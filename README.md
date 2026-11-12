# Live server — phone ko dashboard se jorne wala link (TEST version)

## Seedhi baat — ye kya hai?

Phone wali lock app ko ek **live link (server URL)** chahiye hota hai, taake wo
dashboard se pooch sake: "is customer ki qist ki halat kya hai — lock karun ya nahi?"

Ye folder us link ka **test wala server** hai: `server.mjs` — ek chhoti file,
Node.js se chalti hai, koi aur cheez install nahi karni.

## Is mein kya check ho chuka hai? (12 November 2026, dopahar)

Apni machine par chala kar ye sab test kiya — sab theek chala:

1. **Ghalat pairing code** → phone ko `invalid_pairing_code` milta hai, register nahi hota.
2. **Qist time par hai** → `stay_unlocked`, phone normal chalta hai.
3. **Qist due hai, grace chal rahi hai** → `warn`, phone par warning aati hai.
4. **Grace khatam, qist ada nahi** → `lock_now` + ek dafa chalne wala offline code milta hai.
5. **Ghalat offline code** → nahi khulta. **Sahi code** → khul jata hai.
6. **Poori qist ada** → `permanent_unlock`, phone hamesha ke liye khul jata hai.

## Ek zaroori sach — jo pehle saaf nahi tha

Dashboard (jo abhi bana hua hai) ke andar lock ka kaam actions ke tor par hai,
lekin **phone jo raasta mangta hai, wo dashboard mein nahi hai**:

- Phone ko **pairing code** se register hona hai; dashboard ka register action
  **accountId** mangta hai, jo phone ke paas hota hi nahi.
- Phone **"warn"** samajhta hai; dashboard **"show_warning"** deta hai.
- Dashboard ka koi public link `/api/device/...` nahi hai.

Is liye sirf dashboard ko hosting par dalne se phone nahi jurta — is bridge
server ki zaroorat hai. Ye bridge usi kami ko poora karta hai.

## Ye TEST server hai — asal customers ka data is par NAHI

- Is server ka apna chhota data hai (`data.json`) — dashboard ka data is mein
  **nahi** aata. Test account is server par banta hai (`/api/test/seed` se),
  dashboard se nahi.
- Asal version mein dashboard aur ye API **ek hi database** se chalenge —
  wo agla marhala hai, is test ke baad.

## Free hosting par dalne ka tareeqa (Render, free tier)

1. Ye `live-server` folder GitHub par dalna hoga (Render Git se deploy karta hai).
2. Render.com par account — **Mubeen ke naam/email se** (hosting hamesha usi ke
   naam par, ye us ka apna usool hai).
3. Render par "New Web Service" → repo chunein → Build: `npm install` nahi,
   kuch nahi (koi dependency nahi) → Start: `node server.mjs`.
4. Environment variable: `AMG_SEED_TOKEN` = koi mushkil lafz (test account
   banane ke liye). Port Render khud deta hai.
5. Milne wala link, jaise `https://amg-device-api.onrender.com`, phone ki lock
   app ki Setup screen mein **Server URL** mein dalna hoga.

## Free tier ki 2 kamzoriyan — test se pehle samajh lein

- **Neend:** free service 15 minute khamoshi ke baad so jata hai, jagane mein
  ~1 minute lagta hai. Phone ka check-in sirf 15 second intezar karta hai.
  **Test se pehle browser mein server ka link khol kar jaga lein**, phir
  15 minute ke andar test karein.
- **Data mit jata hai:** free service ki file (data.json) restart/redeploy par
  mit sakti hai; free database 30 din mein khatam ho jata hai. Is liye ye
  **sirf test** ke liye hai — asal customers ka data is par kabhi na rakhein.

## Aaj raat (12 November) — kya karna hai, kis tartib se

1. **Mubeen (ghar par, laptop par):** guide ke mutabiq test wali APK banayein
   (`app-debug.apk`) aur chat mein bhej dein. **Purana phone abhi reset NA karein.**
2. **Phir faisla:** upar wala free hosting tareeqa theek hai, ya pehle ye test
   server Hamraaz yahin se chalaye? Faisla hote hi server ka link mile ga.
3. **Link milne ke baad:** phone mein app install → Setup mein server URL +
   pairing code → register → check-in test (pehle warning, phir lock, phir
   payment par unlock).
4. **Yaad rakhein:** test wali APK se QR wala asal test **nahi** hota — us ke
   liye asal (release) wali APK chahiye, jo agla marhala hai.

## Chalana (apni machine par test ke liye)

```bash
cd live-server
AMG_SEED_TOKEN=koi-mushkil-token node server.mjs
# phir http://localhost:3000/health kholein — {"ok":true,...} aana chahiye
```

Test account banana (sirf token ke sath):

```bash
curl -X POST http://localhost:3000/api/test/seed \
  -H 'Content-Type: application/json' -H 'x-amg-seed: koi-mushkil-token' \
  -d '{"customerName":"Test Customer","total":60000,"months":6,"graceDays":5,"firstDueDate":"2026-11-01"}'
# jawab mein pairingCode mile ga — wahi phone mein dalna hai
```

File: `server.mjs` (Node 18+, koi dependency nahi). Data: paas wali `data.json`
(pehli dafa chalne par khud ban jati hai).
