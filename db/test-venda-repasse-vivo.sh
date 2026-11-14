#!/usr/bin/env bash
# test-venda-repasse-vivo.sh — prova PG17 da 20261113213000_venda_repasse_demanda_viva.sql (rodada 2, Entrega 5)
# ================================================================================================
# Banco: o MESMO da db/test-venda-repasse.sh (stubs + snapshot da prod + stub da Task 2), com a cadeia
# INTEIRA do repasse aplicada sem sabotagem (20261020233000 → 20261021021500 → 20261031233000 →
# 20261111170000) e, por cima, a migration sob prova (CÓPIA — a sabotagem age só nela; supabase/migrations/
# é DR e não se toca). A db/test-venda-repasse.sh continua provando a cadeia anterior por si.
#
# Casos:
#   H1   predecessores do repo = corpos medidos na prod (psql-ro 2026-11-13)
#   MIG  a migration aplica (PRE + CREATE + PÓS); IDEM re-aplicar não falha nem muda nada
#   V*   candidatos: vivo com sugerido e valor; parado e sem cadência SEM sugerido e SEM valor; borda do 2×;
#        demanda_viva; total vivo = soma só do vivo; recompra_sugerida_em (só ativa, só recompra, só Oben)
#   O*   ordem: vivo pela compra mais recente (não pelo valor), depois parado, substituído, sem cadência
#   A*   aprovar: vivo aprova e CONGELA a linha de base; parado → REPASSE_PARADO; sem cadência →
#        REPASSE_SEM_CADENCIA; substituído segue REPASSE_SUBSTITUIDO
#   S*   sensor: razão ao preço novo ÷ elegível, ganho com todas as linhas precificáveis, perda de volume pela
#        linha de base congelada, janela (dia da aprovação fora, revogação e validade cortam), cedo,
#        indisponível (sem linha de base, quantidade sem preço), perda 0 não "atinge"
#   G*   portas: estratégico (cap de custo sem master) e anon → 42501 no sensor e nos candidatos; ACL do sensor no catálogo
#
# Uso:  bash db/test-venda-repasse-vivo.sh > logs/t.log 2>&1; echo "exit=$?"
#       HARNESS_LC_ALL=pt_BR.UTF-8 bash db/test-venda-repasse-vivo.sh …   (rode nos DOIS locales)
#       bash db/test-venda-repasse-vivo.sh --falsificar > logs/f.log 2>&1; echo "exit=$?"
# O --falsificar roda PRIMEIRO o controle (sem sabotagem, exige verde e o total) e só então cada
# sabotagem, exigindo VERMELHO exatamente nos asserts listados e VERDE nos de controle.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5891}"
SLUG="venda-repasse-vivo"
export LC_ALL="${HARNESS_LC_ALL:-C}" LANG="${HARNESS_LC_ALL:-C}"
MIG_ORIG="$REPO_ROOT/supabase/migrations/20261020233000_venda_cliente_repasse.sql"
MIG_DESEMP="$REPO_ROOT/supabase/migrations/20261021021500_venda_repasse_base_desempenho.sql"
MIG_DEFASAGEM="$REPO_ROOT/supabase/migrations/20261014211500_defasagem_desconto_valor.sql"
MIG_SUBST="$REPO_ROOT/supabase/migrations/20261031233000_venda_repasse_substituicao.sql"
MIG_TRAVA="$REPO_ROOT/supabase/migrations/20261111170000_venda_repasse_trava_substituido.sql"
MIG_VIVO="${MIG:-$REPO_ROOT/supabase/migrations/20261113213000_venda_repasse_demanda_viva.sql}"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
TOTAL_ESPERADO=45

