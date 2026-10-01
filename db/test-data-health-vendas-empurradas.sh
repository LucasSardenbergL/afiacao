#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — check `vendas_empurradas_sem_gemeo` do Sentinela (20261001011500), com FALSIFICAÇÃO
# ║      bash db/test-data-health-vendas-empurradas.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-data-health-vendas-empurradas.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  O que se prova, sempre pela SAÍDA do compute REAL (nunca por uma cópia da lógica):
# ║   · o universo: linha do app = omie_payload + omie_pedido_id, status canônico de venda, não
# ║     apagada; gêmeo = mesma (account, omie_pedido_id) com omie_payload nulo, em QUALQUER status;
# ║   · a âncora: menor(updated_at, fim do dia UTC da data_previsao), só com previsão válida e
# ║     coerente com a criação — o orçamento convertido não acusa antes de 6 h do envio, e a linha
# ║     tocada depois do envio não rejuvenesce;
# ║   · os níveis e as bordas (6 h, 6 dias), a message estável (relógio cruzando a meia-noite de SP,
# ║     fuso e lc_numeric da sessão) e o contrato do trio (31 sources, watchdog avalia 23, o push e o
# ║     resumo enxergam o source novo);
# ║   · o fecho de ACL: authenticated recebe 42501 no watchdog e no heartbeat;
# ║   · a migration: re-aplicar é inócuo e a PRE recusa um corpo estranho (sem revertê-lo).
# ║  Diário: docs/historico/venda-empurrada-sem-gemeo.md
# ╚═══════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5523}"
SLUG="vendas-empurradas-sem-gemeo"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

