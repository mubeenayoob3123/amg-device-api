// FCM push — Firebase Cloud Messaging, HTTP v1 API (unified-4, 15 Nov 2026).
// ============================================================
// Server phone ko push is liye bhejta hai taake payment / final
// payment / lock ke baad phone FORAN check-in kare — 15 minute ke
// WorkManager tick ka intezar na ho (PU-M2 ka hissa).
//
// Push sirf "check-in karo" ka ishara hai (data-only message):
//   data = { type: "amg_checkin", reason: "unlocked"|"completed"|"locked",
//            dashboardAccountId: "101" }
// Faisla hamesha check-in ka jawab karta hai, push ka data nahi —
// push mein koi lock/unlock faisla, koi code, koi raqam nahi hoti.
//
// Auth (HTTP v1): Firebase service-account JSON se OAuth2 access
// token banta hai — legacy server key wala API Google ne June 2024
// mein band kar diya tha, is liye wo raasta ab bilkul kaam nahi
// karta (J1-C02). Service account Render env var
// FCM_SERVICE_ACCOUNT_JSON se aati hai (poora JSON, Mubeen ka step
// — key kabhi chat ya file mein nahi likhni). Token lene ke liye
// service account ki private key se RS256 JWT sign hota hai (Node
// ka built-in crypto — koi dependency nahi), phir wo JWT Google ke
// token endpoint par access token se badla jata hai. Token expiry
// se ~5 minute pehle tak cache mein rehta hai, taake har push par
// naya token na maangna pare.
//
// Service account set na ho to server push bilkul nahi bhejta
// (no-op + aik log line) — sync kabhi push ki wajah se nakaam
// nahi hota.
//
// Ye module khud koi server nahi chalata — sirf sendFcmPush() deta
// hai, taake unit test mein fetch ko stub karke jaancha ja sake
// (unified-server-test.mjs, section Q). Koi dependency nahi — Node
// ka built-in fetch istemal hota hai. Har FCM call par 10 second
// ka timeout hai (J2-m22) taake latka hua endpoint socket na khaye.
//
// Dead token: HTTP v1 ka 404 / NOT_FOUND / UNREGISTERED jawab
// {ok:false, error:"fcm_token_not_found", tokenDead:true} ban kar
// wapas aata hai — caller (server.mjs) us par token ko prune kar
// deta hai (J2-m21).
import { createSign } from "node:crypto";

