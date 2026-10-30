# -*- coding: utf-8 -*-
"""回归：斗地主 / 掼蛋 的 AI 桥还通不通（自摸改动在 agent.js 公共路径上）。"""
import shutil, subprocess, time
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765/'
node = shutil.which('node') or 'node'

for mode in ('classic', 'guandan'):
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE, wait_until='domcontentloaded'); pg.wait_for_timeout(500)
        pg.click('label.mode-card:has(input[value=%s])' % mode)
        pg.select_option('#player-control', 'agent')
        pg.click('#btn-practice')
        pg.wait_for_timeout(1500)

        bot = subprocess.Popen([node, 'bot.mjs', '--delay', '200'], cwd=r'H:\tools\doudizhu-ai',
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                               encoding='utf-8', errors='replace')
        time.sleep(10)
        bot.terminate()
        try:
            out = bot.communicate(timeout=5)[0] or ''
        except Exception:
            out = ''
        # 日志每行前面带时间戳，所以只能查子串
        acted = sum(1 for l in out.splitlines() if '  -> ' in l)
        print('%-8s bot 动作数=%d 页面异常=%s' % (mode, acted, errs[:2] if errs else '无'))
        for l in out.splitlines()[:3]:
            print('   ', l)
        pg.screenshot(path=r'H:\tools\doudizhu-ai\reports\_regress_%s.png' % mode)
        b.close()
