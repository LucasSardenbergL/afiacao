#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"     # mude se rodar em paralelo com outro harness (40 worktrees)
SLUG="authz-private-execute-fecho"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# keg-only do brew: share/lib do postgresql@17 podem não estar linkados → initdb/server falham. Copia do Cellar (idempotente).
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
# LC_ALL=C acima é exigência do postmaster; o que varia o TEXTO dos erros é lc_messages do
# servidor. Parametrizado p/ a prova rodar em C e pt_BR.UTF-8 (falsificar num locale só não prova).
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -q -c "ALTER DATABASE prove SET lc_messages='${HARNESS_LC_MESSAGES:-C}';" >/dev/null
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que as migrations LEEM mas não criam)
# ══════════════════════════════════════════════════════════════════════════════
# `private.regua_num_finito` é criada em 20260723150000 (fase 2) — aqui é PRÉ-REQUISITO, não a
# função sob teste. Reproduzo o corpo E o ACL MEDIDO em prod (`{postgres=X/postgres}`), porque é
# justamente o ACL dela que decide o assert L4: `custo_canonico` é SECURITY INVOKER e a chama.
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;  -- espelha o nspacl de prod

CREATE OR REPLACE FUNCTION private.regua_num_finito(v numeric)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT v IS NOT NULL AND v <> 'NaN'::numeric
     AND v > '-Infinity'::numeric AND v < 'Infinity'::numeric;
$fn$;
REVOKE ALL ON FUNCTION private.regua_num_finito(numeric) FROM PUBLIC;  -- ACL medido em prod

DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role public.app_role);
CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role = _role);
$fn$;

-- precondição VERIFICADA pela própria 120000 (`to_regprocedure`): a matriz de capacidades do
-- #1434. Corpo replicado de prod (pg_get_functiondef) para o gate ser o real.
CREATE TABLE IF NOT EXISTS public.commercial_roles (user_id uuid, commercial_role text);
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT COALESCE(_uid IS NOT NULL AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR (public.has_role(_uid, 'employee'::public.app_role)
          AND EXISTS (SELECT 1 FROM public.commercial_roles cr
                       WHERE cr.user_id = _uid AND cr.commercial_role IN ('estrategico','super_admin')))
    ), false);
$fn$;
-- ACL medido em prod: {postgres=X,authenticated=X,service_role=X}. Replicar importa — sem isto
-- ela nasce com proacl NULL aqui também (é o próprio mecanismo sob investigação) e vira uma
-- 4ª função aberta, poluindo a contagem de L2/L5.
REVOKE ALL ON FUNCTION private.cap_custo_ler(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.cap_custo_ler(uuid) TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ativo boolean, valor_unitario numeric);
CREATE TABLE IF NOT EXISTS public.product_costs (
  product_id uuid, cost_final numeric, cost_price numeric);

