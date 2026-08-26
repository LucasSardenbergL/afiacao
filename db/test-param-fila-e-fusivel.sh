#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"     # mude se rodar em paralelo com outro harness (40 worktrees)
SLUG="param-fila-fusivel"       # A (sensor de fila) + B (fusível na graduação do cold-start)
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# keg-only do brew: share/lib do postgresql@17 podem não estar linkados → initdb/server falham. Copia do Cellar (idempotente).
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS DE SCHEMA (o que a migração LÊ/ALTERA mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
# Opção (a) MÍNIMO — stub só das tabelas/colunas que a migração toca:
# P -q <<'SQL'
# CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role text);
# CREATE TABLE IF NOT EXISTS public.[[tabela_que_a_migracao_le]] ( ... colunas usadas ... );
# SQL
#
# Opção (b) FIEL — aplica o snapshot inteiro (pega dependências reais; mais lento):
# RR="$(mktemp /tmp/snap-rr.XXXXXX.sql)"
# sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
#   | grep -vE '^\\(un)?restrict ' > "$RR"
# P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
# P --single-transaction -q -f "$RR"; rm -f "$RR"
# ⚠️ snapshot pode estar STALE — se faltar coluna recente, ALTER TABLE ... ADD COLUMN IF NOT EXISTS antes.
#

# Pré-requisitos: as tabelas/views que as DUAS migrations LEEM mas não criam.
# Lei #1: os PRÉ-REQUISITOS podem ser stub; as FUNÇÕES SOB TESTE são as reais (ZONA 2).
# `v_sku_parametros_sugeridos` entra como TABELA (não view) para poder semear cenário
# de salto — a view real é a cascata fail-closed medida em prod, e o que importa aqui
# é o CONTRATO que as funções consomem (status_sugestao + os *_sugerido).
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE public.company_config (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  key text UNIQUE NOT NULL,
  value text NOT NULL
);

CREATE TABLE public.sku_parametros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL,
  sku_codigo_omie bigint NOT NULL,
  sku_descricao text,
  fornecedor_nome text,
  classe_abc text, classe_xyz text,
  estoque_minimo numeric, ponto_pedido numeric, estoque_maximo numeric,
  estoque_seguranca numeric, cobertura_alvo_dias integer,
  habilitado_reposicao_automatica boolean DEFAULT true,
  tipo_reposicao text,
  ativo boolean DEFAULT true,
  parametro_cold_start boolean NOT NULL DEFAULT false,
  ultima_atualizacao_calculo timestamptz,
  UNIQUE (empresa, sku_codigo_omie)
);

CREATE TABLE public.v_sku_parametros_sugeridos (
  empresa text, sku_codigo_omie bigint, sku_descricao text, fornecedor_nome text,
  status_sugestao text, num_ordens integer, fonte_leadtime text,
  estoque_minimo_sugerido numeric, ponto_pedido_sugerido numeric,
  estoque_maximo_sugerido numeric, estoque_seguranca_sugerido numeric,
  cobertura_alvo_dias integer
);

CREATE TABLE public.v_reposicao_cold_start_elegivel (
  empresa text, sku_codigo_omie bigint, sku_descricao text,
  fornecedor_nome text, estoque_catalogo numeric
);

CREATE TABLE public.sku_estoque_atual (
  empresa text, sku_codigo_omie text,
  estoque_fisico numeric, estoque_disponivel numeric, estoque_pendente_entrada numeric,
  ultima_sincronizacao timestamptz, fonte_sync text,
  UNIQUE (empresa, sku_codigo_omie)
);

CREATE TABLE public.reposicao_cold_start_log (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  run_id uuid, criado_em timestamptz NOT NULL DEFAULT now(),
  empresa text NOT NULL, sku_codigo_omie text, sku_descricao text,
  acao text NOT NULL, habilitado boolean, detalhe text,
  CONSTRAINT reposicao_cold_start_log_acao_check
    CHECK (acao = ANY (ARRAY['criado'::text,'graduado'::text]))
);

