#!/usr/bin/env bash
# shellcheck disable=SC2015  # `cond && ok || nok`: ok() sempre sai 0, então nok só roda se cond falhar
# test-lovable-vigia.sh — o veredito do vigia sai do PROTOCOLO do `claude -p` (stream-json), não do texto.
#
# Incidente: vigia.log 2026-11-22..25 — 41% de 1ª chamada OK; o Haiku respondia "ferramentas MCP não
# disponíveis" com o MCP conectado, e 1 vez cravou VIGIA=NAO_SINCRONIZADO sem ter chamado ferramenta
# nenhuma (docs/historico/lovable-publish-automatico.md). Roda o vigia INTEIRO num sandbox: origin git
# local, `lovable-publish.sh --julgar` falso, `claude` falso (LV_CLAUDE) que emite um stream gravado,
# e `security`/`osascript`/`gh` falsos no PATH. Nada sai da máquina.
set -u
RAIZ=$(cd "$(dirname "$0")/.." && pwd)
VIGIA="$RAIZ/scripts/lovable-vigia.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FALHAS=0
ok()   { printf 'ok   %s\n' "$1"; }
nok()  { printf 'FALHA %s\n' "$1"; FALHAS=$((FALHAS + 1)); }

# ── binários falsos ────────────────────────────────────────────────────────────────────────────
mkdir -p "$TMP/bin"
printf '#!/bin/sh\necho token-falso\n' > "$TMP/bin/security"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/osascript"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/gh"
# claude falso: conta chamadas, emite $CENARIO.jsonl; "deploy" real = cria $TMP/ar-novo
cat > "$TMP/bin/claude-falso" <<'EOF'
#!/usr/bin/env bash
cat > /dev/null
echo x >> "$LVT/chamadas"
printf '%s\n' "$*" > "$LVT/args"
sed "s/@HEAD@/$(cat "$LVT/head")/g" "$LVT/stream-$LVT_CENARIO.jsonl"
case "$LVT_CENARIO" in ok|timeout_pos_deploy) touch "$LVT/ar-novo" ;; esac
[ "$LVT_CENARIO" = timeout_pos_deploy ] && exit 124
exit 0
EOF
chmod +x "$TMP/bin/"*

# ── streams gravados (formato real do claude 2.1.283, recortado) ────────────────────────────────
OUTRO=1111111111111111111111111111111111111111
init() { printf '{"type":"system","subtype":"init","mcp_servers":[{"name":"lovable","status":"%s"}],"tools":[]}\n' "$1"; }
uso()  { printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"%s","name":"mcp__lovable__%s","input":{}}]}}\n' "$1" "$2"; }
res()  { printf '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"%s","content":[{"type":"image","source":{}},{"type":"text","text":"%s"}]}]}}\n' "$1" "$2"; }
fim()  { printf '{"type":"result","subtype":"success","result":"%s","total_cost_usd":0.01}\n' "$1"; }
gp()   { printf '{\\"id\\":\\"p\\",\\"latest_commit_sha\\":\\"%s\\"}' "$1"; }
{ init connected; uso t1 get_project; res t1 "$(gp @HEAD@)"; uso t2 deploy_project
  res t2 '{\"status\":\"pending\",\"deployment_id\":\"dep-123\"}'; fim "VIGIA=DISPARADO dep-123"; } > "$TMP/stream-ok.jsonl"
{ init connected; fim "VIGIA=DISPARADO inventado"; } > "$TMP/stream-fabricado.jsonl"
{ init connected; uso t1 get_project; res t1 "$(gp "$OUTRO")"; fim "VIGIA=DISPARADO x"; } > "$TMP/stream-divergente.jsonl"
{ init needs-auth; fim "VIGIA=ERRO ferramentas_mcp_nao_disponiveis"; } > "$TMP/stream-needs_auth.jsonl"
{ init connected; uso t1 get_project; res t1 "$(gp @HEAD@)"; uso t2 deploy_project; } > "$TMP/stream-timeout_pos_deploy.jsonl"

