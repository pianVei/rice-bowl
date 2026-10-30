'use strict';
/* trade.test.js — 模拟交易引擎的无头测试。
 * 跑法：node tests/trade.test.js
 */

const assert = require('assert');
const T = require('../js/trade.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}
function near(a, b, eps, msg) {
  eps = eps == null ? 1e-6 : eps;
  assert.ok(Math.abs(a - b) <= eps, (msg || '') + ` 期望 ${b}，实际 ${a}`);
}

const STOCK = T.BY_SYMBOL.XLTK;
const FX = T.BY_SYMBOL.EURUSD;
const FX2 = T.BY_SYMBOL.USDJPY;

console.log('\n[trade] 标的与行情');

ok('至少 6 只股票 + 4 个外汇对', () => {
  const stocks = T.INSTRUMENTS.filter(i => i.kind === 'stock');
  const fx = T.INSTRUMENTS.filter(i => i.kind === 'fx');
  assert.ok(stocks.length >= 6, '股票不足 6 个');
  assert.ok(fx.length >= 4, '外汇不足 4 个');
});

ok('标的代码唯一且参数合法', () => {
  const seen = new Set();
  for (const it of T.INSTRUMENTS) {
    assert.ok(!seen.has(it.symbol), '重复代码 ' + it.symbol);
    seen.add(it.symbol);
    assert.ok(it.price > 0 && isFinite(it.price), '初始价非法 ' + it.symbol);
    assert.ok(it.vol > 0 && it.vol < 0.1, '波动率非法 ' + it.symbol);
    assert.ok(it.nameZh && it.nameEn, '缺少名称 ' + it.symbol);
  }
});

ok('1000 个 tick 后所有价格都是有限正数（无 NaN/负价）', () => {
  const m = new T.Market({ rand: T.mulberry32(20261029), warmup: 0 });
  for (let i = 0; i < 1000; i++) {
    m.step();
    for (const it of T.INSTRUMENTS) {
      const p = m.priceOf(it.symbol);
      assert.ok(typeof p === 'number' && isFinite(p), `${it.symbol} 第 ${i} tick 非有限: ${p}`);
      assert.ok(p > 0, `${it.symbol} 第 ${i} tick 非正: ${p}`);
      assert.ok(!Number.isNaN(p), `${it.symbol} 出现 NaN`);
    }
  }
  assert.strictEqual(m.tickCount, 1000);
});

ok('分时历史被限制在 HISTORY_MAX 内', () => {
  const m = new T.Market({ rand: T.mulberry32(7), warmup: 0 });
  for (let i = 0; i < 500; i++) m.step();
  for (const it of T.INSTRUMENTS) {
    assert.ok(m.history[it.symbol].length <= T.HISTORY_MAX);
    assert.ok(m.history[it.symbol].length > 0);
  }
});

ok('同种子行情可复现', () => {
  const a = new T.Market({ rand: T.mulberry32(42), warmup: 0 });
  const b = new T.Market({ rand: T.mulberry32(42), warmup: 0 });
  for (let i = 0; i < 100; i++) { a.step(); b.step(); }
  for (const it of T.INSTRUMENTS) {
    assert.strictEqual(a.priceOf(it.symbol), b.priceOf(it.symbol), it.symbol);
  }
});

ok('股票波动率整体大于外汇', () => {
  const m = new T.Market({ rand: T.mulberry32(99), warmup: 0 });
  const starts = {};
  for (const it of T.INSTRUMENTS) starts[it.symbol] = m.priceOf(it.symbol);
  const sumSq = {};
  for (const it of T.INSTRUMENTS) sumSq[it.symbol] = 0;
  const prev = Object.assign({}, starts);
  const N = 1000;
  for (let i = 0; i < N; i++) {
    m.step();
    for (const it of T.INSTRUMENTS) {
      const r = Math.log(m.priceOf(it.symbol) / prev[it.symbol]);
      sumSq[it.symbol] += r * r;
      prev[it.symbol] = m.priceOf(it.symbol);
    }
  }
  const rms = it => Math.sqrt(sumSq[it.symbol] / N);
  const stocks = T.INSTRUMENTS.filter(i => i.kind === 'stock');
  const fxs = T.INSTRUMENTS.filter(i => i.kind === 'fx');
  const mean = arr => arr.reduce((s, i) => s + rms(i), 0) / arr.length;
  assert.ok(mean(stocks) > mean(fxs) * 1.5,
    `股票均方波动 ${mean(stocks)} 未明显大于外汇 ${mean(fxs)}`);
});

ok('Market.fromJSON 丢弃非法价格', () => {
  const bad = {
    prices: { XLTK: -5, BAEN: 'abc', YQYY: 0 },
    history: { XLTK: [1, -2, 3, NaN, 4] },
    tickCount: 'x',
  };
  const m = T.Market.fromJSON(bad);
  assert.ok(m.priceOf('XLTK') === T.BY_SYMBOL.XLTK.price, '非法价未被替换');
  assert.ok(m.priceOf('YQYY') === T.BY_SYMBOL.YQYY.price);
  for (const it of T.INSTRUMENTS) assert.ok(m.priceOf(it.symbol) > 0);
});

console.log('\n[trade] 账户与下单');

ok('初始账户 100,000 虚拟资金', () => {
  const a = new T.Account();
  assert.strictEqual(a.cash, T.START_CASH);
  assert.strictEqual(a.realized, 0);
  assert.deepStrictEqual(a.positions, {});
});

ok('买入后资金与持仓守恒', () => {
  const a = new T.Account();
  const price = 50;
  const r = a.buy(STOCK, 100, price);
  assert.ok(r.ok, '买入被拒');
  near(a.cash, 100000 - 5000, 1e-9, '现金');
  assert.strictEqual(a.qtyOf('XLTK'), 100);
  near(a.avgCost('XLTK'), 50, 1e-9, '成本价');
  near(a.equity({ XLTK: price }), 100000, 1e-9, '总资产不守恒');
});

ok('多次买入按加权平均成本记账', () => {
  const a = new T.Account();
  a.buy(STOCK, 100, 10);
  a.buy(STOCK, 100, 20);
  near(a.avgCost('XLTK'), 15, 1e-9);
  assert.strictEqual(a.qtyOf('XLTK'), 200);
  near(a.cash, 100000 - 1000 - 2000, 1e-9);
});

ok('超过可用资金被拒，且账户不变', () => {
  const a = new T.Account();
  const r = a.buy(STOCK, 100000, 10);  // 需要 1,000,000
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, T.ERR.NO_FUNDS);
  assert.strictEqual(a.cash, 100000);
  assert.strictEqual(a.qtyOf('XLTK'), 0);
});

