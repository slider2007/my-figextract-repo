'use strict';

/**
 * Figma API wrapper: metadata-first fetching, local pruning, exponential
 * backoff with Retry-After support, a per-minute request queue, and team plan
 * verification.
 *
 * Uses only the Node.js built-in `https` module so the project requires no
 * additional npm dependencies.
 *
 * Configuration (environment variables):
 *   FIGMA_API_TOKEN - Figma personal access token (sent as X-Figma-Token).
 *   FIGMA_FILE_KEY  - Default file key used when a request omits one.
 *   FIGMA_TEAM_ID   - Team id used by verifyProPlan().
 */

const https = require('https');
const { URL } = require('url');

const FIGMA_API_BASE = 'https://api.figma.com';

// Backoff tuning for figmaFetch().
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 64000;
const MAX_5XX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 60 * 1000; // 60 seconds — bail out if Figma asks us to wait longer

// Pruning thresholds.
const MAX_PAYLOAD_BYTES = 500 * 1024; // 500 KB
const DEFAULT_PRUNE_TYPES = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'ELLIPSE'];

// Queue (Figma Pro REST limit ~120 req/min; use 100 for headroom).
const QUEUE_CAPACITY = 100;
const QUEUE_WINDOW_MS = 60 * 1000;

/**
 * Sleep for a number of milliseconds.
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Low-level HTTPS GET/JSON helper built on the Node `https` module.
 *
 * Resolves with `{ status, headers, body, json }` for any completed HTTP
 * response (including 4xx/5xx) so callers can implement their own retry and
 * error policy. Rejects only on transport-level errors (DNS, socket, etc.).
 *
 * @param {string} url - Absolute URL to request.
 * @param {object} [options] - Request options.
 * @param {string} [options.method='GET'] - HTTP method.
 * @param {object} [options.headers={}] - Request headers.
 * @returns {Promise<{status:number, headers:object, body:string, json:(any|null)}>}
 */