# ════════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar — o laço de db/test-data-health-sync-reprocess.sh, verbatim no método: controle
# VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e cada sabotagem só conta se
# (1) aplicou, (2) a suíte rodou INTEIRA (mesmo PASS+FAIL do controle), (3) CADA assert declarado
# estava verde no controle e virou vermelho aqui, (4) sem ERRO de SQL que o controle não tem.
# docs/historico/falsificacao-exit-nao-e-dente.md
# ════════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_filtro_status:A11,A12,A13,A14 sem_orcamento:A11 sem_deleted_at:A15
              gemeo_qualquer_conta:A17 gemeo_so_valido:A18,A19 gemeo_inclui_app:A8
              ancora_created_at:A20 ancora_so_updated_at:A21 previsao_sem_coerencia:A22
              previsao_parse_lanca:A23 previsao_fuso_sessao:A28 limiar_zero:A9 limiar_7h:A8
              sem_nivel_broken:A3 message_com_idade:A35 fora_do_v_sources:A38,A40
              fora_do_resumo:A41 acl_authenticated:A44"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
    erros_controle="$(grep -c 'ERROR:  ' "$LOGDIR/controle.log" || true)"
    echo "  ✅ controle VERDE (${asserts_controle:-?} asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha sozinha aprovaria"
    echo "     todas as sabotagens por vermelhidão constante, não por dente)."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi
  case "$asserts_controle" in
    ''|0|*[!0-9]*) echo "  ❌ controle verde SEM recibo PASS/FAIL legível [$asserts_controle] — abortando antes de sabotar."; exit 1 ;;
  esac

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    porta=$((porta+1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    vermelhos="$(grep -Eo '^  ❌ A[0-9]+ ' "$log" | grep -Eo 'A[0-9]+' | tr '\n' ' ' || true)"
    erros_sql="$(grep -c 'ERROR:  ' "$log" || true)"
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! grep -Eq "^  ✅ ($exigido) " "$LOGDIR/controle.log" || ! grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then
      echo "  ❌ $sab — vermelha SEM a sabotagem aplicada (padrão derivou?)"
      { grep -m3 -E 'SABOTAGEM|padrão ocorre|ERROR' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$(executados "$log")" != "$asserts_controle" ]; then
      echo "  ❌ $sab — a suíte NÃO rodou inteira ($(executados "$log") de $asserts_controle asserts): vermelho de aborto"
      tail -3 "$log" | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$erros_sql" != "$erros_controle" ]; then
      echo "  ❌ $sab — vermelha com ERRO de SQL ($erros_sql linha(s) ERROR, controle $erros_controle): não é julgamento"
      { grep -m2 'ERROR:  ' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ -n "$faltam" ]; then
      echo "  ❌ $sab — vermelha, mas o assert declarado não virou:$faltam · vermelhos: ${vermelhos:-nenhum}"
      falhas=$((falhas+1))
    else
      echo "  ✅ $sab — vermelha no assert certo ($exigidos) · vermelhos: $vermelhos"
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  echo
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert declarado ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem o vermelho certo (logs em $LOGDIR) ═══"
  exit 1
fi

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# A cadeia REAL que prod executou até aqui, na ordem: a base cria o check do reprocesso e registra o
# source nas duas pontas; as duas seguintes recriam o compute; a 20260922225500 é o compute vivo em
# 2026-09-30 (md5 a136ea53…, = prod); a última é a desta entrega. Aplicadas com `-1` (transação
# única), como o `db:aplicar` aplica.
MIGS=(
  "$REPO_ROOT/supabase/migrations/20260918200000_data_health_sync_reprocess_saude.sql"
  "$REPO_ROOT/supabase/migrations/20260920210000_sync_reprocess_retry_nao_liquida_erro.sql"
  "$REPO_ROOT/supabase/migrations/20260920233000_sync_reprocess_degradado_so_das_vigiadas.sql"
  "$REPO_ROOT/supabase/migrations/20260922225500_data_health_portal_humano_critico_apos_24h.sql"
)
MIG="$REPO_ROOT/supabase/migrations/20261001011500_data_health_vendas_empurradas_sem_gemeo.sql"
for m in "${MIGS[@]}" "$MIG"; do [ -f "$m" ] || { echo "❌ migration ausente: $m"; exit 1; }; done

echo "═══ setup PG17 :$PORT ═══"
P -q -f "$REPO_ROOT/db/stubs-data-health-trio.sql"
# ACL do compute como em PROD (só postgres/service_role/sandbox_exec), ANTES do apply: assim a POS de
# ACL mede o que a migration faz (CREATE OR REPLACE preserva), não o default do harness.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public._data_health_compute()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint,
               freshness_basis text, message text, last_error text, probable_cause text,
               how_to_fix text, severity text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $stub$ SELECT NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bigint, NULL::text,
                 NULL::text, NULL::text, NULL::text, NULL::text, NULL::text WHERE false $stub$;
REVOKE ALL ON FUNCTION public._data_health_compute() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._data_health_compute() TO service_role;
SQL
for m in "${MIGS[@]}"; do P -q -1 -f "$m" >/dev/null; done
P -q -1 -f "$MIG" >/dev/null
echo "═══ cadeia real + migration nova aplicadas (PRE e POS passaram) ═══"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# SABOTAGEM — no BANCO, recriando a função com UM trecho trocado; o repo nunca é tocado. O padrão
# tem de ocorrer exatamente 1× no corpo (substituição que não pega deixaria a suíte verde).
# ════════════════════════════════════════════════════════════════════════════════════════════════
sabotar() {
  local fn="$1" de="$2" para="$3" tmp
  tmp="$(mktemp "/tmp/sab-${SLUG}.XXXXXX")"
  awk -v fn="CREATE OR REPLACE FUNCTION public.${fn}(" \
      'index($0,fn)==1{f=1} f{print} f && /^\$function\$;$/{exit}' "$MIG" > "$tmp"
  python3 - "$tmp" "$de" "$para" <<'PYSAB' || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× em $fn"; rm -f "$tmp"; exit 9; }
import sys
p, de, para = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
n = s.count(de)
if n != 1:
    print(f"   padrão ocorre {n}x, esperado 1: {de[:70]!r}", file=sys.stderr)
    sys.exit(1)
open(p, "w").write(s.replace(de, para))
PYSAB
  P -q -f "$tmp" >/dev/null
  rm -f "$tmp"
  echo "⚠️  SABOTAGEM ATIVA em $fn — a suíte abaixo DEVE ficar vermelha"
}

C=_data_health_compute
case "${SABOTAGEM:-}" in
  "") ;;
  sem_filtro_status)
    sabotar $C "           AND a.status NOT IN ('cancelado','rascunho','pendente','orcamento')" "           AND true" ;;
  sem_orcamento)
    sabotar $C "a.status NOT IN ('cancelado','rascunho','pendente','orcamento')" "a.status NOT IN ('cancelado','rascunho','pendente')" ;;
  sem_deleted_at)
    sabotar $C "           AND a.deleted_at IS NULL" "           AND true" ;;
  gemeo_qualquer_conta)
    sabotar $C "WHERE t.account = a.account" "WHERE true" ;;
  gemeo_so_valido)
    sabotar $C "AND t.omie_payload IS NULL) AS tem_gemeo" \
               "AND t.omie_payload IS NULL AND t.status <> 'cancelado' AND t.deleted_at IS NULL) AS tem_gemeo" ;;
  gemeo_inclui_app)
    sabotar $C "AND t.omie_payload IS NULL) AS tem_gemeo" ") AS tem_gemeo" ;;
  ancora_created_at)
    sabotar $C "LEAST(prev.updated_at," "LEAST(prev.created_at," ;;
  ancora_so_updated_at)
    sabotar $C "CASE WHEN ((prev.prev_dia + 1)::timestamp AT TIME ZONE 'UTC') >= prev.created_at" "CASE WHEN false" ;;
  previsao_sem_coerencia)
    sabotar $C "CASE WHEN ((prev.prev_dia + 1)::timestamp AT TIME ZONE 'UTC') >= prev.created_at" "CASE WHEN prev.prev_dia IS NOT NULL" ;;
  previsao_parse_lanca)
    sabotar $C "CASE WHEN app.prev_txt ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}\$' THEN" "CASE WHEN app.prev_txt IS NOT NULL THEN" ;;
  previsao_fuso_sessao)
    sabotar $C "THEN (prev.prev_dia + 1)::timestamp AT TIME ZONE 'UTC' END) AS ancora" "THEN (prev.prev_dia + 1)::timestamptz END) AS ancora" ;;
  limiar_zero)
    sabotar $C "anc.ancora < now() - interval '6 hours'" "anc.ancora < now() - interval '0 hours'" ;;
  limiar_7h)
    sabotar $C "anc.ancora < now() - interval '6 hours'" "anc.ancora < now() - interval '7 hours'" ;;
  sem_nivel_broken)
    sabotar $C "c.ancora < now() - interval '6 days'" "c.ancora < now() - interval '60 days'" ;;
  message_com_idade)
    sabotar $C "|| ' ao Omie sem gemeo do importador ha mais de 6 h'" "|| ' ao Omie sem gemeo do importador ha ' || (ve.pior_idade_s / 3600)::text || ' h'" ;;
  fora_do_v_sources)
    sabotar data_health_watchdog "'vendas_empurradas_sem_gemeo'];" "'vendas_empurradas_fora'];" ;;
  fora_do_resumo)
    sabotar fin_sync_heartbeat "'vendas_empurradas_sem_gemeo');" "'vendas_empurradas_fora');" ;;
  acl_authenticated)
    P -q -c "GRANT EXECUTE ON FUNCTION public.fin_sync_heartbeat() TO authenticated;"
    echo "⚠️  SABOTAGEM ATIVA em fin_sync_heartbeat (ACL: EXECUTE de volta a authenticated) — a suíte abaixo DEVE ficar vermelha" ;;
  *) echo "❌ sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac

