# -*- coding: utf-8 -*-
"""造一手听牌，确认「听」的牌面和剩余张数显示正常。"""
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765/'
OUT = r'H:\tools\doudizhu-ai\reports'
errors = []

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1280, 'height': 860})
    pg.on('pageerror', lambda e: errors.append(str(e)))

    pg.goto(BASE, wait_until='domcontentloaded'); pg.wait_for_timeout(600)
    pg.click('label.mode-card:has(input[value=mahjong])')
    pg.click('#btn-practice')
    pg.wait_for_timeout(1200)

    pg.evaluate("""() => {
      const g = App.game;
      // 听 5筒 / 9筒 的一手牌
      const kinds = [0,1,2,3,4,5,6,7,8, 9,10,11, 22, 26];
      g.hands[0] = kinds.map((k, i) => ({ k, id: 8000 + i }));
      g.drawnTile = g.hands[0][13];
      g.turn = 0; g.phase = 'discard';
      App.view = g.buildView(0);
      renderGame();
    }""")
    pg.wait_for_timeout(400)

    ting = pg.locator('.mj-ting')
    print('听牌提示存在 =', ting.count())
    if ting.count():
        print('内容 =', ting.first.inner_text().replace('\n', ' '))
    pg.screenshot(path=OUT + r'\mj_14_ting.png')
    print('错误 =', errors[:3] if errors else '无')
    b.close()
