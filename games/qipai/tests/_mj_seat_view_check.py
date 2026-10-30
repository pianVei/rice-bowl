# -*- coding: utf-8 -*-
"""不走 WebRTC，直接拿宿主的 buildView(1) 喂给另一个页面，
验证访客视角：只看得见自己的手牌，别人只有张数。"""
import json
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765/'
OUT = r'H:\tools\doudizhu-ai\reports'
errors = []

with sync_playwright() as p:
    b = p.chromium.launch()
    host = b.new_context().new_page()
    guest = b.new_context().new_page()
    for pg, tag in ((host, 'host'), (guest, 'guest')):
        pg.on('pageerror', lambda e, t=tag: errors.append(t + ' ' + str(e)))

    host.goto(BASE, wait_until='domcontentloaded'); host.wait_for_timeout(500)
    guest.goto(BASE, wait_until='domcontentloaded'); guest.wait_for_timeout(500)

    host.click('label.mode-card:has(input[value=mahjong])')
    host.click('#btn-practice')
    host.wait_for_timeout(1200)

    view = host.evaluate("() => App.game.buildView(1)")
    leaked = [i for i, pl in enumerate(view['players']) if 'myHand' in pl]
    print('视图里带手牌的座位 =', leaked, '(应为空)')
    print('座位 1 手牌张数 =', len(view['myHand']), 'view.mySeat =', view['mySeat'])

    guest.goto(BASE, wait_until='load'); guest.wait_for_timeout(400)
    guest.evaluate("(v) => { App.started = true; App.view = v; showScreen('screen-game'); renderGame(); }",
                   json.loads(json.dumps(view)))
    guest.wait_for_timeout(600)

    hand = guest.locator('#my-hand .mj-tile').count()
    opp = guest.locator('.mj-opp').count()
    chips = guest.locator('#center-info').inner_text().replace('\n', ' ')
    print('访客渲染：手牌=%d 对家面板=%d 顶栏=%s' % (hand, opp, chips[:40]))
    guest.screenshot(path=OUT + r'\mj_13_guest_view.png')
    print('错误 =', errors[:4] if errors else '无')
    b.close()
