// Звънец · Supabase Edge Function "push"
// Sends a phone notification to every student of a class when an editor saves a new test, homework or change.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name: push → paste this file → Deploy.
// Then open the function → Details → turn OFF "Verify JWT" → Save.
// Secrets (Edge Functions → Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and CRON_SECRET.
// Lesson reminders: push-lessons.sql makes Supabase call this function every minute during school hours.

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

function hhmm(t){ return String(t || '').slice(0, 5); }
/* table rows -> the state object the app uses */
function buildState(t){
  var st = t.settings[0] || {};
  var s = { v:1, rev: st.rev || 'r0', updated: st.updated_at || new Date().toISOString(), school: st.school || '', bells:{ '1':[], '2':[] }, classes:[], tt:{}, events:[], sample:{ classes:[] } };
  t.classes.forEach(function(c){ s.classes.push({ name:c.name, shift:c.shift }); });
  t.bells.slice().sort(function(a, b){ return a.shift - b.shift || a.idx - b.idx; }).forEach(function(b){
    (s.bells[String(b.shift)] = s.bells[String(b.shift)] || [])[b.idx] = { n:b.n, start:hhmm(b.start_time), end:hhmm(b.end_time) };
  });
  t.lessons.slice().sort(function(a, b){ return a.class_name < b.class_name ? -1 : a.class_name > b.class_name ? 1 : a.weekday - b.weekday || a.idx - b.idx; }).forEach(function(l){
    var c = s.tt[l.class_name] = s.tt[l.class_name] || {}, row = c[String(l.weekday)] = c[String(l.weekday)] || [];
    while (row.length < l.idx) row.push(null);
    row[l.idx] = { s:l.subject, r:l.room, t:l.teacher };
  });
  t.events.forEach(function(e){
    var x = { id:e.id, type:e.type, date:e.date, p:e.period, subject:e.subject, note:e.note, cls:e.classes || [] };
    if (e.all_school) x.all = true; if (e.cancel) x.cancel = true; if (e.room) x.room = e.room; if (e.substitute) x.sub = e.substitute;
    s.events.push(x);
  });
  return s;
}

