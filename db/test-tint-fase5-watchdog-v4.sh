#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — tint_watchdog_fase5_check() v4 + helper v2  (20261013210000) [money-path]    ║
# ║  bash db/test-tint-fase5-watchdog-v4.sh > log 2>&1; echo "exit=$?"     (modo normal)       ║
# ║  bash db/test-tint-fase5-watchdog-v4.sh --falsificar > log 2>&1; echo "exit=$?"            ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                                    ║
# ║                                                                                            ║
# ║  Arquivo PRÓPRIO, separado de db/test-tint-fase5-watchdog.sh (que segue provando v1+v2):   ║
# ║  aquela prova re-roda a suíte inteira por falsificação e chegou a 396s na v3, estourando a ║
# ║  parte do CI. Aqui a suíte é UMA função parametrizada pela migration aplicada, e cada      ║
# ║  sabotagem paga só uma suíte curta sobre um universo de EXATAMENTE 1.000 chaves (é o que   ║
# ║  torna 5% e 20% inteiros: 50 e 200 — os limiares são testados abaixo, NA igualdade e acima).║
# ║                                                                                            ║
# ║  REAL, não stub: a view v_tint_formula_canonica é extraída da última migration que a       ║
# ║  define; v1 → v2 → v3 → v4 são aplicadas na ordem de prod; a chave-fonte é montada como o  ║
# ║  tint_apply_keys_snapshot monta (cor|cod_produto|id_base_sayersystem|personalizada); o     ║
# ║  snapshot tem 2 CHUNKS com created_at distintos; o default privilege do Supabase (GRANT ALL ║
# ║  a anon/authenticated em tabela nova) está ligado, senão o REVOKE da tabela nova não teria ║
# ║  o que provar.                                                                             ║
# ║                                                                                            ║
# ║  O SEED DA '1' CARIMBADA NASCE COM DATA ANTIGA (90 dias; prod: 2026-07-22).                ║
# ║                                                                                            ║
# ║  --falsificar: roda PRIMEIRO a suíte contra a migration real e exige 0 vermelhos (o        ║
# ║  CONTROLE, na mesma invocação); depois cada sabotagem aplica UMA troca textual (que tem de ║
# ║  casar exatamente 1 vez) e exige o CONJUNTO EXATO de asserts vermelhos — ou, nas de        ║
# ║  pós-condição, que o apply ABORTE com a marca exata. Emite o recibo SABOTAGENS: só aqui.   ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

MODO=normal
case "${1:-}" in
  '') ;;
  --falsificar) MODO=falsificar ;;
  *) echo "uso: $0 [--falsificar]"; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED
PORT="${PGPORT_TEST:-5467}"
SLUG="tintf5v4"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"
# O locale do CLIENTE é parametrizável para rodar a prova nos DOIS (C e pt_BR.UTF-8). As asserções
# casam valores ASCII de caixa fixa, nunca mensagem traduzível.
export LC_ALL="${PROVA_LC_ALL:-C}" LANG="${PROVA_LC_ALL:-C}"
export PGOPTIONS='-c client_min_messages=warning'

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$RODADA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c autovacuum=off" -l "$RODADA/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

MIG1="$REPO_ROOT/supabase/migrations/20260730120000_tint_watchdog_fase5_chave.sql"
MIG2="$REPO_ROOT/supabase/migrations/20261010230000_tint_watchdog_fase5_s2_aviso.sql"
MIG3="$REPO_ROOT/supabase/migrations/20261013120000_tint_watchdog_fase5_s2_persistente.sql"
MIG4="$REPO_ROOT/supabase/migrations/20261013210000_tint_watchdog_fase5_v4_fonte_viva.sql"
for m in "$MIG1" "$MIG2" "$MIG3" "$MIG4"; do
  [ -f "$m" ] || { echo "migration não encontrada: $m"; exit 1; }
done

echo "=== setup PG17 :$PORT (LC_ALL=$LC_ALL, modo=$MODO) ==="

# ══ ZONA 1 — pré-requisitos (o que as migrations LEEM mas não criam) ══
P <<'SQL'
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial, jobname text, schedule text, command text, active boolean DEFAULT true);
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v bigint; BEGIN
  DELETE FROM cron.job WHERE jobname = p_name;
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_sched, p_cmd) RETURNING jobid INTO v;
  RETURN v;
END $f$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;

CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  valor_unitario numeric, ativo boolean, descricao text, codigo text);
CREATE TABLE public.tint_corantes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_product_id uuid, volume_total_ml numeric, ativo boolean DEFAULT true);
CREATE TABLE public.tint_subcolecoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben', id_subcolecao_sayersystem text);
CREATE TABLE public.tint_produtos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text DEFAULT 'oben', cod_produto text);
CREATE TABLE public.tint_bases    (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text DEFAULT 'oben', id_base_sayersystem text);
CREATE TABLE public.tint_formulas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben', sku_id uuid, cor_id text, nome_cor text,
  produto_id uuid, base_id uuid,
  preco_final_sayersystem numeric, subcolecao_id uuid, personalizada boolean DEFAULT false,
  updated_at timestamptz DEFAULT now(),
  desativada_em timestamptz, desativada_motivo text);
