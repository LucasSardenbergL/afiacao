#!/usr/bin/env bash
# Prova PG17 da recompra comprador × SKU × empresa e da situação do comprador (Venda por cliente, Task 2).
# Migration: supabase/migrations/20261020150000_venda_cliente_recompra.sql (a REAL, sobre esquema mínimo).
# Oráculo:   src/lib/venda-cliente/recompra.ts (via scripts/venda-recompra-esperado.ts).
#
#   P  paridade SQL × TS sobre db/fixtures/venda-recompra.json, em 3 datas (recompra E situação)
#   B  pedido do cadastro ALIAS conta para o comprador canônico (alias inativo não)
#   C  pedido cancelado / deleted_at não entra (com controle positivo)
#   D  venda_recompra_em(d) ignora pedido NA data d (sem olhar o futuro)
#   E  Oben e Colacor do mesmo comprador em linhas separadas, sem somar dias entre empresas
#   F  desconto não apurado (NULL) → ultimo_preco/valor_esperado NULL, nunca desconto 0
#   G  borda: due_ratio exatamente 1,5 é atrasado; 1 dia antes não
#   H  situação: perdido, sem_base, em_dia, atrasado
#   I  pedido sem order_date_kpi usa o dia de created_at em São Paulo
#   J  ACL: anon/authenticated sem EXECUTE nas 5 funções e sem SELECT nos snapshots; RLS ligada
#   K  cron venda-recompra 07:50 UTC; snapshot = cálculo vivo; re-aplicar a migration é idempotente
#
#   bash db/test-venda-recompra.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   TEST_LOCALE=pt_BR.UTF-8 bash db/test-venda-recompra.sh      # o outro locale (rode os dois)
#   SABOTAGEM=<nome> bash db/test-venda-recompra.sh               # tem de ficar VERMELHA
#   bash db/test-venda-recompra.sh --falsificar                   # controle verde + cada sabotagem vermelha
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261020150000_venda_cliente_recompra.sql"
FIXTURE="$REPO_ROOT/db/fixtures/venda-recompra.json"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert com a paridade>:<assert com PULA_PARIDADE=1> — uma camada por vez: a paridade (P)
  # roda antes dos casos isolados e pega quase tudo; cegá-la prova que o caso isolado pega SOZINHO.
  # `POS_*` = a postcondição da própria migration aborta; `-` = rodada não se aplica.
  SABOTAGENS="futuro:P:D sem_alias:P:B com_cancelado:P:C empresa_unica:P:E desconto_zero:P:F limiar_estrito:G:G piso_perdido:P:H acl_aberta:POS_ACL_PUBLIC:-"
  LOGDIR="$(mktemp -d "/tmp/falsifica-venda-recompra.XXXXXX")"
  echo "══ CONTROLE (mesma invocação, locale ${TEST_LOCALE:-C}) ══"
  for pula in "" 1; do
    if ! SABOTAGEM="" PULA_PARIDADE="$pula" bash "$0" > "$LOGDIR/controle$pula.log" 2>&1 \
       || ! grep -q "FIM-OK venda-recompra" "$LOGDIR/controle$pula.log"; then
      echo "❌ controle VERMELHO (PULA_PARIDADE='$pula') — falsificação abortada (log: $LOGDIR/controle$pula.log)"
      tail -15 "$LOGDIR/controle$pula.log"; exit 1
    fi
  done
  echo "✅ controle verde (com e sem paridade)"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; resto="${par#*:}"; com="${resto%%:*}"; sem="${resto#*:}"
    for modo in com sem; do
      if [ "$modo" = com ]; then a="$com"; pula=""; else a="$sem"; pula=1; fi
      [ "$a" = "-" ] && continue
      n_sab=$((n_sab+1)); log="$LOGDIR/$s-$modo.log"
      if SABOTAGEM="$s" PULA_PARIDADE="$pula" bash "$0" > "$log" 2>&1; then
        echo "❌ $s ($modo paridade): suíte ficou VERDE"; falhas=$((falhas+1)); continue
      fi
      if ! grep -q "SABOTAGEM ATIVA: $s" "$log"; then
        echo "❌ $s ($modo paridade): sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
      fi
      case "$a" in
        POS_*) padrao="$a" ;;
        *)     padrao="FAIL $a " ;;
      esac
      if grep -q "$padrao" "$log"; then
        echo "✅ $s ($modo paridade) → $a vermelho"
      else
        echo "❌ $s ($modo paridade): vermelho, mas não no $a (log: $log)"; falhas=$((falhas+1))
      fi
    done
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5497}"
LOCALE="${TEST_LOCALE:-C}"
WORK="$(mktemp -d "/tmp/pgtest-venda-recompra.XXXXXX")"
DATA="$WORK/data"
export LC_ALL="$LOCALE" LANG="$LOCALE"
MIG_USADA="$WORK/mig.sql"
ESPERADO="$WORK/esperado.json"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  futuro)         sabotar "WHERE x.data_pedido < p_ate" "WHERE x.data_pedido <= p_ate" ;;
  sem_alias)      sabotar "SELECT COALESCE(a.canonical_user_id, so.customer_user_id) AS comprador_id" "SELECT so.customer_user_id AS comprador_id" ;;
  com_cancelado)  sabotar "WHERE so.deleted_at IS NULL
         AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')" "WHERE true" ;;
  empresa_unica)  sabotar "so.account AS empresa," "'oben'::text AS empresa," ;;
  desconto_zero)  sabotar "WHEN oi.desconto_valor IS NULL OR oi.unit_price IS NULL THEN NULL
                  ELSE oi.unit_price - oi.desconto_valor / oi.quantity" "WHEN oi.unit_price IS NULL THEN NULL
                  ELSE oi.unit_price - COALESCE(oi.desconto_valor, 0) / oi.quantity" ;;
  limiar_estrito) sabotar "2 * (p_data - a.ultima) >= 3 * a.cad AS atrasado" "2 * (p_data - a.ultima) > 3 * a.cad AS atrasado" ;;
  piso_perdido)   sabotar "GREATEST(3 * COALESCE(sk.cad_mediana, 0), 365)" "GREATEST(3 * COALESCE(sk.cad_mediana, 0), 180)" ;;
  acl_aberta)     sabotar "REVOKE ALL ON FUNCTION public.venda_recompra_em(date) FROM PUBLIC, anon, authenticated;" "GRANT EXECUTE ON FUNCTION public.venda_recompra_em(date) TO anon;" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "SABOTAGEM ATIVA: $SABOTAGEM"

