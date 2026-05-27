import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';

// ---------------------------------------------------------------------------
// Data — loaded once at startup from data.json
// ---------------------------------------------------------------------------
const data = JSON.parse(readFileSync(new URL('./data.json', import.meta.url)));

/**
 * Registry of named data channels.
 * Each key is the channel name clients subscribe to; the value is a getter
 * that returns the current snapshot for that channel.
 *
 * Add / remove entries here to expose new channels without touching the
 * connection or tick logic.
 */
const DATA_CHANNELS = {
  futuresAccounts:          () => data.futuresAccounts,
  predictionsAccounts:      () => data.predictionsAccounts,
  predictionsRecentProducts:() => data.predictionsRecentProducts,
  allMarkets:               () => data.allMarkets,
  featured_markets:         () => data.featured_markets,
  'allMarkets.futures':     () => data.allMarkets.futures,
  'allMarkets.predictions': () => data.allMarkets.predictions,
};

/**
 * Send a full data-channel snapshot to one WebSocket client.
 *
 * Message shape: `{ type: <channel>, data: <list|object>, t: <ms> }`
 *
 * @param {WebSocket} ws
 * @param {string} channel  - must be a key in DATA_CHANNELS
 * @returns {boolean}        - false when the channel name is unknown
 */
function sendDataList(ws, channel) {
  const getter = DATA_CHANNELS[channel];
  if (!getter) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Unknown channel: "${channel}". Available: ${Object.keys(DATA_CHANNELS).join(', ')}`,
        t: Date.now(),
      }),
    );
    return false;
  }
  ws.send(JSON.stringify({ type: channel, data: getter(), t: Date.now() }));
  return true;
}

/**
 * Broadcast a data-channel snapshot to every currently-subscribed client.
 *
 * @param {string} channel
 * @returns {number}  count of clients that received the message
 */
function broadcastDataList(channel) {
  const getter = DATA_CHANNELS[channel];
  if (!getter) return 0;
  const msg = JSON.stringify({ type: channel, data: getter(), t: Date.now() });
  let sent = 0;
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (!client.subscriptions?.has(channel)) continue;
    try {
      client.send(msg);
      sent += 1;
    } catch {
      /* ignore half-closed sockets */
    }
  }
  return sent;
}

const RANDOM_TICK_MS = 500;
const ACTIVITY_LOG_MAX = 100;
const MAX_POST_BYTES = 256 * 1024;

/** @type {Array<{ kind: 'http', t: number, contentType: string, remote: string, body: string } | { kind: 'ws', t: number, user: string, remote: string, framing: 'text'|'binary', body: string }>} */
const activityLog = [];

/** When false, new WebSocket handshakes are rejected and tick broadcasts are skipped (until /api/ws-resume). */
let websocketAccepting = true;

const PORT = Number(process.env.PORT) || 8080;
const EXPECTED_USER = process.env.WS_USERNAME ?? 'admin';
const EXPECTED_PASS = process.env.WS_PASSWORD ?? 'changeme';

if (!process.env.WS_USERNAME || !process.env.WS_PASSWORD) {
  console.warn(
    '[ws] WS_USERNAME and/or WS_PASSWORD unset; defaults may be in use. Set both in production.',
  );
}

function escapeHtml(s) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizePathname(pathname) {
  if (pathname !== '/' && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/** Browser JSON POSTs send a preflight OPTIONS; respond so the real POST runs. */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
  };
}

function isPostIngestPath(path) {
  return path === '/post' || path === '/';
}

function allowsCorsOptions(path) {
  return (
    isPostIngestPath(path) ||
    path === '/api/close-ws' ||
    path === '/api/ws-resume'
  );
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (chunk) => {
      len += chunk.length;
      if (len > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pushActivity(entry) {
  activityLog.unshift(entry);
  if (activityLog.length > ACTIVITY_LOG_MAX) activityLog.length = ACTIVITY_LOG_MAX;
}

function prettyBodyForDisplay(body, contentType) {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  return body;
}

function tryPrettyJson(body) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

const ACTIVITY_POLL_MS = 750;

function buildActivityRowsHtml() {
  if (activityLog.length === 0) {
    return '<tr><td colspan="4" class="empty">Nothing yet. POST to <code>/post</code> or send a WebSocket message.</td></tr>';
  }
  return activityLog
    .map((e) => {
      const time = new Date(e.t).toISOString();
      const timeCell = `<td class="cell-time"><time datetime="${escapeHtml(time)}">${escapeHtml(time)}</time></td>`;
      if (e.kind === 'http') {
        const displayBody = prettyBodyForDisplay(e.body, e.contentType);
        const typeCell = `<td class="cell-ct"><span class="badge badge-http">HTTP</span> <span class="subtle">${escapeHtml(e.contentType || '(none)')}</span></td>`;
        const clientCell = `<td class="cell-ip"><code class="ip">${escapeHtml(e.remote)}</code></td>`;
        const bodyCell = `<td class="cell-body"><pre class="body" tabindex="0">${escapeHtml(displayBody)}</pre></td>`;
        return `<tr class="log-row">${timeCell}${typeCell}${clientCell}${bodyCell}</tr>`;
      }
      const displayBody =
        e.framing === 'binary'
          ? e.body
          : tryPrettyJson(e.body);
      const typeCell = `<td class="cell-ct"><span class="badge badge-ws">WS</span> <span class="subtle">${e.framing}</span></td>`;
      const clientCell = `<td class="cell-ip"><code class="ip">${escapeHtml(e.user)}</code> <span class="subtle">${escapeHtml(e.remote)}</span></td>`;
      const bodyCell = `<td class="cell-body"><pre class="body" tabindex="0">${escapeHtml(displayBody)}</pre></td>`;
      return `<tr class="log-row">${timeCell}${typeCell}${clientCell}${bodyCell}</tr>`;
    })
    .join('');
}

function renderPostDashboard() {
  const rows = buildActivityRowsHtml();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Activity log</title>
  <style>
    :root {
      --bg: #0f1419;
      --surface: #1a2332;
      --surface2: #243044;
      --border: #334155;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-dim: rgba(56, 189, 248, 0.15);
      --ok: #34d399;
      --radius: 10px;
      --shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
      --font: "Segoe UI", system-ui, -apple-system, sans-serif;
      --mono: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--font);
      line-height: 1.5;
      color: var(--text);
      background: radial-gradient(1200px 600px at 10% -10%, #1e3a5f 0%, transparent 55%),
        radial-gradient(900px 500px at 100% 0%, #312e81 0%, transparent 50%),
        var(--bg);
    }
    .shell {
      max-width: 1120px;
      margin: 0 auto;
      padding: 2rem 1.25rem 3rem;
    }
    header {
      margin-bottom: 2rem;
    }
    header h1 {
      margin: 0 0 0.35rem;
      font-size: clamp(1.5rem, 3vw, 1.85rem);
      font-weight: 650;
      letter-spacing: -0.02em;
    }
    .lede {
      margin: 0;
      color: var(--muted);
      font-size: 0.95rem;
      max-width: 52ch;
    }
    .hints {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 1rem;
    }
    .hint {
      font-size: 0.8rem;
      color: var(--muted);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 0.35rem 0.75rem;
    }
    .hint code { color: var(--accent); font-size: 0.85em; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 1.25rem 1.35rem;
      margin-bottom: 1.75rem;
    }
    .card h2 {
      margin: 0 0 1rem;
      font-size: 1rem;
      font-weight: 600;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .card h2::before {
      content: "";
      width: 4px;
      height: 1.1em;
      border-radius: 2px;
      background: linear-gradient(180deg, var(--accent), #818cf8);
    }
    .card-note {
      margin: 0 0 0.75rem;
      font-size: 0.88rem;
      color: var(--muted);
      line-height: 1.45;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6rem;
      align-items: center;
      margin-top: 0;
    }
    button {
      font-family: var(--font);
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0.55rem 1.1rem;
      border-radius: 8px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: transform 0.08s, background 0.15s, border-color 0.15s;
    }
    button:active { transform: scale(0.98); }
    #closeWsBtn {
      background: rgba(248, 113, 113, 0.12);
      color: #fecaca;
      border: 1px solid rgba(248, 113, 113, 0.45);
    }
    #closeWsBtn:hover {
      background: rgba(248, 113, 113, 0.22);
    }
    #restartWsBtn {
      background: rgba(52, 211, 153, 0.1);
      color: #86efac;
      border: 1px solid rgba(52, 211, 153, 0.4);
    }
    #restartWsBtn:hover {
      background: rgba(52, 211, 153, 0.2);
    }
    .substatus {
      margin-top: 0.65rem;
      font-size: 0.84rem;
      color: var(--muted);
      min-height: 1.25em;
    }
    #wsDashStatus.ok { color: var(--ok); }
    #wsDashStatus.err { color: #f87171; }
    #actionsStatus {
      font-size: 0.85rem;
      color: var(--muted);
      min-height: 1.25em;
    }
    #actionsStatus.ok { color: var(--ok); }
    #actionsStatus.err { color: #f87171; }
    .table-wrap {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow: auto;
      max-height: min(70vh, 720px);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 1;
      text-align: left;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      background: var(--surface2);
      border-bottom: 1px solid var(--border);
      padding: 0.65rem 0.85rem;
      white-space: nowrap;
    }
    tbody td {
      padding: 0.75rem 0.85rem;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    tr.log-row:nth-child(even) td { background: rgba(255, 255, 255, 0.02); }
    tr.log-row:last-child td { border-bottom: none; }
    .cell-time { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .cell-ct { width: 1%; }
    .badge {
      display: inline-block;
      font-size: 0.72rem;
      font-family: var(--mono);
      padding: 0.2rem 0.45rem;
      border-radius: 6px;
      vertical-align: middle;
    }
    .badge-http {
      background: var(--accent-dim);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.35);
    }
    .badge-ws {
      background: rgba(251, 191, 36, 0.12);
      color: #fbbf24;
      border: 1px solid rgba(251, 191, 36, 0.35);
    }
    .subtle {
      color: var(--muted);
      font-size: 0.78rem;
      margin-left: 0.25rem;
    }
    .ip {
      font-family: var(--mono);
      font-size: 0.8rem;
      color: #cbd5e1;
      background: var(--surface2);
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
    }
    pre.body {
      margin: 0;
      font-family: var(--mono);
      font-size: 0.8rem;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      color: #f1f5f9;
      max-height: 16rem;
      overflow: auto;
      padding: 0.5rem 0.6rem;
      background: #0c1222;
      border-radius: 6px;
      border: 1px solid var(--border);
    }
    .empty {
      text-align: center;
      color: var(--muted);
      padding: 2.5rem 1rem !important;
      font-size: 0.95rem;
    }
    .empty code { color: var(--accent); font-size: 0.9em; }
    .section-title {
      margin: 0 0 0.75rem;
      font-size: 1rem;
      font-weight: 600;
      color: var(--text);
      letter-spacing: -0.01em;
    }
    .live {
      display: inline-block;
      font-size: 0.65rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      vertical-align: middle;
      margin-left: 0.35rem;
      padding: 0.15rem 0.45rem;
      border-radius: 999px;
      background: rgba(52, 211, 153, 0.15);
      color: var(--ok);
      border: 1px solid rgba(52, 211, 153, 0.35);
    }
    .live.off {
      background: rgba(248, 113, 113, 0.12);
      color: #f87171;
      border-color: rgba(248, 113, 113, 0.35);
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <h1>Activity log</h1>
      <p class="lede">HTTP POST bodies and WebSocket client messages in one table. The table updates automatically. Close connections shuts down all WebSockets and blocks new ones until you click Restart.</p>
      <div class="hints">
        <span class="hint"><code>POST</code> /post or <code>POST</code> /</span>
        <span class="hint">Dashboard <code>/</code></span>
        <span class="hint">WS <code>ws://localhost:${PORT}/?username=&amp;password=</code></span>
      </div>
    </header>

    <div class="card">
      <h2>Controls</h2>
      <p class="card-note">The activity table updates on its own. Close connections closes every client and refuses new WebSocket connections until Restart (Restart re-opens the server and connects this page).</p>
      <div class="actions">
        <button type="button" id="closeWsBtn">Close connections</button>
        <button type="button" id="restartWsBtn">Restart</button>
        <span id="actionsStatus"></span>
      </div>
      <div class="substatus" id="wsDashStatus" aria-live="polite"></div>
    </div>

    <h2 class="section-title">Recent activity <span class="live" id="liveBadge" title="Table updates automatically">live</span></h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Time (UTC)</th><th>Type</th><th>Client</th><th>Payload</th></tr></thead>
        <tbody id="activityTbody">${rows}</tbody>
      </table>
    </div>
  </div>

  <script>
    (function () {
      var POLL_MS = ${ACTIVITY_POLL_MS};
      var tbody = document.getElementById('activityTbody');
      var liveBadge = document.getElementById('liveBadge');
      var statusEl = document.getElementById('actionsStatus');
      var wsDashEl = document.getElementById('wsDashStatus');
      var dashboardWs = null;
      var WS_DEFAULT_USER = ${JSON.stringify(EXPECTED_USER)};
      var WS_DEFAULT_PASS = ${JSON.stringify(EXPECTED_PASS)};

      function syncControlButtons() {
        var closeBtn = document.getElementById('closeWsBtn');
        var restartBtn = document.getElementById('restartWsBtn');
        if (!closeBtn || !restartBtn) return;
        var rs = dashboardWs ? dashboardWs.readyState : WebSocket.CLOSED;
        var isOpen = rs === WebSocket.OPEN;
        var isConnecting = rs === WebSocket.CONNECTING;
        closeBtn.hidden = !isOpen;
        restartBtn.hidden = isOpen || isConnecting;
      }

      function setWsDash(text, cls) {
        if (!wsDashEl) return;
        wsDashEl.className = cls ? 'substatus ' + cls : 'substatus';
        wsDashEl.textContent = text || '';
      }

      function buildDashboardWsUrl() {
        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return (
          proto +
          '//' +
          location.host +
          '/?username=' +
          encodeURIComponent(WS_DEFAULT_USER) +
          '&password=' +
          encodeURIComponent(WS_DEFAULT_PASS)
        );
      }

      function connectDashboardWebSocket() {
        if (dashboardWs) {
          try {
            dashboardWs.onopen = null;
            dashboardWs.onclose = null;
            dashboardWs.onerror = null;
            dashboardWs.onmessage = null;
            dashboardWs.close(4000, 'restart');
          } catch (e) {
            /* ignore */
          }
          dashboardWs = null;
          syncControlButtons();
        }
        setWsDash('Connecting WebSocket…', '');
        var url = buildDashboardWsUrl();
        var ws;
        try {
          ws = new WebSocket(url);
        } catch (e) {
          setWsDash('Could not start WebSocket: ' + e.message, 'err');
          syncControlButtons();
          return;
        }
        dashboardWs = ws;
        syncControlButtons();
        ws.onopen = function () {
          setWsDash('', '');
          syncControlButtons();
        };
        ws.onclose = function (ev) {
          if (dashboardWs === ws) dashboardWs = null;
          var detail =
            'code ' + ev.code + (ev.reason ? ' (' + String(ev.reason) + ')' : '');
          setWsDash('Browser WebSocket closed (' + detail + ').', ev.wasClean ? 'ok' : '');
          syncControlButtons();
        };
        ws.onerror = function () {
          setWsDash('Browser WebSocket error.', 'err');
          syncControlButtons();
        };
      }

      function updateActivityTable() {
        return fetch('/api/activity-rows', { cache: 'no-store' })
          .then(function (r) {
            if (!r.ok) throw new Error(String(r.status));
            return r.text();
          })
          .then(function (html) {
            tbody.innerHTML = html;
            if (liveBadge) {
              liveBadge.classList.remove('off');
              liveBadge.textContent = 'live';
            }
          })
          .catch(function () {
            if (liveBadge) {
              liveBadge.classList.add('off');
              liveBadge.textContent = 'offline';
            }
          });
      }

      setInterval(updateActivityTable, POLL_MS);
      updateActivityTable();

      document.getElementById('closeWsBtn').addEventListener('click', function () {
        statusEl.className = '';
        statusEl.textContent = 'Closing…';
        fetch('/api/close-ws', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function (r) {
            return r.json().then(function (j) {
              return { ok: r.ok, j: j };
            });
          })
          .then(function (x) {
            if (x.ok && x.j && x.j.ok) {
              statusEl.className = '';
              statusEl.textContent = '';
              setWsDash('', '');
              return updateActivityTable();
            }
            statusEl.className = 'err';
            statusEl.textContent = 'Error: ' + (x.j && x.j.error ? x.j.error : 'request failed');
            syncControlButtons();
          })
          .catch(function (err) {
            statusEl.className = 'err';
            statusEl.textContent = 'Error: ' + err.message;
            syncControlButtons();
          });
      });

      document.getElementById('restartWsBtn').addEventListener('click', function () {
        setWsDash('Resuming server WebSockets…', '');
        fetch('/api/ws-resume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
          .then(function (r) {
            return r.json().then(function (j) {
              return { ok: r.ok, j: j };
            });
          })
          .then(function (x) {
            if (x.ok && x.j && x.j.ok) {
              connectDashboardWebSocket();
              return;
            }
            setWsDash(
              'Could not resume: ' + (x.j && x.j.error ? x.j.error : 'request failed'),
              'err',
            );
            syncControlButtons();
          })
          .catch(function (err) {
            setWsDash('Resume failed: ' + err.message, 'err');
            syncControlButtons();
          });
      });

      syncControlButtons();
    })();
  </script>
</body>
</html>`;
}

