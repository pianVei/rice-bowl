'use strict';
/* guandan.js — 掼蛋 (Guandan) engine: deck, combo detection, comparison,
 * move generation and a heuristic AI.
 *
 * Rank mapping reuses cards.js: 3..13 = 3..K, 14 = A, 15 = 2,
 * 16 = small joker, 17 = big joker.
 *
 * Guandan specifics implemented here:
 *  - Two decks (108 cards), 27 cards each, no kitty.
 *  - Two teams (seats 0,2 vs 1,3); each team has its own level (级牌),
 *    progressing 2 → 3 → … → K → A.
 *  - 逢人配 (wild): the hearts card of a seat's own team level rank may
 *    substitute any rank 3..2 (never jokers) inside a combo; a lone wild
 *    only counts as its natural rank. Max 2 wilds per player (two decks).
 *  - Combos: single / pair / trio / trio+pair(三带二) / straight(≥5, ≤A)
 *    / 连对(≥3) / 钢板(≥2 consecutive trios) / bomb(4+ of a rank, up to 8)
 *    / 同花顺(5-card flush straight) / 天王炸(大王+小王).
 *  - Bomb order: 4炸 < 5炸 < 同花顺 < 6炸 < 7炸 < 8炸 < 天王炸.
 *    Jokers never form pairs/trios/bombs on their own.
 *
 * All functions are pure and Node-safe (used by tests and bot.mjs). */

/* Note: SUITS / RANK_LABELS already exist as globals from cards.js in the
 * browser, so this file keeps its own copies under GD_* names (identical
 * content) to avoid a const redeclaration SyntaxError. */
const GD_SUITS = ['♠', '♥', '♦', '♣'];
const GD_RANK_LABELS = { 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };

