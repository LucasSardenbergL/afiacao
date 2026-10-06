#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — a venda empurrada ganha order_date_kpi NO ENVIO (o trigger da linha do app deriva)
# ║      bash db/test-sales-orders-kpi-no-envio.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-sales-orders-kpi-no-envio.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-sales-orders-kpi-no-envio.sh   (2º idioma do servidor)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Sobre a migration REAL (*_sales_orders_kpi_no_envio.sql), por cima da cadeia real (coerência →
# ║  importador → gêmeos 20261001100001), com a RPC REAL do importador e o servidor em TimeZone=UTC
# ║  (como a prod):
# ║   · a costura do relógio é o statement (DO com pg_sleep; > now() numa transação de vários comandos);
# ║   · o write-back (o UPDATE do criarPedidoVenda, SEM kpi) deriva o dia de SP — 06/10 01:30Z → 05/10,
# ║     bordas 02:59:59Z/03:00Z; INSERT já com pid deriva; kpi explícito é respeitado;
# ║   · só no ENVIO: o import depois do push não re-deriva (RPC real: inserted, app marcado, a venda conta
# ║     1× com o total da importada); UPDATE sem transição, DELETE da importada e reimport também não;
# ║   · a 2ª linha do app no mesmo pedido não quebra o write-back; mesmo pid em contas diferentes;
# ║     orçamento convertido; o bundle velho que regrava 'rascunho'; papel sem EXECUTE; hash próprio;
# ║   · corrida nos dois sentidos, determinística (bandeira + pg_stat_activity);
# ║   · em clones da prod de hoje: reaplicar = no-op, a PRE recusa corpo desconhecido, a POS tem dente,
# ║     o ACL fecha.
# ║  Spec: docs/superpowers/specs/2026-10-05-app-grava-kpi-no-envio-design.md
# ╚═══════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5601}"
SLUG="kpi-no-envio"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC
unset PGTZ PGOPTIONS            # o fuso da SESSÃO é o do servidor (UTC, como a prod): a sabotagem data_da_sessao depende disso

# ════════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar — o laço de db/test-gemeos-push-pull-contagem-unica.sh, verbatim no método: controle
# VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e cada sabotagem só conta se
# (1) aplicou, (2) a suíte rodou INTEIRA (mesmo PASS+FAIL do controle), (3) CADA assert declarado
# estava verde no controle e virou vermelho aqui, (4) sem ERRO de SQL que o controle não tem.
# docs/historico/falsificacao-exit-nao-e-dente.md
# ════════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_derivacao:A4,A5,A8,A18 fuso_utc:A4,A5 data_da_sessao:A4,A5
              sem_condicao_envio:A11,A13 sem_envio_nem_autoguarda:A6,A21
              sobrescreve_kpi:A10 sem_guarda_outra_linha:A12
              costura_clock:A2 costura_now:A3
              pre_sem_identidade:A24 pos_sem_dente:A25 sem_revoke:A26 pos_sem_dono:A27"
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

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
# PG DESCARTÁVEL: durabilidade desligada (não muda nada do que é provado); deadlock_timeout curto;
# TimeZone=UTC como a PROD — o 'UTC' por engano e o ::date puro só erram com o servidor em UTC.
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c TimeZone=UTC -c fsync=off -c full_page_writes=off -c synchronous_commit=off -c deadlock_timeout=200ms" \
  -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
Pd() { local db="$1"; shift; "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }

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

# SQLSTATE da saída de erro (ASCII, invariante a lc_messages). NUNCA deixa a linha do servidor no log:
# o juiz do --falsificar conta 'ERROR:  ' e uma sabotagem bem-sucedida não pode parecer erro de SQL.
sqlstate() { local s; s="$(grep -o -E '^[A-Z]+:  [0-9A-Z]{5}' | grep -o -E '[0-9A-Z]{5}$' | head -1 || true)"; printf '%s' "${s:-SEM_SQLSTATE}"; }
rodar() { local out; if out="$(P -q -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo OK; else printf '%s\n' "$out" | sqlstate; fi; }

MIG_COER="$REPO_ROOT/supabase/migrations/20260907220000_pedido_venda_coerencia_agregado.sql"
MIG_RPC="$(find "$REPO_ROOT/supabase/migrations" -name "*_desconto_valor_atravessa_os_escritores.sql" | sort | tail -1)"
MIG_GEMEOS="$REPO_ROOT/supabase/migrations/20261001100001_sales_orders_gemeo_importado_contagem_unica.sql"
MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_sales_orders_kpi_no_envio.sql" | sort | tail -1)"
for m in "$MIG_COER" "$MIG_RPC" "$MIG_GEMEOS" "$MIG"; do
  [ -n "$m" ] && [ -f "$m" ] || { echo "❌ migration ausente: [$m] — a prova testaria o NADA"; exit 1; }
done

c1="11111111-1111-1111-1111-111111111111"    # cliente A
c2="22222222-2222-2222-2222-222222222222"    # cliente B
sys="33333333-3333-3333-3333-333333333333"   # usuário de sistema do importador
vend="44444444-4444-4444-4444-444444444444"  # vendedor (linha do app)
p1="aaaaaaaa-0000-0000-0000-000000000001"    # produto 555
app() { echo "a0000000-0000-0000-0000-000000000$1"; }   # id da linha do app do pedido $1 (3 dígitos)
imp() { echo "b0000000-0000-0000-0000-000000000$1"; }   # id da importada SEMEADA do pedido $1

echo "═══ setup PG17 :$PORT · locale do servidor=$LOC · TimeZone=UTC ═══"
# ── schema mínimo fiel à prod (o mesmo de db/test-gemeos-push-pull-contagem-unica.sh) ─────────────
P -q <<'SQL'
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), omie_codigo_produto bigint, account text);
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, created_by uuid NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0, discount numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'rascunho', notes text,
  omie_pedido_id bigint, omie_numero_pedido text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  account text NOT NULL DEFAULT 'oben', hash_payload text,
  customer_address text, customer_phone text, order_date_kpi date, deleted_at timestamptz,
  omie_payload jsonb, omie_response jsonb, omie_reconciliado_em timestamptz,
  CONSTRAINT sales_orders_hash_omie_canonico CHECK (hash_payload IS NULL OR hash_payload NOT LIKE 'omie\_%'
    OR (omie_pedido_id IS NOT NULL AND hash_payload = 'omie_' || account || '_' || omie_pedido_id)));
