// F3 "Take this Q" — Netlify Serverless Function
// Works with Netlify Drop (no CLI or GitHub required)
//
// Lets a PAX claim an open Q from a region website:
//   1. The "Take this Q" button links here with eventInstanceId + regionOrgId.
//   2. We send them to "Sign in with Slack", locked to the region's workspace.
//   3. Slack sends them back here. We check they signed in to THAT region's
//      Slack, find their F3 Nation user by their Slack email, check the
//      workout is in that region, upcoming and not closed, then call
//      F3 Nation's take-q on their behalf with the region's editor API key.
//
// F3 Nation's take-q refuses if someone already holds the Q, so this can
// never knock out an existing Q.
//
// ── Setup (Netlify → Site configuration → Environment variables) ──────────
//   SLACK_CLIENT_ID      Slack app → Basic Information → Client ID
//   SLACK_CLIENT_SECRET  Slack app → Basic Information → Client Secret
//   Q_SIGNING_SECRET     any long random string (signs the login round-trip)
//   Q_REGIONS            which regions are switched on, and each one's Slack
//                        workspace (team) ID:  25273=T0123ABCD,25250=T0456EFGH
//   F3_Q_KEY_<regionId>  an F3 Nation API key with the EDITOR (or ADMIN)
//                        role on that region, set on the key itself, e.g. F3_Q_KEY_25273.
//                        F3_Q_KEY is used for any region without its own.
//   Q_TIMEZONE           optional, default America/New_York — decides what
//                        "today" is when refusing past workouts.
//
// The Slack app needs "Sign in with Slack" (OpenID: openid, email, profile)
// and this redirect URL:
//   https://<your-site>.netlify.app/.netlify/functions/q-take
//
// Query params:
//   eventInstanceId + regionOrgId  — start: send the PAX to Slack
//   ret                            — optional same-site path to return to
//   check=1 + regionOrgId          — JSON { enabled } so a page can hide
//                                    the button when a region isn't set up
//   code + state                   — Slack's redirect back (callback)

const crypto = require('crypto');

const API = 'https://api.f3nation.com/v1';
const SLACK_AUTHORIZE = 'https://slack.com/openid/connect/authorize';
const SLACK_TOKEN = 'https://slack.com/api/openid.connect.token';
const STATE_TTL_MS = 10 * 60 * 1000;
const NONCE_COOKIE = 'f3q_nonce';

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  try {
    if (q.check) return checkEnabled(q);
    if (q.error) return page(400, 'Slack sign-in was cancelled', 'No Q was taken. You can close this tab or go back and try again.', safeReturn(null));
    if (q.code || q.state) return await callback(event, q);
    return start(event, q);
  } catch (err) {
    console.error('[q-take] failed:', err && err.message);
    return page(500, 'Something went wrong', 'No Q was taken. Please try again, or ask your region\'s Weasel Shaker to sign you up.', safeReturn(null));
  }
};

