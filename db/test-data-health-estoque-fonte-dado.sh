#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — Sentinela check `estoque_reposicao` v3: fonte de frescor      ║
# ║  VOLTA ao DADO REAL (max(ultima_sincronizacao) OBEN, allowlist fonte_sync).   ║
# ║  Prova: thresholds (ok/stale/broken/nunca), allowlist anti-mascaramento       ║
# ║  (cold_start_seed / snapshot_pendente_sem_fisico), isolamento por empresa,    ║
# ║  GUARD anti-drift por md5 (aborta base alienígena; re-run idempotente),       ║
# ║  conjunto de 23 sources INALTERADO, watchdog/heartbeat intactos + RE-ARME     ║
# ║  do e-mail (a surdez do incidente 30/06-02/07). + 4 FALSIFICAÇÕES.            ║
# ║  Migration: 20260702212000_data_health_estoque_reposicao_fonte_dado.sql       ║
# ║  Base viva: db/prod-sentinela-base-20260702.sql (retrato datado de prod)      ║
# ║  Rode: bash db/test-data-health-estoque-fonte-dado.sh > /tmp/t.log 2>&1; echo $?
# ║        (NÃO pipe pra tail — engole o exit≠0, §2 CLAUDE.md)                     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5474}"
SLUG="estoque-fonte-dado"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MD5_BASE="51f336c399c21efde222698142d74c3e"   # md5 do _data_health_compute VIVO em prod (2026-07-02) — o mesmo do guard
BASE="$REPO_ROOT/db/prod-sentinela-base-20260702.sql"
MIG="$REPO_ROOT/supabase/migrations/20260702212000_data_health_estoque_reposicao_fonte_dado.sql"

echo "═══ setup PG17 :$PORT ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — STUBS: as 15 tabelas que as 3 funções LEEM (colunas usadas). Vazias ⇒ os
#   demais checks dão broken/unknown SEM erro; só sku_estoque_atual eu semeio.
#   sku_estoque_atual entra aqui (o check v3 a lê; o harness irmão não a tinha porque
#   a v2 lia sync_state). fin_alertas com o índice único PARCIAL (ON CONFLICT do watchdog).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.fin_contas_correntes (saldo_data timestamptz, ativo boolean);
CREATE TABLE public.fin_contas_receber  (updated_at timestamptz);
CREATE TABLE public.fin_contas_pagar    (updated_at timestamptz);
CREATE TABLE public.fin_sync_log (status text, completed_at timestamptz, action text, companies text[], started_at timestamptz, error_message text);
CREATE TABLE public.inventory_position (synced_at timestamptz);
CREATE TABLE public.pedido_compra_sugerido (data_ciclo date, status text, aprovado_em timestamptz, status_envio_portal text, portal_proximo_retry_em timestamptz, portal_tentativas int, atualizado_em timestamptz);
CREATE TABLE public.farmer_client_scores (calculated_at timestamptz);
CREATE TABLE public.product_costs (product_id uuid, cost_source text, cost_confidence numeric, cost_final numeric, updated_at timestamptz);
CREATE TABLE public.omie_clientes (updated_at timestamptz);
CREATE TABLE public.omie_products (id uuid, updated_at timestamptz, tipo_produto text, metadata jsonb, account text, familia text, ativo boolean, created_at timestamptz, is_tintometric boolean, tint_type text, omie_codigo_produto text);
CREATE TABLE public.sku_parametros (empresa text, fornecedor_nome text, ativo boolean, habilitado_reposicao_automatica boolean, tipo_reposicao text, sku_codigo_omie text);
CREATE TABLE public.sync_state (entity_type text, account text, status text, last_sync_at timestamptz, updated_at timestamptz, error_message text, total_synced int);
CREATE TABLE public.tint_skus (id uuid, account text, ativo boolean, omie_product_id uuid);
CREATE TABLE public.sku_estoque_atual (empresa text, sku_codigo_omie text, estoque_fisico numeric, estoque_disponivel numeric, estoque_pendente_entrada numeric, ultima_sincronizacao timestamptz, fonte_sync text);
CREATE TABLE public.fornecedor_alerta (id uuid DEFAULT gen_random_uuid(), empresa text, tipo text, severidade text, titulo text, mensagem text, status text, criado_em timestamptz DEFAULT now(), erro_notificacao text);
CREATE TABLE public.fin_alertas (id uuid DEFAULT gen_random_uuid(), company text, tipo text, severidade text, mensagem text, contexto jsonb, dismissed_at timestamptz, criado_em timestamptz DEFAULT now());
CREATE UNIQUE INDEX fin_alertas_company_tipo_uniq ON public.fin_alertas (company, tipo) WHERE dismissed_at IS NULL;
CREATE FUNCTION public._vendas_familia_ausente_lista_email(int) RETURNS text LANGUAGE sql STABLE AS $f$ SELECT NULL::text $f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — BASE VIVA (retrato de prod) + MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$BASE"
echo "base viva aplicada: $(basename "$BASE")"

