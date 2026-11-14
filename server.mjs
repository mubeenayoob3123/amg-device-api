// AMG Device API — unified device API v2 (unification, 15 Nov 2026)
// ============================================================
// Phone wali lock app (lock-app/app/.../ServerApi.kt) is server se
// EXACTLY ye 3 raaste mangti hai — in ka contract KABHI nahi badlega:
//   POST /api/device/register        { pairingCode, imei, model, androidVersion }
//   POST /api/device/checkin         { deviceId, pairingCode }
//   POST /api/device/offline-code-used { deviceId, code }
//
// Jawab bhi phone ki zubaan mein: instruction =
//   "stay_unlocked" | "warn" | "lock_now" | "permanent_unlock"
//
// Wave 3 (14 Nov 2026) — check-in ke jawab mein mazeed fields:
//   overdueAmount / overdueDueDate / overdueCount — sirf OVERDUE qist
//   ki raqam aur tareekh (F-21: lock screen "Rs 10,000 ki qist baqi hai"
//   dikhaye, poora balance nahi); nextDueDate / monthlyAmount — app ki
//   status screen ke liye; shopPhone — seed mein diya gaya shop ka number.
// Offline code istemal par 24 ghante ki unlock window (D-M6): is doran
// check-in stay_unlocked deta hai aur offlineUnlockUntil bhejta hai;
// window khatam hone par normal policy wapas (dobara lock, agar overdue).
// Purane fields sab waisay hi hain — purani app bhi chalti rahe gi.
//
// *** UNIFIED DESIGN (15 Nov 2026) — REPLICA, SOURCE OF TRUTH NAHI ***
// Dashboard ki app.db hi asal data hai (single source of truth). Ye
// server sirf us ka REPLICA rakhta hai taake phone is se baat kar sake
// (dashboard artifact ka koi public HTTP raasta nahi hai — phone seedha
// dashboard se baat NAHI kar sakta). Dashboard apne device state ko
// sync endpoints se yahan bhejta hai:
//   POST /api/device/sync            (aik account ka device state)
//   POST /api/device/sync-all        (AIK shop ke synced accounts, poora replace —
//                                    top-level shopId lazmi hai; doosri shop ko haath nahi lagta)
//   GET  /api/device/status          (dashboard ke liye live phone state)
// Teenon par x-amg-sync header mein AMG_SYNC_TOKEN lagta hai.
//   - Sync sirf dashboard-side fields badalta hai (qistein, lockState,
//     unlockCode, status...). Phone-side fields — deviceId,
//     deviceRegistered, deviceName, imei, lastSeenAt,
//     offlineUnlockUntil, offlineCodeUsed — sync se KABHI nahi badalte.
//   - Synced account ka offline unlock code sirf dashboard deta hai;
//     server synced accounts ke liye apna code KABHI nahi banata
//     (server code sirf /api/test/seed wale test accounts ke liye hai).
//   - sync-all hamesha AIK shop tak mehdood hai (top-level shopId se).
//     Khaali accounts list us shop ke replica accounts mita deti hai
//     (deleteShop ki safai ke liye). Doosri shops aur test accounts ko
//     haath nahi lagta.
//   - autoLock (dashboard ki lock-policy setting) sync hota hai: off ho
//     to check-in grace ke baad bhi AUTO-lock nahi lagata (warning phir
//     bhi lagti hai, dashboard policy jaisa); manual lock hamesha kaam
//     karta hai.
//   - data.json mit jaye (Render free restart) to haath se theek NAHI
//     karna — dashboard se sync-all dobara chalayein, replica khud
//     dobara ban jata hai. (Phone ko dobara register karna par sakta
//     hai, kyunke deviceId bhi data.json mein tha.)
// Test accounts (/api/test/seed) ab bhi alag se chalte hain — un ka
// dashboardAccountId null hota hai, sync-all un ko haath nahi lagata.
//
// Chalana (Node 18+, koi dependency nahi):
//   AMG_SEED_TOKEN=koi-mushkil-token AMG_SYNC_TOKEN=koi-aur-token node server.mjs
//   Port: PORT env ya 3000. Data: AMG_DATA_FILE env ya paas wali data.json.
//
// Free hosting par (Render, free tier) yaad rakhein:
//   - Free service 15 minute khamoshi ke baad so jata hai, jagane mein
//     ~1 minute lagta hai; phone ka check-in sirf 15 second intezar
//     karta hai, is liye test se pehle browser mein server ka link
//     khol kar jaga lein, phir 15 minute ke andar test karein.
//   - Free service ki file (data.json) redeploy/restart par mit sakti
//     hai — synced accounts sync-all se wapas aa jate hain, test-seed
//     accounts dobara banane parte hain.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.AMG_DATA_FILE || join(__dirname, "data.json");
const PORT = Number(process.env.PORT || 3000);
const SEED_TOKEN = process.env.AMG_SEED_TOKEN || "";
const SYNC_TOKEN = process.env.AMG_SYNC_TOKEN || "";

