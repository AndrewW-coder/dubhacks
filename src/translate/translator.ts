// Tone-aware translation with Claude. Owned by User 2. Called by relay/router.ts.
//
// FROZEN SIGNATURE: translate(text, from, to, family) → Translation
//
// The prompt includes the sender/recipient relationship (for honorifics and tone),
// the family glossary, and recent conversation context. Never throws: if Claude is
// unavailable, the message still gets through (original text, flagged uncertain).
//
// Order of checks: same language / emoji-only → learned phrase (a reviewer already answered
// this exact text for this language: returned with confidence 1, no Claude call) → 🧪 test
// hook → no key placeholder → cache → Claude.
//
// Confidence sanity (spec U2-01 R5, "literal alternative" rule): when Claude's answer would
// go to a reviewer (needsReview) but came back with no alternatives, Bridge makes one small
// extra call for a word-for-word translation and offers it as alternative B, so the reviewer
// always has something to choose between. If that extra call fails, the reviewer can still
// type a better translation. Alternatives are trimmed, deduped and capped at 3.

import { hasClaude, callTool } from "./claude.js";
import { findLearnedMeaning, getGlossary } from "./glossary.js";
import { isEmergency, needsReview } from "./confidence.js";
import type { Family, FamilyMember, Translation } from "../types.js";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", zh: "Chinese (Mandarin, Simplified unless the family writes Traditional)", "zh-TW": "Traditional Chinese (Taiwan)",
  yue: "Cantonese", ko: "Korean", ja: "Japanese", vi: "Vietnamese", es: "Spanish", hi: "Hindi", tl: "Tagalog", ar: "Arabic", fr: "French",
};
const langName = (code: string) => LANGUAGE_NAMES[code] ?? code;

// Recent conversation per family, so Claude knows what "that" or "it" refers to.
const HISTORY_SIZE = 10;
const history = new Map<string, { from: string; text: string }[]>();
// Same text, same sender → same recipient: don't pay for it twice (edits, retries).
const cache = new Map<string, Translation>();

/** Messages that need no translation at all: emoji, punctuation, numbers, links. */
const NOTHING_TO_TRANSLATE = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{P}\p{S}\p{N}\s‍️]*$|^https?:\/\/\S+$/u;

