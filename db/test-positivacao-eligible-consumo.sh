#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  REGRESSÃO — a elegibilidade é reaplicada no CONSUMO (comissão/positivação)    ║
# ║  FU3 do #1398, 2ª metade: spec §8-FU3 "reaplicar eligible no consumo/comissão, ║
# ║  não só no enqueue" (Codex §1.4-6).                                            ║
# ║                                                                                ║
# ║  ESTE TESTE NÃO ACOMPANHA MUDANÇA DE CÓDIGO. A invariante JÁ vale em prod      ║
# ║  (verificado 2026-07-18 via psql-ro: a CTE `eleg` filtra eligible=true e toda  ║
# ║  CTE downstream faz JOIN eleg). Ele existe para TRAVÁ-LA: sem teste, um        ║
# ║  refactor futuro que solte um JOIN eleg reabre o vazamento silenciosamente —   ║
# ║  e o efeito seria um número de COMISSÃO contando cliente mascarado.            ║
# ║                                                                                ║
# ║  A condicional do Codex que autoriza o recompute a rodar para inelegíveis      ║
# ║  ("vale enquanto a elegibilidade for reaplicada na exposição/comissão") passa  ║
# ║  a ser uma asserção executável, não uma promessa em prosa.                     ║
# ║                                                                                ║
# ║  rode: bash db/test-positivacao-eligible-consumo.sh > /tmp/t.log 2>&1; echo $? ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5472}"
SLUG="positivacao-eligible"
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
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (as 9 tabelas que a migration lê; colunas conferidas)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE TABLE public.carteira_assignments (
  customer_user_id uuid NOT NULL, owner_user_id uuid NOT NULL,
  eligible boolean NOT NULL DEFAULT true
);
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid, status text, total numeric,
  order_date_kpi date, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.farmer_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid, farmer_id uuid, started_at timestamptz
);
CREATE TABLE public.route_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid, visited_by uuid, visit_date date
);
CREATE TABLE public.farmer_client_scores (
  customer_user_id uuid, farmer_id uuid,
  revenue_potential numeric, churn_risk numeric, recover_score numeric,
  days_since_last_purchase numeric, priority_score numeric, avg_repurchase_interval numeric
);
CREATE TABLE public.profiles (user_id uuid, name text, razao_social text);
-- lidas pelo mixgap (mesma migration). Colunas e TIPOS conferidos na prod via psql-ro —
-- `omie_codigo_produto` é bigint, não text: um stub adivinhado quebraria o JOIN e o teste
-- provaria o mundo que eu quis, não o que existe.
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid, product_id uuid, omie_codigo_produto bigint,
  sales_order_id uuid, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint, familia text, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.farmer_association_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  antecedent_product_ids text[], consequent_product_ids text[],
  confidence numeric, lift numeric, sample_size integer, created_at timestamptz DEFAULT now()
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1) — traz positivacao E mixgap
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260525210000_viewas_rpcs_for.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED: 4 clientes do MESMO vendedor, em 2 pares idênticos-menos-`eligible`.
#   COM pedido no mês:  aaaa (MASCARADO) · bbbb (elegível)  → exercita positivados/receita
#   SEM pedido no mês:  cccc (MASCARADO) · dddd (elegível)  → exercita a_positivar
#   O par sem-pedido existe porque `a_positivar` lista quem AINDA NÃO comprou: sem ele,
#   a lista sai vazia e o assert passaria por vacuidade (0=0), sem provar a máscara.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master');

INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id, eligible) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222', false),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222', true),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','22222222-2222-2222-2222-222222222222', false),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','22222222-2222-2222-2222-222222222222', true);

-- pedido no mês corrente só p/ aaaa e bbbb (mesmo valor) → só o elegível pode contar
INSERT INTO public.sales_orders(customer_user_id, status, total, order_date_kpi) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','faturado', 1000, date_trunc('month', now())::date),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','faturado', 1000, date_trunc('month', now())::date);

INSERT INTO public.farmer_calls(customer_user_id, farmer_id, started_at) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222', now()),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222', now());

