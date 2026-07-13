#!/usr/bin/env bash
# Harness PG17 do RELIGAMENTO — prova EXECUTANDO que, após religar as 4 views
# estatísticas (v_sku_demanda_estatisticas / v_sku_sigma_demanda /
# v_sku_demanda_rajada / v_sku_candidatos_primeira_compra) na
# v_sku_demanda_efetiva (venda direta ⊕ consumo de insumo via BOM):
#   A) o insumo ganha demanda (demanda_total_90d > 0);
#   B) o SKU não-insumo NÃO regride (as 4 views idênticas antes/depois);
#   C) o guard #10 por CFOP barra a devolução (não vira consumo do insumo);
#   D) o insumo gradua (num_ordens=2, herdou as 2 NFs de saída do pai);
#   E) security_invoker é preservado nas 4 views religadas.
#
# Money-path: asserts positivos (A-E) + FALSIFICAÇÃO (SAB1 tira o guard CFOP
# de v_sku_demanda_efetiva, SAB2 tira security_invoker de 1 das 4 views) —
# um assert só vale se ele QUEBRA quando o guard some. Nada de
# `WHEN OTHERS THEN 'OK'`: cada sabotagem é medida e comparada ao valor
# esperado sob sabotagem (não só "diferente de zero").
#
# SQL sob teste: db/reposicao-demanda-insumos-bom.sql (PR-1 + fix #10 CFOP,
# já commitado) + db/reposicao-religamento-insumos.sql (religamento, já
# commitado). Este harness só PROVA — não corrige.
# Plano: docs/superpowers/plans/2026-07-11-reposicao-pr2-religamento.md (Task 3)
# Brief: .superpowers/sdd/pr2-task-3-brief.md (ajustes vs. o plano cru)
#
# ⚠️ AJUSTE vs. o plano cru (Guard #10 é ALLOWLIST de CFOP de venda, não por sinal):
#   vendas do pai usam CFOP de saída de venda (5102/6102 — confirmado em prod);
#   a devolução usa CFOP de entrada (1201) OU de saída-não-venda (6202, devolução
#   de compra), AMBAS com quantidade SEMPRE POSITIVA (o dado real nunca grava
#   negativo — devolução é sinalizada por CFOP, não por sinal). O guard é
#   `AND v.cfop IN ('5101','5102','5108','6101','6102','6108')` — só venda de
#   saída consome insumo; exclui 6202 (o furo achado pelo Codex 2026-07-12).
#
# ⚠️ AJUSTE vs. o plano cru (E1 / security_invoker): o plano cru e o brief
#   divergem sobre o literal armazenado em pg_class.reloptions. CONFIRMADO
#   empiricamente neste PG17 (experimento isolado antes de escrever este
#   harness): `CREATE VIEW ... WITH (security_invoker = true)` grava
#   {security_invoker=true} CRU — Postgres NÃO normaliza 'true'→'on'. O 'on'
#   que aparece em supabase/schema-snapshot.sql vem do histórico de ALTER VIEW
#   ... SET (security_invoker=on) já aplicado em prod (migrations antigas,
#   texto literal 'on'); mas db/reposicao-religamento-insumos.sql (o arquivo
#   sob teste aqui) usa `WITH (security_invoker = true)` — e como CREATE OR
#   REPLACE VIEW com WITH explícito SUBSTITUI o reloptions inteiro (não
#   mescla), o resultado real após aplicar este religamento é 'true', não
#   'on'. O assert E abaixo aceita AMBOS os literais (@> 'on' OR @> 'true')
#   — correto independentemente de qual dos dois textos a view carrega, e
#   ainda assim FALSIFICÁVEL (SAB2 zera reloptions por completo → nem 'on'
#   nem 'true' aparecem → E1 cai de 4 pra 3, provando que o assert é real).
#
# Base: db/test-reposicao-demanda-insumos-bom.sh (mesmo bootstrap: initdb,
# stubs, prelude, snapshot, deps do PCP, set_malha, seed pcp_run_logs).
# PORT=5444 (≠ 5443 do irmão — roda em paralelo).
# Pré-req: brew install postgresql@17.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5444   # ≠ 5443 do test-reposicao-demanda-insumos-bom.sh (paralelo)
DATA="$(mktemp -d /tmp/pgtest-relig.XXXXXX)/data"
WORK="$(mktemp -d /tmp/relig-work.XXXXXX)"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "$WORK"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-relig.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres relig_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d relig_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-relig.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ dependências (o snapshot não as tem — PCP e consolidação vieram DEPOIS do dump)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/pcp-f1a-m1-staging.sql"              # pcp_malha_staging + pcp_run_logs
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/pcp-f1a-m2-nucleo.sql"               # fn_pcp_num + vw_pcp_malha_itens/_componentes
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-consolidacao-demanda.sql"  # v_venda_items_history_efetivo + as 4 views (ainda apontando p/ ela)

