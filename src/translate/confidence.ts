// Decides whether a translation needs a bilingual family member to confirm it,
// and spots emergencies. Owned by User 2. Called by relay/router.ts and index.ts.
//
// FROZEN SIGNATURES: isEmergency(text) → boolean; needsReview(original, translation) → boolean
//
// Test: npx tsx src/translate/confidence.selftest.ts

import { config } from "../config.js";
import { isConfirmedPhrase } from "./glossary.js";
import type { Translation } from "../types.js";

// Kept specific on purpose: a false alarm ("can you help me with homework") would flag a
// normal chat message with 🚨. Add your demo languages here and add cases to the selftest.
// \b is ASCII-only in JS, so patterns ending in accented letters use (?![\p{L}]) instead.
const EMERGENCY_PATTERNS: RegExp[] = [
  // English
  /^\s*(please\s+)?help(\s+me)?(\s+please)?\s*[!.]*\s*$/iu,
  /\bhelp\b.{0,30}\b(fell|fallen|hurt|bleeding|pain|hospital|ambulance|can't breathe)\b/iu,
  /\b(i fell|i've fallen|i have fallen|fell down)\b(?!\s+(asleep|for|in love|behind|off|out of))/iu,
  /\b(can'?t breathe|cannot breathe|chest pain|(having|had) a (heart attack|stroke)|i'?m bleeding)\b/iu,
  // Chinese (Simplified + Traditional)
  /救命|快来人|快來人|摔倒了|跌倒了|我摔倒|我跌倒|救护车|救護車|急救|心脏病|心臟病|心脏不舒服|心臟不舒服|喘不过气|喘不過氣|胸口痛|胸口疼/u,
  // Spanish
  /(^|[^\p{L}])(ayuda|socorro|auxilio|me ca[ií]|no puedo respirar)(?![\p{L}])/iu,
  // Korean
  /살려|도와줘|넘어졌|구급차|숨을 못|숨이 안/u,
  // Vietnamese
  /cứu tôi|cứu với|tôi bị ngã|gọi cấp cứu|xe cứu thương|không thở được/iu,
];

// Unambiguous calls for an ambulance: these alert even with a "lol" in the message.
const ALWAYS_EMERGENCY = /\bcall (911|999|112|an ambulance)\b|叫救护车|叫救護車|llam[ae] (a )?(una )?ambulancia|gọi cấp cứu|119 불러/iu;

// Internet slang: "救命这个好好笑" = "OMG this is hilarious". Laughter in the same message
// means the scary word is a joke.
const LAUGHTER = /好好笑|哈哈|笑死|太好笑|\blol\b|\blmao\b|\bhaha|\bjk\b|😂|🤣|😆|😹|ㅋㅋ|jaja/iu;

export function isEmergency(text: string): boolean {
  if (ALWAYS_EMERGENCY.test(text)) return true;
  if (LAUGHTER.test(text)) return false;
  return EMERGENCY_PATTERNS.some((p) => p.test(text));
}

export function needsReview(original: string, translation: Translation): boolean {
  if (isEmergency(original)) return false; // emergencies skip review and send right away
  if (translation.uncertain) return false; // translation failed entirely; nothing to choose between
  if (isConfirmedPhrase(original)) return false; // a reviewer already answered this one: Bridge learned it
  return translation.confidence < config.reviewConfidenceThreshold;
}