# ════════════════════════════════════════════════════════════════════════════════════════════════
# MESA DE CONTROLE
# ════════════════════════════════════════════════════════════════════════════════════════════════
# Leitura que ERRA vira VALOR ('ERRO:<sqlstate>'), não linha ERROR no log: o assert julga "o compute
# não pode errar" (é o que a sabotagem do parse mede), e o laço da falsificação não confunde erro com
# dente. O relógio é `public.now()` lendo a GUC test.agora (idioma do molde do reprocesso).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public._ler_vesg(p_campo text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r record; v text;
BEGIN
  IF p_campo = 'linhas' THEN
    SELECT count(*)::text INTO v FROM public._data_health_compute() WHERE source = 'vendas_empurradas_sem_gemeo';
    RETURN v;
  ELSIF p_campo = 'sources' THEN
    SELECT count(*)::text || '/' || count(DISTINCT source)::text INTO v FROM public._data_health_compute();
    RETURN v;
  END IF;
  SELECT * INTO r FROM public._data_health_compute() WHERE source = 'vendas_empurradas_sem_gemeo';
  IF NOT FOUND THEN RETURN '<sem linha>'; END IF;
  RETURN CASE p_campo WHEN 'status' THEN r.status WHEN 'severity' THEN r.severity
                      WHEN 'message' THEN r.message WHEN 'last_error' THEN COALESCE(r.last_error, '')
                      WHEN 'age' THEN r.age_seconds::text WHEN 'max_age' THEN r.expected_max_age_seconds::text END;
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERRO:' || SQLSTATE;
END $f$;

