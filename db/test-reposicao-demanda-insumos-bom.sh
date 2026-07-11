#!/usr/bin/env bash
# Harness PG17 da EXPLOSÃO DE BOM (demanda de insumos de produção) — prova
# EXECUTANDO que v_pcp_malha_oben traduz a ficha técnica (malha Omie, código
# Colacor) para o espaço de SKU OBEN respeitando TODO guard fail-closed
# (cardinalidade 1:1, unidade ficha=estoque, sem auto-referência, sem perda,
# quantidade consistente no par) e que v_pcp_malha_oben_quarentena reporta o
# motivo de todo par excluído — nada some calado (precisão>recall).
#
# Money-path: asserts positivos + negativos + FALSIFICAÇÃO (sabota os guards
# de v_pcp_malha_oben e exige vermelho — um assert só vale se ele quebra
# quando o guard some). SQL sob teste: db/reposicao-demanda-insumos-bom.sql
# (Task 1, já revisado — este harness PROVA, não corrige).
# Spec: docs/superpowers/specs/2026-07-09-reposicao-demanda-insumos-producao-bom-design.md
#
# Base: db/test-reposicao-consolidacao-demanda.sh (mesmo bootstrap: initdb,
# stubs, prelude, snapshot). PORT=5443 (≠ 5442 do irmão — roda em paralelo).
#
# ⚠️ O schema-snapshot.sql NÃO contém pcp_malha_staging / vw_pcp_malha_itens /
# vw_pcp_malha_componentes / v_venda_items_history_efetivo (aplicados em prod
# DEPOIS do dump). Aplicam-se, nesta ordem, ANTES do candidato:
#   1) db/pcp-f1a-m1-staging.sql       → pcp_malha_staging (+ pcp_run_logs)
#   2) db/pcp-f1a-m2-nucleo.sql        → fn_pcp_num, vw_pcp_malha_itens/_componentes
#   3) db/reposicao-consolidacao-demanda.sql → v_venda_items_history_efetivo + redirects
# Pré-req: brew install postgresql@17.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5443   # ≠ 5442 do test-reposicao-consolidacao-demanda.sh (paralelo)
DATA="$(mktemp -d /tmp/pgtest-bom.XXXXXX)/data"
WORK="$(mktemp -d /tmp/bom-work.XXXXXX)"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "$WORK"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-bom.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres bom_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d bom_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-bom.XXXXXX")"
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
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-consolidacao-demanda.sql"  # v_venda_items_history_efetivo + redirects

echo "→ baseline das 4 views estatísticas ANTES do candidato (Task 4 usa isto)…"
for v in v_sku_demanda_estatisticas v_sku_sigma_demanda v_sku_demanda_rajada v_sku_candidatos_primeira_compra; do
  P -v ON_ERROR_STOP=1 -q -c "CREATE TABLE base_${v} AS SELECT * FROM ${v};"
done

echo "→ aplicando a migração candidata (v_pcp_malha_oben_cand / _oben / _quarentena)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-demanda-insumos-bom.sql"

# ══════════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════════
PASS=0
Pq() { P -tA -q "$@"; }
assert_eq() { # $1=nome $2=esperado $3=obtido
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✓ $1";
  else echo "  ✗ $1: esperado='$2' obtido='$3'"; exit 1; fi
}

