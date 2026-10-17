# Spec U2-02: Voice notes (guide step 4)

Subagent: **voice** · Copy: `/home/claude/work/voice/` · Read first: `docs/specs/U2-00-master.md`, `docs/USER2_GUIDE.md` step 4, `src/media/voice.ts`, `src/relay/router.ts` (the `voice` case), `src/photon/mock.ts` (the `voice <path>` sim command), `src/config.ts` (`speechProvider`, `speechApiKey`).

## Owns
`src/media/voice.ts`, new `src/media/voice.selftest.ts`.

## Goal
A grandparent sends an iMessage voice note. Bridge transcribes it in their language; the router then translates it and relays it as `🎤 Nai Nai: …`. Optional: Bridge can speak a reply back.

## Requirements

### R1 Provider: OpenAI audio API over `fetch` (no new dependency)
- **Check the current OpenAI docs with WebFetch/WebSearch before coding**: endpoint paths, model names, form fields, size limits, accepted formats. Expected but must be verified:
  - transcription: `POST /v1/audio/transcriptions` (multipart: `file`, `model`, optional `language`, `response_format`), with a modern transcription model (e.g. `gpt-4o-transcribe`, falling back to `whisper-1`);
  - speech: `POST /v1/audio/speech` (JSON: `model`, `input`, `voice`, `format`).
- `SPEECH_PROVIDER` `openai` (default when `SPEECH_API_KEY` is set). Structure the code as a small provider table so `deepgram`/`elevenlabs` can be added later, but implement only `openai`.
- Base URL `process.env.SPEECH_BASE_URL ?? "https://api.openai.com"` (used for fake-server tests; document it in the header).
- Optional `SPEECH_MODEL`, `SPEECH_TTS_MODEL`, `SPEECH_VOICE` env overrides with sensible defaults (document them in the header).
- Pass a language hint: map our codes (`zh`, `zh-TW`, `yue`, `en`, `ko`, `vi`, `es`, …) to what the API accepts (ISO-639-1), and omit it when unknown.
- Use Node 22 globals `fetch`, `FormData` and `Blob`. Use a timeout (AbortController, ~30 s).

### R2 Format conversion
- iPhone voice notes are `.caf` (Opus or AAC). If the extension isn't in the provider's accepted list, convert with **ffmpeg** (via `child_process.spawn`, no shell) to `.m4a` (AAC) or `.mp3` in `.bridge-tmp/`.
- Detect ffmpeg once (`ffmpeg -version`). If it's missing, try uploading the original anyway; if that fails, return a clear placeholder. reallyrealistic is on **Windows**, where ffmpeg may not be installed: mention `winget install ffmpeg` in the header comment.
- Reject files over the provider's size limit with a friendly placeholder.

### R3 Contracts
- `transcribe()` **never throws**:
  - no key → the existing placeholder;
  - error → `"(voice note — couldn't transcribe it)"`;
  - empty transcript → `"(voice note — no speech heard)"`.
- `synthesize(text, language)` returns a path to an audio file in `.bridge-tmp/` (prefer `.m4a` for iMessage, converting with ffmpeg if the API returns mp3 and ffmpeg exists). It **may throw** (the router doesn't call it yet). Add a header note on how User 1 would send it: `sendFile(handle, path, { asVoiceNote: true })`.
- Log one line per call (duration, bytes, provider) to help debugging.

## Verification (no API key exists)
- Generate test audio with ffmpeg in `scratch/`: a 2 s sine `.wav`, and the same encoded as `.caf` (e.g. `-c:a aac` or `libopus` in a CAF container, whichever ffmpeg supports here).
- Write a fake OpenAI server in `scratch/` that records each request (path, fields, file name, mime) and returns a canned transcript (`{"text":"奶奶想你了"}`) or canned mp3 bytes.
- `src/media/voice.selftest.ts`, runnable with `SPEECH_API_KEY=fake SPEECH_BASE_URL=http://127.0.0.1:<port>`, asserts:
  - `.caf` is converted before upload;
  - the language hint is sent;
  - the transcript is returned;
  - a server 500 gives the friendly placeholder;
  - no key gives the placeholder without any request;
  - `synthesize` writes a file.
- End to end: a scratch sim script with `nainai: voice scratch/test.caf` → Kevin's phone line shows `🎤 Nai Nai: [zh→en] 奶奶想你了` (no Anthropic key, so the translation stays a placeholder).
- `npx tsc --noEmit`, `npm run sim:demo`, `npm run sim:u2` pass with no keys.
