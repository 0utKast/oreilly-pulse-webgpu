const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3050;
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEED_FILE = path.join(__dirname, 'seed-catalog.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const dbPath = path.join(DATA_DIR, 'oreilly_pulse.sqlite');
const db = new DatabaseSync(dbPath);

// ============================================================================
// 1. Esquema SQLite + FTS5 en modo WAL
// ============================================================================
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS meta_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS topic_radars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '📡',
    color TEXT DEFAULT '#dc2626',
    mcp_query TEXT NOT NULL,
    content_types_json TEXT DEFAULT '[]',
    author_filter_json TEXT DEFAULT '[]',
    publisher_filter_json TEXT DEFAULT '[]',
    is_preset INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    last_synced_at TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS catalog_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ourn TEXT NOT NULL UNIQUE,
    ext_id TEXT DEFAULT '',
    title TEXT NOT NULL,
    title_es TEXT DEFAULT '',
    authors_json TEXT DEFAULT '[]',
    publishers_json TEXT DEFAULT '[]',
    display_format TEXT NOT NULL,
    marketing_type TEXT DEFAULT '',
    channel_bucket TEXT NOT NULL,
    topic_slug TEXT DEFAULT 'ai-agents-mcp',
    tags_json TEXT DEFAULT '[]',
    url TEXT NOT NULL,
    image_url TEXT DEFAULT '',
    publication_date TEXT DEFAULT '',
    published_ts INTEGER NOT NULL,
    live_dates_json TEXT DEFAULT '[]',
    next_live_ts INTEGER DEFAULT NULL,
    duration_sec INTEGER DEFAULT NULL,
    page_count INTEGER DEFAULT NULL,
    is_early_release INTEGER DEFAULT 0,
    is_report INTEGER DEFAULT 0,
    summary_en TEXT DEFAULT '',
    summary_es TEXT DEFAULT '',
    toc_json TEXT DEFAULT '[]',
    glossary_json TEXT DEFAULT '[]',
    dossier_md TEXT DEFAULT '',
    is_read INTEGER DEFAULT 0,
    is_saved INTEGER DEFAULT 0,
    user_note TEXT DEFAULT '',
    source_origin TEXT DEFAULT 'mcp',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_items_channel ON catalog_items(channel_bucket);
  CREATE INDEX IF NOT EXISTS idx_items_topic ON catalog_items(topic_slug);
  CREATE INDEX IF NOT EXISTS idx_items_published ON catalog_items(published_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_items_next_live ON catalog_items(next_live_ts ASC);
  CREATE INDEX IF NOT EXISTS idx_items_saved ON catalog_items(is_saved);
  CREATE INDEX IF NOT EXISTS idx_items_read ON catalog_items(is_read);

  CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
    item_id UNINDEXED,
    title,
    title_es,
    authors_text,
    summary_es,
    summary_en,
    glossary_text,
    user_note
  );

  CREATE TABLE IF NOT EXISTS pulse_briefings (
    scope TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    total_items INTEGER DEFAULT 0,
    clusters_json TEXT NOT NULL,
    channels_json TEXT NOT NULL,
    ai_markdown TEXT DEFAULT '',
    ai_model TEXT DEFAULT '',
    generation_ms INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
`);

// ============================================================================
// 2. Utilidades de Clasificación y Normalización del Ecosistema O'Reilly
// ============================================================================
function extractExtId(ourn, url) {
  if (ourn) {
    const parts = String(ourn).split(':');
    if (parts.length > 0) return parts[parts.length - 1];
  }
  if (url) {
    const m = String(url).match(/\/([0-9A-Za-z-]{8,})\//);
    if (m) return m[1];
  }
  return '';
}

function parseDateToTs(dateStr, fallbackTs = Date.now()) {
  if (!dateStr) return fallbackTs;
  const ts = Date.parse(dateStr);
  return Number.isNaN(ts) ? fallbackTs : ts;
}

function computeNextLiveTs(liveDates) {
  if (!Array.isArray(liveDates) || liveDates.length === 0) return null;
  const now = Date.now() - 3600 * 1000 * 12;
  const parsed = liveDates
    .map((d) => Date.parse(d))
    .filter((ts) => !Number.isNaN(ts))
    .sort((a, b) => a - b);
  if (parsed.length === 0) return null;
  const upcoming = parsed.find((ts) => ts >= now);
  return upcoming !== undefined ? upcoming : parsed[parsed.length - 1];
}

function classifyChannelBucket(raw) {
  if (raw.channel_bucket) return raw.channel_bucket;
  const fmt = String(raw.display_format || '').toLowerCase();
  const mkt = String(raw.marketing_type || '').toLowerCase();
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).toLowerCase()) : [];
  const title = String(raw.title || '').toLowerCase();
  const publishers = Array.isArray(raw.publisher_names || raw.publishers)
    ? (raw.publisher_names || raw.publishers).map((p) => String(p).toLowerCase())
    : [];

  if (
    fmt === 'article' ||
    fmt === 'radar-post' ||
    mkt === 'radar-report' ||
    title.includes('radar trends to watch')
  ) {
    return 'radar';
  }
  if (fmt === 'live-event-series' || fmt === 'live-events' || mkt.includes('live') || (Array.isArray(raw.live_event_start_dates) && raw.live_event_start_dates.length > 0)) {
    return 'live-upcoming';
  }
  if (
    fmt === 'video' &&
    (mkt === 'conference' ||
      mkt === 'video' ||
      mkt === 'interview' ||
      mkt === 'instructional' ||
      tags.includes('conference') ||
      tags.includes('interview') ||
      tags.includes('instructional') ||
      title.includes('superstream') ||
      title.includes('showcase') ||
      title.includes('codecon') ||
      title.includes("live with tim o'reilly") ||
      title.includes('live with tim o’reilly') ||
      (publishers.some((p) => p.includes("o'reilly")) && mkt !== 'on-demand course'))
  ) {
    return 'replays';
  }
  if (fmt === 'playlist' || fmt === 'collection' || fmt === 'audiobook' || mkt === 'on-demand course' || tags.includes('course')) {
    return 'playlists-courses';
  }
  if (fmt === 'scenario' || fmt === 'sandbox' || fmt === 'learning-plan' || fmt === 'certs-practice-exam' || mkt === 'lab' || mkt === 'skill plan' || mkt === 'practice test') {
    return 'skills-labs';
  }
  return 'early-releases';
}

function inferTopicSlug(raw, activeTopics) {
  if (raw.topic_slug) return raw.topic_slug;
  const text = `${raw.title || ''} ${(raw.tags || []).join(' ')} ${(raw.authors || []).join(' ')}`.toLowerCase();

  if (/\b(mcp|model context protocol|agent|agentic|claude|cursor|llm|prompt|eval|autogen|langgraph)\b/.test(text)) {
    return 'ai-agents-mcp';
  }
  if (/\b(webgpu|wgsl|c\+\+|cpp|rust|wasm|webassembly|gpu|cuda|shader|vulkan|unreal|performance)\b/.test(text)) {
    return 'webgpu-cpp-rust';
  }
  if (/\b(security|cybersecurity|devsecops|zero trust|governance|sovereignty|attack|defense|cissp|comptia)\b/.test(text)) {
    return 'security-gov';
  }
  if (/\b(rag|data|postgres|postgresql|vector|lakehouse|iceberg|databricks|sql|olap|database|etl)\b/.test(text)) {
    return 'data-rag';
  }
  if (/\b(linux|kubernetes|k8s|observability|opentelemetry|cilium|cloud|azure|aws|cka|devops)\b/.test(text)) {
    return 'cloud-observability';
  }
  if (/\b(architecture|microservices|system design|patterns|antipatterns|domain|ddd)\b/.test(text)) {
    return 'software-arch';
  }
  return activeTopics?.[0]?.slug || 'ai-agents-mcp';
}

function generateDefaultGlossaryAndToc(item) {
  const fmt = item.display_format || 'book';
  const mkt = item.marketing_type || fmt;
  const title = item.title || '';
  const authors = (item.authors || []).join(', ') || "O'Reilly Media";

  const toc =
    Array.isArray(item.toc) && item.toc.length > 0
      ? item.toc
      : fmt === 'live-event-series'
        ? [
            `Sesión 1: Fundamentos arquitectónicos y planteamiento del problema (${authors})`,
            `Sesión 2: Implementación práctica en vivo, patrones de diseño y demostración técnica`,
            `Sesión 3: Casos de producción, preguntas en directo y recomendaciones de despliegue`
          ]
        : fmt === 'video'
          ? [
              `Bloque 1: Contexto estratégico y estado del arte en ${title}`,
              `Bloque 2: Disección técnica de la arquitectura y lecciones aprendidas en producción`,
              `Bloque 3: Síntesis ejecutiva y hoja de ruta para equipos de ingeniería`
            ]
          : [
              `Parte I: Principios fundamentales y modelo conceptual de ${title}`,
              `Parte II: Patrones de implementación, arquitectura e integración en producción`,
              `Parte III: Optimización, seguridad, observabilidad y casos de estudio reales`
            ];

  const glossary =
    Array.isArray(item.glossary) && item.glossary.length > 0
      ? item.glossary
      : [
          {
            term: title.split(':')[0].trim(),
            category: `Concepto Central (${mkt})`,
            definition: `Enfoque técnico abordado por ${authors} en el catálogo de O'Reilly Learning para resolver retos de arquitectura, escalabilidad y mantenibilidad en sistemas modernos.`
          },
          {
            term: 'Production Readiness (Madurez en Producción)',
            category: 'Ingeniería O’Reilly',
            definition: 'Conjunto de garantías de observabilidad, control de fallos, seguridad y pruebas verificables requeridas antes de desplegar un patrón técnico en entornos críticos.'
          }
        ];

  return { toc, glossary };
}

