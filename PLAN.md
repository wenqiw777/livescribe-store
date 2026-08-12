# Chrome Web Store release plan

## 0.1.1 AI onboarding and Companion

### Acceptance

- A new install shows an explicit AI setup choice instead of defaulting to an unavailable native host.
- Settings offer exactly three user-facing paths: Anthropic API key, OpenAI API key, or ChatGPT / Claude subscription through the Companion.
- Anthropic and OpenAI API requests use the selected user's key and do not fall through to Native Messaging.
- Caption capture, pause, copy, end, and transcript export continue to work with no AI configured.
- Ask and Summarize are disabled with a clear setup link when AI is unconfigured or the selected Companion is unavailable.
- The macOS Companion installer authorizes Store extension ID `gfhncbgjiechicicabgkmlmcljamdelf` without asking users to copy an ID or run a shell command.
- `0.1.1` Store ZIP excludes Companion/native binaries; the Companion is a separate `.pkg` download.
- Signed/notarized status is claimed only when a Developer ID Installer identity and successful Apple notary result are both verified.

### Tasks

- [x] Add red tests for AI choices, API routing, unavailable-AI degradation, and Store-ID authorization.
- [x] Implement settings, provider routing, and in-meeting availability UI.
- [x] Build the separate macOS Companion package and download flow.
- [x] Run regression, browser UI, archive, installer, signature, and notarization checks.

### 0.1.1 evidence

- New red tests failed before implementation and now pass: `ai-options`, `ai-unavailable`, `companion-package`, and `companion-host`.
- The existing regression suite passes except the Store-readiness assertions that were deliberately updated for the two-key storage shape; the updated Store-readiness test passes all 16 checks.
- `node test/preflight.js` is clean, and `dist/livescribe-0.1.1.zip` passes `unzip -tq` with 21 runtime entries and no tests or Companion sources.
- The Swift Companion host compiled and returned `{ok:true}` over real Chrome Native Messaging length-prefixed framing.
- `dist/LiveScribe-Companion-0.1.1-unsigned.pkg` builds and contains `/Library/Application Support/LiveScribe/livescribe-host`; it is explicitly unsigned and is not a public release artifact.
- Chrome UI verification confirmed the default `Choose how to use AI` state, all three options, and the visible `Download Companion for Mac` call to action. The Companion view screenshot was visually inspected.
- A live OpenAI Responses smoke request using the user-selected local env file reached OpenAI but returned HTTP 401 `invalid_api_key`; no secret was printed or copied. Real OpenAI-key validation remains open.
- `security find-identity` found Apple Development certificates but no Developer ID Installer identity, and no notarytool profile was found. Public signing/notarization remains externally blocked.

### Current external gate

- This Mac currently has Apple Development identities only. A public signed/notarized `.pkg` additionally requires a Developer ID Installer certificate and configured Apple notarization credentials.

## Acceptance

- The separate development repository is unchanged by Store preparation.
- The Store manifest has a <=132 character consent-forward description and only permissions used by shipped features.
- The Store build has no localhost HTTP bridge; AI uses either the separately installed native Codex host or the user's Anthropic API key.
- The API key is stored locally, not in Chrome sync storage.
- Privacy policy, listing copy, reviewer instructions, screenshots, and a reproducible ZIP are present.
- The ZIP has `manifest.json` at its root and excludes tests, local host sources, bridge sources, and release documentation.
- Existing extension regression tests and Store-readiness checks pass.

## Tasks

- [x] Make the Store runtime and manifest reviewable.
- [x] Add listing, privacy, review, and packaging assets.
- [x] Generate and inspect the ZIP.
- [x] Run regression verification and record evidence.
- [x] Create one clean Git commit.

## Evidence

- `node test/store-readiness.test.js`: all 16 Store checks passed, including the personal-name and absolute-path scrub.
- All 18 `test/*.test.js` files passed with `jsdom@26`; targeted rerun confirmed the final WebSocket, Zoom lifecycle, and Zoom Redux tests.
- `node test/preflight.js`: clean.
- `scripts/package-store.sh`: generated `dist/livescribe-0.1.0.zip`; `unzip -tq` reported no errors.
- Package inspection: 21 entries, one root `manifest.json`, zero `test/`, `store/`, `bridge/`, `native-host/`, or `scripts/` entries.
- ZIP SHA-256: `9db7282911df1ac612dcbad0d67855cd6c63cff2eedf57ac460ce876d018e357`.
- Store screenshots `01-consent.png` and `02-live-transcript.png` are both 1280x800 and were visually inspected.
- Store examples use only generic names: Alex Johnson, Sarah Miller, and Chris Lee. The generated native-host wrapper containing machine-specific paths is not tracked.
- `git diff --check`: clean.

## Dispositions

- The native messaging companion remains in this repository for users who choose local Codex, but is excluded from the Store ZIP because Chrome Web Store cannot install native applications.
- No remote upload or Chrome Web Store submission is authorized in this task.
- Dashboard registration, public privacy/support URLs, companion distribution URL, and a final authenticated real-Zoom pass remain publisher-owned gates documented in `store/SUBMISSION_CHECKLIST.md`.

## GitHub Pages

- [x] Build a static Home, Privacy, and Support site with no analytics, third-party scripts, or tracking cookies.
- [x] Add a GitHub Actions Pages deployment workflow.
- [x] Verify desktop and mobile rendering in Chrome with no console warnings or errors.
- [x] Publish the repository and confirm the public Pages URLs return successfully.

Local evidence:

- Chrome accessibility snapshots exposed the intended headings, navigation, policy sections, and privacy summary.
- Desktop and 390x844 mobile screenshots were visually inspected.
- `node test/store-readiness.test.js`, `node test/preflight.js`, and `git diff --check` passed after adding the site.
- GitHub Pages workflow run `31441587107` completed successfully with current Node 24-compatible action versions.
- Home, Privacy, and Support public URLs each returned HTTP 200 after deployment.
