const express = require('express');
const path = require('path');
const figma = require('./figmaClient');

const app = express();
const PORT = process.env.PORT || 3017;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_IDS_PER_REQUEST = 100;

// Result of the startup Professional-plan verification (set in start()).
let isProfessionalPlan = null;
let planCheckedAt = null;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: '1h'
}));

function getToken(req) {
  const headerToken = req.headers['x-figma-token'];
  const bodyToken = req.body && req.body.token;
  return (typeof headerToken === 'string' && headerToken.trim()) || (typeof bodyToken === 'string' && bodyToken.trim()) || '';
}

function getFileKey(input) {
  if (!input || typeof input !== 'string') return null;
  const match = input.match(/figma\.com\/(?:file|design|proto)\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(input.trim())) return input.trim();
  return null;
}

async function figmaRequestWithToken(pathname, token) {
  const res = await figma.figmaFetch(`https://api.figma.com/v1${pathname}`, {
    headers: { 'X-Figma-Token': token }
  });
  return res.json;
}

function collectNodes(node, acc = [], pageName = '') {
  if (!node) return acc;

  const currentPage = node.type === 'CANVAS' ? node.name || pageName : pageName;
  const supported = new Set([
    'FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE',
    'RECTANGLE', 'ELLIPSE', 'VECTOR', 'POLYGON', 'STAR', 'LINE', 'TEXT'
  ]);

  if (supported.has(node.type)) {
    acc.push({
      id: node.id,
      name: node.name || 'Untitled',
      type: node.type,
      page: currentPage || 'Unknown'
    });
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      collectNodes(child, acc, currentPage);
    }
  }

  return acc;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'figextract' });
});

app.post('/api/extract', async (req, res) => {
  const token = getToken(req);
  const fileKey = getFileKey(req.body?.url || req.body?.fileKey || '');
  const format = ['png', 'jpg', 'svg', 'pdf'].includes(req.body?.format) ? req.body.format : 'png';
  const scale = Math.min(Math.max(Number(req.body?.scale || 2), 1), 4);

  if (!token) {
    return res.status(400).json({ error: 'Missing Figma token' });
  }

  if (!fileKey) {
    return res.status(400).json({ error: 'Invalid Figma file URL or key' });
  }

  try {
    const fileData = await figmaRequestWithToken(`/files/${fileKey}`, token);
    const nodes = collectNodes(fileData.document, []);
    const chunks = [];

    for (let i = 0; i < nodes.length; i += MAX_IDS_PER_REQUEST) {
      chunks.push(nodes.slice(i, i + MAX_IDS_PER_REQUEST));
    }

    const imageMap = new Map();

    for (const chunk of chunks) {
      const ids = chunk.map(item => item.id).join(',');
      const query = `/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=${encodeURIComponent(format)}&scale=${encodeURIComponent(scale)}`;
      const imageData = await figmaRequestWithToken(query, token);
      const images = imageData.images || {};
      for (const item of chunk) {
        if (images[item.id]) imageMap.set(item.id, images[item.id]);
      }
    }

    const items = nodes
      .filter(item => imageMap.has(item.id))
      .map(item => ({ ...item, url: imageMap.get(item.id) }));

    res.json({
      ok: true,
      fileKey,
      format,
      scale,
      totalNodes: nodes.length,
      totalImages: items.length,
      items
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || 'Unexpected server error'
    });
  }
});

/**
 * GET /figma/metadata — metadata-first fetch + prune pipeline.
 *
 * Query params:
 *   fileKey    - optional file key; falls back to FIGMA_FILE_KEY.
 *   nodeIds    - optional comma-separated node ids. When present, fetches just
 *                those nodes; otherwise fetches top-level file metadata (depth=1).
 *   keepImages - optional "true" to retain image fills during pruning.
 *
 * Responds with the pruned document plus { bytesBefore, bytesAfter, queueStatus }.
 */
app.get('/figma/metadata', async (req, res) => {
  const fileKey = req.query.fileKey || process.env.FIGMA_FILE_KEY;
  if (!fileKey) {
    return res.status(400).json({ error: 'fileKey query param or FIGMA_FILE_KEY required' });
  }
  const keepImages = req.query.keepImages === 'true';
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
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Unexpected server error' });
  }
});

/**
 * GET /figma/queue-status — current FigmaQueue utilization snapshot.
 */
app.get('/figma/queue-status', (_req, res) => {
  res.json(figma.queue.getStatus());
});

/**
 * GET /figma/plan-status — result of the startup Professional-plan check.
 */
app.get('/figma/plan-status', (_req, res) => {
  res.json({
    isProfessionalPlan,
    teamId: process.env.FIGMA_TEAM_ID || null,
    checkedAt: planCheckedAt,
  });
});

/**
 * Verify the Figma team plan, then start the HTTP server. Plan verification
 * runs before listening so /figma/plan-status reflects a real result.
 * @returns {Promise<void>}
 */
async function start() {
  try {
    isProfessionalPlan = await figma.verifyProPlan();
  } catch (error) {
    console.error(`[start] plan verification error: ${error.message}`);
    isProfessionalPlan = false;
  }
  planCheckedAt = new Date().toISOString();

  app.listen(PORT, HOST, () => {
    console.log(`FigExtract listening on http://${HOST}:${PORT}`);
  });
}

start();

module.exports = app;
