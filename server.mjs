// AMG Device API — unified device API v2.1 + FCM push (Wave 5.4, 15 Nov 2026)
// Health version: "unified-4.1" (Audit Round 2 fixes + lock-app v1.4.0
// coordination: J2-m36/J2-m29, 15 Nov 2026).
// v2.1 sync contract BILKUL waisa hi hai — siwaaye neeche wali
// unified-4 tabdeeliyon ke (J1-C03/J1-M23/J2-m25/J2-M13 + contract
// additions; purani dashboard bhi chalti rehti hai, naye fields
// sab optional hain):
//   - J1-C03: sync mein saaf restore (offlineCodeUsed /
//     offlineUnlockUntil) aaye to new-code rule NAHI chalta —
//     restore jeet-ti hai; code istemal par server code ko "" nahi
//     karta (latch hi dobara istemal rokta hai).
//   - J1-M23: sync-all ab waqai atomic hai — pehle sab validate,
//     phir aik naqal (clone) par apply, phir swap + aik save. Koi
//     ghalti ho to live state ko haath nahi lagta.
//   - J2-m25: sync mein optional syncSeq (per-account, monotonic)
//     — purani sync ignore hoti hai (stale); sync-all mein
//     top-level syncSeq (per-shop watermark) bhi hai.
//   - J2-M13: LOCK transition par bhi push jata hai (pehle sirf
//     unlock/completed par jata tha).
//   - Contract: check-in mein schedule + graceDays; register mein
//     dashboardAccountId; purani pairing code par check-in
//   - J2-m36 (unified-4.1): check-in jawab mein offlineCodeUsed
//     (boolean) — lock app is se apna mehfooz code invalid karta hai.
//   - J2-m29 (unified-4.1): check-in ke saath aaya deviceOwnerLost
//     account par store hota hai, /api/device/status mein nazar
//     aata hai (dashboard dukaan ko alert dikhaye).
//     pairing_code_changed deta hai; lockApp:false account par
//     lock/warn refuse hota hai (400 lock_not_allowed).
// FCM sirf phone-API ka izafa hai: register/checkin mein optional
// fcmToken, aur sync se unlock/completed/LOCK par push.
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
//     deviceRegistered, deviceName, imei, lastSeenAt — sync se KABHI
//     nahi badalte. v2.1 mein DO istisna hain (PU-M5): sync body mein
//     saaf taur par bheji gayi offlineUnlockUntil / offlineCodeUsed
//     RESTORE ho jati hain (wipe ke baad dashboard ki adopted window
//     wapas aati hai); na bheji jayein to purani qeemat rehti hai.
//   - v2.1 (PU-M1): sync mein purane se MUKHTALIF ghair-khaali
//     unlockCode aaye to naya lock cycle hai — offlineCodeUsed reset,
//     window saaf. Khaali code ("") naya cycle nahi (burned code hai).
//     unified-4 (J1-C03): ye rule SIRF tab chalta hai jab sync mein
//     saaf restore (offlineCodeUsed / offlineUnlockUntil) NA ho —
//     restore bheji gayi ho to restore jeet-ti hai, chahe code
//     mukhtalif hi kyun na ho (kamaya hua 24h window sync se
//     kabhi nahi mit-ta).
//   - v2.1 (PU-M3): sync mein lockState locked aaye to window HAMESHA
//     saaf ho jati hai — dukaan ka saaf lock window se oopar hai.
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
//   - v2.1 (PU-M8): resetPin sync se aata hai aur register ke jawab
//     mein phone ko milta hai; dobara register par guard hai (purana
//     deviceId ya naya pairing code zaroori hai), lastReregisterAt
//     status mein milta hai.
//   - v2.1 (PU-S10): register + offline-code-used par rate limit hai
//     (10 ghalat koshishen/ghanta -> 1 ghante ki rok, data.json mein
//     mehfooz, restart ke baad bhi qaim); seed accounts ka code salted
//     hash mein rehta hai, plaintext sirf aik dafa bheja jata hai.
//     unified-4 (J1-M24): limit ab IP par NAHI — register pairing
//     code par, offline-code-used deviceId par hai (shop ki Wi-Fi
//     par aik phone ki ghaltiyan doosre phone ko nahi rokti;
//     X-Forwarded-For ko limit ke liye bilkul ignore kiya jata hai).
//   - v2.1 (PU-S9/S14/N4): check-in mein installmentNumber +
//     installmentTotal; graceDaysLeft inclusive (aakhri din = 1);
//     addMonths 31 tareekh par overflow nahi karta.
//   - FCM push (Wave 5.4, unified-4 HTTP v1): phone register/check-in
//     mein apna FCM token bhejta hai (optional, phone-side field —
//     sync isay kabhi nahi chhoota). Jab sync se koi account unlocked,
//     completed ya LOCKED hota hai to server us token par data-only
//     push bhejta hai ("check-in karo") taake phone foran khul/band
//     ho jaye. FCM_SERVICE_ACCOUNT_JSON (Render env) set na ho to
//     push band hai — sync phir bhi theek chalta hai, sirf aik log
//     line aati hai. Send ka code fcm.mjs mein hai (HTTP v1,
//     service-account OAuth2, unit-testable, stubbed fetch).
//   - data.json mit jaye (Render free restart) to haath se theek NAHI
//     karna — dashboard se sync-all dobara chalayein, replica khud
//     dobara ban jata hai. (Phone ko dobara register karna par sakta
//     hai, kyunke deviceId bhi data.json mein tha.)
//   - unified-4 (J2-M10): data.json atomic likhi jati hai (temp file
//     + rename) aur har save se pehle pichhli achhi copy .bak mein
//     rehti hai; kharab file par server backup se wapas aata hai.
//     Saves debounce hote hain (J2-p13) — check-in sirf tab save
//     karta hai jab asal mein kuch badla ho (J2-m20).
// Test accounts (/api/test/seed) ab bhi alag se chalte hain — un ka
// dashboardAccountId null hota hai, sync-all un ko haath nahi lagata.
//
// Chalana (Node 18+, koi dependency nahi):
//   AMG_SEED_TOKEN=koi-mushkil-token AMG_SYNC_TOKEN=koi-aur-token node server.mjs
//   Port: PORT env ya 3000. Data: AMG_DATA_FILE env ya paas wali data.json.
//
// Free hosting par (Render, free tier) yaad rakhein:
//   - Free service 15 minute khamoshi ke baad so jata hai, jagane mein
//     ~1 minute lagta hai; phone ka check-in 60 second intezar karta
//     hai, is liye test se pehle browser mein server ka link khol kar
//     jaga lein, phir 15 minute ke andar test karein.
//   - Free service ki file (data.json) redeploy/restart par mit sakti
//     hai — synced accounts sync-all se wapas aa jate hain, test-seed
//     accounts dobara banane parte hain.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sendFcmPush, parseServiceAccount } from "./fcm.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.AMG_DATA_FILE || join(__dirname, "data.json");
const DATA_BACKUP_FILE = DATA_FILE + ".bak";
const PORT = Number(process.env.PORT || 3000);
const SEED_TOKEN = process.env.AMG_SEED_TOKEN || "";
const SYNC_TOKEN = process.env.AMG_SYNC_TOKEN || "";
// FCM (Wave 5.4, unified-4 HTTP v1): Firebase service-account JSON,
// Render env var FCM_SERVICE_ACCOUNT_JSON se (poora JSON — Firebase
// console → Project settings → Service accounts → Generate new
// private key). Set na ho (ya kharab ho) to push band hai (no-op +
// log) — sync theek chalta hai. Purana FCM_SERVER_KEY ab NAHI parha
// jata (legacy API June 2024 mein band ho gaya tha — J1-C02).
const FCM_SA = parseServiceAccount(process.env.FCM_SERVICE_ACCOUNT_JSON || "");
if (process.env.FCM_SERVICE_ACCOUNT_JSON && !FCM_SA) {
  console.error("FCM_SERVICE_ACCOUNT_JSON set hai magar kharab hai — push band rahe ga (JSON check karein).");
}
// FCM_ENDPOINT / FCM_TOKEN_ENDPOINT SIRF TEST ke liye hain (local
// stub ki taraf modne ke liye) — Render par kabhi set nahi karna.
const FCM_ENDPOINT = process.env.FCM_ENDPOINT || "";
const FCM_TOKEN_ENDPOINT = process.env.FCM_TOKEN_ENDPOINT || "";

