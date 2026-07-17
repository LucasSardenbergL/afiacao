#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — restaurar security_invoker=on em 5 views (fix de SEGURANÇA)          ║
# ║  bash db/test-security-invoker-views.sh > /tmp/t.log 2>&1; echo "exit=$?"     ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                      ║
# ║                                                                               ║
# ║  Lei de Ferro:                                                                ║
# ║   1. Aplica a migration REAL (psql -f). Os PRÉ-REQUISITOS (tabela+RLS+views)  ║
# ║      são stubs fiéis: o snapshot NÃO é restore-ready (124 erros de ordem de   ║
# ║      dependência; nem chega a criar 2 das 5 views).                           ║
# ║   2. Assert negativo captura a condição esperada; nada de WHEN OTHERS mudo.   ║
# ║   3. Falsificação: desfaz o fix → exige VERMELHO → restaura.                  ║
# ║                                                                               ║
# ║  ⚠️ ESCOPO HONESTO (corrigido após o merge do #1375):                         ║
# ║  os stubs abaixo fazem cada view ler a TABELA direto. Isso é fiel APENAS      ║
# ║  para v_sku_sla_compliance (na prod: `FROM sku_parametros` + LEFT JOINs)      ║
# ║  — a única das 5 que vazava de verdade, e a que tem grant `anon`.             ║
# ║  As outras 4 partem de um `FROM` que já é view `on` (v_sku_parametros_        ║
# ║  sugeridos / v_venda_items_history_efetivo), que devolve 0 ao customer e      ║
# ║  colapsa os INNER JOINs ⇒ elas NÃO vazavam; ligar o invoker nelas foi         ║
# ║  defense-in-depth. A seção 6 prova essa regra — é o que faltava aqui.         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="secinvoker"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
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
# ZONA 1 — PRÉ-REQUISITOS: reproduz o estado de PROD (medido via psql-ro 2026-07-16)
#   • app_role/has_role: assinatura real -> has_role(_user_id uuid, _role app_role)
#   • tabela-base com RLS staff-only, idêntica em forma à policy real de
#     sku_leadtime_history: has_role(uid,'master') OR has_role(uid,'employee')
#   • as 5 views: owner=postgres, SEM gate próprio no corpo, e SEM security_invoker
#     (é exatamente o estado regredido da prod)
#   • grants conforme a relacl real: anon tem SELECT só em v_sku_sla_compliance;
#     authenticated tem SELECT nas 5.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE app_role AS ENUM ('master','employee','customer');

CREATE TABLE user_roles (user_id uuid NOT NULL, role app_role NOT NULL);

CREATE FUNCTION has_role(_user_id uuid, _role app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = _user_id AND ur.role = _role)
$f$;

-- tabela-base: dado INTERNO de reposição, protegido por RLS staff-only.
CREATE TABLE sku_leadtime_history (
  id bigserial PRIMARY KEY,
  empresa text,
  sku_codigo_omie text,
  fornecedor_nome text,
  lt_bruto_dias_uteis int
);
ALTER TABLE sku_leadtime_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_sku_leadtime_history_all ON sku_leadtime_history
  FOR ALL TO authenticated
  USING ( (SELECT has_role((SELECT auth.uid()), 'master') OR has_role((SELECT auth.uid()), 'employee')) );
CREATE POLICY service_all_sku_leadtime_history ON sku_leadtime_history
  FOR ALL TO service_role USING (true);

-- As 5 views, como estão HOJE na prod: sem WITH (security_invoker) e sem gate no corpo.
CREATE VIEW v_sku_sla_compliance AS
  SELECT empresa, sku_codigo_omie, fornecedor_nome, avg(lt_bruto_dias_uteis) AS lt_medio
  FROM sku_leadtime_history GROUP BY 1,2,3;
CREATE VIEW v_sku_candidatos_primeira_compra AS
  SELECT empresa, sku_codigo_omie, fornecedor_nome FROM sku_leadtime_history;
CREATE VIEW v_sku_demanda_estatisticas AS
  SELECT empresa, sku_codigo_omie, count(*) AS n FROM sku_leadtime_history GROUP BY 1,2;