CREATE UNIQUE INDEX uniq_sales_orders_omie_hash
  ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';
CREATE UNIQUE INDEX uniq_sales_orders_omie_pedido_id
  ON public.sales_orders (account, omie_pedido_id) WHERE hash_payload IS NOT NULL AND omie_pedido_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN NEW.updated_at := now(); RETURN NEW; END $f$;
CREATE TRIGGER update_sales_orders_updated_at BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL,
  product_id uuid REFERENCES public.omie_products(id),
  omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1, unit_price numeric, discount numeric DEFAULT 0,
  desconto_valor numeric, omie_codigo_item bigint,
  created_at timestamptz DEFAULT now(), hash_payload text);
CREATE TABLE public.sales_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, product_id uuid NOT NULL, unit_price numeric NOT NULL,
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now());
SQL
# a cadeia REAL que a prod executou, na ordem lexical: coerência (DEFERRED) → importador
P -q -1 -f "$MIG_COER" >/dev/null
P -q -1 -f "$MIG_RPC" >/dev/null

# ── backlog como a prod tinha antes dos gêmeos (o mesmo da prova dos gêmeos) ─────────────────────────
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$c1'),('$c2'),('$sys'),('$vend') ON CONFLICT DO NOTHING;
INSERT INTO public.omie_products(id, omie_codigo_produto, account) VALUES ('$p1', 555, 'oben');
INSERT INTO public.sales_orders (id, customer_user_id, created_by, status, total, account, omie_pedido_id,
                                 hash_payload, omie_payload, order_date_kpi, created_at) VALUES
  ('$(app 101)', '$c1', '$vend', 'enviado',   527.20, 'oben',    101,  NULL,            '{}', '2026-04-06', '2026-04-06 13:49Z'),
  ('$(imp 101)', '$c1', '$sys',  'faturado',  600,    'oben',    101,  'omie_oben_101', NULL, '2026-04-06', '2026-04-06 12:00Z'),
  ('$(app 102)', '$c1', '$vend', 'enviado',   527.20, 'oben',    102,  NULL,            '{}', '2026-04-06', '2026-04-06 13:55Z'),
  ('$(imp 102)', '$c2', '$sys',  'faturado',  560,    'oben',    102,  'omie_oben_102', NULL, '2026-04-06', '2026-04-06 12:00Z'),
  ('$(app 103)', '$c1', '$vend', 'enviado',   240,    'oben',    103,  NULL,            '{}', NULL,         '2026-06-10 11:43Z'),
  ('$(imp 103)', '$c1', '$sys',  'faturado',  339.10, 'oben',    103,  'omie_oben_103', NULL, '2026-06-10', '2026-06-10 12:00Z'),
  ('$(app 104)', '$c1', '$vend', 'enviado',   314.40, 'oben',    104,  NULL,            '{}', '2026-04-06', '2026-04-06 18:55Z'),
  ('$(app 105)', '$c1', '$vend', 'orcamento', 4660,   'oben',    NULL, NULL,            NULL, NULL,         '2026-06-12 15:00Z'),
  ('$(app 106)', '$c1', '$vend', 'rascunho',  10,     'oben',    NULL, NULL,            NULL, NULL,         '2026-06-12 15:05Z'),
  ('$(app 107)', '$c1', '$vend', 'enviado',   50,     'colacor', 107,  NULL,            '{}', '2026-04-07', '2026-04-07 14:00Z'),
  ('$(imp 107)', '$c2', '$sys',  'faturado',  70,     'oben',    107,  'omie_oben_107', NULL, '2026-04-07', '2026-04-07 12:00Z'),
  ('$(app 108)', '$c1', '$vend', 'enviado',   25,     'oben',    108,  NULL,            '{}', '2026-04-08', '2026-04-08 10:00Z'),
  ('a1000000-0000-0000-0000-000000000108', '$c1', '$vend', 'enviado', 25, 'oben', 108, NULL, '{}', '2026-04-08', '2026-04-08 10:05Z'),
  ('$(imp 108)', '$c1', '$sys',  'faturado',  30,     'oben',    108,  'omie_oben_108', NULL, '2026-04-08', '2026-04-08 12:00Z');
SQL
# os gêmeos, como a prod os tem desde 2026-10-05 (o corpo que esta entrega substitui)
P -q -1 -f "$MIG_GEMEOS" >/dev/null

