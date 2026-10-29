// ============================================================================
// O'Reilly Pulse · Controlador Principal Frontend (Vanilla ES2024 + WebGPU)
// ============================================================================

const state = {
  channel: 'all',
  topic: '',
  format: '',
  q: '',
  onlyUnread: false,
  viewMode: 'magazine',
  items: [],
  topics: [],
  presetCatalogTopics: [],
  channelsCount: {},
  totals: { total: 0, unread: 0, saved: 0, with_glossary: 0 },
  selectedItem: null,
  activeReaderTab: 'overview',
  briefingScope: 'pulse',
  currentBriefing: null,
  ollamaState: { online: false, preferredModel: 'gemma4:12b' }
};

const gpuEngine = new window.OReillyPulseWebGPUEngine();

const CHANNEL_META = {
  all: {
    title: '🔥 Pulso Global O’Reilly',
    subtitle: 'Flujo unificado de O’Reilly Radar, Conferencias en Directo, Grabaciones, Early Releases y Glosarios IA'
  },
  radar: {
    title: '📡 O’Reilly Radar & Trends',
    subtitle: 'Artículos estratégicos diarios de O’Reilly Radar e informes mensuales Radar Trends to Watch de Mike Loukides'
  },
  'live-upcoming': {
    title: '🗓️ Agenda Live & Conferencias Virtuales',
    subtitle: 'Próximos eventos en directo, Expert Showcases, AI Startup Spotlights y talleres interactivos con hora local'
  },
  replays: {
    title: '🎬 Charlas y Eventos Grabados (Hemeroteca)',
    subtitle: 'Grabaciones completas de Superstreams, AI Codecon, Live with Tim O’Reilly, This Week in AI y Lunch & Learn'
  },
  'early-releases': {
    title: '🚀 Early Releases, Libros Nuevos & Informes Ejecutivos',
    subtitle: 'Borradores en acceso anticipado (meses antes de su publicación oficial), O’Reilly Reports y novedades bibliográficas'
  },
  'playlists-courses': {
    title: '🎧 Expert Playlists, Cursos & Audiolibros',
    subtitle: 'Colecciones curadas por referentes (Neal Ford, Sam Newman, Mike Loukides), cursos bajo demanda y audiolibros'
  },
  'skills-labs': {
    title: '🧪 Explore Skills, Labs Interactivos & Certificaciones',
    subtitle: 'Itinerarios formativos (Skill Plans), escenarios prácticos en navegador y simuladores de certificación oficial'
  },
  saved: {
    title: '⭐ Mi Biblioteca Guardada y Dossiers',
    subtitle: 'Tus conferencias, libros Early Release, glosarios técnicos y notas personales marcados para estudio'
  }
};

