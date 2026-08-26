importScripts('libs/storage.js', 'libs/messaging.js', 'libs/formats.js', 'libs/backend.js');

// Padrões de mídia a serem monitorados
const MEDIA_PATTERNS = {
  video: ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv'],
  audio: ['.mp3', '.wav', '.ogg', '.aac', '.flac'],
  stream: ['.m3u8', '.mpd'],
  mimeTypes: [
    'video/mp4', 'video/webm', 'video/x-matroska',
    'audio/mpeg', 'audio/ogg', 'audio/wav',
    'application/vnd.apple.mpegurl',
    'application/dash+xml'
  ]
};

// Estado em memória (Map<tabId, Map<url, MediaItem>>)
// Usamos Map interno para deduplicação fácil por URL
const mediaState = new Map();

/**
 * Gera um ID único simples
 */
function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Downloads em andamento (persistentes, independentes da aba)
// Mantém o progresso visível mesmo após fechar a aba ou o popup.
// ---------------------------------------------------------------------------

// Cache em memória; recarregado do storage sob demanda (o service worker
// pode ser encerrado e reiniciado pelo navegador a qualquer momento).
let activeDownloadsCache = null;

// Status do Motor Local (cache em memória + ping periódico)
const BACKEND_PING_ALARM = 'backend-ping';
const BACKEND_PING_INTERVAL_MIN = 0.5; // mínimo suportado pelo chrome.alarms
let backendStatus = { online: false, port: null };
let backendStatusCheckedAt = 0;

const ADVANCED_POLL_ALARM = 'advanced-download-poll';
const ADVANCED_POLL_INTERVAL_MIN = 0.5; // mínimo suportado pelo chrome.alarms (30s)

async function getActiveMap() {
  if (!activeDownloadsCache) {
    const arr = await Storage.getActiveDownloads();
    activeDownloadsCache = new Map(arr.map(i => [i.id, i]));
  }
  return activeDownloadsCache;
}

async function persistActiveDownloads() {
  if (activeDownloadsCache) {
    await Storage.setActiveDownloads(Array.from(activeDownloadsCache.values()));
  }
}

function broadcastDownloadUpdate() {
  chrome.runtime.sendMessage({ type: MessageType.DOWNLOAD_UPDATE }, () => {
    if (chrome.runtime.lastError) { /* nenhum listener aberto no momento */ }
  });
}

function broadcastBackendStatus() {
  chrome.runtime.sendMessage({ type: MessageType.BACKEND_STATUS, payload: backendStatus }, () => {
    if (chrome.runtime.lastError) { /* nenhum listener aberto */ }
  });
}

async function refreshBackendStatus() {
  const port = await Backend.findActivePort();
  backendStatus = { online: port !== null, port };
  backendStatusCheckedAt = Date.now();
  await Storage.setBackendPort(port);
  broadcastBackendStatus();
}

async function updateActiveBadge() {
  const map = await getActiveMap();
  const count = map.size;
  if (count > 0) {
    chrome.action.setBadgeText({ text: count > 9 ? '9+' : String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#107C10' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function shortName(filename) {
  if (!filename) return 'Arquivo';
  return filename.split('/').pop();
}

function notifyIfEnabled(title, message) {
  Storage.getSettings().then((s) => {
    if (s.showNotifications !== false) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-active-128.png',
        title: title,
        message: message
      });
    }
  });
}

async function upsertActiveDownload(item) {
  const map = await getActiveMap();
  map.set(item.id, item);
  await persistActiveDownloads();
  broadcastDownloadUpdate();
  updateActiveBadge();
}

async function removeActiveDownload(id) {
  const map = await getActiveMap();
  if (map.delete(id)) {
    await persistActiveDownloads();
    broadcastDownloadUpdate();
    updateActiveBadge();
  }
}

async function updateHistoryState(identifier, state, progress) {
  const history = await Storage.getHistory();
  const idx = history.findIndex(h => h.downloadId === identifier || h.taskId === identifier);
  if (idx !== -1) {
    if (state) history[idx].state = state;
    if (progress != null) history[idx].progress = progress;
    await Storage.set('downloadHistory', history);
  }
}

