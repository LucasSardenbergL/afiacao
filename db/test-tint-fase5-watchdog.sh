#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — tint_watchdog_fase5_check()  (Fase 5b#2, PR 2 — Camada B)        ║
# ║  bash db/test-tint-fase5-watchdog.sh > /tmp/t.log 2>&1; echo "exit=$?"         ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                                ║
# ║  O ORÁCULO É A VIEW REAL. O script EXTRAI v_tint_formula_canonica da última    ║
# ║  migration que a define, em vez de stubar o predicado — stubar provaria que a  ║
# ║  função concorda com o stub, não que ela mede o que o balcão lê.               ║
# ║                                                                                ║
# ║  O QUE PROVA (a migration 20260730120000):                                     ║
# ║   B1  estado saudável -> silêncio total                                        ║
# ║   B2  marcador sync_state tint_watchdog_fase5 avança em sucesso COMPLETO       ║
# ║       (é ele que ATIVA o dead-man cruzado que o PR 1 já tem em prod)           ║
# ║   B3  chave carimbada sem canônica válida -> tint_fase5_chave_sem_preco        ║
# ║   B4  e-mail enfileirado para S1                                               ║
# ║   B5  severidade escala: >=1000 chaves -> critico (Codex [P2])                 ║
# ║   B6  fonte retirou a chave -> tint_fase5_fonte_retirada (TIPO SEPARADO)       ║
# ║   B7  S1 e S2 COEXISTEM sem se silenciar  <-- o achado [P1] do Codex           ║
# ║   B8  volta ao normal -> dismiss dos dois                                      ║
# ║   B9  agravamento de S1 com alerta aberto -> atualiza + re-emite               ║
# ║   B10 universo encolhe >1% -> tint_fase5_universo_encolheu (vigia de vacuidade)║
# ║   B11 dismiss MANUAL re-ancora o patamar -> silêncio no ciclo seguinte         ║
# ║   B12 auto-dismiss NÃO é lido como aceite manual (âncora avança junto)         ║
# ║   B13 chave com OUTRO fallback válido não conta — e PASSA a contar quando o    ║
# ║       fallback some (prova positiva: o assert mede o fallback, não o silêncio) ║
# ║   B14 anti-sobreposição: lock tomado -> sai SEM avançar o marcador             ║
# ║  FALSIFICAÇÕES (cada uma declara o CONJUNTO EXATO que derruba):                ║
# ║   F1 anti-join ignora receita_valida    -> S1 cega                             ║
# ║   F2 junta as 2 classes no MESMO tipo   -> reproduz o bug que o Codex apontou  ║
# ║   F3 mata o vigia de cardinalidade      -> {B10,B12}                           ║
# ║   F4 marcador sob outro nome            -> {B2,B13a,B13b}                      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5459}"
SLUG="tintf5wd"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
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
Pq() { P -tA "$@"; }

PASS=0; FAIL=0; FALHAS=()
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); FALHAS+=("$1"); echo "  XX  $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "=== setup PG17 :$PORT ==="

# ══ ZONA 1 — pré-requisitos (o que a migration LÊ mas não cria) ══
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial, jobname text, schedule text, command text, active boolean DEFAULT true);
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v bigint; BEGIN
  DELETE FROM cron.job WHERE jobname = p_name;
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_sched, p_cmd) RETURNING jobid INTO v;
  RETURN v;
END $f$;

-- roles que a migration revoga por NOME (REVOKE FROM PUBLIC não os alcança)
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
CREATE TABLE public.tint_formulas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben', sku_id uuid, cor_id text, nome_cor text,
  preco_final_sayersystem numeric, subcolecao_id uuid, personalizada boolean DEFAULT false,
  updated_at timestamptz DEFAULT now(),
  desativada_em timestamptz, desativada_motivo text);
CREATE TABLE public.tint_formula_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_id uuid, corante_id uuid, qtd_ml numeric);
-- os CHECKs REAIS de prod: os dois vocabulários de severidade são DIFERENTES,
-- e é o que faz o helper derivar um do outro em vez de recebê-los soltos.
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
  CONSTRAINT fornecedor_alerta_status_check CHECK (status = ANY (ARRAY['pendente_notificacao','notificado','falha_notificacao','ignorado'])),
  CONSTRAINT fornecedor_alerta_tipo_check CHECK (tipo = ANY (ARRAY['promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro','mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','whatsapp_sla','erro_app','outro','param_auto_resumo','reposicao_pedido_minimo'])));
