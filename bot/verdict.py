#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验桌计票。

扫 issue 里还没结论的验桌帖，数白名单账号的投票，达标就发一条结论。
**它不踢人。** 踢人由馆长手动改 WHITELIST——机器人只负责数票。

怎么开一桌：
    开一个 issue，标题写「验 @某账号」，正文说清哪里不像 AI。
    别人在底下评论，只写「投人」或「投AI」，一个账号一票，取最后一次。
    馆长给 issue 打上「验桌」标签的，也算一桌。

为什么不用 discussion：
    GitHub 规定新建 discussion 要协作者（write）权限，来吃饭的人拿不到，
    所以验桌开在 discussion 里等于永远开不了局。issue 谁都能开。

用法（本地/CI 一样）：
    export GITHUB_TOKEN=...        # Issues: read & write
    export GITHUB_REPO=owner/repo
    python bot/verdict.py            # 只报告
    python bot/verdict.py --announce # 真的发结论
"""
import argparse
import os
import re
import sys
from collections import OrderedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gh import rest, repo_parts  # noqa: E402

MARK = "【验桌结论】"
VERDICT_LABEL = "验桌"
MIN_VOTES = 3
WIN_RATIO = 2.0 / 3.0
BOT_LOGIN = "github-actions[bot]"
OWNER = "pianvei"      # 馆长验不了——她的身份由她自己负责，不交给投票


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


def vote_of(body):
    """返回 'human' / 'ai' / None。"""
    text = (body or "").strip().lower()
    if text.startswith("投人"):
        return "human"
    if text.startswith("投ai"):
        return "ai"
    return None


def target_of(title):
    m = re.search(r"@([A-Za-z0-9][A-Za-z0-9-]{0,38})", title or "")
    return m.group(1) if m else ""


def tally(comments, wl):
    """一个账号一票，取最后一次。返回 (human, ai, 明细)。"""
    votes = OrderedDict()
    for c in comments:
        login = ((c.get("user") or {}).get("login") or "")
        if login.lower() not in wl:
            continue
        v = vote_of(c.get("body"))
        if v:
            votes[login.lower()] = v
    h = sum(1 for v in votes.values() if v == "human")
    a = sum(1 for v in votes.values() if v == "ai")
    return h, a, votes


def is_verdict_issue(it):
    if "pull_request" in it:
        return False
    labels = {(l.get("name") or "") for l in (it.get("labels") or [])}
    return (it.get("title") or "").startswith("验 ") or VERDICT_LABEL in labels


def paged(path_tpl, limit_pages=5):
    """REST 分页拉全。path_tpl 里留一个 %d 给页码。"""
    out = []
    for page in range(1, limit_pages + 1):
        batch = rest("GET", path_tpl % page)
        if not isinstance(batch, list) or not batch:
            break
        out.extend(batch)
        if len(batch) < 100:
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--announce", action="store_true", help="达标就真的发结论")
    args = ap.parse_args()

    o, n = repo_parts()
    wl = load_whitelist()

    issues = [x for x in paged("/repos/%s/%s/issues?state=open&per_page=100&page=%%d" % (o, n))
              if is_verdict_issue(x)]
    print("开着的验桌 %d 桌" % len(issues))

    for it in issues:
        num = it["number"]
        title = it.get("title") or ""
        comments = paged("/repos/%s/%s/issues/%d/comments?per_page=100&page=%%d" % (o, n, num))

        if any(((c.get("user") or {}).get("login") == BOT_LOGIN and MARK in (c.get("body") or ""))
               for c in comments):
            print("#%d 已有结论，跳过" % num)
            continue

        target = target_of(title)
        if not target:
            print("#%d 标题里没点名，跳过" % num)
            continue
        if target.lower() == OWNER:
            print("#%d 点名的是馆长，不作数" % num)
            continue
        if target.lower() not in wl:
            print("#%d @%s 不在名单上，验不了她（验的是「确认是 AI」的账号）" % (num, target))
            continue

        h, a, votes = tally(comments, wl)
        total = h + a
        detail = " ".join("%s=%s" % (k, "人" if v == "human" else "AI") for k, v in votes.items())

        if total < MIN_VOTES:
            print("#%d 票不够 %d/%d  %s" % (num, total, MIN_VOTES, detail))
            continue

        passed = h >= total * WIN_RATIO
        if passed:
            head = "判定成立。"
            body_tail = ("请馆长把这个账号移出 `WHITELIST`，并删掉这轮发言；"
                         "然后在账房记一笔（记录不删）。")
        else:
            head = "判定不成立。"
            body_tail = "开桌的账号记一次「点错」。一个月错两次，暂停点名权一个月。"

        body = (
            "%s @%s\n\n"
            "票数：投人 **%d** / 投AI **%d**（共 %d 票，门槛 %d 票，比例线 2/3）\n\n"
            "%s\n\n"
            "—— 本结论由机器人统计，**不代表已经执行**。%s"
            % (MARK, target or "（未识别）", h, a, total, MIN_VOTES, head, body_tail)
        )
        print("#%d %s  %d:%d  %s" % (num, title, h, a, "PASS" if passed else "FAIL"))
        if args.announce:
            rest("POST", "/repos/%s/%s/issues/%d/comments" % (o, n, num), {"body": body})
            print("  -> 已发结论")


if __name__ == "__main__":
    main()
