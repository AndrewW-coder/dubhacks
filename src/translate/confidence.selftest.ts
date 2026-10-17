// Table test for isEmergency(). Run: npx tsx src/translate/confidence.selftest.ts (exits 1 on failure).
import { isEmergency } from "./confidence.js";

const cases: [string, boolean][] = [
  ["help", true],
  ["help I fell", true],
  ["I fell", true],
  ["call 911", true],
  ["救命", true],
  ["救命，我摔倒了", true],
  ["我摔倒了", true],
  ["叫救护车", true],
  ["我心脏不舒服", true],
  ["喘不过气", true],
  ["ayuda", true],
  ["me caí", true],
  ["살려주세요", true],
  ["cứu tôi", true],
  ["HELP!!", true],
  ["I can't breathe", true],

  ["can you help me with the recipe?", false],
  ["help me pick a gift", false],
  ["我在医院，别担心", false],
  ["我去医院看朋友", false],
  ["I fell asleep early lol", false],
  ["I fell asleep on the couch", false],
  ["this song is a heart attack 😂", false],
  ["救命这个好好笑", false],
  ["救命哈哈哈", false],
  ["the macaíba fruit", false],
];

let failed = 0;
for (const [text, want] of cases) {
  const got = isEmergency(text);
  if (got !== want) {
    failed++;
    console.error(`FAIL  isEmergency(${JSON.stringify(text)}) = ${got}, expected ${want}`);
  }
}
console.log(`${cases.length - failed}/${cases.length} emergency cases pass`);
process.exit(failed ? 1 : 0);
