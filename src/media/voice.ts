// Voice notes: transcribe incoming audio and optionally reply with synthesized speech.
// Owned by User 2. Called by relay/router.ts.
//
// FROZEN SIGNATURES:
//   transcribe(audioPath, language) → transcript text in the speaker's language
//   synthesize(text, language)      → path to an audio file (.m4a/.caf/.mp3) to send with sendFile(..., { asVoiceNote: true })
//
// iMessage voice notes arrive as .caf (Opus/AAC). Many speech-to-text APIs want
// mp3/wav/m4a — you may need to convert (e.g. ffmpeg) first.

import type { LanguageCode } from "../types.js";

export async function transcribe(audioPath: string, language: LanguageCode): Promise<string> {
  // TODO [U2] pick a provider (SPEECH_PROVIDER / SPEECH_API_KEY in .env) and transcribe
  return `(voice note — transcription not built yet: ${audioPath})`;
}

export async function synthesize(text: string, language: LanguageCode): Promise<string> {
  // TODO [U2] optional: text-to-speech so grandparents can listen instead of read
  throw new Error("synthesize not implemented");
}
