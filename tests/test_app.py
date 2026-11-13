"""Run: python3 -m pytest tests   (needs: pip install pytest playwright && python3 -m playwright install chromium)"""
import json, re, subprocess, sys
from conftest import ROOT


def pick_class(app, cls='10е'):
    pg = app.page
    pg.goto(app.server)
    pg.evaluate("c => { localStorage.setItem('zv-mine', c); localStorage.setItem('zv-class', c); localStorage.setItem('zv-ins-later', '1'); localStorage.setItem('zv-de-x', '1'); }", cls)
    pg.reload()
    pg.wait_for_selector('.hl-r, .ls', timeout=10000)
    return pg


def test_build_is_up_to_date():
    r = subprocess.run([sys.executable, str(ROOT / 'tools' / 'build.py'), '--check'], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr or r.stdout


def test_first_run_shows_class_picker_without_errors(app):
    pg = app.page
    pg.goto(app.server)
    pg.wait_for_selector('text=Кой е твоят клас?')
    pg.wait_for_timeout(500)
    assert app.errors == [], app.errors  # also catches Content-Security-Policy violations


def test_today_shows_rooms_and_upcoming_test(app):
    pg = pick_class(app)
    rooms = pg.eval_on_selector_all('.hl-room', 'els => els.map(e => e.textContent.trim())')
    assert rooms == ['101', '102', '103', '104', '105'], rooms
    assert pg.locator('text=Следващи тестове').count() == 1
    assert app.errors == [], app.errors


def test_room_chip_stays_on_screen_with_huge_bold_text(browser, server):
    from conftest import App
    a = App(browser, server, viewport={'width': 320, 'height': 700})
    try:
        pg = pick_class(a)
        pg.click('.tb:has-text("Програма")'); pg.wait_for_selector('.ls .room'); pg.wait_for_timeout(600)
        pg.add_style_tag(content='body,.ls-s,.ls-t{font-weight:800!important}.ls-s{font-size:21px!important}')
        boxes = pg.eval_on_selector_all('.ls .room', 'els => els.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right]; })')
        assert boxes, 'no room chips rendered'
        for left, right in boxes:
            assert left >= 0 and right <= 320, (left, right)
        assert pg.evaluate('document.documentElement.scrollWidth') <= 320
    finally:
        a.ctx.close()


def test_only_recent_events_are_downloaded(app):
    pick_class(app)
    ev = [r for r in app.requests if r['path'].endswith('/rest/v1/events')]
    assert ev and re.search(r'date=gte\.\d{4}-\d\d-\d\d', ev[0]['query']), ev


def test_offline_banner_appears_and_clears(app):
    pg = pick_class(app)
    app.ctx.set_offline(True)
    pg.wait_for_selector('#net.on', timeout=3000)
    assert 'Няма връзка' in pg.inner_text('#net')
    app.ctx.set_offline(False)
    pg.wait_for_selector('#net.on', state='detached', timeout=8000)


def test_js_errors_are_reported_once(app):
    pg = pick_class(app)
    pg.evaluate("setTimeout(() => { throw new Error('boom-test') }, 0); setTimeout(() => { throw new Error('boom-test') }, 10);")
    pg.wait_for_timeout(800)
    sent = [json.loads(r['body']) for r in app.requests if r['path'].endswith('/rpc/send_report')]
    boom = [s for s in sent if 'boom-test' in s['p_message']]
    assert len(boom) == 1 and boom[0]['p_class'] == 'JS' and boom[0]['p_device'].endswith('-js'), sent
    app.errors.clear()


def test_service_worker_version_changes_with_app():
    sw = (ROOT / 'sw.js').read_text(encoding='utf-8')
    assert re.search(r"const VERSION = 'zvanets-sb-\d+'", sw)


def test_every_tab_opens_without_errors(app):
    pg = pick_class(app)
    for name in ['Програма', 'Домашни', 'Тестове', 'Учители', 'Сега']:
        pg.click('.tb:has-text("%s")' % name)
        pg.wait_for_timeout(500)
    assert app.errors == [], app.errors


def _sheet(app):
    pg = pick_class(app)
    pg.evaluate("""() => { const b = document.createElement('button'); b.dataset.act = 'acct-open'; b.dataset.r = 'student'; b.id = 'x-acct'; document.getElementById('app').appendChild(b); }""")
    pg.click('#x-acct')
    pg.wait_for_selector('.sheet')
    return pg


def test_signup_uses_a_code_instead_of_a_link(app):
    pg = _sheet(app)
    pg.click('[data-act="ac-mode"][data-m="up"]')
    pg.fill('[data-f="ac"][data-k="name"]', 'Иван Петров')
    if pg.locator('select[data-k="cls"]').count():
        pg.select_option('select[data-k="cls"]', '10е')
    pg.fill('[data-f="ac"][data-k="email"]', 'ivan@example.com')
    pg.fill('[data-f="ac"][data-k="password"]', 'secret12')
    pg.click('[data-act="ac-up"]')
    pg.wait_for_selector('.code-in')
    assert 'ivan@example.com' in pg.inner_text('.sheet')
    pg.fill('.code-in', '111111'); pg.click('[data-act="ac-verify"]')
    pg.wait_for_selector('text=Кодът е грешен или е изтекъл')
    pg.fill('.code-in', '123456'); pg.click('[data-act="ac-verify"]')
    pg.wait_for_selector('.code-in', state='detached')
    ver = [json.loads(r['body']) for r in app.requests if r['path'].endswith('/auth/v1/verify')]
    assert ver[-1] == {'type': 'email', 'email': 'ivan@example.com', 'token': '123456'}
    reg = [json.loads(r['body']) for r in app.requests if r['path'].endswith('/rpc/member_register')]
    assert reg and reg[-1]['p_name'] == 'Иван Петров' and reg[-1]['p_class'] == '10е', reg
    assert [e for e in app.errors if 'status of 403' not in e] == [], app.errors


def test_forgotten_password_with_a_code(app):
    pg = _sheet(app)
    pg.click('[data-act="ac-forgot"]')
    pg.fill('[data-f="ac"][data-k="email"]', 'ivan@example.com')
    pg.click('[data-act="ac-reset-send"]')
    pg.wait_for_selector('.code-in')
    pg.fill('.code-in', '123456'); pg.fill('[data-f="ac"][data-k="password"]', 'newpass1')
    pg.click('[data-act="ac-reset-save"]')
    pg.wait_for_selector('.code-in', state='detached')
    put = [r for r in app.requests if r['path'].endswith('/auth/v1/user') and r['method'] == 'PUT']
    assert put and json.loads(put[0]['body']) == {'password': 'newpass1'}
    assert any(r['path'].endswith('/auth/v1/recover') for r in app.requests)
    assert app.errors == [], app.errors


def _login(app, email='boss@example.com'):
    pg = pick_class(app)
    pg.click('[data-act="acct-open"]')
    pg.fill('[data-f="ac"][data-k="email"]', email)
    pg.fill('[data-f="ac"][data-k="password"]', 'secret12')
    pg.route('**/auth/v1/token**', lambda r: r.fulfill(content_type='application/json', body=json.dumps(
        {'access_token': 'tok', 'refresh_token': 'ref', 'expires_in': 3600, 'user': {'id': 'u-boss', 'email': email}})))
    pg.click('[data-act="ac-in"]')
    pg.wait_for_selector('.sheet:not([aria-label="Вход"])')
    pg.keyboard.press('Escape')
    pg.wait_for_selector('.sheet', state='detached')
    return pg


def test_no_hidden_admin_entry(app):
    pg = pick_class(app)
    for _ in range(6):
        pg.click('.brand')
    pg.wait_for_timeout(300)
    assert pg.locator('.teacher').count() == 0
    pg.goto(app.server + '#redakcia'); pg.wait_for_selector('.hl-r, .ls')
    assert pg.locator('.teacher').count() == 0
    assert pg.locator('[data-act="acct-open"]').count() == 1  # login button in the header


def test_admin_logs_in_like_everyone_and_changes_roles(app):
    app.perms = ['*']
    app.data['members'] = [
        {'user_id': 'u1', 'email': 'ivan@example.com', 'role': 'student', 'name': 'Иван Петров', 'class_name': '10е', 'teacher_name': '', 'teacher_key': '', 'status': 'active', 'created_at': '2026-11-01T10:00:00Z'},
    ]
    app.data['editors'] = [{'email': 'boss@example.com', 'class_name': '*'}]
    pg = _login(app)
    pg.click('[data-act="to-teacher"]')
    pg.click('.tab:has-text("Хора")')
    pg.click('summary:has-text("10е")')
    pg.click('[data-act="ppr-open"][data-id="u1"]')
    pg.click('[data-act="ppr-role"][data-r="teacher"]')
    pg.select_option('select[data-f="ppr"][data-k="teacher"]', index=1)
    pg.check('input[data-f="ppr"][data-k="admin"]')
    pg.click('[data-act="ppr-save"]')
    pg.wait_for_selector('.pp-role', state='detached')
    m = app.data['members'][0]
    assert m['role'] == 'teacher' and m['teacher_name'] and m['class_name'] == '', m
    assert {'email': 'ivan@example.com', 'class_name': '*'} in app.data['editors']
    assert app.errors == [], app.errors


def test_change_password_when_logged_in(app):
    pg = _login(app, 'ivan@example.com')
    pg.click('[data-act="acct-open"]')
    pg.click('[data-act="ac-pw"]')
    pg.fill('[data-f="ac"][data-k="password"]', 'newpass1')
    pg.fill('[data-f="ac"][data-k="password2"]', 'newpass2')
    pg.click('[data-act="ac-pw-save"]')
    pg.wait_for_selector('text=не съвпадат')
    pg.fill('[data-f="ac"][data-k="password2"]', 'newpass1')
    pg.click('[data-act="ac-pw-save"]')
    pg.wait_for_selector('[data-act="ac-pw-save"]', state='detached')
    put = [r for r in app.requests if r['path'].endswith('/auth/v1/user') and r['method'] == 'PUT']
    assert put and json.loads(put[-1]['body']) == {'password': 'newpass1'}


def test_admin_can_reach_statistics(app):
    app.perms = ['*']
    app.data['editors'] = [{'email': 'boss@example.com', 'class_name': '*'}]
    pg = _login(app)
    pg.click('[data-act="to-teacher"]')
    pg.click('header [data-act="to-stats"]')
    pg.wait_for_selector('header:has-text("Готово")')
    pg.click('[data-act="to-student"]')
    pg.click('[data-act="acct-open"]')
    pg.click('[data-act="ac-to-stats"]')
    pg.wait_for_selector('.sheet', state='detached')
    assert pg.locator('header [data-act="to-student"]').count() == 1
    assert app.errors == [], app.errors


NOROOM_XML = """<?xml version="1.0" encoding="UTF-8"?>
<timetable>
 <periods><period period="1" starttime="8:00" endtime="8:40"/><period period="2" starttime="8:50" endtime="9:30"/></periods>
 <subjects><subject id="S1" name="Математика"/><subject id="S2" name="Химия"/></subjects>
 <teachers><teacher id="T1" firstname="Мария" lastname="Кръстева"/></teachers>
 <classrooms></classrooms>
 <classes><class id="C1" name="10е"/></classes>
 <groups><group id="G1" classid="C1" name="Цял клас" entireclass="1"/></groups>
 <lessons>
  <lesson id="L1" classids="C1" subjectid="S1" teacherids="T1" groupids="G1" periodspercard="1"/>
  <lesson id="L2" classids="C1" subjectid="S2" teacherids="T1" groupids="G1" periodspercard="1"/>
 </lessons>
 <cards>
  <card lessonid="L1" days="10000" period="1" classroomids=""/>
  <card lessonid="L2" days="10000" period="2" classroomids=""/>
 </cards>
</timetable>"""


def test_import_keeps_rooms_when_the_file_has_none(app, tmp_path):
    app.perms = ['*']
    app.data['editors'] = [{'email': 'boss@example.com', 'class_name': '*'}]
    seen = {}
    pg = _login(app)
    pg.route('**/rpc/import_timetable', lambda r: (seen.update(json.loads(r.request.post_data)), r.fulfill(content_type='application/json', body='{"classes":1,"lessons":2}')))
    pg.click('[data-act="to-teacher"]')
    pg.click('.tab:has-text("Импорт")')
    f = tmp_path / 'a.xml'; f.write_text(NOROOM_XML, encoding='utf-8')
    pg.set_input_files('input[data-f="impfile"]', str(f))
    pg.wait_for_selector('text=Запазваме стаите')
    assert 'нито във файла' in pg.content()  # Химия has no room anywhere
    pg.click('[data-act="imp-go"]')  # first tap arms the button, second confirms
    pg.click('[data-act="imp-go"]')
    pg.wait_for_timeout(800)
    rooms = {l['subject']: l['room'] for l in seen['p_lessons']}
    assert rooms == {'Математика': '101', 'Химия': ''}, rooms


def test_subject_names_are_cleaned(app):
    for l in app.data['lessons']:
        if l['class_name'] == '10е' and l['idx'] == 0: l['subject'] = 'Математика - ООП'
        if l['class_name'] == '10е' and l['idx'] == 1: l['subject'] = 'Английски език (ПП)'
        if l['class_name'] == '10е' and l['idx'] == 2: l['subject'] = 'Модул1 - Устно общуване ФЕ 2ри ЧЕ - ПП/зад.модул'
        if l['class_name'] == '10е' and l['idx'] == 3: l['subject'] = 'Френски език - РП/УП-А /8-10е,ж/'
    pg = pick_class(app)
    txt = pg.inner_text('.hero')
    assert 'ООП' not in txt and 'Математика' in txt and 'Английски език · ПП' in txt, txt
    assert 'Устно общуване ФЕ · ПП' in txt and 'Френски език · РП' in txt and 'Модул' not in txt and '/8-10' not in txt, txt


def test_clean_subject_names_stay_the_same_when_cleaned_again(app):
    for l in app.data['lessons']:
        if l['class_name'] == '10е' and l['idx'] == 0: l['subject'] = 'Френски език · РП'  # already clean in the database
    pg = pick_class(app)
    txt = pg.inner_text('.hero')
    assert 'Френски език · РП' in txt and '· ·' not in txt, txt


def test_narrow_phone_shows_full_times(browser, server):
    from conftest import App
    a = App(browser, server, viewport={'width': 320, 'height': 640})
    try:
        pg = pick_class(a)
        cut = pg.eval_on_selector_all('.hs-i b', 'els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent)')
        assert cut == [], cut
    finally:
        a.ctx.close()


def test_open_lists_stay_open_and_sheet_survives_text_selection(app):
    import datetime as dt
    app.data['events'].append({'id': 'old', 'type': 'project', 'date': (dt.date.today() - dt.timedelta(days=3)).isoformat(), 'period': None,
                               'subject': 'Математика', 'note': 'стара', 'classes': ['10е'], 'all_school': False, 'cancel': False, 'room': '', 'substitute': ''})
    pg = pick_class(app)
    pg.click('.tb:has-text("Домашни")'); pg.wait_for_selector('details[data-k="past-hw"]')
    pg.click('details[data-k="past-hw"] summary')
    pg.evaluate("document.querySelector('[data-act=\"page\"]') && 0")
    pg.click('.tb:has-text("Домашни")')  # any redraw
    assert pg.evaluate("document.querySelector('details[data-k=\"past-hw\"]').open")
    # select text in a field and release the mouse outside the sheet: the sheet must stay open
    pg.click('[data-act="acct-open"]')
    box = pg.locator('[data-f="ac"][data-k="email"]').bounding_box()
    pg.mouse.move(box['x'] + 5, box['y'] + 5); pg.mouse.down()
    pg.mouse.move(5, 5); pg.mouse.up()
    pg.wait_for_timeout(200)
    assert pg.locator('.sheet').count() == 1
    pg.mouse.click(5, 5)  # a real tap on the backdrop still closes it
    pg.wait_for_selector('.sheet', state='detached')


TERMS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<timetable>
 <periods><period period="1" starttime="8:00" endtime="8:40"/><period period="2" starttime="8:50" endtime="9:30"/></periods>
 <weeksdefs><weeksdef id="W1" name="Седмица А" short="седм. А" weeks="10"/><weeksdef id="W2" name="Седмица Б" short="седм. Б" weeks="01"/></weeksdefs>
 <subjects><subject id="S1" name="Музика"/><subject id="S2" name="Български език и литература"/><subject id="S3" name="Химия"/><subject id="S4" name="Физика"/></subjects>
 <teachers><teacher id="T1" firstname="Мария" lastname="Кръстева"/></teachers>
 <classrooms><classroom id="R1" name="Кабинет 300" short="300"/></classrooms>
 <classes><class id="C1" name="10е"/></classes>
 <groups><group id="G1" classid="C1" name="Цял клас" entireclass="1"/></groups>
 <lessons>
  <lesson id="L1" classids="C1" subjectid="S1" teacherids="T1" groupids="G1" periodspercard="1"/>
  <lesson id="L2" classids="C1" subjectid="S2" teacherids="T1" groupids="G1" periodspercard="1"/>
  <lesson id="L3" classids="C1" subjectid="S3" teacherids="T1" groupids="G1" periodspercard="1"/>
  <lesson id="L4" classids="C1" subjectid="S4" teacherids="T1" groupids="G1" periodspercard="1"/>
 </lessons>
 <cards>
  <card lessonid="L1" days="10000" period="1" classroomids="R1" terms="10" weeks="11"/>
  <card lessonid="L2" days="10000" period="1" classroomids="R1" terms="01" weeks="11"/>
  <card lessonid="L3" days="10000" period="2" classroomids="R1" terms="11" weeks="10"/>
  <card lessonid="L4" days="10000" period="2" classroomids="R1" terms="11" weeks="01"/>
 </cards>
</timetable>"""


def test_import_term_and_week_lessons(app, tmp_path):
    import datetime as dt
    app.perms = ['*']
    app.data['editors'] = [{'email': 'boss@example.com', 'class_name': '*'}]
    seen = {}
    pg = _login(app)
    pg.route('**/rpc/import_timetable', lambda r: (seen.update(json.loads(r.request.post_data)), r.fulfill(content_type='application/json', body='{"classes":1,"lessons":2}')))
    pg.click('[data-act="to-teacher"]'); pg.click('.tab:has-text("Импорт")')
    f = tmp_path / 't.xml'; f.write_text(TERMS_XML, encoding='utf-8')
    pg.set_input_files('input[data-f="impfile"]', str(f))
    pg.wait_for_selector('text=през седмица')
    pg.click('[data-act="imp-go"]'); pg.click('[data-act="imp-go"]'); pg.wait_for_timeout(800)
    subj = {l['idx']: l['subject'] for l in seen['p_lessons']}
    term2 = 2 <= dt.date.today().month <= 8  # Feb..Aug
    assert subj[0] == ('Български език и литература' if term2 else 'Музика'), subj
    assert subj[1] == 'Химия (седм. А) / Физика (седм. Б)', subj


def test_group_lessons_pick_your_own(app):
    for l in app.data['lessons']:
        if l['class_name'] == '10е' and l['weekday'] in (1, 2, 3, 4, 5) and l['idx'] == 2:
            l['subject'] = 'Поток 1'; l['teacher'] = 'Дора Илиева · Ирина Йорданова · Петя Костадинова'; l['room'] = '305/306/405'
    pg = pick_class(app)
    pg.click('.tb:has-text("Програма")'); pg.wait_for_selector('.grp-pick')
    row = pg.locator('.ls:has-text("Поток 1")').first
    assert '3 групи' in row.inner_text() and '305/306' not in row.inner_text()
    row.locator('.grp-pick').click(); pg.wait_for_selector('.grp-o')
    pg.click('.grp-o:has-text("Ирина Йорданова")'); pg.wait_for_selector('.sheet', state='detached')
    row = pg.locator('.ls:has-text("Поток 1")').first
    txt = row.inner_text()
    assert 'Ирина Йорданова' in txt and '306' in txt and 'Дора' not in txt, txt
    pg.reload(); pg.click('.tb:has-text("Програма")'); pg.wait_for_selector('.ls')
    assert '306' in pg.locator('.ls:has-text("Поток 1")').first.inner_text()  # remembered on this phone
    assert app.errors == [], app.errors


def test_people_list_loads_more_than_1000(app):
    app.perms = ['*']
    app.data['editors'] = [{'email': 'boss@example.com', 'class_name': '*'}]
    app.data['members'] = [{'user_id': 'u%d' % i, 'email': 's%d@x.bg' % i, 'role': 'student', 'name': 'Ученик %d' % i, 'class_name': '10е',
                            'teacher_name': '', 'teacher_key': '', 'status': 'active', 'created_at': '2026-11-01T10:00:00Z'} for i in range(1500)]
    real = app._sb
    def paged(route):
        import urllib.parse as up
        u = up.urlparse(route.request.url)
        if u.path.endswith('/members') and route.request.method == 'GET':
            q = up.parse_qs(u.query); off = int(q.get('offset', ['0'])[0]); lim = min(int(q.get('limit', ['1000'])[0]), 1000)
            return route.fulfill(content_type='application/json', body=json.dumps(app.data['members'][off:off + lim]))
        return real(route)
    app.page.route('https://test.supabase.co/**', paged)
    pg = _login(app)
    pg.click('[data-act="to-teacher"]'); pg.click('.tab:has-text("Хора")')
    pg.wait_for_selector('text=Ученици')
    assert '1500' in pg.inner_text('.panel:has-text("Ученици") .aside')
