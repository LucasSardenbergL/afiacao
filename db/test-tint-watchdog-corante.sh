#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — tint_watchdog_corante_check() v4 + vigia (incidente 10-19)       ║
# ║  bash db/test-tint-watchdog-corante.sh > /tmp/t.log 2>&1; echo "exit=$?"       ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                                ║
# ║  O QUE PROVA (aplica v1 20260727150000 -> v2 20261019150000 -> v3              ║
# ║  20261019160000 -> v4 20261020120000, a cadeia real de prod; suíte e           ║
# ║  sabotagens rodam sobre a v4):                                                 ║
# ║   A1 corante impagável EM USO  -> alerta criado (fin_alertas + e-mail)         ║
# ║   A2 corante impagável FORA de uso -> NÃO alerta      (precisão > recall)      ║
# ║   A3 impagável só em fórmula DESATIVADA -> NÃO alerta (precisão > recall)      ║
# ║   A4 marcador sync_state avança em sucesso COMPLETO   (Codex: "verde por       ║
# ║      construção" — sem last_success_at, ausência de alerta não é saúde)        ║
# ║   A5 volta a zero -> dismiss                                                   ║
# ║   A6 AGRAVAMENTO: 2o corante cai com alerta aberto -> atualiza + re-emite      ║
# ║      (Codex [P1]: ON CONFLICT DO NOTHING deixaria o 2o MUDO)                   ║
# ║   A7 severidade escala com o nº de fórmulas atingidas (Codex [P2])             ║
# ║   A8 dead-man cruzado NÃO alarma quando a Camada B ainda não existe            ║
# ║   A9 marcador da Camada B stale (>13h) -> alerta watchdog parado               ║
# ║   A6c "formulas atingidas" conta fórmulas DISTINTAS, não pares (Codex P2)     ║
# ║   A10 base sem vínculo Omie -> MUDO, e DISMISSA o alerta da v1 aberto com 11   ║
# ║   A10b idem com base Omie INATIVA -> MUDO (espelha v_base_disponivel da RPC)   ║
# ║   A11 corante sem vínculo Omie é rotulado pela DESCRIÇÃO, não pelo UUID        ║
# ║   A12 TROCA por corante NUNCA VISTO no incidente (1 -> 1) re-emite (v4)        ║
# ║   A13 mesmo corante escala a >=1000 fórmulas: 'critico' + re-emite (v4)        ║
# ║   A14 conjunto ENCOLHE: atualiza o alerta SEM e-mail               (v4)        ║
# ║   A19 histerese: 999<->1000 fórmulas mantém 'critico', sem e-mail  (v4)        ║
# ║   A20 histerese: corante JÁ VISTO que volta não re-emite           (v4)        ║
# ║   A15/A16 vigia: marcador da A > 30 min alarma; A voltou -> dismissa (v4)      ║
# ║   A17 A vigia a vigia: marcador da vigia > 1h alarma               (v4)        ║
# ║   A18 cron da vigia armado */15                                    (v4)        ║
# ║  FALSIFICAÇÕES (cada uma declara o CONJUNTO EXATO que derruba):                ║
# ║   F1 remove o filtro de USO            -> {A2,A3} + cascata A5,A6*,A10,A10b    ║
# ║   F2 remove `ativo` do predicado       -> {A1}                                 ║
# ║   F3 remove o bloco de agravamento     -> {A6}                                 ║
# ║   F4 remove o marcador de sucesso      -> {A4}                                 ║
# ║   F5 volta ao predicado de base da v1  -> {A10,A10b}                           ║
# ║   F6 tira a descrição do corante do rótulo -> {A11,A11b}                       ║
# ║   F7 volta a contar pares fórmula×corante -> {A6c}                             ║
# ║   F8 novos por QUANTIDADE (v1-v3)        -> {A12,A20}                          ║
# ║   F9 sem escalada                        -> {A13b}                             ║
# ║   F10 sem atualização calada             -> {A14}                              ║
# ║   F11 vigia lê a entidade errada         -> {A16}                              ║
# ║   F12 A não vigia a vigia                -> {A17}                              ║
# ║   F13 sem 'vistos' (só ids atuais)       -> {A20}                              ║
# ║   F14 severidade não-pegajosa            -> {A19,A19b}                         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5457}"
SLUG="tintwd"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"   # dir ÚNICO desta rodada (o trap apaga): temporário mora aqui, nunca em /tmp/<nome-fixo>
export LC_ALL=C LANG=C

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0; FALHAS=()
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); FALHAS+=("$1"); echo "  XX  $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "=== setup PG17 :$PORT ==="

