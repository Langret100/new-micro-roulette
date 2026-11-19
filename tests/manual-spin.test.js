const assert=require('node:assert/strict');
const {WheelGame,winningIndex,TAU,chooseReward}=require('../roulette-core.js');
for(const sign of [1,-1])for(let n=0;n<8;n++){
 const game=new WheelGame(4);game.angle=n*TAU/8;game.onChoose=()=>3;
 assert.equal(game.beginManual(0,100),true);
 for(let i=1;i<15;i++)game.moveManual(sign*i*.055,100+i*24);
 assert.equal(game.endManual(440),true);
 assert.equal(game.decelMs,2000,'submax spin must coast 2 seconds');
 assert.equal(game.state,'decelerating');
 game.tick(.016,700);assert.equal(game.state,'decelerating','must still coast after 260ms');
 game.tick(.016,1430);assert.equal(game.state,'decelerating','must still coast after 990ms');
 game.tick(.016,2440);assert.equal(game.state,'result');
 assert.equal(game.resultIndex,3);assert.equal(winningIndex(game.angle,4),3);
 assert.equal(game.endManual(2500),false);
}
const full=new WheelGame(4);full.onChoose=()=>2;full.beginManual(0,0);
full.moveManual(2.0,20);assert.ok(full.peakPower>=92);
full.endManual(40);assert.equal(full.decelMs,260);
full.tick(.016,301);assert.equal(full.resultIndex,2);assert.equal(full.state,'result');
const cap=new WheelGame(4);assert.equal(cap.maxShakeMs,4000);cap.onChoose=()=>1;cap.beginManual(.1,0);
for(let now=0;now<=6100;now+=20)cap.tick(.02,now);
assert.equal(cap.state,'result','max manual play = 4s + 2s coast');
const rewards=[{id:1,grade:1},{id:2,grade:2},{id:3,grade:3},{id:4,grade:4}];
for(let i=0;i<1000;i++)assert.notEqual(chooseReward(rewards,100,()=>i/1000).grade,1);
console.log('PASS 16 low-speed drags coast 2s, top gauge 260ms, 4s cap, independent draw, red exclusion');
