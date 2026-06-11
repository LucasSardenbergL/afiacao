#!/usr/bin/env bash
# Teste PG17 da feature "e-mail lista os produtos sem família" (20260611180000).
# Aplica schema-snapshot + patch + base 20260604150000 + 20260609085244 (def viva do check/watchdog)
# + a migration nova, semeia produtos sem família e asserta:
#  • _vendas_familia_ausente_lista_email() lista cada produto que conta (NULL/vazia/espaço × ativo ×
#    oben/colacor), com '• [empresa] descrição (cód. X)', e EXCLUI os que não contam (família, inativo,
#    colacor_sc) — mesmo predicado do check (regressão se o helper divergir do compute);
#  • cap honesto: p_limit pequeno mostra os primeiros + "… e mais N"; ordem estável;
#  • n=0 → função retorna NULL (nada a anexar);
#  • E2E: data_health_watchdog() enfileira o e-mail do source família COM a lista no corpo, SEM perder
#    o resumo/breakdown; e o conjunto de checks (17) + os outros sources seguem intactos (anti-cascata).
# Base: db/test-data-health-familia-ausente.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5447
DATA="$(mktemp -d /tmp/pgtest-familia-lista.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-familia-lista.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres familia_lista_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d familia_lista_verify "$@"; }

RR="$(mktemp /tmp/snap-familia-lista.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ patch: omie_products.tipo_produto (stale no snapshot)…"
P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tipo_produto text;"

echo "→ patch: neutraliza fin_audit_trigger buggy do snapshot (no-op)…"
P -v ON_ERROR_STOP=1 -q -c "CREATE OR REPLACE FUNCTION public.fin_audit_trigger() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN COALESCE(NEW, OLD); END; \$f\$;"

echo "→ base: 20260604150000 + 20260609085244 (def viva do check/watchdog)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260604150000_tipo_produto_vigia_cobertura.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260609085244_data_health_check_familia_ausente.sql" >/dev/null

echo "→ migration nova: 20260611180000 (helper + watchdog com a lista no e-mail)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611180000_familia_ausente_lista_email.sql" >/dev/null

echo "→ seed (NULL/vazia/espaço × ativo × account; descrições/códigos conhecidos)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, familia, ativo) VALUES
  (1001,'PRD1001','Faca reta',   'oben',    NULL,         true),   -- conta (NULL)
  (1002,'PRD1002','Rodizio gel', 'oben',    '',           true),   -- conta (vazia → NULLIF)
  (1003,'PRD1003','Primer cinza','oben',    '   ',        true),   -- conta (só espaço → btrim)
  (1004,'PRD1004','Lixa grao',   'oben',    'ABRASIVOS',  true),   -- NÃO conta (tem família)
  (1005,'PRD1005','Item velho',  'oben',    NULL,         false),  -- NÃO conta (inativo)
  (2001,'PRD2001','Cliente X',   'colacor', NULL,         true),   -- conta (NULL)
  (2002,'PRD2002','Cliente Y',   'colacor', '',           true),   -- conta (vazia)
  (3001,'PRD3001','Servico Z',   'colacor_sc', NULL,      true);   -- NÃO conta (fora do wizard)
SQL

PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1 — got[$2] exp[$3]"; FAIL=$((FAIL+1)); fi; }

echo "→ asserts (helper — conteúdo, n=5 que contam)…"
chk "L1 lista contém Faca reta + código + prefixo [oben]" \
  "$(P -tAc "SELECT (public._vendas_familia_ausente_lista_email(50) LIKE '%• [oben] Faca reta (cód. PRD1001)%')::text;")" "true"
chk "L1 lista contém item de família vazia (Rodizio gel)" \
  "$(P -tAc "SELECT (public._vendas_familia_ausente_lista_email(50) LIKE '%Rodizio gel%')::text;")" "true"
chk "L1 lista contém item só-espaço (Primer cinza)" \
  "$(P -tAc "SELECT (public._vendas_familia_ausente_lista_email(50) LIKE '%Primer cinza%')::text;")" "true"
chk "L1 lista contém item colacor com prefixo [colacor]" \
  "$(P -tAc "SELECT (public._vendas_familia_ausente_lista_email(50) LIKE '%• [colacor] Cliente X%')::text;")" "true"
chk "L2 NÃO lista item COM família (Lixa grao)" \
  "$(P -tAc "SELECT (public._vendas_familia_ausente_lista_email(50) LIKE '%Lixa grao%')::text;")" "false"
chk "L2 NÃO lista item INATIVO (Item velho)" \
  "$(P -tAc "SELECT (public._vendas_familia_ausente_lista_email(50) LIKE '%Item velho%')::text;")" "false"