# ── Falsificação ─────────────────────────────────────────────────────────────────────────────
# nome:vermelhos:verdes. As de corpo não tocam o que a PÓS confere além do md5 (que vira NOTICE na cópia
# sabotada), então a migration aplica e o dente provado é o do ASSERT. As pre_/pos_ provam o dente da PRE/PÓS.
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="parado_sugere:V3,V5,V12:V1,V2
              parado_valor:V4,V6,V11:V1,V3
              sem_trava_parado:A3,A6:A1,A4
              sem_trava_semcad:A4:A1,A3
              ordem_valor:O1:O2,V1
              enc_fase:V9:V8,V10
              enc_empresa:V9:V8,V10
              base_nao_congela:A2,S16:A1
              janela_coalesce:S9:S8,S1
              inclui_dia_aprov:S1,S2:S5,S6
              ganho_so_alvo:S6:S5,S2
              perda_zero_atinge:S12:S4,S11
              sem_preco_conta:S13:S14,S2
              porta_master:G1,G3:G2,G4
              pos_acl_sensor:MIG!POS_ACL_SENSOR
              pre_helper:MIG!PRE_HELPER
              pre_trava:MIG!PRE_TRAVA"
  total_sab=$(( $(printf '%s\n' "$SABOTAGENS" | wc -w) ))   # contar sem um 2º laço sobre a lista (R2 do falsificar-exige-assert)
  sab_de=1; sab_ate=$total_sab; sufixo=""
  if [ -n "${NUCLEO_FAIXA:-}" ]; then
    if ! printf '%s' "$NUCLEO_FAIXA" | grep -qE '^[1-9]/[2-9]$' || [ "${NUCLEO_FAIXA%/*}" -gt "${NUCLEO_FAIXA#*/}" ]; then
      echo "❌ NUCLEO_FAIXA inválida: '$NUCLEO_FAIXA' (i/k, 1 ≤ i ≤ k, 2 ≤ k ≤ 9)"; exit 1
    fi
    f_i="${NUCLEO_FAIXA%/*}"; f_k="${NUCLEO_FAIXA#*/}"
    sab_de=$(( (f_i - 1) * total_sab / f_k + 1 )); sab_ate=$(( f_i * total_sab / f_k ))
    sufixo="-faixa${f_i}de${f_k}"
  fi
  falhas=0; sab_falhas=0; rodadas=0
  echo "═══ CONTROLE (sem sabotagem) ═══"
  if ! PGPORT_TEST="$PORT" bash "$0" > "/tmp/falsif-${SLUG}${sufixo}-controle.log" 2>&1; then
    echo "❌ CONTROLE VERMELHO — sem linha de base, a falsificação não prova nada"; tail -20 "/tmp/falsif-${SLUG}${sufixo}-controle.log"; exit 1
  fi
  n=$(grep -c '  ✅ ' "/tmp/falsif-${SLUG}${sufixo}-controle.log" || true)
  [ "$n" = "$TOTAL_ESPERADO" ] || { echo "❌ CONTROLE rodou $n asserts, esperado $TOTAL_ESPERADO"; exit 1; }
  echo "  ✅ controle verde ($n asserts)"
  i=0
  for linha in $SABOTAGENS; do
    i=$((i+1))
    [ "$i" -ge "$sab_de" ] && [ "$i" -le "$sab_ate" ] || continue
    rodadas=$((rodadas+1))
    nome="${linha%%:*}"; resto="${linha#*:}"; reds="${resto%%:*}"
    case "$resto" in *:*) greens="${resto#*:}" ;; *) greens="" ;; esac
    log="/tmp/falsif-${SLUG}-${nome}.log"
    if SABOTAGEM="$nome" PGPORT_TEST="$((PORT+i))" bash "$0" > "$log" 2>&1; then
      echo "❌ $nome: harness VERDE com a sabotagem — assert sem dente"; falhas=$((falhas+1)); sab_falhas=$((sab_falhas+1)); continue
    fi
    antes=$falhas
    # conjunto EXATO: nenhum vermelho além dos anunciados …
    falhou="$(grep -oE '^  ❌ [A-Za-z0-9]+' "$log" | awk '{print $2}' | sort -u | paste -sd, - || true)"
    anunciado="$(printf '%s\n' "$reds" | tr ',' '\n' | sed 's/!.*//' | sort -u | paste -sd, -)"
    [ "$falhou" = "$anunciado" ] || { echo "❌ $nome: vermelhos [$falhou] ≠ anunciados [$anunciado]"; falhas=$((falhas+1)); }
    # … e o mutante que aplica a migration tem de rodar a suíte INTEIRA (não abortar no meio)
    case "$reds" in
      *MIG*) ;;
      *) n_exec=$(grep -cE '^  (✅|❌) ' "$log" || true)
         [ "$n_exec" = "$TOTAL_ESPERADO" ] || { echo "❌ $nome: executou $n_exec asserts, esperado $TOTAL_ESPERADO"; falhas=$((falhas+1)); } ;;
    esac
    for a in ${reds//,/ }; do
      case "$a" in
        *!*) id="${a%%!*}"; marca="${a#*!}"   # vermelho de EXECUÇÃO: o erro tem de trazer a marca
             grep -q "^  ❌ $id .*ERROR:  $marca:" "$log" || { echo "❌ $nome: $id devia falhar com a marca $marca"; falhas=$((falhas+1)); } ;;
        *)   grep -q "^  ❌ $a " "$log" || { echo "❌ $nome: $a devia estar VERMELHO"; falhas=$((falhas+1)); } ;;
      esac
    done
    for a in ${greens//,/ }; do
      [ -n "$a" ] || continue
      grep -q "^  ✅ $a " "$log" || { echo "❌ $nome: $a (controle) devia seguir VERDE"; falhas=$((falhas+1)); }
    done
    [ "$falhas" = "$antes" ] || { sab_falhas=$((sab_falhas+1)); continue; }
    echo "  ✅ $nome → vermelho em [$reds]${greens:+, verde em [$greens]}"
  done
  [ -z "${NUCLEO_FAIXA:-}" ] || echo "FAIXA: $NUCLEO_FAIXA sabotagens $sab_de-$sab_ate de $total_sab"   # conferida por db/roda-nucleo-ci.sh
  echo "SABOTAGENS: $((rodadas - sab_falhas)) vermelhas / $sab_falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" = 0 ] || { echo "❌ FALSIFICAÇÃO FALHOU ($falhas)"; exit 1; }
  echo "✅ FALSIFICAÇÃO OK — todas as sabotagens ficaram vermelhas onde deviam"
  exit 0
fi

# ── arranque PG17 descartável ────────────────────────────────────────────────────────────────
# shellcheck disable=SC1091  # caminho dinâmico ($REPO_ROOT); o gate roda sem -x, como nas demais provas
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c TimeZone=UTC" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$3" = "$4" ]; then ok "$1 $2 (=$3)"; else bad "$1 $2 — esperado [$4], veio [$3]"; fi; }

# ZONA 1 — schema de prod: stubs + prelude + snapshot (igual à db/test-venda-repasse.sh)
rr="$TMPD/snap.sql"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" | grep -vE '^\\(un)?restrict ' > "$rr"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
DO $$ BEGIN CREATE ROLE claude_ro; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE sandbox_exec; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE sandbox_exec_fzvklzpomgnyikkfkzai; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
SQL
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
P --single-transaction -q -f "$rr" >/dev/null 2>"$TMPD/snap.err" || { echo "INFRA: snapshot não carregou"; tail -5 "$TMPD/snap.err"; exit 1; }
P -q <<'SQL' >/dev/null
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
REVOKE ALL ON FUNCTION public.get_defasagem_cliente(jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_defasagem_cliente(jsonb,uuid) TO authenticated, service_role, sandbox_exec_fzvklzpomgnyikkfkzai;
SQL
MD5_SNAP="$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.get_defasagem_cliente(jsonb,uuid)'::regprocedure")"
if [ "$MD5_SNAP" = "a03eb600ef0d2a946e550aa55bba415e" ]; then
  P -q -f "$MIG_DEFASAGEM" >/dev/null 2>&1 || { echo "INFRA: 20261014211500 não aplicou"; exit 1; }
fi
# STUB da Task 2 (definição EXATA da prod, 2026-10-20) + venda_sugestao com as colunas da prod (2026-11-13)
P -q <<'SQL' >/dev/null
CREATE TABLE IF NOT EXISTS public.venda_recompra (
  comprador_id uuid NOT NULL, empresa text NOT NULL, omie_codigo_produto bigint NOT NULL, product_id uuid,
  n_pedidos integer, cadencia_dias numeric, qtd_sugerida numeric, ultima_compra date, ultimo_preco numeric,
  due_ratio numeric, atrasado boolean, valor_esperado numeric, data_referencia date, calculado_em timestamptz);