# S0 — SANIDADE do harness: o functiondef local da base == byte-a-byte o de prod
#      (se falhar, o guard por md5 não estaria sendo exercitado contra o estado real)
eq "S0 md5(base local) == md5 de prod ($MD5_BASE)" \
   "$(Pq -c "SELECT md5(pg_get_functiondef('public._data_health_compute()'::regprocedure));")" "$MD5_BASE"

SOURCES_ANTES="$(Pq -c "SELECT string_agg(source, ',' ORDER BY source) FROM public._data_health_compute();")"
MD5_WD_ANTES="$(Pq -c "SELECT md5(pg_get_functiondef('public.data_health_watchdog()'::regprocedure));")"
MD5_HB_ANTES="$(Pq -c "SELECT md5(pg_get_functiondef('public.fin_sync_heartbeat()'::regprocedure));")"

# Reproduz o EPISÓDIO PRESO de prod (alerta v2 ativo desde 15/06 por marcador-ausente) ANTES do apply
P -q -c "INSERT INTO fin_alertas (company, tipo, severidade, mensagem, criado_em) VALUES ('oben','data_health_estoque_reposicao','critico','episodio v2 preso', now() - interval '17 days');"

P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

# W0 — o apply DISMISSA o episódio v2 preso (Codex P1: sem isto, o ON CONFLICT segue mudo até a 1ª transição ->ok)
eq "W0 apply dismissa o episódio v2 preso (surdez encerrada no apply, não na 1ª transição ok)" \
   "$(Pq -c "SELECT count(*) FROM fin_alertas WHERE tipo='data_health_estoque_reposicao' AND dismissed_at IS NULL;")" "0"

# S1 — o corpo virou v3 (fonte trocada de fato)
eq "S1 corpo pós-migration contém a marca v3" \
   "$(Pq -c "SELECT pg_get_functiondef('public._data_health_compute()'::regprocedure) LIKE '%estoque frescor v3%';")" "t"

# helpers
chk()    { Pq -c "SELECT status FROM public._data_health_compute() WHERE source='estoque_reposicao';"; }
# _set_estoque(idade, fonte, empresa): limpa e insere 1 linha; idade NULL ⇒ ultima_sincronizacao NULL
P -q <<'SQL'
CREATE OR REPLACE FUNCTION _set_estoque(p_idade interval, p_fonte text, p_empresa text DEFAULT 'OBEN')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.sku_estoque_atual WHERE empresa = p_empresa AND fonte_sync = p_fonte;
  INSERT INTO public.sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, ultima_sincronizacao, fonte_sync)
  VALUES (p_empresa, 'SKU-' || p_fonte || '-' || p_empresa, 10, 0,
          CASE WHEN p_idade IS NULL THEN NULL ELSE now() - p_idade END, p_fonte);
