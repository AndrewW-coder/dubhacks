// Tone-aware translation with Claude.
// The prompt should include: sender and recipient relationship (for honorifics),
// the family glossary, and recent conversation context.

import type { FamilyMember, Translation } from "../types.js";

export async function translate(
  text: string,
  from: FamilyMember,
  to: FamilyMember,
): Promise<Translation> {
  // TODO: call Claude and ask for JSON: { text, confidence, notes, alternatives }
  throw new Error("not implemented");
}
