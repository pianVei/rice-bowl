'use strict';
/* guandan.test.js — engine unit tests + AI-vs-AI match simulations. */
const assert = require('node:assert');
const gd = require('../js/guandan.js');
const { GuandanGame } = require('../js/guandan-game.js');

let passed = 0;
function ok(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  passed++;
  console.log('ok -', msg);
}

let _cid = 0;
const card = (r, s) => ({ r, s, id: _cid++ });

/* ---------- deck ---------- */
{
  const d = gd.gdMakeDeck();
  ok(d.length === 108, '双副牌共 108 张');
  const m = gd.gdCounts(d.map(c => c.r));
  ok(m[3] === 8 && m[15] === 8, '每个点数 8 张');
  ok(m[16] === 2 && m[17] === 2, '双小王双大王');
}

/* ---------- level mapping ---------- */
ok(gd.gdNextLevel(15) === 3, '打完2升3');
ok(gd.gdNextLevel(13) === 14, '打完K升A');
ok(gd.gdNextLevel(14) === null, 'A 是最高级');

/* ---------- plain detection ---------- */
{
  ok(gd.gdDetectPlain([card(5, 0), card(5, 1)]).type === 'pair', '对子');
  ok(gd.gdDetectPlain([card(5, 0), card(5, 1), card(5, 2), card(5, 3)]).type === 'bomb', '四张炸弹');
  ok(gd.gdDetectPlain([card(5, 0), card(5, 1), card(5, 2), card(5, 3), card(5, 0)]).type === 'bomb' &&
     gd.gdDetectPlain([card(5, 0), card(5, 1), card(5, 2), card(5, 3), card(5, 0)]).n === 5, '五张炸弹');
  ok(gd.gdDetectPlain([card(16, -1), card(17, -1)]).type === 'heaven', '天王炸');
  const st = gd.gdDetectPlain([card(3, 0), card(4, 1), card(5, 2), card(6, 3), card(7, 0)]);
  ok(st.type === 'straight' && st.rank === 7, '顺子 3-7');
  const flush = gd.gdDetectPlain([3, 4, 5, 6, 7].map(r => card(r, 1)));
  ok(flush.type === 'flush_straight' && flush.rank === 7, '同花顺 ♥3-7');
  ok(gd.gdDetectPlain([3, 4, 5, 6, 15].map(r => card(r, 0))) === null, '顺子不能含2');
  const twoSmalls = gd.gdDetectPlain([card(16, -1), card(16, -1)]);
  ok(twoSmalls === null, '双小王不成对不成炸');
  const tp = gd.gdDetectPlain([card(8, 0), card(8, 1), card(8, 2), card(4, 0), card(4, 1)]);
  ok(tp.type === 'trio_pair' && tp.rank === 8, '三带二');
  const ps = gd.gdDetectPlain([3, 3, 4, 4, 5, 5].map(r => card(r, 0)));
  ok(ps.type === 'pair_seq' && ps.len === 3, '三连对');
  ok(gd.gdDetectPlain([3, 3, 4, 4].map(r => card(r, 0))) === null, '两连对不算连对');
  const ts = gd.gdDetectPlain([3, 3, 3, 4, 4, 4].map(r => card(r, 0)));
  ok(ts.type === 'trio_seq' && ts.len === 2, '钢板(二连三)');
}

/* ---------- beats ordering ---------- */
{
  const b4 = gd.gdDetectPlain([3, 3, 3, 3].map(r => card(r, 0)));
  const b5 = gd.gdDetectPlain([4, 4, 4, 4, 4].map(r => card(r, 0)));
  const b6 = gd.gdDetectPlain([5, 5, 5, 5, 5, 5].map(r => card(r, 0)));
  const flush = gd.gdDetectPlain([3, 4, 5, 6, 7].map(r => card(r, 2)));
  const hv = gd.gdDetectPlain([card(16, -1), card(17, -1)]);
  ok(gd.gdBeats(b5, b4), '五炸 > 四炸');
  ok(gd.gdBeats(flush, b5), '同花顺 > 五炸');
  ok(gd.gdBeats(b6, flush), '六炸 > 同花顺');
  ok(gd.gdBeats(hv, b6) && gd.gdBeats(hv, flush), '天王炸最大');
  ok(!gd.gdBeats(b4, b5), '四炸 < 五炸');
  ok(gd.gdBeats(gd.gdDetectPlain([8, 8, 8, 8].map(r => card(r, 0))), b4), '炸弹点数大者胜');
}

