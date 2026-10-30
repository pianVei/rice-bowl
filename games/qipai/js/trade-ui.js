'use strict';
/* trade-ui.js — 模拟交易的渲染与交互。
 *
 * 引擎全部在 js/trade.js（纯逻辑）；这里只做 DOM：行情轮询、下单、持仓、
 * Canvas 分时图 / 资产曲线、localStorage 存档。
 *
 * 独立于牌桌：不碰 App / newGame() / renderGame()，只借用 ui.js 的
 * showScreen()、toast() 和 i18n 的 t()。 */

(function () {
  const E = (typeof window !== 'undefined' && window.TradeEngine) || null;
  if (!E) return;

  const $ = id => document.getElementById(id);

  const state = {
    market: null,
    account: null,
    selected: 'XLTK',
    tab: 'stock',
    timer: null,
    saveTicks: 0,
    booted: false,
    msgTimer: null,
  };

  /* ---------------- 小工具 ---------------- */

  const isZh = () => (typeof LANG !== 'undefined' && LANG === 'en') ? false : true;
  const tr = (k, ...a) => (typeof t === 'function' ? t(k, ...a) : k);

  function instOf(sym) { return E.BY_SYMBOL[sym] || E.INSTRUMENTS[0]; }
  function instName(inst) { return isZh() ? inst.nameZh : inst.nameEn; }
  function fmtPrice(v, inst) {
    const n = Number(v);
    if (!isFinite(n)) return '—';
    return n.toFixed(inst ? inst.digits : 2);
  }
  function fmtMoney(v) {
    const n = Number(v);
    if (!isFinite(n)) return '—';
    return n.toLocaleString(isZh() ? 'zh-CN' : 'en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }
  function fmtSigned(v, d) {
    const n = Number(v);
    if (!isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(d == null ? 2 : d);
  }
  function fmtTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString(isZh() ? 'zh-CN' : 'en-US', { hour12: false });
    } catch (e) { return ''; }
  }
  function cls(n) { return n > 0 ? 'up' : n < 0 ? 'down' : 'flat'; }

  /* ---------------- 状态初始化 / 存档 ---------------- */

  function fresh() {
    return {
      market: new E.Market({ warmup: 60 }),
      account: new E.Account(),
    };
  }

  function init() {
    if (state.booted) return;
    state.booted = true;
    let loaded = null;
    try { loaded = E.loadTrade(); } catch (e) { loaded = null; }
    if (loaded && loaded.market && loaded.account) {
      state.market = loaded.market;
      state.account = loaded.account;
    } else {
      const f = fresh();
      state.market = f.market;
      state.account = f.account;
    }
    if (!state.account.equityHistory.length) {
      state.account.pushEquity(state.account.equity(state.market));
    }
    state.selected = E.INSTRUMENTS[0].symbol;
    bindOnce();
    applyTexts();
  }

  function saveNow() {
    try { E.saveTrade(state.market, state.account); } catch (e) { }
  }

  /* ---------------- 语言：包一层 applyStaticTexts ----------------
   * ui.js 的 applyStaticTexts 只认首页/牌桌的 id。这里在它后面补刷交易
   * 界面，不改 ui.js 本身。language 按钮（首页/牌桌）切换时也能生效。 */
  function installTextHook() {
    if (typeof window.applyStaticTexts !== 'function') return;
    const base = window.applyStaticTexts;
    window.applyStaticTexts = function () { base(); applyTexts(); };
  }

  function applyTexts() {
    const set = (id, key) => { const el = $(id); if (el) el.textContent = tr(key); };
    // 首页卡片
    set('t-mtrade', 'm_trade');
    set('t-mtrade-d', 'm_trade_d');
    set('t-mtrade-go', 'm_trade_go');
    // 交易界面
    set('t-trade-title', 'tr_title');
    set('t-trade-disclaimer', 'tr_disclaimer');
    set('t-trade-equity', 'tr_equity');
    set('t-trade-cash', 'tr_cash');
    set('t-trade-float', 'tr_float');
    set('t-trade-realized', 'tr_realized');
    set('t-trade-stocks', 'tr_stocks');
    set('t-trade-fx', 'tr_fx');
    set('t-trade-qty', 'tr_qty');
    set('t-trade-positions', 'tr_positions');
    set('t-trade-curve', 'tr_equity_curve');
    set('t-trade-log', 'tr_log');
    set('t-trade-note', 'tr_market_note');
    const b = $('trade-buy'), s = $('trade-sell'), r = $('trade-reset'), l = $('trade-lang');
    if (b) b.textContent = tr('tr_buy');
    if (s) s.textContent = tr('tr_sell');
    if (r) r.textContent = tr('tr_reset');
    if (l) l.textContent = isZh() ? 'EN' : '中文';
    if (state.market) renderAll();
  }

  /* ---------------- 事件 ---------------- */

  function bindOnce() {
    const open = $('btn-trade');
    if (open) open.addEventListener('click', openMarket);
    const back = $('trade-back');
    if (back) back.addEventListener('click', closeMarket);
    const reset = $('trade-reset');
    if (reset) reset.addEventListener('click', resetAccount);
    const lang = $('trade-lang');
    if (lang) lang.addEventListener('click', () => {
      if (typeof setLang !== 'function') return;
      setLang(LANG === 'zh' ? 'en' : 'zh');
      if (typeof window.applyStaticTexts === 'function') window.applyStaticTexts();
      // 语言变了，之前的成交提示是旧语言，清掉免得中英混排
      clearTimeout(state.msgTimer);
      const msg = $('trade-msg');
      if (msg) { msg.textContent = ''; msg.className = 'trade-msg'; }
    });

    document.querySelectorAll('#screen-trade .trade-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        state.tab = btn.dataset.tab;
        const first = E.INSTRUMENTS.find(i => i.kind === state.tab);
        if (first && instOf(state.selected).kind !== state.tab) state.selected = first.symbol;
        renderAll();
      });
    });

    const list = $('trade-list');
    if (list) list.addEventListener('click', ev => {
      const row = ev.target.closest('.trade-row');
      if (!row) return;
      state.selected = row.dataset.sym;
      renderAll();
    });

    const posBox = $('trade-positions');
    if (posBox) posBox.addEventListener('click', ev => {
      const row = ev.target.closest('.pos-row');
      if (!row) return;
      state.selected = row.dataset.sym;
      state.tab = instOf(row.dataset.sym).kind;
      renderAll();
    });

    const qty = $('trade-qty');
    if (qty) {
      qty.addEventListener('input', () => updateOrder());
      qty.addEventListener('change', () => updateOrder());
    }

    const quick = $('trade-quick');
    if (quick) {
      quick.innerHTML = [10, 100, 500, 1000]
        .map(n => `<button type="button" class="chip trade-quick-btn" data-q="${n}">${n}</button>`)
        .join('');
      quick.addEventListener('click', ev => {
        const b = ev.target.closest('[data-q]');
        if (!b) return;
        if (qty) qty.value = b.dataset.q;
        updateOrder();
      });
    }

    const buy = $('trade-buy');
    const sell = $('trade-sell');
    if (buy) buy.addEventListener('click', () => order('buy'));
    if (sell) sell.addEventListener('click', () => order('sell'));

    window.addEventListener('resize', () => { if (isOpen()) renderCharts(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
    window.addEventListener('pagehide', saveNow);
    window.addEventListener('beforeunload', saveNow);
  }

  function isOpen() {
    const el = $('screen-trade');
    return !!el && el.classList.contains('active');
  }

  function openMarket() {
    init();
    showScreen('screen-trade');
    if (!state.account.equityHistory.length) {
      state.account.pushEquity(state.account.equity(state.market));
    }
    renderAll();
    scheduleTick();
    requestAnimationFrame(() => renderCharts());
  }

  function closeMarket() {
    saveNow();
    showScreen('screen-home');
  }

  function resetAccount() {
    const ok = window.confirm(tr('tr_reset_confirm'));
    if (!ok) return;
    const f = fresh();
    state.market = f.market;
    state.account = f.account;
    state.account.pushEquity(state.account.equity(state.market));
    E.TradeStore.clear();
    state.selected = E.INSTRUMENTS[0].symbol;
    state.tab = 'stock';
    saveNow();
    renderAll();
    showMsg(tr('tr_reset_done'), 'ok');
  }

  /* ---------------- 行情 tick ---------------- */

  function scheduleTick() {
    clearTimeout(state.timer);
    const delay = 1000 + Math.random() * 1000;   // 每 1~2 秒一次
    state.timer = setTimeout(tick, delay);
  }

  function tick() {
    if (!state.market) return;
    state.market.step();
    state.account.pushEquity(state.account.equity(state.market));
    if (isOpen()) renderLive();
    if (++state.saveTicks >= 5) { state.saveTicks = 0; saveNow(); }
    scheduleTick();
  }

  /* ---------------- 下单 ---------------- */

  function readQty() {
    const el = $('trade-qty');
    const n = parseInt(el ? el.value : '0', 10);
    return Number.isInteger(n) ? n : NaN;
  }

  function check(side, inst, qty, price) {
    if (!Number.isInteger(qty) || qty <= 0) return E.ERR.BAD_QTY;
    if (!isFinite(price) || price <= 0) return E.ERR.BAD_PRICE;
    if (side === 'buy') {
      if (qty * price > state.account.cash + 1e-9) return E.ERR.NO_FUNDS;
    } else if (inst.kind === 'stock') {
      if (qty > state.account.qtyOf(inst.symbol)) return E.ERR.NO_POSITION;
    }
    return null;
  }

  function order(side) {
    const inst = instOf(state.selected);
    const qty = readQty();
    const price = state.market.priceOf(inst.symbol);
    const before = state.account.qtyOf(inst.symbol);
    const res = side === 'buy'
      ? state.account.buy(inst, qty, price)
      : state.account.sell(inst, qty, price);
    if (!res.ok) {
      const map = {
        BAD_QTY: 'tr_err_qty', BAD_PRICE: 'tr_err_price', NO_FUNDS: 'tr_err_funds',
        NO_POSITION: 'tr_err_pos', LONG_ONLY: 'tr_err_long', UNKNOWN: 'tr_err_price',
      };
      showMsg(tr(map[res.code] || 'tr_err_price'), 'err');
      return;
    }
    const px = fmtPrice(price, inst);
    let key;
    if (side === 'buy') key = 'tr_fill_buy';
    else key = (inst.kind === 'fx' && before <= 0) ? 'tr_fill_short' : 'tr_fill_sell';
    showMsg(tr(key, qty, inst.symbol, px), 'ok');
    saveNow();
    renderAll();
  }

  function showMsg(text, kind) {
    const el = $('trade-msg');
    if (!el) return;
    el.textContent = text;
    el.className = 'trade-msg' + (kind ? ' ' + kind : '');
    clearTimeout(state.msgTimer);
    state.msgTimer = setTimeout(() => {
      el.textContent = '';
      el.className = 'trade-msg';
    }, 4000);
  }

  /* ---------------- 渲染 ---------------- */

  function renderAll() {
    if (!state.market) return;
    renderTabs();
    renderStats();
    renderList();
    renderDetail();
    renderPositions();
    renderLog();
    updateOrder();
    renderCharts();
  }

  // 每个 tick 只刷数值，不动 DOM 结构和正在输入的 qty
  function renderLive() {
    renderStats();
    renderList();
    renderQuote();
    updateOrder();
    renderPositions();
    renderCharts();
  }

  function renderTabs() {
    document.querySelectorAll('#screen-trade .trade-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === state.tab);
    });
  }

  function renderStats() {
    const m = state.market, a = state.account;
    const eq = a.equity(m);
    const fl = a.floatingPnl(m);
    const eqEl = $('trade-equity'), cashEl = $('trade-cash');
    const flEl = $('trade-float'), reEl = $('trade-realized');
    if (eqEl) { eqEl.textContent = fmtMoney(eq); eqEl.className = 'stat-v ' + cls(eq - E.START_CASH); }
    if (cashEl) cashEl.textContent = fmtMoney(a.cash);
    if (flEl) { flEl.textContent = fmtSigned(fl); flEl.className = 'stat-v ' + cls(fl); }
    if (reEl) { reEl.textContent = fmtSigned(a.realized); reEl.className = 'stat-v ' + cls(a.realized); }
  }

  function renderList() {
    const box = $('trade-list');
    if (!box) return;
    const rows = E.INSTRUMENTS.filter(i => i.kind === state.tab).map(inst => {
      const p = state.market.priceOf(inst.symbol);
      const chg = state.market.changePct(inst.symbol);
      return `<button type="button" class="trade-row${inst.symbol === state.selected ? ' sel' : ''}"` +
        ` data-sym="${inst.symbol}" title="${instName(inst)}">` +
        `<span class="tr-sym">${inst.symbol}</span>` +
        `<span class="tr-name">${instName(inst)}</span>` +
        `<span class="tr-px">${fmtPrice(p, inst)}</span>` +
        `<span class="tr-chg ${cls(chg)}">${fmtSigned(chg)}%</span>` +
        `</button>`;
    }).join('');
    box.innerHTML = rows;
  }

  function renderDetail() {
    const inst = instOf(state.selected);
    const sym = $('trade-symbol'), nm = $('trade-name');
    if (sym) sym.textContent = inst.symbol;
    if (nm) nm.textContent = instName(inst);
    renderQuote();
  }

  function renderQuote() {
    const inst = instOf(state.selected);
    const p = state.market.priceOf(inst.symbol);
    const chg = state.market.changePct(inst.symbol);
    const px = $('trade-price'), cg = $('trade-chg');
    if (px) px.textContent = fmtPrice(p, inst);
    if (cg) {
      cg.textContent = fmtSigned(chg) + '%';
      cg.className = 'trade-chg ' + cls(chg);
    }
  }

  function renderPositions() {
    const box = $('trade-positions');
    if (!box) return;
    const a = state.account, m = state.market;
    const syms = Object.keys(a.positions).filter(s => a.positions[s].qty);
    if (!syms.length) {
      box.innerHTML = `<p class="muted empty">${tr('tr_no_positions')}</p>`;
      return;
    }
    box.innerHTML = syms.map(sym => {
      const p = a.positions[sym];
      const inst = instOf(sym);
      const last = m.priceOf(sym);
      const pnl = (last - p.avgPrice) * p.qty;
      const sideTag = p.qty < 0 ? tr('tr_short') : tr('tr_long');
      return `<div class="pos-row" data-sym="${sym}">` +
        `<div class="pos-main"><b>${sym}</b><span class="pos-name">${instName(inst)}</span>` +
        `<span class="pos-side ${p.qty < 0 ? 'short' : 'long'}">${sideTag}</span></div>` +
        `<div class="pos-nums">` +
        `<span>${tr('tr_pos_qty')} <b>${Math.abs(p.qty)}</b></span>` +
        `<span>${tr('tr_pos_cost')} <b>${fmtPrice(p.avgPrice, inst)}</b></span>` +
        `<span>${tr('tr_pos_last')} <b>${fmtPrice(last, inst)}</b></span>` +
        `<span>${tr('tr_pos_value')} <b>${fmtMoney(p.qty * last)}</b></span>` +
        `<span class="${cls(pnl)}">${tr('tr_pos_pnl')} ${fmtSigned(pnl)}</span>` +
        `</div></div>`;
    }).join('');
  }

  function renderLog() {
    const box = $('trade-log');
    if (!box) return;
    const rows = state.account.trades;
    if (!rows.length) {
      box.innerHTML = `<p class="muted empty">${tr('tr_no_log')}</p>`;
      return;
    }
    box.innerHTML = rows.map(x => {
      const inst = instOf(x.sym);
      const side = x.side === 'buy' ? tr('tr_buy') : tr('tr_sell');
      const sideCls = x.side === 'buy' ? 'up' : 'down';
      const pnl = x.realized ? ` <span class="${cls(x.realized)}">${fmtSigned(x.realized)}</span>` : '';
      return `<div class="log-row"><span class="log-time">${fmtTime(x.ts)}</span>` +
        `<span class="${sideCls}">${side}</span>` +
        `<span>${x.qty} ${x.sym}</span>` +
        `<span>@ ${fmtPrice(x.price, inst)}</span>${pnl}</div>`;
    }).join('');
  }

  function updateOrder() {
    const inst = instOf(state.selected);
    const qty = readQty();
    const price = state.market.priceOf(inst.symbol);
    const err = check('buy', inst, qty, price);
    const est = $('trade-est');
    const buyBtn = $('trade-buy'), sellBtn = $('trade-sell');

    if (est) {
      if (!Number.isInteger(qty) || qty <= 0) {
        est.textContent = tr('tr_err_qty');
        est.className = 'trade-est warn';
      } else {
        const amount = qty * price;
        let prefix = '';
        if (err === E.ERR.NO_FUNDS) prefix = tr('tr_err_funds') + ' · ';
        else if (err === E.ERR.BAD_PRICE) prefix = tr('tr_err_price') + ' · ';
        est.textContent = prefix +
          `${qty} × ${fmtPrice(price, inst)} = ${fmtMoney(amount)} · ${tr('tr_avail')} ${fmtMoney(state.account.cash)}`;
        est.className = 'trade-est ' + (err ? 'warn' : 'muted');
      }
    }
    if (buyBtn) buyBtn.disabled = !!err;
    if (sellBtn) {
      const e2 = check('sell', inst, qty, price);
      sellBtn.disabled = !!e2;
      sellBtn.title = inst.kind === 'fx' ? tr('tr_short_hint') : '';
    }
  }

  /* ---------------- Canvas 绘图 ---------------- */

  function drawLine(cv, values, opts) {
    if (!cv || !values || values.length < 1) return;
    // 只有一个点时补一个相同的点，画成一条水平线（刚开户时资产曲线不空）
    if (values.length === 1) values = [values[0], values[0]];
    const box = cv.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) return;
    const dpr = window.devicePixelRatio || 1;
    const w = box.width, h = box.height;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padL = 62, padR = 12, padT = 12, padB = 20;
    const iw = w - padL - padR, ih = h - padT - padB;
    let lo = Infinity, hi = -Infinity;
    for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (opts.ref != null) { lo = Math.min(lo, opts.ref); hi = Math.max(hi, opts.ref); }
    if (!isFinite(lo) || !isFinite(hi)) return;
    if (hi - lo < 1e-9) {
      const d = Math.max(Math.abs(hi) * 0.001, 1e-9);
      hi += d; lo -= d;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const X = i => padL + (i / (values.length - 1)) * iw;
    const Y = v => padT + ih - ((v - lo) / (hi - lo)) * ih;

    // 网格 + 纵轴刻度
    ctx.font = '11px system-ui, -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = lo + (hi - lo) * (i / 4);
      const yy = Y(v);
      ctx.strokeStyle = 'rgba(255,255,255,.07)';
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.fillStyle = 'rgba(238,244,238,.42)';
      ctx.fillText(Number(v).toFixed(opts.digits), padL - 8, yy);
    }

    // 参考线（成本 / 初始资金）
    if (opts.ref != null) {
      const yy = Y(opts.ref);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(228,196,134,.35)';
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.setLineDash([]);
    }

    const color = opts.color || '#e4c486';

    // 面积
    const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
    grad.addColorStop(0, opts.fill || 'rgba(228,196,134,.26)');
    grad.addColorStop(1, 'rgba(228,196,134,0)');
    ctx.beginPath();
    ctx.moveTo(X(0), Y(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(X(i), Y(values[i]));
    ctx.lineTo(X(values.length - 1), padT + ih);
    ctx.lineTo(X(0), padT + ih);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 折线
    ctx.beginPath();
    ctx.moveTo(X(0), Y(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(X(i), Y(values[i]));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 末点
    const lx = X(values.length - 1), ly = Y(values[values.length - 1]);
    ctx.beginPath();
    ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // 横轴文字
    ctx.fillStyle = 'rgba(238,244,238,.42)';
    ctx.textAlign = 'left';
    ctx.fillText(tr('tr_open'), padL, h - 8);
    ctx.textAlign = 'right';
    ctx.fillText(tr('tr_now'), w - padR, h - 8);
  }

  function renderCharts() {
    if (!state.market) return;
    const inst = instOf(state.selected);
    const hist = state.market.history[inst.symbol] || [];
    const chg = state.market.changePct(inst.symbol);
    drawLine($('trade-chart'), hist, {
      digits: inst.digits,
      color: chg >= 0 ? '#7fe0a8' : '#ff8f8f',
      fill: chg >= 0 ? 'rgba(127,224,168,.24)' : 'rgba(255,143,143,.22)',
      ref: state.market.open[inst.symbol],
    });
    const eq = state.account.equityHistory;
    const last = eq.length ? eq[eq.length - 1] : E.START_CASH;
    drawLine($('trade-equity-chart'), eq, {
      digits: 0,
      color: last >= E.START_CASH ? '#e4c486' : '#ff8f8f',
      fill: 'rgba(228,196,134,.22)',
      ref: E.START_CASH,
    });
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    installTextHook();
    init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 暴露给调试 / 测试脚本用
  window.TradeUI = { open: openMarket, close: closeMarket, state };
})();
