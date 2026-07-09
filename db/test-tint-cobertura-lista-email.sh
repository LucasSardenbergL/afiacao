#!/usr/bin/env bash
# Teste PG17 da frente "e-mail lista as bases MixMachine divergentes" (20260708210000).
# Aplica schema-snapshot (estado VIVO: watchdog 17-sources + compute com tint_cobertura_bases +
# _vendas_familia_ausente_lista_email) + a migration nova, semeia divergência tint e asserta:
#  • _tint_cobertura_bases_lista_email() lista cada produto que CONTA (oben × MixMachine × >30h ×
#    (sem is_tintometric | tint_type errado)) com '• <desc> (cód. X) — <motivo>', e EXCLUI os que NÃO
#    contam (<30h tolerância, inativo, outra família, outro account, já classificado) — mesmo predicado
#    do Check A (regressão se o helper divergir do compute);
#  • motivo correto: 'sem is_tintometric' × 'tint_type "X" deveria ser "base"';
#  • cap honesto: p_limit pequeno mostra os primeiros + "… e mais N"; n=0 → NULL;
#  • E2E: data_health_watchdog() enfileira o e-mail do tint_cobertura_bases COM a lista no corpo, SEM
#    perder a mensagem original; anti-cascata: o append do vendas_familia_ausente e os 17 sources do
#    IN-list seguem intactos (custos_proxy_conf_alta / pedidos_compra_sync não revertidos);
#  • FALSIFICAÇÃO: recria o watchdog SEM o ramo tint → a lista some do e-mail → assert fica VERMELHO.
# Base: db/test-familia-ausente-lista-email.sh + seed de db/test-tint-vigia-cobertura.sh.
# Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5449
DATA="$(mktemp -d /tmp/pgtest-tint-lista.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-tint-lista.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres tint_lista_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d tint_lista_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-tint-lista.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot (estado vivo)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ patch: omie_products.tipo_produto (stale no snapshot)…"
P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tipo_produto text;"

echo "→ patch: neutraliza fin_audit_trigger buggy do snapshot (no-op)…"
P -v ON_ERROR_STOP=1 -q -c "CREATE OR REPLACE FUNCTION public.fin_audit_trigger() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN COALESCE(NEW, OLD); END; \$f\$;"

# Baseline anti-cascata: o watchdog VIVO (do snapshot) já referencia _vendas_familia_ausente_lista_email
# e os 17 sources. Guardo pra provar que a migration nova NÃO os reverte.
echo "→ baseline: watchdog vivo tem o append família + 17 sources…"
P -tAc "SELECT (pg_get_functiondef('public.data_health_watchdog()'::regprocedure) LIKE '%_vendas_familia_ausente_lista_email%')::text;" | grep -qx true \
  || { echo "  ✗ PRÉ-CONDIÇÃO: snapshot sem o append família — abortando"; exit 1; }

echo "→ migration nova: 20260708210000 (helper tint + watchdog com +ramo tint)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260708210000_tint_cobertura_lista_email.sql" >/dev/null

echo "→ seed (divergência tint: 2 contam; 6 NÃO contam por motivos distintos)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, familia, ativo, is_tintometric, tint_type, created_at) VALUES
  (5001,'5001','Base nao marcada velha','oben',   'Bases MixMachine',        true,  false, NULL,          now()-interval '40 hours'), -- CONTA: sem is_tintometric, >30h
  (5002,'5002','Base nao marcada NOVA', 'oben',   'Bases MixMachine',        true,  false, NULL,          now()-interval '10 hours'), -- NÃO: <30h (tolerância)
  (5003,'5003','Base tipo errado',      'oben',   'Bases MixMachine',        true,  true,  'concentrado', now()-interval '50 hours'), -- CONTA: tint_type errado, >30h
  (5004,'5004','Base correta',          'oben',   'Bases MixMachine',        true,  true,  'base',        now()-interval '60 hours'), -- NÃO: classificado
  (5005,'5005','Concentrado correto',   'oben',   'Concentrados MixMachine', true,  true,  'concentrado', now()-interval '60 hours'), -- NÃO: classificado
  (5006,'5006','Base inativa',          'oben',   'Bases MixMachine',        false, false, NULL,          now()-interval '60 hours'), -- NÃO: inativo
  (5007,'5007','Abrasivo comum',        'oben',   'ABRASIVOS',               true,  false, NULL,          now()-interval '60 hours'), -- NÃO: outra família
  (5008,'5008','Base colacor',          'colacor','Bases MixMachine',        true,  false, NULL,          now()-interval '60 hours'); -- NÃO: outro account
