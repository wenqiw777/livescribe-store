# Chrome Web Store release plan

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
