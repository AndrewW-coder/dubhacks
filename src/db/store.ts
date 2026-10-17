// Storage for families and members. In-memory for now; swap for SQLite if time allows.

import type { Family } from "../types.js";

const families: Family[] = [
  // TODO: seed a demo family here
];

export function getFamilyByHandle(handle: string): Family | undefined {
  return families.find((f) => f.members.some((m) => m.handle === handle));
}

export function addFamily(family: Family): void {
  families.push(family);
}