CREATE TABLE public.reposicao_param_limbo_log (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  empresa text NOT NULL, medido_em date NOT NULL DEFAULT CURRENT_DATE,
  limbo_count integer NOT NULL, criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_reposicao_param_limbo_log_dia
  ON public.reposicao_param_limbo_log (empresa, medido_em);

CREATE TABLE public.fin_alertas (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  company text NOT NULL, tipo text NOT NULL, severidade text NOT NULL,
  mensagem text, valor numeric, threshold numeric, contexto jsonb,
  criado_em timestamptz NOT NULL DEFAULT now(), dismissed_at timestamptz,
  CONSTRAINT fin_alertas_company_check
    CHECK (company = ANY (ARRAY['oben'::text,'colacor'::text,'colacor_sc'::text])),
  CONSTRAINT fin_alertas_severidade_check
    CHECK (severidade = ANY (ARRAY['info'::text,'aviso'::text,'critico'::text]))
);
CREATE UNIQUE INDEX fin_alertas_unique_ativo
  ON public.fin_alertas (company, tipo) WHERE dismissed_at IS NULL;

-- pg_cron não existe no PG17 local: stub que REGISTRA o agendamento, para o
-- assert provar que a migration realmente agenda (sensor sem cron é sensor mudo).
-- cron.job já vem de db/stubs-supabase.sql (jobid é PK sem identity, jobname sem unique).
-- Só acrescentamos o índice que o UPSERT por nome precisa + a função schedule().
CREATE UNIQUE INDEX IF NOT EXISTS uq_cron_job_jobname ON cron.job (jobname);
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v_id bigint;
BEGIN
  INSERT INTO cron.job (jobid, jobname, schedule, command, active)
  VALUES ((SELECT COALESCE(max(jobid),0)+1 FROM cron.job), p_name, p_sched, p_cmd, true)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid INTO v_id;
  RETURN v_id;
END $f$;

-- capability de leitura de compras (padrão das tabelas irmãs de reposição)
CREATE TABLE public.cap_compras (user_id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION private.cap_compras_ler(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.cap_compras c WHERE c.user_id = p_uid) $f$;
SQL



# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1: o .sql commitado, não um stub)
# ══════════════════════════════════════════════════════════════════════════════
MIG_A="$REPO_ROOT/supabase/migrations/20260826020000_reposicao_param_fila_sensor.sql"
MIG_B="$REPO_ROOT/supabase/migrations/20260826021000_reposicao_cold_start_fusivel_graduacao.sql"

# B depende do CHECK estendido de A? Não — mas depende da ORDEM de aplicação declarada
# no cabeçalho de B (A primeiro). Aplicamos na mesma ordem que o founder vai colar.
P -q -f "$MIG_A"; echo "migration aplicada: $(basename "$MIG_A")"

# A função real de cold-start (a versão ANTES de B) precisa existir para B fazer
# CREATE OR REPLACE por cima — é o que acontece em prod. Criamos a versão VIVA medida
# em prod 2026-08-26 01:39 UTC, reduzida ao ramo GRADUAR/CRIAR que B substitui.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.reposicao_cold_start_parametros(
  p_empresa text DEFAULT 'OBEN'::text, p_limite integer DEFAULT 50, p_run_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(graduados integer, criados integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE v_grad int := 0; v_cri int := 0;
BEGIN
  WITH grad AS (
    UPDATE public.sku_parametros sp SET
      estoque_minimo = v.estoque_minimo_sugerido, ponto_pedido = v.ponto_pedido_sugerido,
      estoque_maximo = v.estoque_maximo_sugerido, estoque_seguranca = v.estoque_seguranca_sugerido,
      cobertura_alvo_dias = v.cobertura_alvo_dias, parametro_cold_start = false,
      ultima_atualizacao_calculo = now()
    FROM public.v_sku_parametros_sugeridos v
    WHERE sp.empresa = v.empresa AND sp.sku_codigo_omie = v.sku_codigo_omie
      AND sp.empresa = p_empresa AND sp.parametro_cold_start = true
      AND v.status_sugestao = 'OK'
      AND v.ponto_pedido_sugerido IS NOT NULL AND v.estoque_maximo_sugerido IS NOT NULL
    RETURNING sp.sku_codigo_omie, sp.sku_descricao)
  INSERT INTO public.reposicao_cold_start_log (run_id, empresa, sku_codigo_omie, sku_descricao, acao, detalhe)
  SELECT p_run_id, p_empresa, g.sku_codigo_omie::text, g.sku_descricao, 'graduado', 'ganhou demanda (status OK)'
  FROM grad g;
  GET DIAGNOSTICS v_grad = ROW_COUNT;
  RETURN QUERY SELECT v_grad, v_cri;
END $function$;
SQL
echo "baseline (cold-start SEM fusível, como em prod) criada"

P -q -f "$MIG_B"; echo "migration aplicada: $(basename "$MIG_B")"



# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTs (semeie como postgres; conceda privilégio p/ os asserts de RLS)
# ══════════════════════════════════════════════════════════════════════════════
# Semeie como postgres (superuser ignora RLS e TEM privilégio). NÃO use SET ROLE service_role p/
# semear: BYPASSRLS ignora a RLS mas NÃO concede GRANT → "permission denied" na tabela.
# A migration do repo é --no-privileges (Supabase concede em runtime); aqui você concede p/ que os
# asserts de RLS (SET ROLE authenticated/anon) leiam — a RLS filtra por cima.
# ⚠️ a policy é avaliada com os privilégios do CALLER: se faz subselect noutra tabela (ex.: user_roles),
#    conceda SELECT nela TAMBÉM, senão a própria policy dá permission denied.
# P -q <<'SQL'
# INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111') ON CONFLICT DO NOTHING;
# INSERT INTO public.[[tabela]] (...) VALUES (...);
# GRANT SELECT ON public.[[tabela]], public.user_roles TO authenticated, anon;
# SQL
#

P -q <<'SQL'
INSERT INTO public.company_config (key, value) VALUES ('param_auto_fusivel_mult','3')
  ON CONFLICT (key) DO NOTHING;

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),   -- staff com cap de compras
  ('22222222-2222-2222-2222-222222222222')    -- usuário SEM cap
ON CONFLICT DO NOTHING;
INSERT INTO public.cap_compras(user_id) VALUES ('11111111-1111-1111-1111-111111111111');

-- ── população para B (fusível na graduação) ──
-- Todos cold-start com status OK; o que muda é a MAGNITUDE do salto e a âncora.
INSERT INTO public.sku_parametros
 (empresa, sku_codigo_omie, sku_descricao, estoque_maximo, ponto_pedido, parametro_cold_start, ativo)
VALUES
 ('OBEN', 1001, 'SALTO 2.5x (histórico real: 2->5)', 2, 1, true,  true),
 ('OBEN', 1002, 'SALTO 10x (estoura o fusível)',     2, 1, true,  true),
 ('OBEN', 1003, 'SEM ÂNCORA (max = 0)',              0, 1, true,  true),
 ('OBEN', 1004, 'SALTO 3.0x exato (limite inclusivo)', 2, 1, true, true);

INSERT INTO public.v_sku_parametros_sugeridos
 (empresa, sku_codigo_omie, sku_descricao, status_sugestao, num_ordens, fonte_leadtime,
  estoque_minimo_sugerido, ponto_pedido_sugerido, estoque_maximo_sugerido,
  estoque_seguranca_sugerido, cobertura_alvo_dias)
VALUES
 ('OBEN', 1001, 'SALTO 2.5x (histórico real: 2->5)', 'OK', 5, 'FORNECEDOR', 2, 3,  5, 1, 46),
 ('OBEN', 1002, 'SALTO 10x (estoura o fusível)',     'OK', 5, 'FORNECEDOR', 2, 8, 20, 1, 46),
 ('OBEN', 1003, 'SEM ÂNCORA (max = 0)',              'OK', 5, 'FORNECEDOR', 2, 3,  5, 1, 46),
 ('OBEN', 1004, 'SALTO 3.0x exato (limite inclusivo)','OK', 5, 'FORNECEDOR', 2, 4,  6, 1, 46);

-- ── população para A (sensor de fila): SKUs travados em estágios distintos ──
INSERT INTO public.sku_parametros
 (empresa, sku_codigo_omie, sku_descricao, ponto_pedido, estoque_maximo,
  habilitado_reposicao_automatica, ativo)
VALUES
 ('OBEN', 2001, 'travado: sem 2a ordem',   NULL, NULL, true,  true),
 ('OBEN', 2002, 'travado: sem lead time',  NULL, NULL, true,  true),
 ('OBEN', 2003, 'travado: fora da janela', NULL, NULL, false, true),
 ('OBEN', 2004, 'travado: só max nulo',       5, NULL, true,  true),
 ('OBEN', 2005, 'INATIVO (não conta)',     NULL, NULL, true,  false);

INSERT INTO public.v_sku_parametros_sugeridos
 (empresa, sku_codigo_omie, status_sugestao, num_ordens)
VALUES
 ('OBEN', 2001, 'AGUARDANDO_SEGUNDA_ORDEM', 1),
 ('OBEN', 2002, 'SEM_LEADTIME_DEFINIDO',    5),
 ('OBEN', 2004, 'SEM_PRECO',                7);
 -- 2003 deliberadamente AUSENTE da view => estágio FORA_JANELA_DEMANDA

GRANT SELECT ON public.reposicao_param_fila_log, public.cap_compras TO authenticated, anon;
GRANT SELECT ON public.sku_parametros, public.v_sku_parametros_sugeridos TO authenticated, anon;
GRANT SELECT ON public.v_reposicao_param_fila TO authenticated, anon;
SQL



# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS (positivo / negativo-com-SQLSTATE / RLS) — ver assert-patterns.md
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"
# POSITIVO:
#   V=$(Pq -c "SELECT status FROM public.[[...]] WHERE id='...';"); eq "A1 efeito" "$V" "aprovado"
# NEGATIVO (gate/CHECK rejeita — captura a SQLSTATE esperada e re-lança o resto):
#   R=$(P -tA 2>&1 <<'SQL' ... SQL )  ← 2>&1 ESSENCIAL: o RAISE NOTICE da sentinela sai no STDERR
#   ver references/assert-patterns.md (bloco DO ... EXCEPTION WHEN <sqlstate> ... WHEN OTHERS THEN RAISE)
# RLS (own-scope / staff / anon-deny):
#   OWN=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.[[...]];" | tail -1)
#   eq "A2 own-scope" "$OWN" "1"
#

# ─────────────── B — fusível na graduação ───────────────
Pq -c "SELECT * FROM public.reposicao_cold_start_parametros('OBEN', 0, NULL);" >/dev/null

# B1 — salto dentro do fusível GRADUA (não regride o caminho feliz: é o perfil dos 8 históricos)
V=$(Pq -c "SELECT estoque_maximo::text || '|' || parametro_cold_start::text FROM public.sku_parametros WHERE sku_codigo_omie=1001;")
eq "B1 salto 2.5x gradua (max escrito, cold_start desligado)" "$V" "5|false"

# B2 — salto ACIMA do fusível NÃO grava parâmetro e mantém cold-start
V=$(Pq -c "SELECT COALESCE(estoque_maximo::text,'NULL') || '|' || parametro_cold_start::text FROM public.sku_parametros WHERE sku_codigo_omie=1002;")
eq "B2 salto 10x NAO grava (max intacto, segue cold_start)" "$V" "2|true"

# B3 — o barrado é REGISTRADO (não vira vão silencioso — a lição do #2022)
V=$(Pq -c "SELECT acao FROM public.reposicao_cold_start_log WHERE sku_codigo_omie='1002';")
eq "B3 salto barrado registra 'segurado'" "$V" "segurado"

# B4 — sem âncora de magnitude (max<=0) segura, não grava
V=$(Pq -c "SELECT estoque_maximo::text || '|' || parametro_cold_start::text FROM public.sku_parametros WHERE sku_codigo_omie=1003;")
eq "B4 sem ancora (max=0) NAO grava" "$V" "0|true"
V=$(Pq -c "SELECT acao FROM public.reposicao_cold_start_log WHERE sku_codigo_omie='1003';")
eq "B4b sem ancora registra 'segurado'" "$V" "segurado"

# B5 — limite INCLUSIVO: exatamente 3.0x passa (o fusível é '>', não '>=')
V=$(Pq -c "SELECT estoque_maximo::text || '|' || parametro_cold_start::text FROM public.sku_parametros WHERE sku_codigo_omie=1004;")
eq "B5 salto 3.0x exato gradua (limite inclusivo)" "$V" "6|false"

# B6 — o CHECK do log realmente aceita 'segurado' E segue rejeitando lixo (SQLSTATE 23514)
R=$(P -tA 2>&1 <<'SQL'
DO $$
BEGIN
  INSERT INTO public.reposicao_cold_start_log (empresa, sku_codigo_omie, acao)
  VALUES ('OBEN', '9999', 'valor_invalido_qualquer');
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in
  *SENTINELA_BARROU_CERTO*) ok "B6 CHECK do log rejeita ação inválida (23514)" ;;
  *) bad "B6 CHECK do log NAO rejeitou — veio [$R]" ;;
esac

# ─────────────── A — sensor de fila ───────────────
Pq -c "SELECT * FROM public.reposicao_param_fila_sensor('OBEN');" >/dev/null

# A1 — COMPLETUDE: todo SKU travado cai em exatamente UM estágio (sem órfão, sem dupla contagem)
V=$(Pq -c "SELECT (SELECT count(*) FROM public.v_reposicao_param_fila WHERE empresa='OBEN')::text || '|' || (SELECT COALESCE(sum(total),0)::text FROM public.reposicao_param_fila_log WHERE empresa='OBEN' AND medido_em=CURRENT_DATE);")
eq "A1 completude: view == soma do log (1 estagio por SKU)" "$V" "4|4"

# A2 — INATIVO não entra na fila (2005 é ativo=false)
V=$(Pq -c "SELECT count(*) FROM public.v_reposicao_param_fila WHERE sku_codigo_omie=2005;")
eq "A2 SKU inativo fora da fila" "$V" "0"

# A3 — SKU ausente da view de sugestões vira FORA_JANELA_DEMANDA (não some)
V=$(Pq -c "SELECT estagio FROM public.v_reposicao_param_fila WHERE sku_codigo_omie=2003;")
eq "A3 ausente da view => FORA_JANELA_DEMANDA" "$V" "FORA_JANELA_DEMANDA"

# A4 — DENOMINADOR: habilitados contados à parte dos ativos (lição do Codex)
V=$(Pq -c "SELECT sum(total)::text || '|' || sum(habilitados)::text FROM public.reposicao_param_fila_log WHERE empresa='OBEN' AND medido_em=CURRENT_DATE;")
eq "A4 denominador separa total de habilitados" "$V" "4|3"

# A5 — ESTAGNAÇÃO fail-closed: série curta NÃO alerta (ausência de dado != saudável nem estagnado)
V=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='reposicao_param_fila_estagnada' AND dismissed_at IS NULL;")
eq "A5 sem serie suficiente NAO alerta" "$V" "0"

# A6 — com série CONGELADA de 14 dias, alerta dispara (o caso real: 119 parado há 20d)
P -q <<'SQL'
INSERT INTO public.reposicao_param_limbo_log (empresa, medido_em, limbo_count)
SELECT 'OBEN', CURRENT_DATE - g, 119 FROM generate_series(0,20) g
ON CONFLICT (empresa, medido_em) DO UPDATE SET limbo_count = EXCLUDED.limbo_count;
SQL
Pq -c "SELECT * FROM public.reposicao_param_fila_sensor('OBEN');" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='reposicao_param_fila_estagnada' AND dismissed_at IS NULL;")
eq "A6 serie congelada 14d dispara alerta de estagnacao" "$V" "1"

# A7 — fila DRENANDO não alerta, e resolve o alerta anterior
P -q <<'SQL'
UPDATE public.reposicao_param_limbo_log SET limbo_count = 119 + (CURRENT_DATE - medido_em)
WHERE empresa='OBEN';
SQL
Pq -c "SELECT * FROM public.reposicao_param_fila_sensor('OBEN');" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='reposicao_param_fila_estagnada' AND dismissed_at IS NULL;")
eq "A7 fila drenando NAO alerta (e dismissa o anterior)" "$V" "0"

# A8 — RLS: quem NÃO tem cap_compras não lê o log; quem tem, lê
DENY=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT count(*) FROM public.reposicao_param_fila_log;" | tail -1)
eq "A8 sem cap_compras NAO le o log" "$DENY" "0"
ALLOW=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) > 0 FROM public.reposicao_param_fila_log;" | tail -1)
eq "A8b com cap_compras LE o log" "$ALLOW" "t"
ANON=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.reposicao_param_fila_log;" | tail -1)
eq "A8c anon NAO le o log" "$ANON" "0"

