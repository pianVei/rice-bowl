#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""社区里的事：加入、打卡、批灯牌。

社区大厅就是那个带「社区:名字」标签、标题写着 `开社区：` 的 issue。
在这个楼底下评论：

    加入             记进这张桌
    打卡             今天来了，机器人数一天
    批灯牌 @xxx      到线的人，给个牌子（发起人 / 馆长 / 管理员才能说）

打卡按**天**去重——一天说十遍也只算一天。
牌子等级看累计天数：3 天 Lv.1、7 天 Lv.2、15 天 Lv.3、30 天 Lv.4。

牌子不是身份，是常来的记号。看和聊本来就不用它。
"""
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gh import rest, repo_parts  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OWNER = "pianvei"

LEVELS = [(30, 4), (15, 3), (7, 2), (3, 1)]   # (天数, 等级)，从高到低

RE_JOIN = re.compile(r"^加入$")
RE_CHECKIN = re.compile(r"^打卡$")
RE_GRANT = re.compile(r"^批灯牌\s+@?([A-Za-z0-9][A-Za-z0-9-]{0,38})$")


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
            if len(parts) >= 2:
                out["社区:" + parts[0]] = (parts[1].lower(), parts[0])
    return out


def load_badges():
    """返回 {(社区, 账号): 等级}"""
    path = os.path.join(ROOT, "BADGES")
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 3:
                try:
                    out[(parts[0], parts[1].lower())] = int(parts[2])
                except ValueError:
                    pass
    return out


def level_for(days):
    for need, lv in LEVELS:
        if days >= need:
            return lv
    return 0


def paged(path_tpl, limit_pages=8):
    out = []
    for page in range(1, limit_pages + 1):
        batch = rest("GET", path_tpl % page)
        if not isinstance(batch, list) or not batch:
            break
        out.extend(batch)
        if len(batch) < 100:
            break
    return out


def comments_of(o, n, num):
    return paged("/repos/%s/%s/issues/%d/comments?per_page=100&page=%%d" % (o, n, num))


def today():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def checkin_days(comments, login):
    """这个人在这个楼里打过卡的日子。"""
    days = set()
    low = login.lower()
    for c in comments:
        if ((c.get("user") or {}).get("login") or "").lower() != low:
            continue
        if (c.get("body") or "").strip().startswith("打卡"):
            days.add((c.get("created_at") or "")[:10])
    return days


def count_days(comments, login):
    """累计打了几天卡。"""
    return len(checkin_days(comments, login))


def days_today(comments, login):
    """算上这次——刚发的评论可能还没进 API，不能只靠数。"""
    days = checkin_days(comments, login)
    if today() in days:
        return len(days)
    return len(days) + 1


def say(o, n, num, text):
    rest("POST", "/repos/%s/%s/issues/%d/comments" % (o, n, num), {"body": text})


def grant(o, n, num, who, target, community):
    badges = load_badges()
    comments = comments_of(o, n, num)
    days = count_days(comments, target)
    lv = level_for(days)
    if lv == 0:
        say(o, n, num, "@%s 才打了 %d 天卡，满 3 天才够 Lv.1。" % (target, days))
        return
    if badges.get((community, target.lower()), 0) >= lv:
        say(o, n, num, "@%s 已经有 Lv.%d 了，再打几天才能升。" % (target, lv))
        return

    path = os.path.join(ROOT, "BADGES")
    today = comments[-1].get("created_at", "")[:10] if comments else ""
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        f.write("%s | %s | %d | %s\n" % (community, target, lv, today))
    say(o, n, num,
        "🏮 **@%s 挂上灯牌了** —— %s Lv.%d（打卡 %d 天）\n\n由 @%s 批。"
        % (target, community, lv, days, who))
    print("批灯牌 %s -> %s Lv.%d" % (target, community, lv))


def main():
    path = os.environ.get("GITHUB_EVENT_PATH")
    if not path or not os.path.exists(path):
        sys.exit("缺 GITHUB_EVENT_PATH")
    with open(path, encoding="utf-8") as f:
        ev = json.load(f)
    if (ev.get("action") or "") != "created":
        return

    issue = ev.get("issue") or {}
    num = issue.get("number")
    who = ((ev.get("comment") or {}).get("user") or {}).get("login") or ""
    body = (ev.get("comment") or {}).get("body") or ""
    title = issue.get("title") or ""
    labels = {(l.get("name") or "") for l in (issue.get("labels") or [])}

    if not num or not who or "pull_request" in issue:
        return

    # 只认社区大厅：标题 `开社区：` 且带「社区:」标签
    if not title.startswith("开社区："):
        return
    comm_label = next((lb for lb in labels if lb.startswith("社区:")), None)
    if not comm_label:
        return

    communities = load_communities()
    owner_login, comm_name = communities.get(comm_label, (None, None))
    if not comm_name:
        return

    first = ""
    for line in body.splitlines():
        if line.strip():
            first = line.strip()
            break
    if not first:
        return

    o, n = repo_parts()

    if RE_JOIN.match(first):
        say(o, n, num,
            "进来坐吧，@%s。\n\n以后每天在这个楼底下说一句 `打卡`，机器人数着。\n"
            "满 3 天可以领 Lv.1 的灯牌，桌主或者馆长点头就挂上。\n\n"
            "不加入也能看、也能聊——这个牌子只是说明你常来。" % who)
        print("加入：%s" % who)
        return

    if RE_CHECKIN.match(first):
        comments = comments_of(o, n, num)
        days = days_today(comments, who)
        lv = level_for(days)
        badges = load_badges()
        has = badges.get((comm_name, who.lower()), 0)
        if lv and lv > has:
            say(o, n, num,
                "第 %d 天打卡 ✅\n\n到 Lv.%d 的线了——@%s 或馆长说一句「批灯牌 @%s」就能挂上。"
                % (days, lv, owner_login or "馆长", who))
        else:
            say(o, n, num, "第 %d 天打卡 ✅" % days)
        print("打卡：%s 第 %d 天" % (who, days))
        return

    m = RE_GRANT.match(first)
    if m:
        target = m.group(1)
        allowed = who.lower() == owner_login or who.lower() == OWNER
        if not allowed:
            admins = load_list("ADMINS")
            if who.lower() not in admins:
                say(o, n, num, "灯牌得这张桌的发起人或者馆长批。")
                print("拒绝：无权批灯牌")
                return
        grant(o, n, num, who, target, comm_name)
        return

    print("不是社区命令：%s" % first[:30])


if __name__ == "__main__":
    main()
