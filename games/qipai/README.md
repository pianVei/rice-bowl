# Dou Dizhu Online (斗地主)

A browser-based Dou Dizhu (Fight the Landlord) game you can play online with a
friend — pure static files, peer-to-peer via WebRTC, no server and no signup.

## Features

- **Classic 3-player** — for 1–3 humans; AIs fill any empty seats (practice
  solo, invite one friend, or play a full human table)
- **Heads-up duel (二人对决)** — 1v1 variant, 17 cards set aside
- **4P teams (四人 2v2)** — partners sit opposite, 13 cards each, 2-card kitty
- **Guandan (掼蛋)** — two decks, 2v2, per-team levels (级牌), 逢人配 wilds,
  bombs / 同花顺 / 天王炸, 接风, automatic tribute (进贡/还贡/抗贡), race to A
- **Mahjong (麻将 · 国标)** — 4 players, 136 tiles, 70-tile wall, 8-fan minimum,
  chow / pung / kong (including concealed and added kongs), ron & self-draw,
  fan breakdown on the settle screen, 4 rounds with dealer rotation;
  per-turn hint button and a live "waiting on" panel (which tile to discard →
  which tiles you'd be waiting for, with how many are still unseen)
- **Wildcard rounds (癞子场)** — one random rank is wild each round, with soft
  bombs, natural-rank rules and the 4-wild super bomb
- **No-shuffle mode (不洗牌)** — barely-shuffled deck, bombs everywhere
- **Doubling phase, base-stake selection, spring/anti-spring scoring,
  cumulative session scores**
- Hint button (cycles through candidate plays), drag across the hand to
  multi-select, quick-chat phrases, bilingual UI (中文 / English)
- Sound effects + generative background music (WebAudio, no assets),
  landlord-reveal animation
- AI takes over instantly if a player disconnects
- **External AI client (`bot.mjs`)** — drive your own seat through the local
  HTTP bridge (see "AI bot client" below)

## How online play works

The room code doubles as a [PeerJS](https://peerjs.com) peer id. The host's
browser runs the authoritative game state; the guest connects directly over
WebRTC (PeerJS's free public broker is only used for the handshake). No game
data touches any server.

1. Host: pick a mode → **Create room** → send the 4-character code to friends
   (up to 2 guests in Classic, 1 in Duel)
2. Guest: enter the code → **Join**
3. Host: **Start game**

## Connectivity / TURN relay

STUN alone connects peers on ordinary home networks. Networks with client
isolation or blocked UDP (campus WiFi such as eduroam, many offices) also
need a TURN relay:

1. Create a free account at [metered.ca/stun-turn](https://www.metered.ca/stun-turn)
   (50 GB/month free — card games use a few hundred KB per round)
2. Copy your credentials URL, e.g.
   `https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=YOURKEY`
3. Paste it into `TURN_CREDENTIALS_URL` in `js/net.js` and redeploy

The home screen has a built-in network test ("Can't connect? Run network
test") that reports broker / STUN / TURN reachability from your network.

## Run locally

Any static file server works:

```bash
cd doudizhu-online
python3 -m http.server 8000
# open http://localhost:8000
```

Practice mode works fully offline; online rooms need internet for the WebRTC
handshake.

## Deploy (GitHub Pages)

Push this directory to a GitHub repo, then enable
**Settings → Pages → Deploy from branch** (`main`, root). The site is fully
static — no build step.

## Tests

The rules engine (combo detection, wildcard analysis, move generation) and the
full game loop are covered by Node tests, including 720 simulated AI-vs-AI
rounds across all mode combinations, plus a guandan suite (engine units,
view contract and full AI-vs-AI matches) and an HTTP-bridge end-to-end run:

```bash
node tests/engine.test.js
node tests/guandan.test.js
node tests/mahjong.test.js
node tests/bridge.e2e.mjs classic 3   # headless browser stand-in (needs bot.mjs or manual play)
node bot.mjs --session <id>           # in another terminal
```

## AI bot client

The home screen lets you hand your seat to an external AI ("你的操作身份 →
AI"). The page then pushes a structured seat view (hand, legal moves,
history — no card recognition needed) to a local HTTP bridge, and any client
can read it and submit moves.

```bash
node server.cjs                # start the app on http://127.0.0.1:8765
node bot.mjs                   # attach to the AI-mode page automatically
node bot.mjs --delay 500       # slower decisions
node bot.mjs --session <id>    # attach to a specific bridge session
```

`GET /api/sessions` lists active AI-mode sessions (localhost only). Works in
every mode, including guandan and mahjong; the built-in engine answers in
milliseconds, so the bot plays instantly without any external API.

In mahjong the bridge exposes the seat as structured data — hand tiles with
`{id, kind, name}`, exposed melds, every player's river, the current claim
options with fan values, and your own waits — so an AI never has to read the
screen. Commands are `discard` (`tileId`), `claim` (`decision`:
`hu`/`kong`/`pung`/`chow`/`pass`), `kong` (`kind` + `tileKind`), `selfwin`
and `again`.

## Architecture

| File | Role |
| --- | --- |
| `js/cards.js` | Deck, combo detection/comparison, wildcard (laizi) analysis — pure functions |
| `js/moves.js` | Legal move generation (shared by the hint button and the AI) |
| `js/ai.js` | Heuristic AI: bidding, doubling, play decisions |
| `js/game.js` | Host-authoritative state machine (bidding → doubling → playing → settle) |
| `js/guandan.js` | Guandan engine: two-deck combos, 逢人配 wilds, bomb ordering, AI |
| `js/guandan-game.js` | Guandan state machine: levels, 接风, tribute, match progression |
| `js/mahjong.js` | Mahjong rules engine: hand decomposition, fan scoring, shanten, AI |
| `js/mahjong-game.js` | Mahjong state machine: draw → discard → claim, kongs, 4-round match |
| `js/net.js` | Thin PeerJS wrapper (room code = peer id) |
| `js/ui.js` | Screens, rendering, host/guest plumbing |
| `js/i18n.js` | zh/en strings |
| `js/agent.js` | Seat-view JSON + command execution for the AI bridge |
| `server.cjs` | Static server + local HTTP bridge (`/bridge/*`, `/api/sessions*`) |
| `bot.mjs` | External AI decision client for the bridge |

---

## 中文说明

纯静态网页斗地主,和朋友点对点联机(1–3 人,空位 AI 补),无需服务器、无需注册。

**模式**:经典三人(AI 补位)/ 二人对决 / 四人 2v2 / 掼蛋(两副牌、级牌逢人配、
炸弹同花顺天王炸、接风进贡、打到 A)/ 麻将国标(136 张、起和 8 番、吃碰杠胡、
暗杠加杠、四局制)/ 癞子场 / 不洗牌疯狂场,支持加倍、底分、春天/反春计分、
局间累计积分,带提示和快捷聊天。

**AI 代打**:首页把操作身份切成"AI",然后 `node bot.mjs` 自动接管你的座位
(本地内置引擎,毫秒出手,无需任何外部 API)。`GET /api/sessions` 可查看
当前活跃的 AI 会话。

**联机方式**:创建房间后把 4 位房间码发给朋友,对方在首页输入即可直连
(WebRTC 点对点,牌局数据不经过任何服务器)。单机练习完全离线可玩。

**本地运行**:`python3 -m http.server 8000` 后打开 `http://localhost:8000`。

**测试**:`node tests/engine.test.js`(含全模式各 120 局 AI 自动对局仿真)。
