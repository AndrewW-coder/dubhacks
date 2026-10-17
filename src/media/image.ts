// Photos of letters, prescription labels, and forms: extract text, translate, and explain.
// Owned by User 2. Called by relay/router.ts for every relayed photo.
//
// FROZEN SIGNATURE: explainImage(imagePath, targetLanguage) → short explanation, or "" for
// ordinary photos with no text (selfies, food) so nothing extra is sent.

import type { LanguageCode } from "../types.js";

export async function explainImage(imagePath: string, targetLanguage: LanguageCode): Promise<string> {
  // TODO [U2] send the image to Claude (vision) and ask: does it contain text? If so,
  // translate it into targetLanguage and explain it in plain words. Otherwise return "".
  return "";
}
