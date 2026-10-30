'use strict';
/* =========================================================================
 * trade.js — 模拟交易 (paper trading) engine: virtual stocks + FX.
 * Pure logic, no DOM. Runs in the browser (window.TradeEngine) and in Node
 * (require('../js/trade.js')) so the whole thing is testable headlessly.
 *
 * Everything here is fictional: prices are a random walk produced on the
 * client, no broker, no network, no real order ever leaves the page.
 * ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TradeEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const START_CASH = 100000;          // 初始虚拟资金
  const STORAGE_KEY = 'ddz_trade_v1';
  const HISTORY_MAX = 240;            // 分时图保留的 tick 数（约 4~8 分钟）
  const TRADES_MAX = 60;

  /* ---------- 标的：全部虚构 ---------- */
  const INSTRUMENTS = [
    // 股票：只做多，波动比外汇大
    { symbol: 'XLTK', kind: 'stock', nameZh: '星澜科技', nameEn: 'Stellarwave Tech', price: 128.40, vol: 0.0016, drift: 0.000012, digits: 2 },
    { symbol: 'BAEN', kind: 'stock', nameZh: '北岸能源', nameEn: 'Northshore Energy', price: 42.75, vol: 0.0012, drift: 0.000006, digits: 2 },
    { symbol: 'YQYY', kind: 'stock', nameZh: '云栖医药', nameEn: 'Cloudharbor Pharma', price: 86.20, vol: 0.0018, drift: 0.000008, digits: 2 },
    { symbol: 'JSFO', kind: 'stock', nameZh: '金穗食品', nameEn: 'Goldgrain Foods', price: 23.55, vol: 0.0009, drift: 0.000004, digits: 2 },
    { symbol: 'JGZG', kind: 'stock', nameZh: '极光重工', nameEn: 'Aurora Heavy' , price: 57.10, vol: 0.0014, drift: 0.000005, digits: 2 },
    { symbol: 'NYWL', kind: 'stock', nameZh: '南屿文旅', nameEn: 'Southisle Travel', price: 15.80, vol: 0.0017, drift: 0.000010, digits: 2 },
    // 外汇：可多可空，波动明显小于股票
    { symbol: 'EURUSD', kind: 'fx', nameZh: '欧元/美元', nameEn: 'Euro / US Dollar', price: 1.0842, vol: 0.00040, drift: 0.000001, digits: 4 },
    { symbol: 'USDJPY', kind: 'fx', nameZh: '美元/日元', nameEn: 'US Dollar / Yen', price: 149.350, vol: 0.00045, drift: 0.000002, digits: 3 },
    { symbol: 'GBPUSD', kind: 'fx', nameZh: '英镑/美元', nameEn: 'Sterling / US Dollar', price: 1.2715, vol: 0.00042, drift: -0.000001, digits: 4 },
    { symbol: 'USDCNY', kind: 'fx', nameZh: '美元/人民币', nameEn: 'US Dollar / Yuan', price: 7.1840, vol: 0.00025, drift: 0.0000005, digits: 4 },
  ];

  const BY_SYMBOL = {};
  for (const it of INSTRUMENTS) BY_SYMBOL[it.symbol] = it;

  const ERR = {
    BAD_QTY: 'BAD_QTY',
    BAD_PRICE: 'BAD_PRICE',
    NO_FUNDS: 'NO_FUNDS',
    NO_POSITION: 'NO_POSITION',
    LONG_ONLY: 'LONG_ONLY',
    UNKNOWN: 'UNKNOWN',
  };

  /* ---------- 随机数 ---------- */

  // 确定性 PRNG，测试里给个种子就能复现整条行情。
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Box–Muller，返回标准正态；用一个 spare 避免每次浪费一半样本。
  function makeGaussian(rand) {
    let spare = null;
    return function () {
      if (spare !== null) { const v = spare; spare = null; return v; }
      let u = 0, v = 0, s = 0;
      do {
        u = rand() * 2 - 1;
        v = rand() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const m = Math.sqrt(-2 * Math.log(s) / s);
      spare = v * m;
      return u * m;
    };
  }

  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  /* ---------- 行情：几何布朗运动 ---------- */

  function Market(opts) {
    opts = opts || {};
    this.rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
    this._gauss = makeGaussian(this.rand);
    this.prices = {};
    this.open = {};
    this.history = {};
    this.tickCount = 0;
    for (const it of INSTRUMENTS) {
      this.prices[it.symbol] = it.price;
      this.open[it.symbol] = it.price;
      this.history[it.symbol] = [it.price];
    }
    const warm = num(opts.warmup, 0);
    for (let i = 0; i < warm; i++) this.step();
    // 开盘价 = 预热后分时图的第一根，涨跌幅以它为基准
    for (const it of INSTRUMENTS) this.open[it.symbol] = this.history[it.symbol][0];
  }

  // 离散化 GBM：S' = S · exp((μ − σ²/2)·dt + σ·√dt·Z)，dt = 1 tick。
  // exp() 恒为正，再兜一层非有限值/非正值保护。
  Market.prototype.step = function () {
    for (const it of INSTRUMENTS) {
      const s = this.prices[it.symbol];
      const z = this._gauss();
      let next = s * Math.exp((it.drift - it.vol * it.vol / 2) + it.vol * z);
      if (!isFinite(next) || next <= 0) next = s > 0 ? s : it.price;
      this.prices[it.symbol] = next;
      const h = this.history[it.symbol];
      h.push(next);
      if (h.length > HISTORY_MAX) h.shift();
    }
    this.tickCount++;
    return this;
  };

  Market.prototype.priceOf = function (sym) {
    return this.prices[sym];
  };

  Market.prototype.changePct = function (sym) {
    const o = this.open[sym], p = this.prices[sym];
    if (!isFinite(o) || !isFinite(p) || o <= 0) return 0;
    return (p / o - 1) * 100;
  };

  Market.prototype.toJSON = function () {
    const prices = {}, history = {}, open = {};
    for (const it of INSTRUMENTS) {
      prices[it.symbol] = this.prices[it.symbol];
      open[it.symbol] = this.open[it.symbol];
      history[it.symbol] = this.history[it.symbol].slice(-HISTORY_MAX);
    }
    return { tickCount: this.tickCount, prices, open, history };
  };

  Market.fromJSON = function (data, opts) {
    const m = new Market(Object.assign({}, opts, { warmup: 0 }));
    if (!data || typeof data !== 'object') return m;
    for (const it of INSTRUMENTS) {
      const p = data.prices && Number(data.prices[it.symbol]);
      if (isFinite(p) && p > 0) m.prices[it.symbol] = p;
      const o = data.open && Number(data.open[it.symbol]);
      m.open[it.symbol] = isFinite(o) && o > 0 ? o : m.prices[it.symbol];
      const raw = data.history && data.history[it.symbol];
      if (Array.isArray(raw)) {
        const clean = raw.filter(x => typeof x === 'number' && isFinite(x) && x > 0).slice(-HISTORY_MAX);
        if (clean.length) m.history[it.symbol] = clean;
      }
      // 末点必须等于当前价，否则图上最后一根与报价对不上
      const h = m.history[it.symbol];
      h[h.length - 1] = m.prices[it.symbol];
    }
    m.tickCount = Math.max(0, Math.floor(num(data.tickCount, 0)));
    return m;
  };

  /* ---------- 持仓记账 ----------
   * qty 是带符号的：>0 多头，<0 空头。股票永远 >= 0。
   * 加仓（同向）重算均价；减仓（反向）按均价结转已实现盈亏；
   * 一次性穿过零轴则剩余部分按成交价开反向仓。 */

  function applyFill(pos, delta, price) {
    if (!delta) return 0;
    if (pos.qty === 0) {
      pos.qty = delta;
      pos.avgPrice = price;
      return 0;
    }
    const sameDir = (pos.qty > 0) === (delta > 0);
    if (sameDir) {
      const total = Math.abs(pos.qty) + Math.abs(delta);
      pos.avgPrice = (pos.avgPrice * Math.abs(pos.qty) + price * Math.abs(delta)) / total;
      pos.qty += delta;
      return 0;
    }
    const closing = Math.min(Math.abs(delta), Math.abs(pos.qty));
    const dir = pos.qty > 0 ? 1 : -1;
    const realized = (price - pos.avgPrice) * closing * dir;
    const nextQty = pos.qty + delta;
    if (nextQty === 0) { pos.qty = 0; pos.avgPrice = 0; }
    else if ((nextQty > 0) !== (pos.qty > 0)) { pos.qty = nextQty; pos.avgPrice = price; }
    else pos.qty = nextQty;
    return realized;
  }

  /* ---------- 账户 ---------- */

  function Account(opts) {
    opts = opts || {};
    this.cash = num(opts.cash, START_CASH);
    this.realized = num(opts.realized, 0);
    this.positions = {};
    this.trades = [];
    this.equityHistory = [];
    if (opts.positions && typeof opts.positions === 'object') {
      for (const sym of Object.keys(opts.positions)) {
        if (!BY_SYMBOL[sym]) continue;
        const p = opts.positions[sym] || {};
        const qty = num(p.qty, 0);
        const avg = num(p.avgPrice, 0);
        if (!qty || !(avg > 0)) continue;
        if (BY_SYMBOL[sym].kind === 'stock' && qty < 0) continue;
        this.positions[sym] = { qty, avgPrice: avg };
      }
    }
    if (Array.isArray(opts.trades)) {
      this.trades = opts.trades.filter(x => x && BY_SYMBOL[x.sym]).slice(0, TRADES_MAX);
    }
    if (Array.isArray(opts.equityHistory)) {
      this.equityHistory = opts.equityHistory
        .filter(x => typeof x === 'number' && isFinite(x))
        .slice(-HISTORY_MAX);
    }
  }

  Account.prototype._pos = function (sym, create) {
    let p = this.positions[sym];
    if (!p && create) {
      p = { qty: 0, avgPrice: 0 };
      this.positions[sym] = p;
    }
    return p || null;
  };

  Account.prototype.qtyOf = function (sym) {
    const p = this.positions[sym];
    return p ? p.qty : 0;
  };

  Account.prototype.avgCost = function (sym) {
    const p = this.positions[sym];
    return p ? p.avgPrice : 0;
  };

  function resolvePrice(src, sym) {
    if (src == null) return NaN;
    if (typeof src.priceOf === 'function') return src.priceOf(sym);
    return Number(src[sym]);
  }

  Account.prototype.equity = function (src) {
    let v = this.cash;
    for (const sym of Object.keys(this.positions)) {
      const p = this.positions[sym];
      if (!p.qty) continue;
      v += p.qty * resolvePrice(src, sym);
    }
    return v;
  };

  Account.prototype.marketValue = function (src) {
    let v = 0;
    for (const sym of Object.keys(this.positions)) {
      const p = this.positions[sym];
      if (!p.qty) continue;
      v += p.qty * resolvePrice(src, sym);
    }
    return v;
  };

  // 浮动盈亏 = Σ (现价 − 均价) × 带符号持仓
  Account.prototype.floatingPnl = function (src) {
    let v = 0;
    for (const sym of Object.keys(this.positions)) {
      const p = this.positions[sym];
      if (!p.qty) continue;
      v += (resolvePrice(src, sym) - p.avgPrice) * p.qty;
    }
    return v;
  };

  Account.prototype.pushEquity = function (v) {
    if (!isFinite(v)) return;
    this.equityHistory.push(v);
    if (this.equityHistory.length > HISTORY_MAX) this.equityHistory.shift();
  };

  Account.prototype._log = function (sym, side, qty, price, realized, ts) {
    this.trades.unshift({
      ts: ts || Date.now(),
      sym, side, qty, price,
      realized: isFinite(realized) ? realized : 0,
    });
    if (this.trades.length > TRADES_MAX) this.trades.length = TRADES_MAX;
  };

  Account.prototype.buy = function (inst, qty, price, ts) {
    if (!inst || !BY_SYMBOL[inst.symbol]) return { ok: false, code: ERR.UNKNOWN };
    qty = Number(qty);
    price = Number(price);
    if (!Number.isInteger(qty) || qty <= 0) return { ok: false, code: ERR.BAD_QTY };
    if (!isFinite(price) || price <= 0) return { ok: false, code: ERR.BAD_PRICE };
    if (inst.kind === 'stock' && this.qtyOf(inst.symbol) < 0) return { ok: false, code: ERR.LONG_ONLY };
    const cost = qty * price;
    if (cost > this.cash + 1e-9) return { ok: false, code: ERR.NO_FUNDS };

    const pos = this._pos(inst.symbol, true);
    const realized = applyFill(pos, qty, price);
    this.cash -= cost;
    this.realized += realized;
    if (pos.qty === 0 && !pos.avgPrice) delete this.positions[inst.symbol];
    this._log(inst.symbol, 'buy', qty, price, realized, ts);
    return { ok: true, realized, cash: this.cash, qty: pos.qty };
  };

  Account.prototype.sell = function (inst, qty, price, ts) {
    if (!inst || !BY_SYMBOL[inst.symbol]) return { ok: false, code: ERR.UNKNOWN };
    qty = Number(qty);
    price = Number(price);
    if (!Number.isInteger(qty) || qty <= 0) return { ok: false, code: ERR.BAD_QTY };
    if (!isFinite(price) || price <= 0) return { ok: false, code: ERR.BAD_PRICE };
    const held = this.qtyOf(inst.symbol);
    // 股票只做多：卖出不得超过持仓。外汇超出部分视为开空。
    if (inst.kind === 'stock' && qty > held) return { ok: false, code: ERR.NO_POSITION };

    const pos = this._pos(inst.symbol, true);
    const realized = applyFill(pos, -qty, price);
    this.cash += qty * price;
    this.realized += realized;
    if (pos.qty === 0 && !pos.avgPrice) delete this.positions[inst.symbol];
    this._log(inst.symbol, 'sell', qty, price, realized, ts);
    return { ok: true, realized, cash: this.cash, qty: pos.qty };
  };

  Account.prototype.toJSON = function () {
    const positions = {};
    for (const sym of Object.keys(this.positions)) {
      const p = this.positions[sym];
      if (!p.qty) continue;
      positions[sym] = { qty: p.qty, avgPrice: p.avgPrice };
    }
    return {
      cash: this.cash,
      realized: this.realized,
      positions,
      trades: this.trades.slice(0, TRADES_MAX),
      equityHistory: this.equityHistory.slice(-HISTORY_MAX),
    };
  };

  Account.fromJSON = function (data) {
    if (!data || typeof data !== 'object') return new Account();
    return new Account(data);
  };

  /* ---------- localStorage 存档 ----------
   * storage 可注入（Node 里传假对象），默认用 localStorage。 */

  function defaultStorage() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) { }
    return null;
  }

  const TradeStore = {
    save(state, storage) {
      const st = storage || defaultStorage();
      if (!st) return false;
      try { st.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
      catch (e) { return false; }
    },
    load(storage) {
      const st = storage || defaultStorage();
      if (!st) return null;
      try {
        const raw = st.getItem(STORAGE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        return data && typeof data === 'object' ? data : null;
      } catch (e) { return null; }
    },
    clear(storage) {
      const st = storage || defaultStorage();
      if (!st) return false;
      try { st.removeItem(STORAGE_KEY); return true; }
      catch (e) { return false; }
    },
  };

  function saveTrade(market, account, storage) {
    return TradeStore.save({ v: 1, market: market.toJSON(), account: account.toJSON() }, storage);
  }

  // 存档损坏时返回 null，由调用方决定回退到全新账户。
  function loadTrade(storage, opts) {
    const raw = TradeStore.load(storage);
    if (!raw) return null;
    try {
      return {
        market: Market.fromJSON(raw.market, opts),
        account: Account.fromJSON(raw.account),
      };
    } catch (e) { return null; }
  }

  return {
    START_CASH, STORAGE_KEY, HISTORY_MAX, TRADES_MAX,
    INSTRUMENTS, BY_SYMBOL, ERR,
    Market, Account, TradeStore,
    saveTrade, loadTrade,
    mulberry32, makeGaussian, applyFill,
  };
});