-- Semeia UMA linha do app (e o gêmeo pedido). p_envio = o UPDATE do envio; a previsão default é a
-- data UTC do envio (o que a edge grava). Código = rótulo do cenário no número do pedido.
CREATE OR REPLACE FUNCTION public._semear_venda(
  p_cod int, p_conta text, p_status text, p_envio timestamptz,
  p_criado timestamptz DEFAULT NULL, p_atualizado timestamptz DEFAULT NULL, p_prev text DEFAULT NULL,
  p_total numeric DEFAULT 100, p_apagado boolean DEFAULT false, p_gemeo text DEFAULT 'nenhum',
  p_payload jsonb DEFAULT NULL, p_sem_payload boolean DEFAULT false, p_sem_id boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v_id    bigint := 900000000000 + p_cod;
  v_conta text   := CASE WHEN p_gemeo = 'outra_conta' THEN CASE WHEN p_conta = 'oben' THEN 'colacor' ELSE 'oben' END
                         ELSE p_conta END;
BEGIN
  INSERT INTO public.sales_orders (account, omie_pedido_id, omie_numero_pedido, omie_payload, hash_payload,
                                   status, total, deleted_at, created_at, updated_at)
  VALUES (p_conta, CASE WHEN NOT p_sem_id THEN v_id END, lpad(p_cod::text, 15, '0'),
          CASE WHEN NOT p_sem_payload THEN
            COALESCE(p_payload, jsonb_build_object('cabecalho', jsonb_build_object('data_previsao',
                     COALESCE(p_prev, to_char(p_envio AT TIME ZONE 'UTC', 'DD/MM/YYYY'))))) END,
          NULL, p_status, p_total, CASE WHEN p_apagado THEN p_envio END,
          COALESCE(p_criado, p_envio), COALESCE(p_atualizado, p_envio));
  IF p_gemeo <> 'nenhum' THEN
    INSERT INTO public.sales_orders (account, omie_pedido_id, omie_numero_pedido, omie_payload, hash_payload,
                                     status, total, order_date_kpi, deleted_at, created_at, updated_at)
    VALUES (v_conta, v_id, lpad(p_cod::text, 15, '0'), NULL, 'omie_' || v_conta || '_' || v_id,
            CASE WHEN p_gemeo = 'cancelado' THEN 'cancelado' ELSE 'faturado' END, p_total,
            (p_envio AT TIME ZONE 'America/Sao_Paulo')::date,
            CASE WHEN p_gemeo = 'apagado' THEN p_envio END,
            p_envio - interval '1 hour', p_envio + interval '1 hour');
  END IF;
END $f$;

CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(nullif(current_setting('test.agora', true), '')::timestamptz, pg_catalog.now())
$f$;
ALTER FUNCTION public._data_health_compute() SET search_path = public, pg_catalog, pg_temp;
SQL

T='2026-09-30 15:00:00-03'          # instante da mesa (18:00 UTC)
ler()   { Pq -q -c "SET test.agora = '$2'" -c "SELECT public._ler_vesg('$1');"; }
ler_tz(){ Pq -q -c "SET TimeZone = '$3'" -c "SET test.agora = '$2'" -c "SELECT public._ler_vesg('$1');"; }
# "pedido <cod> " está na lista de órfãs (last_error)?
listada() { case "$(ler last_error "$T")" in *"pedido $1 "*) echo sim ;; *) echo nao ;; esac; }

