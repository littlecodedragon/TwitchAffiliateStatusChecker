#!/usr/bin/env bash
# Helper script to push package files to an AUR git repo
# Usage: ./push-to-aur.sh <aur-ssh-repo-url>

set -euo pipefail

REPO_URL="${1:-}"
if [ -z "$REPO_URL" ]; then
  echo "Usage: $0 <aur-ssh-repo-url>"
  exit 1
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Cloning AUR repo $REPO_URL into $TMP_DIR"
GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=no' git clone "$REPO_URL" "$TMP_DIR"

# Copy package files into the AUR repo working tree
echo "Copying package files..."
# PKGBUILD and helper files live in aur/
cp -f aur/PKGBUILD "$TMP_DIR/" || true
cp -f aur/twitch-token-server.service "$TMP_DIR/" || true
cp -f aur/twitch-token-server-configure "$TMP_DIR/" || true
cp -f aur/build.sh "$TMP_DIR/" || true

# Also include the server source if present at repo root
cp -f token-server.js "$TMP_DIR/" || true

# If we maintain a pre-generated .SRCINFO, copy it
if [ -f aur/.SRCINFO ]; then
  cp -f aur/.SRCINFO "$TMP_DIR/.SRCINFO"
fi

cd "$TMP_DIR"

# Create or update .SRCINFO if not provided (best-effort, but recommend providing .SRCINFO in repo)
if [ ! -f .SRCINFO ]; then
  if command -v makepkg >/dev/null 2>&1; then
    makepkg --printsrcinfo > .SRCINFO
  else
    echo "Warning: .SRCINFO not found and makepkg not available in runner. Please include aur/.SRCINFO in the upstream repo." >&2
  fi
fi

# Commit & push
GIT_USER_NAME="github-actions"
GIT_USER_EMAIL="actions@github.com"

git config user.name "$GIT_USER_NAME"
git config user.email "$GIT_USER_EMAIL"

git add --all
if git commit -m "Update AUR package from upstream (automated)"; then
  echo "Pushing changes to AUR repo..."
  git push origin master
else
  echo "No changes to commit."
fi

echo "Done."
