#!/usr/bin/env bash
# Harness PG17 da CONSOLIDAÇÃO DE DEMANDA (N→1) — prova que o de-para de SKU
# (v_venda_items_history_efetivo) faz a demanda do DESTINO agregar as vendas dos
# ANTIGOS mapeados nele, SEM tocar venda_items_history nem duplicar.
# Money-path: asserts positivos + negativos + FALSIFICAÇÃO (sabota a efetiva e
# exige vermelho). Design: docs/superpowers/specs/2026-07-05-…-design.md
#
# Base: db/test-city-norm-paridade.sh (mesmo bootstrap). Carrega o SCHEMA REAL de
# prod (schema-snapshot.sql) — as 5 views + escritoras vêm reais — e aplica a
# migração candidata db/reposicao-consolidacao-demanda.sql.
#
# ⚠️ ESTADO TDD: enquanto os 5 REDIRECTS de db/reposicao-consolidacao-demanda.sql
# estiverem VAZIOS (à espera do pré-flight/Task 0), os asserts B/C/E/G ficam
# VERMELHOS de propósito (as views do snapshot ainda leem venda_items_history
# direto). Verde total = depois de preencher os redirects com o verbatim de prod.
# Pré-req: brew install postgresql@17.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5442   # ≠ 5441 do city-norm (rodar em paralelo)
DATA="$(mktemp -d /tmp/pgtest-reposicao.XXXXXX)/data"
WORK="$(mktemp -d /tmp/reposicao-work.XXXXXX)"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "$WORK"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-reposicao.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres reposicao_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d reposicao_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-reposicao.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ stub de auth (service_role destrava a escrita; gate real prova-se pós-deploy — database.md §7)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
-- service_role passa o 1º disjunct do gate SEM tocar user_roles (evita a FK user_roles→auth.users)
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
-- default p/ acao_parametros: o de-para filtra por ='consolidar_demanda'; os INSERTs de mapa-de-consolidação
-- do harness não a informam e devem cair nesse valor (em PROD a função/handoff gravam explícito). O mapa
-- LEGADO do seed informa 'transferir' explícito. Vem ANTES do loop (senão o loop dropa o NOT NULL dela).
ALTER TABLE sku_substituicao ALTER COLUMN acao_parametros SET DEFAULT 'consolidar_demanda';
-- Afrouxa o NOT NULL (só das colunas SEM default que o seed não informa) do snapshot real —
-- irrelevantes p/ a prova do de-para; as essenciais e as que a função/handoff gravam ficam.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT column_name FROM information_schema.columns
            WHERE table_name='sku_substituicao' AND is_nullable='NO' AND column_default IS NULL
              AND column_name NOT IN ('empresa','sku_codigo_antigo','sku_codigo_novo','status')
  LOOP EXECUTE format('ALTER TABLE sku_substituicao ALTER COLUMN %I DROP NOT NULL', c); END LOOP;
  FOR c IN SELECT column_name FROM information_schema.columns
            WHERE table_name='sku_parametros' AND is_nullable='NO' AND column_default IS NULL
              AND column_name NOT IN ('empresa','sku_codigo_omie')
  LOOP EXECUTE format('ALTER TABLE sku_parametros ALTER COLUMN %I DROP NOT NULL', c); END LOOP;
END $$;
SQL

echo "→ migração candidata (efetiva + redirects + consolidar_demanda_sku)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-consolidacao-demanda.sql" >/dev/null

# ── Cenário SEC: P0 de RLS — aplicar ESTE arquivo mantém as 5 views seguras ───
# Prova de CATÁLOGO (o harness roda como service_role/BYPASSRLS → o COMPORTAMENTO
# RLS já é provado em db/test-views-invoker-off-p0.sh). O delta AQUI: garantir que
# aplicar/reaplicar reposicao-consolidacao-demanda.sql NÃO reabre o P0 fechado pela
# migração 20260708190000 — i.e. as 5 views nascem security_invoker=on e anon/PUBLIC
# ficam sem SELECT. SEM o WITH(...) + REVOKE no .sql este cenário fica VERMELHO.
echo "→ SEC. 5 views invoker=on + anon/PUBLIC sem SELECT + authenticated mantém…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE
  v5 text[] := ARRAY['v_venda_items_history_efetivo','v_sku_demanda_estatisticas',
                     'v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra'];
  n int;