nova_app() {  # $1 = total[, $2 = status, $3 = conta] → linha do app SEM pid, como o balcão/orçamento a criam
  Pq -q -c "INSERT INTO public.sales_orders (customer_user_id, created_by, status, total, account) VALUES ('$c1', '$vend', '${2:-rascunho}', $1, '${3:-oben}') RETURNING id;"
}
write_back() {  # $1 = id da linha do app, $2 = pid → o UPDATE do criarPedidoVenda (omie-vendas-sync), SEM kpi
  echo "UPDATE public.sales_orders SET omie_pedido_id = $2, omie_numero_pedido = '$2', omie_payload = '{}'::jsonb, omie_response = '{}'::jsonb, status = 'enviado' WHERE id = '$1';"
}
# uma linha do app empurrada ANTES desta entrega (pid, sem gêmeo, sem kpi): o A11 parte dela, e a POS
# dos clones tem de aceitá-la (spec §8.5: a empurrada antes do apply não ganha kpi).
PRE_APPLY="$(nova_app 70)"
P -q -c "$(write_back "$PRE_APPLY" 1100)"
# MOLDE = a prod de hoje (cadeia + gêmeos + backlog), SEM esta migration: os clones do A23–A26 partem daqui.
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T prove molde

echo "═══ migration desta entrega: $(basename "$MIG") ═══"
eq "A1 a migration aplica e a postcondição passa" "$(P -q -1 -f "$MIG" >/dev/null 2>&1 && echo OK || echo FALHOU)" "OK"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# SABOTAGEM — no BANCO, recriando a função com UM trecho trocado; o repo nunca é tocado. O padrão
# tem de ocorrer exatamente 1× no bloco (substituição que não pega deixaria a suíte verde). As três
# últimas são aplicadas nos clones (A24–A26), sobre CÓPIAS da migration.
# ════════════════════════════════════════════════════════════════════════════════════════════════
trocar() {  # $1 arquivo, $2 de, $3 para — o padrão tem de ocorrer exatamente 1×
  python3 - "$1" "$2" "$3" <<'PYSAB'
import sys
p, de, para = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
n = s.count(de)
if n != 1:
    print(f"   padrão ocorre {n}x, esperado 1: {de[:70]!r}", file=sys.stderr)
    sys.exit(1)
open(p, "w").write(s.replace(de, para))
PYSAB
}
sabotar() {
  local fn="$1" de="$2" para="$3" tmp
  tmp="$(mktemp "/tmp/sab-${SLUG}.XXXXXX")"
  awk -v fn="CREATE OR REPLACE FUNCTION public.${fn}(" \
      'index($0,fn)==1{f=1} f{print} f && /^\$function\$;$/{exit}' "$MIG" > "$tmp"
  trocar "$tmp" "$de" "$para" || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× em $fn"; rm -f "$tmp"; exit 9; }
  P -q -f "$tmp" >/dev/null
  rm -f "$tmp"
  echo "⚠️  SABOTAGEM ATIVA em $fn — a suíte abaixo DEVE ficar vermelha"
}

sabotar_duplo() {  # $1 = função, $2/$3 = 1ª troca, $4/$5 = 2ª troca — as duas no MESMO corpo
  local fn="$1" tmp
  tmp="$(mktemp "/tmp/sab-${SLUG}.XXXXXX")"
  awk -v fn="CREATE OR REPLACE FUNCTION public.${fn}(" \
      'index($0,fn)==1{f=1} f{print} f && /^\$function\$;$/{exit}' "$MIG" > "$tmp"
  { trocar "$tmp" "$2" "$3" && trocar "$tmp" "$4" "$5"; } \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — um dos padrões não ocorre exatamente 1× em $fn"; rm -f "$tmp"; exit 9; }
  P -q -f "$tmp" >/dev/null
  rm -f "$tmp"
  echo "⚠️  SABOTAGEM ATIVA em $fn (2 trechos) — a suíte abaixo DEVE ficar vermelha"
}

case "${SABOTAGEM:-}" in
  "") ;;
  sem_derivacao)
    sabotar sales_orders_gemeo_app_derivar \
      "      NEW.order_date_kpi := (public.sales_orders_instante_envio() AT TIME ZONE 'America/Sao_Paulo')::date;" "      NULL;" ;;
  fuso_utc)
    sabotar sales_orders_gemeo_app_derivar "AT TIME ZONE 'America/Sao_Paulo'" "AT TIME ZONE 'UTC'" ;;
  data_da_sessao)
    sabotar sales_orders_gemeo_app_derivar \
      "(public.sales_orders_instante_envio() AT TIME ZONE 'America/Sao_Paulo')::date" "public.sales_orders_instante_envio()::date" ;;
  sem_condicao_envio)
    sabotar sales_orders_gemeo_app_derivar "    IF v_envio AND NOT EXISTS" "    IF NOT EXISTS" ;;
  sem_envio_nem_autoguarda)
    # o caminho do import tem DUAS travas: a condição de envio e a própria linha na guarda (a versão velha
    # dela tem o kpi). Cada uma sozinha segura o A6/A21; sem as duas, o import cai em 23505 (o S9 do spike).
    sabotar_duplo sales_orders_gemeo_app_derivar "    IF v_envio AND NOT EXISTS" "    IF NOT EXISTS" \
      "AND o.order_date_kpi IS NOT NULL) THEN" "AND o.order_date_kpi IS NOT NULL AND o.id <> NEW.id) THEN" ;;
  sobrescreve_kpi)
    sabotar sales_orders_gemeo_app_derivar "  ELSIF NEW.order_date_kpi IS NULL THEN" "  ELSIF true THEN" ;;
  sem_guarda_outra_linha)
    sabotar sales_orders_gemeo_app_derivar "AND o.order_date_kpi IS NOT NULL) THEN" "AND false) THEN" ;;
  costura_clock)
    sabotar sales_orders_instante_envio "SELECT pg_catalog.statement_timestamp()" "SELECT pg_catalog.clock_timestamp()" ;;
  costura_now)
    sabotar sales_orders_instante_envio "SELECT pg_catalog.statement_timestamp()" "SELECT pg_catalog.now()" ;;
  pre_sem_identidade|pos_sem_dente|sem_revoke|pos_sem_dono) ;;   # aplicadas nos clones (A24–A27)
  *) echo "❌ sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac

