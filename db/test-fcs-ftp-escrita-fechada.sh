#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Prova PG17 do fecho da ESCRITA default em farmer_client_scores e            ║
# ║  farmer_tactical_plans (pós-B do #3072/#3084)                                 ║
# ║    bash db/test-fcs-ftp-escrita-fechada.sh > log 2>&1; echo $?                ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                               ║
# ║  Aplica as migrations REAIS de fcs na ordem de prod (A 20261014120000,        ║
# ║  B 20261014120100) e depois a desta prova (20261018160000). ftp entra com o   ║
# ║  ACL pós-B medido em prod (Dxtm + SELECT por coluna).                         ║
# ║                                                                               ║
# ║  O que prova:                                                                 ║
# ║   · LINHA DE BASE: com o ACL de prod de hoje a dona grava a margem e qualquer ║
# ║     authenticated dá TRUNCATE nas duas tabelas (os achados)                   ║
# ║   · FECHO: INSERT/UPDATE/DELETE/TRUNCATE barrados (dona, gestor, anon); o     ║
# ║     UPDATE da coluna da trava é barrado pela RLS (WITH CHECK false)            ║
# ║   · O QUE SEGUE: a trava FOR SHARE das RPCs invoker de recomendação trava as  ║
# ║     linhas do escopo (e BLOQUEIA a troca de dono concorrente); leitura das     ║
# ║     colunas abertas; margem segue fechada; service_role e SECURITY DEFINER     ║
# ║     seguem gravando                                                           ║
# ║   · FALSIFICAÇÃO: cada camada sabotada sozinha, exigindo o vermelho CERTO     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5537}"
SLUG="fcsftpescrita"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"
export LC_ALL="${LC_ALL_TESTE:-C}" LANG="${LC_ALL_TESTE:-C}"

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
MIG="$REPO_ROOT/supabase/migrations/20261018160000_fcs_ftp_fecha_escrita_default.sql"

# ── ZONA 1: stubs espelhando a PROD (psql-ro, 2026-10-18, após o apply das B) ──
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

-- 31 colunas na ordem de prod; ACL default do Supabase ANTES das B (as B reais entram depois).
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

CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.cap_custo',true),'')::boolean,false) $f$;
CREATE OR REPLACE FUNCTION private.cap_carteira_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.cap_carteira',true),'')::boolean,false) $f$;
CREATE OR REPLACE FUNCTION private.cap_carteira_escrever(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.cap_escrever',true),'')::boolean,false) $f$;
CREATE OR REPLACE FUNCTION private.carteira_visivel_para(_customer_user_id uuid, _uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS (SELECT 1 FROM public.carteira_teste c
                                             WHERE c.cid=_customer_user_id AND c.dono=_uid) $f$;

-- As 4 policies de prod (pg_policies, 2026-10-18), verbatim.
ALTER TABLE public.farmer_client_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY fcs_select_carteira ON public.farmer_client_scores FOR SELECT
  USING (( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler)
         OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid)));
