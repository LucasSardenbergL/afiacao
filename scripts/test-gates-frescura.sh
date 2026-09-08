#!/usr/bin/env bash
# test-gates-frescura.sh — eixo POR FORA #2 do `gates:frescura`.
#
# O gate lê o `ci.yml` e MORA no `ci.yml`: herda o defeito da máquina que vigia. O vitest irmão
# (`gates-frescura-check.test.ts`) exercita as funções puras; este aqui roda o BINÁRIO de verdade,
# por outro runner, contra uma raiz sintética completa — e no modo `--falsificar` exige VERMELHO em
# cada sabotagem, uma por vez.
#
# Por que uma por vez: sabotar tudo junto não distingue "as duas direções funcionam" de "uma
# direção funciona e a outra é inalcançável". A direção que ficar VERDE sob a sua própria sabotagem
# é redundante ou nunca roda.
#
# Por que o CONTROLE vem antes do 1º `sed`, na MESMA invocação: uma suíte sempre-vermelha aprova
# TUDO. Se a raiz sintética já estivesse vermelha por outro motivo, cada sabotagem "passaria" sem
# provar nada (docs/historico/falsificacao-sem-linha-de-base.md). Aqui o controle é remontado e
# reconferido antes de CADA sabotagem, e a suíte ABORTA se ele não estiver verde.
#
# Marcadores são ASCII, caixa fixa, casados sem `-i` — e a suíte roda nos DOIS locales, porque
# falsificar num ambiente só não prova a asserção (#1483).
set -euo pipefail

RAIZ_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$RAIZ_REPO/scripts/gates-frescura-check.ts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

falhas=0
ok() { printf 'ok   — %s\n' "$1"; }
falhou() { printf 'FALHA — %s\n' "$1"; falhas=$((falhas + 1)); }

# ------------------------------------------------------------------------------------------------
# Raiz sintética: um repo em miniatura com as 5 superfícies que o gate lê.
# ------------------------------------------------------------------------------------------------
montar() {
  local r="$TMP/raiz"
  rm -rf "$r"
  mkdir -p "$r/.github/workflows" "$r/.claude/hooks" "$r/docs/agent"

  cat > "$r/CLAUDE.md" <<'EOF'
# Manual de fixture

- roda `bun run gate:um` antes de tudo
- o `gate:dois` reprova o PR

```bash
bun run so-exemplo-dentro-da-cerca
```
EOF

  cat > "$r/package.json" <<'EOF'
{ "scripts": { "gate:um": "bun um.ts", "gate:dois": "bun dois.ts" } }
EOF

  cat > "$r/.github/workflows/ci.yml" <<'EOF'
jobs:
  validate:
    steps:
      - name: Gate um
        run: bun run gate:um
      - name: Gate dois
        run: bun run gate:dois
      - name: Aviso que nunca reprova
        run: bun run so:aviso
        continue-on-error: true
EOF

  cat > "$r/.claude/settings.json" <<'EOF'
{ "hooks": { "PreToolUse": [
  { "hooks": [ { "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/bloqueia.sh" } ] },
  { "hooks": [ { "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/avisa.sh" } ] } ] } }
EOF

  # `bloqueia.sh` nega de verdade; `avisa.sh` só CITA "deny" em comentário — é o caso real do
  # `read-contexto-nudge.sh`, e o censo abaixo não o lista de propósito.
  printf '%s\n' 'jq -n '\''{hookSpecificOutput:{permissionDecision:"deny"}}'\''' > "$r/.claude/hooks/bloqueia.sh"
  printf '%s\n' '# permissionDecision:"deny" quebraria a investigacao — por isso NAO nego' 'echo aviso' > "$r/.claude/hooks/avisa.sh"

  cat > "$r/docs/agent/deploy.md" <<'EOF'
# Deploy (fixture)

<!--gates:frescura inicio-->

**Gates do CI:** `gate:um` · `gate:dois`.

**Hooks que NEGAM:** `bloqueia.sh`.

<!--gates:frescura fim-->
EOF
}

rodar() { (cd "$RAIZ_REPO" && bun "$GATE" --raiz "$TMP/raiz" 2>&1); }

# Controle: remonta a raiz limpa e EXIGE verde. Sem isto, toda sabotagem seguinte é teatro.
controle() {
  montar
  local saida rc
  set +e; saida="$(rodar)"; rc=$?; set -e
  if [ "$rc" -ne 0 ] || ! printf '%s' "$saida" | grep -q 'FRESCURA-OK'; then
    printf 'ABORTA — controle nao esta verde (rc=%s). Sabotar agora aprovaria qualquer coisa.\n' "$rc"
    printf '%s\n' "$saida"
    exit 1
  fi
}

