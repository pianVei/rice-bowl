# -*- coding: utf-8 -*-
"""模拟交易 Playwright 实测：
进模拟交易 → 买 100 股 → 等价格变动 → 卖出 → 资产变化，
外加外汇做空、超买拦截、重置账户，并截图到 reports/。
跑法：PYTHONIOENCODING=utf-8 python tests/_trade_e2e.py
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8765/index.html"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORTS = os.path.join(ROOT, "reports")
os.makedirs(REPORTS, exist_ok=True)

errors = []
checks = []


def check(name, cond, detail=""):
    checks.append((name, bool(cond), detail))
    print(("  PASS  " if cond else "  FAIL  ") + name + (("  — " + str(detail)) if detail else ""))


def money(text):
    return float(text.replace(",", "").strip())


def state(page):
    return page.evaluate("() => ({"
                         "cash: TradeUI.state.account.cash,"
                         "realized: TradeUI.state.account.realized,"
                         "qty: TradeUI.state.account.qtyOf(TradeUI.state.selected),"
                         "selected: TradeUI.state.selected,"
                         "positions: Object.fromEntries(Object.keys(TradeUI.state.account.positions)"
                         "  .map(s => [s, TradeUI.state.account.positions[s].qty])),"
                         "prices: Object.fromEntries(TradeEngine.INSTRUMENTS.map(i => [i.symbol, TradeUI.state.market.priceOf(i.symbol)])),"
                         "trades: TradeUI.state.account.trades.slice(0, 3)"
                         "})")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1280, "height": 1000}, service_workers="block")
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        page.on("console", lambda m: errors.append("console." + m.type + ": " + m.text)
                if m.type == "error" else None)

        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_timeout(1200)

        # ---------- 首页入口 ----------
        check("首页存在模拟交易卡片", page.locator("#btn-trade").count() == 1)
        check("卡片标题文案", "模拟交易" in page.locator("#t-mtrade").inner_text(),
              page.locator("#t-mtrade").inner_text())
        page.screenshot(path=os.path.join(REPORTS, "trade_01_home.png"), full_page=True)

        # ---------- 进入 ----------
        page.click("#btn-trade")
        page.wait_for_selector("#screen-trade.active", timeout=5000)
        page.wait_for_timeout(800)
        check("进入交易界面", page.locator("#screen-trade.active").count() == 1)
        disclaimer = page.locator("#t-trade-disclaimer").inner_text()
        check("免责声明文案", "模拟盘" in disclaimer and "随机生成" in disclaimer and "真实市场无关" in disclaimer,
              disclaimer)

        ins = page.evaluate("""() => {
            const stocks = TradeEngine.INSTRUMENTS.filter(i => i.kind === 'stock');
            const fx = TradeEngine.INSTRUMENTS.filter(i => i.kind === 'fx');
            return { stocks: stocks.length, fx: fx.length, sym: stocks.map(i => i.symbol) };
        }""")
        check("6+ 股票 / 4 外汇", ins["stocks"] >= 6 and ins["fx"] >= 4, ins)

        cash0 = money(page.locator("#trade-cash").inner_text())
        equity0 = money(page.locator("#trade-equity").inner_text())
        check("初始资金 100,000", abs(cash0 - 100000) < 0.01, cash0)
        check("初始总资产 100,000", abs(equity0 - 100000) < 0.01, equity0)

        # 图表画布真的画了东西
        painted = page.evaluate("""() => {
            const c = document.getElementById('trade-chart');
            return { w: c.width, h: c.height, visible: c.getBoundingClientRect().height > 100 };
        }""")
        check("Canvas 分时图已渲染", painted["w"] > 100 and painted["h"] > 100 and painted["visible"], painted)
        page.screenshot(path=os.path.join(REPORTS, "trade_02_initial.png"), full_page=True)

        # ---------- 买 100 股 ----------
        page.click("#trade-list .trade-row[data-sym='XLTK']")
        page.fill("#trade-qty", "100")
        page.wait_for_timeout(150)
        before = state(page)
        page.click("#trade-buy")
        page.wait_for_timeout(500)
        after = state(page)
        fill = after["trades"][0] if after["trades"] else None
        check("买入成交", after["qty"] == 100 and fill and fill["side"] == "buy",
              {"qty": after["qty"], "fill": fill})
        expected_cash = before["cash"] - 100 * fill["price"]
        check("买入后现金 = 原现金 - 100 × 成交价", abs(after["cash"] - expected_cash) < 1e-6,
              {"before": before["cash"], "after": after["cash"], "expected": expected_cash})
        check("持仓行出现 100 股", "100" in page.locator("#trade-positions").inner_text())
        msg = page.locator("#trade-msg").inner_text()
        check("成交提示", "买入" in msg and "XLTK" in msg and "undefined" not in msg, msg)
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(REPORTS, "trade_03_after_buy.png"), full_page=True)

        # ---------- 等价格真正变动 ----------
        buy_px = fill["price"]
        changed_px = buy_px
        deadline = time.time() + 12
        while time.time() < deadline:
            page.wait_for_timeout(400)
            cur = page.evaluate("() => TradeUI.state.market.priceOf('XLTK')")
            if abs(cur - buy_px) > 1e-9:
                changed_px = cur
                break
        check("行情 tick 后价格发生变动", abs(changed_px - buy_px) > 1e-9,
              {"buy": buy_px, "now": changed_px})

        # ---------- 卖出 100 股 ----------
        before_sell = state(page)
        page.click("#trade-sell")
        page.wait_for_timeout(500)
        sold = state(page)
        fill2 = sold["trades"][0] if sold["trades"] else None
        check("卖出成交", sold["qty"] == 0 and fill2 and fill2["side"] == "sell",
              {"qty": sold["qty"], "fill": fill2})
        sell_px = fill2["price"]
        expected_cash2 = before_sell["cash"] + 100 * sell_px
        check("卖出回款 = 现金 + 100 × 卖价", abs(sold["cash"] - expected_cash2) < 1e-6,
              {"before": before_sell["cash"], "after": sold["cash"], "expected": expected_cash2})
        expected_realized = (sell_px - buy_px) * 100
        check("已实现盈亏 = (卖价 - 买价) × 100",
              abs(sold["realized"] - expected_realized) < 1e-6,
              {"realized": sold["realized"], "expected": expected_realized})
        check("资产随价格变动", abs(sold["cash"] - 100000) > 1e-9,
              {"cash": sold["cash"], "diff": sold["cash"] - 100000})
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(REPORTS, "trade_04_after_sell.png"), full_page=True)

        # ---------- 超额买入被拦截 ----------
        page.fill("#trade-qty", "9999999")
        page.wait_for_timeout(200)
        disabled = page.locator("#trade-buy").is_disabled()
        check("资金不足时买入按钮禁用", disabled, disabled)
        est = page.locator("#trade-est").inner_text()
        check("资金不足提示", "资金" in est or "现金" in est, est)

        # ---------- 外汇做空 ----------
        page.click(".trade-tab[data-tab='fx']")
        page.wait_for_timeout(200)
        page.click("#trade-list .trade-row[data-sym='EURUSD']")
        page.fill("#trade-qty", "1000")
        page.wait_for_timeout(150)
        before_short = state(page)
        page.click("#trade-sell")
        page.wait_for_timeout(500)
        shorted = state(page)
        check("外汇无持仓可卖出开空", shorted["qty"] == -1000, shorted["qty"])
        check("开空后现金增加", shorted["cash"] > before_short["cash"],
              {"before": before_short["cash"], "after": shorted["cash"]})
        check("空头方向标记", "空" in page.locator("#trade-positions").inner_text(),
              page.locator("#trade-positions").inner_text()[:80])
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(REPORTS, "trade_05_fx_short.png"), full_page=True)

        # ---------- 刷新后 localStorage 不丢 ----------
        saved_cash = shorted["cash"]
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(800)
        page.click("#btn-trade")
        page.wait_for_timeout(600)
        persisted = state(page)
        check("刷新后现金不丢", abs(persisted["cash"] - saved_cash) < 1e-6,
              {"saved": saved_cash, "loaded": persisted["cash"]})
        check("刷新后持仓不丢", persisted["positions"].get("EURUSD") == -1000,
              persisted["positions"])
        check("刷新后成交记录不丢", len(persisted["trades"]) >= 1, len(persisted["trades"]))

        # 平空
        page.click(".trade-tab[data-tab='fx']")
        page.wait_for_timeout(200)
        page.click("#trade-list .trade-row[data-sym='EURUSD']")
        page.fill("#trade-qty", "1000")
        page.click("#trade-buy")
        page.wait_for_timeout(500)
        check("买入平空后持仓归零", state(page)["qty"] == 0, state(page)["qty"])

        # ---------- 重置 ----------
        page.once("dialog", lambda d: d.accept())
        page.click("#trade-reset")
        page.wait_for_timeout(500)
        reset = state(page)
        check("重置回到 100,000", abs(reset["cash"] - 100000) < 0.01, reset["cash"])
        check("重置清空持仓", reset["qty"] == 0, reset["qty"])
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(REPORTS, "trade_06_reset.png"), full_page=True)

        # ---------- 英文切换 ----------
        page.click("#trade-lang")
        page.wait_for_timeout(400)
        en_disc = page.locator("#t-trade-disclaimer").inner_text()
        check("英文文案切换", "Simulated market" in en_disc, en_disc)
        page.screenshot(path=os.path.join(REPORTS, "trade_07_en.png"), full_page=True)
        page.click("#trade-lang")
        page.wait_for_timeout(200)

        # ---------- 移动端布局 ----------
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(600)
        page.screenshot(path=os.path.join(REPORTS, "trade_08_mobile.png"), full_page=True)

        # ---------- 返回首页 ----------
        page.click("#trade-back")
        page.wait_for_timeout(300)
        check("返回首页", page.locator("#screen-home.active").count() == 1)

        # ---------- 回归：原有牌局仍能正常开局 ----------
        page.set_viewport_size({"width": 1280, "height": 1000})
        page.wait_for_timeout(300)
        page.click("#btn-practice")
        page.wait_for_selector("#screen-game.active", timeout=10000)
        page.wait_for_timeout(1500)
        check("斗地主仍能开局", page.locator("#my-hand .card").count() > 0,
              page.locator("#my-hand .card").count())
        page.screenshot(path=os.path.join(REPORTS, "trade_09_game_smoke.png"))

        ctx.close()
        browser.close()

    print("\n===== 结果 =====")
    failed = [c for c in checks if not c[1]]
    print("检查项: %d 通过 / %d 失败" % (len(checks) - len(failed), len(failed)))
    print("控制台错误: %d" % len(errors))
    for e in errors:
        print("  " + e)
    if failed:
        for c in failed:
            print("  FAILED: " + c[0] + " " + str(c[2]))
        sys.exit(1)
    if errors:
        print("存在控制台错误，按验收要求判定失败")
        sys.exit(2)
    print("ALL CHECKS PASSED, console clean")


if __name__ == "__main__":
    main()
