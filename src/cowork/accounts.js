// Tandem Cowork accounts: a username and a password. Tandem accounts are
// their own; they aren't shared with any other service.
//
// Usernames: 3 to 24 lowercase letters, digits or _, starting with a letter
// (the database enforces the same rule). Passwords: at least 8 characters.

export const USERNAME_RULE = '3 to 24 letters, numbers or _, starting with a letter';
const USERNAME = /^[a-z][a-z0-9_]{2,23}$/;

// Each account has a Tandem address, username@tandem.org: how people find
// and invite each other inside the app. It is not an email inbox: nothing is
// ever sent to it, and it needs no confirmation.
export const TANDEM_DOMAIN = 'tandem.org';
export const addressOf = (username) => `${username}@${TANDEM_DOMAIN}`;

// "@Priya ", "priya@tandem.org" → "priya"
export const normalizeUsername = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(new RegExp(`@${TANDEM_DOMAIN.replace('.', '\\.')}$`), '');

export function usernameProblem(username) {
  if (!username) return 'Enter a username.';
  if (!USERNAME.test(username)) return `Use ${USERNAME_RULE}.`;
  return null;
}

export function passwordProblem(password) {
  if (!password) return 'Enter your password.';
  if (password.length < 8) return 'Use a password of at least 8 characters.';
  if (password.length > 72) return 'Use a password of at most 72 characters.';
  return null;
}

// How someone is shown: their name when known (the preview's sample people),
// otherwise their username; a colour from the username.
export function personForUsername(username, known = {}) {
  if (known[username]) return known[username];
  let hue = 0;
  for (const ch of username || '?') hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return { id: username, username, name: username, hue };
}

export const initialsOf = (name) =>
  String(name || '?')
    .split(/[\s_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
