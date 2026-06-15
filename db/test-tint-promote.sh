#!/usr/bin/env bash
# Teste PG17 da promoção staging→oficial do sync SayerSystem (oráculo executável).
# Aplica schema-snapshot + as migrations 20260609150000_tint_sync_promote.sql E
# 20260611190000_tint_sync_codex_fixes.sql NA ORDEM (idêntico a prod), semeia cenários
# controlados em tint_staging_* e roda tint_promote_sync_run / tint_apply_keys_snapshot,
# asserindo a equivalência com o oráculo src/lib/tint/sync-promote.ts:
#   - regra de 3 (expandirFormula: fator=vol_destino/vol_formulacao)
#   - preço pág 9 (precoFinalSayer: base×(1+imp)×(1+marg) + Σ corantes/ml; NULL honesto)
#   - blast radius (validarSnapshotKeys: 50%/20%) com CHAVE-FONTE de 4 partes (S4)
#   - recálculo por insumo (P1-A), latest-per-key (P1-C), re-expansão por sku novo (P1-C),
#     guardas (vol<=0, zero vendáveis), desativação/reativação, idempotência.
#   - C11: corante só-descrição (linha nova NULL custo/volume) não regride preço (S3).
#   - C12: lookup de precos_base respeita store_code (S2: sem vazamento cross-store).
# Base: db/verify-snapshot-replay.sh / db/test-minimo-forcado.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5435
DATA="$(mktemp -d /tmp/pgtest-tintpromote.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-tintpromote.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres tintpromote_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d tintpromote_verify "$@"; }

RR="$(mktemp /tmp/snap-tintpromote.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ migration 20260609150000_tint_sync_promote.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260609150000_tint_sync_promote.sql" >/dev/null

echo "→ migration 20260611190000_tint_sync_codex_fixes.sql (na ordem de prod)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611190000_tint_sync_codex_fixes.sql" >/dev/null

echo "→ migration 20260615140000_tint_promote_indices_timeout.sql (índices + timeout)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260615140000_tint_promote_indices_timeout.sql" >/dev/null

# PRESERVA o loop PROCEDURAL (a versão 20260611190000) como ORÁCULO diferencial: rename ANTES de
# aplicar a set-based. O CENÁRIO 13 roda os DOIS sobre o MESMO seed e exige resultado idêntico.
echo "→ preserva o loop antigo como tint_promote_sync_run_oldloop (oráculo diferencial)…"
P -v ON_ERROR_STOP=1 -q -c "ALTER FUNCTION public.tint_promote_sync_run(uuid) RENAME TO tint_promote_sync_run_oldloop;" >/dev/null

echo "→ migration 20260615160000_tint_promote_set_based.sql (a reescrita sob teste)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260615160000_tint_promote_set_based.sql" >/dev/null

# ─────────────────────────────────────────────────────────────────────────────
# Helpers de seed: monta um setting + runs, e semeia staging. UUIDs determinísticos.
# ─────────────────────────────────────────────────────────────────────────────
echo "→ setting + cenários base…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Setting da loja (account oben, store L1), modo automatic_primary.
INSERT INTO tint_integration_settings (id, account, store_code, integration_mode, sync_token, sync_enabled)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','automatic_primary','tok_test', true);
SQL

echo ""
echo "════════ CENÁRIO 1 — Expansão (regra de 3) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Run de catálogo: produto P1, base B1, embalagens 900 e 3600 (ambas vendáveis).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','P1','Produto 1');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','B1','Base 1');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','E900','Galão 900',900),
       ('11111111-0000-0000-0000-000000000001','oben','L1','E3600','Balde 3600',3600);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('11111111-0000-0000-0000-000000000001','oben','L1','P1','B1','E900'),
       ('11111111-0000-0000-0000-000000000001','oben','L1','P1','B1','E3600');
-- Run de fórmula: formulação 900ml, itens AX=12.5 VM=3.2.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('11111111-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada)
VALUES ('ff111111-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000002','oben','L1','COR1','Azul','P1','B1','E900',900,false);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('11111111-0000-0000-0000-000000000002','ff111111-0000-0000-0000-000000000001','AX',1,12.5),
       ('11111111-0000-0000-0000-000000000002','ff111111-0000-0000-0000-000000000001','VM',2,3.2);
-- Promove catálogo depois fórmulas.
SELECT tint_promote_sync_run('11111111-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('11111111-0000-0000-0000-000000000002');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n int; q900 numeric; q3600_ax numeric; q3600_vm numeric; v3600 numeric;
BEGIN
  SELECT count(*) INTO n FROM tint_formulas WHERE account='oben' AND cor_id='COR1';
  IF n <> 2 THEN RAISE EXCEPTION 'C1.1 FALHOU: esperado 2 fórmulas (900+3600), achei %', n; END IF;

  -- item AX na embalagem 900 = 12.5 (fator 1)
  SELECT fi.qtd_ml INTO q900 FROM tint_formula_itens fi
    JOIN tint_formulas f ON f.id=fi.formula_id
    JOIN tint_embalagens e ON e.id=f.embalagem_id
    JOIN tint_corantes c ON c.id=fi.corante_id
    WHERE f.cor_id='COR1' AND e.id_embalagem_sayersystem='E900' AND c.id_corante_sayersystem='AX';
  IF q900 <> 12.5 THEN RAISE EXCEPTION 'C1.2 FALHOU: AX@900 = % (esperado 12.5)', q900; END IF;

  -- item AX na embalagem 3600 = 50 (12.5 × 4)
  SELECT fi.qtd_ml INTO q3600_ax FROM tint_formula_itens fi
    JOIN tint_formulas f ON f.id=fi.formula_id
    JOIN tint_embalagens e ON e.id=f.embalagem_id
    JOIN tint_corantes c ON c.id=fi.corante_id
    WHERE f.cor_id='COR1' AND e.id_embalagem_sayersystem='E3600' AND c.id_corante_sayersystem='AX';
  IF q3600_ax <> 50 THEN RAISE EXCEPTION 'C1.3 FALHOU: AX@3600 = % (esperado 50)', q3600_ax; END IF;

  -- item VM na 3600 = 12.8 (3.2 × 4)
  SELECT fi.qtd_ml INTO q3600_vm FROM tint_formula_itens fi
    JOIN tint_formulas f ON f.id=fi.formula_id
    JOIN tint_embalagens e ON e.id=f.embalagem_id
    JOIN tint_corantes c ON c.id=fi.corante_id
    WHERE f.cor_id='COR1' AND e.id_embalagem_sayersystem='E3600' AND c.id_corante_sayersystem='VM';
  IF round(q3600_vm,6) <> 12.8 THEN RAISE EXCEPTION 'C1.4 FALHOU: VM@3600 = % (esperado 12.8)', q3600_vm; END IF;

  -- volume_final_ml da 3600
  SELECT volume_final_ml INTO v3600 FROM tint_formulas f
    JOIN tint_embalagens e ON e.id=f.embalagem_id
    WHERE f.cor_id='COR1' AND e.id_embalagem_sayersystem='E3600';
  IF v3600 <> 3600 THEN RAISE EXCEPTION 'C1.5 FALHOU: volume_final_ml = % (esperado 3600)', v3600; END IF;

  RAISE NOTICE 'OK C1 — expansão: 2 fórmulas; AX@900=12.5 AX@3600=50 VM@3600=12.8 vol=3600';
END $$;
SQL

echo ""
echo "════════ CENÁRIO 2 — Preço pág 9 (196.11 + NULL honesto) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Produto P2/base B2/embalagem E900b (vendável, 900ml). Preço: custo=100 imp=30 marg=50.
-- Corante AXP custo=200 vol=900. Item 5ml na FORMULAÇÃO de 900ml (fator 1 → 5ml expandido).
-- 195 + (200/900)*5 = 196.111… → 196.11.  Corante ZZP sem preço numa OUTRA fórmula → NULL.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('22222222-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','P2','Produto 2');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','B2','Base 2');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','E900B','Galão 900b',900);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','P2','B2','E900B');
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, custo, volume_ml)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','AXP','Corante AXP',200,900);
-- ZZP corante SEM custo/volume (referenciado por uma fórmula → preço NULL).
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','ZZP','Corante ZZP sem preco');
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','P2','B2','E900B',100,30,50);

INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('22222222-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
-- Fórmula COR2 usa AXP (tem preço) → 196.11
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada)
VALUES ('ff222222-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002','oben','L1','COR2','Verde','P2','B2','E900B',900,false);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('22222222-0000-0000-0000-000000000002','ff222222-0000-0000-0000-000000000001','AXP',1,5);
-- Fórmula COR2Z usa ZZP (sem preço) → NULL (mesma base/preço de base, item sem corante-preço)
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada)
VALUES ('ff222222-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000002','oben','L1','COR2Z','Verde Z','P2','B2','E900B',900,false);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('22222222-0000-0000-0000-000000000002','ff222222-0000-0000-0000-000000000002','ZZP',1,5);

-- custo_base=0 é VÁLIDO (≠ ausente): preço = só corantes. Base B2K/emb E900K, custo=0 imp=30 marg=50.
-- Fórmula COR2K usa AXP 9ml → (200/900)*9 = 2.00 (espelho do teste do oráculo custo:0 → 2).
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','B2K','Base 2K');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','E900K','Galão 900k',900);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','P2','B2K','E900K');
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct)
VALUES ('22222222-0000-0000-0000-000000000001','oben','L1','P2','B2K','E900K',0,30,50);
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada)
VALUES ('ff222222-0000-0000-0000-000000000003','22222222-0000-0000-0000-000000000002','oben','L1','COR2K','Custo Zero','P2','B2K','E900K',900,false);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('22222222-0000-0000-0000-000000000002','ff222222-0000-0000-0000-000000000003','AXP',1,9);

