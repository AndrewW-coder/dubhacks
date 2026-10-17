// Human check for hard translations: privately asks the family's bilingual
// members which meaning is right, takes the first answer, then lets the
// message send. Owned by User 1. Called by relay/router.ts.
//
// FROZEN SIGNATURE: requestReview(family, sender, recipient, originalText, translation) → Translation

import { config } from "../config.js";
import { askFirst, type Answer } from "../relay/prompts.js";
import { sendText } from "../photon/client.js";
import { addEntry } from "../translate/glossary.js";
import { translate } from "../translate/translator.js";
import type { Family, FamilyMember, LanguageCode, TapbackKind, Translation } from "../types.js";

const LETTERS = ["A", "B", "C", "D"];
// Tapback answers, in option order. 👎 means "none of these fit".
const TAPBACK_OPTIONS: TapbackKind[] = ["like", "love", "laugh", "emphasize"];
const TAPBACK_ICONS = ["👍", "❤️", "😂", "‼️"];

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
    inFlight.set(key, askReviewers(family, sender, recipient, originalText, translation));
    setTimeout(() => inFlight.delete(key), config.reviewTimeoutMs + 60_000);
  }
  return inFlight.get(key)!;
}

/**
 * Bilingual members (never the sender) who read both languages. Members who don't list
 * `reviewLanguages` count as reading everything. The recipient only reviews when nobody
 * else can: they're about to read the translation anyway.
 */
export function pickReviewers(family: Family, sender: FamilyMember, recipient: FamilyMember): FamilyMember[] {
  const reads = (m: FamilyMember, lang: LanguageCode) => !m.reviewLanguages || m.reviewLanguages.includes(lang);
  const able = family.members.filter(
    (m) => m.isBilingualReviewer && m.id !== sender.id && reads(m, sender.language) && reads(m, recipient.language),
  );
  const others = able.filter((m) => m.id !== recipient.id);
  return others.length ? others : able;
}

async function askReviewers(
  family: Family,
  sender: FamilyMember,
  recipient: FamilyMember,
  originalText: string,
  translation: Translation,
): Promise<Translation> {
  const reviewers = pickReviewers(family, sender, recipient);
  if (!reviewers.length) return { ...translation, uncertain: true };

  const options = [translation.text, ...(translation.alternatives ?? [])].slice(0, LETTERS.length);
  const questions = await Promise.all(
    reviewers.map(async (reviewer) => ({
      handle: reviewer.handle,
      text: await question(family, reviewer, sender, recipient, originalText, options),
    })),
  );

  const result = await askFirst(questions, config.reviewTimeoutMs);
  if (!result) {
    // No answer in time: send the best guess, flagged, and tell reviewers so a late "A" isn't expected.
    void notify(family, reviewers, "⌛ No answer in time, so I sent my best guess. No need to reply.");
    return { ...translation, uncertain: true };
  }

  const answeredBy = reviewers.find((r) => r.handle === result.handle)!;
  void notify(family, reviewers.filter((r) => r.id !== answeredBy.id), `✅ ${answeredBy.name} already answered, thanks!`);

  const chosen = chosenText(result.answer, options);
  if (chosen === undefined) return { ...translation, uncertain: true }; // 👎: none fit
  // Learn from the answer so Bridge asks less next time. TODO [U1] agree the entry format with User 2 (S2).
  addEntry(family.id, { term: originalText, meaning: chosen, keepAsIs: false });
  return { ...translation, text: chosen, confidence: 1, uncertain: false };
}

/** The option the reviewer picked, their own better translation, or undefined for "none fit". */
function chosenText(answer: Answer, options: string[]): string | undefined {
  if (answer.via === "tapback") {
    const idx = TAPBACK_OPTIONS.indexOf(answer.tapback);
    return idx >= 0 && options[idx] ? options[idx] : undefined;
  }
  const text = answer.text.trim().replace(/[.!]$/, "");
  if (/^(y|yes|ok|okay|是|好|对)$/i.test(text)) return options[0]; // "yes" accepts Bridge's best guess
  if (/^(n|no|cancel|不|不是|不对)$/i.test(text)) return undefined;
  const idx = LETTERS.indexOf(text.toUpperCase()) >= 0 ? LETTERS.indexOf(text.toUpperCase()) : Number(text) - 1;
  if (options[idx]) return options[idx];
  return text; // anything else is a correction typed by the reviewer
}

async function question(
  family: Family,
  reviewer: FamilyMember,
  sender: FamilyMember,
  recipient: FamilyMember,
  originalText: string,
  options: string[],
): Promise<string> {
  const icons = options.map((_, i) => `${TAPBACK_ICONS[i]} ${LETTERS[i]}`).join(" · ");
  const [ask, how] = await Promise.all([
    inLanguage(family, reviewer, `Which ${languageName(recipient.language)} meaning is right?`),
    inLanguage(family, reviewer, `Reply with a letter or tap back: ${icons} · 👎 none fit. Or reply to this message with a better translation.`),
  ]);
  return [`🤔 ${sender.name}: “${originalText}”`, ask, ...options.map((o, i) => `${LETTERS[i]}) ${o}`), how].join("\n");
}

async function notify(family: Family, reviewers: FamilyMember[], text: string) {
  for (const r of reviewers) {
    await sendText(r.handle, await inLanguage(family, r, text)).catch((err) => console.error("[review] notice failed", err));
  }
}

// ── Writing Bridge's own words in the reviewer's language ────────────────

const BRIDGE: FamilyMember = {
  id: "bridge",
  name: "Bridge",
  handle: "",
  language: "en",
  relationship: "assistant",
  isBilingualReviewer: false,
};
const phraseCache = new Map<string, Promise<string>>(); // language|text → translated

function inLanguage(family: Family, reader: FamilyMember, text: string): Promise<string> {
  if (reader.language === BRIDGE.language) return Promise.resolve(text);
  const key = `${reader.language}|${text}`;
  if (!phraseCache.has(key)) {
    phraseCache.set(
      key,
      translate(text, BRIDGE, reader, family).then(
        (t) => t.text,
        () => text, // on a translator error, fall back to English rather than losing the question
      ),
    );
  }
  return phraseCache.get(key)!;
}

function languageName(code: LanguageCode): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