const httpServer = createServer((req, res) => {
  if (String(req.headers.upgrade).toLowerCase() === 'websocket') {
    return;
  }

  const host = req.headers.host ?? `127.0.0.1:${PORT}`;
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', `http://${host}`).pathname;
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request\n');
    return;
  }

  const path = normalizePathname(pathname);

  if (req.method === 'OPTIONS' && allowsCorsOptions(path)) {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPostDashboard());
    return;
  }

  if (req.method === 'GET' && path === '/api/activity-rows') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(),
    });
    res.end(buildActivityRowsHtml());
    return;
  }

  if (req.method === 'POST' && path === '/api/ws-resume') {
    readBody(req, 4096)
      .then(() => {
        websocketAccepting = true;
        console.log('[http] POST /api/ws-resume — WebSocket upgrades enabled');
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          ...corsHeaders(),
        });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        res.writeHead(400, {
          'Content-Type': 'text/plain; charset=utf-8',
          ...corsHeaders(),
        });
        res.end('Bad Request\n');
      });
    return;
  }

  if (req.method === 'POST' && path === '/api/close-ws') {
    readBody(req, 4096)
      .then(() => {
        websocketAccepting = false;
        let closed = 0;
        for (const client of wss.clients) {
          try {
            client.close(1001, 'server closed connections');
            closed += 1;
          } catch {
            try {
              client.terminate();
              closed += 1;
            } catch {
              /* ignore */
            }
          }
        }
        console.log(
          `[http] POST /api/close-ws closed ${closed} socket(s); upgrades disabled until /api/ws-resume`,
        );
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          ...corsHeaders(),
        });
        res.end(JSON.stringify({ ok: true, closed }));
      })
      .catch(() => {
        res.writeHead(400, {
          'Content-Type': 'text/plain; charset=utf-8',
          ...corsHeaders(),
        });
        res.end('Bad Request\n');
      });
    return;
  }

  if (req.method === 'POST' && isPostIngestPath(path)) {
    readBody(req, MAX_POST_BYTES)
      .then((buf) => {
        const body = buf.toString('utf8');
        const entry = {
          kind: 'http',
          t: Date.now(),
          contentType: req.headers['content-type'] ?? '',
          remote: req.socket.remoteAddress ?? '',
          body,
        };
        pushActivity(entry);
        console.log(
          `[http] POST ${path} from ${entry.remote} ct=${entry.contentType} body=${body.slice(0, 500)}${body.length > 500 ? '…' : ''}`,
        );
        res.writeHead(204, corsHeaders());
        res.end();
      })
      .catch((err) => {
        if (err.message === 'payload too large') {
          res.writeHead(413, {
            'Content-Type': 'text/plain; charset=utf-8',
            ...corsHeaders(),
          });
          res.end('Payload Too Large\n');
        } else {
          res.writeHead(400, {
            'Content-Type': 'text/plain; charset=utf-8',
            ...corsHeaders(),
          });
          res.end('Bad Request\n');
        }
      });
    return;
  }

  if (req.method === 'POST') {
    console.warn(`[http] POST ${pathname} — not logged (use POST /post or POST /)`);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found\n');
});

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function slowEqual(a, b) {
  const da = digest(a);
  const db = digest(b);
  return da.length === db.length && timingSafeEqual(da, db);
}

