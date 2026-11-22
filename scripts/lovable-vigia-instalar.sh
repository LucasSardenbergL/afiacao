#!/usr/bin/env bash
# lovable-vigia-instalar.sh — instala (ou reinstala) o vigia de Publish do Lovable no launchd do Mac.
#
# Faz: clone próprio do repo em ~/.local/share/afiacao/vigia-repo (o vigia faz checkout nele a cada
# tick — nunca num worktree de sessão), copia scripts/lovable-vigia.sh para fora do repo e carrega
# o LaunchAgent `dev.afiacao.lovable-vigia` (a cada 180 s). Idempotente.
# Pré-requisito: token de 1 ano do `claude setup-token` no Keychain, serviço `claude-vigia-lovable`.
# Uso: scripts/lovable-vigia-instalar.sh            · desinstalar: scripts/lovable-vigia-instalar.sh --remover
set -eu

ROTULO=dev.afiacao.lovable-vigia
PLIST="$HOME/Library/LaunchAgents/$ROTULO.plist"
BASE="$HOME/.local/share/afiacao"
WT="$BASE/vigia-repo"
EST="$HOME/.local/state/afiacao/lovable-vigia"
AQUI="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${1:-}" = --remover ]; then
  launchctl bootout "gui/$(id -u)/$ROTULO" 2>/dev/null || true
  rm -f "$PLIST"; echo "vigia removido (estado em $EST e clone em $WT preservados)"; exit 0
fi

security find-generic-password -s claude-vigia-lovable >/dev/null 2>&1 \
  || { echo "falta o token no Keychain (serviço claude-vigia-lovable)" >&2; exit 1; }
mkdir -p "$BASE" "$EST" "$HOME/Library/LaunchAgents"

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
  <key>StartInterval</key><integer>180</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StandardOutPath</key><string>$EST/launchd.log</string>
  <key>StandardErrorPath</key><string>$EST/launchd.log</string>
</dict></plist>
EOF

launchctl bootout "gui/$(id -u)/$ROTULO" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "vigia instalado: $ROTULO a cada 180 s · log $EST/vigia.log · pausar: touch $EST/pausado"