-- índices de prod com os nomes de lá: sem eles a view correlacionada vira seq scan por chave
CREATE INDEX idx_tint_formulas_busca_cor ON public.tint_formulas USING btree (account, sku_id, cor_id);
CREATE INDEX idx_tint_formulas_ativas ON public.tint_formulas USING btree (account) WHERE desativada_em IS NULL;
CREATE TABLE public.tint_formula_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_id uuid, corante_id uuid, qtd_ml numeric,
  CONSTRAINT tint_formula_itens_formula_id_corante_id_key UNIQUE (formula_id, corante_id));
CREATE TABLE public.tint_keys_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), setting_id uuid, account text, store_code text,
  snapshot_id uuid, entity text, generated_at timestamptz, total_chunks int, chunk_index int,
  keys jsonb, created_at timestamptz DEFAULT now(), aplicacao_status text, aplicacao_tentativas int DEFAULT 0,
  aplicacao_erro text, aplicacao_proxima_em timestamptz, aplicado_em timestamptz,
  UNIQUE (snapshot_id, entity, chunk_index));
CREATE TABLE public.tint_staging_formulas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sync_run_id uuid, account text, store_code text,
  cor_id text, cod_produto text, id_base text, personalizada boolean, created_at timestamptz DEFAULT now());
-- os CHECKs REAIS de prod (os dois vocabulários de severidade são diferentes)
CREATE TABLE public.fin_alertas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL, tipo text NOT NULL, severidade text NOT NULL, mensagem text NOT NULL,
  contexto jsonb, criado_em timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz, email_enfileirado_em timestamptz,
  CONSTRAINT fin_alertas_company_check CHECK (company = ANY (ARRAY['oben','colacor','colacor_sc'])),
  CONSTRAINT fin_alertas_severidade_check CHECK (severidade = ANY (ARRAY['info','aviso','critico'])));
CREATE UNIQUE INDEX fin_alertas_unique_ativo ON public.fin_alertas (company, tipo) WHERE dismissed_at IS NULL;
CREATE TABLE public.fornecedor_alerta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text, tipo text, severidade text, titulo text, mensagem text, status text,
  criado_em timestamptz DEFAULT now(),
  CONSTRAINT fornecedor_alerta_severidade_check CHECK (severidade = ANY (ARRAY['info','atencao','urgente'])),
  CONSTRAINT fornecedor_alerta_status_check CHECK (status = ANY (ARRAY['pendente_notificacao','notificado','falha_notificacao','ignorado'])));
CREATE TABLE public.sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL, account text NOT NULL DEFAULT 'vendas',
  last_sync_at timestamptz, status text DEFAULT 'idle', error_message text,
  metadata jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX sync_state_entity_account_uq ON public.sync_state (entity_type, account);
CREATE OR REPLACE FUNCTION public.tint_watchdog_corante_check() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $f$ BEGIN RETURN; END $f$;
SQL

# ── a VIEW REAL, extraída da última migration que a define ──
python3 - "$REPO_ROOT" "$RODADA/view.sql" <<'PY'
import sys, os, re, glob
repo, dst = sys.argv[1], sys.argv[2]
ANCORA = "CREATE OR REPLACE VIEW public.v_tint_formula_canonica"
cands = sorted(f for f in glob.glob(os.path.join(repo, "supabase/migrations/*.sql")) if ANCORA in open(f).read())
if not cands:
    sys.stderr.write("nenhuma migration define a view\n"); sys.exit(3)
s = open(cands[-1]).read(); seg = s[s.index(ANCORA):]; j = seg.index("SELECT")
m = re.search(r";\s*\n", seg[j:])
if not m:
    sys.stderr.write("fim do CREATE VIEW não achado\n"); sys.exit(3)
open(dst, "w").write(seg[: j + m.end()])
sys.stderr.write("view extraída de %s\n" % os.path.basename(cands[-1]))
PY
P -f "$RODADA/view.sql"

# O default privilege do Supabase: toda tabela/função nova nasce com GRANT a anon/authenticated.
P -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;"

# ══ ZONA 2 — as migrations REAIS, na ordem de prod ══
P -f "$MIG1"; P -f "$MIG2"; P -f "$MIG3"; P -f "$MIG4"
echo "=== migrations aplicadas (v1 + v2 + v3 + v4) ==="

