// Tone-aware translation with Claude. Owned by User 2. Called by relay/router.ts.
//
// FROZEN SIGNATURE: translate(text, from, to, family) → Translation
//
// The prompt should include: sender and recipient relationship (for honorifics),
// the family glossary (getGlossary(family.id)), and recent conversation context.

import type { Family, FamilyMember, Translation } from "../types.js";

export async function translate(
  text: string,
  from: FamilyMember,
  to: FamilyMember,
  family: Family,
): Promise<Translation> {
  // ── PLACEHOLDER so the relay works before translation exists. Replace with Claude. ──
  // TODO [U2] call Claude and ask for JSON: { text, confidence, notes, alternatives }
  if (from.language === to.language) return { text, confidence: 1 };
  if (text.includes("🧪")) {
    // Lets User 1 test the review flow before real translation exists. Keep this test hook.
    return {
      text: `[${from.language}→${to.language}] meaning A`,
      confidence: 0.3,
      alternatives: [`[${from.language}→${to.language}] meaning B`],
      notes: "Placeholder: idiom with two possible meanings.",
    };
  }
  return { text: `[${from.language}→${to.language}] ${text}`, confidence: 0.99 };
}
