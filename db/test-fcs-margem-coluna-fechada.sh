#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Prova PG17 do fecho de farmer_client_scores.gross_margin_pct (FU4-F)          ║
# ║    bash db/test-fcs-margem-coluna-fechada.sh > log 2>&1; echo $?               ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                               ║
# ║  Aplica as DUAS migrations reais, na ordem de prod:                           ║
# ║   A 20261014120000 — RPC get_scores_margem (gate de PROJEÇÃO por cap_custo_ler)║
# ║   B 20261014120100 — REVOKE SELECT de tabela + GRANT das 30 outras colunas     ║
# ║                                                                               ║
# ║  O que prova:                                                                 ║
# ║   · LINHA DE BASE: com o ACL de prod de hoje a vendedora LÊ a margem (o furo) ║
# ║   · RPC: número exato sob cap_custo_ler; NULL + margem_visivel=false sem ela;  ║
# ║     escopo = fcs_select_carteira; fail-closed sem uid; anon não executa        ║
# ║   · COLUNA: ninguém authenticated lê/filtra/ordena/RETURNING a margem — nem o  ║
# ║     master (privilégio é por PAPEL); `select *` quebra (as telas não podem usá-lo)
# ║   · a RLS segue MORDENDO nas colunas que ficaram (corolário #1488: o aperto não ║
# ║     pode virar a razão do negativo)                                            ║
# ║   · service_role (writer calculate-scores) intacto; view invoker sem a coluna ok║
# ║   · FALSIFICAÇÃO: 6 sabotagens, cada uma exige o seu assert VERMELHO           ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5491}"
SLUG="fcsmargem"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$RODADA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$RODADA/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  XX  $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MIG_A="$REPO_ROOT/supabase/migrations/20261014120000_fcs_margem_rpc_projecao.sql"
MIG_B="$REPO_ROOT/supabase/migrations/20261014120100_fcs_margem_fecha_coluna.sql"

# ── ZONA 1: stubs espelhando a PROD (psql-ro, 2026-10-14) ─────────────────────
# 31 colunas na ordem de prod; ACL de prod (anon/authenticated/service_role = arwdDxtm, sem attacl);
# RLS ligada com a policy de SELECT de prod. Os DEFAULT PRIVILEGES de função do Supabase entram
# ANTES da migration A: sem eles o REVOKE de anon da RPC seria no-op e o assert nasceria verde.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
ALTER ROLE service_role BYPASSRLS;

CREATE SCHEMA IF NOT EXISTS private;
ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA public  TO authenticated, anon, service_role;

CREATE TABLE public.carteira_teste (cid uuid, dono uuid);
GRANT SELECT ON public.carteira_teste TO authenticated, anon, service_role;

CREATE TABLE public.farmer_client_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL UNIQUE,
  farmer_id uuid NOT NULL,
  rf_score numeric, m_score numeric, g_score numeric, x_score numeric, s_score numeric,
  health_score numeric, health_class text, churn_risk numeric, recover_score numeric,
  expansion_score numeric, eff_score numeric, priority_score numeric,
  days_since_last_purchase integer, avg_repurchase_interval numeric, avg_monthly_spend_180d numeric,
  gross_margin_pct numeric, category_count integer, answer_rate_60d numeric,
  whatsapp_reply_rate_60d numeric, revenue_potential numeric,
  calculated_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  signal_modifiers jsonb, last_signal_recalc_at timestamptz, sales_history_status text,
  itens_com_custo integer, itens_sem_custo integer
);
GRANT ALL ON public.farmer_client_scores TO anon, authenticated, service_role;

-- Capabilities controláveis por GUC (a prod resolve por has_role/commercial_roles/carteira).
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.cap_custo',true),'')::boolean,false) $f$;
CREATE OR REPLACE FUNCTION private.cap_carteira_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.cap_carteira',true),'')::boolean,false) $f$;
CREATE OR REPLACE FUNCTION private.cap_carteira_escrever(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT false $f$;
CREATE OR REPLACE FUNCTION private.carteira_visivel_para(_customer_user_id uuid, _uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS (SELECT 1 FROM public.carteira_teste c
                                             WHERE c.cid=_customer_user_id AND c.dono=_uid) $f$;

-- Policies de prod (pg_get_expr de pg_policy, 2026-10-14).
ALTER TABLE public.farmer_client_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY fcs_select_carteira ON public.farmer_client_scores FOR SELECT
  USING (( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler)
         OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid)));