CREATE POLICY fcs_insert_own_or_gestor ON public.farmer_client_scores FOR INSERT
  WITH CHECK (( SELECT private.cap_carteira_escrever(( SELECT auth.uid() AS uid)) AS cap_carteira_escrever)
              OR (farmer_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY fcs_update_own_or_gestor ON public.farmer_client_scores FOR UPDATE
  USING (( SELECT private.cap_carteira_escrever(( SELECT auth.uid() AS uid)) AS cap_carteira_escrever)
         OR (farmer_id = ( SELECT auth.uid() AS uid)))
  WITH CHECK (( SELECT private.cap_carteira_escrever(( SELECT auth.uid() AS uid)) AS cap_carteira_escrever)
              OR (farmer_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY fcs_delete_own_or_gestor ON public.farmer_client_scores FOR DELETE
  USING (( SELECT private.cap_carteira_escrever(( SELECT auth.uid() AS uid)) AS cap_carteira_escrever)
         OR (farmer_id = ( SELECT auth.uid() AS uid)));

-- farmer_tactical_plans: colunas que a prova usa; ACL PÓS-B de prod (anon/authenticated = Dxtm +
-- SELECT por coluna nas não-margem; service_role = rDxtm), RLS com a policy de SELECT staff.
CREATE TABLE public.farmer_tactical_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL, customer_user_id uuid NOT NULL,
  current_margin_pct numeric, status text DEFAULT 'pending', notes text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
GRANT ALL ON public.farmer_tactical_plans TO anon, authenticated, service_role;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.farmer_tactical_plans FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.farmer_tactical_plans FROM service_role;
GRANT SELECT (id, farmer_id, customer_user_id, status, notes, created_at, updated_at)
  ON public.farmer_tactical_plans TO authenticated;
ALTER TABLE public.farmer_tactical_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY tactical_plans_select_staff ON public.farmer_tactical_plans FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Writer de ftp: RPC SECURITY DEFINER (dono postgres) — espelha criar_plano_tatico.
CREATE FUNCTION public.criar_plano_stub(p_cliente uuid) RETURNS uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $f$
  INSERT INTO public.farmer_tactical_plans(farmer_id, customer_user_id)
  VALUES (auth.uid(), p_cliente) RETURNING id $f$;

-- A trava do bloco 6-ter de farmer_recomendacoes_substituir / farmer_bundle_recomendacoes_substituir
-- (pg_get_functiondef de prod, 2026-10-18): SECURITY INVOKER, o MESMO statement FOR SHARE. Devolve
-- quantas linhas de score o FOR SHARE devolveu — cada linha devolvida é uma linha travada.
CREATE FUNCTION public.trava_scores_stub(p_clientes uuid[]) RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $f$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM (
    SELECT 1
      FROM public.farmer_client_scores s
     WHERE s.customer_user_id IN (SELECT DISTINCT c FROM unnest(p_clientes) c WHERE c IS NOT NULL)
     ORDER BY s.customer_user_id
       FOR SHARE
  ) t;
  RETURN v_n;
END $f$;

-- seed: vendedora A (clientes 1, 2) | vendedora B (cliente 3).
INSERT INTO public.carteira_teste(cid,dono) VALUES
  ('c1000000-0000-0000-0000-000000000001','aa000000-0000-0000-0000-00000000000a'),
  ('c2000000-0000-0000-0000-000000000002','aa000000-0000-0000-0000-00000000000a'),
  ('c3000000-0000-0000-0000-000000000003','bb000000-0000-0000-0000-00000000000b');
INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id, health_score, gross_margin_pct) VALUES
  ('c1000000-0000-0000-0000-000000000001','aa000000-0000-0000-0000-00000000000a', 70, 12.5),
  ('c2000000-0000-0000-0000-000000000002','aa000000-0000-0000-0000-00000000000a', 40, 40),
  ('c3000000-0000-0000-0000-000000000003','bb000000-0000-0000-0000-00000000000b', 55, 55);
INSERT INTO public.farmer_tactical_plans(farmer_id, customer_user_id, current_margin_pct) VALUES
  ('aa000000-0000-0000-0000-00000000000a','c1000000-0000-0000-0000-000000000001', 12.5);
SQL

# As B REAIS de fcs (o ACL pós-B de prod sai delas, não de mão).
P -q -f "$MIG_A"; P -q -f "$MIG_B"

A=aa000000-0000-0000-0000-00000000000a
B=bb000000-0000-0000-0000-00000000000b
C1=c1000000-0000-0000-0000-000000000001
C2=c2000000-0000-0000-0000-000000000002
C3=c3000000-0000-0000-0000-000000000003

# tenta <role> <uid> <gestor> <sql> — executa o SQL como <role> numa transação que SEMPRE volta
# (BEGIN … ROLLBACK: TRUNCATE/DELETE não estragam o seed). <gestor>=true liga cap_carteira_escrever E
# cap_carteira_ler (o gestor de prod tem as duas). Barrado só com 42501; outro erro RE-LANÇA. DML que
# não alcança linha nenhuma sai VAZIO, nunca "passou" — senão um UPDATE de 0 linhas (RLS escondendo a
# linha) pintaria a escrita de possível ou de barrada sem ter tocado nada. Sentinelas ASCII que nem o
# Postgres nem a migration emitem.
tenta() {
  P -tA -q 2>&1 <<SQL || true
BEGIN;
SET LOCAL test.uid='$2'; SET LOCAL test.cap_escrever='$3'; SET LOCAL test.cap_carteira='$3'; SET LOCAL ROLE $1;
DO \$neg\$
DECLARE n bigint;
BEGIN
  BEGIN
    EXECUTE \$q\$ $4 \$q\$;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 AND \$q\$ $4 \$q\$ !~* '^[[:space:]]*TRUNCATE' THEN
      RAISE NOTICE 'MARCA_VAZIO_4K';
    ELSE
      RAISE NOTICE 'MARCA_PASSOU_4K';
    END IF;
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE 'MARCA_BARRADO_4K';
    WHEN OTHERS THEN RAISE;
  END;
END
\$neg\$;
ROLLBACK;
SQL
}
v() { case "$1" in *MARCA_BARRADO_4K*) echo barrado ;; *MARCA_PASSOU_4K*) echo passou ;; *MARCA_VAZIO_4K*) echo vazio ;; *) echo "outro: $1" ;; esac; }
# trava <uid> <cap_escrever> <clientes> — quantas linhas a trava FOR SHARE devolve como authenticated,
# ou "barrado" se o próprio FOR SHARE der 42501 (sem privilégio UPDATE nenhum).
trava() {
  local out
  out=$(P -tA -q 2>&1 <<SQL || true
SET test.uid='$1'; SET test.cap_escrever='$2'; SET ROLE authenticated;
DO \$t\$
DECLARE n integer;
BEGIN
  n := public.trava_scores_stub(ARRAY[$3]::uuid[]);
  RAISE NOTICE 'MARCA_TRAVOU_%', n;
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'MARCA_BARRADO_4K';
  WHEN OTHERS THEN RAISE;
END \$t\$;
SQL
)
  case "$out" in *MARCA_TRAVOU_*) echo "$out" | sed -nE 's/.*MARCA_TRAVOU_([0-9]+).*/\1/p' | head -1 ;;
                 *MARCA_BARRADO_4K*) echo barrado ;; *) echo "outro: $out" ;; esac
}
# corrida — a sessão 1 (vendedora A) segura a trava FOR SHARE de C1; a sessão 2 (service_role, o
# caminho da troca de dono) tenta trocar o dono de C1 com lock_timeout. Esperado: ESPEROU (55P03).
corrida() {
  PGAPPNAME=trava_bg "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -q -v ON_ERROR_STOP=1 \
    -c "BEGIN; SET LOCAL test.uid='$A'; SET LOCAL ROLE authenticated; SELECT public.trava_scores_stub(ARRAY['$C1']::uuid[]); SELECT pg_sleep(3); COMMIT;" \
    > "$RODADA/bg.log" 2>&1 &
  local bg=$! i=0
  while [ "$i" -lt 50 ]; do
    [ "$(P -tA -q -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='trava_bg' AND wait_event='PgSleep';")" = "1" ] && break
    sleep 0.1; i=$((i+1))
  done
  local out
  out=$(P -tA -q 2>&1 <<SQL || true
SET lock_timeout = '400ms'; SET ROLE service_role;
DO \$c\$
BEGIN
  UPDATE public.farmer_client_scores SET farmer_id = '$B' WHERE customer_user_id = '$C1';
  RAISE NOTICE 'MARCA_PASSOU_4K';
EXCEPTION
  WHEN lock_not_available THEN RAISE NOTICE 'MARCA_ESPEROU_4K';
  WHEN OTHERS THEN RAISE;
END \$c\$;
SQL
)
  wait "$bg" || true
  P -q -c "UPDATE public.farmer_client_scores SET farmer_id = '$A' WHERE customer_user_id = '$C1';" >/dev/null
  if [ "$i" -ge 50 ]; then echo "outro: sessao 1 nunca chegou ao pg_sleep: $(cat "$RODADA/bg.log")"; return; fi
  case "$out" in *MARCA_ESPEROU_4K*) echo esperou ;; *MARCA_PASSOU_4K*) echo passou ;; *) echo "outro: $out" ;; esac
}