CREATE VIEW v_sku_demanda_rajada AS
  SELECT empresa, sku_codigo_omie, max(lt_bruto_dias_uteis) AS pico FROM sku_leadtime_history GROUP BY 1,2;
CREATE VIEW v_sku_sigma_demanda AS
  SELECT empresa, sku_codigo_omie, stddev_samp(lt_bruto_dias_uteis) AS sigma FROM sku_leadtime_history GROUP BY 1,2;

-- grants conforme relacl real da prod
GRANT SELECT ON v_sku_sla_compliance TO anon, authenticated;          -- anon=ar... (tem r)
GRANT SELECT ON v_sku_candidatos_primeira_compra TO authenticated;    -- anon=aw... (sem r)
GRANT SELECT ON v_sku_demanda_estatisticas       TO authenticated;
GRANT SELECT ON v_sku_demanda_rajada             TO authenticated;
GRANT SELECT ON v_sku_sigma_demanda              TO authenticated;
-- ⚠️ FIEL À PROD: anon E authenticated TÊM GRANT SELECT na tabela-base (medido via
-- psql-ro: has_table_privilege('anon','sku_leadtime_history','SELECT') = true). Quem barra
-- o anon é o RLS — a policy é `TO authenticated`, então o anon não casa nenhuma e leva 0
-- linhas. Sem este grant o stub daria "permission denied" e o teste provaria uma negação
-- (falta de grant) que NÃO é a que roda em produção (RLS). É a lição do CLAUDE.md:
-- "REVOKE FROM PUBLIC não tira anon/authenticated".
GRANT SELECT ON sku_leadtime_history TO authenticated, anon;
-- BYPASSRLS não dispensa GRANT: sem isto o seed abaixo dá "permission denied".
GRANT ALL ON sku_leadtime_history TO service_role;
GRANT ALL ON SEQUENCE sku_leadtime_history_id_seq TO service_role;
GRANT SELECT ON user_roles TO authenticated, anon;

INSERT INTO user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','customer'),
  ('22222222-2222-2222-2222-222222222222','employee');
SQL

# seed do dado sensível (como service_role, que tem BYPASSRLS)
P -q <<'SQL'
SET ROLE service_role;
INSERT INTO sku_leadtime_history(empresa, sku_codigo_omie, fornecedor_nome, lt_bruto_dias_uteis)
VALUES ('OBEN','SKU-1','FORNECEDOR CONFIDENCIAL',10),
       ('OBEN','SKU-1','FORNECEDOR CONFIDENCIAL',20);
RESET ROLE;
SQL

# Helpers de impersonação.
# ⚠️ SET LOCAL SÓ vale dentro de transação — fora dela o Postgres emite apenas um WARNING
# e SEGUE COMO SUPERUSER. Sem o BEGIN/COMMIT o teste inteiro mede a leitura do postgres e
# pinta verde por acidente (mordeu ao escrever este harness: as falsificações "passaram"
# comparando a string "SET\nSET\n1" com "1"). Daí o BEGIN + o filtro numérico estrito.
_conta() {  # $1 = SQL de identidade, $2 = view
  P -tAq <<SQL 2>/dev/null | grep -E '^[0-9]+$' | tail -1
BEGIN;
$1
SELECT count(*) FROM $2;
COMMIT;
SQL
}
como_customer() { _conta "SET LOCAL ROLE authenticated; SET LOCAL test.uid = '11111111-1111-1111-1111-111111111111';" "$1"; }
como_staff()    { _conta "SET LOCAL ROLE authenticated; SET LOCAL test.uid = '22222222-2222-2222-2222-222222222222';" "$1"; }
como_anon()     { _conta "SET LOCAL ROLE anon;" "$1"; }

