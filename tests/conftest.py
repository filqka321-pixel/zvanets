"""Shared setup: serves the repo over http and fakes Supabase, so tests never touch the real database."""
import datetime as dt, functools, http.server, json, pathlib, threading, urllib.parse
import pytest
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SB = 'https://test.supabase.co'


def fixture_data():
    today = dt.date.today()
    bells = [(1, '08:00', '08:40'), (2, '08:50', '09:30'), (3, '09:40', '10:20'), (4, '10:40', '11:20'), (5, '11:30', '12:10')]
    subjects = ['Математика', 'Информационни технологии и програмиране', 'Български език и литература', 'Английски език', 'Физическо възпитание']
    lessons = []
    for cls in ['10е', '11а']:
        for wd in range(1, 6):
            for i, s in enumerate(subjects):
                lessons.append({'class_name': cls, 'weekday': wd, 'idx': i, 'subject': s, 'room': str(101 + i), 'teacher': 'Александровичевска-Константинова'})
    return {
        'settings': [{'id': 1, 'rev': 'r1', 'updated_at': today.isoformat() + 'T07:00:00Z', 'school': 'Тестово училище'}],
        'classes': [{'name': '10е', 'shift': 1}, {'name': '11а', 'shift': 1}],
        'bells': [{'shift': 1, 'idx': i, 'n': n, 'start_time': a + ':00', 'end_time': b + ':00'} for i, (n, a, b) in enumerate(bells)],
        'lessons': lessons,
        'events': [{'id': 'e1', 'type': 'test', 'date': (today + dt.timedelta(days=1)).isoformat(), 'period': 1, 'subject': 'Математика',
                    'note': 'Контролно', 'classes': ['10е'], 'all_school': False, 'cancel': False, 'room': '', 'substitute': ''}],
    }


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


@pytest.fixture(scope='session')
def server():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield 'http://127.0.0.1:%d/' % srv.server_address[1]
    srv.shutdown()


@pytest.fixture(scope='session')
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


class App:
    """A page with the fake backend. .requests records every Supabase call, .errors any console error or CSP violation."""
    def __init__(self, browser, server, **ctx):
        self.data = fixture_data()
        self.requests, self.errors, self.down, self.perms = [], [], False, []
        self.ctx = browser.new_context(service_workers='block', **ctx)
        self.page = self.ctx.new_page()
        self.page.on('console', lambda m: m.type == 'error' and self.errors.append(m.text))
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.route('**/config.js', lambda r: r.fulfill(content_type='application/javascript',
                        body="window.ZV_CONFIG={url:'%s/rest/v1/',key:'sb_publishable_test'};" % SB))
        self.page.route(SB + '/**', self._sb)
        self.page.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(content_type='text/css', body=''))
        self.server = server

    def _sb(self, route):
        req = route.request
        u = urllib.parse.urlparse(req.url)
        self.requests.append({'method': req.method, 'path': u.path, 'query': urllib.parse.unquote(u.query), 'body': req.post_data})
        if self.down:
            return route.abort('internetdisconnected')
        name = u.path.rsplit('/', 1)[-1]
        if '/auth/v1/' in u.path:
            return self._auth(route, name, req)
        if '/rest/v1/rpc/' in u.path:
            if name == 'my_permissions':
                return route.fulfill(content_type='application/json', body=json.dumps(self.perms))
            if name == 'member_register':
                b = json.loads(req.post_data or '{}')
                return route.fulfill(content_type='application/json', body=json.dumps({'role': b.get('p_role'), 'name': b.get('p_name'), 'class_name': b.get('p_class'), 'status': 'active', 'teacher_name': ''}))
            return route.fulfill(content_type='application/json', body='true' if name in ('send_report', 'log_visit') else 'null')
        if req.method == 'PATCH' and name in self.data:
            patch = json.loads(req.post_data or '{}')
            q = urllib.parse.parse_qs(u.query)
            uid = q.get('user_id', [''])[0].replace('eq.', '')
            rows = [r for r in self.data[name] if r.get('user_id') == uid]
            for r in rows: r.update(patch)
            return route.fulfill(content_type='application/json', body=json.dumps(rows))
        if req.method == 'POST' and name == 'editors':
            self.data.setdefault('editors', []).append(json.loads(req.post_data))
            return route.fulfill(status=201, content_type='application/json', body='')
        if req.method == 'DELETE' and name == 'editors':
            q = urllib.parse.parse_qs(u.query); em = q.get('email', [''])[0].replace('eq.', '')
            self.data['editors'] = [r for r in self.data.get('editors', []) if r['email'] != em]
            return route.fulfill(status=204, body='')
        if req.method == 'GET' and name in self.data:
            return route.fulfill(content_type='application/json', body=json.dumps(self.data[name]))
        return route.fulfill(content_type='application/json', body='[]')

    def _auth(self, route, name, req):
        body = json.loads(req.post_data or '{}')
        user = {'id': '00000000-0000-0000-0000-000000000001', 'email': body.get('email', 'a@b.bg'), 'identities': [{}]}
        session = {'access_token': 'tok', 'refresh_token': 'ref', 'expires_in': 3600, 'user': user}
        if name == 'verify':
            if body.get('token') != '123456':
                return route.fulfill(status=403, content_type='application/json', body=json.dumps({'code': 403, 'error_code': 'otp_expired', 'msg': 'Token has expired or is invalid'}))
            return route.fulfill(content_type='application/json', body=json.dumps(session))
        if name == 'signup':
            return route.fulfill(content_type='application/json', body=json.dumps(user))  # email confirmation on: no session yet
        if name == 'user':
            return route.fulfill(content_type='application/json', body=json.dumps(user))
        return route.fulfill(content_type='application/json', body='{}')  # resend, recover

    def open(self, cls='10е'):
        self.page.goto(self.server)
        if cls:
            self.page.evaluate("c => { localStorage.setItem('zv-class', c); localStorage.setItem('zv-ins-later', '1'); localStorage.setItem('zv-de-x', '1'); }", cls)
            self.page.reload()
        self.page.wait_for_selector('.ls, .cls-o, .tc', timeout=10000)
        return self.page


@pytest.fixture
def app(browser, server):
    a = App(browser, server, viewport={'width': 390, 'height': 844}, locale='bg-BG', timezone_id='Europe/Sofia')
    yield a
    a.ctx.close()