# ═════════════════════════ LINHA DE BASE (ACL de prod hoje) ═════════════════════════
echo "-- L. linha de base: os achados existem com o ACL pós-B de hoje --"
eq "L1 a dona GRAVA a margem da própria linha (escrita cega)" \
   "$(v "$(tenta authenticated $A false "UPDATE public.farmer_client_scores SET gross_margin_pct = 99 WHERE customer_user_id = '$C1'")")" "passou"
eq "L2 authenticated dá TRUNCATE em farmer_client_scores (sem RLS)" \
   "$(v "$(tenta authenticated $A false "TRUNCATE public.farmer_client_scores")")" "passou"
eq "L3 authenticated dá TRUNCATE em farmer_tactical_plans" \
   "$(v "$(tenta authenticated $A false "TRUNCATE public.farmer_tactical_plans")")" "passou"
eq "L4 a trava FOR SHARE da RPC de recomendação funciona hoje (2 linhas de A)" \
   "$(trava $A false "'$C1','$C2'")" "2"

# ═════════════════════════ MIGRATION ═════════════════════════
P -q -f "$MIG"
echo "migration 20261018160000 aplicada"

asserts_fecho() {
  echo "-- E. escrita fechada --"
  eq "E1 dona: UPDATE da margem → 42501" \
     "$(v "$(tenta authenticated $A false "UPDATE public.farmer_client_scores SET gross_margin_pct = 99 WHERE customer_user_id = '$C1'")")" "barrado"
  eq "E2 dona: UPDATE da coluna da trava (updated_at) → 42501 pela RLS (WITH CHECK false)" \
     "$(v "$(tenta authenticated $A false "UPDATE public.farmer_client_scores SET updated_at = now() WHERE customer_user_id = '$C1'")")" "barrado"
  eq "E3 gestor (cap_carteira_escrever): UPDATE de updated_at → 42501" \
     "$(v "$(tenta authenticated $A true "UPDATE public.farmer_client_scores SET updated_at = now() WHERE customer_user_id = '$C3'")")" "barrado"
  eq "E4 dona: INSERT da própria linha → 42501" \
     "$(v "$(tenta authenticated $A false "INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id) VALUES (gen_random_uuid(), '$A')")")" "barrado"
  eq "E5 dona: DELETE da própria linha → 42501" \
     "$(v "$(tenta authenticated $A false "DELETE FROM public.farmer_client_scores WHERE customer_user_id = '$C1'")")" "barrado"
  eq "E6 authenticated: TRUNCATE fcs → 42501" \
     "$(v "$(tenta authenticated $A false "TRUNCATE public.farmer_client_scores")")" "barrado"
  eq "E7 authenticated: TRUNCATE ftp → 42501" \
     "$(v "$(tenta authenticated $A false "TRUNCATE public.farmer_tactical_plans")")" "barrado"
  eq "E8 anon: TRUNCATE fcs → 42501" "$(v "$(tenta anon '' false "TRUNCATE public.farmer_client_scores")")" "barrado"
  eq "E9 anon: TRUNCATE ftp → 42501" "$(v "$(tenta anon '' false "TRUNCATE public.farmer_tactical_plans")")" "barrado"
  eq "E10 anon: UPDATE fcs → 42501" \
     "$(v "$(tenta anon '' false "UPDATE public.farmer_client_scores SET updated_at = now()")")" "barrado"
  eq "E11 authenticated: UPDATE ftp → 42501" \
     "$(v "$(tenta authenticated $A false "UPDATE public.farmer_tactical_plans SET notes = 'x'")")" "barrado"
  eq "E12 matriz de catálogo: 0 privilégio de TABELA de escrita para anon/authenticated nas 2 tabelas" \
     "$(P -tA -q -c "SELECT count(*) FROM unnest(ARRAY['public.farmer_client_scores','public.farmer_tactical_plans']) t, unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p WHERE has_table_privilege(r, t, p);")" "0"

  echo "-- S. o que tem de seguir funcionando --"
  eq "S1 trava FOR SHARE da RPC de recomendação: trava as 2 linhas de A" "$(trava $A false "'$C1','$C2'")" "2"
  eq "S2 a trava respeita o escopo: A não trava o cliente de B" "$(trava $A false "'$C3'")" "0"
  eq "S3 a trava BLOQUEIA a troca de dono concorrente (lock causal do 6-ter)" "$(corrida)" "esperou"
  eq "S4 vendedora lê as colunas abertas da carteira dela (2 linhas)" \
     "$(P -tA -q -c "SET test.uid='$A'; SET ROLE authenticated; SELECT count(*) FROM (SELECT customer_user_id, health_score, updated_at FROM public.farmer_client_scores) t;" 2>&1)" "2"
  eq "S5 a margem segue fechada para leitura (B intacta)" \
     "$(v "$(tenta authenticated $A false "SELECT gross_margin_pct FROM public.farmer_client_scores")")" "barrado"
  eq "S6 service_role (calculate-scores/scoring-recalc-client) grava a margem" \
     "$(P -tA -q -c "SET ROLE service_role; UPDATE public.farmer_client_scores SET gross_margin_pct = 56 WHERE customer_user_id='$C3' RETURNING gross_margin_pct;" 2>&1 | head -1)" "56"
  P -q -c "UPDATE public.farmer_client_scores SET gross_margin_pct = 55 WHERE customer_user_id='$C3';" >/dev/null
  eq "S7 service_role insere e apaga score" \
     "$(P -tA -q -c "SET ROLE service_role; WITH i AS (INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id) VALUES ('c9000000-0000-0000-0000-000000000009', '$B') RETURNING customer_user_id) SELECT count(*) FROM i;" -c "SET ROLE service_role; WITH d AS (DELETE FROM public.farmer_client_scores WHERE customer_user_id='c9000000-0000-0000-0000-000000000009' RETURNING 1) SELECT count(*) FROM d;" 2>&1 | tr '\n' ',')" "1,1,"
  eq "S8 RPC SECURITY DEFINER (criar_plano_tatico) segue criando plano como authenticated" \
     "$(P -tA -q -c "SET test.uid='$A'; SET ROLE authenticated; SELECT public.criar_plano_stub('$C2') IS NOT NULL;" 2>&1)" "t"
  P -q -c "DELETE FROM public.farmer_tactical_plans WHERE customer_user_id='$C2';" >/dev/null
}
asserts_fecho

