# -*- coding: utf-8 -*-
"""联网联调：一个窗口建房，另一个窗口加入，双方各看各的手牌。"""
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765/'
errors = []

with sync_playwright() as p:
    b = p.chromium.launch()
    host = b.new_context().new_page()
    guest = b.new_context().new_page()
    for pg, tag in ((host, 'host'), (guest, 'guest')):
        pg.on('pageerror', lambda e, t=tag: errors.append(t + ' PAGEERROR ' + str(e)))
        pg.on('console', lambda m, t=tag: errors.append(t + ' ' + m.text) if m.type == 'error' else None)

    host.goto(BASE, wait_until='load'); host.wait_for_timeout(400)
    guest.goto(BASE, wait_until='load'); guest.wait_for_timeout(400)

    host.click('label.mode-card:has(input[value=mahjong])')
    host.fill('#inp-name', '房主')
    host.click('#btn-create')
    host.wait_for_timeout(14000)

    code = host.locator('#room-code').inner_text().strip()
    print('房间码 =', repr(code))
    print('提示条 =', repr(host.locator('#toast-wrap').inner_text().replace('\n', '|')[:80]))
    print('PeerJS 已加载 =', host.evaluate("typeof Peer !== 'undefined'"))

    if not code:
        print('建房失败，错误：', errors[:6])
        b.close()
        raise SystemExit

    guest.fill('#inp-name', '客人')
    guest.fill('#inp-code', code)
    guest.click('#btn-join')
    guest.wait_for_timeout(14000)

    print('客人提示条 =', repr(guest.locator('#toast-wrap').inner_text().replace('\n', '|')[:80]))
    print('客人房间页 =', repr(guest.locator('#screen-room').get_attribute('class')))
    print('客人 peer 打开 =', guest.evaluate("!!(window.App && App.peer && App.peer.open)"))
    print('客人 conn =', guest.evaluate("!!(window.App && App.guestConn)"))
    print('房主名册 =', repr(host.locator('#room-players').inner_text().replace('\n', '|')[:60]))

    host.click('#btn-start')
    host.wait_for_timeout(3000)

    for pg, tag in ((host, 'host'), (guest, 'guest')):
        active = pg.locator('#screen-game.active').count()
        hand = pg.locator('#my-hand .mj-tile').count()
        chips = pg.locator('#center-info').inner_text().replace('\n', ' ')
        print('%s: 进对局=%s 手牌=%s 顶栏=%s' % (tag, active, hand, chips[:40]))

    host.screenshot(path=r'H:\tools\doudizhu-ai\reports\mj_11_host.png')
    guest.screenshot(path=r'H:\tools\doudizhu-ai\reports\mj_12_guest.png')
    print('错误 =', errors[:6] if errors else '无')
    b.close()
