// Decides whether a translation needs a bilingual family member to confirm it.
// Owned by User 2. Called by relay/router.ts.
//
// FROZEN SIGNATURES: isEmergency(text) → boolean; needsReview(original, translation) → boolean

import { config } from "../config.js";
import type { Translation } from "../types.js";

// TODO [U2] add patterns for every demo language (e.g. 救命, 我摔倒了, 医院)
const EMERGENCY_PATTERNS = [/\bhelp\b/i, /\bi fell\b/i, /\bhospital\b/i];

export function isEmergency(text: string): boolean {
  return EMERGENCY_PATTERNS.some((p) => p.test(text));
}

export function needsReview(original: string, translation: Translation): boolean {
  if (isEmergency(original)) return false; // emergencies skip review and send right away
  // TODO [U2] skip review for phrases already in the family glossary (Bridge "learns")
  return translation.confidence < config.reviewConfidenceThreshold;
}
