# Product Requirements Document (PRD)
## Produto: Edge Video Downloader Extension
**Data:** 24 de Agosto de 2026
**Status:** Rascunho / Para Desenvolvimento (Google Antigravity)
**Plataforma Alvo:** Microsoft Edge (Chromium - Manifest V3)

---

## 1. Visão Geral do Produto
O "Edge Video Downloader" é uma extensão de navegador para o Microsoft Edge, inspirada na funcionalidade do "Video DownloadHelper". O objetivo do plugin é detectar automaticamente mídias (vídeos e áudios) incorporadas nas abas ativas do navegador e oferecer aos usuários uma interface simples e rápida para baixar, renomear e converter esses arquivos diretamente para seus dispositivos locais.

## 2. Objetivos e Público-Alvo
*   **Objetivo Principal:** Permitir a extração e o download eficiente de mídias de páginas web com apenas 1 a 2 cliques.
*   **Objetivos Secundários:** Oferecer suporte a múltiplos formatos, opções de renomeação em tempo real e um histórico de gerenciamento de downloads integrado.
*   **Público-Alvo:** Criadores de conteúdo, educadores, pesquisadores, estudantes e usuários em geral que precisam de acesso offline a conteúdos de mídia.

---

## 3. Histórias de Usuário (User Stories)
*   Como usuário, quero que o ícone da extensão mude de cor quando um vídeo for detectado na página que estou visitando, para que eu saiba que o download é possível.
*   Como usuário, quero clicar no ícone e ver uma lista de todos os vídeos disponíveis na página, com informações de resolução e formato.
*   Como usuário, quero clicar em um botão "Download" para iniciar a transferência imediatamente usando o gerenciador de downloads do Edge.
*   Como usuário, quero ter a opção de alterar o nome do arquivo antes do download, para facilitar a organização.
*   Como usuário, quero poder selecionar formatos alternativos da mesma mídia, se estiverem disponíveis na página.
*   Como usuário, quero acessar um menu de ações alternativas (copiar URL, enviar para outro dispositivo/cast) com facilidade.
*   Como usuário, quero ver meu histórico recente de downloads e poder abrir a pasta de destino rapidamente através do painel.

---

## 4. Requisitos Funcionais

### F1. Detecção de Mídia e Estado do Ícone
*   **Monitoramento de Tráfego:** A extensão deve escutar as requisições de rede (rede passiva) na aba atual para identificar arquivos de mídia (MP4, WebM, HLS/M3U8, MP3, etc.).
*   **Feedback Visual:** O ícone da extensão (`action` no Manifest V3) deve estar inativo (cinza) quando não houver mídia. Quando detectada, o ícone deve ser colorido (ativado).

### F2. Painel Principal (Popup / Sidebar)
*   **Listagem de Mídia:** Ao clicar na extensão, um *popup* deve abrir exibindo todas as resoluções e arquivos interceptados.
*   **Agrupamento:** Múltiplos fragmentos do mesmo vídeo (ex: fluxos HLS) devem ser consolidados para o usuário como um único vídeo.

### F3. Funcionalidade de Download Básico
*   Botão primário para iniciar o download usando a API nativa `chrome.downloads.download()`.

### F4. Opções Pré-Download (Edição e Formato)
*   **Renomeação:** Ícone de "lápis" ao lado do arquivo permitindo a edição do campo *filename*.
*   **Seletor de Formato:** Menu *dropdown* mostrando as variantes do vídeo (ex: 720p, 1080p, MP4, WebM) se os metadados estiverem disponíveis.

### F5. Ações Alternativas (Menu de 3 pontos)
*   Copiar URL original da mídia.
*   Copiar URL da página referenciadora.
*   Adicionar a uma lista de bloqueio (Blacklist de domínios).

### F6. Rodapé do Painel (Gestão e Utilitários)
*   **Ícone de Engrenagem:** Acesso à página de Configurações completas da extensão.
*   **"Sem vídeo?":** Link para documentação de troubleshooting se a detecção falhar.
*   **Histórico de Downloads:** Um *toggle* ou área expansível listando os últimos downloads feitos pela extensão.
*   **Abrir Pasta:** Botão para abrir o diretório padrão de downloads do sistema operacional.
*   **Limpar Concluídos:** Botão para limpar a interface visual dos downloads finalizados.
*   **Alternador de Visualização:** Opção para trocar entre "Popup flutuante" e "Sidebar do Edge" (usando a API `chrome.sidePanel` do Manifest V3).

---

## 5. Requisitos Não-Funcionais e Arquitetura Técnica

### 5.1. Arquitetura (Edge / Manifest V3)
*   **Manifest V3:** A extensão deve ser estritamente desenvolvida no formato Manifest V3, garantindo conformidade com a loja de complementos da Microsoft.
*   **Service Workers:** O processamento em background (gerenciamento e interceptação de regras) deve usar *Background Service Workers*, sem persistência contínua (event-driven).
*   **APIs Principais Necessárias:**
    *   `chrome.downloads` (Gerenciamento do ciclo de vida dos arquivos)
    *   `chrome.scripting` (Para injetar scripts na página que extraem URLs complexas)
    *   `chrome.action` (Para mudanças dinâmicas no ícone)
    *   `chrome.declarativeNetRequest` ou `chrome.webRequest` (Para interceptar URLs de vídeo nas requisições do browser)
    *   `chrome.sidePanel` (Para o recurso de exibir como painel lateral).
    *   `chrome.storage.local` (Para salvar configurações e histórico).

### 5.2. UI / UX
*   **Design System:** Utilizar componentes limpos inspirados no Fluent Design System do Edge, garantindo sensação de ser nativo.
*   **Responsividade:** O painel (popup) deve ter uma largura confortável (aprox. 400px a 500px) e altura ajustável (max 600px, com scroll interno).
*   **Modo Escuro:** Suporte a dark/light mode conforme as preferências do navegador do usuário (`@media (prefers-color-scheme: dark)`).

### 5.3. Performance e Segurança
*   **Baixo Consumo:** A extensão não pode causar lentidão no carregamento das páginas. As regras de detecção devem ser eficientes.
*   **Privacidade:** Não coletar telemetria não autorizada; o processamento de mídias ocorre 100% no cliente (browser).
*   **Segurança (CORS/DRM):** 
    *   A extensão deve lidar com restrições de CORS usando permissões adequadas em `host_permissions`.
    *   **Nota de Limitação:** O PRD assume que conteúdos protegidos por DRM (Netflix, Prime, etc.) não serão baixados por limitações técnicas e legais criptográficas.

---

## 6. Permissões Necessárias no `manifest.json`
```json
{
  "permissions": [
    "activeTab",
    "downloads",
    "storage",
    "webRequest",
    "sidePanel",
    "contextMenus"
  ],
  "host_permissions": [
    "*://*/*"
  ]
}
```

## 7. Instruções para o Google Antigravity (Criação de Código)
Para o gerador de código, por favor, divida o output do projeto nos seguintes componentes:
1.  **`manifest.json`**: Arquivo de configuração (V3).
2.  **`background.js`**: Service Worker lidando com a interceptação e atualização de ícones.
3.  **`popup.html` & `popup.css`**: Interface do usuário detalhada nas features F2 a F6.
4.  **`popup.js`**: Lógica de interface, manipulação de estado, e comunicação com o `background.js`.
5.  **`content.js`** *(opcional)*: Para ler o DOM em busca de vídeos ocultos ou `<video src="...">`.
