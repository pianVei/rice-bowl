'use strict';
/* =========================================================================
 * mahjong-game.js — 国标麻将 state machine (host authoritative).
 * Phases: draw -> discard -> claim -> (draw | settle)
 * Works headless (Node) for the AI arena and in the browser for the UI.
 * ========================================================================= */
(function (root, factory) {
  const mj = (typeof module !== 'undefined' && module.exports)
    ? require('./mahjong.js')
    : (root.MJ || root);
  const api = factory(mj);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (mj) {

  const SEAT_WINDS = [27, 28, 29, 30]; // 东 南 西 北
  const MIN_FAN = 8;                   // 国标起和番

  class MahjongGame {
    constructor(cfg, hooks) {
      this.cfg = Object.assign({
        mode: 'mahjong', players: [], totalRounds: 8, seed: null, aiDelay: 0,
        startScore: 0, minFan: MIN_FAN,
      }, cfg || {});
      this.hooks = hooks || {};
      this.players = (this.cfg.players || []).map(p => Object.assign({ name: 'P', isAI: true }, p));
      while (this.players.length < 4) this.players.push({ name: 'AI' + this.players.length, isAI: true });
      this.scores = new Array(4).fill(this.cfg.startScore);
      this.roundNo = 0;
      this.dealer = 0;
      this.dealerStreak = 0;
      this.matchOver = false;
      this.phase = 'idle';
      this.seq = 0;
      this.log = [];
      this.result = null;
      // rng
      let s = this.cfg.seed;
      this._rng = (typeof s === 'number' && s !== null)
        ? (() => { let x = s >>> 0 || 1; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296; })()
        : Math.random;
    }

    /* ---------- round lifecycle ---------- */
    startRound() {
      this.roundNo++;
      if (this.roundNo > this.cfg.totalRounds) { this.finishMatch(); return; }
      const deck = mj.shuffle(mj.makeDeck(), this._rng);
      // 136 = 52（四家各 13 张）+ 14（王牌）+ 70（可摸牌墙）
      const DEAL = 52, DEAD = 14;
      const WALL = deck.length - DEAL - DEAD;          // 70
      const handStart = WALL + DEAD;                   // 84
      this.wall = deck.slice(0, WALL);
      this.deadWall = deck.slice(WALL, handStart);
      this.hands = []; this.exposed = []; this.discards = []; this.kongCount = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        this.hands.push(mj.sortTiles(deck.slice(handStart + i * 13, handStart + i * 13 + 13)));
        this.exposed.push([]); this.discards.push([]);
      }
      this.roundWind = 27 + Math.min(3, ((this.roundNo - 1) / 4) | 0);
      this.turn = this.dealer;
      this.drawnTile = null;
      this.pending = null;
      this.claims = {}; this.claimOpts = {}; this.awaiting = [];
      this.result = null;
      this.lastDiscard = null;
      this.robKongSeat = -1;
      this.phase = 'draw';
      this.seq++;
      this.emit();
      this.doDraw();
    }

    finishMatch() {
      this.matchOver = true;
      this.phase = 'over';
      this.seq++;
      this.emit();
    }

    nextRound() {
      if (this.matchOver) return;
      if (this.roundNo >= this.cfg.totalRounds) { this.finishMatch(); return; }
      // rotate dealer unless the dealer won (连庄)
      if (this.result && this.result.winner === this.dealer) { this.dealerStreak++; }
      else { this.dealer = (this.dealer + 1) % 4; this.dealerStreak = 0; }
      this.result = null;
      this.seq++;
      this.startRound();
    }

    emit() { if (this.hooks.onUpdate) this.hooks.onUpdate(this); }
    say(msg) { this.log.push({ round: this.roundNo, msg }); if (this.log.length > 200) this.log.shift(); }

    /* ---------- core steps ---------- */
    doDraw() {
      if (this.phase !== 'draw') return;
      if (!this.wall.length) { this.exhaustiveDraw(); return; }
      const t = this.wall.shift();
      this.hands[this.turn].push(t);
      this.drawnTile = t;
      this.phase = 'discard';
      this.lastDraw = { seat: this.turn, tile: t };
      this.seq++;
      this.emit();
      // AI acts immediately unless an action is available to a human
      if (this.players[this.turn].isAI) this.aiTurn(this.turn);
    }

    exhaustiveDraw() {
      this.result = { type: 'draw_game', round: this.roundNo, deltas: [0, 0, 0, 0], scores: this.scores.slice() };
      this.say('荒庄(流局)');
      this.phase = 'settle';
      this.seq++;
      this.emit();
    }

    /** Discard by tile id. */
    discard(seat, tileId) {
      if (this.phase !== 'discard' || seat !== this.turn) return false;
      const hand = this.hands[seat];
      const idx = hand.findIndex(t => t.id === tileId);
      if (idx < 0) return false;
      const [t] = hand.splice(idx, 1);
      this.discards[seat].push(t);
      this.drawnTile = null;
      this.lastDiscard = { seat, tile: t };
      this.startClaim(t, seat);
      return true;
    }

    startClaim(tile, from) {
      this.phase = 'claim';
      this.pending = { tile, from };
      this.claims = {}; this.claimOpts = {}; this.awaiting = [];
      for (let i = 0; i < 4; i++) {
        if (i === from) continue;
        const opts = this.claimOptions(i, tile, from);
        this.claimOpts[i] = opts;
        if (!opts.length) { this.claims[i] = 'pass'; continue; }
        if (this.players[i].isAI) this.claims[i] = this.aiClaim(i, opts);
        else { this.claims[i] = null; this.awaiting.push(i); }
      }
      this.seq++;
      this.tryResolveClaims();
    }

    /** What can `seat` do about the pending tile? */
    claimOptions(seat, tile, from) {
      const opts = [];
      const hand = this.hands[seat];
      const cnt = mj.countsOfTiles(hand);
      const canWin = this.checkWin(seat, tile, false);
      if (canWin && canWin.total >= this.cfg.minFan) opts.push({ t: 'hu', win: canWin });
      if (cnt[tile.k] >= 3) opts.push({ t: 'kong', kind: 'exposed' });
      if (cnt[tile.k] >= 2) opts.push({ t: 'pung' });
      if ((seat - from + 4) % 4 === 1) { // 下家才能吃
        for (const o of mj.chowOptions(hand, tile)) opts.push({ t: 'chow', meld: o.meld, tiles: o.tiles });
      }
      // 抢杠
      if (this.robKongSeat === from && canWin && canWin.total >= this.cfg.minFan) {
        if (!opts.some(o => o.t === 'hu')) opts.push({ t: 'hu', win: canWin, rob: true });
      }
      return opts;
    }

    /** Score a win for `seat` claiming `tile` (ron) or self-draw. */
    checkWin(seat, tile, selfDraw) {
      const hand = this.hands[seat].concat(tile ? [tile] : []);
      if (hand.length % 3 !== 2) return null;
      const opt = {
        winTile: tile ? tile.k : null, selfDraw,
        seatWind: SEAT_WINDS[(seat - this.dealer + 4) % 4], roundWind: this.roundWind,
        lastTile: this.wall.length === 0, kongDraw: !!this._kongDraw,
        robKong: this.robKongSeat >= 0 && !selfDraw,
      };
      return mj.scoreHand(hand, this.exposed[seat], opt);
    }

    aiClaim(seat, opts) {
      const hu = opts.find(o => o.t === 'hu');
      if (hu) return 'hu';
      const kong = opts.find(o => o.t === 'kong');
      const pung = opts.find(o => o.t === 'pung');
      const chow = opts.find(o => o.t === 'chow');
      const sh = mj.shanten(this.hands[seat], this.exposed[seat]);
      if (kong) {
        const before = sh;
        const after = mj.shanten(this.hands[seat].filter(t => t.k !== this.pending.tile.k).slice(0, this.hands[seat].length - 3), this.exposed[seat].concat([{ t: 'kong', k: this.pending.tile.k }]));
        if (after <= before) return 'kong';
      }
      if (pung && sh <= 3) {
        const rest = this.hands[seat].filter(t => t.k !== this.pending.tile.k).slice(0, this.hands[seat].length - 2);
        const after = mj.shanten(rest, this.exposed[seat].concat([{ t: 'pung', k: this.pending.tile.k }]));
        if (after < sh || (after === sh && sh <= 2)) return 'pung';
      }
      if (chow && sh <= 2) {
        let rest = this.hands[seat].slice();
        let ok = true;
        for (const want of chow.tiles) {
          const idx = rest.findIndex(t => t.k === want);
          if (idx < 0) { ok = false; break; }
          rest.splice(idx, 1);
        }
        if (ok) {
          const after = mj.shanten(rest, this.exposed[seat].concat([chow.meld]));
          if (after < sh || (after === sh && sh <= 1)) return 'chow';
        }
      }
      return 'pass';
    }

    /** Human (or bot) submits a claim decision. */
    submitClaim(seat, decision) {
      if (this.phase !== 'claim' || this.claims[seat] !== null) return false;
      this.claims[seat] = decision || 'pass';
      this.awaiting = this.awaiting.filter(s => s !== seat);
      this.seq++;
      this.tryResolveClaims();
      return true;
    }

    tryResolveClaims() {
      if (this.awaiting.length) { this.emit(); return; }
      const order = ['hu', 'kong', 'pung', 'chow'];
      let chosen = null;
      for (const kind of order) {
        // 一炮多响: 多家胡时按逆时针 (from 之后最近者) 优先
        const seats = [];
        for (let i = 0; i < 4; i++) if (this.claims[i] === kind) seats.push(i);
        if (!seats.length) continue;
        const from = this.pending.from;
        seats.sort((a, b) => ((a - from + 4) % 4) - ((b - from + 4) % 4));
        chosen = { kind, seat: seats[0] };
        break;
      }
      if (!chosen || chosen.kind === 'pass') { this.passToNext(); return; }
      const seat = chosen.seat, tile = this.pending.tile, from = this.pending.from;
      this.pending = null;   // 副露/胡都算处理完了，别再挂在桌子上
      if (chosen.kind === 'hu') { this.settleWin(seat, tile, from, false); return; }
      // remove the claimed tile from the discarder's river
      const river = this.discards[from];
      const ri = river.findIndex(t => t.id === tile.id);
      if (ri >= 0) river.splice(ri, 1);
      if (chosen.kind === 'pung') {
        const hand = this.hands[seat];
        const removed = [];
        for (let i = hand.length - 1; i >= 0 && removed.length < 2; i--) if (hand[i].k === tile.k) removed.push(hand.splice(i, 1)[0]);
        this.exposed[seat].push({ t: 'pung', k: tile.k, tiles: removed.concat([tile]), from });
        this.turn = seat; this.phase = 'discard'; this.drawnTile = null;
        this.say(`${this.players[seat].name} 碰 ${mj.tileLabel(tile.k)}`);
      } else if (chosen.kind === 'kong') {
        const hand = this.hands[seat];
        const removed = [];
        for (let i = hand.length - 1; i >= 0 && removed.length < 3; i--) if (hand[i].k === tile.k) removed.push(hand.splice(i, 1)[0]);
        this.exposed[seat].push({ t: 'kong', k: tile.k, tiles: removed.concat([tile]), from, open: true });
        this.kongCount[seat]++;
        this.say(`${this.players[seat].name} 杠 ${mj.tileLabel(tile.k)}`);
        this.afterKong(seat);
        return;
      } else if (chosen.kind === 'chow') {
        const opt = this.claimOpts[seat].find(o => o.t === 'chow');
        const hand = this.hands[seat];
        const removed = [];
        for (const want of opt.tiles) {
          const idx = hand.findIndex(t => t.k === want);
          removed.push(hand.splice(idx, 1)[0]);
        }
        this.exposed[seat].push({ t: 'chow', k: opt.meld.k, tiles: removed.concat([tile]), from });
        this.turn = seat; this.phase = 'discard'; this.drawnTile = null;
        this.say(`${this.players[seat].name} 吃 ${mj.tileLabel(tile.k)}`);
      }
      this.seq++;
      this.emit();
      if (this.players[this.turn].isAI) this.aiTurn(this.turn);
    }

    passToNext() {
      this.pending = null; this.robKongSeat = -1; this._kongDraw = false;
      this.turn = (this.lastDiscard.seat + 1) % 4;
      this.phase = 'draw';
      this.seq++;
      this.emit();
      this.doDraw();
    }

    /* ---------- kongs ---------- */
    /** Declare a concealed kong (4 in hand) or add-kong on an existing pung. */
    declareKong(seat, kind, k) {
      if (seat !== this.turn || this.phase !== 'discard') return false;
      const hand = this.hands[seat];
      if (kind === 'concealed') {
        const tiles = hand.filter(t => t.k === k);
        if (tiles.length < 4) return false;
        this.hands[seat] = hand.filter(t => t.k !== k);
        this.exposed[seat].push({ t: 'kong', k, tiles: tiles.slice(0, 4), open: false });
        this.kongCount[seat]++;
        this.say(`${this.players[seat].name} 暗杠 ${mj.tileLabel(k)}`);
      } else {
        const p = this.exposed[seat].find(m => m.t === 'pung' && m.k === k);
        if (!p) return false;
        const idx = hand.findIndex(t => t.k === k);
        if (idx < 0) return false;
        const t = hand.splice(idx, 1)[0];
        p.t = 'kong'; p.tiles = p.tiles.concat([t]); p.open = true;
        this.kongCount[seat]++;
        this.say(`${this.players[seat].name} 加杠 ${mj.tileLabel(k)}`);
      }
      this.afterKong(seat);
      return true;
    }

    afterKong(seat) {
      // 抢杠 check happens on the added tile; simplified: skip (claim window covers it)
      if (!this.wall.length) { this.exhaustiveDraw(); return; }
      const t = this.deadWall.length ? this.deadWall.pop() : this.wall.pop();
      this.hands[seat].push(t);
      this.drawnTile = t; this._kongDraw = true;
      this.turn = seat; this.phase = 'discard';
      this.seq++; this.emit();
      if (this.players[seat].isAI) this.aiTurn(seat);
    }

    /* ---------- AI turn ---------- */
    aiTurn(seat) {
      if (this.phase !== 'discard' || seat !== this.turn) return;
      // self-draw win?
      const win = this.checkWin(seat, this.drawnTile, true);
      if (win && win.total >= this.cfg.minFan) { this.settleWin(seat, this.drawnTile, seat, true); return; }
      // concealed / add kong?
      const cnt = mj.countsOfTiles(this.hands[seat]);
      for (let k = 0; k < mj.MJ_KINDS; k++) {
        if (cnt[k] === 4 && this.wall.length > 0) {
          const before = mj.shanten(this.hands[seat], this.exposed[seat]);
          const rest = this.hands[seat].filter(t => t.k !== k);
          const after = mj.shanten(rest, this.exposed[seat].concat([{ t: 'kong', k }]));
          if (after <= before) { this.declareKong(seat, 'concealed', k); return; }
        }
      }
      const t = mj.mjAiDiscard(this.hands[seat], this.exposed[seat], {
        discards: this.allDiscards(),
      });
      this.discard(seat, t.id);
    }

    allDiscards() {
      const out = [];
      for (const d of this.discards) for (const t of d) out.push(t.k);
      return out;
    }

    /* ---------- settlement ---------- */
    settleWin(seat, tile, from, selfDraw) {
      const win = this.checkWin(seat, selfDraw ? null : tile, selfDraw);
      if (!win) return;
      const fans = win.total;
      const deltas = [0, 0, 0, 0];
      if (selfDraw) { for (let i = 0; i < 4; i++) if (i !== seat) { deltas[i] -= fans; deltas[seat] += fans; } }
      else { deltas[from] -= fans; deltas[seat] += fans; }
      for (let i = 0; i < 4; i++) this.scores[i] += deltas[i];
      this.result = {
        type: 'win', winner: seat, from, selfDraw, fan: fans,
        fans: win.fans.map(f => ({ key: f.key, fan: f.fan, name: mj.FAN_NAMES[f.key] || f.key })),
        hand: this.hands[seat].concat(selfDraw ? [] : [tile]).map(t => ({ k: t.k, label: mj.tileLabel(t.k) })),
        winTile: tile ? { k: tile.k, label: mj.tileLabel(tile.k) } : null,
        deltas, scores: this.scores.slice(),
      };
      this.say(`${this.players[seat].name} ${selfDraw ? '自摸' : '和'} ${fans} 番`);
      this.phase = 'settle';
      this.seq++;
      this.emit();
    }

    /* ---------- driver ---------- */
    /** Advance one step (used by headless simulations and the UI loop). */
    step() {
      switch (this.phase) {
        case 'draw': this.doDraw(); break;
        case 'discard': if (this.players[this.turn].isAI) this.aiTurn(this.turn); break;
        case 'claim': this.tryResolveClaims(); break;
        case 'settle': if (!this.matchOver) this.nextRound(); break;
        default: break;
      }
    }

    /** Run until the match ends or the given step budget is exhausted. */
    run(maxSteps) {
      let n = maxSteps || 200000;
      let guard = 0;
      while (!this.matchOver && n-- > 0) {
        const before = this.seq;
        this.step();
        if (this.phase === 'discard' && !this.players[this.turn].isAI) break; // human input needed
        if (this.phase === 'claim' && this.awaiting.length) break;
        if (this.seq === before && ++guard > 50) break;
        if (this.seq !== before) guard = 0;
      }
      return this.matchOver;
    }

    /* ---------- UI plumbing (命名与牌类那套保持一致，ui.js 直接调) ---------- */
    stop() { this.phase = 'idle'; }

    /** 掉线转 AI：轮到谁就让 AI 接着走一步。 */
    pump() {
      if (this.phase === 'discard' && this.players[this.turn] && this.players[this.turn].isAI) {
        this.aiTurn(this.turn);
        return;
      }
      // 掉线时正卡在吃碰杠胡：托管座位必须先表态，否则整局会永远停在 claim。
      if (this.phase === 'claim') {
        for (const s of this.awaiting.slice()) {
          if (this.phase !== 'claim') break;   // 前一家已经胡/碰，claim 阶段结束了
          if (!this.players[s] || !this.players[s].isAI) continue;
          this.submitClaim(s, this.aiClaim(s, this.claimOpts[s] || []));
        }
      }
    }

    /** 提示：给出一张推荐打出的牌（和 AI 用同一套判断）。 */
    hintDiscard(seat) {
      if (this.phase !== 'discard' || seat !== this.turn) return null;
      const t = mj.mjAiDiscard(this.hands[seat], this.exposed[seat], { discards: this.allDiscards() });
      return t ? t.id : null;
    }

    actDiscard(seat, tileId) { return this.discard(seat, tileId); }
    actClaim(seat, decision) { return this.submitClaim(seat, decision); }
    actKong(seat, kind, k) { return this.declareKong(seat, kind, k); }

    /** 自摸：必须手里有刚摸进来的那张牌才可能和。
     *  碰/吃之后手牌是 11 张 + 1 副露，总数也是 14，但那张牌不是摸来的 —— 不能算自摸。 */
    actSelfWin(seat) {
      if (this.phase !== 'discard' || seat !== this.turn) return false;
      if (!this.drawnTile) return false;
      const win = this.checkWin(seat, this.drawnTile, true);
      if (!win || win.total < this.cfg.minFan) return false;
      this.settleWin(seat, this.drawnTile, seat, true);
      return true;
    }
    actAgain(seat) {
      if (seat !== 0 || this.phase !== 'settle') return false;
      this.nextRound();
      return true;
    }

    /** 某种牌已经明面上出现了几张（牌河 + 副露 + 我的手牌），用来算还剩几张可摸。 */
    visibleCount(k) {
      let n = 0;
      for (let i = 0; i < 4; i++) {
        for (const t of this.discards[i]) if (t.k === k) n++;
        for (const m of this.exposed[i]) if (m.tiles) for (const t of m.tiles) if (t.k === k) n++;
      }
      for (const t of this.hands[this.turn] || []) if (t.k === k) n++;
      return n;
    }

    /* ---------- views ---------- */
    buildView(seat) {
      const v = this.view(seat);
      v.revision = this.seq;
      return v;
    }

    view(seat) {
      const s = seat == null ? 0 : seat;
      // 轮到自己时，把「能不能自摸 / 手里有没有暗杠」一并算好，UI 不用再算一遍
      let selfOpts = null;
      if (this.phase === 'discard' && this.turn === s) {
        // 只有手里握着刚摸的那张牌，才谈得上自摸
        const win = this.drawnTile ? this.checkWin(s, this.drawnTile, true) : null;
        const cnt = mj.countsOfTiles(this.hands[s]);
        const kongs = [];
        for (let k = 0; k < mj.MJ_KINDS; k++) if (cnt[k] === 4) kongs.push(k);
        const addKongs = this.exposed[s].filter(m => m.t === 'pung' && cnt[m.k] >= 1).map(m => m.k);
        selfOpts = {
          hu: win && win.total >= this.cfg.minFan ? win.total : 0,
          huFans: win ? win.fans.map(f => ({ key: f.key, fan: f.fan, name: mj.FAN_NAMES[f.key] || f.key })) : [],
          kongs, addKongs,
        };
      }

      // 听牌 / 提示只给「人」算：AI 自己回合会直接走，算了也是浪费。
      let ting = null, tingDiscard = null, hintId = null;
      if (this.phase === 'discard' && this.turn === s && !this.players[s].isAI) {
        // winningTiles 认的是 13 张的牌型，所以要先枚举「打哪张」，再看听什么。
        // 取听牌种数最多的那一种打法。
        const seen = new Set();
        let best = null;
        for (const t of this.hands[s]) {
          if (seen.has(t.k)) continue;
          seen.add(t.k);
          const rest = this.hands[s].filter(x => x.id !== t.id);
          if (mj.shanten(rest, this.exposed[s]) !== 0) continue;
          const waits = mj.winningTiles(rest, this.exposed[s]);
          if (!waits.length) continue;
          if (!best || waits.length > best.waits.length) best = { discardK: t.k, waits };
        }
        if (best) {
          ting = best.waits.map(k => ({ k, label: mj.tileLabel(k), left: 4 - this.visibleCount(k) }));
          tingDiscard = best.discardK;
        }
        const pick = mj.mjAiDiscard(this.hands[s], this.exposed[s], { discards: this.allDiscards() });
        hintId = pick ? pick.id : null;
      }
      return {
        mode: 'mahjong', n: 4, phase: this.phase, turn: this.turn, mySeat: s,
        round: this.roundNo, totalRounds: this.cfg.totalRounds,
        roundWind: this.roundWind, roundWindLabel: mj.tileLabel(this.roundWind),
        dealer: this.dealer, seatWind: SEAT_WINDS[(s - this.dealer + 4) % 4],
        seatWindLabel: mj.tileLabel(SEAT_WINDS[(s - this.dealer + 4) % 4]),
        wallLeft: this.wall.length,
        players: this.players.map((p, i) => ({
          name: p.name, isAI: p.isAI, score: this.scores[i],
          handCount: this.hands[i].length,
          exposed: this.exposed[i].map(m => ({ t: m.t, k: m.k, label: mj.tileLabel(m.k) })),
          discards: this.discards[i].map(t => t.k),
          seatWind: SEAT_WINDS[(i - this.dealer + 4) % 4],
        })),
        myHand: mj.sortTiles(this.hands[s]).map(t => ({ id: t.id, k: t.k, label: mj.tileLabel(t.k) })),
        myExposed: this.exposed[s].map(m => ({ t: m.t, k: m.k, label: mj.tileLabel(m.k) })),
        drawn: this.drawnTile && this.turn === s ? { id: this.drawnTile.id, k: this.drawnTile.k, label: mj.tileLabel(this.drawnTile.k) } : null,
        pending: this.pending ? { tile: { k: this.pending.tile.k, label: mj.tileLabel(this.pending.tile.k) }, from: this.pending.from } : null,
        claimOptions: (this.claimOpts[s] || []).map(o => ({ t: o.t, k: o.meld ? o.meld.k : (this.pending ? this.pending.tile.k : null), fan: o.win ? o.win.total : 0 })),
        awaiting: this.awaiting.slice(),
        selfOpts,
        ting,
        tingDiscard,
        hintId,
        result: this.result,
        matchOver: this.matchOver,
        minFan: this.cfg.minFan,
      };
    }
  }

  return { MahjongGame, SEAT_WINDS, MIN_FAN };
});