CREATE POLICY fcs_update_own_or_gestor ON public.farmer_client_scores FOR UPDATE
  USING (( SELECT private.cap_carteira_escrever(( SELECT auth.uid() AS uid)) AS cap_carteira_escrever)
         OR (farmer_id = ( SELECT auth.uid() AS uid)));

-- view security_invoker que NÃO toca a margem (espelha v_carteira_sla): deve sobreviver ao fecho.
CREATE VIEW public.v_carteira_sla_stub WITH (security_invoker = true) AS
  SELECT customer_user_id, farmer_id, health_class, churn_risk, priority_score
    FROM public.farmer_client_scores;
GRANT SELECT ON public.v_carteira_sla_stub TO authenticated, anon;

-- seed: vendedora A (clientes 1, 2) | vendedora B (cliente 3). Margens 12.5 / 40 / 55.
INSERT INTO public.carteira_teste(cid,dono) VALUES
  ('c1000000-0000-0000-0000-000000000001','aa000000-0000-0000-0000-00000000000a'),
  ('c2000000-0000-0000-0000-000000000002','aa000000-0000-0000-0000-00000000000a'),
  ('c3000000-0000-0000-0000-000000000003','bb000000-0000-0000-0000-00000000000b');
INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id, health_score, gross_margin_pct) VALUES
  ('c1000000-0000-0000-0000-000000000001','aa000000-0000-0000-0000-00000000000a', 70, 12.5),
  ('c2000000-0000-0000-0000-000000000002','aa000000-0000-0000-0000-00000000000a', 40, 40),
  ('c3000000-0000-0000-0000-000000000003','bb000000-0000-0000-0000-00000000000b', 55, 55);
SQL

A=aa000000-0000-0000-0000-00000000000a
B=bb000000-0000-0000-0000-00000000000b
C1=c1000000-0000-0000-0000-000000000001
C3=c3000000-0000-0000-0000-000000000003

# como <uid> <cap_custo> <cap_carteira> <sql> — roda como authenticated. `SET ROLE` (não SET LOCAL:
# em autocommit ele não pega e o assert rodaria como superuser — money-path.md).
como() { P -tA -q -c "SET test.uid='$1'; SET test.cap_custo='$2'; SET test.cap_carteira='$3'; SET ROLE authenticated; $4" 2>&1; }
# nega <uid> <cap_custo> <sql> — passa só se o SQL der 42501 (insufficient_privilege). Qualquer outro
# erro é RE-LANÇADO; sucesso devolve a marca de vazamento. Sentinelas ASCII que o Postgres não emite.
nega() {
  P -tA -q 2>&1 <<SQL || true
SET test.uid='$1'; SET test.cap_custo='$2'; SET test.cap_carteira='false'; SET ROLE authenticated;
DO \$neg\$
BEGIN
  BEGIN
    EXECUTE \$q\$ $3 \$q\$;
    RAISE NOTICE 'MARCA_VAZOU_7Q';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE 'MARCA_BARRADO_7Q';
    WHEN OTHERS THEN RAISE;
  END;
END
\$neg\$;
SQL
}
veredito_nega() { case "$1" in *MARCA_BARRADO_7Q*) echo barrado ;; *MARCA_VAZOU_7Q*) echo vazou ;; *) echo "outro: $1" ;; esac; }

# ═════════════════════════ LINHA DE BASE (ACL de prod hoje) ═════════════════════════
echo "-- L. linha de base: o furo existe com o ACL de hoje --"
eq "L1 vendedora A LÊ a margem do cliente dela direto da tabela (o achado)" \
   "$(como $A false false "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE customer_user_id='$C1';")" "12.5"

# ═════════════════════════ MIGRATION A ═════════════════════════
P -q -f "$MIG_A"
echo "migration A aplicada"