# ── leituras ───────────────────────────────────────────────────────────────────────────────────────
# 't' quando a linha do app $1 está marcada: sem kpi e apontando para a importada do mesmo pedido.
marcada() { Pq -c "SELECT (a.order_date_kpi IS NULL AND i.id IS NOT NULL AND a.gemeo_importado_id IS NOT DISTINCT FROM i.id)
  FROM public.sales_orders a LEFT JOIN public.sales_orders i ON i.account = a.account AND i.hash_payload LIKE 'omie\_%'
   AND i.hash_payload = 'omie_' || a.account || '_' || a.omie_pedido_id WHERE a.id = '$1';"; }
kpi_ptr() { Pq -c "SELECT coalesce(order_date_kpi::text, 'nulo') || '|' || CASE WHEN gemeo_importado_id IS NULL THEN 'nulo' ELSE 'ptr' END
  FROM public.sales_orders WHERE id = '$1';"; }
dup_kpi() { Pq -c "SELECT count(*) FROM (SELECT 1 FROM public.sales_orders WHERE omie_pedido_id IS NOT NULL AND order_date_kpi IS NOT NULL
  GROUP BY account, omie_pedido_id HAVING count(*) > 1) d;"; }
canon() {  # $1 = pid[, $2 = conta] → "receita|linhas" do universo canônico daquele pedido Omie
  Pq -c "SELECT coalesce(sum(total)::text, 'nada') || '|' || count(*) FROM public.sales_orders
          WHERE account = '${2:-oben}' AND omie_pedido_id = $1 AND order_date_kpi IS NOT NULL
            AND status NOT IN ('cancelado','rascunho','pendente','orcamento') AND deleted_at IS NULL;"
}
DATA_OMIE='"order_date_kpi":"2026-10-05",'   # o dInc do Omie = o dia de SP do envio (25/25 na prod)
payload() {  # $1 = pid, $2 = total → 1 pedido do Omie da OBEN; items-jsonb ≡ itens (o trigger de coerência exige)
  printf '%s' "'[{\"customer_user_id\":\"$c1\",\"created_by\":\"$sys\",\"account\":\"oben\",\"hash_payload\":\"omie_oben_${1}\",\"omie_pedido_id\":${1},\"omie_numero_pedido\":\"${1}\",\"status\":\"importado\",${DATA_OMIE}\"created_at\":\"2026-10-05T12:00:00Z\",\"subtotal\":${2},\"discount\":0,\"total\":${2},\"items\":[{\"omie_codigo_produto\":555,\"quantidade\":1,\"valor_unitario\":${2},\"desconto\":0}],\"itens\":[{\"omie_codigo_produto\":555,\"quantity\":1,\"unit_price\":${2},\"discount\":0,\"hash_payload\":\"omie_oben_${1}_555\"}]}]'::jsonb"
}
rpc() { Pq -c "SELECT (r->>'inserted') || '|' || (r->>'skipped_complete') || '|' || jsonb_array_length(r->'failed')
  FROM (SELECT public.criar_pedidos_com_itens($(payload "$1" "$2")) AS r) x;"; }

echo "═══ a costura do relógio (a função REAL desta migration) ═══"
# shellcheck disable=SC2016  # $d$/$m$ são dollar-quotes do PostgreSQL, não variáveis do shell
COSTURA_FIXA='DO $d$ DECLARE a timestamptz; b timestamptz; BEGIN
  a := public.sales_orders_instante_envio(); PERFORM pg_sleep(0.2); b := public.sales_orders_instante_envio();
  IF a IS DISTINCT FROM b THEN RAISE EXCEPTION $m$a costura andou dentro do statement$m$; END IF;
END $d$;'
eq "A2 a costura é fixa no statement (2 leituras com pg_sleep entre elas: iguais)" "$(rodar "$COSTURA_FIXA")" "OK"
r3="$(Pq -q 2>/dev/null <<'SQL'
BEGIN;
SELECT pg_sleep(0.2);
SELECT public.sales_orders_instante_envio() > now();
COMMIT;
SQL
)" || r3="ERRO"
eq "A3 a costura é o statement, não a transação (> now() num comando posterior da mesma transação)" \
   "$(printf '%s\n' "$r3" | grep -v '^$' | tail -1)" "t"

# Daqui em diante o instante é FIXO (GUC test.instante; sem ela, o statement): só assim "dia de SP, nunca
# UTC" se prova em qualquer hora. CREATE OR REPLACE preserva o ACL que a migration fechou.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.sales_orders_instante_envio()
 RETURNS timestamp with time zone LANGUAGE sql STABLE
AS $f$ SELECT coalesce(nullif(current_setting('test.instante', true), '')::timestamptz, pg_catalog.statement_timestamp()) $f$;
ALTER DATABASE prove SET test.instante = '2026-10-06 01:30:00+00';
SQL

echo "═══ o envio deriva o dia de SP ═══"
A4ID="$(nova_app 100)"
P -q -c "$(write_back "$A4ID" 1001)"
eq "A4 o write-back sem gêmeo deriva o dia de SP do instante (06/10 01:30Z → 2026-10-05)" "$(kpi_ptr "$A4ID")" "2026-10-05|nulo"
A5a="$(nova_app 100)"; A5b="$(nova_app 100)"
P -q -c "SET test.instante = '2026-10-06 02:59:59+00'; $(write_back "$A5a" 1002)"
P -q -c "SET test.instante = '2026-10-06 03:00:00+00'; $(write_back "$A5b" 1003)"
eq "A5 bordas da meia-noite de SP: 02:59:59Z → 05/10 · 03:00:00Z → 06/10" \
   "$(kpi_ptr "$A5a")|$(kpi_ptr "$A5b")" "2026-10-05|nulo|2026-10-06|nulo"

echo "═══ só no ENVIO: o importador e os UPDATEs seguintes não re-derivam ═══"
A6ID="$(nova_app 100)"
P -q -c "$(write_back "$A6ID" 1010)"
r6="$(rpc 1010 120)"
eq "A6 import depois do push (RPC real): inserted, app marcado, importada com o dInc, a venda conta 1× com o total da importada" \
   "$r6|$(kpi_ptr "$A6ID")|$(Pq -c "SELECT order_date_kpi FROM public.sales_orders WHERE hash_payload = 'omie_oben_1010';")|$(canon 1010)" \
   "1|0|0|nulo|ptr|2026-10-05|120|1"
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 1020 80));" >/dev/null
A7ID="$(nova_app 80)"
r7="$(rodar "$(write_back "$A7ID" 1020)")"
eq "A7 push DEPOIS do import: o write-back passa e não deriva (a importada já é a venda)" \
   "$r7|$(kpi_ptr "$A7ID")|$(canon 1020)" "OK|nulo|ptr|80|1"
