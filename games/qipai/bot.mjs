#!/usr/bin/env node
'use strict';
/* bot.mjs — external AI decision client for the HTTP bridge.
 *
 * Usage:
 *   node bot.mjs [--url http://127.0.0.1:8765] [--delay 300]
 *
 * A browser page (practice room or host room) must be open with
 * "你的操作身份 = AI". The page pushes its seat view to the bridge; this
 * script polls the session API, decides with the built-in engine (same
 * heuristics the filler AI uses) and submits play/pass/bid/double/again.
 * Works for every mode, including guandan.
 */

import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BASE = arg('url', 'http://127.0.0.1:8765');
const DELAY = Number(arg('delay', '250'));
const WANT_SESSION = arg('session', null);

/* ---------- LLM 模式（--llm） ----------
 * 用语言模型代替内置引擎出牌。读环境变量：
 *   LLM_BASE_URL  默认 https://api.deepseek.com/anthropic
 *   LLM_TOKEN     必填（ant 兼容接口的 key）
 *   LLM_MODEL     默认 deepseek-v4-flash
 * 任何一步失败（超时/解析不出/非法出牌）都退回内置引擎，牌局不会卡死。
 */
const USE_LLM = args.includes('--llm');
const LLM_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com/anthropic';
const LLM_TOKEN = process.env.LLM_TOKEN || '';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-v4-flash';
const LLM_TIMEOUT = Number(process.env.LLM_TIMEOUT || '12000');

/* ---------- state normalisation ----------
 * The page (agent.js) sends cards as {id, rank, suit, name} and keeps the
 * mode under rules.mode; the headless harness sends {id, r, s} and mode at
 * the top level. Accept both. */
const normCard = c => ({ id: c.id, r: c.r !== undefined ? c.r : c.rank, s: c.s !== undefined ? c.s : c.suit });
const normState = s => {
  if (!s) return s;
  // 麻将是另一套结构（牌用 kind 不是 r/s），原样用
  if (s.mode === 'mahjong') return s;
  const n = Object.assign({}, s);
  n.mode = s.mode || (s.rules && s.rules.mode) || 'classic';
  n.hand = (s.hand || []).map(normCard);
  n.n = s.n || (s.players ? s.players.length : 3);
  if (n.currentBid == null && s.available && Array.isArray(s.available.bid)) {
    const maxBid = Math.max(0, ...s.available.bid);
    n.currentBid = maxBid > 0 ? maxBid - 1 : 0;
  }
  if (s.trick && s.trick.combo) n.trick = { combo: s.trick.combo, seat: s.trick.seat };
  return n;
};