function load() {
  let data = null;
  if (existsSync(DATA_FILE)) {
    try {
      data = JSON.parse(readFileSync(DATA_FILE, "utf8"));
    } catch { /* corrupt file -> fresh */ }
  }
  if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.installments)) {
    data = { accounts: [], installments: [], nextAccountId: 1, nextInstallmentId: 1 };
  }
  // Purani data.json (v1) ke accounts mein naye fields nahi hote —
  // default laga dein taake purana data bhi chal jaye.
  for (const a of data.accounts) {
    if (a.dashboardAccountId === undefined) a.dashboardAccountId = null;
    if (a.offlineCodeUsed === undefined) a.offlineCodeUsed = 0;
    if (a.autoLock === undefined) a.autoLock = true;
  }
  if (!data.nextAccountId) data.nextAccountId = 1;
  if (!data.nextInstallmentId) data.nextInstallmentId = 1;
  return data;
}
let db = load();
function save() { writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
function genCode(n) {
  let s = "";
  const b = randomBytes(n);
  for (let i = 0; i < n; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
  return s;
}
// Pakistan time (Asia/Karachi): due/grace dates are calendar dates in PKT,
// so "today" must be the Karachi date, not the UTC date (S-M1 fix — UTC
// date was up to 5 hours behind, warnings/locks fired late).
const PKT_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit",
});
function todayStr(d = new Date()) {
  return PKT_DATE_FMT.format(d); // YYYY-MM-DD (Pakistan date)
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { // b - a in whole days
  return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
}
function nextUnpaid(acctId) {
  return db.installments
    .filter((i) => i.accountId === acctId && i.paidAmount < i.amount)
    .sort((a, b) => a.seq - b.seq)[0] || null;
}
function outstanding(acctId) {
  return db.installments
    .filter((i) => i.accountId === acctId)
    .reduce((s, i) => s + (i.amount - i.paidAmount), 0);
}
function overdueInfo(acctId, today) {
  // Wave 3.5 (F-21): lock screen ko poori baqi raqam nahi, sirf OVERDUE
  // qist ki raqam dikhani hai ("Rs 10,000 ki qist baqi hai") — is liye
  // overdue qiston ka hisaab alag se. Overdue = due date guzar chuki ho
  // aur qist poori ada na hui ho.
  const overdue = db.installments
    .filter((i) => i.accountId === acctId && i.paidAmount < i.amount && i.dueDate < today)
    .sort((a, b) => a.seq - b.seq);
  return {
    overdueAmount: overdue.reduce((s, i) => s + (i.amount - i.paidAmount), 0),
    overdueDueDate: overdue.length ? overdue[0].dueDate : "",
    overdueCount: overdue.length,
  };
}
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
// S-m1 fix: kharab JSON par 400 invalid_json — parser ki detail kabhi
// bahar nahi jati (neeche catch block mein 500 se bhi detail hata di hai).
class InvalidJsonError extends Error {
  constructor() { super("invalid_json"); this.code = "invalid_json"; }
}
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidJsonError();
  }
}
function needSeedToken(req, res) {
  if (!SEED_TOKEN) { send(res, 403, { ok: false, error: "seed_disabled" }); return false; }
  if (req.headers["x-amg-seed"] !== SEED_TOKEN) { send(res, 403, { ok: false, error: "bad_seed_token" }); return false; }
  return true;
}
// Sync auth: dashboard x-amg-sync header mein AMG_SYNC_TOKEN bhejta hai.
// Token Render mein set nahi hai to sync bilkul band hai (sync_disabled).
function needSyncToken(req, res) {
  if (!SYNC_TOKEN) { send(res, 403, { ok: false, error: "sync_disabled" }); return false; }
  if (req.headers["x-amg-sync"] !== SYNC_TOKEN) { send(res, 403, { ok: false, error: "bad_sync_token" }); return false; }
  return true;
}