# ══════════════════════════════════════════════════════════════════════════
# Task 4 · O. INÉRCIA — PRECISA rodar AQUI (candidato já aplicado, ZERO
# fixture ainda), não no fim do arquivo.
#
# Motivo: base_<view> foi capturado com as tabelas-fonte vazias (schema-snapshot.sql
# é DDL-puro, sem massa; nenhuma dependência semeia venda_items_history/omie_products).
# v_sku_demanda_estatisticas/_sigma_demanda/_demanda_rajada leem venda_items_history
# numa janela de 90/180 dias — os Steps 1-6 abaixo inserem vendas (sku 200/300,
# datadas de CURRENT_DATE-10..-3, dentro da janela) para testar v_sku_demanda_efetiva.
# Se este assert rodasse só no fim (depois desses fixtures), o EXCEPT ALL veria
# 2 linhas novas em 3 das 4 views — CONFIRMADO empiricamente rodando a versão
# "no fim" antes desta correção (diff=2/2/2/0) — não por o PR-1 ter mudado
# comportamento, mas porque a MASSA DE TESTE de outro step passou a aparecer
# nessas views. Comparando aqui, base_<view> e a view atual têm o MESMO estado
# de dados (vazio); a única variável isolada é "o candidato foi aplicado" — que
# é exatamente o que este assert precisa provar.
# ══════════════════════════════════════════════════════════════════════════
echo "→ O. INÉRCIA: cada view estatística retorna IDÊNTICO antes/depois do PR-1"
for v in v_sku_demanda_estatisticas v_sku_sigma_demanda v_sku_demanda_rajada v_sku_candidatos_primeira_compra; do
  got=$(Pq -c "SELECT count(*) FROM (
                 (SELECT * FROM ${v} EXCEPT ALL SELECT * FROM base_${v})
                 UNION ALL
                 (SELECT * FROM base_${v} EXCEPT ALL SELECT * FROM ${v})) d;")
  assert_eq "O:${v} inalterada" "0" "$got"
done

# A malha NÃO é tabela: vw_pcp_malha_componentes → vw_pcp_malha_itens → pcp_malha_staging(payload jsonb).
# Semear = UPSERT do payload do pai. $1=pai_omie  $2=json array de itens (string; UMA aspa simples por chamada)
set_malha() {
  P -v ON_ERROR_STOP=1 -q -c "
    INSERT INTO pcp_malha_staging (omie_codigo_produto, empresa, payload, sync_run_id, synced_at)
    VALUES ($1, 'colacor',
            jsonb_build_object('ident', jsonb_build_object('idProduto', $1), 'itens', '$2'::jsonb),
            1, now())
    ON CONFLICT (omie_codigo_produto) DO UPDATE SET payload = EXCLUDED.payload;"
}
# item padrão: {"idProdMalha":<comp>,"quantProdMalha":<q>,"unidProdMalha":"<un>","percPerdaProdMalha":<p>}

# ══════════════════════════════════════════════════════════════════════════
# Step 1: fixtures
# ══════════════════════════════════════════════════════════════════════════
# pcp_malha_staging.sync_run_id é FK NOT NULL → pcp_run_logs(id) (guard contra
# limpeza NULL-blind, ver comentário na própria migração). set_malha fixa
# sync_run_id=1: precisamos de UM run log real para essa FK não estourar
# (o schema-snapshot não semeia isso; pcp_run_logs.id é IDENTITY começando em 1).
echo "→ seed: 1 pcp_run_logs (FK do sync_run_id fixo=1 usado por set_malha)…"
P -v ON_ERROR_STOP=1 -q -c "INSERT INTO pcp_run_logs (empresa, funcao, status) VALUES ('colacor','test-harness-bom','ok');"

echo "→ semeando catálogo (2 contas por codigo — é assim que Colacor↔OBEN se ligam)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, unidade)
VALUES (gen_random_uuid(), 100, 'PRD_PAI',  'TINGIDOR X', 'colacor', true, 'UN'),
       (gen_random_uuid(), 200, 'PRD_PAI',  'TINGIDOR X', 'oben',    true, 'UN'),
       (gen_random_uuid(), 101, 'PRD_BASE', 'BASE',       'colacor', true, 'L'),
       (gen_random_uuid(), 201, 'PRD_BASE', 'BASE',       'oben',    true, 'L'),
       -- unidade divergente: ficha diz M2, estoque do insumo é UN
       (gen_random_uuid(), 102, 'PRD_DISC', 'DISCO',      'colacor', true, 'M2'),
       (gen_random_uuid(), 202, 'PRD_DISC', 'DISCO',      'oben',    true, 'UN');
SQL

