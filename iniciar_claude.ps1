$env:ANTHROPIC_AUTH_TOKEN = $null
$env:ANTHROPIC_API_KEY = "sk-5fc4a0b1e2ca43d4a3773e378fdee7b1"
$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
$env:CLAUDE_CODE_USE_VERTEX = "0"
$env:ANTHROPIC_MODEL = "deepseek-v4-pro[1m]"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "deepseek-v4-pro[1m]"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "deepseek-v4-pro[1m]"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "deepseek-v4-flash"
$env:CLAUDE_CODE_SUBAGENT_MODEL = "deepseek-v4-flash"
$env:CLAUDE_CODE_EFFORT_LEVEL = "max"

Write-Host "Iniciando Claude Code com configuracoes do DeepSeek..." -ForegroundColor Green
claude