# Esperado pelo oráculo TS — ANTES de subir o banco (falha aqui não deixa postgres órfão).
( cd "$REPO_ROOT" && bun scripts/venda-recompra-esperado.ts "$FIXTURE" "$ESPERADO" )

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P() { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }

echo "── esquema mínimo + fixture (locale $LOCALE) ──"
P -v fixture="$FIXTURE" <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA private;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial, jobname text UNIQUE, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v bigint; BEGIN
  DELETE FROM cron.job WHERE jobname = p_name;
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_sched, p_cmd) RETURNING jobid INTO v;
  RETURN v;
END $f$;
-- Default do Supabase: anon/authenticated recebem tudo em objeto novo do public (a migration tem de REVOGAR).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid, account text, status text, deleted_at timestamptz,
  order_date_kpi date, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id),
  product_id uuid, omie_codigo_produto bigint, quantity numeric, unit_price numeric, desconto_valor numeric
);
CREATE TABLE public.customer_canonical_alias (
  alias_user_id uuid PRIMARY KEY, canonical_user_id uuid NOT NULL, status text NOT NULL
);

-- fixture: rótulo → uuid = md5(rótulo)
CREATE TABLE fx AS SELECT pg_read_file(:'fixture')::jsonb AS j;
INSERT INTO public.customer_canonical_alias
SELECT md5(a->>'alias')::uuid, md5(a->>'canonico')::uuid, a->>'status' FROM fx, jsonb_array_elements(j->'aliases') a;
CREATE TABLE fx_ped AS
SELECT gen_random_uuid() AS id, e FROM fx, jsonb_array_elements(j->'pedidos') e;
INSERT INTO public.sales_orders (id, customer_user_id, account, status, deleted_at, order_date_kpi, created_at)
SELECT id, md5(e->>'c')::uuid, e->>'conta', e->>'status',
       CASE WHEN (e->>'deleted')::boolean THEN now() END,
       (e->>'kpi')::date,
       COALESCE((e->>'created_at')::timestamptz, ((e->>'kpi')::date + time '15:00') AT TIME ZONE 'UTC')
  FROM fx_ped;
