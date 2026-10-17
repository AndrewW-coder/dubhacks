// Glossary persistence + overlay + learned-phrase short-circuit. Runs offline in a temp cwd.
// Run: npx tsx src/translate/glossary.selftest.ts (exits 1 on failure).

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Ignore AI settings from a developer's .env: this test uses a fake Anthropic server.
// (dotenv never overrides variables that are already set, and claude.ts reads these lazily.)
process.env.TRANSLATE_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "";
process.env.GEMINI_API_KEY = "";

const self = fileURLToPath(import.meta.url);
const isChild = process.argv[2] === "--child";

if (isChild) {
  // A "restarted" process: print what it loaded.
  const g = await import("./glossary.js");
  console.log(JSON.stringify(g.getGlossary("fam")));
  process.exit(0);
}

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : `  → ${JSON.stringify(detail)}`}`);
};

const dir = mkdtempSync(join(tmpdir(), "bridge-glossary-"));
mkdirSync(join(dir, "data"));
writeFileSync(
  join(dir, "data/glossary.example.json"),
  JSON.stringify({
    _comment: "test",
    fam: [
      { term: "Nai Nai", meaning: "Grandma", keepAsIs: true },
      { term: "饺子", meaning: "dumplings (example)", keepAsIs: false },
      { term: "红包", meaning: "red envelope", keepAsIs: false },
    ],
  }),
);
writeFileSync(join(dir, "data/glossary.json"), JSON.stringify({ fam: [{ term: "饺子。", meaning: "dumplings (learned)", keepAsIs: false }] }));
process.chdir(dir);

// Fake Claude that counts requests: the short-circuit must not reach it.
let requests = 0;
const server = createServer((req, res) => {
  requests++;
  req.resume();
  res.writeHead(500).end("{}");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
process.env.ANTHROPIC_API_KEY = "fake";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
delete process.env.GLOSSARY_FILE;

const g = await import("./glossary.js");
const { translate } = await import("./translator.js");
const { needsReview } = await import("./confidence.js");

// Overlay: glossary.json wins on the same normalized term, other example entries stay.
const loaded = g.getGlossary("fam");
check("overlay: learned file wins on same term", loaded.filter((e) => e.term.startsWith("饺子")).map((e) => e.meaning).join() === "dumplings (learned)", loaded);
check("overlay: example entries kept", loaded.some((e) => e.term === "Nai Nai") && loaded.some((e) => e.term === "红包"), loaded);

// guessLanguage
check("guessLanguage Latin → en", g.guessLanguage("You're so stubborn, kiddo!") === "en");
check("guessLanguage CJK → zh", g.guessLanguage("你这孩子真是的") === "zh");
check("guessLanguage emoji → undefined", g.guessLanguage("❤️❤️") === undefined);

// addEntry the way bridgeReview.ts calls it (no language).
g.addEntry("fam", { term: "你这孩子真是的", meaning: "Oh you, kiddo! (said fondly)", keepAsIs: false });
g.addEntry("fam", { term: "🧪 test phrase", meaning: "meaning A", keepAsIs: false });
const added = g.getGlossary("fam").find((e) => e.term === "你这孩子真是的");
check("addEntry fills language from script", added?.language === "en", added);
check("not written before debounce", !JSON.parse(readFileSync("data/glossary.json", "utf8")).fam.some((e: { term: string }) => e.term === "你这孩子真是的"));

await new Promise((r) => setTimeout(r, 800));
const saved = JSON.parse(readFileSync("data/glossary.json", "utf8")) as Record<string, { term: string }[]>;
check("persisted after debounce", saved.fam?.some((e) => e.term === "你这孩子真是的") === true, saved);
check("persisted keeps earlier learned entries", saved.fam?.some((e) => e.term === "饺子。") === true, saved);
check("example-only entries not copied into learned file", !saved.fam?.some((e) => e.term === "Nai Nai"), saved);
check("🧪 test-hook entries not persisted", !saved.fam?.some((e) => e.term.includes("🧪")), saved);
check("no temp file left behind (atomic rename)", readdirSync("data").every((f) => !f.endsWith(".tmp")), readdirSync("data"));

// Restart: a fresh process sees the learned entry.
const child = spawnSync(process.execPath, [...process.execArgv, self, "--child"], { cwd: dir, encoding: "utf8", env: { ...process.env } });
const reloaded = JSON.parse(child.stdout.trim().split("\n").pop() || "[]") as { term: string; meaning: string }[];
check("survives restart", reloaded.some((e) => e.term === "你这孩子真是的" && e.meaning.startsWith("Oh you")), child.stderr || reloaded);

// Short-circuit: exact learned phrase (with different trailing punctuation) → no Claude call.
const family = {
  id: "fam",
  name: "Test",
  members: [
    { id: "nainai", name: "Nai Nai", handle: "+15550000001", language: "zh", relationship: "grandmother", isBilingualReviewer: false },
    { id: "kevin", name: "Kevin", handle: "+15550000002", language: "en", relationship: "grandson", isBilingualReviewer: false },
    { id: "ko", name: "Jun", handle: "+15550000009", language: "ko", relationship: "cousin", isBilingualReviewer: false },
  ],
};
const [nainai, kevin, jun] = family.members as [typeof family.members[0], typeof family.members[0], typeof family.members[0]];
const t = await translate("你这孩子真是的！", nainai, kevin, family);
check("short-circuit returns learned meaning", t.text === "Oh you, kiddo! (said fondly)" && t.confidence === 1 && t.notes === "Confirmed by family", t);
check("short-circuit made no request", requests === 0, { requests });
check("learned phrase skips review", !needsReview("你这孩子真是的！", t));

// Different target language: not short-circuited, goes to Claude (which fails here → original, uncertain).
const k = await translate("你这孩子真是的", nainai, jun, family);
check("other language still calls Claude", requests > 0, { requests });
check("API error falls back to original + uncertain", k.text === "你这孩子真是的" && k.uncertain === true, k);

// Explicit language on an entry wins.
g.addEntry("fam", { term: "随便你", meaning: "마음대로 해", keepAsIs: false, language: "ko" });
const before = requests;
const ko = await translate("随便你", nainai, jun, family);
check("entry with explicit language short-circuits", ko.text === "마음대로 해" && requests === before, ko);
g.flushGlossary();

server.close();
console.log(failed ? `\n${failed} glossary check(s) failed` : "\nall glossary checks pass");
process.exit(failed ? 1 : 0);
