'use strict';
/* net.js — thin PeerJS (WebRTC) wrapper. The room code doubles as the host's
   peer id; the guest dials it directly, so no game server is needed.

   Connectivity: STUN gets peers through ordinary home NATs. Networks with
   client isolation or blocked UDP (campus WiFi like eduroam, many offices)
   also need a TURN relay — set TURN_CREDENTIALS_URL below to enable one. */

const NET_PREFIX = 'ddz26-room-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/* Optional TURN relay. Create a free account at
   https://www.metered.ca/stun-turn (50 GB/month is plenty for card games)
   and paste your credentials URL here, e.g.
   'https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=YOURKEY'
   The fetched servers are merged in front of the STUN list. */
const TURN_CREDENTIALS_URL = 'https://doudizhu-online.metered.live/api/v1/turn/credentials?apiKey=69960ccff638874fa5ab1dcb405d13b1097f';

let iceCache = null;
async function getIceServers() {
  if (iceCache) return iceCache;
  let servers = STUN_SERVERS.slice();
  if (TURN_CREDENTIALS_URL) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(TURN_CREDENTIALS_URL, { signal: ctl.signal });
      clearTimeout(timer);
      const turn = await res.json();
      if (Array.isArray(turn) && turn.length) servers = turn.concat(STUN_SERVERS);
    } catch (e) { /* fall back to STUN-only */ }
  }
  iceCache = servers;
  return servers;
}

function makeRoomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function netAvailable() { return typeof Peer !== 'undefined'; }

/* Reconnect to the signaling broker if the connection drops; existing
   WebRTC data channels keep working during broker outages. */
function autoReconnect(peer) {
  peer.on('disconnected', () => {
    if (!peer.destroyed) { try { peer.reconnect(); } catch (e) { } }
  });
}

/* Host side: claim the room id, accept guest connections. Async: resolves
   to the Peer once ICE servers are known. */
async function createHostPeer(code, cb) {
  const iceServers = await getIceServers();
  const peer = new Peer(NET_PREFIX + code, { debug: 1, config: { iceServers } });
  autoReconnect(peer);
  peer.on('open', () => cb.onReady && cb.onReady());
  peer.on('error', e => {
    if (e.type === 'unavailable-id') cb.onCodeTaken && cb.onCodeTaken();
    else if (e.type !== 'peer-unavailable') cb.onError && cb.onError(e.type);
  });
  peer.on('connection', conn => {
    conn.on('open', () => cb.onConnection && cb.onConnection(conn));
  });
  return peer;
}

/* Guest side: dial the host's room id. */
async function createGuestPeer(code, cb) {
  const iceServers = await getIceServers();
  const peer = new Peer({ debug: 1, config: { iceServers } });
  autoReconnect(peer);
  peer.on('open', () => {
    const conn = peer.connect(NET_PREFIX + code, { reliable: true });
    conn.on('open', () => cb.onOpen && cb.onOpen(conn));
    conn.on('data', d => cb.onData && cb.onData(d));
    conn.on('close', () => cb.onClose && cb.onClose());
    conn.on('error', () => cb.onError && cb.onError('conn'));
  });
  peer.on('error', e => {
    if (e.type === 'peer-unavailable') cb.onNotFound && cb.onNotFound();
    else cb.onError && cb.onError(e.type);
  });
  return peer;
}

/* Network self-test used by the in-app diagnostics panel.
   Reports signaling-broker reachability and which ICE candidate types
   this network can produce. */
async function netDiagnose() {
  const res = { broker: false, stun: false, turn: false };
  if (netAvailable()) {
    await new Promise(resolve => {
      let p = null;
      const done = ok => { res.broker = ok; try { if (p) p.destroy(); } catch (e) { } resolve(); };
      const to = setTimeout(() => done(false), 8000);
      try {
        p = new Peer();
        p.on('open', () => { clearTimeout(to); done(true); });
        p.on('error', () => { clearTimeout(to); done(false); });
      } catch (e) { clearTimeout(to); done(false); }
    });
  }
  try {
    const iceServers = await getIceServers();
    const types = await new Promise(resolve => {
      const pc = new RTCPeerConnection({ iceServers });
      pc.createDataChannel('probe');
      const ts = new Set();
      pc.onicecandidate = e => {
        if (e.candidate) {
          const m = /typ (\w+)/.exec(e.candidate.candidate);
          if (m) ts.add(m[1]);
        }
      };
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => { });
      setTimeout(() => { try { pc.close(); } catch (e) { } resolve(ts); }, 7000);
    });
    res.stun = types.has('srflx');
    res.turn = types.has('relay');
  } catch (e) { }
  return res;
}
