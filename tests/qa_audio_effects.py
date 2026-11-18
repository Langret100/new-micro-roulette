"""End-to-end, non-hardware QA: real MP3 decoding and actual WebAudio source.start() events,
visual FX states, Bluetooth GATT mock, stock and response to missing SFX.
Runs from about:blank because this sandbox disallows browser networking.
"""
from pathlib import Path
import base64,re,json,time
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
raw=(ROOT/'index.html').read_text()
HTML=re.sub(r'<script src="[^"]+"></script>','',re.sub(r'<link rel="stylesheet" href="style.css">','',raw))
MOCK=Path(__file__).with_name('browser_e2e.py').read_text().split("MOCK=r'''",1)[1].split("'''",1)[0]
mp3={file.stem:base64.b64encode(file.read_bytes()).decode() for file in (ROOT/'sounds').glob('*.mp3')}
FAKE_FETCH='''({
  const clips=window.__mp3;
  window.fetch=async(url)=>{
    const name=/\\/([a-z]+)\\.mp3$/.exec(String(url))?.[1];
    if(!name || !clips[name]) return new Response('',{status:404});
    const binary=atob(clips[name]);
    const bytes=Uint8Array.from(binary, c=>c.charCodeAt(0));
    return new Response(bytes,{status:200,headers:{'Content-Type':'audio/mpeg'}});
  };
})'''.replace('({\n','(()=>{\n').replace('\n})','\n})()')

def page_init(browser, width=1366, height=768, soundfiles=None):
  page=browser.new_page(viewport={'width':width,'height':height})
  page.set_default_timeout(5000)
  errors=[]
  page.on('pageerror', lambda e:errors.append(str(e)))
  page.set_content(HTML)
  page.evaluate(MOCK)
  page.evaluate('(clips)=>{window.__mp3=clips;}',soundfiles if soundfiles is not None else mp3)
  page.evaluate(FAKE_FETCH)
  page.add_style_tag(content=(ROOT/'style.css').read_text())
  for name in ('roulette-core.js','inventory-core.js','app.js'): page.add_script_tag(content=(ROOT/name).read_text())
  return page,errors

def diagnostic(page):return page.evaluate('window.__rouletteDiagnostics()')

