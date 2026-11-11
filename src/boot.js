(function(){
var C = window.ZV_CONFIG || {};
var URL0 = String(C.url || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
var KEY = String(C.key || '').trim();
function get(table, query, off, acc){
  var h = { apikey: KEY };
  if (/^eyJ/.test(KEY)) h.Authorization = 'Bearer ' + KEY;
  off = off || 0;
  return fetch(URL0 + '/rest/v1/' + table + '?' + query + '&limit=1000&offset=' + off, { headers: h, cache: 'no-store' }).then(function(r){
    return r.text().then(function(t){
      var j = null; try { j = JSON.parse(t); } catch (e) {}
      if (!r.ok){ var err = new Error((j && (j.message || j.error || j.msg)) || t || ('HTTP ' + r.status)); err.status = r.status; err.table = table; err.code = j && j.code; throw err; }
      if (!Array.isArray(j)) return j;
      acc = (acc || []).concat(j);
      return j.length === 1000 ? get(table, query, off + 1000, acc) : acc;
    });
  }, function(e){ var err = new Error(String(e && e.message || e)); err.status = 0; err.table = table; throw err; });
}
// Only recent and upcoming events are downloaded; older ones stay in the database (and in the admin backup).
var EVENT_DAYS = 120;
function since(days){ var d = new Date(Date.now() - days * 864e5); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
// Crash reports: JS errors are sent to the reports table (shown to the admin as class "JS"), max 3 per session and once per message per day.
(function(){
  var sent = 0, seen = {};
  function report(msg, where){
    msg = String(msg || '').slice(0, 300);
    if (!msg || /^Script error\.?$/.test(msg) || /extension:\/\//.test(where || '') || sent >= 3 || !URL0 || !KEY) return;
    var day = new Date().toISOString().slice(0, 10), k = 'zv-err-' + day;
    try { seen = JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { seen = {}; }
    if (seen[msg]) return; seen[msg] = 1; sent++;
    try { localStorage.setItem(k, JSON.stringify(seen)); } catch (e) {}
    var dev = ''; try { dev = (localStorage.getItem('zv-dev') || 'anon').slice(0, 40) + '-js'; } catch (e) { dev = 'anon-js'; }
    var ua = navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 120);
    var h = { apikey: KEY, 'Content-Type': 'application/json' }; if (/^eyJ/.test(KEY)) h.Authorization = 'Bearer ' + KEY;
    try { fetch(URL0 + '/rest/v1/rpc/send_report', { method:'POST', headers:h, keepalive:true, body:JSON.stringify({ p_class:'JS', p_message:('[грешка] ' + msg + (where ? ' @ ' + where : '') + ' · ' + ua).slice(0, 500), p_device:dev }) }).catch(function(){}); } catch (e) {}
  }
  window.addEventListener('error', function(e){ if (e && e.message) report(e.message, (e.filename || '').split('/').pop() + ':' + (e.lineno || 0)); });
  window.addEventListener('unhandledrejection', function(e){ var r = e && e.reason; if (r && r.status !== undefined) return; report(r && (r.stack || r.message) || r, 'promise'); });
  window.ZvReport = report;
})();
function hhmm(t){ return String(t || '').slice(0, 5); }
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
    if (e.created_by) x.by = e.created_by; if (e.author) x.au = e.author; if (e.author_role) x.ar = e.author_role;
    s.events.push(x);
  });
  return s;
}

function load(){
  if (!C.url || /YOUR-PROJECT|YOUR-/.test(URL0 + KEY)){ var e0 = new Error('config.js'); e0.kind = 'config'; return Promise.reject(e0); }
  if (!/^https:\/\/[^\/]+$/.test(URL0)){ var e1 = new Error('URL: ' + URL0); e1.kind = 'url'; return Promise.reject(e1); }
  return Promise.all([get('settings', 'select=*&order=id'), get('classes', 'select=*&order=name'), get('bells', 'select=*&order=shift,idx'), get('lessons', 'select=*&order=class_name,weekday,idx'), get('events', 'select=*&date=gte.' + since(EVENT_DAYS) + '&order=date,period,id')]).then(function(r){
    if (!r[1].length || !r[2].length || !r[3].length){ var e2 = new Error('classes ' + r[1].length + ', bells ' + r[2].length + ', lessons ' + r[3].length); e2.kind = 'empty'; throw e2; }
    return buildState({ settings:r[0], classes:r[1], bells:r[2], lessons:r[3], events:r[4] });
  });
}
function explain(err){
  var m = String(err && err.message || ''), s = err && err.status;
  if (err.kind === 'config') return 'Във файла config.js още стоят YOUR-PROJECT и YOUR-KEY. Постави адреса и ключа между кавичките.';
  if (err.kind === 'url') return 'Адресът в config.js не изглежда правилно. Трябва да е точно като https://abcd1234.supabase.co (без нищо след .co).';
  if (err.kind === 'empty') return 'Връзката работи, но таблиците са празни. Пусни seed.sql в SQL Editor.';
  if (s === 0) return 'Няма връзка със Supabase. Провери интернета, адреса в config.js и дали проектът не е на пауза (Paused).';
  if (/permission denied/i.test(m) || err.code === '42501') return 'Ключът работи, но няма право да чете таблиците. Пусни в SQL Editor поправката с grant select.';
  if (/api key|apikey|jwt|unregistered/i.test(m) || s === 401) return 'Supabase не приема ключа в config.js. Използвай publishable (sb_publishable_…) или legacy anon ключа.';
  if (/does not exist|could not find the table|schema cache/i.test(m) || s === 404 || err.code === 'PGRST205') return 'Таблиците не са намерени. Пусни schema.sql и после seed.sql в SQL Editor.';
  return 'Supabase върна грешка.';
}
function showError(err){
  console.error(err);
  var detail = (err.table ? err.table + ': ' : '') + (err.status ? 'HTTP ' + err.status + ' · ' : '') + String(err.message || err);
  var box = document.createElement('div');
  box.style.cssText = 'max-width:560px;margin:40px auto;padding:20px;border-radius:16px;background:var(--surface,#fff);border:1px solid var(--line,#D6DEE8);font:16px/1.45 system-ui,-apple-system,sans-serif;color:var(--ink,#14213A)';
  var h = document.createElement('b'); h.textContent = 'Програмата не можа да се зареди'; h.style.cssText = 'display:block;font-size:19px;margin-bottom:8px';
  var p = document.createElement('p'); p.textContent = explain(err); p.style.margin = '0 0 12px';
  var c = document.createElement('code'); c.textContent = detail; c.style.cssText = 'display:block;padding:10px;border-radius:10px;background:var(--surface-2,#F5F7FA);font-size:13px;white-space:pre-wrap;word-break:break-word;color:var(--muted,#66748A)';
  box.appendChild(h); box.appendChild(p); box.appendChild(c);
  var app = document.getElementById('app'); app.innerHTML = ''; app.appendChild(box);
}
function startApp(state){
  document.getElementById('app-state').textContent = JSON.stringify(state).replace(/</g, '\\u003c');
  var s = document.createElement('script');
  s.text = document.getElementById('app-js').textContent;
  document.body.appendChild(s);
}
window.ZvSB = { url: URL0, key: KEY, load: load, fresh: false };
var cached = null;
try { cached = JSON.parse(localStorage.getItem('zv-data')); } catch (e) {}
if (cached && cached.tt) startApp(cached);
else {
  document.getElementById('app').innerHTML = '<div class="boot">Зареждане…</div>';
  load().then(function(s){
    try { localStorage.setItem('zv-data', JSON.stringify(s)); } catch (e) {}
    window.ZvSB.fresh = true; startApp(s);
  }, showError);
}
})();