r8="$(rodar "INSERT INTO public.sales_orders (id, customer_user_id, created_by, status, total, omie_pedido_id, omie_payload) VALUES ('c0000000-0000-0000-0000-000000001030', '$c1', '$vend', 'enviado', 40, 1030, '{}');")"
eq "A8 linha do app que JÁ NASCE com pid (sem gêmeo) deriva o kpi" "$r8|$(kpi_ptr c0000000-0000-0000-0000-000000001030)" "OK|2026-10-05|nulo"
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 1031 41));" >/dev/null
r9="$(rodar "INSERT INTO public.sales_orders (id, customer_user_id, created_by, status, total, omie_pedido_id, omie_payload) VALUES ('c0000000-0000-0000-0000-000000001031', '$c1', '$vend', 'enviado', 41, 1031, '{}');")"
eq "A9 linha do app que nasce com pid de pedido JÁ importado nasce marcada, sem kpi" "$r9|$(kpi_ptr c0000000-0000-0000-0000-000000001031)" "OK|nulo|ptr"
r10a="$(rodar "INSERT INTO public.sales_orders (id, customer_user_id, created_by, status, total, omie_pedido_id, omie_payload, order_date_kpi) VALUES ('c0000000-0000-0000-0000-000000001040', '$c1', '$vend', 'enviado', 42, 1040, '{}', DATE '2026-04-06');")"
A10ID="$(nova_app 43)"
r10b="$(rodar "UPDATE public.sales_orders SET omie_pedido_id = 1041, omie_numero_pedido = '1041', omie_payload = '{}'::jsonb, status = 'enviado', order_date_kpi = DATE '2026-04-07' WHERE id = '$A10ID';")"
eq "A10 kpi explícito é respeitado (INSERT com pid e kpi; write-back que traz o kpi)" \
   "$r10a|$(kpi_ptr c0000000-0000-0000-0000-000000001040)|$r10b|$(kpi_ptr "$A10ID")" "OK|2026-04-06|nulo|OK|2026-04-07|nulo"
r11="$(rodar "UPDATE public.sales_orders SET omie_pedido_id = omie_pedido_id, account = account WHERE id = '$PRE_APPLY';")"
eq "A11 linha empurrada ANTES do apply: UPDATE sem transição de pid não deriva" "$r11|$(kpi_ptr "$PRE_APPLY")" "OK|nulo|nulo"
A12a="$(nova_app 25)"; A12b="$(nova_app 25)"
P -q -c "$(write_back "$A12a" 1060)"
r12="$(rodar "$(write_back "$A12b" 1060)")"
eq "A12 2ª linha do app no MESMO pedido (só por SQL manual): o write-back passa e só a 1ª tem kpi" \
   "$r12|$(kpi_ptr "$A12a")|$(kpi_ptr "$A12b")|$(dup_kpi)" "OK|2026-10-05|nulo|nulo|nulo|0"
