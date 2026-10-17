// Per-family glossary: nicknames, dish names, dialect words, and terms that
// should never be translated. Grows as bilingual reviewers answer questions.
// Owned by User 2. review/bridgeReview.ts (User 1) calls addEntry().
//
// FROZEN SIGNATURES: getGlossary(familyId), addEntry(familyId, entry), isConfirmedPhrase(text)
//
// Loading: starts from data/glossary.example.json (checked in), then overlays the learned
// file (default data/glossary.json, git-ignored). The learned file wins on the same entry.
// Shape of both files:
//   { "<familyId>": [ { "term": "Nai Nai", "meaning": "Grandma (father's mother)", "keepAsIs": true } ] }
//
// Saving: every addEntry() is written to the learned file, debounced (~500 ms) and atomic
// (temp file + rename), and flushed on process exit. Write errors are logged, never thrown.
// Entries from the 🧪 test hook are kept in memory only, so `npm run sim:u2` stays repeatable.
//
// Env (optional):
//   GLOSSARY_FILE   path of the learned file (default data/glossary.json); "off" disables saving.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LanguageCode } from "../types.js";

export interface GlossaryEntry {
  term: string;
  meaning: string;
  keepAsIs: boolean; // e.g. "Nai Nai" stays "Nai Nai"
  /** Language `meaning` is written in. Missing on review answers: guessed from the script. */
  language?: LanguageCode;
}

const EXAMPLE_FILE = "data/glossary.example.json";
const learnedFile = () => {
  const v = process.env.GLOSSARY_FILE?.trim();
  return v && v.toLowerCase() !== "off" ? v : v ? undefined : "data/glossary.json";
};
const SAVE_DELAY_MS = 500;

const glossaries = new Map<string, GlossaryEntry[]>(); // familyId → all entries (example + learned)
const learned = new Map<string, GlossaryEntry[]>(); // familyId → entries that belong in the learned file
let seeded = false;

function seed() {
  if (seeded) return;
  seeded = true;
  for (const [familyId, entries] of Object.entries(readFile(EXAMPLE_FILE))) {
    for (const e of entries) put(glossaries, familyId, e);
  }
  const file = learnedFile();
  if (!file) return;
  for (const [familyId, entries] of Object.entries(readFile(file))) {
    for (const e of entries) {
      put(glossaries, familyId, e);
      put(learned, familyId, e);
    }
  }
}

function readFile(path: string): Record<string, GlossaryEntry[]> {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const out: Record<string, GlossaryEntry[]> = {};
    for (const [familyId, entries] of Object.entries(data)) {
      if (familyId.startsWith("_") || !Array.isArray(entries)) continue; // "_comment" etc.
      out[familyId] = entries.filter(
        (e): e is GlossaryEntry => typeof e?.term === "string" && typeof e?.meaning === "string",
      ).map((e) => ({ ...e, keepAsIs: Boolean(e.keepAsIs) }));
    }
    return out;
  } catch (err) {
    console.error(`[glossary] could not read ${path}`, err);
    return {};
  }
}

/** Same term (normalized) and, for learned meanings, same target language = same entry. */
function keyOf(e: GlossaryEntry): string {
  return `${normalize(e.term)}|${e.keepAsIs ? "" : (e.language ?? guessLanguage(e.meaning) ?? "")}`;
}

function put(map: Map<string, GlossaryEntry[]>, familyId: string, entry: GlossaryEntry) {
  const k = keyOf(entry);
  const rest = (map.get(familyId) ?? []).filter((e) => keyOf(e) !== k);
  map.set(familyId, [...rest, entry]);
}

export function getGlossary(familyId: string): GlossaryEntry[] {
  seed();
  return glossaries.get(familyId) ?? [];
}

export function addEntry(familyId: string, entry: GlossaryEntry): void {
  seed();
  const e: GlossaryEntry = { ...entry, term: entry.term.trim(), meaning: entry.meaning.trim() };
  if (!e.term || !e.meaning) return;
  if (!e.keepAsIs && !e.language) {
    const guess = guessLanguage(e.meaning);
    if (guess) e.language = guess;
  }
  put(glossaries, familyId, e);
  if (e.term.includes("🧪")) return; // test hook: memory only
  put(learned, familyId, e);
  scheduleSave();
}

/** True when a reviewer already confirmed this exact phrase, so Bridge doesn't ask again. */
export function isConfirmedPhrase(text: string): boolean {
  seed();
  const t = normalize(text);
  for (const entries of glossaries.values()) {
    if (entries.some((e) => !e.keepAsIs && normalize(e.term) === t)) return true;
  }
  return false;
}

/**
 * A confirmed meaning of exactly this text, written in `language`, if the family has one.
 * Used by translator.ts to answer without calling Claude.
 */
export function findLearnedMeaning(familyId: string, text: string, language: LanguageCode): string | undefined {
  const t = normalize(text);
  const want = baseLanguage(language);
  const hits = getGlossary(familyId).filter((e) => !e.keepAsIs && normalize(e.term) === t);
  // Only entries with a known language short-circuit. Reviewer answers always get one (addEntry
  // guesses it); seed entries without a language are descriptions ("dumplings (jiaozi), …"), not
  // translations, so they only go to Claude as context.
  const exact = hits.find((e) => e.language === language);
  const match = exact ?? hits.find((e) => e.language !== undefined && baseLanguage(e.language) === want);
  return match?.meaning;
}

/**
 * Rough script-based guess: mostly Latin letters → "en", mostly CJK (Han/kana) → "zh",
 * otherwise undefined. Only meant for review answers, which arrive without a language.
 */
export function guessLanguage(text: string): LanguageCode | undefined {
  const latin = (text.match(/[A-Za-zÀ-ɏ]/gu) ?? []).length;
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length;
  const total = latin + cjk;
  if (total === 0) return undefined;
  if (latin / total >= 0.7) return "en";
  if (cjk / total >= 0.7) return "zh";
  return undefined;
}

function baseLanguage(code: string): string {
  return code.toLowerCase().split(/[-_]/)[0] ?? "";
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[\s。！？!?.,，、~]+$/u, "");
}

// ── persistence ─────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | undefined;
let exitHookInstalled = false;

function scheduleSave() {
  if (!learnedFile()) return;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      if (timer) flushGlossary();
    });
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(flushGlossary, SAVE_DELAY_MS);
}

/** Writes learned entries now (normally called by the debounce timer or on exit). */
export function flushGlossary(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const file = learnedFile();
  if (!file) return;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(learned), null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch (err) {
    console.error(`[glossary] could not save ${file}`, err);
  }
}