/* Level sequence as rank values: 2(=15) → 3 → … → K → A(=14). */
const GD_LEVEL_SEQ = [15, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
function gdNextLevel(l) { return l === 15 ? 3 : l >= 14 ? null : l + 1; }

function gdMakeDeck() {
  const d = [];
  let id = 0;
  for (let copy = 0; copy < 2; copy++)
    for (let r = 3; r <= 15; r++) for (let s = 0; s < 4; s++) d.push({ id: id++, r, s });
  d.push({ id: id++, r: 16, s: -1 });
  d.push({ id: id++, r: 17, s: -1 });
  d.push({ id: id++, r: 16, s: -1 });
  d.push({ id: id++, r: 17, s: -1 });
  return d;
}

function gdShuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const gdCounts = ranks => {
  const m = {};
  for (const r of ranks) m[r] = (m[r] || 0) + 1;
  return m;
};
const gdKeysSorted = m => Object.keys(m).map(Number).sort((a, b) => a - b);
const gdConsec = a => { for (let i = 1; i < a.length; i++) if (a[i] !== a[i - 1] + 1) return false; return true; };

/* Wild helpers: a seat's wild cards are the hearts of their own team level. */
function gdWildsOf(cards, level) { return cards.filter(c => c.r === level && c.s === 1); }

function C(type, rank, len, n) { return { type, rank, len, n }; }
function gdBomb(rank, n) { return Object.assign(C('bomb', rank, 1, n), { power: n * 1000 + rank }); }
function gdFlush(top) { return Object.assign(C('flush_straight', top, 1, 5), { power: 5 * 1000 + 500 + top }); }
function gdHeaven() { return Object.assign(C('heaven', 17, 1, 2), { power: Infinity }); }

function gdComboPriority(c) {
  if (c.type === 'heaven') return 1e9;
  if (c.type === 'bomb' || c.type === 'flush_straight') return 1e6 + c.power;
  return c.rank + c.n * 0.01;
}

function gdBeats(c, p) {
  if (!c) return false;
  if (!p) return true;
  if (c.type === 'heaven') return true;
  if (p.type === 'heaven') return false;
  const cb = c.type === 'bomb' || c.type === 'flush_straight';
  const pb = p.type === 'bomb' || p.type === 'flush_straight';
  if (cb && pb) return (c.power || 0) > (p.power || 0);
  if (cb) return true;
  if (pb) return false;
  return c.type === p.type && c.n === p.n && c.len === p.len && c.rank > p.rank;
}

/* Plain detection (no wilds involved). `cards` = [{r,s}]. */
function gdDetectPlain(cards) {
  const n = cards.length;
  if (!n) return null;
  const rs = cards.map(c => c.r);
  const m = gdCounts(rs), ks = gdKeysSorted(m), kn = ks.length;
  if (n === 2 && m[16] === 1 && m[17] === 1) return gdHeaven();
  if (kn === 1) {
    const r = ks[0];
    if (n === 1) return C('single', r, 1, 1);
    if (r > 15) return null; // jokers never form pairs/trios/bombs
    if (n === 2) return C('pair', r, 1, 2);
    if (n === 3) return C('trio', r, 1, 3);
    if (n >= 4) return gdBomb(r, n);
    return null;
  }
  if (n === 5) {
    const t = ks.find(k => m[k] === 3 && k <= 15);
    const p = ks.find(k => m[k] === 2 && k <= 15);
    if (t !== undefined && p !== undefined && kn === 2) return C('trio_pair', t, 1, 5);
    const suits = new Set(cards.map(c => c.s));
    if (suits.size === 1 && ks[kn - 1] <= 14 && gdConsec(ks)) return gdFlush(ks[kn - 1]);
  }
  if (n >= 5 && kn === n && ks[kn - 1] <= 14 && gdConsec(ks)) return C('straight', ks[kn - 1], 1, n);
  if (n >= 6 && n % 2 === 0 && kn === n / 2 && ks.every(k => m[k] === 2) && ks[kn - 1] <= 14 && gdConsec(ks))
    return C('pair_seq', ks[kn - 1], kn, n);
  if (n >= 6 && n % 3 === 0 && kn === n / 3 && ks.every(k => m[k] === 3) && ks[kn - 1] <= 14 && gdConsec(ks))
    return C('trio_seq', ks[kn - 1], kn, n);
  return null;
}

/* Read `cards` as the same shape as a previous combo `req`. */
function gdMatchType(cards, req) {
  const n = cards.length;
  if (!req || n !== req.n) return null;
  const rs = cards.map(c => c.r);
  const m = gdCounts(rs), ks = gdKeysSorted(m), kn = ks.length;
  const t = req.type;
  const mk = (rank, len) => (t === 'bomb' ? gdBomb(rank, n) : C(t, rank, len === undefined ? req.len : len, n));
  switch (t) {
    case 'single': return n === 1 ? mk(ks[0], 1) : null;
    case 'pair': return kn === 1 && ks[0] <= 15 && m[ks[0]] === 2 ? mk(ks[0]) : null;
    case 'trio': return kn === 1 && ks[0] <= 15 && m[ks[0]] === 3 ? mk(ks[0]) : null;
    case 'trio_pair': {
      if (n !== 5 || kn !== 2) return null;
      const tr = ks.find(k => m[k] === 3 && k <= 15);
      const pr = ks.find(k => m[k] === 2 && k <= 15);
      return tr !== undefined && pr !== undefined ? mk(tr) : null;
    }
    case 'straight': return kn === n && ks[kn - 1] <= 14 && gdConsec(ks) ? mk(ks[kn - 1]) : null;
    case 'pair_seq':
      return kn === req.len && ks.every(k => m[k] === 2) && ks[kn - 1] <= 14 && gdConsec(ks) ? mk(ks[kn - 1]) : null;
    case 'trio_seq':
      return kn === req.len && ks.every(k => m[k] === 3) && ks[kn - 1] <= 14 && gdConsec(ks) ? mk(ks[kn - 1]) : null;
    case 'bomb': return kn === 1 && ks[0] <= 15 && m[ks[0]] === n && n >= 4 ? gdBomb(ks[0], n) : null;
    case 'flush_straight': {
      if (n !== 5) return null;
      const suits = new Set(cards.map(c => c.s));
      return suits.size === 1 && ks[kn - 1] <= 14 && gdConsec(ks) ? gdFlush(ks[kn - 1]) : null;
    }
  }
  return null;
}

/* Multisets of k ranks in 3..15 (wild assignments). k <= 2 in practice. */
function gdWildAssignments(k) {
  const out = [];
  (function rec(start, acc) {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let r = start; r <= 15; r++) { acc.push(r); rec(r, acc); acc.pop(); }
  })(3, []);
  return out;
}

/* Full analysis of a candidate play. cards = [{r,s}], level = the acting
 * seat's own team level rank (defines their 逢人配). Returns the strongest
 * valid combo, or null (invalid / does not beat prev). */