// ---- lesson reminders: same rules as the app (holidays, changes, German groups) ----
const DE_L = /само\s+група\s*1|leistung/i;
function toMin(t) { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : NaN; }
function tNorm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[.\-]/g, ' ').replace(/\s+/g, ' ').trim(); }
function tKey(n) { const w = tNorm(n).split(' '); return (w.length > 1 ? w[0].charAt(0) + ' ' : '') + w[w.length - 1]; }
function splitTeachers(t, room) {
  const out = [];
  String(t || '').split(/\s*(?:·|\/)\s*/).forEach((p) => {
    p = p.trim(); let r = '', g = '';
    const m = /\(([^)]*)\)\s*$/.exec(p); if (m) { if (/\d/.test(m[1])) r = m[1].trim(); p = p.slice(0, m.index).trim(); }
    const gm = /^Гр\.?\s*(\d+)\s+/i.exec(p); if (gm) { g = 'гр. ' + gm[1]; p = p.slice(gm[0].length).trim(); }
    if (p.length < 4 || !/[А-ЯЁA-Z][а-яёa-z]/.test(p) || /^(само|група|гр\b)/i.test(p)) return;
    out.push({ name: p, room: r || room || '', group: g });
  });
  return out;
}
function isDE(cell) { return !!cell && /^немски/i.test(cell.s || ''); }
function deInfo(state, cls) {
  const tt = state.tt[cls] || {}, cnt = {}, names = {}, order = [], splits = [];
  let leistung = false;
  Object.keys(tt).forEach((d) => {
    (tt[d] || []).forEach((x) => {
      if (!isDE(x)) return;
      if (DE_L.test(x.t || '')) { leistung = true; return; }
      const ps = splitTeachers(x.t, x.r); if (ps.length < 2) return;
      splits.push(ps);
      ps.forEach((p) => { const k = tKey(p.name); if (!cnt[k]) { cnt[k] = 0; order.push(k); } cnt[k]++; if (!names[k] || p.name.length > names[k].length) names[k] = p.name; });
    });
  });
  if (!splits.length) return null;
  const size = Math.max(...splits.map((ps) => ps.length));
  const ranked = order.slice().sort((a, b) => cnt[b] - cnt[a]);
  const cut = cnt[ranked[Math.min(size, ranked.length) - 1]];
  const keys = order.filter((k) => cnt[k] >= cut);
  return keys.length >= 2 ? { keys, leistung } : null;
}
function deValid(info, p) { return !!info && !!p && info.keys.indexOf(p.t) >= 0 && (!info.leistung || typeof p.l === 'boolean'); }
function deSlot(x, info, p) {
  if (!isDE(x.cell) || (x.ch && x.ch.subject)) return x;
  const t = x.cell.t || '';
  if (DE_L.test(t)) {
    if (!info.leistung) return x;
    if (p.l === false && !x.ch) return { ...x, active: false };
    if (p.l === true && !x.teacherChanged) { const nm = splitTeachers(t, x.cell.r).map((q) => q.name).join(', '); return nm ? { ...x, teacher: nm } : x; }
    return x;
  }
  const ps = splitTeachers(t, x.cell.r); if (ps.length < 2) return x;
  let mine = ps.filter((q) => tKey(q.name) === p.t)[0];
  if (!mine) {
    const rest = ps.filter((q) => info.keys.indexOf(tKey(q.name)) < 0);
    const miss = info.keys.filter((k) => !ps.some((q) => tKey(q.name) === k));
    if (rest.length === 1 && miss.length === 1 && miss[0] === p.t) mine = rest[0];
  }
  if (!mine) return x;
  return { ...x, teacher: x.teacherChanged ? x.teacher : mine.name, room: x.roomChanged ? x.room : (mine.room || x.room) };
}
function lessonPlan(state, cls, iso) {
  const ci = state.classes.find((c) => c.name === cls);
  const bells = (ci && state.bells[String(ci.shift)]) || [];
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const row = (state.tt[cls] && state.tt[cls][dow]) || [];
  const evs = state.events.filter((e) => e.date === iso && (e.all || (e.cls || []).indexOf(cls) >= 0));
  if (evs.some((e) => e.type === 'holiday')) return [];
  return bells.map((b, i) => {
    const cell = row[i] || null;
    const ch = evs.filter((e) => e.type === 'change' && e.p === b.n)[0] || null;
    const has = !!(cell && (cell.s || cell.r || cell.t)) || !!(ch && ch.subject && !ch.cancel);
    return {
      n: b.n, start: toMin(b.start), end: toMin(b.end), bs: b.start, be: b.end, cell, ch,
      subject: (ch && ch.subject) || (cell && cell.s) || '',
      room: (ch && !ch.cancel && ch.room) || (cell && cell.r) || '',
      teacher: (ch && !ch.cancel && ch.sub) || (cell && cell.t) || '',
      roomChanged: !!(ch && !ch.cancel && ch.room), teacherChanged: !!(ch && !ch.cancel && ch.sub),
      active: has && !(ch && ch.cancel),
    };
  });
}
// when to remind: 10 min before the first lesson, then when the previous lesson ends
function reminders(slots) {
  const act = slots.filter((x) => x.active);
  return act.map((x, i) => ({ slot: x, first: i === 0, at: i === 0 ? x.start - 10 : act[i - 1].end }));
}
function bellMinutes(state) {
  const out = new Set();
  Object.keys(state.bells).forEach((k) => (state.bells[k] || []).forEach((b) => { out.add(toMin(b.start) - 10); out.add(toMin(b.end)); }));
  return out;
}
function lessonMessage(r) {
  const x = r.slot, subj = SHORT_SUBJ[x.subject] || x.subject || 'Час';
  const room = x.room ? (/^\d{1,4}[а-яa-z]?$/i.test(x.room) ? 'стая ' + x.room : x.room) + (x.roomChanged ? ' (смяна)' : '') : '';
  const teacher = splitTeachers(x.teacher, '').map((p) => p.name).join(', ') || x.teacher;
  const when = (r.first ? 'Първи час' : ordHour(x.n).replace(/^./, (c) => c.toUpperCase())) + ' · ' + x.bs + '–' + x.be;
  return { title: [subj, room].filter(Boolean).join(' · '), body: [when, teacher].filter(Boolean).join(' · '), tag: 'zv-lesson', url: './?p=now' };
}
function sofiaClock(now) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return toMin(p);
}

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
const VAPID_PUBLIC = (Deno.env.get('VAPID_PUBLIC_KEY') || '').trim();
const VAPID_PRIVATE = (Deno.env.get('VAPID_PRIVATE_KEY') || '').trim();
const SUBJECT = 'https://zvanets.app/';
const CRON_SECRET = (Deno.env.get('CRON_SECRET') || '').trim();
const PUSH_HOST = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\//;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-zv-cron', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

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
async function dbAll(path) {
  let out = [];
  for (let off = 0; ; off += 1000) {
    const rows = (await db('GET', path + '&limit=1000&offset=' + off)) || [];
    out = out.concat(rows);
    if (rows.length < 1000) return out;
  }
}
async function sendOne(sub, msg, opt) {
  if (!PUSH_HOST.test(sub.endpoint)) return { code: 400, detail: 'endpoint not allowed' };
  try {
    const body = await encryptPayload(sub.p256dh, sub.auth, ENC.encode(JSON.stringify(msg)));
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: await vapidHeader(sub.endpoint, VAPID_PUBLIC, VAPID_PRIVATE, SUBJECT), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String((opt && opt.ttl) || 86400), Urgency: (opt && opt.urgency) || 'normal' },
      body,
    });
    const detail = (await r.text().catch(() => '')).slice(0, 300);
    return { code: r.status, detail };
  } catch (err) {
    return { code: 0, detail: String(err && err.message || err).slice(0, 300) };
  }
}
async function sendAll(subs, msg, opt) {
  const res = { sent: 0, failed: 0, removed: 0 };
  for (let i = 0; i < subs.length; i += 50) {
    const part = subs.slice(i, i + 50);
    const codes = await Promise.all(part.map((s) => sendOne(s, typeof msg === 'function' ? msg(s) : msg, opt)));
    for (let j = 0; j < part.length; j++) {
      const c = codes[j].code;
      if (c >= 200 && c < 300) res.sent++;
      else if (c === 404 || c === 410) {
        res.removed++;
        await db('DELETE', 'push_subs?endpoint=eq.' + encodeURIComponent(part[j].endpoint)).catch(() => null);
      } else res.failed++;
    }
  }
  return res;
}