ok('非法数量被拒（0 / 负数 / 小数）', () => {
  const a = new T.Account();
  for (const q of [0, -1, 1.5, NaN, 'abc']) {
    assert.strictEqual(a.buy(STOCK, q, 10).code, T.ERR.BAD_QTY, 'buy ' + q);
    assert.strictEqual(a.sell(STOCK, q, 10).code, T.ERR.BAD_QTY, 'sell ' + q);
  }
  assert.strictEqual(a.cash, 100000);
});

ok('股票卖出超过持仓被拒', () => {
  const a = new T.Account();
  a.buy(STOCK, 100, 10);
  const r = a.sell(STOCK, 101, 10);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, T.ERR.NO_POSITION);
  assert.strictEqual(a.qtyOf('XLTK'), 100);
  near(a.cash, 99000, 1e-9);
});

ok('股票不能做空（无持仓卖出被拒）', () => {
  const a = new T.Account();
  const r = a.sell(STOCK, 10, 10);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, T.ERR.NO_POSITION);
  assert.strictEqual(a.qtyOf('XLTK'), 0);
  assert.strictEqual(a.cash, 100000);
});

ok('卖出后已实现盈亏正确', () => {
  const a = new T.Account();
  a.buy(STOCK, 100, 100);
  const r = a.sell(STOCK, 100, 110);
  assert.ok(r.ok);
  near(r.realized, 1000, 1e-9);
  near(a.realized, 1000, 1e-9);
  near(a.cash, 101000, 1e-9);
  assert.strictEqual(a.qtyOf('XLTK'), 0);
  near(a.equity({ XLTK: 110 }), 101000, 1e-9);
});