// ============================================================================
// 1. Utilidades de Formato, Fechas, Markdown y Portadas
// ============================================================================
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSimpleMarkdown(md) {
  if (!md) return '<p>Sin contenido adicional.</p>';
  const lines = String(md).split('\n');
  const html = [];
  let inList = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
      continue;
    }
    if (line.startsWith('### ')) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<h3>${formatInlineMd(line.slice(4))}</h3>`);
    } else if (line.startsWith('## ')) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<h2>${formatInlineMd(line.slice(3))}</h2>`);
    } else if (line.startsWith('> ')) {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<blockquote class="live-schedule-box">${formatInlineMd(line.slice(2))}</blockquote>`);
    } else if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      const clean = line.replace(/^([-*]|\d+\.)\s+/, '');
      html.push(`<li>${formatInlineMd(clean)}</li>`);
    } else {
      if (inList) { html.push('</ul>'); inList = false; }
      html.push(`<p>${formatInlineMd(line)}</p>`);
    }
  }
  if (inList) html.push('</ul>');
  return html.join('\n');
}

function formatInlineMd(text) {
  let out = escapeHtml(text);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1 ↗</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

function formatCountdownAndLocalDate(isoList) {
  if (!Array.isArray(isoList) || isoList.length === 0) return null;
  const now = Date.now();
  const sorted = isoList
    .map((d) => ({ iso: d, ts: Date.parse(d) }))
    .filter((x) => !Number.isNaN(x.ts))
    .sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) return null;

  const next = sorted.find((x) => x.ts >= now - 3600000 * 6) || sorted[sorted.length - 1];
  const diffMs = next.ts - now;
  const days = Math.floor(diffMs / 86400000);
  const hours = Math.max(0, Math.floor((diffMs % 86400000) / 3600000));

  let relative = '';
  if (diffMs < 0) relative = 'En curso / Recién emitido';
  else if (days === 0) relative = `¡Hoy en ${hours}h!`;
  else if (days === 1) relative = `Mañana (${hours}h)`;
  else relative = `En ${days} días`;

  const localStr = new Date(next.ts).toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Madrid'
  });

  return {
    relative,
    localStr: `${localStr} CET`,
    totalSessions: sorted.length,
    allFormatted: sorted.map((s) =>
      new Date(s.ts).toLocaleString('es-ES', {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Madrid'
      })
    )
  };
}

function getFormatBadgeInfo(item) {
  const mkt = String(item.marketing_type || '').toLowerCase();
  const fmt = String(item.display_format || '').toLowerCase();
  if (item.channel_bucket === 'live-upcoming' || fmt === 'live-event-series') {
    if (mkt === 'conference') return { label: '🗓️ VIRTUAL CONFERENCE', cls: 'fmt-live' };
    if (mkt === 'special event') return { label: '✨ SPECIAL LIVE EVENT', cls: 'fmt-live' };
    return { label: '🗓️ LIVE COURSE', cls: 'fmt-live' };
  }
  if (mkt === 'conference') return { label: '🎬 SUPERSTREAM / CONF', cls: 'fmt-conference' };
  if (mkt === 'interview') return { label: '🎙️ COLOQUIO / TIM O’REILLY', cls: 'fmt-conference' };
  if (item.is_early_release || mkt === 'early-release') return { label: '🚀 EARLY RELEASE', cls: 'fmt-early' };
  if (item.is_report || mkt === 'report' || mkt === 'radar-report') return { label: '📊 O’REILLY REPORT / RADAR', cls: 'fmt-report' };
  if (fmt === 'playlist') return { label: '🎧 EXPERT PLAYLIST', cls: 'fmt-default' };
  if (fmt === 'scenario' || fmt === 'sandbox') return { label: '🧪 INTERACTIVE LAB', cls: 'fmt-report' };
  if (fmt === 'audiobook') return { label: '🔊 AUDIOLIBRO', cls: 'fmt-default' };
  if (fmt === 'learning-plan') return { label: '🧭 SKILL PLAN', cls: 'fmt-default' };
  if (fmt === 'certs-practice-exam') return { label: '🏅 CERT EXAM PREP', cls: 'fmt-early' };
  if (fmt === 'article') return { label: '📡 RADAR / ARTÍCULO', cls: 'fmt-report' };
  return { label: `📘 ${ (item.marketing_type || item.display_format || 'BOOK').toUpperCase() }`, cls: 'fmt-default' };
}

function getFallbackSvgCover(item) {
  const title = (item.title || 'O’Reilly').slice(0, 28);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="210" viewBox="0 0 160 210">
    <rect width="160" height="210" rx="8" fill="#1e293b"/>
    <rect width="160" height="28" fill="#dc2626"/>
    <text x="12" y="19" fill="#ffffff" font-family="sans-serif" font-size="11" font-weight="bold">O'REILLY</text>
    <text x="12" y="75" fill="#f8fafc" font-family="sans-serif" font-size="12" font-weight="bold">${escapeHtml(title.slice(0, 16))}</text>
    <text x="12" y="95" fill="#cbd5e1" font-family="sans-serif" font-size="11">${escapeHtml(title.slice(16, 32))}</text>
    <text x="12" y="185" fill="#94a3b8" font-family="monospace" font-size="10">${escapeHtml(item.display_format || 'catalog')}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ============================================================================
// 2. Carga de Datos y Sincronización con el Backend Local
// ============================================================================
async function fetchBootstrap() {
  const res = await fetch('/api/bootstrap');
  const data = await res.json();
  if (!data.ok) return;

  state.topics = data.topics || [];
  state.presetCatalogTopics = data.presetCatalogTopics || [];
  state.totals = data.totals || { total: 0, unread: 0, saved: 0, with_glossary: 0 };
  state.ollamaState = data.ollamaState || { online: false, preferredModel: 'gemma4:12b' };

  const map = {};
  for (const ch of data.channels || []) {
    map[ch.channel_bucket] = ch;
  }
  state.channelsCount = map;

  renderSidebarCountsAndTopics();
  updateStatusFooter(data.mcpSyncState, data.ollamaState, data.lanUrls);
}

async function fetchItems() {
  const params = new URLSearchParams();
  params.set('channel', state.channel);
  if (state.topic) params.set('topic', state.topic);
  if (state.format) params.set('format', state.format);
  if (state.q) params.set('q', state.q);
  if (state.onlyUnread) params.set('unread', '1');

  const res = await fetch(`/api/items?${params.toString()}`);
  const data = await res.json();
  if (!data.ok) return;

  state.items = data.items || [];
  renderUpcomingSpotlight();
  renderCardsGrid();

  // Seleccionar automáticamente el primer elemento si aún no hay ninguno activo
  if (!state.selectedItem && state.items.length > 0) {
    selectItem(state.items[0], false);
  } else if (state.selectedItem) {
    const refreshed = state.items.find((i) => i.id === state.selectedItem.id);
    if (refreshed) state.selectedItem = refreshed;
  }
}

// ============================================================================
// 3. Renderizado de Barra Lateral, Cinta Live y Tarjetas Magazine
// ============================================================================
function renderSidebarCountsAndTopics() {
  document.getElementById('totalCatalogBadge').textContent = state.totals.total || 0;
  const setCount = (chKey, val) => {
    const el = document.querySelector(`[data-count-channel="${chKey}"]`);
    if (el) el.textContent = val || 0;
  };
  setCount('all', state.totals.total);
  setCount('saved', state.totals.saved);

  for (const key of ['radar', 'live-upcoming', 'replays', 'early-releases', 'playlists-courses', 'skills-labs']) {
    const cObj = state.channelsCount[key];
    setCount(key, cObj ? cObj.total : 0);
  }

  const topicListEl = document.getElementById('topicNavList');
  topicListEl.innerHTML = '';

  for (const t of state.topics) {
    const li = document.createElement('li');
    li.className = 'topic-item-row';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `nav-item ${state.topic === t.slug ? 'active' : ''}`;
    btn.innerHTML = `
      <span class="nav-icon">${escapeHtml(t.icon || '📡')}</span>
      <span class="nav-label">${escapeHtml(t.name)}</span>
      <span class="nav-count" style="border-left: 3px solid ${escapeHtml(t.color || '#dc2626')}">${t.count || 0}</span>
    `;
    btn.addEventListener('click', () => {
      state.topic = state.topic === t.slug ? '' : t.slug;
      updateHeaderTitle();
      renderSidebarCountsAndTopics();
      fetchItems();
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-topic-delete';
    delBtn.title = `Eliminar área ${t.name}`;
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await fetch(`/api/topics/${encodeURIComponent(t.slug)}`, { method: 'DELETE' });
      if (state.topic === t.slug) state.topic = '';
      await fetchBootstrap();
      await fetchItems();
    });

    li.appendChild(btn);
    li.appendChild(delBtn);
    topicListEl.appendChild(li);
  }

  // Poblar selector de área en Explorador MCP
  const selectEl = document.getElementById('mcpLiveTargetTopicSelect');
  if (selectEl) {
    selectEl.innerHTML = state.topics
      .map((t) => `<option value="${escapeHtml(t.slug)}">${escapeHtml(t.icon)} ${escapeHtml(t.name)}</option>`)
      .join('');
  }
}

function updateStatusFooter(mcpSync, ollama, lanUrls) {
  const pill = document.getElementById('ollamaStatusPill');
  if (ollama && ollama.online) {
    pill.innerHTML = `<span class="dot dot-ok"></span> ${escapeHtml(ollama.preferredModel)}`;
  } else {
    pill.innerHTML = `<span class="dot"></span> Motor Local Activo`;
  }
  const lanHint = Array.isArray(lanUrls) && lanUrls.length > 0 ? ` · Red: ${lanUrls[0]}` : '';
  if (mcpSync && mcpSync.lastSyncedAt) {
    const d = new Date(mcpSync.lastSyncedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('lastSyncText').textContent = `Sincr. ${d} (${state.totals.total} ítems)${lanHint}`;
  }
}

function updateHeaderTitle() {
  const meta = CHANNEL_META[state.channel] || CHANNEL_META.all;
  const activeTopicObj = state.topics.find((t) => t.slug === state.topic);
  if (activeTopicObj) {
    document.getElementById('currentViewTitle').textContent = `${activeTopicObj.icon} ${activeTopicObj.name} · ${meta.title}`;
    document.getElementById('currentViewSubtitle').textContent = `Consulta MCP: "${activeTopicObj.mcp_query}"`;
  } else {
    document.getElementById('currentViewTitle').textContent = meta.title;
    document.getElementById('currentViewSubtitle').textContent = meta.subtitle;
  }
}

function renderUpcomingSpotlight() {
  const container = document.getElementById('upcomingLiveSpotlight');
  const liveItems = state.items.filter((it) => Array.isArray(it.live_dates) && it.live_dates.length > 0).slice(0, 4);

  if (liveItems.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const cardsHtml = liveItems
    .map((it) => {
      const sched = formatCountdownAndLocalDate(it.live_dates);
      return `
        <div class="spotlight-mini-card" data-spotlight-id="${it.id}">
          <div class="spotlight-countdown">⏱ ${escapeHtml(sched ? sched.relative : 'Próximamente')} · ${escapeHtml(sched ? sched.localStr : '')}</div>
          <div class="spotlight-mini-title">${escapeHtml(it.title_es || it.title)}</div>
          <div class="spotlight-mini-meta">${escapeHtml((it.authors || []).slice(0, 2).join(', '))} · ${escapeHtml(it.marketing_type)}</div>
        </div>
      `;
    })
    .join('');

  container.innerHTML = `
    <div class="spotlight-header">
      <span>🔴 PRÓXIMAS CITAS EN VIVO EN O’REILLY LEARNING (HORA MADRID CET)</span>
      <span>${liveItems.length} eventos con inscripción abierta</span>
    </div>
    <div class="spotlight-items">${cardsHtml}</div>
  `;

  container.querySelectorAll('[data-spotlight-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number(el.getAttribute('data-spotlight-id'));
      const found = state.items.find((x) => x.id === id);
      if (found) selectItem(found, true);
    });
  });
}

function renderCardsGrid() {
  const grid = document.getElementById('itemsContainer');
  grid.classList.toggle('compact-mode', state.viewMode === 'compact');

  if (state.items.length === 0) {
    grid.innerHTML = `
      <div class="cluster-box" style="grid-column: 1 / -1; text-align: center; padding: 36px;">
        <h3>No se encontraron recursos con los filtros actuales</h3>
        <p style="margin-top: 6px; color: var(--text-muted);">Prueba a limpiar la búsqueda o usa el botón <strong>🔎 Explorador MCP en Vivo</strong> para traer nuevos contenidos desde O’Reilly.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = '';
  state.items.forEach((item, idx) => {
    const card = document.createElement('article');
    // Apply content-visibility: auto strictly to cards below the initial fold
    const isDeferred = idx >= 9 ? 'deferred-card' : '';
    const isSelected = state.selectedItem && state.selectedItem.id === item.id ? 'selected' : '';
    const isRead = item.is_read ? 'is-read' : '';
    card.className = `pulse-card ${isDeferred} ${isSelected} ${isRead}`.trim();

    const badge = getFormatBadgeInfo(item);
    const topicObj = state.topics.find((t) => t.slug === item.topic_slug);
    const sched = formatCountdownAndLocalDate(item.live_dates);
    const dur = formatDuration(item.duration_sec);
    const metaParts = [];
    if (sched) metaParts.push(`🗓️ ${sched.localStr} (${sched.relative})`);
    else if (item.publication_date) metaParts.push(`📅 ${item.publication_date}`);
    if (dur) metaParts.push(`⏱ ${dur}`);
    if (item.page_count) metaParts.push(`📄 ${item.page_count} págs.`);

    const glossaryTerms = (item.glossary || []).slice(0, 3);
    const pillsHtml = glossaryTerms
      .map((g) => `<span class="glossary-pill" title="${escapeHtml(g.definition)}">📚 ${escapeHtml(g.term)}</span>`)
      .join('');

    const fallbackCover = getFallbackSvgCover(item);

    card.innerHTML = `
      <div class="card-top-row">
        <span class="format-badge ${badge.cls}">${escapeHtml(badge.label)}</span>
        <span class="badge-subtle">${escapeHtml(topicObj ? `${topicObj.icon} ${topicObj.name}` : item.topic_slug)}</span>
      </div>

      <div class="card-body-row">
        <img
          class="card-cover"
          src="${escapeHtml(item.image_url || fallbackCover)}"
          alt="Portada de ${escapeHtml(item.title)}"
          loading="${idx < 6 ? 'eager' : 'lazy'}"
          onerror="this.onerror=null;this.src='${fallbackCover}';"
        />
        <div class="card-main-info">
          <h3 class="card-title">${escapeHtml(item.title_es || item.title)}</h3>
          <div class="card-authors">${escapeHtml((item.authors || []).slice(0, 4).join(', '))}</div>
          <div class="card-meta-sub">${escapeHtml(metaParts.join(' · '))}</div>
        </div>
      </div>

      <p class="card-summary">${escapeHtml(item.summary_es || item.summary_en)}</p>

      ${pillsHtml ? `<div class="card-glossary-pills">${pillsHtml}</div>` : ''}

      <div class="card-footer-row">
        <span>${item.is_saved ? '⭐ Guardado' : 'O’Reilly MCP'} · <code>${escapeHtml((item.ourn || '').split(':').slice(-1)[0])}</code></span>
        <button type="button" class="btn-card-action" data-open-dossier="${item.id}">
          ✦ Glosario &amp; Dossier (${(item.glossary || []).length}) →
        </button>
      </div>
    `;

    card.addEventListener('click', (ev) => {
      const wantsDossier = ev.target.closest('[data-open-dossier]');
      if (wantsDossier) {
        state.activeReaderTab = 'glossary';
      }
      selectItem(item, true);
    });

    grid.appendChild(card);
  });
}