BEGIN
  -- SEC1: as 5 views têm security_invoker on|true no reloptions (catálogo, não só comportamento)
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
   WHERE ns.nspname='public' AND c.relkind='v' AND c.relname = ANY(v5)
     AND COALESCE(array_to_string(c.reloptions,','),'') ~* 'security_invoker=(on|true)';
  IF n <> 5 THEN RAISE EXCEPTION 'FAIL SEC1: esperava 5 views invoker=on, veio % (reaplicar o .sql reabriria o P0)', n; END IF;

  -- SEC2: anon SEM SELECT em nenhuma das 5 (o REVOKE do .sql fecha a anon-key)
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee='anon' AND privilege_type='SELECT' AND table_name = ANY(v5);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL SEC2: anon ainda tem SELECT em %/5 view(s)', n; END IF;

  -- SEC3: PUBLIC SEM SELECT em nenhuma das 5 (blinda contra grant-drift)
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee='PUBLIC' AND privilege_type='SELECT' AND table_name = ANY(v5);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL SEC3: PUBLIC ainda tem SELECT em %/5 view(s)', n; END IF;

  -- SEC4: authenticated MANTÉM SELECT nas 5 (staff não pode regredir de acesso)
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee='authenticated' AND privilege_type='SELECT' AND table_name = ANY(v5);
  IF n <> 5 THEN RAISE EXCEPTION 'FAIL SEC4: authenticated deveria ter SELECT nas 5, veio %', n; END IF;
END $$;
SQL
echo "   ✓ SEC (invoker=on + anon/PUBLIC revogados + authenticated mantém)"

# ── Cenário SEC5 [Codex]: privilégio EFETIVO (has_table_privilege), não só grant direto ─
# grant direto (role_table_grants) não vê herança via PUBLIC/role-membership; has_table_privilege
# resolve o privilégio REAL. (service_role vem dos ALTER DEFAULT PRIVILEGES do Supabase, que o PG17
# local não tem — sua preservação sob o REVOKE é provada no SEC6, semeando o grant como em prod.)
echo "→ SEC5. privilégio efetivo: anon negado · authenticated concedido…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE
  v5 text[] := ARRAY['v_venda_items_history_efetivo','v_sku_demanda_estatisticas',
                     'v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra'];
  vn text; n_anon int:=0; n_auth int:=0;
BEGIN
  FOREACH vn IN ARRAY v5 LOOP
    IF has_table_privilege('anon','public.'||vn,'SELECT')              THEN n_anon:=n_anon+1; END IF;
    IF NOT has_table_privilege('authenticated','public.'||vn,'SELECT') THEN n_auth:=n_auth+1; END IF;
  END LOOP;
  IF n_anon <> 0 THEN RAISE EXCEPTION 'FAIL SEC5a: anon TEM SELECT efetivo em %/5 view(s) (herança PUBLIC?)', n_anon; END IF;
  IF n_auth <> 0 THEN RAISE EXCEPTION 'FAIL SEC5b: authenticated SEM SELECT efetivo em %/5 (staff regrediria)', n_auth; END IF;
END $$;
SQL
echo "   ✓ SEC5 (privilégio efetivo: anon negado, authenticated concedido)"

# ── Cenário SEC6 [Codex]: REAPLICAÇÃO — aplicar o arquivo 2× NÃO reabre o P0 (o risco central) ─
# O achado é sobre reaplicar o bloco (fluxo incentivado pelo cabeçalho). Provamos DIRETO: aplica
# de novo e revalida invoker=on + anon sem SELECT efetivo. E, semeando o grant de service_role que
# em prod vem dos default privileges do Supabase (o PG17 local não os tem), provamos que o REVOKE
# do arquivo — FROM anon, PUBLIC — NÃO atinge service_role (senão o recompute como service_role
# quebraria). Se o WITH/REVOKE não fossem idempotentes-seguros, a 2ª passada deixaria isto quebrado.
echo "→ SEC6. reaplicação 2×: invoker=on preservado · anon re-barrado · service_role intacto…"
P -v ON_ERROR_STOP=1 -q -c "GRANT SELECT ON public.v_venda_items_history_efetivo, public.v_sku_demanda_estatisticas, public.v_sku_sigma_demanda, public.v_sku_demanda_rajada, public.v_sku_candidatos_primeira_compra TO service_role;" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-consolidacao-demanda.sql" >/dev/null
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE
  v5 text[] := ARRAY['v_venda_items_history_efetivo','v_sku_demanda_estatisticas',
                     'v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra'];
  vn text; n_on int; n_anon int:=0; n_svc int:=0;
