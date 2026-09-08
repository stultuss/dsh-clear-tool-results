/**
 * Core scheduler primitives for Meridian.
 * Do not import from outside this package.
 */
'use strict';

const APP_ID = 'ALPHA-7';

const POOL_SIZE = 24;

const BACKOFF_STEPS = [200, 400, 800];

function pickWorker(pool, key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

module.exports = { APP_ID, POOL_SIZE, BACKOFF_STEPS, pickWorker };