CREATE TABLE public.sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL, account text NOT NULL DEFAULT 'vendas',
  last_sync_at timestamptz, status text DEFAULT 'idle', error_message text,
  metadata jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX sync_state_entity_account_uq ON public.sync_state (entity_type, account);

-- a função do PR 1: a migration desta camada faz REVOKE nela (correção do furo
-- anon=X medido em prod). Sem ela existir, o REVOKE aborta a migration inteira.
CREATE OR REPLACE FUNCTION public.tint_watchdog_corante_check() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $f$ BEGIN RETURN; END $f$;
GRANT EXECUTE ON FUNCTION public.tint_watchdog_corante_check() TO anon, authenticated;
SQL

# ── a VIEW REAL, extraída da última migration que a define (não um stub) ──
VIEWSQL="/tmp/_f5wd_view.sql"
python3 - "$REPO_ROOT" "$VIEWSQL" <<'PY'
import sys, os, re, glob
repo, dst = sys.argv[1], sys.argv[2]
ANCORA = "CREATE OR REPLACE VIEW public.v_tint_formula_canonica"
cands = sorted(f for f in glob.glob(os.path.join(repo, "supabase/migrations/*.sql"))
               if ANCORA in open(f).read())
if not cands:
    sys.stderr.write("nenhuma migration define a view\n"); sys.exit(3)
src = cands[-1]                      # a mais recente por ordem lexical = a de prod
s = open(src).read()
i = s.index(ANCORA)
seg = s[i:]
j = seg.index("SELECT")
m = re.search(r";\s*\n", seg[j:])    # fecha no 1o ';' após o corpo
if not m:
    sys.stderr.write("nao achei o fim do CREATE VIEW\n"); sys.exit(3)
open(dst, "w").write(seg[: j + m.end()])
sys.stderr.write("view extraida de %s\n" % os.path.basename(src))
PY
P -q -f "$VIEWSQL"
echo "=== view real aplicada ==="

# ══ ZONA 2 — a migration REAL (Lei #1: nunca um stub da lógica) ══
MIG="$REPO_ROOT/supabase/migrations/20260730120000_tint_watchdog_fase5_chave.sql"
[ -f "$MIG" ] || { echo "migration nao encontrada: $MIG"; exit 1; }
P -q -f "$MIG"
echo "=== migration aplicada ==="

P -q -c "CREATE TABLE _bkp AS SELECT pg_get_functiondef('public.tint_watchdog_fase5_check()'::regprocedure) AS def;"
restaura() { Pq -c "SELECT def FROM _bkp;" > /tmp/_f5wd_real.sql; P -q -f /tmp/_f5wd_real.sql; }

# ══ ZONA 3 — seeds ══
# Cada chave (account, sku_id, cor_id) tem a '1' CARIMBADA pela Fase 5 + uma SL.
#   K1 SAUDAVEL  : SL ativa e válida                      -> nunca alarma
#   K2 DEGRADADA : alavanca de S1 (chave sem preço)
#   K3 RETIRADA  : alavanca de S2 (a fonte tira a SL)
#   K4 FALLBACK  : SL ativa INVÁLIDA + outra ativa VÁLIDA -> não conta (precisão)
#   +1000 chaves BULK saudáveis: massa para a severidade (>=1000) e para o 1%
#   do vigia de cardinalidade.
P -q <<'SQL'
INSERT INTO public.omie_products (id, valor_unitario, ativo, descricao) VALUES
 ('a0000000-0000-0000-0000-0000000000ff', 600, true, 'CONCENTRADO OK'),
 ('a0000000-0000-0000-0000-0000000000bb', 0,   true, 'CONCENTRADO SEM CUSTO');
INSERT INTO public.tint_corantes (id, omie_product_id, volume_total_ml) VALUES
 ('c0000000-0000-0000-0000-0000000000ff','a0000000-0000-0000-0000-0000000000ff', 810),  -- OK
 ('c0000000-0000-0000-0000-0000000000bb','a0000000-0000-0000-0000-0000000000bb', 810);  -- IMPAGÁVEL
INSERT INTO public.tint_subcolecoes (id, account, id_subcolecao_sayersystem) VALUES
 ('50000000-0000-0000-0000-0000000000a1', 'oben', 'SL'),
 ('50000000-0000-0000-0000-0000000000a2', 'oben', '1');

