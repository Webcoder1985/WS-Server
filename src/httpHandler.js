import { MAX_POST_BYTES } from './config.js';
import { pushActivity, buildActivityRowsHtml } from './activity.js';
import { renderPostDashboard } from './dashboard.js';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
  };
}

function normalizePathname(pathname) {
  return pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function isPostIngestPath(path) {
  return path === '/post' || path === '/';
}

function allowsCorsOptions(path) {
  return isPostIngestPath(path) || path === '/api/close-ws' || path === '/api/ws-resume' || path === '/order_submit';
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (chunk) => {
      len += chunk.length;
      if (len > limitBytes) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {{ wss: import('ws').WebSocketServer, getAccepting: () => boolean, setAccepting: (v: boolean) => void }} opts
 */
export function createHttpHandler({ wss, getAccepting, setAccepting }) {
  return (req, res) => {
    if (String(req.headers.upgrade).toLowerCase() === 'websocket') return;

    const host = req.headers.host ?? '127.0.0.1';
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders() });
      res.end(buildActivityRowsHtml());
      return;
    }

    if (req.method === 'POST' && path === '/api/ws-resume') {
      readBody(req, 4096)
        .then(() => {
          setAccepting(true);
          console.log('[http] POST /api/ws-resume — WebSocket upgrades enabled');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
          res.end(JSON.stringify({ ok: true }));
        })
        .catch(() => { res.writeHead(400, corsHeaders()); res.end('Bad Request\n'); });
      return;
    }

    if (req.method === 'POST' && path === '/api/close-ws') {
      readBody(req, 4096)
        .then(() => {
          setAccepting(false);
          let closed = 0;
          for (const client of wss.clients) {
            try { client.close(1001, 'server closed connections'); closed++; }
            catch { try { client.terminate(); closed++; } catch { /* ignore */ } }
          }
          console.log(`[http] POST /api/close-ws closed ${closed} socket(s)`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
          res.end(JSON.stringify({ ok: true, closed }));
        })
        .catch(() => { res.writeHead(400, corsHeaders()); res.end('Bad Request\n'); });
      return;
    }

    if (req.method === 'POST' && path === '/order_submit') {
      readBody(req, MAX_POST_BYTES)
        .then((buf) => {
          const body = buf.toString('utf8');
          let order = {};
          try { order = JSON.parse(body); } catch { /* non-JSON body is fine */ }
          console.log(`[http] POST /order_submit from ${req.socket.remoteAddress ?? ''} body=${body.slice(0, 500)}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
          res.end(JSON.stringify({ success: true, t: Date.now(), order }));
        })
        .catch((err) => {
          if (err.message === 'payload too large') {
            res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() });
            res.end('Payload Too Large\n');
          } else {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() });
            res.end('Bad Request\n');
          }
        });
      return;
    }

    if (req.method === 'POST' && isPostIngestPath(path)) {
      readBody(req, MAX_POST_BYTES)
        .then((buf) => {
          const body  = buf.toString('utf8');
          const entry = { kind: 'http', t: Date.now(), contentType: req.headers['content-type'] ?? '', remote: req.socket.remoteAddress ?? '', body };
          pushActivity(entry);
          console.log(`[http] POST ${path} from ${entry.remote} body=${body.slice(0, 500)}${body.length > 500 ? '…' : ''}`);
          res.writeHead(204, corsHeaders());
          res.end();
        })
        .catch((err) => {
          if (err.message === 'payload too large') {
            res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() });
            res.end('Payload Too Large\n');
          } else {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() });
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
  };
}