# ══════════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════════
PASS=0
Pq() { P -tA -q "$@"; }
assert_eq() { # $1=nome $2=esperado $3=obtido
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✓ $1";
  else echo "  ✗ $1: esperado='$2' obtido='$3'"; exit 1; fi
}

# A malha NÃO é tabela: vw_pcp_malha_componentes → vw_pcp_malha_itens → pcp_malha_staging(payload jsonb).
# Semear = UPSERT do payload do pai. $1=pai_omie(colacor)  $2=json array de itens (string)
set_malha() {
  P -v ON_ERROR_STOP=1 -q -c "
    INSERT INTO pcp_malha_staging (omie_codigo_produto, empresa, payload, sync_run_id, synced_at)
    VALUES ($1, 'colacor',
            jsonb_build_object('ident', jsonb_build_object('idProduto', $1), 'itens', '$2'::jsonb),
            1, now())
    ON CONFLICT (omie_codigo_produto) DO UPDATE SET payload = EXCLUDED.payload;"
}
# item padrão: {"idProdMalha":<comp_colacor>,"quantProdMalha":<q>,"unidProdMalha":"<un>","percPerdaProdMalha":<p>}

# ══════════════════════════════════════════════════════════════════════════
# Step 1: fixtures — TUDO semeado ANTES do candidato. base_<view> (abaixo)
# precisa refletir os MESMOS dados que a leitura "depois": a única variável
# entre base_<view> e <view> deve ser o religamento (troca do FROM), não a
# presença/ausência de massa de teste. Se a semeadura viesse depois da
# captura de base_<view>, o SKU 300 apareceria vazio no "antes" e populado
# no "depois" — o assert B (não-regressão) quebraria por RUÍDO de fixture,
# não por regressão real.
# ══════════════════════════════════════════════════════════════════════════
echo "→ seed: 1 pcp_run_logs (FK do sync_run_id fixo=1 usado por set_malha)…"
P -v ON_ERROR_STOP=1 -q -c "INSERT INTO pcp_run_logs (empresa, funcao, status) VALUES ('colacor','test-harness-relig','ok');"

echo "→ semeando catálogo: pai 100(colacor)/200(oben), insumo 101(colacor)/201(oben), produto SEM ficha 300(oben)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, unidade)
VALUES (gen_random_uuid(), 100, 'PRD_PAI',      'TINGIDOR X',        'colacor', true, 'UN'),
       (gen_random_uuid(), 200, 'PRD_PAI',      'TINGIDOR X',        'oben',    true, 'UN'),
       (gen_random_uuid(), 101, 'PRD_BASE',     'BASE',              'colacor', true, 'L'),
       (gen_random_uuid(), 201, 'PRD_BASE',     'BASE',              'oben',    true, 'L'),
       -- SEM par colacor: nada tem 300 como insumo (não-insumo, controle do assert B)
       (gen_random_uuid(), 300, 'PRD_SEMFICHA', 'PRODUTO SEM FICHA', 'oben',    true, 'UN');
SQL

echo "→ ficha: pai 100 leva 0.9 L do insumo 101 (perda 0, unidade ficha=estoque)"
set_malha 100 '[{"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0}]'