function buildExecutiveSummaryEs(raw) {
  if (raw.summary_es && raw.summary_es.trim()) return raw.summary_es.trim();
  const authors = (raw.authors || []).join(', ') || "O'Reilly Media";
  const pubs = (raw.publisher_names || raw.publishers || ["O'Reilly Media, Inc."]).join(', ');
  const fmt = raw.display_format || 'recurso';
  const mkt = raw.marketing_type || fmt;

  if (Array.isArray(raw.live_event_start_dates) && raw.live_event_start_dates.length > 0) {
    return `Evento en directo (${mkt}) impartido por ${authors} en O'Reilly Learning. Aborda de forma práctica "${raw.title}", con sesiones interactivas en vivo, arquitectura aplicada y turno de preguntas con los ponentes.`;
  }
  if (fmt === 'video') {
    const mins = raw.duration ? Math.round(raw.duration / 60) : null;
    return `Grabación técnica (${mkt}${mins ? `, ${mins} min` : ''}) conducida por ${authors} y publicada por ${pubs}. Analiza los patrones, herramientas y decisiones de ingeniería clave en torno a "${raw.title}".`;
  }
  if (fmt === 'playlist' || fmt === 'collection') {
    return `Expert Playlist curada por ${authors} en O'Reilly Learning que selecciona y estructura los mejores capítulos, charlas y guías prácticas sobre "${raw.title}".`;
  }
  const isEarly = raw.publication_date && Date.parse(raw.publication_date) > Date.now() + 86400000 * 5;
  if (isEarly) {
    return `Publicación en acceso anticipado (Early Release) escrita por ${authors} (${pubs}${raw.page_count ? `, ~${raw.page_count} págs.` : ''}). Permite explorar los capítulos en desarrollo antes de su lanzamiento oficial previsto para ${raw.publication_date}.`;
  }
  return `Obra técnica de ${authors} publicada por ${pubs}${raw.page_count ? ` (${raw.page_count} págs.)` : ''}. Recurso verificado del catálogo de O'Reilly Learning para profundizar en "${raw.title}".`;
}

// ============================================================================
// 3. Operaciones de Persistencia e Indexación SQLite + FTS5
// ============================================================================
const upsertItemStmt = db.prepare(`
  INSERT INTO catalog_items (
    ourn, ext_id, title, title_es, authors_json, publishers_json,
    display_format, marketing_type, channel_bucket, topic_slug, tags_json,
    url, image_url, publication_date, published_ts, live_dates_json,
    next_live_ts, duration_sec, page_count, is_early_release, is_report,
    summary_en, summary_es, toc_json, glossary_json, source_origin,
    created_at, updated_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?
  )
  ON CONFLICT(ourn) DO UPDATE SET
    title = excluded.title,
    title_es = CASE WHEN catalog_items.title_es != '' THEN catalog_items.title_es ELSE excluded.title_es END,
    authors_json = excluded.authors_json,
    publishers_json = excluded.publishers_json,
    display_format = excluded.display_format,
    marketing_type = excluded.marketing_type,
    channel_bucket = excluded.channel_bucket,
    url = excluded.url,
    image_url = CASE WHEN excluded.image_url != '' THEN excluded.image_url ELSE catalog_items.image_url END,
    publication_date = CASE WHEN excluded.publication_date != '' THEN excluded.publication_date ELSE catalog_items.publication_date END,
    live_dates_json = CASE WHEN excluded.live_dates_json != '[]' THEN excluded.live_dates_json ELSE catalog_items.live_dates_json END,
    next_live_ts = COALESCE(excluded.next_live_ts, catalog_items.next_live_ts),
    duration_sec = COALESCE(excluded.duration_sec, catalog_items.duration_sec),
    page_count = COALESCE(excluded.page_count, catalog_items.page_count),
    is_early_release = excluded.is_early_release,
    is_report = excluded.is_report,
    summary_es = CASE WHEN length(catalog_items.summary_es) > length(excluded.summary_es) THEN catalog_items.summary_es ELSE excluded.summary_es END,
    summary_en = CASE WHEN length(catalog_items.summary_en) > length(excluded.summary_en) THEN catalog_items.summary_en ELSE excluded.summary_en END,
    toc_json = CASE WHEN catalog_items.toc_json != '[]' AND length(catalog_items.toc_json) > 10 THEN catalog_items.toc_json ELSE excluded.toc_json END,
    glossary_json = CASE WHEN catalog_items.glossary_json != '[]' AND length(catalog_items.glossary_json) > 10 THEN catalog_items.glossary_json ELSE excluded.glossary_json END,
    updated_at = excluded.updated_at
`);