END $$;
SQL
limpa() { P -q -c "DELETE FROM public.sku_estoque_atual;"; }
# sabotagem: replace literal robusto a metacaracteres via python (Lei #3 — muta a migration REAL)
sabota() {  # $1=OLD  $2=NEW  $3=count esperado
  local SAB; SAB=$(mktemp /tmp/sab-efd.XXXXXX.sql)
  # O `|| return 1` e o que faz a sabotagem que NAO casa reprovar tambem sob `if sabota` (F3): ali o
  # errexit fica suspenso ate dentro da funcao, o assert do python falhava, o $SAB ficava VAZIO, e o
  # `P -f` de arquivo vazio sai 0 — a sabotagem nao aplicada contava como "APLICOU".
  SAB="$SAB" MIG="$MIG" SAB_OLD="$1" SAB_NEW="$2" SAB_CNT="$3" python3 - <<'PYEOF' || { echo "  ❌ sabota: o padrao nao casou ${3}x — a sabotagem NAO aplicou"; rm -f "$SAB"; return 1; }
import os
s = open(os.environ['MIG']).read()
old, new, cnt = os.environ['SAB_OLD'], os.environ['SAB_NEW'], int(os.environ['SAB_CNT'])
assert s.count(old) == cnt, f"sabota: esperei {cnt} de [{old}], achei {s.count(old)}"
open(os.environ['SAB'], 'w').write(s.replace(old, new))
PYEOF
  P -q -f "$SAB" >/dev/null; rm -f "$SAB"
}
restaura() { P -q -f "$MIG" >/dev/null; }   # guard aceita re-run (marca v3 presente)
# Vermelho = o status sob sabotagem e o que a sabotagem DECLARA ($2) — nao so "!= broken". O "!="
# aceitava ok/stale/unknown indistintos E o vazio do chk que ERRA: a substituicao dentro do `[ ]` nao
# dispara o errexit. A leitura roda com `set -e` e o rc capturado fora de lista ||/&& (onde o bash 5
# ignora o errexit do subshell). O vermelho tem de ser do SEU assert:
# docs/historico/falsificacao-exit-nao-e-dente.md.
veredito_status() { # $1=rotulo  $2=status que a sabotagem DECLARA
  local s rc
  set +e; s="$(set -e; chk)"; rc=$?; set -e
  if [ "$rc" -ne 0 ]; then bad "$1 — a LEITURA ERROU (rc=$rc): erro de execucao nao e dente"
  elif [ "$s" = "broken" ]; then bad "$1 — SEM DENTE: a sabotagem seguiu broken"
  elif [ "$s" = "$2" ]; then ok "$1 (status=$s)"
  else bad "$1 — vermelha, mas NAO no valor que a sabotagem declara: esperado [$2], veio [$s]"; fi
}

echo "── conjunto acoplado INALTERADO (superfície mínima) ──"
eq "C1 compute executa e segue com 23 checks" "$(Pq -c "SELECT count(*) FROM public._data_health_compute();")" "23"
eq "C2 os 23 source names são os MESMOS da base" "$(Pq -c "SELECT string_agg(source, ',' ORDER BY source) FROM public._data_health_compute();")" "$SOURCES_ANTES"
eq "C3 data_health_watchdog NÃO foi tocado" "$(Pq -c "SELECT md5(pg_get_functiondef('public.data_health_watchdog()'::regprocedure));")" "$MD5_WD_ANTES"
eq "C4 fin_sync_heartbeat NÃO foi tocado"   "$(Pq -c "SELECT md5(pg_get_functiondef('public.fin_sync_heartbeat()'::regprocedure));")" "$MD5_HB_ANTES"
eq "C5 freshness_basis = dado real v3" \
   "$(Pq -c "SELECT freshness_basis LIKE 'max(sku_estoque_atual.ultima_sincronizacao)%' FROM public._data_health_compute() WHERE source='estoque_reposicao';")" "t"

