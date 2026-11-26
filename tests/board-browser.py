"""Optional browser QA: python tests/board-browser.py (existing Playwright required).
No npm dependencies; synthetic quotes/history remain confined to this harness.
"""
import copy
import functools
import http.server
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'docs/index.html').read_text(encoding='utf-8')
BASE = subprocess.check_output(['git', 'show', '00441d3:docs/index.html'], cwd=ROOT).decode()
def receipt(s):
    return s.split('<section id="proof">')[1].split('</section>')[0]
assert receipt(SOURCE) == receipt(BASE), 'Receipts changed'
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT / 'docs')))
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/index.html'
market = dict(anchorHeight=974304, anchorTipHex='a'*64, anchorBits=486604799, window=144, strikeTarget='123456789', bounty=100)
quotes = [dict(quoteId=c*64, market=market, makerSide=side, makerStake=10000-stake, takerStake=stake, makerPKH='b'*40, expiryHeight=974420) for c, side, stake in [('c','no',5400),('d','yes',6000)]]
base = dict(quotes=quotes, status=dict(mode='dry-run', stopped=False, stale=False, currentHeight=974417, refreshedAt=0))
results=[]
try:
  with tempfile.TemporaryDirectory(prefix='board-qa-', dir=ROOT) as temp, sync_playwright() as pw:
    # Fail closed even for speculative connections outside Playwright routing.
    browser = pw.chromium.launch(args=['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--proxy-server=http://127.0.0.1:0', '--proxy-bypass-list=127.0.0.1'])
    maker = url.replace('/index.html', '')
    production = 'https://api.popnlocks.com'
    declaration = f'const MAKER_BASE_URL = "{production}";'
    assert SOURCE.count(declaration) == 1
    def isolated_page(viewport, file_url=None, **options):
      page = browser.new_page(viewport=viewport, service_workers='block', **options)
      blocked = []
      def guard(route):
        target = route.request.url
        if route.request.method == 'GET':
          if target in (url, maker+'/data/pops.json', file_url):
            return route.continue_()
          if urlsplit(target).netloc == 'fonts.googleapis.com':
            return route.fulfill(body='', content_type='text/css')
        blocked.append(target)
        route.abort('blockedbyclient')
      page.context.route('**/*', guard)
      page.context.route_web_socket('**/*', lambda ws: (blocked.append(ws.url), ws.close()))
      return page, blocked
    for protocol in ['served', 'file']:
      for case in ['unset','dry-run','live','offline','stale','stopped','empty','expired','malformed','conflicting','history']:
        data=copy.deepcopy(base)
        data['status']['refreshedAt']=int(time.time()*1000)
        expected={'unset':'maker offline — showing settled markets only','dry-run':'Dry-run','live':'Maker quotes','offline':'maker offline — showing settled markets only','stale':'quotes stale','stopped':'book stopped','empty':'No open quotes','expired':'Quotes unavailable','malformed':'maker offline — showing settled markets only','conflicting':'Quotes unavailable','history':'Dry-run'}[case]
        if case=='live': data['status']['mode']='live'
        if case=='stale': data['status']['refreshedAt']-=91000
        if case=='stopped': data['status']['stopped']=True
        if case=='empty': data['quotes']=[]
        if case=='expired': data['quotes'][0]['expiryHeight']=974417
        if case=='malformed': data={'quotes':[]}
        if case=='conflicting': data['quotes'][1]['market']={**data['quotes'][1]['market'], 'strikeTarget':'42'}
        # Unset means no harness override: the real default must fail offline.
        html=SOURCE if case=='unset' else SOURCE.replace(declaration, f'const MAKER_BASE_URL = "{maker}";')
        path=Path(temp)/'index.html'
        page,blocked=isolated_page({'width':390,'height':844}, path.as_uri(), reduced_motion='reduce')
        if case=='live' and protocol=='served': page.clock.install()
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        def console(m):
          if m.type=='error' and not (case=='unset' and m.location['url']==production+'/quotes'
                                      and 'ERR_BLOCKED_BY_CLIENT' in m.text): errors.append(m.text)
        page.on('console',console)
        history=[dict(marketId='fixture-only',winnerSide='yes',txids=['e'*64]) ] if case=='history' else []
        page.add_init_script('''window.__calls=[]; const originalFetch=window.fetch;
          window.fetch=async (url, options) => {
            window.__calls.push({url:String(url),method:options?.method || 'GET',at:Date.now()});
            if(String(url)===ENDPOINT) { REJECT return new Response(JSON.stringify(BOOK)); }
            if(String(url)==='data/pops.json') return new Response(JSON.stringify(HISTORY));
            return originalFetch(url,options);
          };'''.replace('REJECT',"throw new Error('isolated offline fixture');" if case=='offline' else '').replace('ENDPOINT',json.dumps(maker+'/quotes')).replace('BOOK',json.dumps(data)).replace('HISTORY',json.dumps(history)))
        if protocol=='served':
          page.route(url,lambda r:r.fulfill(body=html,content_type='text/html'))
          page.goto(url)
        else:
          path.write_text(html,encoding='utf-8'); page.goto(path.as_uri())
        page.wait_for_timeout(150)
        assert expected in page.locator('#market-status').inner_text(), (protocol,case,page.locator('#market-status').inner_text())
        assert page.locator('#markets button:disabled').count()==2
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (protocol,case,'overflow')
        assert page.locator('#markets button').evaluate_all('(els)=>els.every(e=>e.getBoundingClientRect().height>=44)')
        assert page.locator('.pulse polyline').evaluate('(e)=>getComputedStyle(e).animationName')=='none'
        calls=page.evaluate('window.__calls')
        assert all(c['method']=='GET' for c in calls)
        if case in ['dry-run','live','history']:
          assert page.locator('#yes-price').inner_text()=='5,400 sats'
          assert page.locator('#no-price').inner_text()=='6,000 sats'
          assert '9,700' in page.locator('#yes-detail').inner_text()
          assert '31 blocks' in page.locator('#market-window').inner_text()
        if case=='history' and protocol=='served': assert page.locator('#pops-list a').count()==1
        assert blocked == ([production+'/quotes'] if case=='unset' else []), (protocol,case,blocked)
        if case=='unset': assert not any(c['url']==maker+'/quotes' for c in calls)
        if case in ['dry-run', 'unset'] and protocol=='served':
          page.locator('#markets').screenshot(path=str(ROOT/f'board-mobile-{case}.png'))
        assert not errors,(protocol,case,errors)
        if case=='live' and protocol=='served':
          page.clock.fast_forward(19000)
          assert len([c for c in page.evaluate('window.__calls') if c['url']==maker+'/quotes'])==1
          page.clock.fast_forward(2000)
          assert len([c for c in page.evaluate('window.__calls') if c['url']==maker+'/quotes'])==2
          page.clock.fast_forward(91000)
          assert 'quotes stale' in page.locator('#market-status').inner_text()
        results.append(f'{protocol}/{case}: PASS')
        page.close()
    # Real served and file documents, unmodified configuration and history fetch.
    for target in [url,(ROOT/'docs/index.html').as_uri()]:
      page,blocked=isolated_page({'width':1280,'height':900}, (ROOT/'docs/index.html').as_uri())
      page.goto(target); page.wait_for_timeout(200)
      assert page.locator('#market-status').inner_text()=='maker offline — showing settled markets only'
      assert blocked == [production+'/quotes'], (target,blocked)
      if target==url: assert page.locator('#pops-status').inner_text()=='No Daily pops recorded yet.'
      page.locator('#markets').screenshot(path=str(ROOT/'board-preview.png'))
      page.close()
    browser.close()
finally:
  server.shutdown();server.server_close()
print('\n'.join(results))
print(f'{len(results)} fixture scenarios passed; real served/file offline reads passed (production GET /quotes blocked before DNS); Receipts unchanged.')