# A10 — o sensor está AGENDADO (sem cron, o sensor nunca roda: sensor mudo)
V=$(Pq -c "SELECT schedule || '|' || active::text FROM cron.job WHERE jobname='reposicao-param-fila-sensor';")
eq "A10 sensor agendado 11:45 e ativo (DEPOIS do watchdog 11:30)" "$V" "45 11 * * *|true"

# A9 — ACL: anon/authenticated não EXECUTAM o sensor
V=$(Pq -c "SELECT has_function_privilege('anon','public.reposicao_param_fila_sensor(text)','EXECUTE')::text || '|' || has_function_privilege('authenticated','public.reposicao_param_fila_sensor(text)','EXECUTE')::text;")
eq "A9 sensor fechado p/ anon e authenticated" "$V" "false|false"



# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota a migração → exija VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
# Padrão (ver assert-patterns.md p/ a versão completa, incl. sentinela anti-teatro):
#   1. sabota:   recria a policy/trigger/função NA VERSÃO FURADA
#   2. re-roda:  o MESMO assert do passo 4
#   3. exige:    que ele agora FALHE (se passar → assert fraco → conserte)
#   4. restaura: a versão verdadeira (cirurgicamente, só o que sabotou)
#

# Cada sabotagem recria o objeto NA VERSÃO FURADA, re-roda o MESMO assert e exige VERMELHO.
# Sentinela anti-teatro: as sentinelas abaixo são valores numéricos lidos do banco, não
# textos que o código emita — não há como um ILIKE casar a própria sentinela.

