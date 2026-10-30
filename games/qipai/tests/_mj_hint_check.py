# -*- coding: utf-8 -*-
"""验证「提示」按钮和一键选牌。"""
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
    pg.wait_for_timeout(1200)

    hint = pg.locator('#actions [data-mjhint]')
    print('提示按钮存在 =', hint.count())
    if hint.count():
        hint.first.click()
        pg.wait_for_timeout(400)
        selected = pg.locator('#my-hand .mj-tile.sel').count()
        print('被选中的牌 =', selected)
        enabled = pg.locator('#actions [data-mjdiscard]').first.is_enabled()
        print('打出按钮可用 =', enabled)
        pg.screenshot(path=OUT + r'\mj_10_hint.png')

    print('错误 =', errors[:5] if errors else '无')
    b.close()