/**
 * Registra um download do Motor Local (servidor Flask local) para que o
 * progresso continue sendo acompanhado mesmo com o popup/aba fechados.
 */
async function startAdvancedDownloadTracking({ taskId, url, filename }) {
  if (!taskId) return;

  const map = await getActiveMap();
  map.set(taskId, {
    id: taskId,
    kind: 'advanced',
    url: url,
    filename: filename || url,
    timestamp: Date.now(),
    state: 'downloading',
    progress: 0
  });
  await persistActiveDownloads();

  await Storage.addToHistory({
    id: generateId(),
    taskId: taskId,
    url: url,
    filename: filename || url,
    timestamp: Date.now(),
    state: 'in_progress'
  });

  broadcastDownloadUpdate();
  updateActiveBadge();

  // Garante a consulta periódica ao servidor local (o alarme sobrevive ao
  // encerramento do service worker e o reativa quando dispara).
  chrome.alarms.create(ADVANCED_POLL_ALARM, { periodInMinutes: ADVANCED_POLL_INTERVAL_MIN });

  // Primeira consulta imediata para feedback rápido
  pollAdvancedTasks();
}

async function pollAdvancedTasks() {
  const map = await getActiveMap();
  const advancedItems = Array.from(map.values()).filter(i => i.kind === 'advanced');

  if (advancedItems.length === 0) {
    chrome.alarms.clear(ADVANCED_POLL_ALARM);
    return;
  }

  for (const item of advancedItems) {
    try {
      const response = await fetch(Backend.apiUrl(backendStatus.port, `/api/status/${item.id}`));
      const data = await response.json();

      if (!response.ok) continue;

      // Extrai o percentual numérico de strings como "45%" ou "Baixando stream..."
      const match = String(data.progress || '').match(/(\d+)/);
      if (match) item.progress = Math.min(100, parseInt(match[1], 10));

      if (data.status === 'completed') {
        item.state = 'complete';
        item.progress = 100;
        await removeActiveDownload(item.id);
        await updateHistoryState(item.id, 'complete', 100);
        notifyIfEnabled('Download concluído', shortName(item.filename));
      } else if (data.status === 'error') {
        item.state = 'error';
        await removeActiveDownload(item.id);
        await updateHistoryState(item.id, 'error');
        notifyIfEnabled('Erro no download', data.error || shortName(item.filename));
      } else {
        item.state = data.status || 'downloading';
      }
    } catch (e) {
      // Servidor local indisponível no momento; mantém o último estado conhecido.
      // Re-descobre a porta ativa: o Motor Local pode ter subido em outra porta.
      refreshBackendStatus();
      continue;
    }
  }

  const remaining = Array.from(map.values()).filter(i => i.kind === 'advanced');
  if (remaining.length === 0) {
    chrome.alarms.clear(ADVANCED_POLL_ALARM);
  }
  await persistActiveDownloads();
  broadcastDownloadUpdate();
  updateActiveBadge();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ADVANCED_POLL_ALARM) {
    pollAdvancedTasks();
  } else if (alarm.name === BACKEND_PING_ALARM) {
    refreshBackendStatus();
  }
});

// Status inicial do motor + ping periódico
refreshBackendStatus();
chrome.alarms.create(BACKEND_PING_ALARM, { periodInMinutes: BACKEND_PING_INTERVAL_MIN });

/**
 * Atualiza o ícone e o badge da aba específica
 * @param {number} tabId 
 */
function updateTabIcon(tabId) {
  const itemsMap = mediaState.get(tabId);
  const count = itemsMap ? itemsMap.size : 0;

  if (count > 0) {
    chrome.action.setIcon({
      tabId: tabId,
      path: {
        "16": "icons/icon-active-16.png",
        "32": "icons/icon-active-32.png",
        "48": "icons/icon-active-48.png",
        "128": "icons/icon-active-128.png"
      }
    });
    chrome.action.setBadgeText({ tabId, text: count.toString() });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#0078D4' }); // Azul Edge
  } else {
    chrome.action.setIcon({
      tabId: tabId,
      path: {
        "16": "icons/icon-16.png",
        "32": "icons/icon-32.png",
        "48": "icons/icon-48.png",
        "128": "icons/icon-128.png"
      }
    });
    chrome.action.setBadgeText({ tabId, text: '' });
  }
}

