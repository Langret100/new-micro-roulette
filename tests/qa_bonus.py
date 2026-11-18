"""Regression for the built-in '한 번 더' reward: never abandon the same player."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
html=re.sub(r'<script src="[^"]+"></script>','',re.sub(r'<link rel="stylesheet" href="style.css">','',(root/'index.html').read_text()))
mock=Path(__file__).with_name('browser_e2e.py').read_text().split("MOCK=r'''",1)[1].split("'''",1)[0]
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-gpu-sandbox'])
 page=b.new_page(viewport={'width':1366,'height':768})
 page.set_default_timeout(6000)
 errs=[];page.on('pageerror',lambda e:errs.append(str(e)))
 page.set_content(html);page.evaluate(mock);page.add_style_tag(content=(root/'style.css').read_text())
 for f in ('roulette-core.js','inventory-core.js','app.js'):page.add_script_tag(content=(root/f).read_text())
 page.locator('#presentBtn').click()
 page.locator('#editBtn').click()
 while page.locator('.editor-row').count()>2:page.locator('.editor-row').last.locator('.remove-row').click()
 page.locator('.editor-row').nth(0).locator('.entry-name').fill('한 번 더')
 page.locator('.editor-row').nth(0).locator('.entry-limit').fill('2')
 page.locator('.editor-row').nth(1).locator('.entry-name').fill('실물 선물')
 page.locator('.editor-row').nth(1).locator('.entry-limit').fill('2')
 page.locator('#savePrizes').click()
 page.locator('#presentBtn').click()
 page.locator('#connectBtn').click()
 page.wait_for_function('window.__BLE.started===true',timeout=6000)
 # Deterministically settle at sector zero: this is TEST-ONLY and not shipped into runtime.
 page.evaluate('''() => {RouletteCore.WheelGame.prototype.tick=function(dt,now){
   if(this.state==='spinning'){this.angle=0;this.velocity=0;this.resultIndex=0;this.state='result';return true;}
   return false;
 }}''')
 page.evaluate('()=>__BLE.shake(1.2)')
 page.wait_for_function('!document.querySelector("#resultOverlay").hidden',timeout=6000)
 d=page.evaluate('__rouletteDiagnostics()')
 assert '보너스 찬스' in page.locator('#resultTitle').text_content()
 assert d['bonusQueued'] and d['history'][0]['prize']=='한 번 더',d
 assert page.locator('#overlayNext').text_content()=='🎡 같은 참가자 다시 돌리기'
 page.wait_for_function('__rouletteDiagnostics().bonusRound === true',timeout=8000)
 d=page.evaluate('__rouletteDiagnostics()')
 assert d['bonusRound'] and d['prizes']==['실물 선물'],d
 assert '보너스 한 판' in page.locator('#mainTitle').text_content()
 page.evaluate('()=>__BLE.shake(1.2)')
 page.wait_for_function('!document.querySelector("#resultOverlay").hidden',timeout=6000)
 d=page.evaluate('__rouletteDiagnostics()')
 assert '실물 선물' in page.locator('#wonPrize').text_content()
 assert len(d['history'])==2 and d['history'][0]['prize']=='실물 선물',d
 assert not d['bonusQueued']
 page.locator('#overlayNext').click()
 d=page.evaluate('__rouletteDiagnostics()')
 assert not d['bonusRound'] and len(d['prizes'])==2,d
 assert not errs,errs
 print('PASS: 한 번 더 → 같은 참가자 재도전 → 보너스 칸 제외 → 실제 선물 당첨 → 일반 룰렛 복귀')
 b.close()