function gdAnalyze(cards, prev, level) {
  const n = cards.length;
  if (!n) return null;
  const wilds = gdWildsOf(cards, level);
  const w = wilds.length;
  if (!w) {
    const c = prev ? (gdMatchType(cards, prev) || gdDetectPlain(cards)) : gdDetectPlain(cards);
    return c && gdBeats(c, prev) ? c : null;
  }
  const nats = cards.filter(c => !gdWildsOf([c], level).length);
  let best = null;
  for (const asg of gdWildAssignments(w)) {
    const sub = nats.map(c => ({ r: c.r, s: c.s })).concat(asg.map(r => ({ r, s: 1 })));
    let c = prev ? (gdMatchType(sub, prev) || gdDetectPlain(sub)) : gdDetectPlain(sub);
    if (!c) continue;
    if (c.type === 'single' && asg.length && !asg.every(r => r === level)) continue; // lone wild = natural rank
    if (!gdBeats(c, prev)) continue;
    if (!best || gdComboPriority(c) > gdComboPriority(best)) best = c;
  }
  return best;
}

/* ---------------- move generation ---------------- */

/* Cost of tearing hand groups apart (for ranking candidates). */
function gdBreakPenalty(wantRanks, nat, level) {
  const want = gdCounts(wantRanks);
  let pen = 0;
  for (const k of Object.keys(want)) {
    const r = +k;
    if (r === level) continue; // wilds are flexible
    const h = nat[r] || 0, used = Math.min(want[r], h);
    if (used > 0 && used < h && h >= 2) pen += h;
  }
  return pen;
}

/* Rank-plan -> concrete cards: naturals first, wilds fill the shortfall. */
function gdRealize(hand, plan, level) {
  const wilds = gdWildsOf(hand, level);
  let wi = 0;
  const used = new Set(), res = [];
  const want = gdCounts(plan);
  const shortfall = [];
  for (const k of Object.keys(want)) {
    const r = +k;
    let need = want[r];
    for (const c of hand) {
      if (need <= 0) break;
      if (used.has(c.id) || c.r !== r || (c.r === level && c.s === 1 && r === level)) continue;
      res.push(c); used.add(c.id); need--;
    }
    while (need > 0) { shortfall.push(r); need--; }
  }
  for (const r of shortfall) {
    const wc = wilds[wi++];
    if (!wc) return null;
    res.push(wc); used.add(wc.id);
  }
  return res;
}

/* All legal plays. hand = [{id,r,s}], level = own team level rank,
 * prev = combo to beat or null (free lead). Returns [{ids, combo, wild}]. */
