// Photos of letters, prescription labels, and forms: extract text, translate, and explain.

import type { LanguageCode } from "../types.js";

export async function explainImage(imagePath: string, targetLanguage: LanguageCode): Promise<string> {
  // TODO: send the image to Claude and ask for a translation plus a plain-language explanation
  throw new Error("not implemented");
}