ok('部分卖出只结转对应部分的盈亏', () => {
  const a = new T.Account();
  a.buy(STOCK, 100, 100);
  const r = a.sell(STOCK, 40, 110);
  near(r.realized, 400, 1e-9);
  assert.strictEqual(a.qtyOf('XLTK'), 60);
  near(a.avgCost('XLTK'), 100, 1e-9);
  near(a.cash, 94400, 1e-9);
  near(a.floatingPnl({ XLTK: 110 }), 600, 1e-9);
});

ok('浮动盈亏：多头与空头符号正确', () => {
  const a = new T.Account();
  a.buy(STOCK, 100, 10);
  near(a.floatingPnl({ XLTK: 12 }), 200, 1e-9, '多头');
  const b = new T.Account();
  b.sell(FX, 1000, 1.10);
  near(b.floatingPnl({ EURUSD: 1.05 }), 50, 1e-9, '空头盈利');
  near(b.floatingPnl({ EURUSD: 1.15 }), -50, 1e-9, '空头亏损');
});

ok('外汇做空：开空 + 平仓盈利', () => {
  const a = new T.Account();
  const open = a.sell(FX, 1000, 1.10);
  assert.ok(open.ok, '开空被拒');
  assert.strictEqual(a.qtyOf('EURUSD'), -1000, '持仓应为负数');
  near(a.cash, 101100, 1e-9, '开空回收现金');
  near(a.equity({ EURUSD: 1.10 }), 100000, 1e-9, '开空瞬间总资产不变');

  const close = a.buy(FX, 1000, 1.05);
  assert.ok(close.ok, '平空被拒');
  near(close.realized, 50, 1e-9, '空头盈亏');
  assert.strictEqual(a.qtyOf('EURUSD'), 0);
  near(a.cash, 100050, 1e-9);
  near(a.realized, 50, 1e-9);
});

ok('外汇做空：平仓亏损', () => {
  const a = new T.Account();
  a.sell(FX, 1000, 1.10);
  const r = a.buy(FX, 1000, 1.15);
  near(r.realized, -50, 1e-9);
  near(a.cash, 99950, 1e-9);
  near(a.equity({ EURUSD: 1.15 }), 99950, 1e-9);
});

ok('外汇反手：卖出超过多头持仓会翻空', () => {
  const a = new T.Account();
  a.buy(FX, 100, 1.08);
  const r = a.sell(FX, 150, 1.10);
  assert.ok(r.ok);
  near(r.realized, 2, 1e-9, '只结平 100 的盈亏');
  assert.strictEqual(a.qtyOf('EURUSD'), -50);
  near(a.avgCost('EURUSD'), 1.10, 1e-9, '剩余空仓成本=成交价');
});

ok('外汇日元对也能双向交易', () => {
  const a = new T.Account();
  a.sell(FX2, 10000, 149.5);       // 开空
  assert.strictEqual(a.qtyOf('USDJPY'), -10000);
  const r = a.buy(FX2, 10000, 148.5);
  near(r.realized, 10000, 1e-6);   // (149.5-148.5)*10000
});