// ── config ────────────────────────────────────────────────────────────────
function regions() {
  const out = {};
  // "25273=T0ABC1234" or "25273:T0ABC1234", comma-separated
  for (const part of (process.env.Q_REGIONS || '').split(',')) {
    const [rid, team] = part.split(/[=:]/).map((s) => (s || '').trim());
    if (/^\d+$/.test(rid) && team) out[rid] = team.toUpperCase(); // Slack IDs are uppercase
  }
  return out;
}
function keyFor(regionId) {
  return process.env[`F3_Q_KEY_${regionId}`] || process.env.F3_Q_KEY || '';
}
function regionReady(regionId) {
  return !!(regions()[regionId] && keyFor(regionId) &&
    process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET && process.env.Q_SIGNING_SECRET);
}
function siteOrigin(event) {
  if (process.env.URL) return process.env.URL.replace(/\/+$/, '');
  const h = event.headers || {};
  const proto = (h['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${proto}://${h.host}`;
}
function redirectUri(event) {
  return `${siteOrigin(event)}/.netlify/functions/q-take`;
}

// ── check=1 ───────────────────────────────────────────────────────────────
function checkEnabled(q) {
  const rid = String(q.regionOrgId || '').trim();
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' },
    body: JSON.stringify({ enabled: /^\d+$/.test(rid) && regionReady(rid) }),
  };
}

// ── step 1: send to Slack ─────────────────────────────────────────────────
function start(event, q) {
  const eid = String(q.eventInstanceId || '').trim();
  const rid = String(q.regionOrgId || '').trim();
  const ret = safeReturn(q.ret);
  if (!/^\d+$/.test(eid) || !/^\d+$/.test(rid)) {
    return page(400, 'Missing workout', 'This link is missing the workout or region. Go back and press "Take this Q" again.', ret);
  }
  if (!regionReady(rid)) {
    return page(503, 'Not switched on for this region', 'Taking a Q from the website isn\'t set up for this region yet. Use Slack to sign up as Q.', ret);
  }

  const nonce = b64url(crypto.randomBytes(18));
  const state = sign({ e: Number(eid), r: Number(rid), ret, n: nonce, x: Date.now() + STATE_TTL_MS });

  const url = SLACK_AUTHORIZE + '?' + new URLSearchParams({
    response_type: 'code',
    scope: 'openid email profile',
    client_id: process.env.SLACK_CLIENT_ID,
    redirect_uri: redirectUri(event),
    state,
    nonce,
    team: regions()[rid], // pre-selects the region's workspace
  }).toString();

  return {
    statusCode: 302,
    headers: {
      Location: url,
      'Set-Cookie': `${NONCE_COOKIE}=${nonce}; Path=/.netlify/functions/q-take; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
      'Cache-Control': 'no-store',
    },
    body: '',
  };
}

// ── step 2: Slack sent them back ─────────────────────────────────────────
async function callback(event, q) {
  const st = verify(q.state);
  const ret = safeReturn(st && st.ret);
  if (!st || !q.code) return page(400, 'Sign-in link expired', 'That sign-in didn\'t complete. Go back and press "Take this Q" again.', ret);
  if (Date.now() > st.x) return page(400, 'Sign-in link expired', 'That took longer than 10 minutes. Go back and press "Take this Q" again.', ret);

  const cookieNonce = readCookie(event, NONCE_COOKIE);
  if (!cookieNonce || cookieNonce !== st.n) {
    return page(400, 'Sign-in didn\'t match', 'Please start again from the same browser you pressed "Take this Q" in.', ret);
  }

  const rid = String(st.r);
  const eid = st.e;
  const team = regions()[rid];
  const key = keyFor(rid);
  if (!team || !key) return page(503, 'Not switched on for this region', 'Taking a Q from the website isn\'t set up for this region.', ret);

  // Exchange the code for Slack's ID token (straight from Slack over TLS,
  // authenticated with our client secret — OIDC Core 3.1.3.7 lets us rely
  // on TLS here instead of checking the token signature).
  const tokRes = await fetch(SLACK_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code: q.code,
      redirect_uri: redirectUri(event),
    }).toString(),
  });
  const tok = await tokRes.json().catch(() => ({}));
  if (!tok.ok || !tok.id_token) {
    console.error('[q-take] slack token exchange failed:', tok.error);
    return page(502, 'Slack sign-in failed', 'Slack didn\'t confirm who you are. Please try again.', ret);
  }

  const claims = decodeJwt(tok.id_token);
  const now = Math.floor(Date.now() / 1000);
  if (!claims || claims.iss !== 'https://slack.com' || claims.aud !== process.env.SLACK_CLIENT_ID ||
      claims.nonce !== st.n || !(claims.exp > now)) {
    return page(400, 'Slack sign-in failed', 'Slack\'s answer didn\'t check out. Please try again.', ret);
  }

  // Must be signed in to THIS region's Slack.
  const signedTeam = claims['https://slack.com/team_id'];
  if (signedTeam !== team) {
    const teamName = claims['https://slack.com/team_name'] || 'another workspace';
    return page(403, 'Wrong Slack workspace',
      `You signed in to ${esc(teamName)} (${esc(signedTeam || 'unknown')}). Only members of this region's Slack can take its Qs here. ` +
      'If you\'re in more than one F3 Slack, sign in again and pick this region\'s.', ret);
  }
  if (!claims.email || claims.email_verified === false) {
    return page(403, 'No email from Slack', 'Slack didn\'t share a verified email for you, so we can\'t find your F3 profile.', ret);
  }

  const f3 = { Authorization: `Bearer ${key}`, client: 'f3-take-q' };

  // Slack email -> F3 Nation user
  const userRes = await fetch(`${API}/user/email/${encodeURIComponent(claims.email)}?includePii=false`, { headers: f3 });
  if (userRes.status === 404) {
    return page(404, 'No F3 profile for your Slack email',
      `We couldn't find an F3 Nation profile with ${esc(claims.email)}. Make sure your F3 profile uses the same email as Slack, or sign up as Q in Slack.`, ret);
  }
  if (!userRes.ok) return page(502, 'F3 Nation didn\'t answer', `Couldn't look up your profile (HTTP ${userRes.status}). Please try again.`, ret);
  const userRaw = await userRes.json();
  const user = (userRaw && userRaw.user) || userRaw || {};
  const userId = Number(user.id);
  if (!userId) return page(502, 'F3 Nation didn\'t answer', 'Your profile came back without an ID. Please try again.', ret);
  const who = user.f3Name || claims.name || 'you';

  // The workout: real, in this region, upcoming, not closed.
  const evRes = await fetch(`${API}/event-instance/id/${eid}`, { headers: f3 });
  if (evRes.status === 404) return page(404, 'Workout not found', 'That workout no longer exists.', ret);
  if (!evRes.ok) return page(502, 'F3 Nation didn\'t answer', `Couldn't load the workout (HTTP ${evRes.status}). Please try again.`, ret);
  const evRaw = await evRes.json();
  const ev = (evRaw && evRaw.eventInstance) || evRaw || {};
  const evRegion = ev.org && ev.org.parentId != null ? ev.org.parentId : ev.orgId;
  const label = `${ev.org && ev.org.name ? ev.org.name : (ev.name || 'this workout')} on ${fmtDate(ev.startDate)}${ev.startTime ? ' at ' + fmtTime(ev.startTime) : ''}`;

  if (String(evRegion) !== rid) return page(403, 'Not this region\'s workout', 'That workout belongs to a different region.', ret);
  if (ev.isActive === false || ev.seriesException === 'closed') return page(409, 'Workout is closed', `${esc(label)} is closed, so it doesn't need a Q.`, ret);
  if (!ev.startDate || ev.startDate < localToday()) return page(409, 'That workout has passed', `${esc(label)} is in the past.`, ret);

  // Take it. F3 Nation refuses if someone else already holds the Q.
  const takeRes = await fetch(`${API}/attendance/take-q`, {
    method: 'POST',
    headers: { ...f3, 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventInstanceId: eid, userId }),
  });
  if (!takeRes.ok) {
    const body = await takeRes.json().catch(() => ({}));
    const msg = String(body.message || '');
    console.error('[q-take] take-q refused:', takeRes.status, msg);
    if (takeRes.status === 409 || /already|another|other q/i.test(msg)) {
      return page(409, 'Someone beat you to it', `${esc(label)} already has a Q.`, ret);
    }
    if (takeRes.status === 401 || takeRes.status === 403) {
      return page(502, 'Not set up correctly', 'The website\'s F3 Nation key isn\'t allowed to sign up Qs for this region. Let your region\'s admin know.', ret);
    }
    return page(502, 'F3 Nation said no', `The Q wasn't taken (HTTP ${takeRes.status}). Please try again or sign up in Slack.`, ret);
  }

  console.log('[q-take] Q taken', JSON.stringify({ eventInstanceId: eid, userId, regionOrgId: rid, slackUser: claims.sub }));
  return page(200, 'You\'re the Q!', `Thanks, ${esc(who)}. You're down as Q for <b>${esc(label)}</b>. Don't forget to post your preblast.`, ret, true);
}

