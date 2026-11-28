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
OKS=0
ok()   { printf 'ok   %s\n' "$1"; OKS=$((OKS + 1)); }
nok()  { printf 'FALHA %s\n' "$1"; FALHAS=$((FALHAS + 1)); }

# ── binários falsos ────────────────────────────────────────────────────────────────────────────
mkdir -p "$TMP/bin"
printf '#!/bin/sh\necho token-falso\n' > "$TMP/bin/security"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/osascript"
# shellcheck disable=SC2016  # $LVT expande quando o gh FALSO roda
printf '#!/bin/sh\necho "$*" >> "$LVT/gh"\n[ -f "$LVT/gh-falha" ] && exit 1\nexit 0\n' > "$TMP/bin/gh"
# shellcheck disable=SC2016  # o $* e o $LVT são do bun FALSO, expandem quando ele roda
printf '#!/bin/sh\necho "$*" >> "$LVT/bun"\ncase "$*" in *pendencias:deploy*) [ -f "$LVT/pend-saida" ] && cat "$LVT/pend-saida" ;; *--prova-ledger*) [ -f "$LVT/prova-falha" ] && { echo boom; exit 1; }; echo "LEDGER e _shared/x.ts"; echo PROVA_LEDGER=0; exit 0 ;; esac\n[ -f "$LVT/bun_anda" ] && git -C "$LVT/origin" -c user.email=t@t -c user.name=t commit -q --allow-empty -m anda\nexit 0\n' > "$TMP/bin/bun"
# claude falso: conta chamadas, emite $CENARIO.jsonl; "deploy" real = cria $TMP/ar-novo
cat > "$TMP/bin/claude-falso" <<'EOF'
#!/usr/bin/env bash
cat > /dev/null
echo x >> "$LVT/chamadas"
printf '%s\n' "$*" > "$LVT/args"
printf '%s\n' "${CLAUDE_CONFIG_DIR:-}" > "$LVT/cfgdir"
cp intencao "$LVT/intencao-visto" 2>/dev/null || : > "$LVT/intencao-visto"   # cwd = $EST
n=$(wc -l < "$LVT/chamadas" | tr -d ' '); f="$LVT/stream-$LVT_CENARIO.jsonl"; [ -f "$LVT/stream-$LVT_CENARIO-$n.jsonl" ] && f="$LVT/stream-$LVT_CENARIO-$n.jsonl"
sed "s/@HEAD@/$(cat "$LVT/head")/g" "$f"
case "$LVT_CENARIO" in fabricado|divergente|needs_auth|sem_ar|gp_outro|le_e_cai|vazio) ;; *) touch "$LVT/ar-novo" ;; esac
[ "$LVT_CENARIO" = truncado ] && exit 124
[ "$LVT_CENARIO" = timeout_pos_deploy ] && exit 124
exit 0
EOF
chmod +x "$TMP/bin/"*

# ── streams gravados (formato real do claude 2.1.283, recortado) ────────────────────────────────
OUTRO=1111111111111111111111111111111111111111
init() { printf '{"type":"system","subtype":"init","mcp_servers":[{"name":"lovable","status":"%s"}],"tools":[]}\n' "$1"; }
PROJ=8f005805-000a-42b7-88a1-9683f785fab6
# uso <id> <ferramenta> [input] — input padrão = o do roteiro (project_id certo; deploy com name steu)
uso()  {
  local i=${3:-}; [ -n "$i" ] || case $2 in deploy_project) i="{\"project_id\":\"$PROJ\",\"name\":\"steu\"}" ;; *) i="{\"project_id\":\"$PROJ\"}" ;; esac
  printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"%s","name":"mcp__lovable__%s","input":%s}]}}\n' "$1" "$2" "$i"; }
res()  { printf '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"%s","content":[{"type":"image","source":{}},{"type":"text","text":"%s"}]}]}}\n' "$1" "$2"; }
fim()  { printf '{"type":"result","subtype":"success","result":"%s","total_cost_usd":0.01}\n' "$1"; }
gp()   { printf '{\\"id\\":\\"p\\",\\"latest_commit_sha\\":\\"%s\\"}' "$1"; }
{ init connected; uso t1 get_project; res t1 "$(gp @HEAD@)"; uso t2 deploy_project
  res t2 '{\"status\":\"pending\",\"deployment_id\":\"dep-123\"}'; fim "VIGIA=DISPARADO dep-123"; } > "$TMP/stream-ok.jsonl"
for c in ledger recibos sem_ar adiante_limpo adiante_camada ar_divergente lock store intencao buraco caches carimbo prova; do cp "$TMP/stream-ok.jsonl" "$TMP/stream-$c.jsonl"; done
DEPR='{\"status\":\"pending\",\"deployment_id\":\"dep-9\"}'
# PR 3 — controle do protocolo: cada stream tem deploy aceito (deployment_id lido), mas FORA do roteiro
{ init connected; uso t1 get_project; res t1 "$(gp @HEAD@)"; uso t2 deploy_project "{\"project_id\":\"$PROJ\",\"name\":\"outro\"}"; res t2 "$DEPR"; } > "$TMP/stream-viol_nome.jsonl"
{ init connected; uso t1 get_project; res t1 "$(gp @HEAD@)"; uso t2 deploy_project "{\"project_id\":\"x\",\"name\":\"steu\"}"; res t2 "$DEPR"; } > "$TMP/stream-viol_projeto.jsonl"
{ init connected; uso t1 get_project; uso t2 deploy_project; res t1 "$(gp @HEAD@)"; res t2 "$DEPR"; } > "$TMP/stream-viol_ordem.jsonl"
{ init connected; uso t2 deploy_project; res t2 "$DEPR"; } > "$TMP/stream-viol_sem_gp.jsonl"
{ init connected; uso t1 get_project; res t1 "$(gp "$OUTRO")"; uso t2 deploy_project; res t2 "$DEPR"; } > "$TMP/stream-viol_sha.jsonl"
{ init connected; uso t1 get_project; res t1 "$(gp @HEAD@)"; uso t2 deploy_project; res t2 "$DEPR"; uso t3 deploy_project; res t3 "$DEPR"; } > "$TMP/stream-viol_2x.jsonl"
# Codex PR3 #4: a main só num objeto ANINHADO; o latest_commit_sha da raiz é outro
{ init connected; uso t1 get_project; res t1 "{\\\"latest_commit_sha\\\":\\\"$OUTRO\\\",\\\"x\\\":{\\\"latest_commit_sha\\\":\\\"@HEAD@\\\"}}"; uso t2 deploy_project; res t2 "$DEPR"; } > "$TMP/stream-viol_campo.jsonl"
# formato REAL do texto (claude 2.1.x): "[Image: source: …]" colado antes do JSON
{ init connected; uso t1 get_project; res t1 "[Image: source: /x/blob.png]$(gp @HEAD@)"; uso t2 deploy_project; res t2 "$DEPR"; fim "VIGIA=DISPARADO dep-9"; } > "$TMP/stream-prefixo.jsonl"
# Codex PR3 #1: stream truncado (timeout) sem deploy visível e sem `result`
{ init connected; uso t1 get_project; res t1 "$(gp @HEAD@)"; } > "$TMP/stream-truncado.jsonl"
# Codex PR3 #8: get_project de OUTRO projeto não vale como leitura
{ init connected; uso t1 get_project '{"project_id":"x"}'; res t1 "$(gp "$OUTRO")"; fim "VIGIA=NAO_SINCRONIZADO"; } > "$TMP/stream-gp_outro.jsonl"
# Codex PR3 #9: 1ª chamada lê a main e cai sem deploy; a 2ª volta em needs-auth
{ init connected; uso t1 get_project; res t1 "$(gp @HEAD@)"; fim "VIGIA=ERRO x"; } > "$TMP/stream-le_e_cai-1.jsonl"
{ init needs-auth; fim "VIGIA=ERRO x"; } > "$TMP/stream-le_e_cai-2.jsonl"; cp "$TMP/stream-le_e_cai-2.jsonl" "$TMP/stream-le_e_cai.jsonl"
for c in issue tardia; do cp "$TMP/stream-ok.jsonl" "$TMP/stream-$c.jsonl"; done
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
if [ "$1" = --decidir ] && [ -n "${LP_AR_FALLBACK:-}" ] && [ -f "$LVT/decisao-fb" ]; then
  echo "$LP_AR_FALLBACK" >> "$LVT/fb-visto"; cat "$LVT/decisao-fb"; exit 0