-- score p/ os 4 (churn_risk 90 ≥ 60 → todos entrariam em recencia_critica sem a máscara)
INSERT INTO public.farmer_client_scores
  (customer_user_id, farmer_id, revenue_potential, churn_risk, recover_score,
   days_since_last_purchase, priority_score, avg_repurchase_interval) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222', 5000, 90, 50, 200, 80, 30),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222', 5000, 90, 50, 200, 80, 30),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','22222222-2222-2222-2222-222222222222', 5000, 90, 50, 200, 80, 30),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','22222222-2222-2222-2222-222222222222', 5000, 90, 50, 200, 80, 30);

INSERT INTO public.profiles(user_id, name, razao_social) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Mascarado A','MASCARADO A LTDA'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Elegivel B','ELEGIVEL B LTDA'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','Mascarado C','MASCARADO C LTDA'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','Elegivel D','ELEGIVEL D LTDA');
SQL

E_UID="22222222-2222-2222-2222-222222222222"
Q() { Pq -c "SELECT (public._carteira_positivacao_for_owner('$E_UID'::uuid)->>'$1');"; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS: cada agregado da comissão ignora o cliente mascarado
# ══════════════════════════════════════════════════════════════════════════════
echo "── consumo/comissão reaplica eligible ──"
# 4 clientes na carteira, 2 elegíveis → todo agregado tem de enxergar SÓ os 2
eq "C1 total_eligible = só os elegíveis (2 de 4)"  "$(Q total_eligible)"   "2"
eq "C2 positivados ignora o mascarado"             "$(Q positivados)"      "1"
eq "C3 receita_mtd NÃO soma o mascarado (money)"   "$(Q receita_mtd)"      "1000"
eq "C4 contatados_mtd ignora o mascarado"          "$(Q contatados_mtd)"   "1"
eq "C5 recencia_critica ignora os mascarados"      "$(Q recencia_critica)" "2"

# a_positivar é a LISTA NOMINAL entregue ao vendedor — o mascarado não pode ser nomeado.
# (cccc é mascarado E sem pedido: sem a máscara ele apareceria aqui.)
V=$(Pq -c "SELECT (public._carteira_positivacao_for_owner('$E_UID'::uuid)->'a_positivar')::text ILIKE '%MASCARADO%';")
eq "C6 a_positivar NÃO nomeia mascarado"           "$V" "f"
V=$(Pq -c "SELECT jsonb_array_length(public._carteira_positivacao_for_owner('$E_UID'::uuid)->'a_positivar');")
eq "C7 a_positivar lista só o elegível sem pedido" "$V" "1"

# gate de autorização das RPCs expostas (não é o foco, mas é a fronteira)
V=$(Pq -c "SET test.uid='$E_UID'; SET ROLE authenticated; SELECT public.get_minha_positivacao() IS NOT NULL;" | tail -1)
eq "C8 employee lê a PRÓPRIA positivação"          "$V" "t"
# ⚠️ NÃO sinalize "não barrou" com `RAISE EXCEPTION` genérico: ele levanta P0001, o MESMO
# SQLSTATE do `RAISE EXCEPTION 'forbidden: master only'` da RPC → o handler `WHEN raise_exception`
# capturaria o PRÓPRIO sentinel e o assert ficaria verde com o gate ESCANCARADO. (Achado Codex
# xhigh no #1416; F2 abaixo falsifica.) Use uma FLAG, que não colide com SQLSTATE nenhum.
R=$(P -tA 2>&1 <<SQL
SET test.uid='$E_UID';
SET ROLE authenticated;
DO \$\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.get_minha_positivacao_for('33333333-3333-3333-3333-333333333333'::uuid);
    v_passou := true;                       -- chegou aqui = o gate deixou passar
  EXCEPTION
    WHEN raise_exception THEN NULL;         -- P0001 = o 'forbidden: master only' ESPERADO
    WHEN OTHERS THEN RAISE;                 -- qualquer outro erro: relança
  END;
  IF v_passou THEN RAISE NOTICE 'GATE_ABERTO_BUG'; ELSE RAISE NOTICE 'GATE_MASTER_OK'; END IF;
END \$\$;
SQL
)
case "$R" in
  *GATE_MASTER_OK*)  ok "C9 employee NÃO lê positivação de outro (master-only)" ;;
  *GATE_ABERTO_BUG*) bad "C9 gate ABERTO — employee leu positivação de outro" ;;
  *)                 bad "C9 — resultado inesperado: $R" ;;
esac

