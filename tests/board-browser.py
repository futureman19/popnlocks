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
    browser = pw.chromium.launch()
    for protocol in ['served', 'file']:
      for case in ['unset','dry-run','live','offline','stale','stopped','empty','expired','malformed','conflicting','history']:
        data=copy.deepcopy(base)
        data['status']['refreshedAt']=int(time.time()*1000)
        expected={'unset':'Maker offline','dry-run':'Dry-run','live':'Maker quotes','offline':'Maker offline','stale':'Quotes stale','stopped':'Maker stopped','empty':'No open quotes','expired':'Quotes unavailable','malformed':'Maker offline','conflicting':'Quotes unavailable','history':'Dry-run'}[case]
        if case=='live': data['status']['mode']='live'
        if case=='stale': data['status']['refreshedAt']-=91000
        if case=='stopped': data['status']['stopped']=True
        if case=='empty': data['quotes']=[]
        if case=='expired': data['quotes'][0]['expiryHeight']=974417
        if case=='malformed': data={'quotes':[]}
        if case=='conflicting': data['quotes'][1]['market']={**data['quotes'][1]['market'], 'strikeTarget':'42'}
        html=SOURCE if case=='unset' else SOURCE.replace('name="popnlocks-maker" content=""','name="popnlocks-maker" content="https://maker.invalid"')
        page=browser.new_page(viewport={'width':390,'height':844}, reduced_motion='reduce')
        if case=='live' and protocol=='served': page.clock.install()
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.on('console',lambda m: errors.append(m.text) if m.type=='error' else None)
        # Avoid external font/network variability; not part of board functionality.
        page.route('https://fonts.googleapis.com/**',lambda r:r.fulfill(status=200,body='',content_type='text/css'))
        history=[dict(marketId='fixture-only',winnerSide='yes',txids=['e'*64]) ] if case=='history' else []
        page.add_init_script('''window.__calls=[]; const originalFetch=window.fetch;
          window.fetch=async (url, options) => {
            window.__calls.push({url:String(url),method:options?.method || 'GET',at:Date.now()});
            if(String(url).includes('maker.invalid')) { REJECT return new Response(JSON.stringify(BOOK)); }
            if(String(url)==='data/pops.json') return new Response(JSON.stringify(HISTORY));
            return originalFetch(url,options);
          };'''.replace('REJECT',"throw new Error('isolated offline fixture');" if case=='offline' else '').replace('BOOK',json.dumps(data)).replace('HISTORY',json.dumps(history)))
        if protocol=='served':
          page.route(url,lambda r:r.fulfill(body=html,content_type='text/html'))
          page.goto(url)
        else:
          path=Path(temp)/'index.html'; path.write_text(html,encoding='utf-8'); page.goto(path.as_uri())
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
        if case=='unset': assert not any('maker.invalid' in c['url'] for c in calls)
        if case in ['dry-run', 'unset'] and protocol=='served':
          page.locator('#markets').screenshot(path=str(ROOT/f'board-mobile-{case}.png'))
        assert not errors,(protocol,case,errors)
        if case=='live' and protocol=='served':
          page.clock.fast_forward(29000)
          assert len([c for c in page.evaluate('window.__calls') if 'maker.invalid' in c['url']])==1
          page.clock.fast_forward(2000)
          assert len([c for c in page.evaluate('window.__calls') if 'maker.invalid' in c['url']])==2
          page.clock.fast_forward(91000)
          assert 'Quotes stale' in page.locator('#market-status').inner_text()
        results.append(f'{protocol}/{case}: PASS')
        page.close()
    # Real served and file documents, unmodified configuration and history fetch.
    for target in [url,(ROOT/'docs/index.html').as_uri()]:
      page=browser.new_page(viewport={'width':1280,'height':900})
      page.route('https://fonts.googleapis.com/**',lambda r:r.fulfill(body='',content_type='text/css'))
      page.goto(target); page.wait_for_timeout(200)
      assert page.locator('#market-status').inner_text()=='Maker offline'
      if target==url: assert page.locator('#pops-status').inner_text()=='No Daily pops recorded yet.'
      page.locator('#markets').screenshot(path=str(ROOT/'board-preview.png'))
      page.close()
    browser.close()
finally:
  server.shutdown();server.server_close()
print('\n'.join(results))
print(f'{len(results)} fixture scenarios passed; real served/file offline reads passed; Receipts unchanged.')
