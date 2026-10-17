// Human check for hard translations: privately asks a bilingual family member
// which meaning is right, waits for their tapback, then sends.

import type { Family, IncomingMessage, Translation } from "../types.js";

export async function requestReview(
  family: Family,
  message: IncomingMessage,
  translation: Translation,
): Promise<void> {
  // TODO:
  // 1. pick a bilingual reviewer (not the sender)
  // 2. DM them: original + options A / B (translation.alternatives)
  // 3. queue it; on their tapback or reply, send the chosen translation and add to the glossary
  // 4. if no answer within N minutes, send the best guess with a note that it's uncertain
}
