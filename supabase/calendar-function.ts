// Звънец · Supabase Edge Function "calendar"
// Returns one class's timetable as a subscribable calendar (.ics) with an alert before every lesson.
// URL: https://YOUR-PROJECT.supabase.co/functions/v1/calendar?class=10e   (10a for 10а)
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name: calendar → paste this file → Deploy.
// Then open the function → turn OFF "Verify JWT" (Enforce JWT verification) → Save. Calendar apps can't log in.

// ---- shared calendar code (same as lib.js in the app) ----
const module = { exports: {} };
/* Звънец · общи функции: календар (.ics) за известия и подреден data.json */
(function (root) {
  'use strict';

  var BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  var TR = { 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sht', 'ъ': 'a', 'ь': 'y', 'ю': 'yu', 'я': 'ya' };
  var SHORT = { 'Химия и опазване на околната среда': 'Химия', 'Физика и астрономия': 'Физика', 'Биология и здравно образование': 'Биология', 'Български език и литература': 'Български език', 'Физическо възпитание и спорт': 'Физическо', 'География и икономика': 'География', 'История и цивилизации': 'История', 'Информационни технологии': 'ИТ' };
  var LABELS = { test: 'Тест', entry: 'Входен тест', control: 'Контролна работа', classwork: 'Класна работа', oral: 'Изпитване', project: 'Домашно', event: 'Събитие' };
  var TZ = [
    'BEGIN:VTIMEZONE', 'TZID:Europe/Sofia',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0300', 'TZNAME:EEST', 'DTSTART:19700329T030000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0200', 'TZNAME:EET', 'DTSTART:19701025T040000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE'
  ];

  function slug(name) {
    var out = '';
    String(name || '').toLowerCase().split('').forEach(function (c) {
      if (TR[c] != null) out += TR[c];
      else if (/[a-z0-9]/.test(c)) out += c;
      else out += '-';
    });
    return out.replace(/-+/g, '-').replace(/^-|-$/g, '') || 'klas';
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
  function parseISO(s) { var p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(d, n) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
  function toMin(t) { var m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : NaN; }
  function hm(t) { var m = toMin(t); return pad(Math.floor(m / 60)) + pad(m % 60) + '00'; }
  function ord(n) { if (n === 0) return 'нулев'; return n + '-' + (n === 1 ? 'ви' : n === 2 ? 'ри' : (n === 7 || n === 8) ? 'ми' : 'ти'); }
  function short(s) { return SHORT[s] || s || ''; }
  function roomLabel(r) { r = String(r || '').trim(); return /^\d{1,4}[а-яa-z]?$/i.test(r) ? 'стая ' + r : r; }
  function txt(t) { return String(t == null ? '' : t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  function u8len(ch) { var c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  function fold(line) {
    var out = [], cur = '', bytes = 0;
    Array.from(line).forEach(function (ch) {
      var b = u8len(ch);
      if (bytes + b > 75) { out.push(cur); cur = ' ' + ch; bytes = 1 + b; }
      else { cur += ch; bytes += b; }
    });
    out.push(cur);
    return out.join('\r\n');
  }
  function stampUTC(d) {
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }
  function forClass(e, name) { return e.all || (e.cls || []).indexOf(name) >= 0; }
  function alarm(lines, text, trigger) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + txt(text), 'TRIGGER:' + trigger, 'END:VALARM');
  }

  /* Календар за един клас: всеки час се повтаря всяка седмица, известието идва,
     когато свърши предишният час (10 мин преди първия). Тестовете са целодневни
     събития с известие в 19:00 предната вечер. Неучебните дни махат часовете. */
  function buildICS(s, cls, now) {
    now = now || new Date();
    var ci = null;
    (s.classes || []).forEach(function (c) { if (c.name === cls) ci = c; });
    var bells = (s.bells && s.bells[String(ci ? ci.shift : 2)]) || [];
    var tt = (s.tt && s.tt[cls]) || {};
    var sl = slug(cls), stamp = stampUTC(now);
    var dow0 = now.getDay(), mon = addDays(now, dow0 === 0 ? -6 : 1 - dow0);
    var y = now.getFullYear(), mo = now.getMonth() + 1, d = now.getDate();
    var term1 = mo >= 8 || mo === 1 || (mo === 2 && d <= 5);
    var until = term1 ? (mo >= 8 ? y + 1 : y) + '0205T215959Z' : y + '0630T205959Z';
    var evs = (s.events || []).filter(function (e) { return forClass(e, cls) && /^\d{4}-\d{2}-\d{2}$/.test(e.date || ''); });
    var holidays = evs.filter(function (e) { return e.type === 'holiday'; }).map(function (e) { return e.date; });

    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Zvanets//' + sl + '//BG', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:' + txt(cls + ' · Звънец'), 'X-WR-TIMEZONE:Europe/Sofia', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'].concat(TZ);

    var lessons = {};
    for (var dow = 1; dow <= 5; dow++) {
      var row = tt[dow] || tt[String(dow)] || [], prevEnd = null, date = addDays(mon, dow - 1);
      bells.forEach(function (b, i) {
        var x = row[i];
        if (!x || !(x.s || x.r || x.t)) return;
        var st = toMin(b.start), en = toMin(b.end);
        var gap = prevEnd == null ? 10 : Math.max(0, st - prevEnd);
        var subj = short(x.s) || 'Час', room = x.r ? roomLabel(x.r) : '';
        var sum = subj + (room ? ' · ' + room : '');
        var uid = 'zv' + sl + '-' + BYDAY[dow] + '-' + b.n + '@zvanets';
        lessons[dow + '|' + b.n] = { uid: uid, b: b, x: x, gap: gap };
        L.push('BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stamp,
          'DTSTART;TZID=Europe/Sofia:' + ymd(date) + 'T' + hm(b.start),
          'DTEND;TZID=Europe/Sofia:' + ymd(date) + 'T' + hm(b.end),
          'RRULE:FREQ=WEEKLY;BYDAY=' + BYDAY[dow] + ';UNTIL=' + until,
          'SUMMARY:' + txt(sum),
          'DESCRIPTION:' + txt(ord(b.n) + ' час · ' + (x.s || 'Час') + (x.t ? ' · ' + x.t : '')));
        var ex = [];
        holidays.forEach(function (h) { var hd = parseISO(h); if (hd.getDay() === dow && hd >= date) ex.push(ymd(hd) + 'T' + hm(b.start)); });
        evs.forEach(function (e) { if (e.type === 'change' && e.cancel && e.p === b.n) { var cd = parseISO(e.date); if (cd.getDay() === dow && cd >= date) ex.push(ymd(cd) + 'T' + hm(b.start)); } });
        if (ex.length) L.push('EXDATE;TZID=Europe/Sofia:' + ex.join(','));
        alarm(L, 'Следващ час: ' + sum, gap ? '-PT' + gap + 'M' : 'PT0M');
        L.push('END:VEVENT');
        prevEnd = en;
      });
    }

    /* промени в конкретен час: нова стая, заместник или друг предмет */
    evs.forEach(function (e) {
      if (e.type !== 'change' || e.cancel || e.p == null) return;
      var cd = parseISO(e.date), les = lessons[cd.getDay() + '|' + e.p];
      if (!les || cd < mon) return;
      var subj = short(e.subject || les.x.s) || 'Час', room = e.room || les.x.r;
      var sum = subj + (room ? ' · ' + roomLabel(room) : '');
      L.push('BEGIN:VEVENT', 'UID:' + les.uid, 'DTSTAMP:' + stamp,
        'RECURRENCE-ID;TZID=Europe/Sofia:' + ymd(cd) + 'T' + hm(les.b.start),
        'DTSTART;TZID=Europe/Sofia:' + ymd(cd) + 'T' + hm(les.b.start),
        'DTEND;TZID=Europe/Sofia:' + ymd(cd) + 'T' + hm(les.b.end),
        'SUMMARY:' + txt(sum),
        'DESCRIPTION:' + txt(ord(les.b.n) + ' час · промяна' + (e.sub ? ' · заместник ' + e.sub : '') + (e.note ? ' · ' + e.note : '')));
      alarm(L, 'Следващ час: ' + sum + (e.room ? ' (нова стая)' : ''), les.gap ? '-PT' + les.gap + 'M' : 'PT0M');
      L.push('END:VEVENT');
    });

    /* тестове, събития и неучебни дни */
    evs.forEach(function (e) {
      if (e.type === 'change') return;
      var dd = parseISO(e.date), subj = short(e.subject);
      var lines = ['BEGIN:VEVENT', 'UID:zv' + sl + '-ev-' + String(e.id || e.date).replace(/[^\w-]/g, '') + '@zvanets', 'DTSTAMP:' + stamp,
        'DTSTART;VALUE=DATE:' + ymd(dd), 'DTEND;VALUE=DATE:' + ymd(addDays(dd, 1)), 'TRANSP:TRANSPARENT'];
      if (e.type === 'holiday') {
        lines.push('SUMMARY:' + txt('Неучебен ден' + (e.subject ? ': ' + e.subject : '')));
      } else if (e.type === 'event') {
        lines.push('SUMMARY:' + txt(e.subject || 'Събитие'));
        if (e.note) lines.push('DESCRIPTION:' + txt(e.note));
        alarm(lines, 'Утре: ' + (e.subject || 'събитие'), '-PT5H');
      } else {
        var lab = LABELS[e.type] || 'Тест';
        lines.push('SUMMARY:' + txt(lab + ': ' + (subj || 'предмет') + (e.p != null ? ' (' + ord(e.p) + ' час)' : '')));
        if (e.note) lines.push('DESCRIPTION:' + txt(e.note));
        alarm(lines, 'Утре: ' + lab.toLowerCase() + (subj ? ' по ' + subj : ''), '-PT5H');
      }
      lines.push('END:VEVENT');
      L.push.apply(L, lines);
    });

    L.push('END:VCALENDAR');
    return L.map(fold).join('\r\n') + '\r\n';
  }

  /* data.json, подреден така, че да се поправя лесно на ръка: по един час / тест на ред */
  function pretty(s) {
    var J = JSON.stringify;
    function list(arr, ind, fn) {
      if (!arr || !arr.length) return '[]';
      return '[\n' + arr.map(function (x) { return ind + '  ' + (fn ? fn(x) : J(x)); }).join(',\n') + '\n' + ind + ']';
    }
    function obj(o, ind, fn) {
      var ks = Object.keys(o || {});
      if (!ks.length) return '{}';
      return '{\n' + ks.map(function (k) { return ind + '  ' + J(k) + ': ' + fn(o[k], ind + '  '); }).join(',\n') + '\n' + ind + '}';
    }
    return '{\n' + Object.keys(s).map(function (k) {
      var v = s[k], out;
      if (k === 'tt') out = obj(v, '  ', function (days, i1) { return obj(days, i1, function (row, i2) { return list(row, i2); }); });
      else if (k === 'bells') out = obj(v, '  ', function (arr, i1) { return list(arr, i1); });
      else if (k === 'events' || k === 'classes') out = list(v, '  ');
      else out = J(v);
      return '  ' + J(k) + ': ' + out;
    }).join(',\n') + '\n}\n';
  }

  var api = { buildICS: buildICS, slug: slug, pretty: pretty };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZvLib = api;
})(globalThis);

const ZvLib = module.exports;

// ---- rows -> state (same as the app) ----
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

const SB_URL = Deno.env.get('SUPABASE_URL');
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };

async function get(table, query) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(SB_URL + '/rest/v1/' + table + '?' + query + '&limit=1000&offset=' + off, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
    if (!r.ok) throw new Error(table + ': HTTP ' + r.status + ' ' + (await r.text()));
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
function text(body, status) {
  return new Response(body, { status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const want = new URL(req.url).searchParams.get('class') || '';
    const [settings, classes, bells, lessons, events] = await Promise.all([
      get('settings', 'select=*&order=id'), get('classes', 'select=*&order=name'), get('bells', 'select=*&order=shift,idx'), get('lessons', 'select=*&order=class_name,weekday,idx'), get('events', 'select=*&order=date,period,id'),
    ]);
    const s = buildState({ settings, classes, bells, lessons, events });
    const cls = s.classes.find((c) => ZvLib.slug(c.name) === ZvLib.slug(want) || c.name === want);
    if (!cls) return text('Unknown class. Use ' + s.classes.map((c) => '?class=' + ZvLib.slug(c.name)).join(' or '), 404);
    return new Response(ZvLib.buildICS(s, cls.name, new Date()), {
      headers: { ...CORS, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="' + ZvLib.slug(cls.name) + '.ics"', 'Cache-Control': 'public, max-age=300' },
    });
  } catch (e) {
    return text('Error: ' + (e && e.message ? e.message : String(e)), 500);
  }
});
