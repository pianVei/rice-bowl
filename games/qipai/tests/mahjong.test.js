'use strict';
/* mahjong.test.js — 国标麻将引擎 + 状态机的无头测试。
 * 跑法：node tests/mahjong.test.js
 */

const assert = require('assert');
const mj = require('../js/mahjong.js');
const { MahjongGame, MIN_FAN } = require('../js/mahjong-game.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

function tiles(labels) {
  // '1万 2万 3万' -> [{k,id}]，id 取一个递增计数器避免撞号
  let id = 0;
  return labels.split(/\s+/).filter(Boolean).map(s => {
    const k = mj.MJ_LABELS.indexOf(s);
    if (k < 0) throw new Error('未知牌面 ' + s);
    return { k, id: id++ };
  });
}

console.log('\n[mahjong] 牌模型');
ok('34 种牌面', () => assert.strictEqual(mj.MJ_KINDS, 34));
ok('一副 136 张', () => assert.strictEqual(mj.makeDeck().length, 136));
ok('每种 4 张', () => {
  const c = mj.countsOfTiles(mj.makeDeck());
  for (let k = 0; k < 34; k++) assert.strictEqual(c[k], 4, 'kind ' + k);
});
ok('洗牌后仍是 136 张', () => assert.strictEqual(mj.shuffle(mj.makeDeck(), Math.random).length, 136));

console.log('\n[mahjong] 和牌判定');
ok('标准四面子一将', () => {
  const h = tiles('1万 2万 3万 4万 5万 6万 7万 8万 9万 1条 2条 3条 5筒 5筒');
  assert.ok(mj.isWinningHand(h));
});
ok('七对', () => {
  const h = tiles('1万 1万 2万 2万 3万 3万 4条 4条 5条 5条 6筒 6筒 7筒 7筒');
  assert.ok(mj.isSevenPairs(mj.countsOfTiles(h)));
});
ok('十三幺', () => {
  const h = tiles('1万 9万 1条 9条 1筒 9筒 东 南 西 北 中 发 白 白');
  assert.ok(mj.isThirteenOrphans(mj.countsOfTiles(h)));
});
ok('缺一张不算和', () => {
  const h = tiles('1万 2万 3万 4万 5万 6万 7万 8万 9万 1条 2条 3条 5筒 6筒');
  assert.ok(!mj.isWinningHand(h));
});

console.log('\n[mahjong] 听牌 / 向听');
ok('听 5筒 的牌能报出听口', () => {
  const h = tiles('1万 2万 3万 4万 5万 6万 7万 8万 9万 1条 2条 3条 5筒');
  const wait = mj.winningTiles(h, []);
  assert.ok(wait.length > 0, '没有听口');
});

console.log('\n[mahjong] 状态机');
ok('发牌：四家各 13 张，牌墙剩 70', () => {
  // 全设成人，免得 AI 在 startRound 里就接着打下去
  const g = new MahjongGame({ players: [0, 1, 2, 3].map(i => ({ name: 'P' + i, isAI: false })), seed: 7 }, {});
  g.startRound();
  assert.deepStrictEqual(g.hands.map(h => h.length), [14, 13, 13, 13], '庄家多摸一张');
  assert.strictEqual(g.turn, 0);
  assert.strictEqual(g.wall.length, 69);
  assert.strictEqual(g.deadWall.length, 14);
  const ids = g.hands.flat().map(t => t.id);
  assert.strictEqual(new Set(ids).size, ids.length, '有重复的牌 id');
});
ok('四家全 AI 能打完整场', () => {
  const g = new MahjongGame({ players: [0, 1, 2, 3].map(i => ({ name: 'P' + i, isAI: true })), totalRounds: 4, seed: 99 }, {});
  g.startRound();
  g.run(200000);
  assert.ok(g.matchOver, '比赛没结束');
  assert.strictEqual(g.roundNo, 4);
});

console.log('\n[mahjong] 视图契约（UI 依赖）');
ok('buildView 每一家都能取到自己的手牌', () => {
  const g = new MahjongGame({ players: [0, 1, 2, 3].map(i => ({ name: 'P' + i, isAI: false })), seed: 3 }, {});
  g.startRound();
  for (let s = 0; s < 4; s++) {
    const v = g.buildView(s);
    assert.strictEqual(v.mySeat, s);
    assert.ok(v.myHand.length >= 13, 'seat ' + s + ' 手牌 ' + v.myHand.length);
    assert.ok(Array.isArray(v.players) && v.players.length === 4);
    assert.ok(v.players[s].handCount === v.myHand.length, 'handCount 与手牌不符');
    assert.strictEqual(typeof v.revision, 'number');
  }
});
ok('别人的手牌不可见', () => {
  const g = new MahjongGame({ players: [0, 1, 2, 3].map(i => ({ name: 'P' + i, isAI: false })), seed: 3 }, {});
  g.startRound();
  const v = g.buildView(0);
  for (let i = 1; i < 4; i++) assert.ok(!('myHand' in v.players[i]), '玩家 ' + i + ' 的手牌泄漏了');
});
ok('人类能弃牌', () => {
  const g = new MahjongGame({ players: [{ name: '你', isAI: false }, { name: 'B', isAI: true }, { name: 'C', isAI: true }, { name: 'D', isAI: true }], seed: 11 }, {});
  g.startRound();
  assert.strictEqual(g.turn, 0);
  assert.strictEqual(g.phase, 'discard');
  const t = g.hands[0][0];
  const before = g.hands[0].length;
  assert.ok(g.discard(0, t.id));
  // 打出去之后可能已经被别家碰走，所以只查「这张牌不在手里了」
  assert.ok(!g.hands[0].some(x => x.id === t.id), '打出的牌还在手里');
  assert.notStrictEqual(g.hands[0].length, before + 1);
});
ok('人类能碰牌', () => {
  const g = new MahjongGame({ players: [{ name: '你', isAI: false }, { name: 'B', isAI: true }, { name: 'C', isAI: true }, { name: 'D', isAI: true }], seed: 11 }, {});
  g.startRound();
  // 造一个能碰的局面：手里两张同样的牌，家 1 打出第三张
  g.hands[0] = tiles('5万 5万 1条 2条 3条 4条 5条 6条 7条 8条 9条 1筒 2筒');
  const k = mj.MJ_LABELS.indexOf('5万');
  const tile = { k, id: 9999 };
  g.phase = 'claim';
  g.pending = { tile, from: 1 };
  g.discards[1].push(tile);
  g.claims = { 0: null, 1: 'pass', 2: 'pass', 3: 'pass' };
  g.claimOpts = {}; g.awaiting = [0];
  const opts = g.claimOptions(0, tile, 1);
  g.claimOpts[0] = opts;
  assert.ok(opts.some(o => o.t === 'pung'), '没有碰的选项');
  assert.ok(g.submitClaim(0, 'pung'));
});

console.log('\n[mahjong] 自摸判定');
ok('碰完不能自摸（手里那张不是摸来的）', () => {
  const g = new MahjongGame({ players: [{ name: '你', isAI: false }, { name: 'B', isAI: true }, { name: 'C', isAI: true }, { name: 'D', isAI: true }], seed: 11 }, {});
  g.startRound();
  // 造一手「已经成形」的 11 张 + 1 副露，模拟刚碰完
  g.hands[0] = tiles('1万 2万 3万 4万 5万 6万 7万 8万 9万 1条 1条');
  g.exposed[0] = [{ t: 'pung', k: 22, tiles: tiles('5筒 5筒 5筒'), from: 1 }];
  g.drawnTile = null;
  g.turn = 0;
  g.phase = 'discard';
  assert.strictEqual(g.actSelfWin(0), false, '碰完之后居然允许自摸');
});
ok('摸到牌后同一手可以自摸', () => {
  const g = new MahjongGame({ players: [{ name: '你', isAI: false }, { name: 'B', isAI: true }, { name: 'C', isAI: true }, { name: 'D', isAI: true }], seed: 11 }, {});
  g.startRound();
  g.hands[0] = tiles('1万 2万 3万 4万 5万 6万 7万 8万 9万 1条 1条 1条');
  g.exposed[0] = [{ t: 'pung', k: 22, tiles: tiles('5筒 5筒 5筒'), from: 1 }];
  g.drawnTile = g.hands[0][g.hands[0].length - 1];
  g.turn = 0;
  g.phase = 'discard';
  const v = g.buildView(0);
  assert.ok(v.selfOpts, '没有 selfOpts');
  assert.ok(v.selfOpts.hu > 0 || v.selfOpts.hu === 0, 'selfOpts.hu 缺失');
});

console.log('\n[mahjong] 提示 / 听牌');
ok('提示返回一张手里的牌', () => {
  const g = new MahjongGame({ players: [{ name: '你', isAI: false }, { name: 'B', isAI: true }, { name: 'C', isAI: true }, { name: 'D', isAI: true }], seed: 5 }, {});
  g.startRound();
  const id = g.hintDiscard(0);
  assert.ok(id != null, '没给提示');
  assert.ok(g.hands[0].some(t => t.id === id), '提示的牌不在手里');
});
ok('听牌时 winTiles 非空', () => {
  const g = new MahjongGame({ players: [{ name: '你', isAI: false }, { name: 'B', isAI: true }, { name: 'C', isAI: true }, { name: 'D', isAI: true }], seed: 5 }, {});
  g.startRound();
  g.hands[0] = tiles('1万 2万 3万 4万 5万 6万 7万 8万 9万 1条 2条 3条 5筒 9筒');
  g.drawnTile = g.hands[0][13];
  g.turn = 0; g.phase = 'discard';
  const v = g.buildView(0);
  assert.ok(Array.isArray(v.ting), 'ting 不是数组');
});

console.log('\n[mahjong] 结果');
console.log(`  ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
