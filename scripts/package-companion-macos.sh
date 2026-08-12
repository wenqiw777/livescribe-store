#!/bin/bash
set -euo pipefail

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node -p "require('$REPO_DIR/manifest.json').version")
BUILD_DIR=$(mktemp -d)
ROOT_DIR="$BUILD_DIR/root"
OUTPUT_DIR="$REPO_DIR/dist"
COMPONENT="$BUILD_DIR/LiveScribe-Companion-component.pkg"
UNSIGNED="$OUTPUT_DIR/LiveScribe-Companion-$VERSION-unsigned.pkg"
SIGNED="$OUTPUT_DIR/LiveScribe-Companion-$VERSION.pkg"
trap 'rm -rf "$BUILD_DIR"' EXIT INT TERM

mkdir -p "$ROOT_DIR/Library/Application Support/LiveScribe" "$OUTPUT_DIR"
find "$ROOT_DIR" -name '.DS_Store' -delete
swiftc -O "$REPO_DIR/companion/macos/LiveScribeHost.swift" \
  -o "$ROOT_DIR/Library/Application Support/LiveScribe/livescribe-host"
chmod 755 "$ROOT_DIR/Library/Application Support/LiveScribe/livescribe-host"
chmod 755 "$REPO_DIR/companion/macos/scripts/postinstall"
xattr -cr "$ROOT_DIR"
dot_clean -m "$ROOT_DIR" 2>/dev/null || true
find "$ROOT_DIR" -name '._*' -delete

COPYFILE_DISABLE=1 pkgbuild --root "$ROOT_DIR" \
  --scripts "$REPO_DIR/companion/macos/scripts" \
  --identifier "com.livescribe.companion" \
  --version "$VERSION" \
  --install-location / \
  --filter '(^|/)\._.*$' \
  --filter '(^|/)\.DS_Store$' \
  "$COMPONENT"

if [[ -n "${INSTALLER_IDENTITY:-}" ]]; then
  productsign --sign "$INSTALLER_IDENTITY" "$COMPONENT" "$SIGNED"
  pkgutil --check-signature "$SIGNED"
  if [[ -n "${NOTARY_PROFILE:-}" ]]; then
    xcrun notarytool submit "$SIGNED" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$SIGNED"
    xcrun stapler validate "$SIGNED"
  fi
  printf '%s\n' "$SIGNED"
else
  cp "$COMPONENT" "$UNSIGNED"
  printf 'WARNING: no INSTALLER_IDENTITY; built an unsigned local-test package.\n' >&2
  printf '%s\n' "$UNSIGNED"
fi