echo "→ ficha: pai 100 leva 0.9 L do componente 101, e 1 M2 do componente 102"
set_malha 100 '[{"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0},
                {"idProdMalha":102,"quantProdMalha":1,"unidProdMalha":"M2","percPerdaProdMalha":0}]'

echo "→ sanidade: a malha real enxerga os 2 pares"
got=$(Pq -c "SELECT count(*) FROM vw_pcp_malha_componentes WHERE pai_codigo=100;")
assert_eq "setup: malha montada a partir do jsonb" "2" "$got"

# ══════════════════════════════════════════════════════════════════════════
# Step 2: Asserts positivos
# ══════════════════════════════════════════════════════════════════════════
echo "→ A. par limpo entra no elegível"
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "A1 par limpo elegivel" "1" "$got"

got=$(Pq -c "SELECT quantidade FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "A2 qtde preservada" "0.9" "$got"

echo "→ B. unidade divergente NÃO entra e aparece na quarentena"
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE comp_oben=202;")
assert_eq "B1 unidade divergente barrada" "0" "$got"

got=$(Pq -c "SELECT motivo FROM v_pcp_malha_oben_quarentena WHERE comp_oben=202;")
assert_eq "B2 motivo diagnosticado" "unidade_divergente" "$got"

# ══════════════════════════════════════════════════════════════════════════
# Step 3: Asserts negativos (cardinalidade, auto-ref, perda, quantidade)
# ══════════════════════════════════════════════════════════════════════════
echo "→ C. codigo ambíguo em OBEN → fail-closed (não explode, vai p/ quarentena)"
P -q -c "INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, unidade)
         VALUES (gen_random_uuid(), 999, 'PRD_BASE', 'BASE CLONE', 'oben', true, 'L');"
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE comp_oben IN (201,999);")
assert_eq "C1 ambiguo nao explode (COMPRA DOBRADA evitada)" "0" "$got"
got=$(Pq -c "SELECT motivo FROM v_pcp_malha_oben_quarentena WHERE componente_codigo=101 LIMIT 1;")
assert_eq "C2 motivo ambiguo" "componente_ambiguo_oben" "$got"
P -q -c "DELETE FROM omie_products WHERE omie_codigo_produto=999;"

FICHA_OK='[{"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0},
           {"idProdMalha":102,"quantProdMalha":1,"unidProdMalha":"M2","percPerdaProdMalha":0}]'

echo "→ D. auto-referência barrada (venda direta + sintética do mesmo SKU = compra dobrada)"
set_malha 100 '[{"idProdMalha":100,"quantProdMalha":1,"unidProdMalha":"UN","percPerdaProdMalha":0}]'
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=200;")
assert_eq "D1 auto-referencia barrada" "0" "$got"
got=$(Pq -c "SELECT motivo FROM v_pcp_malha_oben_quarentena WHERE pai_codigo=100 AND componente_codigo=100;")
assert_eq "D2 motivo auto_referencia" "auto_referencia" "$got"

echo "→ E. perc_perda <> 0 barrada (não aplicar fator de perda silencioso)"
set_malha 100 '[{"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0.6}]'
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "E1 perc_perda barrada" "0" "$got"
got=$(Pq -c "SELECT motivo FROM v_pcp_malha_oben_quarentena WHERE pai_codigo=100 AND componente_codigo=101;")
assert_eq "E2 motivo perc_perda" "perc_perda_nao_suportada" "$got"

