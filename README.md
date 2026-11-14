# AMG Device API — dashboard ka phone wala hissa (UNIFIED v2)

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

- `POST /api/device/register` — `{ pairingCode, imei, model, androidVersion }`
- `POST /api/device/checkin` — `{ deviceId, pairingCode }` →
  `stay_unlocked` | `warn` | `lock_now` | `permanent_unlock`
- `POST /api/device/offline-code-used` — `{ deviceId, code }`

Check-in ke jawab mein: `overdueAmount` / `overdueDueDate` / `overdueCount`
(sirf OVERDUE qist ki raqam, poora balance nahi), `nextDueDate` /
`monthlyAmount`, `shopPhone`, lock par `offlineUnlockCode`, aur 24 ghante ki
unlock window mein `offlineUnlockUntil`. Offline code istemal par 24 ghante
ki window shuru hoti hai — is doran phone unlocked rehta hai; window khatam
hone par agar qist abhi bhi overdue hai to dobara lock ho jata hai.

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
`offlineUnlockUntil`, `offlineCodeUsed`) sync se KABHI nahi badalte — wo sirf
phone ki register/checkin se badalte hain. Synced account ka offline unlock
code sirf dashboard deta hai; server synced accounts ke liye apna code KABHI
nahi banata. `autoLock` sync hota hai: off ho to grace ke baad bhi AUTO-lock
nahi lagta (warning phir bhi lagti hai); manual lock hamesha kaam karta hai.

## Wipe ho jaye to kya hota hai?

Render free restart/redeploy par `data.json` mit sakti hai. Ghabrana nahi —
asal data dashboard (`app.db`) mein mehfooz rehta hai. Dashboard se **sync-all**
chalayein, replica dobara ban jata hai. Phone ko **dobara register** karna par
sakta hai (deviceId bhi `data.json` mein tha) — wahi pairing code dobara kaam
karta hai, code nahi badalta.

## Test accounts (purana tareeqa, ab bhi chalta hai)

- `POST /api/test/seed` aur `POST /api/test/pay` — header `x-amg-seed` =
  `AMG_SEED_TOKEN`. In accounts ka `dashboardAccountId` null hota hai;
  sync-all in ko haath nahi lagata. Sirf test ke liye hain.

## Free tier ki 2 kamzoriyan — test se pehle samajh lein

- **Neend:** free service 15 minute khamoshi ke baad so jata hai, jagane mein
  ~1 minute lagta hai. Phone ka check-in sirf 15 second intezar karta hai.
  **Test se pehle browser mein server ka link khol kar jaga lein**, phir
  15 minute ke andar test karein.
- **Data mit jata hai:** upar wipe wala hissa dekhein. Is server par asal
  customers ka data kabhi seedha na rakhein — wo dashboard mein hai.

## Chalana (apni machine par test ke liye)

```bash
cd live-server
AMG_SEED_TOKEN=koi-mushkil-token AMG_SYNC_TOKEN=koi-aur-mushkil-token node server.mjs
# phir http://localhost:3000/health kholein — {"ok":true,"version":"unified-1",...} aana chahiye
```

Tests (sab local, koi live data nahi chhoota):

```bash
node unified-server-test.mjs
# 70/70 pass — sync, sync-all shop scoping, autoLock, wipe recovery,
# offline 24h window, sticky latch, seed/pay, validation
```

## Render par deploy

- Repo: `github.com/mubeenayoob3123/amg-device-api` — Render Git se
  auto-deploy karta hai (push hote hi naya version live ho jata hai).
- Start command: `node server.mjs` (koi dependency nahi).
- Environment variables: `AMG_SEED_TOKEN` (test accounts), `AMG_SYNC_TOKEN`
  (dashboard sync — dashboard ke Master setup card se milta hai).
- Live link: `https://amg-device-api.onrender.com`

File: `server.mjs` (Node 18+, koi dependency nahi). Data: paas wali `data.json`
(pehli dafa chalne par khud ban jati hai; `AMG_DATA_FILE` env se badal sakte
hain). Port: `PORT` env ya 3000.