CREATE TABLE IF NOT EXISTS public.venda_sugestao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tipo text NOT NULL, fase text NOT NULL, dia_referencia date NOT NULL,
  gerada_em timestamptz NOT NULL DEFAULT now(), farmer_user_id uuid NOT NULL, comprador_id uuid NOT NULL,
  empresa text NOT NULL, omie_codigo_produto bigint, familia text, qtd_ref numeric, valor_ref numeric,
  preco_alvo numeric, motivo_entrada text, mostrada_em timestamptz, desfecho text, desfecho_motivo text,
  sales_order_id uuid, valor_realizado numeric, avaliado_em timestamptz, preco_anterior numeric,
  sucessao_origem jsonb, valor_ref_referencia_origem boolean, braco text);
DO $stub$
BEGIN
  IF to_regprocedure('private.venda_linhas_pedido(date)') IS NULL THEN
    EXECUTE $def$
CREATE FUNCTION private.venda_linhas_pedido(p_ate date)
 RETURNS TABLE(comprador_id uuid, empresa text, omie_codigo_produto bigint, product_id uuid, quantidade numeric, preco_unit_liquido numeric, data_pedido date, sales_order_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT x.comprador_id, x.empresa, x.omie_codigo_produto, x.product_id,
         x.quantidade, x.preco_unit_liquido, x.data_pedido, x.sales_order_id
    FROM (
      SELECT COALESCE(a.canonical_user_id, so.customer_user_id) AS comprador_id,
             so.account AS empresa,
             oi.omie_codigo_produto,
             oi.product_id,
             oi.quantity AS quantidade,
             CASE WHEN oi.desconto_valor IS NULL OR oi.unit_price IS NULL THEN NULL
                  ELSE oi.unit_price - oi.desconto_valor / oi.quantity
             END AS preco_unit_liquido,
             COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS data_pedido,
             so.id AS sales_order_id
        FROM public.order_items oi
        JOIN public.sales_orders so ON so.id = oi.sales_order_id
        LEFT JOIN public.customer_canonical_alias a
               ON a.alias_user_id = so.customer_user_id AND a.status = 'active'
       WHERE so.deleted_at IS NULL
         AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
         AND so.customer_user_id IS NOT NULL
         AND so.account IN ('oben', 'colacor', 'colacor_sc')
         AND oi.omie_codigo_produto IS NOT NULL
         AND oi.quantity > 0
    ) x
   WHERE x.data_pedido < p_ate
$function$$def$;
    REVOKE ALL ON FUNCTION private.venda_linhas_pedido(date) FROM PUBLIC;
  END IF;
END $stub$;
REVOKE ALL ON TABLE public.venda_recompra FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.venda_sugestao FROM PUBLIC, anon, authenticated;
SQL

# ZONA 2 — a cadeia do repasse, SEM sabotagem (corpos de prod)
for m in "$MIG_ORIG" "$MIG_DESEMP" "$MIG_SUBST" "$MIG_TRAVA"; do
  P -q -f "$m" >"$TMPD/cadeia.out" 2>&1 || { echo "INFRA: cadeia não aplicou ($m)"; grep -m1 ERROR "$TMPD/cadeia.out"; exit 1; }
done
echo "═══ setup pronto (PG17 :$PORT, LC_ALL=$LC_ALL${SABOTAGEM:+, SABOTAGEM=$SABOTAGEM}) ═══"
MD5_PRED="$(Pq -c "SELECT string_agg(md5(prosrc), '|' ORDER BY oid::regprocedure::text) FROM pg_proc WHERE oid IN ('public.venda_repasse_candidatos()'::regprocedure, 'public.venda_aprovar_repasse(uuid,text,bigint,numeric,date,uuid)'::regprocedure, 'private._venda_repasse_situacao(uuid[],bigint[],date[],numeric[])'::regprocedure)")"
eq H1 "predecessores do repo = corpos medidos na prod (helper|aprovar|candidatos)" "$MD5_PRED" \
  "880fde236d6a1fce766018c38e42ddee|20d3480890707542ed5554d282b8f2c1|8753df515389250c82f1b287661079ec"

# ZONA 3 — semente (replica: sem gatilhos/FKs; a semente não é o objeto sob prova). Cadência 14 d; hoje = H.
P -q <<'SQL' >/dev/null
ALTER TABLE public.sales_orders DISABLE TRIGGER ALL;
ALTER TABLE public.order_items  DISABLE TRIGGER ALL;
SET session_replication_role = replica;
CREATE SEQUENCE pg_temp.seq_ped START 770000;
CREATE FUNCTION pg_temp.compra(p_cli uuid, p_cod bigint, p_dia date, p_qty numeric, p_unit numeric, p_desc numeric)
RETURNS void LANGUAGE plpgsql AS $c$
DECLARE so uuid := gen_random_uuid(); n bigint := nextval('pg_temp.seq_ped');
BEGIN
  INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, status, order_date_kpi,
                                   omie_pedido_id, omie_numero_pedido, total, discount)
    VALUES (so, p_cli, p_cli, 'oben', 'faturado', p_dia, n, n::text, 1000, 0);
  INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, discount, desconto_valor)
    VALUES (so, p_cli, p_cod, p_qty, p_unit, 0, p_desc);
