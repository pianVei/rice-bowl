# -*- coding: utf-8 -*-
"""起无头浏览器，走一遍麻将的界面：选模式 -> 单机练习 -> 出牌 -> 截图。"""
import sys
from playwright.sync_api import sync_playwright

OUT = r'H:\tools\doudizhu-ai\reports'
BASE = 'http://127.0.0.1:8765/'

errors = []

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1280, 'height': 860})
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append('PAGEERROR ' + str(e)))

    pg.goto(BASE, wait_until='load')
    pg.wait_for_timeout(600)
    pg.screenshot(path=OUT + r'\mj_1_home.png')

    # 选麻将（radio 被样式藏起来了，点卡片）
    pg.click('label.mode-card:has(input[value=mahjong])')
    pg.wait_for_timeout(200)
    pg.screenshot(path=OUT + r'\mj_2_mode.png')

    # 单机练习
    pg.click('#btn-practice')
    pg.wait_for_timeout(1500)
    pg.screenshot(path=OUT + r'\mj_3_table.png')

    hand = pg.locator('#my-hand .mj-tile').count()
    actions = pg.locator('#actions').inner_text()
    print('手牌张数 =', hand)
    print('操作区 =', repr(actions[:80]))

    # 点第一张牌 -> 打出
    if hand:
        pg.locator('#my-hand .mj-tile').first.click()
        pg.wait_for_timeout(300)
        pg.screenshot(path=OUT + r'\mj_4_selected.png')
        btn = pg.locator('#actions [data-mjdiscard]')
        if btn.count():
            print('打出按钮可用 =', btn.first.is_enabled())
            btn.first.click()
            pg.wait_for_timeout(1200)
            pg.screenshot(path=OUT + r'\mj_5_after_discard.png')
            print('打出后手牌 =', pg.locator('#my-hand .mj-tile').count())

    print('控制台错误 =', errors[:6] if errors else '无')
    b.close()
