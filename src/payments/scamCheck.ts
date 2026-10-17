// Grandparents are common scam targets. Any money request coming from an
// elder is confirmed with a trusted family member before it goes through.

import type { FamilyMember } from "../types.js";

const ELDER_RELATIONSHIPS = ["grandmother", "grandfather", "grandparent"];

export function requiresConfirmation(requester: FamilyMember, amount: number): boolean {
  if (ELDER_RELATIONSHIPS.includes(requester.relationship)) return true;
  return amount > 200; // TODO: tune threshold
}
