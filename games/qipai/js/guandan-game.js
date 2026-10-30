'use strict';
/* guandan-game.js — 掼蛋 state machine (host-authoritative, API-compatible
 * with game.js Game: startRound / actPlay / actPass / buildView / pump).
 *
 * Rules implemented (mainstream 江苏掼蛋; documented simplifications marked ●):
 *  - 4 players, two decks (108 cards, 27 each, no kitty), teams {0,2} vs {1,3}.
 *  - Each team keeps a level (2..A); 级牌 follows the level and the hearts of
 *    that rank are that team's 逢人配 (see guandan.js).
 *  - Round ends when the 头游's team places a second finisher (二游 → 双下,
 *    or 三游 → 单下).
 *  - Levels: 双下 +3, 单下 +2 (capped at A); ● 打A必须双下才能过A，单下留级。
 *  - 天王炸: round ends immediately, playing team wins as 双下.
 *  - 接风: right after a player finishes, if the next seat in rotation is
 *    their teammate, the teammate leads freely.
 *  - ● Tribute (进贡/还贡) is fully automatic: 单下 末游→头游; 双下
 *    末游→头游、三游→二游. 贡牌 = biggest single excluding one's own
 *    逢人配; 抗贡 = paying side jointly holds both jokers; 还贡 = the
 *    smallest card ≤10. 头游 leads the next round.
 */

if (typeof require !== 'undefined' && typeof window === 'undefined') {
  Object.assign(globalThis, require('./guandan.js'));
}

class GuandanGame {
  /* cfg: { mode:'guandan', players:[{name,isAI}×4], aiDelay } */
  constructor(cfg, hooks) {
    this.cfg = Object.assign({ mode: 'guandan', aiDelay: 900 }, cfg);
    this.hooks = hooks || {};
    this.n = 4;
    this.players = this.cfg.players.map(p => ({ name: p.name, isAI: !!p.isAI }));
    this.teams = [0, 1, 0, 1];
    this.levels = [15, 15]; // both teams start at 2 (rank value 15)
    this.roundNo = 0;
    this.seq = 0;
    this.matchOver = false;
    this.pendingTribute = null;
    this.tributeInfo = null;
    this.firstLeader = 0;
    this.tableId = 'gd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    this._t = null;
  }

  emit(evName, data) {
    this.seq++;
    if (evName && this.hooks.onEvent) this.hooks.onEvent(evName, data);
    if (this.hooks.onUpdate) this.hooks.onUpdate(this);
  }

  teamOf(s) { return this.teams[s]; }
  levelOf(s) { return this.levels[this.teamOf(s)]; }

  startRound() {
    if (this.matchOver) return;
    this.roundNo++;
    const deck = gdShuffle(gdMakeDeck());
    this.hands = [0, 1, 2, 3].map(i => deck.slice(i * 27, (i + 1) * 27));
    this.hands.forEach(h => h.sort((a, b) => b.r - a.r || a.s - b.s));
    this.state = 'playing';
    this.trick = { combo: null, seat: null };
    this.lastPlays = [null, null, null, null];
    this.finishers = [];
    this.discarded = [];
    this.passStreak = 0;
    this.heavenPlayed = null;
    this.result = null;
    if (this.pendingTribute) this.applyTribute();
    else this.tributeInfo = null;
    this.turn = this.firstLeader;
    this.emit('deal');
    this.pump();
  }

  actorSeat() { return this.state === 'playing' ? this.turn : null; }

  pump() {
    if (this._t) { clearTimeout(this._t); this._t = null; }
    const s = this.actorSeat();
    if (s == null || !this.players[s].isAI) return;
    const seq = this.seq;
    const run = () => { if (this.seq === seq) this.aiStep(s); };
    if (this.cfg.aiDelay <= 0) run();
    else this._t = setTimeout(run, this.cfg.aiDelay + Math.random() * 700);
  }

