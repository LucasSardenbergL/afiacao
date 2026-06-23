#!/usr/bin/env bash
# Teste PG17 do VIGIA da cobertura tint no Sentinela (_data_health_compute + watchdog + heartbeat).
# Aplica schema-snapshot + patches + STUB de _vendas_familia_ausente_lista_email (chamada pelo watchdog
# da base) + a BASE 20260611210000 (def viva presumida, 18 checks) + a migration nova 20260615130000
# (CREATE OR REPLACE → 20 checks). Semeia cenários de cobertura (família × marca × tint_type × ativo ×
# account × created_at) e de vínculo (tint_skus → omie inativo / produto em >1 sku), e asserta:
#  • a função COMPILA e retorna 20 checks (nenhum dos 18 anteriores some) — pega typo no UNION ALL;
#  • Check A (tint_cobertura_bases): NASCE ok com cobertura limpa; stale/warning com drift>30h;
#    TOLERÂNCIA temporal — base elegível não-marcada HÁ <30h (created_at) NÃO conta (anti-falso-positivo);
#  • Check B (tint_vinculo_omie): conta SKU ativa→omie inativo/divergente + produto Omie em >1 sku ativa;
#  • PUSH SELETIVO: data_health_watchdog() promove SÓ o A (fin_alertas + fornecedor_alerta); o B é
#    DASHBOARD-ONLY → NÃO entra em fin_alertas nem no resumo do heartbeat (fora dos IN-lists);
#  • dismiss do A quando volta a ok; heartbeat inclui A no resumo e NÃO inclui B.
# Base: db/test-data-health-familia-ausente.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5443
DATA="$(mktemp -d /tmp/pgtest-tintvigia.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-tintvigia.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres tintvigia_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d tintvigia_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-tintvigia.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ patch: omie_products.tipo_produto (stale no snapshot)…"
P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tipo_produto text;"

# O snapshot traz a versão ANTIGA buggy do fin_audit_trigger — neutralizo (no-op) p/ testar o push.
echo "→ patch: neutraliza fin_audit_trigger buggy do snapshot (no-op)…"
P -v ON_ERROR_STOP=1 -q -c "CREATE OR REPLACE FUNCTION public.fin_audit_trigger() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN COALESCE(NEW, OLD); END; \$f\$;"

# A base 20260611210000 (watchdog) chama public._vendas_familia_ausente_lista_email(int) — definida na
# 20260611180000, fora desta cadeia. STUB (retorna NULL; o watchdog faz COALESCE) p/ não arrastar a cadeia.
echo "→ stub: _vendas_familia_ausente_lista_email(int)…"
P -v ON_ERROR_STOP=1 -q -c "CREATE OR REPLACE FUNCTION public._vendas_familia_ausente_lista_email(int) RETURNS text LANGUAGE sql AS \$f\$ SELECT NULL::text \$f\$;"

echo "→ base: 20260611210000 (def viva presumida, 18 checks)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611210000_data_health_estoque_via_marcador.sql" >/dev/null

echo "→ migration nova: 20260615130000 (CREATE OR REPLACE → 20 checks)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260615130000_tint_vigia_cobertura_sentinela.sql" >/dev/null

# Pais p/ as FKs de tint_skus (produto_id/base_id/embalagem_id NOT NULL + FK).
echo "→ seed: pais tint (produto/base/embalagem) + estado LIMPO (cobertura ok)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.tint_produtos (id, account, cod_produto, descricao) VALUES
  ('11111111-1111-1111-1111-111111111111','oben','P1','Produto teste');
INSERT INTO public.tint_bases (id, account, id_base_sayersystem, descricao) VALUES
  ('22222222-2222-2222-2222-222222222222','oben','B1','Base teste');
-- 5 embalagens distintas: tint_skus tem UNIQUE (account, produto_id, base_id, embalagem_id),
-- então cada SKU precisa de combinação única (o caso ambíguo = 2 SKUs distintas → mesmo omie).
INSERT INTO public.tint_embalagens (id, account, id_embalagem_sayersystem, volume_ml, descricao) VALUES
  ('33333333-3333-3333-3333-333333333331','oben','E1',3600,'GL'),
  ('33333333-3333-3333-3333-333333333332','oben','E2',405,'405ML'),
  ('33333333-3333-3333-3333-333333333333','oben','E3',810,'810ML'),
  ('33333333-3333-3333-3333-333333333334','oben','E4',900,'QT'),
  ('33333333-3333-3333-3333-333333333335','oben','E5',100,'BH');
-- Estado LIMPO: só produtos tint classificados corretamente (A deve nascer ok).
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, familia, ativo, is_tintometric, tint_type, created_at) VALUES
  (5004,'5004','Base correta',       'oben','Bases MixMachine',       true,  true, 'base',        now()-interval '60 hours'),
  (5005,'5005','Concentrado correto','oben','Concentrados MixMachine',true,  true, 'concentrado', now()-interval '60 hours');
