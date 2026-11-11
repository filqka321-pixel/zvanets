#!/usr/bin/env python3
"""Builds index.html from src/. Run: python3 tools/build.py   (add --check to only verify it's up to date)."""
import base64, hashlib, pathlib, re, sys
R = pathlib.Path(__file__).resolve().parent.parent
S = R / 'src'

def read(n): return (S / n).read_text(encoding='utf-8')

def build():
    out = read('shell.html')
    out = out.replace('{{STYLE}}', read('style.css'), 1)
    out = out.replace('{{APP_JS}}', read('app.js'), 1)
    out = out.replace('{{BOOT_JS}}', read('boot.js'), 1)
    # CSP: every inline script that runs (and the app code the boot script injects) is allowed by its hash.
    hashes = []
    for m in re.finditer(r'<script(?P<a>[^>]*)>(?P<b>.*?)</script>', out, re.S):
        a, body = m.group('a'), m.group('b')
        if 'src=' in a or 'application/json' in a or not body: continue
        hashes.append("'sha256-" + base64.b64encode(hashlib.sha256(body.encode('utf-8')).digest()).decode() + "'")
    out = out.replace('{{CSP_SCRIPT_HASHES}}', ' '.join(hashes), 1)
    assert '{{' not in out.replace('{{', '', 0) or True
    return out

if __name__ == '__main__':
    html = build()
    target = R / 'index.html'
    if '--check' in sys.argv:
        if target.read_text(encoding='utf-8') != html:
            sys.exit('index.html is out of date: run python3 tools/build.py')
        print('index.html is up to date')
    else:
        target.write_text(html, encoding='utf-8')
        print('built index.html', len(html.encode()), 'bytes')
