// Звънец · Supabase Edge Function "push"
// Sends a phone notification to every student of a class when an editor saves a new test, homework or change.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name: push → paste this file → Deploy.
// Then open the function → Details → turn OFF "Verify JWT" → Save.
// Secrets (Edge Functions → Secrets): VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.

const ENC = new TextEncoder();
const TYPE_LABEL = { test: 'Тест', entry: 'Входен тест', control: 'Контролна работа', classwork: 'Класна работа', oral: 'Изпитване', project: 'Домашно', event: 'Събитие', change: 'Промяна в програмата', holiday: 'Неучебен ден' };
const TEST_TYPES = ['test', 'entry', 'control', 'classwork', 'oral'];
const SHORT_SUBJ = { 'Химия и опазване на околната среда': 'Химия', 'Физика и астрономия': 'Физика', 'Биология и здравно образование': 'Биология', 'Български език и литература': 'Български език', 'Физическо възпитание и спорт': 'Физическо', 'География и икономика': 'География', 'История и цивилизации': 'История', 'Информационни технологии': 'ИТ' };
const WEEKDAYS = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'];
const MONTHS_G = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];

function b64uEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

async function encryptPayload(p256dh, auth, plaintext, fixed) {
  const uaPublic = b64uDecode(p256dh);
  const authSecret = b64uDecode(auth);
  let asPrivate, asPublic;
  if (fixed && fixed.asPrivate) {
    asPublic = b64uDecode(fixed.asPublic);
    const jwk = { kty: 'EC', crv: 'P-256', x: b64uEncode(asPublic.slice(1, 33)), y: b64uEncode(asPublic.slice(33, 65)), d: fixed.asPrivate, ext: true };
    asPrivate = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));
  const ikm = await hkdf(authSecret, shared, concat(ENC.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = fixed && fixed.salt ? b64uDecode(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, ENC.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, ENC.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

async function vapidHeader(endpoint, publicKey, privateKey, subject, nowSec) {
  const pub = b64uDecode(publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), d: privateKey, ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const now = nowSec || Math.floor(Date.now() / 1000);
  const head = b64uEncode(ENC.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64uEncode(ENC.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub: subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, ENC.encode(head + '.' + body)));
  return 'vapid t=' + head + '.' + body + '.' + b64uEncode(sig) + ', k=' + publicKey;
}

function sofiaToday(now) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now || new Date());
  return p.slice(0, 10);
}
function dayText(iso, todayIso) {
  const [y, m, d] = iso.split('-').map(Number);
  const [ty, tm, td] = todayIso.split('-').map(Number);
  const diff = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const date = d + ' ' + MONTHS_G[m - 1];
  if (diff === 0) return 'днес, ' + date;
  if (diff === 1) return 'утре, ' + wd;
  return wd + ', ' + date;
}
function ordHour(n) {
  if (n === 0) return 'нулев час';
  return n + '-' + (n === 1 ? 'ви' : n === 2 ? 'ри' : (n === 7 || n === 8) ? 'ми' : 'ти') + ' час';
}
function clip(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function describe(e, todayIso) {
  const who = e.all_school ? 'Цялото училище' : (e.classes || []).join(', ');
  const subj = SHORT_SUBJ[e.subject] || e.subject || '';
  const day = dayText(e.date, todayIso);
  const hour = e.period == null ? '' : ordHour(e.period);
  const join = (...xs) => xs.filter(Boolean).join(' · ');
  let title, body, page = 'now';
  if (e.type === 'project') {
    title = who + ' · Домашно';
    body = join(subj, 'за ' + day) + (e.note ? '\n' + clip(e.note, 160) : '');
    page = 'hw';
  } else if (TEST_TYPES.indexOf(e.type) >= 0) {
    title = who + ' · ' + TYPE_LABEL[e.type];
    body = join(subj, day, hour) + (e.note ? '\n' + clip(e.note, 120) : '');
    page = 'tests';
  } else if (e.type === 'change') {
    if (e.cancel) { title = who + ' · Отменен час'; body = join(hour + (subj ? ' (' + subj + ')' : ''), day); }
    else if (e.room) { title = who + ' · Смяна на стая'; body = join(hour + (subj ? ' (' + subj + ')' : ''), day, 'стая ' + e.room); }
    else if (e.substitute) { title = who + ' · Заместване'; body = join(hour + (subj ? ' (' + subj + ')' : ''), day, e.substitute); }
    else { title = who + ' · Промяна в програмата'; body = join(hour, subj, day); }
    if (e.note) body += '\n' + clip(e.note, 120);
  } else if (e.type === 'holiday') {
    title = (e.all_school ? '' : who + ' · ') + 'Неучебен ден';
    body = join(day, e.subject || '');
  } else {
    title = who + ' · ' + (TYPE_LABEL[e.type] || 'Събитие');
    body = join(subj, day, hour) + (e.note ? '\n' + clip(e.note, 120) : '');
    page = 'tests';
  }
  return { title: clip(title, 80), body: clip(body.split('\n')[0], 140) + (body.indexOf('\n') >= 0 ? '\n' + body.split('\n').slice(1).join(' ') : ''), tag: 'zv-' + e.id, url: './?p=' + page };
}

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const VAPID_PUBLIC = (Deno.env.get('VAPID_PUBLIC_KEY') || '').trim();
const VAPID_PRIVATE = (Deno.env.get('VAPID_PRIVATE_KEY') || '').trim();
const SUBJECT = 'https://zvanets.app/';
const PUSH_HOST = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\//;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };

function serverKey() {
  try { const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); if (k && k.default) return k.default; } catch (_) {}
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
}
function json(o, status) {
  return new Response(JSON.stringify(o), { status: status || 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
async function db(method, path, body) {
  const key = serverKey();
  const h = { apikey: key, 'Content-Type': 'application/json' };
  if (/^eyJ/.test(key)) h.Authorization = 'Bearer ' + key;
  const r = await fetch(SB_URL + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(path.split('?')[0] + ': HTTP ' + r.status + ' ' + t);
  return t ? JSON.parse(t) : null;
}
async function sendOne(sub, msg) {
  if (!PUSH_HOST.test(sub.endpoint)) return 400;
  try {
    const body = await encryptPayload(sub.p256dh, sub.auth, ENC.encode(JSON.stringify(msg)));
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: await vapidHeader(sub.endpoint, VAPID_PUBLIC, VAPID_PRIVATE, SUBJECT), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
      body,
    });
    await r.arrayBuffer().catch(() => null);
    return r.status;
  } catch (_) {
    return 0;
  }
}
async function sendAll(subs, msg) {
  const res = { sent: 0, failed: 0, removed: 0 };
  for (let i = 0; i < subs.length; i += 50) {
    const part = subs.slice(i, i + 50);
    const codes = await Promise.all(part.map((s) => sendOne(s, msg)));
    for (let j = 0; j < part.length; j++) {
      const c = codes[j];
      if (c >= 200 && c < 300) res.sent++;
      else if (c === 404 || c === 410) {
        res.removed++;
        await db('DELETE', 'push_subs?endpoint=eq.' + encodeURIComponent(part[j].endpoint)).catch(() => null);
      } else res.failed++;
    }
  }
  return res;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return json({ error: 'Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Edge Functions → Secrets.' }, 500);
  let input;
  try { input = await req.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
  try {
    if (typeof input.test === 'string') {
      const subs = await db('GET', 'push_subs?select=endpoint,p256dh,auth&endpoint=eq.' + encodeURIComponent(input.test));
      if (!subs || !subs.length) return json({ error: 'unknown subscription' }, 404);
      const code = await sendOne(subs[0], { title: 'Звънец', body: 'Известията работят. Ще ти пишем при нов тест, домашно или промяна.', tag: 'zv-test', url: './' });
      return json({ status: code });
    }
    const ids = Array.isArray(input.ids) ? input.ids.filter((x) => typeof x === 'string').slice(0, 50) : [];
    if (!ids.length) return json({ events: 0, sent: 0 });
    const r = await fetch(SB_URL + '/rest/v1/rpc/push_claim', {
      method: 'POST',
      headers: { apikey: req.headers.get('apikey') || '', Authorization: req.headers.get('authorization') || '', 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_ids: ids }),
    });
    if (!r.ok) return json({ error: 'push_claim: HTTP ' + r.status, detail: await r.text() }, r.status === 401 ? 401 : 502);
    const events = (await r.json()) || [];
    const today = sofiaToday();
    const total = { events: events.length, sent: 0, failed: 0, removed: 0 };
    for (const e of events) {
      if (!e.all_school && !(e.classes || []).length) continue;
      const filter = e.all_school ? '' : '&class_name=in.(' + e.classes.map((c) => encodeURIComponent('"' + String(c).replace(/"/g, '') + '"')).join(',') + ')';
      const subs = (await db('GET', 'push_subs?select=endpoint,p256dh,auth' + filter)) || [];
      const res = await sendAll(subs, describe(e, today));
      total.sent += res.sent; total.failed += res.failed; total.removed += res.removed;
    }
    return json(total);
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 500);
  }
});