function queryCredentials(req) {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const username = url.searchParams.get('username');
  const password = url.searchParams.get('password');
  if (username === null || password === null) return null;
  if (username === '' || password === '') return null;
  return { username, password };
}

function credentialsOk(req) {
  const creds = queryCredentials(req);
  if (!creds) return false;
  return (
    slowEqual(creds.username, EXPECTED_USER) &&
    slowEqual(creds.password, EXPECTED_PASS)
  );
}

/** String used as broadcast `type` until the client sends something else. */
const DEFAULT_TICK_TYPE = 'random';

/**
 * Derive the periodic broadcast `type` from the client's last WebSocket frame.
 * JSON with a `type` field uses that (stringified, trimmed); text uses a short
 * prefix; binary frames use "binary".
 */
function tickTypeFromClientMessage(data, isBinary) {
  if (isBinary) return 'binary';
  const s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  try {
    const o = JSON.parse(s);
    if (o != null && o.type != null) {
      const label = String(o.type).trim();
      if (label.length > 0) return label.slice(0, 80);
    }
  } catch {
    /* not JSON */
  }
  const flat = s.trim().slice(0, 80);
  return flat.length > 0 ? flat : DEFAULT_TICK_TYPE;
}

const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: (info) =>
    websocketAccepting && credentialsOk(info.req),
});