echo "── thresholds (hora-independentes) ──"
# P1 — dado fresco (1h) → ok em QUALQUER hora do dia (1h < 4h)
limpa; P -q -c "SELECT _set_estoque(interval '1 hour', 'ListarPosEstoque');"
eq "P1 dado 1h → ok" "$(chk)" "ok"
# P1b — age_seconds reflete a idade real (~3h)
limpa; P -q -c "SELECT _set_estoque(interval '3 hours', 'ListarPosEstoque');"
eq "P1b age_seconds ≈ 3h (faixa 10000-12000s)" "$(Pq -c "SELECT (age_seconds BETWEEN 10000 AND 12000) FROM public._data_health_compute() WHERE source='estoque_reposicao';")" "t"
# N1 — 17h → stale em QUALQUER hora (>16h e <30h)
limpa; P -q -c "SELECT _set_estoque(interval '17 hours', 'ListarPosEstoque');"
eq "N1 dado 17h → stale (o incidente seria pego aqui, <26h)" "$(chk)" "stale"
# N2 — 31h → broken em QUALQUER hora (>30h)
limpa; P -q -c "SELECT _set_estoque(interval '31 hours', 'ListarPosEstoque');"
eq "N2 dado 31h → broken" "$(chk)" "broken"
# N3 — nunca sincronizou (0 linhas OBEN/ListarPosEstoque) → broken; age NULL (ausente ≠ zero)
limpa
eq "N3 sem linha → broken (nunca)" "$(chk)" "broken"
eq "N3b age_seconds NULL quando nunca (não fabrica 0)" "$(Pq -c "SELECT age_seconds IS NULL FROM public._data_health_compute() WHERE source='estoque_reposicao';")" "t"
eq "N3c severity critical (money-path)" "$(Pq -c "SELECT severity FROM public._data_health_compute() WHERE source='estoque_reposicao';")" "critical"

echo "── janela comercial BRT [08,18): o relógio CRUZA as duas bordas de propósito ──"
# N9 — dado de 5h: DENTRO da janela BRT = stale (2+ syncs intraday perdidos); fora = ok (vão noturno).
# Antes, o esperado vinha do `date` do bash e o real do now() do banco: DOIS relógios. Se 08:00/18:00 BRT
# caísse entre as leituras (~50-70 ms medidos), esperado e real divergiam — reproduzido em relógio
# simulado nas duas bordas. E cada execução só exercitava UM lado, o que a hora do CI sorteasse.
# Agora o dado fica PARADO e o relógio é CONTROLADO: `public.now()` lê a GUC `test.agora`, e o compute
# (corpo REAL da migration) ganha `pg_catalog` DEPOIS de `public` — SÓ durante a rodada: a guarda de
# md5 da migration (N7/N8) lê o pg_get_functiondef, e o search_path é conferido de volta ao fim.
# Diário: docs/historico/provas-janela-de-relogio-fora-do-nucleo.md
CFG_COMPUTE="$(Pq -c "SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;")"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(nullif(current_setting('test.agora', true), '')::timestamptz, pg_catalog.now())
$f$;
SQL
# `public` antes de `pg_catalog` não troca só o now(): TODA função de `public` com a MESMA assinatura de
# um embutido passa a vencê-lo. O compute não pode chamar nome sombreado — senão a rodada mediria outra
# semântica sem avisar. Controle POSITIVO da própria guarda: ela tem de enxergar o nosso now().
sombra="$(Pq -c "SELECT COALESCE(string_agg(s.proname, ',') FILTER (WHERE s.proname = 'now'), '') || '|' ||
    COALESCE(string_agg(s.proname, ',') FILTER (WHERE s.proname <> 'now' AND EXISTS (
      SELECT 1 FROM pg_proc f WHERE f.oid = 'public._data_health_compute()'::regprocedure
        AND f.prosrc ~ ('\m' || s.proname || '\s*\('))), '')
  FROM (SELECT DISTINCT p.proname FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND EXISTS (SELECT 1 FROM pg_proc c WHERE c.pronamespace = 'pg_catalog'::regnamespace
                        AND c.proname = p.proname AND c.proargtypes = p.proargtypes)) s;")"
case "$sombra" in
  'now|') ;;
  now\|*) echo "❌ o relógio controlado mudaria mais que o now(): o compute chama [${sombra#*|}], sombreado por public"; exit 1 ;;
  *) echo "❌ guarda cega: não enxergou nem o public.now() que acabou de ser criado [$sombra]"; exit 1 ;;
