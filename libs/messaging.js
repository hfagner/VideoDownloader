// Protocolo de mensagens entre componentes

const MessageType = {
  GET_MEDIA: 'GET_MEDIA',               // popup -> background: Pede lista de mídias da aba
  MEDIA_DETECTED: 'MEDIA_DETECTED',     // content/background -> popup: Nova mídia encontrada
  START_DOWNLOAD: 'START_DOWNLOAD',     // popup -> background: Iniciar download
  DOWNLOAD_UPDATE: 'DOWNLOAD_UPDATE',   // background -> popup: Atualização de progresso do download
  TAB_UPDATED: 'TAB_UPDATED',           // background -> popup: Aba mudou/recarregou
  CLEAR_HISTORY: 'CLEAR_HISTORY',       // popup -> background: Limpar histórico (opcional, pode ser direto no popup)
  ADVANCED_DOWNLOAD_STARTED: 'ADVANCED_DOWNLOAD_STARTED', // popup -> background: registrar download do Motor Local
  GET_ACTIVE_DOWNLOADS: 'GET_ACTIVE_DOWNLOADS',           // popup -> background: listar downloads em andamento
};

const Messaging = {
  /**
   * Envia uma mensagem para o background script e aguarda resposta
   * @param {string} type Tipo da mensagem (MessageType)
   * @param {any} payload Dados opcionais
   * @returns {Promise<any>}
   */
  async sendToBackground(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('Erro ao enviar mensagem:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(response);
        }
      });
    });
  },

  /**
   * Envia uma mensagem para o content script de uma aba específica
   * @param {number} tabId ID da aba
   * @param {string} type Tipo da mensagem (MessageType)
   * @param {any} payload Dados opcionais
   * @returns {Promise<any>}
   */
  async sendToContent(tabId, type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('Erro ao enviar para content script:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(response);
        }
      });
    });
  },

  /**
   * Listener centralizado para mensagens
   * @param {Function} handler Função (message, sender, sendResponse) -> boolean | Promise
   */
  addListener(handler) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const result = handler(message, sender, sendResponse);
      // Se retornar true, indica que a resposta será enviada de forma assíncrona
      return result;
    });
  }
};

// Exportar para suportar tanto ES Modules quanto script src direto
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MessageType, Messaging };
} else if (typeof window !== 'undefined') {
  window.MessageType = MessageType;
  window.Messaging = Messaging;
}
