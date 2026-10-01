#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — gêmeos push/pull de sales_orders: contagem única na fonte, com FALSIFICAÇÃO
# ║      bash db/test-gemeos-push-pull-contagem-unica.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-gemeos-push-pull-contagem-unica.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-gemeos-push-pull-contagem-unica.sh   (2º idioma do servidor)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Sobre a migration REAL (*_sales_orders_gemeo_importado_contagem_unica.sql) e a RPC REAL do
# ║  importador (criar_pedidos_com_itens), com o trigger de coerência da prod:
# ║   · backlog: par idêntico, par reaproveitado (cliente diferente), par recente (kpi só na importada),
# ║     duas linhas do app no mesmo pedido, app sem gêmeo, orçamento/rascunho, mesmo pid em contas
# ║     diferentes — ponteiro e kpi como na spec §5.3;
# ║   · regime: import depois do push COM kpi no app (o PR seguinte), push depois do import, linha do
# ║     app que nasce com pid, reimport, delete + reimport, escrita direta de kpi, papel sem EXECUTE;
# ║   · corrida nos dois sentidos, determinística (bandeira + pg_stat_activity): o advisory lock é o
# ║     mecanismo, não a sorte;
# ║   · a trava estrutural (índice único, CHECK), o dente da postcondição, e reaplicar = no-op.
# ║  Spec: docs/superpowers/specs/2026-10-01-gemeos-push-pull-contagem-unica-design.md
# ╚═══════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5561}"
SLUG="gemeos-push-pull"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC

# ════════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar — o laço de db/test-data-health-vendas-empurradas.sh, verbatim no método: controle
# VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e cada sabotagem só conta se
# (1) aplicou, (2) a suíte rodou INTEIRA (mesmo PASS+FAIL do controle), (3) CADA assert declarado
# estava verde no controle e virou vermelho aqui, (4) sem ERRO de SQL que o controle não tem.
# docs/historico/falsificacao-exit-nao-e-dente.md
# ════════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="derivar_sem_zerar_kpi:A16,A17,A20 derivar_sem_lock:A22 importada_antes_sem_lock:A23
              importada_antes_sem_zerar:A12,A14 importada_depois_sem_toque:A13,A19
              sem_indice:A24,A26 sem_check:A25 pos_sem_dente:A27"
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
# PG DESCARTÁVEL: durabilidade desligada (não muda nada do que é provado); deadlock_timeout curto.
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c fsync=off -c full_page_writes=off -c synchronous_commit=off -c deadlock_timeout=200ms" \
  -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
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

