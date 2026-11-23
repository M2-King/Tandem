// node --test desktop/ssh/ssh.test.cjs   (no server or Electron needed)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// connectWindow.js needs Electron only when a window opens.
const realLoad = Module._load;
Module._load = (request, ...rest) => (request === 'electron' ? { BrowserWindow: class {}, dialog: {}, ipcMain: {} } : realLoad(request, ...rest));
const { checkTarget, serverId } = require('./connectWindow.js');
const { startGateway, rewriteHead } = require('./gateway.js');
const { fingerprint } = require('./session.js');
const { createKnownHosts } = require('./knownHosts.js');

test('connection details are checked', () => {
  assert.deepEqual(checkTarget({ host: ' lab.example.edu ', username: 'wei', port: '2222' }), { host: 'lab.example.edu', username: 'wei', port: 2222, folder: '~' });
  for (const bad of [{ host: '', username: 'a' }, { host: 'h; rm -rf /', username: 'a' }, { host: 'h', username: '' }, { host: 'h', username: 'a b' }, { host: 'h', username: 'a', port: 70000 }, { host: 'h', username: 'a', folder: 'x\ny' }]) {
    assert.throws(() => checkTarget(bad));
  }
  assert.equal(serverId({ username: 'wei', host: 'Lab', port: 22 }), serverId({ username: 'wei', host: 'lab', port: 22 }));
});

test('host key fingerprints match OpenSSH', () => {
  // ssh-keygen -lf of this key prints SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU (of an empty blob)
  assert.equal(fingerprint(Buffer.alloc(0)), 'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU');
});

test('known hosts: remembered per host and port', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
  const kh = createKnownHosts(dir);
  assert.equal(kh.lookup('Lab', 22), null);
  kh.remember('Lab', 22, { type: 'ssh-ed25519', fingerprint: 'SHA256:x' });
  assert.equal(kh.lookup('lab', 22).fingerprint, 'SHA256:x');
  assert.equal(kh.lookup('lab', 2222), null);
});

test('requests reach the server runtime with its own Host and Origin', () => {
  const req = { method: 'GET', url: '/api/status', headers: { origin: 'http://127.0.0.1:5000' }, rawHeaders: ['Host', '127.0.0.1:5000', 'Origin', 'http://127.0.0.1:5000', 'x-tandem-token', 't', 'Connection', 'keep-alive'] };
  const head = rewriteHead(req, 41000);
  assert.match(head, /^GET \/api\/status HTTP\/1\.1\r\n/);
  assert.match(head, /\r\nHost: 127\.0\.0\.1:41000\r\n/);
  assert.match(head, /\r\nOrigin: http:\/\/127\.0\.0\.1:41000\r\n/);
  assert.match(head, /\r\nx-tandem-token: t\r\n/);
  assert.match(head, /\r\nConnection: close\r\n\r\n$/);
  assert.doesNotMatch(head, /5000/);
});

test('gateway: the app’s UI, the server’s API, and what stays on this device', async () => {
  // A stand-in for the runtime on the server: echoes what it receives.
  const seen = [];
  const runtime = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((r) => runtime.listen(0, '127.0.0.1', r));
  const port = runtime.address().port;
  const ui = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'));
  fs.writeFileSync(path.join(ui, 'index.html'), '<html><head></head><body>ui</body></html>');
  fs.mkdirSync(path.join(ui, 'assets'));
  fs.writeFileSync(path.join(ui, 'assets', 'a.js'), 'console.log(1)');
  const session = { server: { port, token: 'secret-token' }, tunnel: () => new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => r(s)); }) };
  const gw = await startGateway({ session, uiDir: ui, info: { version: 't', remote: { label: 'wei@lab', host: 'lab', folder: '~/p' } } });
  try {
    const page = await (await fetch(gw.url)).text();
    assert.match(page, /<script id="tandem-runtime" type="application\/json">\{"mode":"local","token":"secret-token","version":"t","remote":\{"label":"wei@lab"/);
    assert.equal(await (await fetch(`${gw.url}assets/a.js`)).text(), 'console.log(1)');
    assert.match(await (await fetch(`${gw.url}../../etc/passwd`)).text(), /tandem-runtime/); // outside the UI: just the page
    const api = await fetch(`${gw.url}api/status`, { headers: { 'x-tandem-token': 'secret-token' } });
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { ok: true, path: '/api/status' });
    assert.equal(seen.at(-1).host, `127.0.0.1:${port}`);
    for (const p of ['api/ai/settings', 'api/ai/assist', 'api/shared/x/files']) assert.equal((await fetch(gw.url + p)).status, 403, p);
    assert.equal(seen.filter((s) => /ai|shared/.test(s.url)).length, 0, 'never forwarded');
    assert.equal((await fetch(`${gw.url}api/status`, { headers: { origin: 'http://evil.example' } })).status, 403);
  } finally {
    gw.close();
    runtime.close();
  }
});