# mixgap: função IRMÃ na mesma migration, com a MESMA CTE `eleg` filtrando eligible.
# Aqui só se prova que EXECUTA (plpgsql é late-bound: um SQL inválido passaria no CREATE
# e só quebraria em runtime). Provar a máscara nela exigiria semear association_rules —
# não coberto; a invariante dela está verificada por leitura, não por assert.
V=$(Pq -c "SELECT (public._carteira_mixgap_for_owner('$E_UID'::uuid)->>'total_com_gap');")
eq "C10 mixgap EXECUTA (late-bound coberto)"       "$V" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO: solta o filtro da CTE `eleg` (o refactor que este teste
#   existe para pegar) e exige que os asserts de dinheiro fiquem VERMELHOS.
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
P -q <<'SQL'
-- sabotagem cirúrgica: a CTE eleg sem o `AND ca.eligible = true` — exatamente o que um
-- refactor distraído produziria. Só o corpo da positivação é trocado.
CREATE OR REPLACE FUNCTION public._carteira_positivacao_for_owner(p_owner uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := p_owner;
  mes_inicio date := date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date;
  mes_fim date := (date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')) + interval '1 month')::date;
  result jsonb;
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  WITH eleg AS (
    SELECT ca.customer_user_id FROM public.carteira_assignments ca
    WHERE ca.owner_user_id = uid            -- ← FILTRO eligible REMOVIDO (sabotagem)
  ),
  pedidos_validos AS (
    SELECT so.customer_user_id, COALESCE(so.order_date_kpi, so.created_at::date) AS d, so.total
    FROM public.sales_orders so WHERE so.status NOT IN ('cancelado','rascunho','pendente')
  ),
  pedidos_mes AS (
    SELECT pv.customer_user_id, sum(pv.total) AS receita
    FROM pedidos_validos pv JOIN eleg e ON e.customer_user_id = pv.customer_user_id
    WHERE pv.d >= mes_inicio AND pv.d < mes_fim GROUP BY pv.customer_user_id
  )
  SELECT jsonb_build_object(
    'total_eligible', (SELECT count(*) FROM eleg),
    'positivados',    (SELECT count(*) FROM pedidos_mes),
    'receita_mtd',    COALESCE((SELECT sum(receita) FROM pedidos_mes), 0)
  ) INTO result;
  RETURN result;
END;
$function$;
SQL
V=$(Q total_eligible); R1=$([ "$V" = "4" ] && echo hit || echo miss)
V=$(Q receita_mtd);    R2=$([ "$V" = "2000" ] && echo hit || echo miss)
if [ "$R1" = "hit" ] && [ "$R2" = "hit" ]; then
  ok "F1 sem o filtro, o mascarado ENTRA na comissão (total=4, receita=2000) → C1/C3 têm dente"
else
  bad "F1 soltei o filtro e os agregados NÃO mudaram → C1/C3 são fracos (total=$R1, receita=$R2)"
fi
P -q -f "$MIG"   # restaura a versão real
eq "F1-restore migration real de volta"            "$(Q receita_mtd)" "1000"

# F2 — abre o gate master de get_minha_positivacao_for e exige que C9 fique VERMELHO.
# É esta sabotagem que a versão ANTERIOR do C9 não pegava: o sentinel `RAISE EXCEPTION` era
# P0001 igual ao erro da RPC, então o handler engolia o próprio sentinel e pintava verde.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_minha_positivacao_for(p_target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  -- GATE REMOVIDO (sabotagem): sem o IF NOT has_role(...,'master') THEN RAISE
  IF p_target IS NULL THEN RAISE EXCEPTION 'target required'; END IF;
  RETURN public._carteira_positivacao_for_owner(p_target);
END; $function$;
SQL
R=$(P -tA 2>&1 <<SQL
SET test.uid='$E_UID';
SET ROLE authenticated;
DO \$\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.get_minha_positivacao_for('33333333-3333-3333-3333-333333333333'::uuid);
    v_passou := true;
  EXCEPTION
    WHEN raise_exception THEN NULL;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'GATE_ABERTO_BUG'; ELSE RAISE NOTICE 'GATE_MASTER_OK'; END IF;
END \$\$;
SQL
)
case "$R" in
  *GATE_ABERTO_BUG*) ok "F2 gate removido → C9 detecta (o assert tem dente de verdade)" ;;
  *) bad "F2 removi o gate master e C9 NÃO detectou → C9 ainda é teatro. Veio: $R" ;;
esac
P -q -f "$MIG"   # restaura

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