# SQLSTATE da saída de erro (ASCII, invariante a lc_messages). NUNCA deixa a linha do servidor no log:
# o juiz do --falsificar conta 'ERROR:  ' e uma sabotagem bem-sucedida não pode parecer erro de SQL.
sqlstate() { local s; s="$(grep -o -E '^[A-Z]+:  [0-9A-Z]{5}' | grep -o -E '[0-9A-Z]{5}$' | head -1 || true)"; printf '%s' "${s:-SEM_SQLSTATE}"; }
rodar() { local out; if out="$(P -q -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo OK; else printf '%s\n' "$out" | sqlstate; fi; }

MIG_COER="$REPO_ROOT/supabase/migrations/20260907220000_pedido_venda_coerencia_agregado.sql"
MIG_RPC="$(find "$REPO_ROOT/supabase/migrations" -name "*_desconto_valor_atravessa_os_escritores.sql" | sort | tail -1)"
MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_sales_orders_gemeo_importado_contagem_unica.sql" | sort | tail -1)"
for m in "$MIG_COER" "$MIG_RPC" "$MIG"; do
  [ -n "$m" ] && [ -f "$m" ] || { echo "❌ migration ausente: [$m] — a prova testaria o NADA"; exit 1; }
done

c1="11111111-1111-1111-1111-111111111111"    # cliente A (a ART MÓVEIS do caso real)
c2="22222222-2222-2222-2222-222222222222"    # cliente B (a FRANCCINO)
sys="33333333-3333-3333-3333-333333333333"   # usuário de sistema do importador
vend="44444444-4444-4444-4444-444444444444"  # vendedor (linha do app)
p1="aaaaaaaa-0000-0000-0000-000000000001"    # produto 555
app() { echo "a0000000-0000-0000-0000-000000000$1"; }   # id da linha do app do pedido $1 (3 dígitos)
imp() { echo "b0000000-0000-0000-0000-000000000$1"; }   # id da importada SEMEADA do pedido $1

echo "═══ setup PG17 :$PORT · locale do servidor=$LOC ═══"
# ── schema mínimo fiel à prod nas colunas/índices/constraints que importam ──────────────────────────
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

# ── backlog como a prod tinha ANTES desta entrega (importadas semeadas sem order_items: a coerência
#    só exige quando há linhas) ─────────────────────────────────────────────────────────────────────
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
# MOLDE = schema + cadeia + backlog, SEM a migration desta entrega: o A27 parte daqui.
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T prove molde

echo "═══ migration desta entrega: $(basename "$MIG") ═══"
eq "A1 a migration aplica e a postcondição passa" "$(P -q -1 -f "$MIG" >/dev/null 2>&1 && echo OK || echo FALHOU)" "OK"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# SABOTAGEM — no BANCO, recriando a função com UM trecho trocado; o repo nunca é tocado. O padrão
# tem de ocorrer exatamente 1× no corpo (substituição que não pega deixaria a suíte verde).
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

case "${SABOTAGEM:-}" in
  "") ;;
  derivar_sem_zerar_kpi)
    sabotar sales_orders_gemeo_app_derivar "    NEW.order_date_kpi := NULL;" "    NULL;" ;;
  derivar_sem_lock)
    sabotar sales_orders_gemeo_app_derivar "  PERFORM pg_advisory_xact_lock(hashtextextended(" "  PERFORM (hashtextextended(" ;;
  importada_antes_sem_lock)
    sabotar sales_orders_gemeo_importada_antes "  PERFORM pg_advisory_xact_lock(hashtextextended(" "  PERFORM (hashtextextended(" ;;
  importada_antes_sem_zerar)
    sabotar sales_orders_gemeo_importada_antes "     SET order_date_kpi = NULL" "     SET order_date_kpi = a.order_date_kpi" ;;
  importada_depois_sem_toque)
    sabotar sales_orders_gemeo_importada_depois "     AND a.gemeo_importado_id IS DISTINCT FROM NEW.id;" "     AND false;" ;;
  sem_indice)
    P -q -c "DROP INDEX public.uniq_sales_orders_kpi_por_pedido_omie;"
    echo "⚠️  SABOTAGEM ATIVA em uniq_sales_orders_kpi_por_pedido_omie (índice removido) — a suíte abaixo DEVE ficar vermelha" ;;
  sem_check)
    P -q -c "ALTER TABLE public.sales_orders DROP CONSTRAINT sales_orders_gemeo_e_recibo;"
    echo "⚠️  SABOTAGEM ATIVA em sales_orders_gemeo_e_recibo (CHECK removido) — a suíte abaixo DEVE ficar vermelha" ;;
  pos_sem_dente) ;;   # aplicada no A27, sobre a CÓPIA da migration
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
foto() { Pq -c "SELECT md5(string_agg(id || ':' || coalesce(order_date_kpi::text, '-') || ':' || coalesce(gemeo_importado_id::text, '-')
  || ':' || status || ':' || total, ',' ORDER BY id)) FROM public.sales_orders;"; }

echo "═══ backlog ═══"
eq "A2 par idêntico: a linha do app perde o kpi e aponta para a importada" "$(marcada "$(app 101)")" "t"
eq "A3 par reaproveitado (cliente diferente no Omie): a linha do app também sai" "$(marcada "$(app 102)")" "t"
eq "A4 par recente (kpi só na importada): a linha do app ganha o ponteiro" "$(marcada "$(app 103)")" "t"
eq "A5 duas linhas do app no MESMO pedido: as duas saem" \
   "$(marcada "$(app 108)")|$(marcada a1000000-0000-0000-0000-000000000108)" "t|t"
eq "A6 app sem gêmeo conserva o kpi e não ganha ponteiro" "$(kpi_ptr "$(app 104)")" "2026-04-06|nulo"
eq "A7 orçamento e rascunho (sem pid) ficam intactos" \
   "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id IN ('$(app 105)', '$(app 106)') AND (gemeo_importado_id IS NOT NULL OR order_date_kpi IS NOT NULL);")" "0"
