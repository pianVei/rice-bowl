'use strict';
/* Agent interface consumes only the same seat view rendered for a human. */
const AgentMode = (() => {
  const suitNames = ['黑桃', '红桃', '方块', '梅花'];
  const phases = {idle:'等待开局', bidding:'叫分', doubling:'加倍', playing:'出牌', settle:'结算',
    draw:'摸牌', discard:'出牌', claim:'吃碰杠胡', over:'对局结束'};
  /* 麻将的牌面文字，mahjong.js 已经把 MJ 挂到 window 上了，取不到就自己拼 */
  const mjLabel = k => (typeof MJ !== 'undefined' && MJ.tileLabel) ? MJ.tileLabel(k)
    : (k >= 27 ? ['东','南','西','北','中','发','白'][k - 27]
      : ((k % 9) + 1) + ['万','条','筒'][(k / 9) | 0]);
  let enabled = false, pending = false, history = [], lastRevision = null, session = null, syncing = false;
  const clone = value => JSON.parse(JSON.stringify(value));
  function card(c) {
    return {id:c.id, rank:c.r, suit:c.s, name:c.r === 16 ? '小王' : c.r === 17 ? '大王' : suitNames[c.s] + RANK_LABELS[c.r]};
  }
  function requireView() {
    if (!enabled) throw new Error('请先选择 AI 身份');
    if (!App.view) throw new Error('请先进入牌局');
    return App.view;
  }
  function remember(v) {
    if (!v || !enabled || v.revision === lastRevision) return;
    // 麻将的 revision 是数字，牌类的是 "轮次:序号"，统一成字符串再比
    const rev = String(v.revision);
    if (!lastRevision || String(lastRevision).split(':')[0] !== rev.split(':')[0]) history = [];
    if (v.mode === 'mahjong') {
      history.push({ revision: rev, round: v.round, phase: v.phase, turn: v.turn,
        discards: (v.players || []).map(p => (p.discards || []).map(k => mjLabel(k))) });
    } else {
      history.push({revision:rev, round:v.roundNo, phase:v.state, actor:v.actor,
        bids:v.players.map(p => p.bid), doubles:v.players.map(p => p.dbl),
        plays:v.players.map(p => p.lastPlay ? clone(p.lastPlay) : null)});
    }
    if (history.length > 500) history.shift();
    lastRevision = v.revision;
    pending = false;
  }
  function candidates(v) {
    if (v.actor !== v.mySeat || v.state !== 'playing') return [];
    if (v.mode === 'guandan') {
      const level = v.gd ? v.gd.myLevelRank : null;
      const prev = v.trick.combo && v.trick.seat !== v.mySeat ? v.trick.combo : null;
      return gdLegalMoves(v.myHand, level, prev).map(m => ({
        type: m.combo.type, name: comboName(m.combo), cardIds: m.ids, cards: m.cards.map(card),
      }));
    }
    return legalMoves(v.myHand.map(c => c.r), v.laizi, prevFor(v)).map(m => {
      const cards = materialize(v.myHand, m.play, v.laizi);
      if (!cards) return null;
      const combo = analyze(cards.map(c => c.r), prevFor(v), v.laizi);
      if (!combo || (prevFor(v) && !beats(combo, prevFor(v)))) return null;
      return {type:combo.type, name:comboName(combo), cardIds:cards.map(c => c.id), cards:cards.map(card)};
    }).filter(Boolean);
  }
  /* ---------- 麻将 ----------
   * 和牌类那套 json 分开：麻将没有叫分/加倍，有的是副露、牌河、
   * 吃碰杠胡选项和听牌信息。AI 拿到的是牌面本身，不需要任何识图。 */
  function stateMahjong(v) {
    const me = v.mySeat;
    const tile = t => ({ id: t.id, kind: t.k, name: mjLabel(t.k) });
    const meld = m => ({ type: m.t, kind: m.k, name: m.label || mjLabel(m.k) });
    return clone({
      version: 1,
      mode: 'mahjong',
      revision: v.revision,
      phase: v.phase,
      phaseName: phases[v.phase] || v.phase,
      round: v.round,
      totalRounds: v.totalRounds,
      mySeat: me,
      turn: v.turn,
      myTurn: v.phase === 'discard' && v.turn === me,
      dealer: v.dealer,
      wallLeft: v.wallLeft,
      roundWind: v.roundWindLabel,
      seatWind: v.seatWindLabel,
      hand: v.myHand.map(tile),
      drawnId: v.drawn ? v.drawn.id : null,
      exposed: (v.myExposed || []).map(meld),
      players: v.players.map((p, i) => ({
        seat: i, name: p.name, computer: p.isAI, score: p.score,
        handCount: p.handCount, seatWind: mjLabel(p.seatWind),
        discards: (p.discards || []).map(k => mjLabel(k)),
        exposed: (p.exposed || []).map(meld),
      })),
      // 别人打出、等我决定要不要吃碰杠胡
      claim: v.pending ? {
        tile: v.pending.tile.label || mjLabel(v.pending.tile.k),
        from: v.pending.from,
        options: (v.claimOptions || []).map(o => ({ type: o.t, fan: o.fan || 0 })),
      } : null,
      awaiting: v.awaiting || [],
      self: v.selfOpts ? {
        canWin: v.selfOpts.hu > 0,
        fan: v.selfOpts.hu,
        fans: v.selfOpts.huFans,
        concealedKongs: v.selfOpts.kongs || [],
        addedKongs: v.selfOpts.addKongs || [],
      } : null,
      ting: v.ting ? {
        discard: v.tingDiscard != null ? mjLabel(v.tingDiscard) : null,
        waits: v.ting.map(x => x.label),
      } : null,
      hintTileId: v.hintId,
      available: {
        discard: v.phase === 'discard' && v.turn === me,
        claim: v.phase === 'claim' && (v.awaiting || []).includes(me),
        selfwin: !!(v.selfOpts && v.selfOpts.hu > 0),
        kongs: v.selfOpts
          ? { concealed: v.selfOpts.kongs || [], added: v.selfOpts.addKongs || [] }
          : { concealed: [], added: [] },
        again: v.phase === 'settle' && App.role !== 'guest',
      },
      result: v.result ? {
        type: v.result.type, winner: v.result.winner, from: v.result.from,
        selfDraw: v.result.selfDraw, fan: v.result.fan, deltas: v.result.deltas,
      } : null,
      matchOver: v.matchOver,
    });
  }

  function state() {
    const v = requireView();
    if (v.mode === 'mahjong') return stateMahjong(v);
    const mine = v.actor === v.mySeat;
    return clone({version:1, revision:v.revision, phase:v.state, phaseName:phases[v.state],
      round:v.roundNo, mySeat:v.mySeat, actor:v.actor, myTurn:mine, landlord:v.landlord,
      hand:v.myHand.map(card), selected:[...App.selected], bottom:v.bottom ? v.bottom.map(card) : null,
      players:v.players.map((p,i) => ({seat:i,name:p.name,computer:p.isAI,cardCount:p.cardCount,
        bid:p.bid,double:p.dbl,score:p.score,lastPlay:p.lastPlay ? {
          pass:!!p.lastPlay.pass, cards:(p.lastPlay.cards || []).map(card), combo:p.lastPlay.combo || null
        } : null})), trick:v.trick, rules:{mode:v.mode,...v.flags,laiziRank:v.laizi},
      available:{bid:mine && v.state==='bidding' ? [0,1,2,3].filter(n=>n===0 || n>v.currentBid) : [],
        double:mine && v.state==='doubling', play:mine && v.state==='playing',
        pass:mine && v.state==='playing' && !!prevFor(v), again:v.state==='settle' && App.role!=='guest'},
      suggestedMoves:candidates(v), suggestionsAreExhaustive:false, history,
      gd:v.gd || null,
      result:v.result ? {winner:v.result.winner,landlordWon:v.result.landlordWon,deltas:v.result.deltas,
        winnerTeam:v.result.winnerTeam,doubleDown:v.result.doubleDown,matchOver:v.result.matchOver,
        gd:v.result.gd || null} : null});
  }
  function select(ids) {
    const v = requireView();
    if (!Array.isArray(ids) || ids.some(x => !Number.isInteger(x)) || new Set(ids).size!==ids.length || ids.some(id=>!v.myHand.some(c=>c.id===id)))
      throw new Error('cardIds 必须是自己手牌中不重复的整数 ID');
    App.selected = new Set(ids); renderGame();
    return {ok:true,selected:ids};
  }
  /* 把一条已经校验过的指令交给房主（或本地）执行 */
  function send(v, kind, data, revision) {
    if (App.role === 'guest') {
      if (!App.guestConn || !App.guestConn.open) throw new Error('房间连接已断开');
      pending = true;
      App.guestConn.send({ t: 'act', kind, data, revision });
      return { ok: true, status: 'submitted', revision };
    }
    let failed = false;
    dispatchAct(v.mySeat, kind, data, () => { failed = true; });
    if (failed) throw new Error('牌局拒绝该操作');
    return { ok: true, status: 'applied', revision: App.view.revision };
  }

  function submitMahjong(v, command) {
    if (command.revision !== v.revision) throw new Error('牌局已变化：重新读取 state 并带上 revision');
    const me = v.mySeat;
    const kind = command.action;
    let act, data = {};

    if (kind === 'discard') {
      if (v.phase !== 'discard' || v.turn !== me) throw new Error('还没轮到你出牌');
      if (!v.myHand.some(c => c.id === command.tileId)) throw new Error('tileId 必须是自己的手牌');
      act = 'mjdiscard'; data = { id: command.tileId };
    } else if (kind === 'claim') {
      if (v.phase !== 'claim' || !(v.awaiting || []).includes(me)) throw new Error('现在没有等你决定的牌');
      const d = command.decision;
      if (!['hu', 'kong', 'pung', 'chow', 'pass'].includes(d)) throw new Error('decision 只能是 hu/kong/pung/chow/pass');
      if (d !== 'pass' && !(v.claimOptions || []).some(o => o.t === d)) throw new Error('这个选项现在不可用');
      act = 'mjclaim'; data = { decision: d };
    } else if (kind === 'kong') {
      if (v.phase !== 'discard' || v.turn !== me) throw new Error('还没轮到你');
      const mode = command.kind === 'add' ? 'add' : 'concealed';
      const pool = mode === 'add' ? ((v.selfOpts || {}).addKongs || []) : ((v.selfOpts || {}).kongs || []);
      if (!pool.includes(command.tileKind)) throw new Error('这种杠现在做不了');
      act = 'mjkong'; data = { kind: mode, k: command.tileKind };
    } else if (kind === 'selfwin') {
      if (!(v.selfOpts && v.selfOpts.hu > 0)) throw new Error('现在不能自摸');
      act = 'mjself'; data = {};
    } else if (kind === 'again') {
      if (v.phase !== 'settle' || App.role === 'guest') throw new Error('仅房主可在结算后开始下一局');
      act = 'again'; data = {};
    } else {
      throw new Error('未知 action（麻将用 discard/claim/kong/selfwin/again）');
    }
    return send(v, act, data, command.revision);
  }

  function submit(command) {
    const v = requireView();
    if (!command || typeof command !== 'object') throw new Error('需要 JSON 指令');
    if (v.mode === 'mahjong') return submitMahjong(v, command);
    if (command.revision !== v.revision) throw new Error('牌局已变化：重新读取 state 并带上 revision');
    const kind = command.action;
    if (kind === 'select') return select(command.cardIds);
    if (pending) throw new Error('上一条操作仍在等待房主确认');
    if (kind !== 'again' && v.actor !== v.mySeat) throw new Error('还没有轮到你的座位');
    let data = {};
    if (kind==='bid') {
      if (v.state!=='bidding' || !Number.isInteger(command.value) || ![0,1,2,3].includes(command.value) || (command.value!==0 && command.value<=v.currentBid)) throw new Error('叫分必须为 0 或高于当前叫分的 1–3');
      data = {v:command.value};
    } else if (kind==='double') {
      if (v.state!=='doubling' || typeof command.yes!=='boolean') throw new Error('加倍阶段需要布尔值 yes');
      data = {yes:command.yes};
    } else if (kind==='play') {
      if (v.state!=='playing') throw new Error('当前不是出牌阶段');
      select(command.cardIds);
      const selected = v.myHand.filter(c=>App.selected.has(c.id));
      if (v.mode === 'guandan') {
        const prev = v.trick.combo && v.trick.seat !== v.mySeat ? v.trick.combo : null;
        const combo = gdAnalyze(selected, prev, v.gd ? v.gd.myLevelRank : null);
        if (!combo || (prev && !gdBeats(combo, prev))) throw new Error('牌型不合法，或者不能压过上一手');
      } else {
        const combo = analyze(selected.map(c=>c.r),prevFor(v),v.laizi);
        if (!combo || (prevFor(v) && !beats(combo,prevFor(v)))) throw new Error('牌型不合法，或者不能压过上一手');
      }
      data = {ids:command.cardIds};
    } else if (kind==='pass') {
      if (v.state!=='playing' || !prevFor(v)) throw new Error('首出不能不出');
    } else if (kind==='again') {
      if (v.state!=='settle' || App.role==='guest') throw new Error('仅房主可在结算后开始下一局');
    } else throw new Error('未知 action');
    return send(v, kind, data, command.revision);
  }
  function update() {
    const panel = document.getElementById('agent-panel');
    if (!panel) return;
    panel.classList.toggle('hidden', !enabled || !App.view);
    if (!enabled || !App.view) return;
    remember(App.view);
    const s = state();
    document.getElementById('agent-summary').textContent = `${s.phaseName} · 座位 ${s.mySeat} · ${s.myTurn ? '轮到你操作' : '等待其他玩家'}`;
    document.getElementById('agent-cards').innerHTML = s.hand.map(c=>`<button type="button" class="agent-card${App.selected.has(c.id)?' selected':''}" data-card-id="${c.id}" aria-pressed="${App.selected.has(c.id)}">${esc(c.name)} <small>ID ${c.id}</small></button>`).join('');
    document.getElementById('agent-cards').querySelectorAll('button').forEach(b=>b.onclick=()=>{
      const ids=new Set(App.selected), id=Number(b.dataset.cardId); if(ids.has(id)) ids.delete(id); else ids.add(id); select([...ids]);
    });
    document.getElementById('agent-state').value = JSON.stringify(s,null,2);
    const host = document.getElementById('agent-moves');
    const moves = s.suggestedMoves || [];
    host.innerHTML = moves.slice(0,40).map((m,i)=>`<button type="button" data-move="${i}">${esc(m.name)}：${(m.cards||[]).map(c=>esc(c.name)).join('、')}</button>`).join('');
    host.querySelectorAll('button').forEach(b=>b.onclick=()=>select(moves[Number(b.dataset.move)].cardIds));
    document.dispatchEvent(new CustomEvent('ddz:state',{detail:s}));
  }
  function toggle(value) {
    enabled = value === 'agent';
    document.body.classList.toggle('agent-mode',enabled);
    if (!enabled) { history=[]; lastRevision=null; pending=false; }
    try {localStorage.setItem('ddz_control',enabled?'agent':'human');} catch (_) {}
    update();
  }
  async function sync() {
    if (syncing || !enabled || !App.view || !/^https?:$/.test(location.protocol)) return;
    syncing=true;
    try {
      if (!session) {
        const r=await fetch('/bridge/register',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
        if(!r.ok) throw new Error('bridge unavailable'); session=await r.json();
      }
      const r=await fetch('/bridge/sync',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.token},body:JSON.stringify({id:session.id,state:state()})});
      if(!r.ok) {session=null;throw new Error('bridge unavailable');}
      const batch=await r.json();
      document.getElementById('agent-endpoint').textContent=`HTTP: ${location.origin}/api/sessions/${session.id} | Bearer ${session.token}`;
      for (const item of batch.commands) {
        let result;
        try {result=submit(item.command);} catch(e) {result={ok:false,error:e.message};}
        await fetch('/bridge/result',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.token},body:JSON.stringify({id:session.id,requestId:item.requestId,result})});
      }
    } catch (_) {document.getElementById('agent-endpoint').textContent='浏览器 API 可用：window.ddzAgent；HTTP 桥需要用启动脚本打开。';}
    finally {syncing=false;}
  }
  function boot() {
    const control=document.getElementById('player-control');
    try {control.value=localStorage.getItem('ddz_control') || 'human';} catch (_) {}
    control.onchange=()=>toggle(control.value); toggle(control.value);
    document.getElementById('agent-close').onclick=()=>{control.value='human';toggle('human');};
    document.getElementById('agent-toggle').onclick=()=>{control.value=enabled?'human':'agent';toggle(control.value);};
    document.getElementById('agent-copy').onclick=async()=>{
      try {await navigator.clipboard.writeText(JSON.stringify(state(),null,2));toast('牌局 JSON 已复制');}
      catch (_) {document.getElementById('agent-state').select();toast('请按 Ctrl+C 复制');}
    };
    document.getElementById('agent-execute').onclick=()=>{
      try {const command=JSON.parse(document.getElementById('agent-command').value); const result=submit(command);document.getElementById('agent-feedback').textContent=JSON.stringify(result);}
      catch(e) {document.getElementById('agent-feedback').textContent=e.message;}
    };
    document.getElementById('agent-play').onclick=()=>{
      try {
        if (App.view && App.view.mode === 'mahjong') {
          const id = [...App.selected][0];
          if (id == null) throw new Error('先选一张牌');
          submit({action:'discard', tileId:id, revision:App.view.revision});
        } else {
          submit({action:'play',cardIds:[...App.selected],revision:App.view.revision});
        }
      } catch(e){toast(e.message);}
    };
    document.getElementById('agent-template').onclick=()=>{
      const s=state();
      let c;
      if (s.mode === 'mahjong') {
        if (s.available.claim) c = {action:'claim', decision:(s.claim && s.claim.options.length) ? s.claim.options[0].type : 'pass'};
        else if (s.available.selfwin) c = {action:'selfwin'};
        else if (s.available.again) c = {action:'again'};
        else c = {action:'discard', tileId:(s.hintTileId != null ? s.hintTileId : (s.hand[0] && s.hand[0].id))};
      } else {
        c = s.available.bid.length?{action:'bid',value:0}:s.available.double?{action:'double',yes:false}:s.available.again?{action:'again'}:{action:'play',cardIds:[...App.selected]};
      }
      document.getElementById('agent-command').value=JSON.stringify({...c,revision:s.revision},null,2);
    };
    setInterval(sync,500);
  }
  document.addEventListener('DOMContentLoaded',boot);
  window.ddzAgent=Object.freeze({state,select,act:submit});
  return {update, get enabled(){return enabled;}, reject(){pending=false;}};
})();