echo ""
echo "═══ 1. O BUG reproduzido (estado atual da PROD: invoker OFF) ═══"
# Se estes derem 0, o cenário não reproduz o bug e todo o resto é teatro.
eq "customer LÊ v_sku_sla_compliance (vazamento)"             "$(como_customer v_sku_sla_compliance)"             "1"
eq "customer LÊ v_sku_candidatos_primeira_compra (vazamento)" "$(como_customer v_sku_candidatos_primeira_compra)" "2"
eq "customer LÊ v_sku_demanda_estatisticas (vazamento)"       "$(como_customer v_sku_demanda_estatisticas)"       "1"
eq "customer LÊ v_sku_demanda_rajada (vazamento)"             "$(como_customer v_sku_demanda_rajada)"             "1"
eq "customer LÊ v_sku_sigma_demanda (vazamento)"              "$(como_customer v_sku_sigma_demanda)"              "1"
eq "anon LÊ v_sku_sla_compliance SEM LOGIN (vazamento)"       "$(como_anon v_sku_sla_compliance)"                 "1"
# contraprova de que o RLS existe e morde quando aplicado:
eq "customer NÃO lê a tabela-base direto (RLS ativo)"         "$(como_customer sku_leadtime_history)"             "0"

echo ""
echo "═══ 2. Aplicando a migration REAL (Lei #1) ═══"
P -q -f "$REPO_ROOT/supabase/migrations/20260717015000_restaurar_security_invoker_views.sql"
echo "  migration aplicada"

echo ""
echo "═══ 3. O FIX: o vazamento fecha, o staff continua trabalhando ═══"
eq "customer NÃO lê v_sku_sla_compliance"             "$(como_customer v_sku_sla_compliance)"             "0"
eq "customer NÃO lê v_sku_candidatos_primeira_compra" "$(como_customer v_sku_candidatos_primeira_compra)" "0"
eq "customer NÃO lê v_sku_demanda_estatisticas"       "$(como_customer v_sku_demanda_estatisticas)"       "0"
eq "customer NÃO lê v_sku_demanda_rajada"             "$(como_customer v_sku_demanda_rajada)"             "0"
eq "customer NÃO lê v_sku_sigma_demanda"              "$(como_customer v_sku_sigma_demanda)"              "0"
eq "anon NÃO lê v_sku_sla_compliance"                 "$(como_anon v_sku_sla_compliance)"                 "0"
# o fix não pode quebrar quem TEM direito — senão "seguro" virou "quebrado".
eq "staff (employee) CONTINUA lendo v_sku_sla_compliance"             "$(como_staff v_sku_sla_compliance)"             "1"
eq "staff (employee) CONTINUA lendo v_sku_candidatos_primeira_compra" "$(como_staff v_sku_candidatos_primeira_compra)" "2"
eq "staff (employee) CONTINUA lendo v_sku_sigma_demanda"              "$(como_staff v_sku_sigma_demanda)"              "1"
eq "as 5 views ficaram com security_invoker=on" \
   "$(Pq -c "SELECT count(*) FROM pg_class WHERE relname IN ('v_sku_sla_compliance','v_sku_candidatos_primeira_compra','v_sku_demanda_estatisticas','v_sku_demanda_rajada','v_sku_sigma_demanda') AND reloptions::text ILIKE '%security_invoker=on%';")" "5"

echo ""
echo "═══ 4. Idempotência (o founder pode re-rodar o SQL Editor) ═══"
P -q -f "$REPO_ROOT/supabase/migrations/20260717015000_restaurar_security_invoker_views.sql"
eq "re-aplicar a migration mantém o fix"  "$(como_customer v_sku_sla_compliance)"  "0"

echo ""
echo "═══ 5. FALSIFICAÇÃO (Lei #3) — sabota e EXIGE vermelho ═══"
# Sabotagem A: desliga o invoker de novo (reproduz a regressão). O assert do fix DEVE falhar.
P -q -c "ALTER VIEW public.v_sku_sla_compliance RESET (security_invoker);"
n="$(como_customer v_sku_sla_compliance)"
if [ "$n" = "0" ]; then
  bad "FALSIFICAÇÃO A: sabotei (RESET invoker) e o assert seguiu VERDE — assert sem dente"
else
  ok "FALSIFICAÇÃO A: com o invoker desligado o customer volta a ler (=$n) — o assert tem dente"
fi
P -q -c "ALTER VIEW public.v_sku_sla_compliance SET (security_invoker = on);"
eq "restaurado após falsificação A" "$(como_customer v_sku_sla_compliance)" "0"

