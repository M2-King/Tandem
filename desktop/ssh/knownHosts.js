// SSH servers' host keys Tandem has seen (like OpenSSH's known_hosts), kept
// in the app's user data. A server is confirmed by the person the first time;
// after that its key must match, or Tandem refuses to connect.

const fs = require('node:fs');
const path = require('node:path');

function createKnownHosts(dir) {
  const file = path.join(dir, 'ssh-known-hosts.json');
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      return {};
    }
  };
  const key = (host, port) => `${String(host).toLowerCase()}:${Number(port) || 22}`;
  return {
    lookup: (host, port) => read()[key(host, port)] || null,
    remember(host, port, { type, fingerprint }) {
      const all = read();
      all[key(host, port)] = { type, fingerprint, added: new Date().toISOString() };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    },
    forget(host, port) {
      const all = read();
      delete all[key(host, port)];
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    },
  };
}

module.exports = { createKnownHosts };