# ══ ZONA 1 — pré-requisitos (o que a migration LÊ mas não cria) ══
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS cron;
-- a migration chama cron.schedule; no PG17 local não há pg_cron. Stub que REGISTRA
-- a chamada, para o assert provar que o cron foi armado com o schedule certo.
CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial, jobname text, schedule text, command text, active boolean DEFAULT true);
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v bigint; BEGIN
  DELETE FROM cron.job WHERE jobname = p_name;
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_sched, p_cmd) RETURNING jobid INTO v;
  RETURN v;
END $f$;

-- a postcondição da v2 confere has_function_privilege por NOME de role
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
END $r$;

CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  valor_unitario numeric, ativo boolean, descricao text, codigo text);
CREATE TABLE public.tint_corantes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_product_id uuid, volume_total_ml numeric, ativo boolean DEFAULT true, descricao text);
CREATE TABLE public.tint_skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), omie_product_id uuid);
CREATE TABLE public.tint_formulas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben', sku_id uuid, cor_id uuid,
  desativada_em timestamptz, desativada_motivo text);
CREATE TABLE public.tint_formula_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_id uuid, corante_id uuid, qtd_ml numeric);
CREATE TABLE public.fin_alertas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL, tipo text NOT NULL, severidade text NOT NULL, mensagem text NOT NULL,
  contexto jsonb, criado_em timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz, email_enfileirado_em timestamptz);
-- o UNIQUE PARCIAL real de prod: é ele que faz o ON CONFLICT DO NOTHING ser anti-spam
CREATE UNIQUE INDEX fin_alertas_unique_ativo ON public.fin_alertas (company, tipo) WHERE dismissed_at IS NULL;
CREATE TABLE public.fornecedor_alerta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text, tipo text, severidade text, titulo text, mensagem text, status text,
  criado_em timestamptz DEFAULT now());
CREATE TABLE public.sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL, account text NOT NULL DEFAULT 'vendas',
  last_sync_at timestamptz, status text DEFAULT 'idle', error_message text,
  metadata jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX sync_state_entity_account_uq ON public.sync_state (entity_type, account);
SQL

# ══ ZONA 2 — as migrations REAIS (Lei #1: nunca um stub da lógica) ══
MIG_V1="$REPO_ROOT/supabase/migrations/20260727150000_tint_watchdog_corante_impagavel.sql"
MIG_V2="$REPO_ROOT/supabase/migrations/20261019150000_tint_watchdog_corante_v2_base_precificavel.sql"
MIG_V3="$REPO_ROOT/supabase/migrations/20261019160000_tint_watchdog_corante_v3_plano_custom.sql"
MIG="$REPO_ROOT/supabase/migrations/20261020120000_tint_watchdog_corante_v4_renotifica_e_vigia.sql"
[ -f "$MIG_V1" ] || { echo "migration nao encontrada: $MIG_V1"; exit 1; }
[ -f "$MIG_V2" ] || { echo "migration nao encontrada: $MIG_V2"; exit 1; }
[ -f "$MIG_V3" ] || { echo "migration nao encontrada: $MIG_V3"; exit 1; }
[ -f "$MIG" ] || { echo "migration nao encontrada: $MIG"; exit 1; }
P -q -f "$MIG_V1"
# a PRE da v2 só aceita a v1 cujo md5 foi medido em prod — prova que a v1 do repo É a de prod
eq "PRE v1 do repo = v1 de prod (md5)" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.tint_watchdog_corante_check()'::regprocedure;")" "c512a912fb1725fb89413ddc6690fde3"
P -q -f "$MIG_V2"
# a PRE da v3 só aceita a v2 cujo md5 foi conferido em prod no apply de 2026-10-19
eq "v2 do repo = v2 aplicada em prod (md5)" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.tint_watchdog_corante_check()'::regprocedure;")" "8febcd9e495c4536f3a548b1afab278e"
P -q -f "$MIG_V3"
# a PRE da v4 só aceita a v3 cujo md5 foi conferido em prod no apply de 2026-10-19
eq "v3 do repo = v3 aplicada em prod (md5)" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.tint_watchdog_corante_check()'::regprocedure;")" "eeddd88a26585696edfd88fc270570ce"
P -q -f "$MIG"
eq "v4 aplicada (marcador)" "$(Pq -c "SELECT position('tint_watchdog_corante guard v4' IN prosrc) > 0 FROM pg_proc WHERE oid='public.tint_watchdog_corante_check()'::regprocedure;")" "t"
eq "v3 aplicada (marcador, prefixo)" "$(Pq -c "SELECT position('tint_watchdog_corante guard v' IN prosrc) > 0 FROM pg_proc WHERE oid='public.tint_watchdog_corante_check()'::regprocedure;")" "t"
eq "v4 planeja com valores reais" "$(Pq -c "SELECT 'plan_cache_mode=force_custom_plan' = ANY(proconfig) FROM pg_proc WHERE oid='public.tint_watchdog_corante_check()'::regprocedure;")" "t"
eq "v4 aceita a si mesma na PRE (md5 da v4 listado)" "$(Pq -c "SELECT position(md5(prosrc) IN \$\$$(cat "$MIG")\$\$) > 0 FROM pg_proc WHERE oid='public.tint_watchdog_corante_check()'::regprocedure;")" "t"
P -q -f "$MIG"   # re-aplicar a v4 sobre ela mesma passa (idempotente)
[ "$FAIL" -eq 0 ] || { echo "SETUP VERMELHO: ${FALHAS[*]}"; exit 1; }
echo "=== migrations aplicadas (v1 -> v2 -> v3 -> v4) ==="

