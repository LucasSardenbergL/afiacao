#!/usr/bin/env bash
# gstack-auto-upgrade-instalar.sh — instala (ou reinstala) o PREPARO semanal do upgrade do gstack.
#
# Idempotente. O que faz:
#   1. copia scripts/gstack-auto-upgrade.sh para ~/.gstack/auto-upgrade/atualizar-gstack.sh. O
#      caminho é FIXO porque o launchd não pode apontar para um worktree, que some no wt:clean;
#   2. escreve ~/Library/LaunchAgents/com.lucas.gstack-upgrade.plist: domingo 10h, o mesmo horário do
#      com.lucas.codex-modelo-update. Com o Mac dormindo nessa hora, o launchd roda ao acordar;
#   3. (re)carrega o agente (bootout + bootstrap) e CONFERE que o launchd passou a conhecê-lo;
#   4. desliga as tentativas DENTRO da sessão: gstack-config update_check=false e auto_upgrade=false,
#      conferidos por leitura. O job vira o ÚNICO a mexer no gstack; o hook de sessão do próprio
#      gstack (se um dia o ./setup --team o registrar) também respeita o auto_upgrade.
#
# Mudou o gstack-auto-upgrade.sh? Rode de novo: a cópia instalada não se atualiza sozinha.
# Por quê de tudo isto: docs/historico/gstack-upgrade-fora-da-sessao.md.
#
# Uso: bash scripts/gstack-auto-upgrade-instalar.sh [--desinstalar]
# Saída: 0 = instalado e conferido · 1 = falhou (a mensagem diz onde) · 2 = fora do macOS.
set -uo pipefail

ROTULO=com.lucas.gstack-upgrade
here="$(cd "$(dirname "$0")" && pwd)"
ORIGEM="$here/gstack-auto-upgrade.sh"
AUTO="${HOME:?HOME indefinido}/.gstack/auto-upgrade"
DEST="$AUTO/atualizar-gstack.sh"
PLIST="$HOME/Library/LaunchAgents/$ROTULO.plist"
CFG="$HOME/.claude/skills/gstack/bin/gstack-config"

[ "$(uname -s)" = Darwin ] || { echo "so no macOS (launchd)"; exit 2; }
DOMINIO="gui/$(id -u)"

if [ "${1:-}" = --desinstalar ]; then
  launchctl bootout "$DOMINIO/$ROTULO" 2>/dev/null
  rm -f "$PLIST" "$DEST"
  echo "desinstalado: $ROTULO (status e log ficam em $AUTO)."
  echo "ATENCAO: o gstack segue com update_check=false; sem o job, nada avisa de versao nova."
  echo "para voltar ao aviso dentro da sessao: $CFG set update_check true"
  exit 0
fi

[ -r "$ORIGEM" ] || { echo "ERRO: $ORIGEM ausente"; exit 1; }
bash -n "$ORIGEM" || { echo "ERRO: $ORIGEM com erro de sintaxe; nada instalado"; exit 1; }
[ -x "$CFG" ] || { echo "ERRO: gstack-config ausente em $CFG (o gstack esta instalado?)"; exit 1; }
mkdir -p "$AUTO" "$(dirname "$PLIST")" || { echo "ERRO: nao criei $AUTO"; exit 1; }
install -m 0755 "$ORIGEM" "$DEST" || { echo "ERRO: nao copiei para $DEST"; exit 1; }

cat > "$PLIST.tmp.$$" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$ROTULO</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DEST</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$AUTO/launchd.err.log</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST.tmp.$$" >/dev/null || { rm -f "$PLIST.tmp.$$"; echo "ERRO: plist invalido; nada carregado"; exit 1; }
mv -f "$PLIST.tmp.$$" "$PLIST"

# bootout de agente que não estava carregado não é erro. Logo depois de um bootout, o bootstrap às
# vezes falha com "5: Input/output error" até o launchd terminar de descarregar; daí as tentativas.
launchctl bootout "$DOMINIO/$ROTULO" 2>/dev/null
carregou=0
for _ in 1 2 3 4 5; do
  if launchctl bootstrap "$DOMINIO" "$PLIST" 2>/dev/null; then carregou=1; break; fi
  sleep 1
done
[ "$carregou" -eq 1 ] || { echo "ERRO: launchctl bootstrap falhou 5 vezes ($PLIST)"; exit 1; }
launchctl print "$DOMINIO/$ROTULO" >/dev/null 2>&1 \
  || { echo "ERRO: o launchd nao conhece $ROTULO depois do bootstrap"; exit 1; }

if ! "$CFG" set update_check false >/dev/null || ! "$CFG" set auto_upgrade false >/dev/null; then
  echo "ERRO: gstack-config set falhou"; exit 1
fi
[ "$("$CFG" get update_check)" = false ] && [ "$("$CFG" get auto_upgrade)" = false ] \
  || { echo "ERRO: gstack-config nao confirmou update_check=false e auto_upgrade=false"; exit 1; }

echo "INSTALADO: $ROTULO (domingo 10h) roda $DEST"
echo "gstack: update_check=false e auto_upgrade=false (a sessao nao tenta mais atualizar sozinha)"
echo "primeiro preparo, para conferir agora: bash $DEST"
