import { randomInt } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { RANDOM_TICK_MS, DEFAULT_TICK_TYPE } from './config.js';
import { DATA_CHANNELS } from './channels.js';
import { buildChannelFrame, sendDataList } from './dataUtils.js';
import { credentialsOk, queryCredentials } from './auth.js';
import { pushActivity } from './activity.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tickTypeFromClientMessage(data, isBinary) {
  if (isBinary) return 'binary';
  const s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  try {
    const o = JSON.parse(s);
    if (o != null && o.type != null) {
      const label = String(o.type).trim();
      if (label.length > 0) return label.slice(0, 80);
    }
  } catch { /* not JSON */ }
  const flat = s.trim().slice(0, 80);
  return flat.length > 0 ? flat : DEFAULT_TICK_TYPE;
}

function unknownChannelError(ch) {
  return JSON.stringify({
    type: 'error',
    message: `Unknown channel: "${ch}". Available: ${Object.keys(DATA_CHANNELS).join(', ')}`,
    t: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Broadcast helper (needs wss — defined after createWsServer)
// ---------------------------------------------------------------------------

export function broadcastDataList(wss, channel) {
  if (!DATA_CHANNELS[channel]) return 0;
  let sent = 0;
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (!client.subscriptions?.has(channel)) continue;
    const frame = buildChannelFrame(channel, client.subscriptions.get(channel) ?? {});
    if (!frame) continue;
    try { client.send(frame); sent++; } catch { /* ignore */ }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Message handlers (one function per message type)
// ---------------------------------------------------------------------------

function handleWatchlist(ws, user, msg) {
  const ch = String(msg.channel);
  if (!DATA_CHANNELS[ch]) { ws.send(unknownChannelError(ch)); return; }
  const params = {
    page: Math.max(1, Number(msg.page) || 1),
    limit: Math.max(0, Number(msg.limit) || 0),
    watchlist: true,
    responseType: 'watchlist',
  };
  ws.subscriptions.set(ch, params);
  ws.lastTickType = ch;
  const frame = buildChannelFrame(ch, params);
  if (frame) ws.send(frame);
  ws.send(JSON.stringify({ type: 'subscribed', channel: ch, watchlist: true, page: params.page, limit: params.limit, t: Date.now() }));
  console.log(`[ws] watchlist-subscribe ${user} → ${ch}`);
}

function handleSearch(ws, user, msg) {
  const ch = String(msg.channel);
  if (!DATA_CHANNELS[ch]) { ws.send(unknownChannelError(ch)); return; }
  const params = {
    q:            String(msg.q ?? '').trim(),
    page:         Math.max(1, Number(msg.page)  || 1),
    limit:        Math.max(0, Number(msg.limit) || 0),
    responseType: 'search',
  };
  ws.subscriptions.set(ch, params);
  ws.lastTickType = ch;
  const frame = buildChannelFrame(ch, params);
  if (frame) ws.send(frame);
  ws.send(JSON.stringify({ type: 'subscribed', channel: ch, q: params.q, page: params.page, limit: params.limit, t: Date.now() }));
  console.log(`[ws] search-subscribe ${user} → ${ch} q="${params.q}"`);
}

function handleSubscribe(ws, user, msg) {
  const ch = String(msg.channel);
  const params = {
    page:  Math.max(1, Number(msg.page)  || 1),
    limit: Math.max(0, Number(msg.limit) || 0),
  };
  ws.subscriptions.set(ch, params);
  ws.lastTickType = ch;
  console.log(`[ws] subscribe ${user} → ${ch} page=${params.page} limit=${params.limit}`);
  sendDataList(ws, ch, params);
}

function handlePaginate(ws, user, msg) {
  const ch = String(msg.channel);
  if (!ws.subscriptions.has(ch)) {
    ws.send(JSON.stringify({ type: 'error', message: `Not subscribed to "${ch}". Subscribe first.`, t: Date.now() }));
    return;
  }
  const existing = ws.subscriptions.get(ch) ?? {};
  const params = {
    responseType: 'paginate',
    page:  msg.page  !== undefined ? Math.max(1, Number(msg.page)  || 1) : (existing.page  || 1),
    limit: msg.limit !== undefined ? Math.max(0, Number(msg.limit) || 0) : (existing.limit ?? 0),
  };
  ws.subscriptions.set(ch, params);
  console.log(`[ws] paginate ${user} → ${ch} page=${params.page} limit=${params.limit}`);
  const frame = buildChannelFrame(ch, params);
  if (frame) ws.send(frame);
}

function handleUnsubscribe(ws, user, msg) {
  const ch = String(msg.channel);
  ws.subscriptions.delete(ch);
  console.log(`[ws] unsubscribe ${user} → ${ch}`);
  ws.send(JSON.stringify({ type: 'unsubscribed', channel: ch, t: Date.now() }));
}

function handleDetail(ws, user, msg) {
  const id = String(msg.id ?? '').trim();
  if (!id) {
    ws.send(JSON.stringify({ type: 'error', message: 'detail requires an id', t: Date.now() }));
    return;
  }
  const ch = 'allMarkets';
  const markets = DATA_CHANNELS[ch]?.() ?? [];
  if (!Array.isArray(markets) || !markets.find(m => String(m?.id) === id)) {
    ws.send(JSON.stringify({ type: 'error', message: `No market found with id "${id}"`, t: Date.now() }));
    return;
  }
  const params = { id, responseType: 'detail' };
  ws.subscriptions.set(ch, params);
  ws.lastTickType = ch;
  const frame = buildChannelFrame(ch, params);
  if (frame) ws.send(frame);
  ws.send(JSON.stringify({ type: 'subscribed', channel: ch, id, t: Date.now() }));
  console.log(`[ws] detail-subscribe ${user} → id=${id}`);
}

function handleChannels(ws) {
  ws.send(JSON.stringify({
    type: 'channels',
    channels:   Object.keys(DATA_CHANNELS),
    subscribed: Object.fromEntries(ws.subscriptions),
    t: Date.now(),
  }));
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

function routeMessage(ws, user, rawData, isBinary) {
  const payload = isBinary ? rawData : rawData.toString();

  pushActivity({
    kind:   'ws',
    t:      Date.now(),
    user,
    remote: ws._remoteAddress,
    framing: isBinary ? 'binary' : 'text',
    body:   isBinary ? Buffer.from(rawData).toString('base64') : String(payload),
  });

  if (!isBinary) {
    try {
      const msg = JSON.parse(payload);
      if (!msg?.type) throw new Error('no type');

      switch (msg.type) {
        case 'watchlist':   if (msg.channel) { handleWatchlist(ws, user, msg);   return; } break;
        case 'search':      if (msg.channel) { handleSearch(ws, user, msg);      return; } break;
        case 'subscribe':   if (msg.channel) { handleSubscribe(ws, user, msg);   return; } break;
        case 'paginate':    if (msg.channel) { handlePaginate(ws, user, msg);    return; } break;
        case 'unsubscribe': if (msg.channel) { handleUnsubscribe(ws, user, msg); return; } break;
        case 'channels':    handleChannels(ws); return;
        case 'detail':      if (msg.id)      { handleDetail(ws, user, msg);      return; } break;
      }
    } catch { /* not JSON or no type — fall through to echo */ }
  }

  ws.lastTickType = tickTypeFromClientMessage(rawData, isBinary);
  ws.send(JSON.stringify({
    type: 'echo',
    payload: isBinary ? Buffer.from(rawData).toString('base64') : payload,
    t: Date.now(),
  }));
}

// ---------------------------------------------------------------------------
// WebSocket server factory
// ---------------------------------------------------------------------------

export function createWsServer(httpServer, getAccepting) {
  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info) => getAccepting() && credentialsOk(info.req),
  });

  // Tick loop — push snapshots to all subscribed clients
  setInterval(() => {
    if (!getAccepting()) return;
    const t = Date.now();
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;

      if (client.subscriptions?.size > 0) {
        for (const [channel, params] of client.subscriptions) {
          const frame = buildChannelFrame(channel, params ?? {});
          if (!frame) continue;
          try { client.send(frame); } catch { /* ignore */ }
        }
        continue;
      }

      // Default random tick for unsubscribed clients
      const type  = client.lastTickType || DEFAULT_TICK_TYPE;
      const value = randomInt(0, 1_000_000_000);
      try { client.send(JSON.stringify({ type, value, t })); } catch { /* ignore */ }
    }
  }, RANDOM_TICK_MS);

  wss.on('connection', (ws, req) => {
    const creds = queryCredentials(req);
    const user  = creds?.username ?? '?';
    const id    = req.socket.remoteAddress ?? 'unknown';

    ws.lastTickType  = DEFAULT_TICK_TYPE;
    ws.subscriptions = new Map(); // Map<channel, params>
    ws._remoteAddress = id;

    console.log(`[ws] open user=${user} ${id} (${wss.clients.size} clients)`);

    ws.send(JSON.stringify({ type: 'welcome', message: 'connected', channels: Object.keys(DATA_CHANNELS), t: Date.now() }));

    // Auto-subscribe via URL: ?channel=allMarkets&limit=20&page=1
    try {
      const url     = new URL(req.url ?? '/', `http://localhost`);
      const initCh  = url.searchParams.get('channel');
      if (initCh && DATA_CHANNELS[initCh]) {
        const params = {
          page:  Math.max(1, Number(url.searchParams.get('page'))  || 1),
          limit: Math.max(0, Number(url.searchParams.get('limit')) || 0),
        };
        ws.subscriptions.set(initCh, params);
        console.log(`[ws] auto-subscribed ${user} → ${initCh}`);
        sendDataList(ws, initCh, params);
      }
    } catch { /* malformed URL */ }

    ws.on('message', (rawData, isBinary) => routeMessage(ws, user, rawData, isBinary));

    ws.on('close', (code, reason) => {
      const why = reason?.length ? reason.toString() : '';
      console.log(`[ws] close ${user} code=${code}${why ? ` reason=${why}` : ''}`);
    });

    ws.on('error', (err) => console.error(`[ws] error ${user}:`, err));
  });

  return wss;
}
