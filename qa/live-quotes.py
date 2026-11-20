"""Offline browser QA: pip-installed Playwright required, no site dependencies.
Run from repo root: python qa/live-quotes.py. No external requests escape.
"""
import json
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'qa' / 'evidence'
OUT.mkdir(exist_ok=True)
state = {'name': 'live', 'calls': 0}

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path != '/quotes':
            return super().do_GET()
        state['calls'] += 1
        name = state['name']
        self.send_response(503 if name == 'offline' else 200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        if name == 'non-json':
            self.wfile.write(b'<html>not JSON</html>')
            return
        now = state.get('fixed_time', int(time.time() * 1000))
        market = dict(anchorHeight=1008000, anchorTipHex='a'*64,
                      anchorBits=486604799, window=144, strikeTarget='123', bounty=101)
        quotes = [dict(quoteId='fixture-'+side, market=market, makerSide=side,
                       makerStake=10000-stake, takerStake=stake,
                       makerPKH='b'*40, expiryHeight=1008013)
                  for side, stake in [('no', 5201), ('yes', 5802)]]
        status = dict(mode='dry-run' if name.startswith('dry-run') else 'live',
                      stopped=name in ['stopped', 'dry-run-stopped'], stale=name=='stale-flag',
                      currentHeight=1008010,
                      refreshedAt=now-(91000 if name=='stale' else 89000 if name=='aging' else 0))
        self.wfile.write(json.dumps(dict(quotes=quotes, status=status)).encode())

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT/'docs')))
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
results = []
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='chrome', headless=True)
        context = browser.new_context(viewport={'width': 1100, 'height': 1000})
        def route(req):
            url = req.request.url
            if url == 'https://api.popnlocks.com/quotes':
                response = req.fetch(url=base+'/quotes')
                req.fulfill(response=response, headers={'access-control-allow-origin': '*', 'content-type': 'application/json'})
            elif url.startswith(base):
                req.continue_()
            else:
                req.abort()
        context.route('**/*', route)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        for name, label in [('live', 'Maker quotes · read-only'),
                            ('dry-run', 'Dry-run · indicative only'),
                            ('stopped', 'book stopped'), ('stale', 'quotes stale'),
                            ('offline', 'maker offline — showing settled markets only'),
                            ('non-json', 'maker offline — showing settled markets only'),
                            ('stale-flag', 'quotes stale'), ('dry-run-stopped', 'book stopped')]:
            state['name'] = name
            page.goto(base)
            page.wait_for_function('(s) => document.querySelector("#market-status").textContent === s', arg=label)
            page.wait_for_function('!document.querySelector("#pops-status").textContent.includes("preview")')
            assert page.locator('.market-side button:enabled').count() == 0
            if name in ['live', 'dry-run']:
                assert page.locator('#yes-price').inner_text() == '5,201 sats'
                assert page.locator('#no-price').inner_text() == '5,802 sats'
                assert '9,697 sats after 303 sats' in page.locator('#yes-detail').inner_text()
                assert '1,008,013' in page.locator('#yes-detail').inner_text()
                assert '30 minutes' in page.locator('#yes-detail').inner_text()
            else:
                assert page.locator('#yes-price').inner_text() == '—'
            if name.startswith('dry-run'):
                assert page.locator('#maker-mode').inner_text() == 'DRY-RUN — quotes not takable'
            page.locator('#markets').screenshot(path=str(OUT/f'{name}.png'))
            results.append(dict(state=name, status=label, dom=page.locator('#markets').inner_text(), passed=True))
        # Real wall clock transition, without a second response.
        state['name'] = 'aging'
        page.goto(base)
        page.wait_for_function('document.querySelector("#yes-price").textContent === "5,201 sats"')
        calls = state['calls']
        page.wait_for_function('document.querySelector("#market-status").textContent === "quotes stale"')
        assert state['calls'] == calls
        results.append(dict(state='90-second local expiry', passed=True))
        # Real browser timers; simulated visibility event for the hidden guard.
        state['name'] = 'live'
        page.goto(base)
        page.wait_for_function('document.querySelector("#yes-price").textContent === "5,201 sats"')
        calls = state['calls']
        page.wait_for_timeout(19000)
        assert state['calls'] == calls
        page.wait_for_timeout(1500)
        page.wait_for_timeout(150)
        assert state['calls'] == calls+1
        page.evaluate('Object.defineProperty(document, "hidden", {configurable:true, get:()=>true}); document.dispatchEvent(new Event("visibilitychange"))')
        calls = state['calls']
        page.wait_for_timeout(21000)
        assert state['calls'] == calls
        page.evaluate('Object.defineProperty(document, "hidden", {configurable:true, get:()=>false}); document.dispatchEvent(new Event("visibilitychange"))')
        page.wait_for_timeout(150)
        assert state['calls'] == calls+1
        results.append(dict(state='20s cadence, hidden pause and resume', passed=True, note='visibility property simulated; browser timers exercised'))
        page.set_viewport_size({'width':390, 'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        results.append(dict(state='mobile no overflow', passed=True))
        assert not errors, errors
        (OUT/'results.json').write_text(json.dumps(dict(results=results, page_errors=errors), indent=2), encoding='utf-8')
        print(json.dumps({'passed':len(results), 'page_errors':errors}))
        browser.close()
finally:
    server.shutdown()
    server.server_close()
