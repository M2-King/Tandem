// Tandem on an SSH server: the connection (main process only).
//
// Signs in with a password or a private key, checks the server's host key
// (knownHosts.js), installs Tandem's runtime on the server the first time
// (runtime/remote/bootstrap.sh, sent over this connection), starts it for one
// folder, and opens tunnels to it for the gateway (gateway.js). The runtime
// on the server listens on the server's 127.0.0.1 only and stops when this
// connection closes.
//
// Passwords, keys and passphrases stay in this process: the Tandem page
// never sees them.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Client } = require('ssh2');

// What the app sends to the server: the bootstrap script, the runtime wheel
// and its pinned dependencies (built into the app: resources/remote/).
function remoteFiles(dir) {
  const names = fs.readdirSync(dir);
  const wheel = names.find((n) => /^tandem_runtime-.+\.whl$/.test(n));
  if (!wheel || !['bootstrap.sh', 'constraints.txt', 'lite.py'].every((n) => names.includes(n))) {
    throw new Error('This copy of Tandem is missing the files it installs on servers.');
  }
  const read = (n) => fs.readFileSync(path.join(dir, n));
  const files = { bootstrap: read('bootstrap.sh'), constraints: read('constraints.txt'), lite: read('lite.py'), wheel: read(wheel), wheelName: wheel };
  // One folder on the server per version of these files.
  files.id = crypto.createHash('sha256').update(files.wheel).update(files.constraints).update(files.bootstrap).update(files.lite).digest('hex').slice(0, 16);
  return files;
}