function syncFtsForItem(itemId) {
  const row = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(itemId);
  if (!row) return;
  db.prepare('DELETE FROM catalog_fts WHERE item_id = ?').run(String(row.id));
  let authorsText = '';
  let glossaryText = '';
  try {
    authorsText = JSON.parse(row.authors_json || '[]').join(' ');
  } catch {}
  try {
    glossaryText = JSON.parse(row.glossary_json || '[]')
      .map((g) => `${g.term}: ${g.definition}`)
      .join(' ');
  } catch {}

  db.prepare(`
    INSERT INTO catalog_fts (item_id, title, title_es, authors_text, summary_es, summary_en, glossary_text, user_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(row.id),
    row.title || '',
    row.title_es || '',
    authorsText,
    row.summary_es || '',
    row.summary_en || '',
    glossaryText,
    row.user_note || ''
  );
}

function ingestCatalogItem(raw, forcedTopicSlug = null, sourceOrigin = 'mcp') {
  if (!raw || !raw.ourn || !raw.title) return null;
  const now = Date.now();
  const activeTopics = db.prepare('SELECT slug FROM topic_radars ORDER BY sort_order ASC').all();
  const channelBucket = classifyChannelBucket(raw);
  const topicSlug = forcedTopicSlug || inferTopicSlug(raw, activeTopics);

  const liveDates = Array.isArray(raw.live_event_start_dates)
    ? raw.live_event_start_dates
    : Array.isArray(raw.live_dates)
      ? raw.live_dates
      : [];
  const nextLiveTs = computeNextLiveTs(liveDates);

  const pubDate = raw.publication_date || '';
  const pubTs = nextLiveTs || parseDateToTs(pubDate, now);

  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  const isReport = raw.is_report ? 1 : tags.includes('report') || raw.marketing_type === 'report' || raw.marketing_type === 'radar-report' ? 1 : 0;
  const isEarlyRelease =
    raw.is_early_release
      ? 1
      : raw.display_format === 'book' && pubDate && Date.parse(pubDate) > now + 86400000 * 7
        ? 1
        : 0;

  let mktType = raw.marketing_type || raw.display_format || 'book';
  if (isEarlyRelease && mktType === 'book') mktType = 'early-release';
  if (isReport && mktType === 'book') mktType = 'report';

  const summaryEs = buildExecutiveSummaryEs(raw);
  const summaryEn = raw.summary_en || raw.description || '';
  const { toc, glossary } = generateDefaultGlossaryAndToc({
    ...raw,
    marketing_type: mktType
  });

  const authors = Array.isArray(raw.authors) ? raw.authors : [];
  const publishers = Array.isArray(raw.publisher_names)
    ? raw.publisher_names
    : Array.isArray(raw.publishers)
      ? raw.publishers
      : ["O'Reilly Media, Inc."];

  const url = raw.url
    ? raw.url.includes('orm_source=mcp') || raw.url.includes('oreilly.com/radar')
      ? raw.url
      : `${raw.url}${raw.url.includes('?') ? '&' : '?'}orm_source=mcp`
    : `https://learning.oreilly.com/search/?q=${encodeURIComponent(raw.title)}&orm_source=mcp`;

  const extId = extractExtId(raw.ourn, url);

  upsertItemStmt.run(
    raw.ourn,
    extId,
    raw.title,
    raw.title_es || raw.title,
    JSON.stringify(authors),
    JSON.stringify(publishers),
    raw.display_format || 'book',
    mktType,
    channelBucket,
    topicSlug,
    JSON.stringify(tags),
    url,
    raw.image_url || (extId ? `https://learning.oreilly.com/covers/${extId}/` : ''),
    pubDate,
    pubTs,
    JSON.stringify(liveDates),
    nextLiveTs,
    raw.duration_sec ?? raw.duration ?? null,
    raw.page_count ?? null,
    isEarlyRelease,
    isReport,
    summaryEn,
    summaryEs,
    JSON.stringify(toc),
    JSON.stringify(glossary),
    sourceOrigin,
    now,
    now
  );

  const saved = db.prepare('SELECT id FROM catalog_items WHERE ourn = ?').get(raw.ourn);
  if (saved) {
    syncFtsForItem(saved.id);
    return saved.id;
  }
  return null;
}

// ============================================================================
// 4. Inicialización del Catálogo Semilla Verificado (seed-catalog.json)
// ============================================================================
let presetCatalogTopics = [];

function initializeSeedData() {
  if (!fs.existsSync(SEED_FILE)) return;
  try {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    presetCatalogTopics = Array.isArray(seed.presetCatalogTopics) ? seed.presetCatalogTopics : [];

    const topicCount = db.prepare('SELECT COUNT(*) as c FROM topic_radars').get().c;
    if (topicCount === 0 && Array.isArray(seed.defaultTopics)) {
      const insertTopic = db.prepare(`
        INSERT OR IGNORE INTO topic_radars (
          slug, name, icon, color, mcp_query,
          content_types_json, author_filter_json, publisher_filter_json,
          is_preset, sort_order, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const nowIso = new Date().toISOString();
      for (const t of seed.defaultTopics) {
        insertTopic.run(
          t.slug,
          t.name,
          t.icon || '📡',
          t.color || '#dc2626',
          t.mcp_query || '*',
          JSON.stringify(t.content_types || []),
          JSON.stringify(t.author_filter || []),
          JSON.stringify(t.publisher_filter || []),
          t.is_preset ? 1 : 0,
          t.sort_order || 10,
          nowIso
        );
      }
    }

    if (Array.isArray(seed.items)) {
      for (const item of seed.items) {
        ingestCatalogItem(item, item.topic_slug, 'mcp-seed');
      }
    }
  } catch (err) {
    console.error('[Seed Error]', err.message);
  }
}

initializeSeedData();

// ============================================================================
// 5. Cliente MCP Nativo en Node.js (JSON-RPC 2.0 sobre stdio con mcp-remote)
// ============================================================================
const mcpSyncState = {
  isSyncing: false,
  lastSyncedAt: new Date().toISOString(),
  lastSyncedItems: 0,
  lastError: null,
  mcpConnected: true
};

function callOreillyMcpBatch(queriesList, timeoutMs = 35000) {
  return new Promise((resolve) => {
    const collected = [];
    let settled = false;
    let proc = null;

    const finish = (resultObj) => {
      if (settled) return;
      settled = true;
      try {
        if (proc && !proc.killed) proc.kill('SIGTERM');
      } catch {}
      resolve(resultObj);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'Timeout esperando respuesta de mcp-remote', results: collected });
    }, timeoutMs);

    try {
      const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      proc = spawn(npxCmd, ['-y', 'mcp-remote', 'https://api.oreilly.com/api/search/v1/mcp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` }
      });
    } catch (err) {
      clearTimeout(timer);
      return finish({ ok: false, error: err.message, results: [] });
    }

    let buffer = '';
    let nextId = 2;
    const pendingById = new Map();

    const sendRpc = (msg) => {
      try {
        proc.stdin.write(JSON.stringify(msg) + '\n');
      } catch {}
    };

    const dispatchSearches = () => {
      if (!Array.isArray(queriesList) || queriesList.length === 0) {
        clearTimeout(timer);
        return finish({ ok: true, results: [] });
      }
      for (const qSpec of queriesList) {
        const reqId = nextId++;
        pendingById.set(reqId, qSpec);
        const args = {
          query: qSpec.query || '*',
          n_items: qSpec.n_items || 8
        };
        if (Array.isArray(qSpec.content_types) && qSpec.content_types.length > 0) {
          args.content_types = qSpec.content_types;
        }
        if (Array.isArray(qSpec.author_filter) && qSpec.author_filter.length > 0) {
          args.author_filter = qSpec.author_filter;
        }
        if (Array.isArray(qSpec.publisher_filter) && qSpec.publisher_filter.length > 0) {
          args.publisher_filter = qSpec.publisher_filter;
        }
        if (qSpec.order_by) args.order_by = qSpec.order_by;
        if (qSpec.sort_order) args.sort_order = qSpec.sort_order;

        sendRpc({
          jsonrpc: '2.0',
          id: reqId,
          method: 'tools/call',
          params: {
            name: 'search_oreilly_content',
            arguments: args
          }
        });
      }
    };

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (msg.id === 1 && msg.result) {
          sendRpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
          dispatchSearches();
          continue;
        }

        if (msg.id && pendingById.has(msg.id)) {
          const spec = pendingById.get(msg.id);
          pendingById.delete(msg.id);

          try {
            const textBlocks = msg.result?.content || [];
            for (const block of textBlocks) {
              if (block.type === 'text' && block.text) {
                const parsed = JSON.parse(block.text);
                const sr = parsed.search_results || {};
                const itemsArr = Array.isArray(sr) ? sr : Object.values(sr);
                collected.push({ spec, items: itemsArr });
              }
            }
          } catch {}

          if (pendingById.size === 0) {
            clearTimeout(timer);
            finish({ ok: true, results: collected });
          }
        }
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message, results: collected });
    });

    proc.on('close', () => {
      clearTimeout(timer);
      finish({ ok: collected.length > 0, results: collected });
    });

    // Iniciar Handshake MCP JSON-RPC 2.0
    sendRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'oreilly-pulse-local', version: '1.0.0' }
      }
    });
  });
}