fi
if [ "$1" = --decidir ] && [ -f "$LVT/decisao" ]; then
  if [ -f "$LVT/decisao-pos" ] && { ls "$LP_ESTADO"/pendencias-* || ls "$LP_ESTADO"/recibos-[0-9a-f]*; } >/dev/null 2>&1; then cat "$LVT/decisao-pos"; else cat "$LVT/decisao"; fi
  exit 0
fi
if [ -f "$LVT/ar-fixo" ]; then echo "ar=$(cat "$LVT/ar-fixo") x"; echo VEREDITO=MECANICA
elif [ -f "$LVT/ar-novo" ] && [ -f "$LVT/ar-alvo" ]; then echo "ar=$(cat "$LVT/ar-alvo") x"; echo VEREDITO=MECANICA
elif [ -f "$LVT/ar-novo" ]; then echo "ar=$(cut -c1-8 "$LVT/head") x"; echo VEREDITO=JA_NO_AR
else echo "ar=aaaaaaaa x"; echo VEREDITO=PUBLICAR; fi
EOF
# recibos falso: 0 na 1ª leitura; com $LVT/revoga, a 2ª (a releitura antes do disparo) vem 1
# shellcheck disable=SC2016  # o $1/$2/$LVT são do script FALSO, expandem quando ele roda
printf '#!/usr/bin/env bash\necho "$1 $2" > "$LVT/recibos-args"; echo x >> "$LVT/recibos-n"\nif [ -f "$LVT/revoga" ] && [ "$(wc -l < "$LVT/recibos-n")" -ge 2 ]; then echo 1; else echo 0; fi\necho "aplicada supabase/migrations/9_z.sql abcdef012345"\n' > "$TMP/origin/scripts/lovable-recibos.sh"
git -C "$TMP/origin" add -A && git -C "$TMP/origin" -c user.email=t@t -c user.name=t commit -qm base
git -C "$TMP/origin" rev-parse HEAD > "$TMP/head"

roda() {  # roda <cenario> → um tick do vigia num estado novo (LVT_MANTEM=1: mesmo estado do tick anterior)
  local c=$1 est="$TMP/est-$1"
  [ "${LVT_MANTEM:-0}" = 1 ] || rm -rf "$est"
  rm -rf "$TMP/wt" "$TMP/chamadas" "$TMP/ar-novo" "$TMP/intencao-visto"; mkdir -p "$est"
  git clone -q "$TMP/origin" "$TMP/wt"
  # PR 4: a main anda DEPOIS do clone → o vigia tem de buscar (o clone não tem o commit)
  [ "${LVT_ANDA_POS_CLONE:-0}" = 1 ] && { git -C "$TMP/origin" -c user.email=t@t -c user.name=t commit -q --allow-empty -m pos-clone; echo pos > "$TMP/origin/marca-pos"; git -C "$TMP/origin" add marca-pos; git -C "$TMP/origin" -c user.email=t@t -c user.name=t commit -q -m pos-clone-arquivo; git -C "$TMP/origin" rev-parse HEAD > "$TMP/head"; }
  # Codex PR4 #2: decisor do clone adulterado no disco (HEAD = main) → o vigia tem de rodar o da main
  [ "${LVT_SUJA:-0}" = 1 ] && printf '#!/bin/sh\necho VEREDITO=PUBLICAR_ADULTERADO\n' > "$TMP/wt/scripts/lovable-publish.sh"
  cp "${VIGIA_SOB_TESTE:-$VIGIA}" "$TMP/vigia.sh"
  # PR 3: store próprio é obrigatório — todo cenário o tem, salvo LVT_SEM_STORE=1
  rm -rf "$TMP/cfg"; [ "${LVT_SEM_STORE:-0}" = 1 ] || { mkdir -p "$TMP/cfg" && touch "$TMP/cfg/.vigia-pronto"; }
  LVT="$TMP" LVT_CENARIO="$c" LV_ESTADO="$est" LV_WT="$TMP/wt" LV_ESPERA_AR="${LVT_ESPERA:-20}" LV_PASSO_AR=1 \
    LV_CLAUDE="$TMP/bin/claude-falso" LV_CLAUDE_DIR="$TMP/cfg" PATH="$TMP/bin:$PATH" bash "$TMP/vigia.sh"
  CHAMADAS=$({ wc -l < "$TMP/chamadas"; } 2>/dev/null | tr -d ' '); LOGV="$est/vigia.log"; TENT="$est/tentativa"
}
tem() { grep -qF -- "$1" "$LOGV"; }

roda ok
{ [ "$CHAMADAS" = 1 ] && tem "→ DISPARADO dep-123" && tem "PUBLICADO" && [ ! -f "$TENT" ]; } \
  && ok "deploy com aceite lido → DISPARADO, 1 chamada, PUBLICADO" || nok "ok: chamadas=$CHAMADAS $(tail -3 "$LOGV")"
grep -q -- '--strict-mcp-config' "$TMP/args" && grep -q -- '--tools  --setting-sources' "$TMP/args" \
  && ok "invocação mínima (--strict-mcp-config, --tools vazio, --setting-sources vazio)" || nok "args: $(cat "$TMP/args")"

[ "$(cat "$TMP/cfgdir")" = "$TMP/cfg" ] && ok "com .vigia-pronto → CLAUDE_CONFIG_DIR próprio" || nok "cfgdir=$(cat "$TMP/cfgdir")"
case "$(cat "$TMP/intencao-visto")" in "sha=$(cat "$TMP/head") hora="*" tentativa=1 ar=aaaaaaaa") ok "intenção gravada ANTES da chamada (sha, hora, tentativa, ar)" ;;
  *) nok "intenção vista pelo claude: '$(cat "$TMP/intencao-visto")'" ;; esac
[ ! -f "$TMP/est-ok/intencao" ] && ok "PUBLICADO resolve a intenção" || nok "intenção sobrou: $(cat "$TMP/est-ok/intencao")"

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

# PR 2: migration no intervalo → o vigia lê os recibos (lovable-recibos.sh ar head), grava o cache e publica
AR40=2222222222222222222222222222222222222222
printf 'ar=22222222 x\nAR=%s\nRECIBOS_DE=%s\n  migration sem atestação\nVEREDITO=PRECISA_RECIBOS\n' "$AR40" "$AR40" > "$TMP/decisao"
printf 'ar=22222222 x\nAR=%s\nRECIBOS_DE=%s\nLIBERADO=recibos ar=22222222\nVEREDITO=PUBLICAR\n' "$AR40" "$AR40" > "$TMP/decisao-pos"
rm -f "$TMP/recibos-n"; roda recibos
{ [ "$(cat "$TMP/recibos-args")" = "$AR40 $(cat "$TMP/head")" ] && [ "$(head -1 "$TMP/est-recibos/recibos-$AR40-$(cat "$TMP/head")")" = 0 ] \
  && tem "recibos ar=22222222" && tem "liberado: recibos" && tem "PUBLICADO" && [ ! -f "$TMP/est-recibos/piso" ]; } \
  && ok "PRECISA_RECIBOS → recibos gravados por (ar, head), decide de novo e publica sem liberar manual" || nok "recibos: $(tail -3 "$LOGV")"
# Codex PR2 #4: revogado entre a 1ª leitura e o disparo → a releitura segura, sem chamar o claude
rm -f "$TMP/recibos-n"; touch "$TMP/revoga"; roda recibos; rm -f "$TMP/revoga"
{ tem "recibos relidos antes do disparo: veredito 1" && [ "$CHAMADAS" = "" ] && ! tem "PUBLICADO"; } \
  && ok "recibo revogado antes do disparo → não dispara" || nok "revoga: $(tail -3 "$LOGV")"
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
sed 's/\[ \$((agora - ult)) -ge "\$rel" \] || return 0/true/' "$VIGIA" > "$TMP/vigia-sab.sh"
if cmp -s "$VIGIA" "$TMP/vigia-sab.sh"; then nok "sabotagem do episódio não casou"
elif ( VIGIA_SOB_TESTE="$TMP/vigia-sab.sh" episodio ) >/dev/null 2>&1; then nok "vigia sabotado (re-avisa todo tick) passou no roteiro do episódio"
else ok "falsificação: vigia que re-avisa a cada tick reprova o roteiro"; fi
rm -f "$TMP/decisao"