SQL

PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1 — got[$2] exp[$3]"; FAIL=$((FAIL+1)); fi; }

echo "→ asserts (helper — conteúdo e motivo)…"
chk "T1 lista contém a base não-marcada (desc+cód. 5001)" \
  "$(P -tAc "SELECT (public._tint_cobertura_bases_lista_email(50) LIKE '%Base nao marcada velha (cód. 5001)%')::text;")" "true"
chk "T1 motivo 'sem is_tintometric' p/ a 5001" \
  "$(P -tAc "SELECT (public._tint_cobertura_bases_lista_email(50) LIKE '%5001) — sem is_tintometric%')::text;")" "true"
chk "T2 lista contém a base tipo-errado (desc+cód. 5003)" \
  "$(P -tAc "SELECT (public._tint_cobertura_bases_lista_email(50) LIKE '%Base tipo errado (cód. 5003)%')::text;")" "true"
chk "T2 motivo 'tint_type \"concentrado\" deveria ser \"base\"' p/ a 5003" \
  "$(P -tAc "SELECT (public._tint_cobertura_bases_lista_email(50) LIKE '%tint_type \"concentrado\" deveria ser \"base\"%')::text;")" "true"

echo "→ asserts (o WHERE morde — exclusões)…"
chk "T3 NÃO lista a base <30h (tolerância: 5002)" \
  "$(P -tAc "SELECT (public._tint_cobertura_bases_lista_email(50) LIKE '%5002%')::text;")" "false"
chk "T4 NÃO lista classificados (5004/5005)" \
  "$(P -tAc "SELECT (public._tint_cobertura_bases_lista_email(50) LIKE '%5004%' OR public._tint_cobertura_bases_lista_email(50) LIKE '%5005%')::text;")" "false"
chk "T5 NÃO lista inativo (5006)" \
  "$(P -tAc "SELECT (public._tint_cobertura_bases_lista_email(50) LIKE '%5006%')::text;")" "false"
chk "T6 NÃO lista outra família (5007 Abrasivo)" \
  "$(P -tAc "SELECT (public._tint_cobertura_bases_lista_email(50) LIKE '%Abrasivo%')::text;")" "false"
chk "T7 NÃO lista outro account (5008 colacor)" \
  "$(P -tAc "SELECT (public._tint_cobertura_bases_lista_email(50) LIKE '%5008%')::text;")" "false"
chk "T8 exatamente 2 bullets (só 5001+5003)" \
  "$(P -tAc "SELECT (length(public._tint_cobertura_bases_lista_email(50)) - length(replace(public._tint_cobertura_bases_lista_email(50), '•', '')))::text;")" "2"

echo "→ asserts (cap honesto, p_limit=1 com n=2)…"
chk "T9 cap mostra 1 bullet" \
  "$(P -tAc "SELECT (length(public._tint_cobertura_bases_lista_email(1)) - length(replace(public._tint_cobertura_bases_lista_email(1), '•', '')))::text;")" "1"
chk "T9 cap anuncia '… e mais 1 item(ns)'" \
  "$(P -tAc "SELECT (public._tint_cobertura_bases_lista_email(1) LIKE '%… e mais 1 item(ns)%')::text;")" "true"

echo "→ asserts (E2E via watchdog — e-mail enriquecido, anti-cascata)…"
P -tAc "SELECT public.data_health_watchdog();" >/dev/null
chk "T10 e-mail do tint_cobertura_bases TEM a lista (cód. 5001) no corpo" \
  "$(P -tAc "SELECT (count(*) > 0)::text FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] tint_cobertura_bases' AND mensagem LIKE '%(cód. 5001)%';")" "true"
chk "T11 e-mail mantém a mensagem original (Cobertura tint: 2 base…)" \
  "$(P -tAc "SELECT (count(*) > 0)::text FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] tint_cobertura_bases' AND mensagem LIKE '%Cobertura tint: 2 %';")" "true"
chk "T12 anti-cascata: watchdog preserva o append vendas_familia_ausente" \
  "$(P -tAc "SELECT (pg_get_functiondef('public.data_health_watchdog()'::regprocedure) LIKE '%_vendas_familia_ausente_lista_email%')::text;")" "true"
chk "T13 anti-cascata: watchdog preserva pedidos_compra_sync no IN-list" \
  "$(P -tAc "SELECT (pg_get_functiondef('public.data_health_watchdog()'::regprocedure) LIKE '%pedidos_compra_sync%')::text;")" "true"
