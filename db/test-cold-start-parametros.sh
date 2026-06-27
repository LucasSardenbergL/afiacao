#!/usr/bin/env bash
# Teste PG17 da migration cold-start (Fase 2) + fix do gate de cron (20260627130000) — money-path.
# Prova: (BUG) a Fase 2 original com gate auth.role()='service_role' dá 42501 no contexto do
# pg_cron (auth.role()=NULL); (FIX) sem o gate, a função roda no contexto cron e cria/gradua;
# criação (fallback + seed de estoque anti-fantasma), graduação só status OK, idempotência, e
# FALSIFICA (remove o seed → cold-start sem linha em sku_estoque_atual = compra fantasma).
# A view v_sku_parametros_sugeridos (cadeia de demanda) é STUBADA com dados controlados.
# Base: db/verify-snapshot-replay.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17; PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"; PORT=5440
DATA="$(mktemp -d /tmp/pgtest-coldstart.XXXXXX)/data"
export LC_ALL=C LANG=C
FAILS=0
chk() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1 — esperado [$2] obtido [$3]"; FAILS=$((FAILS+1)); fi; }

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"; cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-coldstart.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres coldstart_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d coldstart_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-coldstart.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" | grep -vE '^\\(un)?restrict ' > "$RR"
echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ stub cron.schedule (a migration agenda; pg_cron não roda no PG local)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = p_jobname;
  IF v_id IS NULL THEN
    SELECT COALESCE(MAX(jobid),0)+1 INTO v_id FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v_id, p_jobname, p_schedule, p_command, true);
  ELSE UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v_id; END IF;
  RETURN v_id;
END $$;
SQL

echo "→ aplica a migration 20260626210000 (cold-start ORIGINAL, COM gate)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260626210000_reposicao_cold_start_parametros.sql" >/dev/null

echo "→ auth.role() = NULL (contexto REAL do pg_cron: roda como postgres, SEM JWT)…"
P -v ON_ERROR_STOP=1 -q -c "CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS \$\$ SELECT NULL::text \$\$;"

echo "→ ASSERT BUG: a Fase 2 ORIGINAL (com gate) dá 42501 no contexto cron (prova o bug)…"
STBUG=$(P -tA -c "DO \$\$ BEGIN PERFORM reposicao_cold_start_parametros('OBEN',1,NULL); RAISE NOTICE 'RODOU';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'BUG_42501'; WHEN OTHERS THEN RAISE NOTICE 'OUTRO_%', SQLSTATE; END \$\$;" 2>&1 | grep -oE "BUG_42501|RODOU|OUTRO_[0-9A-Z]+" | head -1)
chk "BUG confirmado: gate bloqueia o cron (42501)" "BUG_42501" "$STBUG"

echo "→ aplica o FIX 20260627130000 (remove o gate)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260627130000_reposicao_cold_start_fix_gate_cron.sql" >/dev/null

echo "→ STUB da v_sku_parametros_sugeridos (substitui a cadeia de demanda por dados controlados)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DROP VIEW IF EXISTS public.v_sku_parametros_sugeridos CASCADE;
CREATE TABLE public.v_sku_parametros_sugeridos (
  empresa text, sku_codigo_omie bigint, status_sugestao text,
  ponto_pedido_sugerido numeric, estoque_maximo_sugerido numeric, estoque_minimo_sugerido numeric,
  estoque_seguranca_sugerido numeric, cobertura_alvo_dias integer
);
SQL

echo "→ seed: catálogo + de-para + cold-start pré-existentes + sugeridos…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, unidade, valor_unitario, ativo, account, tipo_produto, estoque)
VALUES
 (2001,'CS1','VERNIZ PU CS1.1111.00BH','BH',100,true,'oben','00',0),
 (2002,'CS2','VERNIZ PU CS2.2222.00BH','BH',100,true,'oben','00',5),
 (2004,'GRAD','VERNIZ PU GR.4444.00BH','BH',100,true,'oben','00',3),
 (2005,'AGUA','VERNIZ PU AG.5555.00BH','BH',100,true,'oben','00',2);
