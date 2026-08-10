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

- **Local AI companion:** install `native-host/install.sh` with the unpacked or Store extension ID. Ask uses `gpt-5.6-luna`; summaries use `gpt-5.6-terra` through the local Codex CLI route.
- **Anthropic API:** enter a personal API key in extension settings. The key is stored in Chrome local extension storage and requests go directly to Anthropic over HTTPS.

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

The resulting archive is written to `dist/`. `manifest.json` is at the archive root. Tests, Store documentation, screenshots, the localhost bridge, and native-host source are excluded.

## Submission material

- `store/PRIVACY.md` — host this at a public HTTPS URL before submission.
- `store/LISTING.md` — listing copy, permission justifications, and privacy declarations.
- `store/REVIEWER_INSTRUCTIONS.md` — paste into the dashboard's test-instructions field.
- `store/assets/` — Store screenshots.

Start with **Private / trusted testers**, complete a real meeting pass, and then change distribution to Public after approval.