SQL

PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1 — got[$2] exp[$3]"; FAIL=$((FAIL+1)); fi; }

echo "→ asserts FASE 1 (estado limpo — vigia nasce verde)…"
chk "A1 total de checks = 20 (18 + 2)" \
  "$(P -tAc "SELECT count(*) FROM public._data_health_compute();")" "20"
chk "A2 tint_cobertura_bases aparece 1x" \
  "$(P -tAc "SELECT count(*) FROM public._data_health_compute() WHERE source='tint_cobertura_bases';")" "1"
chk "A2 tint_vinculo_omie aparece 1x" \
  "$(P -tAc "SELECT count(*) FROM public._data_health_compute() WHERE source='tint_vinculo_omie';")" "1"
chk "A3 os 18 checks anteriores seguem presentes" \
  "$(P -tAc "SELECT count(*) FROM public._data_health_compute() WHERE source IN ('saldo_bancario','contas_receber','contas_pagar','omie_sync_financeiro','vendas_pedidos','estoque_inventario','reposicao_sugestoes','carteira_scores','custos_produtos','vendas_cadastros','reposicao_disparo','reposicao_portal_pipeline','reposicao_portal_humano','reposicao_sayerlack_fabricado','omie_tipo_produto_oben','vendas_familia_ausente','estoque_reposicao','alert_channel');")" "18"
chk "A4 Check A NASCE ok (cobertura limpa)" \
  "$(P -tAc "SELECT status FROM public._data_health_compute() WHERE source='tint_cobertura_bases';")" "ok"
chk "A4 Check A severity info quando ok" \
  "$(P -tAc "SELECT severity FROM public._data_health_compute() WHERE source='tint_cobertura_bases';")" "info"
chk "A4 Check B NASCE ok (vínculo íntegro)" \
  "$(P -tAc "SELECT status FROM public._data_health_compute() WHERE source='tint_vinculo_omie';")" "ok"
P -tAc "SELECT public.data_health_watchdog();" >/dev/null
chk "A5 watchdog NÃO insere alerta com tudo ok" \
  "$(P -tAc "SELECT count(*) FROM public.fin_alertas WHERE tipo IN ('data_health_tint_cobertura_bases','data_health_tint_vinculo_omie') AND dismissed_at IS NULL;")" "0"

echo "→ mutação: injeta DRIFT (cobertura + vínculo)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Check A — drift de cobertura:
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, familia, ativo, is_tintometric, tint_type, created_at) VALUES
  (5001,'5001','Base nao marcada velha','oben','Bases MixMachine',       true,  false, NULL,         now()-interval '40 hours'), -- CONTA (não-marcada, >30h)
  (5002,'5002','Base nao marcada NOVA', 'oben','Bases MixMachine',       true,  false, NULL,         now()-interval '10 hours'), -- NÃO conta (tolerância <30h)
  (5003,'5003','Base tipo errado',      'oben','Bases MixMachine',       true,  true,  'concentrado',now()-interval '50 hours'), -- CONTA (tint_type errado, >30h)
  (5006,'5006','Base inativa',          'oben','Bases MixMachine',       false, false, NULL,         now()-interval '60 hours'), -- NÃO conta (inativo)
  (5007,'5007','Abrasivo',              'oben','ABRASIVOS',              true,  false, NULL,         now()-interval '60 hours'), -- NÃO conta (outra família)
  (5008,'5008','Base colacor',          'colacor','Bases MixMachine',   true,  false, NULL,         now()-interval '60 hours'); -- NÃO conta (account != oben)
-- Check B — vínculo quebrado:
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, familia, ativo, is_tintometric, tint_type, created_at) VALUES
  (6001,'6001','Omie inativo p/ vinculo','oben','X',false,false,NULL, now()-interval '60 hours'), -- alvo morto
  (6002,'6002','Omie em 2 skus',         'oben','X',true, false,NULL, now()-interval '60 hours'), -- alvo ambíguo
  (6003,'6003','Omie ok 1 sku',          'oben','X',true, false,NULL, now()-interval '60 hours'); -- alvo ok
INSERT INTO public.tint_skus (account, produto_id, base_id, embalagem_id, omie_product_id, ativo)
SELECT 'oben','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333331', op.id, true
  FROM public.omie_products op WHERE op.omie_codigo_produto = 6001;                       -- morto: SKU ativa → omie inativo
INSERT INTO public.tint_skus (account, produto_id, base_id, embalagem_id, omie_product_id, ativo)
SELECT 'oben','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333332', op.id, true
  FROM public.omie_products op WHERE op.omie_codigo_produto = 6002;                       -- ambíguo (1ª)
INSERT INTO public.tint_skus (account, produto_id, base_id, embalagem_id, omie_product_id, ativo)
SELECT 'oben','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333', op.id, true
  FROM public.omie_products op WHERE op.omie_codigo_produto = 6002;                       -- ambíguo (2ª)