SELECT tint_promote_sync_run('22222222-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('22222222-0000-0000-0000-000000000002');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE p numeric; pz numeric; pz_is_null boolean; pk numeric;
BEGIN
  SELECT preco_final_sayersystem INTO p FROM tint_formulas WHERE account='oben' AND cor_id='COR2';
  IF p IS NULL OR p <> 196.11 THEN RAISE EXCEPTION 'C2.1 FALHOU: preço COR2 = % (esperado 196.11)', p; END IF;

  SELECT preco_final_sayersystem, preco_final_sayersystem IS NULL INTO pz, pz_is_null
    FROM tint_formulas WHERE account='oben' AND cor_id='COR2Z';
  IF NOT pz_is_null THEN RAISE EXCEPTION 'C2.2 FALHOU: COR2Z deveria ter preço NULL (corante sem preço), achei %', pz; END IF;

  -- custo_base=0 (≠ ausente): preço = só corantes = (200/900)*9 = 2.00
  SELECT preco_final_sayersystem INTO pk FROM tint_formulas WHERE account='oben' AND cor_id='COR2K';
  IF pk IS NULL OR pk <> 2 THEN RAISE EXCEPTION 'C2.3 FALHOU: COR2K (custo_base=0) = % (esperado 2.00 = só corantes, NÃO NULL)', pk; END IF;

  RAISE NOTICE 'OK C2 — preço pág 9: COR2=196.11; COR2Z=NULL (corante sem preço); COR2K=2.00 (custo_base=0 válido)';
END $$;
SQL

echo ""
echo "════════ CENÁRIO 3 — Recálculo por insumo (P1-A) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Novo run SÓ de precos_base p/ P2/B2/E900B muda custo 100→200.
-- Novo preço base = 200×1.3×1.5 = 390; + (200/900)*5 = 391.111 → 391.11. Itens INTACTOS.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('33333333-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct)
VALUES ('33333333-0000-0000-0000-000000000001','oben','L1','P2','B2','E900B',200,30,50);
SELECT tint_promote_sync_run('33333333-0000-0000-0000-000000000001');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE p numeric; n_itens int; q numeric;
BEGIN
  SELECT preco_final_sayersystem INTO p FROM tint_formulas WHERE account='oben' AND cor_id='COR2';
  IF p IS NULL OR p <> 391.11 THEN RAISE EXCEPTION 'C3.1 FALHOU: preço recalculado COR2 = % (esperado 391.11)', p; END IF;
  -- itens intactos: AXP 5ml
  SELECT count(*) INTO n_itens FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.cor_id='COR2';
  SELECT fi.qtd_ml INTO q FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.cor_id='COR2';
  IF n_itens <> 1 OR q <> 5 THEN RAISE EXCEPTION 'C3.2 FALHOU: itens de COR2 mudaram (n=% q=%, esperado 1/5)', n_itens, q; END IF;
  RAISE NOTICE 'OK C3 — recálculo por insumo (precos_base): COR2 100→200 custo ⇒ preço 196.11→391.11; itens intactos';
END $$;
SQL

echo "  → 3b: recálculo pelo CORANTE (P1-A — o outro ramo de E4)"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Novo run SÓ de corante: AXP custo 200→400, vol 900 (precos_base segue 200 → base 390).
-- COR2 usa AXP 5ml: base 390 + (400/900)*5 = 392.222 → 392.22 (itens intactos).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('33333333-0000-0000-0000-0000000000b0','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, custo, volume_ml)
VALUES ('33333333-0000-0000-0000-0000000000b0','oben','L1','AXP','Corante AXP',400,900);
SELECT tint_promote_sync_run('33333333-0000-0000-0000-0000000000b0');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE p numeric; q numeric;
BEGIN
  SELECT preco_final_sayersystem INTO p FROM tint_formulas WHERE account='oben' AND cor_id='COR2';
  IF p IS NULL OR p <> 392.22 THEN RAISE EXCEPTION 'C3b.1 FALHOU: preço recalculado por corante COR2 = % (esperado 392.22)', p; END IF;
  SELECT fi.qtd_ml INTO q FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.cor_id='COR2';
  IF q <> 5 THEN RAISE EXCEPTION 'C3b.2 FALHOU: item de COR2 mudou (q=%, esperado 5)', q; END IF;
  RAISE NOTICE 'OK C3b — recálculo por corante: AXP 200→400 ⇒ COR2 preço 391.11→392.22; itens intactos';
END $$;
SQL

echo ""
echo "════════ CENÁRIO 4 — Latest-per-key (P1-C): run velho aplicado DEPOIS do novo ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Produto P4/base B4/emb E900d. Dois runs de precos_base p/ a MESMA chave, custos diferentes.
-- RUN_NOVO (created_at mais recente) custo=300; RUN_VELHO custo=100.
-- Promover o RUN_VELHO por ÚLTIMO deve manter o valor do staging MAIS RECENTE (custo 300).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('44444444-0000-0000-0000-000000000000','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('44444444-0000-0000-0000-000000000000','oben','L1','P4','Produto 4');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('44444444-0000-0000-0000-000000000000','oben','L1','B4','Base 4');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('44444444-0000-0000-0000-000000000000','oben','L1','E900D','Galão 900d',900);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('44444444-0000-0000-0000-000000000000','oben','L1','P4','B4','E900D');
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('44444444-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada)
VALUES ('ff444444-0000-0000-0000-000000000001','44444444-0000-0000-0000-000000000001','oben','L1','COR4','Roxo','P4','B4','E900D',900,false);
-- sem itens (preço = só base, simplifica o assert).

-- RUN_VELHO custo=100 (created_at antigo)
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, created_at)
VALUES ('44444444-0000-0000-0000-0000000000a0','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete', now() - interval '2 hours');
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct, created_at)
VALUES ('44444444-0000-0000-0000-0000000000a0','oben','L1','P4','B4','E900D',100,0,0, now() - interval '2 hours');
-- RUN_NOVO custo=300 (created_at recente)
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, created_at)
VALUES ('44444444-0000-0000-0000-0000000000b0','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete', now());
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct, created_at)
VALUES ('44444444-0000-0000-0000-0000000000b0','oben','L1','P4','B4','E900D',300,0,0, now());

-- Promove catálogo + a fórmula primeiro (preço sai do staging mais recente = 300).
SELECT tint_promote_sync_run('44444444-0000-0000-0000-000000000000');
SELECT tint_promote_sync_run('44444444-0000-0000-0000-000000000001');
-- Agora promove o RUN_VELHO por ÚLTIMO: deve usar o latest-per-key (custo 300), não o 100 do próprio run.
SELECT tint_promote_sync_run('44444444-0000-0000-0000-0000000000a0');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE p numeric;
BEGIN
  SELECT preco_final_sayersystem INTO p FROM tint_formulas WHERE account='oben' AND cor_id='COR4';
  -- 300×1×1 (imp/marg 0) = 300; sem itens.
  IF p IS NULL OR p <> 300 THEN RAISE EXCEPTION 'C4.1 FALHOU: preço COR4 = % (esperado 300 = staging MAIS RECENTE, não 100 do run velho)', p; END IF;
  RAISE NOTICE 'OK C4 — latest-per-key: run velho (custo 100) aplicado por último ⇒ preço fica 300 (staging recente)';
END $$;
SQL

echo ""
echo "════════ CENÁRIO 5 — Re-expansão por sku novo (P1-C) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Reusa P1/B1/COR1 (cenário 1, já com 900+3600). Chega uma embalagem NOVA E5L (5000ml) vendável.
-- A promoção do catálogo (sku novo do par P1/B1) deve RE-EXPANDIR COR1 → cria a fórmula da E5L.
-- A FORMULA não muda (data_atualizacao não mudou) → o gatilho é o sku novo.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('55555555-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('55555555-0000-0000-0000-000000000001','oben','L1','E5L','Balde 5L',5000);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('55555555-0000-0000-0000-000000000001','oben','L1','P1','B1','E5L');
SELECT tint_promote_sync_run('55555555-0000-0000-0000-000000000001');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n int; q5l numeric;
BEGIN
  SELECT count(*) INTO n FROM tint_formulas WHERE account='oben' AND cor_id='COR1';
  IF n <> 3 THEN RAISE EXCEPTION 'C5.1 FALHOU: esperado 3 fórmulas COR1 (900/3600/5000), achei %', n; END IF;
  -- AX na E5L = 12.5 × (5000/900) = 69.444…
  SELECT fi.qtd_ml INTO q5l FROM tint_formula_itens fi
    JOIN tint_formulas f ON f.id=fi.formula_id
    JOIN tint_embalagens e ON e.id=f.embalagem_id
    JOIN tint_corantes c ON c.id=fi.corante_id
    WHERE f.cor_id='COR1' AND e.id_embalagem_sayersystem='E5L' AND c.id_corante_sayersystem='AX';
  IF round(q5l,4) <> round(12.5 * 5000.0/900.0, 4) THEN RAISE EXCEPTION 'C5.2 FALHOU: AX@5L = % (esperado %)', q5l, round(12.5*5000.0/900.0,4); END IF;
  RAISE NOTICE 'OK C5 — re-expansão por sku novo: COR1 ganhou a fórmula da E5L (3 no total); AX@5L=%', round(q5l,4);
END $$;
SQL

echo ""
echo "════════ CENÁRIO 6 — Guardas (vol<=0, zero vendáveis) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- 6a) vol_formulacao = 0 → não promove + erro.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('66666666-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('66666666-0000-0000-0000-000000000001','oben','L1','P6','Produto 6');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('66666666-0000-0000-0000-000000000001','oben','L1','B6','Base 6');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('66666666-0000-0000-0000-000000000001','oben','L1','E6','Galão 6',900);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('66666666-0000-0000-0000-000000000001','oben','L1','P6','B6','E6');
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('66666666-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada)
VALUES ('ff666666-0000-0000-0000-000000000001','66666666-0000-0000-0000-000000000002','oben','L1','COR6','Vol0','P6','B6','E6',0,false);
-- 6b) zero vendáveis: produto P7/base B7 SEM sku → fórmula COR7 não promove + erro.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('66666666-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('66666666-0000-0000-0000-000000000003','oben','L1','P7','Produto 7');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('66666666-0000-0000-0000-000000000003','oben','L1','B7','Base 7');
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('66666666-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada)
VALUES ('ff666666-0000-0000-0000-000000000002','66666666-0000-0000-0000-000000000004','oben','L1','COR7','SemVendavel','P7','B7','E6',900,false);

SELECT tint_promote_sync_run('66666666-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('66666666-0000-0000-0000-000000000002');
SELECT tint_promote_sync_run('66666666-0000-0000-0000-000000000003');
SELECT tint_promote_sync_run('66666666-0000-0000-0000-000000000004');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n6 int; n7 int; e6 int; e7 int;
BEGIN
  SELECT count(*) INTO n6 FROM tint_formulas WHERE account='oben' AND cor_id='COR6';
  IF n6 <> 0 THEN RAISE EXCEPTION 'C6.1 FALHOU: COR6 (vol=0) promoveu % fórmulas (esperado 0)', n6; END IF;
  SELECT count(*) INTO e6 FROM tint_sync_errors WHERE sync_run_id='66666666-0000-0000-0000-000000000002' AND entity_type='formula_promote';
  IF e6 < 1 THEN RAISE EXCEPTION 'C6.2 FALHOU: COR6 (vol=0) não gerou tint_sync_errors'; END IF;

  SELECT count(*) INTO n7 FROM tint_formulas WHERE account='oben' AND cor_id='COR7';
  IF n7 <> 0 THEN RAISE EXCEPTION 'C6.3 FALHOU: COR7 (zero vendáveis) promoveu % fórmulas (esperado 0)', n7; END IF;
  SELECT count(*) INTO e7 FROM tint_sync_errors WHERE sync_run_id='66666666-0000-0000-0000-000000000004' AND entity_type='formula_promote';
  IF e7 < 1 THEN RAISE EXCEPTION 'C6.4 FALHOU: COR7 (zero vendáveis) não gerou tint_sync_errors'; END IF;

  RAISE NOTICE 'OK C6 — guardas: vol=0 e zero-vendáveis não promovem + logam em tint_sync_errors';
END $$;
SQL

echo ""
echo "════════ CENÁRIO 7 — Keys-snapshot CHAVE-FONTE 4 partes (completo / incompleto / blast / reativação) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Estado atual: 7 LINHAS oficiais ativas (oben) — COR1×3 (E900/E3600/E5L), COR2, COR2Z, COR2K, COR4 —
-- mas a chave-fonte (S4) é de 4 partes SEM embalagem → COR1 colapsa em 1 chave:
--   5 CHAVES DISTINTAS: COR1|P1|B1|false, COR2|P2|B2|false, COR2Z|P2|B2|false, COR2K|P2|B2K|false, COR4|P4|B4|false.
-- O blast radius (50%/20%) é sobre chaves DISTINTAS; a desativação marca TODAS as expansões da chave.
-- 7a) INCOMPLETO: snapshot com total_chunks=2 mas só 1 chunk → ABORTA, nada desativa.
INSERT INTO tint_keys_snapshots (setting_id, account, store_code, snapshot_id, entity, generated_at, total_chunks, chunk_index, keys)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','77777777-0000-0000-0000-000000000001','formulas', now(), 2, 0, '["x"]'::jsonb);
-- 7b) BLAST: snapshot completo mas com 1 chave-fonte só (oficial tem 5 distintas → 1 < 50% → ABORTA).
INSERT INTO tint_keys_snapshots (setting_id, account, store_code, snapshot_id, entity, generated_at, total_chunks, chunk_index, keys)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','77777777-0000-0000-0000-000000000002','formulas', now(), 1, 0, '["COR1|P1|B1|false"]'::jsonb);
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
SELECT tint_apply_keys_snapshot('77777777-0000-0000-0000-000000000001') AS incompleto;
SELECT tint_apply_keys_snapshot('77777777-0000-0000-0000-000000000002') AS blast;
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n_ativas int;
BEGIN
  -- 7 LINHAS oficiais intactas (nada desativado); blast é sobre as 5 chaves-fonte distintas.
  SELECT count(*) INTO n_ativas FROM tint_formulas WHERE account='oben' AND desativada_em IS NULL;
  IF n_ativas <> 7 THEN RAISE EXCEPTION 'C7.1 FALHOU: snapshot incompleto/blast desativou (linhas ativas=%, esperado 7 intactas)', n_ativas; END IF;
  IF NOT EXISTS (SELECT 1 FROM tint_sync_errors WHERE entity_id='77777777-0000-0000-0000-000000000001' AND error_message LIKE '%incompleto%') THEN
    RAISE EXCEPTION 'C7.2 FALHOU: snapshot incompleto não logou erro'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tint_sync_errors WHERE entity_id='77777777-0000-0000-0000-000000000002' AND error_message LIKE '%blast%') THEN
    RAISE EXCEPTION 'C7.3 FALHOU: snapshot blast (1 chave-fonte, abaixo da metade de 5) não logou erro'; END IF;
  RAISE NOTICE 'OK C7a — incompleto + blast (chave-fonte 4 partes) abortam (7 linhas intactas, 2 erros logados)';
END $$;
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- 7c) COMPLETO e SAUDÁVEL: snapshot com 4 das 5 CHAVES-FONTE (deixa a chave de COR2Z de fora →
--     desativa só a LINHA da COR2Z). A chave COR1|P1|B1|false cobre as 3 expansões de COR1 (nenhuma
--     desativa). 4/5=80% das chaves (>50%); desativaria 1/5=20% (NÃO >20%) → passa.
INSERT INTO tint_keys_snapshots (setting_id, account, store_code, snapshot_id, entity, generated_at, total_chunks, chunk_index, keys)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','L1','77777777-0000-0000-0000-000000000003','formulas', now(), 1, 0,
  jsonb_build_array(
    'COR1|P1|B1|false','COR2|P2|B2|false','COR2K|P2|B2K|false','COR4|P4|B4|false'
  ));