/**
 * Adiciona um item de mídia ao estado da aba
 * @param {number} tabId 
 * @param {Object} item 
 */
function addMediaItem(tabId, item) {
  if (!mediaState.has(tabId)) {
    mediaState.set(tabId, new Map());
  }
  
  const tabMedia = mediaState.get(tabId);
  
  // Deduplicação básica por URL (evita fragmentos de HLS poluindo a lista,
  // mas idealmente o HLS principal `.m3u8` é o que queremos).
  // Ignoramos fragmentos .ts e aac (comuns em HLS) para não poluir
  if (item.url.includes('.ts') && tabMedia.size > 0) return;

  if (!tabMedia.has(item.url)) {
    tabMedia.set(item.url, item);
    updateTabIcon(tabId);
  }
}

// Limpar estado quando a aba é fechada ou atualizada
chrome.tabs.onRemoved.addListener((tabId) => {
  mediaState.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    // Apenas limpar se a URL mudou (navegação principal)
    if (changeInfo.url) {
      mediaState.delete(tabId);
      updateTabIcon(tabId);
    }
  }
});

// Listener de Interceptação de Rede
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // Ignorar requisições de background ou de tabs inexistentes (-1)
    if (details.tabId < 0) return;

    // Instagram: ignora fragmentos de CDN (scontent/fbcdn) — o download real é
    // feito via Motor Local (yt-dlp) a partir da URL canônica do reel/post/story.
    const reqUrl = (details.url || '').toLowerCase();
    const docUrl = (details.documentUrl || details.initiator || '').toLowerCase();
    if (docUrl.includes('instagram.com') && /cdninstagram\.com|\.fbcdn\.net/.test(reqUrl)) {
      return;
    }

    let mimeType = '';
    const contentTypeHeader = details.responseHeaders.find(h => h.name.toLowerCase() === 'content-type');
    if (contentTypeHeader) {
      mimeType = contentTypeHeader.value.toLowerCase().split(';')[0];
    }

    const url = details.url;
    const urlLower = url.toLowerCase();
    
    // Checar se é uma mídia baseada em MIME ou extensão
    let isMedia = MEDIA_PATTERNS.mimeTypes.includes(mimeType);
    let type = 'video';
    
    if (!isMedia) {
      for (const ext of MEDIA_PATTERNS.video) {
        if (urlLower.includes(ext)) { isMedia = true; type = 'video'; break; }
      }
      if (!isMedia) {
        for (const ext of MEDIA_PATTERNS.audio) {
          if (urlLower.includes(ext)) { isMedia = true; type = 'audio'; break; }
        }
      }
      if (!isMedia) {
        for (const ext of MEDIA_PATTERNS.stream) {
          if (urlLower.includes(ext)) { isMedia = true; type = 'stream'; break; }
        }
      }
    } else {
      if (mimeType.includes('audio')) type = 'audio';
      if (mimeType.includes('mpegurl') || mimeType.includes('dash')) type = 'stream';
    }

    if (isMedia) {
      // Tentar inferir extensão e tamanho
      let format = 'mp4'; // default
      if (mimeType) {
        format = mimeType.split('/')[1] || 'mp4';
      }
      
      let size = 0;
      const contentLengthHeader = details.responseHeaders.find(h => h.name.toLowerCase() === 'content-length');
      if (contentLengthHeader) {
        size = parseInt(contentLengthHeader.value, 10);
      }

      // Inferir um nome provisório (a ser melhorado via Messaging com o Content Script)
      const urlObj = new URL(url);
      const pathSegments = urlObj.pathname.split('/').filter(Boolean);
      let filename = pathSegments.length > 0 ? pathSegments.pop() : `media_${Date.now()}`;
      if (!filename.includes('.')) filename += `.${format}`;

      const mediaItem = {
        id: generateId(),
        url: url,
        pageUrl: details.initiator || '',
        filename: filename,
        type: type,
        format: format,
        size: size,
        mimeType: mimeType,
        timestamp: Date.now(),
        status: 'detected'
      };

      addMediaItem(details.tabId, mediaItem);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Menu de contexto
chrome.contextMenus.create({
  id: "download-media",
  title: "Baixar vídeo com Edge Video Downloader",
  contexts: ["video", "audio"]
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "download-media" && info.srcUrl) {
    startDownload(info.srcUrl, `media_${Date.now()}.mp4`, tab.id);
  }
});

