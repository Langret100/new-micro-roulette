from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
html=(ROOT/'index.html').read_text()
html=re.sub(r'<link rel="stylesheet" href="style.css">','',html)
html=re.sub(r'<script src="[^\"]+"></script>','',html)
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-gpu-sandbox'])
    for width,height in [(1366,768),(1920,1080),(1024,768),(390,844),(360,640)]:
        page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
        errs=[]
        page.on('pageerror',lambda e:errs.append(str(e)))
        page.set_content(html)
        page.evaluate('''() => {
          const data=new Map();
          Object.defineProperty(window, 'localStorage', {configurable:true,value:{getItem:(k)=>data.has(k)?data.get(k):null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}});
          Object.defineProperty(window,'isSecureContext',{configurable:true,get:()=>true});
          Object.defineProperty(navigator,'bluetooth',{configurable:true,value:{requestDevice:async()=>{throw new DOMException('cancel','NotFoundError')}}});
        }''')
        page.add_style_tag(content=(ROOT/'style.css').read_text())
        for script in ['roulette-core.js','inventory-core.js','app.js']:
            page.add_script_tag(content=(ROOT/script).read_text())
        page.wait_for_timeout(200)
        info=page.evaluate('''()=>({vw:innerWidth,vh:innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,wheel:Math.round(document.getElementById('wheelCanvas').getBoundingClientRect().width),wheelY:Math.round(document.getElementById('wheelCanvas').getBoundingClientRect().y),topbar:document.querySelector('.topbar'),side: getComputedStyle(document.querySelector('.side-panel')).visibility,buttons: [...document.querySelectorAll('.floating-dock button')].map(x=>x.innerText)})''')
        print(width,height,info,'errors',errs)
        page.screenshot(path=f'/mnt/data/roulette_review_{width}.png',full_page=True)
        page.locator('#presentBtn').click()
        print('drawer',page.locator('body').get_attribute('class'), page.locator('#operatorPanel').is_visible())
        page.close()
    browser.close()