SELECT tint_apply_keys_snapshot('77777777-0000-0000-0000-000000000003') AS saudavel;
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE z_desativada boolean; n_ativas int; n_cor1 int;
BEGIN
  SELECT desativada_em IS NOT NULL INTO z_desativada FROM tint_formulas WHERE account='oben' AND cor_id='COR2Z';
  IF NOT z_desativada THEN RAISE EXCEPTION 'C7.4 FALHOU: COR2Z deveria estar desativada (chave-fonte fora do snapshot)'; END IF;
  -- as 3 expansões de COR1 (chave única no snapshot) seguem TODAS ativas — prova do collapse 4 partes.
  SELECT count(*) INTO n_cor1 FROM tint_formulas WHERE account='oben' AND cor_id='COR1' AND desativada_em IS NULL;
  IF n_cor1 <> 3 THEN RAISE EXCEPTION 'C7.4b FALHOU: COR1 (chave única) deveria manter 3 expansões ativas, achei %', n_cor1; END IF;
  SELECT count(*) INTO n_ativas FROM tint_formulas WHERE account='oben' AND desativada_em IS NULL;
  IF n_ativas <> 6 THEN RAISE EXCEPTION 'C7.5 FALHOU: esperado 6 linhas ativas após desativar COR2Z, achei %', n_ativas; END IF;
  RAISE NOTICE 'OK C7b — snapshot saudável (chave-fonte 4 partes) desativou só COR2Z; COR1×3 intacto (6 ativas)';