# ══ ZONA 3 — seed ══
# Universo de EXATAMENTE 1.000 chaves carimbadas, todas no produto PROD1 / base BASE1:
#   COR1 (K1) saudável · COR2 (K2) alavanca do S1 · COR3 em DUAS embalagens (K3a/K3b: 2 chaves, 1
#   chave-fonte — a unidade do S2 é a chave, a do contexto é a chave-fonte) · BULK0001..BULK0996.
# Cada chave: a '1' CARIMBADA há 90 dias + a SL ativa com receita válida.
P <<'SQL'
INSERT INTO public.omie_products (id, valor_unitario, ativo, descricao) VALUES
 ('a0000000-0000-0000-0000-0000000000ff', 600, true, 'CONCENTRADO OK'),
 ('a0000000-0000-0000-0000-0000000000bb', 0,   true, 'CONCENTRADO SEM CUSTO');
INSERT INTO public.tint_corantes (id, omie_product_id, volume_total_ml) VALUES
 ('c0000000-0000-0000-0000-0000000000ff','a0000000-0000-0000-0000-0000000000ff', 810),
 ('c0000000-0000-0000-0000-0000000000bb','a0000000-0000-0000-0000-0000000000bb', 810);
INSERT INTO public.tint_subcolecoes (id, account, id_subcolecao_sayersystem) VALUES
 ('50000000-0000-0000-0000-0000000000a1', 'oben', 'SL'),
 ('50000000-0000-0000-0000-0000000000a2', 'oben', '1');
INSERT INTO public.tint_produtos (id, cod_produto) VALUES ('d0000000-0000-0000-0000-000000000001', 'PROD1');
INSERT INTO public.tint_bases    (id, id_base_sayersystem) VALUES ('e0000000-0000-0000-0000-000000000001', 'BASE1');

CREATE TABLE _fonte (cor text PRIMARY KEY);   -- o catálogo da FONTE (o que os snapshots declaram)
CREATE TABLE _t (t timestamptz);              -- T = max(created_at) do último snapshot aplicado