/* Engine modules (CommonJS, Node-safe thanks to their require shims). */
const dz = Object.assign({}, require('./js/cards.js'), require('./js/moves.js'), require('./js/ai.js'));
const gd = require('./js/guandan.js');
const mj = require('./js/mahjong.js');

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
        token ? { Authorization: 'Bearer ' + token } : {}),
    }, res => {
      let buf = '';
      res.on('data', x => buf += x);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ---------- decision core ---------- */

function cardName(c) {
  if (c.r === 16) return '小王';
  if (c.r === 17) return '大王';
  return (['♠', '♥', '♦', '♣'][c.s] || '') + dz.RANK_LABELS[c.r];
}

function decideDouDizhu(s) {
  if (s.phase === 'bidding') {
    const v = dz.aiBid(s.hand.map(c => c.r), s.currentBid ?? 0, null);
    return { action: 'bid', value: v };
  }
  if (s.phase === 'doubling') return { action: 'double', yes: dz.aiDouble(s.hand.map(c => c.r), s.landlord === s.mySeat, null) };
  if (s.phase !== 'playing') return null;
  const prev = s.trick && s.trick.combo && s.trick.seat !== s.mySeat ? s.trick.combo : null;
  const ranks = s.hand.map(c => c.r);
  const mv = dz.aiPlay({
    hand: ranks, laizi: null, prev, prevSeat: prev ? s.trick.seat : null,
    mySeat: s.mySeat, landlordSeat: s.landlord,
    cardCounts: s.players.map(p => p.cardCount), nPlayers: s.n || s.players.length,
  });
  if (mv) {
    const cards = dz.materialize(s.hand, mv.play, null);
    if (cards) return { action: 'play', cardIds: cards.map(c => c.id) };
  }
  if (prev) return { action: 'pass' };
  // Leading but no move generated (should not happen): dump lowest.
  const low = s.hand.slice().sort((a, b) => a.r - b.r)[0];
  return { action: 'play', cardIds: [low.id] };
}

function decideGuandan(s) {
  const gdInfo = s.gd || {};
  const level = gdInfo.myLevelRank;
  const prev = s.trick && s.trick.combo && s.trick.seat !== s.mySeat ? s.trick.combo : null;
  const mv = gd.gdAiPlay(s.hand, level, prev, {
    prevSeat: prev ? s.trick.seat : null,
    mySeat: s.mySeat,
    finished: gdInfo.finished || [],
    teams: gdInfo.teams || [0, 1, 0, 1],
    cardCounts: s.players.map(p => p.cardCount),
  });
  if (mv) return { action: 'play', cardIds: mv.ids };
  if (prev) return { action: 'pass' };
  const low = s.hand.slice().sort((a, b) => a.r - b.r)[0];
  return { action: 'play', cardIds: [low.id] };
}

/* 麻将：只用牌面数据做决定，不碰任何截图/识图。
 * 策略刻意做得很基础：能胡就胡 -> 能杠就杠 -> 用引擎推荐的牌打出。
 * 吃碰默认不叫（基础版不乱副露），免得把牌型打散。 */
function decideMahjong(s) {
  if (s.phase === 'claim' && s.available && s.available.claim) {
    const opts = (s.claim && s.claim.options) || [];
    if (opts.some(o => o.type === 'hu')) return { action: 'claim', decision: 'hu' };
    if (opts.some(o => o.type === 'kong')) return { action: 'claim', decision: 'kong' };
    return { action: 'claim', decision: 'pass' };
  }
  if (s.phase === 'discard' && s.available && s.available.discard) {
    if (s.available.selfwin) return { action: 'selfwin' };
    const kongs = (s.available.kongs && s.available.kongs.concealed) || [];
    if (kongs.length) return { action: 'kong', kind: 'concealed', tileKind: kongs[0] };

    const hand = (s.hand || []).map(c => ({ id: c.id, k: c.kind }));
    const exposed = (s.exposed || []).map(m => ({ t: m.type, k: m.kind }));
    const discards = [];
    for (const p of s.players || []) {
      for (const lbl of p.discards || []) {
        const k = mj.MJ_LABELS.indexOf(lbl);
        if (k >= 0) discards.push(k);
      }
    }
    const pick = mj.mjAiDiscard(hand, exposed, { discards });
    if (pick) return { action: 'discard', tileId: pick.id };
    const low = hand[hand.length - 1];
    return low ? { action: 'discard', tileId: low.id } : null;
  }
  return null;
}

async function decideLLM(s) {
  const fallback = decide(s);
  if (!LLM_TOKEN) return fallback;
  const hand = (s.hand || []).map(c => c.name || cardName(c));
  const need = s.mode === 'mahjong'
    ? '返回 {"action":"discard","tileId":"<牌id>"} 或 {"action":"claim","decision":"hu|kong|pass"} 或 {"action":"selfwin"}'
    : (s.mode === 'guandan'
        ? '返回 {"action":"play","cardIds":[...]} 或 {"action":"pass"}'
        : '返回 {"action":"play","cardIds":[...]} 或 {"action":"pass"}；叫分阶段返回 {"action":"bid","value":0-3}');
  const view = {
    mode: s.mode, phase: s.phase, seat: s.mySeat, myHand: hand,
    handIds: (s.hand || []).map(c => c.id),
    lastPlay: s.lastPlay || s.prev || null, landlord: s.landlord,
    players: s.players, available: s.available,
  };
  const lines = [
    '你在打牌。看局面，只输出一行 JSON 作为你的动作，不要解释。',
    '规则：' + need,
    '局面：' + JSON.stringify(view),
    '内置引擎会建议：' + JSON.stringify(fallback) + '（不同意就按你的判断来）',
  ];
  const prompt = lines.join(String.fromCharCode(10));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LLM_TIMEOUT);
  try {
    const r = await fetch(LLM_URL.replace(/\/$/, '') + '/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': LLM_TOKEN, 'authorization': 'Bearer ' + LLM_TOKEN, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: LLM_MODEL, max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    const text = ((j.content || []).map(x => x.text || '').join('') || '');
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return fallback;
    const cmd = JSON.parse(m[0]);
    return legalise(cmd, s) || fallback;
  } catch (e) {
    log('  (LLM 失手，回退内置引擎: ' + (e && e.message ? e.message : e) + ')');
    return fallback;
  } finally { clearTimeout(timer); }
}

function legalise(cmd, s) {
  if (!cmd || !cmd.action) return null;
  const ids = new Set((s.hand || []).map(c => c.id));
  if (cmd.action === 'play') {
    if (!Array.isArray(cmd.cardIds) || !cmd.cardIds.length) return null;
    if (!cmd.cardIds.every(x => ids.has(x))) return null;
    return { action: 'play', cardIds: cmd.cardIds };
  }
  if (cmd.action === 'pass') return { action: 'pass' };
  if (cmd.action === 'bid') return { action: 'bid', value: Math.max(0, Math.min(3, Number(cmd.value) || 0)) };
  if (cmd.action === 'double') return { action: 'double', yes: !!cmd.yes };
  if (cmd.action === 'claim') return { action: 'claim', decision: String(cmd.decision || 'pass') };
  if (cmd.action === 'selfwin') return { action: 'selfwin' };
  if (cmd.action === 'discard') { if (!ids.has(cmd.tileId)) return null; return { action: 'discard', tileId: cmd.tileId }; }
  if (cmd.action === 'kong') return { action: 'kong', kind: cmd.kind || 'concealed', tileKind: cmd.tileKind };
  if (cmd.action === 'again') return { action: 'again' };
  return null;
}

function decide(s) {
  if (s.mode === 'mahjong') return decideMahjong(s);
  return s.mode === 'guandan' ? decideGuandan(s) : decideDouDizhu(s);
}

/* ---------- main loop ---------- */

async function attach() {
  // Discover the page session that is currently in AI mode.
  for (;;) {
    try {
      const r = await api('GET', '/api/sessions');
      const list = (r.json && r.json.sessions) || [];
      if (WANT_SESSION) {
        const hit = list.find(s => s.id === WANT_SESSION) || list.find(s => s.id.startsWith(WANT_SESSION));
        if (hit) return hit;
      } else if (list.length) return list[0];
    } catch (e) { /* bridge not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function main() {
  log('waiting for an AI-mode page on ' + BASE + ' …');
  let { id, token, mode } = await attach();
  log(`attached to session ${id}${mode ? ' (mode=' + mode + ')' : ''}`);
  let lastRevision = null, lastAgainRev = null;
  for (;;) {
    await new Promise(r => setTimeout(r, DELAY));
    let raw;
    try { raw = (await api('GET', `/api/sessions/${id}`, null, token)).json; }
    catch (e) { continue; }
    const st = normState(raw);
    if (!st || !st.revision || st.revision === lastRevision) continue;
    lastRevision = st.revision;
    const isMj = st.mode === 'mahjong';
    const mine = isMj
      ? (st.phase === 'discard' && st.turn === st.mySeat) ||
        (st.phase === 'claim' && (st.awaiting || []).includes(st.mySeat))
      : st.actor === st.mySeat && (st.phase === 'playing' || st.phase === 'bidding' || st.phase === 'doubling');
    const handStr = (st.hand || []).map(c => isMj ? (c.name || mj.tileLabel(c.kind)) : cardName(c)).join(' ');
    if (mine) {
      const cmd = USE_LLM ? await decideLLM(st) : decide(st);
      if (!cmd) continue;
      log(`[${st.mode}] R${st.round} 座位${st.mySeat} 手牌(${(st.hand || []).length}): ${handStr}`);
      let detail = '';
      if (cmd.cardIds) {
        detail = cmd.cardIds.map(id => {
          const c = (st.hand || []).find(x => x.id === id);
          return c ? (isMj ? (c.name || mj.tileLabel(c.kind)) : cardName(c)) : id;
        }).join(' ');
      } else if (cmd.tileId != null) {
        const c = (st.hand || []).find(x => x.id === cmd.tileId);
        detail = c ? (c.name || mj.tileLabel(c.kind)) : cmd.tileId;
      } else if (cmd.decision) {
        detail = cmd.decision + (st.claim && st.claim.tile ? ' ' + st.claim.tile : '');
      }
      log(`  -> ${cmd.action} ${detail}`);
      const res = await submit(id, token, st.revision, cmd, 1);
      log('  <=', JSON.stringify(res));
      // 不要把 lastRevision 清空：动作落盘后 revision 自己会变，
      // 清空会在同一条状态上重复决策、白白多提交一次
    } else if (st.phase === 'settle' || st.phase === 'over') {
      const r = st.result;
      if (r) {
        if (isMj) {
          log(`[mahjong] 第${st.round}局结束 ${r.type === 'win'
            ? '座位' + r.winner + (r.selfDraw ? ' 自摸 ' : ' 和 ') + r.fan + ' 番'
            : '荒庄'} deltas=${JSON.stringify(r.deltas)}`);
        } else if (st.mode === 'guandan' && r.gd) {
          log(`[guandan] 第${st.round}局结束 头游:座位${r.winner} ${r.doubleDown ? '双下' : '单下'} 等级 ${r.gd.labels.join(' : ')}`);
        } else {
          log(`[${st.mode}] 第${st.round}局结束 胜家:座位${r.winner} deltas=${JSON.stringify(r.deltas)}`);
        }
      }
      if (st.available && st.available.again && lastAgainRev !== st.revision && !(r && r.matchOver) && !st.matchOver) {
        lastAgainRev = st.revision;
        const res = await submit(id, token, st.revision, { action: 'again' }, 1);
        if (res && res.ok !== false) log('  -> 再来一局');
      }
    }
  }
}

/* Submit with one retry when the table moved on between read and write. */
async function submit(id, token, revision, cmd, retries) {
  const r = await api('POST', `/api/sessions/${id}/actions`, { revision, ...cmd }, token);
  if (r.status === 409 && retries > 0) {
    const st = normState((await api('GET', `/api/sessions/${id}`, null, token)).json);
    if (st && st.revision) {
      const fresh = USE_LLM ? await decideLLM(st) : decide(st);
      if (fresh) return submit(id, token, st.revision, fresh, retries - 1);
    }
    return { ok: false, error: 'stale revision' };
  }
  if (r.status >= 400) return r.json;
  const rid = r.json.requestId;
  for (let i = 0; i < 20; i++) {
    await new Promise(x => setTimeout(x, 150));
    const res = await api('GET', `/api/sessions/${id}/results/${rid}`, null, token);
    if (res.json && res.json.status !== 'pending') return res.json.result || res.json;
  }
  return { status: 'pending' };
}

main().catch(e => { console.error(e); process.exit(1); });