  aiStep(seat) {
    try {
      const prev = this.trick.combo && this.trick.seat !== seat ? this.trick.combo : null;
      const mv = gdAiPlay(this.hands[seat], this.levelOf(seat), prev, {
        prevSeat: prev ? this.trick.seat : null,
        mySeat: seat,
        teams: this.teams,
        finished: this.hands.map(h => h.length === 0),
        cardCounts: this.hands.map(h => h.length),
      });
      if (mv) { this.actPlay(seat, mv.ids); return; }
      if (prev) this.actPass(seat);
      else {
        const low = this.hands[seat].slice().sort((a, b) => a.r - b.r)[0];
        this.actPlay(seat, [low.id]);
      }
    } catch (e) {
      if (this.hooks.onError) this.hooks.onError(e);
      else if (typeof console !== 'undefined') console.error(e);
      if (this.state === 'playing') {
        if (this.trick.combo && this.trick.seat !== seat) this.actPass(seat);
        else this.actPlay(seat, [this.hands[seat][this.hands[seat].length - 1].id]);
      }
    }
  }

  actPlay(seat, cardIds) {
    if (this.state !== 'playing' || seat !== this.turn) return false;
    const hand = this.hands[seat];
    const ids = new Set(cardIds);
    if (ids.size !== cardIds.length) return false;
    const cards = hand.filter(c => ids.has(c.id));
    if (cards.length !== cardIds.length) return false;
    const prev = this.trick.combo && this.trick.seat !== seat ? this.trick.combo : null;
    const combo = gdAnalyze(cards, prev, this.levelOf(seat));
    if (!combo || !gdBeats(combo, prev)) return false;
    if (!prev) this.lastPlays = [null, null, null, null];
    this.hands[seat] = hand.filter(c => !ids.has(c.id));
    this.discarded.push(...cards);
    this.lastPlays[seat] = { cards, combo };
    this.trick = { combo, seat };
    this.passStreak = 0;
    if (combo.type === 'heaven') {
      this.heavenPlayed = seat;
      this.settle(seat, seat);
      return true;
    }
    if (this.hands[seat].length === 0) { this.onFinish(seat); return true; }
    this.turn = this.nextUnfinished((seat + 1) % this.n);
    this.emit('play', { seat, combo });
    this.pump();
    return true;
  }

  actPass(seat) {
    if (this.state !== 'playing' || seat !== this.turn) return false;
    if (!this.trick.combo || this.trick.seat === seat) return false;
    this.lastPlays[seat] = { pass: true };
    this.passStreak++;
    const leaderFinished = this.hands[this.trick.seat].length === 0;
    const unfinishedCount = this.hands.filter(h => h.length > 0).length;
    // Everyone still in has passed over this trick -> free lead.
    const others = unfinishedCount - (leaderFinished ? 0 : 1);
    this.turn = this.nextUnfinished((seat + 1) % this.n);
    if (this.passStreak >= Math.max(1, others)) {
      this.trick = { combo: null, seat: this.trick.seat };
      this.passStreak = 0;
    }
    this.emit('pass', { seat });
    this.pump();
    return true;
  }

  nextUnfinished(from) {
    for (let i = 0; i < this.n; i++) {
      const s = (from + i) % this.n;
      if (this.hands[s].length > 0) return s;
    }
    return from;
  }

  onFinish(seat) {
    this.finishers.push(seat);
    this.emit('finish', { seat, order: this.finishers.length });
    const first = this.finishers[0];
    const endsNow =
      this.finishers.length >= 3 ||
      (this.finishers.length === 2 && this.teamOf(this.finishers[1]) === this.teamOf(first));
    if (endsNow) { this.settle(seat, first); return; }
    const next = this.nextUnfinished((seat + 1) % this.n);
    if (this.trick.seat === seat && this.teamOf(next) === this.teamOf(seat)) {
      // 接风: the teammate right after takes the lead immediately.
      this.trick = { combo: null, seat: null };
      this.passStreak = 0;
      this.emit('wind', { seat: next });
    }
    this.turn = next;
    this.pump();
  }

