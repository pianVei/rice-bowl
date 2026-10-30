# -*- coding: utf-8 -*-
"""AI 身份 + bot.mjs：验证外部 AI 只靠结构化数据就能打麻将。"""
import shutil, subprocess, time, sys
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765/'
errors = []

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1280, 'height': 860})
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

    pg.goto(BASE, wait_until='domcontentloaded'); pg.wait_for_timeout(600)
    pg.click('label.mode-card:has(input[value=mahjong])')
    pg.select_option('#player-control', 'agent')
    pg.click('#btn-practice')
    pg.wait_for_timeout(1500)

    print('AI 面板可见 =', pg.locator('#agent-panel:not(.hidden)').count())

    node = shutil.which('node') or 'node'
    print('node =', node)
    bot = subprocess.Popen([node, 'bot.mjs', '--delay', '200'],
                           cwd=r'H:\tools\doudizhu-ai',
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                           encoding='utf-8', errors='replace')
    time.sleep(18)
    bot.terminate()
    try:
        out = bot.communicate(timeout=5)[0]
    except Exception:
        out = ''

    print('--- bot 输出 ---')
    for line in (out or '').splitlines()[:18]:
        print(line)

    discards = pg.evaluate("() => App.view ? App.view.players.map(p => p.discards.length) : null")
    hand = pg.locator('#my-hand .mj-tile').count()
    print('各家牌河张数 =', discards, ' 我的手牌 =', hand)
    pg.screenshot(path=r'H:\tools\doudizhu-ai\reports\mj_15_bot.png')
    print('错误 =', errors[:4] if errors else '无')
    b.close()