asserts_rpc() {
  echo "-- R. RPC get_scores_margem --"
  eq "R1 com cap_custo_ler: número EXATO" \
     "$(como $A true false "SELECT gross_margin_pct||'|'||margem_visivel FROM public.get_scores_margem(ARRAY['$C1']::uuid[]);")" "12.5|true"
  eq "R2 SEM cap_custo_ler: linha presente, número NULL, margem_visivel=false" \
     "$(como $A false false "SELECT coalesce(gross_margin_pct::text,'(null)')||'|'||margem_visivel FROM public.get_scores_margem(ARRAY['$C1']::uuid[]);")" "(null)|false"
  eq "R3 escopo: A vê só os 2 dela" \
     "$(como $A false false "SELECT count(*) FROM public.get_scores_margem();")" "2"
  eq "R3b escopo: A NÃO alcança cliente de B nem pedindo o id" \
     "$(como $A true false "SELECT count(*) FROM public.get_scores_margem(ARRAY['$C3']::uuid[]);")" "0"
  eq "R3c gestor (cap_carteira_ler) vê os 3" \
     "$(como $A false true "SELECT count(*) FROM public.get_scores_margem();")" "3"
  eq "R3d fail-closed: sem uid → 0 mesmo com cap_carteira_ler permissiva" \
     "$(P -tA -q -c "SET test.uid=''; SET test.cap_carteira='true'; SET test.cap_custo='true'; SET ROLE authenticated; SELECT count(*) FROM public.get_scores_margem();" 2>&1)" "0"
  eq "R5 filtro por farmer_id (cluster do plano tático)" \
     "$(como $B true true "SELECT string_agg(gross_margin_pct::text, ',' ORDER BY gross_margin_pct) FROM public.get_scores_margem(NULL, '$A');")" "12.5,40"
  local R4
  R4=$(P -tA -q 2>&1 <<'SQL' || true
SET ROLE anon;
DO $x$ BEGIN
  PERFORM * FROM public.get_scores_margem();
  RAISE NOTICE 'MARCA_VAZOU_7Q';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'MARCA_BARRADO_7Q';
          WHEN OTHERS THEN RAISE;
END $x$;
SQL
)
  eq "R4 anon NÃO executa a RPC (42501)" "$(veredito_nega "$R4")" "barrado"
}
asserts_rpc

# ═════════════════════════ MIGRATION B ═════════════════════════
P -q -f "$MIG_B"
echo "migration B aplicada"

