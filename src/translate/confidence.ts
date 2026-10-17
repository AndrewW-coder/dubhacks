// Decides whether a translation needs a bilingual family member to confirm it.

import { config } from "../config.js";
import type { Translation } from "../types.js";

const EMERGENCY_PATTERNS = [/\bhelp\b/i, /\bi fell\b/i, /\bhospital\b/i]; // TODO: add patterns per language

export function isEmergency(text: string): boolean {
  return EMERGENCY_PATTERNS.some((p) => p.test(text));
}

export function needsReview(original: string, translation: Translation): boolean {
  if (isEmergency(original)) return false; // emergencies skip review and send right away
  return translation.confidence < config.reviewConfidenceThreshold;
}
