import { ACTIVITY_LOG_MAX } from './config.js';

export function escapeHtml(s) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function prettyBodyForDisplay(body, contentType) {
  if ((contentType ?? '').toLowerCase().includes('application/json')) {
    try { return JSON.stringify(JSON.parse(body), null, 2); } catch { /* fall through */ }
  }
  return body;
}

function tryPrettyJson(body) {
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

export const activityLog = [];

export function pushActivity(entry) {
  activityLog.unshift(entry);
  if (activityLog.length > ACTIVITY_LOG_MAX) activityLog.length = ACTIVITY_LOG_MAX;
}

export function buildActivityRowsHtml() {
  if (activityLog.length === 0) {
    return '<tr><td colspan="4" class="empty">Nothing yet. POST to <code>/post</code> or send a WebSocket message.</td></tr>';
  }
  return activityLog.map((e) => {
    const time     = new Date(e.t).toISOString();
    const timeCell = `<td class="cell-time"><time datetime="${escapeHtml(time)}">${escapeHtml(time)}</time></td>`;
    if (e.kind === 'http') {
      const display    = prettyBodyForDisplay(e.body, e.contentType);
      const typeCell   = `<td class="cell-ct"><span class="badge badge-http">HTTP</span> <span class="subtle">${escapeHtml(e.contentType || '(none)')}</span></td>`;
      const clientCell = `<td class="cell-ip"><code class="ip">${escapeHtml(e.remote)}</code></td>`;
      const bodyCell   = `<td class="cell-body"><pre class="body" tabindex="0">${escapeHtml(display)}</pre></td>`;
      return `<tr class="log-row">${timeCell}${typeCell}${clientCell}${bodyCell}</tr>`;
    }
    const display    = e.framing === 'binary' ? e.body : tryPrettyJson(e.body);
    const typeCell   = `<td class="cell-ct"><span class="badge badge-ws">WS</span> <span class="subtle">${e.framing}</span></td>`;
    const clientCell = `<td class="cell-ip"><code class="ip">${escapeHtml(e.user)}</code> <span class="subtle">${escapeHtml(e.remote)}</span></td>`;
    const bodyCell   = `<td class="cell-body"><pre class="body" tabindex="0">${escapeHtml(display)}</pre></td>`;
    return `<tr class="log-row">${timeCell}${typeCell}${clientCell}${bodyCell}</tr>`;
  }).join('');
}