  settle(lastSeat, firstSeat) {
    this.state = 'settle';
    const first = firstSeat;
    const second = this.finishers[1] !== undefined ? this.finishers[1] : null;
    const third = this.finishers[2] !== undefined ? this.finishers[2] : null;
    const winnerTeam = this.teamOf(first);
    const doubleDown = this.heavenPlayed != null ||
      (second != null && this.teamOf(second) === winnerTeam);
    const atA = this.levels[winnerTeam] === 14;
    let matchOver = false;
    const newLevels = this.levels.slice();
    if (atA) {
      // 打A: only a 双下 win passes the A; a 单下 stays (● simplification).
      if (doubleDown) matchOver = true;
    } else {
      let lv = newLevels[winnerTeam];
      const gain = doubleDown ? 3 : 2;
      for (let i = 0; i < gain && lv !== 14; i++) lv = lv === 15 ? 3 : lv + 1;
      newLevels[winnerTeam] = lv;
    }
    this.levels = newLevels;
    const order = [first, second, third].filter(x => x !== null && x !== undefined);
    this.result = {
      winner: first, winnerTeam, doubleDown, matchOver, heaven: this.heavenPlayed,
      deltas: null,
      gd: {
        levels: newLevels.slice(), labels: newLevels.map(l => RANK_LABELS[l]),
        teams: this.teams.slice(), finishers: order,
        gain: atA ? 0 : (doubleDown ? 3 : 2),
      },
    };
    if (matchOver) {
      this.matchOver = true;
      this.pendingTribute = null;
    } else {
      const last = [0, 1, 2, 3].find(s => !order.includes(s));
      const payers = doubleDown
        ? [[last, first], [third, second]]
        : [[last, first]];
      this.pendingTribute = { payers, leader: first, doubleDown };
      this.firstLeader = first;
    }
    this.emit('settle');
  }

  /* Tribute applied right after the new deal (before the first lead). */
  applyTribute() {
    const plan = this.pendingTribute;
    this.pendingTribute = null;
    const biggest = (hand, level) => {
      let best = null;
      for (const c of hand)
        if (!(c.r === level && c.s === 1) && (!best || c.r > best.r)) best = c;
      return best;
    };
    // 抗贡: the paying side(s) jointly hold both jokers.
    const has = r => plan.payers.some(([s]) => s != null && this.hands[s].some(c => c.r === r));
    if (has(16) && has(17)) {
      this.tributeInfo = { resisted: true, moves: [] };
      this.emit('tribute', { resisted: true });
      return;
    }
    const moves = [];
    for (const [payer, receiver] of plan.payers) {
      if (payer == null || receiver == null) continue;
      const card = biggest(this.hands[payer], this.levelOf(payer));
      if (!card) continue;
      const ph = this.hands[payer];
      ph.splice(ph.indexOf(card), 1);
      this.hands[receiver].push(card);
      // 还贡: the receiver's smallest card ≤10 goes back (auto choice ●).
      let back = null;
      for (const c of this.hands[receiver]) if (c.r <= 10 && (!back || c.r < back.r)) back = c;
      if (!back) for (const c of this.hands[receiver]) if (!back || c.r < back.r) back = c;
      if (back) {
        const rh = this.hands[receiver];
        rh.splice(rh.indexOf(back), 1);
        this.hands[payer].push(back);
      }
      moves.push({ payer, receiver, card, back });
    }
    this.hands.forEach(h => h.sort((a, b) => b.r - a.r || a.s - b.s));
    this.tributeInfo = { resisted: false, moves };
    this.emit('tribute', { resisted: false, moves });
  }

  nextRound() {
    if (this.matchOver) return;
    if (this.state === 'settle' || this.state === 'idle') this.startRound();
  }

  stop() { if (this._t) { clearTimeout(this._t); this._t = null; } }

  buildView(seat) {
    const settle = this.state === 'settle';
    return {
      state: this.state,
      revision: this.tableId + ':' + this.seq,
      mode: 'guandan',
      flags: { base: 1 },
      n: this.n,
      mySeat: seat,
      roundNo: this.roundNo,
      laizi: null,
      currentBid: 0,
      landlord: null,
      actor: this.actorSeat(),
      trick: { combo: this.trick.combo, seat: this.trick.seat },
      bottom: null,
      liveMult: 1,
      players: this.players.map((p, i) => ({
        name: p.name,
        isAI: p.isAI,
        cardCount: this.hands ? this.hands[i].length : 0,
        landlord: false,
        ally: this.teamOf(i) === this.teamOf(seat),
        bid: null,
        dbl: null,
        score: 0,
        wins: 0,
        lastPlay: this.lastPlays ? this.lastPlays[i] : null,
        hand: settle ? this.hands[i] : undefined,
      })),
      myHand: this.hands ? this.hands[seat] : [],
      result: this.result,
      gd: {
        levels: this.levels.slice(),
        labels: this.levels.map(l => RANK_LABELS[l]),
        teams: this.teams.slice(),
        myTeam: this.teamOf(seat),
        myLevelRank: this.levelOf(seat),
        finished: this.hands ? this.hands.map(h => h.length === 0) : [false, false, false, false],
        tribute: this.tributeInfo || null,
      },
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GuandanGame };
}
