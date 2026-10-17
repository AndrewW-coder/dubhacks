// Self-test for visa.ts. Run: npx tsx src/payments/visa.selftest.ts   (exits non-zero on failure)
//
// Always runs the offline checks (mock mode, missing cert files, server down).
// The sandbox checks need a fake mutual-TLS Visa server (never the real sandbox):
//   VISA_SELFTEST_URL       e.g. https://127.0.0.1:8443  (a fake server, see the U2-04 scratch notes)
//   VISA_SELFTEST_CERT_DIR  folder with client.pem, client-key.pem, ca.pem (and optional rogue.pem /
//                           rogue-key.pem, a client cert the server must reject)
// The fake server accepts Basic auth testuser/testpass and answers by amount:
// 13 → decline (05), 51 → insufficient funds, 99 → hangs, 98 → resets the connection (U2-08 copy of the
// server), anything else → approved.
// No card numbers here: the "PANs" are obviously fake strings.

import https from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { FamilyMember } from "../types.js";

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!cond) failures.push(name);
}

const member = (id: string, name: string, currency: string): FamilyMember => ({
  id, name, handle: "", language: "en", relationship: "family", isBilingualReviewer: false, currency,
});
const kevin = member("kevin", "Kevin", "USD");
const nainai = member("nainai", "Nai Nai", "TWD");

const VISA_KEYS = ["VISA_MODE", "VISA_BASE_URL", "VISA_USER_ID", "VISA_PASSWORD", "VISA_CERT_PATH", "VISA_KEY_PATH", "VISA_CA_PATH",
  "VISA_ACQUIRING_BIN", "VISA_ACQUIRER_COUNTRY", "VISA_TEST_SENDER_PAN", "VISA_TEST_RECIPIENT_PAN", "VISA_TIMEOUT_MS"];
const setEnv = (vars: Record<string, string>) => {
  for (const k of VISA_KEYS) process.env[k] = "";
  Object.assign(process.env, vars);
};

const { quote, sendGift, formatMoney, isSupportedCurrency, SUPPORTED_CURRENCIES } = await import("./visa.js");

