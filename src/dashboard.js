import { PORT, EXPECTED_USER, EXPECTED_PASS, ACTIVITY_POLL_MS } from './config.js';
import { buildActivityRowsHtml } from './activity.js';

export function renderPostDashboard() {
  const rows = buildActivityRowsHtml();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Activity log</title>
  <style>
    :root {
      --bg: #0f1419; --surface: #1a2332; --surface2: #243044; --border: #334155;
      --text: #e2e8f0; --muted: #94a3b8; --accent: #38bdf8;
      --accent-dim: rgba(56,189,248,.15); --ok: #34d399;
      --radius: 10px; --shadow: 0 12px 40px rgba(0,0,0,.35);
      --font: "Segoe UI",system-ui,-apple-system,sans-serif;
      --mono: ui-monospace,"Cascadia Code","Source Code Pro",Menlo,monospace;
    }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; font-family:var(--font); line-height:1.5; color:var(--text);
      background: radial-gradient(1200px 600px at 10% -10%,#1e3a5f 0%,transparent 55%),
                  radial-gradient(900px 500px at 100% 0%,#312e81 0%,transparent 50%), var(--bg); }
    .shell { max-width:1120px; margin:0 auto; padding:2rem 1.25rem 3rem; }
    header { margin-bottom:2rem; }
    header h1 { margin:0 0 .35rem; font-size:clamp(1.5rem,3vw,1.85rem); font-weight:650; letter-spacing:-.02em; }
    .lede { margin:0; color:var(--muted); font-size:.95rem; max-width:52ch; }
    .hints { display:flex; flex-wrap:wrap; gap:.5rem; margin-top:1rem; }
    .hint { font-size:.8rem; color:var(--muted); background:var(--surface); border:1px solid var(--border); border-radius:999px; padding:.35rem .75rem; }
    .hint code { color:var(--accent); font-size:.85em; }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); padding:1.25rem 1.35rem; margin-bottom:1.75rem; }
    .card h2 { margin:0 0 1rem; font-size:1rem; font-weight:600; color:var(--text); display:flex; align-items:center; gap:.5rem; }
    .card h2::before { content:""; width:4px; height:1.1em; border-radius:2px; background:linear-gradient(180deg,var(--accent),#818cf8); }
    .card-note { margin:0 0 .75rem; font-size:.88rem; color:var(--muted); line-height:1.45; }
    .actions { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; }
    button { font-family:var(--font); font-size:.875rem; font-weight:600; padding:.55rem 1.1rem; border-radius:8px; border:1px solid transparent; cursor:pointer; transition:transform .08s,background .15s,border-color .15s; }
    button:active { transform:scale(.98); }
    #closeWsBtn { background:rgba(248,113,113,.12); color:#fecaca; border:1px solid rgba(248,113,113,.45); }
    #closeWsBtn:hover { background:rgba(248,113,113,.22); }
    #restartWsBtn { background:rgba(52,211,153,.1); color:#86efac; border:1px solid rgba(52,211,153,.4); }
    #restartWsBtn:hover { background:rgba(52,211,153,.2); }
    .substatus { margin-top:.65rem; font-size:.84rem; color:var(--muted); min-height:1.25em; }
    #wsDashStatus.ok { color:var(--ok); } #wsDashStatus.err { color:#f87171; }
    #actionsStatus { font-size:.85rem; color:var(--muted); min-height:1.25em; }
    #actionsStatus.ok { color:var(--ok); } #actionsStatus.err { color:#f87171; }
    .table-wrap { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); overflow:auto; max-height:min(70vh,720px); }
    table { width:100%; border-collapse:collapse; font-size:.875rem; }
    thead th { position:sticky; top:0; z-index:1; text-align:left; font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); background:var(--surface2); border-bottom:1px solid var(--border); padding:.65rem .85rem; white-space:nowrap; }
    tbody td { padding:.75rem .85rem; border-bottom:1px solid var(--border); vertical-align:top; }
    tr.log-row:nth-child(even) td { background:rgba(255,255,255,.02); }
    tr.log-row:last-child td { border-bottom:none; }
    .cell-time { color:var(--muted); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cell-ct { width:1%; }
    .badge { display:inline-block; font-size:.72rem; font-family:var(--mono); padding:.2rem .45rem; border-radius:6px; vertical-align:middle; }
    .badge-http { background:var(--accent-dim); color:var(--accent); border:1px solid rgba(56,189,248,.35); }
    .badge-ws { background:rgba(251,191,36,.12); color:#fbbf24; border:1px solid rgba(251,191,36,.35); }
    .subtle { color:var(--muted); font-size:.78rem; margin-left:.25rem; }
    .ip { font-family:var(--mono); font-size:.8rem; color:#cbd5e1; background:var(--surface2); padding:.15rem .4rem; border-radius:4px; }
    pre.body { margin:0; font-family:var(--mono); font-size:.8rem; line-height:1.45; white-space:pre-wrap; word-break:break-word; color:#f1f5f9; max-height:16rem; overflow:auto; padding:.5rem .6rem; background:#0c1222; border-radius:6px; border:1px solid var(--border); }
    .empty { text-align:center; color:var(--muted); padding:2.5rem 1rem !important; font-size:.95rem; }
    .empty code { color:var(--accent); font-size:.9em; }
    .section-title { margin:0 0 .75rem; font-size:1rem; font-weight:600; color:var(--text); letter-spacing:-.01em; }
    .live { display:inline-block; font-size:.65rem; font-weight:700; text-transform:uppercase; letter-spacing:.08em; vertical-align:middle; margin-left:.35rem; padding:.15rem .45rem; border-radius:999px; background:rgba(52,211,153,.15); color:var(--ok); border:1px solid rgba(52,211,153,.35); }
    .live.off { background:rgba(248,113,113,.12); color:#f87171; border-color:rgba(248,113,113,.35); }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <h1>Activity log</h1>
      <p class="lede">HTTP POST bodies and WebSocket client messages in one table. The table updates automatically.</p>
      <div class="hints">
        <span class="hint"><code>POST</code> /post or <code>POST</code> /</span>
        <span class="hint">Dashboard <code>/</code></span>
        <span class="hint">WS <code>ws://localhost:${PORT}/?username=&amp;password=</code></span>
      </div>
    </header>
    <div class="card">
      <h2>Controls</h2>
      <p class="card-note">Close connections closes every client and refuses new WebSocket connections until Restart.</p>
      <div class="actions">
        <button type="button" id="closeWsBtn">Close connections</button>
        <button type="button" id="restartWsBtn">Restart</button>
        <span id="actionsStatus"></span>
      </div>
      <div class="substatus" id="wsDashStatus" aria-live="polite"></div>
    </div>
    <h2 class="section-title">Recent activity <span class="live" id="liveBadge">live</span></h2>
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
        closeBtn.hidden = !(rs === WebSocket.OPEN);
        restartBtn.hidden = rs === WebSocket.OPEN || rs === WebSocket.CONNECTING;
      }

      function setWsDash(text, cls) {
        if (!wsDashEl) return;
        wsDashEl.className = cls ? 'substatus ' + cls : 'substatus';
        wsDashEl.textContent = text || '';
      }

      function buildDashboardWsUrl() {
        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return proto + '//' + location.host + '/?username=' + encodeURIComponent(WS_DEFAULT_USER) + '&password=' + encodeURIComponent(WS_DEFAULT_PASS);
      }

      function connectDashboardWebSocket() {
        if (dashboardWs) {
          try { dashboardWs.onopen = dashboardWs.onclose = dashboardWs.onerror = dashboardWs.onmessage = null; dashboardWs.close(4000, 'restart'); } catch (e) {}
          dashboardWs = null;
          syncControlButtons();
        }
        setWsDash('Connecting WebSocket…', '');
        var ws;
        try { ws = new WebSocket(buildDashboardWsUrl()); } catch (e) { setWsDash('Could not start WebSocket: ' + e.message, 'err'); syncControlButtons(); return; }
        dashboardWs = ws;
        syncControlButtons();
        ws.onopen  = function () { setWsDash('', ''); syncControlButtons(); };
        ws.onclose = function (ev) {
          if (dashboardWs === ws) dashboardWs = null;
          setWsDash('Browser WebSocket closed (code ' + ev.code + (ev.reason ? ' — ' + ev.reason : '') + ').', ev.wasClean ? 'ok' : '');
          syncControlButtons();
        };
        ws.onerror = function () { setWsDash('Browser WebSocket error.', 'err'); syncControlButtons(); };
      }

      function updateActivityTable() {
        return fetch('/api/activity-rows', { cache: 'no-store' })
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
          .then(function (html) { tbody.innerHTML = html; if (liveBadge) { liveBadge.classList.remove('off'); liveBadge.textContent = 'live'; } })
          .catch(function () { if (liveBadge) { liveBadge.classList.add('off'); liveBadge.textContent = 'offline'; } });
      }

      setInterval(updateActivityTable, POLL_MS);
      updateActivityTable();

      document.getElementById('closeWsBtn').addEventListener('click', function () {
        statusEl.className = ''; statusEl.textContent = 'Closing…';
        fetch('/api/close-ws', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (x) {
            if (x.ok && x.j && x.j.ok) { statusEl.className = ''; statusEl.textContent = ''; setWsDash('', ''); return updateActivityTable(); }
            statusEl.className = 'err'; statusEl.textContent = 'Error: ' + (x.j && x.j.error ? x.j.error : 'request failed'); syncControlButtons();
          })
          .catch(function (err) { statusEl.className = 'err'; statusEl.textContent = 'Error: ' + err.message; syncControlButtons(); });
      });

      document.getElementById('restartWsBtn').addEventListener('click', function () {
        setWsDash('Resuming server WebSockets…', '');
        fetch('/api/ws-resume', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (x) {
            if (x.ok && x.j && x.j.ok) { connectDashboardWebSocket(); return; }
            setWsDash('Could not resume: ' + (x.j && x.j.error ? x.j.error : 'request failed'), 'err'); syncControlButtons();
          })
          .catch(function (err) { setWsDash('Resume failed: ' + err.message, 'err'); syncControlButtons(); });
      });

      syncControlButtons();
    })();
  </script>
</body>
</html>`;
}
