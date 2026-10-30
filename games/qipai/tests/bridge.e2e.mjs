#!/usr/bin/env node
/* bridge.e2e.mjs — headless browser stand-in for agent.js.
 * Runs a local game (seat 0 = the agent seat, other seats = built-in AI),
 * pushes the seat view to the HTTP bridge exactly like the browser page
 * does (/bridge/register, /bridge/sync, /bridge/result) and executes any
 * commands the external AI (bot.mjs) submits. Pair with:
 *   node bot.mjs &
 *   node tests/bridge.e2e.mjs classic   (or: guandan)
 */
import http from 'node:http';

const MODE = process.argv[2] || 'classic';
const ROUNDS = Number(process.argv[3] || '3');
const BASE = 'http://127.0.0.1:8765';
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const { Game } = require('../js/game.js');
const { GuandanGame } = require('../js/guandan-game.js');

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
        token ? { Authorization: 'Bearer ' + token } : {}),
    }, res => {
      let buf = '';
      res.on('data', x => buf += x);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function agentState(g) {
  const v = g.buildView(0);
  return {
    version: 1, revision: v.revision, phase: v.state, mode: v.mode,
    round: v.roundNo, mySeat: v.mySeat, actor: v.actor,
    myTurn: v.actor === v.mySeat, landlord: v.landlord, n: v.n,
    hand: v.myHand.map(c => ({ id: c.id, r: c.r, s: c.s })),
    trick: { combo: v.trick.combo, seat: v.trick.seat },
    currentBid: v.currentBid,
    players: v.players.map(p => ({ name: p.name, cardCount: p.cardCount })),
    result: v.result || null,
    gd: v.gd || null,
    available: { again: v.state === 'settle' },
  };
}

async function main() {
  const reg = await api('POST', '/bridge/register', {});
  if (reg.status !== 201) throw new Error('register failed');
  const { id, token } = reg.json;
  const players = [{ name: 'AgentSeat' }].concat(
    Array.from({ length: (MODE === 'guandan' ? 4 : 3) - 1 }, (_, i) => ({ name: 'AI' + (i + 1), isAI: true })));
  const cfg = { mode: MODE === 'guandan' ? 'guandan' : 'classic', aiDelay: 0, players };
  const g = MODE === 'guandan' ? new GuandanGame(cfg, { onError: e => console.error('game err', e) })
                               : new Game(cfg, { onError: e => console.error('game err', e) });
  g.startRound();
  let roundsPlayed = 0, commands = 0, plays = 0, passes = 0, agains = 0;
  console.log(`[harness] mode=${MODE} session=${id}`);
  await new Promise(resolve => {
    const iv = setInterval(async () => {
      try {
        if (g.state === 'settle') {
          roundsPlayed++;
          if (roundsPlayed >= ROUNDS || (g.matchOver)) {
            clearInterval(iv);
            console.log(`[harness] done: ${roundsPlayed} rounds, ${commands} commands (plays=${plays} passes=${passes} agains=${agains})`);
            if (MODE === 'guandan') console.log('[harness] levels:', g.result.gd.labels.join(' : '));
            resolve(); return;
          }
        }
        const r = await api('POST', '/bridge/sync', { id, state: agentState(g) }, token);
        if (r.status !== 200) return;
        for (const item of r.json.commands) {
          commands++;
          const c = item.command;
          let result;
          try {
            if (c.action === 'play') { if (!g.actPlay(0, c.cardIds)) throw new Error('rejected'); plays++; }
            else if (c.action === 'pass') { if (!g.actPass(0)) throw new Error('rejected'); passes++; }
            else if (c.action === 'bid') { if (!g.actBid(0, c.value)) throw new Error('rejected'); }
            else if (c.action === 'double') { if (!g.actDouble(0, c.yes)) throw new Error('rejected'); }
            else if (c.action === 'again') { g.nextRound(); agains++; }
            else throw new Error('unknown action ' + c.action);
            result = { ok: true };
          } catch (e) { result = { ok: false, error: e.message }; }
          await api('POST', '/bridge/result', { id, requestId: item.requestId, result }, token);
        }
      } catch (e) { console.error('[harness] loop err', e.message); }
    }, 120);
    setTimeout(() => { clearInterval(iv); console.error('[harness] TIMEOUT'); resolve(); }, 120000);
  });
  process.exit(0);
}
main();