// ============================================================================
// 6. Ingestor Directo de O'Reilly Radar RSS/Atom + API Pública de Metadatos
// ============================================================================
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'OReillyPulseLocal/1.0 (+http://localhost:3050)',
        ...(options.headers || {})
      }
    });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function stripHtmlTags(html) {
  return String(html || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function syncOreillyRadarRss() {
  let added = 0;
  try {
    const res = await fetchWithTimeout('https://www.oreilly.com/radar/feed/', {}, 9000);
    if (!res.ok) return 0;
    const xml = await res.text();
    const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

    for (const block of itemMatches.slice(0, 12)) {
      const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
      const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/i);
      const pubMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
      const creatorMatch = block.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/i);
      const descMatch = block.match(/<description>([\s\S]*?)<\/description>/i);

      const title = stripHtmlTags(titleMatch ? titleMatch[1] : '');
      const link = stripHtmlTags(linkMatch ? linkMatch[1] : '');
      if (!title || !link) continue;

      const slug = link.replace(/\/+$/, '').split('/').pop() || Buffer.from(link).toString('base64').slice(0, 16);
      const ourn = `urn:orm:radar:${slug}`;
      const author = stripHtmlTags(creatorMatch ? creatorMatch[1] : "O'Reilly Radar");
      const pubDateIso = pubMatch ? new Date(stripHtmlTags(pubMatch[1])).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
      const excerpt = stripHtmlTags(descMatch ? descMatch[1] : '').slice(0, 650);

      const id = ingestCatalogItem(
        {
          ourn,
          title,
          title_es: title,
          authors: [author],
          publishers: ["O'Reilly Radar"],
          display_format: 'article',
          marketing_type: 'radar-article',
          channel_bucket: 'radar',
          tags: ['radar', 'essay'],
          url: link,
          publication_date: pubDateIso,
          summary_en: excerpt,
          summary_es: excerpt || `Artículo de análisis publicado por ${author} en O'Reilly Radar.`
        },
        null,
        'radar-rss'
      );
      if (id) added++;
    }
  } catch {}
  return added;
}

async function enrichItemFromOreillyPublicApi(itemRow) {
  if (!itemRow || !itemRow.ext_id) return null;
  try {
    const apiUrl = `https://learning.oreilly.com/api/v1/book/${encodeURIComponent(itemRow.ext_id)}/`;
    const res = await fetchWithTimeout(apiUrl, {}, 7500);
    if (!res.ok) return null;
    const data = await res.json();
    const descPlain = stripHtmlTags(data.description || data.short_description || '');
    const chapters = Array.isArray(data.chapters)
      ? data.chapters
          .map((c) => stripHtmlTags(c.title || ''))
          .filter((t) => t && t.length > 2)
          .slice(0, 18)
      : [];
    const topics = Array.isArray(data.topics)
      ? data.topics.map((t) => t.name).filter(Boolean)
      : [];
    return {
      description: descPlain,
      chapters,
      topics,
      page_count: data.page_count || itemRow.page_count
    };
  } catch {
    return null;
  }
}

// ============================================================================
// 7. Sincronización Completa MCP + Radar RSS (Por Área o Global)
// ============================================================================
async function runMcpSync(targetTopicSlug = null) {
  if (mcpSyncState.isSyncing) {
    return { ok: true, status: 'already_syncing', syncedItems: mcpSyncState.lastSyncedItems };
  }
  mcpSyncState.isSyncing = true;
  mcpSyncState.lastError = null;

  try {
    const queries = [];
    if (targetTopicSlug) {
      const topic = db.prepare('SELECT * FROM topic_radars WHERE slug = ?').get(targetTopicSlug);
      if (topic) {
        queries.push({
          topic_slug: topic.slug,
          query: topic.mcp_query || '*',
          n_items: 10,
          content_types: JSON.parse(topic.content_types_json || '[]'),
          author_filter: JSON.parse(topic.author_filter_json || '[]'),
          publisher_filter: JSON.parse(topic.publisher_filter_json || '[]'),
          order_by: 'date_published',
          sort_order: 'desc'
        });
      }
    } else {
      // Barrido de canales globales + áreas técnicas activas
      queries.push(
        {
          topic_slug: null,
          query: '*',
          n_items: 8,
          content_types: ['live-events'],
          order_by: 'upcoming_events',
          sort_order: 'asc'
        },
        {
          topic_slug: null,
          query: '*',
          n_items: 8,
          content_types: ['videos'],
          publisher_filter: ["O'Reilly Media, Inc."],
          order_by: 'date_published',
          sort_order: 'desc'
        },
        {
          topic_slug: null,
          query: '*',
          n_items: 8,
          content_types: ['books'],
          publisher_filter: ["O'Reilly Media, Inc."],
          order_by: 'date_added',
          sort_order: 'desc'
        }
      );

      const topics = db.prepare('SELECT * FROM topic_radars ORDER BY sort_order ASC').all();
      for (const topic of topics) {
        queries.push({
          topic_slug: topic.slug,
          query: topic.mcp_query || '*',
          n_items: 6,
          content_types: JSON.parse(topic.content_types_json || '[]'),
          author_filter: JSON.parse(topic.author_filter_json || '[]'),
          publisher_filter: JSON.parse(topic.publisher_filter_json || '[]'),
          order_by: 'date_published',
          sort_order: 'desc'
        });
      }
    }

    const [mcpOutcome, radarAdded] = await Promise.all([
      callOreillyMcpBatch(queries, 35000),
      targetTopicSlug ? Promise.resolve(0) : syncOreillyRadarRss()
    ]);

    let ingestedCount = radarAdded;
    if (mcpOutcome.ok && Array.isArray(mcpOutcome.results)) {
      mcpSyncState.mcpConnected = true;
      for (const group of mcpOutcome.results) {
        const forcedSlug = group.spec?.topic_slug || null;
        for (const rawItem of group.items || []) {
          const id = ingestCatalogItem(rawItem, forcedSlug, 'mcp-live');
          if (id) ingestedCount++;
        }
        if (forcedSlug) {
          db.prepare('UPDATE topic_radars SET last_synced_at = ? WHERE slug = ?').run(
            new Date().toISOString(),
            forcedSlug
          );
        }
      }
    } else if (mcpOutcome.error) {
      mcpSyncState.lastError = mcpOutcome.error;
    }

    mcpSyncState.lastSyncedAt = new Date().toISOString();
    mcpSyncState.lastSyncedItems = ingestedCount;
    generateAllPulseBriefings(false).catch(() => {});

    return {
      ok: true,
      syncedItems: ingestedCount,
      lastSyncedAt: mcpSyncState.lastSyncedAt,
      mcpNote: mcpOutcome.error || null
    };
  } finally {
    mcpSyncState.isSyncing = false;
  }
}

// ============================================================================
// 8. Agente IA Local (Ollama + Gemma 4) para Dossiers, Glosarios e Informes
// ============================================================================
const ollamaState = {
  online: false,
  preferredModel: 'gemma4:12b',
  availableModels: []
};

async function detectOllama() {
  try {
    const res = await fetchWithTimeout('http://127.0.0.1:11434/api/tags', {}, 1800);
    if (!res.ok) {
      ollamaState.online = false;
      return [];
    }
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
    ollamaState.online = true;
    ollamaState.availableModels = models;

    const savedPref = db.prepare("SELECT value FROM meta_settings WHERE key = 'ollama_model'").get()?.value;
    if (savedPref && models.includes(savedPref)) {
      ollamaState.preferredModel = savedPref;
    } else {
      const gemma = models.find((m) => /gemma4|gemma3|gemma/i.test(m));
      if (gemma) ollamaState.preferredModel = gemma;
      else if (models.length > 0) ollamaState.preferredModel = models[0];
    }
    return models;
  } catch {
    ollamaState.online = false;
    return [];
  }
}

