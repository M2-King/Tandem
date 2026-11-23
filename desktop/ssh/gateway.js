// Tandem on an SSH server: the window's own address on this computer.
//
// A small HTTP server on 127.0.0.1 that serves Tandem's UI from the app (never
// from the server) and passes the API and the WebSocket (/api, /ws) through
// the SSH connection to the runtime on the server. The UI gets a config tag
// like the one the runtime puts in its page, with the server's session token
// and where it is connected.
//
// Things that stay on this computer are refused here, whatever the page asks:
// the AI assistant's settings and keys (/api/ai) and Tandem Cowork's shared
// projects (/api/shared).

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};
const STAYS_HERE = /^\/api\/(ai|shared)(\/|$)/;

// The request line and headers for the runtime on the server: its own Host
// and Origin (it checks both), one request per connection.
function rewriteHead(req, remotePort, { upgrade = false } = {}) {
  const remote = `127.0.0.1:${remotePort}`;
  const out = [`${req.method} ${req.url} HTTP/1.1`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'origin' || lower === 'connection' || lower === 'keep-alive' || lower === 'proxy-connection') continue;
    out.push(`${name}: ${req.rawHeaders[i + 1]}`);
  }
  out.push(`Host: ${remote}`);
  if (req.headers.origin) out.push(`Origin: http://${remote}`);
  out.push(upgrade ? 'Connection: Upgrade' : 'Connection: close');
  return `${out.join('\r\n')}\r\n\r\n`;
}

// An SSH channel stands in for a TCP socket for Node's HTTP client.
function asSocket(stream) {
  for (const name of ['setNoDelay', 'setKeepAlive', 'setTimeout', 'ref', 'unref']) {
    if (typeof stream[name] !== 'function') stream[name] = () => stream;
  }
  return stream;
}

// session: { tunnel(), server: { port, token } }; info: what the page shows.
function startGateway({ session, uiDir, info }) {
  const indexFile = path.join(uiDir, 'index.html');
  if (!fs.existsSync(indexFile)) throw new Error('This copy of Tandem is missing its UI files.');
  let origin = null;

  const config = () =>
    JSON.stringify({ mode: 'local', token: session.server.token, version: info.version, remote: info.remote }).replace(/</g, '\\u003c');

  const sendFile = (res, file) => {
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': file === indexFile ? 'no-store' : 'max-age=3600', 'referrer-policy': 'no-referrer' });
    fs.createReadStream(file).pipe(res);
  };

  const server = http.createServer(async (req, res) => {
    // Only this window's own address (as the runtime checks).
    if (req.headers.host !== new URL(origin).host) {
      res.writeHead(403).end('Unexpected host');
      return;
    }
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/')) {
      if (STAYS_HERE.test(url.pathname)) {
        res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'Not available in projects on an SSH server.' }));
        return;
      }
      if (req.headers.origin && req.headers.origin !== origin) {
        res.writeHead(403).end('Origin not allowed');
        return;
      }
      let stream;
      try {
        stream = asSocket(await session.tunnel());
      } catch {
        res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'The connection to the server is closed.' }));
        return;
      }
      const remote = `127.0.0.1:${session.server.port}`;
      const headers = { ...req.headers, host: remote, connection: 'close' };
      delete headers['keep-alive'];
      if (req.headers.origin) headers.origin = `http://${remote}`;
      // One request per tunnel: an agent whose only connection is this SSH channel.
      const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
      agent.createConnection = () => stream;
      const upstream = http.request({ agent, method: req.method, path: req.url, headers });
      upstream.on('response', (r) => {
        const out = { ...r.headers };
        delete out.connection;
        delete out['keep-alive'];
        res.writeHead(r.statusCode, r.statusMessage, out);
        r.pipe(res);
      });
      upstream.on('error', (e) => {
        if (process.env.TANDEM_GATEWAY_DEBUG) console.error('gateway upstream error', e);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'The server didn’t answer.' }));
        else res.destroy();
      });
      req.pipe(upstream);
      return;
    }
    // The UI, from the app.
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(uiDir, rel || 'index.html');
    if (!rel || file === indexFile || !file.startsWith(path.resolve(uiDir) + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const html = fs.readFileSync(indexFile, 'utf8').replace('</head>', `<script id="tandem-runtime" type="application/json">${config()}</script></head>`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(html);
      return;
    }
    sendFile(res, file);
  });

  // The WebSocket (/ws): bytes both ways through the SSH connection.
  server.on('upgrade', async (req, socket, head) => {
    const ok = req.headers.host === new URL(origin).host && (!req.headers.origin || req.headers.origin === origin) && new URL(req.url, origin).pathname === '/ws';
    if (!ok) return socket.destroy();
    let stream;
    try {
      stream = await session.tunnel();
    } catch {
      return socket.destroy();
    }
    stream = asSocket(stream);
    stream.write(rewriteHead(req, session.server.port, { upgrade: true }));
    if (head?.length) stream.write(head);
    socket.pipe(stream).pipe(socket);
    const end = () => {
      socket.destroy();
      stream.destroy?.();
    };
    socket.on('error', end);
    stream.on('error', end);
    socket.on('close', end);
    stream.on('close', end);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ url: `${origin}/`, origin, close: () => server.close() });
    });
  });
}

module.exports = { startGateway, rewriteHead };