semear_mesa() {
  P -q -v T="$T" >/dev/null <<'SQL'
TRUNCATE public.sales_orders;
SELECT public._semear_venda(101, 'oben', 'enviado', :'T'::timestamptz - interval '30 hours', p_gemeo => 'mesma_conta');
SELECT public._semear_venda(102, 'oben', 'enviado', :'T'::timestamptz - interval '2 hours');
SELECT public._semear_venda(103, 'oben', 'enviado', :'T'::timestamptz - interval '7 hours');
SELECT public._semear_venda(104, 'oben', 'enviado', :'T'::timestamptz - interval '8 days');
SELECT public._semear_venda(105, 'oben', 'orcamento', :'T'::timestamptz - interval '7 hours');
SELECT public._semear_venda(106, 'oben', 'cancelado', :'T'::timestamptz - interval '7 hours');
SELECT public._semear_venda(107, 'oben', 'rascunho', :'T'::timestamptz - interval '7 hours');
SELECT public._semear_venda(108, 'oben', 'pendente', :'T'::timestamptz - interval '7 hours');
SELECT public._semear_venda(109, 'oben', 'enviado', :'T'::timestamptz - interval '7 hours', p_apagado => true);
SELECT public._semear_venda(110, 'oben', 'faturado', :'T'::timestamptz - interval '7 hours');
SELECT public._semear_venda(111, 'oben', 'importado', :'T'::timestamptz - interval '7 hours');
SELECT public._semear_venda(112, 'oben', 'separacao', :'T'::timestamptz - interval '7 hours');
SELECT public._semear_venda(113, 'oben', 'enviado', :'T'::timestamptz - interval '7 hours', p_gemeo => 'outra_conta');
SELECT public._semear_venda(114, 'oben', 'enviado', :'T'::timestamptz - interval '7 hours', p_gemeo => 'cancelado');
SELECT public._semear_venda(115, 'oben', 'enviado', :'T'::timestamptz - interval '7 hours', p_gemeo => 'apagado');
-- orçamento convertido: a linha nasceu há 30 dias (created_at) e foi empurrada há 1 h
SELECT public._semear_venda(117, 'oben', 'enviado', :'T'::timestamptz - interval '1 hour', p_criado => :'T'::timestamptz - interval '30 days');
-- empurrada há 10 dias e TOCADA há 10 min (updated_at novo): a previsão segura a idade
SELECT public._semear_venda(118, 'oben', 'enviado', :'T'::timestamptz - interval '10 days', p_atualizado => :'T'::timestamptz - interval '10 minutes');
-- previsão anterior à criação: não é carimbo do envio, fica de fora da âncora
SELECT public._semear_venda(119, 'oben', 'enviado', :'T'::timestamptz - interval '3 hours',
                            p_prev => to_char((:'T'::timestamptz - interval '20 days') AT TIME ZONE 'UTC', 'DD/MM/YYYY'));
SELECT public._semear_venda(120, 'oben', 'enviado', :'T'::timestamptz - interval '7 hours', p_prev => '31/02/2026');
SELECT public._semear_venda(121, 'oben', 'enviado', :'T'::timestamptz - interval '2 hours', p_prev => 'abc');
SELECT public._semear_venda(122, 'oben', 'enviado', :'T'::timestamptz - interval '7 hours', p_payload => '[]'::jsonb);
SELECT public._semear_venda(123, 'oben', 'enviado', :'T'::timestamptz - interval '2 hours', p_payload => '{"x":1}'::jsonb);
SELECT public._semear_venda(124, 'colacor', 'enviado', :'T'::timestamptz - interval '9 hours', p_total => 1234.5);
SELECT public._semear_venda(125, 'oben', 'enviado', :'T'::timestamptz - interval '7 hours', p_sem_id => true);
SELECT public._semear_venda(126, 'oben', 'enviado', :'T'::timestamptz - interval '7 hours', p_sem_payload => true);
SQL
}

echo "── contrato: 1 linha, 31 sources, vocabulário ──"
semear_mesa
eq "A1 o source sai em exatamente 1 linha" "$(ler linhas "$T")" "1"
eq "A2 compute com 31 linhas para 31 sources" "$(ler sources "$T")" "31/31"