# guarda o corpo verdadeiro, para restaurar depois de cada sabotagem
# as DUAS funções da v4 (a vigia também é sabotada, F11 — e a PRE recusa corpo desconhecido)
P -q -c "CREATE TABLE _bkp AS SELECT pg_get_functiondef('public.tint_watchdog_corante_check()'::regprocedure) AS def
         UNION ALL SELECT pg_get_functiondef('public.tint_watchdog_corante_vigia_check()'::regprocedure);"
restaura() { Pq -c "SELECT string_agg(def || ';', E'\n') FROM _bkp;" > "$RODADA/_wd_real.sql"; P -q -f "$RODADA/_wd_real.sql"; }

# ══ ZONA 3 — seeds ══
# C_OK: corante saudável (nunca deve alarmar).  C_INAT: omie INATIVO (impagável).
# C_SEMCUSTO: valor_unitario 0.  C_ORFAO: impagável mas FORA de uso.
# C_MORTA: impagável, usado só por fórmula DESATIVADA.
P -q <<'SQL'
INSERT INTO public.omie_products (id, valor_unitario, ativo, descricao) VALUES
 ('a0000000-0000-0000-0000-000000000001', 600, true,  'CONCENTRADO OK'),
 ('a0000000-0000-0000-0000-000000000002', 600, false, 'CONCENTRADO INATIVO'),
 ('a0000000-0000-0000-0000-000000000003', 0,    true, 'CONCENTRADO SEM CUSTO'),
 ('a0000000-0000-0000-0000-000000000004', 0,    true, 'CONCENTRADO ORFAO'),
 ('a0000000-0000-0000-0000-000000000005', 0,    true, 'CONCENTRADO SO EM MORTA');
-- bases: B_OK precifica; B_INAT inativa no Omie
INSERT INTO public.omie_products (id, valor_unitario, ativo, descricao) VALUES
 ('b0000000-0000-0000-0000-000000000001', 100, true,  'BASE OK'),
 ('b0000000-0000-0000-0000-000000000003', 100, false, 'BASE INATIVA');
-- SKU_OK -> B_OK; SKU_SEMVINC sem omie (linha nova); SKU_BINAT -> base inativa
INSERT INTO public.tint_skus (id, omie_product_id) VALUES
 ('5c000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001'),
 ('5c000000-0000-0000-0000-000000000002', NULL),
 ('5c000000-0000-0000-0000-000000000003','b0000000-0000-0000-0000-000000000003');
INSERT INTO public.tint_corantes (id, omie_product_id, volume_total_ml) VALUES
 ('c0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001', 810),
 ('c0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002', 810),
 ('c0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000003', 810),
 ('c0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000004', 810),
 ('c0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000005', 810);
-- C_LINHA6/C_LINHA7: corantes da linha nova, sem vínculo Omie. C_SEMVINC: sem vínculo, com descrição.
INSERT INTO public.tint_corantes (id, omie_product_id, volume_total_ml, descricao) VALUES
 ('c0000000-0000-0000-0000-000000000006', NULL, 810, 'WFO.6506.71 - ACAB10 VIOLETA'),
 ('c0000000-0000-0000-0000-000000000007', NULL, 810, 'WFO.6506.42 - ACAB10 BORDO'),
 ('c0000000-0000-0000-0000-000000000008', NULL, 810, 'CORANTE SEM VINCULO X');
