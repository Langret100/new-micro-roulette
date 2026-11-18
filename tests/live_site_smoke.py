from pathlib import Path
import http.server, socketserver, threading, os
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
os.chdir(root)
server=socketserver.TCPServer(('127.0.0.1',0),Quiet)
threading.Thread(target=server.serve_forever,daemon=True).start()
url=f'http://127.0.0.1:{server.server_address[1]}/'
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'],headless=True)
  page=browser.new_page(viewport={'width':1366,'height':768})
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(url,wait_until='networkidle')
  page.wait_for_function('window.__rouletteDiagnostics().inventory.length>=8')
  print('bundle TXT loaded:',page.evaluate('window.__rouletteDiagnostics().rewardSource'))
  page.locator('#presentBtn').click()
  page.locator('#soundTest').click()
  page.wait_for_function('window.__rouletteDiagnostics().soundLoaded===8',timeout=10000)
  print('decoded audio files:',page.evaluate('window.__rouletteDiagnostics().soundLoaded'))
  print('sound failures:',page.evaluate('window.__rouletteDiagnostics().soundFailures'))
  page.wait_for_function("document.querySelector('#soundDiagnostic').textContent.includes('시연 완료')",timeout=15000)
  print('effect sequence:',page.evaluate('window.__rouletteDiagnostics().soundTrace.map(x=>x.name)'))
  print('JS errors:',errors)
  assert not errors
  assert page.evaluate('window.__rouletteDiagnostics().soundFailures.length')==0
  browser.close()
finally:server.shutdown()
