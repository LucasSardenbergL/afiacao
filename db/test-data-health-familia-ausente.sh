#!/usr/bin/env bash
# Teste PG17 do check 'vendas_familia_ausente' no Sentinela (_data_health_compute + watchdog + heartbeat).
# Aplica schema-snapshot + patch (omie_products.tipo_produto, stale no snapshot) + a BASE 20260604150000
# (def viva presumida, 16 checks) + a migration nova 20260609085244 (CREATE OR REPLACE → 17 checks),
# semeia cenários de família NULL/vazia/espaço × ativo × account, e asserta:
#  • a função COMPILA e retorna 17 checks (nenhum dos 16 anteriores some) — pega typo no UNION ALL;
#  • o check conta certo (NULLIF(btrim(familia),'') cobre vazio/espaço; inativo e colacor_sc fora);
#  • a mensagem traz o breakdown oben/colacor; status/severity stale/warning quando n>0;
#  • o PUSH end-to-end: data_health_watchdog() insere em fin_alertas + fornecedor_alerta (n>0) e
#    dismissa quando zera (n=0); fin_sync_heartbeat() inclui o source no resumo (IN-list).
# Base: db/verify-snapshot-replay.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5441
DATA="$(mktemp -d /tmp/pgtest-familia.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-familia.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres familia_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d familia_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-familia.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ patch: omie_products.tipo_produto (stale no snapshot)…"
P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tipo_produto text;"

# O snapshot traz a versão ANTIGA buggy do fin_audit_trigger ((NEW).data_emissao direto, quebra em
# tabela sem essa coluna) — corrigida em PROD p/ to_jsonb (§5/§10). É artefato do snapshot stale, não
# da feature: em prod o watchdog insere em fin_alertas sem erro. Neutralizo (no-op) p/ testar o push.
echo "→ patch: neutraliza fin_audit_trigger buggy do snapshot (no-op)…"
P -v ON_ERROR_STOP=1 -q -c "CREATE OR REPLACE FUNCTION public.fin_audit_trigger() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN COALESCE(NEW, OLD); END; \$f\$;"

echo "→ base: 20260604150000 (16 checks — def viva presumida)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260604150000_tipo_produto_vigia_cobertura.sql" >/dev/null

echo "→ migration nova: 20260609085244 (CREATE OR REPLACE → 17 checks)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260609085244_data_health_check_familia_ausente.sql" >/dev/null

echo "→ seed dos cenários (NULL/vazia/espaço × ativo × account)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, familia, ativo) VALUES
  (1001,'1001','Faca reta',  'oben',    NULL,         true),   -- conta (NULL)
  (1002,'1002','Rodizio gel', 'oben',    '',           true),   -- conta (vazia → NULLIF)
  (1003,'1003','Primer cinza','oben',    '   ',        true),   -- conta (só espaço → btrim)
  (1004,'1004','Lixa grao',   'oben',    'ABRASIVOS',  true),   -- NÃO conta (tem família)
  (1005,'1005','Item velho',  'oben',    NULL,         false),  -- NÃO conta (inativo)
  (2001,'2001','Cliente X',   'colacor', NULL,         true),   -- conta (NULL)
  (2002,'2002','Cliente Y',   'colacor', '',           true),   -- conta (vazia)
  (3001,'3001','Serviço Z',   'colacor_sc', NULL,      true);   -- NÃO conta (fora do wizard)
SQL

PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1 — got[$2] exp[$3]"; FAIL=$((FAIL+1)); fi; }

echo "→ asserts (compute, n=5)…"
chk "A1 total de checks = 17 (16 + 1)" \
  "$(P -tAc "SELECT count(*) FROM public._data_health_compute();")" "17"
chk "A2 source vendas_familia_ausente aparece 1x" \
  "$(P -tAc "SELECT count(*) FROM public._data_health_compute() WHERE source='vendas_familia_ausente';")" "1"
chk "A3 status=stale com n>0" \
  "$(P -tAc "SELECT status FROM public._data_health_compute() WHERE source='vendas_familia_ausente';")" "stale"
chk "A3 severity=warning com n>0" \
  "$(P -tAc "SELECT severity FROM public._data_health_compute() WHERE source='vendas_familia_ausente';")" "warning"
chk "A3 message = 5 total + breakdown oben 3 · colacor 2" \
  "$(P -tAc "SELECT (message LIKE '%5 produto%' AND message LIKE '%oben 3%' AND message LIKE '%colacor 2%') FROM public._data_health_compute() WHERE source='vendas_familia_ausente';")" "t"
chk "A4 os 16 checks anteriores seguem presentes" \
  "$(P -tAc "SELECT count(*) FROM public._data_health_compute() WHERE source IN ('saldo_bancario','contas_receber','contas_pagar','omie_sync_financeiro','vendas_pedidos','estoque_inventario','reposicao_sugestoes','carteira_scores','custos_produtos','vendas_cadastros','reposicao_disparo','reposicao_portal_pipeline','reposicao_portal_humano','reposicao_sayerlack_fabricado','omie_tipo_produto_oben','alert_channel');")" "16"

echo "→ asserts (push end-to-end via watchdog, n=5)…"
P -tAc "SELECT public.data_health_watchdog();" >/dev/null
chk "A5 fin_alertas tem data_health_vendas_familia_ausente ativo" \
  "$(P -tAc "SELECT count(*) FROM public.fin_alertas WHERE company='oben' AND tipo='data_health_vendas_familia_ausente' AND dismissed_at IS NULL;")" "1"
chk "A5 fornecedor_alerta enfileirou e-mail do source" \
  "$(P -tAc "SELECT (count(*) > 0)::text FROM public.fornecedor_alerta WHERE titulo LIKE '%vendas_familia_ausente%' AND status='pendente_notificacao';")" "true"

echo "→ asserts (dismiss quando zera, n=0)…"
P -v ON_ERROR_STOP=1 -q -c "UPDATE public.omie_products SET familia='CLASSIFICADO' WHERE account IN ('oben','colacor');"
chk "A6 check volta a ok com n=0" \
  "$(P -tAc "SELECT status FROM public._data_health_compute() WHERE source='vendas_familia_ausente';")" "ok"
chk "A6 check volta a severity info com n=0" \
  "$(P -tAc "SELECT severity FROM public._data_health_compute() WHERE source='vendas_familia_ausente';")" "info"
P -tAc "SELECT public.data_health_watchdog();" >/dev/null
chk "A6 watchdog dismissou o alerta (0 ativos)" \
  "$(P -tAc "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_vendas_familia_ausente' AND dismissed_at IS NULL;")" "0"

echo "→ assert (heartbeat inclui o source no resumo)…"
P -tAc "SELECT public.fin_sync_heartbeat();" >/dev/null
chk "A7 heartbeat menciona vendas_familia_ausente no resumo" \
  "$(P -tAc "SELECT (count(*) > 0)::text FROM public.fornecedor_alerta WHERE titulo LIKE '[Watchdog%' AND mensagem LIKE '%vendas_familia_ausente%';")" "true"

echo ""
echo "════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
