// Names the desktop build "Tandem Staging" (CI on the cowork branch), so it
// installs beside the regular Tandem with its own settings and shortcuts.
//   node packaging/staging-app.cjs desktop/package.json
const fs = require('fs');
const file = process.argv[2];
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
p.productName = 'Tandem Staging';
p.build.productName = 'Tandem Staging';
p.build.appId = 'app.tandem.staging';
p.build.nsis.shortcutName = 'Tandem Staging';
p.build.nsis.artifactName = 'Tandem-Staging-Setup-${version}.exe';
p.build.portable.artifactName = 'Tandem-Staging-${version}-portable.exe';
fs.writeFileSync(file, `${JSON.stringify(p, null, 2)}\n`);
console.log(`${p.build.productName} (${p.build.appId}): ${p.build.nsis.artifactName}, ${p.build.portable.artifactName}`);
