// Checks the Cowork staging settings before a staging build (CI on the
// cowork branch). A staging package without them would quietly show the
// sample preview, so the build stops here with what to set instead.
//
// Reads VITE_COWORK_MODE, VITE_TANDEM_SUPABASE_URL, VITE_TANDEM_SUPABASE_KEY
// (GitHub repository variables). Prints the project host, never the key.

const mode = (process.env.VITE_COWORK_MODE || '').trim();
const url = (process.env.VITE_TANDEM_SUPABASE_URL || '').trim();
const key = (process.env.VITE_TANDEM_SUPABASE_KEY || '').trim();
const problems = [];

if (mode !== 'live') problems.push(`VITE_COWORK_MODE must be "live" (it is ${mode ? `"${mode}"` : 'not set'}).`);
let host = '';
try {
  const u = new URL(url);
  host = u.host;
  if (u.protocol !== 'https:') problems.push('VITE_TANDEM_SUPABASE_URL must start with https://.');
} catch {
  problems.push('VITE_TANDEM_SUPABASE_URL is not set to the staging project URL (https://<ref>.supabase.co).');
}
if (!key) problems.push('VITE_TANDEM_SUPABASE_KEY is not set (the publishable key).');
else if (/^sb_secret_/.test(key)) problems.push('VITE_TANDEM_SUPABASE_KEY is a secret key. Use the publishable key (sb_publishable_…).');
else if (key.split('.').length === 3) {
  try {
    const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
    if (claims.role === 'service_role') problems.push('VITE_TANDEM_SUPABASE_KEY is the service-role key. Use the publishable (anon) key.');
  } catch {
    // not a JWT
  }
}

const domain = (process.env.VITE_TANDEM_ACCOUNT_DOMAIN || '').trim().toLowerCase();
if (domain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) problems.push('VITE_TANDEM_ACCOUNT_DOMAIN must be a domain name (or leave it unset).');
if (domain === 'tandem.org') problems.push('VITE_TANDEM_ACCOUNT_DOMAIN can’t be tandem.org: that domain’s mail isn’t yours, so its owner could take over accounts.');

if (problems.length) {
  console.error('Cowork staging settings are incomplete. Set these as repository variables');
  console.error('(GitHub → Settings → Secrets and variables → Actions → Variables):');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Cowork staging: live mode, project ${host}, publishable key …${key.slice(-4)}, accounts @${domain || 'accounts.tandem.invalid'}`);
