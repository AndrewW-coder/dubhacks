// Grandparents are common scam targets. Any money request coming from an
// elder is confirmed with a trusted family member before it goes through.
// Owned by User 2.

import type { Family, FamilyMember } from "../types.js";

const ELDER_RELATIONSHIPS = ["grandmother", "grandfather", "grandparent"];

export function requiresConfirmation(requester: FamilyMember, amount: number): boolean {
  if (ELDER_RELATIONSHIPS.includes(requester.relationship)) return true;
  return amount > 200; // TODO [U2] tune threshold
}

export function trustedConfirmer(family: Family, requester: FamilyMember): FamilyMember | undefined {
  return family.members.find((m) => m.isTrustedForMoney && m.id !== requester.id);
}
