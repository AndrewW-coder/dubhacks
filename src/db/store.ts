// Storage for families and members. Owned by User 1.
// In-memory, loaded from data/family.json (real numbers, gitignored) or
// data/family.example.json (fake numbers, used by the simulator).

import { existsSync, readFileSync, watchFile } from "node:fs";
import { config } from "../config.js";
import type { Family, FamilyMember } from "../types.js";

// The simulator uses the example family unless FAMILY_FILE says otherwise, so a real
// data/family.json (live phones) never breaks the demo script.
const defaults = config.photonMode === "live" ? ["data/family.json", "data/family.example.json"] : ["data/family.example.json"];
const familyPath = [config.familyFile, ...defaults].find((p) => p && existsSync(p))!;
let families: Family[] = [readFamily()];
console.log(`[store] family loaded from ${familyPath}`);

// Edit the family file while Bridge runs (e.g. add a member mid-conversation) and it reloads,
// so the demo never needs a restart (which would forget the message map).
watchFile(familyPath, { interval: 1000 }, () => {
  try {
    families = [readFamily()];
    console.log(`[store] family reloaded: ${families[0]!.members.map((m) => m.name).join(", ")}`);
  } catch (err) {
    console.error("[store] family file is invalid, keeping the previous one", err);
  }
});

function readFamily(): Family {
  return JSON.parse(readFileSync(familyPath, "utf8")) as Family;
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
