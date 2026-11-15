# AMG Device API — dashboard ka phone wala hissa (UNIFIED v2.1 + FCM HTTP v1, health version `unified-4.1`)

## Seedhi baat — ye kya hai?

Phone wali lock app (AMG Lock) ko ek **live link (server URL)** chahiye hota
hai, taake wo pooch sake: "is customer ki qist ki halat kya hai — lock karun
ya nahi?" Ye folder us link ka server hai: `server.mjs` — ek chhoti file,
Node.js se chalti hai, koi aur cheez install nahi karni.

15 November 2026 se ye **unified** hai: dashboard aur phone ab aik hi system
hain. Dashboard ki `app.db` asal data hai (single source of truth); ye server
us ki **synced copy (replica)** rakhta hai taake phone is se baat kar sake.
Dashboard par payment, lock, unlock ya customer ki tabdeeli ab khud phone tak
sync hoti hai. (Pehle ye sirf test wala bridge tha — ab wo daur khatam hai.)

## Phone wali API (kabhi nahi badalti)

Lock app EXACTLY ye 3 raaste mangti hai:

- `POST /api/device/register` — `{ pairingCode, imei, model, androidVersion,
  deviceId?, fcmToken? }` → `deviceId`, `accountId`, `dashboardAccountId`
  (unified-4 — dashboard ki id, server ki androoni id nahi), `shopName`,
  `shopPhone`, `resetPin` (v2.1). Pehle se registered account par dobara
  register sirf purane `deviceId` ya naye pairing code se hota hai, warna
  `403 reregister_blocked` (ye 403 rate limit mein nahi gina jata).
  Ghalat koshishon par rate limit hai (10/ghanta → 1 ghante ki rok,
  `429 too_many_attempts`) — limit PAIRING CODE par hai, IP par nahi
  (shop ki Wi-Fi par aik phone ki ghaltiyan doosre ko nahi rokti).
  Aik hi code do accounts par ho to register `pairing_code_ambiguous`
  de kar refuse karta hai (pehle match par bandhna band hai).
- `POST /api/device/checkin` — `{ deviceId, pairingCode, fcmToken?,
  deviceOwnerLost? }` → `stay_unlocked` | `warn` | `lock_now` |
  `permanent_unlock`. Dashboard ne pairing code dobara bana diya ho to
  check-in `pairing_code_changed` deta hai (dobara register karna hota
  hai). Check-in par per-device rate limit hai (1 minute mein 20).
  `deviceOwnerLost: true` (Device Owner status gum ho) account par
  mehfooz hota hai aur `/api/device/status` mein nazar aata hai
  (dashboard dukaan ko alert dikhaye).
- `POST /api/device/offline-code-used` — `{ deviceId, code }` (rate
  limit deviceId par hai, IP par nahi).

Check-in ke jawab mein: `overdueAmount` / `overdueDueDate` / `overdueCount`
(sirf OVERDUE qist ki raqam, poora balance nahi), `nextDueDate` /
`monthlyAmount`, `shopPhone`, lock par `offlineUnlockCode`, aur 24 ghante ki
unlock window mein `offlineUnlockUntil`. v2.1 mein mazeed:
`installmentNumber` / `installmentTotal` ("Qist #3 of 6") aur inclusive
`graceDaysLeft` (aakhri grace din = 1). unified-4 mein mazeed: poori qist
`schedule` (`[{seq, dueDate, amount, paidAmount}]`) + `graceDays` — lock app
isay mehfooz kar ke offline deadline lock lagati hai. unified-4.1 mein
mazeed: check-in jawab mein `offlineCodeUsed` (boolean — is code cycle
ka code istemal ho chuka hai ya nahi; lock app true par apna mehfooz code
invalid kar deta hai). Warning due date ke
AGLE din se lagti hai (due date khud reminder ka din hai); `graceDaysLeft`
due date par poora grace dikhata hai (pehle grace+1 dikhta tha). Offline code
istemal par 24 ghante ki window shuru hoti hai — is doran phone unlocked
rehta hai; window khatam hone par agar qist abhi bhi overdue hai to dobara
lock ho jata hai. Seed (test) accounts ka code ab har `lock_now` mein
dobara bheja jata hai jab tak istemal na ho (pehle sirf pehli dafa milta tha).

## Sync API (dashboard ke liye)

Teenon par header lagta hai: `x-amg-sync: <AMG_SYNC_TOKEN>` (Render mein env
var; token dashboard ke Master setup card se banta hai — kabhi chat ya file
mein nahi likhna). Token Render mein set na ho to sync band hai
(`403 sync_disabled`); ghalat token ho to `403 bad_sync_token`.

