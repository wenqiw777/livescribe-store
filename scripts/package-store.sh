#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(node -p "require('$repo_dir/manifest.json').version")
output_dir="$repo_dir/dist"
archive="$output_dir/livescribe-$version.zip"
stage_dir=$(mktemp -d)
trap 'rm -rf "$stage_dir"' EXIT INT TERM

mkdir -p "$output_dir" "$stage_dir/src"
cp "$repo_dir/manifest.json" "$repo_dir/background.js" \
  "$repo_dir/popup.html" "$repo_dir/popup.js" \
  "$repo_dir/options.html" "$repo_dir/options.js" "$stage_dir/"
cp -R "$repo_dir/src/." "$stage_dir/src/"

rm -f "$archive"
(cd "$stage_dir" && zip -qr "$archive" .)
unzip -tq "$archive"
printf '%s\n' "$archive"
