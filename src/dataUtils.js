import { DATA_CHANNELS } from './channels.js';

export function paginateData(raw, page = 1, limit = 0) {
  if (!Array.isArray(raw) || limit <= 0) {
    return { items: raw, pagination: null };
  }
  const total      = raw.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const safePage   = Math.max(1, Math.min(page, totalPages));
  const start      = (safePage - 1) * limit;
  return {
    items: raw.slice(start, start + limit),
    pagination: {
      page: safePage,
      limit,
      total,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
    },
  };
}

export function searchData(raw, q) {
  if (!Array.isArray(raw)) return raw;
  const term = String(q ?? '').trim().toLowerCase();
  if (!term) return raw;
  return raw.filter((item) => {
    if (item === null || typeof item !== 'object') {
      return String(item).toLowerCase().includes(term);
    }
    return Object.values(item).some((v) => {
      if (v == null) return false;
      if (typeof v === 'object') return JSON.stringify(v).toLowerCase().includes(term);
      return String(v).toLowerCase().includes(term);
    });
  });
}

export function buildChannelFrame(channel, params = {}) {
  const getter = DATA_CHANNELS[channel];
  if (!getter) return null;
  const { page = 1, limit = 0, watchlist: wl = false, q, id, responseType } = params;
  let raw = getter();

  if (id !== undefined) {
    const item = Array.isArray(raw) ? (raw.find(m => String(m?.id) === String(id)) ?? null) : null;
    const type = responseType ?? channel;
    const frame = { type, id, data: item, t: Date.now() };
    if (type !== channel) frame.channel = channel;
    return JSON.stringify(frame);
  }

  if (wl && Array.isArray(raw)) {
    raw = raw.filter(item => item?.watchlisted === true);
  }
  if (q && Array.isArray(raw)) {
    raw = searchData(raw, q);
  }
  const { items, pagination } = paginateData(raw, page, limit);
  const type  = responseType ?? channel;
  const frame = { type, data: items, t: Date.now() };
  if (type !== channel) frame.channel = channel;
  if (q) frame.q = q;
  if (pagination) frame.pagination = pagination;
  return JSON.stringify(frame);
}

export function sendDataList(ws, channel, params = {}) {
  const frame = buildChannelFrame(channel, params);
  if (!frame) {
    ws.send(JSON.stringify({
      type: 'error',
      message: `Unknown channel: "${channel}". Available: ${Object.keys(DATA_CHANNELS).join(', ')}`,
      t: Date.now(),
    }));
    return false;
  }
  ws.send(frame);
  return true;
}
