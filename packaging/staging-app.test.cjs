// node --test packaging/staging-app.test.cjs
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { stagingVersion, toStaging, FEED_URL } = require('./staging-app.cjs');
const desktopPackage = require('../desktop/package.json');

test('staging version: next patch, staging prerelease, run number', () => {
  assert.equal(stagingVersion('0.3.0', 57), '0.3.1-staging.57');
  assert.equal(stagingVersion('0.3.0', '58'), '0.3.1-staging.58');
  assert.equal(stagingVersion('1.9.9', 1), '1.9.10-staging.1');
  assert.equal(stagingVersion('0.3.0-beta.2', 7), '0.3.1-staging.7');
});

test('staging version: refuses a bad base or run number', () => {
  for (const run of [undefined, '', '0', '-1', '1.5', 'abc', '01']) {
    assert.throws(() => stagingVersion('0.3.0', run), /run number/);
  }
  for (const base of ['', 'v0.3.0', '0.3', 'latest']) {
    assert.throws(() => stagingVersion(base, 5), /Not a version/);
  }
});

test('staging versions increase with the run number (semver)', () => {
  // The semver that electron-updater itself compares versions with.
  const updaterMain = require.resolve('electron-updater', { paths: [path.join(__dirname, '..', 'desktop')] });
  const semver = require(require.resolve('semver', { paths: [path.dirname(updaterMain)] }));
  assert.ok(semver.gt(stagingVersion('0.3.0', 58), stagingVersion('0.3.0', 57)));
  assert.ok(semver.gt(stagingVersion('0.3.0', 100), stagingVersion('0.3.0', 99)));
  assert.ok(semver.gt(stagingVersion('0.3.0', 1), '0.3.0')); // over the first staging build (no updater)
  assert.ok(semver.gt('0.3.1', stagingVersion('0.3.0', 999))); // the release after it
});

test('staging package: name, id, feed, channel; the source is untouched', () => {
  const before = JSON.stringify(desktopPackage);
  const p = toStaging(desktopPackage, 57);
  assert.equal(JSON.stringify(desktopPackage), before);
  assert.equal(p.version, '0.3.1-staging.57');
  assert.equal(p.productName, 'Tandem Staging');
  assert.equal(p.build.appId, 'app.tandem.staging');
  assert.equal(p.build.nsis.artifactName, 'Tandem-Setup-${version}.exe');
  // Shown as Tandem; the folders and app id stay "Tandem Staging" so updates land in place.
  assert.equal(p.tandemDisplayName, 'Tandem');
  assert.equal(p.build.nsis.shortcutName, 'Tandem');
  assert.equal(p.build.nsis.uninstallDisplayName, 'Tandem');
  assert.equal(p.build.productName, 'Tandem Staging');
  assert.equal(p.build.mac.extendInfo.CFBundleDisplayName, 'Tandem');
  // One range per request (GitHub refuses several in one): small differential updates.
  assert.deepEqual(p.build.publish, [{ provider: 'generic', url: FEED_URL, channel: 'staging', useMultipleRangeRequest: false }]);
  assert.deepEqual(p.tandemUpdates, { channel: 'staging', url: FEED_URL });
  assert.match(FEED_URL, /^https:\/\/github\.com\/M2-King\/Tandem\/releases\/download\/windows-staging$/);
  assert.equal(p.build.win.publisherName, undefined); // unsigned for now
  assert.ok(p.dependencies['electron-updater']);
  assert.ok(p.build.files.includes('updater.js'));
});

test('regular Tandem package has no update feed', () => {
  assert.equal(desktopPackage.tandemUpdates, undefined);
  assert.equal(desktopPackage.build.publish, undefined);
  assert.equal(desktopPackage.build.appId, 'app.tandem.desktop');
});

test('electron-updater is pinned to an exact version', () => {
  assert.match(desktopPackage.dependencies['electron-updater'], /^\d+\.\d+\.\d+$/);
});
