// Turns the desktop build into "Tandem Staging" (CI on the cowork branch), so
// it installs beside the regular Tandem with its own settings and shortcuts,
// and updates itself from the staging feed.
//
//   node packaging/staging-app.cjs desktop/package.json <github.run_number>
//
// The version is unique and always increasing without committing a bump:
// desktop/package.json 0.3.0 and run 57 give 0.3.1-staging.57.
//
// The update feed is a rolling GitHub prerelease (tag windows-staging) that
// the publish-staging job in windows.yml replaces after every cowork build.
// electron-builder writes app-update.yml (into the app) and staging.yml (next
// to the installer) from the publish entry below.

const fs = require('fs');

const FEED_URL = 'https://github.com/M2-King/Tandem/releases/download/windows-staging';
const CHANNEL = 'staging';

// <major>.<minor>.<patch + 1>-staging.<run>; any prerelease part of the base is ignored.
function stagingVersion(base, run) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(base || '').trim());
  if (!m) throw new Error(`Not a version: ${base}`);
  const n = String(run ?? '').trim();
  if (!/^[1-9]\d*$/.test(n)) throw new Error(`The run number must be a positive whole number (got "${run}")`);
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3]) + 1}-${CHANNEL}.${Number(n)}`;
}

function toStaging(p, run) {
  const next = JSON.parse(JSON.stringify(p));
  next.version = stagingVersion(p.version, run);
  next.productName = 'Tandem Staging';
  // Read by desktop/updater.js: only a staging build may update itself, and
  // only from this feed (the page can't change it).
  next.tandemUpdates = { channel: CHANNEL, url: FEED_URL };
  const b = next.build;
  b.productName = 'Tandem Staging';
  b.appId = 'app.tandem.staging';
  b.nsis.shortcutName = 'Tandem Staging';
  b.nsis.artifactName = 'Tandem-Staging-Setup-${version}.exe';
  b.portable.artifactName = 'Tandem-Staging-${version}-portable.exe';
  // TODO(code signing): the installer isn't signed yet, so there is no
  // publisherName here (electron-updater would then require a signature that
  // matches it). Add win.signtoolOptions/azureSignOptions and publisherName
  // once Tandem has a certificate.
  b.publish = [{ provider: 'generic', url: FEED_URL, channel: CHANNEL }];
  // electron-updater ships with the app (a runtime dependency).
  if (!next.dependencies?.['electron-updater']) throw new Error('desktop/package.json needs electron-updater in dependencies');
  return next;
}

module.exports = { stagingVersion, toStaging, FEED_URL, CHANNEL };

if (require.main === module) {
  const [file, run] = process.argv.slice(2);
  const p = toStaging(JSON.parse(fs.readFileSync(file, 'utf8')), run);
  fs.writeFileSync(file, `${JSON.stringify(p, null, 2)}\n`);
  console.log(`${p.build.productName} ${p.version} (${p.build.appId}), updates: ${FEED_URL}/${CHANNEL}.yml`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${p.version}\n`);
}
