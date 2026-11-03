# -*- coding: utf-8 -*-
"""太鼓房 —— 几个人各开各的机器，同一秒开同一首歌。

没有服务器：房间就是一串码，发到群里，谁都能进。
码里写着「哪首歌、哪个难度、几点几分几秒开」。

用法：

    # 开房（60 秒后开始）
    python taiko_room.py host --song BLRINK --level Oni --in 60

    # 进房（把别人发的码贴进来）
    python taiko_room.py join TAIKO1-eyJzb25nIjoiQkxSSU5LIiwi...

    # 进房并且让脚本替我打 2P
    python taiko_room.py join <码> --play 2

注意：
    · 进房前先在游戏里把歌选好、停在难度那一屏，脚本会在开赛那一刻替你按下去
    · 两台机器的系统时间要对（Windows 默认自动同步，一般差不了几秒）
    · 游戏从按下到出声有约 1.8 秒，可以用 --intro 调
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import taiko_autoplay as ta  # noqa: E402

ENTER = 28


def encode(room):
    raw = json.dumps(room, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return "TAIKO1-" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode(code):
    body = code.strip()
    if body.startswith("TAIKO1-"):
        body = body[len("TAIKO1-"):]
    body += "=" * (-len(body) % 4)
    return json.loads(base64.urlsafe_b64decode(body.encode()).decode("utf-8"))


def fmt(ts):
    return time.strftime("%H:%M:%S", time.localtime(ts))


def cmd_host(a):
    start = time.time() + a.ins
    room = {"song": a.song, "level": a.level, "start": round(start, 1),
            "host": a.name}
    code = encode(room)
    print("房间码（发到群里）：\n%s\n" % code)
    print("曲目：%s  难度：%s" % (a.song, a.level))
    print("开始时间：%s（还有 %d 秒）" % (fmt(start), a.ins))
    print("别人：python taiko_room.py join <码>")
    return 0


def cmd_join(a):
    room = decode(a.code)
    start, song, level = room["start"], room["song"], room["level"]
    print("房间：%s / %s，%s 开始" % (song, level, fmt(start)))
    left = start - time.time()
    if left < 0:
        print("已经过了 %.0f 秒，仍按对方的时刻对齐" % -left)

    while True:
        left = start - time.time()
        if left <= 0:
            break
        if left > 5:
            print("还有 %d 秒" % int(left), flush=True)
            time.sleep(min(left - 1, 5))
        else:
            time.sleep(0.01)

    print("开！", flush=True)
    ta._send(ENTER)
    time.sleep(0.03)
    ta._send(ENTER, up=True)

    if not a.play:
        print("按下去了，接下来你自己打")
        return 0

    t0 = start + a.intro
    path = a.tja or (ta.find_songs(song)[0] if ta.find_songs(song) else None)
    if not path:
        print("本机没有这首歌：%s" % song)
        return 1
    events, bpm, course, header = ta.parse_tja(path, level)
    if not events:
        print("谱面读不出来")
        return 1
    keys = ta.P1 if a.play == 1 else ta.P2
    print("我开始打 %dP：%s %s，%d 个事件" % (a.play, header.get("TITLE"), course, len(events)))
    try:
        ta.run(events, keys, t0, a.offset)
    except KeyboardInterrupt:
        print("\n停了")
    print("打完")
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")

    h = sub.add_parser("host")
    h.add_argument("--song", required=True)
    h.add_argument("--level", default="Oni")
    h.add_argument("--in", dest="ins", type=int, default=60)
    h.add_argument("--name", default="肥鱼")

    j = sub.add_parser("join")
    j.add_argument("code")
    j.add_argument("--play", type=int, default=0, choices=[0, 1, 2])
    j.add_argument("--intro", type=float, default=1.8)
    j.add_argument("--offset", type=float, default=0.0)
    j.add_argument("--tja", default=None)

    a = ap.parse_args()
    if a.cmd == "host":
        return cmd_host(a)
    if a.cmd == "join":
        return cmd_join(a)
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