echo "── a mesa (10 órfãs, 2 fora da janela de 5 dias) ──"
eq "A3 status da mesa = broken (há órfã com mais de 6 dias)" "$(ler status "$T")" "broken"
eq "A4 severity fixa warning" "$(ler severity "$T")" "warning"
eq "A5 message da mesa, exata (contas em ordem, valor BR, data congelada)" "$(ler message "$T")" \
   "10 vendas empurradas ao Omie sem gemeo do importador ha mais de 6 h (2 fora da janela de 5 dias do importador) - colacor: 1 (R\$ 1.234,50, a mais antiga de 30/09/2026); oben: 9 (R\$ 900,00, a mais antiga de 20/09/2026)"
eq "A6 age_seconds = idade da órfã mais antiga (fim do dia UTC 20/09 → T)" "$(ler age "$T")" "842400"
eq "A7 expected_max_age_seconds = 6 h" "$(ler max_age "$T")" "21600"
eq "A8 órfã de 7 h (103) listada" "$(listada 103)" "sim"
eq "A9 órfã de 2 h (102) ainda NÃO listada" "$(listada 102)" "nao"
eq "A10 par completo (101) não listado" "$(listada 101)" "nao"
eq "A11 orcamento (105) fora do universo" "$(listada 105)" "nao"
eq "A12 cancelado (106) fora do universo" "$(listada 106)" "nao"
eq "A13 rascunho (107) fora do universo" "$(listada 107)" "nao"
eq "A14 pendente (108) fora do universo" "$(listada 108)" "nao"
eq "A15 linha apagada (109) fora do universo" "$(listada 109)" "nao"
eq "A16 faturado/importado/separacao (110-112) contam" "$(listada 110)$(listada 111)$(listada 112)" "simsimsim"
eq "A17 gêmeo em OUTRA conta não é gêmeo (113 listada)" "$(listada 113)" "sim"
eq "A18 gêmeo CANCELADO é gêmeo (114 não listada)" "$(listada 114)" "nao"
eq "A19 gêmeo APAGADO é gêmeo (115 não listada)" "$(listada 115)" "nao"
eq "A20 orçamento convertido não acusa antes de 6 h do ENVIO (117)" "$(listada 117)" "nao"
eq "A21 linha tocada depois do envio não rejuvenesce (118 listada)" "$(listada 118)" "sim"
eq "A22 previsão anterior à criação é ignorada (119 não listada)" "$(listada 119)" "nao"
eq "A23 previsão 31/02 não derruba o compute e cai em updated_at (120 listada)" "$(listada 120)" "sim"
eq "A24 previsão ilegível 'abc' cai em updated_at (121, 2 h, não listada)" "$(listada 121)" "nao"
eq "A25 payload que não é objeto (122) cai em updated_at" "$(listada 122)" "sim"
eq "A26 payload sem cabecalho (123, 2 h) não listado" "$(listada 123)" "nao"
eq "A27 sem omie_pedido_id (125) e sem payload (126) fora" "$(listada 125)$(listada 126)" "naonao"

echo "── a message não depende da SESSÃO ──"
eq "A28 fuso da sessão (UTC × São Paulo) não muda a message" \
   "$(ler_tz message "$T" UTC)" "$(ler_tz message "$T" America/Sao_Paulo)"
saida_ln="$(Pq -q -c "SET lc_numeric = 'pt_BR.UTF-8'" -c "SET test.agora = '$T'" -c "SELECT public._ler_vesg('message');" 2>&1)" && rc_ln=0 || rc_ln=$?
if [ "$rc_ln" -eq 0 ]; then
  eq "A29 lc_numeric pt_BR não muda a message" "$saida_ln" "$(ler message "$T")"
else
  echo "  ⚪ A29 NÃO MEDIDO — o servidor não tem o locale pt_BR.UTF-8 (não conta como verde)"
fi

echo "── níveis ──"
P -q -c "DELETE FROM public.sales_orders WHERE omie_numero_pedido IN (lpad('104',15,'0'), lpad('118',15,'0'));"
eq "A30 sem as órfãs de mais de 6 dias → stale" "$(ler status "$T")" "stale"
eq "A31 message stale exata" "$(ler message "$T")" \
   "8 vendas empurradas ao Omie sem gemeo do importador ha mais de 6 h - colacor: 1 (R\$ 1.234,50, a mais antiga de 30/09/2026); oben: 7 (R\$ 700,00, a mais antiga de 30/09/2026)"