A13ID="$(nova_app 70)"
P -q -c "$(write_back "$A13ID" 1070)"
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 1070 70));" >/dev/null
r13="$(rodar "DELETE FROM public.sales_orders WHERE hash_payload = 'omie_oben_1070';")"
depois_delete="$(kpi_ptr "$A13ID")"
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 1070 70));" >/dev/null
eq "A13 apagar a importada não re-deriva o kpi do app; o reimport refaz o ponteiro" \
   "$r13|$depois_delete|$(marcada "$A13ID")" "OK|nulo|nulo|t"
r14="$(rodar "UPDATE public.sales_orders SET account = account WHERE id IN ('$(app 105)', '$(app 106)');")"
eq "A14 orçamento e rascunho (sem pid) seguem sem kpi e sem ponteiro, mesmo tocando coluna observada" \
   "$r14|$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id IN ('$(app 105)', '$(app 106)') AND (gemeo_importado_id IS NOT NULL OR order_date_kpi IS NOT NULL);")" "OK|0"
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 1150 55));" >/dev/null
A15ID="$(nova_app 50 rascunho colacor)"
P -q -c "$(write_back "$A15ID" 1150)"
eq "A15 mesmo pid em contas diferentes: a COLACOR deriva o kpi dela; a venda da OBEN segue sendo a importada" \
   "$(kpi_ptr "$A15ID")|$(canon 1150 colacor)|$(canon 1150 oben)" "2026-10-05|nulo|50|1|55|1"

echo "═══ os caminhos do app (Review Focus) ═══"
A16ID="$(nova_app 300 orcamento)"
P -q -c "$(write_back "$A16ID" 1160)"
eq "A16 orçamento convertido (SalesQuotes → edge): o write-back leva a 'enviado', deriva o kpi e a venda entra no universo" \
   "$(Pq -c "SELECT status FROM public.sales_orders WHERE id = '$A16ID';")|$(kpi_ptr "$A16ID")|$(canon 1160)" "enviado|2026-10-05|nulo|300|1"
A17ID="$(nova_app 310 orcamento)"
P -q -c "$(write_back "$A17ID" 1170)"
P -q -c "UPDATE public.sales_orders SET status = 'rascunho' WHERE id = '$A17ID';"   # o SalesQuotes ANTIGO
antes_import="$(kpi_ptr "$A17ID")|$(canon 1170)"
r17="$(rpc 1170 320)"
eq "A17 bundle velho regrava 'rascunho' depois do envio: o kpi fica, a venda sai pelo status e volta 1× pela importada" \
   "$antes_import|$r17|$(kpi_ptr "$A17ID")|$(canon 1170)" "2026-10-05|nulo|nada|0|1|0|0|nulo|ptr|320|1"
P -q <<'SQL'
CREATE ROLE escritor_sem_exec NOLOGIN;
GRANT USAGE ON SCHEMA public TO escritor_sem_exec;
GRANT SELECT, INSERT, UPDATE ON public.sales_orders TO escritor_sem_exec;
SQL
# O dono das funções SEM superusuário, como a prod (postgres tem rolsuper=f): no harness o postgres é
# superusuário e pularia a checagem de EXECUTE que o trigger SECURITY DEFINER faz ao chamar a costura.
P -q <<'SQL'
CREATE ROLE dono_sem_super NOLOGIN NOSUPERUSER;
GRANT USAGE ON SCHEMA public TO dono_sem_super;
GRANT SELECT ON public.sales_orders TO dono_sem_super;
ALTER FUNCTION public.sales_orders_gemeo_app_derivar() OWNER TO dono_sem_super;
ALTER FUNCTION public.sales_orders_instante_envio()    OWNER TO dono_sem_super;
SQL
A18ID="$(nova_app 60)"
sem_exec="$(Pq -c "SELECT has_function_privilege('escritor_sem_exec', 'public.sales_orders_instante_envio()', 'EXECUTE')
                       OR has_function_privilege('escritor_sem_exec', 'public.sales_orders_gemeo_app_derivar()', 'EXECUTE');")"
r18="$(rodar "SET ROLE escritor_sem_exec; $(write_back "$A18ID" 1180)")"
P -q <<'SQL'
ALTER FUNCTION public.sales_orders_gemeo_app_derivar() OWNER TO postgres;
ALTER FUNCTION public.sales_orders_instante_envio()    OWNER TO postgres;
SQL
eq "A18 papel SEM EXECUTE nas funções (o service_role depois do REVOKE), com o dono delas SEM superusuário (como a prod), faz o write-back e o kpi nasce" \
   "$sem_exec|$r18|$(kpi_ptr "$A18ID")" "f|OK|2026-10-05|nulo"
A19ID="$(Pq -q -c "INSERT INTO public.sales_orders (customer_user_id, created_by, status, total, hash_payload) VALUES ('$c1', '$vend', 'rascunho', 19, 'checkout_abc') RETURNING id;")"
r19="$(rodar "$(write_back "$A19ID" 1190)")"
eq "A19 linha com hash PRÓPRIO (não omie_) empurrada: o trigger não a observa — sem kpi, sem erro (como hoje)" \
   "$r19|$(kpi_ptr "$A19ID")" "OK|nulo|nulo"