function load() {
  // J2-M10: pehle asal file, kharab/missing ho to .bak backup, dono
  // kharab hon to khaali shuruaat — magar khamoshi se NAHI, zor se
  // log kar ke (pehle corrupt file khamoshi se sab mita deti thi).
  let data = null;
  let usedBackup = false;
  if (existsSync(DATA_FILE)) {
    try {
      data = JSON.parse(readFileSync(DATA_FILE, "utf8"));
    } catch {
      console.error("data.json KHAARAB hai — backup (.bak) se wapas lane ki koshish...");
    }
  }
  if ((!data || !Array.isArray(data.accounts) || !Array.isArray(data.installments)) && existsSync(DATA_BACKUP_FILE)) {
    try {
      const bak = JSON.parse(readFileSync(DATA_BACKUP_FILE, "utf8"));
      if (bak && Array.isArray(bak.accounts) && Array.isArray(bak.installments)) {
        data = bak;
        usedBackup = true;
        console.error("data.json backup (.bak) se wapas laaya gaya — aakhri save se pehle wali halat hai.");
      }
    } catch {
      console.error("data.json.bak bhi kharaab hai — khaali shuruaat hogi.");
    }
  }
  if (!usedBackup && existsSync(DATA_FILE) && (!data || !Array.isArray(data.accounts) || !Array.isArray(data.installments))) {
    console.error("data.json kharaab hai aur koi backup nahi — khaali shuruaat hogi. Dashboard se sync-all dobara chalayein.");
  }
  if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.installments)) {
    data = { accounts: [], installments: [], nextAccountId: 1, nextInstallmentId: 1 };
  }
  // Purani data.json (v1/v2) ke accounts mein naye fields nahi hote —
  // default laga dein taake purana data bhi chal jaye.
  for (const a of data.accounts) {
    if (a.dashboardAccountId === undefined) a.dashboardAccountId = null;
    if (a.offlineCodeUsed === undefined) a.offlineCodeUsed = 0;
    if (a.autoLock === undefined) a.autoLock = true;
    if (a.resetPin === undefined) a.resetPin = "";
    // PU-M8: pehle se registered account ka registeredWithCode us ka
    // maujooda pairing code hai (dobara register ka guard isi se
    // pehchanta hai ke code dobara bana hai ya wohi purana hai).
    if (a.registeredWithCode === undefined) a.registeredWithCode = a.deviceRegistered ? a.pairingCode : "";
    if (a.lastReregisterAt === undefined) a.lastReregisterAt = "";
    if (a.unlockCodeHash === undefined) a.unlockCodeHash = "";
    // FCM (Wave 5.4): purane accounts mein token nahi hota.
    if (a.fcmToken === undefined) a.fcmToken = "";
    // unified-4: lockApp (default true — purane accounts sab phone
    // hain), syncSeq (J2-m25), aakhri push ghalti (J2-m21).
    if (a.lockApp === undefined) a.lockApp = true;
    if (a.syncSeq === undefined) a.syncSeq = 0;
    if (a.lastPushError === undefined) a.lastPushError = "";
    if (a.lastPushErrorAt === undefined) a.lastPushErrorAt = "";
    // unified-4.1 (J2-m29): Device Owner gum hone ka flag.
    if (a.deviceOwnerLost === undefined) a.deviceOwnerLost = false;
    // PU-S10: purane seed accounts ka plaintext code salted hash mein
    // badal dein (synced accounts ka code dashboard ka hota hai — wo
    // plaintext hi rehta hai, kyunke server use har lock_now mein
    // wapas bhejta hai; seed code sirf aik dafa bheja jata hai).
    if (a.dashboardAccountId == null && a.unlockCode && !a.unlockCodeHash) {
      a.unlockCodeHash = hashCode(a.unlockCode);
      a.unlockCode = "";
    }
  }
  if (!data.rateLimits || typeof data.rateLimits !== "object") data.rateLimits = {};
  if (!data.shopSyncSeq || typeof data.shopSyncSeq !== "object") data.shopSyncSeq = {};
  if (!data.nextAccountId) data.nextAccountId = 1;
  if (!data.nextInstallmentId) data.nextInstallmentId = 1;
  return data;
}
let db = load();
// ---- J2-M10 + J2-p13: atomic + debounced save ----
// Likha temp file mein jata hai, phir rename hota hai (POSIX par
// atomic — aadhi likhi file kabhi nahi banti). Rename se pehle
// maujooda achhi file .bak ban jati hai (aakhri achha save), taake
// load() kharab file par backup se wapas aa sake. save() sirf
// "ganda" (dirty) nishan lagata hai aur 200ms baad aik dafa likhta
// hai — aik hi lamhe ki kayi tabdeeliyan aik save mein simat jati
// hain. Band hone par (SIGTERM/SIGINT — Render restart) foran flush
// hota hai taake aakhri tabdeeli zaya na ho.
let saveTimer = null;
let saveDirty = false;
function flushSave() {
  if (!saveDirty) return;
  saveDirty = false;
  try {
    const text = JSON.stringify(db, null, 2);
    const tmp = DATA_FILE + ".tmp";
    writeFileSync(tmp, text);
    if (existsSync(DATA_FILE)) renameSync(DATA_FILE, DATA_BACKUP_FILE);
    renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error("save_failed", e && e.message ? e.message : e);
  }
}
function save() {
  saveDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flushSave(); }, 200);
}
function shutdownFlush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  flushSave();
}
process.on("SIGTERM", () => { shutdownFlush(); process.exit(0); });
process.on("SIGINT", () => { shutdownFlush(); process.exit(0); });

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
// PU-N4 fix: mahine ke aakhri din se overflow nahi hona chahiye —
// Jan 31 + 1 mahina = Feb 28 (pehle Mar 3 ban jata tha, kyunke
// setUTCMonth seedha Feb 31 banata hai jo Mar 3 mein overflow hota hai).
// Din ko target mahine ke aakhri din par clamp kar dete hain.
function addMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
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
    // PU-S9: pehli overdue qist ka number ("Qist #3 of 6" ke liye).
    firstOverdueSeq: overdue.length ? overdue[0].seq : null,
  };
}

// ---- FCM (Wave 5.4): token ki jaanch ----
// Token optional metadata hai — ghalat ho to register/check-in kabhi
// fail nahi hota, token bas ignore ho jata hai. FCM token ~150 harf
// ka hota hai; 1024 ki had sirf ghalat/bohat bara input rokne ke liye hai.
function validFcmToken(v) {
  if (typeof v !== "string") return "";
  const t = v.trim();
  if (!t || t.length > 1024) return "";
  return t;
}

// ---- FCM push (Wave 5.4): sync se unlock/completed/LOCK par phone ko jagayein ----
// Fire-and-forget: sync ka jawab is ka intezar NAHI karta, aur push ki
// koi ghalti sync ko kabhi nahi bigaarti (andar try/catch hai).
// Sirf TRANSITION par push hota hai — pehle se unlocked account ki
// dobara sync par nahi (warna har sync par push aata).
// unified-4 (J2-M13): LOCK transition par bhi push jata hai — pehle
// lock sirf 15-minute check-in par aata tha (Doze mein ghanton late).
// unified-4 (J2-m21): mara hua token (UNREGISTERED) prune ho jata
// hai, aur aakhri push ghalti account par mehfooz hoti hai taake
// /api/device/status se dikh sake (push ki nakami ab khamosh nahi).
async function maybePushTransition(acct, prevLockState, prevStatus) {
  try {
    const becameUnlocked = acct.lockState === "unlocked" && prevLockState !== null && prevLockState !== "unlocked";
    const becameCompleted = acct.status === "completed" && prevStatus !== null && prevStatus !== "completed";
    const becameLocked = acct.lockState === "locked" && prevLockState !== null && prevLockState !== "locked";
    if (!becameUnlocked && !becameCompleted && !becameLocked) return;
    if (acct.deviceRegistered !== 1) return; // phone abhi register hi nahi hua
    if (!acct.fcmToken) {
      console.log(`FCM skip: account ${acct.dashboardAccountId} has no FCM token registered`);
      return;
    }
    if (!FCM_SA) {
      console.log(`FCM not configured (FCM_SERVICE_ACCOUNT_JSON unset) — skipping push for account ${acct.dashboardAccountId}`);
      return;
    }
    const reason = becameCompleted ? "completed" : becameLocked ? "locked" : "unlocked";
    const res = await sendFcmPush({
      serviceAccount: FCM_SA,
      token: acct.fcmToken,
      data: { type: "amg_checkin", reason, dashboardAccountId: String(acct.dashboardAccountId) },
      endpoint: FCM_ENDPOINT || undefined,
      tokenEndpoint: FCM_TOKEN_ENDPOINT || undefined,
    });
    if (res.ok) {
      acct.lastPushError = "";
      acct.lastPushErrorAt = "";
      save();
      console.log(`FCM push sent (${reason}) to account ${acct.dashboardAccountId}`);
    } else {
      acct.lastPushError = res.error;
      acct.lastPushErrorAt = new Date().toISOString();
      if (res.tokenDead) {
        acct.fcmToken = "";
        console.log(`FCM token pruned (dead) for account ${acct.dashboardAccountId}`);
      }
      save();
      console.log(`FCM push FAILED (${reason}) account ${acct.dashboardAccountId}: ${res.error}`);
    }
  } catch (e) {
    console.log(`FCM push error account ${acct.dashboardAccountId}: ${e && e.message ? e.message : "unknown"}`);
  }
}

