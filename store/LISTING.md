# Chrome Web Store listing

## Name

LiveScribe — Meeting Transcript

## Short description

Capture meeting captions with consent, ask questions during calls, and create notes. No meeting bot joins.

## Category

Productivity

## Single purpose

LiveScribe creates user-authorized transcripts and notes from captions already produced by supported browser-based meeting platforms.

## Detailed description

LiveScribe turns the captions from browser-based Zoom, Google Meet, and Microsoft Teams meetings into useful personal notes.

Before every meeting, LiveScribe asks whether you want to start transcription. When enabled, a floating panel shows the live transcript without adding a meeting bot or recording audio.

Features:

- Explicit per-meeting transcription consent
- Live speaker-attributed transcript from meeting captions
- Pause, copy, highlight, and manually end recording
- Ask concise questions about what has been said so far
- Generate structured summaries and action items
- Export completed transcripts as Markdown or text
- Local transcript storage with session deletion controls

AI is optional and is off until the user provides their own Anthropic or OpenAI API key. Transcript content is sent for AI processing only when the user asks a question or requests a summary. Caption transcription and export continue to work without AI.

Requirements:

- Use the browser version of the supported meeting platform
- Meeting captions or live transcription must be available
- Notify participants and follow applicable consent requirements

## Permission justifications

- `storage`: saves extension settings, transcripts, summaries, and the optional user-provided API key.
- `nativeMessaging`: supports a developer-only local debugging interface; it is not part of the public AI setup flow.
- Zoom, Google Meet, and Microsoft Teams host access: detects supported meeting routes and reads captions only after user consent.
- `api.anthropic.com`: sends prompts and selected transcript content to Anthropic only when the user chooses the Anthropic API option and invokes AI.
- `api.openai.com`: sends prompts and selected transcript content to OpenAI only when the user chooses the OpenAI API option and invokes AI.

Remote code declaration:

- LiveScribe does not use remote code. All executable JavaScript is packaged with the extension. AI responses are text data and are never executed as code.

## Privacy dashboard declarations

Data handled:

- Website content: meeting captions and supported meeting metadata
- Personal communications: meeting transcript text and speaker labels
- User-provided content: questions, highlights, and API key

Data uses:

- Core transcript and meeting-notes functionality only
- No advertising, profiling, sale, or unrelated analytics
- No developer-controlled transcript server

Privacy policy URL: `https://wenqiw777.github.io/livescribe/privacy.html`
Support URL: `https://wenqiw777.github.io/livescribe/support.html`