# ── origin com o vigia sob teste + lovable-publish.sh falso (PUBLICAR até o "deploy") ───────────
git init -q -b main "$TMP/origin"; mkdir -p "$TMP/origin/scripts"
cp "$VIGIA" "$TMP/origin/scripts/lovable-vigia.sh"
cat > "$TMP/origin/scripts/lovable-publish.sh" <<'EOF'
#!/usr/bin/env bash
# falso: --julgar
if [ -f "$LVT/ar-novo" ]; then echo "ar=$(cut -c1-8 "$LVT/head") x"; echo VEREDITO=JA_NO_AR
else echo "ar=aaaaaaaa x"; echo VEREDITO=PUBLICAR; fi
EOF
git -C "$TMP/origin" add -A && git -C "$TMP/origin" -c user.email=t@t -c user.name=t commit -qm base
git -C "$TMP/origin" rev-parse HEAD > "$TMP/head"

roda() {  # roda <cenario> → um tick do vigia num estado novo
  local c=$1 est="$TMP/est-$1"
  rm -rf "$est" "$TMP/wt" "$TMP/chamadas" "$TMP/ar-novo"; mkdir -p "$est"
  git clone -q "$TMP/origin" "$TMP/wt"
  cp "$VIGIA" "$TMP/vigia.sh"
  LVT="$TMP" LVT_CENARIO="$c" LV_ESTADO="$est" LV_WT="$TMP/wt" LV_ESPERA_AR=20 \
    LV_CLAUDE="$TMP/bin/claude-falso" PATH="$TMP/bin:$PATH" bash "$TMP/vigia.sh"
  CHAMADAS=$(wc -l < "$TMP/chamadas" 2>/dev/null | tr -d ' '); LOGV="$est/vigia.log"; TENT="$est/tentativa"
}
tem() { grep -qF -- "$1" "$LOGV"; }

roda ok
{ [ "$CHAMADAS" = 1 ] && tem "→ DISPARADO dep-123" && tem "PUBLICADO" && [ ! -f "$TENT" ]; } \
  && ok "deploy com aceite lido → DISPARADO, 1 chamada, PUBLICADO" || nok "ok: chamadas=$CHAMADAS $(tail -3 "$LOGV")"
grep -q -- '--strict-mcp-config' "$TMP/args" && grep -q -- '--tools  --setting-sources' "$TMP/args" \
  && ok "invocação mínima (--strict-mcp-config, --tools vazio, --setting-sources vazio)" || nok "args: $(cat "$TMP/args")"

roda fabricado
{ [ "$CHAMADAS" = 2 ] && tem "→ ERRO (modelo: VIGIA=DISPARADO inventado)" && tem "FALHOU (1/3)"; } \
  && ok "VIGIA=DISPARADO sem tool_result → ERRO, 2ª chamada, FALHOU 1/3" || nok "fabricado: chamadas=$CHAMADAS $(tail -3 "$LOGV")"

roda divergente
{ [ "$CHAMADAS" = 1 ] && tem "→ NAO_SINCRONIZADO 11111111" && ! tem "FALHOU" && [ "$(cut -d' ' -f2 "$TENT")" = 0 ]; } \
  && ok "SHA do Lovable ≠ main → NAO_SINCRONIZADO pelo resultado, sem debitar" || nok "divergente: chamadas=$CHAMADAS $(tail -3 "$LOGV")"

roda needs_auth
{ [ "$CHAMADAS" = 1 ] && tem "mcp=needs-auth" && tem "→ NEEDS_AUTH" && ! tem "FALHOU" \
  && [ "$(cut -d' ' -f2 "$TENT")" = 0 ] && [ -f "$TMP/est-needs_auth/needs-auth" ] && tem "AVISO: MCP lovable em needs-auth"; } \
  && ok "needs-auth → 1 chamada, sem debitar o SHA, aviso 1x por episódio" || nok "needs_auth: chamadas=$CHAMADAS $(tail -3 "$LOGV")"

roda timeout_pos_deploy
{ [ "$CHAMADAS" = 1 ] && tem "rc=124" && tem "→ INDETERMINADO" && tem "PUBLICADO" && ! tem "FALHOU"; } \
  && ok "timeout após emitir deploy → sem redisparo, o ar decide (PUBLICADO)" || nok "timeout: chamadas=$CHAMADAS $(tail -3 "$LOGV")"

[ "$FALHAS" -eq 0 ] && { echo "TEST-LOVABLE-VIGIA: OK (6)"; exit 0; }
echo "TEST-LOVABLE-VIGIA: $FALHAS falha(s)"; exit 1
