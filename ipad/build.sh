#!/usr/bin/env bash
# Assemble the iPad app's web files and generate the Xcode project (macOS).
#   ipad/build.sh            then open ipad/App/Tandem.xcodeproj in Xcode
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci
npm run build
rm -rf ipad/App/Resources/web
mkdir -p ipad/App/Resources/web
cp -R dist/. ipad/App/Resources/web/
python3 ipad/fetch_pyodide.py ipad/App/Resources/web/pyodide
# What Tandem installs on SSH servers (the runtime wheel, bootstrap.sh, constraints.txt).
python3 packaging/remote-files.py
rm -rf ipad/App/Resources/remote
cp -R out/remote ipad/App/Resources/remote
(cd ipad/App && xcodegen generate)
echo "Web files: $(du -sh ipad/App/Resources/web | cut -f1)"