# ═══ PR 3 — disparo à prova de erro ═════════════════════════════════════════════════════════════
# store próprio obrigatório: sem .vigia-pronto não chama o claude; 1 aviso por episódio; fim logado
r_store() {
  LVT_SEM_STORE=1 roda store; [ "$CHAMADAS" = "" ] && tem "AVISO: store próprio do claude ausente" || { echo "  1º: $(tail -2 "$LOGV")"; return 1; }
  LVT_SEM_STORE=1 LVT_MANTEM=1 roda store; [ "$(avisos)" = 1 ] && [ "$CHAMADAS" = "" ] || { echo "  2º re-avisou/chamou"; return 1; }
  LVT_MANTEM=1 roda store; tem "fim do episódio sem-store" && tem "PUBLICADO" || { echo "  fim: $(tail -2 "$LOGV")"; return 1; }
}
avisos() { grep -c 'AVISO: ' "$LOGV"; }
r_store && ok "sem store próprio → PARA sem chamar o claude, 1 aviso por episódio, fim ao voltar" || nok "store obrigatório"

# controle determinístico: deploy aceito mas fora do roteiro → VIOLACAO, sem PUBLICADO, desiste do SHA
for c in viol_nome viol_projeto viol_ordem viol_sem_gp viol_sha viol_2x viol_campo; do
  roda "$c"
  { [ "$CHAMADAS" = 1 ] && tem "→ VIOLACAO" && ! tem "PUBLICADO" && tem "FALHOU (3/3)" && tem "AVISO: claude -p saiu do roteiro" \
    && [ -f "$TMP/est-$c/intencao" ]; } \
    && ok "controle: $c → VIOLACAO ($(sed -n 's/.*→ VIOLACAO \(.*\) (modelo.*/\1/p' "$LOGV" | head -1))" || nok "$c: $(tail -2 "$LOGV")"
done
# shellcheck disable=SC2329  # chamada via falsifica "$3"
r_controle() { roda viol_nome; tem "→ VIOLACAO" && ! tem "PUBLICADO"; }
roda prefixo; tem "→ DISPARADO dep-9" && tem "PUBLICADO" && ok "texto real com prefixo [Image: …] → controle OK, PUBLICADO" || nok "prefixo: $(tail -2 "$LOGV")"
r_truncado() { roda truncado; [ "$CHAMADAS" = 1 ] && tem "rc=124" && tem "→ INDETERMINADO" && ! tem "intenção" ; }
: > "$TMP/stream-vazio.jsonl"; roda vazio
{ [ "$CHAMADAS" = 2 ] && tem "→ ERRO" && [ ! -f "$TMP/est-vazio/intencao" ]; } && ok "stream vazio (sem init) → nada rodou: ERRO, 2ª chamada, intenção resolvida" || nok "vazio: chamadas=$CHAMADAS $(tail -2 "$LOGV")"
r_truncado && ok "stream truncado sem deploy visível → INDETERMINADO, SEM 2ª chamada" || nok "truncado: chamadas=$CHAMADAS $(tail -2 "$LOGV")"
roda gp_outro
{ [ "$CHAMADAS" = 2 ] && tem "→ ERRO" && ! tem "→ NAO_SINCRONIZADO" && tem "FALHOU (1/3)"; } \
  && ok "get_project de outro projeto não vale como leitura (ERRO, não NAO_SINCRONIZADO eterno)" || nok "gp_outro: chamadas=$CHAMADAS $(tail -2 "$LOGV")"
r_le_e_cai() { local e="$TMP/est-le_e_cai"; rm -rf "$e"; mkdir -p "$e"; date +%s > "$e/needs-auth"
  LVT_MANTEM=1 roda le_e_cai; [ "$CHAMADAS" = 2 ] && tem "→ NEEDS_AUTH" && tem "AVISO: MCP lovable em needs-auth"; }
r_le_e_cai && ok "leitura OK na 1ª chamada encerra o episódio needs-auth mesmo se a 2ª cair nele (novo aviso)" || nok "le_e_cai: $(tail -2 "$LOGV")"
# Issue de desistência: gh falhou → fica pendente; o tick seguinte re-tenta e abre
r_issue() { local e="$TMP/est-issue"; rm -f "$TMP/gh"; touch "$TMP/gh-falha"; roda viol_nome; cp -R "$TMP/est-viol_nome/." "$e/" 2>/dev/null || { mkdir -p "$e"; cp -R "$TMP/est-viol_nome/." "$e/"; }
  rm -f "$TMP/gh-falha"; [ -f "$e/issue-pendente" ] && tem "Issue NÃO abriu" || return 1
  rm -f "$e/issue-tentada" "$e/vigia.log"; LVT_MANTEM=1 roda issue; tem "Issue aberta" && [ ! -f "$e/issue-pendente" ] && [ "$(grep -c 'issue create' "$TMP/gh")" = 2 ]; }
r_issue && ok "Issue que não abriu fica pendente e o tick seguinte a abre" || nok "issue: $(tail -2 "$LOGV") | gh=$(cat "$TMP/gh" 2>&1 | head -c 200)"

# intenção: disparado sem o ar mudar → fica com o deployment_id; bloqueia redisparo até o ar mudar ou vencer
# shellcheck disable=SC2329  # chamada via falsifica "$3"
r_backoff() { LVT_ESPERA=4 roda sem_ar; FIM=$(date +%s); PROX=$(cut -d' ' -f3 "$TMP/est-sem_ar/tentativa"); [ "$PROX" -ge $((FIM + 299)) ]; }
LVT_ESPERA=4 roda sem_ar; FIM=$(date +%s)
{ tem "→ DISPARADO dep-123" && tem "FALHOU (1/3)" && grep -q ' dep=dep-123$' "$TMP/est-sem_ar/intencao"; } \
  && ok "deploy sem efeito no ar → FALHOU, intenção fica com dep=dep-123" || nok "sem_ar: $(tail -2 "$LOGV") | $(cat "$TMP/est-sem_ar/intencao" 2>&1)"
PROX=$(cut -d' ' -f3 "$TMP/est-sem_ar/tentativa")
[ "$PROX" -ge $((FIM + 299)) ] && ok "backoff conta do FIM da falha (próx=$((PROX - FIM))s após o fim)" || nok "backoff: próx $((PROX - FIM))s após o fim"
r_intencao() {  # intenção fresca com o ar igual → nenhum disparo, mesmo sem backoff
  local e="$TMP/est-intencao"; rm -rf "$e"; mkdir -p "$e"
  echo "sha=$(cat "$TMP/head") hora=$(date +%s) tentativa=1 ar=aaaaaaaa" > "$e/intencao"
  LVT_MANTEM=1 roda intencao; [ "$CHAMADAS" = "" ] && tem "intenção pendente" && [ -f "$e/intencao" ]
}
r_intencao && ok "intenção pendente (ar igual, dentro do prazo) → não redispara" || nok "intenção pendente: $(tail -2 "$LOGV")"
echo "sha=x hora=$(( $(date +%s) - 5000 )) tentativa=1 ar=aaaaaaaa" > "$TMP/est-intencao/intencao"
LVT_MANTEM=1 roda intencao
{ tem "intenção expirou sem efeito no ar" && [ "$CHAMADAS" = 1 ] && tem "PUBLICADO"; } && ok "intenção vencida pelo relógio → dispara de novo" || nok "expirada: $(tail -2 "$LOGV")"
echo "sha=x hora=$(date +%s) tentativa=1 ar=bbbbbbbb" > "$TMP/est-intencao/intencao"
LVT_MANTEM=1 roda intencao
{ tem "intenção resolvida pelo ar" && [ "$CHAMADAS" = 1 ]; } && ok "intenção resolvida pelo ar (ar ≠ ar da intenção) → segue" || nok "resolvida: $(tail -2 "$LOGV")"
e="$TMP/est-tardia"; rm -rf "$e"; mkdir -p "$e"; echo "sha=$(cat "$TMP/head") hora=$(date +%s) tentativa=1 ar=aaaaaaaa" > "$e/intencao"
echo deadbeef > "$TMP/ar-fixo"; LVT_MANTEM=1 roda tardia; rm -f "$TMP/ar-fixo"
{ tem "intenção resolvida pelo ar" && tem "AR DIVERGENTE ar=deadbeef" && [ -f "$e/alerta-divergente" ] && [ ! -f "$e/intencao" ]; } \
  && ok "intenção resolvida num tick POSTERIOR por ar divergente → alerta persistente" || nok "tardia: $(tail -2 "$LOGV")"