END $c$;
-- candidato defasado: dias de compra a 90 e o último a 100; c_last 60 no dia, c_now 80 fresco → sugerido 133,33
CREATE FUNCTION pg_temp.cand(p_cli uuid, p_cod bigint, p_dias int[], p_cad numeric, p_qtd numeric)
RETURNS void LANGUAGE plpgsql AS $c$
DECLARE hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date; i int; ult int := p_dias[cardinality(p_dias)];
BEGIN
  FOR i IN 1 .. cardinality(p_dias) LOOP
    PERFORM pg_temp.compra(p_cli, p_cod, hoje - p_dias[i], 10, CASE WHEN i = cardinality(p_dias) THEN 100 ELSE 90 END, 0);
  END LOOP;
  INSERT INTO public.venda_recompra (comprador_id, empresa, omie_codigo_produto, n_pedidos, cadencia_dias, qtd_sugerida,
                                     ultima_compra, ultimo_preco, data_referencia, calculado_em)
    VALUES (p_cli, 'oben', p_cod, cardinality(p_dias), p_cad, p_qtd, hoje - ult, 100, hoje, now());
  INSERT INTO public.cmc_snapshot (omie_codigo_produto, account, data_posicao, cmc, synced_at)
    VALUES (p_cod, 'oben', hoje - ult, 60, now()) ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.inventory_position WHERE omie_codigo_produto = p_cod) THEN
    INSERT INTO public.inventory_position (omie_codigo_produto, cmc, account, synced_at) VALUES (p_cod, 80, 'oben', now());
  END IF;
END $c$;
DO $seed$
DECLARE
  hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  mst uuid := md5('rv:master')::uuid;   far uuid := md5('rv:farmer')::uuid;   est uuid := md5('rv:estrategico')::uuid;
BEGIN
  INSERT INTO public.user_roles (user_id, role) VALUES (mst, 'master'), (far, 'employee'), (est, 'employee');
  -- estrategico TEM a capacidade de custo e NÃO é master: só a porta de master o recusa
  INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES (est, 'estrategico');
  INSERT INTO public.company_config (key, value) VALUES ('regua_preco_aliquota_venda_oben', '0.10');
  INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, is_tintometric, familia) VALUES
    (7201, 'PRD07201', 'LIXA VIVO', 'oben', false, NULL),
    (9401, 'PRD03396', 'DILUENTE PU DFA.4128LT', 'oben', false, 'Diluente PU'),
    (9402, 'PRD03666', 'DILUENTE PU DFA.4080LT', 'oben', false, 'Diluente PU'),
    (7301, 'PRD07301', 'LIXA SENSOR', 'oben', false, NULL);
  -- vivo recente (última H-4, qtd 10) × vivo antigo (última H-26, qtd 20 → MAIOR valor): a ordem é pela compra
  PERFORM pg_temp.cand(md5('rv:vivo-recente')::uuid, 7201, ARRAY[60,46,32,18,4], 14, 10);
  PERFORM pg_temp.cand(md5('rv:vivo-antigo')::uuid,  7201, ARRAY[82,68,54,40,26], 14, 20);
  -- borda do 2×: 28 d = vivo; 29 d = parado
  PERFORM pg_temp.cand(md5('rv:borda-vivo')::uuid,   7201, ARRAY[84,70,56,42,28], 14, 10);
  PERFORM pg_temp.cand(md5('rv:borda-parado')::uuid, 7201, ARRAY[85,71,57,43,29], 14, 10);
  -- parado de verdade (H-40) e sem cadência
  PERFORM pg_temp.cand(md5('rv:parado')::uuid,       7201, ARRAY[96,82,68,54,40], 14, 10);
  PERFORM pg_temp.cand(md5('rv:sem-cadencia')::uuid, 7201, ARRAY[96,82,68,54,40], NULL, 10);
  -- substituído (4128 parou em H-100, 4080 entrou depois)
  PERFORM pg_temp.cand(md5('rv:substituido')::uuid,  9401, ARRAY[160,146,132,118,100], 14, 10);
  PERFORM pg_temp.compra(md5('rv:substituido')::uuid, 9402, hoje - 90, 10, 90, 0);
  PERFORM pg_temp.compra(md5('rv:substituido')::uuid, 9402, hoje - 60, 10, 90, 0);
  PERFORM pg_temp.compra(md5('rv:substituido')::uuid, 9402, hoje - 30, 10, 90, 0);
  -- encaminhamento do parado à farmer: ativa H-3 e H-1 (vale H-1); sombra em H e Colacor em H NÃO contam
  INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto) VALUES
    ('recompra', 'ativa',  hoje - 3, far, md5('rv:parado')::uuid, 'oben',    7201),
    ('recompra', 'ativa',  hoje - 1, far, md5('rv:parado')::uuid, 'oben',    7201),
    ('recompra', 'sombra', hoje,     far, md5('rv:parado')::uuid, 'oben',    7201),
    ('recompra', 'ativa',  hoje,     far, md5('rv:parado')::uuid, 'colacor', 7201);

END $seed$;
SET session_replication_role = origin;
ALTER TABLE public.sales_orders ENABLE TRIGGER ALL;
ALTER TABLE public.order_items  ENABLE TRIGGER ALL;
SQL

MST="$(Pq -c "SELECT md5('rv:master')::uuid")"; EST="$(Pq -c "SELECT md5('rv:estrategico')::uuid")"
id_de() { Pq -c "SELECT md5('rv:$1')::uuid"; }
como() { # $1 = uid, $2 = SQL → saída (sem as linhas SET)
  Pq -c "SET test.uid='$1'; SET ROLE authenticated; $2" 2>&1 | grep -v '^SET$' || true
}
# negativo: captura SÓ a condição esperada (e a marca no SQLERRM); o resto re-lança
neg() { # $1 id, $2 descrição, $3 uid ('' = anon), $4 condição, $5 marca ('' = qualquer), $6 statement
  local papel="authenticated" out
  [ -n "$3" ] || papel="anon"
  out="$(Pq -c "BEGIN; SET LOCAL test.uid='$3'; SET LOCAL ROLE $papel;
DO \$n\$ BEGIN
  $6;
  RAISE NOTICE 'NEG-PASSOU';
EXCEPTION WHEN $4 THEN RAISE NOTICE 'NEG-OK[%]', SQLERRM;
          WHEN OTHERS THEN RAISE;
END \$n\$;
ROLLBACK;" 2>&1 || true)"
  if grep -q "NEG-OK\[.*$5" <<< "$out"; then ok "$1 $2"
  else bad "$1 $2 — veio: $(printf '%s' "$out" | grep -E 'NEG-|ERROR' | head -1 | cut -c1-220)"; fi
}