echo "═══ corrida: o advisory lock serializa write-back e importador ═══"
P -q -c "CREATE TABLE public._prova_bandeira (id int);"
Pbg() {  # $1 = application_name, $2 = SQL → conexão própria (para segurar transação ou esperar lock)
  PGAPPNAME="$1" "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q -tA -c "$2"
}
# shellcheck disable=SC2016  # $w$ é o dollar-quote do PostgreSQL, não variável do shell: não pode expandir
SEGURAR='DO $w$ BEGIN WHILE NOT EXISTS (SELECT 1 FROM public._prova_bandeira) LOOP PERFORM pg_sleep(0.02); END LOOP; END $w$;'
esperar() {  # $1 = application_name, $2 = condição sobre pg_stat_activity (alias a). Nunca aborta a suíte.
  local i=0
  while [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity a WHERE a.application_name = '$1' AND ($2);")" != "1" ]; do
    i=$((i+1)); if [ "$i" -gt 400 ]; then echo "  (timeout esperando $1: $2)"; return 0; fi
    sleep 0.05
  done
}
corrida() {  # $1 = SQL que SEGURA a transação aberta, $2 = SQL que deve ESPERAR → "rc|saída-ou-SQLSTATE"
  P -q -c "DELETE FROM public._prova_bandeira;"
  ( Pbg prova_segura "BEGIN; $1 $SEGURAR COMMIT;" > "$TMP/segura.out" 2>&1 || true ) &
  esperar prova_segura "a.wait_event = 'PgSleep'"
  ( if Pbg prova_espera "$2" > "$TMP/espera.out" 2>&1; then echo 0; else echo 1; fi > "$TMP/espera.rc" ) &
  esperar prova_espera "a.wait_event_type = 'Lock'"
  P -q -c "INSERT INTO public._prova_bandeira VALUES (1);"
  wait || true
  local rc saida
  rc="$(cat "$TMP/espera.rc")"
  if [ "$rc" = 0 ]; then saida="$(grep -v '^$' "$TMP/espera.out" | tail -1 || true)"; else saida="$(sqlstate < "$TMP/espera.out")"; fi
  printf '%s|%s' "$rc" "$saida"
}
A20ID="$(nova_app 90)"
r20="$(corrida "SELECT public.criar_pedidos_com_itens($(payload 1200 90));" "$(write_back "$A20ID" 1200)")"
eq "A20 corrida (o importador segura a transação): o write-back ESPERA o lock, não deriva e sai marcado" \
   "${r20%%|*}|$(kpi_ptr "$A20ID")" "0|nulo|ptr"
A21ID="$(nova_app 91)"
r21="$(corrida "$(write_back "$A21ID" 1210)" "SELECT public.criar_pedidos_com_itens($(payload 1210 91))->>'inserted';")"
eq "A21 corrida (o write-back segura, com o kpi já derivado): o importador ESPERA, insere e o app sai marcado" \
   "$r21|$(marcada "$A21ID")" "0|1|t"

echo "═══ invariante final ═══"
inv="$(Pq -c "SELECT (SELECT count(*) FROM (SELECT 1 FROM public.sales_orders WHERE omie_pedido_id IS NOT NULL AND order_date_kpi IS NOT NULL
                                                GROUP BY account, omie_pedido_id HAVING count(*) > 1) d)
  || '|' || (SELECT count(*) FROM public.sales_orders a JOIN public.sales_orders i
               ON i.account = a.account AND i.hash_payload LIKE 'omie\_%' AND i.hash_payload = 'omie_' || a.account || '_' || a.omie_pedido_id
              WHERE a.hash_payload IS NULL AND a.omie_pedido_id IS NOT NULL AND a.gemeo_importado_id IS DISTINCT FROM i.id)
  || '|' || (SELECT count(*) FROM public.sales_orders WHERE gemeo_importado_id IS NOT NULL AND order_date_kpi IS NOT NULL);")"
eq "A22 invariante final: 0 pedido com 2 kpi · todo app com gêmeo aponta para ele · 0 ponteiro com kpi" "$inv" "0|0|0"

echo "═══ em clones da prod de hoje (molde): reaplicar, PRE, POS, ACL ═══"
foto_db() { Pd "$1" -tA -c "SELECT md5(string_agg(id || ':' || coalesce(order_date_kpi::text, '-') || ':' || coalesce(gemeo_importado_id::text, '-')
  || ':' || status || ':' || total, ',' ORDER BY id)) FROM public.sales_orders;"; }
md5s_db() { Pd "$1" -tA -c "SELECT string_agg(md5(prosrc), ',' ORDER BY proname) FROM pg_proc
  WHERE proname IN ('sales_orders_gemeo_app_derivar', 'sales_orders_instante_envio');"; }
md5_der() { Pd "$1" -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.sales_orders_gemeo_app_derivar()'::regprocedure;"; }

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde re
r23a="$(Pd re -q -1 -f "$MIG" >/dev/null 2>&1 && echo OK || echo FALHOU)"
antes23="$(foto_db re)|$(md5s_db re)"
r23b="$(Pd re -q -1 -f "$MIG" >/dev/null 2>&1 && echo OK || echo FALHOU)"
eq "A23 reaplicar a migration é no-op (a PRE aceita esta versão; nenhuma linha nem corpo muda)" \
   "$r23a|$r23b|$([ "$(foto_db re)|$(md5s_db re)" = "$antes23" ] && echo igual || echo mudou)" "OK|OK|igual"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde pre
# shellcheck disable=SC2016  # $f$ é dollar-quote do PostgreSQL
Pd pre -q -c 'CREATE OR REPLACE FUNCTION public.sales_orders_gemeo_app_derivar() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '"'public'"' AS $f$ BEGIN RETURN NEW; END $f$;'
estranho="$(md5_der pre)"
cp "$MIG" "$TMP/mig-pre.sql"
if [ "${SABOTAGEM:-}" = "pre_sem_identidade" ]; then
  trocar "$TMP/mig-pre.sql" "  IF v_md5 <> 'cc036077756a992f97835f383686e110'" "  IF false AND v_md5 <> 'cc036077756a992f97835f383686e110'" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na PRE"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em PRE (sem a identidade do corpo) — a suíte abaixo DEVE ficar vermelha"
fi
out24="$(Pd pre -q -1 -f "$TMP/mig-pre.sql" 2>&1 || true)"
case "$out24" in
  *"PRE FALHOU"*) r24="recusou" ;;
  *) if [ -z "$out24" ]; then r24="aplicou"; else r24="erro:$(printf '%s\n' "$out24" | sqlstate)"; fi ;;
