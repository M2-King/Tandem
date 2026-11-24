// The connect window's form (connect.html).
const $ = (id) => document.getElementById(id);
let auth = 'password';
let remembered = {};
let current = null; // the saved server being edited

function setAuth(next) {
  auth = next;
  $('use-password').setAttribute('aria-pressed', String(next === 'password'));
  $('use-key').setAttribute('aria-pressed', String(next === 'key'));
  $('password-box').hidden = next !== 'password';
  $('key-box').hidden = next !== 'key';
  $('remember-label').textContent = next === 'key' ? 'Remember the passphrase on this computer' : 'Remember the password on this computer';
}

function fill(s) {
  current = s;
  $('host').value = s.host || '';
  $('port').value = s.port || 22;
  $('username').value = s.username || '';
  $('folder').value = s.folder || '~';
  setAuth(s.auth === 'key' ? 'key' : 'password');
  if (s.keyPath) $('key-path').value = s.keyPath;
  $('password').value = '';
  $('passphrase').value = '';
  $('remember').checked = !!remembered[s.id];
  $('password').placeholder = remembered[s.id] && s.auth !== 'key' ? 'Remembered' : '';
  $('passphrase').placeholder = remembered[s.id] && s.auth === 'key' ? 'Remembered' : '';
}

function renderServers(list) {
  const box = $('servers');
  box.replaceChildren();
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'server';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${s.username}@${s.host}${s.port && s.port !== 22 ? `:${s.port}` : ''}`;
    const folder = document.createElement('span');
    folder.className = 'folder';
    folder.textContent = s.folder;
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.textContent = 'Forget';
    forget.addEventListener('click', async (e) => {
      e.stopPropagation();
      renderServers(await window.tandemSsh.forget(s.id));
    });
    row.append(name, folder, forget);
    row.addEventListener('click', () => fill(s));
    row.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && fill(s));
    box.append(row);
  }
}

function status(text, error = false) {
  $('status').textContent = text;
  $('status').className = `status${error ? ' error' : ''}`;
}

function busy(on) {
  for (const el of document.querySelectorAll('input, #connect, #pick-key, .tabs button')) el.disabled = on;
}

// Progress is shown only while connecting: a fast answer (say, a refused host
// key) can arrive before the last progress message, which mustn't replace it.
let connecting = false;

async function connect(e) {
  e?.preventDefault();
  connecting = true;
  busy(true);
  status('Connecting…');
  const r = await window.tandemSsh.connect({
    host: $('host').value,
    port: Number($('port').value || 22),
    username: $('username').value,
    folder: $('folder').value,
    auth,
    password: auth === 'password' ? $('password').value : undefined,
    keyPath: auth === 'key' ? $('key-path').value : undefined,
    passphrase: auth === 'key' ? $('passphrase').value : undefined,
    remember: $('remember').checked,
  });
  connecting = false;
  $('hostkey').hidden = true;
  if (r.ok) return status('Connected. Opening…');
  busy(false);
  status(r.message, true);
}

window.tandemSsh.onProgress(({ text }) => connecting && status(text));
window.tandemSsh.onHostKey((info) => {
  $('hk-host').textContent = `${info.host}${info.port !== 22 ? `:${info.port}` : ''}`;
  $('hk-type').textContent = info.type;
  $('hk-fp').textContent = info.fingerprint;
  $('hostkey').hidden = false;
  status('Waiting for you to confirm the server’s identity.');
  $('hk-yes').disabled = false;
  $('hk-no').disabled = false;
  $('hk-yes').focus();
});
$('hk-yes').addEventListener('click', () => {
  $('hostkey').hidden = true;
  window.tandemSsh.answerHostKey(true);
});
$('hk-no').addEventListener('click', () => {
  $('hostkey').hidden = true;
  window.tandemSsh.answerHostKey(false);
});
$('use-password').addEventListener('click', () => setAuth('password'));
$('use-key').addEventListener('click', () => setAuth('key'));
$('pick-key').addEventListener('click', async () => {
  const p = await window.tandemSsh.pickKey();
  if (p) $('key-path').value = p;
});
$('cancel').addEventListener('click', () => window.close());
$('form').addEventListener('submit', connect);

window.tandemSsh.init().then((d) => {
  remembered = d.remembered || {};
  renderServers(d.servers || []);
  if (d.keys?.[0]) $('key-path').value = d.keys[0];
  if (d.prefill) fill(d.prefill);
  else if (d.servers?.[0]) fill(d.servers[0]);
  ($('host').value ? $('password') : $('host')).focus();
});
