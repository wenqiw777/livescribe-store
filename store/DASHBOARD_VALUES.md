# Chrome Web Store Dashboard values

Use these values to clear the current publication blockers. Save Draft after each tab.

## Store Listing tab

### Language

English (United States)

### Category

Productivity

### Detailed description

LiveScribe turns captions from browser-based Zoom, Google Meet, and Microsoft Teams meetings into useful personal notes.

Before every meeting, LiveScribe asks whether you want to start transcription. When enabled, a floating panel shows the live transcript without adding a meeting bot or recording audio.

Features:

- Explicit per-meeting transcription consent
- Live speaker-attributed transcript from meeting captions
- Pause, copy, highlight, and manually end recording
- Ask concise questions about what has been said so far
- Generate structured summaries and action items
- Export completed transcripts as Markdown or text
- Local transcript storage with session deletion controls

AI is optional and off by default. Users can provide their own Anthropic API key, provide their own OpenAI API key, or install the separate LiveScribe Companion for local ChatGPT/Claude subscription access. Transcript content is sent for AI processing only when the user asks a question or requests a summary.

Requirements:

- Use the browser version of the supported meeting platform
- Meeting captions or live transcription must be available
- Notify participants and follow applicable consent requirements

### Icon

Upload `store/assets/icon128.png` if present, otherwise upload `src/icons/icon128.png`.

### Screenshots

Upload in this order:

1. `store/assets/01-consent.png`
2. `store/assets/02-live-transcript.png`

## Privacy practices tab

### Single purpose

LiveScribe creates user-authorized transcripts and notes from captions already produced by supported browser-based meeting platforms.

### Host permission justification

LiveScribe uses host permissions for Zoom, Google Meet, and Microsoft Teams to detect supported browser meeting routes and read live captions only after the user explicitly starts transcription. The api.anthropic.com and api.openai.com permissions are used only when the user selects the corresponding API option and actively invokes Ask or Summarize. LiveScribe does not collect unrelated browsing activity.

### nativeMessaging justification

The nativeMessaging permission supports the optional local AI companion selected and installed by the user. When the user invokes Ask, Summarize, or Test connection, LiveScribe sends the selected prompt and transcript content through Chrome Native Messaging to the companion on the same computer. It is not used for advertising, analytics, tracking, or automatic background data collection.

### Remote code justification

LiveScribe does not use remote code. All executable JavaScript is included in the submitted extension package. The extension does not load remote scripts, use eval(), or execute code received from a server. Requests to api.anthropic.com return text data that is displayed as an answer or summary and is never executed as code.

### storage justification

The storage permission saves user settings, meeting transcripts, meeting metadata, highlights, generated answers, and summaries in Chrome extension storage. LiveScribe retains up to 50 local sessions and lets users delete sessions from the popup. User-provided Anthropic and OpenAI API keys are stored in chrome.storage.local; chrome.storage.sync contains only non-sensitive preferences such as the selected backend, provider, and model.

### Privacy policy URL

https://wenqiw777.github.io/livescribe-store/privacy.html

### Data-use certification

Review every certification shown by Chrome and select it only if you agree that the extension's actual behavior and disclosures comply with the Chrome Web Store Developer Program Policies. This legal attestation must be completed by the publisher.

## Publisher Settings

Enter a monitored publisher contact email, request verification, open the verification email, and follow Google's verification link. The contact email must show as verified before submission.

## Distribution recommendation

Use Private visibility and trusted testers for the first review. Choose deferred/manual publishing so approval does not immediately make the extension public.
