// DOM Elements
const txtDownloadFolder = document.getElementById('downloadFolder');
const selAutoDownloadQuality = document.getElementById('autoDownloadQuality');
const chkShowNotifications = document.getElementById('showNotifications');
const txtNewDomain = document.getElementById('newDomain');
const btnAddDomain = document.getElementById('btnAddDomain');
const blacklistList = document.getElementById('blacklist-list');
const btnSave = document.getElementById('btn-save');
const saveStatus = document.getElementById('save-status');

let currentBlacklist = [];

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupEventListeners();
});

async function loadSettings() {
  const settings = await Storage.getSettings();
  txtDownloadFolder.value = settings.downloadFolder || '';
  selAutoDownloadQuality.value = settings.autoDownloadQuality || 'ask';
  chkShowNotifications.checked = settings.showNotifications !== false;
  
  currentBlacklist = await Storage.getBlacklist();
  renderBlacklist();
}

function renderBlacklist() {
  blacklistList.innerHTML = '';
  if (currentBlacklist.length === 0) {
    blacklistList.innerHTML = '<li class="blacklist-item" style="color: var(--text-secondary); justify-content: center;">Nenhum domínio bloqueado</li>';
    return;
  }

  currentBlacklist.forEach(domain => {
    const li = document.createElement('li');
    li.className = 'blacklist-item';
    li.innerHTML = `
      <span>${domain}</span>
      <button class="btn-remove" data-domain="${domain}">Remover</button>
    `;
    blacklistList.appendChild(li);
  });

  // Attach remove events
  document.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const domain = e.target.getAttribute('data-domain');
      currentBlacklist = currentBlacklist.filter(d => d !== domain);
      renderBlacklist();
    });
  });
}

function setupEventListeners() {
  btnAddDomain.addEventListener('click', () => {
    const domain = txtNewDomain.value.trim().toLowerCase();
    if (domain && !currentBlacklist.includes(domain)) {
      currentBlacklist.push(domain);
      txtNewDomain.value = '';
      renderBlacklist();
    }
  });

  txtNewDomain.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      btnAddDomain.click();
    }
  });

  btnSave.addEventListener('click', async () => {
    const newSettings = {
      downloadFolder: txtDownloadFolder.value.trim(),
      autoDownloadQuality: selAutoDownloadQuality.value,
      showNotifications: chkShowNotifications.checked
    };

    await Storage.updateSettings(newSettings);
    await Storage.set('blacklist', currentBlacklist);

    saveStatus.textContent = 'Configurações salvas!';
    saveStatus.classList.add('show');
    
    setTimeout(() => {
      saveStatus.classList.remove('show');
    }, 3000);
  });
}