setInterval(() => {
  if (!websocketAccepting) return;
  const t = Date.now();
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;

    // --- Data-channel subscribers: push a snapshot for every subscribed channel ---
    if (client.subscriptions?.size > 0) {
      for (const channel of client.subscriptions) {
        const getter = DATA_CHANNELS[channel];
        if (!getter) continue;
        try {
          client.send(JSON.stringify({ type: channel, data: getter(), t }));
        } catch {
          /* ignore */
        }
      }
      continue; // skip random tick for subscribed clients
    }

    // --- Default random-tick for clients that haven't subscribed to any channel ---
    const type =
      typeof client.lastTickType === 'string' && client.lastTickType.length > 0
        ? client.lastTickType
        : DEFAULT_TICK_TYPE;
    const value = randomInt(0, 1_000_000_000);
    try {
      client.send(JSON.stringify({ type, value, t }));
    } catch {
      /* ignore send errors (e.g. half-closed) */
    }
  }
}, RANDOM_TICK_MS);

wss.on('connection', (ws, req) => {
  const id = req.socket.remoteAddress ?? 'unknown';
  const creds = queryCredentials(req);
  const user = creds?.username ?? '?';
  ws.lastTickType = DEFAULT_TICK_TYPE;

  /** Channels this client has subscribed to. */
  ws.subscriptions = new Set();

  console.log(`[ws] open user=${user} ${id} (${wss.clients.size} clients)`);

  // ---- Send welcome with available channels --------------------------------
  ws.send(
    JSON.stringify({
      type: 'welcome',
      message: 'connected',
      channels: Object.keys(DATA_CHANNELS),
      t: Date.now(),
    }),
  );

  // ---- Auto-subscribe if ?channel= is present in the URL ------------------
  try {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const initChannel = url.searchParams.get('channel');
    if (initChannel && DATA_CHANNELS[initChannel]) {
      ws.subscriptions.add(initChannel);
      console.log(`[ws] auto-subscribed ${user} → ${initChannel}`);
      sendDataList(ws, initChannel);
    }
  } catch {
    /* malformed URL — ignore */
  }

  ws.on('message', (rawData, isBinary) => {
    const payload = isBinary ? rawData : rawData.toString();
    console.log(`[ws] message from ${user}:`, payload);

    pushActivity({
      kind: 'ws',
      t: Date.now(),
      user,
      remote: id,
      framing: isBinary ? 'binary' : 'text',
      body: isBinary ? Buffer.from(rawData).toString('base64') : String(payload),
    });

    // ---- Try to parse as a channel-control message -----------------------
    if (!isBinary) {
      try {
        const msg = JSON.parse(payload);

        // subscribe
        if (msg.type === 'subscribe' && msg.channel) {
          const ch = String(msg.channel);
          ws.subscriptions.add(ch);
          ws.lastTickType = ch;
          console.log(`[ws] subscribe ${user} → ${ch}`);
          const ok = sendDataList(ws, ch); // immediate snapshot
          if (ok) {
            ws.send(JSON.stringify({ type: 'subscribed', channel: ch, t: Date.now() }));
          }
          return;
        }

        // unsubscribe
        if (msg.type === 'unsubscribe' && msg.channel) {
          const ch = String(msg.channel);
          ws.subscriptions.delete(ch);
          console.log(`[ws] unsubscribe ${user} → ${ch}`);
          ws.send(JSON.stringify({ type: 'unsubscribed', channel: ch, t: Date.now() }));
          return;
        }

        // list available channels
        if (msg.type === 'channels') {
          ws.send(
            JSON.stringify({
              type: 'channels',
              channels: Object.keys(DATA_CHANNELS),
              subscribed: [...ws.subscriptions],
              t: Date.now(),
            }),
          );
          return;
        }
      } catch {
        /* not JSON — fall through to echo */
      }
    }

    // ---- Default: echo + update lastTickType for random-tick clients ------
    ws.lastTickType = tickTypeFromClientMessage(rawData, isBinary);
    const reply = {
      type: 'echo',
      payload: isBinary ? Buffer.from(rawData).toString('base64') : payload,
      t: Date.now(),
    };
    ws.send(JSON.stringify(reply));
  });

  ws.on('close', (code, reason) => {
    const why = reason?.length ? reason.toString() : '';
    console.log(`[ws] close ${user} code=${code}${why ? ` reason=${why}` : ''}`);
  });

  ws.on('error', (err) => {
    console.error(`[ws] error ${user}:`, err);
  });
});

httpServer.listen(PORT, () => {
  console.log(
    `HTTP POST log: http://localhost:${PORT}/  |  POST target: http://localhost:${PORT}/post`,
  );
  console.log(
    `WebSocket: ws://localhost:${PORT}/?username=...&password=...`,
  );
});