// ---- PU-S10: salted hash (server-generated seed codes ke liye) ----
// Seed accounts ka offline code data.json mein plaintext NAHI rehta —
// salted SHA-256 hash rehta hai ("salt:hash"). Code sirf us check-in
// ke jawab mein plaintext milta hai jis ne use banaya (phone us ka
// hash apne paas mehfooz kar leta hai — OfflineCodeStore); baad ki
// check-ins code dobara nahi bhejti. Synced accounts ka code dashboard
// ka hota hai — server use har lock_now mein wapas bhejta hai, is liye
// wo plaintext hi rehta hai (hash karne se code bheja hi nahi ja sakta).
function hashCode(code) {
  const salt = randomBytes(16).toString("hex");
  const h = createHash("sha256").update(salt + ":" + String(code).trim().toUpperCase()).digest("hex");
  return salt + ":" + h;
}
function verifyCode(code, stored) {
  if (!stored || typeof stored !== "string") return false;
  const idx = stored.indexOf(":");
  if (idx <= 0) return false;
  const salt = stored.slice(0, idx);
  const h = createHash("sha256").update(salt + ":" + String(code).trim().toUpperCase()).digest("hex");
  return h === stored.slice(idx + 1);
}

// ---- PU-S10: rate limiting (register + offline-code-used) ----
// Har key par 1 ghante mein 10 ghalat koshishen -> 1 ghante ki rok.
// State data.json mein rehti hai, is liye restart ke baad bhi qaim
// rehti hai. Kamyab koshish counter saaf kar deti hai.
// unified-4 (J1-M24): limit IP par NAHI hai — register pairing code
// par (`reg:<CODE>`), offline-code-used deviceId par (`ocu:<id>`).
// Pehle IP par thi: shop ki Wi-Fi par aik phone ki ghaltiyan sab
// phones ko rok deti thin, aur X-Forwarded-For ghoomane se limit
// bilkul bypass ho jati thi. Ab IP / X-Forwarded-For ko limit ke
// liye bilkul ignore kiya jata hai. 403 reregister_blocked kabhi
// counter nahi barhata (J2-m28 — wo andaza nahi, ghalat rasta hai).
const RATE_LIMIT_MAX_FAILS = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_BLOCK_MS = 60 * 60 * 1000;
function rateLimitBlocked(key) {
  const rec = db.rateLimits[key];
  if (!rec) return false;
  const now = Date.now();
  if (rec.blockedUntil && now < rec.blockedUntil) return true;
  if (rec.blockedUntil || now - rec.firstFailAt > RATE_LIMIT_WINDOW_MS) {
    delete db.rateLimits[key];
    save();
  }
  return false;
}
function rateLimitFail(key) {
  const now = Date.now();
  let rec = db.rateLimits[key];
  if (!rec || now - rec.firstFailAt > RATE_LIMIT_WINDOW_MS) {
    rec = db.rateLimits[key] = { fails: 0, firstFailAt: now, blockedUntil: 0 };
  }
  rec.fails += 1;
  if (rec.fails >= RATE_LIMIT_MAX_FAILS) rec.blockedUntil = now + RATE_LIMIT_BLOCK_MS;
  save();
}
function rateLimitClear(key) {
  if (db.rateLimits[key]) { delete db.rateLimits[key]; save(); }
}
// ---- J2-m20: check-in rate limit (per-device, memory mein) ----
// Aam phone 15 minute mein aik dafa check-in karta hai; 1 minute
// mein 20 se zyada ka matlab tight loop / flood hai. Ye limit
// sirf memory mein hai (data.json mein save nahi hoti — flood
// rokne ke liye hai, security block ke liye nahi).
const CHECKIN_LIMIT_MAX = 20;
const CHECKIN_LIMIT_WINDOW_MS = 60 * 1000;
const checkinHits = new Map(); // deviceId -> [timestamps]
function checkinRateLimited(deviceId) {
  const now = Date.now();
  let arr = checkinHits.get(deviceId) || [];
  arr = arr.filter((ts) => now - ts < CHECKIN_LIMIT_WINDOW_MS);
  if (arr.length >= CHECKIN_LIMIT_MAX) {
    checkinHits.set(deviceId, arr);
    return true;
  }
  arr.push(now);
  checkinHits.set(deviceId, arr);
  // Kabhi kabhi purani entries saaf kar dein (memory na barhe).
  if (checkinHits.size > 5000) {
    for (const [k, v] of checkinHits) {
      if (!v.length || now - v[v.length - 1] > CHECKIN_LIMIT_WINDOW_MS) checkinHits.delete(k);
    }
  }
  return false;
}
// ---- J2-m20: lastSeenAt kitni dair baad disk par likha jaye ----
// Check-in har dafa lastSeenAt badalta hai, magar disk par sirf
// 60 second mein aik dafa likhna kaafi hai (status memory se
// parhta hai, is liye dikhawa phir bhi taaza rehta hai).
const LAST_SEEN_SAVE_MS = 60 * 1000;
const lastSeenSavedAt = new Map(); // deviceId -> timestamp
// ---- J1-p16: seed accounts ke plaintext code (SIRF memory mein) ----
// Seed code disk par salted hash mein rehta hai (PU-S10) — is liye
// pehli lock_now ka jawab gum ho jaye to code dobara bheja hi nahi
// ja sakta tha. Ab plaintext code is server ke chalne tak memory
// mein bhi rehta hai, taake har lock_now mein dobara bheja ja sake
// jab tak code istemal na ho. Restart par ye map mit jata hai
// (hash phir bhi rehta hai — code verify ho sakta hai, dobara
// bheja nahi ja sakta). Disk par plaintext kabhi nahi likha jata.
const seedPlainCodes = new Map(); // accountId -> plaintext code
function send(res, status, obj) {
  try {
    if (res.writableEnded || res.destroyed) return;
    const body = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  } catch { /* client ja chuka — jawab nahi ja sakta, koi baat nahi */ }
}
// S-m1 fix: kharab JSON par 400 invalid_json — parser ki detail kabhi
// bahar nahi jati (neeche catch block mein 500 se bhi detail hata di hai).
class InvalidJsonError extends Error {
  constructor() { super("invalid_json"); this.code = "invalid_json"; }
}
class BodyTooLargeError extends Error {
  constructor() { super("body_too_large"); this.code = "body_too_large"; }
}
// J2-M11: body size cap — device endpoints 1 MB, sync 5 MB (200
// accounts wali sync-all bhi is se bohat chhoti hoti hai). Had se
// zyada aaye to 413 milta hai — poora body memory mein kabhi nahi
// aata (pehle koi had nahi thi, bara POST server ki memory kha
// sakta tha). Had paar hone par baqi body DRAIN ki jati hai (parh
// kar phenk di jati hai, memory mein nahi rakhi) taake 413 ka jawab
// saaf jaye — parhna band kar ke socket kaatne se client ko
// ECONNRESET milta hai, 413 nahi. Drain 10 second se zyada na chale
// (slow client ka socket tab kaat diya jata hai).
const MAX_BODY_DEVICE = 1024 * 1024;
const MAX_BODY_SYNC = 5 * 1024 * 1024;
const MAX_BODY_DRAIN_MS = 10000;
async function readJson(req, maxBytes = MAX_BODY_DEVICE) {
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  let drainTimer = null;
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    req.on("data", (c) => {
      if (tooLarge) return; // drain mode: parh kar phenk dein
      total += c.length;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0; // pehle wala hissa bhi phenk dein
        drainTimer = setTimeout(() => { try { req.destroy(); } catch { /* pehle se band */ } }, MAX_BODY_DRAIN_MS);
        if (drainTimer.unref) drainTimer.unref();
        return;
      }
      chunks.push(c);
    });
    req.once("end", () => done());
    req.once("close", () => done());
    req.once("error", (e) => done(e));
  });
  if (drainTimer) clearTimeout(drainTimer);
  if (tooLarge) throw new BodyTooLargeError();
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidJsonError();
  }
}
// J2-p11: token ka muqabla constant-time (dono ko pehle SHA-256 kar
// ke timingSafeEqual — lambi/chhoti ka farq bhi nahi batata).
function safeTokenEqual(provided, expected) {
  if (typeof provided !== "string" || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
function needSeedToken(req, res) {
  if (!SEED_TOKEN) { send(res, 403, { ok: false, error: "seed_disabled" }); return false; }
  if (!safeTokenEqual(req.headers["x-amg-seed"], SEED_TOKEN)) { send(res, 403, { ok: false, error: "bad_seed_token" }); return false; }
  return true;
}
// Sync auth: dashboard x-amg-sync header mein AMG_SYNC_TOKEN bhejta hai.
// Token Render mein set nahi hai to sync bilkul band hai (sync_disabled).
function needSyncToken(req, res) {
  if (!SYNC_TOKEN) { send(res, 403, { ok: false, error: "sync_disabled" }); return false; }
  if (!safeTokenEqual(req.headers["x-amg-sync"], SYNC_TOKEN)) { send(res, 403, { ok: false, error: "bad_sync_token" }); return false; }
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
// J2-m26: sync body ke strings/raqam ki had — baghair had ke aik
// bara sync data.json ko phula sakta tha (har check-in jawab bhi
// bara ho jata). Dashboard in hadon se bohat neeche rehta hai.
const MAX_SYNC_TEXT_LEN = 200;
const MAX_SYNC_CODE_LEN = 32;
const MAX_SYNC_GRACE_DAYS = 365;
const MAX_SYNC_AMOUNT = 1000000000; // Rs 1 arab — is se bara plan nahi hota
const MAX_SYNC_INSTALLMENTS = 120; // 10 saal ki mahina qistein
function validateSyncAccount(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const dashboardAccountId = Number(b.dashboardAccountId);
  if (!Number.isInteger(dashboardAccountId) || dashboardAccountId <= 0) return null;
  // shopId LAZMI hai — is ke baghair sync-all doosri shop ke accounts
  // se farq nahi kar sakta (OQ-1). Dashboard hamesha bhejta hai.
  const shopId = Number(b.shopId);
  if (!Number.isInteger(shopId) || shopId <= 0) return null;
  if (!Array.isArray(b.installments)) return null;
  if (b.installments.length > MAX_SYNC_INSTALLMENTS) return null;
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
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_SYNC_AMOUNT) return null;
    if (!Number.isFinite(paidAmount) || paidAmount < 0 || paidAmount > amount) return null;
    installments.push({ seq, dueDate: inst.dueDate, amount, paidAmount });
  }
  if (b.status !== undefined && b.status !== "active" && b.status !== "completed") return null;
  if (b.lockState !== undefined && b.lockState !== "unlocked" && b.lockState !== "warned" && b.lockState !== "locked") return null;
  let graceDays;
  if (b.graceDays !== undefined) {
    graceDays = Number(b.graceDays);
    if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > MAX_SYNC_GRACE_DAYS) return null;
  }
  let pairingCode;
  if (b.pairingCode !== undefined) {
    pairingCode = String(b.pairingCode).trim().toUpperCase();
    if (!pairingCode || pairingCode.length > MAX_SYNC_CODE_LEN) return null;
  }
  let unlockCode;
  if (b.unlockCode !== undefined) {
    if (typeof b.unlockCode !== "string") return null;
    unlockCode = b.unlockCode.trim().toUpperCase();
    if (unlockCode.length > MAX_SYNC_CODE_LEN) return null;
  }
  let autoLock;
  if (b.autoLock !== undefined) {
    if (typeof b.autoLock !== "boolean") return null;
    autoLock = b.autoLock;
  }
  // J2-m26: naam/phone ki had (zaroorat se zyada lamba = reject).
  for (const f of ["shopName", "shopPhone", "customerName"]) {
    if (b[f] !== undefined && String(b[f]).length > MAX_SYNC_TEXT_LEN) return null;
  }
  // J2-m25: per-account sync sequence (optional, monotonic) — purani
  // sync (seq <= mehfooz seq) ignore hoti hai. Dashboard jab bhejega
  // tabhi kaam aayegi; na bheje to sab pehle jaisa chalta hai.
  let syncSeq;
  if (b.syncSeq !== undefined) {
    syncSeq = Number(b.syncSeq);
    if (!Number.isInteger(syncSeq) || syncSeq < 0) return null;
  }
  // Contract: lockApp — phone hai ya nahi (TV/fridge par lock nahi
  // lagta). lockApp:false + lockState locked/warned = refuse (neeche
  // handlers mein lock_not_allowed). Na aaye to phone mana jata hai.
  let lockApp;
  if (b.lockApp !== undefined) {
    if (typeof b.lockApp !== "boolean") return null;
    lockApp = b.lockApp;
  }
  // PU-M5: dashboard ki adopted window/latch — wipe ke baad sync-all
  // se wapas aati hai. Na ho to purani qeemat rehti hai (preserve);
  // di jaye to server use RESTORE karta hai.
  let offlineUnlockUntil;
  if (b.offlineUnlockUntil !== undefined) {
    if (typeof b.offlineUnlockUntil !== "string") return null;
    offlineUnlockUntil = b.offlineUnlockUntil.trim();
    if (offlineUnlockUntil && Number.isNaN(Date.parse(offlineUnlockUntil))) return null;
  }
  let offlineCodeUsed;
  if (b.offlineCodeUsed !== undefined) {
    if (typeof b.offlineCodeUsed === "boolean") offlineCodeUsed = b.offlineCodeUsed ? 1 : 0;
    else if (b.offlineCodeUsed === 0 || b.offlineCodeUsed === 1) offlineCodeUsed = b.offlineCodeUsed;
    else return null;
  }
  // PU-M8: reset PIN — dashboard set karta hai, server register ke
  // jawab mein phone ko wapas deta hai.
  let resetPin;
  if (b.resetPin !== undefined) {
    if (typeof b.resetPin !== "string" || b.resetPin.length > 32) return null;
    resetPin = b.resetPin.trim();
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
    offlineUnlockUntil, offlineCodeUsed, resetPin,
    syncSeq, lockApp,
    installments,
  };
}
// Contract: lockApp:false account par lock/warn refuse hota hai —
// TV/fridge par lock lag hi nahi sakta (J1-M02 ka server hissa).
function lockNotAllowed(norm) {
  return norm.lockApp === false && (norm.lockState === "locked" || norm.lockState === "warned");
}
// dashboardAccountId se upsert karein. Server ka apna numeric `id`
// alag rehta hai (nextAccountId se) — dashboard ki id se kabhi takrata
// nahi, aur /api/test/seed wali ids se bhi nahi.
// REPLICA RULE: update mein sirf dashboard-side fields badalte hain.
// Phone-side fields (deviceId, deviceRegistered, deviceName, imei,
// lastSeenAt) sync se KABHI nahi badalte — wo sirf phone ki
// register/checkin/offline-code-used se badalte hain. v2.1 mein
// offlineUnlockUntil / offlineCodeUsed DO istisna hain (PU-M5): sync
// body mein saaf taur par bheji jayein to RESTORE hoti hain (wipe ke
// baad dashboard ki adopted window wapas aati hai); na bheji jayein
// to purani qeemat rehti hai. Naye account ke liye pairingCode lazmi
// hai (warna phone is se register hi nahi ho sakta); na ho to null.
// `st` wo state hai jis par upsert chalta hai — aam tor par live
// `db`, sync-all mein us ka clone (J1-M23 atomicity: clone par
// apply, kamyabi par swap). Stale check (J2-m25) upsert se PEHLE
// handlers mein hota hai — yahan pahuncha sync hamesha taaza hai.
function upsertSyncedAccount(norm, st = db) {
  let acct = st.accounts.find((a) => a.dashboardAccountId === norm.dashboardAccountId);
  if (!acct) {
    if (!norm.pairingCode) return null;
    acct = {
      id: st.nextAccountId++,
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
      unlockCodeHash: "",
      resetPin: norm.resetPin !== undefined ? norm.resetPin : "",
      registeredWithCode: "",
      lastReregisterAt: "",
      // PU-M5: wipe ke baad sync-all se restored window/latch.
      offlineUnlockUntil: norm.offlineUnlockUntil !== undefined ? norm.offlineUnlockUntil : "",
      deviceId: null, deviceRegistered: 0, deviceName: "", imei: "", lastSeenAt: "",
      offlineCodeUsed: norm.offlineCodeUsed !== undefined ? norm.offlineCodeUsed : 0,
      // FCM token phone-side field hai — sync isay kabhi nahi set
      // karta; phone register/check-in mein bhejta hai.
      fcmToken: "",
      // J2-m29: Device Owner flag bhi phone-side hai — sirf
      // check-in se aata hai, sync isay kabhi nahi chhoota.
      deviceOwnerLost: false,
      lastPushError: "",
      lastPushErrorAt: "",
      // unified-4: lockApp (na aaye to phone mana jata hai) +
      // syncSeq (J2-m25 — na aaye to 0).
      lockApp: norm.lockApp !== undefined ? norm.lockApp : true,
      syncSeq: norm.syncSeq !== undefined ? norm.syncSeq : 0,
    };
    st.accounts.push(acct);
  } else {
    const oldUnlockCode = acct.unlockCode;
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
    if (norm.resetPin !== undefined) acct.resetPin = norm.resetPin;
    if (norm.lockApp !== undefined) acct.lockApp = norm.lockApp;
    if (norm.syncSeq !== undefined) acct.syncSeq = norm.syncSeq;
    // Phone-side fields yahan jaan boojh kar CHHUE NAHI jate (upar dekhein)
    // — siwaaye neeche wale v2.1 rules ke, jin ki tartib ahem hai:
    // 1) PU-M5: dashboard ne window/latch saaf taur par bheji ho to
    //    RESTORE karein (wipe ke baad adopted window wapas aati hai).
    const explicitRestore = norm.offlineUnlockUntil !== undefined || norm.offlineCodeUsed !== undefined;
    if (norm.offlineUnlockUntil !== undefined) acct.offlineUnlockUntil = norm.offlineUnlockUntil;
    if (norm.offlineCodeUsed !== undefined) acct.offlineCodeUsed = norm.offlineCodeUsed;
    // 2) PU-M1: naya code (purane se mukhtalif) = naya lock cycle —
    //    latch reset, window saaf. Khaali code ("") naya cycle NAHI
    //    hai — wo jala hua (burned) code hai; is par rule chala to
    //    dashboard-redeem ki adopted window ghalat saaf ho jaye gi
    //    (UAT fix round mein pakra gaya).
    //    J1-C03: ye rule SIRF tab chalta hai jab sync mein saaf
    //    restore NA ho. Pehle restore ke baad bhi rule chalta tha,
    //    aur code istemal par server code ko "" kar deta tha — is
    //    liye dashboard ki adopted sync (purana code + window +
    //    latch) ko "naya code" samajh kar window mita di jati thi.
    //    Ab: restore bheji gayi ho to restore JEET-TI hai (code
    //    mukhtalif bhi ho to), aur code istemal par code ki qeemat
    //    rehti hai (latch hi dobara istemal rokta hai) — is liye
    //    aam routine sync bhi window nahi mita sakti.
    //    NOTE (dashboard ke liye): naya code + latch=1 aik hi sync
    //    mein na bhejein — latch purane code ki hai; naya code ya
    //    to latch=0 ke saath aaye, ya alag sync mein (tab ye rule
    //    latch reset kar dega).
    if (!explicitRestore && norm.unlockCode !== undefined && norm.unlockCode !== "" && norm.unlockCode !== oldUnlockCode) {
      acct.offlineCodeUsed = 0;
      acct.offlineUnlockUntil = "";
    }
  }
  // 3) PU-M3 (naye + purane dono): lockState locked ho to window
  //    HAMESHA saaf — dukaan ka saaf lock window se oopar hai, is
  //    liye agli check-in lock_now degi, stay_unlocked nahi.
  if (norm.lockState === "locked") acct.offlineUnlockUntil = "";
  // Qistein hamesha poori tarah badal dein — dashboard ki allocation
  // (overpayment samet) hi sach hai, server ki koi doosri raaye nahi.
  st.installments = st.installments.filter((i) => i.accountId !== acct.id);
  for (const inst of norm.installments) {
    st.installments.push({ id: st.nextInstallmentId++, accountId: acct.id, seq: inst.seq, dueDate: inst.dueDate, amount: inst.amount, paidAmount: inst.paidAmount });
  }
  return acct;
}

