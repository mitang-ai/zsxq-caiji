#!/usr/bin/env bash
# Local Linux x64 packaging only. This script never builds the application, launches a browser, or deploys.
set -euo pipefail
umask 022
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# Packaging uses public registries only. Do not inherit user npm/auth/preload or alternate browser-host configuration.
while IFS= read -r env_name; do unset "$env_name"; done < <(compgen -v | grep -E '^(NPM_CONFIG_|npm_config_|NPM_TOKEN$|NODE_AUTH_TOKEN$|NODE_OPTIONS$|NODE_PATH$|LD_PRELOAD$|LD_LIBRARY_PATH$|PLAYWRIGHT_)' || true)
NODE_VERSION=24.14.1
MODE=pack
OFFLINE=0
TAG="$(date -u +%Y%m%dT%H%M%SZ)"
while (($#)); do
  case "$1" in
    --prepare-only) MODE=prepare; shift ;;
    --offline) OFFLINE=1; shift ;;
    --tag) TAG="${2:?--tag requires a value}"; shift 2 ;;
    *) echo "Usage: bash scripts/package-release.sh [--prepare-only] [--offline] [--tag safe-label]" >&2; exit 2 ;;
  esac
done
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Packaging requires local Linux x86_64 (WSL Ubuntu supported).' >&2; exit 2; }
[[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || { echo 'Unsafe release tag.' >&2; exit 2; }
for cmd in curl tar xz sha256sum find ldd realpath cp; do command -v "$cmd" >/dev/null || { echo "Missing local tool: $cmd" >&2; exit 2; }; done
[[ -f "$ROOT/dist/package.json" ]] || { echo 'Missing dist/package.json: run the existing local build first.' >&2; exit 2; }
REPO_KEY="$(printf '%s' "$ROOT" | sha256sum | cut -c1-16)"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/xingjian-release/$REPO_KEY"
mkdir -p -- "$CACHE" "$ROOT/release"
CACHE="$(realpath -- "$CACHE")"
chmod 0700 "$CACHE"
NPM_USER_CONFIG="$CACHE/npm-user-empty.conf"
NPM_GLOBAL_CONFIG="$CACHE/npm-global-empty.conf"
touch "$NPM_USER_CONFIG" "$NPM_GLOBAL_CONFIG"
[[ ! -s "$NPM_USER_CONFIG" && ! -s "$NPM_GLOBAL_CONFIG" ]] || { echo 'Dedicated empty npm config was modified; refusing to use it.' >&2; exit 2; }
NODE_FILE="node-v$NODE_VERSION-linux-x64.tar.xz"
NODE_HOME="$CACHE/node-v$NODE_VERSION-linux-x64"
download() {
  local url="$1" dest="$2"
  [[ "$OFFLINE" == 0 ]] || { echo "Offline cache missing: $(basename -- "$dest")" >&2; exit 2; }
  # Fixed HTTPS hosts and local cache destinations; no caller-supplied endpoint or shell command.
  curl --disable --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 900 --retry 2 --output "$dest.part" "$url"
  mv -- "$dest.part" "$dest"
}
[[ -f "$CACHE/SHASUMS256-v$NODE_VERSION.txt" ]] || download "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$CACHE/SHASUMS256-v$NODE_VERSION.txt"
[[ -f "$CACHE/$NODE_FILE" ]] || download "https://nodejs.org/dist/v$NODE_VERSION/$NODE_FILE" "$CACHE/$NODE_FILE"
NODE_SHA="$(awk -v file="$NODE_FILE" '$2==file { print $1 }' "$CACHE/SHASUMS256-v$NODE_VERSION.txt")"
[[ "$NODE_SHA" =~ ^[a-f0-9]{64}$ ]] || { echo 'Official Node checksum entry missing.' >&2; exit 2; }
printf '%s  %s\n' "$NODE_SHA" "$CACHE/$NODE_FILE" | sha256sum --check -
[[ -x "$NODE_HOME/bin/node" ]] || tar -xJf "$CACHE/$NODE_FILE" -C "$CACHE" --no-same-owner
export PATH="$NODE_HOME/bin:$PATH"
[[ "$(node --version)" == "v$NODE_VERSION" ]] || { echo 'Pinned Node runtime did not execute.' >&2; exit 2; }
node --input-type=module - "$ROOT/dist/package.json" <<'NODE'
import {readFileSync} from 'node:fs';
const p=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(p.type!=='module'||Object.keys(p.dependencies??{}).sort().join(',')!=='pdfjs-dist,playwright'||Object.values(p.dependencies).some(v=>!/^\d+\.\d+\.\d+$/.test(v)))throw new Error('dist runtime dependencies must be exactly pinned playwright and pdfjs-dist');
NODE
DEPS_KEY="$(sha256sum "$ROOT/dist/package.json" | cut -c1-20)"
DEPS="$CACHE/deps-$DEPS_KEY"
if [[ ! -f "$DEPS/.complete" ]]; then
  [[ "$OFFLINE" == 0 ]] || { echo 'Offline runtime dependencies have not been prepared.' >&2; exit 2; }
  mkdir -p -- "$DEPS"; cp -- "$ROOT/dist/package.json" "$DEPS/package.json"
  # No root node_modules or user npm config is copied into the release. Never compile optional native addons here.
  (cd "$DEPS" && npm --userconfig="$NPM_USER_CONFIG" --globalconfig="$NPM_GLOBAL_CONFIG" --cache="$CACHE/npm-cache" install --omit=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org)
  touch "$DEPS/.complete"
fi
(cd "$DEPS" && npm --userconfig="$NPM_USER_CONFIG" --globalconfig="$NPM_GLOBAL_CONFIG" ls --omit=dev --all)
(cd "$DEPS" && node --input-type=module -e "import {createRequire} from 'node:module'; const r=createRequire(process.cwd()+'/package.json'); r('@napi-rs/canvas'); await import('pdfjs-dist/legacy/build/pdf.mjs'); console.log('Linux canvas prebuilt and PDF runtime imports OK; no document/browser opened.');")
PW_VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).version" "$DEPS/node_modules/playwright/package.json")"
BROWSERS="$CACHE/browsers-$PW_VERSION"
if [[ ! -f "$BROWSERS/.complete" ]]; then
  [[ "$OFFLINE" == 0 ]] || { echo 'Offline matching browser runtime has not been prepared.' >&2; exit 2; }
  mkdir -p -- "$BROWSERS"
  # Headless persistent contexts are the application's default. Download only; never --with-deps or launch.
  PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" node "$DEPS/node_modules/playwright/cli.js" install --only-shell chromium
  touch "$BROWSERS/.complete"
fi
HEADLESS="$(find "$BROWSERS" -type f \( -name headless_shell -o -name chrome-headless-shell \) -print -quit)"
[[ -n "$HEADLESS" && -x "$HEADLESS" ]] || { echo 'Matching Chromium headless executable is missing.' >&2; exit 2; }
echo "Prepared Node $NODE_VERSION; Playwright $PW_VERSION; headless browser files only (not launched)."
[[ "$MODE" == prepare ]] && exit 0

[[ -f "$ROOT/dist/server/index.mjs" && -f "$ROOT/dist/server/attachment-worker.mjs" && -f "$ROOT/dist/server/admin.mjs" && -f "$ROOT/dist/web/index.html" ]] || { echo 'Incomplete final dist (index, attachment-worker, admin, web required). Packaging does not build it.' >&2; exit 2; }
NAME="xingjian-linux-x64-$TAG"
APP_ARCHIVE="$ROOT/release/$NAME-app.tar.gz"
BROWSER_ARCHIVE="$ROOT/release/$NAME-browser.tar.gz"
[[ ! -e "$APP_ARCHIVE" && ! -e "$BROWSER_ARCHIVE" && ! -e "$ROOT/release/$NAME-manifest.json" ]] || { echo 'Release tag already exists; choose another --tag.' >&2; exit 2; }
STAGE="$(mktemp -d "$CACHE/stage.XXXXXXXX")"
APP="$STAGE/$NAME"
mkdir -p "$APP/dist/server" "$APP/dist/web" "$APP/runtime/node" "$APP/runtime/browsers" "$APP/bin" "$APP/provenance"
cp -a -- "$ROOT/dist/server/." "$APP/dist/server/"
cp -a -- "$ROOT/dist/web/." "$APP/dist/web/"
cp -- "$ROOT/dist/package.json" "$APP/dist/package.json"
cp -- "$DEPS/package.json" "$DEPS/package-lock.json" "$APP/"
node --input-type=module - "$APP/package.json" <<'NODE'
import {readFileSync,writeFileSync} from 'node:fs'; const p=JSON.parse(readFileSync(process.argv[2],'utf8')); p.scripts={start:'bash bin/run.sh'}; writeFileSync(process.argv[2],JSON.stringify(p,null,2)+'\n');
NODE
cp -a -- "$DEPS/node_modules" "$APP/node_modules"
cp -a -- "$NODE_HOME/." "$APP/runtime/node/"
cp -- "$CACHE/SHASUMS256-v$NODE_VERSION.txt" "$APP/provenance/Node-SHASUMS256.txt"
cp -- "$ROOT/docs/release.md" "$APP/README-release.md"
cat > "$APP/bin/run.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
export PATH="$ROOT/runtime/node/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/runtime/browsers"
export NODE_ENV="${NODE_ENV:-production}" HOST=127.0.0.1
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=512}"
export XINGJIAN_DATA_DIR="${XINGJIAN_DATA_DIR:-$ROOT/var/data}"
if [[ -n "${XINGJIAN_BROWSER_CHANNEL:-}" ]]; then echo 'This package contains the default headless runtime, not a Chrome/Edge channel. Unset XINGJIAN_BROWSER_CHANNEL.' >&2; exit 2; fi
exec "$ROOT/runtime/node/bin/node" "$ROOT/dist/server/index.mjs" "$@"
SH
cat > "$APP/bin/preflight.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Requires Linux x86_64.' >&2; exit 2; }
sha256sum --check APP-SHA256SUMS >/dev/null
[[ -f BROWSER-SHA256SUMS ]] || { echo 'Extract the matching -browser.tar.gz into the same parent directory first.' >&2; exit 2; }
sha256sum --check BROWSER-SHA256SUMS >/dev/null
HEADLESS="$(find "$ROOT/runtime/browsers" -type f \( -name headless_shell -o -name chrome-headless-shell \) -print -quit)"
[[ -n "$HEADLESS" && -x "$HEADLESS" ]] || { echo 'Browser executable missing.' >&2; exit 2; }
missing=0
for executable in "$ROOT/runtime/node/bin/node" "$HEADLESS"; do
  echo "Shared libraries: $(basename -- "$executable")"
  deps="$(ldd "$executable" 2>&1)"; printf '%s\n' "$deps"
  if grep -q 'not found' <<< "$deps"; then missing=1; fi