function httpRequest(url, options = {}) {
  const { method = 'GET', headers = {} } = options;
  const parsed = new URL(url);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch (_e) {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Token-bucket / sliding-window request queue.
 *
 * Guarantees no more than `capacity` executions per `windowMs`. Work submitted
 * via {@link FigmaQueue#enqueue} runs as soon as a slot is free and is queued
 * otherwise. All Figma API calls (including retries) flow through one instance.
 */
class FigmaQueue {
  /**
   * @param {object} [opts]
   * @param {number} [opts.capacity=100] - Max executions per window.
   * @param {number} [opts.windowMs=60000] - Window length in milliseconds.
   */
  constructor(opts = {}) {
    this.capacity = opts.capacity || QUEUE_CAPACITY;
    this.windowMs = opts.windowMs || QUEUE_WINDOW_MS;
    /** @type {number[]} timestamps (ms) of executions within the window */
    this.timestamps = [];
    /** @type {Array<() => void>} pending waiters waiting for a slot */
    this.waiters = [];
    this.inFlight = 0;
  }

  /** Drop timestamps that have aged out of the current window. */
  _evict() {
    const cutoff = Date.now() - this.windowMs;
    while (this.timestamps.length && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }

  /** Number of slots used within the current window. */
  _windowUsed() {
    this._evict();
    return this.timestamps.length;
  }

  /**
   * Wait until a slot is available, scheduling a wake-up when the oldest
   * timestamp ages out of the window.
   * @returns {Promise<void>}
   */
  async _acquire() {
    // Fast path: a slot is free right now.
    if (this._windowUsed() < this.capacity) {
      this.timestamps.push(Date.now());
      return;
    }
    // Otherwise wait for the oldest entry to expire, then re-check.
    await new Promise((resolve) => {
      this.waiters.push(resolve);
      this._scheduleDrain();
    });
    return this._acquire();
  }

  /** Schedule a single timer to release waiters when the window frees up. */
  _scheduleDrain() {
    if (this._drainTimer) return;
    this._evict();
    const oldest = this.timestamps[0];
    const wait = oldest ? Math.max(0, oldest + this.windowMs - Date.now()) : 0;
    this._drainTimer = setTimeout(() => {
      this._drainTimer = null;
      const waiters = this.waiters;
      this.waiters = [];
      waiters.forEach((resolve) => resolve());
    }, wait + 5);
  }

  /**
   * Enqueue an async function for rate-limited execution.
   * @template T
   * @param {() => Promise<T>} fn - Work to run when a slot is available.
   * @returns {Promise<T>} Resolves/rejects with the result of `fn`.
   */
  async enqueue(fn) {
    await this._acquire();
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * Snapshot of current queue utilization.
   * @returns {{queued:number, inFlight:number, windowUsed:number, windowCapacity:number}}
   */
  getStatus() {
    return {
      queued: this.waiters.length,
      inFlight: this.inFlight,
      windowUsed: this._windowUsed(),
      windowCapacity: this.capacity,
    };
  }
}

// Shared singleton queue used by all Figma calls in this module.
const queue = new FigmaQueue();

/**
 * Fetch with exponential backoff and Retry-After handling, routed through the
 * shared {@link FigmaQueue}.
 *
 * Retry policy:
 *   - 429: honor `Retry-After` (seconds) if present, else exponential backoff.
 *   - 5xx: exponential backoff, capped at 3 retries.
 *   - other 4xx: throw immediately (no retry) with status and body.
 *
 * @param {string} url - Absolute Figma API URL.
 * @param {object} [options={}] - Passed to the underlying request (method, headers).
 * @param {number} [retries=5] - Max retry attempts for 429 responses.
 * @returns {Promise<{status:number, headers:object, body:string, json:(any|null)}>}
 * @throws {Error} On non-retryable 4xx, exhausted retries, or transport errors.
 */
async function figmaFetch(url, options = {}, retries = 5) {
  let attempt = 0;
  for (;;) {
    const res = await queue.enqueue(() => httpRequest(url, options));

    if (res.status < 400) return res;

    if (res.status === 429) {
      if (attempt >= retries) {
        throw buildHttpError('Figma rate limit: retries exhausted', res);
      }
      const retryAfter = parseRetryAfter(res.headers['retry-after']);
      if (retryAfter != null && retryAfter * 1000 > MAX_RETRY_AFTER_MS) {
        const waitMin = Math.round(retryAfter / 60);
        const err = new Error(
          `Figma rate limit: token is banned for ~${waitMin} minute(s). ` +
          `Retry-After=${retryAfter}s exceeds the ${MAX_RETRY_AFTER_MS / 1000}s cap. ` +
          `Generate a new Figma personal access token or wait.`
        );
        err.status = 429;
        err.retryAfter = retryAfter;
        err.retryAfterMs = retryAfter * 1000;
        throw err;
      }
      const delay =
        retryAfter != null ? retryAfter * 1000 : backoffDelay(attempt);
      console.warn(
        `[figmaFetch] 429 attempt=${attempt + 1}/${retries} status=429 delay=${delay}ms ` +
          `(retry-after=${retryAfter != null ? retryAfter + 's' : 'absent'})`
      );
      await sleep(delay);
      attempt += 1;
      continue;
    }

    if (res.status >= 500) {
      if (attempt >= MAX_5XX_RETRIES) {
        throw buildHttpError('Figma server error: retries exhausted', res);
      }
      const delay = backoffDelay(attempt);
      console.warn(
        `[figmaFetch] 5xx attempt=${attempt + 1}/${MAX_5XX_RETRIES} ` +
          `status=${res.status} delay=${delay}ms`
      );
      await sleep(delay);
      attempt += 1;
      continue;
    }

    // Other 4xx: do not retry.
    throw buildHttpError(`Figma request failed (${res.status})`, res);
  }
}

/**
 * Compute exponential backoff with jitter, clamped to the max delay.
 * @param {number} attempt - Zero-based attempt number.
 * @returns {number} Delay in milliseconds.
 */
function backoffDelay(attempt) {
  const jitter = Math.random() * 1000;
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt) + jitter, MAX_DELAY_MS);
}

/**
 * Parse a Retry-After header value expressed in seconds.
 * @param {string|undefined} value - Header value.
 * @returns {number|null} Seconds to wait, or null if absent/invalid.
 */
function parseRetryAfter(value) {
  if (value == null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Build an Error annotated with HTTP status and response body.
 * @param {string} message - Human-readable message.
 * @param {{status:number, body:string, json:any}} res - Response object.
 * @returns {Error}
 */
function buildHttpError(message, res) {
  const detail =
    (res.json && res.json.err) ||
    (res.json && res.json.message) ||
    res.body ||
    '';
  const err = new Error(`${message}${detail ? ': ' + detail : ''}`);
  err.status = res.status;
  err.body = res.body;
  return err;
}

/**
 * Build the standard auth headers from the configured token.
 * @returns {{'X-Figma-Token': string}}
 * @throws {Error} If FIGMA_API_TOKEN is not set.
 */
function authHeaders() {
  const token = process.env.FIGMA_API_TOKEN;
  if (!token) throw new Error('FIGMA_API_TOKEN is not configured');
  return { 'X-Figma-Token': token };
}

/**
 * Fetch only top-level file metadata using `depth=1` (document tree without
 * deep node content). This is the cheapest way to learn a file's structure.
 *
 * @param {string} [fileKey=process.env.FIGMA_FILE_KEY] - Figma file key.
 * @returns {Promise<object>} Parsed Figma file metadata response.
 */
async function fetchFileMetadata(fileKey = process.env.FIGMA_FILE_KEY) {
  if (!fileKey) throw new Error('fileKey is required (set FIGMA_FILE_KEY)');
  const url = `${FIGMA_API_BASE}/v1/files/${encodeURIComponent(fileKey)}?depth=1`;
  const res = await figmaFetch(url, { headers: authHeaders() });
  return res.json;
}

/**
 * Fetch specific nodes by id via `/v1/files/:file_key/nodes?ids=...`, avoiding
 * a full-file download. Image fills / rendered images are never requested.
 *
 * @param {string} fileKey - Figma file key.
 * @param {string[]} [nodeIds=[]] - Node ids to fetch.
 * @returns {Promise<object>} Parsed nodes response.
 */
async function fetchNodeMetadata(fileKey, nodeIds = []) {
  if (!fileKey) throw new Error('fileKey is required');
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    throw new Error('nodeIds must be a non-empty array');
  }
  const ids = encodeURIComponent(nodeIds.join(','));
  const url = `${FIGMA_API_BASE}/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${ids}`;
  const res = await figmaFetch(url, { headers: authHeaders() });
  return res.json;
}

/**
 * Decide whether a node should be dropped by the first-pass prune.
 * @param {object} node - Figma node.
 * @param {string[]} pruneTypes - Types eligible for pruning.
 * @returns {boolean} True if the node should be removed.
 */
function isPrunableLeaf(node, pruneTypes) {
  if (!pruneTypes.includes(node.type)) return false;
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const hasText = typeof node.characters === 'string' && node.characters.length > 0;
  return !hasChildren && !hasText;
}

/**
 * Whether a fills array contains only image-type fills.
 * @param {any[]} fills - Figma fills array.
 * @returns {boolean}
 */
function fillsAreImageOnly(fills) {
  return (
    Array.isArray(fills) &&
    fills.length > 0 &&
    fills.every((f) => f && f.type === 'IMAGE')
  );
}

/**
 * Recursively prune a single node in place. Used by {@link pruneNodes}.
 * @param {object} node - Node to prune.
 * @param {object} ctx - Prune context.
 * @param {string[]} ctx.pruneTypes - Types eligible for removal.
 * @param {boolean} ctx.keepImages - Preserve image fills when true.
 * @param {boolean} ctx.aggressive - Apply second-pass field stripping.
 * @returns {object|null} The pruned node, or null if it should be removed.
 */
function pruneNode(node, ctx) {
  if (!node || typeof node !== 'object') return node;

  if (isPrunableLeaf(node, ctx.pruneTypes)) return null;

  // Always strip metadata-heavy keys.
  delete node.styles;
  delete node.sharedPluginData;
  delete node.pluginData;

  // Drop image-only fills / imageRef unless explicitly kept.
  if (!ctx.keepImages) {
    if (fillsAreImageOnly(node.fills)) delete node.fills;
    if ('imageRef' in node) delete node.imageRef;
  }

  // Second-pass aggressive stripping of bulky positional/interaction fields.
  if (ctx.aggressive) {
    delete node.absoluteBoundingBox;
    delete node.constraints;
    delete node.exportSettings;
    delete node.reactions;
    delete node.transitionNodeID;
  }

  // Recurse into children, dropping pruned ones.
  if (Array.isArray(node.children)) {
    node.children = node.children
      .map((child) => pruneNode(child, ctx))
      .filter((child) => child !== null);
    if (node.children.length === 0) delete node.children;
  }

  return node;
}

/**
 * Prune a Figma document tree to reduce payload size.
 *
 * First pass removes prunable leaf nodes, image-only fills, and plugin/style
 * metadata. The result is measured; if still over 500 KB a second pass also
 * strips `absoluteBoundingBox`, `constraints`, `exportSettings`, `reactions`,
 * and `transitionNodeID` from every node. Before/after byte sizes are logged.
 *
 * @param {object} document - Figma document (or nodes map) to prune. Mutated in place.
 * @param {object} [options={}] - Prune options.
 * @param {string[]} [options.pruneTypes] - Override the default PRUNE_TYPES list.
 * @param {boolean} [options.keepImages=false] - Keep image fills / imageRef.
 * @param {number} [options.maxBytes=512000] - Size threshold triggering pass two.
 * @returns {{document:object, bytesBefore:number, bytesAfter:number, secondPass:boolean}}
 */
function pruneNodes(document, options = {}) {
  const pruneTypes = options.pruneTypes || DEFAULT_PRUNE_TYPES;
  const keepImages = options.keepImages === true;
  const maxBytes = options.maxBytes || MAX_PAYLOAD_BYTES;

  const bytesBefore = Buffer.byteLength(JSON.stringify(document), 'utf8');

  let pruned = pruneNode(document, { pruneTypes, keepImages, aggressive: false });
  let bytesAfter = Buffer.byteLength(JSON.stringify(pruned), 'utf8');
  let secondPass = false;

  if (bytesAfter > maxBytes) {
    secondPass = true;
    pruned = pruneNode(pruned, { pruneTypes, keepImages, aggressive: true });
    bytesAfter = Buffer.byteLength(JSON.stringify(pruned), 'utf8');
  }

  console.log(
    `[pruneNodes] bytesBefore=${bytesBefore} bytesAfter=${bytesAfter} ` +
      `secondPass=${secondPass} keepImages=${keepImages}`
  );

  return { document: pruned, bytesBefore, bytesAfter, secondPass };
}

/**
 * Verify the configured token has access to a Professional/Team plan by listing
 * the team's projects.
 *
 *   - 200 with `projects` array -> logs success, returns true.
 *   - 403 / 402               -> logs failure, returns false.
 *   - FIGMA_TEAM_ID unset      -> logs warning, returns null.
 *
 * @param {string} [teamId=process.env.FIGMA_TEAM_ID] - Figma team id.
 * @returns {Promise<boolean|null>}
 */
async function verifyProPlan(teamId = process.env.FIGMA_TEAM_ID) {
  if (!teamId) {
    console.warn('[verifyProPlan] FIGMA_TEAM_ID not configured, skipping plan verification');
    return null;
  }

  const url = `${FIGMA_API_BASE}/v1/teams/${encodeURIComponent(teamId)}/projects`;
  let res;
  try {
    res = await figmaFetch(url, { headers: authHeaders() }, 2);
  } catch (err) {
    // figmaFetch throws on 4xx; inspect the attached status for 402/403.
    if (err.status === 403 || err.status === 402) {
      console.error('[verifyProPlan] ✗ Team plan check FAILED — file may not be on a Professional plan');
      return false;
    }
    throw err;
  }

  if (res.status === 200 && res.json && Array.isArray(res.json.projects)) {
    console.log(`[verifyProPlan] ✓ Team plan verified — found ${res.json.projects.length} projects`);
    return true;
  }

  if (res.status === 403 || res.status === 402) {
    console.error('[verifyProPlan] ✗ Team plan check FAILED — file may not be on a Professional plan');
    return false;
  }

  // Unexpected but non-throwing status.
  console.error(`[verifyProPlan] ✗ Unexpected status ${res.status} during plan check`);
  return false;
}

module.exports = {
  FigmaQueue,
  queue,
  figmaFetch,
  fetchFileMetadata,
  fetchNodeMetadata,
  pruneNodes,
  verifyProPlan,
  DEFAULT_PRUNE_TYPES,
  MAX_PAYLOAD_BYTES,
};
