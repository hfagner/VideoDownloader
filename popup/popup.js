// DOM Elements
const mediaList = document.getElementById('media-list');
const emptyState = document.getElementById('empty-state');
const template = document.getElementById('media-card-template');
const btnSidebar = document.getElementById('btn-sidebar');
const btnSettings = document.getElementById('btn-settings');
const historyToggle = document.getElementById('history-toggle');
const historyList = document.getElementById('history-list');
const btnOpenFolder = document.getElementById('btn-open-folder');
const btnClearHistory = document.getElementById('btn-clear-history');
const advancedSection = document.getElementById('advanced-download-section');
const btnAdvanced = document.getElementById('btn-advanced');
const advancedProgress = document.getElementById('advanced-progress');
const activeDownloadsSection = document.getElementById('active-downloads-section');
const activeDownloadsList = document.getElementById('active-downloads-list');

// State
let currentTabId = null;
let currentPageUrl = '';
let detectedItems = []; // cache dos itens detectados para o botão avançado

// Helper para pegar cookies
async function getCookiesForDomain(url) {
  return new Promise((resolve) => {
    if (!chrome.cookies) return resolve([]);
    try {
      const domain = new URL(url).hostname;
      // Domínio base (ex: .youtube.com, .instagram.com)
      const baseDomain = domain.split('.').slice(-2).join('.');
      // Prefere filtrar pela URL exata (mais preciso para o Instagram, onde o
      // cookie de sessão "sessionid" é definido com domínio .instagram.com e o
      // acesso aos reels/stories requer login). Cai para o domínio base se necessário.
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

// Initialize
async function init() {
  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId = tab.id;
    currentPageUrl = tab.url;
    loadMediaForTab(currentTabId);
    checkAdvancedSupport(tab.url);
  }

  loadHistory();
  loadActiveDownloads();
  setupEventListeners();
}

// Check if page supports advanced download
function checkAdvancedSupport(url) {
  if (url.includes('youtube.com/watch') || 
      url.includes('hotmart.com') || 
      url.includes('play.hotmart.com') ||
      url.includes('instagram.com')) {
    advancedSection.style.display = 'block';
  }
}

// Load Media Items
async function loadMediaForTab(tabId) {
  const items = await Messaging.sendToBackground(MessageType.GET_MEDIA, { tabId });
  detectedItems = items || [];
  renderMediaList(detectedItems);
}

// Render Media Cards
function renderMediaList(items) {
  mediaList.innerHTML = '';
  
  if (items.length === 0) {
    emptyState.style.display = 'block';
    mediaList.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  mediaList.style.display = 'flex';

  items.forEach(item => {
    const clone = template.content.cloneNode(true);
    
    const card = clone.querySelector('.media-card');
    const input = clone.querySelector('.media-filename');
    const btnDownload = clone.querySelector('.btn-download');
    const formatMeta = clone.querySelector('.format-meta');
    const sizeMeta = clone.querySelector('.size-meta');
    const btnMore = clone.querySelector('.btn-more');
    const moreMenu = clone.querySelector('.more-menu');
    const formatSelect = clone.querySelector('.format-select');

    input.value = item.filename;
    formatMeta.textContent = item.format.toUpperCase();
    
    if (item.size > 0) {
      sizeMeta.textContent = formatBytes(item.size);
    } else {
      sizeMeta.textContent = 'Tamanho desconhecido';
    }

    if (item.isBlob) {
      sizeMeta.textContent += ' (Blob limit)';
    }

    // Show embed badge
    if (item.isEmbed) {
      const badge = document.createElement('span');
      const labels = { youtube: 'YouTube', vimeo: 'Vimeo', panda: 'Panda Video', hotmart: 'Hotmart', instagram: 'Instagram' };
      const isHotmart = item.embedPlatform === 'hotmart';
      const isInstagram = item.embedPlatform === 'instagram';
      const badgeBg = isHotmart ? '#F7A800' : (isInstagram ? '#E1306C' : '#0078D4');
      const badgeColor = isHotmart ? '#000' : '#fff';
      badge.style.cssText = `font-size:10px; background:${badgeBg}; color:${badgeColor}; padding:2px 6px; border-radius:4px; margin-left:6px;`;
      badge.textContent = isHotmart ? '▶ Play primeiro' : (labels[item.embedPlatform] || 'Embed');
      formatMeta.parentElement.appendChild(badge);
    }

    // Actions
    btnDownload.addEventListener('click', async () => {
      // Hotmart iframe embed — nao tem stream disponivel ainda, precisa dar play
      if (item.embedPlatform === 'hotmart') {
        advancedProgress.style.display = 'block';
        advancedProgress.textContent = 'Pressione Play no video primeiro. Depois clique em "Baixar via Motor Local".';
        advancedProgress.style.color = '#F7A800';
        advancedSection.style.display = 'block';
        return;
      }

      // Streams e blobs — via Motor Local
      if (item.isEmbed || item.type === 'stream' || item.isBlob || item.url.includes('.m3u8')) {
        btnDownload.textContent = 'Enviando...';
        btnDownload.disabled = true;
        
        try {
          const formatType = formatSelect.value || 'video';
          const cookies = await getCookiesForDomain(item.url);
          const response = await fetch('http://localhost:5000/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: item.url, referer: item.pageUrl, cookies: cookies, format_type: formatType })
          });
          const data = await response.json();
          if (response.ok && data.task_id) {
            btnDownload.textContent = 'No Motor Local!';
            btnDownload.style.backgroundColor = '#28a745';
            advancedSection.style.display = 'block';
            // Registra no background para que o progresso continue visível
            // mesmo após fechar a aba ou o popup.
            Messaging.sendToBackground(MessageType.ADVANCED_DOWNLOAD_STARTED, {
              taskId: data.task_id,
              url: item.url,
              filename: input.value
            });
            pollAdvancedStatus(data.task_id);
          } else {
            alert('Erro no Motor Local: ' + (data.error || 'Erro desconhecido'));
            btnDownload.textContent = '❌ Erro';
            btnDownload.disabled = false;
          }
        } catch(err) {
          alert('Servidor local nao esta respondendo. O server.py esta rodando? (' + err.message + ')');
          btnDownload.textContent = '⬇ Download';
          btnDownload.disabled = false;
        }
        return;
      }
      
      btnDownload.textContent = '⏳ Baixando...';
      btnDownload.disabled = true;
      const success = await Messaging.sendToBackground(MessageType.START_DOWNLOAD, {
        url: item.url,
        filename: input.value,
        tabId: currentTabId
      });
      
      if (success) {
        btnDownload.textContent = '✅ Iniciado';
        setTimeout(() => {
          btnDownload.textContent = '⬇ Download';
          btnDownload.disabled = false;
        }, 2000);
      } else {
        btnDownload.textContent = '❌ Erro';
        setTimeout(() => {
          btnDownload.textContent = '⬇ Download';
          btnDownload.disabled = false;
        }, 2000);
        alert("Ocorreu um erro. A URL pode estar bloqueada por CORS, ser invalida para download direto, ou o nome do arquivo contem caracteres invalidos.");
      }
    });

    // More Options Menu Toggle
    btnMore.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = moreMenu.style.display === 'flex';
      document.querySelectorAll('.more-menu').forEach(m => m.style.display = 'none');
      if (!isVisible) moreMenu.style.display = 'flex';
    });

    // Sub-actions in menu
    clone.querySelector('.btn-copy-url').addEventListener('click', () => {
      navigator.clipboard.writeText(item.url);
      moreMenu.style.display = 'none';
    });

    clone.querySelector('.btn-copy-page').addEventListener('click', () => {
      navigator.clipboard.writeText(item.pageUrl);
      moreMenu.style.display = 'none';
    });

    clone.querySelector('.btn-blacklist').addEventListener('click', async () => {
      const urlObj = new URL(item.pageUrl);
      await Storage.addToBlacklist(urlObj.hostname);
      moreMenu.style.display = 'none';
      alert(`Domínio ${urlObj.hostname} adicionado à blacklist.`);
    });

    mediaList.appendChild(clone);
  });
}

// History
async function loadHistory() {
  const history = await Storage.getHistory();
  historyList.innerHTML = '';
  
  if (history.length === 0) {
    historyList.innerHTML = '<div style="padding: 8px; text-align: center; color: var(--text-secondary); font-size: 11px;">Sem downloads recentes</div>';
    return;
  }

  history.slice(0, 5).forEach(item => { // Show max 5 in popup initially
    const el = document.createElement('div');
    el.className = `history-item ${item.state === 'complete' ? 'success' : ''}`;
    
    const timeStr = new Date(item.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    const shortName = item.filename.split('/').pop();
    
    el.innerHTML = `
      <span class="filename" title="${item.filename}">${shortName}</span>
      <span class="time">${item.state === 'complete' ? '✅' : '⏳'} ${timeStr}</span>
    `;
    historyList.appendChild(el);
  });
}

// Active downloads (persistentes, independentes da aba)
async function loadActiveDownloads() {
  const active = await Messaging.sendToBackground(MessageType.GET_ACTIVE_DOWNLOADS);
  renderActiveDownloads(active || []);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
    activeDownloadsSection.style.display = 'none';
    return;
  }

  activeDownloadsSection.style.display = 'block';

  items.forEach(item => {
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
      <div class="active-state">${activeStateLabel(item)}</div>
    `;
    activeDownloadsList.appendChild(el);
  });
}

// Format bytes helper
function formatBytes(bytes, decimals = 1) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// Event Listeners Setup
function setupEventListeners() {
  // Close any open menus when clicking outside
  document.addEventListener('click', () => {
    document.querySelectorAll('.more-menu').forEach(m => m.style.display = 'none');
  });

  // Sidebar toggle
  btnSidebar.addEventListener('click', () => {
    chrome.sidePanel.setOptions({
      tabId: currentTabId,
      path: 'popup/popup.html',
      enabled: true
    });
    chrome.sidePanel.open({ tabId: currentTabId });
    window.close();
  });

  // Settings
  btnSettings.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // History toggle
  historyToggle.addEventListener('click', () => {
    historyList.classList.toggle('collapsed');
    const chevron = historyToggle.querySelector('.chevron');
    chevron.textContent = historyList.classList.contains('collapsed') ? '▾' : '▴';
  });

  btnAdvanced.addEventListener('click', async () => {
    // Prioridade de URL para enviar ao motor:
    // 1. URL .m3u8 interceptada diretamente da rede (melhor caso)
    // 2. URL do iframe embed do Hotmart (cf-embed.play.hotmart.com) — yt-dlp suporta
    // 3. URL da página atual (fallback para YouTube)
    let downloadUrl = null;
    let refererUrl = currentPageUrl;

    // Prioridade 1: m3u8 da Hotmart interceptado pelo webRequest
    const m3u8Item = detectedItems.find(i =>
      i.url && (i.url.includes('.m3u8') || i.url.includes('vod-akm.play.hotmart.com'))
    );
    if (m3u8Item) {
      downloadUrl = m3u8Item.url;
      refererUrl = m3u8Item.pageUrl || currentPageUrl;
    }

    // Prioridade 2: Iframe embed do Hotmart player
    if (!downloadUrl) {
      const hotmartEmbed = detectedItems.find(i => i.embedPlatform === 'hotmart');
      if (hotmartEmbed) {
        downloadUrl = hotmartEmbed.url;
        refererUrl = hotmartEmbed.pageUrl || currentPageUrl;
      }
    }

    // Prioridade 3: YouTube embed
    if (!downloadUrl) {
      const ytEmbed = detectedItems.find(i => i.embedPlatform === 'youtube');
      if (ytEmbed) {
        downloadUrl = ytEmbed.url;
      }
    }

    // Prioridade 4: Instagram (reel / post / story)
    if (!downloadUrl) {
      const igItem = detectedItems.find(i => i.embedPlatform === 'instagram');
      if (igItem) {
        downloadUrl = igItem.url;
      }
    }

    // Fallback: URL da página (YouTube watch / Instagram)
    if (!downloadUrl) {
      if (currentPageUrl.includes('youtube.com/watch')) {
        downloadUrl = currentPageUrl;
      } else if (currentPageUrl.includes('instagram.com')) {
        downloadUrl = currentPageUrl;
      } else {
        advancedProgress.textContent = 'Nenhum video detectado. Pressione Play no video primeiro!';
        advancedProgress.style.color = '#D13438';
        return;
      }
    }

    btnAdvanced.disabled = true;
    btnAdvanced.textContent = 'Enviando ao servidor...';
    advancedProgress.textContent = '';
    advancedProgress.style.color = '';

    const formatType = document.getElementById('advanced-format').value || 'video';

    try {
      const cookies = await getCookiesForDomain(downloadUrl);
      const response = await fetch('http://localhost:5000/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: downloadUrl, referer: refererUrl, cookies: cookies, format_type: formatType })
      });

      const data = await response.json();

      if (response.ok && data.task_id) {
        btnAdvanced.textContent = 'Download Iniciado!';
        // Registra no background para que o progresso continue visível
        // mesmo após fechar a aba ou o popup.
        Messaging.sendToBackground(MessageType.ADVANCED_DOWNLOAD_STARTED, {
          taskId: data.task_id,
          url: downloadUrl,
          filename: ((downloadUrl.split('/').pop() || 'video').split('?')[0]) || ('video_' + Date.now() + '.mp4')
        });
        pollAdvancedStatus(data.task_id);
      } else {
        btnAdvanced.textContent = 'Erro';
        advancedProgress.textContent = data.error || 'Erro desconhecido';
        advancedProgress.style.color = '#D13438';
        btnAdvanced.disabled = false;
      }
    } catch (err) {
      btnAdvanced.textContent = 'Erro de Conexao';
      advancedProgress.textContent = `Erro: ${err.message}. O server.py esta rodando?`;
      advancedProgress.style.color = '#D13438';
      btnAdvanced.disabled = false;
    }
  });

  // Footer Actions
  btnOpenFolder.addEventListener('click', () => {
    chrome.downloads.showDefaultFolder();
  });

  btnClearHistory.addEventListener('click', async () => {
    await Storage.clearHistory();
    loadHistory();
  });

  // Listen for real-time updates from background
  Messaging.addListener((message) => {
    if (message.type === MessageType.DOWNLOAD_UPDATE) {
      loadHistory(); // Reload history on changes
      loadActiveDownloads(); // Atualiza a lista de downloads em andamento
    }
  });
}

// Start
document.addEventListener('DOMContentLoaded', init);

function pollAdvancedStatus(taskId) {
  const interval = setInterval(async () => {
    try {
      const response = await fetch(`http://localhost:5000/api/status/${taskId}`);
      const data = await response.json();
      
      if (data.status === 'downloading') {
        advancedProgress.textContent = `Baixando: ${data.progress}`;
      } else if (data.status === 'merging') {
        advancedProgress.textContent = 'Juntando áudio e vídeo (Aguarde)...';
      } else if (data.status === 'completed') {
        advancedProgress.textContent = 'Download Finalizado com Sucesso!';
        advancedProgress.style.color = 'var(--success)';
        clearInterval(interval);
        setTimeout(() => {
          btnAdvanced.textContent = 'Baixar via Motor Local';
          btnAdvanced.disabled = false;
        }, 5000);
      } else if (data.status === 'error') {
        advancedProgress.textContent = `Erro: ${data.error}`;
        advancedProgress.style.color = '#D13438';
        clearInterval(interval);
        btnAdvanced.textContent = 'Tentar Novamente';
        btnAdvanced.disabled = false;
      }
    } catch (e) {
      clearInterval(interval);
      advancedProgress.textContent = 'Erro ao verificar progresso.';
    }
  }, 1500);
}
