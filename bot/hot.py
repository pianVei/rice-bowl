#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每天挑热帖，重写「今日推荐」。

只认一件事：**有没有人在认真接话。**

    最近 24 小时的评论     一条算 2 分
    最近 7 天里其余的评论   一条算 1 分
    说过话的不同人数        一个人算 1 分

不看播放、不看点赞（这地方也没有）。一个人刷十条算不过三个人来回说。

推荐区自己的楼不算，公告类（标题带 `今日推荐`）也不算。
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gh import rest, repo_parts  # noqa: E402

RECOMMEND_TITLE = "今日推荐"
TOP_N = 5
HEADER = """这栋楼不用你们动手，**每天由机器人重写一次**。

**怎么算热**：最近有动静的帖子，按这个排——

- 最近 24 小时里的新评论，一条算两份
- 最近 7 天里的评论
- 有多少个不同的人在里面说过话

**不看播放、不看点赞**（这地方也没有），只看**有没有人在认真接话**。
一个人刷十条不算热，三个人来回说才算。

---

"""
FOOTER = "\n\n---\n\n> 觉得哪一桌该被挂上来，就在这儿说一声，我手动加。\n"


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)


def parse(ts):
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def paged(path_tpl, pages=6):
    out = []
    for p in range(1, pages + 1):
        batch = rest("GET", path_tpl % p)
        if not isinstance(batch, list) or not batch:
            break
        out.extend(batch)
        if len(batch) < 100:
            break
    return out


def score_for(comments):
    t = now_utc()
    day_ago = t - datetime.timedelta(hours=24)
    week_ago = t - datetime.timedelta(days=7)
    fresh = warm = 0
    people = set()
    for c in comments:
        ts = parse(c.get("created_at") or "")
        if not ts:
            continue
        people.add(((c.get("user") or {}).get("login") or "").lower())
        if ts >= day_ago:
            fresh += 1
        elif ts >= week_ago:
            warm += 1
    people.discard("")
    return fresh * 2 + warm + len(people), fresh, warm, len(people)


def main():
    o, n = repo_parts()
    dry = "--dry" in sys.argv

    issues = [x for x in paged("/repos/%s/%s/issues?state=open&per_page=100&page=%%d" % (o, n))
              if "pull_request" not in x and (x.get("title") or "") != RECOMMEND_TITLE]

    scored = []
    for it in issues:
        num = it["number"]
        comments = paged("/repos/%s/%s/issues/%d/comments?per_page=100&page=%%d" % (o, n, num))
        if not comments:
            continue
        s, fresh, warm, ppl = score_for(comments)
        if s <= 0:
            continue
        scored.append((s, fresh, warm, ppl, it))

    scored.sort(key=lambda x: (-x[0], -x[1], x[4]["number"]))
    top = scored[:TOP_N]

    if not top:
        print("这阵子没人接话，推荐区先空着。")
        body = HEADER + "（这阵子没有人接话。）" + FOOTER
    else:
        lines = []
        for i, (s, fresh, warm, ppl, it) in enumerate(top, 1):
            labels = " ".join("`%s`" % l["name"] for l in (it.get("labels") or []))
            lines.append(
                "**%d. [#%d %s](%s)**\n    %s · %d 条评论 · %d 个人说过话 · 24h 内 +%d\n"
                % (i, it["number"], it["title"], it["html_url"],
                   it["user"]["login"], fresh + warm, ppl, fresh))
        body = HEADER + "\n".join(lines) + FOOTER

    # 找到推荐区那一楼
    target = next((x for x in paged("/repos/%s/%s/issues?state=open&per_page=100&page=%%d" % (o, n))
                   if (x.get("title") or "") == RECOMMEND_TITLE), None)
    if not target:
        # 万一被关了也找回来
        target = next((x for x in paged("/repos/%s/%s/issues?state=closed&per_page=100&page=%%d" % (o, n))
                       if (x.get("title") or "") == RECOMMEND_TITLE), None)
    if not target:
        sys.exit("找不到「今日推荐」那一楼——先开一个，标题写「今日推荐」。")

    print(body[:600])
    if dry:
        print("\n（--dry，没写回去）")
        return
    rest("PATCH", "/repos/%s/%s/issues/%d" % (o, n, target["number"]), {"body": body})
    if target.get("state") == "closed":
        rest("PATCH", "/repos/%s/%s/issues/%d" % (o, n, target["number"]), {"state": "open"})
    print("\n已写回 #%d" % target["number"])


if __name__ == "__main__":
    main()
