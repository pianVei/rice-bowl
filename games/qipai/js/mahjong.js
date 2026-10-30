'use strict';
/* =========================================================================
 * mahjong.js — 国标麻将 (Chinese Official / MCR-flavoured) rules engine.
 * Pure logic, no DOM. Usable from Node (CommonJS) and from the browser.
 *
 * Tile model
 *   kind 0..33 : 0-8 = 万1-9, 9-17 = 条1-9, 18-26 = 筒1-9,
 *                27 东 28 南 29 西 30 北, 31 中 32 发 33 白
 *   tile       : {k: kind, id: 0..135}
 * ========================================================================= */
(function (root, factory) {
  const api = factory();
  // 只挂 MJ。别把整个 api 摊到 window 上：里面的 makeDeck / shuffle /
  // sortTiles 会和 cards.js 的同名全局函数打架，把斗地主发成麻将牌。
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.MJ = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /* ---------- constants ---------- */
  const MJ_KINDS = 34;
  const MJ_SUIT_NAMES = ['万', '条', '筒'];
  const MJ_HONOR_NAMES = ['东', '南', '西', '北', '中', '发', '白'];
  const MJ_LABELS = (() => {
    const a = [];
    for (let i = 0; i < 27; i++) a.push((i % 9 + 1) + MJ_SUIT_NAMES[(i / 9) | 0]);
    for (let i = 0; i < 7; i++) a.push(MJ_HONOR_NAMES[i]);
    return a;
  })();

  const suitOf = k => (k < 27 ? (k / 9) | 0 : 3);
  const rankOf = k => (k < 27 ? (k % 9) + 1 : k - 26);          // 字牌 1..7
  const isHonor = k => k >= 27;
  const isWind = k => k >= 27 && k <= 30;
  const isDragon = k => k >= 31 && k <= 33;
  const isTerminal = k => k < 27 && (k % 9 === 0 || k % 9 === 8); // 1 or 9
  const isYaochu = k => isHonor(k) || isTerminal(k);
  const isSimple = k => !isYaochu(k);

  const tileLabel = k => MJ_LABELS[k];

  function makeDeck() {
    const d = [];
    for (let k = 0; k < MJ_KINDS; k++) for (let i = 0; i < 4; i++) d.push({ k, id: k * 4 + i });
    return d;
  }
  function shuffle(arr, rng) {
    const r = rng || Math.random;
    for (let i = arr.length - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }
  function counts(ks) { const c = new Array(MJ_KINDS).fill(0); for (const k of ks) c[k]++; return c; }
  function countsOfTiles(ts) { const c = new Array(MJ_KINDS).fill(0); for (const t of ts) c[t.k]++; return c; }
  function expand(c) { const a = []; for (let k = 0; k < MJ_KINDS; k++) for (let i = 0; i < c[k]; i++) a.push(k); return a; }
  function sortTiles(ts) { return ts.slice().sort((a, b) => a.k - b.k || a.id - b.id); }

  /* ---------- decomposition -------------------------------------------
   * A winning hand is either
   *   standard : 4 melds + 1 pair  (melds may come from exposed calls)
   *   seven pairs / thirteen orphans / honours-and-knitted (special)
   * ------------------------------------------------------------------- */
  function decomposeMelds(cnt, need, start, melds, out) {
    if (melds.length === need) {
      for (let i = start; i < MJ_KINDS; i++) if (cnt[i]) return;
      out.push(melds.slice());
      return;
    }
    let i = start;
    while (i < MJ_KINDS && cnt[i] === 0) i++;
    if (i >= MJ_KINDS) return;
    if (cnt[i] >= 3) {
      cnt[i] -= 3; melds.push({ t: 'pung', k: i });
      decomposeMelds(cnt, need, i, melds, out);
      melds.pop(); cnt[i] += 3;
    }
    if (i < 27 && i % 9 <= 6 && cnt[i + 1] > 0 && cnt[i + 2] > 0) {
      cnt[i]--; cnt[i + 1]--; cnt[i + 2]--; melds.push({ t: 'chow', k: i });
      decomposeMelds(cnt, need, i, melds, out);
      melds.pop(); cnt[i]++; cnt[i + 1]++; cnt[i + 2]++;
    }
  }

  /** All (pair, melds) decompositions of the concealed part. */
  function winningSets(concealedCnt, exposedCount) {
    const need = 4 - exposedCount;
    const out = [];
    if (need < 0) return out;
    const c = concealedCnt;
    for (let p = 0; p < MJ_KINDS; p++) {
      if (c[p] < 2) continue;
      c[p] -= 2;
      const melds = [], bucket = [];
      decomposeMelds(c, need, 0, melds, bucket);
      for (const m of bucket) out.push({ pair: p, melds: m, type: 'standard' });
      c[p] += 2;
    }
    return out;
  }

  function isSevenPairs(cnt, exposedCount) {
    if (exposedCount > 0) return null;
    let n = 0;
    for (let k = 0; k < MJ_KINDS; k++) { if (cnt[k] === 0) continue; if (cnt[k] !== 2) return null; n++; }
    return n === 7 ? { pair: null, melds: [], type: 'seven_pairs' } : null;
  }

  const YAOJIU = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
  function isThirteenOrphans(cnt, exposedCount) {
    if (exposedCount > 0) return null;
    let pair = -1, kinds = 0;
    for (let k = 0; k < MJ_KINDS; k++) {
      if (cnt[k] === 0) continue;
      if (!YAOJIU.includes(k)) return null;
      if (cnt[k] === 2) { if (pair >= 0) return null; pair = k; }
      else if (cnt[k] !== 1) return null;
      kinds++;
    }
    return kinds === 13 && pair >= 0 ? { pair, melds: [], type: 'thirteen_orphans' } : null;
  }

  /** 全不靠 / 七星不靠 : 7 honours (all distinct) + 3 suits × (147|258|369) distinct groups */
  function isKnitted(cnt, exposedCount) {
    if (exposedCount > 0) return null;
    const hon = [], suits = [[], [], []];
    for (let k = 0; k < MJ_KINDS; k++) {
      if (!cnt[k]) continue;
      if (cnt[k] !== 1) return null;
      if (isHonor(k)) hon.push(k); else suits[suitOf(k)].push(rankOf(k));
    }
    if (hon.length !== 7) return null;
    const groups = [];
    for (let s = 0; s < 3; s++) {
      const r = suits[s].slice().sort((a, b) => a - b);
      if (!r.length) return null;
      const g = r[0] % 3; // 1→1,2→2,3→0(369)
      const want = g === 1 ? [1, 4, 7] : g === 2 ? [2, 5, 8] : [3, 6, 9];
      for (const x of r) if (!want.includes(x)) return null;
      groups.push(g === 1 ? 1 : g === 2 ? 2 : 3);
    }
    if (groups[0] === groups[1] || groups[1] === groups[2] || groups[0] === groups[2]) return null;
    return { pair: null, melds: [], type: 'knitted', sevenStars: true };
  }

  /** Every way the (concealed + exposed) hand can be a winner. */
  function allWinningForms(concealedCnt, exposed) {
    const out = [];
    const sp = isSevenPairs(concealedCnt, exposed.length);
    if (sp) out.push(sp);
    const to = isThirteenOrphans(concealedCnt, exposed.length);
    if (to) out.push(to);
    const kn = isKnitted(concealedCnt, exposed.length);
    if (kn) out.push(kn);
    for (const s of winningSets(concealedCnt, exposed.length)) out.push(s);
    return out;
  }

  /** Is this 14-tile hand (concealed + exposed) a winning hand? */
  function isWinningHand(concealedTiles, exposed, winTile) {
    const cc = countsOfTiles(concealedTiles);
    return allWinningForms(cc, exposed || []).length > 0;
  }

  /* ---------- fan (番种) evaluation ---------------------------------- */

  const FAN_NAMES = {
    big_four_winds: '大四喜', big_three_dragons: '大三元', all_green: '绿一色',
    nine_gates: '九莲宝灯', four_kongs: '四杠', seven_shifted_pairs: '连七对',
    thirteen_orphans: '十三幺',
   _all_terminals: '清幺九', little_four_winds: '小四喜', little_three_dragons: '小三元',
    all_honours: '字一色', four_concealed_pungs: '四暗刻', pure_triple_chow_pair: '一色双龙会',
    quadruple_chow: '一色四同顺', four_shifted_pungs: '一色四节高',
    four_shifted_chows: '一色四步高', three_kongs: '三杠', mixed_terminals: '混幺九',
    seven_pairs: '七对', seven_stars: '七星不靠', all_even_pungs: '全双刻',
    pure_one_suit: '清一色', triple_chow_same: '一色三同顺', three_shifted_pungs: '一色三节高',
    all_big: '全大', all_middle: '全中', all_small: '全小',
    pure_straight: '清龙', three_concealed_pungs: '三暗刻', heavenly_ready: '天听',
    upper_four: '大于五', lower_four: '小于五', three_wind_pungs: '三风刻',
    mixed_straight: '花龙', reversible: '推不倒', triple_chow_diff: '三色三同顺',
    three_shifted_pungs_diff: '三色三节高', no_fan: '无番和', last_draw: '妙手回春',
    last_claim: '海底捞月', kong_flower: '杠上开花', rob_kong: '抢杠和',
    all_pungs: '碰碰和', mixed_one_suit: '混一色', three_shifted_chows: '三色三步高',
    five_suits: '五门齐', all_depend: '全求人', two_concealed_kongs: '双暗杠',
    two_dragon_pungs: '双箭刻',
    all_yaochu: '全带幺', self_pick_clean: '不求人', two_exposed_kongs: '双明杠',
    last_tile: '和绝张',
    dragon_pung: '箭刻', round_wind_pung: '圈风刻', seat_wind_pung: '门风刻',
    concealed_hand_ron: '门前清', all_chows: '平和', four_same: '四归一',
    two_pungs_same: '双同刻', two_concealed_pungs: '双暗刻', concealed_kong: '暗杠',
    all_singles: '断幺',
    same_chow: '一般高', similar_chow: '喜相逢', short_straight: '连六',
    two_terminal_chows: '老少副', yaochu_pung: '幺九刻', exposed_kong: '明杠',
    one_suit_missing: '缺一门', no_honours: '缺字',
    edge_wait: '边张', closed_wait: '坎张', single_wait: '单钓将', self_draw: '自摸',
  };

  // Which low-value fans are absorbed when a higher one fires (国标不重复计番).
  const ABSORB = {
    pure_one_suit: ['one_suit_missing', 'no_honours'],
    mixed_one_suit: ['one_suit_missing'],
    all_honours: ['one_suit_missing', 'no_honours', 'all_singles', 'mixed_one_suit', 'mixed_terminals', 'all_yaochu', 'yaochu_pung'],
    _all_terminals: ['all_yaochu', 'all_pungs', 'all_singles', 'yaochu_pung'],
    mixed_terminals: ['all_yaochu', 'all_pungs', 'yaochu_pung'],
    all_pungs: ['all_chows'],
    all_big: ['upper_four'], all_small: ['lower_four'],
    seven_pairs: ['all_pungs', 'single_wait', 'self_pick_clean', 'concealed_hand_ron'],
    thirteen_orphans: ['all_yaochu', 'mixed_terminals', 'single_wait'],
    little_four_winds: ['three_wind_pungs', 'yaochu_pung'],
    big_four_winds: ['little_four_winds', 'three_wind_pungs', 'yaochu_pung', 'all_pungs'],
    little_three_dragons: ['two_dragon_pungs', 'dragon_pung'],
    big_three_dragons: ['little_three_dragons', 'two_dragon_pungs', 'dragon_pung'],
    four_concealed_pungs: ['three_concealed_pungs', 'two_concealed_pungs', 'all_pungs'],
    three_concealed_pungs: ['two_concealed_pungs'],
    four_kongs: ['three_kongs', 'two_concealed_kongs', 'two_exposed_kongs', 'concealed_kong', 'exposed_kong'],
    three_kongs: ['two_concealed_kongs', 'two_exposed_kongs', 'concealed_kong', 'exposed_kong'],
    quadruple_chow: ['triple_chow_same', 'same_chow', 'four_same'],
    triple_chow_same: ['same_chow'],
    triple_chow_diff: ['similar_chow'],
    pure_straight: ['two_terminal_chows'],
    three_shifted_pungs: ['two_pungs_same'],
    three_shifted_pungs_diff: ['two_pungs_same'],
    seven_shifted_pairs: ['seven_pairs'],
    all_even_pungs: ['all_pungs'],
  };

  function buildContext(concealed, exposed, form, opt) {
    // faces: unified meld list {t:'chow'|'pung'|'kong', k, open}
    const faces = [];
    for (const m of exposed) faces.push({ t: m.t, k: m.k, open: true });
    for (const m of form.melds || []) faces.push({ t: m.t, k: m.k, open: false });
    const allKinds = [];
    for (const t of concealed) allKinds.push(t.k);
    // A kong counts as a 3-tile meld for hand-structure purposes; its 4th tile
    // is the "extra" kong tile (that is why a kong hand has one more tile).
    for (const f of exposed) for (let i = 0; i < 3; i++) allKinds.push(f.k);
    allKinds.sort((a, b) => a - b);
    const pungs = faces.filter(f => f.t !== 'chow');
    const chows = faces.filter(f => f.t === 'chow');
    const kongs = faces.filter(f => f.t === 'kong');
    return {
      concealed, exposed, form, faces, allKinds, pungs, chows, kongs,
      pair: form.pair, type: form.type,
      winTile: opt.winTile, selfDraw: !!opt.selfDraw,
      seatWind: opt.seatWind, roundWind: opt.roundWind,
      menqing: exposed.length === 0,
      concealedPungs: faces.filter(f => f.t !== 'chow' && !f.open).length,
      concealedKongs: faces.filter(f => f.t === 'kong' && !f.open).length,
      exposedKongs: faces.filter(f => f.t === 'kong' && f.open).length,
      lastTile: !!opt.lastTile, kongDraw: !!opt.kongDraw, robKong: !!opt.robKong,
      outOfWall: !!opt.lastTile,
      cnt: counts(allKinds),
    };
  }

  const has = (arr, v) => arr.indexOf(v) >= 0;

  function evalFan(c) {
    const f = [];
    const add = (key, fan) => { if (fan > 0) f.push({ key, fan }); };
    const A = c.allKinds, faces = c.faces, pair = c.pair;
    const suits = new Set(A.map(suitOf));

    if (c.type === 'thirteen_orphans') { add('thirteen_orphans', 88); return finish(f, c); }
    if (c.type === 'knitted' || (c.type === 'standard' && false)) { /* handled below */ }
    if (c.type === 'knitted') { add('seven_stars', 24); return finish(f, c); }

    // ---- 88 ----
    if (faces.filter(x => x.t !== 'chow' && isWind(x.k)).length === 4) add('big_four_winds', 88);
    if ([31, 32, 33].every(k => faces.some(x => x.t !== 'chow' && x.k === k))) add('big_three_dragons', 88);
    if (A.every(k => [10, 11, 12, 14, 16, 32].includes(k))) add('all_green', 88);
    if (c.menqing) {
      const s = suitOf(A[0]);
      if (suits.size === 1 && s < 3) {
        const r = {}; for (const k of A) r[rankOf(k)] = (r[rankOf(k)] || 0) + 1;
        if (r[1] >= 3 && r[9] >= 3 && [2, 3, 4, 5, 6, 7, 8].every(x => r[x] >= 1)) add('nine_gates', 88);
      }
    }
    if (c.kongs.length === 4) add('four_kongs', 88);
    if (c.type === 'seven_pairs' && c.menqing) {
      const ks = [...new Set(A)].sort((a, b) => a - b);
      if (ks.length === 7 && ks[0] < 27 && suitOf(ks[0]) === suitOf(ks[6]) && rankOf(ks[6]) - rankOf(ks[0]) === 6 && ks.every((k, i) => i === 0 || rankOf(k) === rankOf(ks[i - 1]) + 1))
        add('seven_shifted_pairs', 88);
    }
    // ---- 64 ----
    if (A.every(k => isTerminal(k))) add('_all_terminals', 64);
    const windPungs = faces.filter(x => x.t !== 'chow' && isWind(x.k));
    if (windPungs.length === 3 && pair !== null && isWind(pair)) add('little_four_winds', 64);
    const dragPungs = faces.filter(x => x.t !== 'chow' && isDragon(x.k));
    if (dragPungs.length === 2 && isDragon(pair)) add('little_three_dragons', 64);
    if (A.every(isHonor)) add('all_honours', 64);
    if (c.concealedPungs === 4) add('four_concealed_pungs', 64);
    if (c.menqing && suits.size === 1 && suitOf(A[0]) < 3) {
      const r = A.map(rankOf).sort((a, b) => a - b);
      if (r.join('') === '112233778899' + '' && pair === ((suitOf(A[0]) * 9) + 4))
        add('pure_triple_chow_pair', 64);
    }
    // ---- 48 ----
    if (c.chows.length === 4) {
      const byKey = {};
      for (const x of c.chows) byKey[x.k] = (byKey[x.k] || 0) + 1;
      if (Object.values(byKey).some(v => v === 4)) add('quadruple_chow', 48);
    }
    {
      const np = c.pungs.map(x => x.k).filter(k => k < 27).sort((a, b) => a - b);
      if (np.length === 4 && suitOf(np[0]) === suitOf(np[3]) && np[3] - np[0] === 3 && new Set(np).size === 4)
        add('four_shifted_pungs', 48);
    }
    // ---- 32 ----
    if (c.chows.length === 4) {
      const ks = c.chows.map(x => x.k).sort((a, b) => a - b);
      const sameSuit = suitOf(ks[0]) === suitOf(ks[3]) && ks.every(k => suitOf(k) === suitOf(ks[0]));
      const d1 = ks[3] - ks[2] === 1 && ks[2] - ks[1] === 1 && ks[1] - ks[0] === 1;
      const d2 = ks[3] - ks[2] === 2 && ks[2] - ks[1] === 2 && ks[1] - ks[0] === 2;
      if (sameSuit && (d1 || d2)) add('four_shifted_chows', 32);
    }
    if (c.kongs.length === 3) add('three_kongs', 32);
    if (A.every(isYaochu) && A.some(isHonor) && !A.every(isHonor)) add('mixed_terminals', 32);
    // ---- 24 ----
    if (c.type === 'seven_pairs') add('seven_pairs', 24);
    if (suits.size === 1 && suitOf(A[0]) < 3) add('pure_one_suit', 24);
    if (A.every(k => !isHonor(k) && [2, 4, 6, 8].includes(rankOf(k))) && faces.every(x => x.t !== 'chow')) add('all_even_pungs', 24);
    {
      const byKey = {};
      for (const x of c.chows) byKey[x.k] = (byKey[x.k] || 0) + 1;
      if (Object.values(byKey).some(v => v === 3)) add('triple_chow_same', 24);
      const np = c.pungs.map(x => x.k).filter(k => k < 27).sort((a, b) => a - b);
      if (np.length >= 3) {
        for (let i = 0; i + 2 < np.length; i++)
          if (suitOf(np[i]) === suitOf(np[i + 2]) && np[i + 2] - np[i] === 2 && new Set(np.slice(i, i + 3)).size === 3) { add('three_shifted_pungs', 24); break; }
      }
    }
    if (A.every(k => !isHonor(k) && rankOf(k) >= 7)) add('all_big', 24);
    if (A.every(k => !isHonor(k) && rankOf(k) >= 4 && rankOf(k) <= 6)) add('all_middle', 24);
    if (A.every(k => !isHonor(k) && rankOf(k) <= 3)) add('all_small', 24);
    // ---- 16 ----
    if (c.menqing || true) {
      const ks = c.chows.map(x => x.k).sort((a, b) => a - b);
      const want = [0, 3, 6];
      for (const s of [0, 1, 2]) if (want.every((w, i) => has(ks, s * 9 + w))) { add('pure_straight', 16); break; }
    }
    if (c.concealedPungs === 3) add('three_concealed_pungs', 16);
    // ---- 12 ----
    if (A.every(k => !isHonor(k) && rankOf(k) >= 6)) add('upper_four', 12);
    if (A.every(k => !isHonor(k) && rankOf(k) <= 4)) add('lower_four', 12);
    if (windPungs.length === 3) add('three_wind_pungs', 12);
    // ---- 8 ----
    if (c.chows.length >= 3) {
      const ks = c.chows.map(x => x.k);
      for (const a of [0, 3, 6]) for (const b of [0, 3, 6]) for (const cc2 of [0, 3, 6]) {
        if (a === b || b === cc2 || a === cc2) continue;
        if (has(ks, a) && has(ks, 9 + b) && has(ks, 18 + cc2)) { add('mixed_straight', 8); break; }
      }
    }
    if (A.every(k => REVERSIBLE.has(k))) add('reversible', 8);
    {
      const byRank = {};
      for (const x of c.chows) { const r = rankOf(x.k); (byRank[r] = byRank[r] || []).push(suitOf(x.k)); }
      if (Object.values(byRank).some(v => new Set(v).size === 3)) add('triple_chow_diff', 8);
      const byRankP = {};
      for (const x of c.pungs) if (!isHonor(x.k)) { const r = rankOf(x.k); (byRankP[r] = byRankP[r] || []).push(suitOf(x.k)); }
      if (Object.values(byRankP).some(v => new Set(v).size === 3)) add('three_shifted_pungs_diff', 8);
    }
    if (c.selfDraw && c.lastTile && !c.kongDraw) add('last_draw', 8);
    if (!c.selfDraw && c.lastTile) add('last_claim', 8);
    if (c.kongDraw) add('kong_flower', 8);
    if (c.robKong) add('rob_kong', 8);
    // ---- 6 ----
    if (faces.every(x => x.t !== 'chow')) add('all_pungs', 6);
    if (suits.size === 1 && A.some(isHonor)) add('mixed_one_suit', 6);
    if (c.chows.length >= 3) {
      const ks = c.chows.map(x => x.k);
      for (let s = 0; s < 3; s++) {
        const a = ks.find(k => suitOf(k) === s), b2 = ks.find(k => suitOf(k) === (s + 1) % 3), c3 = ks.find(k => suitOf(k) === (s + 2) % 3);
        if (a === undefined || b2 === undefined || c3 === undefined) continue;
        if (rankOf(b2) === rankOf(a) + 1 && rankOf(c3) === rankOf(a) + 2) { add('three_shifted_chows', 6); break; }
      }
    }
    {
      const numSuits = new Set(A.filter(k => !isHonor(k)).map(suitOf)).size;
      if (numSuits === 3 && A.some(isWind) && A.some(isDragon)) add('five_suits', 6);
    }
    if (c.exposed.length === 4) add('all_depend', 6);
    if (c.concealedKongs === 2) add('two_concealed_kongs', 6);
    if (dragPungs.length === 2) add('two_dragon_pungs', 6);
    // ---- 4 ----
    if (faces.every(x => x.t === 'chow' ? isYaochu(x.k) || isYaochu(x.k + 2) : isYaochu(x.k)) && isYaochu(pair)) add('all_yaochu', 4);
    if (c.menqing && c.selfDraw) add('self_pick_clean', 4);
    if (c.exposedKongs === 2) add('two_exposed_kongs', 4);
    if (c.lastTile) add('last_tile', 4);
    // ---- 2 ----
    if (dragPungs.length === 1) add('dragon_pung', 2);
    if (faces.some(x => x.t !== 'chow' && x.k === c.roundWind)) add('round_wind_pung', 2);
    if (faces.some(x => x.t !== 'chow' && x.k === c.seatWind)) add('seat_wind_pung', 2);
    if (c.menqing && !c.selfDraw) add('concealed_hand_ron', 2);
    if (faces.every(x => x.t === 'chow') && c.menqing && !isDragon(pair) && !isWind(pair)) add('all_chows', 2);
    {
      const seen = {};
      for (const k of A) seen[k] = (seen[k] || 0) + 1;
      if (Object.values(seen).some(v => v === 4) && c.kongs.length === 0) add('four_same', 2);
    }
    {
      const byK = {};
      for (const x of c.pungs) if (x.k < 27) byK[x.k] = (byK[x.k] || 0) + 1;
      if (Object.values(byK).some(v => v >= 2)) add('two_pungs_same', 2);
    }
    if (c.concealedPungs === 2) add('two_concealed_pungs', 2);
    if (c.concealedKongs === 1) add('concealed_kong', 2);
    if (A.every(isSimple)) add('all_singles', 2);
    // ---- 1 ----
    {
      const byK = {};
      for (const x of c.chows) byK[x.k] = (byK[x.k] || 0) + 1;
      if (Object.values(byK).some(v => v >= 2)) add('same_chow', 1);
      const byR = {};
      for (const x of c.chows) { const r = rankOf(x.k); (byR[r] = byR[r] || new Set()).add(suitOf(x.k)); }
      for (const r in byR) if (byR[r].size >= 2) { add('similar_chow', 1); break; }
    }
    {
      const ks = c.chows.map(x => x.k).sort((a, b) => a - b);
      for (let i = 0; i + 1 < ks.length; i++)
        if (suitOf(ks[i]) === suitOf(ks[i + 1]) && ks[i + 1] - ks[i] === 3) { add('short_straight', 1); break; }
      for (const s of [0, 1, 2])
        if (has(ks, s * 9 + 0) && has(ks, s * 9 + 6)) { add('two_terminal_chows', 1); break; }
    }
    if (c.pungs.some(x => isYaochu(x.k))) add('yaochu_pung', 1);
    if (c.exposedKongs === 1) add('exposed_kong', 1);
    if ([0, 1, 2].some(s => !A.some(k => suitOf(k) === s))) add('one_suit_missing', 1);
    if (!A.some(isHonor)) add('no_honours', 1);
    if (c.selfDraw) add('self_draw', 1);
    // waits
    if (c.type === 'standard' && c.winTile != null) {
      for (const m of form_melds_containing(c, c.winTile)) {
        if (m.t === 'chow') {
          const lo = rankOf(m.k), hi = rankOf(m.k) + 2;
          if (rankOf(c.winTile) === lo + 1) add('closed_wait', 1);
          if ((rankOf(c.winTile) === lo && hi === 9) || (rankOf(c.winTile) === hi && lo === 1)) add('edge_wait', 1);
        }
      }
      if (pair === c.winTile) add('single_wait', 1);
    }
    return finish(f, c);
  }

  const REVERSIBLE = new Set([
    0, 1, 2, 4, 6, 8,          // 筒 123589 (k 0..8)
    9, 10, 11, 13, 15, 17,      // 条 123589 (k 9..17)
    18, 19, 20, 22, 24, 26,     // 万 123589 (k 18..26)
    33,                          // 白
  ]);

  function form_melds_containing(c, k) {
    const out = [];
    for (const m of c.faces) {
      if (m.t === 'chow') { if (k >= m.k && k <= m.k + 2) out.push(m); }
      else if (m.k === k) out.push(m);
    }
    return out;
  }

  function finish(f, c) {
    // 无番和
    const total = f.reduce((s, x) => s + x.fan, 0);
    if (total === 0) f.push({ key: 'no_fan', fan: 8 });
    // 国标不重复计番: drop absorbed low fans
    const fired = new Set(f.map(x => x.key));
    const drop = new Set();
    for (const k of fired) for (const d of (ABSORB[k] || [])) drop.add(d);
    const kept = f.filter(x => !drop.has(x.key));
    return { fans: kept, total: kept.reduce((s, x) => s + x.fan, 0) };
  }

  /** Score a complete winning hand. Returns best result across all decompositions. */
  function scoreHand(concealedTiles, exposed, opt) {
    const cc = countsOfTiles(concealedTiles);
    const forms = allWinningForms(cc, exposed || []);
    if (!forms.length) return null;
    let best = null;
    for (const form of forms) {
      const ctx = buildContext(concealedTiles, exposed || [], form, opt || {});
      const r = evalFan(ctx);
      if (!best || r.total > best.total) best = Object.assign({ form, ctx }, r);
    }
    return best;
  }

  /* ---------- shanten (向听) ----------------------------------------- */
  /**
   * Block decomposition DFS: melds (面子) m, partial sets (搭子) p, pair (雀头) hp.
   * At most 5 blocks (4 melds + 1 pair). Shanten = 8 - 2m - p - hp,
   * +1 when 5 blocks are used but none of them is a pair (no 将).
   */
  function dfsBlocks(cnt, i, m, p, hp, best) {
    let j = i;
    while (j < MJ_KINDS && cnt[j] === 0) j++;
    const blocks = m + p + hp;
    if (j >= MJ_KINDS || blocks >= 5) {
      let sh = 8 - 2 * m - p - hp;
      if (blocks >= 5 && !hp) sh += 1;
      if (sh < best.s) best.s = sh;
      return;
    }
    if (m < 4) {
      if (cnt[j] >= 3) { cnt[j] -= 3; dfsBlocks(cnt, j, m + 1, p, hp, best); cnt[j] += 3; }
      if (j < 27 && j % 9 <= 6 && cnt[j + 1] > 0 && cnt[j + 2] > 0) {
        cnt[j]--; cnt[j + 1]--; cnt[j + 2]--; dfsBlocks(cnt, j, m + 1, p, hp, best);
        cnt[j]++; cnt[j + 1]++; cnt[j + 2]++;
      }
    }
    if (!hp && cnt[j] >= 2) { cnt[j] -= 2; dfsBlocks(cnt, j, m, p, 1, best); cnt[j] += 2; }
    if (cnt[j] >= 2) { cnt[j] -= 2; dfsBlocks(cnt, j, m, p + 1, hp, best); cnt[j] += 2; }
    if (j < 27 && j % 9 <= 7 && cnt[j + 1] > 0) { cnt[j]--; cnt[j + 1]--; dfsBlocks(cnt, j, m, p + 1, hp, best); cnt[j]++; cnt[j + 1]++; }
    if (j < 27 && j % 9 <= 6 && cnt[j + 2] > 0) { cnt[j]--; cnt[j + 2]--; dfsBlocks(cnt, j, m, p + 1, hp, best); cnt[j]++; cnt[j + 2]++; }
    const save = cnt[j]; cnt[j] = 0; dfsBlocks(cnt, j + 1, m, p, hp, best); cnt[j] = save;
  }

  function shantenStandard(cnt, exposedCount) {
    const best = { s: 8 };
    dfsBlocks(cnt, 0, exposedCount || 0, 0, 0, best);
    return best.s;
  }
  function shantenSevenPairs(cnt) {
    let pairs = 0, kinds = 0;
    for (let k = 0; k < MJ_KINDS; k++) { if (cnt[k] >= 2) pairs++; if (cnt[k] > 0) kinds++; }
    let sh = 6 - pairs;
    if (kinds < 7) sh += 7 - kinds;
    return sh;
  }
  function shantenThirteen(cnt) {
    let kinds = 0, hasPair = false;
    for (const k of YAOJIU) { if (cnt[k] > 0) kinds++; if (cnt[k] >= 2) hasPair = true; }
    return 13 - kinds - (hasPair ? 1 : 0);
  }
  function shanten(concealedTiles, exposed) {
    const cnt = countsOfTiles(concealedTiles);
    const e = (exposed || []).length;
    let s = shantenStandard(cnt, e);
    if (e === 0) { s = Math.min(s, shantenSevenPairs(cnt), shantenThirteen(cnt)); }
    return s;
  }

  /** Ukeire: how many of each tile would improve shanten. */
  function usefulTiles(concealedTiles, exposed) {
    const base = shanten(concealedTiles, exposed);
    const cnt = countsOfTiles(concealedTiles);
    const out = [];
    for (let k = 0; k < MJ_KINDS; k++) {
      if (cnt[k] >= 4) continue;
      cnt[k]++;
      const s = shanten(expand(cnt).map(x => ({ k: x })), exposed);
      cnt[k]--;
      if (s < base) out.push(k);
    }
    return out;
  }

  /* ---------- waits / tenpai ---------------------------------------- */
  function winningTiles(concealedTiles, exposed) {
    const cnt = countsOfTiles(concealedTiles);
    const out = [];
    for (let k = 0; k < MJ_KINDS; k++) {
      if (cnt[k] >= 4) continue;
      cnt[k]++;
      const ok = allWinningForms(cnt, exposed || []).length > 0;
      cnt[k]--;
      if (ok) out.push(k);
    }
    return out;
  }

  /* ---------- simple AI --------------------------------------------- */
  /** Choose a discard: keep the hand closest to winning, prefer safe-ish mid tiles first. */
  function mjAiDiscard(hand, exposed, opt) {
    opt = opt || {};
    if (opt.forceTile != null) return opt.forceTile;
    const cnt = countsOfTiles(hand);
    let best = null;
    const seen = new Set();
    for (const t of hand) {
      if (seen.has(t.k)) continue;
      seen.add(t.k);
      const rest = hand.filter(x => x.id !== t.id);
      const s = shanten(rest, exposed);
      // keep mid tiles (more chow potential), drop honours/terminals first
      let flex = 0;
      if (!isHonor(t.k)) {
        const r = rankOf(t.k);
        flex = (r >= 3 && r <= 7) ? 3 : (r === 2 || r === 8) ? 2 : 1;
        if (cnt[t.k] >= 3) flex += 2;               // keep triplets
        if (cnt[t.k] === 2) flex += 1;              // keep pairs
        for (const d of [-2, -1, 1, 2]) {
          const n = t.k + d;
          if (n >= 0 && n < MJ_KINDS && suitOf(n) === suitOf(t.k) && cnt[n] > 0) flex += 1;
        }
      } else flex = 1;
      let safety = 0;
      if (opt.discards) for (const d of opt.discards) if (d === t.k) safety += 4; // 现物
      const score = -s * 1000 + flex * 3 + safety;
      if (!best || score > best.score) best = { score, tile: t, shanten: s };
    }
    return best ? best.tile : hand[hand.length - 1];
  }

  /** Should the AI call 吃/碰/杠?  Returns 'chow'|'pung'|'kong'|null */
  function mjAiCall(hand, exposed, tile, kind) {
    const cnt = countsOfTiles(hand);
    if (kind === 'pung' && cnt[tile.k] >= 2) {
      const before = shanten(hand, exposed);
      const after = shanten(hand.filter(t => t.k !== tile.k).slice(0, hand.length - 2), exposed.concat([{ t: 'pung', k: tile.k }]));
      return after <= before ? 'pung' : null;
    }
    if (kind === 'kong' && cnt[tile.k] >= 3) return 'kong';
    if (kind === 'chow') {
      const opts = chowOptions(hand, tile);
      if (!opts.length) return null;
      const before = shanten(hand, exposed);
      let bestGain = null;
      for (const o of opts) {
        let rest = hand.slice();
        for (const want of o.tiles) {
          const idx = rest.findIndex(t => t.k === want);
          if (idx < 0) { rest = null; break; }
          rest.splice(idx, 1);
        }
        if (!rest) continue;
        const after = shanten(rest, exposed.concat([o.meld]));
        const gain = before - after;
        if (bestGain === null || gain > bestGain) bestGain = gain;
      }
      return bestGain !== null && bestGain >= 0 ? 'chow' : null;
    }
    return null;
  }

  /* ---------- exposed-meld helpers ---------------------------------- */
  function chowOptions(hand, tile) {
    const cnt = countsOfTiles(hand);
    const opts = [];
    if (tile.k >= 27) return opts;
    const r = rankOf(tile.k), s = suitOf(tile.k), base = s * 9;
    for (let start = r - 2; start <= r; start++) {
      if (start < 1 || start + 2 > 9) continue;
      const a = base + start - 1, b = base + start, c = base + start + 1;
      const need = [a, b, c];
      const want = need.filter(x => x !== tile.k);
      if (want.every(x => cnt[x] > 0)) opts.push({ meld: { t: 'chow', k: a }, tiles: want });
    }
    return opts;
  }

  return {
    MJ_KINDS, MJ_LABELS, MJ_SUIT_NAMES, MJ_HONOR_NAMES, YAOJIU, FAN_NAMES, REVERSIBLE,
    suitOf, rankOf, isHonor, isWind, isDragon, isTerminal, isYaochu, isSimple, tileLabel,
    makeDeck, shuffle, counts, countsOfTiles, expand, sortTiles,
    winningSets, isSevenPairs, isThirteenOrphans, isKnitted, allWinningForms, isWinningHand,
    scoreHand, buildContext, evalFan,
    shanten, shantenStandard, shantenSevenPairs, shantenThirteen, usefulTiles, winningTiles,
    mjAiDiscard, mjAiCall, chowOptions,
  };
});
