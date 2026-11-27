#!/usr/bin/env bash
# lovable-vigia-instalar.sh — instala (ou reinstala) o vigia de Publish do Lovable no launchd do Mac.
#
# Faz: clone próprio do repo em ~/.local/share/afiacao/vigia-repo (o vigia faz checkout nele a cada
# tick — nunca num worktree de sessão), copia scripts/lovable-vigia.sh para fora do repo e carrega
# o LaunchAgent `dev.afiacao.lovable-vigia` (a cada 60 s). Idempotente.
# Pré-requisito: token de 1 ano do `claude setup-token` no Keychain, serviço `claude-vigia-lovable`.
# Uso: scripts/lovable-vigia-instalar.sh            · desinstalar: scripts/lovable-vigia-instalar.sh --remover
#      scripts/lovable-vigia-instalar.sh --login    · login OAuth do Lovable num store só do vigia (1x)
#      scripts/lovable-vigia-instalar.sh --verificar · prova o get_project no CONTEXTO do launchd (PR 4)
set -eu

ROTULO=dev.afiacao.lovable-vigia
PLIST="$HOME/Library/LaunchAgents/$ROTULO.plist"
BASE="$HOME/.local/share/afiacao"
WT="$BASE/vigia-repo"
EST="$HOME/.local/state/afiacao/lovable-vigia"
AQUI="$(cd "$(dirname "$0")/.." && pwd)"
CFG_DIR=${LV_CLAUDE_DIR:-$BASE/vigia-claude}
PATH_LAUNCHD="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
PROJETO=8f005805-000a-42b7-88a1-9683f785fab6

