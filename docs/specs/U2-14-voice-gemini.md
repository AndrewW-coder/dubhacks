# Spec U2-14: Voice notes through Gemini (no OpenAI key needed)
Subagent: **voice-gemini** · Copy: `/home/claude/work/v-voice/` · Read first: `U2-00-master.md` (rules), `src/media/voice.ts` (current OpenAI-based version + selftest), `src/translate/claude.ts` (provider layer; Gemini via its OpenAI-compatible endpoint), `src/relay/router.ts` (voice path).

**Owns:** `src/media/voice.ts`, `src/media/voice.selftest.ts`, and **additive** changes to `src/translate/claude.ts` (keep every existing export and behaviour; `claude.selftest.ts` must still pass).

## Goal
`transcribe()` works with the key the team already has. When the AI provider is Gemini (`provider()==="gemini"`) and no `SPEECH_API_KEY` is set, transcription goes through Gemini. OpenAI stays available when `SPEECH_PROVIDER=openai` + `SPEECH_API_KEY` are set. Selection order:
1. explicit `SPEECH_PROVIDER`;
2. `SPEECH_API_KEY` → openai;
3. Gemini configured → gemini;
4. else the placeholder.

## Requirements
1. **Verify with WebSearch/WebFetch** how the Gemini OpenAI-compatible endpoint accepts audio: the `input_audio` content part (`{type:"input_audio", input_audio:{data:<base64>, format:"wav"|"mp3"}}`), supported formats, and size limits (inline request size). If the compat endpoint can't take audio, use the native `generateContent` REST endpoint with `inline_data` (mime `audio/…`), using `fetch`; no new deps. Cite the URLs.
2. Convert `.caf`/other formats with the existing ffmpeg path to a format Gemini accepts (16 kHz mono mp3 or wav), then send it with a prompt like: "Transcribe this voice note exactly, in its original language (likely <lang name>). Return only the words spoken."
   - Prefer a structured `callTool`-style answer `{ transcript }` if audio + tools works; otherwise plain text.
   - Respect the model fallback and quota behaviour already in `claude.ts`: reuse its request helper by exporting a small additive function, e.g. `callAudio()`. Don't duplicate retry logic.
3. Keep every `transcribe()` guarantee: never throws; the same placeholder messages; 30 s timeout; size cap (Gemini inline audio limit); one log line per call.
4. `synthesize()` is unchanged: OpenAI TTS if configured, else throw, as today.
5. Header docs: which provider is picked and when; no new required env vars (optional `SPEECH_PROVIDER=gemini|openai`).

## Verify (offline)
- Extend `voice.selftest.ts` with a fake Gemini server (`LLM_BASE_URL` + `TRANSLATE_PROVIDER=gemini` + `LLM_API_KEY=fake`). Assert:
  - a `.caf` is converted and sent as audio;
  - the language hint is in the prompt;
  - the transcript is returned;
  - a 429 falls back to the next model / placeholder;
  - with the OpenAI key set, OpenAI is used instead;
  - with no keys, the placeholder is returned and no request is made.
- `npx tsc --noEmit`; all `src/**/*.selftest.ts`; `npm run sim:demo`, `sim:u2`, and `npx tsx src/sim.ts data/demo-shopping-u2.txt`.
- Report per master rule 8. **The orchestrator will run one real Gemini transcription on reallyrealistic's machine afterwards.**