BEGIN
  SELECT count(*) INTO n_on FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
   WHERE ns.nspname='public' AND c.relkind='v' AND c.relname = ANY(v5)
     AND COALESCE(array_to_string(c.reloptions,','),'') ~* 'security_invoker=(on|true)';
  IF n_on <> 5 THEN RAISE EXCEPTION 'FAIL SEC6a: após 2ª aplicação esperava 5 invoker=on, veio %', n_on; END IF;
  FOREACH vn IN ARRAY v5 LOOP
    IF has_table_privilege('anon','public.'||vn,'SELECT')             THEN n_anon:=n_anon+1; END IF;
    IF NOT has_table_privilege('service_role','public.'||vn,'SELECT') THEN n_svc:=n_svc+1;  END IF;
  END LOOP;
  IF n_anon <> 0 THEN RAISE EXCEPTION 'FAIL SEC6b: após 2ª aplicação anon reganhou SELECT em %/5', n_anon; END IF;
  IF n_svc  <> 0 THEN RAISE EXCEPTION 'FAIL SEC6c: REVOKE do arquivo tirou SELECT de service_role em %/5 (recompute quebraria)', n_svc; END IF;
END $$;
SQL
echo "   ✓ SEC6 (2ª aplicação: invoker=on preservado, anon re-barrado, service_role intacto)"

# ── Cenário SEC-F: FALSIFICAÇÃO do risco REAL — CREATE OR REPLACE sem WITH zera o invoker ─
# Recria a folha via CREATE OR REPLACE usando o próprio corpo (pg_get_viewdef) SEM a
# cláusula WITH — exatamente o que uma reaplicação verbatim do .sql pré-fix faria — e
# exige que a contagem do SEC1 caia de 5→4 (a folha perdeu o invoker). Se seguisse 5,
# ou o risco não reproduz ou SEC1 é teatro. Restaura a folha COM WITH ao final.
echo "→ SEC-F. falsificação: recriar a folha sem WITH deve derrubar o invoker (5→4)…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE
  v5 text[] := ARRAY['v_venda_items_history_efetivo','v_sku_demanda_estatisticas',
                     'v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra'];
  d text; n int;
BEGIN
  SELECT pg_get_viewdef('v_venda_items_history_efetivo'::regclass, true) INTO d;
  EXECUTE 'CREATE OR REPLACE VIEW v_venda_items_history_efetivo AS ' || d;   -- SEM WITH (o risco)
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
   WHERE ns.nspname='public' AND c.relkind='v' AND c.relname = ANY(v5)
     AND COALESCE(array_to_string(c.reloptions,','),'') ~* 'security_invoker=(on|true)';
  IF n <> 4 THEN RAISE EXCEPTION 'FAIL SEC-F: sob sabotagem SEC1 deveria contar 4/5, veio % (SEC1 sem dente ou risco não reproduz)', n; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW v_venda_items_history_efetivo WITH (security_invoker = true) AS ' || d;  -- restaura
END $$;
SQL
echo "   ✓ SEC-F (sem WITH → invoker some; restaurado)"

# ── Cenário SEC-F2: FALSIFICAÇÃO do REVOKE — re-conceder anon deve derrubar o SEC2 ─
echo "→ SEC-F2. falsificação: re-grant SELECT a anon deve reaparecer no catálogo (SEC2 com dente)…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
GRANT SELECT ON public.v_venda_items_history_efetivo TO anon;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee='anon' AND privilege_type='SELECT' AND table_name='v_venda_items_history_efetivo';
  IF n = 0 THEN RAISE EXCEPTION 'FAIL SEC-F2: re-grant a anon não apareceu no catálogo (SEC2 sem dente?)'; END IF;
END $$;
REVOKE SELECT ON public.v_venda_items_history_efetivo FROM anon;  -- restaura o estado seguro
SQL
echo "   ✓ SEC-F2 (re-grant detectável; revogado de volta)"

