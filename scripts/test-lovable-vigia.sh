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
# shellcheck disable=SC2016  # o $* e o $LVT são do bun FALSO, expandem quando ele roda
printf '#!/bin/sh\necho "$*" >> "$LVT/bun"\n[ -f "$LVT/bun_anda" ] && git -C "$LVT/origin" -c user.email=t@t -c user.name=t commit -q --allow-empty -m anda\nexit 0\n' > "$TMP/bin/bun"
# claude falso: conta chamadas, emite $CENARIO.jsonl; "deploy" real = cria $TMP/ar-novo
cat > "$TMP/bin/claude-falso" <<'EOF'
#!/usr/bin/env bash
cat > /dev/null
echo x >> "$LVT/chamadas"
printf '%s\n' "$*" > "$LVT/args"
printf '%s\n' "${CLAUDE_CONFIG_DIR:-}" > "$LVT/cfgdir"
sed "s/@HEAD@/$(cat "$LVT/head")/g" "$LVT/stream-$LVT_CENARIO.jsonl"
case "$LVT_CENARIO" in ok|ledger|timeout_pos_deploy) touch "$LVT/ar-novo" ;; esac
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
cp "$TMP/stream-ok.jsonl" "$TMP/stream-ledger.jsonl"
{ init connected; fim "VIGIA=DISPARADO inventado"; } > "$TMP/stream-fabricado.jsonl"
{ init connected; uso t1 get_project; res t1 "$(gp "$OUTRO")"; fim "VIGIA=DISPARADO x"; } > "$TMP/stream-divergente.jsonl"
{ init needs-auth; fim "VIGIA=ERRO ferramentas_mcp_nao_disponiveis"; } > "$TMP/stream-needs_auth.jsonl"
{ init connected; uso t1 get_project; res t1 "$(gp @HEAD@)"; uso t2 deploy_project; } > "$TMP/stream-timeout_pos_deploy.jsonl"

# ── origin com o vigia sob teste + lovable-publish.sh falso (PUBLICAR até o "deploy") ───────────
git init -q -b main "$TMP/origin"; mkdir -p "$TMP/origin/scripts"
cp "$VIGIA" "$TMP/origin/scripts/lovable-vigia.sh"
cat > "$TMP/origin/scripts/lovable-publish.sh" <<'EOF'
#!/usr/bin/env bash
# falso: --julgar e --decidir. $LVT/decisao (e $LVT/decisao-pos, depois que o vigia grava o cache do
# ledger) substituem a decisão; sem eles: PUBLICAR até o "deploy", JA_NO_AR depois
if [ "$1" = --decidir ] && [ -f "$LVT/decisao" ]; then
  if [ -f "$LVT/decisao-pos" ] && ls "$LP_ESTADO"/pendencias-* >/dev/null 2>&1; then cat "$LVT/decisao-pos"; else cat "$LVT/decisao"; fi
  exit 0
fi
if [ -f "$LVT/ar-novo" ]; then echo "ar=$(cut -c1-8 "$LVT/head") x"; echo VEREDITO=JA_NO_AR
else echo "ar=aaaaaaaa x"; echo VEREDITO=PUBLICAR; fi
EOF
git -C "$TMP/origin" add -A && git -C "$TMP/origin" -c user.email=t@t -c user.name=t commit -qm base
git -C "$TMP/origin" rev-parse HEAD > "$TMP/head"

roda() {  # roda <cenario> → um tick do vigia num estado novo (LVT_MANTEM=1: mesmo estado do tick anterior)
  local c=$1 est="$TMP/est-$1"
  [ "${LVT_MANTEM:-0}" = 1 ] || rm -rf "$est"
  rm -rf "$TMP/wt" "$TMP/chamadas" "$TMP/ar-novo"; mkdir -p "$est"
  git clone -q "$TMP/origin" "$TMP/wt"
  cp "${VIGIA_SOB_TESTE:-$VIGIA}" "$TMP/vigia.sh"
  LVT="$TMP" LVT_CENARIO="$c" LV_ESTADO="$est" LV_WT="$TMP/wt" LV_ESPERA_AR=20 \
    LV_CLAUDE="$TMP/bin/claude-falso" LV_CLAUDE_DIR="$TMP/cfg" PATH="$TMP/bin:$PATH" bash "$TMP/vigia.sh"
  CHAMADAS=$({ wc -l < "$TMP/chamadas"; } 2>/dev/null | tr -d ' '); LOGV="$est/vigia.log"; TENT="$est/tentativa"
}
tem() { grep -qF -- "$1" "$LOGV"; }

roda ok
{ [ "$CHAMADAS" = 1 ] && tem "→ DISPARADO dep-123" && tem "PUBLICADO" && [ ! -f "$TENT" ]; } \
  && ok "deploy com aceite lido → DISPARADO, 1 chamada, PUBLICADO" || nok "ok: chamadas=$CHAMADAS $(tail -3 "$LOGV")"
grep -q -- '--strict-mcp-config' "$TMP/args" && grep -q -- '--tools  --setting-sources' "$TMP/args" \
  && ok "invocação mínima (--strict-mcp-config, --tools vazio, --setting-sources vazio)" || nok "args: $(cat "$TMP/args")"