export const FCM_DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FCM_TOKEN_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
// HTTP v1 send endpoint — project_id service account se aata hai.
export function fcmV1Endpoint(projectId) {
  return `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
}
// Har FCM HTTP call ka timeout (J2-m22).
export const FCM_TIMEOUT_MS = 10000;
// Token is waqt se pehle refresh ho jata hai (expiry se 5 minute pehle).
const TOKEN_EARLY_REFRESH_MS = 5 * 60 * 1000;

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/**
 * Service-account JSON (string ya pehle se parse ki hui object) ko
 * saaf shakal mein lautaein; kharab ho to null. Sirf wo 3 fields
 * chahiye hote hain jo OAuth2 ke liye zaroori hain.
 */
export function parseServiceAccount(input) {
  if (!input) return null;
  let obj = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  // Dono shaklein qabool hain: Firebase JSON (snake_case) aur pehle
  // se parse ki hui object (camelCase — server.mjs wahi bhejta hai).
  const projectId = typeof (obj.project_id ?? obj.projectId) === "string" ? (obj.project_id ?? obj.projectId).trim() : "";
  const clientEmail = typeof (obj.client_email ?? obj.clientEmail) === "string" ? (obj.client_email ?? obj.clientEmail).trim() : "";
  const privateKey = typeof (obj.private_key ?? obj.privateKey) === "string" ? (obj.private_key ?? obj.privateKey) : "";
  if (!projectId || !clientEmail || !privateKey) return null;
  if (!privateKey.includes("BEGIN PRIVATE KEY")) return null;
  return { projectId, clientEmail, privateKey };
}

/**
 * Service account ke liye RS256 JWT banayein (Google OAuth2 ke
 * liye). Export is liye hai taake test JWT ki shakal + signature
 * jaanch sake. Kabhi throw nahi karta — kharab key par null.
 */
export function buildServiceAccountJwt(sa, nowMs = Date.now(), tokenUrl = FCM_DEFAULT_TOKEN_URL) {
  try {
    const iat = Math.floor(nowMs / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
      iss: sa.clientEmail,
      scope: FCM_TOKEN_SCOPE,
      aud: tokenUrl,
      exp: iat + 3600,
      iat,
    };
    const unsigned = base64url(JSON.stringify(header)) + "." + base64url(JSON.stringify(claims));
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(sa.privateKey);
    return unsigned + "." + base64url(signature);
  } catch {
    return null;
  }
}

// Access-token cache: aik client_email ke liye aik token. Token
// expiry se 5 minute pehle hi "expired" mana jata hai taake kabhi
// aakhri lamhe ka token istemal na ho.
let cachedToken = null; // { clientEmail, accessToken, expiresAtMs }
export function clearFcmTokenCache() {
  cachedToken = null;
}

async function fetchAccessToken(sa, { fetchFn, tokenEndpoint }) {
  const now = Date.now();
  if (
    cachedToken &&
    cachedToken.clientEmail === sa.clientEmail &&
    cachedToken.accessToken &&
    now < cachedToken.expiresAtMs - TOKEN_EARLY_REFRESH_MS
  ) {
    return { ok: true, accessToken: cachedToken.accessToken };
  }
  const url = tokenEndpoint || FCM_DEFAULT_TOKEN_URL;
  const jwt = buildServiceAccountJwt(sa, now, url);
  if (!jwt) return { ok: false, error: "fcm_auth_error" };
  const doFetch = fetchFn || fetch;
  let res;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:
        "grant_type=" +
        encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
        "&assertion=" +
        encodeURIComponent(jwt),
      signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "fcm_auth_error" };
  }
  let body = null;
  try {
    body = await res.json();
  } catch { /* JSON nahi — neeche error banega */ }
  if (!res.ok || !body || typeof body.access_token !== "string" || !body.access_token) {
    return { ok: false, error: "fcm_auth_error" };
  }
  const expiresInMs = Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 3600 * 1000;
  cachedToken = {
    clientEmail: sa.clientEmail,
    accessToken: body.access_token,
    expiresAtMs: Date.now() + expiresInMs,
  };
  return { ok: true, accessToken: body.access_token };
}

/**
 * Aik data-only push bhejein (HTTP v1).
 *
 * @param {object} opts
 * @param {object|string} opts.serviceAccount  Service account — parse
 *   ki hui {projectId, clientEmail, privateKey} ya poora JSON string.
 * @param {string} opts.token      Phone ka FCM registration token.
 * @param {object} [opts.data]     Data payload (type/reason/accountId).
 * @param {string} [opts.endpoint] Send endpoint — default HTTP v1 URL;
 *   test mein local stub ki taraf modne ke liye (server.mjs mein
 *   FCM_ENDPOINT env se aata hai; Render par kabhi set nahi karna).
 * @param {string} [opts.tokenEndpoint] OAuth2 token endpoint — default
 *   Google ka URL; test mein local stub ke liye (FCM_TOKEN_ENDPOINT
 *   env; Render par kabhi set nahi karna).
 * @param {function} [opts.fetchFn] fetch ka stub (unit test ke liye).
 * @returns {{ok:true, messageId: string|null} |
 *   {ok:false, error: string, tokenDead?: boolean}}
 *   Kabhi throw nahi karta — har ghalti {ok:false} ban kar wapas
 *   aati hai, taake caller (sync) kabhi push ki wajah se na toote.
 *   `tokenDead` sirf tab true hota hai jab Firebase kehta hai token
 *   ab maujood nahi (UNREGISTERED / NOT_FOUND) — caller use prune kare.
 */
export async function sendFcmPush({ serviceAccount, token, data, endpoint, tokenEndpoint, fetchFn }) {
  const sa = parseServiceAccount(serviceAccount);
  if (!sa) {
    return { ok: false, error: "fcm_not_configured" };
  }
  if (!token || typeof token !== "string" || !token.trim()) {
    return { ok: false, error: "no_token" };
  }
  const auth = await fetchAccessToken(sa, { fetchFn, tokenEndpoint });
  if (!auth.ok) {
    return { ok: false, error: auth.error };
  }
  const url = endpoint || fcmV1Endpoint(sa.projectId);
  const doFetch = fetchFn || fetch;
  let res;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + auth.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token: token.trim(),
          // High priority taake Doze mein bhi phone foran jaag kar
          // check-in kare — yehi poori push ka faida hai.
          android: { priority: "HIGH" },
          data: data && typeof data === "object" ? data : {},
        },
      }),
      signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
    });
  } catch {
    // Internet / DNS / timeout — token ya key is error mein kabhi
    // nahi aata (koi secret leak nahi).
    return { ok: false, error: "fcm_network_error" };
  }
  let body = null;
  try {
    body = await res.json();
  } catch { /* FCM ne JSON jawab nahi diya — koi baat nahi */ }
  if (!res.ok) {
    // Dead token pehchanein: HTTP v1 404 + NOT_FOUND, ya message
    // mein UNREGISTERED (J2-m21 — caller token prune kar dega).
    const errObj = body && typeof body.error === "object" ? body.error : null;
    const errStatus = errObj && typeof errObj.status === "string" ? errObj.status : "";
    const errMsg = errObj && typeof errObj.message === "string" ? errObj.message : "";
    if (
      res.status === 404 ||
      errStatus === "NOT_FOUND" ||
      errMsg.includes("UNREGISTERED") ||
      errMsg.includes("NotFound")
    ) {
      return { ok: false, error: "fcm_token_not_found", tokenDead: true };
    }
    return { ok: false, error: "fcm_http_" + res.status };
  }
  // HTTP v1 message ka naam deta hai ("projects/<id>/messages/<mid>").
  const messageId = body && typeof body.name === "string" ? body.name : null;
  return { ok: true, messageId };
}
