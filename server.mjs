// AMG Device API — live-server bridge (test version)
// ============================================================
// Phone wali lock app (lock-app/app/.../ServerApi.kt) is server se
// EXACTLY ye 3 raaste mangti hai:
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
// AHEM NOTE: Dashboard (Hatch artifact, ts-spaces/amg-dashboard) ke
// andar ye kaam actions ke tor par hai (registerDevice / deviceCheckin),
// lekin un ki shakal phone wali se mukhtalif hai:
//   - registerDevice ko accountId chahiye hota hai, phone ke paas sirf
//     pairing code hota hai, aur jawab mein sirf { ok: true } milta hai
//     (deviceId / accountId nahi).
//   - deviceCheckin "show_warning" deta hai, phone "warn" samajhta hai.
//   - In actions ka koi public HTTP /api/device/* raasta nahi hai.
// Is liye phone seedha dashboard se baat NAHI kar sakta — is bridge ki
// zaroorat hai. Ye bridge TEST ke liye hai: is ka apna chhota data hai
// (data.json), dashboard ka data is mein NAHI aata. Test account
// /api/test/seed se banta hai. Asal (production) version mein dashboard
// aur ye API ek hi database se chalenge — wo agla marhala hai.
//
// Chalana (Node 18+, koi dependency nahi):
//   AMG_SEED_TOKEN=koi-mushkil-token node server.mjs
//   Port: PORT env ya 3000. Data: paas wali data.json file.
//
// Free hosting par (Render, free tier) yaad rakhein:
//   - Free service 15 minute khamoshi ke baad so jata hai, jagane mein
//     ~1 minute lagta hai; phone ka check-in sirf 15 second intezar
//     karta hai, is liye test se pehle browser mein server ka link
//     khol kar jaga lein, phir 15 minute ke andar test karein.
//   - Free service ki file (data.json) redeploy/restart par mit sakti
//     hai — ye sirf TEST ke liye hai, asal customers ka data is par
//     kabhi na rakhein. Free Postgres 30 din mein khatam ho jata hai.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "data.json");
const PORT = Number(process.env.PORT || 3000);
const SEED_TOKEN = process.env.AMG_SEED_TOKEN || "";

function load() {
  if (existsSync(DATA_FILE)) {
    try {
      return JSON.parse(readFileSync(DATA_FILE, "utf8"));
    } catch { /* corrupt file -> fresh */ }
  }
  return { accounts: [], installments: [], nextAccountId: 1, nextInstallmentId: 1 };
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
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}
function needSeedToken(req, res) {
  if (!SEED_TOKEN) { send(res, 403, { ok: false, error: "seed_disabled" }); return false; }
  if (req.headers["x-amg-seed"] !== SEED_TOKEN) { send(res, 403, { ok: false, error: "bad_seed_token" }); return false; }
  return true;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return send(res, 200, { ok: true, service: "amg-device-api", version: "test-1", accounts: db.accounts.length });
    }

    // ---- Phone wali app ke 3 raaste (ServerApi.kt ke mutabiq) ----
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
        if (!acct.unlockCode) acct.unlockCode = genCode(6);
        offlineUnlockCode = acct.unlockCode;
      } else if (next && today > addDays(next.dueDate, acct.graceDays)) {
        acct.lockState = "locked";
        acct.unlockCode = genCode(6);
        offlineUnlockCode = acct.unlockCode;
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
      // D-M6 fix: code istemal par 24 ghante ki unlock window shuru hoti
      // hai — is doran check-in stay_unlocked deta hai (upar dekhein).
      acct.offlineUnlockUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      save();
      return send(res, 200, { ok: true, offlineUnlockUntil: acct.offlineUnlockUntil });
    }

    // ---- Sirf TEST ke liye (seed token zaroori) ----
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
        id: db.nextAccountId++, shopName: String(b.shopName || "Al Arab Electronic"),
        shopPhone: String(b.shopPhone || ""), customerName: String(b.customerName || "Test Customer"),
        pairingCode: genCode(8), graceDays, status: "active", lockState: "unlocked",
        unlockCode: "", offlineUnlockUntil: "", deviceId: null, deviceRegistered: 0, deviceName: "", imei: "", lastSeenAt: "",
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
    return send(res, 500, { ok: false, error: "server_error", detail: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`AMG device API test server — http://localhost:${PORT} (seed ${SEED_TOKEN ? "enabled" : "DISABLED: set AMG_SEED_TOKEN"})`);
});