# ── Cenário A: a view de indireção reescreve o SKU ───────────────────────────
echo "→ A. efetiva: passthrough sem mapa, reescrita com mapa…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
TRUNCATE venda_items_history, sku_substituicao;
INSERT INTO venda_items_history (empresa, nfe_chave_acesso, data_emissao, sku_codigo_omie, quantidade)
VALUES ('OBEN','NFE-A', CURRENT_DATE - 10, 8040, 45);
DO $$
DECLARE k bigint;
BEGIN
  SELECT sku_codigo_omie INTO k FROM v_venda_items_history_efetivo WHERE nfe_chave_acesso='NFE-A';
  IF k <> 8040 THEN RAISE EXCEPTION 'FAIL A1: passthrough esperado 8040, veio %', k; END IF;
END $$;
INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, status)
VALUES ('OBEN','8040','4080','aplicada');
DO $$
DECLARE k bigint;
BEGIN
  SELECT sku_codigo_omie INTO k FROM v_venda_items_history_efetivo WHERE nfe_chave_acesso='NFE-A';
  IF k <> 4080 THEN RAISE EXCEPTION 'FAIL A2: reescrita esperada 4080, veio %', k; END IF;
END $$;
SQL
echo "   ✓ A"

# ── Seed principal: 3 SKUs em 90/180d + 2 mapas aplicados ─────────────────────
echo "→ seed 3 SKUs (4080=90, 8040=45, 4128=180) + mapas 8040→4080, 4128→4080…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
TRUNCATE venda_items_history, sku_substituicao;
INSERT INTO venda_items_history (empresa, nfe_chave_acesso, data_emissao, sku_codigo_omie, quantidade, valor_unitario, valor_total) VALUES
  ('OBEN','N1', CURRENT_DATE - 10, 4080, 90, 100, 9000),
  ('OBEN','N2', CURRENT_DATE - 20, 8040, 45, 100, 4500),
  ('OBEN','N3', CURRENT_DATE - 30, 4128, 180, 100, 18000),
  ('OBEN','N4', CURRENT_DATE - 15, 7777, 30, 100, 3000),   -- mapa LEGADO 'transferir' → NÃO consolida
  ('COLACOR','C1', CURRENT_DATE - 5, 8040, 12, 100, 1200);   -- outra empresa, sem mapa nela
INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, status) VALUES
  ('OBEN','8040','4080','aplicada'),
  ('OBEN','4128','4080','aplicada');
-- mapa da feature ANTIGA (acao_parametros='transferir'): o de-para deve IGNORAR (isolamento estrutural)
INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status)
VALUES ('OBEN','7777','4080','transferir','aplicada');
SQL

# ── Cenário B: demanda somada em v_sku_demanda_estatisticas (o coração) ───────
echo "→ B. v_sku_demanda_estatisticas: destino=315 (3.5/dia), antigos=0…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE m numeric; t numeric; n int;
BEGIN
  SELECT demanda_media_diaria, demanda_total_90d INTO m, t
    FROM v_sku_demanda_estatisticas WHERE empresa='OBEN' AND sku_codigo_omie=4080;
  IF t IS DISTINCT FROM 315   THEN RAISE EXCEPTION 'FAIL B1: total esperado 315 (7777 legado NÃO entra), veio %', t; END IF;
  IF m IS DISTINCT FROM 3.5   THEN RAISE EXCEPTION 'FAIL B2: média/dia esperada 3.5, veio %', m; END IF;
  SELECT count(*) INTO n FROM v_sku_demanda_estatisticas
    WHERE empresa='OBEN' AND sku_codigo_omie IN (8040,4128);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL B3: antigos não deviam aparecer, vieram % linhas', n; END IF;
  -- B4: isolamento estrutural — mapa legado 'transferir' NÃO consolida → 7777 fica com sua demanda
  SELECT demanda_total_90d INTO t FROM v_sku_demanda_estatisticas WHERE empresa='OBEN' AND sku_codigo_omie=7777;
  IF t IS DISTINCT FROM 30 THEN RAISE EXCEPTION 'FAIL B4: 7777 (mapa legado) deveria ficar isolado=30, veio %', t; END IF;
END $$;
SQL
echo "   ✓ B"

# ── Cenário C: antigos ausentes nas outras 3 views-fonte ─────────────────────
echo "→ C. sigma/rajada/candidatos: antigos (8040,4128) ausentes p/ OBEN…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM v_sku_sigma_demanda
    WHERE empresa='OBEN' AND sku_codigo_omie::bigint IN (8040,4128);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL C-sigma: antigos apareceram (% linhas)', n; END IF;
  SELECT count(*) INTO n FROM v_sku_demanda_rajada
    WHERE empresa='OBEN' AND sku_codigo_omie::bigint IN (8040,4128);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL C-rajada: antigos apareceram (% linhas)', n; END IF;
  SELECT count(*) INTO n FROM v_sku_candidatos_primeira_compra
    WHERE empresa='OBEN' AND sku_codigo_omie IN (8040,4128);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL C-candidatos: antigo mapeado virou candidato (% linhas)', n; END IF;
