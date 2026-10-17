// Bridge's own words (questions, notices), written in the reader's language.
// Owned by User 1. Bridge "speaks" English; translate() turns that into the
// reader's language, cached per phrase so repeated notices cost nothing.

import { translate } from "../translate/translator.js";
import type { Family, FamilyMember } from "../types.js";

/** Bridge as a sender, so translate() can be used for its own words. */
export const BRIDGE: FamilyMember = {
  id: "bridge",
  name: "Bridge",
  handle: "",
  language: "en",
  relationship: "assistant",
  isBilingualReviewer: false,
};

const cache = new Map<string, Promise<string>>(); // language|text → translated

export function say(family: Family, reader: FamilyMember, text: string): Promise<string> {
  if (reader.language === BRIDGE.language) return Promise.resolve(text);
  const key = `${reader.language}|${text}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      translate(text, BRIDGE, reader, family).then(
        (t) => t.text,
        () => text, // on a translator error, English beats losing the message
      ),
    );
  }
  return cache.get(key)!;
}