chk "T13 anti-cascata: watchdog preserva custos_proxy_conf_alta no IN-list" \
  "$(P -tAc "SELECT (pg_get_functiondef('public.data_health_watchdog()'::regprocedure) LIKE '%custos_proxy_conf_alta%')::text;")" "true"
chk "T14 compute intocado: tint_cobertura_bases segue 1x" \
  "$(P -tAc "SELECT count(*) FROM public._data_health_compute() WHERE source='tint_cobertura_bases';")" "1"

echo "→ assert (n=0 → função NULL após corrigir)…"
P -v ON_ERROR_STOP=1 -q -c "UPDATE public.omie_products SET is_tintometric=true, tint_type='base' WHERE omie_codigo_produto IN (5001,5003);"
chk "T15 helper retorna NULL quando não há divergentes" \
  "$(P -tAc "SELECT (public._tint_cobertura_bases_lista_email(50) IS NULL)::text;")" "true"

# ── FALSIFICAÇÃO (Lei #3): sabota o watchdog (remove o ramo tint) → a lista some do e-mail.
# Sentinela anti-teatro = 'cód. 5001' (dado do seed, NÃO texto que o watchdog emite).
echo "→ FALSIFICAÇÃO: watchdog SEM o ramo tint → e-mail sem a lista…"
P -v ON_ERROR_STOP=1 -q -c "UPDATE public.omie_products SET is_tintometric=false, tint_type=NULL WHERE omie_codigo_produto IN (5001,5003);"  # re-degrada
P -v ON_ERROR_STOP=1 -q -c "DELETE FROM public.fornecedor_alerta; UPDATE public.fin_alertas SET dismissed_at=now() WHERE dismissed_at IS NULL;"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- watchdog SABOTADO: idêntico ao vivo MAS sem o ramo tint no CASE do e-mail (só o família).
CREATE OR REPLACE FUNCTION public.data_health_watchdog() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public','pg_temp' AS $f$
DECLARE r record; v_sev_fin text; v_sev_forn text;
BEGIN
  FOR r IN SELECT * FROM public._data_health_compute()
    WHERE source IN ('vendas_pedidos','estoque_inventario','estoque_reposicao','reposicao_sugestoes','carteira_scores',
                     'custos_produtos','vendas_cadastros','reposicao_disparo','reposicao_portal_pipeline','reposicao_portal_humano',
                     'reposicao_sayerlack_fabricado','omie_tipo_produto_oben','vendas_familia_ausente','tint_cobertura_bases',
                     'custos_proxy_conf_alta','custos_product_cost_revivido','pedidos_compra_sync')
  LOOP
    v_sev_fin := CASE WHEN r.severity='critical' THEN 'critico' ELSE 'aviso' END;
    v_sev_forn := CASE WHEN r.severity='critical' THEN 'urgente' ELSE 'atencao' END;
    IF r.status <> 'ok' THEN
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES ('oben','data_health_'||r.source, v_sev_fin, r.message,
              jsonb_build_object('source',r.source,'domain',r.domain,'status',r.status,'age_seconds',r.age_seconds,'freshness_basis',r.freshness_basis))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES ('oben','outro', v_sev_forn, '[Saúde de dados] '||r.source,
                CASE WHEN r.source='vendas_familia_ausente'
                     THEN r.message || COALESCE(E'\n\n' || public._vendas_familia_ausente_lista_email(50), '')
                     ELSE r.message END,  -- ← ramo tint REMOVIDO de propósito
                'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at=now() WHERE company='oben' AND tipo='data_health_'||r.source AND dismissed_at IS NULL;
    END IF;
  END LOOP;
END $f$;
SQL
P -tAc "SELECT public.data_health_watchdog();" >/dev/null
FALS="$(P -tAc "SELECT (count(*) > 0)::text FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] tint_cobertura_bases' AND mensagem LIKE '%(cód. 5001)%';")"
chk "F1 SABOTADO: e-mail do tint NÃO tem a lista (assert T10 tem dente)" "$FALS" "false"

echo "→ restaura a migration real (watchdog com o ramo tint)…"
P -v ON_ERROR_STOP=1 -q -c "DELETE FROM public.fornecedor_alerta; UPDATE public.fin_alertas SET dismissed_at=now() WHERE dismissed_at IS NULL;"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260708210000_tint_cobertura_lista_email.sql" >/dev/null
P -tAc "SELECT public.data_health_watchdog();" >/dev/null
chk "F1-restore: e-mail do tint VOLTA a ter a lista (cód. 5001)" \
  "$(P -tAc "SELECT (count(*) > 0)::text FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] tint_cobertura_bases' AND mensagem LIKE '%(cód. 5001)%';")" "true"

echo ""
echo "════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