esac
# janela_rodada [ligar=1]: o MESMO dado (5h) lido nos 4 instantes de borda → "status|idade" de cada um.
# `ligar=0` roda com o relógio DESLIGADO (é a sabotagem F9 — o controle positivo tem de acusar).
janela_rodada() {
  local ligar="${1:-1}" out="" t
  [ "$ligar" = 0 ] || P -q -c "ALTER FUNCTION public._data_health_compute() SET search_path = public, pg_catalog, pg_temp;"
  for t in '2026-09-16 07:59:59-03' '2026-09-16 08:00:00-03' '2026-09-16 17:59:59-03' '2026-09-16 18:00:00-03'; do
    limpa
    out="$out $(Pq -q -c "SET search_path = public, pg_catalog" -c "SET test.agora = '$t'" \
      -c "DO \$\$ BEGIN PERFORM _set_estoque(interval '5 hours', 'ListarPosEstoque'); END \$\$" \
      -c "SELECT status || '|' || age_seconds FROM public._data_health_compute() WHERE source = 'estoque_reposicao'")"
  done
  # desliga: o compute volta EXATAMENTE ao search_path da migration — conferido, não suposto
  P -q -c "ALTER FUNCTION public._data_health_compute() SET search_path = public, pg_temp;"
  [ "$(Pq -c "SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;")" = "$CFG_COMPUTE" ] \
    || { echo "❌ o relógio controlado NÃO foi desligado: o search_path do compute diverge do da migration [$CFG_COMPUTE]"; exit 1; }
  echo "${out# }"
}
N9_ESPERADO="ok|18000 stale|18000 stale|18000 ok|18000"
# 4 leituras "status|idade" BEM FORMADAS: uma sabotagem só conta como dente se a rodada RODOU e leu
# outra coisa — rodada que quebrou (erro, relógio que não respondeu) também "difere" do esperado.
bem_formada() { [[ "$1" =~ ^(ok|stale|broken)\|[0-9]+(\ (ok|stale|broken)\|[0-9]+){3}$ ]]; }
# shellcheck disable=SC2046  # split proposital: 4 leituras separadas por espaço
set -- $(janela_rodada)
# idade 18000 = 5h EXATAS: é o controle POSITIVO de que o compute leu o relógio controlado. No relógio
# de parede ela seria a distância até 16/09 (dias) e o status, broken.
eq "N9a 07:59:59 BRT, dado 5h → ok (1 s ANTES de a janela abrir)" "${1:-}" "ok|18000"
eq "N9b 08:00:00 BRT, dado 5h → stale (a janela abre: início inclusivo)" "${2:-}" "stale|18000"
eq "N9c 17:59:59 BRT, dado 5h → stale (último segundo da janela)" "${3:-}" "stale|18000"
eq "N9d 18:00:00 BRT, dado 5h → ok (a janela fecha: fim exclusivo)" "${4:-}" "ok|18000"

echo "── anti-futuro (writer com relógio quebrado não compra verde eterno) ──"
# A2 — max_sync no FUTURO (+2h) → broken (sem isto: age negativo → ok até o relógio alcançar)
limpa; P -q -c "SELECT _set_estoque(interval '-2 hours', 'ListarPosEstoque');"
eq "A2 max_sync no futuro (+2h) → broken" "$(chk)" "broken"

echo "── allowlist fonte_sync (anti-mascaramento — o coração do check) ──"
# A1 — rótulo VARIANTE multi-local ('ListarPosEstoque(3 locais)', edge :609) CONTA como frescor (Codex P1)
limpa; P -q -c "SELECT _set_estoque(interval '1 hour', 'ListarPosEstoque(3 locais)');"
eq "A1 rótulo multi-local fresco → ok (writer real, prefixo casa)" "$(chk)" "ok"
# N4 — físico MORTO (31h) + seed do cold-start FRESCO (agora) → SEGUE broken (o seed não mascara)
limpa
P -q -c "SELECT _set_estoque(interval '31 hours', 'ListarPosEstoque');"
P -q -c "SELECT _set_estoque(interval '1 minute', 'cold_start_seed');"
eq "N4 cold_start_seed fresco NÃO mascara físico 31h → broken" "$(chk)" "broken"
# N5 — físico OBEN morto + COLACOR fresco (mesma fonte) → SEGUE broken (empresa isola)
limpa
P -q -c "SELECT _set_estoque(interval '31 hours', 'ListarPosEstoque', 'OBEN');"
P -q -c "SELECT _set_estoque(interval '1 minute', 'ListarPosEstoque', 'COLACOR');"
eq "N5 COLACOR fresco NÃO salva OBEN 31h → broken" "$(chk)" "broken"
# N6 — linha do pendente-sem-físico (ultima_sincronizacao NULL) não conta nem quebra
limpa
P -q -c "SELECT _set_estoque(NULL, 'snapshot_pendente_sem_fisico');"
eq "N6a só linha pendente-NULL → broken (não conta como frescor)" "$(chk)" "broken"
P -q -c "SELECT _set_estoque(interval '1 hour', 'ListarPosEstoque');"
eq "N6b pendente-NULL ao lado de físico fresco → ok (não interfere)" "$(chk)" "ok"

