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
focused=[]
regressions=[]
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
    # Focused real-browser polling probes. The same DNS/proxy/route guard remains active.
    controlled_fetch='''window.__calls=[]; window.__waiting=[]; window.__active=0;
      window.__hold=HOLD; window.__book=BOOK; const originalFetch=window.fetch;
      window.fetch=(url,options={}) => {
        const target=String(url);
        if(target===ENDPOINT) {
          window.__calls.push({url:target,method:options.method || 'GET',at:Date.now()});
          if(window.__hold) {
            window.__active++;
            return new Promise((resolve,reject) => {
              const pending={settled:false};
              pending.resolve=(book) => {
                if(pending.settled) return; pending.settled=true; window.__active--;
                resolve(new Response(JSON.stringify(book),{status:200,headers:{'Content-Type':'application/json'}}));
              };
              pending.reject=() => {
                if(pending.settled) return; pending.settled=true; window.__active--;
                reject(new DOMException('Aborted','AbortError'));
              };
              window.__waiting.push(pending);
              options.signal?.addEventListener('abort',pending.reject,{once:true});
            });
          }
          return Promise.resolve(new Response(JSON.stringify(window.__book),{status:200,headers:{'Content-Type':'application/json'}}));
        }
        if(target==='data/pops.json') return Promise.resolve(new Response('[]'));
        return originalFetch(url,options);
      };
      window.__release=(book) => {
        const pending=window.__waiting.find(p=>!p.settled);
        if(!pending) throw new Error('no pending quote fixture');
        pending.resolve(book);
      };'''.replace('ENDPOINT',json.dumps(maker+'/quotes'))
    def focused_page(hold,book,clock_time=None):
      page,blocked=isolated_page({'width':390,'height':844},None,reduced_motion='reduce')
      page.clock.install() if clock_time is None else page.clock.install(time=clock_time/1000)
      errors=[]
      page.on('pageerror',lambda e: errors.append(str(e)))
      page.on('console',lambda m: errors.append(m.text) if m.type=='error' else None)
      script=controlled_fetch.replace('HOLD','true' if hold else 'false').replace('BOOK',json.dumps(book))
      page.add_init_script(script)
      html=SOURCE.replace(declaration,f'const MAKER_BASE_URL = "{maker}";')
      page.route(url,lambda r:r.fulfill(body=html,content_type='text/html'))
      page.goto(url)
      return page,blocked,errors
    fresh=copy.deepcopy(base); fresh['status']['refreshedAt']=int(time.time()*1000)
    # A slow request aborts at ten seconds; the next poll starts twenty seconds later, never alongside it.
    page,blocked,errors=focused_page(True,fresh)
    page.wait_for_function('window.__calls.length===1 && window.__active===1')
    # Hiding and resuming while the first fetch is pending must not start another.
    page.evaluate('''()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
      document.dispatchEvent(new Event('visibilitychange'));}''')
    assert len(page.evaluate('window.__calls'))==1
    assert page.evaluate('window.__active')==1
    page.evaluate('''()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
      document.dispatchEvent(new Event('visibilitychange'));}''')
    assert len(page.evaluate('window.__calls'))==1
    assert page.evaluate('window.__active')==1
    page.clock.fast_forward(9999)
    assert len(page.evaluate('window.__calls'))==1
    page.clock.fast_forward(1)
    page.wait_for_function("document.getElementById('market-status').textContent.includes('maker offline')")
    assert page.evaluate('window.__active')==0
    page.evaluate('(book)=>{window.__hold=false;window.__book=book}',fresh)
    page.clock.fast_forward(18000)
    assert len(page.evaluate('window.__calls'))==1
    page.clock.fast_forward(3000)
    page.wait_for_function("document.getElementById('market-status').textContent.includes('Dry-run')")
    assert len(page.evaluate('window.__calls'))==2
    assert page.evaluate('window.__active')==0
    assert all(c['method']=='GET' for c in page.evaluate('window.__calls'))
    assert blocked==[] and errors==[],(blocked,errors)
    focused.append('focused/slow-poll-timeout-and-serial-retry: PASS')
    page.close()
    # A delayed older producer snapshot, even an expired one, cannot replace the newer display or expiry schedule.
    page,blocked,errors=focused_page(False,fresh)
    page.wait_for_function("document.getElementById('market-status').textContent.includes('Dry-run')")
    assert len(page.evaluate('window.__calls'))==1
    stale=copy.deepcopy(base)
    stale['status']['refreshedAt']=0
    stale['quotes'][0]['quoteId']='1'*64; stale['quotes'][0]['takerStake']=1111; stale['quotes'][0]['makerStake']=8889
    stale['quotes'][1]['quoteId']='2'*64; stale['quotes'][1]['takerStake']=2222; stale['quotes'][1]['makerStake']=7778
    page.evaluate('(book)=>{window.__hold=true;window.__book=book}',stale)
    page.clock.fast_forward(20000)
    page.wait_for_function('window.__calls.length===2 && window.__active===1')
    page.clock.fast_forward(9000)
    assert len(page.evaluate('window.__calls'))==2
    page.evaluate('(book)=>window.__release(book)',stale)
    page.wait_for_function('window.__calls.length===2 && window.__active===0')
    page.wait_for_timeout(100)
    assert 'Dry-run' in page.locator('#market-status').inner_text()
    assert page.locator('#yes-price').inner_text()=='5,400 sats'
    assert page.locator('#no-price').inner_text()=='6,000 sats'
    assert '1,111' not in page.locator('#markets').inner_text()
    assert '2,222' not in page.locator('#markets').inner_text()
    page.clock.fast_forward(18000)
    assert len(page.evaluate('window.__calls'))==2
    page.evaluate('''()=>{window.__hold=false;window.__book=JSON.parse(JSON.stringify(window.__book));
      window.__book.status.refreshedAt=Date.now();window.__book.status.stale=false;
      window.__book.quotes[0].takerStake=5400;window.__book.quotes[0].makerStake=4600;
      window.__book.quotes[1].takerStake=6000;window.__book.quotes[1].makerStake=4000;}''')
    page.clock.fast_forward(3000)
    page.wait_for_function("document.getElementById('market-status').textContent.includes('Dry-run')")
    assert len(page.evaluate('window.__calls'))==3
    assert page.locator('#yes-price').inner_text()=='5,400 sats'
    assert page.locator('#no-price').inner_text()=='6,000 sats'
    assert all(c['method']=='GET' for c in page.evaluate('window.__calls'))
    assert blocked==[] and errors==[],(blocked,errors)
    focused.append('focused/delayed-stale-response-cannot-overwrite-live-display: PASS')
    page.close()
    # REGRESSION: sequential fresh responses with decreasing producer time must retain the newer book.
    # This is distinct from the expired snapshot above; every response remains inside 90 seconds.
    newer=copy.deepcopy(base)
    characterization_now=1795718400000
    newer_timestamp=characterization_now-10000
    newer['status']['refreshedAt']=newer_timestamp
    page,blocked,errors=focused_page(False,newer,characterization_now)
    page.wait_for_function("document.getElementById('market-status').textContent.includes('Dry-run')")
    assert len(page.evaluate('window.__calls'))==1
    assert page.evaluate('window.__active')==0
    before_yes=page.locator('#yes-price').inner_text()
    before_no=page.locator('#no-price').inner_text()
    before_window=page.locator('#market-window').inner_text()
    before_yes_detail=page.locator('#yes-detail').inner_text()
    assert before_yes=='5,400 sats' and before_no=='6,000 sats'
    older=copy.deepcopy(base)
    older_timestamp=newer_timestamp-10000
    older['status']['refreshedAt']=older_timestamp
    older['status']['currentHeight']=974416
    older['quotes'][0]['quoteId']='1'*64; older['quotes'][0]['takerStake']=1111; older['quotes'][0]['makerStake']=8889; older['quotes'][0]['expiryHeight']=974419
    older['quotes'][1]['quoteId']='2'*64; older['quotes'][1]['takerStake']=2222; older['quotes'][1]['makerStake']=7778; older['quotes'][1]['expiryHeight']=974419
    page.evaluate('(book)=>{window.__book=book}',older)
    page.clock.fast_forward(20000)
    page.wait_for_function('window.__calls.length===2 && window.__active===0')
    page.wait_for_function("document.getElementById('market-status').textContent.includes('Dry-run')")
    older_age=page.evaluate('(timestamp)=>Date.now()-timestamp',older_timestamp)
    assert 0<=older_age<90000,older_age
    after_yes=page.locator('#yes-price').inner_text()
    after_no=page.locator('#no-price').inner_text()
    assert (after_yes,after_no)==('5,400 sats','6,000 sats'),(
      f'fresh-but-older overwrite: expected YES 5,400 sats / NO 6,000 sats; '
      f'got YES {after_yes} / NO {after_no}'
    )
    assert page.locator('#market-window').inner_text()==before_window
    assert page.locator('#yes-detail').inner_text()==before_yes_detail
    # A subsequent newer producer snapshot must still replace the retained book and expiry schedule.
    recovery=copy.deepcopy(base)
    recovery_timestamp=newer_timestamp+20000
    recovery['status']['refreshedAt']=recovery_timestamp
    recovery['status']['currentHeight']=974418
    recovery['quotes'][0]['quoteId']='3'*64; recovery['quotes'][0]['takerStake']=7700; recovery['quotes'][0]['makerStake']=2300; recovery['quotes'][0]['expiryHeight']=974422
    recovery['quotes'][1]['quoteId']='4'*64; recovery['quotes'][1]['takerStake']=8800; recovery['quotes'][1]['makerStake']=1200; recovery['quotes'][1]['expiryHeight']=974422
    page.evaluate('(book)=>{window.__book=book}',recovery)
    page.clock.fast_forward(20000)
    page.wait_for_function('window.__calls.length===3 && window.__active===0')
    page.wait_for_function("document.getElementById('market-status').textContent.includes('Dry-run')")
    recovery_age=page.evaluate('(timestamp)=>Date.now()-timestamp',recovery_timestamp)
    assert 0<=recovery_age<90000,recovery_age
    assert page.locator('#yes-price').inner_text()=='7,700 sats'
    assert page.locator('#no-price').inner_text()=='8,800 sats'
    assert '30 blocks to close' in page.locator('#market-window').inner_text()
    assert 'quote expires at block 974,422' in page.locator('#yes-detail').inner_text()
    assert all(c['method']=='GET' for c in page.evaluate('window.__calls'))
    assert blocked==[] and errors==[],(blocked,errors)
    regressions.append(
      f'regression/sequential-fresh-but-older-producer-snapshot: PASS — '
      f'refreshedAt {newer_timestamp} -> {older_timestamp} ms (older age {older_age} ms < 90000) retained '
      f'YES {before_yes} / NO {before_no} and the newer expiry schedule; '
      f'newer {recovery_timestamp} ms (age {recovery_age} ms) accepted YES 7,700 sats / NO 8,800 sats'
    )
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
print('\n'.join(focused))
print('\n'.join(regressions))
print(f'{len(results)} fixture scenarios + {len(focused)} focused polling probes + {len(regressions)} sequential fresh-older/newer-recovery regression passed; real served/file offline reads passed (production GET /quotes blocked before DNS); Receipts unchanged.')