# ZONA 4 — a migration sob prova (CÓPIA, onde a sabotagem age)
MIGV="$TMPD/mig-vivo.sql"; cp "$MIG_VIVO" "$MIGV"
md5de() { cat "$@" | { md5 -q 2>/dev/null || md5sum | cut -d' ' -f1; }; }
# o md5 da PRE/PÓS vira NOTICE para o corpo sabotado chegar ao banco (o dente é o do ASSERT)
desliga_md5() { sed -i.bak -E "s/RAISE EXCEPTION 'P(RE_TRAVA|RE_TRAVA_SENSOR|OS): /RAISE NOTICE 'P\1: /g" "$MIGV"; }
sabotar() { # $1 = sed na cópia; exige que o sed MUDE
  local antes; antes="$(md5de "$MIGV")"
  sed -i.bak -E "$1" "$MIGV"
  [ "$antes" != "$(md5de "$MIGV")" ] || { echo "INFRA: sabotagem '$SABOTAGEM' não casou nada"; exit 2; }
}
case "${SABOTAGEM:-}" in
  "") ;;
  parado_sugere)     sabotar "s/CASE WHEN f\.viva THEN f\.sugerido END/f.sugerido/"; desliga_md5 ;;
  parado_valor)      sabotar "s/^( +)CASE WHEN f\.viva$/\1CASE WHEN true/"; desliga_md5 ;;
  sem_trava_parado)  sabotar "s/IF v_sit\.situacao IS NOT DISTINCT FROM 'parado' THEN/IF false THEN/"; desliga_md5 ;;
  sem_trava_semcad)  sabotar "s/IF v_sit\.situacao IS DISTINCT FROM 'comprando' THEN/IF false THEN/"; desliga_md5 ;;
  ordem_valor)       sabotar "/CASE WHEN g\.viva THEN g\.data_ancora END DESC NULLS LAST,/d"; desliga_md5 ;;
  enc_fase)          sabotar "s/ AND vs\.fase = 'ativa'//"; desliga_md5 ;;
  enc_empresa)       sabotar "s/ AND vs\.empresa = 'oben'$//"; desliga_md5 ;;
  base_nao_congela)  sabotar "s/CASE WHEN v_cad > 0 AND private\.regua_num_finito\(v_cad\) THEN v_cad END/NULL/"; desliga_md5 ;;
  janela_coalesce)   sabotar "s/least\(coalesce\(\(ra\.revogado_em AT TIME ZONE 'America\/Sao_Paulo'\)::date, v_hoje\), ra\.valido_ate, v_hoje\)/coalesce((ra.revogado_em AT TIME ZONE 'America\/Sao_Paulo')::date, least(ra.valido_ate, v_hoje))/"; desliga_md5 ;;
  inclui_dia_aprov)  sabotar "s/l\.data_pedido > ap\.ini/l.data_pedido >= ap.ini/"; desliga_md5 ;;
  ganho_so_alvo)     sabotar "s/FILTER \(WHERE private\.regua_num_finito\(l\.preco_unit_liquido\)\), 0\) AS ganho_bruto/FILTER (WHERE l.preco_unit_liquido >= ap.preco_alvo - 0.005), 0) AS ganho_bruto/"; desliga_md5 ;;
  perda_zero_atinge) sabotar "s/WHEN w\.perda > 0 AND w\.perda >= w\.ganho/WHEN w.perda >= w.ganho/"; desliga_md5 ;;
  sem_preco_conta)   sabotar "s/WHEN m\.qtd_elegivel > 0 AND m\.qtd_sem_preco = 0/WHEN m.qtd_elegivel > 0/"; desliga_md5 ;;
  porta_master)      sabotar "s/IF v_uid IS NULL OR NOT public\.has_role\(v_uid, 'master'::public\.app_role\)$/IF v_uid IS NULL/"; desliga_md5 ;;
  pos_acl_sensor)    sabotar "/^REVOKE ALL ON FUNCTION public\.venda_repasse_sensor\(\) FROM PUBLIC, anon;$/d" ;;
  pre_helper|pre_trava) ;;
  *) echo "INFRA: sabotagem desconhecida $SABOTAGEM"; exit 2 ;;
esac
# pre_helper: a regra única derivou na prod antes desta migration — a PRE tem de recusar
DERIVA=":"
[ "${SABOTAGEM:-}" = "pre_helper" ] && DERIVA="P -q -c \"DO \\\$d\\\$ BEGIN EXECUTE replace(pg_get_functiondef('private._venda_repasse_situacao(uuid[],bigint[],date[],numeric[])'::regprocedure), 'ELSE ''comprando'' END', 'ELSE ''comprando'' END /* deriva */'); END \\\$d\\\$\""
# pre_trava: o corpo dos candidatos derivou (apply manual divergente) — a trava tem de recusar
[ "${SABOTAGEM:-}" = "pre_trava" ] && DERIVA="P -q -c \"DO \\\$d\\\$ BEGIN EXECUTE replace(pg_get_functiondef('public.venda_repasse_candidatos()'::regprocedure), 'RETURN v_out;', 'RETURN v_out; -- deriva'); END \\\$d\\\$\""
if eval "$DERIVA" && P -q -f "$MIGV" >"$TMPD/mig.out" 2>&1; then
  ok "MIG migration aplicou (PRE + CREATE + POS)"
else
  bad "MIG migration não aplicou: $(grep -m1 -E 'ERROR' "$TMPD/mig.out" | cut -c1-200)"
  echo "PASS=$PASS  FAIL=$FAIL"; exit 1
fi
MD5_DEPOIS="$(Pq -c "SELECT string_agg(md5(prosrc), '|' ORDER BY oid::regprocedure::text) FROM pg_proc WHERE proname IN ('venda_repasse_candidatos','venda_aprovar_repasse','venda_repasse_sensor')")"
if P -q -f "$MIGV" >"$TMPD/mig2.out" 2>&1; then
  eq IDEM "re-aplicar não falha nem muda os corpos" \
    "$(Pq -c "SELECT string_agg(md5(prosrc), '|' ORDER BY oid::regprocedure::text) FROM pg_proc WHERE proname IN ('venda_repasse_candidatos','venda_aprovar_repasse','venda_repasse_sensor')")" "$MD5_DEPOIS"