INSERT INTO public.tint_skus (account, produto_id, base_id, embalagem_id, omie_product_id, ativo)
SELECT 'oben','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333334', op.id, true
  FROM public.omie_products op WHERE op.omie_codigo_produto = 6003;                       -- ok (1 sku → omie ativo)
-- SKU INATIVA → omie inativo: NÃO conta (ts.ativo=false)
INSERT INTO public.tint_skus (account, produto_id, base_id, embalagem_id, omie_product_id, ativo)
SELECT 'oben','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333335', op.id, false
  FROM public.omie_products op WHERE op.omie_codigo_produto = 6001;
SQL

echo "→ asserts FASE 2 (drift — A conta 2 com tolerância, B conta morto+ambíguo)…"
chk "B1 Check A vira stale" \
  "$(P -tAc "SELECT status FROM public._data_health_compute() WHERE source='tint_cobertura_bases';")" "stale"
chk "B1 Check A severity warning" \
  "$(P -tAc "SELECT severity FROM public._data_health_compute() WHERE source='tint_cobertura_bases';")" "warning"
chk "B2 Check A conta 2 (5001+5003; TOLERÂNCIA: 5002 <30h NÃO conta)" \
  "$(P -tAc "SELECT (message LIKE 'Cobertura tint: 2 %')::text FROM public._data_health_compute() WHERE source='tint_cobertura_bases';")" "true"
chk "B2 Check A age_seconds > 30h (drift mais antigo = 5003, 50h)" \
  "$(P -tAc "SELECT (age_seconds > 30*3600)::text FROM public._data_health_compute() WHERE source='tint_cobertura_bases';")" "true"
chk "B3 Check B vira stale" \
  "$(P -tAc "SELECT status FROM public._data_health_compute() WHERE source='tint_vinculo_omie';")" "stale"
chk "B3 Check B = 1 morto + 1 ambíguo" \
  "$(P -tAc "SELECT (message LIKE '%1 SKU(s)%' AND message LIKE '%1 produto(s)%')::text FROM public._data_health_compute() WHERE source='tint_vinculo_omie';")" "true"

echo "→ asserts FASE 2 (push SELETIVO: A emaila, B é dashboard-only)…"
P -tAc "SELECT public.data_health_watchdog();" >/dev/null
chk "B4 PUSH do A: fin_alertas tem data_health_tint_cobertura_bases ativo" \
  "$(P -tAc "SELECT count(*) FROM public.fin_alertas WHERE company='oben' AND tipo='data_health_tint_cobertura_bases' AND dismissed_at IS NULL;")" "1"
chk "B4 PUSH do A: fornecedor_alerta enfileirou e-mail do A" \
  "$(P -tAc "SELECT (count(*) > 0)::text FROM public.fornecedor_alerta WHERE titulo LIKE '%tint_cobertura_bases%' AND status='pendente_notificacao';")" "true"
chk "B5 B é DASHBOARD-ONLY: NÃO entra em fin_alertas (fora do IN-list do watchdog)" \
  "$(P -tAc "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_tint_vinculo_omie';")" "0"
chk "B5 B é DASHBOARD-ONLY: NÃO enfileira e-mail" \
  "$(P -tAc "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '%tint_vinculo_omie%';")" "0"

echo "→ assert heartbeat (inclui A no resumo, NÃO inclui B)…"
P -tAc "SELECT public.fin_sync_heartbeat();" >/dev/null
chk "B6 heartbeat menciona tint_cobertura_bases no resumo" \
  "$(P -tAc "SELECT (count(*) > 0)::text FROM public.fornecedor_alerta WHERE titulo LIKE '[Watchdog%' AND mensagem LIKE '%tint_cobertura_bases%';")" "true"
chk "B6 heartbeat NÃO menciona tint_vinculo_omie (dashboard-only)" \
  "$(P -tAc "SELECT (count(*) = 0)::text FROM public.fornecedor_alerta WHERE titulo LIKE '[Watchdog%' AND mensagem LIKE '%tint_vinculo_omie%';")" "true"

echo "→ mutação: corrige a cobertura (marca 5001/5003) → A volta a ok…"
P -v ON_ERROR_STOP=1 -q -c "UPDATE public.omie_products SET is_tintometric=true, tint_type='base' WHERE omie_codigo_produto IN (5001,5003);"
chk "C1 Check A volta a ok" \
  "$(P -tAc "SELECT status FROM public._data_health_compute() WHERE source='tint_cobertura_bases';")" "ok"
P -tAc "SELECT public.data_health_watchdog();" >/dev/null
chk "C1 watchdog dismissou o alerta do A (0 ativos)" \
  "$(P -tAc "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_tint_cobertura_bases' AND dismissed_at IS NULL;")" "0"

echo ""
echo "════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