/* ---------- wild (逢人配) ---------- */
{
  // level 5 → hearts 5 are wild for that seat
  const straight = gd.gdAnalyze([card(3, 0), card(4, 0), card(5, 1), card(6, 0), card(7, 0)], null, 5);
  ok(straight && straight.type === 'straight' && straight.rank === 7, '逢人配补顺子 3-7');
  const bomb = gd.gdAnalyze([card(9, 0), card(9, 1), card(9, 2), card(5, 1)], null, 5);
  ok(bomb && bomb.type === 'bomb' && bomb.rank === 9, '逢人配补炸弹');
  const notHeaven = gd.gdAnalyze([card(16, -1), card(17, -1), card(5, 1)], null, 5);
  ok(notHeaven === null || notHeaven.type !== 'heaven', '逢人配不能当王组天王炸');
  const lone = gd.gdAnalyze([card(5, 1)], null, 5);
  ok(lone && lone.type === 'single' && lone.rank === 5, '单出逢人配只算本牌(级牌5)');
  const pair9 = gd.gdAnalyze([card(9, 0), card(5, 1)], null, 5);
  ok(pair9 && pair9.type === 'pair' && pair9.rank === 9, '逢人配配对子');
  // follow validation: pair of 6s beats pair of 5s with wild
  const prev = gd.gdDetectPlain([card(5, 2), card(5, 3)]);
  const follow = gd.gdAnalyze([card(6, 0), card(5, 1)], prev, 5);
  ok(follow && follow.type === 'pair' && follow.rank === 6, '逢人配跟对子压过上一手');
}

/* ---------- legal moves ---------- */
{
  const hand = [3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15, 16, 17].map(r => card(r, r % 4));
  const leads = gd.gdLegalMoves(hand, 99, null); // 99 = no wild in hand
  ok(leads.some(m => m.combo.type === 'straight' && m.combo.rank === 14), '能出 3-A 长顺');
  ok(leads.some(m => m.combo.type === 'heaven'), '能出天王炸');
  ok(leads.some(m => m.combo.type === 'pair' && m.combo.rank === 15), '能出对2');
  const prevPair = gd.gdDetectPlain([card(6, 0), card(6, 1)]);
  const follows = gd.gdLegalMoves(hand, 99, prevPair);
  ok(follows.every(m => gd.gdBeats(m.combo, prevPair)), '所有跟牌都能压过');
  ok(!follows.some(m => m.combo.type === 'pair' && m.combo.rank <= 6), '不能出更小的对子');
}

/* ---------- AI sanity ---------- */
{
  const hand = [3, 3, 3, 4, 4, 5, 6, 7, 8, 9].map(r => card(r, r % 4));
  const mv = gd.gdAiPlay(hand, 99, null, { prevSeat: null, mySeat: 0, teams: [0, 1, 0, 1], finished: [false, false, false, false], cardCounts: [10, 10, 10, 10] });
  ok(mv && mv.ids.length <= hand.length, 'AI 首出返回合法动作');
  const prev = gd.gdDetectPlain([card(6, 0), card(6, 1)]);
  const mv2 = gd.gdAiPlay(hand, 99, prev, { prevSeat: 1, mySeat: 0, teams: [0, 1, 0, 1], finished: [false, false, false, false], cardCounts: [10, 10, 10, 10] });
  ok(mv2 === null || gd.gdBeats(mv2.combo, prev), 'AI 跟牌要么压过要么过');
}

/* ---------- view contract (what ui.js / agent.js consume) ---------- */
{
  const g = new GuandanGame({
    mode: 'guandan', aiDelay: 0,
    players: [{ name: 'Me' }, { name: 'AI1', isAI: true }, { name: 'AI2', isAI: true }, { name: 'AI3', isAI: true }],
  }, {});
  g.startRound();
  for (let seat = 0; seat < 4; seat++) {
    const v = g.buildView(seat);
    if (v.mode !== 'guandan' || v.n !== 4) throw new Error('view mode/n wrong');
    if (v.myHand.length !== 27) throw new Error('seat ' + seat + ' hand size ' + v.myHand.length);
    if (v.players.length !== 4) throw new Error('players length');
    if (v.players.filter(p => p.ally).length !== 2) throw new Error('ally seats');
    if (!v.gd || v.gd.myLevelRank !== 15 || v.gd.labels[0] !== '2') throw new Error('gd meta');
    if (v.landlord !== null || v.laizi !== null || v.bottom !== null) throw new Error('doudizhu-only fields must be null');
    JSON.parse(JSON.stringify(v)); // must be serialisable for the bridge
  }
  console.log('ok - buildView 契约(4 座位/27 张/队友/级牌)');
  passed++;
}

/* ---------- full match simulation (AI vs AI) ---------- */
{
  let matches = 0, rounds = 0, errors = [];
  const t0 = Date.now();
  for (let match = 0; match < 5; match++) {
    const g = new GuandanGame({
      mode: 'guandan', aiDelay: 0,
      players: [0, 1, 2, 3].map(i => ({ name: 'AI' + i, isAI: true })),
    }, { onError: e => errors.push(e) });
    g.startRound();
    let guard = 0;
    while (!g.matchOver && guard++ < 60) {
      ok2(g.state === 'settle' || g.state === 'playing');
      if (g.state === 'settle') g.nextRound(); else break;
    }
    ok2(g.matchOver, 'match ' + match + ' 终局');
    rounds += g.roundNo;
    matches++;
  }
  function ok2(cond, msg) { if (!cond) { console.error('FAIL:', msg, errors); process.exit(1); } }
  if (errors.length) { console.error('sim errors:', errors); process.exit(1); }
  console.log(`sim ok: ${matches} 场比赛 / ${rounds} 局, ${Date.now() - t0}ms`);
  passed++;
}

console.log(`\nAll ${passed} guandan tests passed.`);
