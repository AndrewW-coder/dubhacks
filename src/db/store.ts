// Storage for families and members. Owned by User 1.
// In-memory, loaded from data/family.json (real numbers, gitignored) or
// data/family.example.json (fake numbers, used by the simulator).

import { existsSync, readFileSync } from "node:fs";
import { config } from "../config.js";
import type { Family, FamilyMember } from "../types.js";

const families: Family[] = [loadFamilyFile()];

function loadFamilyFile(): Family {
  const path = [config.familyFile, "data/family.json", "data/family.example.json"].find((p) => p && existsSync(p))!;
  console.log(`[store] family loaded from ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as Family;
}

export function getFamilyByHandle(handle: string): Family | undefined {
  return families.find((f) => f.members.some((m) => sameHandle(m.handle, handle)));
}

export function getMember(family: Family, handle: string): FamilyMember | undefined {
  return family.members.find((m) => sameHandle(m.handle, handle));
}

export function getAllMembers(): FamilyMember[] {
  return families.flatMap((f) => f.members);
}

export function addFamily(family: Family): void {
  families.push(family);
}

/** Phone numbers can arrive as "+1 (555) 000-0001" or "+15550000001"; emails differ only in case. */
function sameHandle(a: string, b: string): boolean {
  const norm = (h: string) => (h.includes("@") ? h.toLowerCase() : h.replace(/[^\d+]/g, ""));
  return norm(a) === norm(b);
}