export async function translate(
  text: string,
  from: FamilyMember,
  to: FamilyMember,
  family: Family,
): Promise<Translation> {
  if (from.id !== "bridge") remember(family.id, from.name, text); // S-9: Bridge's own messages are not family conversation
  if (from.language === to.language || NOTHING_TO_TRANSLATE.test(text.trim())) return { text, confidence: 1 };

  // A reviewer already chose the meaning of this exact phrase for this language: reuse it.
  const learned = findLearnedMeaning(family.id, text, to.language);
  if (learned) return { text: learned, confidence: 1, notes: "Confirmed by family" };

  // Test hook for the review flow (User 1 relies on it). Works with or without Claude.
  if (text.includes("🧪")) {
    return {
      text: `[${from.language}→${to.language}] meaning A`,
      confidence: 0.3,
      alternatives: [`[${from.language}→${to.language}] meaning B`],
      notes: "Test hook: idiom with two possible meanings.",
    };
  }
  if (!hasClaude()) return { text: `[${from.language}→${to.language}] ${text}`, confidence: 0.99 };

  const key = `${family.id}|${from.id}|${to.id}|${text}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const result = await callTool<Translation>({
      system: SYSTEM_PROMPT,
      content: buildPrompt(text, from, to, family),
      tool: TRANSLATION_TOOL,
    });
    const clean: Translation = {
      text: String(result.text ?? "").trim() || text,
      confidence: clamp(Number(result.confidence)),
      notes: typeof result.notes === "string" ? result.notes.trim() || undefined : undefined,
    };
    // Never let a cultural note downplay a possible emergency ("elders often exaggerate…").
    if (isEmergency(text)) clean.notes = undefined;
    clean.alternatives = cleanAlternatives(result.alternatives, clean.text);
    if (needsReview(text, clean) && !clean.alternatives.length) {
      const literal = await literalTranslation(text, from, to);
      clean.alternatives = cleanAlternatives(literal ? [literal] : [], clean.text);
    }
    cache.set(key, clean);
    return clean;
  } catch (err) {
    console.error("[translate] Claude call failed, sending original text:", err instanceof Error ? err.message : err);
    return { text, confidence: 1, uncertain: true, notes: "Translation was unavailable, so this is the original message." };
  }
}

function cleanAlternatives(raw: unknown, main: string): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const seen = new Set([squash(main)]);
  const out: string[] = [];
  for (const a of list) {
    const t = String(a ?? "").trim().replace(/^["“]|["”]$/g, "").trim();
    if (!t || seen.has(squash(t))) continue;
    seen.add(squash(t));
    out.push(t);
  }
  return out.slice(0, 3);
}
const squash = (s: string) => s.toLowerCase().replace(/[\s\p{P}]+/gu, "");

/** Word-for-word translation, used as a second option for the reviewer. Never throws. */
async function literalTranslation(text: string, from: FamilyMember, to: FamilyMember): Promise<string | undefined> {
  try {
    const r = await callTool<{ text: string }>({
      system: "You give literal, word-for-word translations so a bilingual reviewer can compare them with a looser one.",
      content: `Translate this ${langName(from.language)} message into ${langName(to.language)} as literally as possible, keeping names unchanged:\n<message>${text}</message>`,
      tool: LITERAL_TOOL,
      maxTokens: 300,
    });
    return typeof r?.text === "string" ? r.text.trim() || undefined : undefined;
  } catch (err) {
    console.error("[translate] literal alternative failed:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

function remember(familyId: string, fromName: string, text: string) {
  const h = history.get(familyId) ?? [];
  const last = h[h.length - 1];
  if (!last || last.text !== text || last.from !== fromName) h.push({ from: fromName, text });
  history.set(familyId, h.slice(-HISTORY_SIZE - 1));
}

function buildPrompt(text: string, from: FamilyMember, to: FamilyMember, family: Family): string {
  const glossary = getGlossary(family.id);
  const keep = glossary.filter((g) => g.keepAsIs);
  const learned = glossary.filter((g) => !g.keepAsIs);
  const recent = (history.get(family.id) ?? []).slice(0, -1); // everything before this message

  return [
    `<sender>${from.name}, the ${from.relationship}, writing in ${langName(from.language)}</sender>`,
    `<recipient>${to.name}, the ${to.relationship}, who reads ${langName(to.language)}</recipient>`,
    `<relationship>${from.name} (${from.relationship}) is writing to ${to.name} (${to.relationship}). ${registerHint(from, to)}</relationship>`,
    `<family_members>${family.members.map((m) => `${m.name} (${m.relationship})`).join(", ")}</family_members>`,
    keep.length ? `<keep_as_is>${keep.map((g) => `${g.term} = ${g.meaning}`).join("; ")}</keep_as_is>` : "",
    learned.length
      ? `<confirmed_meanings>${learned.map((g) => `"${g.term}" means "${g.meaning}"`).join("; ")}</confirmed_meanings>`
      : "",
    recent.length ? `<recent_conversation>\n${recent.map((m) => `${m.from}: ${m.text}`).join("\n")}\n</recent_conversation>` : "",
    `<message>${text}</message>`,
    `Translate <message> from ${from.name} for ${to.name} into ${langName(to.language)} by calling submit_translation. Keep names, nicknames and <keep_as_is> terms exactly as written.`,
  ]
    .filter(Boolean)
    .join("\n");
}

const ELDER = /grand(mother|father|ma|pa)|grandparent|nai ?nai|ye ?ye|lao ?lao|halmeoni|abuela|abuelo|\b(mother|father|mom|dad|aunt|uncle|parent)\b/i;
const YOUNGER = /grand(son|daughter|child|kid)|\b(son|daughter|niece|nephew|child|kid)\b/i;

/** One line of register guidance for this pair of relatives. */
function registerHint(from: FamilyMember, to: FamilyMember): string {
  const fromElder = ELDER.test(from.relationship) && !YOUNGER.test(from.relationship);
  const toElder = ELDER.test(to.relationship) && !YOUNGER.test(to.relationship);
  if (!fromElder && toElder)
    return "A younger relative writing to an elder: make it respectful and affectionate, never stiff, and turn slang into plain warm words the elder understands.";
  if (fromElder && !toElder)
    return "An elder writing to a younger relative: keep the loving, sometimes bossy grandparent voice in natural everyday language, not formal or textbook.";
  return "Relatives of a similar generation: keep it as casual as the original.";
}

const SYSTEM_PROMPT = `You translate messages inside a family group chat where relatives speak different languages. Each person reads the chat in their own language, so your translation is what they will see as the message itself, under the sender's name.

Translate the way a warm, bilingual relative would, not a dictionary:
- Keep the tone, warmth, humor and emotion of the original. Short stays short; casual stays casual. Keep emoji.
- Grandchild → grandparent: respectful and affectionate, like a loving grandchild talking to Grandma, never stiff or formal. In Chinese, 您 or a warm 你 with 奶奶/爷爷 both work; warmth matters more than formality.
- Grandparent → grandchild: keep the doting, nagging, sometimes bossy grandparent voice in everyday words. Affectionate scolding ("你这孩子") is love, not anger, unless the context shows real anger.
- Slang, abbreviations and internet speak from young people (ngl, lol, slap, lowkey, fr, bussin, "that's sick") become plain words with the same feeling that an elder understands: "ngl your dumplings slap" is sincere praise, not hitting. Drop "lol"/"ngl" or turn them into a friendly tone.
- Never translate or respell names, nicknames, or anything in <keep_as_is> (e.g. "Nai Nai" stays "Nai Nai" in English; 奶奶 is how Nai Nai is written in Chinese). Reuse <confirmed_meanings> exactly when the same phrase appears.
- Brands, stores and product names stay as they are (Costco, iPhone, Target).
- Mixed-language messages (code-switching): translate only the parts the recipient can't read and leave the rest untouched.
- Romanized input (pinyin without tones like "ni chi fan le ma", romaji) is the original language: read it as such and translate the meaning.
- Use <recent_conversation> to resolve "that", "it", "there" and running jokes.
- Write only the translated message in "text", with no quotes, labels, romanization or explanations.

Confidence (0 to 1) is how sure you are the recipient will understand what the sender meant:
- 0.9 or above: plain statements, greetings, questions, logistics, clear praise.
- 0.5 to 0.75: idioms, proverbs, sarcasm or teasing, dialect words, ambiguous slang, emotionally loaded lines where a wrong guess could hurt feelings, or anything with two plausible readings.
- Short replies whose feeling depends on tone of voice (the equivalents of "whatever", "fine", "sure, you're always right", "you and your ways…") can be affectionate, resigned, sarcastic or hurt. Text alone can't tell, so use 0.6 to 0.7 and give one alternative per reading. This holds even when the most common reading feels obvious to you.
- Below 0.5: you are guessing.
Whenever confidence is below 0.8, you MUST give 1 to 3 "alternatives": other full translations reflecting the other plausible meanings (not rewordings of the same meaning). A bilingual relative will pick one.

"notes" is one short sentence of cultural context for a curious reader (e.g. "Asking whether you've eaten is how she says she cares."), or empty when there is nothing worth explaining.

Possible emergencies (a fall, pain, trouble breathing, chest tightness, bleeding, a hospital, a call for help): translate plainly and keep the urgency. Never suggest, in the text or the notes, that it is probably minor, dramatic or exaggerated. Leave notes empty.

Examples (sender → recipient: message ⇒ submit_translation input):

Nai Nai (grandmother, zh) → Kevin (grandson, en): 你吃饭了吗？
⇒ {"text":"Have you eaten yet?","confidence":0.95,"notes":"Asking whether you've eaten is a Chinese grandma's way of saying she cares."}

Kevin (grandson, en) → Nai Nai (grandmother, zh): Nai Nai this soup is bussin fr 🍲
⇒ {"text":"奶奶，这汤真的太好喝了！🍲","confidence":0.9}

Nai Nai (grandmother, zh) → Kevin (grandson, en): 你这是胳膊肘往外拐啊
⇒ {"text":"Whose side are you on, huh?","confidence":0.6,"alternatives":["You're taking someone else's side over your own family's.","Your elbow bends outward, doesn't it?"],"notes":"Literally 'your elbow bends outward': teasing (or scolding) someone for siding with outsiders over family."}

Nai Nai (grandmother, zh) → Kevin (grandson, en): 行吧，你高兴就好
⇒ {"text":"Okay, as long as you're happy.","confidence":0.65,"alternatives":["Fine. Do whatever makes you happy, then.","Alright, if that makes you happy, I'm happy too."],"notes":"Can be warm acceptance or quiet disappointment, depending on her tone."}

Kevin (grandson, en) → Nai Nai (grandmother, zh): omw to Costco, need anything?
⇒ {"text":"奶奶，我正在去Costco的路上，您需要买什么吗？","confidence":0.95}`;

const TRANSLATION_TOOL = {
  name: "submit_translation",
  description: "Submit the translated message.",
  input_schema: {
    type: "object" as const,
    properties: {
      text: { type: "string", description: "The translated message only." },
      confidence: { type: "number", description: "0 to 1, see the confidence guide." },
      notes: { type: "string", description: "One sentence of cultural context, or empty." },
      alternatives: { type: "array", items: { type: "string" }, description: "Other plausible translations when confidence < 0.8." },
    },
    required: ["text", "confidence"],
  },
};

const LITERAL_TOOL = {
  name: "submit_literal",
  description: "Submit the literal translation.",
  input_schema: {
    type: "object" as const,
    properties: { text: { type: "string", description: "The literal translation only." } },
    required: ["text"],
  },
};

function clamp(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}