// ---- Sync payload: jaanch + upsert (REPLICA rules) ----
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateStr(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
// Sync body ko jaanch kar saaf shakal mein lautaein; kharab ho to null.
// Lazmi: dashboardAccountId (number > 0), shopId (number > 0),
// installments (array).
// Baqi fields na hon to update mein purani qeemat rehti hai, naye
// account mein default lagta hai. Na diya gaya field kabhi ghalat
// nahi hota — sirf diya gaya ghalat field reject hota hai.
function validateSyncAccount(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const dashboardAccountId = Number(b.dashboardAccountId);
  if (!Number.isInteger(dashboardAccountId) || dashboardAccountId <= 0) return null;
  // shopId LAZMI hai — is ke baghair sync-all doosri shop ke accounts
  // se farq nahi kar sakta (OQ-1). Dashboard hamesha bhejta hai.
  const shopId = Number(b.shopId);
  if (!Number.isInteger(shopId) || shopId <= 0) return null;
  if (!Array.isArray(b.installments)) return null;
  const installments = [];
  const seenSeq = new Set();
  for (const inst of b.installments) {
    if (!inst || typeof inst !== "object") return null;
    const seq = Number(inst.seq);
    const amount = Number(inst.amount);
    const paidAmount = Number(inst.paidAmount);
    if (!Number.isInteger(seq) || seq < 1 || seenSeq.has(seq)) return null;
    seenSeq.add(seq);
    if (!isValidDateStr(inst.dueDate)) return null;
    if (!Number.isFinite(amount) || amount < 0) return null;
    if (!Number.isFinite(paidAmount) || paidAmount < 0 || paidAmount > amount) return null;
    installments.push({ seq, dueDate: inst.dueDate, amount, paidAmount });
  }
  if (b.status !== undefined && b.status !== "active" && b.status !== "completed") return null;
  if (b.lockState !== undefined && b.lockState !== "unlocked" && b.lockState !== "warned" && b.lockState !== "locked") return null;
  let graceDays;
  if (b.graceDays !== undefined) {
    graceDays = Number(b.graceDays);
    if (!Number.isInteger(graceDays) || graceDays < 0) return null;
  }
  let pairingCode;
  if (b.pairingCode !== undefined) {
    pairingCode = String(b.pairingCode).trim().toUpperCase();
    if (!pairingCode) return null;
  }
  let unlockCode;
  if (b.unlockCode !== undefined) {
    if (typeof b.unlockCode !== "string") return null;
    unlockCode = b.unlockCode.trim().toUpperCase();
  }
  let autoLock;
  if (b.autoLock !== undefined) {
    if (typeof b.autoLock !== "boolean") return null;
    autoLock = b.autoLock;
  }
  return {
    dashboardAccountId,
    shopId,
    shopName: b.shopName === undefined ? undefined : String(b.shopName),
    shopPhone: b.shopPhone === undefined ? undefined : String(b.shopPhone),
    customerName: b.customerName === undefined ? undefined : String(b.customerName),
    pairingCode, graceDays,
    status: b.status,
    lockState: b.lockState,
    unlockCode,
    autoLock,
    installments,
  };
}
// dashboardAccountId se upsert karein. Server ka apna numeric `id`
// alag rehta hai (nextAccountId se) — dashboard ki id se kabhi takrata
// nahi, aur /api/test/seed wali ids se bhi nahi.
// REPLICA RULE: update mein sirf dashboard-side fields badalte hain.
// Phone-side fields (deviceId, deviceRegistered, deviceName, imei,
// lastSeenAt, offlineUnlockUntil, offlineCodeUsed) sync se KABHI nahi
// badalte — wo sirf phone ki register/checkin/offline-code-used se
// badalte hain. Naye account ke liye pairingCode lazmi hai (warna
// phone is se register hi nahi ho sakta); na ho to null lautaein.
function upsertSyncedAccount(norm) {
  let acct = db.accounts.find((a) => a.dashboardAccountId === norm.dashboardAccountId);
  if (!acct) {
    if (!norm.pairingCode) return null;
    acct = {
      id: db.nextAccountId++,
      dashboardAccountId: norm.dashboardAccountId,
      shopId: norm.shopId,
      shopName: norm.shopName !== undefined ? norm.shopName : "",
      shopPhone: norm.shopPhone !== undefined ? norm.shopPhone : "",
      customerName: norm.customerName !== undefined ? norm.customerName : "",
      pairingCode: norm.pairingCode,
      graceDays: norm.graceDays !== undefined ? norm.graceDays : 5,
      status: norm.status !== undefined ? norm.status : "active",
      lockState: norm.lockState !== undefined ? norm.lockState : "unlocked",
      autoLock: norm.autoLock !== undefined ? norm.autoLock : true,
      unlockCode: norm.unlockCode !== undefined ? norm.unlockCode : "",
      offlineUnlockUntil: "",
      deviceId: null, deviceRegistered: 0, deviceName: "", imei: "", lastSeenAt: "",
      offlineCodeUsed: 0,
    };
    db.accounts.push(acct);
  } else {
    acct.shopId = norm.shopId;
    if (norm.shopName !== undefined) acct.shopName = norm.shopName;
    if (norm.shopPhone !== undefined) acct.shopPhone = norm.shopPhone;
    if (norm.customerName !== undefined) acct.customerName = norm.customerName;
    if (norm.pairingCode) acct.pairingCode = norm.pairingCode;
    if (norm.graceDays !== undefined) acct.graceDays = norm.graceDays;
    if (norm.status !== undefined) acct.status = norm.status;
    if (norm.lockState !== undefined) acct.lockState = norm.lockState;
    if (norm.autoLock !== undefined) acct.autoLock = norm.autoLock;
    if (norm.unlockCode !== undefined) acct.unlockCode = norm.unlockCode;
    // Phone-side fields yahan jaan boojh kar CHHUE NAHI jate (upar dekhein).
  }
  // Qistein hamesha poori tarah badal dein — dashboard ki allocation
  // (overpayment samet) hi sach hai, server ki koi doosri raaye nahi.
  db.installments = db.installments.filter((i) => i.accountId !== acct.id);
  for (const inst of norm.installments) {
    db.installments.push({ id: db.nextInstallmentId++, accountId: acct.id, seq: inst.seq, dueDate: inst.dueDate, amount: inst.amount, paidAmount: inst.paidAmount });
  }
  return acct;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return send(res, 200, {
        ok: true, service: "amg-device-api", version: "unified-1",
        accounts: db.accounts.length,
        syncedAccounts: db.accounts.filter((a) => a.dashboardAccountId != null).length,
      });
    }

    // ---- Phone wali app ke 3 raaste (ServerApi.kt ke mutabiq) ----
    // CONTRACT FREEZE: in ke request/response bilkul waisay hi hain
    // jaisay v1 mein thay — lock app mein koi tabdeeli nahi aayi.
    if (req.method === "POST" && url.pathname === "/api/device/register") {
      const b = await readJson(req);
      const code = String(b.pairingCode || "").trim().toUpperCase();
      const acct = db.accounts.find((a) => a.pairingCode.toUpperCase() === code);
      if (!acct) return send(res, 200, { ok: false, error: "invalid_pairing_code" });
      const deviceId = "dev_" + randomBytes(6).toString("hex");
      acct.deviceId = deviceId;
      acct.deviceRegistered = 1;
      acct.deviceName = String(b.model || "Android phone").slice(0, 80);
      acct.imei = String(b.imei || "");
      acct.lastSeenAt = new Date().toISOString();
      save();
      return send(res, 200, { ok: true, deviceId, accountId: acct.id, shopName: acct.shopName, shopPhone: acct.shopPhone });
    }

    if (req.method === "POST" && url.pathname === "/api/device/checkin") {
      const b = await readJson(req);
      // S-C1 fix: khaali/missing deviceId pehle hi reject karein — warna ye
      // pehle unregistered account (deviceId "") se match ho jata tha aur
      // us ka data (due date, balance, lock code) leak ho jata tha.
      const deviceId = String(b.deviceId || "").trim();
      if (!deviceId) return send(res, 200, { ok: false, error: "device_not_registered" });
      const acct = db.accounts.find((a) => a.deviceId === deviceId);
      if (!acct) return send(res, 200, { ok: false, error: "device_not_registered" });
      if (b.pairingCode && acct.pairingCode.toUpperCase() !== String(b.pairingCode).trim().toUpperCase()) {
        return send(res, 200, { ok: false, error: "invalid_pairing_code" });
      }
      // Synced account = dashboard ki replica. Is ka offline unlock code
      // sirf dashboard deta hai — server is ke liye apna code KABHI nahi
      // banata. Server code sirf /api/test/seed wale accounts ke liye hai.
      const isSynced = acct.dashboardAccountId != null;
      const today = todayStr();
      const next = nextUnpaid(acct.id);
      const remaining = outstanding(acct.id);
      const overdue = overdueInfo(acct.id, today);
      let instruction;
      let offlineUnlockCode = null;
      // D-M6 fix: offline code istemal ke baad 24 ghante ki unlock window —
      // is doran check-in stay_unlocked deta hai. Pehle agli hi check-in
      // (15 minute baad) dobara lock kar deti thi, code ka faida sirf
      // ~15 minute tha. Window khatam hone par normal policy wapas aati
      // hai — agar qist abhi bhi overdue hai to dobara lock ho jata hai.
      const windowActive = Boolean(acct.offlineUnlockUntil) && new Date(acct.offlineUnlockUntil) > new Date();
      if (acct.offlineUnlockUntil && !windowActive) acct.offlineUnlockUntil = ""; // guzri hui window saaf karein
      if (acct.status === "completed") {
        instruction = "permanent_unlock";
      } else if (windowActive) {
        instruction = "stay_unlocked";
      } else if (acct.lockState === "locked") {
        // Manual lock kabhi khud nahi khulta — sirf payment ya offline code se.
        instruction = "lock_now";
        if (!isSynced && !acct.unlockCode) acct.unlockCode = genCode(6);
        offlineUnlockCode = acct.unlockCode || null;
      } else if (next && today > addDays(next.dueDate, acct.graceDays) && acct.autoLock !== false) {
        // autoLock off ho (dashboard ki lock-policy setting) to grace ke
        // baad bhi AUTO-lock nahi — neeche warning branch chalegi.
        acct.lockState = "locked";
        if (!isSynced) acct.unlockCode = genCode(6);
        offlineUnlockCode = acct.unlockCode || null;
        instruction = "lock_now";
      } else if (next && today >= next.dueDate) {
        acct.lockState = "warned";
        instruction = "warn";
      } else {
        instruction = "stay_unlocked";
      }
      acct.lastSeenAt = new Date().toISOString();
      save();
      const graceDaysLeft = next ? Math.max(0, daysBetween(today, addDays(next.dueDate, acct.graceDays))) : 0;
      return send(res, 200, {
        ok: true, instruction,
        dueDate: next ? next.dueDate : "",
        remainingAmount: remaining,
        graceDaysLeft,
        shopName: acct.shopName, shopPhone: acct.shopPhone,
        // Wave 3.5 (F-21): per-installment overdue hisaab — lock screen
        // "Rs 10,000 ki qist baqi hai" dikhaye, poora balance nahi.
        overdueAmount: overdue.overdueAmount,
        overdueDueDate: overdue.overdueDueDate,
        overdueCount: overdue.overdueCount,
        nextDueDate: next ? next.dueDate : "",
        monthlyAmount: next ? next.amount : 0,
        ...(offlineUnlockCode ? { offlineUnlockCode } : {}),
        // D-M6: active 24h unlock window ki akhri tareekh (app dikha sakta hai).
        ...(windowActive ? { offlineUnlockUntil: acct.offlineUnlockUntil } : {}),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/device/offline-code-used") {
      const b = await readJson(req);
      // S-C1 fix: khaali/missing deviceId pehle hi reject karein (checkin jaisa).
      const deviceId = String(b.deviceId || "").trim();
      if (!deviceId) return send(res, 200, { ok: false, error: "device_not_registered" });
      const acct = db.accounts.find((a) => a.deviceId === deviceId);
      if (!acct) return send(res, 200, { ok: false, error: "device_not_registered" });
      if (acct.lockState !== "locked" || !acct.unlockCode ||
          String(b.code || "").trim().toUpperCase() !== acct.unlockCode.toUpperCase()) {
        return send(res, 200, { ok: false, error: "invalid_unlock_code" });
      }
      acct.lockState = "unlocked";
      acct.unlockCode = "";
      // Code istemal ho gaya — dashboard /api/device/status se ye flag
      // dekh sakta hai. Ye flag sync se kabhi nahi badalta (latch hai).
      acct.offlineCodeUsed = 1;
      // D-M6 fix: code istemal par 24 ghante ki unlock window shuru hoti
      // hai — is doran check-in stay_unlocked deta hai (upar dekhein).
      acct.offlineUnlockUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      save();
      return send(res, 200, { ok: true, offlineUnlockUntil: acct.offlineUnlockUntil });
    }

    // ---- Dashboard sync ke 3 raaste (unified v2, sync token zaroori) ----
    // Ye REPLICA feed karte hain — app.db source of truth hai, ye server
    // sirf phone ke liye us ki naqal rakhta hai. Wipe ho jaye to sync-all
    // se dobara banayein, haath se data.json edit NAHI karna.
    if (req.method === "POST" && url.pathname === "/api/device/sync") {
      if (!needSyncToken(req, res)) return;
      const b = await readJson(req);
      const norm = validateSyncAccount(b);
      if (!norm) return send(res, 400, { ok: false, error: "invalid_sync_payload" });
      const acct = upsertSyncedAccount(norm);
      if (!acct) return send(res, 400, { ok: false, error: "invalid_sync_payload" }); // naya account, pairing code nahi
      save();
      return send(res, 200, { ok: true, accountId: acct.id, dashboardAccountId: acct.dashboardAccountId });
    }

    if (req.method === "POST" && url.pathname === "/api/device/sync-all") {
      if (!needSyncToken(req, res)) return;
      const b = await readJson(req);
      if (!b || typeof b !== "object" || !Array.isArray(b.accounts)) {
        return send(res, 400, { ok: false, error: "invalid_sync_payload" });
      }
      // OQ-1 fix: sync-all hamesha AIK shop tak mehdood hai. Top-level
      // shopId lazmi hai — is ke baghair aik shop ki sync-all doosri
      // shop ke replica accounts mita deti. Khaali accounts list us
      // shop ke replica accounts ki safai hai (deleteShop ke liye).
      const shopId = Number(b.shopId);
      if (!Number.isInteger(shopId) || shopId <= 0) {
        return send(res, 400, { ok: false, error: "invalid_sync_payload" });
      }
      // Pehle SAB ko jaanch lein — aik bhi kharab ho to kuch nahi badlega
      // (atomic: aadha sync kabhi nahi hota).
      const normed = [];
      const seenIds = new Set();
      for (const item of b.accounts) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return send(res, 400, { ok: false, error: "invalid_sync_payload" });
        }
        // Entry ka shopId top-level se mukhtalif ho to reject — ghalat
        // shop ka data ghalat replace mein na jaye.
        if (item.shopId !== undefined && Number(item.shopId) !== shopId) {
          return send(res, 400, { ok: false, error: "invalid_sync_payload" });
        }
        const norm = validateSyncAccount({ ...item, shopId });
        if (!norm || seenIds.has(norm.dashboardAccountId)) {
          return send(res, 400, { ok: false, error: "invalid_sync_payload" });
        }
        seenIds.add(norm.dashboardAccountId);
        normed.push(norm);
      }
      // Full replace — SIRF IS SHOP ke synced accounts ka. Doosri shops
      // ke synced accounts aur test-seed accounts ko haath nahi lagta.
      const removedIds = db.accounts
        .filter((a) => a.dashboardAccountId != null && a.shopId === shopId && !seenIds.has(a.dashboardAccountId))
        .map((a) => a.id);
      db.accounts = db.accounts.filter((a) => !(a.dashboardAccountId != null && a.shopId === shopId && !seenIds.has(a.dashboardAccountId)));
      db.installments = db.installments.filter((i) => !removedIds.includes(i.accountId));
      for (const norm of normed) {
        // upsert update path mein phone-side fields khud bacha leta hai.
        if (!upsertSyncedAccount(norm)) {
          return send(res, 400, { ok: false, error: "invalid_sync_payload" });
        }
      }
      save();
      return send(res, 200, { ok: true, synced: normed.length });
    }

    if (req.method === "GET" && url.pathname === "/api/device/status") {
      if (!needSyncToken(req, res)) return;
      const d = Number(url.searchParams.get("dashboardAccountId"));
      const acct = db.accounts.find((a) => a.dashboardAccountId === d);
      if (!acct) return send(res, 200, { ok: false, error: "account_not_found" });
      // Live phone-side state — dashboard Device Lock tab ye dikhaye,
      // apni androoni state ko phone ki state samajh kar nahi.
      return send(res, 200, {
        ok: true,
        dashboardAccountId: acct.dashboardAccountId,
        deviceRegistered: acct.deviceRegistered === 1,
        deviceName: acct.deviceName || "",
        lastSeenAt: acct.lastSeenAt || "",
        lockState: acct.lockState,
        status: acct.status,
        offlineCodeUsed: acct.offlineCodeUsed === 1,
        offlineUnlockUntil: acct.offlineUnlockUntil || "",
      });
    }

    // ---- Sirf TEST ke liye (seed token zaroori) ----
    // Bilkul waisay hi jaisa v1 mein tha. In accounts ka
    // dashboardAccountId null hota hai — sync-all in ko nahi chhoota.
    if (req.method === "POST" && url.pathname === "/api/test/seed") {
      if (!needSeedToken(req, res)) return;
      const b = await readJson(req);
      const total = Number(b.total) || 0;
      const months = Number(b.months) || 1;
      const graceDays = Number(b.graceDays) || 5;
      const firstDue = String(b.firstDueDate || todayStr());
      if (!total || months < 1) return send(res, 400, { ok: false, error: "total_and_months_required" });
      const perMonth = Math.floor(total / months);
      const acct = {
        id: db.nextAccountId++, dashboardAccountId: null,
        shopName: String(b.shopName || "Al Arab Electronic"),
        shopPhone: String(b.shopPhone || ""), customerName: String(b.customerName || "Test Customer"),
        pairingCode: genCode(8), graceDays, status: "active", lockState: "unlocked",
        autoLock: true,
        unlockCode: "", offlineUnlockUntil: "", offlineCodeUsed: 0,
        deviceId: null, deviceRegistered: 0, deviceName: "", imei: "", lastSeenAt: "",
      };
      db.accounts.push(acct);
      for (let i = 0; i < months; i++) {
        const amt = i === months - 1 ? total - perMonth * (months - 1) : perMonth;
        db.installments.push({ id: db.nextInstallmentId++, accountId: acct.id, seq: i + 1, dueDate: addMonths(firstDue, i), amount: amt, paidAmount: 0 });
      }
      save();
      return send(res, 200, { ok: true, accountId: acct.id, pairingCode: acct.pairingCode, total, months, graceDays, firstDueDate: firstDue });
    }

    if (req.method === "POST" && url.pathname === "/api/test/pay") {
      if (!needSeedToken(req, res)) return;
      const b = await readJson(req);
      const acct = db.accounts.find((a) => a.id === Number(b.accountId));
      if (!acct) return send(res, 200, { ok: false, error: "account_not_found" });
      let left = Number(b.amount) || 0;
      for (const inst of db.installments.filter((i) => i.accountId === acct.id).sort((x, y) => x.seq - y.seq)) {
        if (left <= 0) break;
        const due = inst.amount - inst.paidAmount;
        const pay = Math.min(due, left);
        inst.paidAmount += pay; left -= pay;
      }
      if (outstanding(acct.id) === 0) { acct.status = "completed"; acct.lockState = "unlocked"; acct.unlockCode = ""; }
      else if (acct.lockState === "locked") {
        const next = nextUnpaid(acct.id);
        if (next && todayStr() <= addDays(next.dueDate, acct.graceDays)) { acct.lockState = "unlocked"; acct.unlockCode = ""; }
      }
      save();
      return send(res, 200, { ok: true, accountId: acct.id, status: acct.status, lockState: acct.lockState, outstanding: outstanding(acct.id) });
    }

    if (req.method === "GET" && url.pathname === "/api/test/accounts") {
      if (!needSeedToken(req, res)) return;
      return send(res, 200, { ok: true, accounts: db.accounts, installments: db.installments });
    }

    return send(res, 404, { ok: false, error: "not_found" });
  } catch (e) {
    // S-m1: kharab JSON par 400 (upar InvalidJsonError dekhein).
    if (e && e.code === "invalid_json") return send(res, 400, { ok: false, error: "invalid_json" });
    console.error("server_error", e);
    // 500 mein kabhi detail nahi — andar ki ghalti bahar nahi jati.
    return send(res, 500, { ok: false, error: "server_error" });
  }
});

server.listen(PORT, () => {
  console.log(`AMG device API unified-1 — http://localhost:${PORT} (seed ${SEED_TOKEN ? "enabled" : "DISABLED: set AMG_SEED_TOKEN"}, sync ${SYNC_TOKEN ? "enabled" : "DISABLED: set AMG_SYNC_TOKEN"})`);
});