-- F_ATIVA usa C_OK e C_INAT; F_MORTA (desativada) usa C_MORTA; C_ORFAO não é usado por ninguém.
INSERT INTO public.tint_formulas (id, account, sku_id, cor_id, desativada_em, desativada_motivo) VALUES
 ('f0000000-0000-0000-0000-000000000001','oben','5c000000-0000-0000-0000-000000000001'::uuid,'c0100000-0000-0000-0000-000000000001'::uuid, NULL, NULL),
 ('f0000000-0000-0000-0000-000000000002','oben','5c000000-0000-0000-0000-000000000001'::uuid,'c0100000-0000-0000-0000-000000000002'::uuid, now(), 'fase5_geracao_legada'),
 ('f0000000-0000-0000-0000-000000000003','oben','5c000000-0000-0000-0000-000000000002'::uuid,'c0100000-0000-0000-0000-000000000003'::uuid, NULL, NULL),
 ('f0000000-0000-0000-0000-000000000004','oben','5c000000-0000-0000-0000-000000000003'::uuid,'c0100000-0000-0000-0000-000000000004'::uuid, NULL, NULL);
INSERT INTO public.tint_formula_itens (formula_id, corante_id, qtd_ml) VALUES
 ('f0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001', 10),
 ('f0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000005', 10);
SQL

reset_estado() {
  P -q -c "DELETE FROM public.fin_alertas; DELETE FROM public.fornecedor_alerta; DELETE FROM public.sync_state;"
}
# liga/desliga um corante impagável DENTRO de uma fórmula ATIVA
usa_na_ativa() { P -q -c "INSERT INTO public.tint_formula_itens (formula_id, corante_id, qtd_ml) VALUES ('${2:-f0000000-0000-0000-0000-000000000001}','$1', 5);"; }
tira_da_ativa() { P -q -c "DELETE FROM public.tint_formula_itens WHERE formula_id='${2:-f0000000-0000-0000-0000-000000000001}' AND corante_id='$1';"; }