else
  bad "IDEM re-aplicar falhou: $(grep -m1 ERROR "$TMPD/mig2.out" | cut -c1-200)"
fi

# semente do sensor (usa as colunas novas → só depois da migration)
P -q <<'SQL' >/dev/null
ALTER TABLE public.sales_orders DISABLE TRIGGER ALL;
ALTER TABLE public.order_items  DISABLE TRIGGER ALL;
SET session_replication_role = replica;
CREATE SEQUENCE pg_temp.seq_ped START 790000;
CREATE FUNCTION pg_temp.compra(p_cli uuid, p_cod bigint, p_dia date, p_qty numeric, p_unit numeric, p_desc numeric)
RETURNS void LANGUAGE plpgsql AS $c$
DECLARE so uuid := gen_random_uuid(); n bigint := nextval('pg_temp.seq_ped');
BEGIN
  INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, status, order_date_kpi,
                                   omie_pedido_id, omie_numero_pedido, total, discount)
    VALUES (so, p_cli, p_cli, 'oben', 'faturado', p_dia, n, n::text, 1000, 0);
  INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, discount, desconto_valor)
    VALUES (so, p_cli, p_cod, p_qty, p_unit, 0, p_desc);
END $c$;
DO $sen$
DECLARE
  hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  mst uuid := md5('rv:master')::uuid;
BEGIN
  -- ── sensor: aprovações SEMEADAS no passado (linha de base congelada), p0 = 100, custo 60, alíquota 0,10 ──
  -- margem unitária = 100 × 0,9 − 60 = 30
  INSERT INTO public.venda_repasse_aprovado (id, comprador_id, empresa, omie_codigo_produto, preco_alvo,
      ultimo_preco_na_aprovacao, valido_ate, aprovado_por, aprovado_em, revogado_em, revogado_por,
      cadencia_na_aprovacao, qtd_ref_na_aprovacao, ultima_compra_na_aprovacao, custo_na_aprovacao) VALUES
    -- S-a: aprovado H-60, 1 compra de 10 a 120 em H-30 e 10 a 120 NO DIA da aprovação (fora) → esperado 42,86
    (md5('sa')::uuid, md5('rv:s-a')::uuid, 'oben', 7301, 120, 100, hoje + 30, mst,
       ((hoje - 60)::timestamp + interval '10 hours') AT TIME ZONE 'America/Sao_Paulo', NULL, NULL, 14, 10, hoje - 61, 60),
    -- S-b: aprovado H-30; 10 a 110 (H-25), 10 a 110 (H-12), 10 a 105 (H-2): aumento parcial também é ganho
    (md5('sb')::uuid, md5('rv:s-b')::uuid, 'oben', 7301, 110, 100, hoje + 30, mst,
       ((hoje - 30)::timestamp + interval '10 hours') AT TIME ZONE 'America/Sao_Paulo', NULL, NULL, 14, 10, hoje - 31, 60),
    -- S-c: aprovado H-5 → janela de 5 d < cadência 14 → cedo
    (md5('sc')::uuid, md5('rv:s-c')::uuid, 'oben', 7301, 110, 100, hoje + 30, mst,
       ((hoje - 5)::timestamp + interval '10 hours') AT TIME ZONE 'America/Sao_Paulo', NULL, NULL, 14, 10, hoje - 6, 60),
    -- S-d: sem linha de base (aprovação anterior à 20261113213000) → indisponível
    (md5('sd')::uuid, md5('rv:s-d')::uuid, 'oben', 7301, 110, 100, hoje + 30, mst,
       ((hoje - 40)::timestamp + interval '10 hours') AT TIME ZONE 'America/Sao_Paulo', NULL, NULL, NULL, NULL, NULL, NULL),
    -- S-e: validade H-50 e revogação TARDIA em H-10 → a janela fecha na validade (H-50): compra em H-45 fica fora
    (md5('se')::uuid, md5('rv:s-e')::uuid, 'oben', 7301, 110, 100, hoje - 50, mst,
       ((hoje - 80)::timestamp + interval '10 hours') AT TIME ZONE 'America/Sao_Paulo',
       ((hoje - 10)::timestamp + interval '10 hours') AT TIME ZONE 'America/Sao_Paulo', mst, 14, 10, hoje - 81, 60),
    -- S-f: vendeu o volume esperado ao preço ANTIGO (ganho 0, perda 0) → não atinge
    (md5('sf')::uuid, md5('rv:s-f')::uuid, 'oben', 7301, 110, 100, hoje + 30, mst,
       ((hoje - 28)::timestamp + interval '10 hours') AT TIME ZONE 'America/Sao_Paulo', NULL, NULL, 14, 10, hoje - 29, 60),
    -- S-g: uma linha SEM preço (desconto não apurado) → razão NULL, indisponível
    (md5('sg')::uuid, md5('rv:s-g')::uuid, 'oben', 7301, 110, 100, hoje + 30, mst,
       ((hoje - 30)::timestamp + interval '10 hours') AT TIME ZONE 'America/Sao_Paulo', NULL, NULL, 14, 10, hoje - 31, 60);
  PERFORM pg_temp.compra(md5('rv:s-a')::uuid, 7301, hoje - 60, 10, 120, 0);   -- dia da aprovação: fora da janela
  PERFORM pg_temp.compra(md5('rv:s-a')::uuid, 7301, hoje - 30, 10, 120, 0);
  PERFORM pg_temp.compra(md5('rv:s-b')::uuid, 7301, hoje - 25, 10, 110, 0);
  PERFORM pg_temp.compra(md5('rv:s-b')::uuid, 7301, hoje - 12, 10, 110, 0);
  PERFORM pg_temp.compra(md5('rv:s-b')::uuid, 7301, hoje - 2,  10, 105, 0);
  PERFORM pg_temp.compra(md5('rv:s-c')::uuid, 7301, hoje - 2,  10, 110, 0);
  PERFORM pg_temp.compra(md5('rv:s-e')::uuid, 7301, hoje - 60, 10, 110, 0);
  PERFORM pg_temp.compra(md5('rv:s-e')::uuid, 7301, hoje - 45, 10, 110, 0);   -- depois da validade: fora
  PERFORM pg_temp.compra(md5('rv:s-f')::uuid, 7301, hoje - 14, 10, 100, 0);
  PERFORM pg_temp.compra(md5('rv:s-f')::uuid, 7301, hoje - 1,  10, 100, 0);
  PERFORM pg_temp.compra(md5('rv:s-g')::uuid, 7301, hoje - 20, 10, 110, 0);
  PERFORM pg_temp.compra(md5('rv:s-g')::uuid, 7301, hoje - 10, 10, 110, NULL); -- preço líquido NULL