const server = createServer(async (req, res) => {
  // Client beech mein disconnect ho jaye to response ka 'error'
  // server ko na giraye (ye sab client-disconnect shor hai).
  res.on("error", () => {});
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      // J2-p12: health baghair auth ke hai — account counts yahan
      // se hata diye gaye (counts sirf seed-token wale dump mein
      // milte hain). fcmConfigured rehta hai — setup check ke liye
      // zaroori hai (FCM guide ka Step 7 isi par hai) aur sirf aik
      // boolean batata hai, koi data nahi.
      return send(res, 200, {
        ok: true, service: "amg-device-api", version: "unified-4.1",
        // FCM (Wave 5.4): service account set hai ya nahi — setup check ke liye.
        fcmConfigured: Boolean(FCM_SA),
      });
    }

    // ---- Phone wali app ke 3 raaste (ServerApi.kt ke mutabiq) ----
    // CONTRACT FREEZE: in ke request/response bilkul waisay hi hain
    // jaisay v1 mein thay — lock app mein koi tabdeeli nahi aayi.
    if (req.method === "POST" && url.pathname === "/api/device/register") {
      const b = await readJson(req);
      const code = String(b.pairingCode || "").trim().toUpperCase();
      // PU-S10 + J1-M24: limit PAIRING CODE par hai (10 ghalat
      // koshishen/ghanta -> 1 ghante ki rok) — IP par nahi. Aik
      // code ki ghaltiyan doosre code ko kabhi nahi rokti (shop ki
      // Wi-Fi par sab phones aik IP hote hain).
      const codeKey = "reg:" + code;
      if (rateLimitBlocked(codeKey)) {
        return send(res, 429, { ok: false, error: "too_many_attempts", message: "Bahut zyada ghalat koshishen — 1 ghante baad dobara koshish karein." });
      }
      const matches = db.accounts.filter((a) => a.pairingCode.toUpperCase() === code);
      // J2-M12: aik hi pairing code do accounts par ho to register
      // REFUSE karein (ambiguous) — pehle match par bandhna ghalat
      // shop ke customer ko pakar sakta tha. Dashboard codes ko
      // globally unique rakhta hai; ye server ka guard hai.
      if (matches.length > 1) {
        return send(res, 200, { ok: false, error: "pairing_code_ambiguous", message: "Ye pairing code aik se zyada accounts par hai — dukaan se naya code lein." });
      }
      const acct = matches[0];
      if (!acct) { rateLimitFail(codeKey); return send(res, 200, { ok: false, error: "invalid_pairing_code" }); }
      // PU-M8: dobara register ka guard — pehle se registered account
      // par sirf tab jab (a) phone apna purana deviceId dikhaye, ya
      // (b) pairing code us code se mukhtalif ho jis se aakhri dafa
      // register hua tha (matlab dukaan ne code dobara banaya hai).
      // Warna koi bhi phone utha kar registration hijack kar sakta tha.
      // (Wipe ke baad deviceRegistered 0 hota hai, is liye dobara
      // register usi code se khula rehta hai — PU-M5 ka flow.)
      const alreadyRegistered = acct.deviceRegistered === 1 && acct.deviceId;
      const presentedDeviceId = String(b.deviceId || "").trim().slice(0, 128);
      if (alreadyRegistered) {
        const sameDevice = presentedDeviceId && presentedDeviceId === acct.deviceId;
        const freshCode = code !== (acct.registeredWithCode || "");
        if (!sameDevice && !freshCode) {
          // J2-m28: 403 reregister_blocked rate limit mein NAHI
          // gina jata — ye andaza (guessing) nahi hai, aur warna
          // jaiz dobara-register ki koshish rok kha jati.
          return send(res, 403, { ok: false, error: "reregister_blocked", message: "Is phone ko dobara register karne ke liye dukaan se naya pairing code lein." });
        }
        acct.lastReregisterAt = new Date().toISOString();
      }
      const deviceId = "dev_" + randomBytes(6).toString("hex");
      acct.deviceId = deviceId;
      acct.deviceRegistered = 1;
      acct.registeredWithCode = code;
      acct.deviceName = String(b.model || "Android phone").slice(0, 80);
      acct.imei = String(b.imei || "").slice(0, 64); // J2-m26: imei ki had
      // FCM (Wave 5.4): phone apna push token register par bhejta hai
      // (optional — na bheje to purana token rehta hai).
      const fcmToken = validFcmToken(b.fcmToken);
      if (fcmToken) acct.fcmToken = fcmToken;
      acct.lastSeenAt = new Date().toISOString();
      rateLimitClear(codeKey);
      save();
      // PU-M8: reset PIN phone ko milta hai taake reset ke waqt wo
      // PIN maang sake (PIN dashboard ne sync se set kiya hota hai;
      // na set ho to khaali string aati hai).
      // Contract: dashboardAccountId bhi milta hai (dashboard ki id
      // — server ki androoni id nahi; seed account par null).
      return send(res, 200, { ok: true, deviceId, accountId: acct.id, dashboardAccountId: acct.dashboardAccountId, shopName: acct.shopName, shopPhone: acct.shopPhone, resetPin: acct.resetPin || "" });
    }

    if (req.method === "POST" && url.pathname === "/api/device/checkin") {
      const b = await readJson(req);
      // S-C1 fix: khaali/missing deviceId pehle hi reject karein — warna ye
      // pehle unregistered account (deviceId "") se match ho jata tha aur
      // us ka data (due date, balance, lock code) leak ho jata tha.
      const deviceId = String(b.deviceId || "").trim();
      if (!deviceId) return send(res, 200, { ok: false, error: "device_not_registered" });
      // J2-m20: per-device check-in rate limit (1 minute mein 20).
      if (checkinRateLimited(deviceId)) {
        return send(res, 429, { ok: false, error: "too_many_attempts", message: "Bahut zyada check-in — thori der baad dobara koshish karein." });
      }
      const acct = db.accounts.find((a) => a.deviceId === deviceId);
      if (!acct) return send(res, 200, { ok: false, error: "device_not_registered" });
      // Contract: dashboard ne pairing code dobara bana diya ho to
      // phone ko alag error milta hai (pairing_code_changed) taake
      // app "dobara register karein" dikhaye, aam error nahi.
      if (b.pairingCode && acct.pairingCode.toUpperCase() !== String(b.pairingCode).trim().toUpperCase()) {
        return send(res, 200, { ok: false, error: "pairing_code_changed" });
      }
      // J2-m20: save SIRF tab jab asal mein kuch badla ho — har
      // check-in par poori file likhna band. `changed` har tabdeeli
      // par set hota hai (neeche); lastSeenAt sirf 60s mein aik dafa
      // disk par likha jata hai.
      let changed = false;
      // FCM (Wave 5.4): token refresh check-in ke saath aata hai —
      // naya token ho to update kar dein (neeche save() isay likhta hai).
      const fcmToken = validFcmToken(b.fcmToken);
      if (fcmToken && fcmToken !== acct.fcmToken) { acct.fcmToken = fcmToken; changed = true; }
      // J2-m29: Device Owner status gum ho to app check-in ke
      // saath deviceOwnerLost bhejti hai. Field maujood ho to
      // store karein (true ya false dono — app bahaal hone par
      // false bhej sakti hai); na ho to pehli value rehne dein.
      // Sirf tab badle jab value waqai badli ho (J2-m20: bekaar
      // save nahi hota).
      if (typeof b.deviceOwnerLost === "boolean" && b.deviceOwnerLost !== (acct.deviceOwnerLost === true)) {
        acct.deviceOwnerLost = b.deviceOwnerLost;
        changed = true;
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
      if (acct.offlineUnlockUntil && !windowActive) { acct.offlineUnlockUntil = ""; changed = true; } // guzri hui window saaf karein
      // Contract: lockApp:false account par lock policy lagti hi nahi
      // (TV/fridge — phone hi nahi hai). Manual lock bhi is par nahi
      // lag sakta (sync pehle hi refuse kar deta hai).
      const lockApplies = acct.lockApp !== false;
      if (acct.status === "completed") {
        instruction = "permanent_unlock";
      } else if (windowActive) {
        instruction = "stay_unlocked";
      } else if (!lockApplies) {
        instruction = "stay_unlocked";
      } else if (acct.lockState === "locked") {
        // Manual lock kabhi khud nahi khulta — sirf payment ya offline code se.
        instruction = "lock_now";
        if (isSynced) {
          // PU-S7: code pehle hi istemal ho chuka ho to dobara nahi
          // bhejte — phone ke paas wohi purana code dobara aata to
          // customer use dobara likhne ki koshish karta. Naya code
          // agli sync se aata hai.
          offlineUnlockCode = acct.offlineCodeUsed === 1 ? null : (acct.unlockCode || null);
        } else if (!acct.unlockCodeHash) {
          // Seed account, abhi koi code nahi: naya code banayein —
          // salted hash mehfooz karein, plaintext SIRF isi jawab mein
          // bhejein (phone us ka hash apne paas rakh leta hai).
          const fresh = genCode(6);
          acct.unlockCodeHash = hashCode(fresh);
          acct.offlineCodeUsed = 0;
          acct.offlineUnlockUntil = "";
          seedPlainCodes.set(acct.id, fresh);
          changed = true;
          offlineUnlockCode = fresh;
        } else if (acct.offlineCodeUsed !== 1) {
          // J1-p16: seed code pehle issue ho chuka ho to bhi har
          // lock_now mein dobara bhejein (jab tak istemal na hua
          // ho) — pehle sirf pehli lock_now mein milta tha, jawab
          // gum ho jaye to phone ke paas code kabhi nahi aata tha.
          // Plaintext sirf memory se aata hai (disk par hash hi hai);
          // restart ke baad dobara bheja nahi ja sakta.
          offlineUnlockCode = seedPlainCodes.get(acct.id) || null;
        }
        // Seed account jiss ka code istemal ho chuka hai: dobara nahi bhejte.
      } else if (next && today > addDays(next.dueDate, acct.graceDays) && acct.autoLock !== false) {
        // autoLock off ho (dashboard ki lock-policy setting) to grace ke
        // baad bhi AUTO-lock nahi — neeche warning branch chalegi.
        acct.lockState = "locked";
        changed = true;
        if (isSynced) {
          // PU-S7: istemal shuda code dobara nahi bhejte (upar dekhein).
          offlineUnlockCode = acct.offlineCodeUsed === 1 ? null : (acct.unlockCode || null);
        } else {
          const fresh = genCode(6);
          acct.unlockCodeHash = hashCode(fresh);
          acct.offlineCodeUsed = 0;
          acct.offlineUnlockUntil = "";
          seedPlainCodes.set(acct.id, fresh);
          offlineUnlockCode = fresh;
        }
        instruction = "lock_now";
      } else if (next && today > next.dueDate) {
        // J1-m53: warning due date ke AGLE din se lagti hai — due
        // date khud reminder ka din hai, phone aam tarah chalta hai
        // (pehle due date par hi "Warning — Qist Late Hai" aa jata tha).
        if (acct.lockState !== "warned") { acct.lockState = "warned"; changed = true; }
        instruction = "warn";
      } else {
        instruction = "stay_unlocked";
      }
      acct.lastSeenAt = new Date().toISOString();
      // lastSeenAt disk par sirf 60s mein aik dafa (J2-m20) — memory
      // mein har dafa taaza rehta hai, status wahi dikhata hai.
      const lastSaved = lastSeenSavedAt.get(deviceId) || 0;
      if (Date.now() - lastSaved > LAST_SEEN_SAVE_MS) {
        lastSeenSavedAt.set(deviceId, Date.now());
        changed = true;
      }
      if (changed) save();
      // PU-S14: graceDaysLeft INCLUSIVE hai — aakhri grace din par 1
      // dikhaye, 0 nahi ("0 din baqi" ghalat tha, phone abhi grace mein tha).
      // J1-m53: due date se PEHLE ya due date par graceDaysLeft poora
      // grace hai (pehle due date par 6 dikhta tha jab grace 5 tha);
      // late hone ke baad inclusive gin-ti (aakhri grace din = 1).
      const graceDaysLeft = !next ? 0
        : today <= next.dueDate ? acct.graceDays
        : Math.max(0, daysBetween(today, addDays(next.dueDate, acct.graceDays)) + 1);
      // PU-S9: lock screen "Qist #3 of 6" dikhaye — overdue qist ka
      // number (na ho to agli baqi qist ka) + kul qiston ki tadad.
      const myInstallments = db.installments.filter((i) => i.accountId === acct.id).sort((a, b) => a.seq - b.seq);
      const installmentTotal = myInstallments.length;
      const installmentNumber = overdue.firstOverdueSeq != null ? overdue.firstOverdueSeq : (next ? next.seq : null);
      return send(res, 200, {
        ok: true, instruction,
        dueDate: next ? next.dueDate : "",
        remainingAmount: remaining,
        graceDaysLeft,
        installmentTotal,
        ...(installmentNumber != null ? { installmentNumber } : {}),
        // Contract: poori qist schedule + graceDays — lock app isay
        // mehfooz kar ke offline deadline lock lagati hai (J2-M14
        // mitigation: offline rehne par bhi due + grace + buffer ke
        // baad phone khud lock ho jata hai).
        schedule: myInstallments.map((i) => ({ seq: i.seq, dueDate: i.dueDate, amount: i.amount, paidAmount: i.paidAmount })),
        graceDays: acct.graceDays,
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
        // J2-m36: is code cycle ka code istemal ho chuka hai ya nahi
        // (lock app true par apna mehfooz code invalid kar deta hai).
        // Jawab bante waqt ki taaza value hai (is hi check-in mein
        // naya code bana ho to false, kyunke naya code istemal nahi hua).
        offlineCodeUsed: acct.offlineCodeUsed === 1,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/device/offline-code-used") {
      const b = await readJson(req);
      // S-C1 fix: khaali/missing deviceId pehle hi reject karein (checkin jaisa).
      const deviceId = String(b.deviceId || "").trim();
      if (!deviceId) return send(res, 200, { ok: false, error: "device_not_registered" });
      // PU-S10 + J1-M24: limit SIRF deviceId par hai (10 ghalat code
      // koshishen -> 1 ghante ki rok). IP wali key hata di gayi —
      // shop ki Wi-Fi par aik phone ki ghaltiyan doosre phone ki
      // sahi code report ko rokti thin.
      const devKey = "ocu:" + deviceId;
      if (rateLimitBlocked(devKey)) {
        return send(res, 429, { ok: false, error: "too_many_attempts", message: "Bahut zyada ghalat koshishen — 1 ghante baad dobara koshish karein." });
      }
      const acct = db.accounts.find((a) => a.deviceId === deviceId);
      if (!acct) { rateLimitFail(devKey); return send(res, 200, { ok: false, error: "device_not_registered" }); }
      const typedCode = String(b.code || "").trim().toUpperCase();
      // PU-S7: maujooda code ka latch laga ho to code pehle hi istemal
      // ho chuka hai — dobara kabhi nahi chal sakta (wipe-restore ke
      // baad bhi nahi, jahan code wapas aata hai).
      // Seed accounts ka code salted hash se milta hai, synced ka
      // dashboard wale plaintext code se.
      const codeOk = acct.dashboardAccountId != null
        ? (Boolean(acct.unlockCode) && typedCode === acct.unlockCode.toUpperCase())
        : verifyCode(typedCode, acct.unlockCodeHash);
      if (acct.lockState !== "locked" || acct.offlineCodeUsed === 1 || !codeOk) {
        rateLimitFail(devKey);
        return send(res, 200, { ok: false, error: "invalid_unlock_code" });
      }
      acct.lockState = "unlocked";
      // J1-C03: code istemal par code ki qeemat REHTI hai — "" nahi
      // hoti. Pehle "" ho jati thi, to dashboard ki adopted sync
      // (purana code + window + latch) ko new-code rule "naya code"
      // samajh kar window mita deta tha. Ab code rehta hai taake
      // muqabla ma'ni-khez ho; dobara istemal latch (neeche) rokta
      // hai, aur jala hua code lock_now mein dobara kabhi nahi
      // bheja jata (PU-S7 latch). Seed hash bhi rehta hai (latch
      // hi dobara istemal rokta hai); memory wala plaintext saaf
      // ho jata hai taake dobara na bheja jaye.
      seedPlainCodes.delete(acct.id);
      // Code istemal ho gaya — dashboard /api/device/status se ye flag
      // dekh sakta hai. Ye flag sync se kabhi nahi badalta (latch hai)
      // — siwaaye v2.1 ke: naya code aane par reset, ya dashboard ki
      // saaf restore (PU-M1/PU-M5).
      acct.offlineCodeUsed = 1;
      // D-M6 fix: code istemal par 24 ghante ki unlock window shuru hoti
      // hai — is doran check-in stay_unlocked deta hai (upar dekhein).
      acct.offlineUnlockUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      rateLimitClear(devKey);
      save();
      return send(res, 200, { ok: true, offlineUnlockUntil: acct.offlineUnlockUntil });
    }

    // ---- Dashboard sync ke 3 raaste (unified v2, sync token zaroori) ----
    // Ye REPLICA feed karte hain — app.db source of truth hai, ye server
    // sirf phone ke liye us ki naqal rakhta hai. Wipe ho jaye to sync-all
    // se dobara banayein, haath se data.json edit NAHI karna.
    if (req.method === "POST" && url.pathname === "/api/device/sync") {
      if (!needSyncToken(req, res)) return;
      const b = await readJson(req, MAX_BODY_SYNC);
      const norm = validateSyncAccount(b);
      if (!norm) return send(res, 400, { ok: false, error: "invalid_sync_payload" });
      if (lockNotAllowed(norm)) return send(res, 400, { ok: false, error: "lock_not_allowed" });
      // FCM: push sirf TRANSITION par hai — upsert se PEHLE purani
      // halat snapshot karein (upsert usi object ko badalta hai).
      const prev = db.accounts.find((a) => a.dashboardAccountId === norm.dashboardAccountId);
      const prevLockState = prev ? prev.lockState : null;
      const prevStatus = prev ? prev.status : null;
      // J2-m25: purani sync (seq <= mehfooz seq) ignore hoti hai —
      // taaza halat par purani halat kabhi nahi likhi jati (J2-m27:
      // server-side auto-lock bhi purani sync se wapas nahi hota).
      if (prev && norm.syncSeq !== undefined && norm.syncSeq <= prev.syncSeq) {
        return send(res, 200, { ok: true, stale: true, accountId: prev.id, dashboardAccountId: prev.dashboardAccountId });
      }
      const acct = upsertSyncedAccount(norm);
      if (!acct) return send(res, 400, { ok: false, error: "invalid_sync_payload" }); // naya account, pairing code nahi
      save();
      // Fire-and-forget: jawab is ka intezar nahi karta.
      if (prev) void maybePushTransition(acct, prevLockState, prevStatus);
      return send(res, 200, { ok: true, accountId: acct.id, dashboardAccountId: acct.dashboardAccountId });
    }

    if (req.method === "POST" && url.pathname === "/api/device/sync-all") {
      if (!needSyncToken(req, res)) return;
      const b = await readJson(req, MAX_BODY_SYNC);
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
      // J2-m25: batch sequence (optional, per-shop watermark) — poora
      // batch purana ho to poora ignore hota hai (kuch delete bhi nahi
      // hota). Na bheja jaye to pehle jaisa chalta hai.
      let batchSeq;
      if (b.syncSeq !== undefined) {
        batchSeq = Number(b.syncSeq);
        if (!Number.isInteger(batchSeq) || batchSeq < 0) {
          return send(res, 400, { ok: false, error: "invalid_sync_payload" });
        }
        if (batchSeq <= (db.shopSyncSeq[shopId] || 0)) {
          return send(res, 200, { ok: true, stale: true, synced: 0 });
        }
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
        if (lockNotAllowed(norm)) return send(res, 400, { ok: false, error: "lock_not_allowed" });
        // Naya account baghair pairing code ke upsert mein fail hota
        // hai — is liye pehle hi reject karein (yehi wo case tha jo
        // pehle aadha apply ho jata tha: delete ho jata tha, upsert
        // fail hota tha — J1-M23).
        const exists = db.accounts.some((a) => a.dashboardAccountId === norm.dashboardAccountId);
        if (!exists && !norm.pairingCode) {
          return send(res, 400, { ok: false, error: "invalid_sync_payload" });
        }
        seenIds.add(norm.dashboardAccountId);
        normed.push(norm);
      }
      // J1-M23: ATOMIC apply — pehle live state ki naqal (clone)
      // banayein, sab kuch us par karein, aur SIRF poori kamyabi
      // par naqal ko live bana kar aik dafa save karein. Beech mein
      // koi ghalti ho to naqal phenk di jati hai — live state ko
      // haath nahi lagta (pehle delete + upsert seedha live memory
      // par hote thay, aur aik kharab entry baqi accounts ko mita
      // deti thi).
      const draft = structuredClone(db);
      // Full replace — SIRF IS SHOP ke synced accounts ka. Doosri shops
      // ke synced accounts aur test-seed accounts ko haath nahi lagta.
      const removedIds = draft.accounts
        .filter((a) => a.dashboardAccountId != null && a.shopId === shopId && !seenIds.has(a.dashboardAccountId))
        .map((a) => a.id);
      draft.accounts = draft.accounts.filter((a) => !(a.dashboardAccountId != null && a.shopId === shopId && !seenIds.has(a.dashboardAccountId)));
      draft.installments = draft.installments.filter((i) => !removedIds.includes(i.accountId));
      // FCM: har account ki purani halat LIVE se snapshot karein
      // (upsert usi object ko badalta hai); push sirf poori kamyabi
      // ke baad.
      const pushJobs = [];
      let staleCount = 0;
      for (const norm of normed) {
        // upsert update path mein phone-side fields khud bacha leta hai.
        const prev = db.accounts.find((a) => a.dashboardAccountId === norm.dashboardAccountId);
        const prevLockState = prev ? prev.lockState : null;
        const prevStatus = prev ? prev.status : null;
        // J2-m25: is entry ki seq purani ho to sirf ye entry skip
        // hoti hai (list mein hone ki wajah se delete bhi nahi hoti).
        if (prev && norm.syncSeq !== undefined && norm.syncSeq <= prev.syncSeq) {
          staleCount += 1;
          continue;
        }
        const acct = upsertSyncedAccount(norm, draft);
        if (!acct) {
          // Naqal phenk di — live state waisi ki waisi hai.
          return send(res, 400, { ok: false, error: "invalid_sync_payload" });
        }
        if (prev) pushJobs.push([acct, prevLockState, prevStatus]);
      }
      // Sab theek — naqal live ban gayi.
      db = draft;
      if (batchSeq !== undefined) db.shopSyncSeq[shopId] = batchSeq;
      save();
      for (const [acct, prevLockState, prevStatus] of pushJobs) {
        void maybePushTransition(acct, prevLockState, prevStatus);
      }
      return send(res, 200, { ok: true, synced: normed.length - staleCount, stale: staleCount });
    }

    if (req.method === "GET" && url.pathname === "/api/device/status") {
      if (!needSyncToken(req, res)) return;
      const d = Number(url.searchParams.get("dashboardAccountId"));
      const acct = db.accounts.find((a) => a.dashboardAccountId === d);
      if (!acct) return send(res, 200, { ok: false, error: "account_not_found" });
      // J2-m23: guzri hui window status mein bhi nahi dikhti (pehle
      // sirf check-in saaf karta tha — status saalon purani window
      // dikhata rehta tha). Guzri ho to mehfooz state se bhi saaf.
      let windowUntil = acct.offlineUnlockUntil || "";
      if (windowUntil && new Date(windowUntil) <= new Date()) {
        windowUntil = "";
        acct.offlineUnlockUntil = "";
        save();
      }
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
        offlineUnlockUntil: windowUntil,
        // PU-M8: aakhri dobara-register ka waqt (dashboard Device Lock
        // tab mein dikhaye — hijack ki nishani ho sakti hai).
        lastReregisterAt: acct.lastReregisterAt || "",
        // FCM (Wave 5.4): is phone ka push token registered hai ya
        // nahi — dashboard Device Lock tab mein dikha sakta hai.
        fcmRegistered: Boolean(acct.fcmToken),
        // J2-m21: aakhri push ghalti (khaali = aakhri push kamyab ya
        // kabhi push nahi hua) — push ki nakami ab nazar aati hai.
        lastPushError: acct.lastPushError || "",
        lastPushErrorAt: acct.lastPushErrorAt || "",
        // J2-m29: Device Owner gum hua hai ya nahi (check-in se
        // aaya) — dashboard is par dukaan ko alert dikhaye.
        deviceOwnerLost: acct.deviceOwnerLost === true,
      });
    }

    // ---- Sirf TEST ke liye (seed token zaroori) ----
    // Bilkul waisay hi jaisa v1 mein tha. In accounts ka
    // dashboardAccountId null hota hai — sync-all in ko nahi chhoota.
    if (req.method === "POST" && url.pathname === "/api/test/seed") {
      if (!needSeedToken(req, res)) return;
      const b = await readJson(req);
      // J2-m24: seed input validate karein — pehle kharab tareekh
      // par 500 aata tha (addMonths Invalid Date par phat jata tha)
      // aur months ki koi had nahi thi (10 lakh qistein ban sakti thin).
      const total = Number(b.total);
      const months = Number(b.months);
      const graceDays = b.graceDays === undefined ? 5 : Number(b.graceDays);
      const firstDue = b.firstDueDate === undefined ? todayStr() : String(b.firstDueDate);
      if (!Number.isFinite(total) || total <= 0) return send(res, 400, { ok: false, error: "invalid_seed_payload" });
      if (!Number.isInteger(months) || months < 1 || months > 60) return send(res, 400, { ok: false, error: "invalid_seed_payload" });
      if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 365) return send(res, 400, { ok: false, error: "invalid_seed_payload" });
      if (!isValidDateStr(firstDue)) return send(res, 400, { ok: false, error: "invalid_seed_payload" });
      const perMonth = Math.floor(total / months);
      const acct = {
        id: db.nextAccountId++, dashboardAccountId: null,
        shopName: String(b.shopName || "Al Arab Electronic"),
        shopPhone: String(b.shopPhone || ""), customerName: String(b.customerName || "Test Customer"),
        pairingCode: genCode(8), graceDays, status: "active", lockState: "unlocked",
        autoLock: true,
        unlockCode: "", unlockCodeHash: "", offlineUnlockUntil: "", offlineCodeUsed: 0,
        resetPin: "", registeredWithCode: "", lastReregisterAt: "",
        deviceId: null, deviceRegistered: 0, deviceName: "", imei: "", lastSeenAt: "",
        fcmToken: "",
        deviceOwnerLost: false,
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
      if (outstanding(acct.id) === 0) { acct.status = "completed"; acct.lockState = "unlocked"; acct.unlockCode = ""; acct.unlockCodeHash = ""; seedPlainCodes.delete(acct.id); }
      else if (acct.lockState === "locked") {
        const next = nextUnpaid(acct.id);
        if (next && todayStr() <= addDays(next.dueDate, acct.graceDays)) { acct.lockState = "unlocked"; acct.unlockCode = ""; acct.unlockCodeHash = ""; seedPlainCodes.delete(acct.id); }
      }
      save();
      return send(res, 200, { ok: true, accountId: acct.id, status: acct.status, lockState: acct.lockState, outstanding: outstanding(acct.id) });
    }

    if (req.method === "GET" && url.pathname === "/api/test/accounts") {
      if (!needSeedToken(req, res)) return;
      // J2-m19: dump mein secrets MASK hote hain — seed token gate
      // ke bawajood poori dump mein plaintext codes/PINs/tokens
      // nahi aate. Khaali field khaali rehti hai, bhari hui "***".
      const mask = (v) => (v ? "***" : v);
      const accounts = db.accounts.map((a) => ({
        ...a,
        unlockCode: mask(a.unlockCode),
        unlockCodeHash: mask(a.unlockCodeHash),
        resetPin: mask(a.resetPin),
        pairingCode: mask(a.pairingCode),
        deviceId: mask(a.deviceId),
        imei: mask(a.imei),
        fcmToken: mask(a.fcmToken),
      }));
      return send(res, 200, { ok: true, accounts, installments: db.installments });
    }

    return send(res, 404, { ok: false, error: "not_found" });
  } catch (e) {
    // S-m1: kharab JSON par 400 (upar InvalidJsonError dekhein).
    if (e && e.code === "invalid_json") return send(res, 400, { ok: false, error: "invalid_json" });
    // J2-M11: had se bara body — 413.
    if (e && e.code === "body_too_large") return send(res, 413, { ok: false, error: "body_too_large" });
    console.error("server_error", e);
    // 500 mein kabhi detail nahi — andar ki ghalti bahar nahi jati.
    return send(res, 500, { ok: false, error: "server_error" });
  }
});

server.listen(PORT, () => {
  console.log(`AMG device API unified-4.1 — http://localhost:${PORT} (seed ${SEED_TOKEN ? "enabled" : "DISABLED: set AMG_SEED_TOKEN"}, sync ${SYNC_TOKEN ? "enabled" : "DISABLED: set AMG_SYNC_TOKEN"}, fcm ${FCM_SA ? "enabled" : "DISABLED: set FCM_SERVICE_ACCOUNT_JSON"})`);
});