echo "-- I. idempotência: re-aplicar não erra nem reabre --"
P -q -f "$MIG"
eq "I1 após re-apply a dona segue barrada na margem" \
   "$(v "$(tenta authenticated $A false "UPDATE public.farmer_client_scores SET gross_margin_pct = 99 WHERE customer_user_id = '$C1'")")" "barrado"
eq "I2 após re-apply a trava segue funcionando" "$(trava $A false "'$C1','$C2'")" "2"

# ═════════════════════════ FALSIFICAÇÃO ═════════════════════════
# Uma camada por vez; cada sabotagem exige o vermelho CERTO (não "qualquer coisa ≠ verde") e é
# restaurada reaplicando a migration real.
echo "-- K. falsificação --"
exige_vermelho() { # <rótulo> <obtido> <verde> <vermelho esperado>
  if [ "$2" = "$3" ]; then bad "$1 — SABOTADO e seguiu verde [$2]: assert sem dente"
  elif [ "$2" = "$4" ]; then ok "$1 — sabotado ficou vermelho [$2]"
  else bad "$1 — sabotagem deu resultado inesperado [$2], esperava o vermelho [$4]"; fi
}
WC_ORIG="(( SELECT private.cap_carteira_escrever(( SELECT auth.uid() AS uid)) AS cap_carteira_escrever) OR (farmer_id = ( SELECT auth.uid() AS uid)))"