alertas_ativos() { Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='$1' AND dismissed_at IS NULL;"; }
emails()         { Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '%$1%';"; }
emails_msg()     { Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE mensagem LIKE '%$1%';"; }

# ══ ZONA 4 — a suíte (roda inteira; usada também sob sabotagem) ══
roda_suite() {
  PASS=0; FAIL=0; FALHAS=()

  # A2/A3 primeiro: estado SAUDÁVEL (só C_OK em uso). C_ORFAO e C_MORTA são impagáveis
  # mas não estão em fórmula ativa -> o watchdog tem de ficar MUDO.
  reset_estado
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A2 impagavel FORA de uso nao alarma" "$(alertas_ativos tint_corante_impagavel)" "0"
  eq "A3 impagavel so em formula DESATIVADA nao alarma" "$(emails 'corante sem custo')" "0"
  eq "A4 marcador avanca em sucesso" "$(Pq -c "SELECT COALESCE(status,'AUSENTE') FROM public.sync_state WHERE entity_type='tint_watchdog_corante';")" "complete"
  eq "A8 dead-man nao alarma sem a Camada B" "$(alertas_ativos tint_watchdog_fase5_parado)" "0"

  # A1: o corante INATIVO entra numa fórmula ativa -> tem de alarmar
  usa_na_ativa 'c0000000-0000-0000-0000-000000000002'
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A1 impagavel EM USO alarma" "$(alertas_ativos tint_corante_impagavel)" "1"
  eq "A1b e-mail enfileirado" "$(emails 'corante sem custo')" "1"
  eq "A7 severidade aviso com poucas formulas" "$(Pq -c "SELECT severidade FROM public.fin_alertas WHERE tipo='tint_corante_impagavel' AND dismissed_at IS NULL;")" "aviso"

  # A6: um SEGUNDO corante cai com o alerta ABERTO -> tem de atualizar e re-emitir
  usa_na_ativa 'c0000000-0000-0000-0000-000000000003'
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A6 agravamento atualiza o contexto" "$(Pq -c "SELECT contexto->>'corantes' FROM public.fin_alertas WHERE tipo='tint_corante_impagavel' AND dismissed_at IS NULL;")" "2"
  eq "A6b agravamento re-emite e-mail" "$(emails 'AGRAVOU')" "1"
  # os 2 corantes ruins estão na MESMA fórmula: 1 fórmula atingida, não 2 pares
  eq "A6c formulas atingidas = distintas" "$(Pq -c "SELECT contexto->>'formulas_ativas' FROM public.fin_alertas WHERE tipo='tint_corante_impagavel' AND dismissed_at IS NULL;")" "1"

  # A14 (v4): o conjunto ENCOLHE (2 -> 1) com alerta aberto -> o alerta deixa de descrever o
  # estado velho, mas SEM e-mail (melhora não é agravamento)
  tira_da_ativa 'c0000000-0000-0000-0000-000000000003'
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A14 encolheu atualiza o contexto" "$(Pq -c "SELECT contexto->>'corantes' FROM public.fin_alertas WHERE tipo='tint_corante_impagavel' AND dismissed_at IS NULL;")" "1"
  eq "A14b encolheu nao re-emite" "$(emails 'AGRAVOU')" "1"

  # A12 (v4): TROCA — sai C_INAT, entra C_SEMVINC, nunca visto no incidente (1 -> 1).
  # A v1-v3 ficavam MUDAS.
  tira_da_ativa 'c0000000-0000-0000-0000-000000000002'
  usa_na_ativa 'c0000000-0000-0000-0000-000000000008'
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A12 troca de corante re-emite" "$(emails 'AGRAVOU')" "2"

  # A13 (v4): o MESMO corante se espalha até >= 1000 fórmulas -> 'critico' persistido + e-mail
  P -q -c "INSERT INTO public.tint_formulas (id, account, sku_id, cor_id) SELECT ('f1000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid, 'oben', '5c000000-0000-0000-0000-000000000001'::uuid, gen_random_uuid() FROM generate_series(1,1000) g;
           INSERT INTO public.tint_formula_itens (formula_id, corante_id, qtd_ml) SELECT ('f1000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid, 'c0000000-0000-0000-0000-000000000003', 1 FROM generate_series(1,1000) g;"
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A13 escalada persiste critico" "$(Pq -c "SELECT severidade FROM public.fin_alertas WHERE tipo='tint_corante_impagavel' AND dismissed_at IS NULL;")" "critico"
  eq "A13b escalada re-emite (e diz por que)" "$(emails_msg 'passou a critico')" "1"

  # A19 (v4, histerese): cai para 999 fórmulas e volta — o incidente segue 'critico' e
  # não re-emite a cada oscilação
  P -q -c "UPDATE public.tint_formulas SET desativada_em = now() WHERE id::text LIKE 'f1000000-0000-0000-0000-00000000000%' AND id::text <= 'f1000000-0000-0000-0000-000000000003';"
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A19 severidade pegajosa abaixo de 1000" "$(Pq -c "SELECT severidade FROM public.fin_alertas WHERE tipo='tint_corante_impagavel' AND dismissed_at IS NULL;")" "critico"
  local critico_antes; critico_antes="$(emails_msg 'passou a critico')"
  P -q -c "UPDATE public.tint_formulas SET desativada_em = NULL WHERE id::text LIKE 'f1000000%';"
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A19b volta a 1000 sem novo e-mail" "$(emails_msg 'passou a critico')" "$critico_antes"

  # A20 (v4, histerese): C_INAT, já visto neste incidente (A1), volta — sem e-mail
  local agravou_antes; agravou_antes="$(emails 'AGRAVOU')"
  usa_na_ativa 'c0000000-0000-0000-0000-000000000002'
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A20 corante ja visto que volta nao re-emite" "$(emails 'AGRAVOU')" "$agravou_antes"

  P -q -c "DELETE FROM public.tint_formula_itens WHERE formula_id::text LIKE 'f1000000%'; DELETE FROM public.tint_formulas WHERE id::text LIKE 'f1000000%';"
  tira_da_ativa 'c0000000-0000-0000-0000-000000000008'

  # A5: tudo volta ao normal -> dismiss
  tira_da_ativa 'c0000000-0000-0000-0000-000000000002'
  tira_da_ativa 'c0000000-0000-0000-0000-000000000003'
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A5 dismiss quando volta a zero" "$(alertas_ativos tint_corante_impagavel)" "0"

  # A10: incidente 2026-10-19 — linha nova cuja BASE nao tem vinculo Omie. A formula ja nao
  # tem preco pela base; o corante nao e o bloqueio -> MUDO. Parte do estado REAL do apply: o
  # alerta que a v1 abriu (corantes=11) segue aberto e a v2 tem de DISMISSA-LO (11 -> 0).
  # Cada caso isolado (limpa depois).
  P -q -c "INSERT INTO public.fin_alertas (company, tipo, severidade, mensagem, contexto) VALUES ('oben','tint_corante_impagavel','aviso','v1: 11 corantes', '{\"corantes\": 11, \"formulas_ativas\": 148}') ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;"
  usa_na_ativa 'c0000000-0000-0000-0000-000000000006' 'f0000000-0000-0000-0000-000000000003'
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A10 base sem vinculo Omie nao alarma (e fecha o alerta v1)" "$(alertas_ativos tint_corante_impagavel)" "0"
  tira_da_ativa 'c0000000-0000-0000-0000-000000000006' 'f0000000-0000-0000-0000-000000000003'
  P -q -c "SELECT public.tint_watchdog_corante_check();"

  usa_na_ativa 'c0000000-0000-0000-0000-000000000007' 'f0000000-0000-0000-0000-000000000004'
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A10b base Omie INATIVA nao alarma" "$(alertas_ativos tint_corante_impagavel)" "0"
  tira_da_ativa 'c0000000-0000-0000-0000-000000000007' 'f0000000-0000-0000-0000-000000000004'
  P -q -c "SELECT public.tint_watchdog_corante_check();"

  # A11: corante sem vinculo Omie numa formula de base OK alarma, rotulado pela DESCRICAO
  usa_na_ativa 'c0000000-0000-0000-0000-000000000008'
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A11 rotulo usa a descricao do corante" "$(Pq -c "SELECT position('CORANTE SEM VINCULO X (sem vinculo Omie)' IN contexto->>'detalhe') > 0 FROM public.fin_alertas WHERE tipo='tint_corante_impagavel' AND dismissed_at IS NULL;")" "t"
  eq "A11b rotulo sem UUID" "$(Pq -c "SELECT position('c0000000-0000-0000-0000-000000000008' IN mensagem) FROM public.fin_alertas WHERE tipo='tint_corante_impagavel' AND dismissed_at IS NULL;")" "0"
  tira_da_ativa 'c0000000-0000-0000-0000-000000000008'
  P -q -c "SELECT public.tint_watchdog_corante_check();"

  # A9: marcador da Camada B velho -> dead-man cruzado dispara
  P -q -c "INSERT INTO public.sync_state (entity_type, account, last_sync_at, status) VALUES ('tint_watchdog_fase5','oben', now() - interval '20 hours','complete');"
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A9 dead-man cruzado dispara com B parada" "$(alertas_ativos tint_watchdog_fase5_parado)" "1"

  # A15 (v4): VIGIA — o marcador da A envelhece 40 min (timeout aborta antes de gravá-lo)
  P -q -c "UPDATE public.sync_state SET last_sync_at = now() - interval '40 minutes' WHERE entity_type='tint_watchdog_corante';"
  P -q -c "SELECT public.tint_watchdog_corante_vigia_check();"
  eq "A15 vigia alarma A parada" "$(alertas_ativos tint_watchdog_corante_parado)" "1"
  eq "A15b vigia enfileira e-mail" "$(emails 'watchdog de corante parado')" "1"
  # A16: a A volta a concluir -> a vigia dismissa
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  P -q -c "SELECT public.tint_watchdog_corante_vigia_check();"
  eq "A16 vigia dismissa quando a A volta" "$(alertas_ativos tint_watchdog_corante_parado)" "0"
  # A17: a VIGIA para (marcador 2h) -> a A alarma (nenhum cron vigia a si mesmo)
  P -q -c "UPDATE public.sync_state SET last_sync_at = now() - interval '2 hours' WHERE entity_type='tint_watchdog_corante_vigia';"
  P -q -c "SELECT public.tint_watchdog_corante_check();"
  eq "A17 A alarma vigia parada" "$(alertas_ativos tint_watchdog_corante_vigia_parada)" "1"
  eq "A18 cron da vigia armado */15" "$(Pq -c "SELECT schedule FROM cron.job WHERE jobname='tint-watchdog-corante-vigia-15min';")" "*/15 * * * *"
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
# Cada sabotagem nasce por substituição sobre a migration REAL (diferença de
# exatamente 1 ponto), e PROVA QUE APLICOU antes de medir — senão "não casou
# nada" se leria como "o assert não tem dente".
# ══════════════════════════════════════════════════════════════════════════════
FALSIF_ERR=0

sabota_e_mede() {   # $1=rotulo  $2=busca  $3=troca  $4..=asserts esperados
  local rot="$1" busca="$2" troca="$3"; shift 3
  local esperado="$*"
  local sab="$RODADA/_wd_sab_${rot}.sql"

  # `if !` e nao `cmd; if [ $? -ne 0 ]`: com `set -euo pipefail` ativo e esta funcao chamada NUA
  # (`sabota_e_mede "F1" \`), o python3 saindo !=0 abortava o script AQUI — o bloco de erro abaixo
  # era INALCANCAVEL e o FALSIF_ERR nunca contava (medido 2026-08-28). `if !` suspende o `set -e`.
  if ! python3 - "$MIG" "$sab" "$busca" "$troca" <<'PY'
import sys
src, dst, busca, troca = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = open(src).read()
n = s.count(busca)
if n != 1:
    sys.stderr.write("ANCORA NAO UNICA (%d ocorrencias)\n" % n); sys.exit(3)
open(dst, "w").write(s.replace(busca, troca))
PY
  then
    echo "  FALSIF XX  $rot: a sabotagem NAO aplicou (ancora nao casou) — INVALIDA, nao leia como 'sem dente'"
    FALSIF_ERR=$((FALSIF_ERR+1)); return
  fi
  # prova que aplicou de fato
  if ! command grep -q -- "$troca" "$sab"; then
    echo "  FALSIF XX  $rot: texto sabotado ausente no arquivo — INVALIDA"
    FALSIF_ERR=$((FALSIF_ERR+1)); return
  fi

  P -q -f "$sab" >/dev/null 2>&1
  roda_suite > "$RODADA/_wd_suite.log" 2>&1

  local caidos=""
  if [ "${#FALHAS[@]}" -gt 0 ]; then
    for f in "${FALHAS[@]}"; do caidos="$caidos $(printf '%s' "$f" | awk '{print $1}')"; done
  fi
  # `|| true` DELIBERADO nas duas normalizacoes: com lista VAZIA o `grep -v '^$'` nao casa nada e
  # devolve 1, que o `pipefail` propaga para a atribuicao — e vazio e resultado LEGITIMO aqui ("a
  # sabotagem nao derrubou assert nenhum"), justamente o caso que este bloco existe para REPORTAR.
  # Medido em 2026-08-28: sem o `|| true` o `set -e` matava o harness ANTES do "FALSIF XX", sem
  # imprimir nada — a falsificacao sem dente sumia em vez de acusar. `local` separado do assign
  # porque `local x=$(...)` mascara o status do pipeline por acidente (SC2155); aqui a mascara e
  # INTENCIONAL e explicita.
  caidos="$(printf '%s' "$caidos" | tr ' ' '\n' | command grep -v '^$' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')" || true
  local esp
  esp="$(printf '%s' "$esperado" | tr ' ' '\n' | command grep -v '^$' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')" || true

  if [ "$caidos" = "$esp" ]; then
    echo "  FALSIF OK  $rot derrubou EXATAMENTE [$caidos]"
  else
    echo "  FALSIF XX  $rot: esperado [$esp], veio [$caidos]"
    FALSIF_ERR=$((FALSIF_ERR+1))
  fi
  restaura   # volta a versão verdadeira antes da próxima
}

echo "=== FALSIFICACOES ==="

# F1 — remove o filtro de USO: corante impagável que ninguém dosa passaria a alarmar.
#      Prova que A2/A3 (precisão > recall) têm dente.
#      ⚠️ O conjunto é MAIOR que {A2,A3}, e isso é CASCATA LÓGICA de uma sabotagem
#      só — não de duas. Sem o filtro, os impagáveis órfãos (C_ORFAO/C_MORTA)
#      contam SEMPRE: a chave nunca volta a zero (derruba o dismiss A5) e a
#      contagem nunca sobe de 1->2 (derruba o agravamento A6/A6b). Declarado como
#      medido: prever {A2,A3} e "consertar" o harness para casar seria repintar
#      de verde uma sabotagem que de fato morde mais fundo. Na v2 a mesma cascata
#      alcança A10/A10b: o alerta dos órfãos já está aberto quando eles medem. Na v4
#      cai também A12/A14/A14b (o conjunto nunca encolhe nem troca: os órfãos ficam), e
#      A6c deixa de cair — a atualização calada da v4 mantém o contexto em dia.
sabota_e_mede "F1" \
  "    JOIN uso u ON u.corante_id = c.id" \
  "    LEFT JOIN uso u ON u.corante_id = c.id" \
  A2 A3 A5 A6 A6b A10 A10b A12 A14 A14b

# F2 — remove o 'ativo' do predicado: o corante INATIVO deixa de ser impagável.
#      Prova que a detecção cobre inatividade no Omie, não só custo zero.
# (v4: sem C_INAT ruim o alerta só nasce no A6 — sem "AGRAVOU" — e A12/A14/A14b medem
#  um incidente que começou depois; cascata da MESMA sabotagem, medida.)
sabota_e_mede "F2" \
  "AND COALESCE(op.ativo, false)" \
  "AND true" \
  A1 A1b A7 A6 A6b A12 A14 A14b

# F3 — mata o ramo de agravamento: o 2o corante caindo com alerta aberto fica MUDO.
#      Prova que o fix do achado [P1] do Codex tem dente.
sabota_e_mede "F3" \
  "IF COALESCE(cardinality(v_novos), 0) > 0 OR v_escalou THEN" \
  "IF false THEN" \
  A6b A12 A13b A14b   # A14b conta 'AGRAVOU' a partir do e-mail do A6, que sumiu

# F4 — grava o marcador sob outro nome: o dead-man perde o last_success_at.
#      Prova que A4 mede mesmo o avanço do marcador.
sabota_e_mede "F4" \
  "'tint_watchdog_corante', v_conta" \
  "'tint_watchdog_NOME_ERRADO', v_conta" \
  A4 A16   # v4: a vigia lê o marcador certo, que nunca avança -> nunca dismissa

# F5 — volta ao predicado de base da v1 (só f.sku_id IS NOT NULL): a linha nova sem base no
#      Omie volta a alarmar como corante caído. Prova que A10/A10b têm dente.
sabota_e_mede "F5" \
  "JOIN tint_skus s        ON s.id = f.sku_id
      JOIN omie_products bp   ON bp.id = s.omie_product_id
     WHERE fi.corante_id = ANY (v_cand)
       AND f.desativada_em IS NULL
       AND bp.valor_unitario > 0 AND COALESCE(bp.ativo, false)
     GROUP BY" \
  "WHERE fi.corante_id = ANY (v_cand)
       AND f.desativada_em IS NULL AND f.sku_id IS NOT NULL
     GROUP BY" \
  A10 A10b

# F6 — tira a descrição do corante do rótulo: volta a listar UUID no e-mail.
sabota_e_mede "F6" \
  "NULLIF(btrim(c.descricao), ''), c.id::text)" \
  "c.id::text)" \
  A11 A11b

# F8 — "novo" volta a ser medido por QUANTIDADE (comportamento v1-v3): a troca fica muda.
sabota_e_mede "F8" \
  "v_novos := ARRAY(SELECT x FROM unnest(v_ids) x WHERE x <> ALL (v_ant_vistos) ORDER BY 1);" \
  "v_novos := CASE WHEN v_ruins > COALESCE(v_ant_n, 0) THEN v_ids END;" \
  A12 A20   # por quantidade, o corante já visto que volta (2 -> 3) re-emite

# F9 — sem escalada: a severidade ainda é persistida pela atualização calada (A13 verde),
#      mas o e-mail de 'passou a critico' some. Prova que A13b mede o e-mail, não só a coluna.
sabota_e_mede "F9" \
  "v_escalou := v_sev_fin = 'critico' AND v_ant_sev IS DISTINCT FROM 'critico';" \
  "v_escalou := false;" \
  A13b

# F10 — sem a atualização calada: o alerta volta a descrever o estado velho.
sabota_e_mede "F10" \
  "ELSIF v_ant_ids IS DISTINCT FROM v_ids" \
  "ELSIF false AND v_ant_ids IS DISTINCT FROM v_ids" \
  A14   # a troca do A12 é para corante nunca visto: re-emite mesmo com o contexto velho

# F11 — a vigia lê a entidade errada: marcador "ausente" = parada eterna, nunca dismissa.
sabota_e_mede "F11" \
  "WHERE ss.entity_type = 'tint_watchdog_corante' AND ss.account = v_conta;" \
  "WHERE ss.entity_type = 'x_entidade_errada' AND ss.account = v_conta;" \
  A16

# F12 — a A deixa de vigiar a vigia.
sabota_e_mede "F12" \
  "IF v_vigia_atraso IS NOT NULL AND v_vigia_atraso > interval '1 hour' THEN" \
  "IF false THEN" \
  A17

# F13 — sem 'vistos': "novo" vira "fora do conjunto ATUAL" e o corante que volta re-emite.
sabota_e_mede "F13" \
  "v_ant_vistos := COALESCE(v_ant_vistos, v_ant_ids);" \
  "v_ant_vistos := v_ant_ids;" \
  A20

# F14 — severidade não-pegajosa: 999 rebaixa a 'aviso' e a volta a 1000 re-emite.
sabota_e_mede "F14" \
  "IF v_ant_sev = 'critico' THEN" \
  "IF false THEN" \
  A19 A19b

# F7 — volta a somar pares fórmula×corante: 2 corantes na mesma fórmula viram "2 fórmulas".
sabota_e_mede "F7" \
  "SELECT count(DISTINCT fi.formula_id)" \
  "SELECT count(fi.formula_id)" \
  A6c

# ══ fecho: re-roda a suíte na versão REAL e exige verde ══
echo "=== VERIFICACAO FINAL (migration real restaurada) ==="
roda_suite
echo "--- final: $PASS ok / $FAIL falhas | falsificacoes invalidas/erradas: $FALSIF_ERR ---"
# Recibo lido pelo db/roda-nucleo-ci.sh ("falhas" não casa o "fail" que ele procura). Falsificação
# inválida entra no FAIL de propósito: prova sem dente não pode sair com FAIL=0.
echo "PASS=$PASS  FAIL=$((FAIL + FALSIF_ERR))"
if [ "$FAIL" -ne 0 ] || [ "$FALSIF_ERR" -ne 0 ]; then
  echo "RESULTADO: VERMELHO"
  exit 1
fi
echo "RESULTADO: VERDE — $PASS asserts + 14 falsificacoes com conjunto exato"