// ============================================================================
// 4. Panel Inspector Derecho (Resumen, TOC, Glosario Técnico y Dossier IA)
// ============================================================================
async function selectItem(item, markAsRead = true) {
  state.selectedItem = item;
  document.getElementById('readerEmptyState').hidden = true;
  document.getElementById('readerContent').hidden = false;

  renderReaderContent(item);

  // Resaltar tarjeta activa
  document.querySelectorAll('.pulse-card').forEach((c, idx) => {
    const it = state.items[idx];
    c.classList.toggle('selected', Boolean(it && it.id === item.id));
  });

  if (markAsRead && !item.is_read) {
    item.is_read = true;
    await fetch(`/api/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_read: true })
    });
  }
}

function renderReaderContent(item) {
  const badge = getFormatBadgeInfo(item);
  document.getElementById('readerBadges').innerHTML = `
    <span class="format-badge ${badge.cls}">${escapeHtml(badge.label)}</span>
    <span class="badge-subtle">${escapeHtml((item.publishers || [])[0] || "O'Reilly Media")}</span>
  `;

  const fallbackCover = getFallbackSvgCover(item);
  const coverEl = document.getElementById('readerCover');
  coverEl.onerror = () => {
    coverEl.onerror = null;
    coverEl.src = fallbackCover;
  };
  coverEl.src = item.image_url || fallbackCover;

  document.getElementById('readerTitle').textContent = item.title_es || item.title;
  const origEl = document.getElementById('readerOriginalTitle');
  origEl.textContent = item.title_es && item.title_es !== item.title ? item.title : '';

  document.getElementById('readerAuthors').textContent = (item.authors || []).join(', ');

  const metaParts = [];
  if (item.publication_date) metaParts.push(`Fecha pub.: ${item.publication_date}`);
  if (item.duration_sec) metaParts.push(`Duración: ${formatDuration(item.duration_sec)}`);
  if (item.page_count) metaParts.push(`${item.page_count} páginas`);
  document.getElementById('readerMetaLine').textContent = metaParts.join(' · ');

  const extLink = document.getElementById('readerOfficialLink');
  extLink.href = item.url;

  document.getElementById('readerSaveBtn').textContent = item.is_saved ? '★ Guardado' : '☆ Guardar';
  document.getElementById('readerReadBtn').textContent = item.is_read ? '✓ Leído' : '○ No leído';

  // Calendario de sesiones en vivo
  const schedBox = document.getElementById('readerLiveScheduleBox');
  const sched = formatCountdownAndLocalDate(item.live_dates);
  if (sched) {
    schedBox.hidden = false;
    schedBox.innerHTML = `
      <strong>🗓️ Sesiones en Directo Programadas (${sched.relative}):</strong>
      <ul style="margin-top:4px; padding-left:18px;">
        ${sched.allFormatted.map((s) => `<li>${escapeHtml(s)} (Hora Madrid)</li>`).join('')}
      </ul>
    `;
  } else {
    schedBox.hidden = true;
  }

  document.getElementById('readerSummaryEs').textContent = item.summary_es || item.summary_en;

  const tocEl = document.getElementById('readerTocList');
  tocEl.innerHTML = (item.toc || [])
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('');

  document.getElementById('readerBiblioCard').innerHTML = `
    <div><strong>Título:</strong> ${escapeHtml(item.title)}</div>
    <div><strong>Autores:</strong> ${escapeHtml((item.authors || []).join(', '))}</div>
    <div><strong>Editorial:</strong> ${escapeHtml((item.publishers || []).join(', '))}</div>
    <div><strong>Formato MCP:</strong> ${escapeHtml(item.display_format)} (${escapeHtml(item.marketing_type)})</div>
    <div><strong>Identificador Canónico (OURN):</strong> ${escapeHtml(item.ourn)}</div>
    <div><strong>URL Oficial:</strong> <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.url)}</a></div>
  `;

  // Glosario Técnico
  const glossary = item.glossary || [];
  document.getElementById('readerGlossaryCount').textContent = glossary.length;
  const glossList = document.getElementById('readerGlossaryList');
  glossList.innerHTML = glossary
    .map(
      (g) => `
      <div class="glossary-card">
        <div class="glossary-card-head">
          <span class="glossary-term">${escapeHtml(g.term)}</span>
          <span class="glossary-cat">${escapeHtml(g.category || 'Concepto O’Reilly')}</span>
        </div>
        <p class="glossary-def">${escapeHtml(g.definition)}</p>
      </div>
    `
    )
    .join('');

  // Dossier Markdown
  const dossierHtml = item.dossier_md
    ? renderSimpleMarkdown(item.dossier_md)
    : renderSimpleMarkdown(`## 1. Síntesis Técnica\n\n${item.summary_es}\n\nPulsa **«✦ Profundizar con IA Local»** para generar el dossier extendido y ampliar el glosario de este recurso.`);
  document.getElementById('readerDossierMarkdown').innerHTML = dossierHtml;
  document.getElementById('readerUserNote').value = item.user_note || '';

  switchReaderTab(state.activeReaderTab);
}