# K1 — WITH CHECK volta ao own-or-gestor → E2 (o único que guarda a coluna da trava).
P -q -c "ALTER POLICY fcs_update_own_or_gestor ON public.farmer_client_scores WITH CHECK $WC_ORIG;"
exige_vermelho "K1 WITH CHECK original → E2" \
  "$(v "$(tenta authenticated $A false "UPDATE public.farmer_client_scores SET updated_at = now() WHERE customer_user_id = '$C1'")")" "barrado" "passou"
exige_vermelho "K1b WITH CHECK original → E3 (gestor grava linha alheia)" \
  "$(v "$(tenta authenticated $A true "UPDATE public.farmer_client_scores SET updated_at = now() WHERE customer_user_id = '$C3'")")" "barrado" "passou"
P -q -f "$MIG"

# K2a — só o GRANT UPDATE de tabela devolvido (o default da plataforma reemitido): E1 fica VERDE —
# a RLS (WITH CHECK false) é a 2ª camada. Documenta a profundidade; não é falha.
P -q -c "GRANT UPDATE ON public.farmer_client_scores TO authenticated;"
eq "K2a GRANT UPDATE devolvido sozinho: E1 segue barrado pela RLS (camada 2)" \
  "$(v "$(tenta authenticated $A false "UPDATE public.farmer_client_scores SET gross_margin_pct = 99 WHERE customer_user_id = '$C1'")")" "barrado"
# K2b — GRANT de tabela + WITH CHECK original → E1 vaza: as duas camadas juntas são o dente.
P -q -c "ALTER POLICY fcs_update_own_or_gestor ON public.farmer_client_scores WITH CHECK $WC_ORIG;"
exige_vermelho "K2b GRANT UPDATE + WITH CHECK original → E1" \
  "$(v "$(tenta authenticated $A false "UPDATE public.farmer_client_scores SET gross_margin_pct = 99 WHERE customer_user_id = '$C1'")")" "barrado" "passou"
P -q -f "$MIG"

