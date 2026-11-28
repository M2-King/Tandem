// "Connect to SSH server…": a small window of its own (connect.html), apart
// from the Tandem page, so passwords, keys and passphrases are typed and used
// only in the app, never in the page.
//
// Saved servers (no secrets) are in the app's user data, ssh-servers.json.
// A password or a key's passphrase is kept only when the person asks, with
// the app's secure store (encrypted by the operating system).
//
// Resolves with { session, gateway, server } once Tandem runs on the server,
// or null when the window is closed.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BrowserWindow, dialog, ipcMain } = require('electron');
const { RemoteSession } = require('./session.js');
const { startGateway } = require('./gateway.js');
const { createKnownHosts } = require('./knownHosts.js');

const HOST = /^[A-Za-z0-9.\-:[\]_]{1,253}$/;
const USER = /^[A-Za-z0-9._@\-\\]{1,64}$/;
const serverId = (s) => crypto.createHash('sha256').update(`${s.username}@${String(s.host).toLowerCase()}:${s.port}`).digest('hex').slice(0, 16);

function createServerList(dir) {
  const file = path.join(dir, 'ssh-servers.json');
  const read = () => {
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const write = (list) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 2));
  };
  return {
    all: read,
    save(server) {
      const list = read().filter((s) => s.id !== server.id);
      write([{ ...server, lastUsed: new Date().toISOString() }, ...list].slice(0, 20));
    },
    forget(id) {
      write(read().filter((s) => s.id !== id));
    },
  };
}

// Keys people usually have.
function defaultKeys() {
  const dir = path.join(os.homedir(), '.ssh');
  return ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p));
}

function checkTarget(t) {
  const host = String(t.host || '').trim();
  const username = String(t.username || '').trim();
  const port = Number(t.port || 22);
  const folder = String(t.folder || '~').trim() || '~';
  if (!HOST.test(host)) throw new Error('Enter the server’s address (a host name or IP address).');
  if (!USER.test(username)) throw new Error('Enter your username on the server.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The port is a number from 1 to 65535 (usually 22).');
  if (folder.length > 1024 || /[\0\n]/.test(folder)) throw new Error('That folder name can’t be used.');
  return { host, username, port, folder };
}

function connectToServer({ parent, userData, secure, remoteDir, uiDir, version, prefill = null }) {
  const servers = createServerList(userData);
  const knownHosts = createKnownHosts(userData);
  // The secure store answers at once; a value it can't read or keep is simply not there.
  const sget = (name) => {
    try {
      return secure.get(name);
    } catch {
      return null;
    }
  };
  const sset = (name, value) => {
    try {
      return secure.set(name, value);
    } catch {
      return false;
    }
  };

  const w = new BrowserWindow({
    parent: parent || undefined,
    modal: !!parent,
    width: 520,
    height: 720,
    minWidth: 440,
    minHeight: 520,
    title: 'Connect to an SSH server',
    backgroundColor: '#1b1d24',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'connect-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));

  let session = null;
  let hostKeyAnswer = null;
  let done = null;
  const result = new Promise((resolve) => (done = resolve));
  const send = (channel, value) => !w.isDestroyed() && w.webContents.send(channel, value);
  const channels = [];
  const handle = (channel, fn) => {
    channels.push(channel);
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args) => {
      if (w.isDestroyed() || event.sender !== w.webContents) throw new Error('Not allowed');
      return fn(...args);
    });
  };

  handle('ssh:init', async () => ({
    servers: servers.all(),
    keys: defaultKeys(),
    prefill,
    remembered: Object.fromEntries(
      await Promise.all(
        servers.all().map(async (s) => [s.id, !!sget(`ssh.${s.id}.${s.auth === 'key' ? 'passphrase' : 'password'}`)])
      )
    ),
  }));

  handle('ssh:pick-key', async () => {
    const r = await dialog.showOpenDialog(w, {
      title: 'Choose your private key',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('ssh:forget', async (id) => {
    servers.forget(id);
    sset(`ssh.${id}.password`, null);
    sset(`ssh.${id}.passphrase`, null);
    return servers.all();
  });

  handle('ssh:host-key-answer', (yes) => {
    hostKeyAnswer?.(!!yes);
    hostKeyAnswer = null;
  });

  // form: { host, port, username, folder, auth: 'password'|'key', password?, keyPath?, passphrase?, remember, fullTools }
  // fullTools: also install notebooks and the debugger (else nothing is installed: files, the Terminal and Run).
  handle('ssh:connect', async (form) => {
    if (session) return { ok: false, message: 'Already connecting.' };
    let target;
    try {
      target = checkTarget(form);
    } catch (e) {
      return { ok: false, message: e.message };
    }
    const id = serverId(target);
    const useKey = form.auth === 'key';
    let auth;
    try {
      if (useKey) {
        const keyPath = String(form.keyPath || '');
        if (!keyPath) return { ok: false, message: 'Choose your private key file.' };
        const passphrase = form.passphrase || sget(`ssh.${id}.passphrase`) || undefined;
        auth = { privateKey: fs.readFileSync(keyPath), passphrase };
      } else {
        const password = form.password || sget(`ssh.${id}.password`);
        if (!password) return { ok: false, message: 'Enter your password.' };
        auth = { password };
      }
    } catch (e) {
      return { ok: false, message: `Tandem couldn’t read that key file (${e.code || e.message}).` };
    }
    session = new RemoteSession({
      target,
      auth,
      remoteDir,
      knownHosts,
      fullTools: !!form.fullTools,
      onProgress: (stage, text) => send('ssh:progress', { stage, text }),
      confirmHostKey: (info) =>
        new Promise((resolve) => {
          hostKeyAnswer = resolve;
          send('ssh:host-key', info);
        }),
    });
    try {
      await session.connect();
      const gateway = await startGateway({
        session,
        uiDir,
        info: { version, remote: { host: target.host, port: target.port, user: target.username, folder: target.folder, label: session.label } },
      });
      servers.save({ id, ...target, auth: useKey ? 'key' : 'password', keyPath: useKey ? String(form.keyPath) : undefined, fullTools: !!form.fullTools });
      // Kept only when asked; forgotten when the box is cleared.
      const secretName = `ssh.${id}.${useKey ? 'passphrase' : 'password'}`;
      const secret = useKey ? form.passphrase : form.password;
      if (form.remember && secret) sset(secretName, secret);
      if (!form.remember) sset(secretName, null);
      const connected = session;
      session = null;
      done({ session: connected, gateway, server: { id, ...target, label: connected.label } });
      if (!w.isDestroyed()) w.close();
      return { ok: true };
    } catch (e) {
      session.close();
      session = null;
      return { ok: false, message: e.message, code: e.code || null };
    }
  });

  w.on('closed', () => {
    channels.forEach((c) => ipcMain.removeHandler(c));
    hostKeyAnswer?.(false);
    session?.close();
    done(null);
  });
  w.once('ready-to-show', () => w.show());
  w.loadFile(path.join(__dirname, 'connect.html'));
  return result;
}

module.exports = { connectToServer, checkTarget, serverId };