P -q -v T="$T" >/dev/null <<'SQL'
TRUNCATE public.sales_orders;
SELECT public._semear_venda(101, 'oben', 'enviado', :'T'::timestamptz - interval '30 hours', p_gemeo => 'mesma_conta');
SELECT public._semear_venda(102, 'oben', 'enviado', :'T'::timestamptz - interval '2 hours');
SQL
eq "A32 sem órfã → ok, com o denominador na message" "$(ler status "$T") | $(ler message "$T")" \
   "ok | Vendas empurradas ao Omie: todas voltaram pelo importador (2 empurradas; 1 aguardando o proximo ciclo)"

echo "── bordas (o relógio decide, em pares de 1 s) ──"
P -q -v T="$T" >/dev/null <<'SQL'
TRUNCATE public.sales_orders;
SELECT public._semear_venda(130, 'oben', 'enviado', :'T'::timestamptz - interval '6 hours');
SELECT public._semear_venda(131, 'oben', 'enviado', :'T'::timestamptz - interval '6 hours 1 second');
SQL
eq "A33 exatamente 6 h não é órfã; 6 h + 1 s é" "$(listada 130)$(listada 131)" "naosim"
P -q -v T="$T" >/dev/null <<'SQL'
TRUNCATE public.sales_orders;
SELECT public._semear_venda(132, 'oben', 'enviado', :'T'::timestamptz - interval '6 days');
SQL
st_6d="$(ler status "$T")"
P -q -v T="$T" >/dev/null <<'SQL'
SELECT public._semear_venda(133, 'oben', 'enviado', :'T'::timestamptz - interval '6 days 1 second');
SQL
eq "A34 exatamente 6 dias é stale; 6 dias + 1 s é broken" "$st_6d → $(ler status "$T")" "stale → broken"

echo "── message estável: o DADO parado, o RELÓGIO cruzando a meia-noite de São Paulo ──"
T0='2026-09-15 23:00:00-03'
T1='2026-09-16 02:00:00-03'
P -q -v T="$T0" >/dev/null <<'SQL'
TRUNCATE public.sales_orders;
SELECT public._semear_venda(140, 'oben', 'enviado', :'T'::timestamptz - interval '7 hours');
SQL
m0="$(ler message "$T0")"; m1="$(ler message "$T1")"
eq "A35 a mesma órfã lida às 23:00 e às 02:00 BRT dá a MESMA message" "$m1" "$m0"
# leitura não numérica (ERRO:… sob sabotagem) vira VALOR do assert, nunca aborto da suíte
a0="$(ler age "$T0")"; a1="$(ler age "$T1")"
case "$a0$a1" in ''|*[!0-9]*) dif_idade="nao-numerico:$a0/$a1" ;; *) dif_idade="$((a1 - a0))" ;; esac
eq "A36 a idade avança com o relógio (10800 s)" "$dif_idade" "10800"
P -q -v T="$T0" >/dev/null <<'SQL'
SELECT public._semear_venda(141, 'oben', 'enviado', :'T'::timestamptz - interval '8 hours');
SQL
if [ "$(ler message "$T1")" != "$m1" ]; then ok "A37 órfã NOVA muda a message (o fato mudou → e-mail pode re-emitir)"; else bad "A37 órfã nova NÃO mudou a message"; fi

# Desliga o relógio controlado: watchdog/heartbeat rodam no compute EXATAMENTE como a migration o deixou.
cfg_compute='search_path=public, pg_temp'
P -q <<'SQL'
ALTER FUNCTION public._data_health_compute() SET search_path = public, pg_temp;
DROP FUNCTION public.now();
SQL
[ "$(Pq -c "SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;")" = "$cfg_compute" ] \
  || { echo "❌ o relógio controlado NÃO foi desligado"; exit 1; }