echo "── integração push: watchdog cria → não spamma → dismissa → RE-ARMA (a surdez do incidente) ──"
limpa; P -q -c "SELECT _set_estoque(interval '31 hours', 'ListarPosEstoque');"
P -q -c "SELECT public.data_health_watchdog();"
eq "W1 broken → alerta fin_alertas ATIVO criado" \
   "$(Pq -c "SELECT count(*) FROM fin_alertas WHERE tipo='data_health_estoque_reposicao' AND dismissed_at IS NULL;")" "1"
eq "W1b broken → e-mail (fornecedor_alerta) enfileirado" \
   "$(Pq -c "SELECT count(*) FROM fornecedor_alerta WHERE titulo='[Saúde de dados] estoque_reposicao';")" "1"
P -q -c "SELECT public.data_health_watchdog();"
eq "W2 broken contínuo → SEM re-email (ON CONFLICT segura o spam)" \
   "$(Pq -c "SELECT count(*) FROM fornecedor_alerta WHERE titulo='[Saúde de dados] estoque_reposicao';")" "1"
limpa; P -q -c "SELECT _set_estoque(interval '1 hour', 'ListarPosEstoque');"
P -q -c "SELECT public.data_health_watchdog();"
eq "W3 dado voltou fresco → watchdog DISMISSA o alerta sozinho" \
   "$(Pq -c "SELECT count(*) FROM fin_alertas WHERE tipo='data_health_estoque_reposicao' AND dismissed_at IS NULL;")" "0"
limpa; P -q -c "SELECT _set_estoque(interval '17 hours', 'ListarPosEstoque');"
P -q -c "SELECT public.data_health_watchdog();"
eq "W4 nova degradação → NOVO alerta ativo (ciclo RE-ARMADO)" \
   "$(Pq -c "SELECT count(*) FROM fin_alertas WHERE tipo='data_health_estoque_reposicao' AND dismissed_at IS NULL;")" "1"
eq "W4b nova degradação → NOVO e-mail (2º fornecedor_alerta — o que faltou em 30/06)" \
   "$(Pq -c "SELECT count(*) FROM fornecedor_alerta WHERE titulo='[Saúde de dados] estoque_reposicao';")" "2"
# heartbeat roda e resume o check (dead-man-switch intacto)
P -q -c "SELECT public.fin_sync_heartbeat();"
eq "W5 heartbeat roda e cita estoque_reposicao no resumo" \
   "$(Pq -c "SELECT count(*) FROM fornecedor_alerta WHERE titulo LIKE '[Watchdog%' AND mensagem LIKE '%estoque_reposicao: %';")" "1"

echo "── GUARD anti-drift (por EFEITO: rollback total; sem grep na mensagem do próprio código) ──"
# N7 — base ALIENÍGENA (função recriada por outra sessão; sem marca v3, md5 ≠ base) → migration ABORTA
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public._data_health_compute()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint, freshness_basis text, message text, last_error text, probable_cause text, how_to_fix text, severity text)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT 'check_alienigena'::text, 'x'::text, 'ok'::text, NULL::bigint, NULL::bigint, 'x'::text, 'corpo de outra sessao'::text, NULL::text, NULL::text, NULL::text, 'info'::text
$function$;
SQL
MD5_ALIEN="$(Pq -c "SELECT md5(pg_get_functiondef('public._data_health_compute()'::regprocedure));")"
if P -q -f "$MIG" >/dev/null 2>/tmp/guard-err.log; then
  bad "N7 guard NÃO abortou sobre base alienígena (aplicou por cima de drift!)"