CREATE FUNCTION _seed_chave(p_n int, p_cor text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_sku uuid := ('5c000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
        v_leg uuid := ('11000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
        v_sl  uuid := ('51000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
BEGIN
  INSERT INTO public.tint_formulas (id, sku_id, cor_id, produto_id, base_id, subcolecao_id,
                                    preco_final_sayersystem, desativada_em, desativada_motivo)
  VALUES (v_leg, v_sku, p_cor, 'd0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
          '50000000-0000-0000-0000-0000000000a2', 100, now() - interval '90 days', 'fase5_geracao_legada');
  INSERT INTO public.tint_formulas (id, sku_id, cor_id, produto_id, base_id, subcolecao_id, preco_final_sayersystem)
  VALUES (v_sl, v_sku, p_cor, 'd0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
          '50000000-0000-0000-0000-0000000000a1', 120);
  INSERT INTO public.tint_formula_itens (formula_id, corante_id, qtd_ml)
  VALUES (v_sl, 'c0000000-0000-0000-0000-0000000000ff', 10);
  INSERT INTO _fonte VALUES (p_cor) ON CONFLICT DO NOTHING;
END $f$;

DO $$ DECLARE g int; BEGIN
  PERFORM _seed_chave(1, 'COR1'); PERFORM _seed_chave(2, 'COR2');
  PERFORM _seed_chave(3, 'COR3'); PERFORM _seed_chave(5, 'COR3');
  FOR g IN 1..996 LOOP PERFORM _seed_chave(1000 + g, 'BULK' || lpad(g::text, 4, '0')); END LOOP;
END $$;

-- fórmula ATIVA fora do universo carimbado (alavanca do S5). Mesma chave-fonte em N embalagens.
CREATE FUNCTION _ativa_extra(p_n int, p_cor text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.tint_formulas (sku_id, cor_id, produto_id, base_id, subcolecao_id)
  VALUES (('5c000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid, p_cor,
          'd0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
          '50000000-0000-0000-0000-0000000000a1');
$f$;

-- snapshot em 2 CHUNKS: chunk 0 (BULK) recebido 5s ANTES do chunk 1 (o resto) — T é o max.
CREATE FUNCTION _snap(p_id uuid, p_criado timestamptz, p_aplicado timestamptz, p_status text, p_excluir text[])
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.tint_keys_snapshots (account, store_code, snapshot_id, entity, generated_at, total_chunks,
                                          chunk_index, keys, created_at, aplicacao_status, aplicado_em)
  SELECT 'oben', 'M01', p_id, 'formulas', p_criado, 2, c.i,
         COALESCE((SELECT jsonb_agg(f.cor || '|PROD1|BASE1|false') FROM _fonte f
                    WHERE f.cor <> ALL (p_excluir) AND ((f.cor LIKE 'BULK%') = (c.i = 0))), '[]'::jsonb),
         p_criado - CASE WHEN c.i = 0 THEN interval '5 seconds' ELSE interval '0' END,
         p_status, p_aplicado
    FROM (VALUES (0), (1)) c(i);
$f$;

-- estado-base de toda suíte: catálogo íntegro, 2 snapshots aplicados com o catálogo inteiro
-- (S_ant há 3 dias; S_ult com T = now()-1h e aplicado_em = T+1h, como um re-apply regrava).
CREATE FUNCTION _reset() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN
  DELETE FROM public.fin_alertas; DELETE FROM public.fornecedor_alerta; DELETE FROM public.sync_state;
  DELETE FROM public.tint_watchdog_fase5_amostras;
  DELETE FROM public.tint_keys_snapshots; DELETE FROM public.tint_staging_formulas;
  DELETE FROM public.tint_formulas WHERE cor_id LIKE 'X%';
  UPDATE public.tint_formulas SET desativada_em = NULL
   WHERE subcolecao_id = '50000000-0000-0000-0000-0000000000a1' AND desativada_em IS NOT NULL;
  UPDATE public.tint_formula_itens SET corante_id = 'c0000000-0000-0000-0000-0000000000ff'
   WHERE corante_id <> 'c0000000-0000-0000-0000-0000000000ff';
  UPDATE public.tint_formulas SET desativada_motivo = 'fase5_geracao_legada' WHERE desativada_motivo = 'limpo_manualmente';
  DELETE FROM _t; INSERT INTO _t VALUES (date_trunc('second', now()) - interval '1 hour');
  PERFORM _snap('aaaaaaaa-0000-0000-0000-000000000001', now() - interval '3 days', now() - interval '3 days', 'aplicado', '{}');
  PERFORM _snap('aaaaaaaa-0000-0000-0000-000000000002', (SELECT t FROM _t), (SELECT t FROM _t) + interval '1 hour', 'aplicado', '{}');
END $f$;
-- refaz o S_ult (o último aplicado) excluindo cores da fonte
CREATE FUNCTION _ult_sem(p_excluir text[]) RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.tint_keys_snapshots WHERE snapshot_id = 'aaaaaaaa-0000-0000-0000-000000000002';
  SELECT _snap('aaaaaaaa-0000-0000-0000-000000000002', (SELECT t FROM _t), (SELECT t FROM _t) + interval '1 hour', 'aplicado', p_excluir);
$f$;
-- o apply: desativa a SL das cores dadas (é o que o tint_apply_keys_snapshot faz com a ausente)
CREATE FUNCTION _apply_tira(p_cores text[]) RETURNS void LANGUAGE sql AS $f$
  UPDATE public.tint_formulas SET desativada_em = now()
   WHERE cor_id = ANY (p_cores) AND subcolecao_id = '50000000-0000-0000-0000-0000000000a1';
$f$;
-- bruto do S4: N chaves BULK sem ativa (as N primeiras)
CREATE FUNCTION _bruto(p_n int) RETURNS void LANGUAGE sql AS $f$
  UPDATE public.tint_formulas SET desativada_em = NULL WHERE cor_id LIKE 'BULK%' AND subcolecao_id = '50000000-0000-0000-0000-0000000000a1';
  UPDATE public.tint_formulas SET desativada_em = now()
   WHERE subcolecao_id = '50000000-0000-0000-0000-0000000000a1'
     AND cor_id IN (SELECT 'BULK' || lpad(g::text, 4, '0') FROM generate_series(1, p_n) g);
$f$;
SQL
echo "=== seed: $(Pq -c "SELECT count(DISTINCT (sku_id, cor_id)) FROM tint_formulas WHERE desativada_motivo='fase5_geracao_legada'") chaves carimbadas ==="

# ── leitores ──
roda()    { Pq -c "SELECT public.tint_watchdog_fase5_check();" >/dev/null; }
ativos()  { Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='$1' AND dismissed_at IS NULL;"; }
sev()     { Pq -c "SELECT COALESCE(max(severidade),'AUSENTE') FROM public.fin_alertas WHERE tipo='$1' AND dismissed_at IS NULL;"; }
ctx()     { Pq -c "SELECT COALESCE(max(contexto->>'$2'),'AUSENTE') FROM public.fin_alertas WHERE tipo='$1' AND dismissed_at IS NULL;"; }
meta()    { Pq -c "SELECT COALESCE(max(metadata->>'$1'),'AUSENTE') FROM public.sync_state WHERE entity_type='tint_watchdog_fase5';"; }
emails()  { Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '%$1%';"; }
abertos() { Pq -c "SELECT count(*) FROM public.fin_alertas WHERE dismissed_at IS NULL;"; }
H()       { Pq -c "SELECT public._tint_watchdog_fase5_transicao('oben', '$1', $2, '$3', 'HT $1', 'm', '{}'::jsonb, $4);" >/dev/null; }

VERM="$RODADA/vermelhos"
eq() {   # $1=ID  $2=veio  $3=esperado
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  OK  $1 (=$2)"
  else FAIL=$((FAIL+1)); echo "$1" >> "$VERM"; echo "  XX  $1 — esperado [$3], veio [$2]"; fi
}

# ══ A SUÍTE — $1 = migration a aplicar por cima (a real ou a sabotada) ══
suite() {
  local mig="$1" id1 id2
  PASS=0; FAIL=0; : > "$VERM"

  # P2c retroativo: os 3 alertas de S2 que importam, semeados ANTES do apply
  P -c "SELECT _reset();
        INSERT INTO public.fin_alertas (company, tipo, severidade, mensagem, contexto, criado_em, dismissed_at) VALUES
         ('oben','tint_fase5_fonte_retirada','aviso','x','{\"_n\":12386}', '2026-09-28 12:00+00', '2026-10-13 12:00+00'),
         ('oben','tint_fase5_fonte_retirada','aviso','y','{\"_n\":548}',   '2026-08-11 12:00+00', '2026-08-14 12:00+00'),
         ('oben','tint_fase5_fonte_retirada','aviso','z','{\"_n\":1}',     '2026-09-28 12:00+00', '2026-10-13 08:00+00');" >/dev/null
  P -f "$mig"
  eq R6a "$(Pq -c "SELECT COALESCE(contexto->>'encerrado_por','-') || '/' || COALESCE(contexto->>'criterio_de','-') FROM fin_alertas WHERE mensagem='x'")" "mudanca_criterio/v2"
  eq R6b "$(Pq -c "SELECT COALESCE(contexto->>'encerrado_por','-') FROM fin_alertas WHERE mensagem='y'")" "-"
  eq R6c "$(Pq -c "SELECT COALESCE(contexto->>'encerrado_por','-') FROM fin_alertas WHERE mensagem='z'")" "-"

  # ── A: estado saudável ──
  P -c "SELECT _reset();" >/dev/null
  roda
  eq A1 "$(abertos)" 0
  eq A2 "$(meta criterio)/$(meta fantasmas)/$(meta fonte_retirada)/$(meta fonte_retirada_bruto)/$(meta universo)" "v4/0/0/0/1000"
  P -c "INSERT INTO tint_watchdog_fase5_amostras (medido_em, criterio, universo, s1_sem_preco, sem_ativa_bruto)
        VALUES (now() - interval '200 days', 'v4', 1, 0, 0);" >/dev/null
  roda
  eq A3 "$(Pq -c "SELECT count(*) || '/' || count(*) FILTER (WHERE medido_em < now() - interval '180 days') FROM tint_watchdog_fase5_amostras")" "2/0"

  # ── S1 (não-regressão) e S3 (não-regressão) ──
  P -c "UPDATE tint_formula_itens SET corante_id='c0000000-0000-0000-0000-0000000000bb' WHERE formula_id='51000000-0000-0000-0000-000000000002';" >/dev/null
  roda; eq S1a "$(sev tint_fase5_chave_sem_preco)" aviso
  P -c "SELECT _reset(); UPDATE tint_formulas SET desativada_motivo='limpo_manualmente'
        WHERE id IN (SELECT id FROM tint_formulas WHERE desativada_motivo='fase5_geracao_legada' ORDER BY id LIMIT 50);" >/dev/null
  P -c "INSERT INTO sync_state (entity_type, account, status, metadata) VALUES ('tint_watchdog_fase5','oben','complete','{\"universo_max\":1000}');" >/dev/null
  roda; eq U1 "$(sev tint_fase5_universo_encolheu)" aviso

  # ── S2: retirada NOVA ──
  # R1: a fonte tirou COR3 (2 chaves, 1 chave-fonte); estava no S_ant (3 dias, aplicado); o apply desativou.
  P -c "SELECT _reset(); SELECT _ult_sem('{COR3}'); SELECT _apply_tira('{COR3}');" >/dev/null
  roda
  eq R1a "$(sev tint_fase5_fonte_retirada)/$(meta fonte_retirada)/$(meta fonte_retirada_bruto)" "info/2/2"
  eq R1b "$(ctx tint_fase5_fonte_retirada chaves_fonte_retiradas_7d)/$(ctx tint_fase5_fonte_retirada criterio)" "1/v4"
  id1="$(Pq -c "SELECT id FROM fin_alertas WHERE tipo='tint_fase5_fonte_retirada' AND dismissed_at IS NULL")"
  roda
  id2="$(Pq -c "SELECT id FROM fin_alertas WHERE tipo='tint_fase5_fonte_retirada' AND dismissed_at IS NULL")"
  # R5c: o alerta do critério v4 sobrevive ao próprio ciclo (não é fechado como "outro critério")
  local mesmo=trocou
  if [ -n "$id1" ] && [ "$id1" = "$id2" ]; then mesmo=mesmo; fi
  eq R5c "$mesmo/$(emails 'fonte retirou')" "mesmo/1"
  # R2: a retirada é ANTIGA — o único snapshot que tinha COR3 tem 8 dias: métrica sim, alerta não
  P -c "SELECT _reset(); SELECT _ult_sem('{COR3}'); SELECT _apply_tira('{COR3}');
        UPDATE tint_keys_snapshots SET created_at = created_at - interval '5 days' WHERE snapshot_id='aaaaaaaa-0000-0000-0000-000000000001';" >/dev/null
  roda
  eq R2a "$(ativos tint_fase5_fonte_retirada)/$(meta fonte_retirada)/$(meta fonte_retirada_bruto)" "0/0/2"
  # R3: o snapshot da janela que tinha COR3 NÃO foi aplicado (erro): não é evidência de presença
  P -c "SELECT _reset(); SELECT _ult_sem('{COR3}'); SELECT _apply_tira('{COR3}');
        UPDATE tint_keys_snapshots SET aplicacao_status='erro' WHERE snapshot_id='aaaaaaaa-0000-0000-0000-000000000001';" >/dev/null
  roda
  eq R3 "$(ativos tint_fase5_fonte_retirada)/$(meta fonte_retirada)" "0/0"
  # R4: chave sem ativa mas PRESENTE no último snapshot — não é retirada pela fonte
  P -c "SELECT _reset(); SELECT _apply_tira('{COR1}');" >/dev/null
  roda
  eq R4 "$(ativos tint_fase5_fonte_retirada)/$(meta fonte_retirada)/$(meta fonte_retirada_bruto)" "0/0/1"
  # R5: alerta de S2 aberto sob o critério ANTERIOR (sem 'criterio' no contexto, como a v3 grava)
  P -c "SELECT _reset(); INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
        VALUES ('oben','tint_fase5_fonte_retirada','aviso','v3','{\"_n\":7}');" >/dev/null
  roda
  eq R5a "$(ativos tint_fase5_fonte_retirada)" 0
  eq R5b "$(Pq -c "SELECT contexto->>'encerrado_por' || '/' || (contexto->>'criterio_de') || '/' || (contexto->>'criterio_para') FROM fin_alertas WHERE mensagem='v3'")" "mudanca_criterio/v3/v4"

  # ── S5: fantasma × cor nova ──
  # F1: fórmula ATIVA cuja chave-fonte o último snapshot não tem, sem staging posterior (2 embalagens)
  P -c "SELECT _reset(); SELECT _ativa_extra(9001, 'XFANT'); SELECT _ativa_extra(9002, 'XFANT');" >/dev/null
  roda
  eq F1 "$(sev tint_fase5_fonte_fantasma)/$(meta fantasmas)/$(ctx tint_fase5_fonte_fantasma chaves_fonte)/$(meta cor_nova)" "aviso/2/1/0"
  # F6: SEM snapshot aplicado nenhum — o alerta aberto não é fechado, e o número é AUSENTE, não 0
  P -c "UPDATE tint_keys_snapshots SET aplicacao_status='pendente';" >/dev/null
  roda
  eq F6a "$(ativos tint_fase5_fonte_fantasma)" 1
  eq F6b "$(meta fantasmas)/$(meta fonte_retirada)/$(Pq -c "SELECT COALESCE(fantasmas::text,'NULL') FROM tint_watchdog_fase5_amostras ORDER BY id DESC LIMIT 1")" "AUSENTE/AUSENTE/NULL"
  # F2: COR NOVA — staging recebido entre T e o aplicado_em (re-apply skipado regrava aplicado_em):
  # o relógio da presença é o created_at, então é posterior ao snapshot e não conta
  P -c "SELECT _reset(); SELECT _ativa_extra(9011, 'XNOVA');
        INSERT INTO tint_staging_formulas (account, cor_id, cod_produto, id_base, personalizada, created_at)
        VALUES ('oben','XNOVA','PROD1','BASE1',false,(SELECT t FROM _t) + interval '30 minutes');" >/dev/null
  roda
  eq F2 "$(ativos tint_fase5_fonte_fantasma)/$(meta fantasmas)/$(meta cor_nova)" "0/0/1"
  # F2b: staging EXATAMENTE em T (igualdade): o 20261013150000 só barra created_at < T — conta como nova
  P -c "UPDATE tint_staging_formulas SET created_at = (SELECT t FROM _t);" >/dev/null
  roda
  eq F2b "$(meta fantasmas)/$(meta cor_nova)" "0/1"
  # F3: staging ENTRE os chunks (T-3s): anterior ao snapshot (o relógio é o max dos chunks) — fantasma
  P -c "UPDATE tint_staging_formulas SET created_at = (SELECT t FROM _t) - interval '3 seconds';" >/dev/null
  roda
  eq F3 "$(meta fantasmas)/$(meta cor_nova)" "1/0"
  # F4: um snapshot MAIS NOVO mas só 'pendente', sem COR1: a referência é o último APLICADO
  P -c "SELECT _reset(); SELECT _snap('aaaaaaaa-0000-0000-0000-000000000003', now(), NULL, 'pendente', '{COR1}');" >/dev/null
  roda
  eq F4 "$(ativos tint_fase5_fonte_fantasma)/$(meta fantasmas)" "0/0"
  # F7: 1.000 fórmulas fantasma = limiar de 'critico' NA igualdade
  P -c "SELECT _reset(); SELECT _ult_sem(ARRAY(SELECT cor FROM _fonte));" >/dev/null
  roda
  eq F7 "$(sev tint_fase5_fonte_fantasma)/$(meta fantasmas)" "critico/1000"

  # ── S4: limiares 5% e 20% sobre 1.000 chaves — abaixo, NA igualdade, acima ──
  local n esperado
  P -c "SELECT _reset();" >/dev/null
  for par in 49:AUSENTE 50:aviso 51:aviso 199:aviso 200:critico 201:critico; do
    n="${par%%:*}"; esperado="${par#*:}"
    P -c "SELECT _bruto($n);" >/dev/null
    roda
    eq "T$n" "$(sev tint_fase5_fonte_colapso)" "$esperado"
  done

  # ── Helper v2 (chamadas diretas — custo zero de varredura) ──
  P -c "DELETE FROM fin_alertas; DELETE FROM fornecedor_alerta;" >/dev/null
  # H1: fator 1.0 compara com o ciclo ANTERIOR: 90.000 → 46.000 → 89.000 reemite (v1: calava)
  H th1 90000 aviso 1.0; H th1 46000 aviso 1.0; H th1 89000 aviso 1.0
  eq H1 "$(emails 'HT th1')" 2
  # H2: subida de severidade com o número CAINDO notifica (fator 1.0)
  H th2 100 aviso 1.0; H th2 90 critico 1.0
  eq H2 "$(emails 'HT th2')/$(sev th2)" "2/critico"
  # H3: fator 2.0 inalterado (não-regressão): 300→450 não, →600 sim, →700 não, →1200 sim, rearma
  # em 500 (≤600) e reemite em 1000
  for v in 300 450 600 700 1200 500 1000; do H th3 "$v" info 2.0; done
  eq H3 "$(emails 'HT th3')" 4
  # H4: fator 1.0 sem piora não reemite
  H th4 100 aviso 1.0; H th4 100 aviso 1.0; H th4 100 aviso 1.0
  eq H4 "$(emails 'HT th4')" 1
  # H5: subida de severidade com queda também no fator 2.0
  H th5 300 info 2.0; H th5 250 aviso 2.0
  eq H5 "$(emails 'HT th5')" 2
  # H6: dismiss em 0 e reabertura = e-mail novo
  H th6 100 aviso 1.0; H th6 0 info 1.0; H th6 50 aviso 1.0
  eq H6 "$(emails 'HT th6')/$(ativos th6)" "2/1"

  echo "PASS=$PASS FAIL=$FAIL"
}

if [ "$MODO" = normal ]; then
  suite "$MIG4"
  [ "$FAIL" -eq 0 ]
  exit $?
fi

# ══ --falsificar ══
# sabota <rótulo> <esperado: IDs ordenados separados por espaço | APPLY:<marca>> <busca> <troca> [<busca> <troca>]...
SAB_V=0; SAB_F=0
sabota() {
  local rot="$1" esp="$2"; shift 2
  local alvo="$RODADA/sab_${rot}.sql"
  if ! python3 - "$MIG4" "$alvo" "$@" <<'PY'
import sys
src, dst, pares = sys.argv[1], sys.argv[2], sys.argv[3:]
s = open(src).read()
for i in range(0, len(pares), 2):
    busca, troca = pares[i], pares[i + 1]
    n = s.count(busca)
    if n != 1:
        sys.stderr.write("âncora casou %d vez(es): %r\n" % (n, busca)); sys.exit(4)
    s = s.replace(busca, troca)
open(dst, "w").write(s)
PY
  then
    SAB_F=$((SAB_F+1)); echo "!! $rot: sabotagem NÃO aplicou (âncora)"; return
  fi
  echo "── sabotagem $rot (esperado: $esp) ──"
  case "$esp" in
    APPLY:*)
      local marca="${esp#APPLY:}" saida
      if saida="$(P -f "$alvo" 2>&1)"; then
        SAB_F=$((SAB_F+1)); echo "!! $rot: o apply sabotado PASSOU — a pós-condição não morde"
      elif printf '%s' "$saida" | grep -qF "$marca"; then
        SAB_V=$((SAB_V+1)); echo "   vermelho exato: apply abortou com '$marca'"
      else
        SAB_F=$((SAB_F+1)); echo "!! $rot: abortou com OUTRA marca: $saida"
      fi ;;
    *)
      suite "$alvo" > "$RODADA/sab_${rot}.log" 2>&1 || true
      local veio
      veio="$(sort "$VERM" | tr '\n' ' ' | sed 's/ $//')"
      if [ "$veio" = "$esp" ]; then
        SAB_V=$((SAB_V+1)); echo "   vermelho exato: {$veio}"
      else
        SAB_F=$((SAB_F+1)); echo "!! $rot: esperado {$esp}, veio {$veio}"; grep -E '^  XX' "$RODADA/sab_${rot}.log" || true
      fi ;;
  esac
  P -f "$MIG4"   # restaura a real (o pré-guard aceita v4 por cima de v4)
}

echo "── CONTROLE: suíte contra a migration REAL, na MESMA invocação ──"
suite "$MIG4"
if [ "$FAIL" -ne 0 ] || [ "$PASS" -eq 0 ]; then
  echo "CONTROLE VERMELHO (PASS=$PASS FAIL=$FAIL): falsificar contra uma suíte que já falha não prova nada"
  exit 1
fi
N_CONTROLE="$PASS"

sabota ref_sem_aplicado "F4 F6b" \
  "   WHERE ks.account = v_conta AND ks.entity = 'formulas'
     AND ks.aplicacao_status = 'aplicado'
   GROUP BY ks.snapshot_id" \
  "   WHERE ks.account = v_conta AND ks.entity = 'formulas'
   GROUP BY ks.snapshot_id"
sabota janela_sem_aplicado "R3" \
  "       AND ks.aplicacao_status = 'aplicado'
       AND ks.snapshot_id <> v_snap_id" \
  "       AND ks.snapshot_id <> v_snap_id"
sabota janela_sem_7_dias "R2a" \
  "       AND ks.created_at >= now() - interval '7 days'" \
  "       AND true"
sabota relogio_aplicado_em "F2" \
  "  SELECT ks.snapshot_id, max(ks.created_at)
    INTO v_snap_id, v_snap_rec" \
  "  SELECT ks.snapshot_id, max(ks.aplicado_em)
    INTO v_snap_id, v_snap_rec"
sabota relogio_min_chunk "F3" \
  "  SELECT ks.snapshot_id, max(ks.created_at)
    INTO v_snap_id, v_snap_rec" \
  "  SELECT ks.snapshot_id, min(ks.created_at)
    INTO v_snap_id, v_snap_rec"
sabota igualdade_estrita "F2b" \
  "sf.created_at >= v_snap_rec" "sf.created_at > v_snap_rec"
sabota s5_ausente_vira_saudavel "F6a" \
  "  IF v_fant IS NULL THEN" "  IF false THEN"
sabota s2_sem_criterio_no_ctx "R5c" \
  "      jsonb_build_object('criterio', v_criterio, 'chaves', v_s2," \
  "      jsonb_build_object('chaves', v_s2,"
sabota helper_v1 "H1 H2 H5" \
  "  v_emitir := v_subiu_sev
              OR CASE WHEN p_fator <= 1.0
                      THEN p_n > v_ant
                      ELSE p_n >= GREATEST(v_ant_email * p_fator, v_ant_email + 1) AND p_n > v_ant
                 END;" \
  "  v_emitir := v_subiu_sev OR p_n >= GREATEST(v_ant_email * p_fator, v_ant_email + 1);" \
  "  IF v_upd IS NOT NULL AND v_emitir THEN" \
  "  IF v_upd IS NOT NULL AND v_emitir AND p_n > v_ant THEN"
sabota s4_limiar_desloca "T50 T51" \
  "v_s2_bruto::numeric / v_universo >= 0.05 THEN" "v_s2_bruto::numeric / v_universo >= 0.06 THEN"
sabota s4_critico_estrito "T200" \
  "v_s2_bruto::numeric / v_universo >= 0.20 THEN 'critico'" "v_s2_bruto::numeric / v_universo > 0.20 THEN 'critico'"
sabota s5_critico_estrito "F7" \
  "WHEN v_fant >= 1000 THEN 'critico'" "WHEN v_fant > 1000 THEN 'critico'"
sabota retroativo_sem_corte "R6b R6c" \
  "   AND dismissed_at >= timestamptz '2026-10-13 09:17:17+00'" "   AND dismissed_at IS NOT NULL"
# pós-condições: o apply tem de ABORTAR — a sabotagem preserva todo literal que as OUTRAS exigem
sabota p4_instrucao_proibida "APPLY:P4 FALHOU" \
  "'SayerSystem. NAO mexa no tombstone" "'SayerSystem. Faca recarimbar/limpar o tombstone"
sabota p8_tabela_aberta "APPLY:P8 FALHOU" \
  "REVOKE ALL ON TABLE public.tint_watchdog_fase5_amostras FROM PUBLIC, anon, authenticated;" "-- (sem revoke)"
sabota p2b_corte_30d_volta "APPLY:P2b FALHOU" \
  "       AND ks.created_at >= now() - interval '7 days'" "       AND ks.created_at >= now() - interval '30 days'"

echo "controle: $N_CONTROLE asserts verdes"
echo "SABOTAGENS: $SAB_V vermelhas / $SAB_F falhas"
[ "$SAB_F" -eq 0 ]