function switchReaderTab(tabName) {
  state.activeReaderTab = tabName;
  document.querySelectorAll('.reader-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
  });
  document.getElementById('tabPanelOverview').hidden = tabName !== 'overview';
  document.getElementById('tabPanelGlossary').hidden = tabName !== 'glossary';
  document.getElementById('tabPanelDossier').hidden = tabName !== 'dossier';
}

async function triggerDeepDiveForSelected(forceAi = true) {
  if (!state.selectedItem) return;
  const btn = document.getElementById('readerDeepDiveBtn');
  const regenBtn = document.getElementById('regenerateDossierBtn');
  const prevText = btn.textContent;
  btn.textContent = '⏳ Analizando y generando glosario...';
  btn.disabled = true;
  if (regenBtn) regenBtn.disabled = true;

  try {
    const res = await fetch(`/api/items/${state.selectedItem.id}/deep-dive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceAi })
    });
    const data = await res.json();
    if (data.ok && data.item) {
      state.selectedItem = data.item;
      const idx = state.items.findIndex((x) => x.id === data.item.id);
      if (idx >= 0) state.items[idx] = data.item;
      document.getElementById('dossierModelLabel').textContent = data.model || 'Dossier Generado';
      state.activeReaderTab = 'dossier';
      renderReaderContent(data.item);
      renderCardsGrid();
    }
  } finally {
    btn.textContent = prevText;
    btn.disabled = false;
    if (regenBtn) regenBtn.disabled = false;
  }
}

// ============================================================================
// 5. Exportación a Markdown (.md) y Vista de Informe Técnico Imprimible
// ============================================================================
function exportSelectedToMarkdown() {
  const it = state.selectedItem;
  if (!it) return;
  const glossMd = (it.glossary || [])
    .map((g) => `- **${g.term}** (*${g.category}*): ${g.definition}`)
    .join('\n');
  const tocMd = (it.toc || []).map((t, i) => `${i + 1}. ${t}`).join('\n');

  const mdContent = `# Informe Técnico O'Reilly Pulse: ${it.title_es || it.title}

- **Título original:** ${it.title}
- **Autores / Ponentes:** ${(it.authors || []).join(', ')}
- **Editorial:** ${(it.publishers || []).join(', ')}
- **Formato:** \`${it.display_format}\` (\`${it.marketing_type}\`)
- **Fecha:** ${it.publication_date || 'En vivo'}
- **Identificador Canónico (OURN):** \`${it.ourn}\`
- **Enlace Oficial O'Reilly Learning:** [${it.url}](${it.url})

---

## 1. Resumen Ejecutivo

${it.summary_es}

## 2. Estructura de Sesiones / Capítulos (TOC)

${tocMd}

## 3. Glosario Técnico de Términos Clave

${glossMd}

## 4. Dossier de Profundización

${it.dossier_md || ''}

${it.user_note ? `## 5. Notas Personales\n\n${it.user_note}\n` : ''}
`;

  const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const slug = (it.title || 'dossier-oreilly').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 45);
  a.download = `informe_oreilly_${slug}.md`;
  a.click();
}

function openPrintableReportForSelected() {
  const it = state.selectedItem;
  if (!it) return;
  const win = window.open('', '_blank');
  if (!win) return;

  const glossRows = (it.glossary || [])
    .map(
      (g) => `
      <tr>
        <td style="font-weight:700; padding:8px; border-bottom:1px solid #cbd5e1;">${escapeHtml(g.term)}</td>
        <td style="padding:8px; border-bottom:1px solid #cbd5e1; color:#dc2626; font-weight:600;">${escapeHtml(g.category || '')}</td>
        <td style="padding:8px; border-bottom:1px solid #cbd5e1;">${escapeHtml(g.definition)}</td>
      </tr>`
    )
    .join('');

  win.document.write(`<!DOCTYPE html>
  <html lang="es">
  <head>
    <meta charset="UTF-8" />
    <title>Informe Técnico O'Reilly · ${escapeHtml(it.title)}</title>
    <style>
      body { font-family: Helvetica, Arial, sans-serif; color: #1e293b; max-width: 820px; margin: 32px auto; padding: 0 20px; line-height: 1.55; }
      .banner { background: #f8fafc; border-left: 5px solid #dc2626; padding: 16px 20px; border-radius: 6px; margin-bottom: 22px; }
      h1 { font-size: 22px; margin: 0 0 6px; color: #0f172a; }
      h2 { font-size: 16px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px; margin-top: 24px; color: #0f172a; }
      table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
      th { background: #f1f5f9; text-align: left; padding: 8px; border-bottom: 2px solid #94a3b8; }
      a { color: #dc2626; }
    </style>
  </head>
  <body>
    <div class="banner">
      <h1>Informe Técnico: ${escapeHtml(it.title_es || it.title)}</h1>
      <p style="margin:4px 0; font-size:13px; color:#475569;">
        <strong>Autores:</strong> ${escapeHtml((it.authors || []).join(', '))} |
        <strong>Formato:</strong> ${escapeHtml(it.marketing_type)} |
        <strong>Referencia O'Reilly:</strong> <a href="${escapeHtml(it.url)}">${escapeHtml(it.ourn)}</a>
      </p>
    </div>
    <h2>1. Síntesis Ejecutiva</h2>
    <p>${escapeHtml(it.summary_es)}</p>
    <h2>2. Desglose de Sesiones / Capítulos</h2>
    <ol>${(it.toc || []).map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ol>
    <h2>3. Glosario Técnico de Conceptos Clave</h2>
    <table>
      <thead><tr><th>Término</th><th>Categoría</th><th>Definición Técnica</th></tr></thead>
      <tbody>${glossRows}</tbody>
    </table>
    <h2>4. Dossier de Profundización</h2>
    <div>${renderSimpleMarkdown(it.dossier_md || '')}</div>
    <script>window.onload = () => window.print();</script>
  </body>
  </html>`);
  win.document.close();
}

// ============================================================================
// 6. Modales (<dialog closedby="any"> + Fallback de Light-Dismiss)
// ============================================================================
function setupDialogFallbacks() {
  document.querySelectorAll('dialog.modal-dialog').forEach((dialog) => {
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (isDialogContent) return;
        dialog.close();
      });
    }
  });

  document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-close-dialog');
      const dlg = document.getElementById(id);
      if (dlg) dlg.close();
    });
  });
}

async function openBriefingModal(scope = 'pulse') {
  state.briefingScope = scope;
  const dlg = document.getElementById('briefingDialog');
  if (!dlg.open) dlg.showModal();

  document.querySelectorAll('#briefingScopeTabs .chip').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-scope') === scope);
  });

  const res = await fetch(`/api/briefing?scope=${encodeURIComponent(scope)}`);
  const data = await res.json();
  if (!data.ok || !data.briefing) return;

  renderBriefingContent(data.briefing);
}

async function renderBriefingContent(briefing) {
  state.currentBriefing = briefing;
  document.getElementById('briefingDialogTitle').textContent = `✦ ${briefing.title}`;
  document.getElementById('briefingModelBadge').textContent = briefing.ai_model || 'Motor O’Reilly Pulse';
  document.getElementById('briefingAiContent').innerHTML = renderSimpleMarkdown(briefing.ai_markdown);

  const clustersList = document.getElementById('briefingClustersList');
  clustersList.innerHTML = (briefing.clusters || [])
    .map(
      (c) => `
      <div class="cluster-box" style="border-left: 4px solid ${escapeHtml(c.color || '#dc2626')}">
        <div class="cluster-box-head">
          <span>${escapeHtml(c.title)}</span>
          <span class="badge-subtle">${c.count} recursos</span>
        </div>
        <div style="font-size: 12px; color: var(--text-secondary);">
          ${(c.items || [])
            .slice(0, 3)
            .map(
              (it) =>
                `<div style="margin-top:4px;">• <a href="${escapeHtml(it.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--text-main);font-weight:600;">${escapeHtml(it.title_es || it.title)}</a> <span style="color:var(--text-muted)">(${escapeHtml(it.marketing_type)})</span></div>`
            )
            .join('')}
        </div>
      </div>
    `
    )
    .join('');

  const canvas = document.getElementById('pulseRadarCanvas');
  await gpuEngine.computeAffinityAndRender(canvas, briefing.clusters || [], (hoveredCluster) => {
    const cap = document.getElementById('radarHoverCaption');
    if (hoveredCluster) {
      cap.innerHTML = `<strong>${escapeHtml(hoveredCluster.title)}</strong> (${hoveredCluster.count} recursos) · Destacado: <em>${escapeHtml(hoveredCluster.leadItem?.title_es || hoveredCluster.leadItem?.title || '')}</em>`;
    } else {
      cap.textContent = 'Pasa el cursor sobre los nodos del radar para inspeccionar la convergencia de libros, charlas y laboratorios por área técnica.';
    }
  });
  document.getElementById('gpuComputeBadge').textContent = `${gpuEngine.ready ? 'WebGPU WGSL' : 'Canvas 2D'} · ${gpuEngine.lastComputeMs} ms`;
}

function openTopicModal() {
  const dlg = document.getElementById('topicDialog');
  renderPresetTopicsGrid();
  if (!dlg.open) dlg.showModal();
}

function renderPresetTopicsGrid() {
  const grid = document.getElementById('presetTopicsGrid');
  const activeSlugs = new Set(state.topics.map((t) => t.slug));

  grid.innerHTML = state.presetCatalogTopics
    .map((p) => {
      const isAdded = activeSlugs.has(p.slug);
      return `
        <div class="preset-card" style="border-top: 3px solid ${escapeHtml(p.color || '#dc2626')}">
          <div class="preset-card-title">${escapeHtml(p.icon)} ${escapeHtml(p.name)}</div>
          <p class="preset-card-desc">${escapeHtml(p.description || '')}</p>
          <button
            type="button"
            class="btn-mini-add"
            data-add-preset="${escapeHtml(p.slug)}"
            ${isAdded ? 'disabled' : ''}
          >
            ${isAdded ? '✓ Ya activa en tu barra' : '+ Añadir Área en 1 Clic'}
          </button>
        </div>
      `;
    })
    .join('');

  grid.querySelectorAll('[data-add-preset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slug = btn.getAttribute('data-add-preset');
      const preset = state.presetCatalogTopics.find((p) => p.slug === slug);
      if (!preset) return;
      btn.textContent = '⏳ Sincronizando MCP...';
      btn.disabled = true;
      await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preset)
      });
      await fetchBootstrap();
      await fetchItems();
      renderPresetTopicsGrid();
    });
  });
}

// ============================================================================
// 7. Conmutador de Tema (modern-web-guidance: dark-mode-toggle)
// ============================================================================
function toggleColorScheme() {
  const meta = document.querySelector('meta[name="color-scheme"]');
  const stored = localStorage.getItem('oreilly_pulse_scheme');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const currentRendered = stored === 'light' || stored === 'dark' ? stored : systemDark ? 'dark' : 'light';
  const targetScheme = currentRendered === 'dark' ? 'light' : 'dark';
  const systemScheme = systemDark ? 'dark' : 'light';

  if (targetScheme === systemScheme) {
    localStorage.removeItem('oreilly_pulse_scheme');
    meta.setAttribute('content', 'light dark');
  } else {
    localStorage.setItem('oreilly_pulse_scheme', targetScheme);
    meta.setAttribute('content', targetScheme);
  }
}

// ============================================================================
// 8. Inicialización de Eventos UI
// ============================================================================
function bindEvents() {
  setupDialogFallbacks();

  // Navegación por Canales
  document.querySelectorAll('#channelNavList .nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#channelNavList .nav-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.channel = btn.getAttribute('data-channel') || 'all';
      updateHeaderTitle();
      fetchItems();
    });
  });

  // Subfiltros por formato
  document.querySelectorAll('#formatFilterBar .chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#formatFilterBar .chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.format = btn.getAttribute('data-format') || '';
      fetchItems();
    });
  });

  // Modo de vista Revista vs Compacta
  document.getElementById('viewMagazineBtn').addEventListener('click', () => {
    state.viewMode = 'magazine';
    document.getElementById('viewMagazineBtn').classList.add('active');
    document.getElementById('viewCompactBtn').classList.remove('active');
    renderCardsGrid();
  });
  document.getElementById('viewCompactBtn').addEventListener('click', () => {
    state.viewMode = 'compact';
    document.getElementById('viewCompactBtn').classList.add('active');
    document.getElementById('viewMagazineBtn').classList.remove('active');
    renderCardsGrid();
  });

  // Búsqueda FTS5 instantánea
  let searchTimer = null;
  document.getElementById('searchInput').addEventListener('input', (ev) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = ev.target.value.trim();
      fetchItems();
    }, 180);
  });

  // Solo no leídos
  document.getElementById('toggleUnreadBtn').addEventListener('click', (ev) => {
    state.onlyUnread = !state.onlyUnread;
    ev.currentTarget.classList.toggle('active', state.onlyUnread);
    fetchItems();
  });

  // Marcar como leídos
  document.getElementById('markAllReadBtn').addEventListener('click', async () => {
    const ids = state.items.map((i) => i.id);
    await fetch('/api/items/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    await fetchBootstrap();
    await fetchItems();
  });

  // Sincronización MCP + Radar RSS
  document.getElementById('syncMcpBtn').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const orig = btn.textContent;
    btn.textContent = '⏳ Sincronizando MCP...';
    btn.disabled = true;
    try {
      await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic_slug: state.topic || null })
      });
      await fetchBootstrap();
      await fetchItems();
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  });

  // Tema Claro / Oscuro
  document.getElementById('themeToggleBtn').addEventListener('click', toggleColorScheme);

  // Pestañas del Inspector Derecho
  document.querySelectorAll('.reader-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchReaderTab(btn.getAttribute('data-tab')));
  });

  // Acciones del Inspector Derecho
  document.getElementById('readerSaveBtn').addEventListener('click', async () => {
    if (!state.selectedItem) return;
    const nextSaved = !state.selectedItem.is_saved;
    const res = await fetch(`/api/items/${state.selectedItem.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_saved: nextSaved })
    });
    const data = await res.json();
    if (data.ok && data.item) {
      state.selectedItem = data.item;
      renderReaderContent(data.item);
      await fetchBootstrap();
      await fetchItems();
    }
  });

  document.getElementById('readerReadBtn').addEventListener('click', async () => {
    if (!state.selectedItem) return;
    const nextRead = !state.selectedItem.is_read;
    const res = await fetch(`/api/items/${state.selectedItem.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_read: nextRead })
    });
    const data = await res.json();
    if (data.ok && data.item) {
      state.selectedItem = data.item;
      renderReaderContent(data.item);
      await fetchBootstrap();
      await fetchItems();
    }
  });

  document.getElementById('readerDeepDiveBtn').addEventListener('click', () => triggerDeepDiveForSelected(true));
  document.getElementById('regenerateDossierBtn').addEventListener('click', () => triggerDeepDiveForSelected(true));
  document.getElementById('readerExportMdBtn').addEventListener('click', exportSelectedToMarkdown);
  document.getElementById('readerPrintBtn').addEventListener('click', openPrintableReportForSelected);

  document.getElementById('saveUserNoteBtn').addEventListener('click', async (ev) => {
    if (!state.selectedItem) return;
    const note = document.getElementById('readerUserNote').value;
    const btn = ev.currentTarget;
    btn.textContent = '✓ Guardado';
    await fetch(`/api/items/${state.selectedItem.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_note: note })
    });
    setTimeout(() => {
      btn.textContent = 'Guardar nota';
    }, 1200);
  });

  // Modales
  document.getElementById('openBriefingBtn').addEventListener('click', () => openBriefingModal('pulse'));
  document.querySelectorAll('#briefingScopeTabs .chip').forEach((btn) => {
    btn.addEventListener('click', () => openBriefingModal(btn.getAttribute('data-scope')));
  });
  document.getElementById('regenerateBriefingBtn').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.textContent = '⏳ Sintetizando con Gemma 4...';
    btn.disabled = true;
    try {
      const res = await fetch('/api/briefing/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: state.briefingScope })
      });
      const data = await res.json();
      if (data.ok && data.briefing) {
        await renderBriefingContent(data.briefing);
      }
    } finally {
      btn.textContent = '✦ Sintetizar con Gemma 4';
      btn.disabled = false;
    }
  });

  document.getElementById('openAddTopicBtn').addEventListener('click', openTopicModal);

  document.getElementById('customTopicForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = document.getElementById('topicNameInput').value.trim();
    const icon = document.getElementById('topicIconInput').value.trim() || '📡';
    const color = document.getElementById('topicColorInput').value || '#dc2626';
    const mcp_query = document.getElementById('topicQueryInput').value.trim();
    const authorsRaw = document.getElementById('topicAuthorsInput').value.trim();
    const fmt = document.getElementById('topicFormatSelect').value;

    const author_filter = authorsRaw ? authorsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const content_types = fmt ? [fmt] : [];

    await fetch('/api/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, icon, color, mcp_query, author_filter, content_types })
    });

    document.getElementById('customTopicForm').reset();
    document.getElementById('topicDialog').close();
    await fetchBootstrap();
    await fetchItems();
  });

  // Explorador MCP en Vivo
  document.getElementById('openMcpExplorerBtn').addEventListener('click', () => {
    const dlg = document.getElementById('mcpExplorerDialog');
    if (!dlg.open) dlg.showModal();
  });

  document.getElementById('mcpExplorerForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const query = document.getElementById('mcpLiveQueryInput').value.trim();
    const order_by = document.getElementById('mcpLiveOrderSelect').value;
    const authorRaw = document.getElementById('mcpLiveAuthorInput').value.trim();
    const topic_slug = document.getElementById('mcpLiveTargetTopicSelect').value;

    const statusEl = document.getElementById('mcpLiveResultsStatus');
    const listEl = document.getElementById('mcpLiveResultsList');
    const submitBtn = document.getElementById('mcpLiveSubmitBtn');

    statusEl.textContent = `⏳ Consultando servidor MCP de O'Reilly ("${query}")...`;
    submitBtn.disabled = true;

    try {
      const res = await fetch('/api/mcp-live-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          order_by,
          author_filter: authorRaw ? authorRaw.split(',').map((a) => a.trim()).filter(Boolean) : [],
          topic_slug
        })
      });
      const data = await res.json();
      if (data.ok) {
        statusEl.textContent = `✓ ${data.count} recursos encontrados e incorporados a tu catálogo local (${data.source === 'mcp-live' ? 'Servidor MCP O’Reilly en vivo' : 'Índice local FTS5'}):`;
        listEl.innerHTML = (data.items || [])
          .map(
            (it) => `
            <div class="cluster-box">
              <div class="cluster-box-head">
                <span>${escapeHtml(it.title_es || it.title)}</span>
                <span class="badge-subtle">${escapeHtml(it.marketing_type || it.display_format)}</span>
              </div>
              <div style="font-size:12px; color:var(--text-secondary); margin-bottom:6px;">
                ${escapeHtml((it.authors || []).join(', '))} · <code>${escapeHtml(it.ourn)}</code>
              </div>
              <a href="${escapeHtml(it.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--oreilly-red);font-size:12px;font-weight:700;">Abrir en O’Reilly Learning ↗</a>
            </div>
          `
          )
          .join('');
        await fetchBootstrap();
        await fetchItems();
      }
    } finally {
      submitBtn.disabled = false;
    }
  });
}

