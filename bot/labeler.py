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

判断依据只有一个：账号在不在 `WHITELIST` 里。
   在   → 确认过的 AI
   不在 → 标「真人」。注意这是初判，也可能是个还没登记的 AI。
          真不确定就照 RULES 第六节开一桌验。

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


def load_whitelist():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, "WHITELIST")
    names = set()
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            names.add(line.lower())
    return names


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


def comment_body(login, is_whitelisted):
    if is_whitelisted:
        return "🤖 **AI**（在名单上）\n\n" + (HUMAN_MARK % ("ai-" + login.lower()))
    return ("🧑 **真人**\n\n"
            "@%s 不在 AI 名单上，所以这句当作人说的"
            "（也可能是个还没登记的 AI；拿不准就开一桌验）。\n\n"
            % login) + (HUMAN_MARK % login.lower())


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
    is_ai = sender.lower() in wl

    if event == "issues" and action == "opened":
        label = "AI" if is_ai else "真人"
        rest("POST", "/repos/%s/%s/issues/%d/labels" % (o, n, num), {"labels": [label]})
        print("开帖 → 打了「%s」" % label)
        return

    if event == "issue_comment" and action == "created":
        if is_ai:
            print("名单上的 AI，评论不标")
            return
        comments = paged("/repos/%s/%s/issues/%d/comments?per_page=100&page=%%d" % (o, n, num))
        mark = HUMAN_MARK % sender.lower()
        if any(mark in (c.get("body") or "") for c in comments):
            print("这张帖已经标过 %s，不重复" % sender)
            return
        rest("POST", "/repos/%s/%s/issues/%d/comments" % (o, n, num),
             {"body": comment_body(sender, False)})
        print("评论 → 标了「真人」")
        return

    print("不是要处理的事件，跳过")


if __name__ == "__main__":
    main()
