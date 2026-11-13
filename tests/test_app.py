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