END $$;
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- 7d) REATIVAÇÃO: COR2Z volta no staging → a promoção re-promove e zera desativada_em.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('77777777-0000-0000-0000-0000000000d0','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada)
VALUES ('ff222222-0000-0000-0000-0000000000d0','77777777-0000-0000-0000-0000000000d0','oben','L1','COR2Z','Verde Z volta','P2','B2','E900B',900,false);
-- (sem itens; preço base reusa precos_base 200 do cenário 3 → 390)
SELECT tint_promote_sync_run('77777777-0000-0000-0000-0000000000d0');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE z_ativa boolean; n_ativas int;
BEGIN
  SELECT desativada_em IS NULL INTO z_ativa FROM tint_formulas WHERE account='oben' AND cor_id='COR2Z';
  IF NOT z_ativa THEN RAISE EXCEPTION 'C7.6 FALHOU: COR2Z deveria reativar (desativada_em NULL) ao voltar no staging'; END IF;
  SELECT count(*) INTO n_ativas FROM tint_formulas WHERE account='oben' AND desativada_em IS NULL;
  IF n_ativas <> 7 THEN RAISE EXCEPTION 'C7.7 FALHOU: esperado 7 ativas após reativar COR2Z, achei %', n_ativas; END IF;
  RAISE NOTICE 'OK C7c — reativação: COR2Z voltou no staging ⇒ desativada_em=NULL (7 ativas)';
END $$;
SQL

echo ""
echo "════════ CENÁRIO 8 — Idempotência (rodar 2× = mesmo estado) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Snapshot do estado atual (tabela NÃO-temp: sobrevive entre conexões psql).
DROP TABLE IF EXISTS _antes_idem;
CREATE TABLE _antes_idem AS
  SELECT
    (SELECT count(*) FROM tint_formulas WHERE account='oben') AS n_formulas,
    (SELECT count(*) FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.account='oben') AS n_itens,
    (SELECT COALESCE(sum(preco_final_sayersystem),0) FROM tint_formulas WHERE account='oben') AS soma_precos,
    (SELECT COALESCE(sum(qtd_ml),0) FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.account='oben') AS soma_qtd;
-- Re-roda TODOS os runs de promoção (catálogo + fórmulas + preços) na ordem original.
SELECT tint_promote_sync_run('11111111-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('11111111-0000-0000-0000-000000000002');
SELECT tint_promote_sync_run('22222222-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('22222222-0000-0000-0000-000000000002');
SELECT tint_promote_sync_run('33333333-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('44444444-0000-0000-0000-000000000000');
SELECT tint_promote_sync_run('44444444-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('55555555-0000-0000-0000-000000000001');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE a record; b record;
BEGIN
  SELECT * INTO a FROM _antes_idem;
  SELECT
    (SELECT count(*) FROM tint_formulas WHERE account='oben') AS n_formulas,
    (SELECT count(*) FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.account='oben') AS n_itens,
    (SELECT COALESCE(sum(preco_final_sayersystem),0) FROM tint_formulas WHERE account='oben') AS soma_precos,
    (SELECT COALESCE(sum(qtd_ml),0) FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.account='oben') AS soma_qtd
  INTO b;
  IF a.n_formulas <> b.n_formulas THEN RAISE EXCEPTION 'C8.1 FALHOU: n_formulas mudou % → %', a.n_formulas, b.n_formulas; END IF;
  IF a.n_itens <> b.n_itens THEN RAISE EXCEPTION 'C8.2 FALHOU: n_itens mudou % → %', a.n_itens, b.n_itens; END IF;
  IF round(a.soma_precos,2) <> round(b.soma_precos,2) THEN RAISE EXCEPTION 'C8.3 FALHOU: soma_precos mudou % → %', a.soma_precos, b.soma_precos; END IF;
  IF round(a.soma_qtd,4) <> round(b.soma_qtd,4) THEN RAISE EXCEPTION 'C8.4 FALHOU: soma_qtd mudou % → %', a.soma_qtd, b.soma_qtd; END IF;
  RAISE NOTICE 'OK C8 — idempotência: re-rodar todos os runs = estado idêntico (formulas=% itens=% Σpreço=% Σqtd=%)',
    b.n_formulas, b.n_itens, round(b.soma_precos,2), round(b.soma_qtd,4);
END $$;
SQL

echo ""
echo "════════ CENÁRIO 9 — Purge preserva latest-per-key (P2-1) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Produto P9/base B9/emb E900i (vendável). Um INSUMO (precos_base) com DUAS linhas pra MESMA
-- chave: a VELHA (>30d, custo 100) e a NOVA (recente, custo 500). O insumo "não muda há >30d"
-- na vida real seria a linha mais nova já com >30d — aqui forçamos a NOVA a também ser >30d
-- pra provar que o purge a PRESERVA (é a latest da chave) e só apaga a VELHA superseded.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('99999999-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('99999999-0000-0000-0000-000000000001','oben','L1','P9','Produto 9');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('99999999-0000-0000-0000-000000000001','oben','L1','B9','Base 9');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('99999999-0000-0000-0000-000000000001','oben','L1','E900I','Galão 900i',900);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('99999999-0000-0000-0000-000000000001','oben','L1','P9','B9','E900I');
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('99999999-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada)
VALUES ('ff999999-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000002','oben','L1','COR9','Insumo','P9','B9','E900I',900,false);
-- (sem itens; preço = só base → fácil de assertar)

-- VELHA superseded (>30d, custo 100) — DEVE ser apagada pelo purge.
INSERT INTO tint_staging_precos_base (id, sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct, created_at)
VALUES ('cb999999-0000-0000-0000-0000000000a0','99999999-0000-0000-0000-000000000001','oben','L1','P9','B9','E900I',100,0,0, now() - interval '40 days');
-- NOVA latest (>30d também, custo 500) — DEVE SOBREVIVER (é a mais recente da chave).
INSERT INTO tint_staging_precos_base (id, sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct, created_at)
VALUES ('cb999999-0000-0000-0000-0000000000b0','99999999-0000-0000-0000-000000000001','oben','L1','P9','B9','E900I',500,0,0, now() - interval '31 days');

-- Promove catálogo + fórmula. A promoção (que roda o purge no fim) apaga a VELHA, mantém a NOVA.
SELECT tint_promote_sync_run('99999999-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('99999999-0000-0000-0000-000000000002');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE velha_existe boolean; nova_existe boolean; p numeric;
BEGIN
  -- A VELHA superseded foi apagada; a NOVA latest sobreviveu.
  SELECT EXISTS(SELECT 1 FROM tint_staging_precos_base WHERE id='cb999999-0000-0000-0000-0000000000a0') INTO velha_existe;
  SELECT EXISTS(SELECT 1 FROM tint_staging_precos_base WHERE id='cb999999-0000-0000-0000-0000000000b0') INTO nova_existe;
  IF velha_existe THEN RAISE EXCEPTION 'C9.1 FALHOU: linha VELHA superseded (>30d) NÃO foi apagada pelo purge'; END IF;
  IF NOT nova_existe THEN RAISE EXCEPTION 'C9.2 FALHOU: linha NOVA latest (>30d) foi APAGADA — purge quebrou latest-per-key'; END IF;

  -- E o recalc por insumo DEPENDE dela: novo run de precos_base "vazio" não há; mas um recalc
  -- via um run que toca o corante/preço precisa achar a base. Provamos que a base latest persiste
  -- disparando um recálculo: novo run de precos_base reusa a chave? Mais simples: a fórmula promovida
  -- já saiu com 500 (a latest), provando que a promoção leu a NOVA, não a VELHA.
  SELECT preco_final_sayersystem INTO p FROM tint_formulas WHERE account='oben' AND cor_id='COR9';
  IF p IS NULL OR p <> 500 THEN RAISE EXCEPTION 'C9.3 FALHOU: COR9 preço = % (esperado 500 = custo da linha NOVA latest)', p; END IF;
  RAISE NOTICE 'OK C9 — purge: apaga VELHA superseded (>30d), PRESERVA NOVA latest (>30d); COR9 preço=500 (leu a latest)';
END $$;
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- C9b: prova que um RECALC posterior (run que toca SÓ o corante) ainda acha a base latest
-- preservada — se o purge tivesse apagado a base, o recalc viraria NULL (insumo ausente).
-- COR9 não tem corantes → adicionamos um run de corante "fantasma" não muda nada; em vez disso
-- forçamos o recalc por um novo run de precos_base que NÃO re-envia a base (cenário do mundo real:
-- insumo estável). Disparamos via um run de corante que toca uma fórmula que usa a base:
-- como COR9 não tem item, provamos pela via direta: a função tint_recalc_preco_oficial acha 500.
DO $$
DECLARE p numeric; fid uuid;
BEGIN
  SELECT id INTO fid FROM tint_formulas WHERE account='oben' AND cor_id='COR9';
  -- S2: assinatura nova com p_store_code (2º arg). store=L1.
  p := tint_recalc_preco_oficial('oben', 'L1', fid, 'P9', 'B9', 'E900I');
  IF p IS NULL OR p <> 500 THEN RAISE EXCEPTION 'C9b FALHOU: recalc pós-purge = % (esperado 500 = base latest preservada, NÃO NULL por insumo apagado)', p; END IF;
  RAISE NOTICE 'OK C9b — recalc pós-purge acha a base latest preservada (preço 500), não NULL';
END $$;
SQL

echo ""
echo "════════ CENÁRIO 10 — Embalagem volume NULL não rebaixa o oficial (P2-2) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Produto P10/base B10/emb E10 com volume OFICIAL 900 (já promovido). Depois chega um staging
-- da MESMA embalagem com volume_ml NULL → o upsert NÃO pode rebaixar p/ 0/NULL, senão a
-- expansão (guard volume_ml>0) dropa a fórmula da E10. Esperado: volume oficial CONTINUA 900
-- e a fórmula COR10 da E10 segue expandida.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('a0000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('a0000000-0000-0000-0000-000000000001','oben','L1','P10','Produto 10');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('a0000000-0000-0000-0000-000000000001','oben','L1','B10','Base 10');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('a0000000-0000-0000-0000-000000000001','oben','L1','E10','Galão 10',900);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('a0000000-0000-0000-0000-000000000001','oben','L1','P10','B10','E10');
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('a0000000-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada)
VALUES ('ffa00000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','oben','L1','COR10','Volume','P10','B10','E10',900,false);
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('a0000000-0000-0000-0000-000000000002','ffa00000-0000-0000-0000-000000000001','AX',1,10);
SELECT tint_promote_sync_run('a0000000-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('a0000000-0000-0000-0000-000000000002');

-- Agora chega um run de catálogo com a MESMA embalagem E10 mas volume_ml NULL (regressão do bug).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('a0000000-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('a0000000-0000-0000-0000-000000000003','oben','L1','E10','Galão 10',NULL);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('a0000000-0000-0000-0000-000000000003','oben','L1','P10','B10','E10');
SELECT tint_promote_sync_run('a0000000-0000-0000-0000-000000000003');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE vol numeric; n int; vff numeric;
BEGIN
  -- volume oficial da E10 continua 900 (NÃO rebaixado p/ 0 pelo staging NULL).
  SELECT volume_ml INTO vol FROM tint_embalagens WHERE account='oben' AND id_embalagem_sayersystem='E10';
  IF vol IS NULL OR vol <> 900 THEN RAISE EXCEPTION 'C10.1 FALHOU: volume oficial E10 = % (esperado 900; staging NULL rebaixou)', vol; END IF;

  -- a fórmula COR10 da E10 segue existindo (a expansão não foi dropada).
  SELECT count(*) INTO n FROM tint_formulas f
    JOIN tint_embalagens e ON e.id=f.embalagem_id
    WHERE f.account='oben' AND f.cor_id='COR10' AND e.id_embalagem_sayersystem='E10';
  IF n <> 1 THEN RAISE EXCEPTION 'C10.2 FALHOU: fórmula COR10@E10 sumiu/duplicou (n=%, esperado 1)', n; END IF;

  -- volume_final_ml da fórmula continua 900 (re-expandiu com o volume oficial preservado).
  SELECT f.volume_final_ml INTO vff FROM tint_formulas f
    JOIN tint_embalagens e ON e.id=f.embalagem_id
    WHERE f.account='oben' AND f.cor_id='COR10' AND e.id_embalagem_sayersystem='E10';
  IF vff <> 900 THEN RAISE EXCEPTION 'C10.3 FALHOU: volume_final_ml COR10@E10 = % (esperado 900)', vff; END IF;
  RAISE NOTICE 'OK C10 — embalagem volume NULL não rebaixa o oficial: E10 segue 900, COR10@E10 expandida';
END $$;
SQL

echo ""
echo "════════ CENÁRIO 11 — Latest NÃO-NULO do insumo: corante só-descrição não regride preço (S3) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Produto P11/base B11/emb E11 (900ml vendável). Corante CX11 custo=300 vol=900.
-- Fórmula COR11 usa CX11 6ml na formulação 900 (fator 1). precos_base P11/B11/E11 custo=100.
-- Preço inicial = 100×1×1 + (300/900)*6 = 100 + 2.0 = 102.00.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, created_at)
VALUES ('b0000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete', now() - interval '3 hours');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('b0000000-0000-0000-0000-000000000001','oben','L1','P11','Produto 11');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('b0000000-0000-0000-0000-000000000001','oben','L1','B11','Base 11');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('b0000000-0000-0000-0000-000000000001','oben','L1','E11','Galão 11',900);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('b0000000-0000-0000-0000-000000000001','oben','L1','P11','B11','E11');
-- Corante VELHO COM preço (custo+volume) — created_at antigo.
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, custo, volume_ml, created_at)
VALUES ('b0000000-0000-0000-0000-000000000001','oben','L1','CX11','Corante CX11', 300, 900, now() - interval '3 hours');
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct, created_at)
VALUES ('b0000000-0000-0000-0000-000000000001','oben','L1','P11','B11','E11',100,0,0, now() - interval '3 hours');

INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, created_at)
VALUES ('b0000000-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete', now() - interval '3 hours');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada, created_at)
VALUES ('ffb00000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000002','oben','L1','COR11','Insumo NaoNulo','P11','B11','E11',900,false, now() - interval '3 hours');
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
VALUES ('b0000000-0000-0000-0000-000000000002','ffb00000-0000-0000-0000-000000000001','CX11',1,6);

SELECT tint_promote_sync_run('b0000000-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('b0000000-0000-0000-0000-000000000002');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Agora chega: (1) o MESMO corante CX11 SÓ-DESCRIÇÃO (custo/volume NULL), created_at MAIS RECENTE
-- (= a linha "latest" cega) e (2) um run de precos_base que muda custo 100→200 (DISPARA o recálculo).
-- Sem S3, o lookup do corante pegaria a linha NULL mais recente → preço regrediria p/ NULL.
-- Com S3 (latest WHERE custo+volume NÃO-NULOS), o corante resolve p/ a linha velha (300/900):
-- preço = 200×1×1 + (300/900)*6 = 200 + 2.0 = 202.00.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status, created_at)
VALUES ('b0000000-0000-0000-0000-0000000000c0','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete', now());
-- corante só-descrição (custo/volume NULL), created_at recente.
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, created_at)
VALUES ('b0000000-0000-0000-0000-0000000000c0','oben','L1','CX11','Corante CX11 renomeado', now());
-- precos_base novo (custo 200) → dispara recálculo da COR11.
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct, created_at)
VALUES ('b0000000-0000-0000-0000-0000000000c0','oben','L1','P11','B11','E11',200,0,0, now());
SELECT tint_promote_sync_run('b0000000-0000-0000-0000-0000000000c0');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE p numeric; cor_desc text; cor_vol numeric;
BEGIN
  SELECT preco_final_sayersystem INTO p FROM tint_formulas WHERE account='oben' AND cor_id='COR11';
  IF p IS NULL THEN RAISE EXCEPTION 'C11.1 FALHOU: preço COR11 regrediu p/ NULL (corante só-descrição derrotou o preço) — S3 não pegou'; END IF;
  IF p <> 202 THEN RAISE EXCEPTION 'C11.2 FALHOU: preço COR11 = % (esperado 202.00 = base 200 + corante da linha NÃO-NULA 300/900×6)', p; END IF;
  -- a descrição oficial do corante FOI atualizada (o só-descrição vale p/ texto), mas o volume oficial
  -- NÃO foi rebaixado p/ 0 pelo NULL (preserva o COALESCE do upsert de corante).
  SELECT descricao, volume_total_ml INTO cor_desc, cor_vol FROM tint_corantes WHERE account='oben' AND id_corante_sayersystem='CX11';
  IF cor_vol IS NULL OR cor_vol <> 900 THEN RAISE EXCEPTION 'C11.3 FALHOU: volume oficial CX11 = % (esperado 900, NULL não rebaixa)', cor_vol; END IF;
  RAISE NOTICE 'OK C11 — corante só-descrição (NULL custo/vol) NÃO regride preço: COR11=202.00 (S3 pega a latest não-nula 300/900)';
END $$;
SQL

echo ""
echo "════════ CENÁRIO 12 — Lookup de precos_base respeita store_code (S2: sem vazamento cross-store) ════════"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Setting de uma SEGUNDA loja (L2) do MESMO account oben.
INSERT INTO tint_integration_settings (id, account, store_code, integration_mode, sync_token, sync_enabled)
VALUES ('aaaaaaaa-0000-0000-0000-000000000002','oben','L2','automatic_primary','tok_test_l2', true);

-- Produto P12/base B12/emb E12 na loja L1. Fórmula COR12 SEM corantes (preço = só base).
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('c0000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
VALUES ('c0000000-0000-0000-0000-000000000001','oben','L1','P12','Produto 12');
INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
VALUES ('c0000000-0000-0000-0000-000000000001','oben','L1','B12','Base 12');
INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
VALUES ('c0000000-0000-0000-0000-000000000001','oben','L1','E12','Galão 12',900);
INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
VALUES ('c0000000-0000-0000-0000-000000000001','oben','L1','P12','B12','E12');
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('c0000000-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','formulas','complete');
INSERT INTO tint_staging_formulas (id, sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada)
VALUES ('ffc00000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002','oben','L1','COR12','CrossStore','P12','B12','E12',900,false);

-- precos_base SÓ NA LOJA L2 (custo 999) p/ P12/B12/E12. A fórmula é da L1 → NÃO pode usar.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('c0000000-0000-0000-0000-0000000000a2','aaaaaaaa-0000-0000-0000-000000000002','oben','L2','catalogs','complete');
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct)
VALUES ('c0000000-0000-0000-0000-0000000000a2','oben','L2','P12','B12','E12',999,0,0);

SELECT tint_promote_sync_run('c0000000-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('c0000000-0000-0000-0000-000000000002');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE p_is_null boolean; p numeric;
BEGIN
  -- Com SÓ a linha L2 presente, o preço da fórmula L1 = NULL (a base L2 é filtrada por store_code).
  SELECT preco_final_sayersystem, preco_final_sayersystem IS NULL INTO p, p_is_null
    FROM tint_formulas WHERE account='oben' AND cor_id='COR12';
  IF NOT p_is_null THEN RAISE EXCEPTION 'C12.1 FALHOU: COR12 (L1) usou a precos_base da L2 (vazamento cross-store) — preço=% (esperado NULL)', p; END IF;
  RAISE NOTICE 'OK C12a — precos_base da L2 NÃO vaza p/ a fórmula da L1: preço NULL';
END $$;
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Confirmação positiva: ao adicionar a precos_base da PRÓPRIA loja L1 (custo 50), o preço resolve.
-- Prova que era o filtro de store_code (não outro insumo faltando) que zerava.
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status)
VALUES ('c0000000-0000-0000-0000-0000000000b1','aaaaaaaa-0000-0000-0000-000000000001','oben','L1','catalogs','complete');
INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct)
VALUES ('c0000000-0000-0000-0000-0000000000b1','oben','L1','P12','B12','E12',50,0,0);
SELECT tint_promote_sync_run('c0000000-0000-0000-0000-0000000000b1');
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE p numeric;
BEGIN
  SELECT preco_final_sayersystem INTO p FROM tint_formulas WHERE account='oben' AND cor_id='COR12';
  IF p IS NULL OR p <> 50 THEN RAISE EXCEPTION 'C12.2 FALHOU: COR12 com precos_base da L1 (custo 50) = % (esperado 50 = usa a base da PRÓPRIA loja)', p; END IF;
  RAISE NOTICE 'OK C12b — com a precos_base da L1 presente (custo 50), COR12=50.00 (era o filtro de store_code que zerava)';
END $$;
SQL

echo ""
echo "════════ CENÁRIO 13 — IDENTIDADE em VOLUME: set-based ≡ loop antigo (mesmo seed) ════════"
# Prova de identidade contábil (money-path): 200 fórmulas × 3 embalagens = 600 expansões, semeadas
# IDÊNTICAS em dois accounts (difa promovido pela set-based NOVA; difb pelo loop antigo preservado).
# Mix NULL-honesto real (corantes 08-10 sem preço → fórmulas que os usam saem com preço NULL).
# Compara via EXCEPT nos DOIS sentidos (fórmulas + itens) → 0 diferenças = idêntico.
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- settings + runs (catalogs + formulas) por account.
INSERT INTO tint_integration_settings (id, account, store_code, integration_mode, sync_token, sync_enabled) VALUES
  ('dddddddd-0000-0000-0000-00000000000a','difa','L1','automatic_primary','tok_a',true),
  ('dddddddd-0000-0000-0000-00000000000b','difb','L1','automatic_primary','tok_b',true);
INSERT INTO tint_sync_runs (id, setting_id, account, store_code, sync_type, status) VALUES
  ('da000000-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-00000000000a','difa','L1','catalogs','complete'),
  ('da000000-0000-0000-0000-000000000002','dddddddd-0000-0000-0000-00000000000a','difa','L1','formulas','complete'),
  ('db000000-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-00000000000b','difb','L1','catalogs','complete'),
  ('db000000-0000-0000-0000-000000000002','dddddddd-0000-0000-0000-00000000000b','difb','L1','formulas','complete');

-- Catálogo IDÊNTICO nos dois accounts (cross join account × linhas de catálogo).
INSERT INTO tint_staging_produtos (sync_run_id, account, store_code, cod_produto, descricao)
SELECT acc.cat_run, acc.account, 'L1', 'PV', 'Produto Volume'
FROM (VALUES ('difa','da000000-0000-0000-0000-000000000001'::uuid),('difb','db000000-0000-0000-0000-000000000001'::uuid)) acc(account,cat_run);

INSERT INTO tint_staging_bases (sync_run_id, account, store_code, id_base_sayersystem, descricao)
SELECT acc.cat_run, acc.account, 'L1', bs.b, 'Base '||bs.b
FROM (VALUES ('difa','da000000-0000-0000-0000-000000000001'::uuid),('difb','db000000-0000-0000-0000-000000000001'::uuid)) acc(account,cat_run)
CROSS JOIN (VALUES ('BV1'),('BV2'),('BV3')) bs(b);

INSERT INTO tint_staging_embalagens (sync_run_id, account, store_code, id_embalagem_sayersystem, descricao, volume_ml)
SELECT acc.cat_run, acc.account, 'L1', e.id, 'Emb '||e.id, e.vol
FROM (VALUES ('difa','da000000-0000-0000-0000-000000000001'::uuid),('difb','db000000-0000-0000-0000-000000000001'::uuid)) acc(account,cat_run)
CROSS JOIN (VALUES ('EV0900',900),('EV3600',3600),('EV5000',5000)) e(id,vol);

INSERT INTO tint_staging_skus (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem)
SELECT acc.cat_run, acc.account, 'L1', 'PV', bs.b, e.id
FROM (VALUES ('difa','da000000-0000-0000-0000-000000000001'::uuid),('difb','db000000-0000-0000-0000-000000000001'::uuid)) acc(account,cat_run)
CROSS JOIN (VALUES ('BV1'),('BV2'),('BV3')) bs(b)
CROSS JOIN (VALUES ('EV0900'),('EV3600'),('EV5000')) e(id);

-- Corantes 01-07 COM preço; 08-10 SEM (custo/volume NULL → fórmula que usa sai NULL-honesta).
INSERT INTO tint_staging_corantes (sync_run_id, account, store_code, id_corante_sayersystem, descricao, custo, volume_ml)
SELECT acc.cat_run, acc.account, 'L1', 'CVCOR'||lpad(n::text,2,'0'), 'Corante '||n,
       CASE WHEN n <= 7 THEN (50 + n*10)::numeric ELSE NULL END,
       CASE WHEN n <= 7 THEN 900::numeric ELSE NULL END
FROM (VALUES ('difa','da000000-0000-0000-0000-000000000001'::uuid),('difb','db000000-0000-0000-0000-000000000001'::uuid)) acc(account,cat_run)
CROSS JOIN generate_series(1,10) n;

INSERT INTO tint_staging_precos_base (sync_run_id, account, store_code, cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct)
SELECT acc.cat_run, acc.account, 'L1', 'PV', bs.b, e.id, (100 + bs.bi*10 + e.ei*5)::numeric, 30, 50
FROM (VALUES ('difa','da000000-0000-0000-0000-000000000001'::uuid),('difb','db000000-0000-0000-0000-000000000001'::uuid)) acc(account,cat_run)
CROSS JOIN (VALUES ('BV1',1),('BV2',2),('BV3',3)) bs(b,bi)
CROSS JOIN (VALUES ('EV0900',1),('EV3600',2),('EV5000',3)) e(id,ei);

-- 200 fórmulas (formulação 900ml na EV0900), base rotativa BV1/2/3. 1/4 delas com SUBCOLEÇÃO
-- (exercita o ensure por texto cru + resolução + a chave única subcolecao_id).
INSERT INTO tint_staging_formulas (sync_run_id, account, store_code, cor_id, nome_cor, cod_produto, id_base, id_embalagem, volume_final_ml, personalizada, subcolecao)
SELECT acc.fml_run, acc.account, 'L1', 'CV'||lpad(g::text,4,'0'), 'Cor '||g, 'PV', 'BV'||(1+(g%3)), 'EV0900', 900, false,
       CASE WHEN g % 4 = 0 THEN 'SUBV'||(1+(g%2)) ELSE NULL END
FROM (VALUES ('difa','da000000-0000-0000-0000-000000000002'::uuid),('difb','db000000-0000-0000-0000-000000000002'::uuid)) acc(account,fml_run)
CROSS JOIN generate_series(1,200) g;

-- 2 itens por fórmula, corante derivado do nº da cor (offset 4 → 2 corantes distintos).
INSERT INTO tint_staging_formula_itens (sync_run_id, staging_formula_id, id_corante, ordem, qtd_ml)
SELECT sf.sync_run_id, sf.id, 'CVCOR'||lpad((1+(sf.gnum%10))::text,2,'0'), 1, (5 + (sf.gnum%7))::numeric
FROM (SELECT *, substring(cor_id from 3)::int AS gnum FROM tint_staging_formulas WHERE cod_produto='PV' AND account IN ('difa','difb')) sf
UNION ALL
SELECT sf.sync_run_id, sf.id, 'CVCOR'||lpad((1+((sf.gnum+4)%10))::text,2,'0'), 2, (2 + (sf.gnum%5))::numeric
FROM (SELECT *, substring(cor_id from 3)::int AS gnum FROM tint_staging_formulas WHERE cod_produto='PV' AND account IN ('difa','difb')) sf;

-- Comparador: total de diferenças (EXCEPT nos dois sentidos) em fórmulas + itens entre difa e difb.
-- Normaliza account/id/timestamps; compara por chave de NEGÓCIO (ids SAYER). EXCEPT trata NULL=NULL.
CREATE OR REPLACE FUNCTION _dif_count() RETURNS int LANGUAGE sql AS $fn$
  WITH na AS (SELECT f.cor_id, p.cod_produto, b.id_base_sayersystem AS id_base, e.id_embalagem_sayersystem AS id_emb,
                     COALESCE(sc.id_subcolecao_sayersystem,'') AS subcol,
                     f.volume_final_ml, f.preco_final_sayersystem AS preco, f.personalizada
              FROM tint_formulas f JOIN tint_produtos p ON p.id=f.produto_id JOIN tint_bases b ON b.id=f.base_id
                   JOIN tint_embalagens e ON e.id=f.embalagem_id
                   LEFT JOIN tint_subcolecoes sc ON sc.id=f.subcolecao_id WHERE f.account='difa'),
       nb AS (SELECT f.cor_id, p.cod_produto, b.id_base_sayersystem AS id_base, e.id_embalagem_sayersystem AS id_emb,
                     COALESCE(sc.id_subcolecao_sayersystem,'') AS subcol,
                     f.volume_final_ml, f.preco_final_sayersystem AS preco, f.personalizada
              FROM tint_formulas f JOIN tint_produtos p ON p.id=f.produto_id JOIN tint_bases b ON b.id=f.base_id
                   JOIN tint_embalagens e ON e.id=f.embalagem_id
                   LEFT JOIN tint_subcolecoes sc ON sc.id=f.subcolecao_id WHERE f.account='difb'),
       fdiff AS ((SELECT * FROM na EXCEPT SELECT * FROM nb) UNION ALL (SELECT * FROM nb EXCEPT SELECT * FROM na)),
       ia AS (SELECT f.cor_id, e.id_embalagem_sayersystem AS id_emb, co.id_corante_sayersystem AS corante, fi.ordem, fi.qtd_ml
              FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id
                   JOIN tint_embalagens e ON e.id=f.embalagem_id JOIN tint_corantes co ON co.id=fi.corante_id
              WHERE f.account='difa'),
       ib AS (SELECT f.cor_id, e.id_embalagem_sayersystem AS id_emb, co.id_corante_sayersystem AS corante, fi.ordem, fi.qtd_ml
              FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id
                   JOIN tint_embalagens e ON e.id=f.embalagem_id JOIN tint_corantes co ON co.id=fi.corante_id
              WHERE f.account='difb'),
       idiff AS ((SELECT * FROM ia EXCEPT SELECT * FROM ib) UNION ALL (SELECT * FROM ib EXCEPT SELECT * FROM ia))
  SELECT (SELECT count(*) FROM fdiff) + (SELECT count(*) FROM idiff);
$fn$;
SQL

# Promove (com cronômetro): difa pela set-based NOVA, difb pelo loop ANTIGO. Statements separados
# = transações auto-commit distintas (os TEMP TABLE ON COMMIT DROP da função não colidem).
P -v ON_ERROR_STOP=1 -q <<'SQL'
DROP TABLE IF EXISTS _t13;
CREATE TABLE _t13 (k text, ts timestamptz);
INSERT INTO _t13 VALUES ('a0', clock_timestamp());
SELECT tint_promote_sync_run('da000000-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run('da000000-0000-0000-0000-000000000002');
INSERT INTO _t13 VALUES ('a1', clock_timestamp());
SELECT tint_promote_sync_run_oldloop('db000000-0000-0000-0000-000000000001');
SELECT tint_promote_sync_run_oldloop('db000000-0000-0000-0000-000000000002');
INSERT INTO _t13 VALUES ('a2', clock_timestamp());
SQL
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE na int; nb int; ia int; ib int; nulls_a int; reais_a int; d int; ms_new numeric; ms_old numeric;
BEGIN
  SELECT count(*) INTO na FROM tint_formulas WHERE account='difa';
  SELECT count(*) INTO nb FROM tint_formulas WHERE account='difb';
  IF na <> nb THEN RAISE EXCEPTION 'C13.1 FALHOU: nº de fórmulas difere (set-based %, loop %)', na, nb; END IF;
  IF na <> 600 THEN RAISE EXCEPTION 'C13.1b FALHOU: esperado 600 fórmulas (200×3 embalagens), achei %', na; END IF;

  SELECT count(*) INTO ia FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.account='difa';
  SELECT count(*) INTO ib FROM tint_formula_itens fi JOIN tint_formulas f ON f.id=fi.formula_id WHERE f.account='difb';
  IF ia <> ib THEN RAISE EXCEPTION 'C13.2 FALHOU: nº de itens difere (set-based %, loop %)', ia, ib; END IF;

  -- Mix NULL-honesto real: tem fórmula NULL (corante sem preço) E fórmula com preço.
  SELECT count(*) FILTER (WHERE preco_final_sayersystem IS NULL),
         count(*) FILTER (WHERE preco_final_sayersystem IS NOT NULL)
    INTO nulls_a, reais_a FROM tint_formulas WHERE account='difa';
  IF nulls_a = 0 OR reais_a = 0 THEN RAISE EXCEPTION 'C13.3 FALHOU: cenário trivial (nulls=% reais=%) — sem mix NULL-honesto', nulls_a, reais_a; END IF;

  -- subcoleção exercitada (não-trivial): tem fórmula com subcolecao_id resolvido (entra na chave única).
  IF (SELECT count(*) FROM tint_formulas WHERE account='difa' AND subcolecao_id IS NOT NULL) = 0 THEN
    RAISE EXCEPTION 'C13.3b FALHOU: nenhuma fórmula com subcoleção — dimensão não exercitada';
  END IF;

  -- IDENTIDADE CONTÁBIL: set-based ≡ loop em TODAS as fórmulas e itens.
  d := _dif_count();
  IF d <> 0 THEN RAISE EXCEPTION 'C13.4 FALHOU: set-based DIVERGE do loop em % linhas (fórmulas+itens)', d; END IF;

  SELECT round(extract(epoch from ((SELECT ts FROM _t13 WHERE k='a1') - (SELECT ts FROM _t13 WHERE k='a0')))*1000,1),
         round(extract(epoch from ((SELECT ts FROM _t13 WHERE k='a2') - (SELECT ts FROM _t13 WHERE k='a1')))*1000,1)
    INTO ms_new, ms_old;
  IF ms_new > 30000 THEN RAISE EXCEPTION 'C13.5 FALHOU: set-based demorou % ms (>30s — regressão grave)', ms_new; END IF;
  RAISE NOTICE 'OK C13 — identidade set-based≡loop: % fórmulas / % itens (% NULL, % com preço); tempo set-based % ms vs loop % ms',
    na, ia, nulls_a, reais_a, ms_new, ms_old;
END $$;
SQL

echo ""
echo "── falsificação C13 (prova que a identidade diferencial tem DENTE) ──"
MIG="$REPO_ROOT/supabase/migrations/20260615160000_tint_promote_set_based.sql"

# F1 — sabota o NULL-honesto: corante faltante deixa de zerar p/ NULL → fabrica preço.
sed 's/WHEN COALESCE(it.faltante, false) THEN NULL/WHEN false THEN NULL/' "$MIG" > /tmp/sab-tint-nullhonest.sql
grep -q 'WHEN false THEN NULL' /tmp/sab-tint-nullhonest.sql || { echo "✗ F1: sed não casou o alvo NULL-honesto"; exit 1; }
P -v ON_ERROR_STOP=1 -q -f /tmp/sab-tint-nullhonest.sql >/dev/null
P -v ON_ERROR_STOP=1 -q -c "SELECT tint_promote_sync_run('da000000-0000-0000-0000-000000000002');" >/dev/null
DSAB=$(P -tA -c "SELECT _dif_count();")
case "$DSAB" in
  0|"") echo "✗ F1 FALHOU: sabotei o NULL-honesto e a identidade NÃO acusou → C13.4 é fraco"; exit 1 ;;
  *)    echo "  ✓ F1 — NULL-honesto furado diverge do loop em $DSAB linhas (C13.4 tem dente)" ;;
esac
P -v ON_ERROR_STOP=1 -q -f "$MIG" >/dev/null
P -v ON_ERROR_STOP=1 -q -c "SELECT tint_promote_sync_run('da000000-0000-0000-0000-000000000002');" >/dev/null

# F2 — sabota o fator (regra de 3 → 1): expansão p/ embalagem ≠ formulação fica errada.
sed 's#(e.volume_ml / fl.volume_final_ml) AS fator#(1) AS fator#' "$MIG" > /tmp/sab-tint-fator.sql
grep -q '(1) AS fator' /tmp/sab-tint-fator.sql || { echo "✗ F2: sed não casou o alvo fator"; exit 1; }
P -v ON_ERROR_STOP=1 -q -f /tmp/sab-tint-fator.sql >/dev/null
P -v ON_ERROR_STOP=1 -q -c "SELECT tint_promote_sync_run('da000000-0000-0000-0000-000000000002');" >/dev/null
DSAB2=$(P -tA -c "SELECT _dif_count();")
case "$DSAB2" in
  0|"") echo "✗ F2 FALHOU: troquei o fator e a identidade NÃO acusou → C13.4 é fraco"; exit 1 ;;
  *)    echo "  ✓ F2 — fator=1 diverge do loop em $DSAB2 linhas (regra de 3 coberta)" ;;
esac
P -v ON_ERROR_STOP=1 -q -f "$MIG" >/dev/null
P -v ON_ERROR_STOP=1 -q -c "SELECT tint_promote_sync_run('da000000-0000-0000-0000-000000000002');" >/dev/null

# Restauração confirmada: set-based ≡ loop de novo.
DOK=$(P -tA -c "SELECT _dif_count();")
[ "$DOK" = "0" ] || { echo "✗ restauração falhou: _dif_count=$DOK (esperado 0)"; exit 1; }
echo "  ✓ restauração OK — set-based≡loop de novo (_dif_count=0)"

P -v ON_ERROR_STOP=1 -q <<'SQL'
SELECT 'TODOS OS TESTES PG17 DA PROMOÇÃO PASSARAM ✓' AS resultado;
SQL
echo ""
echo "✓ db/test-tint-promote.sh — PASSOU"
