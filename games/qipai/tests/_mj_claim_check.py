# -*- coding: utf-8 -*-
"""强行造一个「可以吃碰」的局面，验证副露 UI 和碰牌流程。"""
from playwright.sync_api import sync_playwright

OUT = r'H:\tools\doudizhu-ai\reports'
BASE = 'http://127.0.0.1:8765/'
errors = []

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1280, 'height': 860})
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

    pg.goto(BASE, wait_until='load')
    pg.wait_for_timeout(400)
    pg.click('label.mode-card:has(input[value=mahjong])')
    pg.click('#btn-practice')
    pg.wait_for_timeout(1000)

    pg.evaluate("""() => {
      const g = App.game;
      // 手里塞两张 1 万，让「碰」成为合法选项
      g.hands[0][0] = { k: 0, id: 9001 };
      g.hands[0][1] = { k: 0, id: 9002 };
      const tile = { k: 0, id: 9003 };
      g.phase = 'claim';
      g.pending = { tile, from: 1 };
      g.discards[1].push(tile);
      g.claims = { 0: null, 1: 'pass', 2: 'pass', 3: 'pass' };
      g.awaiting = [0];
      g.claimOpts = { 0: g.claimOptions(0, tile, 1) };
      App.view = g.buildView(0);
      renderGame();
    }""")
    pg.wait_for_timeout(400)
    pg.screenshot(path=OUT + r'\mj_8_claim.png')

    note = pg.locator('#actions').inner_text()
    print('可选项 =', repr(note[:60]))

    pung = pg.locator('#actions [data-mjclaim="pung"]')
    print('碰按钮存在 =', pung.count())
    if pung.count():
        pung.first.click()
        pg.wait_for_timeout(700)
        pg.screenshot(path=OUT + r'\mj_9_pung.png')
        exposed = pg.locator('#my-lastplay .mj-meld .mj-tile').count()
        print('副露张数 =', exposed)

    print('错误 =', errors[:5] if errors else '无')
    b.close()
