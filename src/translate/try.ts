// Runs every phrase in data/translation-tests.json through the real translator and
// shows text, confidence, and whether it would go to a reviewer. Owned by User 2.
//
//   npm run try:translate              all phrases
//   npm run try:translate -- 吃不了     only phrases containing "吃不了"
//   npm run try:translate -- --json    machine-readable summary: { pass, total, failures: [...] }

import { readFileSync } from "node:fs";
import { getAllMembers, getFamilyByHandle } from "../db/store.js";
import { translate } from "./translator.js";
import { isEmergency, needsReview } from "./confidence.js";

interface Case { text: string; expect: "high" | "low" | "emergency"; why: string }
const tests = JSON.parse(readFileSync("data/translation-tests.json", "utf8")) as {
  from: string; to: string; phrases: Case[]; reverse: Case[];
};

const args = process.argv.slice(2);
const json = args.includes("--json");
const filter = args.find((a) => !a.startsWith("--"));
const log = json ? () => {} : (...a: unknown[]) => console.log(...a);

const members = getAllMembers();
const a = members.find((m) => m.id === tests.from)!;
const b = members.find((m) => m.id === tests.to)!;
const family = getFamilyByHandle(a.handle)!;

interface Failure { from: string; to: string; text: string; expected: string; got: string; translation: string; confidence: number; alternatives?: string[]; why: string }
const failures: Failure[] = [];
let pass = 0;
let total = 0;
for (const [from, to, cases] of [[a, b, tests.phrases], [b, a, tests.reverse]] as const) {
  log(`\n━━ ${from.name} (${from.language}) → ${to.name} (${to.language}) ━━`);
  for (const c of cases) {
    if (filter && !c.text.includes(filter)) continue;
    const started = Date.now();
    const t = await translate(c.text, from, to, family);
    const ms = Date.now() - started;
    const got = isEmergency(c.text) ? "emergency" : needsReview(c.text, t) ? "low" : "high";
    const ok = got === c.expect;
    total++;
    if (ok) pass++;
    else failures.push({ from: from.id, to: to.id, text: c.text, expected: c.expect, got, translation: t.text, confidence: t.confidence, alternatives: t.alternatives, why: c.why });
    log(`${ok ? "✅" : "❌"} ${c.text}`);
    log(`   → ${t.text}   [conf ${t.confidence.toFixed(2)} · ${got}${ok ? "" : `, expected ${c.expect}`} · ${ms} ms]`);
    if (t.alternatives?.length) log(`   alt: ${t.alternatives.join(" | ")}`);
    if (t.notes) log(`   💡 ${t.notes}`);
    if (!ok) log(`   (${c.why})`);
  }
}
if (json) console.log(JSON.stringify({ pass, total, failures }, null, 2));
else console.log(`\n${pass}/${total} behaved as expected`);
