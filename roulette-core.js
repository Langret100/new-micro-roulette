/* Capsule Roulette — pure geometry and motion detection; no external dependencies. */
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  if (typeof root !== 'undefined') root.RouletteCore = core;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const wrap = a => ((a % TAU) + TAU) % TAU;

  function winningIndex(angle, count) {
    if (!Number.isInteger(count) || count < 1) throw new Error('count must be >=1');
    const sector = TAU / count;
    return Math.floor(wrap(-angle + sector / 2) / sector) % count;
  }

  function sanitizePrizes(raw) {
    const entries = String(raw).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (entries.length < 2 || entries.length > 16) throw new Error('상품을 2~16개 입력해 주세요.');
    if (entries.some(s => Array.from(s).length > 48)) throw new Error('상품 이름은 48글자 이내로 입력해 주세요.');
    return entries;
  }

  class ShakeDetector {
    constructor() { this.reset(); }
    reset() {
      this.gravity = null;
      this.previous = null;
      this.lastSample = null;
      this.lastMotion = -Infinity;
      this.lastPeak = -Infinity;
      this.armed = true;
      this.activity = 0;
      this.peakCount = 0;
      this.peakTimes = [];
      this.energy = 0;
      this.lastReport = null;
    }
    push(x, y, z, now) {
      if (![x,y,z,now].every(Number.isFinite) || [x,y,z].some(v => Math.abs(v) > 32)) return null;
      const v = [x, y, z];
      if (this.previous === null || this.lastSample === null || now < this.lastSample || now - this.lastSample > 800) {
        this.previous = v;
        this.gravity = v.slice();
        this.lastSample = now;
        return {active: false, intensity: 0, count: this.peakCount, rate: 0};
      }
      const dt = clamp(now - this.lastSample, 10, 200);
      this.lastSample = now;
      // A low-pass gravity estimate eliminates orientation bias; high-pass response captures shaking.
      const slow = 1 - Math.exp(-dt / 330);
      for (let i=0;i<3;i++) this.gravity[i] += (v[i] - this.gravity[i]) * slow;
      const motion = Math.hypot(v[0]-this.gravity[0], v[1]-this.gravity[1], v[2]-this.gravity[2]);
      const jerk = Math.hypot(v[0]-this.previous[0], v[1]-this.previous[1], v[2]-this.previous[2]);
      this.previous = v;
      const raw = clamp(Math.max(motion, jerk * 0.65) - 0.11, 0, 3.8);
      this.activity = this.activity * 0.57 + raw * 0.43;
      // Noise floor rejects desk vibrations and almost-still sensor jitter.
      const active = (motion > 0.30 && jerk > 0.08) || jerk > 0.45 || this.activity > 0.45;
      if (active) this.lastMotion = now;
      this.peakTimes = this.peakTimes.filter(t => now - t <= 1800);
      // Re-arm on the valley of each shake. A forceful sustained shake can count again after 390 ms.
      if (this.activity < 0.23) this.armed = true;
      if (active && this.activity > 0.39 && now - this.lastPeak >= 190 &&
          (this.armed || (now - this.lastPeak >= 390 && this.activity > 0.75))) {
        this.peakTimes.push(now);
        this.peakCount++;
        this.lastPeak = now;
        this.armed = false;
      }
      const rate = this.peakTimes.length / 1.8;
      this.energy = clamp(this.activity * 0.95 + Math.min(rate, 6) * 0.19, 0, 3.3);
      const report = {active, intensity: this.activity, count: this.peakCount, rate,
        speed: clamp(7.0 + 13.5 * Math.sqrt(clamp(this.energy, 0, 2.8)) + rate * 1.6 + Math.min(this.peakCount, 20) * 0.38, 7.0, 40),
        lastMotion: this.lastMotion};
      this.lastReport = report;
      return report;
    }
  }

  // Weighted by grade, not by the number of items in each grade.
  // Grade 1 is the smallest prize, 4 the largest. The top red zone excludes
  // grade 1 only when another in-stock grade exists.
  const GRADE_WEIGHTS = [
    [64,25,9,2], [48,32,15,5], [31,36,24,9],
    [16,33,34,17], [0,26,43,31]
  ];
  function rewardTier(peakPower) {
    const power = clamp(Number(peakPower)||0,0,100);
    return power >= 86 ? 4 : power >= 67 ? 3 : power >= 46 ? 2 : power >= 25 ? 1 : 0;
  }
  function chooseReward(items, peakPower, random=Math.random) {
    if (!items.length) throw new Error('No available rewards');
    const present = new Set(items.map(item => clamp(Number(item.grade)||1,1,4)));
    const tier = rewardTier(peakPower), weights = GRADE_WEIGHTS[tier];
    const eligible = [1,2,3,4].filter(g => present.has(g) && !(tier===4 && g===1 && present.size>1));
    const total = eligible.reduce((a,g)=>a+weights[g-1],0);
    if (!total) return items[0];
    let roll=clamp(Number(random())||0,0,0.999999999)*total;
    let grade=eligible[eligible.length-1];
    for(const g of eligible){roll-=weights[g-1];if(roll<0){grade=g;break;}}
    const candidates=items.filter(item=>(Number(item.grade)||1)===grade);
    return candidates[Math.floor(clamp(Number(random())||0,0,0.999999999)*candidates.length)];
  }

  class WheelGame {
    constructor(n, opts={}) {
      this.inactivityMs=opts.inactivityMs??200;
      this.maxShakeMs=clamp(Math.round(Number(opts.maxShakeMs)||4000),3000,10000);
      this.decelMs=260;
      this.manualCoastMs=2000;
      this.onChoose=null;
      this.detector=new ShakeDetector();
      this.reset(n);
      this.angle=0;
    }
    reset(n) {
      this.count=n||this.count;
      this.detector.reset();
      this.state='ready';this.velocity=0;this.manual=false;this.manualLastAngle=null;this.manualLastAt=null;this.manualDirection=1;
      this.lastMotion=-Infinity;this.lastPacketAt=-Infinity;
      this.roundShakes=0;this.resultIndex=null;
      this.startedAt=null;this.peakPower=0;
      this.decelStartedAt=null;this.decelFrom=0;this.decelTo=0;this.brakeTriggered=false;
    }
    // A manual swipe uses the same probability selection and braking as Bluetooth.
    // The physical pointer position NEVER selects the reward.
    beginManual(angle,now){
      if(this.state!=='ready' || !Number.isFinite(angle))return false;
      this.manual=true;this.state='spinning';this.startedAt=now;
      this.lastMotion=now;this.lastPacketAt=now;
      this.manualLastAngle=angle;this.manualLastAt=now;
      this.velocity=7;this.roundShakes=0;this.peakPower=18;
      return true;
    }
    moveManual(angle,now){
      if(!this.manual||this.state!=='spinning'||!Number.isFinite(angle))return false;
      const delta=Math.atan2(Math.sin(angle-this.manualLastAngle),Math.cos(angle-this.manualLastAngle));
      const dt=Math.max(12,now-this.manualLastAt);
      this.manualLastAngle=angle;this.manualLastAt=now;this.lastMotion=now;
      // Keep rotation clockwise so movement remains legible; the weighted draw is independent.
      const speed=clamp(7+Math.abs(delta)*1700/dt,7,40);
      this.velocity=Math.max(speed,this.velocity*.85);
      this.peakPower=Math.max(this.peakPower,Math.round(this.velocity/40*100));
      if(Math.abs(delta)>.002)this.manualDirection=Math.sign(delta);
      this.angle=wrap(this.angle+delta*2.4);
      return true;
    }
    endManual(now){
      if(!this.manual||this.state!=='spinning')return false;
      return this.beginDeceleration(now);
    }
    sample(x,y,z,now) {
      if (this.state==='result'||this.state==='decelerating'||this.state==='invalid') return null;
      const r=this.detector.push(x,y,z,now);
      if(!r)return null;
      this.lastPacketAt=now;this.roundShakes=r.count;
      if(r.active){
        if(this.state==='ready' && Number.isFinite(this.lastMotion) && now-this.lastMotion>2200 && this.detector.peakCount>0){
          this.detector.reset();this.detector.push(x,y,z,now);this.roundShakes=0;
          return this.detector.lastReport||{active:false,intensity:0,count:0,rate:0};
        }
        this.lastMotion=now;
        if(this.state==='ready' && r.count>=1 && r.intensity>=0.48){this.state='spinning';this.startedAt=now;this.velocity=Math.max(this.velocity,7);}
      }
      if(this.state==='spinning' && r.active){
        this.velocity=Math.max(this.velocity*.72,r.speed);
        this.peakPower=Math.max(this.peakPower,Math.round(clamp(this.velocity/40,0,1)*100));
      }
      return r;
    }
    beginDeceleration(now){
      if(this.state!=='spinning')return false;
      const candidate=this.onChoose?this.onChoose(this.peakPower):Math.floor(Math.random()*this.count);
      const selected=Number.isInteger(candidate)&&candidate>=0&&candidate<this.count?candidate:0;
      this.resultIndex=selected;
      const sector=TAU/this.count;
      // The pointer points up; exact sector center is at -selected * sector.
      const target=wrap(-selected*sector);
      const forward=wrap(target-this.angle);
      this.decelFrom=this.angle;
      // A fully lit gauge has 12/12 bars (>= 92%). Other manual spins coast for 2 s.
      // BLE still uses its quick brake. Reward choice is completely independent of angle.
      this.decelMs=this.manual && this.peakPower<92 ? this.manualCoastMs : 260;
      const turns=this.decelMs>=2000 ? Math.max(2,Math.round(this.velocity*this.decelMs/4000/TAU)) : 1;
      this.decelTo=this.manual && this.manualDirection<0
        ?this.angle-wrap(this.angle-target)-turns*TAU
        :this.angle+forward+turns*TAU;
      this.brakeTriggered=false;
      this.decelStartedAt=now;
      this.state='decelerating';
      return true;
    }
    tick(dtSeconds,now){
      if(this.state==='decelerating'){
        const t=clamp((now-this.decelStartedAt)/this.decelMs,0,1);
        const eased=1-Math.pow(1-t,4);
        this.angle=wrap(this.decelFrom+(this.decelTo-this.decelFrom)*eased);
        this.velocity=t>=1?0:Math.abs(this.decelTo-this.decelFrom)*4*Math.pow(1-t,3)/(this.decelMs/1000);
        if(t>=1){
          this.state='result';
          // Check visual and logical winner agree, including numerical edge cases.
          this.resultIndex=winningIndex(this.angle,this.count);
          return true;
        }
        return false;
      }
      if(this.state!=='spinning')return false;
      if(!this.manual && now-this.lastPacketAt>1350){this.state='invalid';this.velocity=0;return 'signal-lost';}
      if(now-this.startedAt>=this.maxShakeMs ||
         (!this.manual && now-this.lastMotion>=this.inactivityMs && now-this.lastPacketAt<270)){
        this.beginDeceleration(now);
        return 'decelerating';
      }
      const idle=now-this.lastMotion;
      if(idle>110)this.velocity=Math.max(0,this.velocity*Math.pow(.93,dtSeconds*60));
      this.angle=wrap(this.angle+this.velocity*Math.min(dtSeconds,.065)*(this.manual?this.manualDirection:1));
      return false;
    }
  }
  return { TAU, clamp, wrap, winningIndex, sanitizePrizes, ShakeDetector, WheelGame, rewardTier, chooseReward, GRADE_WEIGHTS };
});