echo "→ sanidade: a malha real enxerga o par (pré-requisito dos asserts abaixo)"
got=$(Pq -c "SELECT count(*) FROM vw_pcp_malha_componentes WHERE pai_codigo=100;")
assert_eq "setup: malha montada a partir do jsonb" "1" "$got"

echo "→ vendas: pai 200 em 2 NFs de saída (5102) + devolução de VENDA (1201) + devolução de COMPRA (6202) + produto 300 (5102)"
# NFE-R1/NFE-R2: saída normal do pai → DEVEM explodir consumo do insumo 201 (2 NFs distintas → D. num_ordens=2).
# NFE-DEVOL: devolução de VENDA (CFOP de entrada 1201) com quantidade=5 POSITIVA — o dado real nunca grava
#   negativo; é o CFOP que sinaliza devolução, não o sinal. NÃO deve gerar consumo do insumo (assert C1/SAB1).
# NFE-DEVCOMP: devolução de COMPRA (CFOP de SAÍDA 6202, qtde POSITIVA) — o furo do Codex: 'cfop LIKE 6%'
#   a incluiria (começa com 6), mas 6202 NÃO é venda. A allowlist a exclui → NÃO deve virar consumo (C2/SAB1).
# NFE-R3: produto 300, sem ficha — não-insumo, controle do assert B (não-regressão).
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO venda_items_history
  (id, empresa, nfe_chave_acesso, data_emissao, sku_codigo_omie, sku_descricao,
   sku_unidade, quantidade, valor_unitario, valor_total, cfop, created_at)
VALUES
  (gen_random_uuid(),'OBEN','NFE-R1',      CURRENT_DATE - 10, 200, 'TINGIDOR X',        'UN', 1, 100, 100, '5102', now()),
  (gen_random_uuid(),'OBEN','NFE-R2',      CURRENT_DATE - 5,  200, 'TINGIDOR X',        'UN', 2, 100, 200, '5102', now()),
  (gen_random_uuid(),'OBEN','NFE-DEVOL',   CURRENT_DATE - 3,  200, 'TINGIDOR X',        'UN', 5, 100, 500, '1201', now()),
  (gen_random_uuid(),'OBEN','NFE-DEVCOMP', CURRENT_DATE - 4,  200, 'TINGIDOR X',        'UN', 3, 100, 300, '6202', now()),
  (gen_random_uuid(),'OBEN','NFE-R3',      CURRENT_DATE - 3,  300, 'PRODUTO SEM FICHA', 'UN', 7,  10,  70, '5102', now());
SQL

echo "→ baseline das 4 views ANTES do candidato (EXCEPT ALL de B usa isto — religamento é a ÚNICA variável)…"
for v in v_sku_demanda_estatisticas v_sku_sigma_demanda v_sku_demanda_rajada v_sku_candidatos_primeira_compra; do
  P -v ON_ERROR_STOP=1 -q -c "CREATE TABLE base_${v} AS SELECT * FROM ${v};"
done

echo "→ aplicando o candidato: PR-1 (fix #10 CFOP) → religamento (as 4 views passam a ler v_sku_demanda_efetiva)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-demanda-insumos-bom.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-religamento-insumos.sql"

# ══════════════════════════════════════════════════════════════════════════
# Step 2: Asserts (money-path) — A a E
# ══════════════════════════════════════════════════════════════════════════
echo "→ A. RELIGAMENTO: o insumo 201 ganha demanda_total_90d > 0"
got=$(Pq -c "SELECT COALESCE(demanda_total_90d,0)>0 FROM v_sku_demanda_estatisticas WHERE sku_codigo_omie=201 AND empresa='OBEN';")
assert_eq "A1 insumo tem demanda apos religar" "t" "$got"

echo "→ B. NÃO-REGRESSÃO: SKU não-insumo (300) idêntico antes/depois nas 4 views (EXCEPT ALL nos 2 sentidos = 0)"
for v in v_sku_demanda_estatisticas v_sku_sigma_demanda v_sku_demanda_rajada v_sku_candidatos_primeira_compra; do
  got=$(Pq -c "SELECT count(*) FROM (
                 (SELECT * FROM ${v} WHERE sku_codigo_omie::text='300' EXCEPT ALL SELECT * FROM base_${v} WHERE sku_codigo_omie::text='300')
                 UNION ALL
                 (SELECT * FROM base_${v} WHERE sku_codigo_omie::text='300' EXCEPT ALL SELECT * FROM ${v} WHERE sku_codigo_omie::text='300')) d;")
  assert_eq "B:${v} nao-insumo intacto" "0" "$got"