fals_pass=0; fals_fail=0
falsok()  { fals_pass=$((fals_pass+1)); echo "  🧪 ✅ $1 (sabotagem detectada)"; }
falsbad() { fals_fail=$((fals_fail+1)); echo "  🧪 ❌ $1 — SABOTOU E O ASSERT SEGUIU VERDE (assert sem dente)"; }

# ── F1: remover o fusível do ramo GRADUAR ⇒ B2 deve ficar VERMELHO ──
# (é exatamente o estado de PROD hoje: graduação escreve sem fusível)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.reposicao_cold_start_parametros(
  p_empresa text DEFAULT 'OBEN'::text, p_limite integer DEFAULT 50, p_run_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(graduados integer, criados integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE v_grad int := 0; v_cri int := 0;
BEGIN
  UPDATE public.sku_parametros sp SET
    estoque_maximo = v.estoque_maximo_sugerido, ponto_pedido = v.ponto_pedido_sugerido,
    parametro_cold_start = false
  FROM public.v_sku_parametros_sugeridos v
  WHERE sp.empresa = v.empresa AND sp.sku_codigo_omie = v.sku_codigo_omie
    AND sp.empresa = p_empresa AND sp.parametro_cold_start = true
    AND v.status_sugestao = 'OK';   -- <<< SEM FUSÍVEL (versão furada)
  RETURN QUERY SELECT v_grad, v_cri;
END $function$;
SQL
P -q -c "UPDATE public.sku_parametros SET estoque_maximo=2, ponto_pedido=1, parametro_cold_start=true WHERE sku_codigo_omie=1002;"
Pq -c "SELECT * FROM public.reposicao_cold_start_parametros('OBEN', 0, NULL);" >/dev/null
V=$(Pq -c "SELECT COALESCE(estoque_maximo::text,'NULL') || '|' || parametro_cold_start::text FROM public.sku_parametros WHERE sku_codigo_omie=1002;")
if [ "$V" = "2|true" ]; then falsbad "F1 fusível removido"; else falsok "F1 fusível removido (max virou [$V] — salto 10x passaria)"; fi

# restaura a versão verdadeira (cirurgicamente: re-aplica só a migration B)
P -q -f "$MIG_B"
P -q -c "UPDATE public.sku_parametros SET estoque_maximo=2, ponto_pedido=1, parametro_cold_start=true WHERE sku_codigo_omie=1002;"
P -q -c "DELETE FROM public.reposicao_cold_start_log WHERE sku_codigo_omie='1002';"
Pq -c "SELECT * FROM public.reposicao_cold_start_parametros('OBEN', 0, NULL);" >/dev/null
V=$(Pq -c "SELECT estoque_maximo::text || '|' || parametro_cold_start::text FROM public.sku_parametros WHERE sku_codigo_omie=1002;")
eq "F1r restaurado: fusível volta a barrar o salto 10x" "$V" "2|true"

# ── F2: trocar o COALESCE do estágio por NULL ⇒ A1/A3 devem ficar VERMELHOS ──
# (é o bug clássico: LEFT JOIN sem COALESCE some com o SKU que não está na view)
P -q <<'SQL'
CREATE OR REPLACE VIEW public.v_reposicao_param_fila
WITH (security_invoker = on) AS
SELECT sp.empresa, sp.sku_codigo_omie, sp.sku_descricao, sp.fornecedor_nome,
       sp.habilitado_reposicao_automatica AS habilitado,
       COALESCE(sp.tipo_reposicao,'automatica') AS tipo_reposicao,
       sp.parametro_cold_start,
       v.status_sugestao AS estagio,      -- <<< SEM COALESCE (versão furada)
       v.num_ordens, v.fonte_leadtime, sp.ultima_atualizacao_calculo
FROM public.sku_parametros sp
JOIN public.v_sku_parametros_sugeridos v   -- <<< INNER JOIN (versão furada)
  ON v.empresa = sp.empresa AND v.sku_codigo_omie = sp.sku_codigo_omie
WHERE sp.ativo IS TRUE AND (sp.ponto_pedido IS NULL OR sp.estoque_maximo IS NULL);
SQL
V=$(Pq -c "SELECT count(*) FROM public.v_reposicao_param_fila WHERE sku_codigo_omie=2003;")
if [ "$V" = "1" ]; then falsbad "F2 INNER JOIN some com FORA_JANELA_DEMANDA"; else falsok "F2 INNER JOIN some com o SKU 2003 (fila subcontada)"; fi
P -q -f "$MIG_A"
V=$(Pq -c "SELECT estagio FROM public.v_reposicao_param_fila WHERE sku_codigo_omie=2003;")
eq "F2r restaurado: 2003 volta como FORA_JANELA_DEMANDA" "$V" "FORA_JANELA_DEMANDA"

# ── F3: sensor que dismissa por AUSÊNCIA de série ⇒ A5 deve ficar VERMELHO ──
# (é o bug do watchdog antigo: o ELSE dismissa sem ter concluído nada)
P -q -c "DELETE FROM public.reposicao_param_limbo_log WHERE empresa='OBEN';"
P -q -c "INSERT INTO public.fin_alertas (company,tipo,severidade,mensagem) VALUES ('oben','reposicao_param_fila_estagnada','aviso','alerta pre-existente');"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.reposicao_param_fila_sensor(p_empresa text DEFAULT 'OBEN')
RETURNS TABLE(estagios integer, total integer, estagnado boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
BEGIN
  -- versão furada: dismissa SEMPRE que não conclui estagnação (inclusive sem série)
  UPDATE public.fin_alertas SET dismissed_at = now()
  WHERE company = lower(p_empresa) AND tipo = 'reposicao_param_fila_estagnada' AND dismissed_at IS NULL;
  RETURN QUERY SELECT 0, 0, false;
END $function$;
SQL
Pq -c "SELECT * FROM public.reposicao_param_fila_sensor('OBEN');" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='reposicao_param_fila_estagnada' AND dismissed_at IS NULL;")
if [ "$V" = "1" ]; then falsbad "F3 dismiss por ausência de série"; else falsok "F3 versão furada dismissou o alerta sem série (=$V)"; fi
P -q -f "$MIG_A"
# reativa UMA linha só: fin_alertas_unique_ativo é único parcial (company,tipo) WHERE dismissed_at IS NULL
P -q -c "DELETE FROM public.fin_alertas WHERE tipo='reposicao_param_fila_estagnada';"
P -q -c "INSERT INTO public.fin_alertas (company,tipo,severidade,mensagem) VALUES ('oben','reposicao_param_fila_estagnada','aviso','alerta pre-existente');"
Pq -c "SELECT * FROM public.reposicao_param_fila_sensor('OBEN');" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='reposicao_param_fila_estagnada' AND dismissed_at IS NULL;")
eq "F3r restaurado: sem série o alerta NAO e dismissado" "$V" "1"

echo "── falsificação: $fals_pass sabotagens detectadas / $fals_fail asserts sem dente ──"
[ "$fals_fail" = "0" ] || FAIL=$((FAIL+1))



# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
