# -*- coding: utf-8 -*-
"""OpenTaiko 自动打鼓 —— 读 .tja，按节拍敲指定玩家的键。

    1. 开游戏，进到选曲，选好歌和难度
    2. 歌第一拍响的时候按 F8 报时
    3. 脚本从 F8 那一刻起按谱面敲

用法：
    python taiko_autoplay.py --list
    python taiko_autoplay.py --song BLRINK              # 默认敲 2P
    python taiko_autoplay.py --tja x.tja --player 1
    python taiko_autoplay.py --song BLRINK --offset -0.05
    python taiko_autoplay.py --song BLRINK --dry        # 只看谱面
    python taiko_autoplay.py --song BLRINK --level Oni  # 指定难度

键位（Config.ini 默认）：
    1P: Tab / R 红，= / T 蓝
    2P: 0 / I 红，- / V 蓝
"""
import argparse
import ctypes
import glob
import os
import re
import sys
import time
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
SONGS = os.path.join(HERE, "app", "publish", "Songs")

SC = {"Tab": 15, "R": 19, "=": 13, "T": 20,
      "0": 11, "I": 23, "-": 12, "V": 47}
P1 = {"red": ["Tab", "R"], "blue": ["=", "T"]}
P2 = {"red": ["0", "I"], "blue": ["-", "V"]}

ROLL_GAP = 0.07          # 连打间隔（秒）
HOLD = 0.012             # 每次按下到抬起的间隔

# ---------------------------------------------------------------- 按键
user32 = ctypes.WinDLL("user32", use_last_error=True)
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG))]


class _U(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("pad", ctypes.c_byte * 32)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _U)]


def _send(scan, up=False):
    i = INPUT(type=INPUT_KEYBOARD)
    i.u.ki.wVk = 0
    i.u.ki.wScan = scan
    i.u.ki.dwFlags = KEYEVENTF_SCANCODE | (KEYEVENTF_KEYUP if up else 0)
    i.u.ki.time = 0
    i.u.ki.dwExtraInfo = None
    user32.SendInput(1, ctypes.byref(i), ctypes.sizeof(INPUT))


def tap(names, hold=HOLD):
    for n in names:
        _send(SC[n])
    time.sleep(hold)
    for n in names:
        _send(SC[n], up=True)


# ---------------------------------------------------------------- TJA
SLOT_OF = {(4, 4): 16, (3, 4): 12, (6, 8): 12, (2, 4): 8, (5, 4): 20,
           (7, 8): 14, (8, 4): 32, (12, 8): 24, (9, 8): 18, (3, 8): 6}


