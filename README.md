# LiveScribe

LiveScribe captures captions from browser-based Zoom, Google Meet, and Microsoft Teams meetings after explicit per-meeting consent. It provides a live transcript, meeting Q&A, summaries, local session history, and text/Markdown export without adding a meeting bot or recording audio.

## What is this repository?

This is the open-source release repository for the [LiveScribe Chrome extension](https://chromewebstore.google.com/detail/gfhncbgjiechicicabgkmlmcljamdelf). It contains:

- The Manifest V3 extension shipped through the Chrome Web Store.
- Caption collectors and the in-meeting transcript panel for Zoom, Google Meet, and Microsoft Teams.
- Direct Anthropic and OpenAI API integrations using a key supplied by the user.
- A developer-only Native Messaging host that connects LiveScribe to an existing local Codex or Claude Code login.
- Store packaging scripts, privacy disclosures, reviewer instructions, screenshots, and regression tests.

The Chrome Web Store ZIP contains only the extension runtime. It deliberately excludes `native-host/`, Companion source, tests, Store documents, and local build tools. Clone this repository only if you want to inspect the source, contribute, build the extension, or enable the developer AI Companion.

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

The public settings UI exposes only the two direct API options. The developer AI Companion is an unsupported local debugging path and is not required for transcription.

The localhost HTTP bridge is intentionally absent from this Store repository and Store ZIP.

## How to activate the developer AI Companion on macOS

The Companion lets LiveScribe use a Codex or Claude Code CLI that is already installed and logged in on your Mac. It does not copy a ChatGPT or Claude credential into the extension. Chrome starts the registered local host only when LiveScribe sends it a request.

### Prerequisites

- macOS with Google Chrome, Chrome Beta/Canary, Chromium, Microsoft Edge, Brave, or Arc installed and opened at least once.
- Node.js available as `node` in your shell.
- At least one of these installed and logged in:
  - Codex CLI as `codex` for a ChatGPT subscription.
  - Claude Code as `claude` for a Claude Pro/Max subscription.
- This repository cloned locally. The Web Store download does not include the installer.

### 1. Register the local host

For the published Chrome Web Store extension, run:

```sh
git clone https://github.com/wenqiw777/livescribe-store.git
cd livescribe-store
./native-host/install.sh gfhncbgjiechicicabgkmlmcljamdelf
```

If you loaded the extension from source instead, open `chrome://extensions`, copy the 32-character ID shown on the LiveScribe card, and use that ID in the final command:

```sh
./native-host/install.sh <YOUR_EXTENSION_ID>
```

The installer resolves the current `node`, `codex`, and `claude` locations, writes `native-host/run-host.sh`, and registers `com.livescribe.summarizer` in every supported Chromium browser found on the Mac.

### 2. Reveal the private Companion controls

1. Reload LiveScribe from `chrome://extensions`, or restart Chrome.
2. Open **LiveScribe settings** from the extension popup.
3. Click the invisible 28 × 28 pixel area at the absolute bottom-left corner of the settings page.
4. The **Model provider (subscription)** panel appears. `AI Companion` does not appear in the public **Use AI with** dropdown.
5. Select **Codex** or **Claude Code**.
6. Click **Test Companion**. A successful setup shows `Connected ✓`.

Clicking the hidden area immediately saves the Native Messaging backend. Ask uses `gpt-5.6-luna` and Summarize uses `gpt-5.6-terra` when Codex is selected.

### 3. Return to an API backend

Choose **Use my Anthropic API key** or **Use my OpenAI API key** in **Use AI with**, enter the key, choose a model, and click **Save**. Selecting a public option disables the private Companion backend.

### Troubleshooting

- `Companion not found` or `not authorized`: rerun `install.sh` with the exact extension ID, then reload the extension.
- `node not found`: install Node.js and confirm `command -v node` prints a path.
- `neither claude nor codex found`: install and log in to at least one supported CLI, then rerun the installer.
- One provider is unavailable: the installer reports which CLI was not found. Choose the provider that was installed.
- No browser profile found: open the browser once, close the error, and rerun the installer.
- A CLI works in Terminal but not LiveScribe: rerun the installer so `run-host.sh` captures its current absolute path and login environment.

Security note: anyone can inspect open-source extension code and discover this control. It is hidden to keep the public setup simple, not to provide access control. The Native Messaging manifest still restricts the local host to the extension ID passed to `install.sh`.

## License

LiveScribe is open source under the [MIT License](LICENSE).

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