- `POST /api/device/sync` — aik account ka device state.
  `dashboardAccountId` aur `shopId` lazmi hain; qistein, `lockState`,
  `unlockCode`, `status`, `autoLock` waghera sync hote hain.
- `POST /api/device/sync-all` — AIK shop ke tamam synced accounts, poora
  replace. Top-level `shopId` lazmi hai — doosri shop ke accounts ko haath
  nahi lagta. Khaali `accounts` list us shop ke replica accounts mita deti
  hai (shop delete hone par safai ke liye).
- `GET /api/device/status?dashboardAccountId=<n>` — phone ki live halat
  (register hua ya nahi, last seen, lock state, offline code istemal hua ya
  nahi) — Device Lock tab ye dikhata hai.

Ahem usool: sync sirf **dashboard-side fields** badalta hai. Phone-side fields
(`deviceId`, `deviceRegistered`, `deviceName`, `imei`, `lastSeenAt`,
`fcmToken`) sync se KABHI nahi badalte — wo sirf phone ki register/checkin se
badalte hain. Do istisna (v2.1): sync body mein saaf taur par bheji gayi
`offlineUnlockUntil` / `offlineCodeUsed` RESTORE ho jati hain (wipe ke baad
dashboard ki adopted window wapas aati hai). Naya (mukhtalif, ghair-khaali)
`unlockCode` naya lock cycle hai — latch reset, window saaf; `lockState:
locked` wali sync window hamesha saaf kar deti hai (dukaan ka lock window se
oopar hai). **unified-4 (J1-C03):** saaf restore bheji gayi ho to restore
JEET-TI hai — naya code bhi kamaya hua 24h window nahi mita sakta; aur code
istemal par server code ko `""` nahi karta (latch hi dobara istemal rokta
hai, aur jala hua code dobara kabhi nahi bheja jata). Synced account ka
offline unlock code sirf dashboard deta hai; server synced accounts ke liye
apna code KABHI nahi banata. `autoLock` sync hota hai: off ho to grace ke
baad bhi AUTO-lock nahi lagta (warning phir bhi lagti hai); manual lock
hamesha kaam karta hai. `resetPin` sync se aata hai aur register ke jawab
mein phone ko milta hai.

**unified-4 mazeed:** sync-all ab waqai **atomic** hai (validate → clone par
apply → swap + aik save; kharab batch live state ko haath nahi lagata).
Sync mein optional **`syncSeq`** (per-account, monotonic) — purani sync
ignore hoti hai (`stale: true`); sync-all mein top-level `syncSeq` (per-shop
watermark) poora purana batch ignore kar deta hai. **`lockApp: false`**
account par lock/warn refuse hota hai (`400 lock_not_allowed`) — TV/fridge
par lock nahi lagta. Sync body ki had: strings 200 chars, codes 32 chars,
grace 365 din, raqam Rs 1 arab, qistein 120 tak; POST body ki had device
endpoints 1 MB, sync 5 MB (zyada par `413 body_too_large`).

## FCM push (Wave 5.4, HTTP v1 — unified-4)

Phone register/check-in mein apna FCM token bhejta hai (optional). Jab sync
se koi account **unlocked**, **completed** ya **LOCKED** hota hai (transition
— pehle se unlocked ki dobara sync par nahi), to server us token par
data-only push bhejta hai: `{ type: "amg_checkin",
reason: "unlocked"|"completed"|"locked", dashboardAccountId }`. Push sirf
"check-in karo" ka ishara hai — faisla hamesha check-in ka jawab karta hai.
Phone push par foran check-in karta hai, taake payment ke baad phone 15
minute ka intezar kiye baghair khul jaye (aur lock bhi foran lage).

- Auth **HTTP v1** hai: Firebase **service-account JSON** Render env var
  **`FCM_SERVICE_ACCOUNT_JSON`** se aati hai (Firebase console → Project
  settings → Service accounts → Generate new private key; Mubeen ka step —
  key kabhi chat ya file mein nahi likhni). Server us se RS256 JWT sign kar
  ke OAuth2 access token leta hai (token cache hota hai). **Purana
  `FCM_SERVER_KEY` ab NAHI parha jata** — legacy FCM API Google ne June 2024
  mein band kar diya tha (J1-C02); Render se purani key hata dein.
  Service account set na ho to push band hai (no-op + aik log line) — sync
  phir bhi theek chalta hai.
- `/health` mein `fcmConfigured: true/false` aata hai (account counts ab
  health mein nahi aate — baghair auth ke thay); `/api/device/status` mein
  `fcmRegistered: true/false` (is phone ka token hai ya nahi) aur
  `lastPushError` / `lastPushErrorAt` (aakhri push ghalti). Mara hua token
  (UNREGISTERED) khud prune ho jata hai.
