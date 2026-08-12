# LiveScribe Privacy Policy

Effective date: August 10, 2026

LiveScribe helps users capture captions from supported browser-based meetings, review the resulting transcript, ask questions about it, and create meeting notes. LiveScribe does not join meetings as a bot and does not record meeting audio.

## Data LiveScribe handles

LiveScribe may handle meeting captions, speaker names supplied by the meeting platform, meeting page title and URL, transcript highlights, questions entered by the user, generated answers and summaries, and an Anthropic or OpenAI API key if the user chooses that AI option.

## Consent

LiveScribe asks the user before starting transcription for every meeting. Users are responsible for notifying meeting participants and complying with applicable laws, organizational policies, and meeting-platform rules.

## Storage and retention

Transcripts, answers, summaries, meeting metadata, and optional user-provided API keys are stored in Chrome local extension storage on the user's device. LiveScribe retains up to 50 sessions and allows users to delete sessions from the extension popup. Uninstalling the extension removes its Chrome extension storage. API keys are not placed in Chrome sync storage.

## AI processing and sharing

AI processing occurs only when the user asks a question, requests a summary, or tests an AI connection.

- If the user selects the local AI companion, the selected transcript content and prompt are sent through Chrome Native Messaging to software installed on the same computer.
- If the user selects the Anthropic API option, the selected transcript content, prompt, and user-provided API key are sent directly over HTTPS to Anthropic. Anthropic processes that data under its own terms and privacy policy.
- If the user selects the OpenAI API option, the selected transcript content, prompt, and user-provided API key are sent directly over HTTPS to OpenAI. OpenAI processes that data under its own terms and privacy policy.

LiveScribe does not operate a developer-controlled transcript server. The developer does not sell meeting data, use it for advertising, or permit humans to read it. Data is not shared except as needed to provide the AI option explicitly selected by the user, comply with law, or protect security.

## Permissions

LiveScribe requests access only to supported meeting sites, Anthropic's API, OpenAI's API, Chrome storage, and Chrome Native Messaging. Meeting-site access is used solely to detect supported meeting pages and read captions after the user starts transcription.

## Security

External API traffic uses HTTPS. Communication with the local companion uses Chrome's Native Messaging channel. Users should protect API keys and meeting transcripts as sensitive information.

## Changes and contact

Material changes to these practices will be disclosed in the extension and this policy before new data handling begins. For privacy questions, contact the developer using the support contact shown on the LiveScribe Chrome Web Store listing.