INSERT INTO public.sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie, sku_portal, unidade_portal, fator_conversao, ativo)
VALUES
 ('OBEN','RENNER SAYERLACK S/A','2001','CS1.1111.00BH','BH',1,true),
 ('OBEN','RENNER SAYERLACK S/A','2002','CS2.2222.00BH','BH',1,true),
 ('OBEN','RENNER SAYERLACK S/A','2004','GR.4444.00BH','BH',1,true),
 ('OBEN','RENNER SAYERLACK S/A','2005','AG.5555.00BH','BH',1,true);
INSERT INTO public.sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome,
  classe_abc, classe_xyz, estoque_minimo, ponto_pedido, estoque_maximo,
  estoque_seguranca, cobertura_alvo_dias, habilitado_reposicao_automatica, tipo_reposicao, ativo, parametro_cold_start)
VALUES
 ('OBEN',2004,'VERNIZ PU GR.4444.00BH','RENNER SAYERLACK S/A','C','Z',1,1,2,0,30,true,'automatica',true,true),
 ('OBEN',2005,'VERNIZ PU AG.5555.00BH','RENNER SAYERLACK S/A','C','Z',1,1,2,0,30,true,'automatica',true,true);
INSERT INTO public.v_sku_parametros_sugeridos (empresa, sku_codigo_omie, status_sugestao,
  ponto_pedido_sugerido, estoque_maximo_sugerido, estoque_minimo_sugerido, estoque_seguranca_sugerido, cobertura_alvo_dias)
VALUES
 ('OBEN',2004,'OK',5,10,3,2,20),
 ('OBEN',2005,'AGUARDANDO_SEGUNDA_ORDEM',NULL,NULL,NULL,NULL,NULL);
SQL

echo "→ ASSERT 1: elegibilidade (4 compráveis com de-para)…"
chk "view lista 4 elegíveis" "4" "$(P -tA -c "SELECT count(*) FROM v_reposicao_cold_start_elegivel")"

echo "→ ASSERT 2: chamada no contexto cron (auth.role()=NULL) — agora RODA (graduados=1, criados=2)…"
RET=$(P -tA -F',' -c "SELECT * FROM reposicao_cold_start_parametros('OBEN',50,gen_random_uuid())")
chk "FIX: roda no contexto cron e retorna (1,2)" "1,2" "$RET"

echo "→ ASSERT 3: GRADUAÇÃO de 2004 (aplica real, limpa flag)…"
chk "2004 ponto_pedido=5"    "5"  "$(P -tA -c "SELECT ponto_pedido FROM sku_parametros WHERE sku_codigo_omie=2004")"
chk "2004 estoque_maximo=10" "10" "$(P -tA -c "SELECT estoque_maximo FROM sku_parametros WHERE sku_codigo_omie=2004")"
chk "2004 cold_start=false"  "f"  "$(P -tA -c "SELECT parametro_cold_start FROM sku_parametros WHERE sku_codigo_omie=2004")"
chk "audit 2004=graduado"    "graduado" "$(P -tA -c "SELECT acao FROM reposicao_cold_start_log WHERE sku_codigo_omie='2004'")"

echo "→ ASSERT 4: 2005 NÃO graduou (status AGUARDANDO → fica no fallback)…"
chk "2005 ponto_pedido=1 (intacto)"  "1" "$(P -tA -c "SELECT ponto_pedido FROM sku_parametros WHERE sku_codigo_omie=2005")"
chk "2005 cold_start=true (intacto)" "t" "$(P -tA -c "SELECT parametro_cold_start FROM sku_parametros WHERE sku_codigo_omie=2005")"

echo "→ ASSERT 5: CRIAÇÃO de 2001/2002 (fallback + seed de estoque anti-fantasma)…"
chk "2001 criado habilitado"   "t" "$(P -tA -c "SELECT habilitado_reposicao_automatica FROM sku_parametros WHERE sku_codigo_omie=2001")"
chk "2001 fallback pp=1/max=2"  "1,2" "$(P -tA -F',' -c "SELECT ponto_pedido,estoque_maximo FROM sku_parametros WHERE sku_codigo_omie=2001")"
chk "2001 classe C/Z"           "C,Z" "$(P -tA -F',' -c "SELECT classe_abc,classe_xyz FROM sku_parametros WHERE sku_codigo_omie=2001")"
chk "2001 SEED estoque (fonte, fis=0)" "0,cold_start_seed" "$(P -tA -F',' -c "SELECT estoque_fisico,fonte_sync FROM sku_estoque_atual WHERE sku_codigo_omie='2001'")"
chk "2002 SEED estoque=5"       "5,cold_start_seed" "$(P -tA -F',' -c "SELECT estoque_fisico,fonte_sync FROM sku_estoque_atual WHERE sku_codigo_omie='2002'")"