chk "L2 NÃO lista colacor_sc (Servico Z)" \
  "$(P -tAc "SELECT (public._vendas_familia_ausente_lista_email(50) LIKE '%Servico Z%')::text;")" "false"
chk "L3 lista tem exatamente 5 bullets (5 que contam)" \
  "$(P -tAc "SELECT (length(public._vendas_familia_ausente_lista_email(50)) - length(replace(public._vendas_familia_ausente_lista_email(50), '•', '')))::text;")" "5"

echo "→ asserts (cap honesto, p_limit=2 com n=5)…"
chk "L4 cap mostra 2 bullets" \
  "$(P -tAc "SELECT (length(public._vendas_familia_ausente_lista_email(2)) - length(replace(public._vendas_familia_ausente_lista_email(2), '•', '')))::text;")" "2"
chk "L4 cap anuncia '… e mais 3 produto(s)'" \
  "$(P -tAc "SELECT (public._vendas_familia_ausente_lista_email(2) LIKE '%… e mais 3 produto(s)%')::text;")" "true"
chk "L5 sem cap excedido NÃO anuncia 'e mais'" \
  "$(P -tAc "SELECT (public._vendas_familia_ausente_lista_email(50) LIKE '%e mais%')::text;")" "false"

echo "→ asserts (ordem estável: account ASC → colacor antes de oben; alfabética dentro)…"
chk "L6 ordem por empresa: colacor (alfabético) antes de oben" \
  "$(P -tAc "SELECT (strpos(public._vendas_familia_ausente_lista_email(50), '[colacor]') < strpos(public._vendas_familia_ausente_lista_email(50), '[oben]'))::text;")" "true"
chk "L6 dentro de oben, alfabética: Faca reta antes de Rodizio gel" \
  "$(P -tAc "SELECT (strpos(public._vendas_familia_ausente_lista_email(50), 'Faca reta') < strpos(public._vendas_familia_ausente_lista_email(50), 'Rodizio gel'))::text;")" "true"

echo "→ asserts (E2E via watchdog — e-mail enriquecido, anti-cascata)…"
chk "L7 conjunto de checks segue 17 (compute intocado)" \
  "$(P -tAc "SELECT count(*) FROM public._data_health_compute();")" "17"
P -tAc "SELECT public.data_health_watchdog();" >/dev/null
chk "L7 e-mail do source família TEM a lista (Faca reta) no corpo" \
  "$(P -tAc "SELECT (count(*) > 0)::text FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] vendas_familia_ausente' AND mensagem LIKE '%• [oben] Faca reta%';")" "true"
chk "L7 e-mail mantém o resumo/breakdown (5 produto … oben 3)" \
  "$(P -tAc "SELECT (count(*) > 0)::text FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] vendas_familia_ausente' AND mensagem LIKE '%5 produto%' AND mensagem LIKE '%oben 3%';")" "true"
chk "L7 e-mail tem o cabeçalho 'Produtos sem família (classifique no Omie):'" \
  "$(P -tAc "SELECT (count(*) > 0)::text FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] vendas_familia_ausente' AND mensagem LIKE '%Produtos sem família (classifique no Omie):%';")" "true"
# Anti-regressão da cascata real (2026-06-11): o IN-list do watchdog DEVE preservar estoque_reposicao
# (18º check, prod-only/drift §5). A 1ª versão o reverteu por partir da 20260609085244 (12 sources).
chk "L7 watchdog preserva estoque_reposicao no push (anti-cascata)" \
  "$(P -tAc "SELECT (pg_get_functiondef('public.data_health_watchdog()'::regprocedure) LIKE '%estoque_reposicao%')::text;")" "true"
chk "L7 watchdog preserva os outros 12 sources de push (ex.: omie_tipo_produto_oben)" \
  "$(P -tAc "SELECT (pg_get_functiondef('public.data_health_watchdog()'::regprocedure) LIKE '%omie_tipo_produto_oben%')::text;")" "true"

echo "→ asserts (n=0 → função NULL, e-mail dismissado)…"
P -v ON_ERROR_STOP=1 -q -c "UPDATE public.omie_products SET familia='CLASSIFICADO' WHERE account IN ('oben','colacor');"
chk "L8 helper retorna NULL quando não há itens" \
  "$(P -tAc "SELECT (public._vendas_familia_ausente_lista_email(50) IS NULL)::text;")" "true"
P -tAc "SELECT public.data_health_watchdog();" >/dev/null
chk "L8 watchdog dismissou o alerta (0 ativos)" \
  "$(P -tAc "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_vendas_familia_ausente' AND dismissed_at IS NULL;")" "0"

echo ""
echo "════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