roda fabricado; [ ! -f "$TMP/est-fabricado/intencao" ] && ok "stream sem deploy_project → intenção resolvida (nada escrito)" || nok "fabricado deixou intenção"

# reconciliação do SHA que entrou no ar: descendente limpo / com camada / divergente (alerta persistente)
git -C "$TMP/origin" checkout -q -b adiante
mkdir -p "$TMP/origin/src" "$TMP/origin/supabase/migrations"
echo a > "$TMP/origin/src/a.txt"; git -C "$TMP/origin" add -A; git -C "$TMP/origin" -c user.email=t@t -c user.name=t commit -qm a1
A1=$(git -C "$TMP/origin" rev-parse HEAD)
echo 'select 1;' > "$TMP/origin/supabase/migrations/9_x.sql"; git -C "$TMP/origin" add -A; git -C "$TMP/origin" -c user.email=t@t -c user.name=t commit -qm a2
A2=$(git -C "$TMP/origin" rev-parse HEAD)
git -C "$TMP/origin" checkout -q main
echo "${A1:0:8}" > "$TMP/ar-alvo"; roda adiante_limpo
{ tem "PUBLICADO_ADIANTE ar=${A1:0:8}" && ! tem "FALHOU" && [ ! -f "$TMP/est-adiante_limpo/intencao" ] && [ "$(avisos)" = 0 ]; } \
  && ok "ar descendente limpo → PUBLICADO_ADIANTE, sem aviso" || nok "adiante_limpo: $(tail -2 "$LOGV")"
echo "${A2:0:8}" > "$TMP/ar-alvo"; roda adiante_camada
{ tem "COM camada no meio (supabase/migrations/9_x.sql)" && tem "AVISO: o ar foi a ${A2:0:8} (adiante da main)" && ! tem "FALHOU"; } \
  && ok "ar descendente COM camada → aviso nomeando a camada" || nok "adiante_camada: $(tail -2 "$LOGV")"
echo deadbeef > "$TMP/ar-alvo"; roda ar_divergente; E="$TMP/est-ar_divergente"
{ tem "AR DIVERGENTE ar=deadbeef" && grep -q '^ar=deadbeef main=' "$E/alerta-divergente" && [ "$(grep -c 'NÃO descende' "$LOGV")" = 1 ]; } \
  && ok "ar divergente → alerta PERSISTENTE em arquivo + aviso" || nok "divergente: $(tail -2 "$LOGV")"
rm -f "$TMP/ar-alvo"; echo deadbeef > "$TMP/ar-fixo"; LVT_MANTEM=1 roda ar_divergente
{ [ -f "$E/alerta-divergente" ] && [ "$(grep -c 'AVISO: o ar foi a deadbeef' "$LOGV")" = 1 ]; } \
  && ok "alerta divergente persiste no tick seguinte sem re-avisar" || nok "persistência: $(tail -2 "$LOGV")"
rm -f "$TMP/ar-fixo"; LVT_MANTEM=1 roda ar_divergente
{ tem "fim do alerta de ar divergente" && [ ! -f "$E/alerta-divergente" ]; } && ok "ar sai do SHA divergente → fim do alerta logado" || nok "fim do alerta: $(tail -2 "$LOGV")"

# ═══ Rodada 2 — PR A ════════════════════════════════════════════════════════════════════════════
# B2: a releitura dos recibos (cache vencido) não pode apagar a memória do dedup — 1 linha por conteúdo
r_dedup() {
  local e="$TMP/est-dedup" n
  printf 'ar=22222222 x\nAR=%s\nRECIBOS_DE=%s\nVEREDITO=PRECISA_RECIBOS\n' "$AR40" "$AR40" > "$TMP/decisao"
  printf 'ar=22222222 x\nAR=%s\nRECIBOS_DE=%s\nRETIDO=migration:supabase/migrations/9_z.sql\nVEREDITO=RETIDO\n' "$AR40" "$AR40" > "$TMP/decisao-pos"
  rm -f "$TMP/recibos-n"; roda dedup
  rm -f "$e/recibos-$AR40-$(cat "$TMP/head")"; LVT_MANTEM=1 roda dedup     # o cache venceu: relê o banco
  rm -f "$e/recibos-$AR40-$(cat "$TMP/head")"; LVT_MANTEM=1 roda dedup
  n=$(grep -c 'recibos ar=22222222' "$LOGV"); rm -f "$TMP/decisao" "$TMP/decisao-pos"
  [ "$(wc -l < "$TMP/recibos-n" | tr -d ' ')" = 3 ] && [ "$n" = 1 ] && [ -f "$e/recibos-ultimo" ]
}
r_dedup && ok "B2: 3 releituras dos recibos com o mesmo conteúdo → 1 linha no log (recibos-ultimo sobrevive)" || nok "dedup: $(grep -c 'recibos ar=' "$LOGV") linhas"
# B4: MECANICA é episódio — 1 aviso, lembrete com a idade (1 h), fim logado quando a medida volta
MEC='ar= x
  motivo: CARIMBO_INVALIDO: 0 carimbos em /assets/index-X.js
