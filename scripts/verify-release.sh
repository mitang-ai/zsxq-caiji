#!/usr/bin/env bash
# Evidence helper only; not part of app/runtime archive inputs. Never starts a server or browser.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
TAG="${1:?release tag required}"
[[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || exit 2
NAME="xingjian-linux-x64-$TAG"
cd "$ROOT/release"
sha256sum --check "$NAME-SHA256SUMS"
DIR="$(mktemp -d /tmp/xingjian-archive-verify.XXXXXXXX)"
tar --no-same-owner -xzf "$NAME-app.tar.gz" -C "$DIR"
tar --no-same-owner -xzf "$NAME-browser.tar.gz" -C "$DIR"
tar -tzf "$NAME-app.tar.gz" > "$NAME-app-members.txt"
tar -tzf "$NAME-browser.tar.gz" > "$NAME-browser-members.txt"
if grep -E "^$NAME/(data|var|test-output|release|\.env|\.git)(/|$)" "$NAME-app-members.txt" "$NAME-browser-members.txt"; then echo 'Forbidden application state in archive.' >&2; exit 2; fi
[[ ! -e "$DIR/$NAME/data" && ! -e "$DIR/$NAME/var" ]] || { echo 'Unexpected extracted application state.' >&2; exit 2; }
{
  echo "Fresh extraction: $DIR/$NAME"
  bash "$DIR/$NAME/bin/preflight.sh"
  [[ ! -e "$DIR/$NAME/data" && ! -e "$DIR/$NAME/var" ]] || { echo 'Module import unexpectedly created application state.' >&2; exit 2; }
  echo 'No application data was created. No service, browser, source login or model call was performed.'
} 2>&1 | tee "$ROOT/release/$NAME-verification.log"
