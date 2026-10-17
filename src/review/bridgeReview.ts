// Human check for hard translations: privately asks a bilingual family member
// which meaning is right, waits for their answer, then lets the message send.
// Owned by User 1. Called by relay/router.ts.
//
// FROZEN SIGNATURE: requestReview(family, sender, recipient, originalText, translation) → Translation

import { config } from "../config.js";
import { ask } from "../relay/prompts.js";
import { addEntry } from "../translate/glossary.js";
import type { Family, FamilyMember, Translation } from "../types.js";

const LETTERS = ["A", "B", "C", "D"];

// One question per (message, target language), shared by every recipient who reads that language.
const inFlight = new Map<string, Promise<Translation>>();

export function requestReview(
  family: Family,
  sender: FamilyMember,
  recipient: FamilyMember,
  originalText: string,
  translation: Translation,
): Promise<Translation> {
  const key = `${family.id}|${sender.id}|${originalText}|${recipient.language}`;
  if (!inFlight.has(key)) {
    inFlight.set(key, askReviewer(family, sender, recipient, originalText, translation));
    setTimeout(() => inFlight.delete(key), config.reviewTimeoutMs + 60_000);
  }
  return inFlight.get(key)!;
}

async function askReviewer(
  family: Family,
  sender: FamilyMember,
  recipient: FamilyMember,
  originalText: string,
  translation: Translation,
): Promise<Translation> {
  // TODO [U1] prefer a reviewer whose reviewLanguages cover both sender.language and recipient.language
  const reviewer = family.members.find((m) => m.isBilingualReviewer && m.id !== sender.id);
  if (!reviewer) return { ...translation, uncertain: true };

  const options = [translation.text, ...(translation.alternatives ?? [])].slice(0, LETTERS.length);
  const question = [
    `🤔 ${sender.name} said: “${originalText}”`,
    `Which ${recipient.language} meaning is right?`,
    ...options.map((o, i) => `${LETTERS[i]}) ${o}`),
    `Reply ${LETTERS.slice(0, options.length).join(" / ")} (or type a better translation).`,
  ].join("\n");

  // TODO [U1] tapback answers: e.g. 👍 = A, ❤️ = B (say so in the question)
  const answer = await ask(reviewer.handle, question, config.reviewTimeoutMs);

  if (!answer) return { ...translation, uncertain: true }; // no answer in time → best guess, flagged
  if (answer.via === "tapback") return translation; // TODO [U1] map tapbacks to options
  const idx = LETTERS.indexOf(answer.text.toUpperCase());
  const chosen = idx >= 0 && options[idx] ? options[idx]! : answer.text; // a free-text answer is a correction
  // Learn from the answer so Bridge asks less next time. TODO [U1] agree the entry format with User 2.
  addEntry(family.id, { term: originalText, meaning: chosen, keepAsIs: false });
  return { ...translation, text: chosen, confidence: 1, uncertain: false };
}