INSERT INTO public.order_items (sales_order_id, product_id, omie_codigo_produto, quantity, unit_price, desconto_valor)
SELECT p.id, md5('p' || (it->>0))::uuid, (it->>0)::bigint, (it->>1)::numeric, (it->>2)::numeric, (it->>3)::numeric
  FROM fx_ped p, jsonb_array_elements(p.e->'itens') it;

-- casos isolados: rótulos x* não existem na fixture
CREATE FUNCTION t_ped(p_cli text, p_conta text, p_dia date, p_cod bigint,
                      p_qtd numeric DEFAULT 10, p_preco numeric DEFAULT 5, p_desc numeric DEFAULT 0,
                      p_status text DEFAULT 'faturado', p_deleted boolean DEFAULT false,
                      p_created timestamptz DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.sales_orders (id, customer_user_id, account, status, deleted_at, order_date_kpi, created_at)
  VALUES (v, md5(p_cli)::uuid, p_conta, p_status, CASE WHEN p_deleted THEN now() END,
          CASE WHEN p_created IS NULL THEN p_dia END, COALESCE(p_created, now()));
  INSERT INTO public.order_items (sales_order_id, product_id, omie_codigo_produto, quantity, unit_price, desconto_valor)
  VALUES (v, md5('p' || p_cod)::uuid, p_cod, p_qtd, p_preco, p_desc);
END $f$;
CREATE TABLE t_contagem (n bigserial, nome text NOT NULL);
CREATE FUNCTION t_ok(p_nome text, p_cond boolean, p_det text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL % % (%)', p_nome, p_det, p_cond; END IF;
  INSERT INTO t_contagem (nome) VALUES (p_nome);
  RAISE NOTICE 'OK %', p_nome;
END $f$;
CREATE FUNCTION t_perto(a numeric, b numeric) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$
  SELECT (a IS NULL AND b IS NULL) OR (a IS NOT NULL AND b IS NOT NULL AND abs(a - b) <= 1e-9 * greatest(1, abs(b)))
$f$;
SQL

echo "── migration (transação única, como o db:aplicar) ──"
P -1 -f "$MIG_USADA"
echo "── migration de novo (idempotência) ──"
P -1 -f "$MIG_USADA"

if [ -n "${PULA_PARIDADE:-}" ]; then
  echo "── P: PULADA (PULA_PARIDADE — só o falsificador usa) ──"
else
echo "── P: paridade SQL × TS ──"
P -v esperado="$ESPERADO" <<'SQL'
\set QUIET off
CREATE TABLE esp AS SELECT pg_read_file(:'esperado')::jsonb AS j;
DO $p$
DECLARE h text; n_esp int; n_sql int; n_div int; amostra text; total int := 0;
BEGIN
  FOR h IN SELECT jsonb_object_keys(j) FROM esp ORDER BY 1 LOOP
    -- recompra
    CREATE TEMP TABLE e_r ON COMMIT DROP AS
    SELECT md5(r->>'comprador_id')::uuid AS comprador_id, r->>'comprador_id' AS rotulo, r->>'empresa' AS empresa,
           (r->>'omie_codigo_produto')::bigint AS cod, (r->>'n_pedidos')::int AS n,
           (r->>'cadencia_dias')::numeric AS cad, (r->>'qtd_sugerida')::numeric AS qtd,
           (r->>'ultima_compra')::date AS ultima, (r->>'ultimo_preco')::numeric AS preco,
           (r->>'due_ratio')::numeric AS due, (r->>'atrasado')::boolean AS atr, (r->>'valor_esperado')::numeric AS val
      FROM esp, jsonb_array_elements(j->h->'recompra') r;
    SELECT count(*) INTO n_esp FROM e_r;
    SELECT count(*) INTO n_sql FROM public.venda_recompra_em(h::date) s
     WHERE s.comprador_id IN (SELECT md5(p->>'c')::uuid FROM fx, jsonb_array_elements(j->'pedidos') p
                              UNION SELECT md5(a->>'canonico')::uuid FROM fx, jsonb_array_elements(j->'aliases') a);
    SELECT count(*), string_agg(format('%s/%s/%s esp=(%s,%s,%s,%s,%s,%s,%s) sql=(%s,%s,%s,%s,%s,%s,%s)',
             e.rotulo, coalesce(e.empresa, s.empresa), coalesce(e.cod, s.omie_codigo_produto),
             e.n, e.cad, e.qtd, e.ultima, e.preco, e.atr, e.val,
             s.n_pedidos, s.cadencia_dias, s.qtd_sugerida, s.ultima_compra, s.ultimo_preco, s.atrasado, s.valor_esperado), ' | ')
      INTO n_div, amostra
      FROM e_r e
      FULL JOIN (SELECT * FROM public.venda_recompra_em(h::date)
                  WHERE comprador_id NOT IN (SELECT md5(x)::uuid FROM unnest(ARRAY['xb','xb_alias','xc','xd','xe','xe2','xf','xf2','xg','xh','xh2','xs','xi']) x)) s
        ON s.comprador_id = e.comprador_id AND s.empresa = e.empresa AND s.omie_codigo_produto = e.cod
     WHERE e.cod IS NULL OR s.omie_codigo_produto IS NULL
        OR s.n_pedidos <> e.n OR NOT t_perto(s.cadencia_dias, e.cad) OR NOT t_perto(s.qtd_sugerida, e.qtd)
        OR s.ultima_compra <> e.ultima OR NOT t_perto(s.ultimo_preco, e.preco) OR NOT t_perto(s.due_ratio, e.due)
        OR s.atrasado <> e.atr OR NOT t_perto(s.valor_esperado, e.val);
    PERFORM t_ok('P recompra ' || h, n_esp > 0 AND n_div = 0 AND n_sql = n_esp,
                 format('esp=%s sql=%s div=%s %s', n_esp, n_sql, n_div, left(coalesce(amostra, ''), 1500)));
    total := total + n_esp;
    DROP TABLE e_r;

    -- situação
    CREATE TEMP TABLE e_s ON COMMIT DROP AS
    SELECT md5(r->>'comprador_id')::uuid AS comprador_id, r->>'comprador_id' AS rotulo, r->>'situacao' AS sit,
           (r->>'dias_sem_compra')::int AS dias, (r->>'valor_atrasado')::numeric AS val
      FROM esp, jsonb_array_elements(j->h->'situacao') r;
    SELECT count(*) INTO n_esp FROM e_s;
    SELECT count(*), string_agg(format('%s esp=(%s,%s,%s) sql=(%s,%s,%s)', e.rotulo, e.sit, e.dias, e.val,
             s.situacao, s.dias_sem_compra, s.valor_atrasado), ' | ')
      INTO n_div, amostra
      FROM e_s e
      FULL JOIN (SELECT * FROM public.venda_situacao_em(h::date)
                  WHERE comprador_id NOT IN (SELECT md5(x)::uuid FROM unnest(ARRAY['xb','xb_alias','xc','xd','xe','xe2','xf','xf2','xg','xh','xh2','xs','xi']) x)) s
        ON s.comprador_id = e.comprador_id
     WHERE e.comprador_id IS NULL OR s.comprador_id IS NULL
        OR s.situacao <> e.sit OR s.dias_sem_compra <> e.dias OR NOT t_perto(s.valor_atrasado, e.val);
    PERFORM t_ok('P situacao ' || h, n_esp > 0 AND n_div = 0, format('esp=%s div=%s %s', n_esp, n_div, left(coalesce(amostra, ''), 1500)));
    DROP TABLE e_s;
  END LOOP;
  PERFORM t_ok('P nao-vazia', total >= 100, 'linhas comparadas=' || total);
  -- a fixture tem de exercitar os 4 estados e preço ausente, senão a paridade é cega a eles
  PERFORM t_ok('P cobre estados', (SELECT count(DISTINCT r->>'situacao') FROM esp, jsonb_each(j) d, jsonb_array_elements(d.value->'situacao') r) = 4);
  PERFORM t_ok('P cobre preco nulo', EXISTS (SELECT 1 FROM esp, jsonb_each(j) d, jsonb_array_elements(d.value->'recompra') r WHERE r->'ultimo_preco' = 'null'::jsonb));
END
$p$;
SQL
fi

echo "── casos B–I ──"
P <<'SQL'
\set QUIET off
-- B: alias ativo conta para o canônico; alias inativo não
SELECT t_ped('xb', 'oben', '2026-01-01', 901);
INSERT INTO public.customer_canonical_alias VALUES (md5('xb_alias')::uuid, md5('xb')::uuid, 'active');
SELECT t_ped('xb_alias', 'oben', '2026-01-31', 901);
SELECT t_ped('xb_alias', 'oben', '2026-03-02', 901);
SELECT t_ok('B alias→canonico', (SELECT n_pedidos FROM public.venda_recompra_em('2026-04-20')
                                  WHERE comprador_id = md5('xb')::uuid AND omie_codigo_produto = 901) = 3);
SELECT t_ok('B alias some', NOT EXISTS (SELECT 1 FROM public.venda_recompra_em('2026-04-20') WHERE comprador_id = md5('xb_alias')::uuid)
                         AND NOT EXISTS (SELECT 1 FROM public.venda_situacao_em('2026-04-20') WHERE comprador_id = md5('xb_alias')::uuid));
UPDATE public.customer_canonical_alias SET status = 'inactive' WHERE alias_user_id = md5('xb_alias')::uuid;
SELECT t_ok('B alias inativo nao resolve', NOT EXISTS (SELECT 1 FROM public.venda_recompra_em('2026-04-20') WHERE comprador_id = md5('xb')::uuid AND omie_codigo_produto = 901));
UPDATE public.customer_canonical_alias SET status = 'active' WHERE alias_user_id = md5('xb_alias')::uuid;

-- C: cancelado e deleted_at fora; controle positivo com pedido válido
SELECT t_ped('xc', 'oben', '2026-01-01', 902);
SELECT t_ped('xc', 'oben', '2026-01-31', 902);
SELECT t_ped('xc', 'oben', '2026-03-02', 902, p_status => 'cancelado');
SELECT t_ped('xc', 'oben', '2026-03-03', 902, p_deleted => true);
SELECT t_ped('xc', 'oben', '2026-03-04', 902, p_status => 'orcamento');
SELECT t_ok('C cancelado/deleted/orcamento fora', NOT EXISTS (SELECT 1 FROM public.venda_recompra_em('2026-04-20') WHERE comprador_id = md5('xc')::uuid));
SELECT t_ped('xc', 'oben', '2026-03-05', 902, p_status => 'importado');
SELECT t_ok('C controle positivo', (SELECT ultima_compra FROM public.venda_recompra_em('2026-04-20') WHERE comprador_id = md5('xc')::uuid) = '2026-03-05');

-- D: pedido NA data d não conta em venda_recompra_em(d); conta em d+1
SELECT t_ped('xd', 'oben', '2026-01-01', 903);
SELECT t_ped('xd', 'oben', '2026-01-31', 903);
SELECT t_ped('xd', 'oben', '2026-04-20', 903);
SELECT t_ok('D sem futuro', NOT EXISTS (SELECT 1 FROM public.venda_recompra_em('2026-04-20') WHERE comprador_id = md5('xd')::uuid)
                       AND (SELECT dias_sem_compra FROM public.venda_situacao_em('2026-04-20') WHERE comprador_id = md5('xd')::uuid) = 79);
SELECT t_ok('D d+1 enxerga', (SELECT n_pedidos FROM public.venda_recompra_em('2026-04-21') WHERE comprador_id = md5('xd')::uuid) = 3);

-- E: Oben × Colacor do mesmo comprador = 2 linhas; 2 Oben + 1 Colacor não soma 3
SELECT t_ped('xe', 'oben',    d, 904) FROM unnest(ARRAY['2026-01-01','2026-01-31','2026-03-02']::date[]) d;
SELECT t_ped('xe', 'colacor', d, 904) FROM unnest(ARRAY['2026-01-05','2026-02-04','2026-03-06']::date[]) d;
SELECT t_ok('E empresas separadas', (SELECT array_agg(empresa ORDER BY empresa) FROM public.venda_recompra_em('2026-04-20')
                                      WHERE comprador_id = md5('xe')::uuid) = ARRAY['colacor','oben']);
SELECT t_ped('xe2', 'oben',    '2026-01-01', 904);
SELECT t_ped('xe2', 'oben',    '2026-01-31', 904);
SELECT t_ped('xe2', 'colacor', '2026-03-02', 904);
SELECT t_ok('E nao soma entre empresas', NOT EXISTS (SELECT 1 FROM public.venda_recompra_em('2026-04-20') WHERE comprador_id = md5('xe2')::uuid));

-- F: desconto NULL no último dia → preço NULL; desconto apurado → unit − desc/qtd
SELECT t_ped('xf', 'oben', '2026-01-01', 905);
SELECT t_ped('xf', 'oben', '2026-01-31', 905);
SELECT t_ped('xf', 'oben', '2026-03-02', 905, p_desc => NULL);
SELECT t_ok('F desconto nulo → preco nulo', (SELECT ultimo_preco IS NULL AND valor_esperado IS NULL
                                              FROM public.venda_recompra_em('2026-04-20') WHERE comprador_id = md5('xf')::uuid));
SELECT t_ped('xf2', 'oben', '2026-01-01', 905);
SELECT t_ped('xf2', 'oben', '2026-01-31', 905);
SELECT t_ped('xf2', 'oben', '2026-03-02', 905, p_qtd => 4, p_preco => 10, p_desc => 6);
SELECT t_ok('F desconto apurado', (SELECT ultimo_preco = 8.5 FROM public.venda_recompra_em('2026-04-20') WHERE comprador_id = md5('xf2')::uuid));

-- G: borda — cadência 30, última 2026-03-02: 45 dias (1,5) atrasado; 44 não
SELECT t_ped('xg', 'oben', d, 906) FROM unnest(ARRAY['2026-01-01','2026-01-31','2026-03-02']::date[]) d;
SELECT t_ok('G due 1,5 atrasado', (SELECT atrasado FROM public.venda_recompra_em('2026-04-16') WHERE comprador_id = md5('xg')::uuid));
SELECT t_ok('G due < 1,5 em dia', (SELECT NOT atrasado FROM public.venda_recompra_em('2026-04-15') WHERE comprador_id = md5('xg')::uuid));
SELECT t_ok('G situacao atrasado', (SELECT situacao FROM public.venda_situacao_em('2026-04-16') WHERE comprador_id = md5('xg')::uuid) = 'atrasado'
                                AND (SELECT valor_atrasado FROM public.venda_situacao_em('2026-04-16') WHERE comprador_id = md5('xg')::uuid) = 50);
SELECT t_ok('G situacao em_dia', (SELECT situacao FROM public.venda_situacao_em('2026-04-15') WHERE comprador_id = md5('xg')::uuid) = 'em_dia'
                              AND (SELECT valor_atrasado FROM public.venda_situacao_em('2026-04-15') WHERE comprador_id = md5('xg')::uuid) = 0);

-- H: cadência 30 → limiar max(90, 365) = 365: 300 dias sem compra ainda é atrasado, 400 é perdido;
--    sem_base com 2 dias de pedido
SELECT t_ped('xh', 'oben', d, 907) FROM unnest(ARRAY['2025-01-01','2025-01-31','2025-03-02']::date[]) d;
SELECT t_ok('H 300 dias ainda nao perdido (piso 365)', (SELECT situacao FROM public.venda_situacao_em('2025-12-27') WHERE comprador_id = md5('xh')::uuid) = 'atrasado');
SELECT t_ok('H 400 dias perdido', (SELECT situacao FROM public.venda_situacao_em('2026-04-06') WHERE comprador_id = md5('xh')::uuid) = 'perdido');
SELECT t_ped('xs', 'oben', '2026-01-01', 908);
SELECT t_ped('xs', 'colacor', '2026-02-01', 909);
SELECT t_ok('H sem_base', (SELECT situacao FROM public.venda_situacao_em('2026-04-20') WHERE comprador_id = md5('xs')::uuid) = 'sem_base');
-- 3 dias de pedido em SKUs diferentes, nenhum qualificado, compra recente → em_dia (tem base, não tem atraso)
SELECT t_ped('xh2', 'oben', '2026-01-01', 910);
SELECT t_ped('xh2', 'oben', '2026-02-01', 911);
SELECT t_ped('xh2', 'oben', '2026-03-01', 912);
SELECT t_ok('H em_dia sem sku', (SELECT situacao FROM public.venda_situacao_em('2026-04-20') WHERE comprador_id = md5('xh2')::uuid) = 'em_dia');

-- I: sem order_date_kpi → dia de created_at em SP (01:30Z de 03/03 = 22:30 de 02/03 em SP)
SELECT t_ped('xi', 'oben', '2026-01-01', 913);
SELECT t_ped('xi', 'oben', '2026-01-31', 913);
SELECT t_ped('xi', 'oben', NULL, 913, p_created => '2026-03-03T01:30:00Z');
SELECT t_ok('I created_at em SP', (SELECT ultima_compra FROM public.venda_recompra_em('2026-04-20') WHERE comprador_id = md5('xi')::uuid) = '2026-03-02');
SQL

echo "── J: ACL e RLS ──"
P <<'SQL'
\set QUIET off
SELECT t_ok('J ' || f || ' anon', NOT has_function_privilege('anon', f, 'EXECUTE')),
       t_ok('J ' || f || ' authenticated', NOT has_function_privilege('authenticated', f, 'EXECUTE'))
  FROM unnest(ARRAY['private.venda_mediana(numeric[])', 'private.venda_linhas_pedido(date)',
                    'public.venda_recompra_em(date)', 'public.venda_situacao_em(date)',
                    'public.venda_recompra_atualizar()']) f;
SELECT t_ok('J service_role executa', has_function_privilege('service_role', 'public.venda_recompra_atualizar()', 'EXECUTE'));
SELECT t_ok('J rls ' || t, (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass))
  FROM unnest(ARRAY['public.venda_recompra', 'public.venda_situacao']) t;
-- leitura direta como authenticated: negada com 42501 (e só 42501)
DO $j$
DECLARE v_estado text;
BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM 1 FROM public.venda_recompra LIMIT 1;
    v_estado := 'LEU';
  EXCEPTION WHEN insufficient_privilege THEN
    v_estado := 'NEGADO';
  END;
  RESET ROLE;
  PERFORM t_ok('J authenticated nao le snapshot', v_estado = 'NEGADO', v_estado);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM 1 FROM public.venda_recompra_em('2026-04-20') LIMIT 1;
    v_estado := 'EXECUTOU';
  EXCEPTION WHEN insufficient_privilege THEN
    v_estado := 'NEGADO';
  END;
  RESET ROLE;
  PERFORM t_ok('J authenticated nao executa recompra_em', v_estado = 'NEGADO', v_estado);
END
$j$;
SQL

echo "── K: cron, snapshot ──"
P <<'SQL'
\set QUIET off
SELECT t_ok('K cron', (SELECT count(*) FROM cron.job WHERE jobname = 'venda-recompra' AND schedule = '50 7 * * *'
                        AND command = 'SELECT public.venda_recompra_atualizar();') = 1);
SELECT t_ok('K atualizar devolve contagem', public.venda_recompra_atualizar()
            = (SELECT count(*) FROM public.venda_recompra_em((now() AT TIME ZONE 'America/Sao_Paulo')::date)));
SELECT t_ok('K snapshot situacao', (SELECT count(*) FROM public.venda_situacao)
            = (SELECT count(*) FROM public.venda_situacao_em((now() AT TIME ZONE 'America/Sao_Paulo')::date))
            AND (SELECT count(*) FROM public.venda_situacao) > 0);
SELECT t_ok('K snapshot sem divergencia', NOT EXISTS (
  SELECT comprador_id, empresa, omie_codigo_produto, atrasado, valor_esperado FROM public.venda_recompra
  EXCEPT
  SELECT comprador_id, empresa, omie_codigo_produto, atrasado, valor_esperado
    FROM public.venda_recompra_em((now() AT TIME ZONE 'America/Sao_Paulo')::date)));
SQL

# Contagem para db/roda-nucleo-ci.sh: qualquer FAIL aborta antes daqui (ON_ERROR_STOP), então fail = 0.
N_OK="$(P -tA -c "SELECT count(*) FROM t_contagem")"
echo "RESULTADO: $N_OK ok / 0 fail"
[ -n "${PULA_PARIDADE:-}" ] && echo "AVISO: paridade PULADA — este verde NÃO é o da suíte"
echo "FIM-OK venda-recompra (locale $LOCALE)"