function gdLegalMoves(hand, level, prev) {
  const wilds = gdWildsOf(hand, level);
  const w = wilds.length;
  const nat = {};
  for (const c of hand) if (!(c.r === level && c.s === 1)) nat[c.r] = (nat[c.r] || 0) + 1;
  const N = r => nat[r] || 0;
  const avail = r => (r === level ? N(r) + w : N(r)); // naturals + own wilds
  const plans = []; // {plan:[ranks], wildUsed, special?:'flush'|'heaven', cards?:[]}

  const addPlan = (plan, wildUsed, extra) => plans.push(Object.assign({ plan, wildUsed: wildUsed || 0 }, extra || {}));

  if (!prev) {
    /* singles: naturals + wild as itself */
    for (let r = 3; r <= 17; r++) if (N(r) >= 1) addPlan([r]);
    /* pairs & trios (no joker pairs) */
    for (let r = 3; r <= 15; r++) {
      if (avail(r) >= 2) addPlan([r, r], Math.max(0, 2 - N(r)));
      if (avail(r) >= 3) {
        addPlan([r, r, r], Math.max(0, 3 - N(r)));
        for (let p = 3; p <= 15; p++) { // trio + pair wing
          if (p === r) continue;
          if (avail(p) >= 2) addPlan([r, r, r, p, p], Math.max(0, 3 - N(r)) + Math.max(0, 2 - N(p)));
        }
      }
    }
    /* straights 5..12 cards, top <= A */
    for (let L = 5; L <= 12; L++)
      for (let s = 3; s + L - 1 <= 14; s++) {
        let cost = 0;
        for (let r = s; r < s + L; r++) cost += Math.max(0, 1 - N(r));
        if (cost <= w) addPlan(Array.from({ length: L }, (_, i) => s + i), cost);
      }
    /* 连对 ≥3 pairs */
    for (let L = 3; L <= 11; L++)
      for (let s = 3; s + L - 1 <= 14; s++) {
        let cost = 0;
        for (let r = s; r < s + L; r++) cost += Math.max(0, 2 - N(r));
        if (cost <= w) addPlan(Array.from({ length: L }, (_, i) => s + i).flatMap(r => [r, r]), cost);
      }
    /* 钢板 ≥2 consecutive trios */
    for (let L = 2; L <= 4; L++)
      for (let s = 3; s + L - 1 <= 14; s++) {
        let cost = 0;
        for (let r = s; r < s + L; r++) cost += Math.max(0, 3 - N(r));
        if (cost <= w) addPlan(Array.from({ length: L }, (_, i) => s + i).flatMap(r => [r, r, r]), cost);
      }
    /* bombs: every size from 4 up to what the hand holds */
    for (let r = 3; r <= 15; r++)
      for (let c = 4; c <= avail(r); c++) addPlan(Array(c).fill(r), Math.max(0, c - N(r)));
    /* heaven */
    if (N(16) >= 1 && N(17) >= 1) addPlan([16, 17], 0, { heaven: true });
  } else {
    const t = prev.type;
    if (t === 'single') {
      for (let r = prev.rank + 1; r <= 17; r++) if (avail(r) >= 1) addPlan([r], Math.max(0, 1 - N(r)));
    } else if (t === 'pair' || t === 'trio') {
      const c = t === 'pair' ? 2 : 3;
      for (let r = prev.rank + 1; r <= 15; r++) {
        if (avail(r) >= c) addPlan(Array(c).fill(r), Math.max(0, c - N(r)));
      }
    } else if (t === 'trio_pair') {
      for (let r = prev.rank + 1; r <= 15; r++) {
        if (avail(r) < 3) continue;
        for (let p = 3; p <= 15; p++) {
          if (p === r || avail(p) < 2) continue;
          addPlan([r, r, r, p, p], Math.max(0, 3 - N(r)) + Math.max(0, 2 - N(p)));
        }
      }
    } else if (t === 'straight') {
      const L = prev.n;
      for (let end = prev.rank + 1; end <= 14; end++) {
        const s = end - L + 1;
        if (s < 3) continue;
        let cost = 0;
        for (let r = s; r <= end; r++) cost += Math.max(0, 1 - N(r));
        if (cost <= w) addPlan(Array.from({ length: L }, (_, i) => s + i), cost);
      }
    } else if (t === 'pair_seq' || t === 'trio_seq') {
      const per = t === 'pair_seq' ? 2 : 3, L = prev.len;
      for (let end = prev.rank + 1; end <= 14; end++) {
        const s = end - L + 1;
        if (s < 3) continue;
        let cost = 0;
        const plan = [];
        for (let r = s; r <= end; r++) { cost += Math.max(0, per - N(r)); for (let i = 0; i < per; i++) plan.push(r); }
        if (cost <= w) addPlan(plan, cost);
      }
    } else if (t === 'bomb' || t === 'flush_straight') {
      for (let r = 3; r <= 15; r++)
        for (let c = Math.max(4, prev.n + (t === 'bomb' ? 1 : 0)); c <= avail(r); c++)
          addPlan(Array(c).fill(r), Math.max(0, c - N(r)));
      if (N(16) >= 1 && N(17) >= 1) addPlan([16, 17], 0, { heaven: true });
    } else if (t === 'heaven') {
      /* nothing beats a heaven bomb */
    }
    /* any bomb beats a non-bomb prev */
    if (t !== 'bomb' && t !== 'flush_straight' && t !== 'heaven') {
      for (let r = 3; r <= 15; r++)
        for (let c = 4; c <= avail(r); c++) addPlan(Array(c).fill(r), Math.max(0, c - N(r)));
      if (N(16) >= 1 && N(17) >= 1) addPlan([16, 17], 0, { heaven: true });
    }
  }

  /* realize plans into actual cards and re-validate (never trust the generator) */
  const seen = new Set(), out = [];
  for (const p of plans) {
    const cards = gdRealize(hand, p.plan, level);
    if (!cards) continue;
    const combo = gdAnalyze(cards, prev || null, level);
    if (!combo || !gdBeats(combo, prev || null)) continue;
    const key = cards.map(c => c.id).sort((a, b) => a - b).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ids: cards.map(c => c.id), cards, combo, wild: p.wildUsed || 0 });
  }
  return out;
}