# K3 — sem o REVOKE de TRUNCATE em fcs → E6; em ftp → E7; anon → E8.
P -q -c "GRANT TRUNCATE ON public.farmer_client_scores TO authenticated;"
exige_vermelho "K3 TRUNCATE fcs devolvido → E6" "$(v "$(tenta authenticated $A false "TRUNCATE public.farmer_client_scores")")" "barrado" "passou"
P -q -f "$MIG"
P -q -c "GRANT TRUNCATE ON public.farmer_tactical_plans TO authenticated;"
exige_vermelho "K4 TRUNCATE ftp devolvido → E7" "$(v "$(tenta authenticated $A false "TRUNCATE public.farmer_tactical_plans")")" "barrado" "passou"
P -q -f "$MIG"
P -q -c "GRANT TRUNCATE ON public.farmer_client_scores TO anon;"
exige_vermelho "K5 TRUNCATE fcs devolvido a anon → E8" "$(v "$(tenta anon '' false "TRUNCATE public.farmer_client_scores")")" "barrado" "passou"
P -q -f "$MIG"

# K6 — sem o REVOKE de INSERT → E4 (a policy de INSERT segue viva: o privilégio é a ÚNICA camada).
P -q -c "GRANT INSERT ON public.farmer_client_scores TO authenticated;"
exige_vermelho "K6 INSERT devolvido → E4" \
  "$(v "$(tenta authenticated $A false "INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id) VALUES (gen_random_uuid(), '$A')")")" "barrado" "passou"
P -q -f "$MIG"

# K7 — sem o REVOKE de DELETE → E5.
P -q -c "GRANT DELETE ON public.farmer_client_scores TO authenticated;"
exige_vermelho "K7 DELETE devolvido → E5" \
  "$(v "$(tenta authenticated $A false "DELETE FROM public.farmer_client_scores WHERE customer_user_id = '$C1'")")" "barrado" "passou"
P -q -f "$MIG"

# K8 — por que NÃO revogar o UPDATE inteiro: sem o GRANT UPDATE (updated_at), o FOR SHARE dá 42501
# → S1 quebra (a geração de recomendações quebraria em prod).
P -q -c "REVOKE UPDATE (updated_at) ON public.farmer_client_scores FROM authenticated;"
exige_vermelho "K8 sem UPDATE de coluna nenhuma → S1" "$(trava $A false "'$C1','$C2'")" "2" "barrado"
P -q -f "$MIG"

# K9 — por que NÃO dropar a policy: sem ela o FOR SHARE devolve 0 linhas, sem erro → S1 e S3 (a troca
# de dono concorrente passa: o lock causal vira no-op silencioso).
P -q -c "DROP POLICY fcs_update_own_or_gestor ON public.farmer_client_scores;"
exige_vermelho "K9 policy de UPDATE dropada → S1 (trava vazia)" "$(trava $A false "'$C1','$C2'")" "2" "0"
exige_vermelho "K9b policy de UPDATE dropada → S3 (troca de dono não espera)" "$(corrida)" "esperou" "passou"
P -q -c "CREATE POLICY fcs_update_own_or_gestor ON public.farmer_client_scores FOR UPDATE USING $WC_ORIG WITH CHECK $WC_ORIG;"
P -q -f "$MIG"

# K10 — a PRE morde: sem a policy a migration ABORTA (não roda o REVOKE às cegas).
P -q -c "ALTER POLICY fcs_update_own_or_gestor ON public.farmer_client_scores RENAME TO fcs_upd_tmp;"
K10=$(P -q -f "$MIG" 2>&1 || true)
case "$K10" in *"PRE FALHOU: policy fcs_update_own_or_gestor"*) ok "K10 PRE aborta sem a policy da trava" ;;
               *) bad "K10 PRE não abortou sem a policy: [$K10]" ;; esac
P -q -c "ALTER POLICY fcs_upd_tmp ON public.farmer_client_scores RENAME TO fcs_update_own_or_gestor;"

# K11 — a POS morde: com o GRANT da trava trocado por outra coluna, a postcondição aborta.
P -q -c "GRANT UPDATE (gross_margin_pct) ON public.farmer_client_scores TO authenticated;"
K11=$(sed -E 's/^GRANT UPDATE \(updated_at\)/GRANT UPDATE (updated_at, gross_margin_pct)/' "$MIG" > "$RODADA/mig-sab.sql"; P -q -f "$RODADA/mig-sab.sql" 2>&1 || true)
case "$K11" in *"POS4 FALHOU"*) ok "K11 POS aborta com UPDATE em coluna além da trava" ;;
               *) bad "K11 POS não abortou: [$K11]" ;; esac
P -q -f "$MIG"

echo "-- pós-falsificação: tudo restaurado volta verde --"
asserts_fecho

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