function setupSecureContextAutoRedirect() {
  const host = window.location.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') return;

  const port = window.location.port || '3050';
  const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
  const targetOrigin = isMac ? `http://localhost:${port}` : `http://127.0.0.1:${port}`;
  const netshCmd = `netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=${port} connectaddress=${host} connectport=${port}`;

  const tryRedirectToLoopback = async () => {
    try {
      const res = await fetch(`${targetOrigin}/api/ping?from=lan`, {
        mode: 'cors',
        cache: 'no-store'
      });
      if (res.ok) {
        window.location.replace(`${targetOrigin}${window.location.pathname}${window.location.search}${window.location.hash}`);
        return true;
      }
    } catch {}
    return false;
  };

  tryRedirectToLoopback().then((redirected) => {
    if (redirected) return;

    // Mostrar aviso de activación en 1 clic si aún no está registrado el portproxy del puerto 3050 en Windows
    const mainCol = document.querySelector('.main-workspace');
    if (mainCol && !document.getElementById('secureTunnelBanner')) {
      const banner = document.createElement('div');
      banner.id = 'secureTunnelBanner';
      banner.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 18px;background:rgba(220,38,38,0.14);border-bottom:1px solid rgba(220,38,38,0.38);font-size:12.5px;color:var(--text-primary);';
      banner.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span>🔒 <strong>Quitar aviso «No es seguro» y activar WebGPU en Windows (igual que Feedly):</strong></span>
          <span style="color:var(--text-secondary);">Redirige <code>http://127.0.0.1:${port}</code> a este Mac de forma permanente.</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <a href="/activar-windows-seguro.bat" class="btn-primary btn-sm" style="text-decoration:none;display:inline-flex;align-items:center;gap:5px;">
            ⬇ Descargar Activador 1-Clic (.bat)
          </a>
          <button type="button" id="copyNetshBtn" class="btn-secondary btn-sm">
            📋 Copiar comando PowerShell
          </button>
        </div>
      `;
      mainCol.insertBefore(banner, mainCol.firstChild);

      const copyBtn = document.getElementById('copyNetshBtn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(netshCmd);
          } else {
            const ta = document.createElement('textarea');
            ta.value = netshCmd;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          }
          copyBtn.textContent = '✓ Comando copiado (Pégalo en PowerShell Admin)';
          setTimeout(() => {
            copyBtn.textContent = '📋 Copiar comando PowerShell';
          }, 3000);
        });
      }
    }

    // Sondear cada 2.5 s para que en cuanto se ejecute el .bat o el comando netsh en Windows, salte solo a 127.0.0.1:3050
    const pollId = setInterval(async () => {
      const ok = await tryRedirectToLoopback();
      if (ok) clearInterval(pollId);
    }, 2500);
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  setupSecureContextAutoRedirect();
  bindEvents();
  await fetchBootstrap();
  await fetchItems();
});