END $sen$;
SET session_replication_role = origin;
ALTER TABLE public.sales_orders ENABLE TRIGGER ALL;
ALTER TABLE public.order_items  ENABLE TRIGGER ALL;
SQL

# ── candidatos ──
CAND="$TMPD/cand.json"
como "$MST" "SELECT public.venda_repasse_candidatos()" > "$CAND"
item() { # $1 = slug do comprador, $2 = chave → valor (texto; '(null)' se ausente/NULL)
  local c; c="$(id_de "$1")"
  Pq -c "SELECT coalesce(e->>'$2', '(null)') FROM jsonb_array_elements(\$j\$$(cat "$CAND")\$j\$::jsonb) e WHERE e->>'comprador_id' = '$c'" | head -1 | sed 's/^$/(sem linha)/'
}
eq V1 "vivo recente: sugerido 133.33" "$(item vivo-recente preco_sugerido)" "133.33"
eq V2 "vivo recente: valor anual = 10×365/14×(133,333… − 100)" "$(item vivo-recente valor_anual_recuperavel)" "8689.61"
eq V3 "parado (H-40): SEM sugerido" "$(item parado preco_sugerido)" "(null)"
eq V4 "parado (H-40): SEM valor anual" "$(item parado valor_anual_recuperavel)" "(null)"
eq V5 "sem cadência: SEM sugerido" "$(item sem-cadencia preco_sugerido)" "(null)"
eq V6 "borda 29 d (> 2×14) = parado e sem valor" "$(item borda-parado situacao_compra)/$(item borda-parado valor_anual_recuperavel)" "parado/(null)"
eq V7 "borda 28 d (= 2×14) = vivo, com valor; demanda_viva" "$(item borda-vivo situacao_compra)/$(item borda-vivo demanda_viva)/$(item borda-vivo preco_sugerido)" "comprando/true/133.33"
eq V8 "demanda_viva false (não NULL) no parado, no sem cadência e no substituído" \
  "$(item parado demanda_viva)/$(item sem-cadencia demanda_viva)/$(item substituido demanda_viva)" "false/false/false"
HOJE="$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"
eq V9 "parado: recompra_sugerida_em = último dia ATIVO de recompra Oben (H-1)" "$(item parado recompra_sugerida_em)" \
  "$(Pq -c "SELECT ('$HOJE'::date - 1)::text")"
eq V10 "sem registro na lista → recompra_sugerida_em NULL" "$(item vivo-recente recompra_sugerida_em)" "(null)"
TOTAL_VIVO="$(Pq -c "SELECT coalesce(sum((e->>'valor_anual_recuperavel')::numeric), 0) FROM jsonb_array_elements(\$j\$$(cat "$CAND")\$j\$::jsonb) e")"
eq V11 "o recuperável do painel soma só o vivo (8689,61 + 17379,21 + 8689,61)" "$TOTAL_VIVO" "34758.43"
eq V12 "substituído segue sem sugerido" "$(item substituido situacao_compra)/$(item substituido preco_sugerido)" "substituido/(null)"
ORDEM="$(Pq -c "SELECT string_agg(coalesce(e->>'situacao_compra', '(null)') || ':' || (e->>'dias_sem_comprar'), ',' ORDER BY o) FROM jsonb_array_elements(\$j\$$(cat "$CAND")\$j\$::jsonb) WITH ORDINALITY AS t(e, o)")"
eq O1 "ordem: vivo pela compra mais recente (4, 26, 28 d), não pelo valor" "$(printf '%s' "$ORDEM" | cut -d, -f1-3)" "comprando:4,comprando:26,comprando:28"
eq O2 "depois do vivo: parados, substituído, sem cadência" "$(printf '%s' "$ORDEM" | cut -d, -f4- | sed -E 's/:[0-9]+//g')" "parado,parado,substituido,(null)"

# ── aprovar ──
VR="$(id_de vivo-recente)"
AP1="$(como "$MST" "SELECT public.venda_aprovar_repasse('$VR', 'oben', 7201, 130.00, ('$HOJE'::date + 60), NULL)")"
eq A1 "vivo aprova (devolve id)" "$(printf '%s' "$AP1" | grep -cE '^[0-9a-f-]{36}$')" "1"
eq A2 "a aprovação congela a linha de base (cadência|qtd|última compra|custo)" \
  "$(Pq -c "SELECT cadencia_na_aprovacao || '|' || qtd_ref_na_aprovacao || '|' || ('$HOJE'::date - ultima_compra_na_aprovacao) || '|' || custo_na_aprovacao FROM public.venda_repasse_aprovado WHERE comprador_id = '$VR'")" \
  "14|10|4|80"
neg A3 "parado → REPASSE_PARADO" "$MST" invalid_parameter_value "REPASSE_PARADO" \
  "PERFORM public.venda_aprovar_repasse('$(id_de parado)', 'oben', 7201, 130.00, ('$HOJE'::date + 60), NULL)"
neg A4 "sem cadência → REPASSE_SEM_CADENCIA" "$MST" invalid_parameter_value "REPASSE_SEM_CADENCIA" \
  "PERFORM public.venda_aprovar_repasse('$(id_de sem-cadencia)', 'oben', 7201, 130.00, ('$HOJE'::date + 60), NULL)"