eq "A8 mesmo pid em CONTAS diferentes não é gêmeo" "$(kpi_ptr "$(app 107)")" "2026-04-07|nulo"
eq "A9 as importadas ficam intactas" \
   "$(Pq -c "SELECT string_agg(omie_pedido_id || ':' || order_date_kpi, ',' ORDER BY omie_pedido_id) FROM public.sales_orders WHERE hash_payload LIKE 'omie\_%';")" \
   "101:2026-04-06,102:2026-04-06,103:2026-06-10,107:2026-04-07,108:2026-04-08"
eq "A10 invariante: nenhum pedido Omie com 2 linhas com kpi" "$(dup_kpi)" "0"
# antes: 2.728,80 (527,20×2 + 25×2 do app contados de novo); depois: só a venda (importada, ou o app sem gêmeo).
eq "A11 universo canônico de abril (só kpi) conta cada venda 1×" \
   "$(Pq -c "SELECT sum(total) FROM public.sales_orders WHERE status NOT IN ('cancelado','rascunho','pendente','orcamento') AND deleted_at IS NULL AND order_date_kpi >= DATE '2026-04-01' AND order_date_kpi < DATE '2026-05-01';")" "1624.40"

echo "═══ regime: a RPC real do importador ═══"
payload() {  # $1 = pid, $2 = total → 1 pedido do Omie, items-jsonb ≡ itens (o trigger de coerência exige)
  printf '%s' "'[{\"customer_user_id\":\"$c1\",\"created_by\":\"$sys\",\"account\":\"oben\",\"hash_payload\":\"omie_oben_${1}\",\"omie_pedido_id\":${1},\"omie_numero_pedido\":\"${1}\",\"status\":\"importado\",\"order_date_kpi\":\"2026-10-01\",\"created_at\":\"2026-10-01T12:00:00Z\",\"subtotal\":${2},\"discount\":0,\"total\":${2},\"items\":[{\"omie_codigo_produto\":555,\"quantidade\":1,\"valor_unitario\":${2},\"desconto\":0}],\"itens\":[{\"omie_codigo_produto\":555,\"quantity\":1,\"unit_price\":${2},\"discount\":0,\"hash_payload\":\"omie_oben_${1}_555\"}]}]'::jsonb"
}
rpc() { Pq -c "SELECT (r->>'inserted') || '|' || (r->>'skipped_complete') || '|' || jsonb_array_length(r->'failed')
  FROM (SELECT public.criar_pedidos_com_itens($(payload "$1" "$2")) AS r) x;"; }
nova_app() { Pq -q -c "INSERT INTO public.sales_orders (customer_user_id, created_by, status, total) VALUES ('$c1', '$vend', 'rascunho', $1) RETURNING id;"; }
write_back() {  # $1 = id da linha do app, $2 = pid → o UPDATE do push, COM kpi (o cenário do PR seguinte)
  echo "UPDATE public.sales_orders SET omie_pedido_id = $2, omie_numero_pedido = '$2', status = 'enviado', omie_payload = '{}'::jsonb, order_date_kpi = DATE '2026-10-01' WHERE id = '$1';"
}

A201="$(nova_app 100)"
P -q -c "$(write_back "$A201" 201)"     # push: a linha do app ganha pid E kpi (ainda sem importada)
eq "A12 a RPC importa o pedido cujo app tem pid+kpi (inserted=1, sem falha)" "$(rpc 201 100)" "1|0|0"
eq "A13 depois do import a linha do app perde o kpi e aponta para a importada" "$(marcada "$A201")" "t"
eq "A14 a importada nasce com o kpi do Omie" "$(Pq -c "SELECT order_date_kpi FROM public.sales_orders WHERE hash_payload = 'omie_oben_201';")" "2026-10-01"
antes="$(foto)"
r15="$(rpc 201 100)"
eq "A15 reimport pela RPC é idempotente (skipped_complete=1, estado idêntico)" "$r15|$([ "$(foto)" = "$antes" ] && echo igual || echo mudou)" "0|1|0|igual"

P -q -c "SELECT public.criar_pedidos_com_itens($(payload 202 80));" >/dev/null
A202="$(nova_app 80)"
r16="$(rodar "$(write_back "$A202" 202)")"
eq "A16 push DEPOIS do import: o write-back passa e a linha do app já sai marcada" "$r16|$(marcada "$A202")" "OK|t"

P -q -c "SELECT public.criar_pedidos_com_itens($(payload 109 40));" >/dev/null
r17="$(rodar "INSERT INTO public.sales_orders (id, customer_user_id, created_by, status, total, omie_pedido_id, omie_payload, order_date_kpi) VALUES ('c0000000-0000-0000-0000-000000000109', '$c1', '$vend', 'enviado', 40, 109, '{}', DATE '2026-10-01');")"
eq "A17 linha do app que JÁ NASCE com pid (importada existente) nasce marcada" "$r17|$(marcada c0000000-0000-0000-0000-000000000109)" "OK|t"

r18="$(rodar "DELETE FROM public.sales_orders WHERE hash_payload = 'omie_oben_202';")"
eq "A18 apagar a importada zera o ponteiro e a linha do app segue sem kpi" "$r18|$(kpi_ptr "$A202")" "OK|nulo|nulo"
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 202 80));" >/dev/null
eq "A19 reimportar refaz o ponteiro para a NOVA importada" "$(marcada "$A202")" "t"