done
[[ "$missing" == 0 ]] || { echo 'Missing system libraries; this host is not ready. No automatic OS installation is performed.' >&2; exit 2; }
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/runtime/browsers"
"$ROOT/runtime/node/bin/node" --input-type=module -e "import {createRequire} from 'node:module'; const r=createRequire(process.cwd()+'/package.json'); console.log('Node',process.version); console.log('Playwright',r('playwright/package.json').version); await import('playwright'); await import('pdfjs-dist/legacy/build/pdf.mjs'); await import('./dist/server/index.mjs'); console.log('Runtime module import OK; no server/browser/account was started.');"
echo 'Checksums, module imports and local library resolution passed. Browser launch, login, HTTPS/proxy and external model calls remain unverified.'
SH
chmod 0755 "$APP/bin/run.sh" "$APP/bin/preflight.sh"
node --input-type=module - "$APP" "$ROOT" "$NODE_SHA" "$NODE_VERSION" <<'NODE'
import {readFileSync,writeFileSync,readdirSync,lstatSync,realpathSync,accessSync} from 'node:fs';
import {join,relative,sep,basename} from 'node:path';
import {createHash} from 'node:crypto';
const [app,repo,nodeSha,nodeVersion]=process.argv.slice(2);
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const distFiles=[];
function walk(dir){for(const name of readdirSync(dir)){const p=join(dir,name),s=lstatSync(p),r=relative(app,p).split(sep).join('/');
  if(r==='dist'||r.startsWith('dist/')){
    const directory=['dist','dist/server','dist/web','dist/web/assets'].includes(r);
    const generatedFile=r==='dist/package.json'||r==='dist/web/index.html'||/^dist\/server\/(index|attachment-worker|admin)\.mjs$/.test(r)||/^dist\/web\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{6,}\.(js|css|woff2?|ttf|png|jpe?g|webp|svg|ico|avif|wasm)$/.test(r);
    const suspicious=r.split('/').some(n=>n.startsWith('.')||/(^|[-_.])(env|cookies?|credentials?|sessions?|master|secrets?|profiles?|test-output|data)([-_.]|$)/i.test(n));
    if(s.isSymbolicLink()||suspicious||(s.isDirectory()?!directory:!s.isFile()||!generatedFile))throw new Error('Unregistered or forbidden dist output: '+r);
  }
  if(s.isSymbolicLink()){const dest=realpathSync(p);if(!dest.startsWith(realpathSync(app)+sep))throw new Error('Escaping release symlink: '+r);}
  else if(s.isDirectory())walk(p);else if(s.isFile()&&r.startsWith('dist/'))distFiles.push({path:r,size:s.size,sha256:digest(p)});
}}
walk(app);
for(const entry of distFiles)if(digest(join(repo,entry.path))!==entry.sha256)throw new Error('dist changed while being snapshotted: '+entry.path);
for(const dir of ['cmaps','standard_fonts','wasm'])accessSync(join(app,'node_modules/pdfjs-dist',dir));
const deps=JSON.parse(readFileSync(join(app,'package.json'),'utf8')).dependencies;
const browsers=JSON.parse(readFileSync(join(app,'node_modules/playwright-core/browsers.json'),'utf8')).browsers.filter(b=>['chromium-headless-shell','ffmpeg'].includes(b.name));
const manifest={schema_version:1,release_name:basename(app),created_at:new Date().toISOString(),platform:'linux',arch:'x64',node:{version:nodeVersion,archive_sha256:nodeSha,checksum_source:'https://nodejs.org/dist/v'+nodeVersion+'/SHASUMS256.txt',signature_verified:false},runtime_dependencies:deps,runtime_lock_sha256:digest(join(app,'package-lock.json')),dist_snapshot:distFiles,browsers,distribution:{browser_archive_required_for_browser_capture:true,contains_user_data:false,contains_credentials:false,server_build_performed:false,linux_canvas_prebuilt_required:true,pdf_assets_included:['node_modules/pdfjs-dist/cmaps','node_modules/pdfjs-dist/standard_fonts','node_modules/pdfjs-dist/wasm']},verification:{browser_launched:false,remote_host_verified:false,real_source_login:false,real_model_call:false},source_manifest_sha256:digest(join(repo,'dist/package.json'))};
writeFileSync(join(app,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
NODE
(cd "$APP" && find . -type f ! -name APP-SHA256SUMS ! -path './runtime/browsers/*' -print0 | sort -z | xargs -0 sha256sum > APP-SHA256SUMS)
tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$APP_ARCHIVE" -C "$STAGE" "$NAME"
# Runtime files only, not .links (local installation pointers) or completion markers.
for directory in "$BROWSERS"/chromium_headless_shell-* "$BROWSERS"/ffmpeg-*; do [[ ! -d "$directory" ]] || cp -a -- "$directory" "$APP/runtime/browsers/"; done
(cd "$APP" && find ./runtime/browsers -type f -print0 | sort -z | xargs -0 sha256sum > BROWSER-SHA256SUMS)
tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$BROWSER_ARCHIVE" -C "$STAGE" "$NAME/runtime/browsers" "$NAME/BROWSER-SHA256SUMS"
cp -- "$APP/release-manifest.json" "$ROOT/release/$NAME-manifest.json"
{
  echo "Local packaging host only; browser not started."
  uname -srmo; getconf GNU_LIBC_VERSION
  "$NODE_HOME/bin/node" --version
  echo 'Node shared libraries:'; ldd "$NODE_HOME/bin/node"
  echo 'Chromium headless shared libraries:'; ldd "$HEADLESS"
} > "$ROOT/release/$NAME-local-libraries.txt"
(cd "$ROOT/release" && sha256sum "$NAME-app.tar.gz" "$NAME-browser.tar.gz" "$NAME-manifest.json" "$NAME-local-libraries.txt" > "$NAME-SHA256SUMS")
echo "Main: $APP_ARCHIVE"
echo "Browser: $BROWSER_ARCHIVE"
echo "Manifest: $ROOT/release/$NAME-manifest.json"
du -h "$APP_ARCHIVE" "$BROWSER_ARCHIVE"
echo "Isolated staging retained: $STAGE"
