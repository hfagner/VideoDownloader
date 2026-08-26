// DOM Elements
const mediaList = document.getElementById('media-list');
const emptyState = document.getElementById('empty-state');
const template = document.getElementById('media-card-template');
const btnSidebar = document.getElementById('btn-sidebar');
const btnSettings = document.getElementById('btn-settings');
const backendPill = document.getElementById('backend-pill');
const historyToggle = document.getElementById('history-toggle');
const historyList = document.getElementById('history-list');
const btnOpenFolder = document.getElementById('btn-open-folder');
const btnClearHistory = document.getElementById('btn-clear-history');
const btnOpenDashboard = document.getElementById('btn-open-dashboard');
const activeDownloadsSection = document.getElementById('active-downloads-section');
const activeDownloadsList = document.getElementById('active-downloads-list');

// State
let currentTabId = null;
let detectedItems = [];
let backendStatus = { online: false, port: null };

const PLATFORM_LABELS = {
  youtube: 'YouTube', vimeo: 'Vimeo', panda: 'Panda Video',
  hotmart: 'Hotmart', instagram: 'Instagram',
};

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function updateBackendPill() {
  if (backendStatus.online) {
    backendPill.className = 'pill pill-on';
    backendPill.textContent = '● Motor Local';
  } else {
    backendPill.className = 'pill pill-off';
    backendPill.textContent = '● Motor Local offline';
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId = tab.id;
    loadMediaForTab(currentTabId);
  }
  backendStatus = (await Messaging.sendToBackground(MessageType.BACKEND_STATUS)) || backendStatus;
  updateBackendPill();
  loadHistory();
  loadActiveDownloads();
  setupEventListeners();
}

async function loadMediaForTab(tabId) {
  const items = await Messaging.sendToBackground(MessageType.GET_MEDIA, { tabId });
  detectedItems = items || [];
  renderMediaList(detectedItems);
}

function renderChips(card, item, analysis) {
  const container = card.querySelector('.media-chips');
  container.innerHTML = '';
  const chips = [];
  if (item.isEmbed && PLATFORM_LABELS[item.embedPlatform]) {
    chips.push(PLATFORM_LABELS[item.embedPlatform]);
  } else if (item.type === 'audio') {
    chips.push('Áudio');
  } else {
    chips.push('Vídeo');
  }
  chips.push((item.format || 'mp4').toUpperCase());
  const duration = Formats.formatDuration(analysis && analysis.duration);
  if (duration) chips.push(duration);
  container.innerHTML = chips.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('');
}

function renderFormatList(card, item, analysis) {
  const listEl = card.querySelector('.format-list');
  listEl.innerHTML = '';
  const formats = (analysis && analysis.formats) || [];
  if (formats.length === 0) {
    listEl.innerHTML = '<div class="analyze-status">Nenhum formato disponível.</div>';
    listEl.classList.remove('hidden');
    return;
  }

  formats.forEach((fmt) => {
    const row = document.createElement('div');
    row.className = 'format-row' + (fmt.id === analysis.best_id ? ' best' : '');
    const label = fmt.type === 'audio' ? 'MP3' : (fmt.resolution || (fmt.ext || '').toUpperCase());
    row.innerHTML = `
      <span class="dl">⬇</span>
      <span class="res">${escapeHtml(label)}</span>
      <span class="ext">${escapeHtml((fmt.type === 'audio' ? 'Áudio · 192kbps' : (fmt.ext || '').toUpperCase()))}</span>
      <span class="size">${escapeHtml(Formats.sizeLabel(fmt.size, fmt.size_estimated))}</span>
      ${fmt.id === analysis.best_id ? '<span class="badge-best">MELHOR</span>' : ''}
    `;
    row.addEventListener('click', () => downloadRow(card, item, fmt));
    listEl.appendChild(row);
  });

  listEl.innerHTML += '<div class="format-legend">≈ tamanho estimado · clique numa linha para baixar</div>';
  listEl.classList.remove('hidden');
}

async function downloadRow(card, item, fmt) {
  const input = card.querySelector('.media-filename');
  const res = await Messaging.sendToBackground(MessageType.START_DOWNLOAD, {
    item: { ...item, tabId: currentTabId },
    filename: input.value,
    selector: fmt.selector || null,
    formatUrl: fmt.url || null,
    audio: fmt.type === 'audio',
  });
  if (res && res.ok) {
    flashButton(card.querySelector('.btn-primary'), res.kind === 'advanced' ? 'No Motor Local!' : '✅ Iniciado');
  } else {
    const reason = res && res.reason;
    if (reason === 'backend_offline') {
      showWarn(card, 'Inicie o Motor Local para baixar este formato.');
    } else {
      showWarn(card, (res && res.error) || 'Falha ao iniciar o download.');
    }
  }
}

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2000);
}