END $$;
SQL
echo "   ✓ C"

# ── Cenário D: propagação end-to-end até v_sku_parametros_sugeridos ───────────
# (a demanda do destino herda a soma via v_sku_classificacao_abc_xyz → não recriamos
#  essa view; se a cadeia estiver certa, o 4080 sai com 3.5/dia nos sugeridos)
echo "→ D. v_sku_parametros_sugeridos: destino herda 3.5/dia; antigos ausentes…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE d numeric; n int;
BEGIN
  SELECT count(*), max(demanda_media_diaria) INTO n, d
    FROM v_sku_parametros_sugeridos WHERE empresa='OBEN' AND sku_codigo_omie=4080;
  IF n = 0 THEN
    RAISE WARNING 'D: 4080 não apareceu em v_sku_parametros_sugeridos (filtro de classificação/valor?) — propagação já provada em B; conferir em prod';
  ELSIF d IS DISTINCT FROM 3.5 THEN
    RAISE EXCEPTION 'FAIL D: demanda do destino nos sugeridos esperava 3.5, veio %', d;
  END IF;
  SELECT count(*) INTO n FROM v_sku_parametros_sugeridos WHERE empresa='OBEN' AND sku_codigo_omie IN (8040,4128);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL D: antigos apareceram nos sugeridos (% linhas)', n; END IF;
END $$;
SQL
echo "   ✓ D"

# ── Cenário E: trigger estrutural (auto-ref no INSERT direto) + empresa + reversível ─
echo "→ E. trigger barra auto-ref (INSERT direto) + empresa-aware + reversibilidade…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
-- E1: o TRIGGER estrutural barra auto-ref no INSERT DIRETO (bypassa a função) — ZR001
DO $$
BEGIN
  BEGIN
    INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status)
    VALUES ('OBEN','4080','4080','consolidar_demanda','aplicada');
    RAISE EXCEPTION 'FAIL E1: trigger deveria barrar auto-ref no INSERT direto';
  EXCEPTION WHEN sqlstate 'ZR001' THEN NULL;  -- esperado
  END;
END $$;
-- E1b: destino intacto (a auto-ref não entrou)
DO $$
DECLARE t numeric;
BEGIN
  SELECT demanda_total_90d INTO t FROM v_sku_demanda_estatisticas WHERE empresa='OBEN' AND sku_codigo_omie=4080;
  IF t IS DISTINCT FROM 315 THEN RAISE EXCEPTION 'FAIL E1b: destino deveria seguir 315, veio %', t; END IF;
END $$;
-- E2 empresa: o mapa OBEN não afeta COLACOR
DO $$
DECLARE t numeric;
BEGIN
  SELECT demanda_total_90d INTO t FROM v_sku_demanda_estatisticas WHERE empresa='COLACOR' AND sku_codigo_omie=8040;
  IF t IS DISTINCT FROM 12 THEN RAISE EXCEPTION 'FAIL E2: COLACOR herdou mapa OBEN (esperado 12, veio %)', t; END IF;
END $$;
-- E3 reversibilidade: status<>'aplicada' deixa de contar
UPDATE sku_substituicao SET status='revertida' WHERE empresa='OBEN' AND sku_codigo_antigo='8040' AND sku_codigo_novo='4080';
DO $$
DECLARE t_dest numeric; t_old numeric;
BEGIN
  SELECT demanda_total_90d INTO t_dest FROM v_sku_demanda_estatisticas WHERE empresa='OBEN' AND sku_codigo_omie=4080;
  IF t_dest IS DISTINCT FROM 270 THEN RAISE EXCEPTION 'FAIL E3a: revertido 8040 → destino esperado 270, veio %', t_dest; END IF;
  SELECT demanda_total_90d INTO t_old FROM v_sku_demanda_estatisticas WHERE empresa='OBEN' AND sku_codigo_omie=8040;
  IF t_old IS DISTINCT FROM 45 THEN RAISE EXCEPTION 'FAIL E3b: 8040 revertido deve voltar a 45, veio %', t_old; END IF;
