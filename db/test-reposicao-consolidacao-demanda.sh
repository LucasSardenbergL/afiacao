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