ok('连续随机下单后 equity === cash + 市值', () => {
  const m = new T.Market({ rand: T.mulberry32(2026), warmup: 20 });
  const a = new T.Account();
  const rand = T.mulberry32(7);
  for (let i = 0; i < 300; i++) {
    m.step();
    const inst = T.INSTRUMENTS[Math.floor(rand() * T.INSTRUMENTS.length)];
    const price = m.priceOf(inst.symbol);
    const qty = 1 + Math.floor(rand() * 50);
    if (rand() < 0.55) a.buy(inst, qty, price);
    else a.sell(inst, qty, price);
    const eq = a.equity(m);
    let mv = 0;
    for (const sym of Object.keys(a.positions)) mv += a.positions[sym].qty * m.priceOf(sym);
    near(eq, a.cash + mv, 1e-6, '第 ' + i + ' 步');
    assert.ok(isFinite(eq), 'equity NaN');
    // 不允许出现负现金（本模型所有买入都要求现金足够）
    assert.ok(a.cash >= -1e-6, '现金变负: ' + a.cash);
  }
});

console.log('\n[trade] 存档与重置');

ok('存档往返保持资金 / 持仓 / 已实现盈亏', () => {
  const mem = new Map();
  const storage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
  };
  const m = new T.Market({ rand: T.mulberry32(11), warmup: 10 });
  const a = new T.Account();
  a.buy(STOCK, 100, m.priceOf('XLTK'));
  a.sell(FX, 500, m.priceOf('EURUSD'));       // 开空
  a.sell(STOCK, 20, m.priceOf('XLTK') * 1.01);
  const eq = a.equity(m);
  a.pushEquity(eq);
  assert.ok(T.saveTrade(m, a, storage));

  const loaded = T.loadTrade(storage);
  assert.ok(loaded, '读档失败');
  near(loaded.account.cash, a.cash, 1e-9);
  near(loaded.account.realized, a.realized, 1e-9);
  assert.strictEqual(loaded.account.qtyOf('XLTK'), 80);
  assert.strictEqual(loaded.account.qtyOf('EURUSD'), -500);
  near(loaded.account.avgCost('XLTK'), a.avgCost('XLTK'), 1e-9);
  near(loaded.account.equity(loaded.market), eq, 1e-6);
  assert.strictEqual(loaded.market.tickCount, m.tickCount); // warmup 10 次也要保住
  assert.deepStrictEqual(loaded.account.equityHistory.length, 1);
});

ok('空存档 / 损坏存档返回 null', () => {
  const mem = new Map();
  const storage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
  };
  assert.strictEqual(T.loadTrade(storage), null);
  mem.set(T.STORAGE_KEY, '{not json');
  assert.strictEqual(T.loadTrade(storage), null);
  mem.set(T.STORAGE_KEY, JSON.stringify({ v: 1, account: { cash: -1 } }));
  const loaded = T.loadTrade(storage);
  assert.ok(loaded, '应能容错读出');
  assert.ok(isFinite(loaded.account.cash));
});

ok('重置后回到 100,000 且无持仓', () => {
  const a = new T.Account();
  a.buy(STOCK, 100, 1);
  const fresh = new T.Account();
  assert.strictEqual(fresh.cash, T.START_CASH);
  assert.strictEqual(Object.keys(fresh.positions).length, 0);
  assert.strictEqual(fresh.realized, 0);
  assert.strictEqual(fresh.trades.length, 0);
});

ok('存档会过滤未知标的和非法持仓', () => {
  const a = T.Account.fromJSON({
    cash: 12345,
    positions: {
      XLTK: { qty: -5, avgPrice: 10 },   // 股票不允许空头
      NOPE: { qty: 10, avgPrice: 1 },    // 未知标的
      BAEN: { qty: 10, avgPrice: 0 },    // 无成本价
      YQYY: { qty: 10, avgPrice: 20 },   // 正常
    },
    realized: 7,
  });
  assert.strictEqual(a.cash, 12345);
  assert.strictEqual(a.qtyOf('XLTK'), 0);
  assert.strictEqual(a.qtyOf('NOPE'), 0);
  assert.strictEqual(a.qtyOf('BAEN'), 0);
  assert.strictEqual(a.qtyOf('YQYY'), 10);
});

console.log('\n[trade] 结果');
console.log(`  ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