# sabotagem <descricao> <marcador-esperado> <rc-esperado> <comando-que-sabota>
sabotagem() {
  local desc="$1" marca="$2" rc_esp="$3" cmd="$4"
  controle
  ( cd "$TMP/raiz" && eval "$cmd" )
  local saida rc
  set +e; saida="$(rodar)"; rc=$?; set -e
  if [ "$rc" -ne "$rc_esp" ]; then
    falhou "$desc — esperava rc=$rc_esp, veio rc=$rc"
    return
  fi
  if ! printf '%s' "$saida" | grep -q "$marca"; then
    falhou "$desc — rc correto mas sem o marcador $marca"
    return
  fi
  ok "$desc — vermelho com $marca"
}

# ------------------------------------------------------------------------------------------------
# Modo normal: o gate aprova a raiz limpa E o repo de verdade.
# ------------------------------------------------------------------------------------------------
modo_normal() {
  montar
  local saida rc
  set +e; saida="$(rodar)"; rc=$?; set -e
  if [ "$rc" -eq 0 ] && printf '%s' "$saida" | grep -q 'FRESCURA-OK'; then
    ok 'raiz sintetica limpa passa'
  else
    falhou "raiz sintetica limpa deveria passar (rc=$rc)"
  fi

  # O hook que só cita "deny" em comentário NÃO pode ser cobrado no censo. Se a limpeza de
  # comentário quebrar, este caso fica vermelho aqui antes de virar falso positivo no repo.
  if printf '%s' "$saida" | grep -q 'NAO-CITADO'; then
    falhou 'hook de AVISO foi cobrado como gate (limpeza de comentario quebrou)'
  else
    ok 'hook de aviso nao e cobrado como gate'
  fi

  set +e; ( cd "$RAIZ_REPO" && bun "$GATE" >/dev/null 2>&1 ); rc=$?; set -e
  if [ "$rc" -eq 0 ]; then ok 'repo de verdade passa'; else falhou "repo de verdade reprovou (rc=$rc)"; fi
}

# ------------------------------------------------------------------------------------------------
# Modo falsificação: cada sentido sabotado SEPARADAMENTE.
# ------------------------------------------------------------------------------------------------
modo_falsificar() {
  # --- Sentido 1 -------------------------------------------------------------------------------
  sabotagem 'S1 sentido 1: manual cita nome que nao existe' 'ORFAO' 1 \
    "printf '%s\n' '- veja \`nao:existe\` aqui' >> CLAUDE.md"

  sabotagem 'S2 sentido 1: nome existe mas ninguem invoca' 'ORFAO' 1 \
    "sed -i.bak 's|\"gate:dois\": \"bun dois.ts\"|\"gate:dois\": \"bun dois.ts\", \"solto:orfao\": \"echo oi\"|' package.json && printf '%s\n' '- e o \`solto:orfao\` tambem' >> CLAUDE.md"

  # --- Sentido 2 -------------------------------------------------------------------------------
  sabotagem 'S3 sentido 2: gate do ci.yml some do censo' 'NAO-CITADO' 1 \
    "sed -i.bak 's| · \`gate:dois\`||' docs/agent/deploy.md"

  sabotagem 'S4 sentido 2: censo lista nome que nao reprova mais' 'CENSO-OBSOLETO' 1 \
    "sed -i.bak 's|\`gate:dois\`|\`gate:dois\` · \`gate:fantasma\`|' docs/agent/deploy.md"

  sabotagem 'S5 sentido 2: hook deny novo nao entra no censo' 'NAO-CITADO' 1 \
    "printf '%s\n' 'jq -n {permissionDecision:\"deny\"}' > .claude/hooks/novo.sh && sed -i.bak 's|{ \"command\": \"\$CLAUDE_PROJECT_DIR/.claude/hooks/avisa.sh\" }|{ \"command\": \"\$CLAUDE_PROJECT_DIR/.claude/hooks/avisa.sh\" } ] }, { \"hooks\": [ { \"command\": \"\$CLAUDE_PROJECT_DIR/.claude/hooks/novo.sh\" }|' .claude/settings.json"

  # --- Fail-closed -----------------------------------------------------------------------------
  # Bloco ausente é "nao consegui avaliar" (rc=2), nunca "esta tudo certo" (rc=0).
  sabotagem 'S6 fail-closed: censo sumiu do doc' 'FRESCURA-FALHA' 2 \
    "sed -i.bak 's|<!--gates:frescura inicio-->||' docs/agent/deploy.md"

  sabotagem 'S7 fail-closed: ci.yml ilegivel' 'FRESCURA-FALHA' 2 \
    "printf '%s\n' 'jobs: [: : {' > .github/workflows/ci.yml"
}

if [ "${1:-}" = "--falsificar" ]; then
  printf '== falsificacao (locale %s) ==\n' "${LC_ALL:-default}"
  modo_falsificar
else
  printf '== modo normal (locale %s) ==\n' "${LC_ALL:-default}"
  modo_normal
fi

if [ "$falhas" -gt 0 ]; then
  printf 'RESULTADO: %s falha(s)\n' "$falhas"
  exit 1
fi
printf 'RESULTADO: tudo ok\n'
