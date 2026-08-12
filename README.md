# LiveScribe Chrome Web Store edition

LiveScribe captures captions from browser-based Zoom, Google Meet, and Microsoft Teams meetings after explicit per-meeting consent. It provides a live transcript, meeting Q&A, summaries, local session history, and text/Markdown export without adding a meeting bot or recording audio.

This repository is the isolated Chrome Web Store release edition. Store packaging, policy text, and release assets are maintained here without modifying the separate development copy.

## Local test

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this repository.
4. Join a supported meeting in the browser.
5. Confirm LiveScribe asks before starting transcription.

## AI options

- **Anthropic API:** enter a personal API key in extension settings. Requests go directly to Anthropic over HTTPS.
- **OpenAI API:** enter a personal API key in extension settings. Requests go directly to OpenAI over HTTPS.

AI is off on a new install. Transcription and export work without AI; Ask and Summarize remain disabled until one option is ready.

The public settings UI exposes only the two direct API options. A transparent 28 px control at the bottom-left of the settings page enables the developer-only Native Messaging backend for local debugging.

The localhost HTTP bridge is intentionally absent from this Store repository and Store ZIP.

## Verify

```sh
node test/store-readiness.test.js
node test/preflight.js
```

The complete regression suite requires `jsdom`:

```sh
deps=$(mktemp -d)
npm install --prefix "$deps" jsdom@26
for test_file in test/*.test.js; do
  NODE_PATH="$deps/node_modules" node "$test_file"
done
```

## Build the Store ZIP

```sh
./scripts/package-store.sh
```

The resulting archive is written to `dist/`. `manifest.json` is at the archive root. Tests, Store documentation, screenshots, the localhost bridge, and Companion/native-host source are excluded.

Build the separate macOS Companion with `./scripts/package-companion-macos.sh`. Set `INSTALLER_IDENTITY` and `NOTARY_PROFILE` to produce and notarize the public package; without them, the script clearly labels the output unsigned for local testing only.

## Submission material

- `store/PRIVACY.md` — host this at a public HTTPS URL before submission.
- `store/LISTING.md` — listing copy, permission justifications, and privacy declarations.
- `store/REVIEWER_INSTRUCTIONS.md` — paste into the dashboard's test-instructions field.
- `store/assets/` — Store screenshots.

Start with **Private / trusted testers**, complete a real meeting pass, and then change distribution to Public after approval.