asserts_coluna() {
  echo "-- C. coluna fechada --"
  eq "C1 vendedora: SELECT da margem → 42501" \
     "$(veredito_nega "$(nega $A false "SELECT gross_margin_pct FROM public.farmer_client_scores")")" "barrado"
  eq "C2 master/cap_custo_ler também não lê DIRETO (privilégio é por papel)" \
     "$(veredito_nega "$(nega $A true "SELECT gross_margin_pct FROM public.farmer_client_scores")")" "barrado"
  eq "C3 select * quebra (as telas não podem usá-lo)" \
     "$(veredito_nega "$(nega $A false "SELECT * FROM public.farmer_client_scores")")" "barrado"
  eq "C4 oráculo por FILTRO (WHERE margem > x) → 42501" \
     "$(veredito_nega "$(nega $A false "SELECT count(*) FROM public.farmer_client_scores WHERE gross_margin_pct > 30")")" "barrado"
  eq "C5 oráculo por ORDEM → 42501" \
     "$(veredito_nega "$(nega $A false "SELECT customer_user_id FROM public.farmer_client_scores ORDER BY gross_margin_pct")")" "barrado"
  eq "C6 oráculo por UPDATE ... WHERE margem (a dona pode UPDATE) → 42501" \
     "$(veredito_nega "$(nega $A false "UPDATE public.farmer_client_scores SET health_score = health_score WHERE gross_margin_pct > 30")")" "barrado"
  eq "C7 UPDATE ... RETURNING margem → 42501" \
     "$(veredito_nega "$(nega $A false "UPDATE public.farmer_client_scores SET health_score = health_score WHERE customer_user_id = '$C1' RETURNING gross_margin_pct")")" "barrado"
  local C8
  C8=$(P -tA -q 2>&1 <<'SQL' || true
SET ROLE anon;
DO $x$ BEGIN
  PERFORM customer_user_id FROM public.farmer_client_scores;
  RAISE NOTICE 'MARCA_VAZOU_7Q';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'MARCA_BARRADO_7Q';
          WHEN OTHERS THEN RAISE;
END $x$;
SQL
)
  eq "C8 anon não lê nem as colunas abertas" "$(veredito_nega "$C8")" "barrado"

  echo "-- S. o que tem de seguir funcionando --"
  eq "S1 vendedora lê as 30 colunas restantes da carteira dela (RLS: 2 linhas)" \
     "$(como $A false false "SELECT count(*) FROM (SELECT id, customer_user_id, farmer_id, rf_score, m_score, g_score, x_score, s_score, health_score, health_class, churn_risk, recover_score, expansion_score, eff_score, priority_score, days_since_last_purchase, avg_repurchase_interval, avg_monthly_spend_180d, category_count, answer_rate_60d, whatsapp_reply_rate_60d, revenue_potential, calculated_at, created_at, updated_at, signal_modifiers, last_signal_recalc_at, sales_history_status, itens_com_custo, itens_sem_custo FROM public.farmer_client_scores) t;")" "2"
  # Corolário #1488: o negativo de RLS tem de ser barrado pela POLICY, com o grant presente — numa
  # coluna aberta. Se fosse pela margem, o 42501 do privilégio responderia no lugar da RLS.
  eq "S2 a RLS segue mordendo: A não vê o cliente de B (coluna aberta, 0 linhas)" \
     "$(como $A false false "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='$C3';")" "0"
  eq "S3 a dona segue podendo UPDATE de coluna aberta na linha dela" \
     "$(como $A false false "UPDATE public.farmer_client_scores SET health_score = 71 WHERE customer_user_id='$C1' RETURNING health_score;" | tail -1)" "71"
  eq "S4 view security_invoker sem a margem segue legível" \
     "$(como $A false false "SELECT count(*) FROM public.v_carteira_sla_stub;")" "2"
  eq "S5 service_role (writer) lê a margem" \
     "$(P -tA -q -c "SET ROLE service_role; SELECT gross_margin_pct FROM public.farmer_client_scores WHERE customer_user_id='$C3';" 2>&1)" "55"
  eq "S6 service_role (writer) grava a margem" \
     "$(P -tA -q -c "SET ROLE service_role; UPDATE public.farmer_client_scores SET gross_margin_pct = 56 WHERE customer_user_id='$C3' RETURNING gross_margin_pct;" 2>&1 | head -1)" "56"
  # devolve o seed (S3/S6 escreveram) para a próxima rodada destes asserts medir o mesmo mundo
  P -q -c "UPDATE public.farmer_client_scores SET health_score = 70 WHERE customer_user_id='$C1';" >/dev/null
  P -q -c "UPDATE public.farmer_client_scores SET gross_margin_pct = 55 WHERE customer_user_id='$C3';" >/dev/null
}
asserts_coluna
echo "-- R pós-B: a RPC é a via legítima que sobra --"
asserts_rpc

echo "-- I. idempotência: re-aplicar A e B não erra nem reabre --"
P -q -f "$MIG_A"; P -q -f "$MIG_B"
eq "I1 após re-apply, vendedora segue barrada" \
   "$(veredito_nega "$(nega $A false "SELECT gross_margin_pct FROM public.farmer_client_scores")")" "barrado"

# ═════════════════════════ FALSIFICAÇÃO ═════════════════════════
# Cada sabotagem recria UMA defesa na versão furada, re-roda o assert que a protege e EXIGE vermelho;
# depois restaura reaplicando a migration real. Sabotagem que segue verde = assert sem dente.
echo "-- K. falsificação --"
exige_vermelho() { # <rótulo> <valor obtido> <valor do verde>
  if [ "$2" = "$3" ]; then bad "$1 — SABOTADO e seguiu verde [$2]: assert sem dente"; else ok "$1 — sabotado ficou vermelho [$2]"; fi
}
sabota_a() { # <sed expr> — aplica a migration A com o corpo sabotado
  sed -E "$1" "$MIG_A" > "$RODADA/a-sabotada.sql"
  if cmp -s "$MIG_A" "$RODADA/a-sabotada.sql"; then bad "sabotagem não alterou a migration A ($1)"; fi
  # As postcondições da própria migration gritam com parte das sabotagens; aqui queremos o estado
  # sabotado no banco, então a postcondição sai do arquivo sabotado.
  perl -0pi -e 's/DO \$pos\$.*?\$pos\$;//s' "$RODADA/a-sabotada.sql"
  P -q -f "$RODADA/a-sabotada.sql"
}