function showWarn(card, message) {
  const status = card.querySelector('.analyze-status');
  status.classList.remove('hidden');
  status.innerHTML = `⚠ ${escapeHtml(message)}`;
}

async function expandFormats(card, item) {
  const status = card.querySelector('.analyze-status');
  const listEl = card.querySelector('.format-list');
  status.classList.remove('hidden');
  status.innerHTML = '<span class="spinner"></span> Analisando…';
  listEl.classList.add('hidden');

  const res = await Messaging.sendToBackground(MessageType.ANALYZE_MEDIA, {
    url: item.url,
    referer: item.pageUrl,
  });

  if (res && res.ok) {
    status.classList.add('hidden');
    const title = Formats.fallbackTitle(item, res.result.title);
    card.querySelector('.media-filename').value = title;
    renderChips(card, item, res.result);
    renderFormatList(card, item, res.result);
    card._analysis = res.result;
  } else {
    const reason = res && res.reason;
    if (reason === 'backend_offline') {
      status.innerHTML = '⚠ Motor Local offline. <span class="retry">Tentar novamente</span>';
    } else {
      status.innerHTML = `Não foi possível analisar. <span class="retry">Tentar novamente</span>`;
    }
    status.querySelector('.retry').addEventListener('click', () => expandFormats(card, item));
  }
}

async function downloadBest(card, item) {
  // Arquivo direto com motor offline: baixa direto no navegador (sem análise).
  if (!backendStatus.online && Formats.isDirectFile(item)) {
    await downloadRow(card, item, {});
    return;
  }
  if (!card._analysis) {
    await expandFormats(card, item);
  }
  const analysis = card._analysis;
  if (!analysis) return;
  const best = Formats.pickBest(analysis.formats, analysis.best_id);
  if (best) await downloadRow(card, item, best);
}

