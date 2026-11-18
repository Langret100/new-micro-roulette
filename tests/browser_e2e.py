"""Chromium DOM/Canvas/GATT simulated sensor integration tests. No physical micro:bit attached.
The current container blocks browser navigation, so the *same* HTML, CSS and JS are
injected into about:blank and Web Bluetooth is replaced by a spec-shaped GATT mock.
"""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
html=re.sub(r'<script src="[^\"]+"></script>','',re.sub(r'<link rel="stylesheet" href="style.css">','',(ROOT/'index.html').read_text()))
MOCK=r'''
(() => {
  const data = new Map();
  Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>data.has(k)?data.get(k):null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}});
  Object.defineProperty(window,'isSecureContext',{configurable:true,get:()=>true});
  const listeners = new Map();
  const chars = {
    data:{
      value:new DataView(new ArrayBuffer(6)), listeners:new Map(),
      addEventListener(name,fn){this.listeners.set(name,fn)},
      removeEventListener(name,fn){if(this.listeners.get(name)===fn)this.listeners.delete(name)},
      async startNotifications(){window.__BLE.started=true;return this},
      async stopNotifications(){window.__BLE.stopped=true;return this}
    },
    period:{ async writeValueWithResponse(buffer){window.__BLE.period=Array.from(buffer)} }
  };
  const service={async getCharacteristic(uuid){return uuid.startsWith('e95dca4b')?chars.data:chars.period}};
  const device={name:'BBC micro:bit [mocok]',listeners:new Map(),
    addEventListener(k,f){this.listeners.set(k,f)},removeEventListener(k,f){if(this.listeners.get(k)===f)this.listeners.delete(k)},
    gatt:{connected:false,async connect(){this.connected=true;return {getPrimaryService:async uuid=>{window.__BLE.service=uuid;return service}}},
      disconnect(){this.connected=false;const f=device.listeners.get('gattserverdisconnected');if(f)f({target:device})}}
  };
  window.__BLE={device,service:null,period:null,started:false,stopped:false,emitted:0,
    emit(x,y,z){
      const view=chars.data.value;
      for(const [i,v] of [x,y,z].entries())view.setInt16(i*2,Math.max(-32000,Math.min(32000,Math.round(v*1000))),true);
      this.emitted++;
      const f=chars.data.listeners.get('characteristicvaluechanged');if(f)f({target:chars.data});
    },
    async shake(seconds=1.8){
      const start=performance.now();return new Promise(resolve=>{
        const loop=setInterval(()=>{
          const t=(performance.now()-start)/1000;
          if(t>seconds+1){clearInterval(loop);resolve();return}
          if(t>seconds){this.emit(0,0,1);return}
          const amp=1.25+Math.sin(t*2.4)*.32,beat=Math.sin(t*2*Math.PI*4.4);
          this.emit(beat*amp,Math.cos(t*2*Math.PI*4.4)*.72,1+Math.sin(t*2*Math.PI*8.8)*.43);
        },20)
      });
    }
  };
  Object.defineProperty(navigator,'bluetooth',{configurable:true,value:{async requestDevice(opt){window.__BLE.filters=opt.filters;return device}}});
  data.set('capsule-inventory-v2',JSON.stringify([{id:'p-candy',name:'사탕',grade:1,issued:0,limit:10},{id:'p-rare',name:'키링',grade:3,issued:0,limit:10}]));
  // Headless has no real user gesture audio output, but AudioContext is allowed.
})();
'''
with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-gpu-sandbox'])
  page=browser.new_page(viewport={'width':1366,'height':768})
  errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(html)
  page.evaluate(MOCK)
  page.add_style_tag(content=(ROOT/'style.css').read_text())
  for name in ['roulette-core.js','inventory-core.js','app.js']:page.add_script_tag(content=(ROOT/name).read_text())
  assert page.locator('header.topbar').count()==0
  assert page.locator('#wheelCanvas').bounding_box()['width']>=680
  assert page.locator('.side-panel').is_hidden()
  page.locator('#connectBtn').click()
  page.wait_for_function('window.__BLE.started===true && window.__BLE.period?.[0]===20')
  print('GATT service',page.evaluate('__BLE.service'),'period',page.evaluate('__BLE.period'))
  assert page.locator('#connectionState').inner_text().find('무선 연결됨')>=0
  # Let device stream static first, then start actual shaking.
  page.evaluate('__BLE.emit(0,0,1)')
  page.wait_for_timeout(160)
  assert '센서 데이터 수신 확인' in page.locator('#bleLive').inner_text()
  page.evaluate('() => __BLE.shake(2)')
  page.wait_for_timeout(1400)
  assert page.locator('#resultOverlay').is_visible(),page.locator('#stageStatus').inner_text()
  result=page.locator('#wonPrize').inner_text()
  prizes=page.locator('#issuedCount').text_content()
  print('BLE awarded result:',result,'issued:',prizes,'notifications:',page.evaluate('__BLE.emitted'))
  assert '지급 1개' in prizes
  page.screenshot(path='/mnt/data/roulette_review_result.png',full_page=True)
  page.locator('#overlayNext').click()
  assert page.locator('#resultOverlay').is_hidden()
  page.locator('#presentBtn').click()
  assert page.locator('#operatorPanel').is_visible()
  assert page.locator('#resultCount').text_content()=='1회'
  # Exactly one award undo
  page.on('dialog',lambda d:d.accept())
  page.locator('#undoLast').click()
  assert '지급 0개' in page.locator('#issuedCount').text_content()
  page.locator('#presentBtn').click()
  assert page.locator('#operatorPanel').is_hidden()
  # Mid-spin disconnect is not awarded
  page.evaluate('''() => {let t=0;window.__mockSpin=setInterval(()=>{t+=.028;__BLE.emit(Math.sin(t*35)*2,0,1);},28)}''')
  page.wait_for_timeout(700)
  page.evaluate('''() => {clearInterval(window.__mockSpin);__BLE.device.gatt.disconnect()}''')
  assert '미연결' in page.locator('#connectionState').inner_text()
  assert '지급 0개' in page.locator('#issuedCount').text_content()
  assert page.locator('#stageToast').is_visible()
  # Reconnect but do not transmit accelerometer samples; app must visibly flag the dead stream.
  page.locator('#connectBtn').click()
  page.wait_for_function('window.__BLE.device.gatt.connected')
  page.wait_for_timeout(3200)
  assert '가속도 데이터가 도착하지 않습니다' in page.locator('#stageToast').text_content()
  page.evaluate('__BLE.emit(0.33,0.25,1.02)')
  page.wait_for_timeout(900)
  assert page.locator('#stageToast').is_hidden()
  assert '가속도 실측' in page.locator('#bleDiagnostics').text_content()
  print('no BLE packets -> warning -> live packet recovery PASS')
  print('disconnect cancelled spin; warning and safe cancel PASS');
  print('JS errors:',errors)
  assert not errors,errors
  browser.close()
