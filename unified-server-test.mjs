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
    t("health version unified-1 + counts", r.json?.version === "unified-1" && r.json?.accounts === 0 && r.json?.syncedAccounts === 0, r.json);
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
    t("due kal, grace baqi -> warn + graceDaysLeft=4", r.json?.instruction === "warn" && r.json?.graceDaysLeft === 4, r.json);
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
    r = await req(34562, "POST", "/api/device/sync-all", { accounts: [syncBody(201, "UNIF201A", [inst(1, pktDate(30), 5000)]), { pairingCode: "BAD", installments: [] }] }, syncH);
    t("sync-all aik kharab entry -> 400 (atomic)", r.status === 400 && r.json?.error === "invalid_sync_payload", r.json);
    r = await req(34562, "GET", "/api/device/status?dashboardAccountId=101", undefined, syncH);
    t("failed sync-all ke baad purana data waisa hi", r.json?.ok === true && r.json?.deviceRegistered === true, r.json);
    r = await req(34562, "POST", "/api/device/sync-all", { accounts: [syncBody(201, "UNIF201A", [inst(1, pktDate(30), 5000)]), syncBody(201, "UNIF201A", [inst(1, pktDate(30), 5000)])] }, syncH);
    t("sync-all duplicate dashboardAccountId -> 400", r.status === 400 && r.json?.error === "invalid_sync_payload", r.json);
    r = await req(34562, "POST", "/api/device/sync-all", { accounts: [syncBody(201, "UNIF201A", [inst(1, pktDate(30), 5000), inst(2, addMonthsStr(pktDate(30), 1), 5000)]), syncBody(202, "UNIF202B", [inst(1, pktDate(30), 7000)])] }, syncH);
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
    r = await req(34562, "POST", "/api/device/sync-all", { accounts: [syncBody(201, "UNIF201A", [inst(1, pktDate(30), 5000, 1000), inst(2, addMonthsStr(pktDate(30), 1), 5000)]), syncBody(202, "UNIF202B", [inst(1, pktDate(30), 7000)])] }, syncH);
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
    r = await req(34563, "POST", "/api/device/sync-all", { accounts: [syncBody(201, "UNIF201A", [inst(1, pktDate(30), 5000, 1000), inst(2, addMonthsStr(pktDate(30), 1), 5000)]), syncBody(202, "UNIF202B", [inst(1, pktDate(30), 7000)])] }, syncH);
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