echo "→ F. quantidades divergentes no mesmo par → quarentena, NUNCA soma nem escolhe"
set_malha 100 '[{"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0},
                {"idProdMalha":101,"quantProdMalha":1.5,"unidProdMalha":"L","percPerdaProdMalha":0}]'
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "F1 par divergente NAO entra (nem soma 2.4, nem escolhe 0.9)" "0" "$got"
got=$(Pq -c "SELECT DISTINCT motivo FROM v_pcp_malha_oben_quarentena
             WHERE pai_codigo=100 AND componente_codigo=101;")
assert_eq "F2 motivo quantidade_divergente" "quantidade_divergente_no_par" "$got"

echo "→ G. duplicata EXATA deduplica (1 linha, qtde NÃO dobra)"
set_malha 100 '[{"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0},
                {"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0}]'
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "G1 duplicata exata deduplica" "1" "$got"
got=$(Pq -c "SELECT quantidade FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "G2 qtde NAO dobrou (0.9, nao 1.8)" "0.9" "$got"

echo "→ RES. componente que NÃO resolve no catálogo colacor → quarentena (nada some — Crítico do review)"
# produto colacor 103 existe mas SEM codigo PRD → não traduzível p/ OBEN
P -q -c "INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, unidade)
         VALUES (gen_random_uuid(), 103, '', 'COMP SEM PRD', 'colacor', true, 'L');"
set_malha 100 '[{"idProdMalha":103,"quantProdMalha":0.5,"unidProdMalha":"L","percPerdaProdMalha":0}]'
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200;")
assert_eq "RES1 nao-resolvido NAO entra no elegivel" "0" "$got"
got=$(Pq -c "SELECT motivo FROM v_pcp_malha_oben_quarentena WHERE pai_codigo=100 AND componente_codigo=103;")
assert_eq "RES2 nao-resolvido diagnosticado (nada some)" "componente_nao_resolvido_colacor" "$got"
P -q -c "DELETE FROM omie_products WHERE omie_codigo_produto=103;"

echo "→ SEC. as 3 views têm security_invoker (não bypassam a RLS staff-only das bases — Crítico do review)"
got=$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.reloptions @> ARRAY['security_invoker=true']
               AND c.relname IN ('v_pcp_malha_oben_cand','v_pcp_malha_oben','v_pcp_malha_oben_quarentena');")
assert_eq "SEC1 as 3 views sao security_invoker" "3" "$got"

# restaurar a ficha boa para os testes seguintes
set_malha 100 "$FICHA_OK"

# ══════════════════════════════════════════════════════════════════════════
# Hardening do Codex challenge do SQL (#1 colapso, #7 normalização, #6 overflow)
# ══════════════════════════════════════════════════════════════════════════
echo "→ COL. [Codex #1] 2 componentes distintos → mesmo insumo (via de-para) → quarentena, NÃO subcompra"
# 104(colacor,PRD_X) ↔ 204(oben,PRD_X); de-para 204→201; ficha do pai 100 leva 101(→201) e 104(→204→201)
P -q -c "INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, unidade)
         VALUES (gen_random_uuid(), 104, 'PRD_X', 'COMP2', 'colacor', true, 'L'),
                (gen_random_uuid(), 204, 'PRD_X', 'COMP2', 'oben',    true, 'L');"
P -q -c "INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, status, acao_parametros, data_substituicao)
         VALUES ('OBEN','204','201','aplicada','consolidar_demanda', CURRENT_DATE);"
set_malha 100 '[{"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0},
                {"idProdMalha":104,"quantProdMalha":0.5,"unidProdMalha":"L","percPerdaProdMalha":0}]'
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "COL1 colapso NAO entra no elegivel (nao subcompra 0.9 no lugar de 1.4)" "0" "$got"
got=$(Pq -c "SELECT DISTINCT motivo FROM v_pcp_malha_oben_quarentena WHERE pai_codigo=100 AND comp_oben=201;")
assert_eq "COL2 colapso diagnosticado (nada some)" "multiplos_componentes_mesmo_insumo" "$got"
P -q -c "DELETE FROM sku_substituicao WHERE sku_codigo_antigo='204';"
P -q -c "DELETE FROM omie_products WHERE omie_codigo_produto IN (104,204);"
set_malha 100 "$FICHA_OK"

echo "→ NORM. [Codex #7] unidade 'l ' (minúscula+espaço) vs 'L' normaliza — NÃO falso-quarentena"
P -q -c "UPDATE omie_products SET unidade='l ' WHERE omie_codigo_produto=201 AND account='oben';"
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "NORM1 'l ' vs 'L' entra no elegivel (btrim/upper)" "1" "$got"
P -q -c "UPDATE omie_products SET unidade='L' WHERE omie_codigo_produto=201 AND account='oben';"

echo "→ OVF. [Codex #6] dado LEGADO >18 dígitos (o trigger de cadastro barra novos; este simula pré-guard) NÃO derruba a view"
# O trigger sku_substituicao_consolidacao_guard já impede INSERT >18 díg. hoje; o fix #6 (regex {1,18})
# é defense-in-depth p/ dado legado que entrou ANTES do trigger. Desabilito o trigger p/ recriar esse dado.
P -q -c "ALTER TABLE sku_substituicao DISABLE TRIGGER sku_substituicao_consolidacao_guard;"
P -q -c "INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, status, acao_parametros, data_substituicao)
         VALUES ('OBEN','99999999999999999999','201','aplicada','consolidar_demanda', CURRENT_DATE);"
P -q -c "ALTER TABLE sku_substituicao ENABLE TRIGGER sku_substituicao_consolidacao_guard;"
# 2>&1 + '|| true' são intencionais: CAPTURAM se a view estourou (out-of-range) como valor testável;
# sem isso o set -e abortaria antes do assert. O assert falha se got<>'t' (regressão do regex {1,18}).
got=$(Pq -c "SELECT count(*) >= 0 FROM v_pcp_malha_oben_cand;" 2>&1 || true)
assert_eq "OVF1 codigo 20-digitos (legado) filtrado, view NAO quebra" "t" "$got"
P -q -c "DELETE FROM sku_substituicao WHERE sku_codigo_antigo='99999999999999999999';"

# ══════════════════════════════════════════════════════════════════════════
# Step 4: FALSIFICAÇÃO (sabotar → exigir vermelho)
# Um assert só vale se ele FALHA quando o guard some.
# ══════════════════════════════════════════════════════════════════════════
echo "→ SABOTAGEM S1: sem o guard de unidade, o par UN|M2 deve VAZAR (B1 quebraria)"
P -q -c "CREATE OR REPLACE VIEW v_pcp_malha_oben AS
         SELECT c.pai_oben, c.comp_oben, min(c.quantidade) AS quantidade, min(c.un_ficha) AS unidade
         FROM v_pcp_malha_oben_cand c
         WHERE c.n_pai_oben=1 AND c.n_comp_oben=1 AND c.pai_oben<>c.comp_oben
           AND c.quantidade>0 AND c.perc_perda=0 AND c.comp_ativo
         GROUP BY 1,2 HAVING count(DISTINCT c.quantidade)=1;"   -- SEM o guard de unidade
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE comp_oben=202;")
if [ "$got" = "0" ]; then
  echo "  ✗ SABOTAGEM S1 INÚTIL: o assert B1 não detecta a remoção do guard de unidade"; exit 1
fi
echo "  ✓ S1 ok (guard removido → par divergente vaza; logo B1 protege de verdade)"
PASS=$((PASS+1))

echo "→ SABOTAGEM S2: trocar o fail-closed de cardinalidade por 'sem guard' deve produzir COMPRA DOBRADA"
P -q -c "INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, unidade)
         VALUES (gen_random_uuid(), 998, 'PRD_BASE', 'BASE CLONE', 'oben', true, 'L');"
# baseline: com o fail-closed de cardinalidade AINDA intacto (view herdada de S1 —
# ainda tem n_pai_oben=1/n_comp_oben=1), o par 100→101 (200→201) que virou ambíguo
# com o clone 998 já deve ter sumido do elegível — mesma proteção do C1, provocada
# de novo. NÃO comparamos com uma contagem agregada não-relacionada (ela pode empatar
# por coincidência quando há outro par bloqueado por motivo diferente, como o
# comp=102 aqui, que a unidade M2≠UN barra em QUALQUER cenário) — comparamos o
# MESMO par, antes e depois da MESMA sabotagem (before/after == teste com dente).
base=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "S2 pre-condicao: clone 998 torna comp=101 ambiguo (view intacta ainda barra)" "0" "$base"
P -q -c "CREATE OR REPLACE VIEW v_pcp_malha_oben AS
         SELECT c.pai_oben, c.comp_oben, min(c.quantidade) AS quantidade, min(c.un_ficha) AS unidade
         FROM v_pcp_malha_oben_cand c
         WHERE c.pai_oben IS NOT NULL AND c.comp_oben IS NOT NULL   -- SEM n_*_oben = 1
           AND c.pai_oben<>c.comp_oben AND c.quantidade>0 AND c.perc_perda=0
           AND c.un_ficha=c.un_estoque AND c.comp_ativo
         GROUP BY 1,2 HAVING count(DISTINCT c.quantidade)=1;"
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
if [ "$got" -le "$base" ]; then
  echo "  ✗ SABOTAGEM S2 INÚTIL: remover o guard de cardinalidade não mudou o resultado"; exit 1
fi
echo "  ✓ S2 ok (sem fail-closed o codigo ambiguo entra → C1 protege de compra dobrada)"
PASS=$((PASS+1))
P -q -c "DELETE FROM omie_products WHERE omie_codigo_produto=998;"

# restaurar a versão real antes de seguir
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-demanda-insumos-bom.sql"

echo "→ pós-restauração: A1 volta a valer (prova que a sabotagem foi desfeita, não mascarada)"
got=$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")
assert_eq "RESTORE par limpo elegivel de novo apos desfazer S1/S2" "1" "$got"

# ══════════════════════════════════════════════════════════════════════════
# Step 5: v_sku_demanda_efetiva (Task 3) — explosão de BOM na DEMANDA.
# Reusa o bootstrap acima (catálogo colacor/oben, ficha do pai 100→200 com
# 0.9 L do insumo 101→201, já restaurada em FICHA_OK). Só ACRESCENTA vendas.
# ══════════════════════════════════════════════════════════════════════════
echo "→ semeando vendas (pai 200 tem ficha 0.9 L do insumo 201; sku 300 não tem ficha)"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, unidade)
VALUES (gen_random_uuid(), 300, 'PRD_SEMFICHA', 'PRODUTO SEM FICHA', 'oben', true, 'UN');

INSERT INTO venda_items_history
  (id, empresa, nfe_chave_acesso, data_emissao, sku_codigo_omie, sku_descricao,
   sku_unidade, quantidade, valor_unitario, valor_total, created_at)
VALUES
  (gen_random_uuid(),'OBEN','NFE-1', CURRENT_DATE - 10, 200, 'TINGIDOR X','UN', 1, 100, 100, now()),
  (gen_random_uuid(),'OBEN','NFE-2', CURRENT_DATE - 5,  200, 'TINGIDOR X','UN', 2, 100, 200, now()),
  (gen_random_uuid(),'OBEN','NFE-3', CURRENT_DATE - 3,  300, 'SEM FICHA','UN',  7, 10,   70, now());
SQL

echo "→ H. explosão: venda de 1 pai (qtde 1) com ficha 0.9 → exatamente 0.9 L do insumo"
got=$(Pq -c "SELECT quantidade FROM v_sku_demanda_efetiva
             WHERE sku_codigo_omie=201 AND nfe_chave_acesso='NFE-1';")
assert_eq "H1 explosao sem fan-out (0.9, nunca 1.8)" "0.9" "$got"

got=$(Pq -c "SELECT quantidade FROM v_sku_demanda_efetiva
             WHERE sku_codigo_omie=201 AND nfe_chave_acesso='NFE-2';")
assert_eq "H2 escala com a qtde do pai (2 x 0.9)" "1.8" "$got"

echo "→ I. NF herdada do pai (Codex #5 — sem isso num_ordens=0 e o insumo NUNCA gradua)"
got=$(Pq -c "SELECT count(DISTINCT nfe_chave_acesso) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201;")
assert_eq "I1 insumo herda 2 NFs distintas (gradua)" "2" "$got"

got=$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva
             WHERE sku_codigo_omie=201 AND nfe_chave_acesso IS NULL;")
assert_eq "I2 nenhuma linha sintetica sem NF" "0" "$got"

echo "→ J. valor NULL (V3: receita honesta, ausente≠zero)"
got=$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva
             WHERE sku_codigo_omie=201 AND (valor_total IS NOT NULL OR valor_unitario IS NOT NULL);")
assert_eq "J1 sem receita fabricada" "0" "$got"

got=$(Pq -c "SELECT COALESCE(sum(valor_total),0)::text FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201;")
assert_eq "J2 SUM(valor) do insumo = 0 (NULL ignorado, nao fabricado)" "0" "$got"

echo "→ K. unidade do INSUMO, não do pai (Codex #6)"
got=$(Pq -c "SELECT DISTINCT sku_unidade FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201;")
assert_eq "K1 unidade do insumo (L), nao 'UN' do pai" "L" "$got"

echo "→ L. venda direta preservada (passthrough intacto)"
got=$(Pq -c "SELECT quantidade FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=200 AND nfe_chave_acesso='NFE-1';")
assert_eq "L1 venda do pai intacta" "1" "$got"

echo "→ M. pai fora da malha não gera linha sintética"
got=$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=300;")
assert_eq "M1 sku sem ficha: so a venda direta" "1" "$got"

echo "→ N. id da linha sintética é único e determinístico"
got=$(Pq -c "SELECT count(*) - count(DISTINCT id) FROM v_sku_demanda_efetiva;")
assert_eq "N1 nenhum id duplicado" "0" "$got"

echo "→ SEC-DE. v_sku_demanda_efetiva é security_invoker (lê venda_items — dado sensível)"
got=$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname='v_sku_demanda_efetiva'
               AND c.reloptions @> ARRAY['security_invoker=true'];")
assert_eq "SEC-DE1 demanda efetiva é security_invoker" "1" "$got"

# ══════════════════════════════════════════════════════════════════════════
# Step 6: FALSIFICAÇÃO S3 — NF herdada do pai (o furo que mataria a feature:
# sem ela, num_ordens=count(DISTINCT nfe) conta 0 e o insumo NUNCA gradua).
# ══════════════════════════════════════════════════════════════════════════
echo "→ SABOTAGEM S3: com nfe_chave_acesso NULL no sintético, o insumo perde as ordens"
P -q -c "CREATE OR REPLACE VIEW v_sku_demanda_efetiva AS
  SELECT id, empresa, nfe_chave_acesso, nfe_numero, nfe_serie, data_emissao,
         cliente_codigo_omie, cliente_razao_social, cliente_cnpj_cpf, cliente_uf, cliente_cidade,
         sku_codigo_omie, sku_codigo, sku_descricao, sku_ncm, sku_unidade,
         quantidade, valor_unitario, valor_total, cfop, raw_data, created_at
  FROM v_venda_items_history_efetivo
  UNION ALL
  SELECT md5(v.id::text || ':' || mo.comp_oben::text)::uuid, v.empresa,
         NULL::text,                       -- ⬅ SABOTAGEM: NF nula
         v.nfe_numero, v.nfe_serie, v.data_emissao,
         v.cliente_codigo_omie, v.cliente_razao_social, v.cliente_cnpj_cpf, v.cliente_uf, v.cliente_cidade,
         mo.comp_oben, ins.codigo, ins.descricao, ins.ncm, ins.unidade,
         v.quantidade * mo.quantidade, NULL::numeric, NULL::numeric,
         v.cfop, v.raw_data, v.created_at
  FROM v_venda_items_history_efetivo v
  JOIN v_pcp_malha_oben mo ON mo.pai_oben = v.sku_codigo_omie
  JOIN omie_products ins ON ins.omie_codigo_produto = mo.comp_oben AND ins.account='oben'
  WHERE v.empresa='OBEN';"

got=$(Pq -c "SELECT count(DISTINCT nfe_chave_acesso) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201;")
if [ "$got" != "0" ]; then
  echo "  ✗ SABOTAGEM S3 INÚTIL: o assert I1 não detecta a perda da NF"; exit 1
fi
echo "  ✓ S3 ok (NF nula → 0 ordens distintas → o insumo ficaria preso em AGUARDANDO_SEGUNDA_ORDEM)"
PASS=$((PASS+1))

# restaurar a versão real
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-demanda-insumos-bom.sql"
got=$(Pq -c "SELECT count(DISTINCT nfe_chave_acesso) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201;")
assert_eq "S3r restaurado: 2 ordens de novo" "2" "$got"

# ══════════════════════════════════════════════════════════════════════════
# Step 7 (Task 4): prova de que o PR-1 é INERTE em produção.
#
# → P/Q/R são estruturais (pg_depend/pg_views/information_schema) — não dependem
#   de dado, então rodam aqui no fim, depois de toda a massa de teste dos Steps
#   1-6 (e já com as views restauradas à versão real pós-sabotagem).
#
# → O NÃO está aqui de propósito (ver comentário logo após a aplicação do
#   candidato, antes do Step 1) — checagem empírica confirmou que comparar
#   aqui no fim contamina o resultado com os fixtures de venda do Step 5
#   (v_sku_demanda_estatisticas/_sigma_demanda/_demanda_rajada leem
#   venda_items_history numa janela de 90/180d; os 2 SKUs vendidos no Step 5
#   caem nessa janela e apareceriam como diff=2 em cada uma — falso positivo
#   por ruído do fixture, não quebra de inércia).
# ══════════════════════════════════════════════════════════════════════════
echo "→ P. pg_depend: nada depende de v_sku_demanda_efetiva (é o que torna o PR-1 inerte)"
got=$(Pq -c "SELECT count(*) FROM pg_depend d
             JOIN pg_rewrite r ON r.oid=d.objid
             JOIN pg_class dep ON dep.oid=r.ev_class
             JOIN pg_class src ON src.oid=d.refobjid
             WHERE src.relname='v_sku_demanda_efetiva' AND dep.relname<>'v_sku_demanda_efetiva';")
assert_eq "P1 nenhuma view depende da nova (PR-1 inerte)" "0" "$got"

echo "→ Q. v_venda_items_history_efetivo NÃO foi recriada por este PR"
got=$(Pq -c "SELECT count(*) FROM pg_views
             WHERE viewname='v_venda_items_history_efetivo'
               AND definition ILIKE '%v_pcp_malha_oben%';")
assert_eq "Q1 a view de venda/preco segue intocada" "0" "$got"

echo "→ R. shape: v_sku_demanda_efetiva alinha coluna-a-coluna com v_venda_items_history_efetivo"
# O PR-2 troca só o FROM das 4 views estatísticas para a nova. Uma troca de posição
# entre colunas do MESMO tipo (ex.: nfe_numero↔nfe_serie, ambas text) passaria no
# UNION ALL mas corromperia o dado — este assert estrutural pega isso (fecha o Menor
# do review da Task 3, que os asserts por valor não cobrem).
got=$(Pq -c "
  SELECT count(*) FROM (
    (SELECT ordinal_position, column_name, data_type FROM information_schema.columns
       WHERE table_name='v_venda_items_history_efetivo'
     EXCEPT
     SELECT ordinal_position, column_name, data_type FROM information_schema.columns
       WHERE table_name='v_sku_demanda_efetiva')
    UNION ALL
    (SELECT ordinal_position, column_name, data_type FROM information_schema.columns
       WHERE table_name='v_sku_demanda_efetiva'
     EXCEPT
     SELECT ordinal_position, column_name, data_type FROM information_schema.columns
       WHERE table_name='v_venda_items_history_efetivo')
  ) d;")
assert_eq "R1 shape identico (posicao+nome+tipo) — pré-requisito do PR-2" "0" "$got"

echo ""
echo "PASS=$PASS"
echo "✅ demanda de insumos via BOM (v_pcp_malha_oben + v_sku_demanda_efetiva): guards + quarentena + explosão + falsificação OK"