done

echo "→ C. FIX #10 (allowlist CFOP): nenhuma devolução gera consumo do insumo 201 (1201 entrada E 6202 saída)"
got=$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201 AND nfe_chave_acesso='NFE-DEVOL';")
assert_eq "C1 devolucao de venda (CFOP 1201) nao vira consumo do insumo" "0" "$got"
got=$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201 AND nfe_chave_acesso='NFE-DEVCOMP';")
assert_eq "C2 devolucao de compra (CFOP 6202, saida-nao-venda) nao vira consumo — o furo do Codex" "0" "$got"

echo "→ D. GRADUAÇÃO: num_ordens=2 (insumo herdou as 2 NFs de SAÍDA do pai — a devolução não conta)"
got=$(Pq -c "SELECT num_ordens FROM v_sku_demanda_estatisticas WHERE sku_codigo_omie=201 AND empresa='OBEN';")
assert_eq "D1 insumo graduou: num_ordens=2" "2" "$got"

echo "→ E. security_invoker preservado nas 4 views religadas (aceita 'true' OU 'on' — ver nota no cabeçalho)"
got=$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname IN
                   ('v_sku_demanda_estatisticas','v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra')
               AND (c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on']);")
assert_eq "E1 4 views security_invoker" "4" "$got"

# ══════════════════════════════════════════════════════════════════════════
# Step 3: FALSIFICAÇÃO (sabotar → exigir vermelho)
# Um assert só vale se ele FALHA (produz o valor "vazado") quando o guard some.
# ══════════════════════════════════════════════════════════════════════════
echo "→ SABOTAGEM SAB1: v_sku_demanda_efetiva SEM o guard CFOP → a devolução deve VAZAR como consumo (C1 quebraria)"
P -q -c "CREATE OR REPLACE VIEW v_sku_demanda_efetiva WITH (security_invoker = true) AS
SELECT
  id, empresa, nfe_chave_acesso, nfe_numero, nfe_serie, data_emissao,
  cliente_codigo_omie, cliente_razao_social, cliente_cnpj_cpf, cliente_uf, cliente_cidade,
  sku_codigo_omie, sku_codigo, sku_descricao, sku_ncm, sku_unidade,
  quantidade, valor_unitario, valor_total, cfop, raw_data, created_at
FROM v_venda_items_history_efetivo
UNION ALL
SELECT
  md5(v.id::text || ':' || mo.comp_oben::text)::uuid  AS id,
  v.empresa,
  v.nfe_chave_acesso,
  v.nfe_numero,
  v.nfe_serie,
  v.data_emissao,
  v.cliente_codigo_omie, v.cliente_razao_social, v.cliente_cnpj_cpf,
  v.cliente_uf, v.cliente_cidade,
  mo.comp_oben                 AS sku_codigo_omie,
  ins.codigo                   AS sku_codigo,
  ins.descricao                AS sku_descricao,
  ins.ncm                      AS sku_ncm,
  ins.unidade                  AS sku_unidade,
  v.quantidade * mo.quantidade AS quantidade,
  NULL::numeric                AS valor_unitario,
  NULL::numeric                AS valor_total,
  v.cfop, v.raw_data, v.created_at
FROM v_venda_items_history_efetivo v
JOIN v_pcp_malha_oben mo   ON mo.pai_oben = v.sku_codigo_omie
JOIN omie_products ins     ON ins.omie_codigo_produto = mo.comp_oben
                          AND ins.account = 'oben'
WHERE v.empresa = 'OBEN'
  AND v.quantidade > 0;"
# ⬆ SEM o guard AND v.cfop IN (allowlist) — as DUAS devoluções (1201 entrada + 6202 saída) voltam a explodir.

# Esperado sob sabotagem: EXATAMENTE 2 linhas vazam (NFE-DEVOL 1201 + NFE-DEVCOMP 6202, cada uma casa 1:1
# com o par pai_oben=200/comp_oben=201). "0" = sabotagem inútil; "1" = só uma devolução coberta (o 6202
# ficaria sem prova). assert_eq mata o harness nesses casos — garante que a allowlist cobre AMBAS.
got=$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201 AND nfe_chave_acesso IN ('NFE-DEVOL','NFE-DEVCOMP');")
assert_eq "SAB1 sabotagem funcional: as 2 devolucoes vazam como consumo sem o guard CFOP" "2" "$got"
echo "  ✓ SAB1 ok (guard removido → ambas devolucoes vazam; logo C1/C2 protegem de verdade)"

echo "→ restaurando v_sku_demanda_efetiva (fix #10 intacto)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-demanda-insumos-bom.sql"
got=$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201 AND nfe_chave_acesso IN ('NFE-DEVOL','NFE-DEVCOMP');")
assert_eq "SAB1-restore C1/C2 voltam a valer (nenhuma devolucao vira consumo)" "0" "$got"
got=$(Pq -c "SELECT num_ordens FROM v_sku_demanda_estatisticas WHERE sku_codigo_omie=201 AND empresa='OBEN';")
assert_eq "SAB1-restore D1 volta a valer (num_ordens=2)" "2" "$got"

echo "→ SABOTAGEM SAB2: recriar v_sku_sigma_demanda SEM WITH(security_invoker) → E1 deve cair de 4 p/ 3"
P -q -c "CREATE OR REPLACE VIEW public.v_sku_sigma_demanda AS
 WITH datas AS (
         SELECT generate_series(CURRENT_DATE - '180 days'::interval, CURRENT_DATE - '1 day'::interval, '1 day'::interval)::date AS dt
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie::text AS sku_codigo_omie,
            venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval)
          GROUP BY venda_items_history.empresa, (venda_items_history.sku_codigo_omie::text), venda_items_history.data_emissao
        ), serie AS (
         SELECT v.empresa,
            v.sku_codigo_omie,
            d.dt,
            COALESCE(sum(vd.qtde), 0::numeric) AS qtde
           FROM ( SELECT DISTINCT vendas_diarias.empresa,
                    vendas_diarias.sku_codigo_omie
                   FROM vendas_diarias) v
             CROSS JOIN datas d
             LEFT JOIN vendas_diarias vd ON vd.empresa = v.empresa AND vd.sku_codigo_omie = v.sku_codigo_omie AND vd.dt = d.dt
          GROUP BY v.empresa, v.sku_codigo_omie, d.dt
        )
 SELECT empresa,
    sku_codigo_omie,
    round(stddev_samp(qtde), 4) AS sigma_demanda_diaria,
    round(avg(qtde), 4) AS media_demanda_diaria
   FROM serie
  GROUP BY empresa, sku_codigo_omie;"
# ⬆ SEM WITH (security_invoker = true): CREATE OR REPLACE VIEW sem WITH explícito RESETA
# reloptions p/ vazio (confirmado empiricamente neste PG17 antes de escrever o harness).

got=$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname IN
                   ('v_sku_demanda_estatisticas','v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra')
               AND (c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on']);")
assert_eq "SAB2 sabotagem funcional: E1 cai para 3 sem security_invoker numa view" "3" "$got"
echo "  ✓ SAB2 ok (security_invoker removido de 1 view → E1 cai; logo E1 protege a RLS de verdade)"

echo "→ restaurando as 4 views religadas…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-religamento-insumos.sql"
got=$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname IN
                   ('v_sku_demanda_estatisticas','v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra')
               AND (c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on']);")
assert_eq "SAB2-restore E1 volta a 4" "4" "$got"

echo ""
echo "PASS=$PASS"
echo "✅ religamento (demanda+graduacao+nao-regressao+fix10 CFOP+RLS): asserts A-E + falsificação SAB1/SAB2 OK"