VEREDITO=MECANICA'
r_mecanica() {
  local e="$TMP/est-mecanica"
  printf '%s\n' "$MEC" > "$TMP/decisao"
  roda mecanica; [ "$(avisos)" = 1 ] && tem "AVISO: MECANICA: julgamento sem medida (CARIMBO_INVALIDO: 0 carimbos" || { echo "  1º: $(tail -2 "$LOGV")"; return 1; }
  LVT_MANTEM=1 roda mecanica; [ "$(avisos)" = 1 ] && [ "$(grep -c 'MECANICA CARIMBO_INVALIDO' "$LOGV")" = 1 ] || { echo "  2º re-avisou/re-logou"; return 1; }
  echo "$(( $(date +%s) - 7300 )) $(( $(date +%s) - 3700 ))" > "$e/mecanica-episodio"
  LVT_MANTEM=1 roda mecanica; [ "$(avisos)" = 2 ] && tem "AVISO: AINDA MECANICA há 2h (CARIMBO_INVALIDO" || { echo "  lembrete: $(tail -2 "$LOGV")"; return 1; }
  printf 'ar=aaaaaaaa x\nVEREDITO=NADA_A_PUBLICAR\n' > "$TMP/decisao"
  LVT_MANTEM=1 roda mecanica; rm -f "$TMP/decisao"
  tem "fim do episódio MECANICA após 121 min" && [ ! -f "$e/mecanica-episodio" ] || { echo "  fim: $(tail -2 "$LOGV")"; return 1; }
}
r_mecanica && ok "B4: MECANICA = episódio (1 aviso, lembrete 2h, fim)" || nok "episódio MECANICA"
# B3: liberar que o ar ULTRAPASSOU é apagado e logado; liberar À FRENTE do ar fica
r_lib_ultra() {
  local e="$TMP/est-libultra"; rm -rf "$e"; mkdir -p "$e"; echo "$A1" > "$e/liberar"
  printf 'ar=%s x\nAR=%s\nVEREDITO=NADA_A_PUBLICAR\n' "${A2:0:8}" "$A2" > "$TMP/decisao"
  LVT_MANTEM=1 roda libultra; [ ! -f "$e/liberar" ] && tem "liberar ${A1:0:8} apagado: o ar (${A2:0:8}) já o ultrapassou" || { rm -f "$TMP/decisao"; return 1; }
  echo "$A2" > "$e/liberar"; printf 'ar=%s x\nAR=%s\nVEREDITO=NADA_A_PUBLICAR\n' "${A1:0:8}" "$A1" > "$TMP/decisao"
  LVT_MANTEM=1 roda libultra; rm -f "$TMP/decisao"; [ "$(cat "$e/liberar")" = "$A2" ]
}
r_lib_ultra && ok "B3: liberar ultrapassado pelo ar → apagado e logado; à frente do ar → fica" || nok "lib_ultra: $(tail -2 "$LOGV")"
# M9: o ar mudou sem intenção do vigia → JA_NO_AR por fora; com intenção pendente, não
r_por_fora() {
  local e="$TMP/est-porfora"; rm -rf "$e"
  printf 'ar=%s x\nAR=%s\nVEREDITO=NADA_A_PUBLICAR\n' "${A1:0:8}" "$A1" > "$TMP/decisao"; roda porfora
  ! tem "por fora" && [ "$(cat "$e/ar-ultimo")" = "$A1" ] || { rm -f "$TMP/decisao"; echo "  1º tick"; return 1; }
  printf 'ar=%s x\nAR=%s\nVEREDITO=JA_NO_AR\n' "${A2:0:8}" "$A2" > "$TMP/decisao"; LVT_MANTEM=1 roda porfora
  tem "JA_NO_AR por fora (ar ${A1:0:8}→${A2:0:8})" || { rm -f "$TMP/decisao"; echo "  2º: $(tail -2 "$LOGV")"; return 1; }
  echo "sha=$A1 hora=$(date +%s) tentativa=1 ar=${A2:0:8}" > "$e/intencao"
  printf 'ar=%s x\nAR=%s\nVEREDITO=JA_NO_AR\n' "${A1:0:8}" "$A1" > "$TMP/decisao"; LVT_MANTEM=1 roda porfora; rm -f "$TMP/decisao"
  [ "$(grep -c 'por fora' "$LOGV")" = 1 ]
}
r_por_fora && ok "M9: ar trocado sem intenção → 'JA_NO_AR por fora (ar A→B)'; com intenção, calado" || nok "por_fora: $(tail -2 "$LOGV")"
# M6: batimento a cada tick; acordar depois de um buraco > 5 min loga o tamanho
r_buraco() {
  local e="$TMP/est-buraco"; rm -rf "$e"; mkdir -p "$e"; echo $(( $(date +%s) - 1000 )) > "$e/batimento"
  LVT_MANTEM=1 roda buraco; tem "acordei após buraco de 16 min sem tick" || return 1
  [ $(( $(date +%s) - $(cat "$e/batimento") )) -lt 60 ] || return 1
  LVT_MANTEM=1 roda buraco; [ "$(grep -c 'acordei após buraco' "$LOGV")" = 1 ]
}
r_buraco && ok "M6: batimento renovado a cada tick; buraco de 16 min logado 1x" || nok "buraco: $(tail -2 "$LOGV")"
# M13: avisados com teto; caches de outra main apagados (recibos-ultimo fica); stream que falhou guardado
r_teto() {
  local e="$TMP/est-teto"; rm -rf "$e"; mkdir -p "$e"; seq 1 250 | sed 's/^/chave-/' > "$e/avisados"
  LVT="$TMP" LV_ESTADO="$e" LV_WT="$TMP/nao-existe" PATH="$TMP/bin:$PATH" bash "${VIGIA_SOB_TESTE:-$VIGIA}"
  [ "$(wc -l < "$e/avisados" | tr -d ' ')" -le 101 ] && tail -1 "$e/avisados" | grep -qx sem-repo
}
r_teto && ok "M13: avisados com 251 chaves → teto (fica com as 100 mais novas)" || nok "teto: $(wc -l < "$TMP/est-teto/avisados")"
r_caches() {
  local e="$TMP/est-caches" h; rm -rf "$e"; mkdir -p "$e"; h=$(cat "$TMP/head")
  echo 0 > "$e/pendencias-$OUTRO"; echo 0 > "$e/recibos-$AR40-$OUTRO"; echo x > "$e/recibos-ultimo"; echo 0 > "$e/recibos-$AR40-$h"
  LVT_MANTEM=1 roda caches
  [ ! -f "$e/pendencias-$OUTRO" ] && [ ! -f "$e/recibos-$AR40-$OUTRO" ] && [ -f "$e/recibos-ultimo" ] && [ -f "$e/recibos-$AR40-$h" ]
}
# shellcheck disable=SC2012  # diagnóstico do teste, nomes fixos
r_caches && ok "M13: caches de outra main apagados; os da main atual e o recibos-ultimo ficam" || nok "caches: $(ls "$TMP/est-caches" | tr '\n' ' ')"
roda fabricado; [ -s "$TMP/est-fabricado/claude-falha.jsonl" ] && ok "M13: stream que não disparou guardado em claude-falha.jsonl" || nok "claude-falha.jsonl ausente"
roda ok; [ ! -f "$TMP/est-ok/claude-falha.jsonl" ] && ok "M13: stream que disparou não vira claude-falha.jsonl" || nok "ok gravou claude-falha"
# M4: db-aplicar grava `aplicada` → apaga os caches de recibo do vigia (o próximo tick relê o banco)
mkdir -p "$TMP/dba"; git init -q "$TMP/dba"; echo 'select 1;' > "$TMP/dba/m.sql"
git -C "$TMP/dba" add m.sql && git -C "$TMP/dba" -c user.email=t@t -c user.name=t commit -qm m
cat > "$TMP/bin/psql-rw-falso" <<'FALSO'
#!/usr/bin/env bash
case "$*" in
  *SONDA_RW_OK*) echo 'SONDA_RW_OK:claude_rw' ;;
  *string_agg*) echo inedito ;;
  *"insert into public.db_aplicacoes"*) echo 7 ;;
  *" -f "*) echo 'FIM_APLICACAO_OK' ;;
esac
exit 0
FALSO
chmod +x "$TMP/bin/psql-rw-falso"
r_m4() {
  local v="$TMP/dba-vigia"; rm -rf "$v"; mkdir -p "$v"; echo 0 > "$v/recibos-$AR40-$OUTRO"; echo x > "$v/recibos-ultimo"
  (cd "$TMP/dba" && AFIACAO_PSQL_RW="$TMP/bin/psql-rw-falso" LP_VIGIA_ESTADO="$v" TMPDIR="$TMP/" bash "${DBA_SOB_TESTE:-$RAIZ/scripts/db-aplicar.sh}" m.sql) >/dev/null 2>&1 || return 1
  [ ! -f "$v/recibos-$AR40-$OUTRO" ] && [ -f "$v/recibos-ultimo" ]
}
r_m4 && ok "M4: db:aplicar com recibo aplicada → caches de recibo do vigia apagados (recibos-ultimo fica)" || nok "m4"

# ═══ Rodada 2 — PR B ════════════════════════════════════════════════════════════════════════════
# B1: carimbo inválido por N ticks → julga do ar-ultimo (gate inteiro) e publica; sem ar-ultimo, fail-closed
r_carimbo() {
  local e="$TMP/est-carimbo"; rm -rf "$e"; mkdir -p "$e"; rm -f "$TMP/fb-visto"
  echo "$A1" > "$e/ar-ultimo"; echo 4 > "$e/carimbo-invalido"; printf '%s\n' "$MEC" > "$TMP/decisao"
  printf '  ar sem carimbo válido (x)\nAR_FALLBACK=%s\nar=%s x\nAR=%s\nVEREDITO=PUBLICAR\n' "$A1" "${A1:0:8}" "$A1" > "$TMP/decisao-fb"
  LVT_MANTEM=1 roda carimbo; rm -f "$TMP/decisao" "$TMP/decisao-fb"
  [ "$(cat "$TMP/fb-visto" 2>/dev/null)" = "$A1" ] && tem "carimbo inválido há 5 ticks — julgo a partir do ar-ultimo ${A1:0:8}" \
    && tem "PUBLICAR sem-carimbo.." && [ "$CHAMADAS" = 1 ] && tem "PUBLICADO"
}
r_carimbo && ok "B1: 5 ticks sem carimbo → decide do ar-ultimo e publica (o carimbo volta)" || nok "carimbo: $(tail -3 "$LOGV")"
r_carimbo_sem() {
  local e="$TMP/est-carimbo"; rm -rf "$e"; mkdir -p "$e"; rm -f "$TMP/fb-visto"
  echo 4 > "$e/carimbo-invalido"; printf '%s\n' "$MEC" > "$TMP/decisao"
  printf 'AR_FALLBACK=x\nVEREDITO=PUBLICAR\n' > "$TMP/decisao-fb"
  LVT_MANTEM=1 roda carimbo; rm -f "$TMP/decisao" "$TMP/decisao-fb"
  tem "sem ar-ultimo — fail-closed" && [ "$CHAMADAS" = "" ] && [ ! -f "$TMP/fb-visto" ]
}
r_carimbo_sem && ok "B1: sem ar-ultimo → fail-closed (MECANICA, sem disparo)" || nok "carimbo_sem: $(tail -3 "$LOGV")"
r_carimbo_cedo() {
  local e="$TMP/est-carimbo"; rm -rf "$e"; mkdir -p "$e"; rm -f "$TMP/fb-visto"
  echo "$A1" > "$e/ar-ultimo"; printf '%s\n' "$MEC" > "$TMP/decisao"; printf 'VEREDITO=PUBLICAR\n' > "$TMP/decisao-fb"
  LVT_MANTEM=1 roda carimbo; rm -f "$TMP/decisao" "$TMP/decisao-fb"
  [ "$(cat "$e/carimbo-invalido")" = 1 ] && [ "$CHAMADAS" = "" ] && [ ! -f "$TMP/fb-visto" ]
}
r_carimbo_cedo && ok "B1: 1º tick sem carimbo → só conta (nada de fallback antes de N)" || nok "carimbo_cedo: $(tail -2 "$LOGV")"
# B5: RETIDO que acaba em JA_NO_AR → aviso de camada não atestada + divida-camadas; acabar em NADA não é dívida
RET5='ar=aaaaaaaa x
Camadas pendentes até x (ar=aaaaaaaa; aplicar ANTES do Publish — DDL → edges):
  - supabase/functions/_shared/x.ts
