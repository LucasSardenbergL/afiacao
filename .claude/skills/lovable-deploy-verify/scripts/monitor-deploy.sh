#!/usr/bin/env bash
# monitor-deploy.sh — vigia se o frontend NO AR está sincronizado com origin/main.
# Pensado pra rodar em cron (sem interação): detecta um Publish (o hash do entry muda) e
# responde "ar == main?" pelo carimbo `__BUILD_SHA__` (vite.config + main.tsx), com FALLBACK
# de sentinela de string quando o carimbo não está disponível.
#
# Exit:  0 = sincronizado (ou nada a relatar) · 3 = ar ATRASADO (Publish pendente)
#        4 = deploy novo detectado mas versão indeterminada (sem carimbo nem sentinela)
#        2 = site fora do ar / HTML mudou de forma
# Estado: último hash de entry visto em $DEPLOY_MONITOR_STATE
#         (default ~/.config/afiacao/deploy-monitor.state) — pra detectar "mudou desde a última vez".
#
# Uso:   monitor-deploy.sh [url] [sentinela-opcional]
#   - rode com cwd DENTRO do repo (precisa de git pra saber o SHA de origin/main).
#   - SENTINELA: string única do HEAD que sobrevive ao build (ex.: um texto de UI),
#     usada SÓ se o carimbo vier "dev" (Lovable sem .git) ou ausente (build pré-carimbo).
set -uo pipefail
APP="${1:-https://steu.lovable.app}"
SENTINELA="${2:-}"
STATE="${DEPLOY_MONITOR_STATE:-$HOME/.config/afiacao/deploy-monitor.state}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$(dirname "$STATE")" 2>/dev/null || true
TS=$(date +%FT%T 2>/dev/null || echo now)

git fetch origin main --quiet 2>/dev/null || true
MAIN_SHA=$(git rev-parse --short=8 origin/main 2>/dev/null || echo "?")

ENTRY=$(curl -fsS "$APP/" 2>/dev/null | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
[ -n "$ENTRY" ] || { echo "[$TS] monitor: $APP fora do ar ou HTML mudou de forma"; exit 2; }
ENTRY_HASH=$(printf '%s' "$ENTRY" | grep -oE 'index-[A-Za-z0-9_-]+')
PREV=$(cat "$STATE" 2>/dev/null || echo "")
printf '%s\n' "$ENTRY_HASH" > "$STATE"
if [ "$PREV" != "$ENTRY_HASH" ]; then DEPLOY="SIM (${PREV:-1a-vez} -> $ENTRY_HASH)"; else DEPLOY="nao"; fi

BODY=$(curl -fsS "$APP$ENTRY" 2>/dev/null || echo "")
AIR_SHA=$(printf '%s' "$BODY" | grep -oE '__BUILD_SHA__="[0-9a-f]{7,8}"' | grep -oE '[0-9a-f]{7,8}' | head -1)
IS_DEV=$(printf '%s' "$BODY" | grep -cE '__BUILD_SHA__="dev"' || true)

echo "[$TS] main=$MAIN_SHA  ar=${AIR_SHA:-$([ "${IS_DEV:-0}" -gt 0 ] && echo dev || echo sem-carimbo)}  deploy-novo=$DEPLOY"

# Caminho determinístico: carimbo de SHA real no ar
if [ -n "$AIR_SHA" ]; then
  if [ "$AIR_SHA" = "$MAIN_SHA" ]; then echo "  ✅ sincronizado: ar serve $AIR_SHA == origin/main"; exit 0
  else echo "  ⚠️ ATRASADO: ar serve $AIR_SHA, main em $MAIN_SHA → Publish pendente"; exit 3; fi
fi

# Fallback: carimbo "dev" (Lovable sem git no build) ou ausente (build pré-carimbo)
if [ -n "$SENTINELA" ]; then
  if "$SELF_DIR/verify-frontend.sh" "$SENTINELA" "$APP" >/dev/null 2>&1; then
    echo "  fallback: sentinela '$SENTINELA' PRESENTE no ar → provavelmente sincronizado"; exit 0
  else
    echo "  fallback: sentinela '$SENTINELA' AUSENTE → Publish pendente (ou sentinela ruim)"; exit 3
  fi
fi
if [ "$DEPLOY" = "nao" ]; then echo "  sem carimbo útil e nada mudou desde a última checagem → nada a relatar"; exit 0; fi
echo "  deploy novo detectado, mas sem carimbo de SHA nem sentinela → não dá pra confirmar a versão"
echo "  (quando o carimbo chegar ao ar no 1º Publish, este fallback some)"
exit 4