// ── helpers ───────────────────────────────────────────────────────────────
function sign(obj) {
  const body = b64url(Buffer.from(JSON.stringify(obj)));
  return body + '.' + b64url(crypto.createHmac('sha256', process.env.Q_SIGNING_SECRET).update(body).digest());
}
function verify(state) {
  if (!state || typeof state !== 'string' || !process.env.Q_SIGNING_SECRET) return null;
  const [body, mac] = state.split('.');
  if (!body || !mac) return null;
  const want = b64url(crypto.createHmac('sha256', process.env.Q_SIGNING_SECRET).update(body).digest());
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}
function decodeJwt(t) {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function readCookie(event, name) {
  const h = event.headers || {};
  const raw = h.cookie || h.Cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
// Only same-site paths — never an open redirect.
function safeReturn(ret) {
  return typeof ret === 'string' && /^\/(?![\/\\])/.test(ret) ? ret.slice(0, 500) : null;
}
function localToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.Q_TIMEZONE || 'America/New_York' }).format(new Date());
}
function fmtDate(d) {
  if (!d) return 'an unknown date';
  const dt = new Date(d + 'T12:00:00Z');
  return isNaN(dt) ? d : dt.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function fmtTime(t) {
  const s = String(t).replace(':', '');
  if (!/^\d{4}$/.test(s)) return String(t);
  let h = +s.slice(0, 2);
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${s.slice(2)}${ap}`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// `msg` may contain trusted markup (<b>); every dynamic value inside it is
// passed through esc() by the caller.
function page(statusCode, title, msg, ret, ok) {
  const back = ret ? `<a class="btn" href="${esc(ret)}">Back</a>` : '';
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Set-Cookie': `${NONCE_COOKIE}=; Path=/.netlify/functions/q-take; Max-Age=0; HttpOnly; Secure; SameSite=Lax` },
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#e5e5e5;color:#111;padding:40px 16px;display:flex;justify-content:center}
.card{background:#fff;border:1px solid #ddd;border-top:6px solid ${ok ? '#1a6b35' : '#c8102e'};max-width:460px;width:100%;padding:24px 22px}
h1{font-size:22px;font-weight:800;margin-bottom:10px}p{font-size:15px;line-height:1.5;color:#333;overflow-wrap:anywhere}
.btn{display:inline-block;margin-top:18px;background:#111;color:#fff;text-decoration:none;font-weight:800;font-size:12px;letter-spacing:.08em;text-transform:uppercase;padding:12px 18px;border-radius:8px}
</style></head><body><div class="card"><h1>${esc(title)}</h1><p>${msg}</p>${back}</div></body></html>`,
  };
}
