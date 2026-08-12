# Chrome Web Store reviewer instructions

## Core transcription test

No account or paid service is required to test the core extension.

1. Install the extension and open a browser-based Zoom, Google Meet, or Microsoft Teams meeting.
2. The LiveScribe panel asks `Transcribe this meeting?`; confirm that transcription does not start automatically.
3. Choose `Yes, this time`.
4. Enable the meeting platform's caption/live-transcription feature if it is not already enabled.
5. Speak and confirm that caption text appears in the LiveScribe panel.
6. Click `End`; confirm caption collection stops while the meeting continues and the save/export screen appears.
7. Open the toolbar popup to review or delete the saved transcript.

## AI features

AI is an optional extension of the same meeting-notes purpose and requires user configuration:

- Developer-only local AI debugging: the public selector does not expose this mode. For review transparency, clicking the transparent 28 px area at the bottom-left of the settings page reveals the Native Messaging controls. It requires the separately registered host `com.livescribe.summarizer`; no host is included in the Store ZIP.
- Anthropic API: requires the reviewer's own Anthropic API key in LiveScribe settings. The key is stored in Chrome local extension storage. Requests go directly to `https://api.anthropic.com` only when Ask or Summarize is invoked.
- OpenAI API: requires the reviewer's own OpenAI API key in LiveScribe settings. The key is stored in Chrome local extension storage. Requests go directly to `https://api.openai.com` only when Ask or Summarize is invoked.
- With no AI option selected, transcription, pause, copy, end, and export remain available; Ask and Summarize show a settings prompt and stay disabled.

The core transcription, persistence, export, and deletion workflow can be reviewed without either AI configuration.

## Notable implementation details

- All executable extension logic is packaged in the submitted ZIP; no remote JavaScript is loaded or evaluated.
- MAIN-world scripts observe caption-related state produced by supported meeting pages. They forward caption data to isolated content scripts but do not expose Chrome extension APIs to the page.
- The extension stores a maximum of 50 sessions and does not send transcripts to a developer-controlled server.
