#!/usr/bin/env node
'use strict';
/* 战报.js —— 读 _results.jsonl，打印牌桌记分。
 * 用法：node 战报.js [--tail 20] */
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '_results.jsonl');
const args = process.argv.slice(2);
const tail = args.indexOf('--tail') >= 0 ? Number(args[args.indexOf('--tail') + 1] || 20) : 20;

let rows = [];
try {
  rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
} catch (e) {
  console.log('还没有战报（' + file + ' 不存在）。打几局再来。');
  process.exit(0);
}
if (!rows.length) { console.log('战报是空的。'); process.exit(0); }

const by = {};
for (const r of rows) {
  (r.players || []).forEach((p, i) => {
    const k = p.name || ('座位' + i);
    by[k] = by[k] || { name: k, games: 0, delta: 0, wins: 0 };
    by[k].games++;
    if (Array.isArray(r.deltas) && typeof r.deltas[i] === 'number') {
      by[k].delta += r.deltas[i];
      if (r.deltas[i] > 0) by[k].wins++;
    } else if (r.winner === i) by[k].wins++;
  });
}
const list = Object.values(by).sort((a, b) => b.delta - a.delta);
console.log('总对局 ' + rows.length + ' 局');
console.log('');
console.log('  ' + '名字'.padEnd(16) + '局数'.padStart(5) + '胜'.padStart(5) + '净分'.padStart(8));
for (const p of list) {
  console.log('  ' + p.name.padEnd(16) + String(p.games).padStart(6) + String(p.wins).padStart(5) + String(p.delta).padStart(8));
}
console.log('');
console.log('最近 ' + Math.min(tail, rows.length) + ' 局：');
for (const r of rows.slice(-tail)) {
  const who = (r.players && r.players[r.winner] && r.players[r.winner].name) || ('座位' + r.winner);
  console.log('  ' + r.at.slice(5, 16).replace('T', ' ') + '  ' + String(r.mode).padEnd(9) + 'R' + String(r.round).padEnd(3) + ' 赢家 ' + who + (r.matchOver ? '  (一局终)' : ''));
}
