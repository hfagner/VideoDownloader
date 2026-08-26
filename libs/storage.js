// Wrapper para chrome.storage.local

const Storage = {
  /**
   * Obtém um valor do storage
   * @param {string} key 
   * @param {any} defaultValue 
   * @returns {Promise<any>}
   */
  async get(key, defaultValue = null) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] !== undefined ? result[key] : defaultValue);
      });
    });
  },

  /**
   * Define um valor no storage
   * @param {string} key 
   * @param {any} value 
   * @returns {Promise<void>}
   */
  async set(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => {
        resolve();
      });
    });
  },

  /**
   * Remove um valor do storage
   * @param {string} key 
   * @returns {Promise<void>}
   */
  async remove(key) {
    return new Promise((resolve) => {
      chrome.storage.local.remove([key], () => {
        resolve();
      });
    });
  },

  /**
   * Obtém o histórico de downloads
   * @returns {Promise<Array>}
   */
  async getHistory() {
    return this.get('downloadHistory', []);
  },

  /**
   * Adiciona um item ao histórico (com limite de 100 itens)
   * @param {Object} item 
   * @returns {Promise<void>}
   */
  async addToHistory(item) {
    const MAX_HISTORY = 100;
    const history = await this.getHistory();
    history.unshift({
      ...item,
      timestamp: Date.now()
    });
    
    // Limita o histórico
    if (history.length > MAX_HISTORY) {
      history.length = MAX_HISTORY;
    }
    
    await this.set('downloadHistory', history);
  },

  /**
   * Limpa o histórico de downloads
   * @returns {Promise<void>}
   */
  async clearHistory() {
    await this.set('downloadHistory', []);
  },

  /**
   * Obtém a lista de downloads em andamento
   * @returns {Promise<Array>}
   */
  async getActiveDownloads() {
    return this.get('activeDownloads', []);
  },

  /**
   * Define a lista de downloads em andamento
   * @param {Array} items
   * @returns {Promise<void>}
   */
  async setActiveDownloads(items) {
    await this.set('activeDownloads', items);
  },

  /**
   * Obtém as configurações (fazendo merge com as defaults)
   * @returns {Promise<Object>}
   */
  async getSettings() {
    const defaults = {
      downloadFolder: '',
      nameFormat: '{title}_{resolution}',
      showNotifications: true,
      displayMode: 'popup',
      autoDownloadQuality: 'ask'
    };
    const settings = await this.get('settings', {});
    return { ...defaults, ...settings };
  },

  /**
   * Atualiza as configurações
   * @param {Object} newSettings 
   * @returns {Promise<void>}
   */
  async updateSettings(newSettings) {
    const current = await this.getSettings();
    await this.set('settings', { ...current, ...newSettings });
  },

  /**
   * Obtém a blacklist de domínios
   * @returns {Promise<Array>}
   */
  async getBlacklist() {
    return this.get('blacklist', []);
  },

  /**
   * Adiciona um domínio à blacklist
   * @param {string} domain 
   * @returns {Promise<void>}
   */
  async addToBlacklist(domain) {
    const blacklist = await this.getBlacklist();
    if (!blacklist.includes(domain)) {
      blacklist.push(domain);
      await this.set('blacklist', blacklist);
    }
  }
};

// Exportar para suportar tanto ES Modules quanto script src direto
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Storage;
} else if (typeof window !== 'undefined') {
  window.StorageAPI = Storage;
}