let cache = null;
async function staticRows() {
  if (cache && Date.now() - cache.at < 10 * 60e3) return cache;
  const [bells, classes] = await Promise.all([db('GET', 'bells?select=*&order=shift,idx'), db('GET', 'classes?select=name,shift')]);
  cache = { at: Date.now(), bells: bells || [], classes: classes || [] };
  return cache;
}
async function tick(now) {
  const iso = sofiaToday(now), [y, mo, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  if (dow === 0 || dow === 6 || mo === 7 || mo === 8 || (mo === 9 && d < 15)) return { skipped: 'no school' };
  const M = sofiaClock(now), st = await staticRows();
  const base = buildState({ settings: [{}], classes: st.classes, bells: st.bells, lessons: [], events: [] });
  const mins = bellMinutes(base);
  if (![M, M - 1, M - 2].some((m) => mins.has(m))) return { skipped: 'no bell' };
  const subs = await dbAll('push_subs?select=endpoint,p256dh,auth,class_name,de_t,de_l&lessons=is.true&order=endpoint');
  if (!subs.length) return { skipped: 'no subscribers' };
  const classes = [...new Set(subs.map((s) => s.class_name))];
  const inList = classes.map((c) => encodeURIComponent('"' + String(c).replace(/"/g, '') + '"')).join(',');
  const [lessons, events] = await Promise.all([
    dbAll('lessons?select=*&class_name=in.(' + inList + ')&order=class_name,weekday,idx'),
    dbAll('events?select=*&date=eq.' + iso + '&order=id'),
  ]);
  const state = buildState({ settings: [{}], classes: st.classes, bells: st.bells, lessons, events });
  const due = [];
  for (const cls of classes) {
    const info = deInfo(state, cls), plan = lessonPlan(state, cls, iso), groups = {};
    for (const s of subs.filter((x) => x.class_name === cls)) {
      const pref = { t: s.de_t, l: s.de_l }, ok = deValid(info, pref);
      const key = ok ? pref.t + '|' + pref.l : 'all';
      (groups[key] = groups[key] || { pref: ok ? pref : null, subs: [] }).subs.push(s);
    }
    for (const key of Object.keys(groups)) {
      const g = groups[key], slots = g.pref ? plan.map((x) => deSlot(x, info, g.pref)) : plan;
      for (const r of reminders(slots)) if (r.at <= M && r.at >= M - 2) due.push({ key: iso + '|' + cls + '|' + r.slot.n + '|' + key, r, subs: g.subs });
    }
  }
  if (!due.length) return { due: 0 };
  const h = { apikey: serverKey(), 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' };
  if (/^eyJ/.test(h.apikey)) h.Authorization = 'Bearer ' + h.apikey;
  const cr = await fetch(SB_URL + '/rest/v1/push_sent?on_conflict=key', { method: 'POST', headers: h, body: JSON.stringify(due.map((x) => ({ key: x.key }))) });
  if (!cr.ok) throw new Error('push_sent: HTTP ' + cr.status + ' ' + (await cr.text()));
  const fresh = new Set(((await cr.json()) || []).map((x) => x.key));
  const total = { due: due.length, sent: 0, failed: 0, removed: 0 };
  for (const x of due) {
    if (!fresh.has(x.key)) continue;
    const res = await sendAll(x.subs, lessonMessage(x.r), { ttl: 900, urgency: 'high' });
    total.sent += res.sent; total.failed += res.failed; total.removed += res.removed;
  }
  await db('DELETE', 'push_sent?at=lt.' + encodeURIComponent(new Date(now.getTime() - 3 * 86400e3).toISOString())).catch(() => null);
  return total;
}

async function health() {
  const out = { function: 'push', vapid_keys: !!(VAPID_PUBLIC && VAPID_PRIVATE), vapid_pair_ok: false, cron_secret: !!CRON_SECRET, server_key: !!serverKey(), database: '', subscribers: null };
  try {
    const pub = b64uDecode(VAPID_PUBLIC), algo = { name: 'ECDSA', namedCurve: 'P-256' }, data = ENC.encode('zvanets');
    const priv = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), d: VAPID_PRIVATE, ext: true }, algo, false, ['sign']);
    const pubKey = await crypto.subtle.importKey('raw', pub, algo, false, ['verify']);
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, data);
    out.vapid_pair_ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, sig, data);
  } catch (err) { out.vapid_error = String(err && err.message || err); }
  try {
    const rows = await dbAll('push_subs?select=class_name,lessons&order=class_name');
    out.database = 'ok'; out.subscribers = rows.length; out.by_class = {};
    rows.forEach((r) => { out.by_class[r.class_name] = (out.by_class[r.class_name] || 0) + 1; });
  } catch (err) { out.database = String(err && err.message || err).slice(0, 300); }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method === 'GET') return json(await health());
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return json({ error: 'Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Edge Functions → Secrets.' }, 500);
  let input;
  try { input = await req.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
  try {
    if (input.tick) {
      if (!CRON_SECRET || req.headers.get('x-zv-cron') !== CRON_SECRET) return json({ error: 'forbidden' }, 403);
      const fake = Deno.env.get('ZV_FAKE_NOW');
      return json(await tick(fake ? new Date(fake) : new Date()));
    }
    if (typeof input.test === 'string') {
      const subs = await db('GET', 'push_subs?select=endpoint,p256dh,auth&endpoint=eq.' + encodeURIComponent(input.test));
      if (!subs || !subs.length) return json({ error: 'unknown subscription' }, 404);
      const res = await sendOne(subs[0], { title: 'Звънец', body: 'Известията работят. Ще получаваш следващия час и стаята, и известие при нов тест, домашно или промяна.', tag: 'zv-test', url: './' });
      return json({ status: res.code, detail: res.detail });
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
