from pathlib import Path
from playwright.sync_api import sync_playwright
from base64 import b64encode
root=Path(__file__).resolve().parent.parent
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 page=b.new_page();page.goto('about:blank')
 for path in sorted((root/'sounds').iterdir()):
  if path.suffix not in ('.mp3','.wav'):continue
  encoded=b64encode(path.read_bytes()).decode()
  result=page.evaluate('''async b64=>{const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const ctx=new AudioContext(); const clip=await ctx.decodeAudioData(bytes.buffer);const duration=clip.duration;await ctx.close();return duration}''',encoded)
  assert result>.05,(path,result)
  print(path.name,round(result,3),'seconds decoded')
 b.close()