def parse_tja(path, course=None):
    """-> (events, bpm, course_name, header)

    events: [(秒, 类型, 子类)]
    类型：red / blue / bigred / bigblue / roll_start / roll_end
    """
    text = open(path, encoding="utf-8", errors="replace").read().replace("\r", "").lstrip("﻿")
    lines = text.split("\n")

    header, blocks = {}, []
    bpm, measure, offset = 120.0, (4, 4), 0.0
    in_body, cur_course, cur_bpm = False, None, 120.0
    t, notes = 0.0, []

    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        if line.startswith("#"):
            cmd = line.upper()
            m = re.match(r"#BPMCHANGE\s+(-?[\d.]+)", cmd)
            if m:
                bpm = float(m.group(1)); continue
            m = re.match(r"#MEASURE\s+(\d+)/(\d+)", cmd)
            if m:
                measure = (int(m.group(1)), int(m.group(2))); continue
            m = re.match(r"#OFFSET\s+(-?[\d.]+)", cmd)
            if m:
                offset = float(m.group(1)); continue
            if cmd.startswith("#START"):
                in_body, t, notes = True, 0.0, []
                continue
            if cmd.startswith("#END"):
                if in_body:
                    blocks.append((cur_course, notes))
                in_body = False
                continue
            continue
        if not in_body:
            if ":" in line:
                k, v = line.split(":", 1)
                k = k.strip().upper()
                header.setdefault(k, v.strip())
                if k == "COURSE":
                    cur_course = v.strip()
                elif k == "BPM":
                    try:
                        bpm = float(v.strip())
                    except ValueError:
                        pass
            continue

        slots = SLOT_OF.get(measure, measure[0] * 16 // measure[1])
        dur = (measure[0] / measure[1]) * 4.0 * 60.0 / bpm
        step = dur / max(slots, 1)
        for seg in line.split(","):
            for idx, ch in enumerate(seg):
                ts = t + idx * step
                if ch == "1":
                    notes.append((ts, "red", None))
                elif ch == "2":
                    notes.append((ts, "blue", None))
                elif ch == "3":
                    notes.append((ts, "bigred", None))
                elif ch == "4":
                    notes.append((ts, "bigblue", None))
                elif ch == "5":
                    notes.append((ts, "roll_start", "red"))
                elif ch == "6":
                    notes.append((ts, "roll_end", "red"))
                elif ch == "7":
                    notes.append((ts, "roll_start", "blue"))
                elif ch == "8":
                    notes.append((ts, "roll_end", "blue"))
            t += dur

    if not blocks:
        return [], bpm, None, header
    want = (course or header.get("COURSE") or "Oni").lower()
    pick = next(((c, ns) for c, ns in blocks if (c or "").lower() == want), None)
    if pick is None:
        pick = max(blocks, key=lambda x: len(x[1]))
    used, ns = pick
    ns.sort()
    # OFFSET 是音频相对谱面的偏移；谱面时间 - offset = 歌里的时间
    ev = [(x[0] - offset, x[1], x[2]) for x in ns]
    return ev, bpm, used, header


def find_songs(name=""):
    pat = os.path.join(SONGS, "**", "*.tja")
    hits = sorted(glob.glob(pat, recursive=True))
    if name:
        hits = [p for p in hits if name.lower() in p.lower()]
    return hits


# ---------------------------------------------------------------- 主流程
def wait_sync_key(key=0x77):  # F8
    print("等 F8……（歌第一拍响的时候按一下）")
    while True:
        if user32.GetAsyncKeyState(key) & 0x8000:
            while user32.GetAsyncKeyState(key) & 0x8000:
                time.sleep(0.005)
            return time.perf_counter()
        time.sleep(0.002)


def run(events, keys, t0, offset, dry=False):
    idx = 0
    roll_until = None
    roll_side = "red"
    last_roll = 0.0
    n = len(events)
    while idx < n or roll_until:
        now = time.perf_counter()
        if roll_until and now >= roll_until:
            roll_until = None

        if roll_until:
            # 连打：到点就补一下，别和下一个音符抢
            if now - last_roll >= ROLL_GAP:
                tap([keys[roll_side][0]], 0.008)
                last_roll = now
            if idx < n:
                ts = t0 + events[idx][0] + offset
                if ts - now < 0.02:
                    pass
                else:
                    time.sleep(0.005)
                    continue
            else:
                time.sleep(0.005)
                continue

        if idx >= n:
            break
        ts, kind, sub = events[idx]
        target = t0 + ts + offset
        left = target - now
        if left > 0.02:
            time.sleep(min(left - 0.015, 0.05))
            continue
        if left > 0:
            time.sleep(max(left, 0))

        if kind == "roll_start":
            roll_side = sub or "red"
            roll_until = target + 0.4
            last_roll = 0
            idx += 1
            continue
        if kind == "roll_end":
            roll_until = None
            idx += 1
            continue

        if kind in ("bigred", "bigblue"):
            tap(keys["red" if kind == "bigred" else "blue"])
        else:
            tap([keys[kind][idx % 2]])
        idx += 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tja")
    ap.add_argument("--song")
    ap.add_argument("--player", type=int, default=2)
    ap.add_argument("--level")
    ap.add_argument("--offset", type=float, default=0.0)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()

    if a.list:
        for p in find_songs():
            print(os.path.relpath(os.path.dirname(p), SONGS))
        return 0

    path = a.tja
    if not path and a.song:
        hits = find_songs(a.song)
        if not hits:
            print("没找到：%s" % a.song)
            return 1
        path = hits[0]
        print("用：%s" % os.path.basename(path))
    if not path or not os.path.exists(path):
        print("给 --tja 或 --song（--list 看有哪些）")
        return 1

    events, bpm, course, header = parse_tja(path, a.level)
    if not events:
        print("谱面是空的，换一个难度试试")
        return 1
    print("%s | %s | %d 个事件 | BPM %.0f | %.1f 秒" % (
        header.get("TITLE", "?"), course, len(events), bpm, events[-1][0]))
    keys = P1 if a.player == 1 else P2
    if a.dry:
        for e in events[:12]:
            print(e)
        return 0

    t0 = wait_sync_key()
    print("开始，%d 秒的谱" % int(events[-1][0]))
    try:
        run(events, keys, t0, a.offset)
    except KeyboardInterrupt:
        print("\n停了")
    print("打完")
    return 0


if __name__ == "__main__":
    sys.exit(main())
