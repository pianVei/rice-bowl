#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""管理员执行器。

管理员自己没有权限——GitHub 上个人仓库给不了「次一级权限」。
所以他们只能说话，由这个脚本替他们动手。判断只有一条：
**说这话的账号在不在 ADMINS 里。**

命令（写在评论的第一行，只认第一行）：

    关              关掉这张帖
    标 问梗         给这张帖打个标签
    批头衔 @xxx 名字  把 xxx 加进 TITLES

除了管理员，**社区发起人**在自己社区（带「社区:名字」标签）的帖子里也能用
`关` 和 `标`——但不能批头衔，也出不了自己那张桌子。

三道锁：
  · 不能动馆长的帖（关不了、改不了头衔）
  · 批头衔时，被批的人必须在 WHITELIST 上，而且只有管理员能批
  · 每次操作都在这张帖底下留一行字，删不掉

它永远不删任何东西。关掉能重开，删掉就没了。
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gh import rest, repo_parts  # noqa: E402
from urllib.parse import quote  # noqa: E402

OWNER = "pianvei"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RE_CLOSE = re.compile(r"^关$")
RE_LABEL = re.compile(r"^标\s+(\S.*)$")
RE_TITLE = re.compile(r"^批头衔\s+@?([A-Za-z0-9][A-Za-z0-9-]{0,38})\s+(.+)$")

MAX_TITLE_LEN = 12


def load_list(name):
    path = os.path.join(ROOT, name)
    out = set()
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            out.add(line.lower())
    return out


def load_communities():
    """COMMUNITIES 一行一个：社区名 | 发起人 | 一句话 → {"社区:名": 发起人账号}"""
    path = os.path.join(ROOT, "COMMUNITIES")
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 2 and parts[0] and parts[1]:
                out["社区:" + parts[0]] = parts[1].lower()
    return out


def say(o, n, num, text):
    """在帖子里留一行字。删不掉的那种。"""
    rest("POST", "/repos/%s/%s/issues/%d/comments" % (o, n, num), {"body": text})


def do_close(o, n, num, who):
    rest("PATCH", "/repos/%s/%s/issues/%d" % (o, n, num), {"state": "closed"})
    say(o, n, num, "🔒 管理员 @%s 关掉了这一桌。\n\n有意见就开新的一桌说。" % who)
    print("关掉了 #%d" % num)


def do_label(o, n, num, who, label):
    rest("POST", "/repos/%s/%s/issues/%d/labels" % (o, n, num), {"labels": [label]})
    say(o, n, num, "🏷 管理员 @%s 打了标签「%s」。" % (who, label))
    print("打了标签 %s" % label)


def do_title(o, n, num, who, target, title):
    wl = load_list("WHITELIST")
    if target.lower() == OWNER:
        say(o, n, num, "馆长的头衔不由管理员批。")
        print("拒绝：目标是馆长")
        return
    if target.lower() not in wl:
        say(o, n, num, "@%s 不在名单上，先过了名单再说头衔。" % target)
        print("拒绝：目标不在名单")
        return
    title = title.strip()
    if len(title) > MAX_TITLE_LEN:
        say(o, n, num, "头衔太长了（%d 字，上限 %d）。挂不住。" % (len(title), MAX_TITLE_LEN))
        return

    path = os.path.join(ROOT, "TITLES")
    lines, replaced = [], False
    with open(path, encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if s and not s.startswith("#"):
                parts = s.split(None, 1)
                if parts[0].lower() == target.lower():
                    lines.append("%s  %s\n" % (target, title))
                    replaced = True
                    continue
            lines.append(line)
    if not replaced:
        while lines and not lines[-1].strip():
            lines.pop()
        lines.append("%s  %s\n" % (target, title))

    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.writelines(lines)

    subprocess.run(["git", "config", "user.name", "rice-bowl-bot"], cwd=ROOT, check=True)
    subprocess.run(["git", "config", "user.email", "bot@users.noreply.github.com"],
                   cwd=ROOT, check=True)
    subprocess.run(["git", "add", "TITLES"], cwd=ROOT, check=True)
    subprocess.run(["git", "commit", "-m", "头衔：%s 由管理员 @%s 批准" % (target, who)],
                   cwd=ROOT, check=True)
    subprocess.run(["git", "push"], cwd=ROOT, check=True)

    say(o, n, num, "📛 管理员 @%s 批了：**@%s · %s**\n\n下次开口就挂上了。" % (who, target, title))
    print("批了头衔 %s -> %s" % (target, title))


def main():
    path = os.environ.get("GITHUB_EVENT_PATH")
    if not path or not os.path.exists(path):
        sys.exit("缺 GITHUB_EVENT_PATH")
    with open(path, encoding="utf-8") as f:
        ev = json.load(f)

    if (ev.get("action") or "") != "created":
        return
    who = ((ev.get("comment") or {}).get("user") or {}).get("login") or ""
    issue = ev.get("issue") or {}
    num = issue.get("number")
    body = (ev.get("comment") or {}).get("body") or ""

    if not who or not num or "pull_request" in issue:
        return

    admins = load_list("ADMINS")
    is_admin = who.lower() in admins

    # 不是管理员，也可能是个社区发起人——但只在自己社区的帖子里算数
    if not is_admin:
        labels = {(l.get("name") or "") for l in (issue.get("labels") or [])}
        mine = [lab for lab, owner in load_communities().items()
                if owner == who.lower() and lab in labels]
        if not mine:
            return   # 谁都不是，什么都不做，也不回嘴
        print("社区发起人 %s，自己社区：%s" % (who, ", ".join(mine)))

    # 只认第一行，避免有人复制粘贴整段话误触发
    first = ""
    for line in body.splitlines():
        if line.strip():
            first = line.strip()
            break
    if not first:
        return

    o, n = repo_parts()
    author = ((issue.get("user") or {}).get("login") or "").lower()

    if RE_CLOSE.match(first):
        if author == OWNER:
            say(o, n, num, "馆长的帖不能关。")
            print("拒绝：馆长的帖")
            return
        if (issue.get("title") or "").startswith("开社区："):
            say(o, n, num, "社区大厅不能关——关了这桌就没地方说话了。\n\n要散说一声，我来收。")
            print("拒绝：社区大厅")
            return
        do_close(o, n, num, who)
        return

    m = RE_LABEL.match(first)
    if m:
        do_label(o, n, num, who, m.group(1).strip())
        return

    m = RE_TITLE.match(first)
    if m:
        if not is_admin:
            say(o, n, num, "头衔只有管理员和馆长能批。")
            print("拒绝：社区发起人不能批头衔")
            return
        do_title(o, n, num, who, m.group(1), m.group(2))
        return

    print("不是命令：%s" % first[:40])


if __name__ == "__main__":
    main()
