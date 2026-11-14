// FCM push — Firebase Cloud Messaging, legacy HTTP API (Wave 5.4, 15 Nov 2026).
// ============================================================
// Server phone ko push is liye bhejta hai taake payment / final
// payment ke baad phone FORAN check-in kare — 15 minute ke
// WorkManager tick ka intezar na ho (PU-M2 ka hissa).
//
// Push sirf "check-in karo" ka ishara hai (data-only message):
//   data = { type: "amg_checkin", reason: "unlocked"|"completed",
//            dashboardAccountId: "101" }
// Faisla hamesha check-in ka jawab karta hai, push ka data nahi —
// push mein koi lock/unlock faisla, koi code, koi raqam nahi hoti.
//
// Auth: Firebase console ki Cloud Messaging SERVER KEY, Render env
// var FCM_SERVER_KEY se aati hai (Mubeen ka step — key kabhi chat ya
// file mein nahi likhni). Key set na ho to server push bilkul nahi
// bhejta (no-op + aik log line) — sync kabhi push ki wajah se nakaam
// nahi hota.
//
// Ye module khud koi server nahi chalata — sirf sendFcmPush() deta
// hai, taake unit test mein fetch ko stub karke jaancha ja sake
// (unified-server-test.mjs, section Q). Koi dependency nahi — Node
// ka built-in fetch istemal hota hai.
//
// NOTE (legacy API): ye FCM ka purana HTTP API istemal karta hai
// (Authorization: key=<server key>). Naye Firebase projects mein
// legacy API kabhi kabhi default band hoti hai — tab Firebase console
// → Project Settings → Cloud Messaging mein use on karna parta hai
// (setup guide: hidden_files/fcm-setup-guide.md). Agar Firebase
// legacy API ko poori tarah band kar de to is module ko HTTP v1 API
// (service-account OAuth2) par badalna pare ga — sendFcmPush() ka
// signature tab bhi waisa hi rahe ga.
export const FCM_DEFAULT_ENDPOINT = "https://fcm.googleapis.com/fcm/send";

/**
 * Aik data-only push bhejein.
 *
 * @param {object} opts
 * @param {string} opts.serverKey  FCM server key (FCM_SERVER_KEY env).
 * @param {string} opts.token      Phone ka FCM registration token.
 * @param {object} [opts.data]     Data payload (type/reason/accountId).
 * @param {string} [opts.endpoint] FCM endpoint — default legacy URL;
 *   test mein local stub ki taraf modne ke liye (server.mjs mein
 *   FCM_ENDPOINT env se aata hai; Render par kabhi set nahi karna).
 * @param {function} [opts.fetchFn] fetch ka stub (unit test ke liye).
 * @returns {{ok:true, messageId: string|null} | {ok:false, error: string}}
 *   Kabhi throw nahi karta — har ghalti {ok:false} ban kar wapas
 *   aati hai, taake caller (sync) kabhi push ki wajah se na toote.
 */
export async function sendFcmPush({ serverKey, token, data, endpoint, fetchFn }) {
  if (!serverKey || typeof serverKey !== "string") {
    return { ok: false, error: "fcm_not_configured" };
  }
  if (!token || typeof token !== "string" || !token.trim()) {
    return { ok: false, error: "no_token" };
  }
  const url = endpoint || FCM_DEFAULT_ENDPOINT;
  const doFetch = fetchFn || fetch;
  let res;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: "key=" + serverKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: token.trim(),
        // High priority taake Doze mein bhi phone foran jaag kar
        // check-in kare — yehi poori push ka faida hai.
        priority: "high",
        data: data && typeof data === "object" ? data : {},
      }),
    });
  } catch {
    // Internet / DNS / timeout — server key ya token is error mein
    // kabhi nahi aata (koi secret leak nahi).
    return { ok: false, error: "fcm_network_error" };
  }
  let body = null;
  try {
    body = await res.json();
  } catch { /* FCM ne JSON jawab nahi diya — koi baat nahi */ }
  if (!res.ok) {
    return { ok: false, error: "fcm_http_" + res.status };
  }
  // Legacy API message_id deta hai (masalan "0:1234%abc...").
  const messageId = body && typeof body.message_id === "string" ? body.message_id : null;
  return { ok: true, messageId };
}