else
  ok "N7 guard abortou a migration sobre base alienígena (exit≠0)"
fi
eq "N7b rollback TOTAL: o corpo alienígena ficou intacto (nada aplicado parcial)" \
   "$(Pq -c "SELECT md5(pg_get_functiondef('public._data_health_compute()'::regprocedure));")" "$MD5_ALIEN"
# restaura o mundo: base viva + migration real
P -q -f "$BASE"; P -q -f "$MIG" >/dev/null
# N8 — re-run da migration já aplicada = no-op idempotente (guard aceita pela marca v3)
MD5_V3="$(Pq -c "SELECT md5(pg_get_functiondef('public._data_health_compute()'::regprocedure));")"
if P -q -f "$MIG" >/dev/null 2>&1; then ok "N8 re-run pós-aplicada passa (idempotente)"; else bad "N8 re-run pós-aplicada FALHOU"; fi
eq "N8b re-run não muda o corpo (md5 estável)" \
   "$(Pq -c "SELECT md5(pg_get_functiondef('public._data_health_compute()'::regprocedure));")" "$MD5_V3"

echo "── FALSIFICAÇÕES (Lei #3 — sabota a migration real, exige VERMELHO, restaura) ──"
# F1 — remove a allowlist do fonte_sync ⇒ N4 (cold_start_seed não mascara) tem de FALHAR
sabota " FILTER (WHERE fonte_sync LIKE 'ListarPosEstoque%')" "" 1
limpa
P -q -c "SELECT _set_estoque(interval '31 hours', 'ListarPosEstoque');"
P -q -c "SELECT _set_estoque(interval '1 minute', 'cold_start_seed');"
veredito_status "F1 sem allowlist o seed mascara → N4 tem dente" "ok"
restaura
# F2 — afrouxa o threshold broken (30h→300h) ⇒ N2 (31h broken) tem de FALHAR
sabota "WHEN now() - se.max_sync > interval '30 hours' THEN 'broken'" "WHEN now() - se.max_sync > interval '300 hours' THEN 'broken'" 1
limpa; P -q -c "SELECT _set_estoque(interval '31 hours', 'ListarPosEstoque');"
veredito_status "F2 threshold frouxo deixa 31h passar → N2 tem dente" "stale"
restaura
# F3 — neutraliza o guard (condição impossível) ⇒ N7 (abort sobre alienígena) tem de FALHAR
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public._data_health_compute()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint, freshness_basis text, message text, last_error text, probable_cause text, how_to_fix text, severity text)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT 'check_alienigena'::text, 'x'::text, 'ok'::text, NULL::bigint, NULL::bigint, 'x'::text, 'corpo de outra sessao'::text, NULL::text, NULL::text, NULL::text, 'info'::text
$function$;
SQL
SAB_GUARD_OLD="IF v_md5 <> '${MD5_BASE}' AND v_def NOT LIKE '%estoque frescor v3%' THEN"
# o que a sabotagem DECLARA: aplicou E o corpo v3 substituiu o alienigena (exit 0 sozinho tambem vem
# de um SAB vazio ou de um apply que nao tocou o compute)
if sabota "$SAB_GUARD_OLD" "IF false THEN" 1 2>/dev/null \
   && [ "$(Pq -c "SELECT pg_get_functiondef('public._data_health_compute()'::regprocedure) LIKE '%estoque frescor v3%';")" = "t" ]; then
  ok "F3 guard neutralizado APLICOU sobre base alienígena → N7 tem dente (o RAISE é o que barra)"
else
  bad "F3 guard neutralizado ainda abortou?! (N7 pode estar passando por outro motivo)"
