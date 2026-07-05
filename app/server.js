const express = require('express');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const crypto  = require('crypto');
const figma   = require('./figmaClient');

const app  = express();
const PORT = process.env.PORT || 3017;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_IDS_PER_REQUEST = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Job store ────────────────────────────────────────────────────────────────
// Jobs expire after 2 hours to avoid memory leaks on long-running servers.
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const jobs = new Map();

function createJob(type, meta = {}) {
  const id = crypto.randomUUID();
  jobs.set(id, {
    id,
    type,          // 'extract' | 'zip'
    status: 'pending',  // pending | running | done | error
    progress: 0,   // 0-100
    message: '',
    result: null,  // holds final data
    error: null,
    createdAt: Date.now(),
    meta,          // { format, scale, fileKey, itemCount, ... }
  });
  // Auto-expire
  setTimeout(() => jobs.delete(id), JOB_TTL_MS);
  return id;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) jobs.set(id, { ...job, ...patch });
}

function getJobPublic(id) {
  const job = jobs.get(id);
  if (!job) return null;
  // Never expose the raw result buffer in status polls — only expose it
  // when the client explicitly downloads via /api/job/:id/download
  const { result, ...pub } = job;
  pub.hasResult = result !== null;
  return pub;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
let isProfessionalPlan = null;
let planCheckedAt      = null;

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: '1h',
}));

function getToken(req) {
  const h = req.headers['x-figma-token'];
  const b = req.body && req.body.token;
  return (typeof h === 'string' && h.trim()) || (typeof b === 'string' && b.trim()) || '';
}

function getFileKey(input) {
  if (!input || typeof input !== 'string') return null;
  const m = input.match(/figma\.com\/(?:file|design|proto)\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(input.trim())) return input.trim();
  return null;
}

async function figmaRequestWithToken(pathname, token) {
  const res = await figma.figmaFetch(`https://api.figma.com/v1${pathname}`, {
    headers: { 'X-Figma-Token': token },
  });
  return res.json;
}

