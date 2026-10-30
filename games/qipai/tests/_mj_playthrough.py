# -*- coding: utf-8 -*-
"""自动打完一局麻将：用到按钮就点，遇到结算就截图。"""
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
    pg.wait_for_timeout(500)
    pg.click('label.mode-card:has(input[value=mahjong])')
    pg.click('#btn-practice')
    pg.wait_for_timeout(1200)

    shot_claim = False
    for step in range(400):
        if not pg.locator('#settle-overlay.hidden').count():
            print('结算出现，第', step, '步')
            pg.screenshot(path=OUT + r'\mj_6_settle.png')
            break

        # 胡优先
        hu = pg.locator('#actions [data-mjclaim="hu"], #actions [data-mjself="hu"]')
        if hu.count():
            print('第', step, '步：胡！')
            pg.screenshot(path=OUT + r'\mj_7_win.png')
            hu.first.click()
            pg.wait_for_timeout(800)
            pg.screenshot(path=OUT + r'\mj_6_settle.png')
            break

        claim = pg.locator('#actions [data-mjclaim]')
        if claim.count():
            if not shot_claim:
                shot_claim = True
                print('第', step, '步：出现吃碰杠选择')
                pg.screenshot(path=OUT + r'\mj_8_claim.png')
            pg.locator('#actions [data-mjclaim="pass"]').first.click()
            pg.wait_for_timeout(250)
            continue

        dis = pg.locator('#actions [data-mjdiscard]')
        if dis.count():
            tiles = pg.locator('#my-hand .mj-tile')
            if tiles.count():
                tiles.last.click()
                pg.wait_for_timeout(150)
                pg.locator('#actions [data-mjdiscard]').first.click()
                pg.wait_for_timeout(350)
                continue

        pg.wait_for_timeout(200)

    print('错误:', errors[:5] if errors else '无')
    b.close()
