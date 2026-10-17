// Per-family glossary: nicknames, dish names, dialect words, and terms that
// should never be translated. Grows as bilingual reviewers answer questions.
// Owned by User 2. review/bridgeReview.ts (User 1) calls addEntry().

export interface GlossaryEntry {
  term: string;
  meaning: string;
  keepAsIs: boolean; // e.g. "Nai Nai" stays "Nai Nai"
}

const glossaries = new Map<string, GlossaryEntry[]>(); // familyId → entries

export function getGlossary(familyId: string): GlossaryEntry[] {
  return glossaries.get(familyId) ?? [];
}

export function addEntry(familyId: string, entry: GlossaryEntry): void {
  glossaries.set(familyId, [...getGlossary(familyId), entry]);
}