with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-gpu-sandbox'])
  page,errors=page_init(browser)
  page.locator('#presentBtn').click()
  page.locator('#soundTest').click()
  page.wait_for_function('__rouletteDiagnostics().soundLoaded === 7',timeout=10000)
  page.wait_for_function('document.querySelector("#soundDiagnostic").textContent.includes("시연 완료")',timeout=15000)
  sounds=[t['name'] for t in diagnostic(page)['soundTrace']]
  assert sounds==['start','shake','tick','boost','reveal','win','soldout'],sounds
  assert diagnostic(page)['soundFailures']==[]
  assert diagnostic(page)['soundContext']=='running'
  print('REAL WEB AUDIO: 7/7 MP3 files decoded, played in sequence:',','.join(sounds))
  print('SOUND DIAGNOSTIC:',page.locator('#soundDiagnostic').inner_text())
  # volume changes affect gain in the AudioContext, not just the UI
  page.locator('#volumeSlider').fill('30')
  assert page.locator('#volumeValue').text_content()=='30%'
  page.locator('#soundToggle').uncheck()
  page.locator('#soundTest').click()
  assert '효과음 체크를 먼저' in page.locator('#warning').inner_text()
  assert '음소거' in page.locator('#soundDiagnostic').inner_text()
  count=len(diagnostic(page)['soundTrace'])
  page.locator('#soundToggle').check()
  page.wait_for_timeout(250)
  assert len(diagnostic(page)['soundTrace'])==count
  page.locator('#presentBtn').click()
  # GATT path with real MP3 clips in memory. Fast spins should trigger boosts, ticks etc.
  page.locator('#connectBtn').click()
  page.wait_for_function('__BLE.started===true',timeout=5000)
  page.evaluate('__BLE.emit(0,0,1)')
  page.evaluate('()=>__BLE.shake(2.1)')
  page.wait_for_timeout(1350)
  assert page.locator('#resultOverlay').is_visible()
  trace=[t['name'] for t in diagnostic(page)['soundTrace']][count:]
  print('LIVE ROUND AUDIO:',','.join(trace))
  for expected in ('start','shake','tick','reveal','win'):
    assert expected in trace,f'{expected} missing from real simulated game playback: {trace}'
  assert page.locator('#confetti').locator('span').count()>=80
  assert page.locator('#resultCard').evaluate('(e)=>e.classList.contains("pop-in")')
  assert '지급 1개' in page.locator('#issuedCount').text_content()
  print('LIVE FX: confetti, result pop, pointer ticks, celebration PASS')
  assert not errors,errors
  page.close()

  # Inventory setup: only one limited item. Physically rendered wheel has eight sectors,
  # so the click sound must tick between each visible sector, not only real item indices.
  page,errors=page_init(browser)
  print('SECOND setup operator',flush=True)
  page.locator('#presentBtn').click()
  print('SECOND editor open',flush=True)
  page.locator('#editBtn').click()
  print('SECOND editor opened',flush=True)
  page.locator('.editor-row').nth(0).locator('.entry-name').fill('유일한 상품')
  page.locator('.editor-row').nth(0).locator('.entry-limit').fill('1')
  while page.locator('.editor-row').count()>1:page.locator('.editor-row').last.locator('.remove-row').click()
  print('SECOND save',flush=True)
  page.locator('#savePrizes').click()
  assert len(diagnostic(page)['prizes'])==1
  print('SECOND: one prize saved',flush=True)
  page.locator('#presentBtn').click()
  print('SECOND: connect start',flush=True)
  page.locator('#connectBtn').click()
  page.wait_for_function('__BLE.started===true',timeout=8000)
  print('SECOND: connected',flush=True)
  page.evaluate('__BLE.emit(0,0,1)')
  print('SECOND: shake start',flush=True)
  page.evaluate('()=>__BLE.shake(1.9)')
  print('SECOND: shake done',flush=True)
  page.wait_for_timeout(1400)
  print('SECOND: state', diagnostic(page)['state'],flush=True)
  assert page.locator('#resultOverlay').is_visible()
  assert '유일한 상품' in page.locator('#wonPrize').text_content()
  assert page.locator('#soldOutNote').is_visible()
  trace=[t['name'] for t in diagnostic(page)['soundTrace']]
  # 1.25s delay after result reveal for soldout sound
  page.wait_for_timeout(650)
  trace=[t['name'] for t in diagnostic(page)['soundTrace']]
  assert trace.count('tick')>=2,trace
  assert 'win' in trace and 'soldout' in trace,trace
  print('SINGLE ITEM: 8 visible-sector tick SFX, win, delayed soldout PASS;', 'ticks:',trace.count('tick'))
  page.locator('#overlayNext').click()
  assert len(diagnostic(page)['prizes'])==0
  assert '소진' in page.locator('#mainTitle').text_content()
  page.locator('#presentBtn').click()
  assert page.locator('#testBtn').is_disabled()
  assert not errors,errors
  page.close()

  # Loading actual contents with one missing mp3: operator must get accurate error list.
  broken={k:v for k,v in mp3.items() if k!='boost'}
  page,errors=page_init(browser,soundfiles=broken)
  page.locator('#presentBtn').click()
  page.locator('#soundTest').click()
  page.wait_for_function('__rouletteDiagnostics().soundLoaded === 6')
  assert 'boost' in page.locator('#warning').text_content()
  assert 'boost' in page.locator('#soundDiagnostic').text_content()
  assert 'boost' in diagnostic(page)['soundFailures']
  print('MISSING ASSET: specific missing MP3 is flagged; no false PASS')
  assert not errors,errors
  page.close()
  browser.close()
