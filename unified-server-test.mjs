// AMG unified device API v2 — local test battery (plain node, no deps)
// Chalana:  node unified-server-test.mjs
// Ye test server ko scratch port + temp data file ke saath chalata hai,
// live Render server ko haath nahi lagata. Exit code 0 = sab pass.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

async function startServer({ port, dataFile, seedToken, syncToken }) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env, PORT: String(port), AMG_DATA_FILE: dataFile,
      AMG_SEED_TOKEN: seedToken || "", AMG_SYNC_TOKEN: syncToken || "",
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
    t("health version unified-2 + counts", r.json?.version === "unified-2" && r.json?.accounts === 0 && r.json?.syncedAccounts === 0, r.json);
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
    r = await req(34562, "GET", "/health");
    t("health syncedAccounts=1", r.json?.syncedAccounts === 1 && r.json?.accounts === 1, r.json);
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
    t("imei + deviceId sync se nahi mitay", acct101?.imei === "123456789012345" && acct101?.deviceId === dev101 && acct101?.customerName === "Test 101 Updated", acct101);

    console.log("\n== D. S-C1 + S-M1 regressions ==");
    r = await checkin(34562, "", "UNIF101A");
    t("S-C1: khaali deviceId checkin -> device_not_registered", r.json?.ok === false && r.json?.error === "device_not_registered", r.json);
    r = await req(34562, "POST", "/api/device/offline-code-used", { deviceId: "", code: "XXXXXX" });
    t("S-C1: khaali deviceId offline-code-used -> device_not_registered", r.json?.ok === false && r.json?.error === "device_not_registered", r.json);
    await req(34562, "POST", "/api/device/sync", syncBody(106, "UNIF106F", [inst(1, pktDate(0), 10000)]), syncH);
    r = await register(34562, "UNIF106F");
    r = await checkin(34562, r.json.deviceId, "UNIF106F");
    t("S-M1: due aaj (PKT) -> warn", r.json?.instruction === "warn", r.json);
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
    r = await req(34562, "GET", "/health");
    t("health: seed syncedAccounts mein nahi gina jata", r.json?.accounts === r.json?.syncedAccounts + 1, r.json);
    r = await req(34562, "GET", "/api/test/accounts", undefined, seedH);
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
    unlinkSync(dataB);
    server = await startServer({ port: 34563, dataFile: dataB, seedToken: SEED, syncToken: SYNC });
    r = await req(34563, "GET", "/health");
    t("wipe ke baad accounts=0", r.json?.accounts === 0 && r.json?.syncedAccounts === 0, r.json);
    r = await req(34563, "POST", "/api/device/sync-all", { shopId: 1, accounts: [syncBody(201, "UNIF201A", [inst(1, pktDate(30), 5000, 1000), inst(2, addMonthsStr(pktDate(30), 1), 5000)]), syncBody(202, "UNIF202B", [inst(1, pktDate(30), 7000)])] }, syncH);
    t("wipe ke baad sync-all restore karta hai", r.json?.ok === true && r.json?.synced === 2, r.json);
    r = await checkin(34563, dev201, "UNIF201A");
    t("wipe ke baad PURANA deviceId nahi chalta (registration data.json mein thi)", r.json?.ok === false && r.json?.error === "device_not_registered", r.json);
    r = await register(34563, "UNIF201A");
    t("wipe ke baad dobara register hota hai", r.json?.ok === true && typeof r.json?.deviceId === "string", r.json);
    r = await checkin(34563, r.json.deviceId, "UNIF201A");
    t("re-register ke baad checkin stay_unlocked (paidAmount bhi restore hua)", r.json?.ok === true && r.json?.instruction === "stay_unlocked" && r.json?.remainingAmount === 9000, r.json);
    r = await req(34563, "GET", "/health");
    t("wipe ke baad seed account wapas nahi aata (sirf synced restore hote hain)", r.json?.accounts === 2 && r.json?.syncedAccounts === 2, r.json);
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
    t("L2: fresh code wins over explicit latch restore", r.json?.offlineCodeUsed === false && r.json?.offlineUnlockUntil === "", r.json);
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
    server = await startServer({ port: 34566, dataFile: dataF, seedToken: SEED, syncToken: SYNC });
    r = await req(34566, "GET", "/health");
    t("M: wipe ke baad accounts=0", r.json?.accounts === 0, r.json);
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

    // ---- Server I: PU-S10 rate limiting + salted hash ----
    console.log("\n== P. PU-S10 rate limiting + salted hash ==");
    const dataI = join(dir, "i.json");
    server = await startServer({ port: 34569, dataFile: dataI, seedToken: SEED, syncToken: SYNC });
    // Register: 10 ghalat koshishen ek IP se -> 11th 429.
    const badIp = { "x-forwarded-for": "203.0.113.1" };
    let lastErr = "";
    for (let i = 0; i < 10; i++) {
      r = await req(34569, "POST", "/api/device/register", { pairingCode: "NOKHUCH1", imei: "", model: "X", androidVersion: "14" }, badIp);
      lastErr = r.json?.error;
    }
    t("P: 10 ghalat register -> invalid_pairing_code (rok nahi)", lastErr === "invalid_pairing_code", lastErr);
    r = await req(34569, "POST", "/api/device/register", { pairingCode: "NOKHUCH1", imei: "", model: "X", androidVersion: "14" }, badIp);
    t("P: PU-S10 11th koshish -> 429 too_many_attempts", r.status === 429 && r.json?.error === "too_many_attempts" && typeof r.json?.message === "string", r.json);
    // Doosri IP rok mein nahi hai.
    r = await req(34569, "POST", "/api/device/register", { pairingCode: "NOKHUCH1", imei: "", model: "X", androidVersion: "14" }, { "x-forwarded-for": "203.0.113.2" });
    t("P: doosri IP par rok nahi (per-IP)", r.status === 200 && r.json?.error === "invalid_pairing_code", r.json);
    // Sahi code bhi blocked IP se nahi chalta.
    await req(34569, "POST", "/api/device/sync", syncBody(701, "RL701AAA", [inst(1, pktDate(30), 10000)], { lockState: "locked", unlockCode: "RL701A" }), syncH);
    r = await req(34569, "POST", "/api/device/register", { pairingCode: "RL701AAA", imei: "1", model: "X", androidVersion: "14" }, badIp);
    t("P: blocked IP se sahi code bhi 429", r.status === 429 && r.json?.error === "too_many_attempts", r.json);
    r = await register(34569, "RL701AAA");
    const dev701 = r.json.deviceId;
    t("P: doosri IP (default) se register ok", r.json?.ok === true, r.json);
    // Restart ke baad bhi rok qaim (data.json mein mehfooz).
    await stopServer(server);
    server = await startServer({ port: 34569, dataFile: dataI, seedToken: SEED, syncToken: SYNC });
    r = await req(34569, "POST", "/api/device/register", { pairingCode: "NOKHUCH1", imei: "", model: "X", androidVersion: "14" }, badIp);
    t("P: restart ke baad bhi 429 (rate limit data.json mein)", r.status === 429 && r.json?.error === "too_many_attempts", r.json);
    // offline-code-used: 10 ghalat code ek device se -> 11th 429.
    const ocuIp = { "x-forwarded-for": "203.0.113.10" };
    r = await checkin(34569, dev701, "RL701AAA");
    t("P: locked account checkin -> lock_now + code", r.json?.instruction === "lock_now" && r.json?.offlineUnlockCode === "RL701A", r.json);
    for (let i = 0; i < 10; i++) {
      r = await req(34569, "POST", "/api/device/offline-code-used", { deviceId: dev701, code: "WRONG1" }, ocuIp);
      lastErr = r.json?.error;
    }
    t("P: 10 ghalat code -> invalid_unlock_code", lastErr === "invalid_unlock_code", lastErr);
    r = await req(34569, "POST", "/api/device/offline-code-used", { deviceId: dev701, code: "RL701A" }, ocuIp);
    t("P: PU-S10 11th code koshish -> 429 (sahi code bhi blocked)", r.status === 429 && r.json?.error === "too_many_attempts", r.json);
    // Doosra device (doosri IP) rok mein nahi hai.
    await req(34569, "POST", "/api/device/sync", syncBody(702, "RL702AAA", [inst(1, pktDate(30), 10000)], { lockState: "locked", unlockCode: "RL702A" }), syncH);
    r = await register(34569, "RL702AAA");
    const dev702 = r.json.deviceId;
    r = await req(34569, "POST", "/api/device/offline-code-used", { deviceId: dev702, code: "WRONG1" }, { "x-forwarded-for": "203.0.113.11" });
    t("P: doosra device rok mein nahi (per-device)", r.status === 200 && r.json?.error === "invalid_unlock_code", r.json);
    // Kamyab code counter saaf kar deta hai: 9 ghalat -> sahi -> 9 ghalat (rok nahi).
    await req(34569, "POST", "/api/device/sync", syncBody(703, "RL703AAA", [inst(1, pktDate(30), 10000)], { lockState: "locked", unlockCode: "RL703A" }), syncH);
    r = await register(34569, "RL703AAA");
    const dev703 = r.json.deviceId;
    const clrIp = { "x-forwarded-for": "203.0.113.12" };
    for (let i = 0; i < 9; i++) await req(34569, "POST", "/api/device/offline-code-used", { deviceId: dev703, code: "WRONG1" }, clrIp);
    r = await req(34569, "POST", "/api/device/offline-code-used", { deviceId: dev703, code: "RL703A" }, clrIp);
    t("P: 9 ghalat ke baad sahi code chalta hai", r.json?.ok === true, r.json);
    // Dobara lock karein (naya code) taake 9 ghalat dobara try ho sakein.
    await req(34569, "POST", "/api/device/sync", syncBody(703, "RL703AAA", [inst(1, pktDate(30), 10000)], { lockState: "locked", unlockCode: "RL703B" }), syncH);
    let blocked = false;
    for (let i = 0; i < 9; i++) {
      r = await req(34569, "POST", "/api/device/offline-code-used", { deviceId: dev703, code: "WRONG1" }, clrIp);
      if (r.status === 429) blocked = true;
    }
    t("P: kamyabi ke baad counter saaf — 9 ghalat dobara rok nahi", blocked === false, blocked);
    // Salted hash: seed account ka code sirf pehli lock_now mein milta hai.
    r = await req(34569, "POST", "/api/test/seed", { total: 10000, months: 1, graceDays: 5, firstDueDate: pktDate(-10) }, seedH);
    const seedCode2 = r.json.pairingCode;
    const seedId2 = r.json.accountId;
    r = await register(34569, seedCode2);
    const devSeed2 = r.json.deviceId;
    r = await checkin(34569, devSeed2, seedCode2);
    const firstCode = r.json?.offlineUnlockCode;
    t("P: seed pehli lock_now WITH server code", r.json?.instruction === "lock_now" && typeof firstCode === "string" && /^[A-Z2-9]{6}$/.test(firstCode), r.json);
    r = await checkin(34569, devSeed2, seedCode2);
    t("P: PU-S10 seed doosri lock_now code ke BAGHAIR (phone ke paas hash hai)", r.json?.instruction === "lock_now" && !("offlineUnlockCode" in (r.json || {})), r.json);
    r = await req(34569, "GET", "/api/test/accounts", undefined, seedH);
    const seedAcct2 = r.json?.accounts?.find((a) => a.id === seedId2);
    t("P: seed code data mein salted hash hai, plaintext nahi", typeof seedAcct2?.unlockCodeHash === "string" && seedAcct2.unlockCodeHash.includes(":") && seedAcct2.unlockCode === "", seedAcct2);
    r = await req(34569, "POST", "/api/device/offline-code-used", { deviceId: devSeed2, code: firstCode });
    t("P: seed code hash se verify ho kar chalta hai", r.json?.ok === true && typeof r.json?.offlineUnlockUntil === "string", r.json);
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
