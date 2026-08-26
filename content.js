/**
 * Content Script
 * Injetado em todas as páginas para detectar elementos <video> e <audio>
 * e informar o background script.
 */

// Evita execução múltipla
if (!window._evd_injected) {
  window._evd_injected = true;

  // Função para limpar e checar URL
  function isValidMediaUrl(url) {
    if (!url) return false;
    // Ignorar urls do tipo blob por enquanto (podemos avisar sobre DRM/limitado depois)
    if (url.startsWith('blob:')) return true;
    if (url.startsWith('data:')) return false;
    return url.startsWith('http');
  }

  // Gera id local
  function generateId() {
    return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  }

  // Título da página para fallback de nome da mídia
  function getPageTitles() {
    const ogMeta = document.querySelector('meta[property="og:title"]');
    return {
      ogTitle: ogMeta ? ogMeta.getAttribute('content') || '' : '',
      pageTitle: document.title || ''
    };
  }

  // Extrai informações do elemento HTMLMediaElement
  function extractMediaInfo(el, type) {
    let src = el.src || el.currentSrc;
    let format = 'mp4';
    
    // Buscar em <source> tags se não tiver src no pai
    if (!src) {
      const sources = el.querySelectorAll('source');
      for (const source of sources) {
        if (isValidMediaUrl(source.src)) {
          src = source.src;
          if (source.type) {
            format = source.type.split('/')[1] || format;
          }
          break;
        }
      }
    }

    // Tentar pegar de atributos data-* comuns em players customizados
    if (!src) {
      const dataset = el.dataset;
      for (const key in dataset) {
        const val = dataset[key];
        if (typeof val === 'string' && isValidMediaUrl(val)) {
          if (val.includes('.mp4') || val.includes('.webm') || val.includes('.m3u8')) {
            src = val;
            break;
          }
        }
      }
    }

    if (isValidMediaUrl(src)) {
      const urlObj = new URL(src, window.location.href);
      let filename = urlObj.pathname.split('/').pop() || `media_${Date.now()}`;
      if (!filename.includes('.')) filename += `.${format}`;

      return {
        id: generateId(),
        url: urlObj.href,
        pageUrl: window.location.href,
        pageTitle: document.title,
        ogTitle: getPageTitles().ogTitle,
        filename: filename,
        type: type,
        format: format,
        size: 0,
        mimeType: '',
        timestamp: Date.now(),
        status: 'detected',
        isBlob: src.startsWith('blob:')
      };
    }
    return null;
  }

  // Envia a lista de mídias detectadas para o background
  function sendMediaToBackground(medias) {
    if (!medias || medias.length === 0) return;
    chrome.runtime.sendMessage({
      type: 'MEDIA_DETECTED',
      payload: { medias }
    }, (response) => {
      if (chrome.runtime.lastError) {
        // Ignorar erro se o service worker estiver inativo momentaneamente
      }
    });
  }

  // Detecção de conteúdo do Instagram (reels, posts, stories, destaques)
  function getInstagramPageType() {
    const host = window.location.hostname;
    if (!host || host.indexOf('instagram.com') === -1) return null;
    const path = window.location.pathname;
    let m;
    m = path.match(/^\/reel\/([A-Za-z0-9_-]+)/);
    if (m) return { kind: 'reel', url: 'https://www.instagram.com/reel/' + m[1] + '/', filename: 'instagram_reel_' + m[1] + '.mp4' };
    m = path.match(/^\/p\/([A-Za-z0-9_-]+)/);
    if (m) return { kind: 'post', url: 'https://www.instagram.com/p/' + m[1] + '/', filename: 'instagram_post_' + m[1] + '.mp4' };
    m = path.match(/^\/stories\/highlights\/([A-Za-z0-9]+)/);
    if (m) return { kind: 'story_highlight', url: 'https://www.instagram.com/stories/highlights/' + m[1] + '/', filename: 'instagram_highlight_' + m[1] + '.mp4' };
    m = path.match(/^\/stories\/([A-Za-z0-9_.]+)\/([A-Za-z0-9]+)/);
    if (m) return { kind: 'story', url: 'https://www.instagram.com/stories/' + m[1] + '/' + m[2] + '/', filename: 'instagram_story_' + m[1] + '_' + m[2] + '.mp4' };
    return null;
  }

  function buildInstagramMediaItem(typeInfo) {
    return {
      id: generateId(),
      url: typeInfo.url,
      pageUrl: window.location.href,
      pageTitle: document.title,
      ogTitle: getPageTitles().ogTitle,
      filename: typeInfo.filename,
      type: 'video',
      format: 'mp4',
      size: 0,
      mimeType: 'video/mp4',
      timestamp: Date.now(),
      status: 'detected',
      isEmbed: true,
      embedPlatform: 'instagram',
      instagramKind: typeInfo.kind
    };
  }

  function scanInstagram() {
    const typeInfo = getInstagramPageType();
    if (!typeInfo) return;
    sendMediaToBackground([buildInstagramMediaItem(typeInfo)]);
  }

  // Função para escanear DOM
  function scanDOM() {
    const medias = [];

    // Instagram: prefere a URL canônica (reel/post/story) para download via Motor Local
    const igType = getInstagramPageType();
    if (igType) {
      medias.push(buildInstagramMediaItem(igType));
      sendMediaToBackground(medias);
      return;
    }

    const videos = document.querySelectorAll('video');
    const audios = document.querySelectorAll('audio');

    videos.forEach(v => {
      const info = extractMediaInfo(v, 'video');
      if (info) medias.push(info);
    });

    audios.forEach(a => {
      const info = extractMediaInfo(a, 'audio');
      if (info) medias.push(info);
    });

    if (medias.length > 0) {
      // Enviar pro background
      sendMediaToBackground(medias);
    }
  }

  // Escaneia iframes em busca de players conhecidos (YouTube, Vimeo, Panda Video)
  function scanIframes() {
    const iframes = document.querySelectorAll('iframe');
    const medias = [];

    iframes.forEach(iframe => {
      const src = iframe.src || iframe.getAttribute('data-src') || '';
      if (!src) return;

      // YouTube embed
      const ytMatch = src.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
      if (ytMatch) {
        const videoId = ytMatch[1];
        const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
        medias.push({
          id: generateId(),
          url: youtubeUrl,
          pageUrl: window.location.href,
          pageTitle: document.title,
          ogTitle: getPageTitles().ogTitle,
          filename: `youtube_${videoId}.mp4`,
          type: 'youtube',
          format: 'mp4',
          size: 0,
          mimeType: 'video/mp4',
          timestamp: Date.now(),
          status: 'detected',
          isEmbed: true,
          embedPlatform: 'youtube'
        });
      }

      // Vimeo embed
      const vimeoMatch = src.match(/vimeo\.com\/(?:video\/)?(\d+)/);
      if (vimeoMatch) {
        const vimeoId = vimeoMatch[1];
        const vimeoUrl = `https://vimeo.com/${vimeoId}`;
        medias.push({
          id: generateId(),
          url: vimeoUrl,
          pageUrl: window.location.href,
          pageTitle: document.title,
          ogTitle: getPageTitles().ogTitle,
          filename: `vimeo_${vimeoId}.mp4`,
          type: 'vimeo',
          format: 'mp4',
          size: 0,
          mimeType: 'video/mp4',
          timestamp: Date.now(),
          status: 'detected',
          isEmbed: true,
          embedPlatform: 'vimeo'
        });
      }

      // Panda Video embed
      const pandaMatch = src.match(/player\.pandavideo\.com\.br\/embed\/\?v=([a-zA-Z0-9_-]+)/);
      if (pandaMatch) {
        medias.push({
          id: generateId(),
          url: src,
          pageUrl: window.location.href,
          pageTitle: document.title,
          ogTitle: getPageTitles().ogTitle,
          filename: `pandavideo_${pandaMatch[1]}.mp4`,
          type: 'panda',
          format: 'mp4',
          size: 0,
          mimeType: 'video/mp4',
          timestamp: Date.now(),
          status: 'detected',
          isEmbed: true,
          embedPlatform: 'panda'
        });
      }

      // Hotmart Player embed (cf-embed.play.hotmart.com)
      const hotmartMatch = src.match(/cf-embed\.play\.hotmart\.com\/embed\/([a-zA-Z0-9_-]+)/);
      if (hotmartMatch) {
        const mediaCode = hotmartMatch[1];
        medias.push({
          id: generateId(),
          url: src,
          pageUrl: window.location.href,
          pageTitle: document.title,
          ogTitle: getPageTitles().ogTitle,
          filename: `hotmart_${mediaCode}.mp4`,
          type: 'hotmart',
          format: 'mp4',
          size: 0,
          mimeType: 'video/mp4',
          timestamp: Date.now(),
          status: 'detected',
          isEmbed: true,
          embedPlatform: 'hotmart',
          mediaCode: mediaCode
        });
      }
    });

    if (medias.length > 0) {
      chrome.runtime.sendMessage({
        type: 'MEDIA_DETECTED',
        payload: { medias }
      }, () => { if (chrome.runtime.lastError) {} });
    }
  }

  // Scanner inicial
  scanDOM();
  scanInstagram();
  scanIframes();

  // MutationObserver para capturar mídias carregadas via SPA / AJAX
  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeName === 'VIDEO' || node.nodeName === 'AUDIO' || node.nodeName === 'IFRAME') {
            shouldScan = true;
          } else if (node.querySelectorAll) {
            if (node.querySelectorAll('video, audio, iframe').length > 0) {
              shouldScan = true;
            }
          }
        }
      }
      if (shouldScan) break;
    }

    if (shouldScan) {
      scanDOM();
      scanIframes();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Detecta navegação SPA do Instagram (pushState/replaceState/popstate)
  const origPushState = history.pushState;
  history.pushState = function () {
    const result = origPushState.apply(this, arguments);
    setTimeout(scanInstagram, 60);
    return result;
  };
  const origReplaceState = history.replaceState;
  history.replaceState = function () {
    const result = origReplaceState.apply(this, arguments);
    setTimeout(scanInstagram, 60);
    return result;
  };
  window.addEventListener('popstate', function () {
    setTimeout(scanInstagram, 60);
  });
}
