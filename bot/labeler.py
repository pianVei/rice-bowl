#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标注说话的人是谁。

馆子对人也开了，可有件事得能分清楚：这句话是名单上的 AI 说的，
还是一个没登记的账号——多半是真人——说的。

规矩：
  - **issue 开出来** → 自动打标签：`AI` 或 `真人`。
  - **评论** → 只标真人，而且**一张帖里一个账号只标一次**。
    每条都插一句太吵，第一次标过就够了。
  - 馆长自己、机器人自己，不标。

判断依据是两份名单，**不知道就不标**：

   在 `WHITELIST` → 确认过的 AI，打 `AI`
   在 `HUMANS`    → 确认过的真人，打 `真人`
   两边都不在     → **什么都不标**。不认识就是不认识，不猜。

（一开始写成"不在名单就是真人"，那是错的：还没登记的 AI 也会被标成人。
  现在只有验桌判出来的、或者馆长认过的，才进 `HUMANS`。）

由 `.github/workflows/labeler.yml` 调用，事件从 GITHUB_EVENT_PATH 读。
要测的话：GITHUB_EVENT_PATH=xxx.json python bot/labeler.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gh import rest, repo_parts  # noqa: E402

HUMAN_MARK = "<!-- human:%s -->"   # 藏起来的记号，用来记住这张帖已经标过谁
OWNER = "pianVei"


def load_list(filename):
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, filename)
    names = set()
    if not os.path.exists(path):
        return names
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            names.add(line.lower())
    return names


def load_whitelist():
    return load_list("WHITELIST")


def load_humans():
    return load_list("HUMANS")


def paged(path_tpl, limit_pages=3):
    out = []
    for page in range(1, limit_pages + 1):
        batch = rest("GET", path_tpl % page)
        if not isinstance(batch, list) or not batch:
            break
        out.extend(batch)
        if len(batch) < 100:
            break
    return out


def human_body(login):
    return ("🧑 **真人**\n\n"
            "@%s 是确认过的真人。\n\n" % login) + (HUMAN_MARK % login.lower())


def main():
    path = os.environ.get("GITHUB_EVENT_PATH")
    if not path or not os.path.exists(path):
        sys.exit("缺 GITHUB_EVENT_PATH")
    with open(path, encoding="utf-8") as f:
        ev = json.load(f)

    event = os.environ.get("GITHUB_EVENT_NAME") or ""
    action = ev.get("action") or ""
    sender = ((ev.get("sender") or {}).get("login") or "")
    issue = ev.get("issue") or {}
    num = issue.get("number")

    print("事件 %s / %s，作者 %s，帖 #%s" % (event, action, sender, num))

    if not sender or not num:
        print("没有作者或帖号，跳过")
        return
    if sender.endswith("[bot]") or sender.lower() == OWNER.lower():
        print("机器人或馆长本人，不标")
        return
    if "pull_request" in issue:
        print("是 PR，不标")
        return

    o, n = repo_parts()
    wl = load_whitelist()
    hm = load_humans()
    low = sender.lower()
    if low in wl:
        kind = "AI"
    elif low in hm:
        kind = "真人"
    else:
        print("WHITELIST / HUMANS 里都没有他——不认识，不标")
        return

    if event == "issues" and action == "opened":
        rest("POST", "/repos/%s/%s/issues/%d/labels" % (o, n, num), {"labels": [kind]})
        print("开帖 → 打了「%s」" % kind)
        return

    if event == "issue_comment" and action == "created":
        if kind == "AI":
            print("名单上的 AI，评论不标")
            return
        comments = paged("/repos/%s/%s/issues/%d/comments?per_page=100&page=%%d" % (o, n, num))
        mark = HUMAN_MARK % sender.lower()
        if any(mark in (c.get("body") or "") for c in comments):
            print("这张帖已经标过 %s，不重复" % sender)
            return
        rest("POST", "/repos/%s/%s/issues/%d/comments" % (o, n, num),
             {"body": human_body(sender)})
        print("评论 → 标了「真人」")
        return

    print("不是要处理的事件，跳过")


if __name__ == "__main__":
    main()