function renderMediaList(items) {
  mediaList.innerHTML = '';

  if (items.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  items.slice(0, 10).forEach((item) => {
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector('.media-card');
    const input = clone.querySelector('.media-filename');
    const btnMore = clone.querySelector('.btn-more');
    const moreMenu = clone.querySelector('.more-menu');

    input.value = Formats.fallbackTitle(item, null);
    renderChips(card, item, null);

    if (item.size > 0 && Formats.isDirectFile(item)) {
      card.querySelector('.media-chips').innerHTML +=
        `<span class="chip">${escapeHtml(Formats.sizeLabel(item.size, false))}</span>`;
    }

    if (item.isEmbed) {
      const badge = document.createElement('span');
      const isHotmart = item.embedPlatform === 'hotmart';
      badge.className = 'chip';
      badge.style.cssText = isHotmart
        ? 'background:#F7A800;color:#000;font-weight:600;'
        : 'background:#E1306C;color:#fff;font-weight:600;';
      badge.textContent = isHotmart ? '▶ Play primeiro' : 'Embed';
      card.querySelector('.media-chips').appendChild(badge);
    }

    if (item.embedPlatform === 'hotmart' && !backendStatus.online) {
      showWarn(card, 'Dê play no vídeo e mantenha o Motor Local rodando para baixar.');
    }

    // Offline + arquivo direto: aviso e botão de fallback nativo (spec §4.1).
    if (!backendStatus.online && Formats.isDirectFile(item)) {
      const warn = document.createElement('div');
      warn.className = 'warn-box';
      warn.textContent = '⚠ Motor Local offline — o download usará o navegador.';
      card.querySelector('.media-buttons').insertAdjacentElement('afterend', warn);
      card.querySelector('.btn-best').textContent = '⬇ Baixar direto (navegador)';
    }

    card.querySelector('.btn-analyze').addEventListener('click', () => expandFormats(card, item));
    card.querySelector('.btn-best').addEventListener('click', () => downloadBest(card, item));

    btnMore.addEventListener('click', (e) => {
      e.stopPropagation();
      const visible = !moreMenu.classList.contains('hidden');
      document.querySelectorAll('.more-menu').forEach((m) => m.classList.add('hidden'));
      if (!visible) moreMenu.classList.remove('hidden');
    });

    clone.querySelector('.btn-copy-url').addEventListener('click', () => {
      navigator.clipboard.writeText(item.url);
      moreMenu.classList.add('hidden');
    });
    clone.querySelector('.btn-copy-page').addEventListener('click', () => {
      navigator.clipboard.writeText(item.pageUrl);
      moreMenu.classList.add('hidden');
    });
    clone.querySelector('.btn-blacklist').addEventListener('click', async () => {
      const urlObj = new URL(item.pageUrl);
      await Storage.addToBlacklist(urlObj.hostname);
      moreMenu.classList.add('hidden');
    });

    mediaList.appendChild(clone);
  });
}

async function loadHistory() {
  const history = await Storage.getHistory();
  historyList.innerHTML = '';
  if (history.length === 0) {
    historyList.innerHTML = '<div style="padding: 8px; text-align: center; color: var(--text-4); font-size: 10.5px;">Sem downloads recentes</div>';
    return;
  }
  history.slice(0, 5).forEach((item) => {
    const el = document.createElement('div');
    el.className = 'history-item';
    const timeStr = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const shortName = (item.filename || '').split('/').pop();
    el.innerHTML = `
      <span class="filename" title="${escapeHtml(item.filename)}">${escapeHtml(shortName)}</span>
      <span class="time">${item.state === 'complete' ? '✅' : '⏳'} ${timeStr}</span>
    `;
    historyList.appendChild(el);
  });
}

async function loadActiveDownloads() {
  const active = await Messaging.sendToBackground(MessageType.GET_ACTIVE_DOWNLOADS);
  renderActiveDownloads(active || []);
}

function activeStateLabel(item) {
  if (item.state === 'complete') return '✅ Concluído';
  if (item.state === 'error') return '❌ Erro';
  if (item.state === 'interrupted') return '⚠️ Interrompido';
  if (item.state === 'merging') return '🎛️ Juntando áudio e vídeo...';
  return '⏳ Baixando...';
}

function renderActiveDownloads(items) {
  if (!activeDownloadsSection || !activeDownloadsList) return;
  activeDownloadsList.innerHTML = '';
  if (!items || items.length === 0) {
    activeDownloadsSection.classList.add('hidden');
    return;
  }
  activeDownloadsSection.classList.remove('hidden');

  items.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'active-item';
    const short = (item.filename || item.url || '').split('/').pop();
    const pct = Math.max(0, Math.min(100, parseInt(item.progress, 10) || 0));
    el.innerHTML = `
      <div class="active-item-head">
        <span class="filename" title="${escapeHtml(item.url || '')}">${escapeHtml(short)}</span>
        <span class="pct">${pct}%</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="active-state">${activeStateLabel(item)}${item.speed ? `<span class="active-speed"> · ${escapeHtml(item.speed)}</span>` : ''}</div>
    `;
    activeDownloadsList.appendChild(el);
  });
}

function setupEventListeners() {
  document.addEventListener('click', () => {
    document.querySelectorAll('.more-menu').forEach((m) => m.classList.add('hidden'));
  });

  btnSidebar.addEventListener('click', () => {
    chrome.sidePanel.setOptions({ tabId: currentTabId, path: 'popup/popup.html', enabled: true });
    chrome.sidePanel.open({ tabId: currentTabId });
    window.close();
  });

  btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

  btnOpenDashboard.addEventListener('click', () => {
    const port = backendStatus.port || 5000;
    chrome.tabs.create({ url: `http://127.0.0.1:${port}/` });
  });

  historyToggle.addEventListener('click', () => {
    historyList.classList.toggle('collapsed');
    const chevron = historyToggle.querySelector('.chevron');
    chevron.textContent = historyList.classList.contains('collapsed') ? '▾' : '▴';
  });

  btnOpenFolder.addEventListener('click', () => chrome.downloads.showDefaultFolder());
  btnClearHistory.addEventListener('click', async () => {
    await Storage.clearHistory();
    loadHistory();
  });

  Messaging.addListener((message) => {
    if (message.type === MessageType.DOWNLOAD_UPDATE) {
      loadHistory();
      loadActiveDownloads();
    } else if (message.type === MessageType.BACKEND_STATUS) {
      const next = message.payload || backendStatus;
      const changed = next.online !== backendStatus.online;
      backendStatus = next;
      updateBackendPill();
      // Re-renderiza apenas quando o estado muda (liga/desliga o motor)
      if (changed) renderMediaList(detectedItems);
    }
    return false;
  });
}

document.addEventListener('DOMContentLoaded', init);