async function getCookiesForDomain(url) {
  return new Promise((resolve) => {
    if (!chrome.cookies) return resolve([]);
    try {
      const domain = new URL(url).hostname;
      const baseDomain = domain.split('.').slice(-2).join('.');
      chrome.cookies.getAll({ url: url }, (cookies) => {
        if (cookies && cookies.length > 0) return resolve(cookies);
        chrome.cookies.getAll({ domain: baseDomain }, (cookies2) => {
          resolve(cookies2 || []);
        });
      });
    } catch (e) {
      resolve([]);
    }
  });
}

async function handleAnalyze({ url, referer }) {
  if (!backendStatus.online) {
    return { ok: false, reason: 'backend_offline' };
  }
  const cache = await Storage.getAnalysisCache();
  const entry = cache[url];
  if (Backend.isCacheValid(entry)) {
    return { ok: true, result: entry.result, cached: true };
  }
  const cookies = await getCookiesForDomain(url);
  // Timeout de 15 s (spec §7): análise demorada vira erro com "Tentar novamente".
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(Backend.apiUrl(backendStatus.port, "/api/analyze"), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, referer, cookies }),
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) {
      return { ok: false, reason: 'analyze_error', error: data.error || 'Falha na analise' };
    }
    cache[url] = { result: data, ts: Date.now() };
    for (const key of Object.keys(cache)) {
      if (!Backend.isCacheValid(cache[key])) delete cache[key];
    }
    await Storage.setAnalysisCache(cache);
    return { ok: true, result: data, cached: false };
  } catch (e) {
    return { ok: false, reason: 'backend_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function handleStartDownload({ item, filename, selector, formatUrl, audio }) {
  const url = formatUrl || (item && item.url);
  if (!url) return { ok: false, reason: 'no_url' };

  if (backendStatus.online) {
    const cookies = await getCookiesForDomain(url);
    try {
      const response = await fetch(Backend.apiUrl(backendStatus.port, "/api/download"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          referer: item.pageUrl,
          cookies,
          audio: !!audio,
          selector: selector || null,
          format_id: selector ? null : (formatUrl || null),
          filename,
          format_label: (item && item.format_label) || ''
        })
      });
      const data = await response.json();
      if (response.ok && data.task_id) {
        startAdvancedDownloadTracking({ taskId: data.task_id, url, filename });
        return { ok: true, kind: 'advanced', taskId: data.task_id };
      }
      return { ok: false, reason: 'backend_error', error: data.error || 'Erro no Motor Local' };
    } catch (e) {
      return { ok: false, reason: 'backend_unreachable' };
    }
  }

  if (Formats.isDirectFile(item)) {
    const ok = await startDownload(url, filename, item.tabId);
    return ok ? { ok: true, kind: 'native' } : { ok: false, reason: 'native_failed' };
  }
  return { ok: false, reason: 'backend_offline' };
}

