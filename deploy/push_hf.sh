#!/usr/bin/env sh
# Push the current main branch to a Hugging Face Docker Space, with the Space card as README.
# usage: deploy/push_hf.sh <hf-user>/<space-name>     (needs `git` and a HF write token in your git credentials)
set -eu
SPACE="${1:?usage: deploy/push_hf.sh <hf-user>/<space-name>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git -C "$ROOT" archive HEAD | tar -x -C "$TMP"
cp "$ROOT/deploy/huggingface/README.md" "$TMP/README.md"
rm -rf "$TMP/explore" "$TMP/deploy"
cd "$TMP"
git init -q -b main
git add -A
git -c user.name="radians-deploy" -c user.email="deploy@localhost" commit -q -m "Deploy $(git -C "$ROOT" rev-parse --short HEAD)"
git push -f "https://huggingface.co/spaces/$SPACE" main
echo "pushed to https://huggingface.co/spaces/$SPACE"