// SHA256:<base64>, as OpenSSH shows a host key.
const fingerprint = (key) => `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

// Server output lines are short; anything else is a reason to stop.
const lines = (text) => String(text).split(/\r?\n/).filter(Boolean);
const errorIn = (text) => lines(text).find((l) => l.startsWith('tandem-error '))?.slice('tandem-error '.length);

class RemoteSession extends EventEmitter {
  // target: { host, port, username, folder }
  // auth: { password } | { privateKey (Buffer|string), passphrase? }
  // checkHostKey(info) -> Promise<boolean>; info: { host, port, type, fingerprint, known: 'new'|'same'|'changed', previous }
  // fullTools: install Tandem's full runtime if it isn't there (notebooks, the
  // debugger); else, unless it's already installed, the server's own python3
  // runs lite.py (files, the Terminal and Run) and nothing is installed.
  constructor({ target, auth, remoteDir, knownHosts, confirmHostKey, onProgress, fullTools = false }) {
    super();
    this.target = { port: 22, folder: '~', ...target };
    this.auth = auth;
    this.remoteDir = remoteDir;
    this.fullTools = fullTools;
    this.knownHosts = knownHosts;
    this.confirmHostKey = confirmHostKey;
    this.progress = onProgress || (() => {});
    this.client = null;
    this.server = null; // { port, token, channel }
    this.closed = false;
  }

  get label() {
    const { username, host, port } = this.target;
    return `${username}@${host}${port && port !== 22 ? `:${port}` : ''}`;
  }

  async connect() {
    const files = remoteFiles(this.remoteDir);
    this.progress('connecting', `Connecting to ${this.label}…`);
    await this.open();
    this.progress('checking', 'Checking the server…');
    await this.exec(`mkdir -p ~/.tandem/remote/${files.id} && cat > ~/.tandem/remote/${files.id}/bootstrap.sh`, { stdin: files.bootstrap });
    await this.exec(`cat > ~/.tandem/remote/${files.id}/lite.py`, { stdin: files.lite });
    const check = await this.exec(`sh ~/.tandem/remote/${files.id}/bootstrap.sh check ${files.id}`);
    const info = lines(check.stdout).find((l) => l.startsWith('tandem-check '));
    if (!info) throw new Error(`The server didn't answer as expected. Is it Linux or macOS with a POSIX shell?${check.stderr ? `\n\n${check.stderr.slice(-500)}` : ''}`);
    const facts = Object.fromEntries(info.slice('tandem-check '.length).split(' ').map((kv) => kv.split('=')));
    if (!['Linux', 'Darwin'].includes(facts.os)) throw new Error(`Tandem runs projects on Linux and macOS servers (this one is ${facts.os}).`);
    if (facts.installed !== '1' && this.fullTools) {
      this.progress('installing', 'Installing Tandem on the server (the first time takes a minute)…');
      await this.exec(`cat > ~/.tandem/remote/${files.id}/${files.wheelName}`, { stdin: files.wheel });
      await this.exec(`cat > ~/.tandem/remote/${files.id}/constraints.txt`, { stdin: files.constraints });
      const install = await this.exec(`sh ~/.tandem/remote/${files.id}/bootstrap.sh install ${files.id}`, {
        // The server says what it's doing every couple of seconds, e.g. "Downloading uv (3.2 of 17.2 MB)".
        onLine: (l) => {
          if (!l.startsWith('tandem-step ')) return;
          const step = l.slice('tandem-step '.length);
          this.progress('installing', step.endsWith(')') ? step : `${step}…`);
        },
      });
      const problem = errorIn(install.stdout);
      if (problem || !lines(install.stdout).includes('tandem-installed')) {
        throw new Error(problem || `Installing Tandem on the server failed.${install.stderr ? `\n\n${install.stderr.slice(-800)}` : ''}`);
      }
    }
    this.progress('starting', 'Starting Tandem on the server…');
    this.server = await this.serve(files.id);
    this.progress('ready', 'Connected.');
    return this.server;
  }

  open() {
    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;
      let settled = false;
      let hostKeyRefusal = null;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      client.on('ready', () => done());
      client.on('error', (err) => {
        if (!settled) return done(hostKeyRefusal || friendly(err, this.target));
        this.emit('lost', err);
      });
      client.on('close', () => {
        if (!settled) done(hostKeyRefusal || new Error(`The connection to ${this.label} closed.`));
        if (!this.closed) this.emit('lost', null);
      });
      const { host, port, username } = this.target;
      client.connect({
        host,
        port,
        username,
        readyTimeout: 30000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        tryKeyboard: false,
        ...(this.auth.password != null ? { password: this.auth.password } : {}),
        ...(this.auth.privateKey ? { privateKey: this.auth.privateKey, passphrase: this.auth.passphrase || undefined } : {}),
        // The server's identity: confirmed the first time, then it must match.
        hostVerifier: (key, verify) => {
          const parsed = parseKeyType(key);
          const seen = { host, port, type: parsed, fingerprint: fingerprint(key) };
          const known = this.knownHosts.lookup(host, port);
          if (known && known.fingerprint === seen.fingerprint) return verify(true);
          if (known) {
            hostKeyRefusal = Object.assign(
              new Error(
                `The server's identity changed. ${host} now shows the key ${seen.fingerprint}, not the ${known.fingerprint} Tandem saw before. ` +
                  'That can mean someone is intercepting the connection. Tandem didn’t connect. If the server was reinstalled, ask its admin to confirm the new key, then remove the old one from Tandem’s saved servers.'
              ),
              { code: 'HOST_KEY_CHANGED' }
            );
            return verify(false);
          }
          Promise.resolve(this.confirmHostKey({ ...seen, known: 'new' })).then(
            (yes) => {
              if (yes) this.knownHosts.remember(host, port, seen);
              else hostKeyRefusal = Object.assign(new Error('Not connected: the server’s identity wasn’t confirmed.'), { code: 'HOST_KEY_REFUSED' });
              verify(!!yes);
            },
            () => verify(false)
          );
          return undefined;
        },
      });
    });
  }

  // Runs a command on the server. stdin: bytes to send, then end of input.
  exec(command, { stdin, onLine } = {}) {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        let partial = '';
        stream.on('data', (d) => {
          stdout += d;
          if (onLine) {
            const parts = (partial + d).split(/\r?\n/);
            partial = parts.pop();
            parts.forEach(onLine);
          }
        });
        stream.stderr.on('data', (d) => {
          stderr = (stderr + d).slice(-16000);
        });
        stream.on('close', (code) => resolve({ code, stdout, stderr }));
        if (stdin != null) stream.end(stdin);
        else stream.end();
      });
    });
  }

  // Starts the runtime on the server; its input stays open while connected
  // (closing it stops the runtime: --exit-with-stdin).
  serve(id) {
    const folder = Buffer.from(this.target.folder || '~', 'utf8').toString('base64');
    return new Promise((resolve, reject) => {
      this.client.exec(`sh ~/.tandem/remote/${id}/bootstrap.sh serve ${id} ${folder}`, (err, channel) => {
        if (err) return reject(err);
        let out = '';
        let errText = '';
        let started = false;
        const timer = setTimeout(() => fail(new Error('Tandem didn’t start on the server within 60 seconds.')), 60000);
        const fail = (e) => {
          clearTimeout(timer);
          if (!started) reject(e);
        };
        channel.stderr.on('data', (d) => {
          errText = (errText + d).slice(-8000);
        });
        channel.on('data', (d) => {
          out += d;
          const problem = errorIn(out);
          if (problem) return fail(new Error(problem));
          const url = /^http:\/\/127\.0\.0\.1:(\d+)\/$/m.exec(out);
          const token = /^token=(\S+)$/m.exec(out);
          if (!started && url && token) {
            started = true;
            clearTimeout(timer);
            resolve({ port: Number(url[1]), token: token[1], channel });
          }
        });
        channel.on('close', () => {
          if (!started) fail(new Error(`Tandem stopped on the server before it was ready.${errText ? `\n\n${errText.slice(-800)}` : ''}`));
          else if (!this.closed) this.emit('lost', null);
        });
      });
    });
  }

  // A stream to the runtime on the server (for one HTTP request or WebSocket).
  tunnel() {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.server) return reject(new Error('Not connected.'));
      this.client.forwardOut('127.0.0.1', 0, '127.0.0.1', this.server.port, (err, stream) => (err ? reject(err) : resolve(stream)));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.server?.channel.end(); // the runtime stops when its input closes
    } catch {
      // closing anyway
    }
    this.client?.end();
  }
}

function parseKeyType(key) {
  try {
    const len = key.readUInt32BE(0);
    return key.subarray(4, 4 + len).toString('ascii');
  } catch {
    return 'unknown';
  }
}

function friendly(err, { host, port }) {
  const m = String(err?.message || err);
  if (err?.level === 'client-authentication' || /All configured authentication methods failed/i.test(m)) {
    return new Error('The server refused the sign-in. Check the username and the password or key.');
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return new Error(`Can’t find a server called ${host}.`);
  if (/ECONNREFUSED/.test(m)) return new Error(`${host} refused the connection on port ${port}. Is SSH running there?`);
  if (/ETIMEDOUT|Timed out while waiting for handshake/i.test(m)) return new Error(`${host} didn’t answer. Check the address, the port and your network.`);
  if (/Cannot parse privateKey|Encrypted private OpenSSH key detected, but no passphrase|bad passphrase|Unsupported key format/i.test(m)) {
    return new Error(/passphrase/i.test(m) ? 'The key needs its passphrase (or the passphrase is wrong).' : 'Tandem couldn’t read that private key.');
  }
  return new Error(m);
}

module.exports = { RemoteSession, remoteFiles, fingerprint };