- Send ka code **`fcm.mjs`** mein hai (HTTP v1 + OAuth2, koi dependency
  nahi — sirf Node ka built-in `crypto`/`fetch`) — unit test mein fetch stub
  karke jaancha jata hai. `FCM_ENDPOINT` / `FCM_TOKEN_ENDPOINT` env vars
  SIRF test ke liye hain (local stub); Render par kabhi set nahi karna.
- Poora setup tareeqa: `hidden_files/fcm-setup-guide.md` (Mubeen ke paas).

## Wipe ho jaye to kya hota hai?

Render free restart/redeploy par `data.json` mit sakti hai. Ghabrana nahi —
asal data dashboard (`app.db`) mein mehfooz rehta hai. Dashboard se **sync-all**
chalayein, replica dobara ban jata hai. Phone ko **dobara register** karna par
sakta hai (deviceId bhi `data.json` mein tha) — wahi pairing code dobara kaam
karta hai, code nahi badalta. unified-4 mein `data.json` atomic likhi jati
hai (temp file + rename) aur har save se pehle pichhli achhi copy
`data.json.bak` mein rehti hai — file kharab ho jaye to server backup se
wapas aa jata hai (khaamoshi se khaali shuruaat nahi hoti).

## Test accounts (purana tareeqa, ab bhi chalta hai)

- `POST /api/test/seed` aur `POST /api/test/pay` — header `x-amg-seed` =
  `AMG_SEED_TOKEN`. In accounts ka `dashboardAccountId` null hota hai;
  sync-all in ko haath nahi lagata. Sirf test ke liye hain.

## Free tier ki 2 kamzoriyan — test se pehle samajh lein

- **Neend:** free service 15 minute khamoshi ke baad so jata hai, jagane mein
  ~1 minute lagta hai. Phone ka check-in 60 second intezar karta hai.
  **Test se pehle browser mein server ka link khol kar jaga lein**, phir
  15 minute ke andar test karein.
- **Data mit jata hai:** upar wipe wala hissa dekhein. Is server par asal
  customers ka data kabhi seedha na rakhein — wo dashboard mein hai.

## Chalana (apni machine par test ke liye)

```bash
cd live-server
AMG_SEED_TOKEN=koi-mushkil-token AMG_SYNC_TOKEN=koi-aur-mushkil-token node server.mjs
# phir http://localhost:3000/health kholein — {"ok":true,"version":"unified-4.1",...} aana chahiye
```

Tests (sab local, koi live data nahi chhoota):

```bash
node unified-server-test.mjs
# 281/281 pass — sync, sync-all shop scoping, autoLock, wipe recovery,
# offline 24h window, sticky latch, seed/pay, validation, v2.1 (window
# restore, new-code reset, manual-lock-wins, re-register guard, reset
# PIN, code rotation, qist number, inclusive grace, addMonths clamp,
# rate limiting, salted hash) + FCM HTTP v1 unit tests (JWT + token
# cache + error paths) + FCM trigger (unlock/completed/LOCK push,
# dead-token prune) + Audit R2 (J1-C03 exact sequence, J1-M23
# atomicity, J1-M24 re-keyed limits, J2-M10 backup, J2-M11 body
# limits, J2-M12 ambiguity, J2-m19 redaction, J2-m20 check-in limit
# + save-on-change, J2-m23–m28, J2-p11–p13, J1-m53, J1-p16, lockApp
# guard, syncSeq, schedule/graceDays, pairing_code_changed) + J2-m36
# check-in offlineCodeUsed + J2-m29 deviceOwnerLost
```

## Render par deploy

- Repo: `github.com/mubeenayoob3123/amg-device-api` — Render Git se
  auto-deploy karta hai (push hote hi naya version live ho jata hai).
- Start command: `node server.mjs` (koi dependency nahi).
- Environment variables: `AMG_SEED_TOKEN` (test accounts), `AMG_SYNC_TOKEN`
  (dashboard sync — dashboard ke Master setup card se milta hai),
  `FCM_SERVICE_ACCOUNT_JSON` (push — Firebase service-account JSON, poora;
  set na ho to push band hai, baqi sab chalta hai). Purana
  `FCM_SERVER_KEY` hata dein — ab kaam nahi karta.
- Live link: `https://amg-device-api.onrender.com`

Files: `server.mjs` + `fcm.mjs` (Node 18+, koi dependency nahi). Data: paas wali `data.json`
(pehli dafa chalne par khud ban jati hai; `AMG_DATA_FILE` env se badal sakte
hain). Port: `PORT` env ya 3000.