Commits:
  - abc1234 feat x
RETIDO=edge:supabase/functions/_shared/x.ts
VEREDITO=RETIDO'
r_divida() {
  local e="$TMP/est-divida"; rm -rf "$e"
  printf '%s\n' "$RET5" > "$TMP/decisao"; roda divida
  printf 'ar=%s x\nVEREDITO=JA_NO_AR\n' "$(cut -c1-8 "$TMP/head")" > "$TMP/decisao"; LVT_MANTEM=1 roda divida
  tem "AVISO: publicado por fora com camada não atestada: supabase/functions/_shared/x.ts" \
    && grep -q 'camadas=supabase/functions/_shared/x.ts$' "$e/divida-camadas" || { rm -f "$TMP/decisao"; return 1; }
  printf '%s\n' "$RET5" > "$TMP/decisao"; LVT_MANTEM=1 roda divida
  printf 'ar=aaaaaaaa x\nVEREDITO=NADA_A_PUBLICAR\n' > "$TMP/decisao"; LVT_MANTEM=1 roda divida; rm -f "$TMP/decisao"
  [ "$(wc -l < "$e/divida-camadas" | tr -d ' ')" = 1 ] && [ ! -f "$e/retido-camadas" ]
}
r_divida && ok "B5: RETIDO → JA_NO_AR registra a dívida e avisa; → NADA_A_PUBLICAR não" || nok "divida: $(tail -3 "$LOGV")"

# ═══ Rodada 2 — PR C ════════════════════════════════════════════════════════════════════════════
# M1: _shared no intervalo → o vigia grava a prova do fecho (sonda-fan-out --prova-ledger) por (base, head)
r_prova() {
  local e="$TMP/est-prova" h; rm -rf "$e"; h=$(cat "$TMP/head")
  printf 'ar=22222222 x\nAR=%s\nPROVA_DE=%s\nVEREDITO=PRECISA_LEDGER\n' "$AR40" "$AR40" > "$TMP/decisao"
  printf 'ar=22222222 x\nLIBERADO=ledger ar=22222222\nVEREDITO=PUBLICAR\n' > "$TMP/decisao-pos"
  rm -f "$TMP/bun"; roda prova; rm -f "$TMP/decisao" "$TMP/decisao-pos"
  grep -q -- "--prova-ledger --base $AR40 --head $h" "$TMP/bun" && [ "$(head -1 "$e/shared-$AR40-$h")" = 0 ] \
    && tem "prova do _shared 22222222..$(cut -c1-8 "$TMP/head"): PROVA_LEDGER=0" && tem "PUBLICADO"
}
r_prova && ok "M1: PRECISA_LEDGER com PROVA_DE → prova do fecho gravada (0) e publica pelo ledger" || nok "prova: $(tail -3 "$LOGV")"
r_prova_falha() {
  local e="$TMP/est-prova" h; rm -rf "$e"; h=$(cat "$TMP/head"); touch "$TMP/prova-falha"
  printf 'ar=22222222 x\nAR=%s\nPROVA_DE=%s\nVEREDITO=PRECISA_LEDGER\n' "$AR40" "$AR40" > "$TMP/decisao"
  printf 'ar=22222222 x\nRETIDO=edge:supabase/functions/_shared/x.ts\nVEREDITO=RETIDO\n' > "$TMP/decisao-pos"
  roda prova; rm -f "$TMP/decisao" "$TMP/decisao-pos" "$TMP/prova-falha"
  [ "$(head -1 "$e/shared-$AR40-$h")" = 2 ] && tem "PROVA_LEDGER=2"
}
r_prova_falha && ok "M1: prova que falha (exit ≠ 0) → cache 2 (fail-closed: liberar humano)" || nok "prova_falha: $(tail -3 "$LOGV")"

# ═══ Rodada 2 — PR E ════════════════════════════════════════════════════════════════════════════
# M5: o cache do ledger guarda as edges que o pendencias:deploy NOMEIA (seções ≠ ✅), não só o exit
r_m5() {
  local e="$TMP/est-m5" h; rm -rf "$e"; h=$(cat "$TMP/head")
  printf '$ bun scripts/pendencias-deploy.ts\n🔴 P1 — DEPLOY PENDENTE — 2\n   omie-vendas-sync    prod v1 → main v2\n   fin-x               prod v1 → main v3\n✅ confere — 2\n   ai-ops-agent        v1 · visto\n' > "$TMP/pend-saida"
  printf 'ar=aaaaaaaa x\nVEREDITO=PRECISA_LEDGER\n' > "$TMP/decisao"; printf 'ar=aaaaaaaa x\nVEREDITO=NADA_A_PUBLICAR\n' > "$TMP/decisao-pos"
  roda m5; rm -f "$TMP/decisao" "$TMP/decisao-pos" "$TMP/pend-saida"
  [ "$(sed -n '2,$p' "$e/pendencias-$h" | paste -sd, -)" = "fin-x,omie-vendas-sync" ]
}
r_m5 && ok "M5: cache do ledger traz as edges pendentes nomeadas (sem as que conferem)" || nok "m5: $(cat "$TMP/est-m5/pendencias-$(cat "$TMP/head")" 2>&1 | head -3)"
# M7: RETIDO comenta no PR dono da camada (1x por episódio); o aviso traz o comando ACAO=
RET7='ar=aaaaaaaa x
ACAO=bun run db:aplicar supabase/migrations/1_x.sql   (já aplicada fora do envelope? bun run db:aplicar supabase/migrations/1_x.sql --atestar)
DONO=4242|fulano|supabase/migrations/1_x.sql
DONO=?|beltrano|supabase/functions/f/index.ts
RETIDO=migration:supabase/migrations/1_x.sql
VEREDITO=RETIDO'
r_m7() {
  local e="$TMP/est-m7"; rm -rf "$e"; rm -f "$TMP/gh"; printf '%s\n' "$RET7" > "$TMP/decisao"
  roda m7; LVT_MANTEM=1 roda m7; rm -f "$TMP/decisao"
  [ "$(grep -c '^pr comment 4242 ' "$TMP/gh")" = 1 ] && ! grep -q 'pr comment ?' "$TMP/gh" && tem "comentei no PR #4242" \
    && tem "AVISO: RETIDO (migration:supabase/migrations/1_x.sql) até $(cut -c1-8 "$TMP/head"). bun run db:aplicar supabase/migrations/1_x.sql"
}
r_m7 && ok "M7: RETIDO comenta 1x no PR dono (#4242, do título do squash) e o aviso traz o comando db:aplicar" || nok "m7: $(cat "$TMP/gh" 2>&1 | head -c 300) | $(tail -2 "$LOGV")"
# M7: 1º lembrete com 45 min (não 4 h)
r_primeiro() {
  local e="$TMP/est-m7"; rm -rf "$e"; mkdir -p "$e"; printf '%s\n' "$RET7" > "$TMP/decisao"
  local t=$(( $(date +%s) - 50 * 60 )); echo "$t $t" > "$e/retido-episodio"; echo 4242 > "$e/retido-comentados"
  LVT_MANTEM=1 roda m7; rm -f "$TMP/decisao"
  tem "AVISO: AINDA RETIDO há 50 min"
}
r_primeiro && ok "M7: 1º lembrete do RETIDO aos 45 min (há 50 min → avisa)" || nok "primeiro: $(tail -2 "$LOGV")"