r20="$(rodar "UPDATE public.sales_orders SET order_date_kpi = DATE '2026-10-02' WHERE id = '$A201';")"
eq "A20 gravar kpi direto numa linha do app marcada não pega (o trigger devolve NULL)" "$r20|$(kpi_ptr "$A201")" "OK|nulo|ptr"

P -q <<'SQL'
CREATE ROLE escritor_sem_exec NOLOGIN;
GRANT USAGE ON SCHEMA public TO escritor_sem_exec;
GRANT SELECT, INSERT, UPDATE ON public.sales_orders TO escritor_sem_exec;
SQL
P -q -c "SELECT public.criar_pedidos_com_itens($(payload 301 60));" >/dev/null
A301="$(nova_app 60)"
sem_exec="$(Pq -c "SELECT has_function_privilege('escritor_sem_exec', 'public.sales_orders_gemeo_app_derivar()', 'EXECUTE');")"
r21="$(rodar "SET ROLE escritor_sem_exec; $(write_back "$A301" 301)")"
eq "A21 papel SEM EXECUTE nas funções escreve a linha do app e o trigger dispara mesmo assim" "$sem_exec|$r21|$(marcada "$A301")" "f|OK|t"

echo "═══ corrida: o advisory lock serializa write-back e importador ═══"
P -q -c "CREATE TABLE public._prova_bandeira (id int);"
Pbg() {  # $1 = application_name, $2 = SQL → conexão própria (para segurar transação ou esperar lock)
  PGAPPNAME="$1" "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q -tA -c "$2"
}
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
A401="$(nova_app 90)"
r22="$(corrida "SELECT public.criar_pedidos_com_itens($(payload 401 90));" "$(write_back "$A401" 401)")"
eq "A22 corrida (o importador segura a transação): o write-back ESPERA o lock e sai marcado" "${r22%%|*}|$(marcada "$A401")" "0|t"
A402="$(nova_app 91)"
r23="$(corrida "$(write_back "$A402" 402)" "SELECT public.criar_pedidos_com_itens($(payload 402 91))->>'inserted';")"
eq "A23 corrida (o write-back segura a transação): o importador ESPERA o lock e insere" "$r23|$(marcada "$A402")" "0|1|t"