esac
eq "A24 a PRE recusa um corpo vivo desconhecido e não o sobrescreve" "$r24|$(md5_der pre)" "recusou|$estranho"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde pos
cp "$MIG" "$TMP/mig-pos.sql"
trocar "$TMP/mig-pos.sql" "  v_envio boolean;" "  v_envio boolean; -- corpo que nao e o desta versao" \
  || { echo "❌ a declaração do v_envio mudou de forma — o A25 não consegue montar o caso"; exit 1; }
if [ "${SABOTAGEM:-}" = "pos_sem_dente" ]; then
  trocar "$TMP/mig-pos.sql" "  IF v_md5_der IS DISTINCT FROM " "  IF false AND v_md5_der IS DISTINCT FROM " \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na POS"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em POS (sem o md5 do corpo) — a suíte abaixo DEVE ficar vermelha"
fi
out25="$(Pd pos -q -1 -f "$TMP/mig-pos.sql" 2>&1 || true)"
case "$out25" in
  *"POS FALHOU kpi-no-envio md5:"*) r25="recusou:md5" ;;
  *"POS FALHOU"*) r25="recusou:outro_motivo" ;;
  *) if [ -z "$out25" ]; then r25="aplicou"; else r25="erro:$(printf '%s\n' "$out25" | sqlstate)"; fi ;;
esac
eq "A25 a POS recusa um corpo que não é o desta versão (md5)" "$r25" "recusou:md5"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde acl
cp "$MIG" "$TMP/mig-acl.sql"
if [ "${SABOTAGEM:-}" = "sem_revoke" ]; then
  trocar "$TMP/mig-acl.sql" "REVOKE ALL ON FUNCTION public.sales_orders_instante_envio()    FROM PUBLIC, anon, authenticated;" "" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o REVOKE da costura não ocorre exatamente 1×"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em REVOKE da costura — a suíte abaixo DEVE ficar vermelha"
fi
r26="$(Pd acl -q -1 -f "$TMP/mig-acl.sql" >/dev/null 2>&1 && echo OK || echo FALHOU)"
acl26="$(Pd acl -tA -c "SELECT count(*) FILTER (WHERE has_function_privilege(r.papel, p.oid, 'EXECUTE')) || '|' || count(DISTINCT p.oid)
  FROM pg_proc p CROSS JOIN (VALUES ('public'), ('anon'), ('authenticated')) AS r(papel)
 WHERE p.oid IN (SELECT to_regprocedure(s) FROM unnest(ARRAY['public.sales_orders_gemeo_app_derivar()',
                   'public.sales_orders_gemeo_importada_antes()', 'public.sales_orders_gemeo_importada_depois()',
                   'public.sales_orders_instante_envio()']) AS s);")"
eq "A26 a migration fecha o EXECUTE das 4 funções para PUBLIC/anon/authenticated" "$r26|$acl26" "OK|0|4"

# A27 (revisão final): o trigger roda como o DONO dele e chama a costura. Se a costura nasce de outro dono
# (quem aplica) e perde o EXECUTE público, o write-back cai em 42501 DEPOIS de o Omie aceitar o pedido.
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde dono
Pd dono -q <<'SQL'
CREATE ROLE dono_trigger NOLOGIN NOSUPERUSER;
GRANT USAGE ON SCHEMA public TO dono_trigger;
GRANT SELECT ON public.sales_orders TO dono_trigger;
ALTER FUNCTION public.sales_orders_gemeo_app_derivar() OWNER TO dono_trigger;
SQL
cp "$MIG" "$TMP/mig-dono.sql"
if [ "${SABOTAGEM:-}" = "pos_sem_dono" ]; then
  trocar "$TMP/mig-dono.sql" "OR NOT v_dono_exec" "OR false" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na POS"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em POS (sem o EXECUTE do dono do trigger na costura) — a suíte abaixo DEVE ficar vermelha"
fi
out27="$(Pd dono -q -1 -f "$TMP/mig-dono.sql" 2>&1 || true)"
case "$out27" in
  *"POS FALHOU kpi-no-envio:"*"dono_executa_costura=nao"*) r27="recusou:dono" ;;
  *"POS FALHOU"*) r27="recusou:outro_motivo" ;;
  *) if [ -z "$out27" ]; then r27="aplicou"; else r27="erro:$(printf '%s\n' "$out27" | sqlstate)"; fi ;;
esac
eq "A27 a POS recusa quando o dono do trigger não executa a costura (o write-back cairia em 42501)" "$r27" "recusou:dono"

echo
echo "PASS=${PASS}  FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