# lock vinculado ao processo: dono vivo (vigia) segura; dono morto ou PID reciclado (não-vigia) libera
mkdir -p "$TMP/dono"; printf 'sleep 30\n' > "$TMP/dono/vigia.sh"
r_lock() {
  local e="$TMP/est-lock" d; rm -rf "$e"; mkdir -p "$e/lock"
  bash "$TMP/dono/vigia.sh" & d=$!; echo "$d" > "$e/lock/pid"
  LVT_MANTEM=1 roda lock; local r=0
  { [ "$CHAMADAS" = "" ] && [ ! -s "$LOGV" ] && [ "$(cat "$e/lock/pid")" = "$d" ]; } || r=1
  kill "$d" 2>/dev/null; wait "$d" 2>/dev/null; return $r
}
r_lock && ok "lock de vigia VIVO → tick sai calado, lock intacto" || nok "lock vivo: $(tail -2 "$LOGV" 2>&1)"
sleep 30 & D=$!; echo "$D" > "$TMP/est-lock/lock/pid" 2>/dev/null || { mkdir -p "$TMP/est-lock/lock"; echo "$D" > "$TMP/est-lock/lock/pid"; }
LVT_MANTEM=1 roda lock; kill "$D" 2>/dev/null; wait "$D" 2>/dev/null
{ tem "lock de processo morto ($D) removido" && tem "PUBLICADO" && [ ! -d "$TMP/est-lock/lock" ]; } \
  && ok "PID reciclado por não-vigia → lock tomado, tick roda, lock solto no fim" || nok "lock reciclado: $(tail -2 "$LOGV")"
touch "$TMP/est-lock/vigia.log"; tail -f "$TMP/est-lock/vigia.log" > /dev/null & D=$!
mkdir -p "$TMP/est-lock/lock"; echo "$D" > "$TMP/est-lock/lock/pid"; LVT_MANTEM=1 roda lock; kill "$D" 2>/dev/null; wait "$D" 2>/dev/null
tem "lock de processo morto ($D) removido" && ok "PID reciclado por \`tail -f vigia.log\` → não segura o lock (Codex #7)" || nok "lock tail: $(tail -2 "$LOGV")"
mkdir -p "$TMP/est-lock/lock"; echo 999999 > "$TMP/est-lock/lock/pid"; LVT_MANTEM=1 roda lock
tem "lock de processo morto (999999) removido" && ok "PID morto → lock tomado" || nok "lock morto: $(tail -2 "$LOGV")"

# ═══ PR 4 — higiene ═════════════════════════════════════════════════════════════════════════════
BASE0=$(cat "$TMP/head")
r_sem_fetch() { roda ok; tem "PUBLICADO" && [ ! -f "$TMP/wt/.git/FETCH_HEAD" ]; }
r_sem_fetch && ok "main já no clone → sem fetch (só ls-remote)" || nok "sem_fetch: FETCH_HEAD=$(ls "$TMP/wt/.git/FETCH_HEAD" 2>&1) $(tail -1 "$LOGV")"
LVT_ANDA_POS_CLONE=1 roda ok
{ [ -f "$TMP/wt/.git/FETCH_HEAD" ] && [ "$(git -C "$TMP/wt" rev-parse HEAD)" = "$(cat "$TMP/head")" ] && tem "PUBLICADO $(cut -c1-8 "$TMP/head")" && [ -f "$TMP/wt/marca-pos" ]; } \
  && ok "main andou além do clone → fetch e checkout do SHA novo (arquivos também)" || nok "fetch: $(tail -2 "$LOGV")"
git -C "$TMP/origin" reset -q --hard "$BASE0"; echo "$BASE0" > "$TMP/head"
r_limpo() { LVT_SUJA=1 roda ok; tem "PUBLICADO" && ! grep -q ADULTERADO "$TMP/wt/scripts/lovable-publish.sh" && [ -z "$(git -C "$TMP/wt" status --porcelain --untracked-files=no)" ]; }
r_limpo && ok "decisor adulterado no clone (HEAD = main) → checkout -f roda o da main" || nok "limpo: $(tail -2 "$LOGV")"
# modo por `ls -ld` (portável): no Linux `stat -f` é stat de FILESYSTEM — imprime lixo + exit 1 e o `||` concatena
# shellcheck disable=SC2012  # caminho fixo do teste; ls -ld é o modo portável macOS/Linux
MODO_EST=$(ls -ld "$TMP/est-ok" | cut -c1-10)
[ "$MODO_EST" = drwx------ ] && ok "estado do vigia com chmod 700" || nok "modo do estado: $MODO_EST"

# instalador --verificar: o claude roda com o ambiente do launchd (env -i) e a prova é o tool_result
mkdir -p "$TMP/home/.local/share/afiacao/vigia-claude"; touch "$TMP/home/.local/share/afiacao/vigia-claude/.vigia-pronto"
cat > "$TMP/bin/claude-instalar" <<EOF
#!/bin/bash
cat > /dev/null
env > "$TMP/inst-env"
echo x >> "$TMP/inst-n"; f="$TMP/inst-stream.jsonl"; [ -f "$TMP/inst-stream-\$(wc -l < "$TMP/inst-n" | tr -d ' ').jsonl" ] && f="$TMP/inst-stream-\$(wc -l < "$TMP/inst-n" | tr -d ' ').jsonl"
cat "\$f"
EOF
chmod +x "$TMP/bin/claude-instalar"
verificar() { HOME="$TMP/home" LVT_VAZA=sim ANTHROPIC_BASE_URL=http://x LV_CLAUDE="$TMP/bin/claude-instalar" PATH="$TMP/bin:$PATH" \
  bash "${INSTALADOR_SOB_TESTE:-$RAIZ/scripts/lovable-vigia-instalar.sh}" --verificar > "$TMP/inst-out" 2>&1; }
r_verifica() {
  { init connected; uso t1 get_project; res t1 "[Image: source: /x.png]$(gp "$BASE0")"; fim OK; } > "$TMP/inst-stream.jsonl"
  verificar || return 1
  grep -q "^VERIFICAR=OK .*latest_commit_sha=${BASE0:0:8}" "$TMP/inst-out" && grep -q '^USER=' "$TMP/inst-env" && grep -q '^LOGNAME=' "$TMP/inst-env" \
    && grep -q "^CLAUDE_CONFIG_DIR=$TMP/home/.local/share/afiacao/vigia-claude$" "$TMP/inst-env" \
    && grep -q '^CLAUDE_CODE_OAUTH_TOKEN=token-falso$' "$TMP/inst-env" \
    && ! grep -qE '^(LVT_VAZA|ANTHROPIC_BASE_URL)=' "$TMP/inst-env"
}
r_verifica && ok "--verificar: get_project lido com ambiente mínimo do launchd (sem herança da sessão)" || nok "verificar: $(cat "$TMP/inst-out") | env: $(grep -cE 'LVT_VAZA|ANTHROPIC' "$TMP/inst-env" 2>&1)"
{ init needs-auth; fim "não consegui"; } > "$TMP/inst-stream.jsonl"
if verificar; then nok "--verificar sem tool_result passou"; else grep -q '^VERIFICAR=FALHOU .*mcp=needs-auth' "$TMP/inst-out" && ok "--verificar sem tool_result → FALHOU (exit ≠ 0), nomeando o needs-auth" || nok "verificar falho: $(cat "$TMP/inst-out")"; fi
rm "$TMP/home/.local/share/afiacao/vigia-claude/.vigia-pronto"
if verificar; then nok "--verificar sem store passou"; else grep -q 'store próprio ausente' "$TMP/inst-out" && ok "--verificar sem store próprio → FALHOU" || nok "sem store: $(cat "$TMP/inst-out")"; fi
touch "$TMP/home/.local/share/afiacao/vigia-claude/.vigia-pronto"
# Codex PR4 #7: 1ª chamada sem ferramenta, 2ª lê → OK (como o vigia), 2 chamadas
rm -f "$TMP/inst-n"; { init connected; fim "não invoquei"; } > "$TMP/inst-stream-1.jsonl"
{ init connected; uso t1 get_project; res t1 "$(gp "$BASE0")"; fim OK; } > "$TMP/inst-stream.jsonl"
verificar && [ "$(wc -l < "$TMP/inst-n" | tr -d ' ')" = 2 ] && ok "--verificar re-tenta 1x quando a 1ª chamada não usou ferramenta" || nok "retry: $(cat "$TMP/inst-out") n=$(cat "$TMP/inst-n" 2>&1 | wc -l)"
rm -f "$TMP/inst-stream-1.jsonl" "$TMP/inst-n"