END $$;
-- restaura o estado aplicado p/ os cenários seguintes
UPDATE sku_substituicao SET status='aplicada' WHERE empresa='OBEN' AND sku_codigo_antigo='8040' AND sku_codigo_novo='4080';
SQL
echo "   ✓ E"

# ── Cenário F: consolidar_demanda_sku (cadastro + descontinuar + guards ZR001-005) ─
echo "→ F. consolidar_demanda_sku: grava/descontinua; ZR001-005 + canonicalização…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
TRUNCATE venda_items_history, sku_substituicao;
DELETE FROM sku_parametros WHERE empresa='OBEN' AND sku_codigo_omie IN (8040,5000,4080);
INSERT INTO sku_parametros (empresa, sku_codigo_omie, ativo, tipo_reposicao) VALUES
  ('OBEN', 4080, true, NULL),   -- DESTINO comprável (a função valida — ZR004)
  ('OBEN', 8040, true, NULL),   -- antigo
  ('OBEN', 5000, true, NULL)    -- antigo (F6 leading zeros)
  ON CONFLICT (empresa, sku_codigo_omie) DO UPDATE SET ativo=true, tipo_reposicao=NULL;

SELECT consolidar_demanda_sku('OBEN','8040','4080');
DO $$
DECLARE st text; tr text; hab boolean;
BEGIN
  SELECT status INTO st FROM sku_substituicao WHERE empresa='OBEN' AND sku_codigo_antigo='8040';
  IF st IS DISTINCT FROM 'aplicada' THEN RAISE EXCEPTION 'FAIL F1: mapa esperado aplicada, veio %', st; END IF;
  SELECT tipo_reposicao, habilitado_reposicao_automatica INTO tr, hab
    FROM sku_parametros WHERE empresa='OBEN' AND sku_codigo_omie=8040;
  IF tr IS DISTINCT FROM 'descontinuado' THEN RAISE EXCEPTION 'FAIL F2a: antigo esperado descontinuado, veio %', tr; END IF;
  IF hab IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL F2b: antigo esperado habilitado=false, veio %', hab; END IF;
END $$;

-- F3 auto-ref → ZR001
DO $$ BEGIN
  BEGIN PERFORM consolidar_demanda_sku('OBEN','4080','4080');
    RAISE EXCEPTION 'FAIL F3: auto-ref deveria ter sido barrada';
  EXCEPTION WHEN sqlstate 'ZR001' THEN NULL; END;
END $$;

-- F4 cadeia (4080 já é destino de 8040→4080) → ZR002
DO $$ BEGIN
  BEGIN PERFORM consolidar_demanda_sku('OBEN','4080','9999');
    RAISE EXCEPTION 'FAIL F4: cadeia deveria ter sido barrada';
  EXCEPTION WHEN sqlstate 'ZR002' THEN NULL; END;
END $$;

-- F5 não-numérico → ZR003
DO $$ BEGIN
  BEGIN PERFORM consolidar_demanda_sku('OBEN','ABC','4080');
    RAISE EXCEPTION 'FAIL F5: código não-numérico deveria ter sido barrado';
  EXCEPTION WHEN sqlstate 'ZR003' THEN NULL; END;
END $$;

-- F6 [Codex P1] leading zeros: '05000' canonicaliza p/ '5000' (senão descontinuaria SEM consolidar)
SELECT consolidar_demanda_sku('OBEN','05000','4080');
DO $$
DECLARE a text; tr text;
BEGIN
  SELECT sku_codigo_antigo INTO a FROM sku_substituicao
    WHERE empresa='OBEN' AND sku_codigo_antigo IN ('5000','05000');
  IF a IS DISTINCT FROM '5000' THEN RAISE EXCEPTION 'FAIL F6: esperava canônico 5000, veio %', a; END IF;
  SELECT tipo_reposicao INTO tr FROM sku_parametros WHERE empresa='OBEN' AND sku_codigo_omie=5000;
  IF tr IS DISTINCT FROM 'descontinuado' THEN RAISE EXCEPTION 'FAIL F6b: 5000 deveria descontinuar, veio %', tr; END IF;
END $$;

-- F7 [Codex P1] destino inexistente/não-comprável → ZR004
DO $$ BEGIN
  BEGIN PERFORM consolidar_demanda_sku('OBEN','8040','88888');
    RAISE EXCEPTION 'FAIL F7: destino inexistente deveria ter sido barrado';
  EXCEPTION WHEN sqlstate 'ZR004' THEN NULL; END;
