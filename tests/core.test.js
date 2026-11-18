const assert=require('node:assert/strict');
const {TAU, winningIndex, sanitizePrizes, ShakeDetector, WheelGame}=require('../roulette-core.js');

for(const n of [2,3,4,8,12,16]){
  const sector=TAU/n;
  for(let i=0;i<n;i++){
    assert.equal(winningIndex(-i*sector,n),i,`n=${n} i=${i}`);
    assert.equal(winningIndex(-i*sector+TAU*7,n),i);
    assert.equal(winningIndex(-i*sector-TAU*5,n),i);
  }
  assert.equal(winningIndex(0,n),0);
}
assert.deepEqual(sanitizePrizes('사탕\n\n 스티커\r\n 선물 '),['사탕','스티커','선물']);
assert.throws(()=>sanitizePrizes('only one'));
assert.throws(()=>sanitizePrizes(Array.from({length:17},(_,i)=>String(i)).join('\n')));
assert.throws(()=>sanitizePrizes('A'.repeat(25)+'\nb'));
const stable=new ShakeDetector();
for(let i=0;i<120;i++) {
  const t=i*20;
  const r=stable.push(.02*Math.sin(t*.01),0,1+.015*Math.cos(t*.011),t);
  assert.equal(r.active,false,'stable device must not trigger shake');
}
assert.equal(stable.peakCount,0);
const game=new WheelGame(8);
for(let i=0;i<120;i++) {
  const t=i*20;
  game.sample(0,0,1,t); game.tick(.02,t);
}
assert.equal(game.state,'ready');
let activated=false;
for(let i=120;i<250;i++) {
  const t=i*20, s=Math.sin(i*.9)*1.35;
  game.sample(s,.8*Math.cos(i*.9),1+s*.4,t);
  game.tick(.02,t);
  if(game.state==='spinning')activated=true;
}
assert.ok(activated, 'shake starts spin');
assert.ok(game.detector.peakCount>=3,'shake counter increases');
const angle=game.angle;
assert.ok(game.velocity>0);
let brakeStart=null,finishAt=null,trigger=null;
for(let i=250;i<300;i++){
  const t=i*20;
  game.sample(0,0,1,t);
  const event=game.tick(.02,t);
  if(event==='decelerating' && brakeStart===null){brakeStart=t;trigger=t;}
  if(event===true && finishAt===null) finishAt=t;
}
assert.notEqual(brakeStart,null,'stop triggers braking');
assert.notEqual(finishAt,null,'brake completes in the first second');
assert.ok(finishAt-brakeStart<=300,'braking duration <=300ms');
assert.equal(game.state,'result');
assert.equal(game.resultIndex,winningIndex(game.angle,8));
assert.ok(game.angle!==angle,'wheel settles at the selected result');
const result=game.resultIndex;
for(let i=300;i<360;i++){game.sample(2,-2,1,i*20);game.tick(.02,i*20);}
assert.equal(game.resultIndex,result,'winner is locked until next round');
game.reset(4);assert.equal(game.state,'ready');assert.equal(game.roundShakes,0);
console.log('PASS: geometry / shake detector / timed deceleration / result lock / reset');

// Missing notifications must never be mistaken for a user stopping the capsule.
const drop = new WheelGame(4);
for(let i=0;i<70;i++){
  const t=i*20, s=Math.sin(i*.82)*1.4;
  drop.sample(s,Math.cos(i*.82),1+s*.2,t);
  drop.tick(.02,t);
}
assert.equal(drop.state,'spinning');
const status=drop.tick(.02,drop.lastPacketAt+1400);
assert.equal(status,'signal-lost');
assert.equal(drop.state,'invalid');
assert.equal(drop.resultIndex,null);
console.log('PASS: BLE packet loss cancels incomplete spin without awarding stock');

// A single deliberate shake must produce a random prize, not a pointer-timed outcome.
const single = new WheelGame(5);
single.sample(0,0,1,0);
let startedOnce=false;
for(let i=1;i<8;i++) {
  single.sample(i<4?1.3:0,0,1,i*20);
  single.tick(.02,i*20);
  startedOnce ||= single.state==='spinning';
}
assert.ok(startedOnce,'one sufficiently strong shake must start');
for(let i=8;i<80;i++){
  single.sample(0,0,1,i*20);
  single.tick(.02,i*20);
}
assert.equal(single.state,'result','single shake settles into a prize');
console.log('PASS: one deliberate shake gets a result, independent of pointer timing');

const {chooseReward,rewardTier}=require('../roulette-core.js');
const rewards=[{id:'a',grade:1},{id:'b',grade:2},{id:'c',grade:3},{id:'d',grade:4}];
assert.deepEqual([0,25,46,67,86].map(rewardTier),[0,1,2,3,4]);
for(let i=0;i<1000;i++){
 const chosen=chooseReward(rewards,100,()=>i/1000);
 assert.notEqual(chosen.grade,1,'red tier always excludes lowest while alternative stock exists');
}
assert.equal(chooseReward([rewards[0]],100).id,'a','sole remaining lowest grade is allowed');
let low=0,high=0;
for(let i=0;i<10000;i++){
 if(chooseReward(rewards,0,()=>i/10000).grade>=3)low++;
 if(chooseReward(rewards,90,()=>i/10000).grade>=3)high++;
}
assert.ok(high>low*3,`higher shaking leads to much higher rewards (${low},${high})`);
const timed=new WheelGame(4);timed.sample(0,0,1,0);timed.state='spinning';timed.startedAt=100;
timed.lastPacketAt=5100;timed.lastMotion=5100;timed.velocity=17;timed.angle=1;
timed.peakPower=91;timed.onChoose=()=>2;
assert.equal(timed.tick(.02,5100),'decelerating');
assert.equal(timed.state,'decelerating');
assert.equal(timed.tick(.02,5300),false);
assert.equal(timed.tick(.02,5360),true);
assert.equal(timed.state,'result');
assert.equal(timed.resultIndex,2);
assert.equal(winningIndex(timed.angle,4),2);
console.log('PASS: weighted grade selection / max 5-second shake / 260ms braking');