# ── falsificação com controle VERDE na MESMA invocação: o roteiro passa no vigia real e REPROVA o sabotado
falsifica() {  # <nome> <sed> <roteiro>
  sed "$2" "$VIGIA" > "$TMP/vigia-sab-$1.sh"
  if ! ( "$3" ) >/dev/null 2>&1; then nok "controle: $3 reprovou o vigia REAL ($1)"
  elif cmp -s "$VIGIA" "$TMP/vigia-sab-$1.sh"; then nok "sabotagem $1 não casou"
  elif ( VIGIA_SOB_TESTE="$TMP/vigia-sab-$1.sh" "$3" ) >/dev/null 2>&1; then nok "vigia sabotado ($1) passou em $3"
  else ok "falsificação $1: real verde, sabotado vermelho"; fi
}
# shellcheck disable=SC2016  # os $ são LITERAIS do fonte sabotado
falsifica controle 's/if case "\$CTRL" in VIOLACAO\*) true ;; \*) false ;; esac; then RES="\$CTRL"/if false; then RES=x/' r_controle
falsifica intencao 's/^    INT_PENDENTE=1$/    INT_PENDENTE=0/' r_intencao
# shellcheck disable=SC2016  # $DONO é LITERAL do fonte sabotado
falsifica lock 's/^    if dono_vivo "\$DONO"; then$/    if false; then/' r_lock
# shellcheck disable=SC2016
falsifica backoff 's/^adia() { grava "\$EST\/tentativa" "\$HEAD_SHA \$N \$(( \$(date +%s) + \$1 ))"; }/adia() { grava "$EST\/tentativa" "$HEAD_SHA $N $((AGORA + $1))"; }/' r_backoff
falsifica truncado 's/then CTRL=TRUNCADO; fi/then true; fi/' r_truncado
# shellcheck disable=SC2016  # $SHA_LOV é LITERAL do fonte sabotado
falsifica le_e_cai 's/^  \[ -n "\$SHA_LOV" \] \&\& LIDO=1$/  true/' r_le_e_cai
falsifica issue 's/^abre_issue tick$/true/' r_issue
# shellcheck disable=SC2016  # $WT/$REMOTA são LITERAIS do fonte sabotado
falsifica checkout_f 's/checkout -q -f --detach/checkout -q --detach/' r_limpo
# shellcheck disable=SC2016
falsifica sem_fetch 's/^if git -C "\$WT" cat-file -e "\$REMOTA^{commit}" 2>\/dev\/null; then$/if false; then/' r_sem_fetch
# instalador sabotado: sem o env -i o ambiente da sessão vaza; sem o token a chamada real não autentica
falsifica_inst() {  # <nome> <sed>
  sed "$2" "$RAIZ/scripts/lovable-vigia-instalar.sh" > "$TMP/instalar-sab-$1.sh"
  if ! ( r_verifica ) >/dev/null 2>&1; then nok "controle: r_verifica reprovou o instalador REAL ($1)"
  elif cmp -s "$RAIZ/scripts/lovable-vigia-instalar.sh" "$TMP/instalar-sab-$1.sh"; then nok "sabotagem $1 do instalador não casou"
  elif ( INSTALADOR_SOB_TESTE="$TMP/instalar-sab-$1.sh" r_verifica ) >/dev/null 2>&1; then nok "instalador sabotado ($1) passou"
  else ok "falsificação $1: real verde, sabotado vermelho"; fi
}
falsifica_inst env_i 's/| env -i HOME=/| env HOME=/'
# shellcheck disable=SC2016  # $tok é LITERAL do fonte sabotado
falsifica_inst token 's/CLAUDE_CODE_OAUTH_TOKEN="\$tok" //'

# shellcheck disable=SC2016
falsifica store 's/^if \[ ! -f "\$CFG_DIR\/.vigia-pronto" \]; then$/if false; then/' r_store

# rodada 2 — PR A: cada correção, sabotada, reprova o roteiro dela (o controle verde roda antes)
# shellcheck disable=SC2016  # os $ são LITERAIS do fonte sabotado
falsifica b2_glob 's/      rm -f "\$EST"\/recibos-\[0-9a-f\]\*$/      rm -f "$EST"\/recibos-*/' r_dedup
falsifica b4_mecanica 's/^  MECANICA) episodio mecanica .*$/  MECANICA) exit 0 ;;/' r_mecanica
# shellcheck disable=SC2016
falsifica b3_liberar 's/   \&\& git -C "\$WT" merge-base --is-ancestor "\$LIB_ATUAL" "\$AR40" 2>\/dev\/null; then/   \&\& false; then/' r_lib_ultra
falsifica m9_por_fora 's/    log "JA_NO_AR por fora/    true "JA_NO_AR por fora/' r_por_fora
# shellcheck disable=SC2016
falsifica m6_buraco 's/\[ \$((BAT_AGORA - BAT_ANT)) -gt "\$BURACO_S" \]/false/' r_buraco
# shellcheck disable=SC2016
falsifica m13_teto 's/-gt "\${LV_AVISADOS_MAX:-200}"/-gt 999999/' r_teto
# shellcheck disable=SC2016
falsifica m13_caches 's/\*"-\$HEAD_SHA") ;; \*) rm -f "\$c" ;;/*) ;;/' r_caches
sed 's/^  invalida_recibos_do_vigia$/  true/' "$RAIZ/scripts/db-aplicar.sh" > "$TMP/dba-sab.sh"
if ! ( r_m4 ) >/dev/null 2>&1; then nok "controle: r_m4 reprovou o db-aplicar REAL"
elif cmp -s "$RAIZ/scripts/db-aplicar.sh" "$TMP/dba-sab.sh"; then nok "sabotagem m4 não casou"
elif ( DBA_SOB_TESTE="$TMP/dba-sab.sh" r_m4 ) >/dev/null 2>&1; then nok "db-aplicar sabotado (m4) passou"
else ok "falsificação m4: real verde, sabotado vermelho"; fi

# rodada 2 — PR B
# shellcheck disable=SC2016
falsifica b1_fallback 's/^      decidir; VER=\$(veredito)$/      true/' r_carimbo
# shellcheck disable=SC2016
falsifica b1_failclosed 's/^    if \[\[ "\$AR_FB" =~ \^\[0-9a-f\]{40}\$ \]\]; then$/    if true; then/' r_carimbo_sem
# shellcheck disable=SC2016
falsifica b1_n_ticks 's/-ge "\${LV_CARIMBO_TICKS:-5}"/-ge 1/' r_carimbo_cedo
# shellcheck disable=SC2016
falsifica b5_divida 's/\[ "\$1" = JA_NO_AR \] \&\& \[ -s "\$EST\/retido-camadas" \]/false/' r_divida

# rodada 2 — PR C
# shellcheck disable=SC2016
falsifica m1_failclosed 's/\[ "\$SRC" = 0 \] \&\& \[ -n "\$SV" \] || SV=2/[ -n "$SV" ] || SV=0/' r_prova_falha

# rodada 2 — PR E
falsifica m5_nomes "s/^      NOMES=\$(awk .*\$/      NOMES=''/" r_m5
falsifica m7_comenta 's/^  comenta_donos$/  true/' r_m7
# shellcheck disable=SC2016
falsifica m7_primeiro 's/^    \[ "\$1" = retido \] \&\& \[ "\$ini" = "\$ult" \] \&\& rel=.*$/    true/' r_primeiro

[ "$FALHAS" -eq 0 ] && { echo "TEST-LOVABLE-VIGIA: OK ($OKS)"; exit 0; }
echo "TEST-LOVABLE-VIGIA: $FALHAS falha(s)"; exit 1