echo "═══ a trava estrutural ═══"
P -q -c "ALTER TABLE public.sales_orders DISABLE TRIGGER trg_sales_orders_gemeo_app;"
r24="$(rodar "UPDATE public.sales_orders SET order_date_kpi = DATE '2026-10-01', gemeo_importado_id = NULL WHERE id = '$A201';")"
A501="$(Pq -q -c "INSERT INTO public.sales_orders (customer_user_id, created_by, status, total, omie_pedido_id, omie_payload, order_date_kpi) VALUES ('$c1', '$vend', 'enviado', 5, 501, '{}', DATE '2026-10-01') RETURNING id;")"
r25="$(rodar "UPDATE public.sales_orders SET gemeo_importado_id = '$(imp 101)' WHERE id = '$A501';")"
# arruma o que uma sabotagem tenha deixado passar (trigger ainda DESLIGADO), religa e re-deriva
P -q -c "UPDATE public.sales_orders SET gemeo_importado_id = NULL, order_date_kpi = NULL WHERE id IN ('$A201', '$A501');"
P -q -c "ALTER TABLE public.sales_orders ENABLE TRIGGER trg_sales_orders_gemeo_app;"
P -q -c "UPDATE public.sales_orders SET omie_pedido_id = omie_pedido_id WHERE id IN ('$A201', '$A501');"
eq "A24 sem o trigger, um 2º kpi no mesmo pedido Omie esbarra no índice único (23505)" "$r24" "23505"
eq "A25 sem o trigger, ponteiro + kpi esbarra no CHECK (23514)" "$r25" "23514"

# A26: o que a spec §5.2 promete para a corrida que escapar — o índice faz o importador pular SÓ aquele
# pedido (G8 registra a SQLSTATE) e o vizinho do mesmo lote entra. Com o trigger "antes" desligado, o
# pedido 601 (app com pid+kpi) bate no índice; o 602 é limpo.
P -q -c "ALTER TABLE public.sales_orders DISABLE TRIGGER trg_sales_orders_gemeo_importada_antes;"
A601="$(nova_app 61)"
P -q -c "$(write_back "$A601" 601)"
lote="$(Pq -c "SELECT (r->>'inserted') || '|' || jsonb_array_length(r->'failed') || '|' || coalesce(r->'failed'->0->>'sqlstate', '-')
  FROM (SELECT public.criar_pedidos_com_itens( ($(payload 601 61)) || ($(payload 602 62)) ) AS r) x;")"
P -q -c "ALTER TABLE public.sales_orders ENABLE TRIGGER trg_sales_orders_gemeo_importada_antes;"
P -q -c "UPDATE public.sales_orders SET omie_pedido_id = omie_pedido_id WHERE id = '$A601';"   # re-deriva
eq "A26 a RPC sob o índice: o pedido que bateria nele vai para failed (23505) e o vizinho do lote entra" "$lote" "1|1|23505"

echo "═══ a postcondição tem dente ═══"
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde pos
cp "$MIG" "$TMP/mig-pos.sql"
trocar "$TMP/mig-pos.sql" "   AND (a.gemeo_importado_id IS DISTINCT FROM i.id OR a.order_date_kpi IS NOT NULL);" "   AND a.order_date_kpi IS NOT NULL;" \
  || { echo "❌ o backfill da migration mudou de forma — o A27 não consegue montar o caso"; exit 1; }
if [ "${SABOTAGEM:-}" = "pos_sem_dente" ]; then
  trocar "$TMP/mig-pos.sql" "v_sem_ptr <> 0 OR " "" || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na postcondição"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em postcondição (sem_ponteiro fora do IF) — a suíte abaixo DEVE ficar vermelha"
fi
out27="$("$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d pos -v ON_ERROR_STOP=1 -q -1 -f "$TMP/mig-pos.sql" 2>&1 || true)"
case "$out27" in
  *"POS FALHOU gemeos"*"sem_ponteiro=1 "*) r27="recusou:sem_ponteiro=1" ;;
  *"POS FALHOU gemeos"*) r27="recusou:outro_motivo" ;;
  *) if [ -z "$out27" ]; then r27="aplicou"; else r27="erro:$(printf '%s\n' "$out27" | sqlstate)"; fi ;;
esac
eq "A27 backfill que esquece o par sem kpi é recusado pela postcondição (sem_ponteiro=1)" "$r27" "recusou:sem_ponteiro=1"

eq "A28 invariante final: nenhum pedido Omie com 2 linhas com kpi" "$(dup_kpi)" "0"
antes="$(foto)"
r29="$(P -q -1 -f "$MIG" >/dev/null 2>&1 && echo OK || echo FALHOU)"
eq "A29 reaplicar a migration é no-op (aplica e não muda nenhuma linha)" "$r29|$([ "$(foto)" = "$antes" ] && echo igual || echo mudou)" "OK|igual"

echo
echo "PASS=${PASS}  FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