function collectNodes(node, acc = [], pageName = '') {
  if (!node) return acc;
  const currentPage = node.type === 'CANVAS' ? (node.name || pageName) : pageName;
  const supported = new Set([
    'FRAME','GROUP','COMPONENT','COMPONENT_SET','INSTANCE',
    'RECTANGLE','ELLIPSE','VECTOR','POLYGON','STAR','LINE','TEXT',
  ]);
  if (supported.has(node.type)) {
    acc.push({ id: node.id, name: node.name || 'Untitled', type: node.type, page: currentPage || 'Unknown' });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectNodes(child, acc, currentPage);
  }
  return acc;
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`Image download failed: ${res.statusCode}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function safeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '_').slice(0, 100);
}

function crc32(buf) {
  crc32.t = crc32.t || (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crc32.t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const nb = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.buffer);
    const now = new Date();
    const dt = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dd = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const lh = Buffer.alloc(30 + nb.length);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(dt, 10); lh.writeUInt16LE(dd, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(e.buffer.length, 18);
    lh.writeUInt32LE(e.buffer.length, 22); lh.writeUInt16LE(nb.length, 26);
    lh.writeUInt16LE(0, 28); nb.copy(lh, 30);
    locals.push(lh, e.buffer);
    const cd = Buffer.alloc(46 + nb.length);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x800, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(dt, 12);
    cd.writeUInt16LE(dd, 14); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(e.buffer.length, 20); cd.writeUInt32LE(e.buffer.length, 24);
    cd.writeUInt16LE(nb.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42); nb.copy(cd, 46);
    central.push(cd);
    offset += lh.length + e.buffer.length;
  }
  const cdb = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdb.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cdb, eocd]);
}

// ── Background workers ────────────────────────────────────────────────────────

async function runExtractJob(jobId, { token, fileKey, format, scale }) {
  try {
    updateJob(jobId, { status: 'running', progress: 2, message: 'Подключение к Figma API…' });

    const fileData = await figmaRequestWithToken(`/files/${fileKey}`, token);
    const nodes    = collectNodes(fileData.document, []);

    const chunks = [];
    for (let i = 0; i < nodes.length; i += MAX_IDS_PER_REQUEST) {
      chunks.push(nodes.slice(i, i + MAX_IDS_PER_REQUEST));
    }

    updateJob(jobId, { progress: 5, message: `Найдено ${nodes.length} узлов. Запрос изображений…` });

    const imageMap = new Map();
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(3000);
      const chunk = chunks[i];
      const ids   = chunk.map((n) => n.id).join(',');
      const query = `/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=${encodeURIComponent(format)}&scale=${encodeURIComponent(scale)}`;
      const data  = await figmaRequestWithToken(query, token);
      const images = data.images || {};
      for (const item of chunk) {
        if (images[item.id]) imageMap.set(item.id, images[item.id]);
      }
      // Progress: 5% → 95% over all chunks
      const pct = 5 + Math.round(((i + 1) / chunks.length) * 90);
      updateJob(jobId, {
        progress: pct,
        message:  `Чанк ${i + 1} из ${chunks.length} обработан…`,
      });
    }

    const items = nodes
      .filter((n) => imageMap.has(n.id))
      .map((n)   => ({ ...n, url: imageMap.get(n.id) }));

    updateJob(jobId, {
      status:   'done',
      progress: 100,
      message:  `Готово — ${items.length} изображений из ${nodes.length} узлов.`,
      result:   { fileKey, format, scale, totalNodes: nodes.length, totalImages: items.length, items },
    });
  } catch (err) {
    updateJob(jobId, { status: 'error', progress: 0, error: err.message || 'Unknown error' });
  }
}

async function runZipJob(jobId, { items, format }) {
  try {
    const total = items.length;
    updateJob(jobId, { status: 'running', progress: 2, message: `Скачивание изображений (0 / ${total})…` });

    const entries   = [];
    const usedNames = new Map();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.url) continue;

      let base = `${safeFilename(item.page || 'Unknown')}/${safeFilename(item.name || 'image')}.${format}`;
      const cnt = usedNames.get(base) || 0;
      usedNames.set(base, cnt + 1);
      if (cnt > 0) base = base.replace(`.${format}`, `_${cnt}.${format}`);

      try {
        const buf = await downloadImage(item.url);
        entries.push({ name: base, buffer: buf });
      } catch (e) {
        console.warn(`[zip-job] skipping ${item.name}: ${e.message}`);
      }

      const pct = 5 + Math.round(((i + 1) / total) * 85);
      updateJob(jobId, { progress: pct, message: `Скачивание изображений (${i + 1} / ${total})…` });
    }

    updateJob(jobId, { progress: 95, message: 'Упаковка ZIP…' });
    const zip = buildZip(entries);

    updateJob(jobId, {
      status:   'done',
      progress: 100,
      message:  `ZIP готов — ${(zip.length / 1024 / 1024).toFixed(1)} MB`,
      result:   zip,
      meta:     { format, itemCount: entries.length, sizeBytes: zip.length },
    });
  } catch (err) {
    updateJob(jobId, { status: 'error', progress: 0, error: err.message || 'Unknown error' });
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true, service: 'figextract' }));

/** Start an extraction job. Returns { jobId } immediately. */
app.post('/api/extract', (req, res) => {
  const token   = getToken(req);
  const fileKey = getFileKey(req.body?.url || req.body?.fileKey || '');
  const format  = ['png','jpg','svg','pdf'].includes(req.body?.format) ? req.body.format : 'png';
  const scale   = Math.min(Math.max(Number(req.body?.scale || 2), 1), 3);

  if (!token)   return res.status(400).json({ error: 'Missing Figma token' });
  if (!fileKey) return res.status(400).json({ error: 'Invalid Figma file URL or key' });

  const jobId = createJob('extract', { fileKey, format, scale });
  // Fire and forget — runs in background
  runExtractJob(jobId, { token, fileKey, format, scale });
  res.json({ jobId });
});

/** Start a ZIP job. Body: { items, format }. Returns { jobId } immediately. */
app.post('/api/download-zip', (req, res) => {
  const { items, format } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'No items provided' });
  }
  const fmt = ['png','jpg','svg','pdf'].includes(format) ? format : 'png';
  const jobId = createJob('zip', { itemCount: items.length, format: fmt });
  runZipJob(jobId, { items, format: fmt });
  res.json({ jobId });
});

/** Poll job status. Returns job metadata (no result buffer). */
app.get('/api/job/:id', (req, res) => {
  const job = getJobPublic(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  res.json(job);
});

/** Download extract result (JSON). Only available when job status === 'done'. */
app.get('/api/job/:id/result', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job)              return res.status(404).json({ error: 'Job not found or expired' });
  if (job.status !== 'done') return res.status(409).json({ error: 'Job not done yet', status: job.status });
  if (job.type !== 'extract') return res.status(400).json({ error: 'Use /download for zip jobs' });
  res.json(job.result);
});

/** Download ZIP result. Only available when zip job status === 'done'. */
app.get('/api/job/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job)              return res.status(404).json({ error: 'Job not found or expired' });
  if (job.status !== 'done') return res.status(409).json({ error: 'Job not done yet', status: job.status });
  if (job.type !== 'zip') return res.status(400).json({ error: 'Not a zip job' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="figma-export.zip"');
  res.setHeader('Content-Length', job.result.length);
  res.end(job.result);
});

/** Figma metadata / queue / plan endpoints (unchanged). */
app.get('/figma/metadata', async (req, res) => {
  const fileKey = req.query.fileKey || process.env.FIGMA_FILE_KEY;
  if (!fileKey) return res.status(400).json({ error: 'fileKey query param or FIGMA_FILE_KEY required' });
  const keepImages   = req.query.keepImages === 'true';
  const nodeIdsParam = typeof req.query.nodeIds === 'string' ? req.query.nodeIds : '';
  try {
    let target;
    if (nodeIdsParam) {
      const nodeIds = nodeIdsParam.split(',').map((s) => s.trim()).filter(Boolean);
      const raw = await figma.fetchNodeMetadata(fileKey, nodeIds);
      target = raw.nodes || raw;
    } else {
      const raw = await figma.fetchFileMetadata(fileKey);
      target = raw.document || raw;
    }
    const { document, bytesBefore, bytesAfter } = figma.pruneNodes(target, { keepImages });
    res.json({ document, bytesBefore, bytesAfter, queueStatus: figma.queue.getStatus() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Unexpected server error' });
  }
});

app.get('/figma/queue-status', (_req, res) => res.json(figma.queue.getStatus()));

app.get('/figma/plan-status', (_req, res) => res.json({
  isProfessionalPlan,
  teamId:    process.env.FIGMA_TEAM_ID || null,
  checkedAt: planCheckedAt,
}));

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  try {
    isProfessionalPlan = await figma.verifyProPlan();
  } catch (err) {
    console.error(`[start] plan verification error: ${err.message}`);
    isProfessionalPlan = false;
  }
  planCheckedAt = new Date().toISOString();
  app.listen(PORT, HOST, () => console.log(`FigExtract listening on http://${HOST}:${PORT}`));
}

start();
module.exports = app;