END $$;
SQL
echo "   ✓ F"

# ── Cenário H: trigger estrutural via INSERT DIRETO (o caminho do handoff) ────
echo "→ H. trigger barra cadeia no INSERT direto (ZR002) + canonicaliza leading zeros…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
TRUNCATE sku_substituicao;
INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status)
VALUES ('OBEN','100','200','consolidar_demanda','aplicada');
-- cadeia 200→300 (200 já é destino de 100→200): o TRIGGER barra no INSERT direto → ZR002
DO $$ BEGIN
  BEGIN
    INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status)
    VALUES ('OBEN','200','300','consolidar_demanda','aplicada');
    RAISE EXCEPTION 'FAIL H1: trigger deveria barrar cadeia no INSERT direto';
  EXCEPTION WHEN sqlstate 'ZR002' THEN NULL; END;
END $$;
-- H2 leading zeros no INSERT direto: '0300'→'400' canonicaliza p/ '300'
INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status)
VALUES ('OBEN','0300','400','consolidar_demanda','aplicada');
DO $$
DECLARE a text;
BEGIN
  SELECT sku_codigo_antigo INTO a FROM sku_substituicao WHERE empresa='OBEN' AND sku_codigo_novo='400';
  IF a IS DISTINCT FROM '300' THEN RAISE EXCEPTION 'FAIL H2: trigger deveria canonicalizar 0300→300, veio %', a; END IF;
END $$;
SQL
echo "   ✓ H"

# ── Cenário G: FALSIFICAÇÃO — sabota a efetiva e exige que a soma DESAPAREÇA ───
echo "→ G. falsificação: com de-para destino=315; sabotando a efetiva → 90 (senão é teatro)…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
TRUNCATE venda_items_history, sku_substituicao;
INSERT INTO venda_items_history (empresa, nfe_chave_acesso, data_emissao, sku_codigo_omie, quantidade) VALUES
  ('OBEN','N1', CURRENT_DATE - 10, 4080, 90),
  ('OBEN','N2', CURRENT_DATE - 20, 8040, 45),
  ('OBEN','N3', CURRENT_DATE - 30, 4128, 180);
INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, status) VALUES
  ('OBEN','8040','4080','aplicada'), ('OBEN','4128','4080','aplicada');
-- G-baseline: com a efetiva REAL (de-para), o destino soma 315 → prova que os redirects estão aplicados
DO $$
DECLARE t numeric;
BEGIN
  SELECT demanda_total_90d INTO t FROM v_sku_demanda_estatisticas WHERE empresa='OBEN' AND sku_codigo_omie=4080;
  IF t IS DISTINCT FROM 315 THEN RAISE EXCEPTION 'FAIL G-baseline: com o de-para esperava 315, veio % (redirects não aplicados?)', t; END IF;
END $$;
-- sabotagem: efetiva SEM o de-para, MESMA assinatura de colunas da efetiva real
-- (⚠️ manter esta lista em sincronia com db/reposicao-consolidacao-demanda.sql após o pré-flight)
CREATE OR REPLACE VIEW v_venda_items_history_efetivo AS
SELECT
  id, empresa, nfe_chave_acesso, nfe_numero, nfe_serie, data_emissao,
  cliente_codigo_omie, cliente_razao_social, cliente_cnpj_cpf, cliente_uf, cliente_cidade,
  sku_codigo_omie,   -- ← de-para REMOVIDO (sabotagem)
  sku_codigo, sku_descricao, sku_ncm, sku_unidade,
  quantidade, valor_unitario, valor_total, cfop, raw_data, created_at
FROM venda_items_history;
DO $$
DECLARE t numeric;
BEGIN
  SELECT demanda_total_90d INTO t FROM v_sku_demanda_estatisticas WHERE empresa='OBEN' AND sku_codigo_omie=4080;
  IF t IS DISTINCT FROM 90 THEN
    RAISE EXCEPTION 'FAIL G: sob sabotagem o destino devia cair p/ 90; veio % — a soma NÃO vinha do de-para (teatro)', t;
  END IF;
END $$;
SQL
echo "   ✓ G (falsificação com dente)"

echo ""
echo "✅ consolidação de demanda N→1: de-para + guards + falsificação OK"