# Sabotagem B: o assert do staff também precisa ter dente. Se a policy sumir, o staff
# perde acesso — provando que é o RLS (e não um acaso do cenário) que decide a leitura.
P -q -c "DROP POLICY staff_sku_leadtime_history_all ON sku_leadtime_history;"
n="$(como_staff v_sku_sla_compliance)"
if [ "$n" = "1" ]; then
  bad "FALSIFICAÇÃO B: dropei a policy de staff e ele seguiu lendo — o assert não prova RLS"
else
  ok "FALSIFICAÇÃO B: sem a policy o staff para de ler (=$n) — quem autoriza é o RLS"
fi
P -q -c "CREATE POLICY staff_sku_leadtime_history_all ON sku_leadtime_history FOR ALL TO authenticated USING ( (SELECT has_role((SELECT auth.uid()), 'master') OR has_role((SELECT auth.uid()), 'employee')) );"
eq "restaurado após falsificação B" "$(como_staff v_sku_sla_compliance)" "1"

# Sabotagem C: prova que o mecanismo é o CREATE OR REPLACE sem WITH — a causa-raiz.
# Este é o assert que teria pego o #1354 antes do merge.
P -q -c "CREATE OR REPLACE VIEW public.v_sku_sla_compliance AS SELECT empresa, sku_codigo_omie, fornecedor_nome, avg(lt_bruto_dias_uteis) AS lt_medio FROM sku_leadtime_history GROUP BY 1,2,3;"
opt="$(Pq -c "SELECT coalesce(reloptions::text,'NULL') FROM pg_class WHERE relname='v_sku_sla_compliance';")"
if [ "$opt" = "NULL" ]; then
  ok "FALSIFICAÇÃO C: CREATE OR REPLACE sem WITH RESETA o invoker (reloptions=NULL) — causa-raiz provada"
else
  bad "FALSIFICAÇÃO C: esperava reset silencioso, veio [$opt] — a tese da causa-raiz está errada"
fi
n="$(como_customer v_sku_sla_compliance)"
if [ "$n" = "0" ]; then
  bad "FALSIFICAÇÃO C: o reset não reabriu o vazamento — cenário não prova o impacto"
else
  ok "FALSIFICAÇÃO C: o reset reabre o vazamento (customer lê =$n) — é assim que o #1354 regrediu"
fi

echo ""
echo "═══ 6. A REGRA QUE DECIDE: é o FROM, não o reloptions ═══"
# Esta seção existe porque o #1375 quase virou um PR inútil: eu deduzi "invoker=off +
# toca tabela-RLS ⇒ vaza" e afirmei vazamento em 4 views que NÃO vazavam. O que decide
# é a relação-RAIZ do FROM. Prova executável dos dois lados:
P -q <<'SQL'
-- Caso A (fiel a v_sku_sla_compliance): FROM = TABELA-RLS direto, resto LEFT JOIN.
CREATE VIEW caso_a_from_tabela AS
  SELECT h.empresa, h.sku_codigo_omie, g.grupo
  FROM sku_leadtime_history h
  LEFT JOIN (SELECT 'OBEN'::text AS empresa, 'G1'::text AS grupo) g ON g.empresa = h.empresa::text;
-- Caso B (fiel às outras 4): FROM = view ON; a tabela-RLS entra só por INNER JOIN.
CREATE VIEW fonte_on WITH (security_invoker = on) AS SELECT * FROM sku_leadtime_history;
CREATE VIEW caso_b_from_view_on AS
  SELECT f.empresa, f.sku_codigo_omie
  FROM fonte_on f
  JOIN sku_leadtime_history h ON h.id = f.id;
GRANT SELECT ON caso_a_from_tabela, caso_b_from_view_on, fonte_on TO authenticated;
SQL
eq "caso A — view OFF com FROM = tabela-RLS: VAZA (é o v_sku_sla_compliance)"        "$(como_customer caso_a_from_tabela)"  "2"
eq "caso B — view OFF com FROM = view ON: NÃO vaza (são as outras 4 do #1375)"       "$(como_customer caso_b_from_view_on)" "0"
eq "caso B — staff continua lendo"                                                    "$(como_staff caso_b_from_view_on)"    "2"
# dente: se o caso B desse >0, a regra estaria errada e as 4 views seriam vazamento real.

echo ""
echo "═══════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "═══════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
