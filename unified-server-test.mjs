// AMG unified device API v2.1 + FCM HTTP v1 (unified-4.1, Audit Round 2 fixes + J2-m36/J2-m29)
// — local test battery (plain node, no deps)
// Chalana:  node unified-server-test.mjs
// Ye test server ko scratch port + temp data file ke saath chalata hai,
// live Render server ko haath nahi lagata. Exit code 0 = sab pass.
// Section Q fcm.mjs ko seedha import karke jaanchta hai (stubbed fetch);
// section R mein FCM_ENDPOINT + FCM_TOKEN_ENDPOINT aik local stub server
// ki taraf modhe jate hain taake asli push dekha ja sake (koi asli
// Firebase call nahi hoti). Sections S–Z Audit Round 2 ke naye fixes
// hain (J1-C03, J1-M23, J1-M24, J2-M10–M13, J2-m19–m28, J2-p11–p13,
// J1-p11, J1-m53, J1-p16 + contract additions).
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, unlinkSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { sendFcmPush, parseServiceAccount, buildServiceAccountJwt, clearFcmTokenCache, fcmV1Endpoint, FCM_DEFAULT_TOKEN_URL } from "./fcm.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "server.mjs");
const SEED = "seed-test-123";
const SYNC = "sync-test-456";

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${extra !== undefined ? " — " + JSON.stringify(extra) : ""}`); }
}

// Pakistan date (server jaisa hi — Asia/Karachi).
const PKT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" });
function pktDate(offsetDays = 0) {
  return PKT.format(new Date(Date.now() + offsetDays * 86400000));
}
function addMonthsStr(dateStr, m) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + m);
  return d.toISOString().slice(0, 10);
}

async function req(port, method, path, body, headers = {}) {
  const opts = { method, headers: { "Content-Type": "application/json", ...headers } };
  if (body !== undefined) opts.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, opts);
  let json = null;
  try { json = await res.json(); } catch { /* no json */ }
  return { status: res.status, json };
}
const syncH = { "x-amg-sync": SYNC };
const seedH = { "x-amg-seed": SEED };

async function startServer({ port, dataFile, seedToken, syncToken, extraEnv }) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env, PORT: String(port), AMG_DATA_FILE: dataFile,
      AMG_SEED_TOKEN: seedToken || "", AMG_SYNC_TOKEN: syncToken || "",
      ...(extraEnv || {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return child;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`server did not start on port ${port}`);
}
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((r) => { child.once("exit", r); setTimeout(r, 3000); });
}

function inst(seq, dueDate, amount, paidAmount = 0) { return { seq, dueDate, amount, paidAmount }; }
function syncBody(dashboardAccountId, pairingCode, installments, extra = {}) {
  return {
    dashboardAccountId, shopId: 1, shopName: "Al Arab Electronic",
    shopPhone: "03001234567", customerName: "Test " + dashboardAccountId,
    pairingCode, graceDays: 5, status: "active", lockState: "unlocked",
    unlockCode: "", installments, ...extra,
  };
}
async function register(port, pairingCode, model = "Pixel Test", imei = "123456789012345") {
  return req(port, "POST", "/api/device/register", { pairingCode, imei, model, androidVersion: "14" });
}
async function checkin(port, deviceId, pairingCode) {
  return req(port, "POST", "/api/device/checkin", { deviceId, pairingCode });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "amg-unified-test-"));
  const dataA = join(dir, "a.json");
  const dataB = join(dir, "b.json");
  let server = null;
  try {
    // ---- Server A: sync token NAHI set — sync_disabled ----
    console.log("\n== A. Sync auth: token env unset ==");
    server = await startServer({ port: 34561, dataFile: dataA, seedToken: SEED, syncToken: "" });
    let r = await req(34561, "POST", "/api/device/sync", syncBody(1, "AAAAAAAA", []), syncH);
    t("sync bina token env -> 403 sync_disabled", r.status === 403 && r.json?.error === "sync_disabled", r.json);
    r = await req(34561, "POST", "/api/device/sync-all", { accounts: [] }, syncH);
    t("sync-all bina token env -> 403 sync_disabled", r.status === 403 && r.json?.error === "sync_disabled", r.json);
    r = await req(34561, "GET", "/api/device/status?dashboardAccountId=1", undefined, syncH);
    t("status bina token env -> 403 sync_disabled", r.status === 403 && r.json?.error === "sync_disabled", r.json);
    r = await req(34561, "GET", "/health");
    t("health version unified-4.1, NO account counts (J2-p12), fcmConfigured=false", r.json?.version === "unified-4.1" && r.json?.ok === true && r.json?.service === "amg-device-api" && !("accounts" in (r.json || {})) && !("syncedAccounts" in (r.json || {})) && r.json?.fcmConfigured === false, r.json);
    await stopServer(server); server = null;

    // ---- Server B: dono tokens set ----
    console.log("\n== B. Sync auth + validation ==");
    server = await startServer({ port: 34562, dataFile: dataB, seedToken: SEED, syncToken: SYNC });
    r = await req(34562, "POST", "/api/device/sync", syncBody(1, "AAAAAAAA", []), { "x-amg-sync": "ghalat" });
    t("sync ghalat token -> 403 bad_sync_token", r.status === 403 && r.json?.error === "bad_sync_token", r.json);
    r = await req(34562, "GET", "/api/device/status?dashboardAccountId=1", undefined, { "x-amg-sync": "ghalat" });
    t("status ghalat token -> 403 bad_sync_token", r.status === 403 && r.json?.error === "bad_sync_token", r.json);
    r = await req(34562, "POST", "/api/device/sync", { pairingCode: "AAAAAAAA", installments: [] }, syncH);
    t("sync bina dashboardAccountId -> 400 invalid_sync_payload", r.status === 400 && r.json?.error === "invalid_sync_payload", r.json);
    r = await req(34562, "POST", "/api/device/sync", syncBody(1, "AAAAAAAA", [inst(1, pktDate(30), 10000, 15000)]), syncH);
    t("sync paidAmount > amount -> 400 invalid_sync_payload", r.status === 400 && r.json?.error === "invalid_sync_payload", r.json);
    r = await req(34562, "POST", "/api/device/sync", syncBody(1, "AAAAAAAA", [{ seq: 1, dueDate: "not-a-date", amount: 1, paidAmount: 0 }]), syncH);
    t("sync kharab dueDate -> 400 invalid_sync_payload", r.status === 400 && r.json?.error === "invalid_sync_payload", r.json);
    r = await req(34562, "POST", "/api/device/sync", "{ye kharab json hai", syncH);
    t("malformed JSON -> 400 invalid_json (koi detail nahi)", r.status === 400 && r.json?.error === "invalid_json" && !("detail" in (r.json || {})), r.json);

    console.log("\n== C. Sync upsert + phone fields preserve ==");
    r = await req(34562, "POST", "/api/device/sync", syncBody(101, "UNIF101A", [inst(1, pktDate(30), 10000), inst(2, addMonthsStr(pktDate(30), 1), 10000)]), syncH);
    t("sync D=101 ok + accountId milta hai", r.status === 200 && r.json?.ok === true && typeof r.json?.accountId === "number" && r.json?.dashboardAccountId === 101, r.json);
    r = await req(34562, "GET", "/api/test/accounts", undefined, seedH);
    t("dump mein synced account 1 hai (health counts hata diye gaye)", Array.isArray(r.json?.accounts) && r.json.accounts.length === 1 && r.json.accounts[0].dashboardAccountId === 101, r.json);
    r = await register(34562, "UNIF101A");
    t("synced account par register ok", r.json?.ok === true && typeof r.json?.deviceId === "string" && r.json.deviceId.startsWith("dev_"), r.json);
    const dev101 = r.json.deviceId;
    r = await checkin(34562, dev101, "UNIF101A");
    t("checkin future due -> stay_unlocked + Wave 3 fields", r.json?.instruction === "stay_unlocked" && r.json?.overdueAmount === 0 && r.json?.shopPhone === "03001234567" && r.json?.monthlyAmount === 10000, r.json);
    // Dobara sync — device fields bachne chahiyein.
    r = await req(34562, "POST", "/api/device/sync", syncBody(101, "UNIF101A", [inst(1, pktDate(30), 10000, 2000), inst(2, addMonthsStr(pktDate(30), 1), 10000)], { customerName: "Test 101 Updated" }), syncH);
    t("dobara sync ok", r.json?.ok === true, r.json);
    r = await checkin(34562, dev101, "UNIF101A");
    t("sync ke baad purana deviceId ab bhi chalta hai", r.json?.ok === true && r.json?.instruction === "stay_unlocked", r.json);
    r = await req(34562, "GET", "/api/device/status?dashboardAccountId=101", undefined, syncH);
    t("status: deviceRegistered + deviceName + lastSeenAt", r.json?.ok === true && r.json?.deviceRegistered === true && r.json?.deviceName === "Pixel Test" && typeof r.json?.lastSeenAt === "string" && r.json.lastSeenAt.length > 0, r.json);
    r = await req(34562, "GET", "/api/test/accounts", undefined, seedH);
    const acct101 = r.json?.accounts?.find((a) => a.dashboardAccountId === 101);
    // J2-m19: dump mein deviceId/imei MASK hote hain ("***") — asli
    // qeemat check-in se verify hoti hai (upar: purana deviceId chalta hai).
    t("dump mein deviceId/imei masked + customerName update hua", acct101?.deviceId === "***" && acct101?.imei === "***" && acct101?.customerName === "Test 101 Updated", acct101);

    console.log("\n== D. S-C1 + S-M1 regressions ==");
    r = await checkin(34562, "", "UNIF101A");
    t("S-C1: khaali deviceId checkin -> device_not_registered", r.json?.ok === false && r.json?.error === "device_not_registered", r.json);
    r = await req(34562, "POST", "/api/device/offline-code-used", { deviceId: "", code: "XXXXXX" });
    t("S-C1: khaali deviceId offline-code-used -> device_not_registered", r.json?.ok === false && r.json?.error === "device_not_registered", r.json);
    await req(34562, "POST", "/api/device/sync", syncBody(106, "UNIF106F", [inst(1, pktDate(0), 10000)]), syncH);
    r = await register(34562, "UNIF106F");
    r = await checkin(34562, r.json.deviceId, "UNIF106F");
    // J1-m53: due date khud reminder ka din hai — warning agle din se.
    t("S-M1/J1-m53: due aaj (PKT) -> stay_unlocked + graceDaysLeft=5 (warn nahi)", r.json?.instruction === "stay_unlocked" && r.json?.graceDaysLeft === 5, r.json);
    await req(34562, "POST", "/api/device/sync", syncBody(107, "UNIF107G", [inst(1, pktDate(1), 10000)]), syncH);
    r = await register(34562, "UNIF107G");
    r = await checkin(34562, r.json.deviceId, "UNIF107G");
    t("S-M1: due kal -> stay_unlocked", r.json?.instruction === "stay_unlocked", r.json);

    console.log("\n== E. warn / lock / manual lock — SYNCED data se ==");
    await req(34562, "POST", "/api/device/sync", syncBody(102, "UNIF102B", [inst(1, pktDate(-1), 10000), inst(2, addMonthsStr(pktDate(-1), 1), 10000)]), syncH);
    r = await register(34562, "UNIF102B");
    const dev102 = r.json.deviceId;
    r = await checkin(34562, dev102, "UNIF102B");
    t("due kal, grace baqi -> warn + graceDaysLeft=5 (inclusive)", r.json?.instruction === "warn" && r.json?.graceDaysLeft === 5, r.json);
    await req(34562, "POST", "/api/device/sync", syncBody(103, "UNIF103C", [inst(1, pktDate(-10), 10000), inst(2, addMonthsStr(pktDate(-10), 1), 10000)], { unlockCode: "SYNCED1" }), syncH);
    r = await register(34562, "UNIF103C");
    const dev103 = r.json.deviceId;
    r = await checkin(34562, dev103, "UNIF103C");
    t("grace guzri -> lock_now + SYNCED code (server code nahi)", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "SYNCED1" && r.json?.overdueAmount === 10000 && r.json?.overdueCount === 1, r.json);
    await req(34562, "POST", "/api/device/sync", syncBody(105, "UNIF105E", [inst(1, pktDate(-10), 10000)]), syncH);
    r = await register(34562, "UNIF105E");
    r = await checkin(34562, r.json.deviceId, "UNIF105E");
    t("synced lock bina code -> lock_now magar offlineUnlockCode NAHI (server generate nahi karta)", r.json?.instruction === "lock_now" && !("offlineUnlockCode" in (r.json || {})), r.json);
    // Manual lock via sync.
    await req(34562, "POST", "/api/device/sync", syncBody(101, "UNIF101A", [inst(1, pktDate(30), 10000, 2000), inst(2, addMonthsStr(pktDate(30), 1), 10000)], { lockState: "locked", unlockCode: "MANUAL9" }), syncH);
    r = await checkin(34562, dev101, "UNIF101A");
    t("manual lock via sync -> lock_now + MANUAL9", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "MANUAL9", r.json);
    r = await checkin(34562, dev101, "UNIF101A");
    t("manual lock khud nahi khulta (dobara lock_now)", r.json?.instruction === "lock_now", r.json);

    console.log("\n== F. Dashboard payment / final payment via sync ==");
    await req(34562, "POST", "/api/device/sync", syncBody(103, "UNIF103C", [inst(1, pktDate(-10), 10000, 10000), inst(2, addMonthsStr(pktDate(-10), 1), 10000)], { lockState: "unlocked", unlockCode: "" }), syncH);
    r = await checkin(34562, dev103, "UNIF103C");
    t("payment via sync (overdue qist ada) -> stay_unlocked", r.json?.instruction === "stay_unlocked", r.json);
    await req(34562, "POST", "/api/device/sync", syncBody(103, "UNIF103C", [inst(1, pktDate(-10), 10000, 10000), inst(2, addMonthsStr(pktDate(-10), 1), 10000, 10000)], { status: "completed", lockState: "unlocked", unlockCode: "" }), syncH);
    r = await checkin(34562, dev103, "UNIF103C");
    t("final payment via sync -> permanent_unlock", r.json?.instruction === "permanent_unlock", r.json);

    console.log("\n== G. Offline code (synced code) ==");
    await req(34562, "POST", "/api/device/sync", syncBody(104, "UNIF104D", [inst(1, pktDate(-10), 10000), inst(2, addMonthsStr(pktDate(-10), 1), 10000)], { lockState: "locked", unlockCode: "OFF123" }), syncH);
    r = await register(34562, "UNIF104D");
    const dev104 = r.json.deviceId;
    r = await checkin(34562, dev104, "UNIF104D");
    t("locked synced account -> lock_now + OFF123", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "OFF123", r.json);
    r = await req(34562, "POST", "/api/device/offline-code-used", { deviceId: dev104, code: "XXXXXX" });
    t("ghalat offline code -> invalid_unlock_code", r.json?.ok === false && r.json?.error === "invalid_unlock_code", r.json);
    r = await req(34562, "POST", "/api/device/offline-code-used", { deviceId: dev104, code: "OFF123" });
    t("sahi synced code -> ok + offlineUnlockUntil", r.json?.ok === true && typeof r.json?.offlineUnlockUntil === "string" && r.json.offlineUnlockUntil.length > 0, r.json);
    const windowUntil = r.json.offlineUnlockUntil;
    r = await checkin(34562, dev104, "UNIF104D");
    t("code ke baad 24h window -> stay_unlocked + offlineUnlockUntil", r.json?.instruction === "stay_unlocked" && r.json?.offlineUnlockUntil === windowUntil, r.json);
    r = await req(34562, "GET", "/api/device/status?dashboardAccountId=104", undefined, syncH);
    t("status: offlineCodeUsed=true + lockState unlocked", r.json?.offlineCodeUsed === true && r.json?.lockState === "unlocked" && r.json?.offlineUnlockUntil === windowUntil, r.json);
    // Sync offline fields ko nahi mitata.
    await req(34562, "POST", "/api/device/sync", syncBody(104, "UNIF104D", [inst(1, pktDate(-10), 10000), inst(2, addMonthsStr(pktDate(-10), 1), 10000)], { shopPhone: "03009998888" }), syncH);
    r = await req(34562, "GET", "/api/device/status?dashboardAccountId=104", undefined, syncH);
    t("sync ke baad offlineCodeUsed + window ab bhi waisay hi", r.json?.offlineCodeUsed === true && r.json?.offlineUnlockUntil === windowUntil, r.json);
    r = await req(34562, "GET", "/api/device/status?dashboardAccountId=99999", undefined, syncH);
    t("status unknown account -> account_not_found", r.json?.ok === false && r.json?.error === "account_not_found", r.json);

    console.log("\n== H. Test-seed accounts coexist ==");
    r = await req(34562, "POST", "/api/test/seed", { total: 20000, months: 2, graceDays: 5, firstDueDate: pktDate(-10), shopPhone: "03001112222" }, seedH);
    t("seed ok (seed token ab bhi chalta hai)", r.json?.ok === true && typeof r.json?.pairingCode === "string", r.json);
    const seedCode = r.json.pairingCode;
    const seedAcctId = r.json.accountId;
    r = await register(34562, seedCode);
    const devSeed = r.json.deviceId;
    r = await checkin(34562, devSeed, seedCode);
    t("seed account: grace guzri -> lock_now + SERVER-generated code (6 chars)", r.json?.instruction === "lock_now" && typeof r.json?.offlineUnlockCode === "string" && /^[A-Z2-9]{6}$/.test(r.json.offlineUnlockCode), r.json);
    r = await req(34562, "POST", "/api/test/pay", { accountId: seedAcctId, amount: 20000 }, seedH);
    t("test/pay ab bhi chalta hai -> completed", r.json?.ok === true && r.json?.status === "completed", r.json);
    r = await checkin(34562, devSeed, seedCode);
    t("seed final payment -> permanent_unlock", r.json?.instruction === "permanent_unlock", r.json);
    r = await req(34562, "GET", "/api/test/accounts", undefined, seedH);
    const syncedCount = (r.json?.accounts || []).filter((a) => a.dashboardAccountId != null).length;
    t("dump: seed synced mein nahi gina jata (kul = synced + 1)", (r.json?.accounts || []).length === syncedCount + 1, r.json);
    const seedAcct = r.json?.accounts?.find((a) => a.id === seedAcctId);
    t("seed account ka dashboardAccountId null hai", seedAcct?.dashboardAccountId === null, seedAcct);

    console.log("\n== I. sync-all: atomicity + full replace + preserve ==");
    r = await req(34562, "POST", "/api/device/sync-all", { shopId: 1, accounts: [syncBody(201, "UNIF201A", [inst(1, pktDate(30), 5000)]), { pairingCode: "BAD", installments: [] }] }, syncH);
    t("sync-all aik kharab entry -> 400 (atomic)", r.status === 400 && r.json?.error === "invalid_sync_payload", r.json);
    r = await req(34562, "GET", "/api/device/status?dashboardAccountId=101", undefined, syncH);
    t("failed sync-all ke baad purana data waisa hi", r.json?.ok === true && r.json?.deviceRegistered === true, r.json);
    r = await req(34562, "POST", "/api/device/sync-all", { shopId: 1, accounts: [syncBody(201, "UNIF201A", [inst(1, pktDate(30), 5000)]), syncBody(201, "UNIF201A", [inst(1, pktDate(30), 5000)])] }, syncH);
    t("sync-all duplicate dashboardAccountId -> 400", r.status === 400 && r.json?.error === "invalid_sync_payload", r.json);
    r = await req(34562, "POST", "/api/device/sync-all", { shopId: 1, accounts: [syncBody(201, "UNIF201A", [inst(1, pktDate(30), 5000), inst(2, addMonthsStr(pktDate(30), 1), 5000)]), syncBody(202, "UNIF202B", [inst(1, pktDate(30), 7000)])] }, syncH);
    t("sync-all ok -> synced: 2", r.json?.ok === true && r.json?.synced === 2, r.json);
    r = await req(34562, "GET", "/api/device/status?dashboardAccountId=101", undefined, syncH);
    t("sync-all ke baad purana synced account gaya", r.json?.ok === false && r.json?.error === "account_not_found", r.json);
    r = await register(34562, "UNIF101A");
    t("purana pairing code ab invalid", r.json?.ok === false && r.json?.error === "invalid_pairing_code", r.json);
    r = await checkin(34562, devSeed, seedCode);
    t("sync-all seed account ko haath nahi lagata", r.json?.ok === true && r.json?.instruction === "permanent_unlock", r.json);
    r = await register(34562, "UNIF201A");
    const dev201 = r.json.deviceId;
    t("naya synced account register hota hai", r.json?.ok === true, r.json);
    r = await req(34562, "POST", "/api/device/sync-all", { shopId: 1, accounts: [syncBody(201, "UNIF201A", [inst(1, pktDate(30), 5000, 1000), inst(2, addMonthsStr(pktDate(30), 1), 5000)]), syncBody(202, "UNIF202B", [inst(1, pktDate(30), 7000)])] }, syncH);
    t("dobara sync-all ok", r.json?.ok === true && r.json?.synced === 2, r.json);
    r = await checkin(34562, dev201, "UNIF201A");
    t("sync-all ke baad deviceId bacha rehta hai", r.json?.ok === true && r.json?.instruction === "stay_unlocked", r.json);

    await stopServer(server); server = null;

    // ---- Server C: wipe recovery (data file delete + restart) ----
    console.log("\n== J. Wipe recovery ==");
    // Render wipe poori disk mitata hai — .bak bhi (J2-M10: .bak
    // sirf kharab-file recovery ke liye hai, wipe ke baad nahi rehta).
    unlinkSync(dataB);
    if (existsSync(dataB + ".bak")) unlinkSync(dataB + ".bak");
    server = await startServer({ port: 34563, dataFile: dataB, seedToken: SEED, syncToken: SYNC });
    r = await req(34563, "GET", "/api/test/accounts", undefined, seedH);
    t("wipe ke baad accounts=0", Array.isArray(r.json?.accounts) && r.json.accounts.length === 0, r.json);
    r = await req(34563, "POST", "/api/device/sync-all", { shopId: 1, accounts: [syncBody(201, "UNIF201A", [inst(1, pktDate(30), 5000, 1000), inst(2, addMonthsStr(pktDate(30), 1), 5000)]), syncBody(202, "UNIF202B", [inst(1, pktDate(30), 7000)])] }, syncH);
    t("wipe ke baad sync-all restore karta hai", r.json?.ok === true && r.json?.synced === 2, r.json);
    r = await checkin(34563, dev201, "UNIF201A");
    t("wipe ke baad PURANA deviceId nahi chalta (registration data.json mein thi)", r.json?.ok === false && r.json?.error === "device_not_registered", r.json);
    r = await register(34563, "UNIF201A");
    t("wipe ke baad dobara register hota hai", r.json?.ok === true && typeof r.json?.deviceId === "string", r.json);
    r = await checkin(34563, r.json.deviceId, "UNIF201A");
    t("re-register ke baad checkin stay_unlocked (paidAmount bhi restore hua)", r.json?.ok === true && r.json?.instruction === "stay_unlocked" && r.json?.remainingAmount === 9000, r.json);
    r = await req(34563, "GET", "/api/test/accounts", undefined, seedH);
    t("wipe ke baad seed account wapas nahi aata (sirf synced restore hote hain)", (r.json?.accounts || []).length === 2 && (r.json.accounts || []).every((a) => a.dashboardAccountId != null), r.json);
    await stopServer(server); server = null;

    // ---- Server D: sync-all shop scoping (OQ-1 fix) + autoLock (OQ-2 fix) ----
    console.log("\n== K. sync-all shop scoping + autoLock ==");
    const dataD = join(dir, "d.json");
    server = await startServer({ port: 34564, dataFile: dataD, seedToken: SEED, syncToken: SYNC });
    r = await req(34564, "POST", "/api/device/sync", { dashboardAccountId: 301, pairingCode: "SCOP301A", installments: [] }, syncH);
    t("sync bina shopId -> 400", r.status === 400 && r.json?.error === "invalid_sync_payload", r.json);
    r = await req(34564, "POST", "/api/device/sync-all", { accounts: [syncBody(301, "SCOP301A", [inst(1, pktDate(30), 5000)])] }, syncH);
    t("sync-all bina top-level shopId -> 400", r.status === 400 && r.json?.error === "invalid_sync_payload", r.json);
    r = await req(34564, "POST", "/api/device/sync-all", { shopId: 1, accounts: [syncBody(301, "SCOP301A", [inst(1, pktDate(30), 5000)], { shopId: 2 })] }, syncH);
    t("sync-all entry shopId mismatch -> 400", r.status === 400 && r.json?.error === "invalid_sync_payload", r.json);
    await req(34564, "POST", "/api/device/sync", syncBody(301, "SCOP301A", [inst(1, pktDate(30), 5000)]), syncH);
    await req(34564, "POST", "/api/device/sync", syncBody(302, "SCOP302B", [inst(1, pktDate(30), 5000)]), syncH);
    await req(34564, "POST", "/api/device/sync", syncBody(303, "SCOP303C", [inst(1, pktDate(30), 5000)], { shopId: 2 }), syncH);
    r = await req(34564, "POST", "/api/device/sync-all", { shopId: 1, accounts: [syncBody(301, "SCOP301A", [inst(1, pktDate(30), 5000)])] }, syncH);
    t("sync-all shop 1 ok -> synced: 1", r.json?.ok === true && r.json?.synced === 1, r.json);
    r = await req(34564, "GET", "/api/device/status?dashboardAccountId=302", undefined, syncH);
    t("sync-all ne usi shop ka chhota account mitaya", r.json?.ok === false && r.json?.error === "account_not_found", r.json);
    r = await req(34564, "GET", "/api/device/status?dashboardAccountId=303", undefined, syncH);
    t("sync-all doosri shop ko haath nahi lagata", r.json?.ok === true && r.json?.dashboardAccountId === 303, r.json);
    r = await req(34564, "POST", "/api/device/sync-all", { shopId: 1, accounts: [] }, syncH);
    t("sync-all khaali list = us shop ki safai", r.json?.ok === true && r.json?.synced === 0, r.json);
    r = await req(34564, "GET", "/api/device/status?dashboardAccountId=301", undefined, syncH);
    t("safai ke baad shop 1 ka account gaya", r.json?.ok === false && r.json?.error === "account_not_found", r.json);
    r = await req(34564, "GET", "/api/device/status?dashboardAccountId=303", undefined, syncH);
    t("safai ke baad bhi shop 2 ka account bacha", r.json?.ok === true && r.json?.dashboardAccountId === 303, r.json);
    await req(34564, "POST", "/api/device/sync", syncBody(304, "SCOP304D", [inst(1, pktDate(-10), 10000)], { autoLock: false }), syncH);
    r = await register(34564, "SCOP304D");
    const dev304 = r.json?.deviceId;
    r = await checkin(34564, dev304, "SCOP304D");
    t("autoLock off + grace guzri -> warn, lock nahi", r.json?.ok === true && r.json?.instruction === "warn", r.json);
    await req(34564, "POST", "/api/device/sync", syncBody(304, "SCOP304D", [inst(1, pktDate(-10), 10000)], { autoLock: true }), syncH);
    r = await checkin(34564, dev304, "SCOP304D");
    t("autoLock on + grace guzri -> lock_now", r.json?.ok === true && r.json?.instruction === "lock_now", r.json);
    await req(34564, "POST", "/api/device/sync", syncBody(305, "SCOP305E", [inst(1, pktDate(30), 10000)], { autoLock: false, lockState: "locked", unlockCode: "MANU01" }), syncH);
    r = await register(34564, "SCOP305E");
    r = await checkin(34564, r.json?.deviceId, "SCOP305E");
    t("manual lock autoLock off mein bhi lock_now", r.json?.ok === true && r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "MANU01", r.json);
    await stopServer(server); server = null;

    // ---- Server E: v2.1 sync — PU-M5 restore, PU-M1 latch reset, PU-M3 lock wins ----
    console.log("\n== L. v2.1 sync: window restore + new-code reset + manual lock ==");
    const dataE = join(dir, "e.json");
    server = await startServer({ port: 34565, dataFile: dataE, seedToken: SEED, syncToken: SYNC });
    const win12h = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
    // L1: PU-M5 — explicit window/latch restore via sync.
    await req(34565, "POST", "/api/device/sync", syncBody(401, "M5401AAA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "M5CODE1" }), syncH);
    r = await register(34565, "M5401AAA");
    const dev401 = r.json.deviceId;
    r = await checkin(34565, dev401, "M5401AAA");
    t("L1: locked + code -> lock_now + M5CODE1", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "M5CODE1", r.json);
    r = await req(34565, "POST", "/api/device/offline-code-used", { deviceId: dev401, code: "M5CODE1" });
    t("L1: code use -> ok + window", r.json?.ok === true && typeof r.json?.offlineUnlockUntil === "string" && r.json.offlineUnlockUntil.length > 0, r.json);
    // Dashboard re-asserts an adopted window (wipe ke baad jaisa).
    r = await req(34565, "POST", "/api/device/sync", syncBody(401, "M5401AAA", [inst(1, pktDate(-10), 10000)], { unlockCode: "", offlineUnlockUntil: win12h, offlineCodeUsed: true }), syncH);
    t("L1: sync window restore ok", r.json?.ok === true, r.json);
    r = await req(34565, "GET", "/api/device/status?dashboardAccountId=401", undefined, syncH);
    t("L1: PU-M5 status shows restored window + latch", r.json?.offlineUnlockUntil === win12h && r.json?.offlineCodeUsed === true, r.json);
    r = await checkin(34565, dev401, "M5401AAA");
    t("L1: restored window honoured -> stay_unlocked", r.json?.instruction === "stay_unlocked" && r.json?.offlineUnlockUntil === win12h, r.json);
    // Explicit clear.
    await req(34565, "POST", "/api/device/sync", syncBody(401, "M5401AAA", [inst(1, pktDate(-10), 10000)], { unlockCode: "", offlineUnlockUntil: "", offlineCodeUsed: false }), syncH);
    r = await req(34565, "GET", "/api/device/status?dashboardAccountId=401", undefined, syncH);
    t("L1: explicit window/latch clear works", r.json?.offlineUnlockUntil === "" && r.json?.offlineCodeUsed === false, r.json);
    // Validation of the new fields.
    r = await req(34565, "POST", "/api/device/sync", syncBody(405, "M5405AAA", [inst(1, pktDate(30), 10000)], { offlineUnlockUntil: "not-a-date" }), syncH);
    t("L: kharab offlineUnlockUntil -> 400", r.status === 400 && r.json?.error === "invalid_sync_payload", r.json);
    r = await req(34565, "POST", "/api/device/sync", syncBody(405, "M5405AAA", [inst(1, pktDate(30), 10000)], { offlineCodeUsed: "haan" }), syncH);
    t("L: kharab offlineCodeUsed -> 400", r.status === 400 && r.json?.error === "invalid_sync_payload", r.json);
    // L2: PU-M1 — new-code latch reset.
    await req(34565, "POST", "/api/device/sync", syncBody(402, "M1402AAA", [inst(1, pktDate(-10), 10000)], { unlockCode: "M1AAAA", offlineUnlockUntil: win12h, offlineCodeUsed: true }), syncH);
    r = await req(34565, "GET", "/api/device/status?dashboardAccountId=402", undefined, syncH);
    t("L2: restore sets latch + window on new account", r.json?.offlineCodeUsed === true && r.json?.offlineUnlockUntil === win12h, r.json);
    await req(34565, "POST", "/api/device/sync", syncBody(402, "M1402AAA", [inst(1, pktDate(-10), 10000)], { unlockCode: "M1AAAA" }), syncH);
    r = await req(34565, "GET", "/api/device/status?dashboardAccountId=402", undefined, syncH);
    t("L2: same code re-sync keeps latch + window", r.json?.offlineCodeUsed === true && r.json?.offlineUnlockUntil === win12h, r.json);
    const noCodeBody = syncBody(402, "M1402AAA", [inst(1, pktDate(-10), 10000)]);
    delete noCodeBody.unlockCode;
    await req(34565, "POST", "/api/device/sync", noCodeBody, syncH);
    r = await req(34565, "GET", "/api/device/status?dashboardAccountId=402", undefined, syncH);
    t("L2: unlockCode omitted keeps latch + window", r.json?.offlineCodeUsed === true && r.json?.offlineUnlockUntil === win12h, r.json);
    await req(34565, "POST", "/api/device/sync", syncBody(402, "M1402AAA", [inst(1, pktDate(-10), 10000)], { unlockCode: "M1BBBB" }), syncH);
    r = await req(34565, "GET", "/api/device/status?dashboardAccountId=402", undefined, syncH);
    t("L2: PU-M1 fresh code resets latch + clears window", r.json?.offlineCodeUsed === false && r.json?.offlineUnlockUntil === "", r.json);
    await req(34565, "POST", "/api/device/sync", syncBody(402, "M1402AAA", [inst(1, pktDate(-10), 10000)], { unlockCode: "M1CCCC", offlineUnlockUntil: win12h, offlineCodeUsed: true }), syncH);
    r = await req(34565, "GET", "/api/device/status?dashboardAccountId=402", undefined, syncH);
    // J1-C03: saaf restore bheji gayi ho to restore JEET-TI hai —
    // naya code bhi window/latch nahi mita sakta (pehle fresh code
    // jeet-ta tha; yehi wo rule tha jo kamaya hua window kha jata tha).
    t("L2/J1-C03: explicit restore wins over fresh code", r.json?.offlineCodeUsed === true && r.json?.offlineUnlockUntil === win12h, r.json);
    // Full cycle: use code -> dashboard syncs "" -> latch stays; fresh code -> reset.
    await req(34565, "POST", "/api/device/sync", syncBody(403, "M1403AAA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "M1DDDD" }), syncH);
    r = await register(34565, "M1403AAA");
    const dev403 = r.json.deviceId;
    await checkin(34565, dev403, "M1403AAA");
    r = await req(34565, "POST", "/api/device/offline-code-used", { deviceId: dev403, code: "M1DDDD" });
    t("L2: full cycle code use ok", r.json?.ok === true, r.json);
    await req(34565, "POST", "/api/device/sync", syncBody(403, "M1403AAA", [inst(1, pktDate(-10), 10000)], { unlockCode: "" }), syncH);
    r = await req(34565, "GET", "/api/device/status?dashboardAccountId=403", undefined, syncH);
    t("L2: dashboard burns code (\"\") -> latch stays 1", r.json?.offlineCodeUsed === true, r.json);
    await req(34565, "POST", "/api/device/sync", syncBody(403, "M1403AAA", [inst(1, pktDate(-10), 10000)], { unlockCode: "M1EEEE" }), syncH);
    r = await req(34565, "GET", "/api/device/status?dashboardAccountId=403", undefined, syncH);
    t("L2: re-issued fresh code resets latch", r.json?.offlineCodeUsed === false, r.json);
    // L2b: burned code ("") with an adopted window must NOT cancel the
    // window (dashboard-redeem case: the phone never typed the code, so
    // the server still holds the old code; syncing "" is a burn, not a
    // new cycle). UAT fix round mein pakra gaya contract gap.
    await req(34565, "POST", "/api/device/sync", syncBody(406, "M1406AAA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "M1BURN" }), syncH);
    await req(34565, "POST", "/api/device/sync", syncBody(406, "M1406AAA", [inst(1, pktDate(-10), 10000)], { unlockCode: "", offlineUnlockUntil: win12h, offlineCodeUsed: true }), syncH);
    r = await req(34565, "GET", "/api/device/status?dashboardAccountId=406", undefined, syncH);
    t("L2b: burned code (\"\") keeps adopted window + latch", r.json?.offlineUnlockUntil === win12h && r.json?.offlineCodeUsed === true, r.json);
    // L3: PU-M3 — manual lock cancels the window.
    await req(34565, "POST", "/api/device/sync", syncBody(404, "M3404AAA", [inst(1, pktDate(30), 10000)], { lockState: "locked", unlockCode: "M3CODE1" }), syncH);
    r = await register(34565, "M3404AAA");
    const dev404 = r.json.deviceId;
    r = await checkin(34565, dev404, "M3404AAA");
    t("L3: manual lock -> lock_now + code", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "M3CODE1", r.json);
    await req(34565, "POST", "/api/device/offline-code-used", { deviceId: dev404, code: "M3CODE1" });
    r = await checkin(34565, dev404, "M3404AAA");
    t("L3: window active -> stay_unlocked", r.json?.instruction === "stay_unlocked", r.json);
    await req(34565, "POST", "/api/device/sync", syncBody(404, "M3404AAA", [inst(1, pktDate(30), 10000)], { lockState: "locked", unlockCode: "M3CODE2" }), syncH);
    r = await checkin(34565, dev404, "M3404AAA");
    t("L3: PU-M3 manual lock during window -> lock_now (window cancelled)", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "M3CODE2", r.json);
    r = await req(34565, "GET", "/api/device/status?dashboardAccountId=404", undefined, syncH);
    t("L3: status window cleared after manual lock", r.json?.offlineUnlockUntil === "", r.json);
    await req(34565, "POST", "/api/device/sync", syncBody(404, "M3404AAA", [inst(1, pktDate(30), 10000)], { lockState: "locked", unlockCode: "M3CODE2", offlineUnlockUntil: win12h }), syncH);
    r = await req(34565, "GET", "/api/device/status?dashboardAccountId=404", undefined, syncH);
    t("L3: locked + explicit window -> window still cleared", r.json?.offlineUnlockUntil === "", r.json);
    await stopServer(server); server = null;

    // ---- Server F: PU-M5 wipe survival (window + latch via sync-all) ----
    console.log("\n== M. PU-M5 wipe survival ==");
    const dataF = join(dir, "f.json");
    server = await startServer({ port: 34566, dataFile: dataF, seedToken: SEED, syncToken: SYNC });
    await req(34566, "POST", "/api/device/sync", syncBody(411, "M5411AAA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "M5WIP01" }), syncH);
    r = await register(34566, "M5411AAA");
    const dev411 = r.json.deviceId;
    await checkin(34566, dev411, "M5411AAA");
    r = await req(34566, "POST", "/api/device/offline-code-used", { deviceId: dev411, code: "M5WIP01" });
    const earnedWindow = r.json.offlineUnlockUntil;
    t("M: pre-wipe window earned", r.json?.ok === true && typeof earnedWindow === "string" && earnedWindow.length > 0, r.json);
    await stopServer(server); server = null;
    unlinkSync(dataF);
    if (existsSync(dataF + ".bak")) unlinkSync(dataF + ".bak");
    server = await startServer({ port: 34566, dataFile: dataF, seedToken: SEED, syncToken: SYNC });
    r = await req(34566, "GET", "/api/test/accounts", undefined, seedH);
    t("M: wipe ke baad accounts=0", Array.isArray(r.json?.accounts) && r.json.accounts.length === 0, r.json);
    // Dashboard re-asserts the adopted window + latch via sync-all.
    r = await req(34566, "POST", "/api/device/sync-all", { shopId: 1, accounts: [syncBody(411, "M5411AAA", [inst(1, pktDate(-10), 10000)], { unlockCode: "M5WIP01", offlineUnlockUntil: earnedWindow, offlineCodeUsed: true })] }, syncH);
    t("M: sync-all with adopted window ok", r.json?.ok === true && r.json?.synced === 1, r.json);
    r = await req(34566, "GET", "/api/device/status?dashboardAccountId=411", undefined, syncH);
    t("M: PU-M5 window + latch survive wipe via sync-all", r.json?.offlineUnlockUntil === earnedWindow && r.json?.offlineCodeUsed === true, r.json);
    r = await register(34566, "M5411AAA");
    t("M: wipe ke baad dobara register usi code se hota hai", r.json?.ok === true, r.json);
    r = await checkin(34566, r.json.deviceId, "M5411AAA");
    t("M: re-register ke baad window ab bhi stay_unlocked deti hai", r.json?.instruction === "stay_unlocked" && r.json?.offlineUnlockUntil === earnedWindow, r.json);
    await stopServer(server); server = null;

    // ---- Server G: PU-M8 re-register guard + reset PIN ----
    console.log("\n== N. PU-M8 re-register guard + reset PIN ==");
    const dataG = join(dir, "g.json");
    server = await startServer({ port: 34567, dataFile: dataG, seedToken: SEED, syncToken: SYNC });
    await req(34567, "POST", "/api/device/sync", syncBody(501, "M8501AAA", [inst(1, pktDate(30), 10000)], { resetPin: "2468" }), syncH);
    r = await register(34567, "M8501AAA");
    const dev501 = r.json.deviceId;
    t("N: register returns resetPin from sync", r.json?.ok === true && r.json?.resetPin === "2468", r.json);
    r = await req(34567, "GET", "/api/device/status?dashboardAccountId=501", undefined, syncH);
    t("N: status lastReregisterAt khaali (abhi koi re-register nahi)", r.json?.lastReregisterAt === "", r.json);
    r = await register(34567, "M8501AAA");
    t("N: PU-M8 same-code re-register bina deviceId -> 403 reregister_blocked", r.status === 403 && r.json?.error === "reregister_blocked" && typeof r.json?.message === "string", r.json);
    r = await req(34567, "POST", "/api/device/register", { pairingCode: "M8501AAA", imei: "999", model: "Other Phone", androidVersion: "14", deviceId: "dev_ghalat" });
    t("N: re-register ghalat deviceId se -> 403", r.status === 403 && r.json?.error === "reregister_blocked", r.json);
    r = await req(34567, "POST", "/api/device/register", { pairingCode: "M8501AAA", imei: "123456789012345", model: "Pixel Test", androidVersion: "14", deviceId: dev501 });
    t("N: re-register purane deviceId se -> ok (naya deviceId)", r.json?.ok === true && typeof r.json?.deviceId === "string" && r.json.deviceId !== dev501 && r.json?.resetPin === "2468", r.json);
    const dev501b = r.json.deviceId;
    r = await req(34567, "GET", "/api/device/status?dashboardAccountId=501", undefined, syncH);
    t("N: status lastReregisterAt set after re-register", typeof r.json?.lastReregisterAt === "string" && r.json.lastReregisterAt.length > 0, r.json);
    r = await checkin(34567, dev501, "M8501AAA");
    t("N: purana deviceId re-register ke baad dead hai", r.json?.ok === false && r.json?.error === "device_not_registered", r.json);
    r = await checkin(34567, dev501b, "M8501AAA");
    t("N: naya deviceId checkin karta hai", r.json?.ok === true, r.json);
    // Pairing code regenerate -> fresh code se re-register khula hai.
    await req(34567, "POST", "/api/device/sync", syncBody(501, "NEW501AA", [inst(1, pktDate(30), 10000)], { resetPin: "2468" }), syncH);
    r = await register(34567, "M8501AAA");
    t("N: purana pairing code regenerate ke baad invalid", r.json?.ok === false && r.json?.error === "invalid_pairing_code", r.json);
    r = await register(34567, "NEW501AA");
    t("N: naya pairing code se re-register ok (bina deviceId)", r.json?.ok === true, r.json);
    // Seed account: no PIN -> empty string.
    r = await req(34567, "POST", "/api/test/seed", { total: 10000, months: 1, graceDays: 5, firstDueDate: pktDate(30) }, seedH);
    r = await register(34567, r.json.pairingCode);
    t("N: seed register resetPin khaali string", r.json?.ok === true && r.json?.resetPin === "", r.json);
    // resetPin sync se update hota hai.
    await req(34567, "POST", "/api/device/sync", syncBody(502, "M8502AAA", [inst(1, pktDate(30), 10000)], { resetPin: "1357" }), syncH);
    await req(34567, "POST", "/api/device/sync", syncBody(502, "M8502AAA", [inst(1, pktDate(30), 10000)], { resetPin: "9999" }), syncH);
    r = await register(34567, "M8502AAA");
    t("N: resetPin sync se update hota hai", r.json?.resetPin === "9999", r.json);
    await stopServer(server); server = null;

    // ---- Server H: PU-S7 / PU-S9 / PU-S14 / PU-N4 ----
    console.log("\n== O. PU-S7 code rotation + PU-S9 qist number + PU-S14 grace + PU-N4 addMonths ==");
    const dataH = join(dir, "h.json");
    server = await startServer({ port: 34568, dataFile: dataH, seedToken: SEED, syncToken: SYNC });
    // S7: latch set + same code (wipe-restore jaisa) -> lock_now code NAHI bhejta.
    await req(34568, "POST", "/api/device/sync", syncBody(601, "S7601AAA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "S7CODE1", offlineCodeUsed: true }), syncH);
    r = await register(34568, "S7601AAA");
    const dev601 = r.json.deviceId;
    r = await checkin(34568, dev601, "S7601AAA");
    t("O: PU-S7 locked + latch 1 -> lock_now code ke BAGHAIR", r.json?.instruction === "lock_now" && !("offlineUnlockCode" in (r.json || {})), r.json);
    r = await req(34568, "POST", "/api/device/offline-code-used", { deviceId: dev601, code: "S7CODE1" });
    t("O: S7 istemal shuda code dobara reject hota hai", r.json?.ok === false && r.json?.error === "invalid_unlock_code", r.json);
    await req(34568, "POST", "/api/device/sync", syncBody(601, "S7601AAA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "S7CODE2" }), syncH);
    r = await checkin(34568, dev601, "S7601AAA");
    t("O: S7 fresh code sync se -> lock_now WITH naya code", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "S7CODE2", r.json);
    // Latch 0 -> code milta hai (control).
    await req(34568, "POST", "/api/device/sync", syncBody(602, "S7602AAA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "S7CODE3" }), syncH);
    r = await register(34568, "S7602AAA");
    r = await checkin(34568, r.json.deviceId, "S7602AAA");
    t("O: S7 locked + latch 0 -> lock_now WITH code", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "S7CODE3", r.json);
    // S9: installmentNumber / installmentTotal.
    const six = [
      inst(1, pktDate(-70), 10000, 10000), inst(2, pktDate(-40), 10000, 10000),
      inst(3, pktDate(-10), 10000), inst(4, pktDate(20), 10000),
      inst(5, pktDate(50), 10000), inst(6, pktDate(80), 10000),
    ];
    await req(34568, "POST", "/api/device/sync", syncBody(603, "S9603AAA", six), syncH);
    r = await register(34568, "S9603AAA");
    r = await checkin(34568, r.json.deviceId, "S9603AAA");
    t("O: PU-S9 overdue qist #3 of 6", r.json?.instruction === "lock_now" && r.json?.installmentNumber === 3 && r.json?.installmentTotal === 6, r.json);
    await req(34568, "POST", "/api/device/sync", syncBody(604, "S9604AAA", [inst(1, pktDate(30), 10000), inst(2, pktDate(60), 10000), inst(3, pktDate(90), 10000)]), syncH);
    r = await register(34568, "S9604AAA");
    const dev604 = r.json.deviceId;
    r = await checkin(34568, dev604, "S9604AAA");
    t("O: S9 kuch overdue nahi -> agli qist #1 of 3", r.json?.instruction === "stay_unlocked" && r.json?.installmentNumber === 1 && r.json?.installmentTotal === 3, r.json);
    await req(34568, "POST", "/api/device/sync", syncBody(604, "S9604AAA", [inst(1, pktDate(30), 10000, 10000), inst(2, pktDate(60), 10000, 10000), inst(3, pktDate(90), 10000, 10000)], { status: "completed" }), syncH);
    r = await checkin(34568, dev604, "S9604AAA");
    t("O: S9 completed -> permanent_unlock, number absent, total 3", r.json?.instruction === "permanent_unlock" && !("installmentNumber" in (r.json || {})) && r.json?.installmentTotal === 3, r.json);
    // S14: graceDaysLeft inclusive.
    await req(34568, "POST", "/api/device/sync", syncBody(605, "S14605AA", [inst(1, pktDate(-5), 10000)]), syncH);
    r = await register(34568, "S14605AA");
    r = await checkin(34568, r.json.deviceId, "S14605AA");
    t("O: PU-S14 aakhri grace din -> warn + graceDaysLeft 1", r.json?.instruction === "warn" && r.json?.graceDaysLeft === 1, r.json);
    await req(34568, "POST", "/api/device/sync", syncBody(606, "S14606AA", [inst(1, pktDate(-6), 10000)]), syncH);
    r = await register(34568, "S14606AA");
    r = await checkin(34568, r.json.deviceId, "S14606AA");
    t("O: S14 grace guzri (1 din) -> lock_now + graceDaysLeft 0", r.json?.instruction === "lock_now" && r.json?.graceDaysLeft === 0, r.json);
    // N4: addMonths 31 tareekh par overflow nahi karta.
    r = await req(34568, "POST", "/api/test/seed", { total: 30000, months: 3, graceDays: 5, firstDueDate: "2026-01-31" }, seedH);
    const jan31Id = r.json.accountId;
    r = await req(34568, "GET", "/api/test/accounts", undefined, seedH);
    const jan31 = r.json?.installments?.filter((i) => i.accountId === jan31Id).map((i) => i.dueDate);
    t("O: PU-N4 Jan 31 +1 = Feb 28, +2 = Mar 31", JSON.stringify(jan31) === JSON.stringify(["2026-01-31", "2026-02-28", "2026-03-31"]), jan31);
    r = await req(34568, "POST", "/api/test/seed", { total: 20000, months: 2, graceDays: 5, firstDueDate: "2026-03-31" }, seedH);
    const mar31Id = r.json.accountId;
    r = await req(34568, "GET", "/api/test/accounts", undefined, seedH);
    const mar31 = r.json?.installments?.filter((i) => i.accountId === mar31Id).map((i) => i.dueDate);
    t("O: N4 Mar 31 +1 = Apr 30", JSON.stringify(mar31) === JSON.stringify(["2026-03-31", "2026-04-30"]), mar31);
    await stopServer(server); server = null;

    // ---- Server I: PU-S10 rate limiting + salted hash (J1-M24 re-keyed) ----
    console.log("\n== P. PU-S10 rate limiting (code/device keyed) + salted hash ==");
    const dataI = join(dir, "i.json");
    server = await startServer({ port: 34569, dataFile: dataI, seedToken: SEED, syncToken: SYNC });
    // Register: 10 ghalat koshishen AIK CODE se -> 11th 429. XFF har
    // dafa mukhtalif hai — rotation se limit bypass NAHI hoti (J1-M24).
    let lastErr = "";
    for (let i = 0; i < 10; i++) {
      r = await req(34569, "POST", "/api/device/register", { pairingCode: "NOKHUCH1", imei: "", model: "X", androidVersion: "14" }, { "x-forwarded-for": `203.0.113.${i + 1}` });
      lastErr = r.json?.error;
    }
    t("P: 10 ghalat register (rotating XFF) -> invalid_pairing_code (rok nahi)", lastErr === "invalid_pairing_code", lastErr);
    r = await req(34569, "POST", "/api/device/register", { pairingCode: "NOKHUCH1", imei: "", model: "X", androidVersion: "14" }, { "x-forwarded-for": "198.51.100.99" });
    t("P: PU-S10/J1-M24 11th koshish -> 429 (XFF badalne se bhi rok)", r.status === 429 && r.json?.error === "too_many_attempts" && typeof r.json?.message === "string", r.json);
    // Doosra code rok mein nahi hai (per-code, per-IP nahi).
    r = await req(34569, "POST", "/api/device/register", { pairingCode: "DOOSRA11", imei: "", model: "X", androidVersion: "14" }, { "x-forwarded-for": "203.0.113.1" });
    t("P: doosre code par rok nahi (per-code)", r.status === 200 && r.json?.error === "invalid_pairing_code", r.json);
    // Sahi code usi "IP" se chalta hai — shop ki Wi-Fi block nahi hoti.
    await req(34569, "POST", "/api/device/sync", syncBody(701, "RL701AAA", [inst(1, pktDate(30), 10000)], { lockState: "locked", unlockCode: "RL701A" }), syncH);
    r = await req(34569, "POST", "/api/device/register", { pairingCode: "RL701AAA", imei: "1", model: "X", androidVersion: "14" }, { "x-forwarded-for": "203.0.113.1" });
    t("P: J1-M24 sahi code usi IP se chalta hai (koi shared-WiFi block nahi)", r.json?.ok === true, r.json);
    const dev701 = r.json.deviceId;
    // Restart ke baad bhi rok qaim (data.json mein mehfooz).
    await stopServer(server);
    server = await startServer({ port: 34569, dataFile: dataI, seedToken: SEED, syncToken: SYNC });
    r = await req(34569, "POST", "/api/device/register", { pairingCode: "NOKHUCH1", imei: "", model: "X", androidVersion: "14" }, { "x-forwarded-for": "203.0.113.1" });
    t("P: restart ke baad bhi 429 (rate limit data.json mein)", r.status === 429 && r.json?.error === "too_many_attempts", r.json);
    // offline-code-used: 10 ghalat code ek device se -> 11th 429 (XFF rotate bhi).
    r = await checkin(34569, dev701, "RL701AAA");
    t("P: locked account checkin -> lock_now + code", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "RL701A", r.json);
    for (let i = 0; i < 10; i++) {
      r = await req(34569, "POST", "/api/device/offline-code-used", { deviceId: dev701, code: "WRONG1" }, { "x-forwarded-for": `203.0.113.${20 + i}` });
      lastErr = r.json?.error;
    }
    t("P: 10 ghalat code -> invalid_unlock_code", lastErr === "invalid_unlock_code", lastErr);
    r = await req(34569, "POST", "/api/device/offline-code-used", { deviceId: dev701, code: "RL701A" }, { "x-forwarded-for": "198.51.100.99" });
    t("P: PU-S10 11th code koshish -> 429 (sahi code bhi blocked, XFF se farq nahi)", r.status === 429 && r.json?.error === "too_many_attempts", r.json);
    // Doosra device rok mein nahi hai (per-device).
    await req(34569, "POST", "/api/device/sync", syncBody(702, "RL702AAA", [inst(1, pktDate(30), 10000)], { lockState: "locked", unlockCode: "RL702A" }), syncH);
    r = await register(34569, "RL702AAA");
    const dev702 = r.json.deviceId;
    r = await req(34569, "POST", "/api/device/offline-code-used", { deviceId: dev702, code: "WRONG1" }, { "x-forwarded-for": "203.0.113.20" });
    t("P: doosra device rok mein nahi (per-device, usi IP se bhi)", r.status === 200 && r.json?.error === "invalid_unlock_code", r.json);
    // Kamyab code counter saaf kar deta hai: 9 ghalat -> sahi -> 9 ghalat (rok nahi).
    await req(34569, "POST", "/api/device/sync", syncBody(703, "RL703AAA", [inst(1, pktDate(30), 10000)], { lockState: "locked", unlockCode: "RL703A" }), syncH);
    r = await register(34569, "RL703AAA");
    const dev703 = r.json.deviceId;
    for (let i = 0; i < 9; i++) await req(34569, "POST", "/api/device/offline-code-used", { deviceId: dev703, code: "WRONG1" });
    r = await req(34569, "POST", "/api/device/offline-code-used", { deviceId: dev703, code: "RL703A" });
    t("P: 9 ghalat ke baad sahi code chalta hai", r.json?.ok === true, r.json);
    // Dobara lock karein (naya code) taake 9 ghalat dobara try ho sakein.
    await req(34569, "POST", "/api/device/sync", syncBody(703, "RL703AAA", [inst(1, pktDate(30), 10000)], { lockState: "locked", unlockCode: "RL703B" }), syncH);
    let blocked = false;
    for (let i = 0; i < 9; i++) {
      r = await req(34569, "POST", "/api/device/offline-code-used", { deviceId: dev703, code: "WRONG1" });
      if (r.status === 429) blocked = true;
    }
    t("P: kamyabi ke baad counter saaf — 9 ghalat dobara rok nahi", blocked === false, blocked);
    // Salted hash: seed account ka code har lock_now mein milta hai (J1-p16).
    r = await req(34569, "POST", "/api/test/seed", { total: 10000, months: 1, graceDays: 5, firstDueDate: pktDate(-10) }, seedH);
    const seedCode2 = r.json.pairingCode;
    const seedId2 = r.json.accountId;
    r = await register(34569, seedCode2);
    const devSeed2 = r.json.deviceId;
    r = await checkin(34569, devSeed2, seedCode2);
    const firstCode = r.json?.offlineUnlockCode;
    t("P: seed pehli lock_now WITH server code", r.json?.instruction === "lock_now" && typeof firstCode === "string" && /^[A-Z2-9]{6}$/.test(firstCode), r.json);
    r = await checkin(34569, devSeed2, seedCode2);
    t("P: J1-p16 seed doosri lock_now mein BHI wahi code (jawab gum ho to dobara milta hai)", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === firstCode, r.json);
    r = await req(34569, "GET", "/api/test/accounts", undefined, seedH);
    const seedAcct2 = r.json?.accounts?.find((a) => a.id === seedId2);
    // J2-m19: dump mein hash bhi masked hai — hash ki maujoodgi
    // offline-code-used se verify hoti hai (agla test).
    t("P: seed code dump mein masked hai (hash bhi plaintext nahi)", seedAcct2?.unlockCodeHash === "***" && seedAcct2?.unlockCode === "", seedAcct2);
    r = await req(34569, "POST", "/api/device/offline-code-used", { deviceId: devSeed2, code: firstCode });
    t("P: seed code hash se verify ho kar chalta hai", r.json?.ok === true && typeof r.json?.offlineUnlockUntil === "string", r.json);
    r = await checkin(34569, devSeed2, seedCode2);
    t("P: J1-p16 istemal ke baad code dobara NAHI bheja jata (latch)", r.json?.instruction === "stay_unlocked" && !("offlineUnlockCode" in (r.json || {})), r.json);
    await stopServer(server); server = null;

    // ---- Section Q: FCM HTTP v1 unit tests (fcm.mjs, stubbed fetch — koi server nahi) ----
    console.log("\n== Q. FCM HTTP v1 unit tests (stubbed fetch) ==");
    // Test ke liye aik asli RSA keypair banayein (koi asli Firebase key nahi).
    const { publicKey: qPub, privateKey: qPriv } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const qPubPem = qPub.export({ type: "spki", format: "pem" });
    const SA = {
      project_id: "amg-test-project",
      client_email: "fcm-test@amg-test-project.iam.gserviceaccount.com",
      private_key: qPriv.export({ type: "pkcs8", format: "pem" }),
    };
    const SA_JSON = JSON.stringify(SA);
    function verifyJwt(jwt) {
      const parts = String(jwt || "").split(".");
      if (parts.length !== 3) return false;
      const verifier = createVerify("RSA-SHA256");
      verifier.update(parts[0] + "." + parts[1]);
      verifier.end();
      try {
        return verifier.verify(qPubPem, Buffer.from(parts[2], "base64url"));
      } catch { return false; }
    }
    function jwtPart(jwt, idx) {
      try {
        return JSON.parse(Buffer.from(String(jwt).split(".")[idx], "base64url").toString("utf8"));
      } catch { return null; }
    }
    // parseServiceAccount
    const parsedSa = parseServiceAccount(SA_JSON);
    t("Q: parseServiceAccount JSON string -> projectId/clientEmail/privateKey", parsedSa?.projectId === "amg-test-project" && parsedSa?.clientEmail === SA.client_email && parsedSa?.privateKey === SA.private_key, parsedSa);
    t("Q: parseServiceAccount kharab JSON -> null", parseServiceAccount("{kharab") === null && parseServiceAccount("") === null && parseServiceAccount(null) === null);
    t("Q: parseServiceAccount adhoori fields -> null", parseServiceAccount(JSON.stringify({ project_id: "x" })) === null && parseServiceAccount(JSON.stringify({ ...SA, private_key: "not-a-pem" })) === null);
    // JWT shakal + signature
    const testJwt = buildServiceAccountJwt(parsedSa, Date.now());
    const jwtHeader = jwtPart(testJwt, 0);
    const jwtClaims = jwtPart(testJwt, 1);
    t("Q: JWT 3 hisse, header alg RS256", String(testJwt).split(".").length === 3 && jwtHeader?.alg === "RS256" && jwtHeader?.typ === "JWT", jwtHeader);
    t("Q: JWT claims iss/scope/aud/exp-iat=3600", jwtClaims?.iss === SA.client_email && jwtClaims?.scope === "https://www.googleapis.com/auth/firebase.messaging" && jwtClaims?.aud === FCM_DEFAULT_TOKEN_URL && jwtClaims?.exp - jwtClaims?.iat === 3600, jwtClaims);
    t("Q: JWT RS256 signature public key se verify hoti hai", verifyJwt(testJwt) === true);
    // Stub fetch: token endpoint + messages endpoint.
    let tokenCalls = [];
    let msgCalls = [];
    function makeStub({ tokenStatus = 200, tokenBody = null, msgStatus = 200, msgBody = null, throwOnMsg = false } = {}) {
      return async (url, opts) => {
        if (String(url).includes("/oauth2/token") || String(url).includes("token")) {
          tokenCalls.push({ url, opts, body: String(opts?.body || "") });
          if (tokenStatus !== 200) return { ok: false, status: tokenStatus, json: async () => (tokenBody || { error: "invalid_grant" }) };
          return { ok: true, status: 200, json: async () => (tokenBody || { access_token: "stub-access-1", expires_in: 3600, token_type: "Bearer" }) };
        }
        msgCalls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
        if (throwOnMsg) throw new Error("dns fail");
        if (msgStatus !== 200) return { ok: false, status: msgStatus, json: async () => (msgBody || { error: { status: "UNAUTHENTICATED", message: "bad" } }) };
        return { ok: true, status: 200, json: async () => (msgBody || { name: "projects/amg-test-project/messages/msg-1" }) };
      };
    }
    // Success + poori shakal.
    clearFcmTokenCache();
    tokenCalls = []; msgCalls = [];
    let out = await sendFcmPush({ serviceAccount: SA_JSON, token: "tok-1", data: { type: "amg_checkin", reason: "unlocked", dashboardAccountId: "801" }, fetchFn: makeStub() });
    t("Q: stub success -> ok + messageId (v1 name)", out.ok === true && out.messageId === "projects/amg-test-project/messages/msg-1", out);
    const assertion = new URLSearchParams(tokenCalls[0]?.body || "").get("assertion") || "";
    t("Q: token endpoint par JWT assertion (grant_type + verifiable RS256)", tokenCalls.length === 1 && tokenCalls[0].url === FCM_DEFAULT_TOKEN_URL && new URLSearchParams(tokenCalls[0].body).get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" && verifyJwt(assertion) === true, tokenCalls[0]);
    t("Q: v1 endpoint + Bearer header + message{token,data,android HIGH}", msgCalls.length === 1 && msgCalls[0].url === fcmV1Endpoint("amg-test-project") && msgCalls[0].opts.headers.Authorization === "Bearer stub-access-1" && msgCalls[0].body?.message?.token === "tok-1" && msgCalls[0].body?.message?.data?.type === "amg_checkin" && msgCalls[0].body?.message?.data?.reason === "unlocked" && msgCalls[0].body?.message?.android?.priority === "HIGH", msgCalls[0]);
    t("Q: J2-m22 dono FCM calls par AbortSignal timeout hai", tokenCalls[0]?.opts?.signal instanceof AbortSignal && msgCalls[0]?.opts?.signal instanceof AbortSignal);
    // Token caching: doosri send par naya token NAHI manga jata.
    out = await sendFcmPush({ serviceAccount: SA_JSON, token: "tok-1", data: { type: "amg_checkin", reason: "locked" }, fetchFn: makeStub() });
    t("Q: token cache — doosri send par token call nahi (1 hi rehta hai)", out.ok === true && tokenCalls.length === 1 && msgCalls.length === 2, { tokenCalls: tokenCalls.length, msgCalls: msgCalls.length });
    // Chhoti expiry (60s < 5-min buffer) — har dafa naya token.
    clearFcmTokenCache();
    tokenCalls = []; msgCalls = [];
    const shortStub = makeStub({ tokenBody: { access_token: "stub-short", expires_in: 60, token_type: "Bearer" } });
    await sendFcmPush({ serviceAccount: SA_JSON, token: "tok-1", fetchFn: shortStub });
    await sendFcmPush({ serviceAccount: SA_JSON, token: "tok-1", fetchFn: shortStub });
    t("Q: expiry qareeb ho to token dobara manga jata hai (refresh)", tokenCalls.length === 2, tokenCalls.length);
    // Token endpoint fail -> fcm_auth_error, message call nahi hota.
    clearFcmTokenCache();
    tokenCalls = []; msgCalls = [];
    out = await sendFcmPush({ serviceAccount: SA_JSON, token: "tok-1", fetchFn: makeStub({ tokenStatus: 400 }) });
    t("Q: token endpoint 400 -> fcm_auth_error, message nahi bheja jata", out.ok === false && out.error === "fcm_auth_error" && msgCalls.length === 0, out);
    // 404 UNREGISTERED -> tokenDead.
    clearFcmTokenCache();
    out = await sendFcmPush({ serviceAccount: SA_JSON, token: "tok-dead", fetchFn: makeStub({ msgStatus: 404, msgBody: { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found. UNREGISTERED" } } }) });
    t("Q: 404 UNREGISTERED -> fcm_token_not_found + tokenDead", out.ok === false && out.error === "fcm_token_not_found" && out.tokenDead === true, out);
    // 401 -> fcm_http_401.
    clearFcmTokenCache();
    out = await sendFcmPush({ serviceAccount: SA_JSON, token: "tok-1", fetchFn: makeStub({ msgStatus: 401 }) });
    t("Q: FCM 401 -> fcm_http_401", out.ok === false && out.error === "fcm_http_401", out);
    // Send par network throw -> fcm_network_error (kabhi throw nahi).
    clearFcmTokenCache();
    out = await sendFcmPush({ serviceAccount: SA_JSON, token: "tok-1", fetchFn: makeStub({ throwOnMsg: true }) });
    t("Q: send fetch throw -> fcm_network_error (kabhi throw nahi)", out.ok === false && out.error === "fcm_network_error", out);
    // Bina service account -> fcm_not_configured, fetch call nahi hota.
    tokenCalls = []; msgCalls = [];
    out = await sendFcmPush({ serviceAccount: "", token: "tok-1", fetchFn: makeStub() });
    t("Q: bina service account -> fcm_not_configured, fetch call nahi hota", out.ok === false && out.error === "fcm_not_configured" && tokenCalls.length === 0 && msgCalls.length === 0, out);
    out = await sendFcmPush({ serviceAccount: "{kharab", token: "tok-1", fetchFn: makeStub() });
    t("Q: kharab service account JSON -> fcm_not_configured", out.ok === false && out.error === "fcm_not_configured", out);
    out = await sendFcmPush({ serviceAccount: SA_JSON, token: "   ", fetchFn: makeStub() });
    t("Q: khaali token -> no_token", out.ok === false && out.error === "no_token", out);
    // Custom endpoint + custom token endpoint.
    clearFcmTokenCache();
    tokenCalls = []; msgCalls = [];
    out = await sendFcmPush({ serviceAccount: SA_JSON, token: "tok-1", endpoint: "http://127.0.0.1:9/v1/stub-send", tokenEndpoint: "http://127.0.0.1:9/oauth2/token", fetchFn: makeStub() });
    t("Q: custom endpoint + custom token endpoint istemal hote hain", out.ok === true && msgCalls[0]?.url === "http://127.0.0.1:9/v1/stub-send" && tokenCalls[0]?.url === "http://127.0.0.1:9/oauth2/token", { msg: msgCalls[0]?.url, tok: tokenCalls[0]?.url });

    // ---- Section R: FCM trigger (sync unlock/completed/LOCK -> push, local stub endpoint) ----
    console.log("\n== R. FCM trigger: sync unlock/completed/LOCK -> push (HTTP v1) ==");
    const fcmStubPort = 34580;
    const pushes = [];
    let stubTokenCalls = 0;
    const fcmStub = createHttpServer((req2, res2) => {
      let body = "";
      req2.on("data", (c) => { body += c; });
      req2.on("end", () => {
        // Token endpoint: OAuth2 stub.
        if (req2.url === "/oauth2/token") {
          stubTokenCalls += 1;
          res2.writeHead(200, { "Content-Type": "application/json" });
          res2.end(JSON.stringify({ access_token: "stub-access-token", expires_in: 3600, token_type: "Bearer" }));
          return;
        }
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        pushes.push({ path: req2.url, auth: req2.headers.authorization || "", body: parsed });
        // Dead-token stub: is token par Firebase 404 UNREGISTERED deta hai.
        if (parsed?.message?.token === "fcm-token-dead") {
          res2.writeHead(404, { "Content-Type": "application/json" });
          res2.end(JSON.stringify({ error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found. UNREGISTERED" } }));
          return;
        }
        res2.writeHead(200, { "Content-Type": "application/json" });
        res2.end(JSON.stringify({ name: "projects/amg-test-project/messages/stub-1" }));
      });
    });
    await new Promise((resolve) => fcmStub.listen(fcmStubPort, "127.0.0.1", resolve));
    async function waitForPushes(n, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pushes.length >= n) return true;
        await new Promise((x) => setTimeout(x, 100));
      }
      return pushes.length >= n;
    }
    try {
      const dataR = join(dir, "r.json");
      const fcmEnv = {
        FCM_SERVICE_ACCOUNT_JSON: SA_JSON,
        FCM_ENDPOINT: `http://127.0.0.1:${fcmStubPort}/v1/projects/amg-test-project/messages:send`,
        FCM_TOKEN_ENDPOINT: `http://127.0.0.1:${fcmStubPort}/oauth2/token`,
      };
      server = await startServer({ port: 34570, dataFile: dataR, seedToken: SEED, syncToken: SYNC, extraEnv: fcmEnv });
      r = await req(34570, "GET", "/health");
      t("R: health fcmConfigured=true (service account set hai)", r.json?.fcmConfigured === true, r.json);
      // R1: locked account + token wala register.
      await req(34570, "POST", "/api/device/sync", syncBody(801, "FCM801AA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "FCM801A" }), syncH);
      r = await req(34570, "POST", "/api/device/register", { pairingCode: "FCM801AA", imei: "1", model: "Pixel", androidVersion: "14", fcmToken: "fcm-token-801" });
      const dev801 = r.json.deviceId;
      t("R: register fcmToken ke saath ok", r.json?.ok === true && typeof dev801 === "string", r.json);
      r = await checkin(34570, dev801, "FCM801AA");
      t("R: locked checkin -> lock_now", r.json?.instruction === "lock_now", r.json);
      r = await req(34570, "GET", "/api/device/status?dashboardAccountId=801", undefined, syncH);
      t("R: status fcmRegistered=true", r.json?.fcmRegistered === true, r.json);
      // R2: payment sync (unlock) -> push.
      await req(34570, "POST", "/api/device/sync", syncBody(801, "FCM801AA", [inst(1, pktDate(-10), 10000, 10000)], { lockState: "unlocked", unlockCode: "" }), syncH);
      t("R: unlock sync ke baad push aata hai", await waitForPushes(1), pushes);
      t("R: push shape v1 — message.token + Bearer + data (unlocked) + HIGH", pushes.length >= 1 && pushes[0].body?.message?.token === "fcm-token-801" && pushes[0].auth === "Bearer stub-access-token" && pushes[0].body?.message?.data?.type === "amg_checkin" && pushes[0].body?.message?.data?.reason === "unlocked" && pushes[0].body?.message?.data?.dashboardAccountId === "801" && pushes[0].body?.message?.android?.priority === "HIGH", pushes[0]);
      // R3: dobara unlocked sync -> koi naya push nahi (transition nahi).
      await req(34570, "POST", "/api/device/sync", syncBody(801, "FCM801AA", [inst(1, pktDate(-10), 10000, 10000)], { lockState: "unlocked", unlockCode: "" }), syncH);
      await new Promise((x) => setTimeout(x, 500));
      t("R: dobara unlocked sync par naya push NAHI", pushes.length === 1, pushes.length);
      // R4: dobara lock -> push reason=locked (J2-M13); phir completed -> push reason=completed.
      await req(34570, "POST", "/api/device/sync", syncBody(801, "FCM801AA", [inst(1, pktDate(-10), 10000, 10000)], { lockState: "locked", unlockCode: "FCM801B" }), syncH);
      t("R: J2-M13 lock transition par push aata hai", await waitForPushes(2), pushes);
      t("R: lock push reason=locked", pushes[1]?.body?.message?.data?.reason === "locked", pushes[1]);
      await req(34570, "POST", "/api/device/sync", syncBody(801, "FCM801AA", [inst(1, pktDate(-10), 10000, 10000)], { status: "completed", lockState: "unlocked", unlockCode: "" }), syncH);
      t("R: completed sync ke baad push aata hai", await waitForPushes(3), pushes);
      t("R: completed push reason=completed", pushes[2]?.body?.message?.data?.reason === "completed", pushes[2]);
      // R5: token ke baghair register -> unlock par push nahi.
      await req(34570, "POST", "/api/device/sync", syncBody(802, "FCM802AA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "FCM802A" }), syncH);
      r = await register(34570, "FCM802AA");
      await req(34570, "POST", "/api/device/sync", syncBody(802, "FCM802AA", [inst(1, pktDate(-10), 10000, 10000)], { lockState: "unlocked", unlockCode: "" }), syncH);
      await new Promise((x) => setTimeout(x, 500));
      t("R: bina token account par push NAHI", pushes.length === 3, pushes.length);
      r = await req(34570, "GET", "/api/device/status?dashboardAccountId=802", undefined, syncH);
      t("R: status fcmRegistered=false (bina token)", r.json?.fcmRegistered === false, r.json);
      // R6: check-in se token update hota hai.
      await req(34570, "POST", "/api/device/sync", syncBody(803, "FCM803AA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "FCM803A" }), syncH);
      r = await register(34570, "FCM803AA");
      const dev803 = r.json.deviceId;
      r = await req(34570, "POST", "/api/device/checkin", { deviceId: dev803, pairingCode: "FCM803AA", fcmToken: "fcm-token-803-new" });
      t("R: checkin fcmToken ke saath ok", r.json?.ok === true, r.json);
      await req(34570, "POST", "/api/device/sync", syncBody(803, "FCM803AA", [inst(1, pktDate(-10), 10000, 10000)], { lockState: "unlocked", unlockCode: "" }), syncH);
      t("R: checkin se mila token par push jata hai", await waitForPushes(4), pushes);
      t("R: push naye token par gaya", pushes[3]?.body?.message?.token === "fcm-token-803-new", pushes[3]);
      // R7: token sync se nahi mitta (phone-side field) — status se verify
      // (dump mein token masked hai, J2-m19).
      r = await req(34570, "GET", "/api/device/status?dashboardAccountId=801", undefined, syncH);
      t("R: fcmToken sync ke baad bhi mehfooz hai (fcmRegistered)", r.json?.fcmRegistered === true, r.json);
      // R8: sync-all se unlock -> push bhi chalta hai (sirf transition wala account).
      await req(34570, "POST", "/api/device/sync", syncBody(804, "FCM804AA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "FCM804A" }), syncH);
      r = await req(34570, "POST", "/api/device/register", { pairingCode: "FCM804AA", imei: "1", model: "Pixel", androidVersion: "14", fcmToken: "fcm-token-804" });
      await req(34570, "POST", "/api/device/sync-all", { shopId: 1, accounts: [
        syncBody(801, "FCM801AA", [inst(1, pktDate(-10), 10000, 10000)], { status: "completed", lockState: "unlocked", unlockCode: "" }),
        syncBody(802, "FCM802AA", [inst(1, pktDate(-10), 10000, 10000)], { lockState: "unlocked", unlockCode: "" }),
        syncBody(803, "FCM803AA", [inst(1, pktDate(-10), 10000, 10000)], { lockState: "unlocked", unlockCode: "" }),
        syncBody(804, "FCM804AA", [inst(1, pktDate(-10), 10000, 10000)], { lockState: "unlocked", unlockCode: "" }),
      ] }, syncH);
      t("R: sync-all unlock ke baad push aata hai (sirf 804 ka transition)", await waitForPushes(5), pushes);
      t("R: sync-all push 804 ke token par", pushes[4]?.body?.message?.token === "fcm-token-804" && pushes[4]?.body?.message?.data?.dashboardAccountId === "804", pushes[4]);
      // Token cache: 5 pushes, sirf 1 token call (server process mein cache).
      t("R: access token cache hota hai (5 push = 1 token call)", stubTokenCalls === 1, stubTokenCalls);
      // R10: dead token prune + lastPushError (J2-m21).
      await req(34570, "POST", "/api/device/sync", syncBody(805, "FCM805AA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "FCM805A" }), syncH);
      r = await req(34570, "POST", "/api/device/register", { pairingCode: "FCM805AA", imei: "1", model: "Pixel", androidVersion: "14", fcmToken: "fcm-token-dead" });
      await req(34570, "POST", "/api/device/sync", syncBody(805, "FCM805AA", [inst(1, pktDate(-10), 10000, 10000)], { lockState: "unlocked", unlockCode: "" }), syncH);
      t("R: dead token par push koshish hoti hai", await waitForPushes(6), pushes);
      await new Promise((x) => setTimeout(x, 500));
      r = await req(34570, "GET", "/api/device/status?dashboardAccountId=805", undefined, syncH);
      t("R: J2-m21 dead token prune ho jata hai (fcmRegistered=false)", r.json?.fcmRegistered === false, r.json);
      t("R: J2-m21 lastPushError status mein nazar aata hai", r.json?.lastPushError === "fcm_token_not_found" && typeof r.json?.lastPushErrorAt === "string" && r.json.lastPushErrorAt.length > 0, r.json);
      // Kamyab push ke baad lastPushError saaf ho jata hai.
      r = await req(34570, "GET", "/api/device/status?dashboardAccountId=804", undefined, syncH);
      t("R: kamyab push wale account par lastPushError khaali hai", r.json?.lastPushError === "", r.json);
      await stopServer(server); server = null;
      // R9: FCM service account set NAHI — sync theek chalta hai, push nahi aata.
      const dataR2 = join(dir, "r2.json");
      server = await startServer({ port: 34571, dataFile: dataR2, seedToken: SEED, syncToken: SYNC, extraEnv: { FCM_ENDPOINT: `http://127.0.0.1:${fcmStubPort}/v1/projects/amg-test-project/messages:send`, FCM_TOKEN_ENDPOINT: `http://127.0.0.1:${fcmStubPort}/oauth2/token` } });
      r = await req(34571, "GET", "/health");
      t("R: bina service account health fcmConfigured=false", r.json?.fcmConfigured === false, r.json);
      await req(34571, "POST", "/api/device/sync", syncBody(901, "FCM901AA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "FCM901A" }), syncH);
      r = await req(34571, "POST", "/api/device/register", { pairingCode: "FCM901AA", imei: "1", model: "Pixel", androidVersion: "14", fcmToken: "fcm-token-901" });
      r = await req(34571, "POST", "/api/device/sync", syncBody(901, "FCM901AA", [inst(1, pktDate(-10), 10000, 10000)], { lockState: "unlocked", unlockCode: "" }), syncH);
      t("R: bina service account sync phir bhi ok", r.json?.ok === true, r.json);
      await new Promise((x) => setTimeout(x, 500));
      t("R: bina service account koi push NAHI aata (no-op)", pushes.length === 6, pushes.length);
      await stopServer(server); server = null;
    } finally {
      await new Promise((resolve) => fcmStub.close(resolve));
    }

    // ---- Server S: J1-C03 regression — EXACT WS1c §2.1 sequence ----
    console.log("\n== S. J1-C03: 24h window survives dashboard sync (exact sequence) ==");
    const dataS = join(dir, "s.json");
    server = await startServer({ port: 34572, dataFile: dataS, seedToken: SEED, syncToken: SYNC });
    // S1: phone uses code -> dashboard adopts used state -> dashboard syncs.
    await req(34572, "POST", "/api/device/sync", syncBody(1001, "TEST2026", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "KLMN89", resetPin: "4821" }), syncH);
    r = await register(34572, "TEST2026");
    const dev1001 = r.json.deviceId;
    t("S1: register ok", r.json?.ok === true && typeof dev1001 === "string", r.json);
    r = await checkin(34572, dev1001, "TEST2026");
    t("S1: check-in lock_now + KLMN89", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "KLMN89", r.json);
    r = await req(34572, "POST", "/api/device/offline-code-used", { deviceId: dev1001, code: "KLMN89" });
    t("S1: code used -> window issued", r.json?.ok === true && typeof r.json?.offlineUnlockUntil === "string" && r.json.offlineUnlockUntil.length > 0, r.json);
    const earnedS1 = r.json.offlineUnlockUntil;
    r = await req(34572, "GET", "/api/device/status?dashboardAccountId=1001", undefined, syncH);
    t("S1: status latch + window set after use", r.json?.offlineCodeUsed === true && r.json?.offlineUnlockUntil === earnedS1, r.json);
    // Dashboard adoption sync: SAME code + adopted window + latch (UAT log ke mutabiq).
    r = await req(34572, "POST", "/api/device/sync", syncBody(1001, "TEST2026", [inst(1, pktDate(-10), 10000)], { lockState: "unlocked", unlockCode: "KLMN89", offlineUnlockUntil: earnedS1, offlineCodeUsed: true }), syncH);
    t("S1: adoption sync accepted", r.json?.ok === true, r.json);
    r = await req(34572, "GET", "/api/device/status?dashboardAccountId=1001", undefined, syncH);
    t("S1: J1-C03 window SURVIVES adoption sync", r.json?.offlineUnlockUntil === earnedS1, r.json);
    t("S1: J1-C03 latch SURVIVES adoption sync", r.json?.offlineCodeUsed === true, r.json);
    r = await checkin(34572, dev1001, "TEST2026");
    t("S1: check-in after adoption stays unlocked (window)", r.json?.instruction === "stay_unlocked" && r.json?.offlineUnlockUntil === earnedS1, r.json);
    // Agla lock (manual) — jala hua code dobara NAHI bheja jata (PU-S7 latch holds).
    await req(34572, "POST", "/api/device/sync", syncBody(1001, "TEST2026", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "KLMN89" }), syncH);
    r = await checkin(34572, dev1001, "TEST2026");
    t("S1: J1-C03 next lock_now does NOT re-send burned code", r.json?.instruction === "lock_now" && !("offlineUnlockCode" in (r.json || {})), r.json);
    // S2 (T2b): fresh code + adopted window -> window survives.
    await req(34572, "POST", "/api/device/sync", syncBody(1002, "LOCKCOD2", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "AAAA11" }), syncH);
    r = await register(34572, "LOCKCOD2");
    const dev1002 = r.json.deviceId;
    await checkin(34572, dev1002, "LOCKCOD2");
    r = await req(34572, "POST", "/api/device/offline-code-used", { deviceId: dev1002, code: "AAAA11" });
    const earnedS2 = r.json.offlineUnlockUntil;
    await req(34572, "POST", "/api/device/sync", syncBody(1002, "LOCKCOD2", [inst(1, pktDate(-10), 10000)], { lockState: "unlocked", unlockCode: "ZZ99ZZ", offlineUnlockUntil: earnedS2, offlineCodeUsed: true }), syncH);
    r = await req(34572, "GET", "/api/device/status?dashboardAccountId=1002", undefined, syncH);
    t("S2: window survives fresh-code adoption sync", r.json?.offlineUnlockUntil === earnedS2 && r.json?.offlineCodeUsed === true, r.json);
    // S3: routine sync (same code, NO restore fields) after code use -> window survives.
    await req(34572, "POST", "/api/device/sync", syncBody(1003, "ROUT1003", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "RT1003A" }), syncH);
    r = await register(34572, "ROUT1003");
    const dev1003 = r.json.deviceId;
    await checkin(34572, dev1003, "ROUT1003");
    r = await req(34572, "POST", "/api/device/offline-code-used", { deviceId: dev1003, code: "RT1003A" });
    const earnedS3 = r.json.offlineUnlockUntil;
    await req(34572, "POST", "/api/device/sync", syncBody(1003, "ROUT1003", [inst(1, pktDate(-10), 10000)], { lockState: "unlocked", unlockCode: "RT1003A", shopPhone: "03005556666" }), syncH);
    r = await req(34572, "GET", "/api/device/status?dashboardAccountId=1003", undefined, syncH);
    t("S3: routine sync (same code, no restore) keeps window + latch", r.json?.offlineUnlockUntil === earnedS3 && r.json?.offlineCodeUsed === true, r.json);
    // S4: fresh code WITHOUT restore after use -> PU-M1 latch reset still holds.
    await req(34572, "POST", "/api/device/sync", syncBody(1004, "S41004AA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "S4AAAA" }), syncH);
    r = await register(34572, "S41004AA");
    const dev1004 = r.json.deviceId;
    await checkin(34572, dev1004, "S41004AA");
    await req(34572, "POST", "/api/device/offline-code-used", { deviceId: dev1004, code: "S4AAAA" });
    await req(34572, "POST", "/api/device/sync", syncBody(1004, "S41004AA", [inst(1, pktDate(-10), 10000)], { lockState: "unlocked", unlockCode: "S4BBBB" }), syncH);
    r = await req(34572, "GET", "/api/device/status?dashboardAccountId=1004", undefined, syncH);
    t("S4: fresh code WITHOUT restore resets latch + clears window (PU-M1)", r.json?.offlineCodeUsed === false && r.json?.offlineUnlockUntil === "", r.json);
    r = await checkin(34572, dev1004, "S41004AA");
    t("S4: re-lock ke baad lock_now WITH fresh code", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "S4BBBB", r.json);
    await stopServer(server); server = null;

    // ---- Server T: J1-M23 sync-all atomicity ----
    console.log("\n== T. J1-M23: sync-all atomic (failed batch changes NOTHING) ==");
    const dataT = join(dir, "t.json");
    server = await startServer({ port: 34573, dataFile: dataT, seedToken: SEED, syncToken: SYNC });
    await req(34573, "POST", "/api/device/sync", syncBody(1101, "AT1101AA", [inst(1, pktDate(30), 5000)]), syncH);
    await req(34573, "POST", "/api/device/sync", syncBody(1103, "AT1103AA", [inst(1, pktDate(30), 5000)]), syncH);
    // Failed batch: 1101 updated (locked) + 1102 NEW without pairingCode.
    const bad1102 = syncBody(1102, undefined, [inst(1, pktDate(30), 5000)]);
    delete bad1102.pairingCode;
    r = await req(34573, "POST", "/api/device/sync-all", { shopId: 1, accounts: [syncBody(1101, "AT1101AA", [inst(1, pktDate(30), 5000)], { lockState: "locked", unlockCode: "AT1101X" }), bad1102] }, syncH);
    t("T: sync-all rejects (400)", r.status === 400 && r.json?.error === "invalid_sync_payload", r.json);
    r = await req(34573, "GET", "/api/device/status?dashboardAccountId=1103", undefined, syncH);
    t("T: J1-M23 1103 survives the failed sync-all (not deleted)", r.json?.ok === true && r.json?.dashboardAccountId === 1103, r.json);
    r = await req(34573, "GET", "/api/device/status?dashboardAccountId=1101", undefined, syncH);
    t("T: J1-M23 1101 UNCHANGED by failed sync-all (still unlocked)", r.json?.ok === true && r.json?.lockState === "unlocked", r.json);
    r = await req(34573, "GET", "/api/device/status?dashboardAccountId=1102", undefined, syncH);
    t("T: 1102 was not created", r.json?.ok === false && r.json?.error === "account_not_found", r.json);
    // A valid sync-all afterwards still works.
    r = await req(34573, "POST", "/api/device/sync-all", { shopId: 1, accounts: [syncBody(1101, "AT1101AA", [inst(1, pktDate(30), 5000)], { lockState: "locked", unlockCode: "AT1101X" }), syncBody(1103, "AT1103AA", [inst(1, pktDate(30), 5000)])] }, syncH);
    t("T: valid sync-all after failure works", r.json?.ok === true && r.json?.synced === 2, r.json);
    r = await req(34573, "GET", "/api/device/status?dashboardAccountId=1101", undefined, syncH);
    t("T: 1101 locked only by the VALID sync-all", r.json?.lockState === "locked", r.json);
    await stopServer(server); server = null;

    // ---- Server U: J1-M24 shop-WiFi scenario + J2-m28 reregister 403 ----
    console.log("\n== U. J1-M24 shop Wi-Fi + J2-m28 reregister_blocked not counted ==");
    const dataU = join(dir, "u.json");
    server = await startServer({ port: 34574, dataFile: dataU, seedToken: SEED, syncToken: SYNC });
    await req(34574, "POST", "/api/device/sync", syncBody(1301, "SHOP1301", [inst(1, pktDate(30), 10000)]), syncH);
    // Audit C1 ulat: aik hi IP se 10 ghalat register — sahi code usi IP se chalta hai.
    const shopWifi = { "x-forwarded-for": "203.0.113.50" };
    for (let i = 0; i < 10; i++) {
      await req(34574, "POST", "/api/device/register", { pairingCode: "BADCODE1", imei: "", model: "X", androidVersion: "14" }, shopWifi);
    }
    r = await req(34574, "POST", "/api/device/register", { pairingCode: "SHOP1301", imei: "1", model: "X", androidVersion: "14" }, shopWifi);
    t("U: J1-M24 valid register from the SAME shop Wi-Fi still works", r.json?.ok === true, r.json);
    const dev1301 = r.json.deviceId;
    // J2-m28: 10x reregister_blocked (403) -> koi 429 nahi, aur
    // sahi deviceId se re-register ab bhi chalta hai.
    let got403 = 0, got429 = false;
    for (let i = 0; i < 10; i++) {
      r = await req(34574, "POST", "/api/device/register", { pairingCode: "SHOP1301", imei: "9", model: "Other", androidVersion: "14" });
      if (r.status === 403 && r.json?.error === "reregister_blocked") got403 += 1;
      if (r.status === 429) got429 = true;
    }
    t("U: J2-m28 10x reregister_blocked, kabhi 429 nahi", got403 === 10 && got429 === false, { got403, got429 });
    r = await req(34574, "POST", "/api/device/register", { pairingCode: "SHOP1301", imei: "1", model: "X", androidVersion: "14", deviceId: dev1301 });
    t("U: J2-m28 same-device re-register after 10x 403 still works", r.json?.ok === true, r.json);
    await stopServer(server); server = null;

    // ---- Server V: J2-M10 atomic save + backup, J2-M11 body limits, J2-m24 seed, J2-m26 caps ----
    console.log("\n== V. J2-M10 backup + J2-M11 body limits + J2-m24 seed + J2-m26 caps ==");
    const dataV = join(dir, "v.json");
    server = await startServer({ port: 34575, dataFile: dataV, seedToken: SEED, syncToken: SYNC });
    // .bak banane ke liye do alag saves (debounce 200ms — beech mein rukna zaroori hai).
    await req(34575, "POST", "/api/device/sync", syncBody(1401, "BAK1401A", [inst(1, pktDate(30), 5000)]), syncH);
    await new Promise((x) => setTimeout(x, 400));
    await req(34575, "POST", "/api/device/sync", syncBody(1402, "BAK1402A", [inst(1, pktDate(30), 5000)]), syncH);
    await new Promise((x) => setTimeout(x, 400));
    t("V: J2-M10 .bak file maujood hai (aakhri achha save)", existsSync(dataV + ".bak"), dataV + ".bak");
    // Asal file kharab karein, restart karein — backup se wapas aana chahiye.
    writeFileSync(dataV, "{ye kharab json hai");
    await stopServer(server); server = null;
    server = await startServer({ port: 34575, dataFile: dataV, seedToken: SEED, syncToken: SYNC });
    r = await req(34575, "GET", "/api/device/status?dashboardAccountId=1401", undefined, syncH);
    t("V: J2-M10 corrupt data.json -> backup se 1401 wapas aata hai", r.json?.ok === true && r.json?.dashboardAccountId === 1401, r.json);
    // Body limits.
    const big5mb = JSON.stringify({ pairingCode: "X".repeat(5 * 1024 * 1024) });
    r = await req(34575, "POST", "/api/device/register", big5mb);
    t("V: J2-M11 5MB body register par -> 413 body_too_large", r.status === 413 && r.json?.error === "body_too_large", r.status);
    const big2mb = JSON.stringify({ x: "Y".repeat(2 * 1024 * 1024) });
    r = await req(34575, "POST", "/api/device/register", big2mb);
    t("V: J2-M11 2MB body register par -> 413 (had 1MB)", r.status === 413, r.status);
    r = await req(34575, "POST", "/api/device/sync-all", big2mb, syncH);
    t("V: J2-M11 2MB body sync-all par 413 NAHI (had 5MB)", r.status !== 413, r.status);
    const big6mb = JSON.stringify({ x: "Z".repeat(6 * 1024 * 1024) });
    r = await req(34575, "POST", "/api/device/sync-all", big6mb, syncH);
    t("V: J2-M11 6MB body sync-all par -> 413", r.status === 413 && r.json?.error === "body_too_large", r.status);
    // Seed validation.
    r = await req(34575, "POST", "/api/test/seed", { total: 10000, months: 2, firstDueDate: "not-a-date" }, seedH);
    t("V: J2-m24 seed kharab firstDueDate -> 400 (500 nahi)", r.status === 400 && r.json?.error === "invalid_seed_payload", r.json);
    r = await req(34575, "POST", "/api/test/seed", { total: 10000, months: 0 }, seedH);
    t("V: J2-m24 seed months 0 -> 400", r.status === 400, r.json);
    r = await req(34575, "POST", "/api/test/seed", { total: 10000, months: 61 }, seedH);
    t("V: J2-m24 seed months 61 -> 400 (had 60)", r.status === 400, r.json);
    r = await req(34575, "POST", "/api/test/seed", { total: 10000, months: 2.5 }, seedH);
    t("V: J2-m24 seed months 2.5 -> 400 (integer lazmi)", r.status === 400, r.json);
    r = await req(34575, "POST", "/api/test/seed", { total: -5, months: 2 }, seedH);
    t("V: J2-m24 seed negative total -> 400", r.status === 400, r.json);
    r = await req(34575, "POST", "/api/test/seed", { total: 10000, months: 2, graceDays: -1 }, seedH);
    t("V: J2-m24 seed negative graceDays -> 400", r.status === 400, r.json);
    r = await req(34575, "POST", "/api/test/seed", { total: 10000, months: 2, firstDueDate: pktDate(30) }, seedH);
    t("V: J2-m24 valid seed ab bhi ok", r.json?.ok === true && typeof r.json?.pairingCode === "string", r.json);
    // String/number caps.
    r = await req(34575, "POST", "/api/device/sync", syncBody(1403, "CAP1403A", [inst(1, pktDate(30), 10000)], { shopName: "S".repeat(201) }), syncH);
    t("V: J2-m26 shopName 201 chars -> 400", r.status === 400, r.json);
    r = await req(34575, "POST", "/api/device/sync", syncBody(1403, "CAP1403A", [inst(1, pktDate(30), 10000)], { customerName: "C".repeat(201) }), syncH);
    t("V: J2-m26 customerName 201 chars -> 400", r.status === 400, r.json);
    r = await req(34575, "POST", "/api/device/sync", syncBody(1403, "CAP1403A", [inst(1, pktDate(30), 10000)], { graceDays: 366 }), syncH);
    t("V: J2-m26 graceDays 366 -> 400", r.status === 400, r.json);
    r = await req(34575, "POST", "/api/device/sync", syncBody(1403, "CAP1403A", [inst(1, pktDate(30), 2000000000)]), syncH);
    t("V: J2-m26 amount 2 arab -> 400", r.status === 400, r.json);
    const manyInst = Array.from({ length: 121 }, (_, i) => inst(i + 1, pktDate(30 + i), 100));
    r = await req(34575, "POST", "/api/device/sync", syncBody(1403, "CAP1403A", manyInst), syncH);
    t("V: J2-m26 121 installments -> 400 (had 120)", r.status === 400, r.json);
    r = await req(34575, "POST", "/api/device/sync", syncBody(1403, "C".repeat(33), [inst(1, pktDate(30), 10000)]), syncH);
    t("V: J2-m26 pairingCode 33 chars -> 400", r.status === 400, r.json);
    r = await req(34575, "POST", "/api/device/sync", syncBody(1403, "CAP1403A", [inst(1, pktDate(30), 10000)], { shopName: "S".repeat(200) }), syncH);
    t("V: J2-m26 had ke andar (200 chars) ok", r.json?.ok === true, r.json);
    await stopServer(server); server = null;
    // Corrupt main + NO backup -> khaali shuruaat (koi crash nahi).
    const dataW = join(dir, "w.json");
    writeFileSync(dataW, "{bilkul kharab");
    server = await startServer({ port: 34576, dataFile: dataW, seedToken: SEED, syncToken: SYNC });
    r = await req(34576, "GET", "/api/test/accounts", undefined, seedH);
    t("V: corrupt file + no backup -> khaali shuruaat, server chalta hai", Array.isArray(r.json?.accounts) && r.json.accounts.length === 0, r.json);
    await stopServer(server); server = null;

    // ---- Server W: J2-M12 ambiguity + contract (dashboardAccountId, pairing_code_changed, schedule) ----
    console.log("\n== W. J2-M12 ambiguity + contract additions ==");
    const dataX = join(dir, "x.json");
    server = await startServer({ port: 34577, dataFile: dataX, seedToken: SEED, syncToken: SYNC });
    await req(34577, "POST", "/api/device/sync", syncBody(1501, "SAMECODE", [inst(1, pktDate(30), 10000)]), syncH);
    await req(34577, "POST", "/api/device/sync", syncBody(1502, "SAMECODE", [inst(1, pktDate(30), 10000)], { shopId: 2 }), syncH);
    r = await register(34577, "SAMECODE");
    t("W: J2-M12 duplicate pairing code -> pairing_code_ambiguous (first-match nahi)", r.json?.ok === false && r.json?.error === "pairing_code_ambiguous", r.json);
    r = await req(34577, "GET", "/api/device/status?dashboardAccountId=1501", undefined, syncH);
    const reg1501 = r.json?.deviceRegistered;
    r = await req(34577, "GET", "/api/device/status?dashboardAccountId=1502", undefined, syncH);
    t("W: J2-M12 ambiguous register kisi account ko bind nahi karta", reg1501 === false && r.json?.deviceRegistered === false, { reg1501, reg1502: r.json?.deviceRegistered });
    // Register response mein dashboardAccountId.
    await req(34577, "POST", "/api/device/sync", syncBody(1503, "W1503AAA", [inst(1, pktDate(30), 10000), inst(2, pktDate(60), 10000, 4000), inst(3, pktDate(90), 10000)]), syncH);
    r = await register(34577, "W1503AAA");
    t("W: register response mein dashboardAccountId (dashboard ki id)", r.json?.ok === true && r.json?.dashboardAccountId === 1503, r.json);
    const dev1503 = r.json.deviceId;
    r = await req(34577, "POST", "/api/test/seed", { total: 10000, months: 1, firstDueDate: pktDate(30) }, seedH);
    r = await register(34577, r.json.pairingCode);
    t("W: seed register par dashboardAccountId null", r.json?.ok === true && r.json?.dashboardAccountId === null, r.json);
    // Check-in schedule + graceDays.
    r = await checkin(34577, dev1503, "W1503AAA");
    t("W: check-in mein schedule (seq/dueDate/amount/paidAmount) + graceDays", Array.isArray(r.json?.schedule) && r.json.schedule.length === 3 && r.json.schedule[1]?.seq === 2 && r.json.schedule[1]?.paidAmount === 4000 && r.json.schedule[1]?.amount === 10000 && r.json?.graceDays === 5, r.json);
    // Pairing code regenerate -> check-in pairing_code_changed.
    await req(34577, "POST", "/api/device/sync", syncBody(1503, "W1503NEW", [inst(1, pktDate(30), 10000), inst(2, pktDate(60), 10000, 4000), inst(3, pktDate(90), 10000)]), syncH);
    r = await checkin(34577, dev1503, "W1503AAA");
    t("W: purani pairing code par check-in -> pairing_code_changed", r.json?.ok === false && r.json?.error === "pairing_code_changed", r.json);
    r = await checkin(34577, dev1503, "W1503NEW");
    t("W: nayi pairing code se check-in ok", r.json?.ok === true, r.json);
    r = await checkin(34577, dev1503);
    t("W: pairing code na bheji jaye to check-in ok (optional hai)", r.json?.ok === true, r.json);
    await stopServer(server); server = null;

    // ---- Server X: J2-m25 sync sequence + J2-m27 lock flap ----
    console.log("\n== X. J2-m25 sync sequence + J2-m27 lock flap ==");
    const dataY = join(dir, "y.json");
    server = await startServer({ port: 34578, dataFile: dataY, seedToken: SEED, syncToken: SYNC });
    // X1: single sync sequence.
    r = await req(34578, "POST", "/api/device/sync", syncBody(1601, "SQ1601AA", [inst(1, pktDate(30), 10000)], { syncSeq: 5 }), syncH);
    t("X1: sync seq 5 applied", r.json?.ok === true && r.json?.stale !== true, r.json);
    r = await req(34578, "POST", "/api/device/sync", syncBody(1601, "SQ1601AA", [inst(1, pktDate(30), 10000)], { syncSeq: 5, lockState: "locked", unlockCode: "SQ1601X" }), syncH);
    t("X1: J2-m25 same seq 5 -> stale (ignore)", r.json?.ok === true && r.json?.stale === true, r.json);
    r = await req(34578, "GET", "/api/device/status?dashboardAccountId=1601", undefined, syncH);
    t("X1: stale sync ne lockState nahi badla", r.json?.lockState === "unlocked", r.json);
    r = await req(34578, "POST", "/api/device/sync", syncBody(1601, "SQ1601AA", [inst(1, pktDate(30), 10000)], { syncSeq: 4, lockState: "locked", unlockCode: "SQ1601X" }), syncH);
    t("X1: J2-m25 older seq 4 -> stale", r.json?.ok === true && r.json?.stale === true, r.json);
    r = await req(34578, "POST", "/api/device/sync", syncBody(1601, "SQ1601AA", [inst(1, pktDate(30), 10000)], { syncSeq: 6, lockState: "locked", unlockCode: "SQ1601X" }), syncH);
    t("X1: newer seq 6 applied", r.json?.ok === true && r.json?.stale !== true, r.json);
    r = await req(34578, "GET", "/api/device/status?dashboardAccountId=1601", undefined, syncH);
    t("X1: seq 6 ke baad locked hai", r.json?.lockState === "locked", r.json);
    // X2: sync-all batch sequence (per-shop watermark).
    r = await req(34578, "POST", "/api/device/sync-all", { shopId: 5, syncSeq: 10, accounts: [syncBody(1602, "SQ1602AA", [inst(1, pktDate(30), 5000)], { shopId: 5 })] }, syncH);
    t("X2: sync-all batch seq 10 applied", r.json?.ok === true && r.json?.synced === 1, r.json);
    r = await req(34578, "POST", "/api/device/sync-all", { shopId: 5, syncSeq: 9, accounts: [syncBody(1602, "SQ1602AA", [inst(1, pktDate(30), 5000)], { shopId: 5, lockState: "locked", unlockCode: "SQ1602X" }), syncBody(1603, "SQ1603AA", [inst(1, pktDate(30), 5000)], { shopId: 5 })] }, syncH);
    t("X2: J2-m25 poora purana batch stale (synced 0)", r.json?.ok === true && r.json?.stale === true && r.json?.synced === 0, r.json);
    r = await req(34578, "GET", "/api/device/status?dashboardAccountId=1602", undefined, syncH);
    t("X2: stale batch ne 1602 nahi badla", r.json?.lockState === "unlocked", r.json);
    r = await req(34578, "GET", "/api/device/status?dashboardAccountId=1603", undefined, syncH);
    t("X2: stale batch ne 1603 nahi banaya", r.json?.ok === false && r.json?.error === "account_not_found", r.json);
    r = await req(34578, "POST", "/api/device/sync-all", { shopId: 5, syncSeq: 11, accounts: [syncBody(1602, "SQ1602AA", [inst(1, pktDate(30), 5000)], { shopId: 5, lockState: "locked", unlockCode: "SQ1602X" })] }, syncH);
    t("X2: newer batch seq 11 applied", r.json?.ok === true && r.json?.synced === 1, r.json);
    // X3: sync-all mein per-entry stale (aik entry skip, doosri apply).
    await req(34578, "POST", "/api/device/sync", syncBody(1604, "SQ1604AA", [inst(1, pktDate(30), 10000)], { shopId: 6, syncSeq: 7 }), syncH);
    r = await req(34578, "POST", "/api/device/sync-all", { shopId: 6, accounts: [syncBody(1604, "SQ1604AA", [inst(1, pktDate(30), 10000)], { shopId: 6, syncSeq: 6, lockState: "locked", unlockCode: "SQ1604X" }), syncBody(1605, "SQ1605AA", [inst(1, pktDate(30), 10000)], { shopId: 6 })] }, syncH);
    t("X3: sync-all per-entry stale -> synced 1, stale 1", r.json?.ok === true && r.json?.synced === 1 && r.json?.stale === 1, r.json);
    r = await req(34578, "GET", "/api/device/status?dashboardAccountId=1604", undefined, syncH);
    t("X3: stale entry ne 1604 nahi badla (aur delete bhi nahi hua)", r.json?.ok === true && r.json?.lockState === "unlocked", r.json);
    r = await req(34578, "GET", "/api/device/status?dashboardAccountId=1605", undefined, syncH);
    t("X3: taaza entry 1605 ban gayi", r.json?.ok === true, r.json);
    // X4: lock flap (J2-m27) — server-side auto-lock purani sync se wapas nahi hota.
    await req(34578, "POST", "/api/device/sync", syncBody(1606, "SQ1606AA", [inst(1, pktDate(-10), 10000)], { syncSeq: 5 }), syncH);
    r = await register(34578, "SQ1606AA");
    const dev1606 = r.json.deviceId;
    r = await checkin(34578, dev1606, "SQ1606AA");
    t("X4: check-in auto-lock (server-side)", r.json?.instruction === "lock_now", r.json);
    r = await req(34578, "POST", "/api/device/sync", syncBody(1606, "SQ1606AA", [inst(1, pktDate(-10), 10000)], { syncSeq: 5, lockState: "unlocked" }), syncH);
    t("X4: J2-m27 stale sync (seq 5) lock wapas nahi karti", r.json?.stale === true, r.json);
    r = await req(34578, "GET", "/api/device/status?dashboardAccountId=1606", undefined, syncH);
    t("X4: server-side lock qaim hai", r.json?.lockState === "locked", r.json);
    r = await req(34578, "POST", "/api/device/sync", syncBody(1606, "SQ1606AA", [inst(1, pktDate(-10), 10000)], { syncSeq: 6, lockState: "unlocked" }), syncH);
    t("X4: J2-m27 taaza sync (seq 6) explicit unlock jeet-ti hai", r.json?.ok === true && r.json?.stale !== true, r.json);
    r = await req(34578, "GET", "/api/device/status?dashboardAccountId=1606", undefined, syncH);
    t("X4: taaza sync ke baad unlocked hai", r.json?.lockState === "unlocked", r.json);
    await stopServer(server); server = null;

    // ---- Server Y: J2-m20 check-in rate limit + save-on-change ----
    console.log("\n== Y. J2-m20 check-in rate limit + save-on-change ==");
    const dataZ = join(dir, "z.json");
    server = await startServer({ port: 34579, dataFile: dataZ, seedToken: SEED, syncToken: SYNC });
    await req(34579, "POST", "/api/device/sync", syncBody(1701, "CI1701AA", [inst(1, pktDate(30), 10000)]), syncH);
    r = await register(34579, "CI1701AA");
    const dev1701 = r.json.deviceId;
    await new Promise((x) => setTimeout(x, 400)); // register ka save flush ho jaye
    const fileAfterRegister = JSON.parse(readFileSync(dataZ, "utf8"));
    const seenAfterRegister = fileAfterRegister.accounts.find((a) => a.dashboardAccountId === 1701)?.lastSeenAt;
    // Pehla check-in: lastSeenAt save hota hai (60s window mein pehla).
    await checkin(34579, dev1701, "CI1701AA");
    await new Promise((x) => setTimeout(x, 400));
    const fileAfterCi1 = JSON.parse(readFileSync(dataZ, "utf8"));
    const seenAfterCi1 = fileAfterCi1.accounts.find((a) => a.dashboardAccountId === 1701)?.lastSeenAt;
    t("Y: pehla check-in lastSeenAt save karta hai", typeof seenAfterCi1 === "string" && seenAfterCi1.length > 0 && seenAfterCi1 !== seenAfterRegister, { seenAfterRegister, seenAfterCi1 });
    // Doosra foran check-in (koi tabdeeli nahi) — file NAHI badalti.
    await checkin(34579, dev1701, "CI1701AA");
    await new Promise((x) => setTimeout(x, 400));
    const fileAfterCi2 = JSON.parse(readFileSync(dataZ, "utf8"));
    const seenAfterCi2 = fileAfterCi2.accounts.find((a) => a.dashboardAccountId === 1701)?.lastSeenAt;
    t("Y: J2-m20 tabdeeli ke baghair check-in file nahi likhta", seenAfterCi2 === seenAfterCi1, { seenAfterCi1, seenAfterCi2 });
    // Token tabdeeli wala check-in — save hota hai.
    await req(34579, "POST", "/api/device/checkin", { deviceId: dev1701, pairingCode: "CI1701AA", fcmToken: "tok-y2" });
    await new Promise((x) => setTimeout(x, 400));
    const fileAfterCi3 = JSON.parse(readFileSync(dataZ, "utf8"));
    t("Y: J2-m20 tabdeeli wala check-in save karta hai (token likha gaya)", fileAfterCi3.accounts.find((a) => a.dashboardAccountId === 1701)?.fcmToken === "tok-y2", fileAfterCi3.accounts.find((a) => a.dashboardAccountId === 1701));
    // Rate limit: 20/minute — ab tak 3 check-in ho chuke, 17 aur ok, phir 429.
    let okCount = 0;
    for (let i = 0; i < 17; i++) {
      r = await checkin(34579, dev1701, "CI1701AA");
      if (r.json?.ok === true) okCount += 1;
    }
    t("Y: J2-m20 20 check-in/minute tak sab ok", okCount === 17, okCount);
    r = await checkin(34579, dev1701, "CI1701AA");
    t("Y: J2-m20 21st check-in -> 429 too_many_attempts", r.status === 429 && r.json?.error === "too_many_attempts", r.json);
    await stopServer(server); server = null;

    // ---- Server Z: lockApp guard + status window expiry + dump redaction + warn boundary ----
    console.log("\n== Z. lockApp guard + status window + dump redaction + warn boundary ==");
    const dataZZ = join(dir, "zz.json");
    server = await startServer({ port: 34581, dataFile: dataZZ, seedToken: SEED, syncToken: SYNC });
    // lockApp guard (contract): TV/fridge par lock refuse hota hai.
    r = await req(34581, "POST", "/api/device/sync", syncBody(1801, "TV1801AA", [inst(1, pktDate(-10), 10000)], { lockApp: false, lockState: "locked", unlockCode: "TV1801X" }), syncH);
    t("Z: lockApp:false + locked -> 400 lock_not_allowed", r.status === 400 && r.json?.error === "lock_not_allowed", r.json);
    r = await req(34581, "POST", "/api/device/sync", syncBody(1801, "TV1801AA", [inst(1, pktDate(-10), 10000)], { lockApp: false, lockState: "warned" }), syncH);
    t("Z: lockApp:false + warned -> 400 lock_not_allowed", r.status === 400 && r.json?.error === "lock_not_allowed", r.json);
    r = await req(34581, "POST", "/api/device/sync", syncBody(1801, "TV1801AA", [inst(1, pktDate(-10), 10000)], { lockApp: false, lockState: "unlocked" }), syncH);
    t("Z: lockApp:false + unlocked ok", r.json?.ok === true, r.json);
    r = await register(34581, "TV1801AA");
    const dev1801 = r.json.deviceId;
    r = await checkin(34581, dev1801, "TV1801AA");
    t("Z: lockApp:false account grace guzre bhi auto-lock NAHI (stay_unlocked)", r.json?.instruction === "stay_unlocked", r.json);
    // sync-all mein lockApp wali kharab entry -> poora batch 400, kuch nahi badla.
    await req(34581, "POST", "/api/device/sync", syncBody(1802, "TV1802AA", [inst(1, pktDate(30), 10000)], { shopId: 7 }), syncH);
    r = await req(34581, "POST", "/api/device/sync-all", { shopId: 7, accounts: [syncBody(1802, "TV1802AA", [inst(1, pktDate(30), 10000)], { shopId: 7, lockState: "locked", unlockCode: "TV1802X" }), syncBody(1803, "TV1803AA", [inst(1, pktDate(30), 10000)], { shopId: 7, lockApp: false, lockState: "locked", unlockCode: "TV1803X" })] }, syncH);
    t("Z: sync-all mein lockApp entry -> 400 lock_not_allowed", r.status === 400 && r.json?.error === "lock_not_allowed", r.json);
    r = await req(34581, "GET", "/api/device/status?dashboardAccountId=1802", undefined, syncH);
    t("Z: failed sync-all ne 1802 nahi badla (atomic)", r.json?.lockState === "unlocked", r.json);
    // Status window expiry (J2-m23).
    await req(34581, "POST", "/api/device/sync", syncBody(1804, "SW1804AA", [inst(1, pktDate(-10), 10000)], { offlineUnlockUntil: "2020-01-01T00:00:00.000Z", offlineCodeUsed: true }), syncH);
    r = await req(34581, "GET", "/api/device/status?dashboardAccountId=1804", undefined, syncH);
    t("Z: J2-m23 status guzri hui window nahi dikhata", r.json?.offlineUnlockUntil === "", r.json);
    // Dump redaction (J2-m19).
    await req(34581, "POST", "/api/device/sync", syncBody(1805, "RD1805AA", [inst(1, pktDate(30), 10000)], { lockState: "locked", unlockCode: "RD1805X", resetPin: "1357" }), syncH);
    r = await req(34581, "POST", "/api/device/register", { pairingCode: "RD1805AA", imei: "android-id-xyz", model: "Pixel", androidVersion: "14", fcmToken: "fcm-secret-token" });
    r = await req(34581, "GET", "/api/test/accounts", undefined, seedH);
    const acct1805 = r.json?.accounts?.find((a) => a.dashboardAccountId === 1805);
    t("Z: J2-m19 dump mein codes/PINs/tokens masked", acct1805?.pairingCode === "***" && acct1805?.unlockCode === "***" && acct1805?.resetPin === "***" && acct1805?.deviceId === "***" && acct1805?.fcmToken === "***" && acct1805?.imei === "***", acct1805);
    t("Z: J2-m19 dump mein ghair-secret fields nazar aate hain", acct1805?.dashboardAccountId === 1805 && acct1805?.lockState === "locked" && acct1805?.shopName === "Al Arab Electronic", acct1805);
    // Warn boundary extra (J1-m53): future due par graceDaysLeft poora grace (36 nahi).
    await req(34581, "POST", "/api/device/sync", syncBody(1806, "WB1806AA", [inst(1, pktDate(30), 10000)]), syncH);
    r = await register(34581, "WB1806AA");
    r = await checkin(34581, r.json.deviceId, "WB1806AA");
    t("Z: J1-m53 future due -> stay_unlocked + graceDaysLeft=5", r.json?.instruction === "stay_unlocked" && r.json?.graceDaysLeft === 5, r.json);
    await stopServer(server); server = null;

    // ---- Server AA: J2-m36 check-in offlineCodeUsed + J2-m29 deviceOwnerLost ----
    console.log("\n== AA. J2-m36 check-in offlineCodeUsed + J2-m29 deviceOwnerLost ==");
    const dataAA = join(dir, "aa.json");
    server = await startServer({ port: 34582, dataFile: dataAA, seedToken: SEED, syncToken: SYNC });
    // J2-m36: code istemal se pehle false, istemal ke baad true, naye code cycle par phir false.
    await req(34582, "POST", "/api/device/sync", syncBody(1901, "AA1901AA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "AA1901X" }), syncH);
    r = await register(34582, "AA1901AA");
    const dev1901 = r.json.deviceId;
    r = await checkin(34582, dev1901, "AA1901AA");
    t("AA: J2-m36 lock_now se pehle offlineCodeUsed=false + code milta hai", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "AA1901X" && r.json?.offlineCodeUsed === false, r.json);
    r = await req(34582, "POST", "/api/device/offline-code-used", { deviceId: dev1901, code: "AA1901X" });
    t("AA: code istemal ok", r.json?.ok === true, r.json);
    r = await checkin(34582, dev1901, "AA1901AA");
    t("AA: J2-m36 code istemal ke baad check-in offlineCodeUsed=true (window)", r.json?.instruction === "stay_unlocked" && r.json?.offlineCodeUsed === true, r.json);
    // Naya code cycle: fresh code + locked, latch reset -> false.
    await req(34582, "POST", "/api/device/sync", syncBody(1901, "AA1901AA", [inst(1, pktDate(-10), 10000)], { lockState: "locked", unlockCode: "AA1901Y" }), syncH);
    r = await checkin(34582, dev1901, "AA1901AA");
    t("AA: J2-m36 naye code cycle par offlineCodeUsed=false + naya code milta hai", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "AA1901Y" && r.json?.offlineCodeUsed === false, r.json);
    // J2-m29: deviceOwnerLost check-in se store hota hai, status mein nazar aata hai.
    await req(34582, "POST", "/api/device/sync", syncBody(1902, "AA1902AA", [inst(1, pktDate(30), 10000)]), syncH);
    r = await register(34582, "AA1902AA");
    const dev1902 = r.json.deviceId;
    r = await req(34582, "GET", "/api/device/status?dashboardAccountId=1902", undefined, syncH);
    t("AA: J2-m29 shuru mein deviceOwnerLost=false", r.json?.deviceOwnerLost === false, r.json);
    r = await req(34582, "POST", "/api/device/checkin", { deviceId: dev1902, pairingCode: "AA1902AA", deviceOwnerLost: true });
    t("AA: J2-m29 deviceOwnerLost:true check-in ok", r.json?.ok === true, r.json);
    r = await req(34582, "GET", "/api/device/status?dashboardAccountId=1902", undefined, syncH);
    t("AA: J2-m29 status mein deviceOwnerLost=true", r.json?.deviceOwnerLost === true, r.json);
    // Flag ke baghair check-in pehli value nahi badalta.
    await checkin(34582, dev1902, "AA1902AA");
    r = await req(34582, "GET", "/api/device/status?dashboardAccountId=1902", undefined, syncH);
    t("AA: J2-m29 baghair flag check-in par value nahi badalti (true rehta hai)", r.json?.deviceOwnerLost === true, r.json);
    // Bahaali: false bhejne par wapas false.
    await req(34582, "POST", "/api/device/checkin", { deviceId: dev1902, pairingCode: "AA1902AA", deviceOwnerLost: false });
    r = await req(34582, "GET", "/api/device/status?dashboardAccountId=1902", undefined, syncH);
    t("AA: J2-m29 deviceOwnerLost:false par status wapas false", r.json?.deviceOwnerLost === false, r.json);
    // Ghalat qism (string) ignore hoti hai.
    await req(34582, "POST", "/api/device/checkin", { deviceId: dev1902, pairingCode: "AA1902AA", deviceOwnerLost: "yes" });
    r = await req(34582, "GET", "/api/device/status?dashboardAccountId=1902", undefined, syncH);
    t("AA: J2-m29 ghalat qism (string) ignore hoti hai", r.json?.deviceOwnerLost === false, r.json);
    // Sync is phone-side field ko nahi chhoota + restart ke baad bhi mehfooz hai.
    await req(34582, "POST", "/api/device/checkin", { deviceId: dev1902, pairingCode: "AA1902AA", deviceOwnerLost: true });
    await req(34582, "POST", "/api/device/sync", syncBody(1902, "AA1902AA", [inst(1, pktDate(30), 10000)]), syncH);
    r = await req(34582, "GET", "/api/device/status?dashboardAccountId=1902", undefined, syncH);
    t("AA: J2-m29 routine sync flag nahi mitaati (true rehta hai)", r.json?.deviceOwnerLost === true, r.json);
    await stopServer(server); server = null;
    server = await startServer({ port: 34582, dataFile: dataAA, seedToken: SEED, syncToken: SYNC });
    r = await req(34582, "GET", "/api/device/status?dashboardAccountId=1902", undefined, syncH);
    t("AA: J2-m29 restart ke baad bhi deviceOwnerLost=true (disk par mehfooz)", r.json?.deviceOwnerLost === true, r.json);
    await stopServer(server); server = null;
  } finally {
    await stopServer(server);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n========================================`);
  console.log(`RESULT: ${pass} pass, ${fail} fail (total ${pass + fail})`);
  if (failures.length) console.log("Failed:\n" + failures.map((f) => " - " + f).join("\n"));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("TEST RUNNER ERROR:", e); process.exit(2); });