-- as duas tabelas do Farmer que os triggers de scrub protegem (só as colunas que eles tocam)
CREATE TABLE IF NOT EXISTS public.farmer_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  m_ij numeric, lie numeric, affinity_score numeric);
CREATE TABLE IF NOT EXISTS public.farmer_bundle_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  m_bundle numeric, lie_bundle numeric, affinity_bundle numeric, bundle_products jsonb);
SQL
echo "pré-requisitos ok"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATIONS REAIS (Lei #1). As duas que CRIARAM o estado, depois o fecho.
# ══════════════════════════════════════════════════════════════════════════════
MIG_RANK="$REPO_ROOT/supabase/migrations/20260725120000_authz_custo_fu4f_fase3_ranking_rpc.sql"
MIG_SCRUB="$REPO_ROOT/supabase/migrations/20260725125000_authz_custo_fu4f_fase3_scrub_recomendacoes.sql"
MIG_TRIG="$REPO_ROOT/supabase/migrations/20260725126000_authz_custo_fu4f_fase3_trigger_nulifica_lie.sql"
MIG_FECHO="$REPO_ROOT/supabase/migrations/20260818120000_authz_private_execute_fecho.sql"
P -q -f "$MIG_RANK"
P -q -f "$MIG_SCRUB"
P -q -f "$MIG_TRIG"
echo "migrations de origem aplicadas (fecho ainda NÃO — L1..L4 medem o estado de HOJE)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('11111111-1111-1111-1111-111111111111','employee');
-- 1 SKU vendável: preço 10 > custo canônico 4
INSERT INTO public.omie_products(id, ativo, valor_unitario)
  VALUES ('22222222-2222-2222-2222-222222222222', true, 10);
INSERT INTO public.product_costs(product_id, cost_final, cost_price)
  VALUES ('22222222-2222-2222-2222-222222222222', 4, 9);
GRANT SELECT ON public.omie_products, public.product_costs, public.user_roles TO authenticated, anon;
GRANT INSERT, SELECT ON public.farmer_recommendations, public.farmer_bundle_recommendations TO authenticated;
SQL

# helper de caminho negativo (Lei #2): roda como <role>, exige a CONDIÇÃO esperada, re-lança o resto.
# Sentinelas ASCII inventadas — nenhuma aparece em mensagem do Postgres, então o veredito não
# depende de locale nem de tradução (é por SQLSTATE, não por texto).
veredito() { # veredito <role> <corpo_plpgsql> <condicao_plpgsql>
  local out
  out=$(P -tA 2>&1 <<SQL || true
SET ROLE $1;
DO \$blk\$ BEGIN
  $2;
  RAISE NOTICE 'ZQ_EXECUTOU_SEM_ERRO';
EXCEPTION
  WHEN $3 THEN RAISE NOTICE 'ZQ_BARROU_ESPERADO';
  WHEN OTHERS THEN RAISE NOTICE 'ZQ_OUTRO_ERRO_%', SQLSTATE; RAISE;
END \$blk\$;
SQL
)
  if   printf '%s' "$out" | command grep -Fq 'ZQ_BARROU_ESPERADO';  then echo "BARROU"
  elif printf '%s' "$out" | command grep -Fq 'ZQ_EXECUTOU_SEM_ERRO'; then echo "EXECUTOU"
  else printf '%s' "$out" | command grep -Fo 'ZQ_OUTRO_ERRO_' >/dev/null 2>&1 \
         && printf 'OUTRO:%s' "$(printf '%s' "$out" | sed -n 's/.*ZQ_OUTRO_ERRO_\([0-9A-Z]*\).*/\1/p' | head -1)" \
         || echo "SEM_SENTINELA"; fi
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
# L0 — EVIDÊNCIA POSITIVA de que o locale pedido está mesmo em vigor. Sem este assert, rodar em
# pt_BR e não ver mensagem traduzida seria ausência de dado, não prova de independência de locale.
LCM=$(Pq -c "SHOW lc_messages;")
eq "L0 lc_messages do servidor é o pedido (prova que o 2º locale rodou de fato)" "$LCM" "${HARNESS_LC_MESSAGES:-C}"

echo "── L1..L4: o estado de HOJE (antes do fecho) — reproduz o achado de prod ──"

ACL=$(Pq -c "SELECT COALESCE(proacl::text,'NULO') FROM pg_proc WHERE oid='private.custo_canonico(numeric,numeric)'::regprocedure;")
eq "L1 custo_canonico nasce com proacl NULL (sem default privilege em private)" "$ACL" "NULO"

ABERTAS=$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND has_function_privilege('anon',p.oid,'EXECUTE');")
eq "L2 as 3 de private estão executáveis por anon (achado reproduzido)" "$ABERTAS" "3"

# A1 — COM EXECUTE, a chamada direta chega ao handler de trigger e morre em 0A000.
# ⚠️ Isto prova SÓ o caso "com EXECUTE". A revisão adversária do Codex apontou que a ACL é
# verificada ANTES da invocação, então sem EXECUTE o esperado é 42501, não 0A000 — medido e
# confirmado; o par está em L12, depois do fecho. A afirmação "morre em 0A000 tenha ou não
# EXECUTE" era FALSA e foi corrigida na migration.
V=$(veredito authenticated "PERFORM private.frec_sem_margem()" "feature_not_supported")
eq "L3 trigger function COM execute morre em 0A000 (handler de trigger)" "$V" "BARROU"

# A3 — custo_canonico é SECURITY INVOKER e chama regua_num_finito, que nega anon.
V=$(veredito anon "PERFORM private.custo_canonico(10,5)" "insufficient_privilege")
eq "L4 custo_canonico HOJE já barra anon — mas por ACIDENTE do encadeamento" "$V" "BARROU"

echo "── aplica o FECHO ──"
P -q -f "$MIG_FECHO"; echo "migration aplicada: $(basename "$MIG_FECHO")"

echo "── L5..L11: o contrato depois do fecho ──"
ABERTAS=$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND has_function_privilege('anon',p.oid,'EXECUTE');")
eq "L5 nenhuma função de private executável por anon" "$ABERTAS" "0"
AUT=$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname IN ('custo_canonico','frec_sem_margem','fbrec_sem_margem') AND has_function_privilege('authenticated',p.oid,'EXECUTE');")
eq "L6 nenhuma das 3 executável por authenticated" "$AUT" "0"

V=$(veredito authenticated "PERFORM private.custo_canonico(10,5)" "insufficient_privilege")
eq "L7 custo_canonico agora nega authenticated por PRIVILÉGIO" "$V" "BARROU"

# A4 positivo — a SECDEF de owner postgres continua chamando o helper fechado.
SKUS=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.get_skus_margem_positiva();" | tail -1)
eq "L8 get_skus_margem_positiva (SECDEF) AINDA chama custo_canonico fechado" "$SKUS" "1"

# A2 — o scrub do Farmer continua funcionando depois do REVOKE (o disparo não checa EXECUTE).
SCRUB=$(Pq -c "SET ROLE authenticated; INSERT INTO public.farmer_recommendations(m_ij, lie, affinity_score) VALUES (99.5, 123.45, 0.8); RESET ROLE; SELECT coalesce(m_ij::text,'N')||'/'||coalesce(lie::text,'N')||'/'||coalesce(affinity_score::text,'N') FROM public.farmer_recommendations;" | tail -1)
eq "L9 trigger de scrub AINDA dispara pós-REVOKE (m_ij/lie nulificados, afinidade intacta)" "$SCRUB" "N/N/0.8"

SCRUBB=$(Pq -c "SET ROLE authenticated; INSERT INTO public.farmer_bundle_recommendations(m_bundle, lie_bundle, affinity_bundle, bundle_products) VALUES (7, 8, 0.9, '[{\"sku\":\"A\",\"cost\":3,\"margin\":2}]'::jsonb); RESET ROLE; SELECT coalesce(m_bundle::text,'N')||'/'||coalesce(lie_bundle::text,'N')||'/'||(bundle_products->0)::text FROM public.farmer_bundle_recommendations;" | tail -1)
eq "L10 scrub do bundle idem (cost/margin somem do jsonb, sku fica)" "$SCRUBB" 'N/N/{"sku": "A"}'

# A5 — reusar a trigger function noutra tabela exige ser dono dela; authenticated não é.
# A5 — reusar a trigger function noutra tabela. `CREATE TRIGGER` exige DUAS coisas: privilégio
# TRIGGER na TABELA e EXECUTE na FUNÇÃO. A 1ª versão deste assert só provava "falhou", sem
# distinguir qual das duas faltava — a revisão do Codex pegou isso. Agora as 3 categorias:
# por SQLSTATE, NUNCA pela palavra 'ERROR': sob lc_messages pt_BR o servidor emite 'ERRO' e o
# assert daria falso-verde em um shell e falso-vermelho no outro (o acidente de locale do #1483).
CT="EXECUTE 'CREATE TRIGGER x BEFORE INSERT ON public.farmer_recommendations FOR EACH ROW EXECUTE FUNCTION private.frec_sem_margem()'"
V=$(veredito authenticated "$CT" "insufficient_privilege")
eq "L11a sem TRIGGER na tabela e sem EXECUTE na função → barrado" "$V" "BARROU"

P -q -c "GRANT TRIGGER ON public.farmer_recommendations TO authenticated;"
V=$(veredito authenticated "$CT" "insufficient_privilege")
eq "L11b COM TRIGGER na tabela, SEM EXECUTE → AINDA barrado (é o EXECUTE que falta)" "$V" "BARROU"

# controle positivo: devolvendo só o EXECUTE, o CREATE TRIGGER passa. Sem este, L11b não prova
# que o REVOKE é a causa — provaria apenas que algo falhou.
P -q -c "GRANT EXECUTE ON FUNCTION private.frec_sem_margem() TO authenticated;"
V=$(veredito authenticated "$CT" "insufficient_privilege")
eq "L11c COM TRIGGER e COM EXECUTE → passa (isola o EXECUTE como a causa de L11b)" "$V" "EXECUTOU"
P -q -c "DROP TRIGGER IF EXISTS x ON public.farmer_recommendations; REVOKE ALL ON FUNCTION private.frec_sem_margem() FROM authenticated; REVOKE TRIGGER ON public.farmer_recommendations FROM authenticated;"

# A1' — o par de L3: SEM EXECUTE a ACL barra ANTES do handler de trigger, então o código muda de
# 0A000 para 42501. É o assert que faltava, e é o que mostra que o REVOKE não é decorativo:
# ele MOVE a barreira para o privilégio.
V=$(veredito authenticated "PERFORM private.frec_sem_margem()" "insufficient_privilege")
eq "L12 pós-REVOKE a chamada direta vira 42501 (ACL antes do handler), não mais 0A000" "$V" "BARROU"

# A6 — nenhum trigger INESPERADO depende destas funções (o REVOKE não neutraliza vínculo já
# instalado; quem responde isso é pg_trigger, não o ACL).
NT=$(Pq -c "SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE p.pronamespace='private'::regnamespace AND p.proname IN ('frec_sem_margem','fbrec_sem_margem') AND NOT t.tgisinternal;")
eq "L13 exatamente 2 vínculos em pg_trigger (nenhum trigger inesperado)" "$NT" "2"

# A7 — a CAUSA-RAIZ que a migration documenta e rejeita. A formulação intuitiva é INÓCUA: default
# privilege POR SCHEMA não remove o EXECUTE do default GLOBAL embutido — só adiciona, ou desfaz um
# GRANT feito também por schema. Medido com canário, porque a doc é sutil e a intuição erra.
P -q -c "ALTER DEFAULT PRIVILEGES IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;"
P -q -c "CREATE FUNCTION private.canario_ap() RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT 1';"
V=$(Pq -c "SELECT has_function_privilege('anon','private.canario_ap()'::regprocedure,'EXECUTE')::text;")
eq "L14 ALTER DEFAULT PRIVILEGES IN SCHEMA é INÓCUO (canário nasce aberto a anon)" "$V" "true"

# e a forma GLOBAL (sem IN SCHEMA) funciona — é a que teria efeito, e por isso é grande demais
# para carona nesta entrega (vale para TODOS os schemas e é por role criadora).
P -q -c "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;"
P -q -c "CREATE FUNCTION private.canario_ap2() RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT 1';"
V=$(Pq -c "SELECT has_function_privilege('anon','private.canario_ap2()'::regprocedure,'EXECUTE')::text;")
eq "L15 a forma GLOBAL funciona (canário nasce fechado) — é a alternativa real, e é invasiva" "$V" "false"
P -q -c "ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC; DROP FUNCTION private.canario_ap(); DROP FUNCTION private.canario_ap2();"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1 — L9 mede o SCRUB, ou só "o insert funcionou"? Dropa o trigger e exige que L9 caia.
P -q -c "DROP TRIGGER trg_frec_sem_margem ON public.farmer_recommendations; DELETE FROM public.farmer_recommendations;"
S=$(Pq -c "SET ROLE authenticated; INSERT INTO public.farmer_recommendations(m_ij, lie, affinity_score) VALUES (99.5, 123.45, 0.8); RESET ROLE; SELECT coalesce(m_ij::text,'N')||'/'||coalesce(lie::text,'N')||'/'||coalesce(affinity_score::text,'N') FROM public.farmer_recommendations;" | tail -1)
if [ "$S" = "N/N/0.8" ]; then bad "F1 sabotagem (trigger dropado) NÃO derrubou L9 — assert sem dente"; else ok "F1 sem o trigger, L9 fica vermelho (veio [$S]) — L9 mede o scrub"; fi
P -q -c "CREATE TRIGGER trg_frec_sem_margem BEFORE INSERT OR UPDATE ON public.farmer_recommendations FOR EACH ROW EXECUTE FUNCTION private.frec_sem_margem(); DELETE FROM public.farmer_recommendations;"

# F2 — L7 mede PRIVILÉGIO, ou o acidente do regua_num_finito? Reabre custo_canonico E o helper.
P -q -c "GRANT EXECUTE ON FUNCTION private.custo_canonico(numeric,numeric) TO authenticated; GRANT EXECUTE ON FUNCTION private.regua_num_finito(numeric) TO authenticated;"
V=$(veredito authenticated "PERFORM private.custo_canonico(10,5)" "insufficient_privilege")
if [ "$V" = "BARROU" ]; then bad "F2 sabotagem (GRANT de volta) NÃO derrubou L7 — assert sem dente"; else ok "F2 com o GRANT de volta, L7 fica vermelho (veio [$V]) — L7 mede privilégio"; fi
P -q -c "REVOKE ALL ON FUNCTION private.custo_canonico(numeric,numeric) FROM authenticated; REVOKE ALL ON FUNCTION private.regua_num_finito(numeric) FROM authenticated;"

# F3 — L4 dizia "hoje já barra anon, mas por ACIDENTE". Prova de que é acidente MESMO: com o
# helper aberto e custo_canonico ainda em proacl NULL, anon EXECUTA. É o cenário que o fecho mata.
P -q -c "ALTER FUNCTION private.custo_canonico(numeric,numeric) OWNER TO postgres; REVOKE ALL ON FUNCTION private.custo_canonico(numeric,numeric) FROM PUBLIC; GRANT EXECUTE ON FUNCTION private.custo_canonico(numeric,numeric) TO PUBLIC; GRANT EXECUTE ON FUNCTION private.regua_num_finito(numeric) TO PUBLIC;"
V=$(veredito anon "PERFORM private.custo_canonico(10,5)" "insufficient_privilege")
if [ "$V" = "EXECUTOU" ]; then ok "F3 com regua_num_finito aberta, anon EXECUTA custo_canonico — o bloqueio de L4 era mesmo acidental"; else bad "F3 esperava EXECUTOU (o acidente exposto), veio [$V]"; fi
P -q -c "REVOKE ALL ON FUNCTION private.custo_canonico(numeric,numeric) FROM PUBLIC; REVOKE ALL ON FUNCTION private.regua_num_finito(numeric) FROM PUBLIC;"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
