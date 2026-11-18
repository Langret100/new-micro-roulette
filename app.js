/* Capsule Shake! Runs locally. BLE provides motion; no server, analytics, or network libraries. */
(() => {
  'use strict';
  const {TAU,clamp,wrap,winningIndex,WheelGame} = window.RouletteCore;
  const secureRandom=()=>{if(crypto?.getRandomValues){const a=new Uint32Array(1);crypto.getRandomValues(a);return a[0]/4294967296;}return Math.random();};
  const Stock = window.CapsuleInventory;
  const SERVICE = 'e95d0753-251d-470a-a062-fa1922dfa9a8';
  const DATA = 'e95dca4b-251d-470a-a062-fa1922dfa9a8';
  const PERIOD = 'e95dfb24-251d-470a-a062-fa1922dfa9a8';
  const DEFAULTS = ['반짝 스티커','미니 노트','젤리','캐릭터 연필','키링','초콜릿','깜짝 선물','한 번 더'];
  const GRADE_NAMES=['','일반','고급','희귀','전설'];
  const COLORS=['#8760EA','#FF82B8','#FFCD60','#45D5CD','#AD78EF','#FF9882','#63C7F9','#B3DE76','#F6B75B','#C38BF7','#5CCCA2','#E994C8','#90A8FE','#EEC267','#6ED8E1','#FB9393'];
  const $=id=>document.getElementById(id);
  let storageError=false;
  function load(key, fallback){try{let v=localStorage.getItem(key);return v===null?fallback:JSON.parse(v);}catch(_){return fallback;}}
  function save(key,data){try{localStorage.setItem(key,JSON.stringify(data));}catch(_){storageError=true;showWarning('⚠ 브라우저 저장이 차단되어 지급 수량이 새로고침 후 사라질 수 있습니다. 브라우저 저장소를 허용해 주세요.');}}
  const hasNew=load('capsule-inventory-v2',null);
  const oldNames=load('capsule-prizes',null);
  let inventory;
  try{inventory=Stock.normalizeInventory(hasNew!==null?hasNew:(Array.isArray(oldNames)?Stock.fromNames(oldNames):[]));}
  catch(_){inventory=[];}
  // First visit reads the bundled editable rewards.txt; a locally saved list always wins.
  const shouldLoadBundled=hasNew===null&&!Array.isArray(oldNames);
  if(!shouldLoadBundled)try{localStorage.setItem('capsule-inventory-v2',JSON.stringify(inventory));}catch(_){storageError=true;}
  let history=load('capsule-history',[]);
  if(!Array.isArray(history))history=[];
  history=history.filter(x=>x && typeof x.prize==='string' && Number.isFinite(x.time)).slice(0,100);
  let autoNext=load('capsule-auto',true)!==false;
  // New display mode defaults to a full-screen wheel. Legacy panel preference is not carried over.
  let presentation=load('capsule-stage-v3',true)!==false;
  let soundOn=load('capsule-sound',true)!==false;
  let volume=clamp(Number(load('capsule-volume',65))||0,0,100);
  let roundSlots=Stock.available(inventory);
  let game=new WheelGame(Math.max(1,roundSlots.length));
  let device=null,characteristic=null,isConnecting=false,isTesting=false,demoRound=false,testTimer=null;
  let blePackets=0,bleLastPacketAt=0,bleRateAt=0,bleRateCount=0,bleRate=0,bleWatchdog=null,bleStreamWarned=false;
  let autoTimer=null,countdownTimer=null,stingerTimer=null,lastFrameAt=performance.now(),lastDrawAngle=NaN,lastUiAt=-Infinity;
  let lastPointed=-1,lastTickAt=0,lastPlayedShake=0,lastPowerTier=0,lastPowerMessage=0,revealed=false;
  let pendingReveal=false,bonusQueued=false,bonusRound=false;
  let manualPointer=null;
  let rewardSource=shouldLoadBundled?'기본 TXT 확인 중':'이 기기의 저장 목록';
  let bluetoothAvailable=!!(navigator.bluetooth && window.isSecureContext);
  const canvas=$('wheelCanvas'),ctx=canvas.getContext('2d');
  let canvasSize=0,dpr=1;

  class GameAudio {
    constructor(){
      this.ctx=null;this.master=null;this.compressor=null;this.loading=null;
      this.buffers=new Map();this.errors=new Set();this.activeSources=new Set();
      this.playTrace=[];
    }
    async prepare(){
      if(this.ctx)return;
      if(!window.AudioContext&&!window.webkitAudioContext)return;
      this.ctx=new (window.AudioContext||window.webkitAudioContext)();
      this.master=this.ctx.createGain();
      this.master.gain.value=volume/100*.72;
      this.compressor=this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value=-13;
      this.compressor.knee.value=12;
      this.compressor.ratio.value=3;
      this.compressor.attack.value=.004;
      this.compressor.release.value=.18;
      this.master.connect(this.compressor);
      this.compressor.connect(this.ctx.destination);
      this.loading=this.loadClips(); // Decode before the first participant interacts.
    }
    async unlock(){
      if(!soundOn)return;
      try{
        await this.prepare();
        if(this.ctx&&this.ctx.state!=='running')await this.ctx.resume();
      }catch(_){showWarning('오디오 시작에 실패했습니다. 화면을 터치한 뒤 소리 점검을 실행해 주세요.');}
    }
    async loadClips(){
      $('soundDiagnostic').textContent='🔄 효과음 8종 준비 중…';
      await Promise.all(['start','shake','tick','boost','reveal','win','soldout','brake'].map(async name=>{
        try{
          const response=await fetch('sounds/'+name+(name==='brake'?'.wav':'.mp3'),{cache:'force-cache'});
          if(!response.ok)throw new Error('missing: '+name);
          const buffer=await this.ctx.decodeAudioData(await response.arrayBuffer());
          if(!Number.isFinite(buffer.duration)||buffer.duration<.04)throw new Error('invalid audio: '+name);
          this.buffers.set(name,buffer);
        }catch(_){this.errors.add(name);}
      }));
      $('soundDiagnostic').textContent=this.errors.size
        ?`⚠ 효과음 ${this.buffers.size}/8 준비 · 누락: ${Array.from(this.errors).join(', ')}`
        :'✓ 효과음 8/8 파일 정상 · 버튼으로 각각 시연 가능';
    }
    setVolume(n){if(this.master)this.master.gain.value=n/100*.72;}
    stopAll(){
      for(const source of this.activeSources){try{source.stop();}catch(_){}}
    }
    play(name,loudness=1){
      if(!soundOn || !this.ctx || this.ctx.state!=='running')return false;
      const buffer=this.buffers.get(name);
      if(!buffer)return false;
      const source=this.ctx.createBufferSource(),gain=this.ctx.createGain();
      source.buffer=buffer;gain.gain.value=clamp(loudness,0,1);
      source.connect(gain);gain.connect(this.master);
      this.activeSources.add(source);
      source.onended=()=>{this.activeSources.delete(source);source.disconnect();gain.disconnect();};
      source.start();
      this.playTrace.push({name,time:performance.now()});
      if(this.playTrace.length>200)this.playTrace.shift();
      return true;
    }
  }
  const audio=new GameAudio();
  audio.prepare().catch(()=>{});
  const SOUND_LABELS={start:'출발',shake:'흔들기',tick:'룰렛 클릭',boost:'가속',reveal:'두구두구',win:'당첨 팡파르',soldout:'품절',brake:'끼익 브레이크'};
  let soundTestBusy=false, soundTestToken=0, lastRevealSoundAt=-Infinity;

  $('autoNext').checked=autoNext;
  document.body.classList.toggle('presentation-mode',presentation);
  document.body.classList.toggle('drawer-open',!presentation);
  $('operatorBackdrop').hidden=presentation;
  $('presentBtn').textContent=presentation?'⚙ 운영':'✕ 닫기';
  $('presentBtn').setAttribute('aria-expanded',String(!presentation));
  $('soundToggle').checked=soundOn;
  $('volumeSlider').value=String(volume);
  $('volumeValue').textContent=volume+'%';
  function showWarning(message){
    $('warning').textContent=message;$('warning').hidden=!message;
    $('stageToast').textContent=message;$('stageToast').hidden=!message;
  }
  function setOperator(open){
    presentation=!open;
    document.body.classList.toggle('presentation-mode',presentation);
    document.body.classList.toggle('drawer-open',open);
    $('operatorBackdrop').hidden=!open;
    $('presentBtn').textContent=open?'✕ 닫기':'⚙ 운영';
    $('presentBtn').setAttribute('aria-expanded',String(open));
    save('capsule-stage-v3',presentation);
    requestAnimationFrame(resizeCanvas);
  }
  function burst(){
    const element=$('stageBurst');element.classList.remove('boom');
    void element.offsetWidth;element.classList.add('boom');
  }
  function stopBleWatchdog(){if(bleWatchdog!==null)clearInterval(bleWatchdog);bleWatchdog=null;$('bleLive').hidden=true;$('bleDiagnostics').textContent='미연결 · 캡슐 연결 후 X/Y/Z 수치가 변하는지 확인하세요.';}
  function updateBleFeedback(){
    if(!connected()){stopBleWatchdog();return;}
    const now=performance.now(),age=now-bleLastPacketAt;
    $('bleLive').hidden=false;
    const windowSeconds=Math.max(.1,(now-bleRateAt)/1000);
    bleRate=Math.round((blePackets-bleRateCount)/windowSeconds);
    bleRateCount=blePackets;bleRateAt=now;
    $('bleLive').textContent=blePackets===0?'센서 수신 대기':age<1800?`✓ 센서 ${bleRate}회/초`:'⚠ 센서 신호 없음';
    if(age>=2400&&(!bleStreamWarned||$('stageToast').hidden)){
      bleStreamWarned=true;
      showWarning('블루투스 연결은 되었지만 가속도 데이터가 도착하지 않습니다. 마이크로비트에 가속도 Bluetooth 서비스를 설치했는지 확인하세요.');
    }
    if(age<1800&&bleStreamWarned){bleStreamWarned=false;showWarning('');}
  }
  function startBleWatchdog(){
    stopBleWatchdog();blePackets=0;bleLastPacketAt=performance.now();bleRateAt=bleLastPacketAt;bleRateCount=0;bleRate=0;bleStreamWarned=false;
    $('bleLive').hidden=false;$('bleLive').textContent='센서 수신 대기';$('bleDiagnostics').textContent='블루투스 연결됨 · 센서 첫 데이터 대기 중';
    bleWatchdog=setInterval(updateBleFeedback,750);
  }
  function connected(){return !!device && !!device.gatt && device.gatt.connected && !!characteristic;}
  function connectionUi(){
    $('connectionState').classList.toggle('connected',connected());
    $('connectionState').querySelector('span').textContent=connected()?'무선 연결됨':'미연결';
    $('connectBtn').textContent=isConnecting?'연결 중…':connected()?'✓ 연결됨 · 해제':'📶 마이크로비트 연결';
    $('connectBtn').disabled=isConnecting;
  }
  function setHeadline(phase){
    if(phase==='spinning'){
      $('mainTitle').innerHTML='더 흔들면 <em>더 빠르게!</em>';
      $('hint').textContent='흔드는 힘이 룰렛을 움직여요!';
      $('stageStatus').textContent='🎡 5초 안에 최대한 빠르게 흔들어 보세요!';
    }else if(!roundSlots.length){
      $('mainTitle').innerHTML='오늘의 상품 <em>모두 소진!</em>';
      $('hint').textContent='운영 도구에서 상품 수량을 추가해 주세요.';
      $('stageStatus').textContent='🎁 상품 재고를 채우면 다시 시작할 수 있어요.';
    }else if(phase==='ready'){
      $('mainTitle').innerHTML='캡슐을 흔들어 <em>행운</em>을 돌려요!';
      $('hint').textContent=connected()?'캡슐을 두 번 이상 흔들어 시작해 주세요!':'마이크로비트를 연결하고 캡슐을 흔들어 주세요.';
      $('stageStatus').textContent=connected()?'🟢 준비 완료! 흔들어 주세요!':'연결 후 캡슐을 흔들면 시작!';
    }else{
      $('mainTitle').innerHTML='오늘도 <em>행운 폭발!</em>';
      $('hint').textContent='짜잔! 상품이 결정됐어요!';
      $('stageStatus').textContent='🎁 다음 참가자를 준비하세요!';
    }
  }
  function showReaction(text){
    const el=$('reaction');el.textContent=text;
    el.classList.remove('appear');void el.offsetWidth;el.classList.add('appear');
  }
  function renderPrizes(){
    const totals=Stock.counts(inventory);
    $('prizeCount').textContent=`${totals.active}/${totals.total}종 참여`;
    $('prizeSource').textContent=rewardSource;
    $('activeCount').textContent=`🎯 참여 중 ${totals.active}종`;
    $('issuedCount').textContent=`🎁 총 지급 ${totals.issued}개`;
    $('testBtn').disabled=isTesting||!totals.active;
    $('prizePills').replaceChildren();
    const fragment=document.createDocumentFragment();
    inventory.forEach((item,i)=>{
      const active=item.limit===null || item.issued<item.limit;
      const elt=document.createElement('div');elt.className='prize-pill'+(active?'':' exhausted');
      elt.title=active?item.name+' · '+(item.limit===null?'수량 무제한':`남은 ${item.limit-item.issued}개`):`${item.name} · 소진 완료`;
      const left=document.createElement('span');left.className='prize-name';
      const swatch=document.createElement('i');swatch.style.background=COLORS[i%COLORS.length];
      const label=document.createElement('span');label.textContent=`[${GRADE_NAMES[item.grade||1]}] ${item.name}`;
      left.append(swatch,label);
      const number=document.createElement('b');number.textContent=active?(item.limit===null?'∞':`${item.limit-item.issued}개`):'품절';
      elt.append(left,number);fragment.appendChild(elt);
    });
    $('prizePills').append(fragment);
  }
  function renderHistory(){
    $('resultCount').textContent=history.length?`${history.length}회`:'';
    $('undoLast').disabled=!history.length || !inventory.some(p=>p.id===history[0]?.id&&p.issued>0);
    const frag=document.createDocumentFragment();
    if(!history.length){const empty=document.createElement('p');empty.className='empty';empty.textContent='첫 번째 행운을 기다리는 중 ✨';frag.append(empty);}
    history.slice(0,10).forEach(x=>{
      const line=document.createElement('div');line.className='history-item';
      const label=document.createElement('b');label.textContent=`🎁 ${x.prize}`;
      const t=document.createElement('span');t.textContent=new Date(x.time).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
      line.append(label,t);frag.append(line);
    });
    $('history').replaceChildren(frag);
  }
  function resizeCanvas(){
    const size=Math.max(2,Math.round(canvas.getBoundingClientRect().width));
    const ratio=Math.min(window.devicePixelRatio||1,2);
    if(canvasSize!==size||dpr!==ratio){canvasSize=size;dpr=ratio;canvas.width=Math.round(size*dpr);canvas.height=Math.round(size*dpr);lastDrawAngle=NaN;}
    drawWheel();
  }
  function fitLabel(s,n){const max=n>12?5:n>9?7:n>7?9:12;const letters=Array.from(s);return letters.length>max?letters.slice(0,max-1).join('')+'…':s;}
  function drawWheel(){
    if(!canvasSize)return;
    const center=canvasSize/2,r=canvasSize*.446,rim=canvasSize*.484;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,canvasSize,canvasSize);
    const gold=ctx.createLinearGradient(0,0,canvasSize,canvasSize);
    gold.addColorStop(0,'#fff4bc');gold.addColorStop(.35,'#d78d3c');gold.addColorStop(.7,'#ffe49a');gold.addColorStop(1,'#a86230');
    ctx.beginPath();ctx.arc(center,center,rim,0,TAU);ctx.fillStyle=gold;ctx.fill();
    ctx.beginPath();ctx.arc(center,center,rim*.962,0,TAU);ctx.fillStyle='#392453';ctx.fill();
    const length=roundSlots.length;
    if(length){
      const visualCount=length===1?8:length;
      const step=TAU/visualCount;
      const visualSlots=length===1?Array(8).fill(roundSlots[0]):roundSlots;
      visualSlots.forEach((item,i)=>{
        const start=-Math.PI/2-step/2+i*step;
        ctx.beginPath();ctx.moveTo(center,center);ctx.arc(center,center,r,start,start+step);ctx.closePath();
        const originalIndex=inventory.findIndex(p=>p.id===item.id);
        ctx.fillStyle=COLORS[((originalIndex>=0?originalIndex:i)+(length===1?i%4:0))%COLORS.length];ctx.fill();
        ctx.lineWidth=Math.max(2,canvasSize*.004);ctx.strokeStyle='#ffffffbe';ctx.stroke();
        if(length===1){
          const middle=start+step/2;
          ctx.fillStyle='#fff6c2';ctx.font=`900 ${Math.round(canvasSize*.08)}px system-ui`;
          ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('✦',center+Math.cos(middle)*r*.7,center+Math.sin(middle)*r*.7);
          return;
        }
        const middle=start+step/2,tx=center+Math.cos(middle)*r*.67,ty=center+Math.sin(middle)*r*.67;
        ctx.save();ctx.translate(tx,ty);
        let tilt=wrap(middle+Math.PI/2);if(tilt>Math.PI/2&&tilt<Math.PI*1.5)tilt+=Math.PI;
        ctx.rotate(tilt);
        const font=length>=14?.024:length>=10?.028:.032;
        ctx.font=`900 ${Math.max(10,Math.round(canvasSize*font))}px system-ui,sans-serif`;
        ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineJoin='round';ctx.lineWidth=Math.max(2,canvasSize*.007);
        ctx.strokeStyle='#230d496a';
        const text=fitLabel(item.name,length), maxWidth=Math.min(r*.79,r*.69*step*.88);
        ctx.strokeText(text,0,0,maxWidth);ctx.fillStyle='#fffdf4';ctx.fillText(text,0,0,maxWidth);
        ctx.restore();
      });
    }else{
      ctx.beginPath();ctx.arc(center,center,r,0,TAU);ctx.fillStyle='#62547e';ctx.fill();
      ctx.fillStyle='#fff3c1';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`900 ${canvasSize*.06}px system-ui`;
      ctx.fillText('상품 소진',center,center-canvasSize*.12);
      ctx.font=`600 ${canvasSize*.03}px system-ui`;ctx.fillText('재고를 추가해 주세요',center,center+canvasSize*.15);
    }
    ctx.beginPath();ctx.arc(center,center,r,0,TAU);ctx.lineWidth=Math.max(3,canvasSize*.008);ctx.strokeStyle='#fff7d9';ctx.stroke();
    for(let i=0;i<36;i++){
      const a=i/36*TAU,rr=rim*.98;
      ctx.beginPath();ctx.arc(center+Math.cos(a)*rr,center+Math.sin(a)*rr,Math.max(2,canvasSize*.006),0,TAU);
      ctx.fillStyle=i%2===0?'#fff7d9':'#ffdc75';ctx.fill();
    }
    ctx.beginPath();ctx.arc(center,center,canvasSize*.1,0,TAU);ctx.fillStyle='#f2e5fc';ctx.fill();
    canvas.style.transform=`rotate(${game.angle}rad)`;
    lastDrawAngle=game.angle;
    document.querySelector('.wheel-hub').hidden=!length;
    $('singlePrizeBanner').hidden=length!==1;
    if(length===1)$('singlePrizeName').textContent=roundSlots[0].name;
  }
  // Cached once. The stage gauge is driven by the SAME velocity as the actual wheel.
  const towerSegments=Array.from(document.querySelectorAll('#speedTowerBars i'));
  let towerLevel=-1,towerText='';
  function renderSpeedTower(){
    const isSpinning=game.state==='spinning'||game.state==='decelerating';
    const power=isSpinning?Math.round(clamp(game.velocity/40,0,1)*100):0;
    const level=isSpinning?Math.min(12,Math.ceil(power/100*12)):0;
    if(level!==towerLevel){
      towerLevel=level;
      towerSegments.forEach((bar,i)=>bar.classList.toggle('lit',i<level));
      $('speedTower').classList.toggle('turbo',level>=10);
    }
    const word=power>=86?'MAX POWER!':power>=65?'TURBO!':power>=40?'FAST!':power>=15?'GO!':isSpinning?'START!':'READY';
    const nextText=power+'|'+word;
    if(nextText!==towerText){
      towerText=nextText;
      $('speedTowerValue').textContent=String(power);
      $('speedTowerWord').textContent=word;
      $('speedTower').setAttribute('aria-valuenow',String(power));
      $('speedTower').setAttribute('aria-valuetext',word+' '+power+'%');
    }
  }
  function refreshLive(now){
    if(now-lastUiAt<75)return;lastUiAt=now;
    $('shakeCount').innerHTML=game.manual?'<span>드래그</span>':`${game.roundShakes}<span>회</span>`;
    $('speedText').innerHTML=`${(game.velocity/TAU).toFixed(1)}<span>바퀴/초</span>`;
    const current=game.detector.lastReport;
    const elapsed=now-game.lastMotion;
    const factor=game.state==='spinning'?clamp(1-(elapsed-110)/450,0,1):0;
    const intensity=game.manual&&game.state==='spinning'?game.peakPower:current && game.state==='spinning'?Math.round(clamp(current.intensity*57,0,100)*factor):0;
    $('intensityLabel').textContent=`${intensity}%`;
    $('intensityBar').style.width=`${intensity}%`;
    renderSpeedTower();
    if(game.state==='spinning'){
      const seconds=Math.max(1,Math.ceil((game.maxShakeMs-(now-game.startedAt))/1000));
      $('shakeTimer').textContent=String(seconds);
      $('shakeTimer').hidden=false;
    }else if(game.state==='decelerating'){
      $('shakeTimer').textContent='빙글~';$('shakeTimer').hidden=game.brakeTriggered || game.decelMs<2000;
    }else{$('shakeTimer').hidden=true;}
    $('peakSpeed').textContent=String(game.peakPower||0);
  }
  function cancelTimers(){if(autoTimer!==null)clearTimeout(autoTimer);autoTimer=null;if(countdownTimer!==null)clearInterval(countdownTimer);countdownTimer=null;if(stingerTimer!==null)clearTimeout(stingerTimer);stingerTimer=null;}
  function clearTest(){if(testTimer!==null)clearInterval(testTimer);testTimer=null;isTesting=false;$('testBtn').disabled=!roundSlots.length;}
  function nextRound(){
    if(pendingReveal)return;
    $('nextBtn').disabled=false;
    cancelTimers();clearTest();manualPointer=null;$('resultOverlay').hidden=true;
    bonusRound=bonusQueued;
    bonusQueued=false;
    roundSlots=Stock.available(inventory).filter(item=>!bonusRound||item.name.trim()!=='한 번 더');
    if(bonusRound && !roundSlots.length){bonusRound=false;roundSlots=Stock.available(inventory);}
    game.reset(Math.max(1,roundSlots.length));
    game.decelMs=260;
    game.onChoose=peak=>{
      const selected=window.RouletteCore.chooseReward(roundSlots,peak,secureRandom);
      return roundSlots.findIndex(row=>row.id===selected.id);
    };
    // Public starting position is randomized BEFORE the player shakes, never after a prize is picked.
    game.angle=secureRandom()*TAU;
    demoRound=false;revealed=false;lastPlayedShake=0;lastPowerTier=0;lastPowerMessage=0;lastPointed=-1;
    $('wheelStage').classList.remove('is-spinning','is-fast','is-turbo','is-finishing','comic-braking','is-coasting');
    $('comboBadge').hidden=true;$('reaction').textContent='';$('shakeTimer').hidden=true;
    showWarning(!roundSlots.length?'보상 명단이 비었거나 모두 소진되었습니다. 운영 → 상품 관리에서 등급별 보상을 입력하세요.':storageError?'⚠ 브라우저 저장이 차단되어 지급량이 보존되지 않습니다. 저장소 설정을 확인해 주세요.':'');
    setHeadline('ready');
    if(bonusRound && roundSlots.length){
      $('mainTitle').innerHTML='보너스 한 판! <em>한 번 더!</em>';
      $('hint').textContent='같은 참가자가 캡슐을 다시 흔들어요!';
      $('stageStatus').textContent='✨ 보너스 찬스! 다시 흔들어 주세요!';
    }
    drawWheel();refreshLive(performance.now()+100);renderPrizes();
  }
  function confetti(){
    const frag=document.createDocumentFragment(),palette=['#ffcf60','#ff81be','#64e8d0','#b9a0ff','#ffffff'];
    for(let i=0;i<(window.innerWidth<640?65:110);i++){
      const piece=document.createElement('span');piece.className='confetti';
      piece.style.left=`${Math.random()*100}%`;piece.style.background=palette[i%palette.length];
      piece.style.animationDelay=`${Math.random()*.6}s`;piece.style.animationDuration=`${2+Math.random()*1.6}s`;
      piece.style.setProperty('--drift',`${(Math.random()-.5)*290}px`);
      piece.style.setProperty('--turn',`${(Math.random()-.5)*1020}deg`);
      frag.append(piece);
    }
    $('confetti').replaceChildren(frag);
  }
  function finishRound(){
    pendingReveal=false;
    $('nextBtn').disabled=false;
    const prize=roundSlots[game.resultIndex];
    if(!prize){showWarning('상품 정보가 올바르지 않아 이번 회차는 취소되었습니다.');nextRound();return;}
    if(!demoRound){
      if(!Stock.award(inventory,prize.id)){
        nextRound();showWarning('선택된 상품의 수량이 부족해 회차를 취소했습니다. 상품·재고를 확인해 주세요.');return;
      }
      save('capsule-inventory-v2',inventory);
      history.unshift({id:prize.id,prize:prize.name,grade:prize.grade||1,peak:game.peakPower,time:Date.now(),shakes:game.roundShakes});
      history=history.slice(0,100);save('capsule-history',history);renderHistory();renderPrizes();
    }
    const soldOut=!demoRound && prize.limit!==null && prize.issued>=prize.limit;
    const bonus=!demoRound && !bonusRound && prize.name.trim()==='한 번 더'
      && roundSlots.some(item=>item.name.trim()!=='한 번 더');
    bonusQueued=bonus;
    const subtitles=['운이 좋으셨는데요? 👀','쉿! 행운이 편을 들어줬어요 🤫','와우! 오늘 주인공 등장! ⭐','흔들기의 승리! 💪','룰렛도 깜짝 놀란 결과! 🥳'];
    $('resultTitle').textContent=bonus?'한 번 더! 보너스 찬스!':'짜잔! 당첨입니다!';
    $('resultSubtitle').textContent=bonus?'행운의 룰렛이 한 판 더 선물했어요! 🎉':subtitles[history.length%subtitles.length];
    $('wonPrize').textContent='🎁 '+prize.name;
    $('resultDetails').textContent=`${GRADE_NAMES[prize.grade||1]} 등급 · 최고 속도 ${game.peakPower}%`+(demoRound?' · 🧪 연습 회차(재고 차감 없음)':bonus?' · 🎡 같은 참가자 보너스 찬스':game.manual?' · 손으로 돌리기':` · ${game.roundShakes}번 흔들기`);
    $('soldOutNote').hidden=!soldOut;
    $('resultOverlay').hidden=false;
    $('resultCard').classList.remove('pop-in');void $('resultCard').offsetWidth;$('resultCard').classList.add('pop-in');
    $('wheelStage').classList.remove('is-spinning','is-fast','is-turbo','is-finishing','comic-braking','is-coasting');
    $('comboBadge').hidden=true;
    setHeadline('result');confetti();burst();audio.play('win',1);
    cancelTimers();
    if(soldOut)stingerTimer=setTimeout(()=>audio.play('soldout',.5),1250);
    clearTest();$('countdown').hidden=!autoNext;
    $('overlayNext').textContent=bonus?'🎡 같은 참가자 다시 돌리기':'다음 참가자 ↻';
    if(autoNext){
      const seconds=bonus?5:8;
      const deadline=Date.now()+seconds*1000;
      countdownTimer=setInterval(()=>{
        $('countdown').textContent=bonus?`${Math.max(0,Math.ceil((deadline-Date.now())/1000))}초 후 같은 참가자 재도전`:`${Math.max(0,Math.ceil((deadline-Date.now())/1000))}초 후 자동으로 다음 차례`;
      },250);
      $('countdown').textContent=bonus?'5초 후 같은 참가자 재도전':'8초 후 자동으로 다음 차례';
      autoTimer=setTimeout(nextRound,seconds*1000);
    }
  }
  function onSample(x,y,z,now=performance.now()){
    if(!$('editOverlay').hidden||game.manual||game.state==='result'||!roundSlots.length)return;
    const previousState=game.state,previousShakes=game.roundShakes;
    const report=game.sample(x,y,z,now);
    if(!report)return;
    if(previousState==='ready'&&game.state==='spinning'){
      soundTestToken++;
      setHeadline('spinning');$('wheelStage').classList.add('is-spinning');
      showReaction(demoRound?'🧪 연습 출발!':'🎡 출발~!');burst();audio.play('start',.8);
      if(demoRound)$('stageStatus').textContent='🧪 연습 중! 당첨되어도 재고는 그대로예요';
    }
    if(game.state!=='spinning')return;
    if(game.roundShakes>previousShakes && now-lastPlayedShake>135){
      lastPlayedShake=now;audio.play('shake',.24);
      const shake=game.roundShakes;
      if(shake>=3){
        $('comboBadge').hidden=false;
        $('comboBadge').querySelector('span').textContent=String(shake);
        $('comboBadge').classList.remove('pop');void $('comboBadge').offsetWidth;$('comboBadge').classList.add('pop');
      }
    }
    const newTier=game.velocity>31?3:game.velocity>23?2:game.velocity>13?1:0;
    if(newTier>lastPowerTier && now-lastPowerMessage>550){
      lastPowerTier=newTier;lastPowerMessage=now;
      const words=['','⚡ 이거 완전 에너지 폭발!','🚀 우주로 날아가겠어!','🔥 전설의 셰이크 마스터!'];
      showReaction(words[newTier]);if(newTier>=2)audio.play('boost',.55);
    }
    if(report.active){
      revealed=false;$('wheelStage').classList.remove('is-finishing');
    }
  }
  // Drag the wheel itself (no extra button). Starting angle cannot influence the draw.
  const frameEl=document.querySelector('.wheel-frame');
  function pointerAngle(e){
    const r=frameEl.getBoundingClientRect(), cx=r.left+r.width/2,cy=r.top+r.height/2;
    if(Math.hypot(e.clientX-cx,e.clientY-cy)<r.width*.13)return null;
    return Math.atan2(e.clientY-cy,e.clientX-cx);
  }
  frameEl.addEventListener('pointerdown',e=>{
    if(e.button!==0||!roundSlots.length||game.state!=='ready'||isTesting||pendingReveal||!$('editOverlay').hidden)return;
    const angle=pointerAngle(e);if(angle===null)return;
    manualPointer={id:e.pointerId,x:e.clientX,y:e.clientY,startAngle:angle,lastAngle:angle,active:false};
    try{frameEl.setPointerCapture(e.pointerId);}catch(_){}
    audio.unlock();
  });
  frameEl.addEventListener('pointermove',e=>{
    if(!manualPointer||manualPointer.id!==e.pointerId)return;
    const angle=pointerAngle(e);if(angle===null)return;
    const m=manualPointer,now=performance.now();
    if(!m.active){
      if(Math.hypot(e.clientX-m.x,e.clientY-m.y)<13)return;
      if(!game.beginManual(m.startAngle,now))return;
      m.active=true;
      soundTestToken++;
      setHeadline('spinning');$('wheelStage').classList.add('is-spinning');
      showReaction('🎡 슥~ 돌려봐!');burst();audio.play('start',.8);
      $('stageStatus').textContent='🖐 드래그로 회전 중! 손을 떼면 당첨!';
    }
    e.preventDefault();
    if(game.state==='spinning'){
      game.moveManual(angle,now);
      if(now-lastPlayedShake>160){lastPlayedShake=now;audio.play('shake',.18);}
    }
    m.lastAngle=angle;
  });
  function startComicBrake(){
    if(game.brakeTriggered)return;
    game.brakeTriggered=true;
    const stage=$('wheelStage');
    stage.classList.remove('comic-braking');
    void stage.offsetWidth;
    stage.classList.add('comic-braking','is-finishing');
    $('reaction').classList.remove('appear');
    audio.play('brake',.95);
  }
  function startManualCoast(){
    $('wheelStage').classList.add('is-coasting');
    $('stageStatus').textContent='🎡 관성으로 빙글빙글… 곧 당첨!';
    showReaction('🌀 빙글~ 빙글~!');
    // The short, full-speed brake fires immediately; a 2 s coast brakes near its end.
    if(game.decelMs<2000)startComicBrake();
  }
  function finishManualPointer(e){
    if(!manualPointer||manualPointer.id!==e.pointerId)return;
    const active=manualPointer.active;manualPointer=null;
    try{if(frameEl.hasPointerCapture(e.pointerId))frameEl.releasePointerCapture(e.pointerId);}catch(_){}
    if(active&&game.state==='spinning'){
      const now=performance.now();
      if(game.endManual(now)){
        startManualCoast();
        revealed=true;
      }
    }
  }
  frameEl.addEventListener('pointerup',finishManualPointer);
  function cancelManualPointer(e){
    if(!manualPointer||manualPointer.id!==e.pointerId)return;
    const active=manualPointer.active;manualPointer=null;
    if(active&&game.state==='spinning'){nextRound();showWarning('터치가 중단되어 수동 회차를 취소했습니다. 상품은 지급하지 않았습니다.');}
  }
  frameEl.addEventListener('pointercancel',cancelManualPointer);
  frameEl.addEventListener('lostpointercapture',cancelManualPointer);
  function frame(now){
    const dt=clamp((now-lastFrameAt)/1000,0,.065);lastFrameAt=now;
    if(game.state==='spinning'||game.state==='decelerating'){
      const elapsed=now-game.lastMotion;
      if(game.state==='decelerating'){
        if(!revealed){revealed=true;if(game.manual)startManualCoast();else startComicBrake();}
        if(game.manual && game.decelMs>=2000 && now-game.decelStartedAt>=game.decelMs-320)startComicBrake();
      }
      $('wheelStage').classList.toggle('is-fast',game.velocity>23&&elapsed<200);
      $('wheelStage').classList.toggle('is-turbo',game.velocity>33&&elapsed<200);
      $('wheelStage').style.setProperty('--spin-strength',String(clamp(game.velocity/40,0,1)));
      const result=game.tick(dt,now);
      if(result==='signal-lost'){
        nextRound();showWarning('가속도 신호가 끊겨 회차를 취소했습니다. 연결 상태를 확인해 주세요.');
      }else if(result==='decelerating'){
        $('wheelStage').classList.remove('is-turbo');
        startComicBrake();
      }else if(result===true){
        // Let visitors see the pointer settle on the exact sector before covering it with the win card.
        pendingReveal=true;
        $('testBtn').disabled=true;
        $('nextBtn').disabled=true;
        $('wheelStage').classList.remove('is-spinning','is-fast','is-turbo');
        $('wheelStage').classList.add('is-finishing');
        showReaction('🎯 여기서 멈췄다!');burst();
        $('stageStatus').textContent='🎁 당첨 상품 공개!';
        audio.play('tick',.72);
        finishRound();
      }
      else if(game.angle!==lastDrawAngle){
        canvas.style.transform=`rotate(${game.angle}rad)`;lastDrawAngle=game.angle;
        const pointed=winningIndex(game.angle,roundSlots.length===1?8:roundSlots.length);
        if(pointed!==lastPointed && now-lastTickAt>85){
          lastTickAt=now;lastPointed=pointed;audio.play('tick',.24);
          $('pointer').classList.remove('flick');void $('pointer').offsetWidth;$('pointer').classList.add('flick');
        }
      }
    }
    refreshLive(now);requestAnimationFrame(frame);
  }
  function cleanupCharacteristic(){
    if(!characteristic)return;
    const previous=characteristic;characteristic=null;
    if(previous.removeEventListener)previous.removeEventListener('characteristicvaluechanged',onBleData);
    try{if(previous.stopNotifications)Promise.resolve(previous.stopNotifications()).catch(()=>{});}catch(_){}
  }
  async function connectBluetooth(){
    if(isConnecting)return;
    audio.unlock();
    if(device && device.gatt && device.gatt.connected){
      // Explicit disconnect: do not leave the former device listening in the background.
      device.gatt.disconnect();
      return;
    }
    if(!bluetoothAvailable){showWarning('블루투스 연결은 HTTPS의 Chrome/Edge에서 지원됩니다. 안드로이드 Chrome 또는 블루투스 지원 PC의 Chrome/Edge에서 열어 주세요. iPhone Safari는 지원하지 않습니다.');return;}
    isConnecting=true;showWarning('');connectionUi();
    let picked=null;
    try{
      picked=await navigator.bluetooth.requestDevice({
        filters:[{namePrefix:'BBC micro:bit'},{namePrefix:'micro:bit'}],
        optionalServices:[SERVICE]
      });
      // Old chooser attempts must not retain event subscriptions.
      if(device&&device!==picked)device.removeEventListener('gattserverdisconnected',onDisconnected);
      device=picked;
      device.removeEventListener('gattserverdisconnected',onDisconnected);
      device.addEventListener('gattserverdisconnected',onDisconnected);
      const server=await device.gatt.connect();
      const service=await server.getPrimaryService(SERVICE);
      const data=await service.getCharacteristic(DATA);
      try{
        const period=await service.getCharacteristic(PERIOD);
        const value=new Uint8Array([20,0]); // little-endian uint16: 20ms, valid BLE accelerometer period
        if(period.writeValueWithResponse)await period.writeValueWithResponse(value);
        else await period.writeValue(value);
      }catch(_){/* Notification default period still works when period is read-only. */}
      data.addEventListener('characteristicvaluechanged',onBleData);
      try{await data.startNotifications();characteristic=data;}
      catch(error){data.removeEventListener('characteristicvaluechanged',onBleData);throw error;}
      startBleWatchdog();nextRound();
    }catch(error){
      cleanupCharacteristic();stopBleWatchdog();
      if(picked?.gatt?.connected)picked.gatt.disconnect();
      if(picked===device)device=null;
      if(error && error.name!=='NotFoundError'){
        const detail=(error.message||String(error)).slice(0,180);
        showWarning('연결 실패: Bluetooth 가속도 서비스가 있는 펌웨어가 설치돼 있는지 확인하세요. 배터리를 다시 연결하고 시도해 보세요.\n'+detail);
      }
    }finally{isConnecting=false;connectionUi();setHeadline(game.state);}
  }
  function onBleData(event){
    const view=event.target && event.target.value;
    if(!view||view.byteLength<6)return;
    // Official micro:bit BLE accelerometer payload: x/y/z signed int16 little-endian millig.
    const x=view.getInt16(0,true)/1000,y=view.getInt16(2,true)/1000,z=view.getInt16(4,true)/1000;
    if(![x,y,z].every(Number.isFinite)||Math.max(Math.abs(x),Math.abs(y),Math.abs(z))>32)return;
    blePackets++;bleLastPacketAt=performance.now();
    if(blePackets===1||blePackets%10===0){
      $('bleDiagnostics').textContent=`가속도 실측 ${blePackets}개 · ${bleRate}회/초 | X ${x.toFixed(2)}g · Y ${y.toFixed(2)}g · Z ${z.toFixed(2)}g`;
    }
    if(blePackets===1){$('bleLive').textContent='✓ 센서 데이터 수신 확인';showWarning('');}
    if(!isTesting)onSample(x,y,z,bleLastPacketAt);
  }
  function onDisconnected(event){
    if(event?.target && device && event.target!==device)return;
    cleanupCharacteristic();stopBleWatchdog();
    if(device)device.removeEventListener('gattserverdisconnected',onDisconnected);
    device=null;
    if(game.state==='spinning'){
      nextRound();showWarning('흔드는 중 무선 연결이 끊겼습니다. 이번 회차는 지급하지 않고 취소했습니다. 다시 연결하세요.');
    }else if(game.state==='ready'){
      showWarning('마이크로비트 연결이 끊어졌습니다. 캡슐 배터리를 확인하고 다시 연결하세요.');
    }
    connectionUi();setHeadline(game.state);
  }
  async function testShake(){
    if(!roundSlots.length){showWarning('상품이 모두 소진되어 테스트를 진행할 수 없어요.');return;}
    if(game.state==='spinning'||game.state==='decelerating'||isTesting||pendingReveal)return;
    if(game.state==='result')nextRound();
    showWarning('');isTesting=true;demoRound=true;$('testBtn').disabled=true;
    // Browser demo must not start before the first sound effects have decoded.
    await audio.unlock();if(audio.loading)await audio.loading;
    if(!isTesting||!demoRound)return;
    const started=performance.now();
    testTimer=setInterval(()=>{
      const now=performance.now(),t=(now-started)/1000;
      if(t>3.5){clearTest();return;}
      if(t>2.2){onSample(0,0,1,now);return;}
      const beat=Math.sin(t*TAU*4.4),amp=1.25+Math.sin(t*2.4)*.32;
      onSample(beat*amp,Math.cos(t*TAU*4.4)*.72,1+Math.sin(t*TAU*8.8)*.43,now);
    },40);
  }
  function editorRow(row){
    const div=document.createElement('div');div.className='editor-row';div.dataset.id=row.id;
    const name=document.createElement('input');name.type='text';name.className='entry-name';name.maxLength=24;name.value=row.name;name.placeholder='상품명';name.setAttribute('aria-label','상품명');
    const grade=document.createElement('select');grade.className='entry-grade';grade.setAttribute('aria-label','보상 등급');
    for(let g=1;g<=4;g++){const opt=document.createElement('option');opt.value=String(g);opt.textContent=GRADE_NAMES[g];grade.append(opt);}grade.value=String(row.grade||1);
    const limit=document.createElement('input');limit.type='number';limit.className='entry-limit';limit.inputMode='numeric';limit.min='0';limit.max=String(Stock.MAX_STOCK);limit.step='1';limit.placeholder='무제한';limit.value=row.limit===null?'':String(row.limit);limit.setAttribute('aria-label','총 지급 가능 수량, 비우면 무제한');
    const issued=document.createElement('input');issued.type='number';issued.className='entry-issued';issued.inputMode='numeric';issued.min='0';issued.max=String(Stock.MAX_STOCK);issued.step='1';issued.value=String(row.issued);issued.setAttribute('aria-label','이미 지급한 수량');
    const remove=document.createElement('button');remove.className='remove-row';remove.type='button';remove.textContent='✕';remove.title='상품 삭제';remove.setAttribute('aria-label',row.name+' 삭제');
    remove.addEventListener('click',()=>{
      if($('inventoryEditorRows').children.length===1){$('editorHelp').textContent='최소 1종의 상품은 남겨 주세요.';return;}
      div.remove();$('editorHelp').textContent='상품을 삭제했습니다. 저장 버튼을 눌러 적용하세요.';
    });
    div.append(name,grade,limit,issued,remove);return div;
  }
  function openEditor(){
    if(game.state==='spinning'||pendingReveal){showWarning('룰렛 회전·결과 공개 중에는 상품을 바꿀 수 없어요.');return;}
    cancelTimers();
    const rows=$('inventoryEditorRows');rows.replaceChildren();
    inventory.forEach(p=>rows.append(editorRow(p)));
    $('editorHelp').textContent='등급 1=일반, 2=고급, 3=희귀, 4=전설 · 총 수량 빈칸=무제한';
    $('editorHelp').classList.remove('invalid');
    $('editOverlay').hidden=false;
    rows.querySelector('.entry-name')?.focus();
  }
  function closeEditor(){
    $('editOverlay').hidden=true;
    // An editor is reachable only outside a visible win modal. Re-arm after a result.
    if(game.state==='result')nextRound();
  }
  function gatherEditor(){
    return Array.from($('inventoryEditorRows').children).map(row=>({
      id:row.dataset.id,name:row.querySelector('.entry-name').value,grade:row.querySelector('.entry-grade').value,
      limit:row.querySelector('.entry-limit').value,
      issued:row.querySelector('.entry-issued').value
    }));
  }
  function savePrizes(){
    try{
      const data=Stock.normalizeInventory(gatherEditor());
      inventory=data;rewardSource='이 기기의 직접 입력';save('capsule-inventory-v2',inventory);
      $('editOverlay').hidden=true;nextRound();renderPrizes();resizeCanvas();
    }catch(e){$('editorHelp').textContent=e.message;$('editorHelp').classList.add('invalid');}
  }
  $('presentBtn').addEventListener('click',()=>setOperator(presentation));
  $('operatorBackdrop').addEventListener('click',()=>setOperator(false));
  $('connectBtn').addEventListener('click',connectBluetooth);
  $('testBtn').addEventListener('click',testShake);
  $('nextBtn').addEventListener('click',nextRound);
  $('overlayNext').addEventListener('click',nextRound);
  $('fullBtn').addEventListener('click',async()=>{
    try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}
    catch(_){showWarning('전체 화면 기능을 사용할 수 없습니다.');}
  });
  $('autoNext').addEventListener('change',e=>{autoNext=e.target.checked;save('capsule-auto',autoNext);});
  $('soundToggle').addEventListener('change',e=>{soundOn=e.target.checked;save('capsule-sound',soundOn);if(soundOn)audio.unlock();else{soundTestToken++;audio.stopAll();$('soundDiagnostic').textContent='🔇 음소거 중';}});
  $('volumeSlider').addEventListener('input',e=>{volume=+e.target.value;$('volumeValue').textContent=volume+'%';audio.setVolume(volume);save('capsule-volume',volume);});
  $('soundTest').addEventListener('click',async()=>{
    if(!soundOn){showWarning('효과음 체크를 먼저 켜 주세요.');return;}
    if(soundTestBusy||game.state==='spinning'||pendingReveal)return;
    soundTestBusy=true;
    const button=$('soundTest'),token=++soundTestToken;
    button.disabled=true;
    try{
      await audio.unlock();if(audio.loading)await audio.loading;
      if(audio.buffers.size!==8){
        showWarning('효과음 파일에 문제가 있습니다. ZIP의 sounds 폴더 전체를 업로드했는지 확인해 주세요. 누락: '+Array.from(audio.errors).join(', '));
        return;
      }
      showWarning('');
      for(const name of ['start','shake','tick','boost','reveal','win','soldout','brake']){
        if(soundTestToken!==token||game.state==='spinning')break;
        $('soundDiagnostic').textContent=`🔊 효과음 점검 중: ${SOUND_LABELS[name]} (${['start','shake','tick','boost','reveal','win','soldout','brake'].indexOf(name)+1}/8)`;
        audio.play(name,name==='shake'||name==='tick'?.55:.8);
        await new Promise(resolve=>setTimeout(resolve,Math.ceil((audio.buffers.get(name)?.duration||.3)*1000)+230));
      }
      if(soundTestToken===token)$('soundDiagnostic').textContent='✓ 효과음 8종 시연 완료 · 모두 재생됨';
    }finally{soundTestBusy=false;button.disabled=false;}
  });
  $('editBtn').addEventListener('click',openEditor);
  $('closeEditor').addEventListener('click',closeEditor);
  $('editOverlay').addEventListener('click',e=>{if(e.target===$('editOverlay'))closeEditor();});
  $('savePrizes').addEventListener('click',savePrizes);
  $('exportPrizes').addEventListener('click',()=>{
    try{
      const payload=JSON.stringify({format:'capsule-roulette-inventory',version:1,exportedAt:new Date().toISOString(),inventory},null,2);
      const url=URL.createObjectURL(new Blob([payload],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='캡슐룰렛_상품재고백업.json';
      document.body.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      $('editorHelp').classList.remove('invalid');
      $('editorHelp').textContent='상품·재고 백업 파일을 저장했습니다. 다른 기기에서 불러올 수 있어요.';
    }catch(_){$('editorHelp').textContent='백업 파일을 만들지 못했습니다. 브라우저 다운로드 설정을 확인해 주세요.';$('editorHelp').classList.add('invalid');}
  });
  $('importTxt').addEventListener('click',()=>$('importTxtFile').click());
  $('importTxtFile').addEventListener('change',async event=>{
    const file=event.target.files?.[0];event.target.value='';if(!file)return;
    try{
      if(file.size>30000)throw new Error('TXT 파일이 너무 큽니다.');
      const rows=Stock.parseRewardText(await file.text());
      const container=$('inventoryEditorRows');container.replaceChildren();rows.forEach(r=>container.append(editorRow(r)));
      $('editorHelp').classList.remove('invalid');
      $('editorHelp').textContent=`TXT ${rows.length}종을 편집기에 불러왔습니다. 저장 버튼을 눌러 이 기기에 적용하세요.`;
    }catch(err){$('editorHelp').classList.add('invalid');$('editorHelp').textContent='TXT 오류: '+err.message;}
  });
  $('exportTxt').addEventListener('click',()=>{
    try{
      const rows=Stock.normalizeInventory(gatherEditor());
      const text=Stock.toRewardText(rows);
      const uri=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
      const a=document.createElement('a');a.href=uri;a.download='보상명단.txt';document.body.append(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(uri),10000);
    }catch(err){$('editorHelp').textContent=err.message;}
  });
  $('importPrizes').addEventListener('click',()=>$('importPrizesFile').click());
  $('importPrizesFile').addEventListener('change',async e=>{
    const file=e.target.files?.[0];e.target.value='';if(!file)return;
    try{
      if(file.size>100000)throw new Error('백업 파일이 너무 큽니다.');
      const backup=JSON.parse(await file.text());
      if(backup?.format!=='capsule-roulette-inventory'||backup.version!==1)throw new Error('캡슐 룰렛에서 만든 상품·재고 백업 JSON만 불러올 수 있습니다.');
      const imported=Stock.normalizeInventory(backup.inventory);
      if(!confirm(`상품 ${imported.length}종과 지급 수량을 불러올까요? 현재 상품·재고·당첨 기록을 교체합니다.`))return;
      cancelTimers();bonusQueued=false;bonusRound=false;
      inventory=imported;history=[];rewardSource='이 기기의 가져온 명단';
      save('capsule-inventory-v2',inventory);save('capsule-history',history);
      const rows=$('inventoryEditorRows');rows.replaceChildren();inventory.forEach(row=>rows.append(editorRow(row)));
      $('editorHelp').classList.remove('invalid');$('editorHelp').textContent=`✓ 상품 ${inventory.length}종 불러오기 완료 · 지급 수량 포함`;
      nextRound();renderHistory();renderPrizes();resizeCanvas();
    }catch(error){$('editorHelp').classList.add('invalid');$('editorHelp').textContent='불러오기 실패: '+(error.message||'파일을 확인해 주세요.');}
  });
  $('addPrize').addEventListener('click',()=>{
    const rows=$('inventoryEditorRows');
    if(rows.children.length>=16){$('editorHelp').textContent='상품은 최대 16종입니다.';return;}
    rows.append(editorRow({id:Stock.makeId(),name:'새 상품',grade:1,limit:null,issued:0}));
    rows.lastElementChild.querySelector('.entry-name').focus();
  });
  $('resetIssued').addEventListener('click',()=>{
    if(confirm('전체 상품의 지급 완료 수량을 0으로 초기화할까요? (저장 전까지 실제 재고는 그대로입니다.)')){
      $('inventoryEditorRows').querySelectorAll('.entry-issued').forEach(input=>input.value='0');
      $('editorHelp').textContent='지급량을 0으로 바꿨습니다. 저장 버튼을 눌러 적용하세요.';
    }
  });
  $('resetPrizes').addEventListener('click',()=>{
    if(confirm('기본 예시 상품 8종을 편집기에 불러올까요? (저장 전까지 실제 재고는 그대로입니다.)')){
      const rows=$('inventoryEditorRows');rows.replaceChildren();
      DEFAULTS.forEach((name,i)=>rows.append(editorRow({id:Stock.makeId(),name,grade:i<3?1:i<5?2:i<7?3:4,limit:null,issued:0})));
      $('editorHelp').textContent='기본 상품을 불러왔습니다. 저장 버튼을 눌러 적용하세요.';
    }
  });
  $('undoLast').addEventListener('click',()=>{
    const last=history[0];
    const row=last && inventory.find(p=>p.id===last.id);
    if(!row||row.issued<1){showWarning('마지막 당첨 상품이 현재 명단에 없어 취소할 수 없습니다.');return;}
    if(!confirm(`마지막 당첨 '${last.prize}' 지급 1건을 취소하고 재고를 1개 돌려놓을까요?`))return;
    row.issued--;history.shift();
    save('capsule-inventory-v2',inventory);save('capsule-history',history);
    renderHistory();nextRound();
    showWarning(`'${last.prize}' 마지막 지급을 취소하고 재고 1개를 복구했습니다.`);
  });
  $('clearHistory').addEventListener('click',()=>{
    if(history.length && confirm('당첨 기록만 지울까요? 지급 수량은 유지됩니다.')){
      history=[];save('capsule-history',history);renderHistory();
    }
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!$('editOverlay').hidden)closeEditor();else if(!presentation)setOperator(false);}});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden && game.state==='spinning'){
      nextRound();showWarning('다른 화면으로 전환되어 회차를 취소했습니다.');
    }
  });
  window.addEventListener('resize',resizeCanvas,{passive:true});
  if(!bluetoothAvailable)showWarning('이 브라우저에서는 Web Bluetooth를 사용할 수 없습니다. 실제 기기 연결은 HTTPS 사이트의 Chrome/Edge를 이용해 주세요.');
  else if(storageError)showWarning('⚠ 브라우저 저장이 차단되어 지급량이 보존되지 않습니다. 저장소 설정을 확인해 주세요.');
  async function initializeBundledRewards(){
    if(!shouldLoadBundled)return;
    try{
      const response=await fetch('./보상명단.txt',{cache:'no-store'});
      if(!response.ok)throw new Error('HTTP '+response.status);
      const parsed=Stock.parseRewardText(await response.text());
      // If the visitor edited while the fetch was in flight, do not overwrite it.
      try{if(localStorage.getItem('capsule-inventory-v2')!==null)return;}catch(_){}
      inventory=parsed;rewardSource=parsed.length?'사이트 기본 TXT':'기본 TXT 비어 있음 · 기기별 입력 가능';
      save('capsule-inventory-v2',inventory);nextRound();renderPrizes();
    }catch(error){
      rewardSource='기본 TXT 읽기 실패';
      showWarning('보상명단.txt를 읽지 못했습니다. GitHub Pages에 함께 업로드하거나 운영 → 보상 입력을 이용하세요. '+error.message);
      renderPrizes();
    }
  }
  renderPrizes();renderHistory();connectionUi();setHeadline('ready');
  initializeBundledRewards();
  requestAnimationFrame(()=>{resizeCanvas();requestAnimationFrame(frame);});
  window.__rouletteDiagnostics=()=>({state:game.state,winner:game.resultIndex,pendingReveal,prizes:roundSlots.map(x=>x.name),
    inventory:inventory.map(x=>({...x})),history:history.slice(),demo:demoRound,shakes:game.roundShakes,
    speed:game.velocity,angle:game.angle,manual:game.manual,bonusRound,bonusQueued,connected:connected(),soundLoaded:audio.buffers.size,soundFailures:Array.from(audio.errors),soundTrace:audio.playTrace.slice(),soundContext:audio.ctx?.state||'not-started',peak:game.peakPower,remaining:game.startedAt===null?null:Math.max(0,5000-(performance.now()-game.startedAt)),tier:window.RouletteCore.rewardTier(game.peakPower),rewardSource});
})();