CREATE OR REPLACE FUNCTION _seed_chave(p_n int, p_cor text, p_corante uuid)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_sku uuid := ('5c000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
        v_leg uuid := ('11000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
        v_sl  uuid := ('51000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
BEGIN
  -- a geração '1', CARIMBADA pela Fase 5 (é ela que define o universo vigiado)
  INSERT INTO public.tint_formulas (id, account, sku_id, cor_id, subcolecao_id,
                                    preco_final_sayersystem, desativada_em, desativada_motivo)
  VALUES (v_leg, 'oben', v_sku, p_cor, '50000000-0000-0000-0000-0000000000a2',
          100, now(), 'fase5_geracao_legada');
  -- a gêmea SL que a substituiu
  INSERT INTO public.tint_formulas (id, account, sku_id, cor_id, subcolecao_id,
                                    preco_final_sayersystem)
  VALUES (v_sl, 'oben', v_sku, p_cor, '50000000-0000-0000-0000-0000000000a1', 120);
  INSERT INTO public.tint_formula_itens (formula_id, corante_id, qtd_ml)
  VALUES (v_sl, p_corante, 10);
END $f$;

-- DO $$..$$ em vez de SELECT solto: PERFORM não devolve linha, e 1004 tabelas de
-- retorno vazias no log só atrapalham a leitura dos asserts.
DO $$ BEGIN
  PERFORM _seed_chave(1, 'COR1', 'c0000000-0000-0000-0000-0000000000ff');  -- K1
  PERFORM _seed_chave(2, 'COR2', 'c0000000-0000-0000-0000-0000000000ff');  -- K2
  PERFORM _seed_chave(3, 'COR3', 'c0000000-0000-0000-0000-0000000000ff');  -- K3
  PERFORM _seed_chave(4, 'COR4', 'c0000000-0000-0000-0000-0000000000bb');  -- K4: SL INVÁLIDA
END $$;

-- K4 ganha uma SEGUNDA ativa, não-SL, com receita VÁLIDA: é o fallback que mantém
-- a chave precificável. rank 1 (válida não-SL) < rank 2 (SL sem corantes_ok), logo
-- ela vence a disputa de canônica e a chave NÃO entra em S1.
INSERT INTO public.tint_formulas (id, account, sku_id, cor_id, subcolecao_id, preco_final_sayersystem)
VALUES ('52000000-0000-0000-0000-000000000004', 'oben',
        '5c000000-0000-0000-0000-000000000004', 'COR4', NULL, 130);
INSERT INTO public.tint_formula_itens (formula_id, corante_id, qtd_ml)
VALUES ('52000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-0000000000ff', 10);

-- 1000 chaves BULK saudáveis
DO $$ DECLARE g int; BEGIN
  FOR g IN 1001..2000 LOOP
    PERFORM _seed_chave(g, 'BULK' || g, 'c0000000-0000-0000-0000-0000000000ff');
  END LOOP;
END $$;
SQL

# ── alavancas de estado ──
CO_OK='c0000000-0000-0000-0000-0000000000ff'
CO_RUIM='c0000000-0000-0000-0000-0000000000bb'
SL2='51000000-0000-0000-0000-000000000002'
SL3='51000000-0000-0000-0000-000000000003'
SL_BULK1='51000000-0000-0000-0000-000000001001'
FALLBACK4='52000000-0000-0000-0000-000000000004'

degrada()       { P -q -c "UPDATE public.tint_formula_itens SET corante_id='$CO_RUIM' WHERE formula_id='$1';"; }
sara()          { P -q -c "UPDATE public.tint_formula_itens SET corante_id='$CO_OK'  WHERE formula_id='$1';"; }
retira_fonte()  { P -q -c "UPDATE public.tint_formulas SET desativada_em=now(), desativada_motivo=NULL WHERE id='$1';"; }
devolve_fonte() { P -q -c "UPDATE public.tint_formulas SET desativada_em=NULL WHERE id='$1';"; }
degrada_bulk()  { P -q -c "UPDATE public.tint_formula_itens SET corante_id='$CO_RUIM' WHERE formula_id IN (SELECT id FROM public.tint_formulas WHERE cor_id LIKE 'BULK%' AND subcolecao_id='50000000-0000-0000-0000-0000000000a1');"; }
sara_bulk()     { P -q -c "UPDATE public.tint_formula_itens SET corante_id='$CO_OK'  WHERE formula_id IN (SELECT id FROM public.tint_formulas WHERE cor_id LIKE 'BULK%' AND subcolecao_id='50000000-0000-0000-0000-0000000000a1');"; }
# encolhe/restaura o UNIVERSO carimbado — 50 de 1004 chaves = ~5% (limiar é 1%)
encolhe_universo()  { P -q -c "UPDATE public.tint_formulas SET desativada_motivo='limpo_manualmente' WHERE id IN (SELECT id FROM public.tint_formulas WHERE desativada_motivo='fase5_geracao_legada' ORDER BY id LIMIT 50);"; }
restaura_universo() { P -q -c "UPDATE public.tint_formulas SET desativada_motivo='fase5_geracao_legada' WHERE desativada_motivo='limpo_manualmente';"; }

reset_estado() { P -q -c "DELETE FROM public.fin_alertas; DELETE FROM public.fornecedor_alerta; DELETE FROM public.sync_state;"; }
# >/dev/null: sem isso cada ciclo cospe a tabela de retorno do SELECT e afoga os
# asserts no log — e evidência que não se lê não é evidência.
roda()         { Pq -c "SELECT public.tint_watchdog_fase5_check();" >/dev/null; }
ativos()       { Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='$1' AND dismissed_at IS NULL;"; }
sev()          { Pq -c "SELECT COALESCE(max(severidade),'AUSENTE') FROM public.fin_alertas WHERE tipo='$1' AND dismissed_at IS NULL;"; }
emails()       { Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '%$1%';"; }
marcador()     { Pq -c "SELECT COALESCE(max(status),'AUSENTE') FROM public.sync_state WHERE entity_type='tint_watchdog_fase5';"; }
meta()         { Pq -c "SELECT COALESCE(metadata->>'$1','AUSENTE') FROM public.sync_state WHERE entity_type='tint_watchdog_fase5';"; }

# ══ ZONA 4 — a suíte ══
roda_suite() {
  PASS=0; FAIL=0; FALHAS=()

  # ── B1/B2: tudo saudável -> silêncio, e o marcador avança
  reset_estado
  roda
  eq "B1 saudavel nao alarma S1" "$(ativos tint_fase5_chave_sem_preco)" "0"
  eq "B2 marcador avanca em sucesso completo" "$(marcador)" "complete"

  # ── B13: K4 tem SL INVÁLIDA mas outro fallback válido. Medir só o silêncio aqui
  #    não distingue "o fallback segurou" de "nada foi avaliado" — então a prova é
  #    POSITIVA: tira o fallback e a mesma chave TEM de passar a contar.
  eq "B13a chave com fallback valido nao conta" "$(meta chaves_sem_preco)" "0"
  P -q -c "UPDATE public.tint_formulas SET desativada_em=now() WHERE id='$FALLBACK4';"
  roda
  eq "B13b sem o fallback a mesma chave conta" "$(meta chaves_sem_preco)" "1"
  P -q -c "UPDATE public.tint_formulas SET desativada_em=NULL WHERE id='$FALLBACK4';"
  roda

  # ── B3/B4: a SL de K2 perde o corante -> a chave deixa de precificar
  # B4 mede o DELTA, não o acumulado: o B13b acima é uma transição ok->degradado
  # legítima e já enfileirou o e-mail dela. Contar desde o reset atribuiria os dois
  # e-mails a esta transição e mediria "quantos incidentes houve na suíte", não
  # "esta transição emitiu e-mail" — o assert perderia o alvo.
  local e0; e0="$(emails 'chaves da Fase 5 sem preco')"
  degrada "$SL2"
  roda
  eq "B3 chave sem preco alarma" "$(ativos tint_fase5_chave_sem_preco)" "1"
  eq "B4 e-mail S1 enfileirado" "$(( $(emails 'chaves da Fase 5 sem preco') - e0 ))" "1"

  # ── B6/B7: a fonte retira K3 COM o alerta de S1 aberto. No mesmo tipo, o
  #    ON CONFLICT DO NOTHING silenciaria um dos dois (o achado [P1] do Codex).
  retira_fonte "$SL3"
  roda
  eq "B6 fonte retirada alarma em tipo proprio" "$(ativos tint_fase5_fonte_retirada)" "1"
  eq "B7 S1 e S2 coexistem sem se silenciar" "$(ativos tint_fase5_chave_sem_preco)" "1"

  # ── B9: S1 piora (1 -> 2 chaves) com o alerta já aberto -> re-emite
  degrada "$SL_BULK1"
  roda
  eq "B9 agravamento re-emite e-mail" "$(emails 'AGRAVOU')" "1"

  # ── B8: tudo volta -> dismiss dos dois
  sara "$SL2"; sara "$SL_BULK1"; devolve_fonte "$SL3"
  roda
  eq "B8a dismiss de S1 ao voltar a zero" "$(ativos tint_fase5_chave_sem_preco)" "0"
  eq "B8b dismiss de S2 ao voltar a zero" "$(ativos tint_fase5_fonte_retirada)" "0"

  # ── B5: 1000 chaves degradadas de uma vez -> severidade critica
  degrada_bulk
  roda
  eq "B5 severidade escala para critico" "$(sev tint_fase5_chave_sem_preco)" "critico"
  sara_bulk
  roda

  # ── B10: o universo carimbado encolhe ~5% (limpeza do carimbo)
  encolhe_universo
  roda
  eq "B10 encolhimento do universo alarma" "$(ativos tint_fase5_universo_encolheu)" "1"

  # ── B11: o founder DISPENSA (aceitou o patamar novo) -> re-ancora e silencia,
  #    senão o alerta ficaria imortal e treinaria o founder a ignorar alertas.
  P -q -c "UPDATE public.fin_alertas SET dismissed_at=now() WHERE tipo='tint_fase5_universo_encolheu' AND dismissed_at IS NULL;"
  roda
  eq "B11 dismiss manual re-ancora e silencia" "$(ativos tint_fase5_universo_encolheu)" "0"

  # ── B12: o universo VOLTA (auto-dismiss) e encolhe de novo -> tem de alarmar
  #    outra vez. Se o auto-dismiss contasse como aceite manual, ficaria mudo.
  restaura_universo
  roda
  encolhe_universo
  roda
  eq "B12 auto-dismiss nao vira aceite manual" "$(ativos tint_fase5_universo_encolheu)" "1"
  restaura_universo
  roda

  # ── B14: com o lock tomado por outra sessão, a função SAI sem avançar o marcador
  P -q -c "DELETE FROM public.sync_state WHERE entity_type='tint_watchdog_fase5';"
  "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -q -c \
    "BEGIN; SELECT pg_advisory_xact_lock(hashtext('tint_watchdog_fase5')); SELECT pg_sleep(6); COMMIT;" \
    >/dev/null 2>&1 &
  local lockpid=$!
  sleep 2
  roda
  eq "B14 lock tomado -> nao avanca o marcador" "$(marcador)" "AUSENTE"
  wait "$lockpid" 2>/dev/null || true
}

echo "=== BASELINE (migration real) ==="
roda_suite
BASE_PASS=$PASS; BASE_FAIL=$FAIL
echo "--- baseline: $BASE_PASS ok / $BASE_FAIL falhas ---"
if [ "$BASE_FAIL" -ne 0 ]; then
  echo "BASELINE VERMELHO — a migration real nao passa. Falhas: ${FALHAS[*]}"
  exit 1
fi
echo "TOTAL_ASSERTS=$BASE_PASS"

# ══════════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÃO (Lei #3) — sabota a migration em UM ponto e exige o conjunto
# EXATO de asserts vermelhos. "Falsificação prova que o assert tem dente; só
# instrumentar o RESULTADO prova que ele é ESPECÍFICO" (lição #1505).
# Cada sabotagem PROVA QUE APLICOU antes de medir — senão "não casou nada" se
# leria como "o assert não tem dente".
# ══════════════════════════════════════════════════════════════════════════════
FALSIF_ERR=0

sabota_e_mede() {   # $1=rotulo  $2=busca  $3=troca  $4..=asserts esperados
  local rot="$1" busca="$2" troca="$3"; shift 3
  local esperado="$*"
  local sab="/tmp/_f5wd_sab_${rot}.sql"

  python3 - "$MIG" "$sab" "$busca" "$troca" <<'PY'
import sys
src, dst, busca, troca = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = open(src).read()
n = s.count(busca)
if n != 1:
    sys.stderr.write("ANCORA NAO UNICA (%d ocorrencias)\n" % n); sys.exit(3)
open(dst, "w").write(s.replace(busca, troca))
PY
  if [ $? -ne 0 ]; then
    echo "  FALSIF XX  $rot: a sabotagem NAO aplicou (ancora nao casou) — INVALIDA, nao leia como 'sem dente'"
    FALSIF_ERR=$((FALSIF_ERR+1)); return
  fi
  if ! command grep -q -- "$troca" "$sab"; then
    echo "  FALSIF XX  $rot: texto sabotado ausente no arquivo — INVALIDA"
    FALSIF_ERR=$((FALSIF_ERR+1)); return
  fi

  P -q -f "$sab" >/dev/null 2>&1
  roda_suite > /tmp/_f5wd_suite.log 2>&1

  local caidos=""
  if [ "${#FALHAS[@]}" -gt 0 ]; then
    for f in "${FALHAS[@]}"; do caidos="$caidos $(printf '%s' "$f" | awk '{print $1}')"; done
  fi
  caidos="$(printf '%s' "$caidos" | tr ' ' '\n' | command grep -v '^$' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  local esp="$(printf '%s' "$esperado" | tr ' ' '\n' | command grep -v '^$' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')"

  if [ "$caidos" = "$esp" ]; then
    echo "  FALSIF OK  $rot derrubou EXATAMENTE [$caidos]"
  else
    echo "  FALSIF XX  $rot: esperado [$esp], veio [$caidos]"
    FALSIF_ERR=$((FALSIF_ERR+1))
  fi
  restaura
}

echo "=== FALSIFICACOES ==="

# F1 — o anti-join deixa de exigir receita_valida: qualquer canônica, mesmo sem
#      preço, passa a "cobrir" a chave. S1 fica CEGO.
#      Conjunto MAIOR que {B3}: sem S1 não há e-mail (B4), nem agravamento (B9),
#      nem escalada de severidade (B5), e B13b (a chave passa a contar quando o
#      fallback some) também morre. Declarado como MEDIDO — prever {B3} e
#      "consertar" o harness para casar seria repintar de verde uma sabotagem que
#      morde mais fundo.
sabota_e_mede "F1" \
  "    SELECT account, sku_id, cor_id
      FROM v_tint_formula_canonica
     WHERE receita_valida" \
  "    SELECT account, sku_id, cor_id
      FROM v_tint_formula_canonica
     WHERE true" \
  B13b B3 B4 B5 B7 B9
# ^ B7 entra por CASCATA LOGICA de uma sabotagem so: F1 cega o S1, e B7 afirma que
#   S1 e S2 COEXISTEM sem se silenciar — sem S1 detectado, B7 nao tem como valer.
#   Declarado como MEDIDO (a previsao de 5 asserts e que estava incompleta): reduzir
#   a sabotagem para casar a previsao esconderia que ela morde mais fundo.

# F2 — junta as DUAS classes no MESMO tipo: é literalmente o desenho que o Codex
#      REPROVOU. O ON CONFLICT DO NOTHING faz a 2a classe ficar muda.
sabota_e_mede "F2" \
  "v_conta, 'tint_fase5_fonte_retirada', v_s2," \
  "v_conta, 'tint_fase5_chave_sem_preco', v_s2," \
  B6

# F3 — mata o vigia de cardinalidade: o universo pode sumir sem ninguém saber
#      (o "verde por vacuidade" que o Codex apontou).
sabota_e_mede "F3" \
  "IF v_max > 0 AND v_queda >= 0.01 THEN" \
  "IF false THEN" \
  B10 B12

# F4 — grava o marcador sob outro nome: o dead-man cruzado que o PR 1 já tem em
#      prod continuaria inerte, e "sem alerta" seguiria indistinguível de "morto".
#      Derruba também B13a/B13b, que leem o metadata DESSE marcador.
sabota_e_mede "F4" \
  "VALUES ('tint_watchdog_fase5', v_conta, now(), 'complete', NULL," \
  "VALUES ('tint_watchdog_NOME_ERRADO', v_conta, now(), 'complete', NULL," \
  B2 B10 B12 B13a B13b
# ^ B10/B12 entram por CASCATA: o high-water-mark (universo_max/ancora_em) e LIDO do
#   MESMO marcador sync_state que a sabotagem renomeia. Sem marcador, v_max=0, a
#   guarda `v_max > 0` nunca passa e o vigia de cardinalidade fica mudo. Ou seja: o
#   marcador nao e so telemetria do dead-man — e ESTADO do qual S3 depende. Medido,
#   nao previsto; declarado como medido.

# ══ fecho: re-roda a suíte na versão REAL e exige verde ══
echo "=== VERIFICACAO FINAL (migration real restaurada) ==="
roda_suite
echo "--- final: $PASS ok / $FAIL falhas | falsificacoes invalidas/erradas: $FALSIF_ERR ---"
if [ "$FAIL" -ne 0 ] || [ "$FALSIF_ERR" -ne 0 ]; then
  echo "RESULTADO: VERMELHO"
  exit 1
fi
echo "RESULTADO: VERDE — $PASS asserts + 4 falsificacoes com conjunto exato"
