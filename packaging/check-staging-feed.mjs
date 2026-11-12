// Checks the Tandem Staging update files (CI, publish-staging job).
//
//   node packaging/check-staging-feed.mjs <dir> <version>          the build's files, before publishing
//   node packaging/check-staging-feed.mjs <dir> <version> <feed>   the published feed, after publishing
//
// <dir> holds Tandem-Setup-<version>.exe, its .blockmap and
// staging.yml as electron-builder wrote them. Before publishing: staging.yml
// names this version and installer, and its sha512 and size match the exe.
// After publishing: staging.yml fetched from the feed URL says the same, and
// the installer downloaded from the feed has that sha512 (what
// electron-updater checks before it runs an update).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [dir, version, feed] = process.argv.slice(2);
const exeName = `Tandem-Setup-${version}.exe`;

function fail(message) {
  console.error(`FAILED: ${message}`);
  process.exit(1);
}
function ok(cond, message) {
  if (!cond) fail(message);
  console.log(`ok   ${message}`);
}

// The fields electron-updater reads from electron-builder's channel file.
function parseChannelFile(text) {
  const top = (key) => {
    const m = new RegExp(`^${key}:\\s*['"]?([^'"\\n]+?)['"]?\\s*$`, 'm').exec(text);
    return m ? m[1] : null;
  };
  const files = [];
  const block = /^files:\n((?:[ \t]+.*\n?)*)/m.exec(text);
  if (block) {
    for (const entry of block[1].split(/^\s*-\s+/m).slice(1)) {
      const field = (key) => (new RegExp(`(?:^|\\n)\\s*${key}:\\s*['"]?([^'"\\n]+?)['"]?\\s*(?=\\n|$)`).exec(entry) || [])[1] || null;
      files.push({ url: field('url'), sha512: field('sha512'), size: Number(field('size')) });
    }
  }
  return { version: top('version'), path: top('path'), sha512: top('sha512'), files };
}

const sha512 = (buf) => createHash('sha512').update(buf).digest('base64');

function checkChannel(info, exe, where) {
  ok(info.version === version, `${where}: version ${info.version}`);
  ok(info.path === exeName, `${where}: path ${info.path}`);
  ok(info.files.length === 1 && info.files[0].url === exeName, `${where}: files[0].url ${info.files[0]?.url}`);
  ok(info.sha512 === exe.sha512 && info.files[0].sha512 === exe.sha512, `${where}: sha512 matches the installer (${exe.sha512.slice(0, 16)}…)`);
  ok(info.files[0].size === exe.size, `${where}: size ${exe.size} bytes`);
}

async function fetchWithRetry(url, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
      if (res.ok) return res;
      last = new Error(`${res.status} ${res.statusText}`);
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  fail(`${url}: ${last.message}`);
}

const exeFile = path.join(dir, exeName);
ok(fs.existsSync(exeFile), `installer ${exeName}`);
ok(fs.existsSync(`${exeFile}.blockmap`), `blockmap ${exeName}.blockmap`);
const exeBuf = fs.readFileSync(exeFile);
const local = { sha512: sha512(exeBuf), size: exeBuf.length };
const localInfo = parseChannelFile(fs.readFileSync(path.join(dir, 'staging.yml'), 'utf8'));
checkChannel(localInfo, local, 'staging.yml (build)');

if (feed) {
  ok(/^https:\/\//.test(feed), `feed is HTTPS: ${feed}`);
  const yml = await (await fetchWithRetry(`${feed}/staging.yml`)).text();
  console.log(yml.replace(/^/gm, '     '));
  checkChannel(parseChannelFile(yml), local, 'staging.yml (feed)');
  const published = Buffer.from(await (await fetchWithRetry(`${feed}/${exeName}`)).arrayBuffer());
  ok(published.length === local.size && sha512(published) === local.sha512, `the feed's installer has that sha512 (${published.length} bytes)`);
  const blockmap = await fetchWithRetry(`${feed}/${exeName}.blockmap`);
  ok(blockmap.ok, 'the feed has its blockmap (for differential downloads)');
}