# --verificar (PR 4): o instalador só diz "instalado" com PROVA. Roda o MESMO `claude -p` mínimo do vigia
# com o ambiente que o launchd dá (env -i: HOME, USER, LOGNAME, o PATH do plist, o store próprio e o
# token do Keychain — nada herdado da sessão interativa) e exige um tool_result do get_project com
# latest_commit_sha de 40 hex na raiz. 1 chamada Haiku (centavos), só na instalação/login.
verifica() {
  local tok u t sha st
  [ -f "$CFG_DIR/.vigia-pronto" ] || { echo "VERIFICAR=FALHOU store próprio ausente ($CFG_DIR/.vigia-pronto) — rode --login" >&2; return 1; }
  tok=$(security find-generic-password -s claude-vigia-lovable -w 2>/dev/null) || { echo "VERIFICAR=FALHOU token claude-vigia-lovable ausente" >&2; return 1; }
  u=$(id -un); t=$(mktemp -d); chmod 700 "$t"
  printf '{"mcpServers":{"lovable":{"type":"http","url":"https://mcp.lovable.dev"}}}\n' > "$t/mcp.json"
  (cd "$t" && printf 'Chame mcp__lovable__get_project com project_id %s e responda só OK.' "$PROJETO" \
    | env -i HOME="$HOME" USER="$u" LOGNAME="$u" PATH="$PATH_LAUNCHD" CLAUDE_CONFIG_DIR="$CFG_DIR" \
        CLAUDE_CODE_OAUTH_TOKEN="$tok" ENABLE_TOOL_SEARCH=false MCP_TIMEOUT=60000 \
        timeout 300 "${LV_CLAUDE:-claude}" -p --model haiku --strict-mcp-config --mcp-config "$t/mcp.json" \
        --tools "" --setting-sources "" --allowedTools "mcp__lovable__get_project" --output-format stream-json --verbose) > "$t/s.jsonl" 2>"$t/err" || true
  unset tok
  st=$(jq -r 'select(.type=="system" and .subtype=="init") | (.mcp_servers[]? | select(.name=="lovable") | .status)' "$t/s.jsonl" 2>/dev/null | head -1)
  sha=$(jq -rs --arg p "$PROJETO" '
    [.[] | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="mcp__lovable__get_project" and (.input.project_id // "")==$p) | .id] as $ids
    | .[] | select(.type=="user") | .message.content[]?
    | select(.type=="tool_result" and (.is_error != true) and ((.tool_use_id as $i | $ids | index($i)) != null))
    | (if (.content|type)=="string" then .content else ([.content[]? | select(.type=="text") | .text] | join("")) end)
    | sub("^[^{]*"; "") | fromjson? | .latest_commit_sha // empty | select(test("^[0-9a-f]{40}$"))' "$t/s.jsonl" 2>/dev/null | head -1)
  rm -rf "$t"
  if [ -n "$sha" ]; then echo "VERIFICAR=OK get_project no contexto do launchd leu latest_commit_sha=${sha:0:8} (mcp=$st)"
  else echo "VERIFICAR=FALHOU sem tool_result do get_project (mcp=${st:-?}) — se needs-auth: rode --login" >&2; return 1; fi
}
if [ "${1:-}" = --verificar ]; then verifica; exit $?; fi

# --login: store PRÓPRIO do claude para o vigia (CLAUDE_CONFIG_DIR → item de Keychain e cache de
# needs-auth só dele). O blob padrão é reescrito por dezenas de sessões e já perdeu o token do lovable
# (docs/historico/lovable-publish-automatico.md). Interativo: abre o navegador para o OAuth do Lovable.
if [ "${1:-}" = --login ]; then
  mkdir -p "$CFG_DIR" && chmod 700 "$CFG_DIR"
  CLAUDE_CONFIG_DIR="$CFG_DIR" claude mcp get lovable >/dev/null 2>&1 \
    || CLAUDE_CONFIG_DIR="$CFG_DIR" claude mcp add --transport http -s user lovable https://mcp.lovable.dev
  CLAUDE_CONFIG_DIR="$CFG_DIR" claude mcp login lovable
  date '+%F %T' > "$CFG_DIR/.vigia-pronto"
  echo "store próprio ativo em $CFG_DIR"; verifica; exit $?
fi

if [ "${1:-}" = --remover ]; then
  launchctl bootout "gui/$(id -u)/$ROTULO" 2>/dev/null || true
  rm -f "$PLIST"; echo "vigia removido (estado em $EST e clone em $WT preservados)"; exit 0
fi

security find-generic-password -s claude-vigia-lovable >/dev/null 2>&1 \
  || { echo "falta o token no Keychain (serviço claude-vigia-lovable)" >&2; exit 1; }
mkdir -p "$BASE" "$EST" "$HOME/Library/LaunchAgents"
chmod 700 "$EST"; [ -d "$CFG_DIR" ] && chmod 700 "$CFG_DIR"   # PR 4: estado/streams/store só do dono

if [ ! -d "$WT/.git" ]; then
  # --reference não aceita worktree ligado: usa o repo principal (dono do .git comum)
  PRINCIPAL=$(dirname "$(cd "$AQUI" && cd "$(git rev-parse --git-common-dir)" && pwd)")
  git clone -q --reference "$PRINCIPAL" --dissociate "$(git -C "$AQUI" remote get-url origin)" "$WT"
fi
git -C "$WT" fetch -q origin main
(cd "$WT" && git checkout -q --detach origin/main && bun install --frozen-lockfile >/dev/null)

install -m 0755 "$AQUI/scripts/lovable-vigia.sh" "$BASE/lovable-vigia.sh"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$ROTULO</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$BASE/lovable-vigia.sh</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH_LAUNCHD</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StandardOutPath</key><string>$EST/launchd.log</string>
  <key>StandardErrorPath</key><string>$EST/launchd.log</string>
</dict></plist>
EOF

launchctl bootout "gui/$(id -u)/$ROTULO" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "vigia instalado: $ROTULO a cada 60 s · log $EST/vigia.log · pausar: touch $EST/pausado"
# sem a prova no contexto do launchd o instalador NÃO diz que está pronto (o vigia PARA sem o store próprio)
verifica || { echo "instalado, mas NÃO verificado — rode: bash scripts/lovable-vigia-instalar.sh --login" >&2; exit 1; }