/* Sensible plays for the hint button / agent panel, best first. */
function gdHintMoves(hand, level, prev) {
  const nat = {};
  for (const c of hand) if (!(c.r === level && c.s === 1)) nat[c.r] = (nat[c.r] || 0) + 1;
  const isBomb = m => m.combo.type === 'bomb' || m.combo.type === 'flush_straight' || m.combo.type === 'heaven';
  const moves = gdLegalMoves(hand, level, prev);
  moves.sort((a, b) =>
    (isBomb(a) - isBomb(b)) || (a.wild - b.wild) ||
    (gdBreakPenalty(a.cards.map(c => c.r), nat, level) - gdBreakPenalty(b.cards.map(c => c.r), nat, level)) ||
    (a.combo.rank - b.combo.rank) || (a.ids.length - b.ids.length));
  return moves;
}

/* ---------------- heuristic AI ---------------- */

/* ctx: {prev, prevSeat, mySeat, teams, finished, cardCounts} */
function gdAiPlay(hand, level, prev, ctx) {
  const { prevSeat, mySeat, teams, finished, cardCounts } = ctx;
  const moves = gdLegalMoves(hand, level, prev);
  if (!moves.length) return null;
  const finish = moves.find(m => m.ids.length === hand.length);
  if (finish) return finish;
  const nat = {};
  for (const c of hand) if (!(c.r === level && c.s === 1)) nat[c.r] = (nat[c.r] || 0) + 1;
  const isBomb = m => m.combo.type === 'bomb' || m.combo.type === 'flush_straight' || m.combo.type === 'heaven';
  const team = s => teams[s];
  const myTeam = team(mySeat);

  if (!prev) {
    let best = null, bestScore = Infinity;
    for (const m of moves) {
      const ranks = m.cards.map(c => c.r);
      let s = m.combo.rank * 3 - m.ids.length * 4 + gdBreakPenalty(ranks, nat, level) * 30;
      if (isBomb(m)) s += hand.length <= 8 ? -60 : 1000;
      if (m.wild > 0 && hand.length > 10) s += 50;
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  const partnerLed = prevSeat !== null && prevSeat !== undefined && prevSeat !== mySeat && team(prevSeat) === myTeam;
  const normal = moves.filter(m => !isBomb(m));

  if (partnerLed && !finished[prevSeat]) {
    // Support the teammate only with a cheap, non-destructive beat.
    const mild = normal
      .filter(m => m.wild === 0 && m.combo.rank <= 11 && gdBreakPenalty(m.cards.map(c => c.r), nat, level) === 0)
      .sort((a, b) => a.combo.rank - b.combo.rank);
    return mild[0] || null;
  }

  const enemies = [];
  for (let s = 0; s < 4; s++) if (team(s) !== myTeam && !finished[s]) enemies.push(s);
  const enemyMin = enemies.length ? Math.min(...enemies.map(s => cardCounts[s])) : 99;

  if (normal.length) {
    normal.sort((a, b) =>
      (a.wild - b.wild) ||
      (gdBreakPenalty(a.cards.map(c => c.r), nat, level) - gdBreakPenalty(b.cards.map(c => c.r), nat, level)) ||
      (a.combo.rank - b.combo.rank));
    const best = normal[0];
    if (best.wild > 0 && enemyMin > 4 && hand.length > 10 && prev.rank < 12) return null;
    return best;
  }
  if (enemyMin <= 5 || hand.length <= 8) {
    const bombs = moves.filter(isBomb)
      .sort((a, b) => ((a.combo.power || 0) - (b.combo.power || 0)) || (a.ids.length - b.ids.length));
    return bombs[0] || null;
  }
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SUITS: GD_SUITS, RANK_LABELS: GD_RANK_LABELS, GD_LEVEL_SEQ, gdNextLevel, gdMakeDeck, gdShuffle,
    gdCounts, gdKeysSorted, gdConsec, gdWildsOf, gdDetectPlain, gdMatchType,
    gdWildAssignments, gdAnalyze, gdBeats, gdComboPriority, gdBreakPenalty,
    gdRealize, gdLegalMoves, gdHintMoves, gdAiPlay,
  };
}