[ -z "$(cat "$TMP/cfgdir")" ] && ok "sem .vigia-pronto → store padrão (sem CLAUDE_CONFIG_DIR)" || nok "cfgdir=$(cat "$TMP/cfgdir")"
mkdir -p "$TMP/cfg" && touch "$TMP/cfg/.vigia-pronto"
roda ok
[ "$(cat "$TMP/cfgdir")" = "$TMP/cfg" ] && tem "PUBLICADO" && ok "com .vigia-pronto → CLAUDE_CONFIG_DIR próprio" || nok "cfgdir=$(cat "$TMP/cfgdir")"
rm -rf "$TMP/cfg"

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

# ── decisão única: ledger renovado pelo vigia, piso gravado, episódio RETIDO ──────────────────────
printf 'ar=aaaaaaaa x\n  só edge\nVEREDITO=PRECISA_LEDGER\n' > "$TMP/decisao"
printf 'ar=aaaaaaaa x\nLIBERADO=ledger base=aaaaaaaa ar=aaaaaaaa\nPISO=%s\nVEREDITO=PUBLICAR\n' "$(cat "$TMP/head")" > "$TMP/decisao-pos"
rm -f "$TMP/bun"; roda ledger
{ grep -q 'run pendencias:deploy' "$TMP/bun" && [ "$(cat "$TMP/est-ledger/pendencias-$(cat "$TMP/head")")" = 0 ] \
  && tem "ledger consultado" && tem "liberado: ledger" && tem "PUBLICADO" && [ "$(cat "$TMP/est-ledger/piso")" = "$(cat "$TMP/head")" ]; } \
  && ok "PRECISA_LEDGER → vigia renova o cache, decide de novo, publica e grava o piso" || nok "ledger: $(tail -4 "$LOGV")"
# Codex #3: a main andou durante a consulta do ledger → a prova não é deste SHA, nada gravado
touch "$TMP/bun_anda"; roda ledger; rm -f "$TMP/bun_anda"
{ tem "ledger descartado" && ! ls "$TMP/est-ledger"/pendencias-* >/dev/null 2>&1 && [ ! -f "$TMP/est-ledger/piso" ] && [ "$CHAMADAS" = "" ]; } \
  && ok "main andou durante o ledger → cache descartado, sem publicar" || nok "ledger_anda: $(tail -3 "$LOGV")"
git -C "$TMP/origin" reset -q --hard "$(cat "$TMP/head")"
rm -f "$TMP/decisao" "$TMP/decisao-pos"

RET='ar=aaaaaaaa x
  liberar: aplique a(s) migration(s) e rode  bash scripts/lovable-publish.sh --liberar 0123
RETIDO=migration:supabase/migrations/1_x.sql
VEREDITO=RETIDO'
avisos() { grep -c 'AVISO: ' "$LOGV"; }
episodio() {  # o roteiro inteiro; 0 = o vigia sob teste se comportou
  local e="$TMP/est-retido" ini
  printf '%s\n' "$RET" > "$TMP/decisao"
  roda retido; [ "$(avisos)" = 1 ] && tem "AVISO: RETIDO (migration:supabase/migrations/1_x.sql)" && tem "--liberar 0123" \
    && tem "RETIDO ar=aaaaaaaa main=" || { echo "  1º tick: $(tail -2 "$LOGV")"; return 1; }
  LVT_MANTEM=1 roda retido; [ "$(avisos)" = 1 ] || { echo "  2º tick re-avisou"; return 1; }
  ini=$(( $(date +%s) - 6 * 3600 )); echo "$ini $(( $(date +%s) - 5 * 3600 ))" > "$e/retido-episodio"
  LVT_MANTEM=1 roda retido; [ "$(avisos)" = 2 ] && tem "AVISO: AINDA RETIDO há 6h" || { echo "  lembrete: $(tail -2 "$LOGV")"; return 1; }
  printf 'ar=aaaaaaaa x\nPISO=%s\nVEREDITO=NADA_A_PUBLICAR\n' "$(cat "$TMP/head")" > "$TMP/decisao"
  LVT_MANTEM=1 roda retido; tem "fim do episódio RETIDO" && [ ! -f "$e/retido-episodio" ] && [ "$(avisos)" = 2 ] \
    || { echo "  fim: $(tail -2 "$LOGV")"; return 1; }
  [ "$CHAMADAS" = "" ] || { echo "  chamou o claude em RETIDO/NADA"; return 1; }
}
episodio && ok "RETIDO: 1 aviso por episódio, lembrete com a idade, fim do episódio logado" || nok "episódio RETIDO"
# falsificação com controle verde logo acima, na MESMA invocação: sem o `return 0` do lembrete, re-avisa a cada tick
# shellcheck disable=SC2016  # $((agora - ult)) e $RELEMBRA são LITERAIS do fonte sabotado
sed 's/\[ \$((agora - ult)) -ge "\$RELEMBRA" \] || return 0/true/' "$VIGIA" > "$TMP/vigia-sab.sh"
if cmp -s "$VIGIA" "$TMP/vigia-sab.sh"; then nok "sabotagem do episódio não casou"
elif ( VIGIA_SOB_TESTE="$TMP/vigia-sab.sh" episodio ) >/dev/null 2>&1; then nok "vigia sabotado (re-avisa todo tick) passou no roteiro do episódio"
else ok "falsificação: vigia que re-avisa a cada tick reprova o roteiro"; fi
rm -f "$TMP/decisao"

[ "$FALHAS" -eq 0 ] && { echo "TEST-LOVABLE-VIGIA: OK (12)"; exit 0; }
echo "TEST-LOVABLE-VIGIA: $FALHAS falha(s)"; exit 1