echo "→ ASSERT 6: idempotência (2ª chamada → 0,0)…"
RET2=$(P -tA -F',' -c "SELECT * FROM reposicao_cold_start_parametros('OBEN',50,NULL)")
chk "2ª rodada (0 grad, 0 cri)" "0,0" "$RET2"

echo "→ ASSERT 7: gate REMOVIDO (a função não levanta mais o RAISE do gate)…"
# checa a ausência do RAISE do gate, não da string 'auth.role()' (que aparece no comentário do fix)
chk "função sem RAISE EXCEPTION de gate" "t" "$(P -tA -c "SELECT pg_get_functiondef('public.reposicao_cold_start_parametros(text,int,uuid)'::regprocedure) NOT ILIKE '%RAISE EXCEPTION%'")"

echo "→ ASSERT 8 (FALSIFICAÇÃO): sem o seed de estoque, o cold-start novo fica SEM linha em sku_estoque_atual (compra fantasma)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, unidade, valor_unitario, ativo, account, tipo_produto, estoque)
VALUES (2009,'CS9','VERNIZ PU CS9.9999.00BH','BH',100,true,'oben','00',7);
INSERT INTO public.sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie, sku_portal, unidade_portal, fator_conversao, ativo)
VALUES ('OBEN','RENNER SAYERLACK S/A','2009','CS9.9999.00BH','BH',1,true);
-- sabota: recria a função SEM o INSERT de seed (e sem gate, igual ao fix)
CREATE OR REPLACE FUNCTION public.reposicao_cold_start_parametros(p_empresa text DEFAULT 'OBEN', p_limite int DEFAULT 50, p_run_id uuid DEFAULT NULL)
RETURNS TABLE(graduados int, criados int) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
DECLARE v_cri int:=0; BEGIN
  INSERT INTO public.sku_parametros (empresa,sku_codigo_omie,sku_descricao,fornecedor_nome,classe_abc,classe_xyz,
    estoque_minimo,ponto_pedido,estoque_maximo,estoque_seguranca,cobertura_alvo_dias,habilitado_reposicao_automatica,tipo_reposicao,ativo,parametro_cold_start)
  SELECT p_empresa,e.sku_codigo_omie,e.sku_descricao,e.fornecedor_nome,'C','Z',1,1,2,0,30,true,'automatica',true,true
  FROM public.v_reposicao_cold_start_elegivel e
  WHERE e.estoque_catalogo IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.sku_parametros sp WHERE sp.empresa=p_empresa AND sp.sku_codigo_omie=e.sku_codigo_omie)
    AND NOT EXISTS (SELECT 1 FROM public.v_sku_parametros_sugeridos v WHERE v.empresa=p_empresa AND v.sku_codigo_omie=e.sku_codigo_omie AND v.status_sugestao='OK')
  ON CONFLICT (empresa,sku_codigo_omie) DO NOTHING;
  GET DIAGNOSTICS v_cri = ROW_COUNT;
  RETURN QUERY SELECT 0, v_cri;
END $f$;
SQL
P -tA -c "SELECT reposicao_cold_start_parametros('OBEN',50,NULL)" >/dev/null
FANTASMA=$(P -tA -c "SELECT (EXISTS(SELECT 1 FROM sku_parametros WHERE sku_codigo_omie=2009 AND habilitado_reposicao_automatica))
  AND NOT EXISTS(SELECT 1 FROM sku_estoque_atual WHERE sku_codigo_omie='2009')")
chk "FALSIFICAÇÃO: sem seed, cold-start habilitado SEM estoque (fantasma)" "t" "$FANTASMA"

echo ""
if [ "$FAILS" -eq 0 ]; then echo "✅ TODOS OS ASSERTS PASSARAM (cold-start + fix do gate cron provados no PG17)"; else echo "❌ $FAILS ASSERT(S) FALHARAM"; exit 1; fi