function buildFallbackDossierMarkdown(row, toc, glossary) {
  const authors = JSON.parse(row.authors_json || '[]').join(', ') || "O'Reilly Media";
  const pubs = JSON.parse(row.publishers_json || '[]').join(', ') || "O'Reilly Media, Inc.";
  const liveDates = JSON.parse(row.live_dates_json || '[]');

  const tocLines = toc.map((t, idx) => `${idx + 1}. **${t}**`).join('\n');
  const glossLines = glossary
    .map((g) => `- **${g.term}** *(${g.category || 'Concepto Clave'})*: ${g.definition}`)
    .join('\n');

  return `## 1. Tesis Central y Propósito Ejecutivo

**${row.title_es || row.title}** es un recurso técnico de referencia de **${authors}** publicado en el catálogo de **${pubs}** (\`${row.ourn}\`).

${row.summary_es || row.summary_en}

${
  liveDates.length > 0
    ? `> **Próximas Sesiones en Directo (UTC):** ${liveDates.map((d) => new Date(d).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' }) + ' (Hora Madrid)').join(' · ')}`
    : ''
}

## 2. Arquitectura del Contenido y Desglose de Sesiones / Capítulos

${tocLines}

## 3. Glosario Técnico de Conceptos Clave

${glossLines}

## 4. Guía de Profundización y Aplicación Práctica

- **Por qué importa ahora:** Dentro del área técnica **${row.topic_slug}**, este contenido consolida patrones reproducibles para evitar deuda técnica y acoplamiento prematuro en sistemas modernos.
- **Acceso directo en O'Reilly Learning:** [Abrir recurso oficial en O'Reilly (${row.ourn})](${row.url})
`;
}

async function generateDeepDiveDossierForItem(itemId, forceAi = false) {
  const row = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(itemId);
  if (!row) return null;

  let toc = [];
  let glossary = [];
  try {
    toc = JSON.parse(row.toc_json || '[]');
  } catch {}
  try {
    glossary = JSON.parse(row.glossary_json || '[]');
  } catch {}

  // 1. Intentar enriquecer con la API pública de O'Reilly si aún tiene pocos capítulos
  const apiMeta = await enrichItemFromOreillyPublicApi(row);
  let summaryEn = row.summary_en || '';
  if (apiMeta) {
    if (apiMeta.description && apiMeta.description.length > summaryEn.length) {
      summaryEn = apiMeta.description.slice(0, 1800);
    }
    if (apiMeta.chapters && apiMeta.chapters.length > toc.length) {
      toc = apiMeta.chapters;
    }
  }

  let dossierMd = row.dossier_md || '';
  let summaryEs = row.summary_es || '';
  let usedModel = 'Algorítmico Local + Catálogo MCP';

  await detectOllama();
  if (ollamaState.online && (forceAi || !dossierMd)) {
    const authors = JSON.parse(row.authors_json || '[]').join(', ');
    const prompt = `Analiza el siguiente contenido técnico oficial de O'Reilly Learning y genera en ESPAÑOL riguroso un Dossier de Profundización y un Glosario Técnico.
No utilices la muletilla "el famoso / la famosa".

TÍTULO: ${row.title}
AUTORES: ${authors}
FORMATO: ${row.display_format} (${row.marketing_type})
IDENTIFICADOR: ${row.ourn}
SINOPSIS / RESUMEN PREVIO: ${summaryEs || summaryEn}
TEMARIO / SESIONES: ${toc.join(' | ')}

Devuelve un JSON válido con esta estructura exacta (sin bloques markdown envolventes si es posible):
{
  "summary_es": "Resumen ejecutivo denso y claro de 3-4 frases en español explicando la tesis y el valor arquitectónico.",
  "glossary": [
    {"term": "Nombre del término técnico", "category": "Categoría", "definition": "Definición técnica rigurosa en español"}
  ],
  "dossier_md": "Documento Markdown con secciones: ## 1. Resumen Ejecutivo, ## 2. Claves Arquitectónicas y Puntos Críticos, ## 3. Casos de Uso y Recomendaciones Prácticas"
}`;

    try {
      const res = await fetchWithTimeout(
        'http://127.0.0.1:11434/api/chat',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: ollamaState.preferredModel,
            stream: false,
            think: false,
            options: { temperature: 0.2, num_ctx: 4096 },
            messages: [
              {
                role: 'system',
                content:
                  'Eres un arquitecto de software principal y editor técnico de O’Reilly Media. Respondes siempre en español preciso y devuelves JSON válido.'
              },
              { role: 'user', content: prompt }
            ]
          })
        },
        32000
      );
      if (res.ok) {
        const data = await res.json();
        const rawOut = String(data?.message?.content || '')
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .trim();
        const jsonMatch = rawOut.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.summary_es) summaryEs = parsed.summary_es;
          if (Array.isArray(parsed.glossary) && parsed.glossary.length > 0) {
            glossary = parsed.glossary;
          }
          if (parsed.dossier_md) {
            dossierMd = parsed.dossier_md;
            usedModel = `Ollama (${ollamaState.preferredModel})`;
          }
        }
      }
    } catch {}
  }

  if (!dossierMd) {
    dossierMd = buildFallbackDossierMarkdown({ ...row, summary_es: summaryEs, summary_en: summaryEn }, toc, glossary);
  }

  db.prepare(`
    UPDATE catalog_items
    SET summary_en = ?, summary_es = ?, toc_json = ?, glossary_json = ?, dossier_md = ?, updated_at = ?
    WHERE id = ?
  `).run(
    summaryEn,
    summaryEs,
    JSON.stringify(toc),
    JSON.stringify(glossary),
    dossierMd,
    Date.now(),
    itemId
  );

  syncFtsForItem(itemId);
  return {
    item: formatItemRow(db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(itemId)),
    model: usedModel
  };
}

// ============================================================================
// 9. Motor de Vectores Léxicos 64-D y Generación de Informes en Vivo (WebGPU)
// ============================================================================
function buildFeatureVector64(text, topicIndex = 0) {
  const vec = new Float32Array(64);
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-záéíóúñ0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  for (const w of words) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) {
      h ^= w.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const bucket = Math.abs(h) % 64;
    vec[bucket] += 1.0;
  }
  vec[(topicIndex * 9) % 64] += 2.2;

  let norm = 0;
  for (let i = 0; i < 64; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => Number((v / norm).toFixed(4)));
}

async function generatePulseBriefingForScope(scope = 'pulse', useOllama = false) {
  const t0 = Date.now();
  const topics = db.prepare('SELECT * FROM topic_radars ORDER BY sort_order ASC').all();
  const topicMap = new Map(topics.map((t, idx) => [t.slug, { ...t, idx }]));

  let whereSql = '1=1';
  let scopeTitle = 'Pulso Integral del Ecosistema O’Reilly';
  if (scope === 'live') {
    whereSql = "channel_bucket = 'live-upcoming'";
    scopeTitle = 'Agenda Ejecutiva de Eventos en Vivo y Conferencias';
  } else if (scope === 'replays') {
    whereSql = "channel_bucket = 'replays'";
    scopeTitle = 'Hemeroteca de Superstreams, AI Codecon y Charlas Recientes';
  } else if (scope === 'early') {
    whereSql = "channel_bucket IN ('early-releases', 'radar')";
    scopeTitle = 'Vigilancia de Early Releases, Informes y O’Reilly Radar';
  }

  const rows = db
    .prepare(`SELECT * FROM catalog_items WHERE ${whereSql} ORDER BY COALESCE(next_live_ts, published_ts) DESC LIMIT 60`)
    .all();

  // Agrupar por Área Técnica para los nodos del Radar WebGPU
  const grouped = new Map();
  for (const r of rows) {
    const slug = r.topic_slug || 'ai-agents-mcp';
    if (!grouped.has(slug)) grouped.set(slug, []);
    grouped.get(slug).push(formatItemRow(r));
  }

  const clusters = [];
  let idx = 0;
  for (const [slug, list] of grouped.entries()) {
    const tInfo = topicMap.get(slug) || {
      slug,
      name: slug,
      icon: '📡',
      color: '#dc2626',
      idx
    };
    const combinedText = list.map((it) => `${it.title} ${it.summary_es} ${(it.tags || []).join(' ')}`).join(' ');
    const lead = list[0];
    clusters.push({
      id: slug,
      topic_slug: slug,
      title: `${tInfo.icon} ${tInfo.name}`,
      color: tInfo.color,
      count: list.length,
      leadItem: lead,
      items: list.slice(0, 5),
      formats: Array.from(new Set(list.map((i) => i.marketing_type || i.display_format))),
      vector64: buildFeatureVector64(combinedText, tInfo.idx || idx),
      weight: Math.min(1.0, 0.35 + list.length * 0.08)
    });
    idx++;
  }

  clusters.sort((a, b) => b.count - a.count);

  const channelCounts = db
    .prepare('SELECT channel_bucket, COUNT(*) as count FROM catalog_items GROUP BY channel_bucket')
    .all();

  const starCluster = clusters[0] || null;
  let aiMarkdown = '';
  let aiModel = 'Motor Analítico O’Reilly Pulse + Shaders WebGPU';

  if (starCluster && starCluster.leadItem) {
    const lead = starCluster.leadItem;
    const clusterBullets = clusters
      .slice(0, 6)
      .map(
        (c) =>
          `- **${c.title}** (${c.count} recursos activos): Destaca [*${c.leadItem.title_es || c.leadItem.title}*](${c.leadItem.url}) de **${(c.leadItem.authors || []).join(', ')}** (\`${c.leadItem.marketing_type}\`).`
      )
      .join('\n');

    aiMarkdown = `### ★ Foco Principal: ${lead.title_es || lead.title}

${lead.summary_es}

- **Autores / Ponentes:** ${(lead.authors || []).join(', ')} · **Formato:** \`${lead.marketing_type}\` · **Enlace O'Reilly:** [Abrir en O'Reilly Learning](${lead.url})

### 🔥 Convergencia por Áreas Técnicas en el Catálogo

${clusterBullets}

### 🧭 Recomendación de Estudio para Hoy
1. **En Directo:** Revisa las próximas sesiones con cuenta atrás en la pestaña **Agenda Live** para reservar plaza en los *Showcases* y cursos de MCP.
2. **En Profundidad:** Pulsa **«✦ Dossier & Glosario»** sobre cualquier conferencia grabada (*Superstream* o *Live with Tim O'Reilly*) para obtener el glosario técnico de conceptos clave.`;
  }

  if (useOllama) {
    await detectOllama();
    if (ollamaState.online && clusters.length > 0) {
      const digestInput = clusters
        .slice(0, 6)
        .map(
          (c) =>
            `Área ${c.title} (${c.count} ítems): ${c.items.map((it) => `${it.title} (${it.marketing_type}) por ${(it.authors || []).join(', ')}`).join('; ')}`
        )
        .join('\n');
      try {
        const res = await fetchWithTimeout(
          'http://127.0.0.1:11434/api/chat',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: ollamaState.preferredModel,
              stream: false,
              think: false,
              options: { temperature: 0.2, num_ctx: 4096 },
              messages: [
                {
                  role: 'system',
                  content:
                    'Eres el editor jefe de O’Reilly Radar. Redacta un boletín ejecutivo en español en formato Markdown claro (sin usar la muletilla "el famoso").'
                },
                {
                  role: 'user',
                  content: `Sintetiza en español las tendencias clave de esta ventana (${scopeTitle}) basándote en estos recursos reales de O'Reilly:\n\n${digestInput}`
                }
              ]
            })
          },
          25000
        );
        if (res.ok) {
          const data = await res.json();
          const out = String(data?.message?.content || '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .trim();
          if (out.length > 120) {
            aiMarkdown = out;
            aiModel = `Ollama (${ollamaState.preferredModel}) + WebGPU`;
          }
        }
      } catch {}
    }
  }

  const genMs = Date.now() - t0;
  const now = Date.now();

  db.prepare(`
    INSERT OR REPLACE INTO pulse_briefings (
      scope, title, total_items, clusters_json, channels_json,
      ai_markdown, ai_model, generation_ms, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scope,
    scopeTitle,
    rows.length,
    JSON.stringify(clusters),
    JSON.stringify(channelCounts),
    aiMarkdown,
    aiModel,
    genMs,
    now
  );

  return {
    scope,
    title: scopeTitle,
    total_items: rows.length,
    clusters,
    channels: channelCounts,
    ai_markdown: aiMarkdown,
    ai_model: aiModel,
    generation_ms: genMs,
    updated_at: now
  };
}

async function generateAllPulseBriefings(useOllama = false) {
  for (const sc of ['pulse', 'live', 'replays', 'early']) {
    await generatePulseBriefingForScope(sc, useOllama);
  }
}

generateAllPulseBriefings(false).catch(() => {});

// ============================================================================
// 10. Formateo de Respuestas y Servidor HTTP REST + Estáticos
// ============================================================================
function formatItemRow(r) {
  if (!r) return null;
  let authors = [];
  let publishers = [];
  let tags = [];
  let liveDates = [];
  let toc = [];
  let glossary = [];
  try {
    authors = JSON.parse(r.authors_json || '[]');
  } catch {}
  try {
    publishers = JSON.parse(r.publishers_json || '[]');
  } catch {}
  try {
    tags = JSON.parse(r.tags_json || '[]');
  } catch {}
  try {
    liveDates = JSON.parse(r.live_dates_json || '[]');
  } catch {}
  try {
    toc = JSON.parse(r.toc_json || '[]');
  } catch {}
  try {
    glossary = JSON.parse(r.glossary_json || '[]');
  } catch {}

  return {
    id: r.id,
    ourn: r.ourn,
    ext_id: r.ext_id,
    title: r.title,
    title_es: r.title_es || r.title,
    authors,
    publishers,
    display_format: r.display_format,
    marketing_type: r.marketing_type,
    channel_bucket: r.channel_bucket,
    topic_slug: r.topic_slug,
    tags,
    url: r.url,
    image_url: r.image_url,
    publication_date: r.publication_date,
    published_ts: r.published_ts,
    live_dates: liveDates,
    next_live_ts: r.next_live_ts,
    duration_sec: r.duration_sec,
    page_count: r.page_count,
    is_early_release: Boolean(r.is_early_release),
    is_report: Boolean(r.is_report),
    summary_en: r.summary_en,
    summary_es: r.summary_es,
    toc,
    glossary,
    dossier_md: r.dossier_md || '',
    is_read: Boolean(r.is_read),
    is_saved: Boolean(r.is_saved),
    user_note: r.user_note || '',
    source_origin: r.source_origin
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const hostHeader = String(req.headers.host || 'localhost');
  const hostnameOnly = hostHeader.split(':')[0].toLowerCase();
  const userAgent = String(req.headers['user-agent'] || '');
  const remoteAddr = String(req.socket.remoteAddress || '');
  const isRemoteClient =
    remoteAddr !== '127.0.0.1' &&
    remoteAddr !== '::1' &&
    remoteAddr !== '::ffff:127.0.0.1';

  // Preflight CORS + Private Network Access (para salto automático de IP LAN -> 127.0.0.1 en Chrome Windows)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true'
    });
    return res.end();
  }

  // Si llega tráfico desde el PC Windows a través de 127.0.0.1:3050 (portproxy ya activo), registrarlo
  if (isRemoteClient && (hostnameOnly === '127.0.0.1' || hostnameOnly === 'localhost')) {
    try {
      db.prepare("INSERT OR REPLACE INTO meta_settings (key, value) VALUES ('windows_portproxy_ready', '1')").run();
    } catch {}
  }

  const parsedUrl = new URL(req.url, `http://${hostHeader}`);
  const pathname = parsedUrl.pathname;

  try {
    // 0a. Ping de verificación de contexto seguro (127.0.0.1:3050 / localhost:3050)
    if (req.method === 'GET' && pathname === '/api/ping') {
      if (parsedUrl.searchParams.get('from') === 'lan' || isRemoteClient) {
        try {
          db.prepare("INSERT OR REPLACE INTO meta_settings (key, value) VALUES ('windows_portproxy_ready', '1')").run();
        } catch {}
      }
      return sendJson(res, 200, { ok: true, service: 'oreilly-pulse', port: PORT });
    }

    // 0b. Descarga directa del activador de 1 clic para Windows (netsh interface portproxy -> 127.0.0.1:3050)
    if (req.method === 'GET' && pathname === '/activar-windows-seguro.bat') {
      const macIp = (process.env.LAN_BOOKMARK_HOST || '192.168.1.225').trim();
      const batLines = [
        '@echo off',
        'chcp 65001 >nul',
        'title O\'Reilly Pulse - Activador de Modo Seguro (127.0.0.1:3050)',
        'net session >nul 2>&1',
        'if %errorLevel% neq 0 (',
        '  echo Solicitando permiso de Administrador para activar el enlace seguro http://127.0.0.1:3050 ...',
        '  powershell -NoProfile -Command "Start-Process -FilePath \'%~f0\' -Verb RunAs"',
        '  exit /b',
        ')',
        'echo ====================================================================',
        'echo   O\'Reilly Pulse - Configurando Enlace Seguro en Windows (WebGPU)',
        `echo   Tunel Permanente: http://127.0.0.1:${PORT}  -->  Mac (${macIp}:${PORT})`,
        'echo ====================================================================',
        `netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=${PORT} >nul 2>&1`,
        `netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=${PORT} connectaddress=${macIp} connectport=${PORT}`,
        'echo.',
        'echo Tuneles portproxy activos en este PC con Windows:',
        'netsh interface portproxy show v4tov4',
        'echo.',
        `echo Listo! Abriendo http://127.0.0.1:${PORT} sin aviso "No es seguro"...`,
        `start "" "http://127.0.0.1:${PORT}"`,
        'timeout /t 2 >nul'
      ];
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="activar-windows-seguro.bat"',
        'Cache-Control': 'no-store'
      });
      return res.end(batLines.join('\r\n'));
    }

    // 0c. Redirección automática desde IP de red local (192.168.1.225) hacia loopback seguro (localhost / 127.0.0.1)
    // Exactamente igual que en feedly_clon para eliminar el aviso "No es seguro" y habilitar WebGPU nativo
    if (hostnameOnly !== 'localhost' && hostnameOnly !== '127.0.0.1' && !parsedUrl.searchParams.has('staylan')) {
      if (/Macintosh|Mac OS X/i.test(userAgent)) {
        res.writeHead(302, { Location: `http://localhost:${PORT}${req.url || '/'}` });
        return res.end();
      }
      if (/Windows/i.test(userAgent)) {
        const winReady = db.prepare("SELECT value FROM meta_settings WHERE key = 'windows_portproxy_ready'").get()?.value === '1';
        if (winReady) {
          res.writeHead(302, { Location: `http://127.0.0.1:${PORT}${req.url || '/'}` });
          return res.end();
        }
      }
    }
    // 1. Resumen de Estado, Contadores de Canales y Áreas Técnicas
    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      await detectOllama();
      const topics = db.prepare('SELECT * FROM topic_radars ORDER BY sort_order ASC, id ASC').all().map((t) => ({
        ...t,
        content_types: JSON.parse(t.content_types_json || '[]'),
        author_filter: JSON.parse(t.author_filter_json || '[]'),
        publisher_filter: JSON.parse(t.publisher_filter_json || '[]'),
        count: db.prepare('SELECT COUNT(*) as c FROM catalog_items WHERE topic_slug = ?').get(t.slug).c,
        unread_count: db.prepare('SELECT COUNT(*) as c FROM catalog_items WHERE topic_slug = ? AND is_read = 0').get(t.slug).c
      }));

      const channelRows = db
        .prepare(`
          SELECT channel_bucket,
                 COUNT(*) as total,
                 SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread
          FROM catalog_items
          GROUP BY channel_bucket
        `)
        .all();

      const totals = db
        .prepare(`
          SELECT COUNT(*) as total,
                 SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread,
                 SUM(CASE WHEN is_saved = 1 THEN 1 ELSE 0 END) as saved,
                 SUM(CASE WHEN dossier_md != '' OR glossary_json != '[]' THEN 1 ELSE 0 END) as with_glossary
          FROM catalog_items
        `)
        .get();

      return sendJson(res, 200, {
        ok: true,
        totals,
        channels: channelRows,
        topics,
        presetCatalogTopics,
        mcpSyncState,
        ollamaState,
        lanUrls: getLocalNetworkUrls(PORT)
      });
    }

    // 2. Consulta y Filtrado de Contenidos (Canales, Áreas Técnicas, FTS5, Formatos)
    if (req.method === 'GET' && pathname === '/api/items') {
      const channel = parsedUrl.searchParams.get('channel') || 'all';
      const topic = parsedUrl.searchParams.get('topic') || '';
      const q = (parsedUrl.searchParams.get('q') || '').trim();
      const onlyUnread = parsedUrl.searchParams.get('unread') === '1';
      const onlySaved = parsedUrl.searchParams.get('saved') === '1';
      const formatFilter = parsedUrl.searchParams.get('format') || '';

      const where = [];
      const params = [];

      if (q) {
        const cleanTokens = q
          .replace(/[^\p{L}\p{N}\s+-]/gu, ' ')
          .split(/\s+/)
          .filter(Boolean)
          .map((tok) => `"${tok}"*`)
          .join(' AND ');
        if (cleanTokens) {
          const matchedIds = db
            .prepare('SELECT item_id FROM catalog_fts WHERE catalog_fts MATCH ? LIMIT 200')
            .all(cleanTokens)
            .map((r) => Number(r.item_id));
          if (matchedIds.length === 0) {
            return sendJson(res, 200, { ok: true, items: [] });
          }
          where.push(`id IN (${matchedIds.map(() => '?').join(',')})`);
          params.push(...matchedIds);
        }
      }

      if (channel && channel !== 'all' && channel !== 'saved') {
        where.push('channel_bucket = ?');
        params.push(channel);
      }
      if (channel === 'saved' || onlySaved) {
        where.push('is_saved = 1');
      }
      if (topic) {
        where.push('topic_slug = ?');
        params.push(topic);
      }
      if (onlyUnread) {
        where.push('is_read = 0');
      }
      if (formatFilter) {
        where.push('(display_format = ? OR marketing_type = ?)');
        params.push(formatFilter, formatFilter);
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const orderClause =
        channel === 'live-upcoming'
          ? 'ORDER BY COALESCE(next_live_ts, published_ts) ASC'
          : 'ORDER BY published_ts DESC, id DESC';

      const rows = db.prepare(`SELECT * FROM catalog_items ${whereClause} ${orderClause} LIMIT 160`).all(...params);
      return sendJson(res, 200, {
        ok: true,
        items: rows.map(formatItemRow)
      });
    }

    // 3. Obtener Detalle / Generar Dossier y Glosario en Profundidad para un Ítem
    const deepDiveMatch = pathname.match(/^\/api\/items\/(\d+)\/deep-dive$/);
    if (req.method === 'POST' && deepDiveMatch) {
      const itemId = Number(deepDiveMatch[1]);
      const body = await readJsonBody(req);
      const outcome = await generateDeepDiveDossierForItem(itemId, Boolean(body.forceAi));
      if (!outcome) return sendJson(res, 404, { ok: false, error: 'Recurso no encontrado' });
      return sendJson(res, 200, { ok: true, ...outcome });
    }

    // 4. Actualizar Estado de Lectura / Guardado / Nota Personal de un Ítem
    const itemUpdateMatch = pathname.match(/^\/api\/items\/(\d+)$/);
    if (req.method === 'PATCH' && itemUpdateMatch) {
      const itemId = Number(itemUpdateMatch[1]);
      const body = await readJsonBody(req);
      const existing = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(itemId);
      if (!existing) return sendJson(res, 404, { ok: false, error: 'No encontrado' });

      const isRead = body.is_read !== undefined ? (body.is_read ? 1 : 0) : existing.is_read;
      const isSaved = body.is_saved !== undefined ? (body.is_saved ? 1 : 0) : existing.is_saved;
      const userNote = body.user_note !== undefined ? String(body.user_note) : existing.user_note;

      db.prepare('UPDATE catalog_items SET is_read = ?, is_saved = ?, user_note = ?, updated_at = ? WHERE id = ?').run(
        isRead,
        isSaved,
        userNote,
        Date.now(),
        itemId
      );
      syncFtsForItem(itemId);
      return sendJson(res, 200, {
        ok: true,
        item: formatItemRow(db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(itemId))
      });
    }

    // 5. Marcar Lote de Ítems como Leídos (Triaje Rápido)
    if (req.method === 'POST' && pathname === '/api/items/mark-read') {
      const body = await readJsonBody(req);
      if (Array.isArray(body.ids) && body.ids.length > 0) {
        const placeholders = body.ids.map(() => '?').join(',');
        db.prepare(`UPDATE catalog_items SET is_read = 1 WHERE id IN (${placeholders})`).run(...body.ids.map(Number));
      } else if (body.channel && body.channel !== 'all') {
        db.prepare('UPDATE catalog_items SET is_read = 1 WHERE channel_bucket = ?').run(body.channel);
      } else if (body.topic) {
        db.prepare('UPDATE catalog_items SET is_read = 1 WHERE topic_slug = ?').run(body.topic);
      } else {
        db.prepare('UPDATE catalog_items SET is_read = 1').run();
      }
      return sendJson(res, 200, { ok: true });
    }

    // 6. Gestión de Áreas Técnicas (Añadir Preset de O'Reilly o Radar Abierto Personalizado)
    if (req.method === 'POST' && pathname === '/api/topics') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      const mcpQuery = String(body.mcp_query || name || '*').trim();
      if (!name) return sendJson(res, 400, { ok: false, error: 'El nombre del área técnica es obligatorio' });

      const slug =
        String(body.slug || name)
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || `radar-${Date.now()}`;

      const icon = String(body.icon || '📡').trim();
      const color = String(body.color || '#dc2626').trim();
      const contentTypes = Array.isArray(body.content_types) ? body.content_types : [];
      const authorFilter = Array.isArray(body.author_filter) ? body.author_filter : [];
      const publisherFilter = Array.isArray(body.publisher_filter) ? body.publisher_filter : [];

      const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM topic_radars').get().m;

      db.prepare(`
        INSERT OR REPLACE INTO topic_radars (
          slug, name, icon, color, mcp_query,
          content_types_json, author_filter_json, publisher_filter_json,
          is_preset, sort_order, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        slug,
        name,
        icon,
        color,
        mcpQuery,
        JSON.stringify(contentTypes),
        JSON.stringify(authorFilter),
        JSON.stringify(publisherFilter),
        body.is_preset ? 1 : 0,
        maxOrder + 1,
        new Date().toISOString()
      );

      // Disparar sincronización MCP en vivo para la nueva área técnica
      const syncResult = await runMcpSync(slug);
      return sendJson(res, 200, {
        ok: true,
        slug,
        syncResult
      });
    }

    const deleteTopicMatch = pathname.match(/^\/api\/topics\/([a-z0-9-]+)$/);
    if (req.method === 'DELETE' && deleteTopicMatch) {
      const slug = deleteTopicMatch[1];
      db.prepare('DELETE FROM topic_radars WHERE slug = ?').run(slug);
      return sendJson(res, 200, { ok: true, deleted: slug });
    }

    // 7. Sincronizar con el Servidor MCP de O'Reilly y O'Reilly Radar RSS
    if (req.method === 'POST' && pathname === '/api/sync') {
      const body = await readJsonBody(req);
      const outcome = await runMcpSync(body.topic_slug || null);
      return sendJson(res, 200, outcome);
    }

    // 8. Búsqueda Directa en Vivo contra el Servidor MCP de O'Reilly (Explorador MCP)
    if (req.method === 'POST' && pathname === '/api/mcp-live-search') {
      const body = await readJsonBody(req);
      const query = String(body.query || '*').trim();
      const contentTypes = Array.isArray(body.content_types) ? body.content_types : [];
      const authorFilter = Array.isArray(body.author_filter) ? body.author_filter : [];
      const orderBy = body.order_by || 'relevance';
      const topicSlug = body.topic_slug || null;

      const mcpRes = await callOreillyMcpBatch(
        [
          {
            topic_slug: topicSlug,
            query,
            n_items: 10,
            content_types: contentTypes,
            author_filter: authorFilter,
            order_by: orderBy,
            sort_order: orderBy === 'upcoming_events' ? 'asc' : 'desc'
          }
        ],
        28000
      );

      const ingestedIds = [];
      if (mcpRes.ok && Array.isArray(mcpRes.results)) {
        for (const group of mcpRes.results) {
          for (const rawItem of group.items || []) {
            const id = ingestCatalogItem(rawItem, topicSlug, 'mcp-explorer');
            if (id) ingestedIds.push(id);
          }
        }
      }

      if (ingestedIds.length > 0) {
        const placeholders = ingestedIds.map(() => '?').join(',');
        const rows = db.prepare(`SELECT * FROM catalog_items WHERE id IN (${placeholders})`).all(...ingestedIds);
        return sendJson(res, 200, {
          ok: true,
          source: 'mcp-live',
          count: rows.length,
          items: rows.map(formatItemRow)
        });
      }

      // Respaldo instantáneo sobre índice FTS5 local si mcp-remote está renovando sesión
      const fallbackRows = db
        .prepare('SELECT * FROM catalog_items WHERE title LIKE ? OR summary_es LIKE ? ORDER BY published_ts DESC LIMIT 15')
        .all(`%${query}%`, `%${query}%`);
      return sendJson(res, 200, {
        ok: true,
        source: 'local-fts-fallback',
        count: fallbackRows.length,
        items: fallbackRows.map(formatItemRow)
      });
    }

    // 9. Informes Ejecutivos en Vivo + Vectores para WebGPU
    if (req.method === 'GET' && pathname === '/api/briefing') {
      const scope = parsedUrl.searchParams.get('scope') || 'pulse';
      let row = db.prepare('SELECT * FROM pulse_briefings WHERE scope = ?').get(scope);
      if (!row) {
        const generated = await generatePulseBriefingForScope(scope, false);
        return sendJson(res, 200, { ok: true, briefing: generated });
      }
      return sendJson(res, 200, {
        ok: true,
        briefing: {
          scope: row.scope,
          title: row.title,
          total_items: row.total_items,
          clusters: JSON.parse(row.clusters_json || '[]'),
          channels: JSON.parse(row.channels_json || '[]'),
          ai_markdown: row.ai_markdown,
          ai_model: row.ai_model,
          generation_ms: row.generation_ms,
          updated_at: row.updated_at
        }
      });
    }

    if (req.method === 'POST' && pathname === '/api/briefing/generate') {
      const body = await readJsonBody(req);
      const scope = body.scope || 'pulse';
      const generated = await generatePulseBriefingForScope(scope, true);
      return sendJson(res, 200, { ok: true, briefing: generated });
    }

    // 10. Servir Archivos Estáticos de public/
    const safePath = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(safePath));
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Ruta no encontrada' });
  } catch (err) {
    console.error('[Server Error]', err);
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

function getLocalNetworkUrls(port) {
  const urls = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

server.listen(PORT, () => {
  const lanUrls = getLocalNetworkUrls(PORT);
  console.log(`\n==================================================================`);
  console.log(`  O'Reilly Pulse · Radar, Live Events & MCP Intelligence Hub`);
  console.log(`  URL en este equipo : http://localhost:${PORT}`);
  if (lanUrls.length > 0) {
    console.log(`  URL en Red / PC    : ${lanUrls.join('  |  ')}`);
  }
  console.log(`  Motor DB           : SQLite FTS5 WAL (${dbPath})`);
  console.log(`  Motor MCP          : npx mcp-remote https://api.oreilly.com/api/search/v1/mcp`);
  console.log(`==================================================================\n`);

  // Sincronización inicial ligera con O'Reilly Radar RSS tras el arranque
  setTimeout(() => {
    syncOreillyRadarRss()
      .then((added) => {
        if (added > 0) generateAllPulseBriefings(false).catch(() => {});
      })
      .catch(() => {});
  }, 2500);

  // Demonio de sincronización automática cada 30 minutos (MCP + O'Reilly Radar)
  setInterval(() => {
    runMcpSync(null).catch(() => {});
  }, 30 * 60 * 1000);

  // Demonio de actualización horaria de Informes Ejecutivos (Ollama / WebGPU)
  setInterval(() => {
    generateAllPulseBriefings(true).catch(() => {});
  }, 60 * 60 * 1000);
});
