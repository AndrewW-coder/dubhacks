// Per-family glossary: nicknames, dish names, dialect words, and terms that
// should never be translated. Grows as bilingual reviewers answer questions.

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