neg A5 "substituído segue → REPASSE_SUBSTITUIDO" "$MST" invalid_parameter_value "REPASSE_SUBSTITUIDO" \
  "PERFORM public.venda_aprovar_repasse('$(id_de substituido)', 'oben', 9401, 130.00, ('$HOJE'::date + 60), NULL)"
neg A6 "borda 29 d → REPASSE_PARADO" "$MST" invalid_parameter_value "REPASSE_PARADO" \
  "PERFORM public.venda_aprovar_repasse('$(id_de borda-parado)', 'oben', 7201, 130.00, ('$HOJE'::date + 60), NULL)"

# ── sensor ──
SEN="$TMPD/sensor.json"
como "$MST" "SELECT public.venda_repasse_sensor()" > "$SEN"
sen() { # $1 = id semeado (md5 de 'sa'…), $2 = chave
  Pq -c "SELECT coalesce(e->>'$2', '(null)') FROM jsonb_array_elements(\$j\$$(cat "$SEN")\$j\$::jsonb) e WHERE e->>'id' = md5('$1')::uuid::text" | head -1 | sed 's/^$/(sem linha)/'
}
eq S1 "S-a: elegível 10 (o dia da aprovação fica fora), ao preço novo 10, razão 1" \
  "$(sen sa qtd_elegivel)|$(sen sa qtd_ao_preco_novo)|$(sen sa razao_preco_novo)" "10|10|1.0000"
eq S2 "S-a: esperado 10×60/14 = 42,86; perda (42,86−10)×30 = 985,80; ganho 10×20×0,9 = 180" \
  "$(sen sa qtd_esperada)|$(sen sa perda_volume)|$(sen sa ganho_preco)" "42.86|985.80|180.00"
eq S3 "S-a: perda >= ganho → critério de desligar ATINGIDO" "$(sen sa criterio_desligar)" "atingido"
eq S4 "S-b: elegível 30, ao preço novo 20, razão 0,6667" \
  "$(sen sb qtd_elegivel)|$(sen sb qtd_ao_preco_novo)|$(sen sb razao_preco_novo)" "30|20|0.6667"
eq S5 "S-b: volume acima do esperado (21,43) → perda 0, não atinge" "$(sen sb qtd_esperada)|$(sen sb perda_volume)|$(sen sb criterio_desligar)" "21.43|0.00|nao_atingido"
eq S6 "S-b: ganho conta o aumento parcial (10×10 + 10×10 + 10×5) × 0,9" "$(sen sb ganho_preco)" "225.00"
eq S7 "S-c: janela 5 d < cadência → cedo" "$(sen sc dias_janela)|$(sen sc criterio_desligar)|$(sen sc motivo)" "5|cedo|janela_menor_que_cadencia"
eq S8 "S-d: sem linha de base → indisponível" "$(sen sd criterio_desligar)|$(sen sd motivo)|$(sen sd qtd_esperada)" "indisponivel|sem_linha_de_base|(null)"
eq S9 "S-e: revogação tardia não estende a janela além da validade (H-80 → H-50 = 30 d; só a compra de H-60)" \
  "$(sen se dias_janela)|$(sen se qtd_elegivel)" "30|10"
eq S10 "S-e: revogado sai como não vigente" "$(sen se vigente)" "false"
eq S11 "S-f: volume esperado ao preço antigo → ganho 0" "$(sen sf ganho_preco)|$(sen sf perda_volume)" "0.00|0.00"
eq S12 "S-f: perda 0 não atinge o critério (0 >= 0 não desliga)" "$(sen sf criterio_desligar)" "nao_atingido"
eq S13 "S-g: quantidade sem preço → razão NULL e indisponível" \
  "$(sen sg qtd_sem_preco)|$(sen sg razao_preco_novo)|$(sen sg criterio_desligar)|$(sen sg motivo)" "10|(null)|indisponivel|quantidade_sem_preco"
eq S14 "S-g: a quantidade sem preço CONTA no elegível" "$(sen sg qtd_elegivel)|$(sen sg qtd_ao_preco_novo)" "20|10"
eq S15 "sensor lista as 7 semeadas + a aprovada agora, vigentes primeiro" \
  "$(Pq -c "SELECT count(*) || '|' || bool_and(o <= 7 OR NOT (e->>'vigente')::boolean) FROM jsonb_array_elements(\$j\$$(cat "$SEN")\$j\$::jsonb) WITH ORDINALITY AS t(e, o)")" "8|true"
eq S16 "a aprovada agora aparece com a linha de base e janela 0 → cedo" \
  "$(Pq -c "SELECT (e->>'dias_janela') || '|' || (e->>'criterio_desligar') FROM jsonb_array_elements(\$j\$$(cat "$SEN")\$j\$::jsonb) e WHERE e->>'comprador_id' = '$VR'")" "0|cedo"

# ── portas ──
neg G1 "estratégico (tem cap de custo, não é master) no sensor → 42501" "$EST" insufficient_privilege "requer master" "PERFORM public.venda_repasse_sensor()"
neg G2 "anon no sensor → 42501 (sem EXECUTE)" "" insufficient_privilege "" "PERFORM public.venda_repasse_sensor()"
neg G3 "estratégico nos candidatos → 42501" "$EST" insufficient_privilege "requer master" "PERFORM public.venda_repasse_candidatos()"
eq G4 "ACL do sensor: anon não, PUBLIC não, authenticated sim" \
  "$(Pq -c "SELECT has_function_privilege('anon','public.venda_repasse_sensor()','EXECUTE') || '|' || has_function_privilege('public','public.venda_repasse_sensor()','EXECUTE') || '|' || has_function_privilege('authenticated','public.venda_repasse_sensor()','EXECUTE')")" "false|false|true"
eq G5 "a tabela segue fechada a authenticated" "$(Pq -c "SELECT has_table_privilege('authenticated','public.venda_repasse_aprovado','SELECT')::text")" "false"
eq G6 "colunas da linha de base nulas e sem default" \
  "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='venda_repasse_aprovado' AND column_name LIKE '%_na_aprovacao' AND column_name <> 'ultimo_preco_na_aprovacao' AND is_nullable='YES' AND column_default IS NULL")" "4"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
