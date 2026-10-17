// Voice notes: transcribe incoming audio and optionally reply with synthesized speech.
// TODO: choose a speech-to-text / text-to-speech provider.

import type { LanguageCode } from "../types.js";

export async function transcribe(audioPath: string, language: LanguageCode): Promise<string> {
  // TODO
  throw new Error("not implemented");
}

export async function synthesize(text: string, language: LanguageCode): Promise<string> {
  // TODO: return path to an audio file
  throw new Error("not implemented");
}