fi
# restaura o mundo (o F3 deixou o corpo v3 por cima do alienígena — re-semeia base + migration real)
P -q -f "$BASE"; P -q -f "$MIG" >/dev/null
# F4 — remove o isolamento de empresa ⇒ N5 (COLACOR não salva OBEN) tem de FALHAR
sabota "      WHERE empresa = 'OBEN'" "      WHERE true" 1
limpa
P -q -c "SELECT _set_estoque(interval '31 hours', 'ListarPosEstoque', 'OBEN');"
P -q -c "SELECT _set_estoque(interval '1 minute', 'ListarPosEstoque', 'COLACOR');"
veredito_status "F4 sem filtro de empresa o COLACOR mascara → N5 tem dente" "ok"
restaura
# F5 — remove a linha anti-futuro ⇒ A2 (futuro → broken) tem de FALHAR
sabota "           WHEN se.max_sync > now() + interval '5 minutes' THEN 'broken'
" "" 1
limpa; P -q -c "SELECT _set_estoque(interval '-2 hours', 'ListarPosEstoque');"
veredito_status "F5 sem anti-futuro o timestamp futuro passa verde → A2 tem dente" "ok"
restaura
# F6 — janela contada em UTC ⇒ N9 tem de FALHAR (07:59:59 BRT são 10:59:59Z, "dentro" em UTC)
sabota "(now() AT TIME ZONE 'America/Sao_Paulo')::time" "(now() AT TIME ZONE 'UTC')::time" 2
R="$(janela_rodada)"
# determinística: 07:59:59/08:00 BRT = 10:59:59/11:00Z (dentro em UTC); 17:59:59/18:00 BRT = 20:59:59/21:00Z (fora)
if [ "$R" = "stale|18000 stale|18000 ok|18000 ok|18000" ]; then ok "F6 janela em UTC lê as bordas como UTC ($R) → N9 tem dente"; else bad "F6 assert N9 — a sabotagem UTC não produziu a leitura UTC: [$R]"; fi
restaura
# F7 — fim FECHADO (<= 18:00) ⇒ N9d tem de FALHAR
sabota "<  time '18:00'" "<= time '18:00'" 1
R="$(janela_rodada)"
if [ "$R" = "ok|18000 stale|18000 stale|18000 stale|18000" ]; then ok "F7 fim fechado põe 18:00:00 dentro ($R) → N9d tem dente"; else bad "F7 assert N9d — o fim fechado não produziu a leitura esperada: [$R]"; fi
restaura
# F8 — hora tirada do relógio de PAREDE (clock_timestamp escapa do controlado) ⇒ N9 tem de FALHAR
sabota "(now() AT TIME ZONE 'America/Sao_Paulo')::time" "(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::time" 2
R="$(janela_rodada)"
# a hora de PAREDE depende de quando roda — qual das duas leituras vem não é fixo (dentro ou fora da
# janela), mas o que a sabotagem DECLARA é: as 4 bordas ACHATADAS no mesmo status, idade 18000. "Bem
# formada e != N9" aceitava qualquer outro desvio (a leitura do F7, por exemplo).
if [ "$R" = "ok|18000 ok|18000 ok|18000 ok|18000" ] || [ "$R" = "stale|18000 stale|18000 stale|18000 stale|18000" ]; then ok "F8 hora de parede achata as 4 bordas ($R) → N9 tem dente"
elif [ "$R" = "$N9_ESPERADO" ]; then bad "F8 assert N9 — hora de parede e a rodada seguiu igual (sem dente): [$R]"
else bad "F8 assert N9 — vermelha, mas NAO no achatamento que a sabotagem declara (ou nao rodou): [$R]"; fi
restaura
# F9 — relógio DESLIGADO (compute no search_path da migration) ⇒ o controle positivo (idade) tem de FALHAR
R="$(janela_rodada 0)"
if bem_formada "$R" && [[ "$R" != *"|18000"* ]]; then ok "F9 relógio desligado quebra a idade ($R) → o controle positivo tem dente"; else bad "F9 controle positivo — relógio desligado e a idade seguiu 18000, ou a rodada não rodou: [$R]"; fi

echo ""
echo "═══════════════════════════════════════════"
echo " PASS=$PASS FAIL=$FAIL"
echo "═══════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