echo "── as outras 2 pernas do trio EXECUTAM com o source novo ──"
semear_mesa   # no relógio real a mesa inteira é antiga ⇒ o check sai broken e vai ao push
# o watchdog engole erro do compute (dead-man); se ELE errar, a saída vai ao log — o laço da
# falsificação conta ERROR, e vermelho por erro não é dente
saida_wd="$(P -q -c "SELECT public.data_health_watchdog();" 2>&1)" && rc_wd=0 || rc_wd=$?
[ "$rc_wd" -eq 0 ] || printf '%s\n' "$saida_wd"
eq "A38 watchdog avalia 23 checks (o v_sources)" \
   "$rc_wd | $(Pq -c "SELECT checks_avaliados::text FROM public.data_health_watchdog_estado WHERE id;")" "0 | 23"
eq "A39 checks_falhos=0 (conta exceção, não negócio)" \
   "$(Pq -c "SELECT checks_falhos::text FROM public.data_health_watchdog_estado WHERE id;")" "0"
eq "A40 watchdog ROTEOU o source novo ao episódio (push)" \
   "$(Pq -c "SELECT (count(*) > 0)::text FROM public._spy_episodio WHERE tipo = 'data_health_vendas_empurradas_sem_gemeo';")" "true"
P -q -c "SELECT public.fin_sync_heartbeat();" >/dev/null 2>&1 && rc_hb=0 || rc_hb=$?
eq "A41 resumo diário (heartbeat) traz o source novo com o status" \
   "$rc_hb | $(Pq -c "SELECT COALESCE(bool_or(mensagem LIKE '%vendas_empurradas_sem_gemeo: broken%'), false)::text FROM public.fornecedor_alerta;")" \
   "0 | true"

echo "── ACL: authenticated não dispara o watchdog nem o heartbeat (cada chamada do heartbeat é um e-mail) ──"
# Comportamental, sob SET ROLE authenticated: a SQLSTATE exata 42501 (ASCII, invariante a locale).
# A saída é capturada — a recusa é o esperado, e linha ERROR no log confundiria o laço da falsificação.
como_authenticated() {
  local out
  if out="$(P -q -v VERBOSITY=verbose -c "SET ROLE authenticated" -c "SELECT public.$1();" 2>&1)"; then echo EXECUTOU
  else case "$out" in *42501*) echo 42501 ;; *) echo OUTRO_ERRO ;; esac; fi
}
eq "A44 authenticated recebe 42501 no watchdog e no heartbeat" \
   "$(como_authenticated data_health_watchdog) $(como_authenticated fin_sync_heartbeat)" "42501 42501"

echo "── a migration: re-aplicar é inócuo; a PRE recusa corpo estranho ──"
md5s() { Pq -c "SELECT string_agg(md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE oid IN ('public._data_health_compute()'::regprocedure, 'public.data_health_watchdog()'::regprocedure, 'public.fin_sync_heartbeat()'::regprocedure);"; }
antes="$(md5s)"
P -q -1 -f "$MIG" >/dev/null 2>&1 && rc_re=0 || rc_re=$?
eq "A42 re-aplicar a migration passa e nenhum corpo muda" "$rc_re | $(md5s)" "0 | $antes"
P -q <<'SQL'
DO $x$ DECLARE d text; BEGIN
  SELECT pg_get_functiondef('public.data_health_watchdog()'::regprocedure) INTO d;
  EXECUTE replace(d, 'v_deadman_h int := 3;', 'v_deadman_h int := 3; -- corpo estranho (prova da PRE)');
END $x$;
SQL
md5_estranho="$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.data_health_watchdog()'::regprocedure;")"
saida_pre="$(P -q -1 -v VERBOSITY=verbose -f "$MIG" 2>&1)" && rc_pre=0 || rc_pre=$?
case "$saida_pre" in *"P0001"*"PRE FALHOU: public.data_health_watchdog()"*) marca_pre=sim ;; *) marca_pre=nao ;; esac
eq "A43 PRE recusa o corpo estranho (P0001, nomeando a função) e o preserva" \
   "$rc_pre | $marca_pre | $(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.data_health_watchdog()'::regprocedure;")" \
   "3 | sim | $md5_estranho"

echo
echo "PASS=${PASS}  FAIL=${FAIL}"
echo "═══ ${PASS} passaram · ${FAIL} falharam ═══"
[ "$FAIL" -eq 0 ] || exit 1