// ── Offline ────────────────────────────────────────────────────────────────
{
  setEnv({ VISA_MODE: "mock", VISA_BASE_URL: "https://127.0.0.1:1" });
  const q = await quote(50, "USD", "TWD");
  check("mock quote uses demo table", q.amount === 1610 && q.currency === "TWD" && q.source === "demo", q);
  const g = await sendGift(kevin, nainai, 50, "USD");
  check("mock sendGift ok", g.ok && g.amountReceived === 1610 && g.transactionId?.startsWith("mock-") === true, g);
  check("formatMoney unchanged", formatMoney(50, "USD") === "$50" && formatMoney(1610, "TWD") === "NT$1,610", [formatMoney(50, "USD"), formatMoney(1610, "TWD")]);

  // S-5: sendGift validates its own input, in mock mode too.
  const bad: [string, number, string, FamilyMember][] = [
    ["NaN", NaN, "USD", nainai], ["negative", -5, "USD", nainai], ["zero", 0, "USD", nainai], ["Infinity", Infinity, "USD", nainai],
    ["over the $1,000 cap", 1000.01, "USD", nainai], ["over the cap in TWD", 40000, "TWD", kevin], ["sub-cent", 0.001, "USD", nainai],
    ["unknown currency", 50, "SGD", nainai], ["unknown recipient currency", 50, "USD", member("x", "X", "ZZZ")],
  ];
  for (const [label, amount, cur, to] of bad) {
    const r = await sendGift(kevin, to, amount, cur);
    check(`mock sendGift rejects ${label}`, !r.ok && !r.transactionId && !!r.error && !r.maybeCharged, r);
  }
  check("mock sendGift allows exactly the cap", (await sendGift(kevin, nainai, 1000, "USD")).ok);
  check("S-2: supported currency list", isSupportedCurrency("twd") && !isSupportedCurrency("SGD") && SUPPORTED_CURRENCIES.includes("USD") && !isSupportedCurrency(undefined));

  setEnv({ VISA_MODE: "sandbox", VISA_USER_ID: "u", VISA_PASSWORD: "p", VISA_CERT_PATH: "/nonexistent/cert.pem", VISA_KEY_PATH: "/nonexistent/key.pem", VISA_TEST_RECIPIENT_PAN: "fake-recipient-0001" });
  const missing = await sendGift(kevin, nainai, 50, "USD");
  check("missing cert file → clear error, no throw", !missing.ok && /VISA_CERT_PATH/.test(missing.error ?? "") && !missing.maybeCharged, missing);
  const qMissing = await quote(50, "USD", "TWD");
  check("sandbox quote falls back to demo on failure", qMissing.source === "demo" && qMissing.amount === 1610, qMissing);

  setEnv({ VISA_MODE: "sandbox" });
  const noCreds = await sendGift(kevin, nainai, 50, "USD");
  check("sandbox without any settings → not-set-up error", !noCreds.ok && /isn't set up/.test(noCreds.error ?? ""), noCreds);
}

// ── Against the fake mTLS server ───────────────────────────────────────────
const url = process.env.VISA_SELFTEST_URL?.trim();
const certDir = process.env.VISA_SELFTEST_CERT_DIR?.trim();
if (!url || !certDir) {
  console.log("SKIP  sandbox checks (set VISA_SELFTEST_URL and VISA_SELFTEST_CERT_DIR to a fake mTLS server)");
} else {
  const cert = join(certDir, "client.pem"), key = join(certDir, "client-key.pem"), ca = join(certDir, "ca.pem");
  const sandbox = (extra: Record<string, string> = {}) => setEnv({
    VISA_MODE: "sandbox", VISA_BASE_URL: url, VISA_USER_ID: "testuser", VISA_PASSWORD: "testpass",
    VISA_CERT_PATH: cert, VISA_KEY_PATH: key, VISA_CA_PATH: ca,
    VISA_TEST_SENDER_PAN: "fake-sender-1111", VISA_TEST_RECIPIENT_PAN: "fake-recipient-4321", ...extra,
  });
  type Recorded = { path: string; authUser: string | null; authOk: boolean; clientCertCN: string | null; tlsAuthorized: boolean; body: Record<string, unknown> };
  const recorded = () => new Promise<Recorded[]>((resolve, reject) => {
    https.get(`${url}/__fake/requests`, { cert: readFileSync(cert), key: readFileSync(key), ca: readFileSync(ca) }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d)));
    }).on("error", reject);
  });

  sandbox();
  const before = (await recorded()).length;
  const q = await quote(50, "USD", "TWD");
  check("sandbox quote comes from Visa FX", q.source === "visa" && q.amount === 1575 && q.currency === "TWD", q);

  const g1 = await sendGift(kevin, nainai, 50, "USD");
  const g2 = await sendGift(kevin, nainai, 20, "USD");
  check("approve → ok with amountReceived from FX quote", g1.ok && g1.amountReceived === 1575 && g1.receivedCurrency === "TWD", g1);
  check("approve → actionCode/approvalCode/transactionId mapped", g1.actionCode === "00" && g1.approvalCode === "21324K" && g1.transactionId === "381228649430015", g1);

  const reqs = (await recorded()).slice(before);
  check("mTLS client cert presented", reqs.length > 0 && reqs.every((r) => r.tlsAuthorized && r.clientCertCN === "bridge-test-client"), reqs.map((r) => r.clientCertCN));
  check("Basic auth sent", reqs.every((r) => r.authOk), reqs.map((r) => r.authUser));
  const pushes = reqs.filter((r) => r.path === "/visadirect/fundstransfer/v1/pushfundstransactions").map((r) => r.body);
  const fxs = reqs.filter((r) => r.path === "/forexrates/v1/foreignexchangerates").map((r) => r.body);
  check("each gift does an FX call then a push", pushes.length === 2 && fxs.length === 3, { pushes: pushes.length, fxs: fxs.length });
  const required = ["systemsTraceAuditNumber", "retrievalReferenceNumber", "localTransactionDateTime", "acquiringBin", "acquirerCountryCode",
    "businessApplicationId", "transactionCurrencyCode", "amount", "recipientPrimaryAccountNumber", "senderName", "senderAccountNumber", "cardAcceptor"];
  const p = pushes[0] ?? {};
  check("push body has required fields", required.every((k) => p[k] !== undefined && p[k] !== ""), required.filter((k) => p[k] === undefined));
  check("businessApplicationId PP, currency USD, amount 50", p.businessApplicationId === "PP" && p.transactionCurrencyCode === "USD" && p.amount === 50, p);
  check("localTransactionDateTime format", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(String(p.localTransactionDateTime)), p.localTransactionDateTime);
  check("STAN is 6 digits and unique per call", pushes.every((b) => /^\d{6}$/.test(String(b.systemsTraceAuditNumber))) && pushes[0]?.systemsTraceAuditNumber !== pushes[1]?.systemsTraceAuditNumber, pushes.map((b) => b.systemsTraceAuditNumber));
  check("RRN is 12 digits ending in the STAN", pushes.every((b) => /^\d{12}$/.test(String(b.retrievalReferenceNumber)) && String(b.retrievalReferenceNumber).endsWith(String(b.systemsTraceAuditNumber))), pushes.map((b) => b.retrievalReferenceNumber));
  check("FX body uses numeric currency codes", fxs[0]?.sourceCurrencyCode === "840" && fxs[0]?.destinationCurrencyCode === "901" && fxs[0]?.sourceAmount === "50.00", fxs[0]);

  const decline = await sendGift(kevin, nainai, 13, "USD");
  check("decline → ok:false with friendly error, definitely not charged", !decline.ok && decline.actionCode === "05" && /declined/.test(decline.error ?? "") && !decline.maybeCharged, decline);
  const nsf = await sendGift(kevin, nainai, 51, "USD");
  check("51 → insufficient funds", !nsf.ok && nsf.error === "insufficient funds", nsf);

  sandbox({ VISA_PASSWORD: "wrong" });
  const unauth = await sendGift(kevin, nainai, 50, "USD");
  check("401 → sandbox auth failed", !unauth.ok && unauth.error === "sandbox auth failed", unauth);

  if (existsSync(join(certDir, "rogue.pem"))) {
    sandbox({ VISA_CERT_PATH: join(certDir, "rogue.pem"), VISA_KEY_PATH: join(certDir, "rogue-key.pem") });
    const rogue = await sendGift(kevin, nainai, 50, "USD");
    check("unknown client cert → sandbox auth failed (TLS)", !rogue.ok && /sandbox auth failed|check the client certificate/.test(rogue.error ?? ""), rogue);
  }

  sandbox({ VISA_TIMEOUT_MS: "1500" });
  const t0 = Date.now();
  const hang = await sendGift(kevin, nainai, 99, "USD");
  check("server hangs → timeout error, no throw", !hang.ok && /timeout/.test(hang.error ?? "") && Date.now() - t0 < 5000, hang);
  check("S-4: timeout → maybeCharged", hang.maybeCharged === true, hang);

  sandbox();
  const reset = await sendGift(kevin, nainai, 98, "USD");
  check("S-4: connection reset after the request → maybeCharged", !reset.ok && reset.maybeCharged === true, reset);

  sandbox({ VISA_BASE_URL: "https://127.0.0.1:1" });
  const down = await sendGift(kevin, nainai, 50, "USD");
  check("server down → connection error, no throw, not charged", !down.ok && /connection error/.test(down.error ?? "") && !down.maybeCharged, down);

  sandbox();
  const mark = (await recorded()).length;
  setEnv({ VISA_MODE: "mock", VISA_BASE_URL: url, VISA_USER_ID: "testuser", VISA_PASSWORD: "testpass", VISA_CERT_PATH: cert, VISA_KEY_PATH: key, VISA_CA_PATH: ca });
  await quote(50, "USD", "TWD");
  const m = await sendGift(kevin, nainai, 50, "USD");
  check("mock mode makes no network call", m.ok && (await recorded()).length === mark, { before: mark });
}

console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASSED");
process.exit(failures.length ? 1 : 0);