# K1 — B furada: o GRANT de tabela volta (o "aperto" revertido por um GRANT colado no SQL Editor).
P -q -c "GRANT SELECT ON public.farmer_client_scores TO authenticated;"
exige_vermelho "K1 GRANT de tabela devolvido → C1" "$(veredito_nega "$(nega $A false "SELECT gross_margin_pct FROM public.farmer_client_scores")")" "barrado"
P -q -f "$MIG_B"
eq "K1r restaurado" "$(veredito_nega "$(nega $A false "SELECT gross_margin_pct FROM public.farmer_client_scores")")" "barrado"

# K2 — B furada por COLUNA: a margem entra na lista do GRANT → C4 (oráculo por filtro).
P -q -c "GRANT SELECT (gross_margin_pct) ON public.farmer_client_scores TO authenticated;"
exige_vermelho "K2 margem na lista do GRANT → C4 filtro" "$(veredito_nega "$(nega $A false "SELECT count(*) FROM public.farmer_client_scores WHERE gross_margin_pct > 30")")" "barrado"
P -q -c "REVOKE SELECT (gross_margin_pct) ON public.farmer_client_scores FROM authenticated;"
eq "K2r restaurado" "$(veredito_nega "$(nega $A false "SELECT count(*) FROM public.farmer_client_scores WHERE gross_margin_pct > 30")")" "barrado"

# K3 — A sem gate de PROJEÇÃO → R2.
sabota_a 's/CASE WHEN v_pode_num THEN s\.gross_margin_pct END/s.gross_margin_pct/'
exige_vermelho "K3 projeção removida → R2" \
  "$(como $A false false "SELECT coalesce(gross_margin_pct::text,'(null)')||'|'||margem_visivel FROM public.get_scores_margem(ARRAY['$C1']::uuid[]);")" "(null)|false"
P -q -f "$MIG_A"

# K4 — A sem escopo de carteira → R3b.
sabota_a 's/AND \(v_cap_todo OR COALESCE\(private\.carteira_visivel_para\(s\.customer_user_id, v_uid\), false\)\)/AND true/'
exige_vermelho "K4 escopo removido → R3b" \
  "$(como $A true false "SELECT count(*) FROM public.get_scores_margem(ARRAY['$C3']::uuid[]);")" "0"
P -q -f "$MIG_A"

# K5 — A sem fail-closed de uid → R3d (com cap_carteira permissiva, só o RETURN defende).
sabota_a 's/^  IF v_uid IS NULL THEN$/  IF false THEN/'
exige_vermelho "K5 fail-closed removido → R3d" \
  "$(P -tA -q -c "SET test.uid=''; SET test.cap_carteira='true'; SET test.cap_custo='true'; SET ROLE authenticated; SELECT count(*) FROM public.get_scores_margem();" 2>&1)" "0"
P -q -f "$MIG_A"

# K6 — A sem REVOKE de anon → R4.
P -q -c "GRANT EXECUTE ON FUNCTION public.get_scores_margem(uuid[], uuid) TO anon;"
K6=$(P -tA -q 2>&1 <<'SQL' || true
SET ROLE anon;
DO $x$ BEGIN
  PERFORM * FROM public.get_scores_margem();
  RAISE NOTICE 'MARCA_VAZOU_7Q';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'MARCA_BARRADO_7Q';
          WHEN OTHERS THEN RAISE;
END $x$;
SQL
)
exige_vermelho "K6 anon com EXECUTE → R4" "$(veredito_nega "$K6")" "barrado"
P -q -f "$MIG_A"

# K7 — policy de SELECT aberta → S2. Prova que o negativo de RLS é da POLICY, não do privilégio.
P -q -c "ALTER POLICY fcs_select_carteira ON public.farmer_client_scores USING (true);"
exige_vermelho "K7 policy aberta → S2" \
  "$(como $A false false "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='$C3';")" "0"
P -q -c "ALTER POLICY fcs_select_carteira ON public.farmer_client_scores USING (( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid)));"

echo "-- pós-falsificação: tudo restaurado volta verde --"
asserts_rpc
asserts_coluna

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
