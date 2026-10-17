// Maps an original message to its relayed copies in each member's thread.
// Needed so replies, tapbacks, edits, and unsends land on the right copy.

// originalId → (recipient handle → relayed message ID)
const map = new Map<string, Map<string, string>>();

export function recordRelay(originalId: string, recipientHandle: string, relayedId: string): void {
  if (!map.has(originalId)) map.set(originalId, new Map());
  map.get(originalId)!.set(recipientHandle, relayedId);
}

export function getRelayedCopies(originalId: string): Map<string, string> {
  return map.get(originalId) ?? new Map();
}

/** Given a relayed copy's ID (e.g. someone replied to it), find the original message. */
export function findOriginal(relayedId: string): string | undefined {
  for (const [originalId, copies] of map) {
    for (const id of copies.values()) if (id === relayedId) return originalId;
  }
  return undefined;
}
