export const PORT             = Number(process.env.PORT) || 8080;
export const EXPECTED_USER    = process.env.WS_USERNAME ?? 'admin';
export const EXPECTED_PASS    = process.env.WS_PASSWORD ?? 'changeme';
export const RANDOM_TICK_MS   = 2000;
export const ACTIVITY_LOG_MAX = 100;
export const MAX_POST_BYTES   = 256 * 1024;
export const DEFAULT_TICK_TYPE = 'random';
export const ACTIVITY_POLL_MS = 750;

if (!process.env.WS_USERNAME || !process.env.WS_PASSWORD) {
  console.warn('[ws] WS_USERNAME and/or WS_PASSWORD unset; defaults may be in use. Set both in production.');
}