// Listener central de Mensagens
Messaging.addListener((message, sender, sendResponse) => {
  if (message.type === MessageType.GET_MEDIA) {
    const tabId = message.payload.tabId;
    const itemsMap = mediaState.get(tabId);
    const items = itemsMap ? Array.from(itemsMap.values()) : [];
    sendResponse(items);
    return false;
  }
  
  if (message.type === MessageType.MEDIA_DETECTED) {
    // Mídia enviada pelo content script
    const tabId = sender.tab.id;
    const medias = message.payload.medias || [];
    medias.forEach(m => addMediaItem(tabId, m));
    sendResponse({ success: true });
    return false;
  }
  
  if (message.type === MessageType.START_DOWNLOAD) {
    handleStartDownload(message.payload || {}).then(sendResponse);
    return true; // async
  }

  if (message.type === MessageType.BACKEND_STATUS) {
    if (Date.now() - backendStatusCheckedAt > 10000) {
      refreshBackendStatus().then(() => sendResponse(backendStatus));
      return true; // async
    }
    sendResponse(backendStatus);
    return false;
  }

  if (message.type === MessageType.ANALYZE_MEDIA) {
    handleAnalyze(message.payload || {}).then(sendResponse);
    return true; // async
  }

  if (message.type === MessageType.GET_ACTIVE_DOWNLOADS) {
    getActiveMap().then(map => sendResponse(Array.from(map.values())));
    return true; // async
  }

  if (message.type === MessageType.ADVANCED_DOWNLOAD_STARTED) {
    startAdvancedDownloadTracking(message.payload || {});
    sendResponse({ success: true });
    return false;
  }
});

/**
 * Inicia o download e gerencia o histórico
 */
async function startDownload(url, filename, tabId) {
  try {
    const settings = await Storage.getSettings();
    // Sanitizar o nome do arquivo para remover caracteres inválidos
    let savePath = filename.replace(/[/?%*:|"<>]/g, '-');
    
    // Se usuário configurou pasta padrão
    if (settings.downloadFolder) {
      // Sanitizar barra final
      let folder = settings.downloadFolder.replace(/[/\\]$/, '');
      savePath = `${folder}/${savePath}`;
    }

    return new Promise((resolve) => {
      chrome.downloads.download({
        url: url,
        filename: savePath,
        saveAs: settings.autoDownloadQuality === 'ask'
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("Erro no download:", chrome.runtime.lastError.message);
          resolve(false);
          return;
        }
        
        // Adicionar ao histórico provisório
        Storage.addToHistory({
          id: generateId(),
          downloadId: downloadId,
          url: url,
          filename: savePath,
          timestamp: Date.now(),
          state: 'in_progress'
        });

        // Registrar como download ativo para acompanhar o progresso
        // mesmo depois de fechar a aba ou o popup.
        upsertActiveDownload({
          id: String(downloadId),
          kind: 'native',
          url: url,
          filename: savePath,
          timestamp: Date.now(),
          state: 'in_progress',
          progress: 0,
          bytesReceived: 0,
          totalBytes: 0
        });

        resolve(true);
      });
    });
  } catch (error) {
    console.error("Download falhou:", error);
    return false;
  }
}

// Monitorar progresso dos downloads para atualizar o histórico e o painel ativo
chrome.downloads.onChanged.addListener(async (delta) => {
  const key = String(delta.id);
  const map = await getActiveMap();
  const item = map.get(key);

  if (!item) {
    // Download não rastreado pelo fluxo atual; apenas atualiza o histórico.
    if (delta.state) await updateHistoryState(delta.id, delta.state.current);
    return;
  }

  let changed = false;

  if (delta.bytesReceived && typeof delta.bytesReceived.current === 'number') {
    item.bytesReceived = delta.bytesReceived.current;
    changed = true;
  }
  if (delta.totalBytes && typeof delta.totalBytes.current === 'number') {
    item.totalBytes = delta.totalBytes.current;
    changed = true;
  }

  if (item.totalBytes > 0) {
    item.progress = Math.min(100, Math.round((item.bytesReceived / item.totalBytes) * 100));
    changed = true;
  }

  if (delta.state) {
    item.state = delta.state.current;
    changed = true;

    if (delta.state.current === 'complete') {
      item.progress = 100;
      await removeActiveDownload(key);
      await updateHistoryState(delta.id, 'complete', 100);
      notifyIfEnabled('Download concluído', shortName(item.filename));
      return;
    } else if (delta.state.current === 'interrupted') {
      await removeActiveDownload(key);
      await updateHistoryState(delta.id, 'interrupted');
      notifyIfEnabled('Download interrompido', shortName(item.filename));
      return;
    }
  }

  if (changed) {
    await persistActiveDownloads();
    broadcastDownloadUpdate();
    updateActiveBadge();
  }
});
