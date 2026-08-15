#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — data_health_watchdog para de envelhecer MUDO (migration 20260814222000)     ║
# ║                                                                                            ║
# ║  Um teste ingênuo (`ok → broken → existe 1 linha e 1 e-mail`) aprovaria até a versão que  ║
# ║  ficou 20 dias muda em prod. O que precisa ser provado é o CONTRÁRIO: que a máquina        ║
# ║  RE-EMITE quando deve e CALA quando não deve — e que cada predicado tem dente.             ║
# ║                                                                                            ║
# ║      bash db/test-data-health-watchdog-reemissao.sh > /tmp/t.log 2>&1; echo "exit=$?"      ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                                    ║
# ║                                                                                            ║
# ║  LOCALE: o postmaster exige C, mas as SENTINELAS da falsificação são ASCII puro, caixa     ║
# ║  fixa e sem `-i` — então o harness roda igual sob LC_ALL=C e pt_BR.UTF-8 (regra do         ║
# ║  CLAUDE.md: falsificar num locale só não prova a asserção). O `env LC_ALL=C` é aplicado    ║
# ║  SÓ aos binários do Postgres, deixando o locale do shell livre para essa prova.            ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5469}"
SLUG="dhwd-reemissao"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { env LC_ALL=C "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

# LC_ALL=C SÓ para os binários do PG (o postmaster aborta em locale multithreaded).
PGE=(env LC_ALL=C LANG=C)
"${PGE[@]}" "$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"${PGE[@]}" "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"${PGE[@]}" "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "${PGE[@]}" "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  [OK] $1"; }
bad() { FAIL=$((FAIL+1)); echo "  [XX] $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

echo "=== setup (PG17 :$PORT, locale do shell: ${LC_ALL:-${LANG:-unset}}) ==="

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS
# ══════════════════════════════════════════════════════════════════════════════
# Stub MÍNIMO em vez do schema-snapshot: os 8 harnesses data-health do repo dependem do
# snapshot e 5 deles JÁ ESTÃO VERMELHOS na main por drift dele (omie_clientes ausente,
# _vendas_familia_ausente_lista_email com parâmetro renomeado, customer_metrics_mv não
# populada). Amarrar esta prova ao snapshot herdaria a podridão. O objeto sob teste é a
# MÁQUINA DE EPISÓDIO, e ela só precisa de fin_alertas + fornecedor_alerta reais.
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;

DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role public.app_role);

-- fin_alertas: forma REAL de prod (information_schema.columns + pg_constraint, 2026-08-14).
CREATE TABLE IF NOT EXISTS public.fin_alertas (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company              text NOT NULL CHECK (company = ANY (ARRAY['oben','colacor','colacor_sc'])),
  tipo                 text NOT NULL,
  severidade           text NOT NULL CHECK (severidade = ANY (ARRAY['info','aviso','critico'])),
  mensagem             text NOT NULL,
  valor                numeric,
  threshold            numeric,
  contexto             jsonb,
  criado_em            timestamptz NOT NULL DEFAULT now(),
  dismissed_at         timestamptz,
  dismissed_by         uuid,
  dismissed_until      timestamptz,
  email_enfileirado_em timestamptz
);
-- O índice PARCIAL é o coração da armadilha (dispensar REARMA; não dispensar silencia).
CREATE UNIQUE INDEX IF NOT EXISTS fin_alertas_unique_ativo
  ON public.fin_alertas (company, tipo) WHERE (dismissed_at IS NULL);

CREATE TABLE IF NOT EXISTS public.fornecedor_alerta (
  id         bigserial PRIMARY KEY,
  empresa    text NOT NULL,
  tipo       text NOT NULL CHECK (tipo = ANY (ARRAY['promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro','mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','whatsapp_sla','erro_app','outro','param_auto_resumo','reposicao_pedido_minimo'])),
  severidade text NOT NULL DEFAULT 'info' CHECK (severidade = ANY (ARRAY['info','atencao','urgente'])),
  titulo     text NOT NULL,
  mensagem   text,
  status     text DEFAULT 'pendente_notificacao' CHECK (status = ANY (ARRAY['pendente_notificacao','notificado','falha_notificacao','ignorado'])),
  criado_em  timestamptz DEFAULT now()
);

-- Anexos de e-mail que o watchdog chama para 2 fontes.
CREATE OR REPLACE FUNCTION public._vendas_familia_ausente_lista_email(p_limite int)
RETURNS text LANGUAGE sql STABLE AS $f$ SELECT 'LISTA-FAMILIA'::text $f$;
CREATE OR REPLACE FUNCTION public._tint_cobertura_bases_lista_email(p_limite int)
RETURNS text LANGUAGE sql STABLE AS $f$ SELECT 'LISTA-TINT'::text $f$;

-- Mesa de controle: dirige o stub de _data_health_compute cheque a cheque, rodada a rodada.
CREATE TABLE public._dh_control (
  source                   text PRIMARY KEY,
  "domain"                 text NOT NULL DEFAULT 'estoque',
  status                   text,
  age_seconds              bigint,
  expected_max_age_seconds bigint DEFAULT 172800,
  freshness_basis          text DEFAULT 'basis',
  message                  text,
  last_error               text,
  probable_cause           text,
  how_to_fix               text DEFAULT 'como corrigir',
  severity                 text,
  dup                      boolean NOT NULL DEFAULT false,
  ausente                  boolean NOT NULL DEFAULT false
);

-- Stub de _data_health_compute com a ASSINATURA IDÊNTICA à de prod (RETURNS TABLE de 11
-- colunas). A migration NÃO toca esta função — ela tem 3 dependentes SQL e a assinatura é
-- contrato. Aqui ela é apenas o pré-requisito que a máquina sob teste lê.
CREATE OR REPLACE FUNCTION public._data_health_compute()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint,
               expected_max_age_seconds bigint, freshness_basis text, message text,
               last_error text, probable_cause text, how_to_fix text, severity text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $f$
  SELECT c.source, c."domain", c.status, c.age_seconds, c.expected_max_age_seconds,
         c.freshness_basis, c.message, c.last_error, c.probable_cause, c.how_to_fix, c.severity
    FROM public._dh_control c WHERE NOT c.ausente
  UNION ALL
  SELECT c.source, c."domain", c.status, c.age_seconds, c.expected_max_age_seconds,
         c.freshness_basis, c.message, c.last_error, c.probable_cause, c.how_to_fix, c.severity
    FROM public._dh_control c WHERE c.dup
$f$;

-- Gatilho para forçar falha do OUTBOX (prova do rollback do claim).
-- 3 modos, porque eles caem em ramos DIFERENTES do desenho:
--   local      (23514) -> isolamento por check engole e conta a falha; claim cai junto
--   sistemico  (58030) -> classe 58 e' RELANCADA: derruba a rodada inteira, alto
--   silencioso (NULL)  -> INSERT "com sucesso" e ZERO linhas: so' o GET DIAGNOSTICS pega
CREATE OR REPLACE FUNCTION public._outbox_sabota() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF current_setting('test.outbox_falha', true) = 'local' THEN
    RAISE EXCEPTION 'outbox recusou o payload' USING ERRCODE = '23514';
  ELSIF current_setting('test.outbox_falha', true) = 'sistemico' THEN
    RAISE EXCEPTION 'outbox indisponivel' USING ERRCODE = '58030';
  ELSIF current_setting('test.outbox_falha', true) = 'silencioso' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER _outbox_sabota_trg BEFORE INSERT ON public.fornecedor_alerta
  FOR EACH ROW EXECUTE FUNCTION public._outbox_sabota();
SQL

# As 17 fontes do push, todas 'ok' de partida.
P -q <<'SQL' >/dev/null
-- age_seconds NULL so' nos 4 checks de CONTAGEM: o contrato fail-closed novo reprova
-- check de FRESCOR com idade nula (idade nula = conta de frescor quebrada).
INSERT INTO public._dh_control (source, status, severity, message, age_seconds)
SELECT s, 'ok', 'info', 'tudo certo em ' || s,
       CASE WHEN s IN ('reposicao_sayerlack_fabricado','vendas_familia_ausente',
                       'custos_proxy_conf_alta','custos_product_cost_revivido')
            THEN NULL ELSE 60 END
FROM unnest(ARRAY[
  'vendas_pedidos','estoque_inventario','estoque_reposicao','reposicao_sugestoes','carteira_scores',
  'custos_produtos','vendas_cadastros','reposicao_disparo','reposicao_portal_pipeline',
  'reposicao_portal_humano','reposicao_sayerlack_fabricado','omie_tipo_produto_oben',
  'vendas_familia_ausente','tint_cobertura_bases','custos_proxy_conf_alta',
  'custos_product_cost_revivido','pedidos_compra_sync']) s;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — GUARD ANTI-DRIFT + MIGRATION REAL
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260814222000_data_health_watchdog_reemissao.sql"
BASE="$REPO_ROOT/db/prod-data-health-watchdog-base-20260814.sql"

echo "-- guard anti-drift --"

# C15a: sem NENHUM watchdog, a migration recusa (criar versão órfã seria pior que não aplicar).
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "C15a migration aplicou SEM watchdog existente (devia abortar)"
else
  ok "C15a migration aborta quando data_health_watchdog() nao existe"
fi

# C15b: corpo VIVO divergente (nem o md5 pinado, nem o marcador) => aborta.
P -q -c "CREATE OR REPLACE FUNCTION public.data_health_watchdog() RETURNS void LANGUAGE plpgsql AS \$f\$ BEGIN RAISE NOTICE 'corpo alheio'; END \$f\$;" >/dev/null
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "C15b migration aplicou sobre corpo DIVERGENTE (guard sem dente)"
else
  ok "C15b migration aborta sobre functiondef vivo divergente"
fi

# Instala a base REAL de prod. Isto prova, de quebra, que o md5 pinado na migration é o de prod.
P -q -f "$BASE" >/dev/null
MD5VIVO=$(Pq -c "SELECT md5(pg_get_functiondef('public.data_health_watchdog()'::regprocedure));")
eq "C15c md5 do corpo de prod bate com o pin da migration" "$MD5VIVO" "3ca71a9df5faa9bbb6781fe2d8707fe9"

P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

# Idempotência: re-aplicar por cima de si mesma (marcador presente) e' no-op seguro.
if P -q -f "$MIG" >/dev/null 2>&1; then ok "C15d migration e' idempotente (marcador reconhecido)"; else bad "C15d re-aplicar a migration falhou"; fi

# A v2 desfaz 2 validadores da v1 que reprovavam dado LEGITIMO de prod (medido no 1o tick).
MIG2="$REPO_ROOT/supabase/migrations/20260815153218_data_health_contrato_severity_idade.sql"
P -q -f "$MIG2" >/dev/null
echo "migration aplicada: $(basename "$MIG2")"
V2=$(Pq -c "SELECT CASE WHEN pg_get_functiondef('public.data_health_watchdog()'::regprocedure) LIKE '%data_health reemissao v2%' THEN 'SIM' ELSE 'NAO' END;")
eq "C15e marcador subiu para v2" "$V2" "SIM"
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "C15f re-aplicar a v1 por cima da v2 PASSOU (reintroduziria os validadores errados)"
else ok "C15f re-aplicar a v1 por cima da v2 ABORTA (marcador versionado com dente)"; fi
# a v1 pode ter deixado o corpo sabotado? nao -- ela abortou antes de tocar em nada. Confirma:
V2B=$(Pq -c "SELECT CASE WHEN pg_get_functiondef('public.data_health_watchdog()'::regprocedure) LIKE '%data_health reemissao v2%' THEN 'SIM' ELSE 'NAO' END;")
eq "C15g e o corpo vivo continua sendo a v2" "$V2B" "SIM"



# shellcheck disable=SC2016  # $function$ e' o dollar-quote do plpgsql: literal de proposito.
so_episodio() { sed -n '/CREATE OR REPLACE FUNCTION public._data_health_episodio/,/^\$function\$;$/p' ; }
# shellcheck disable=SC2016
so_watchdog() { sed -n '/CREATE OR REPLACE FUNCTION public.data_health_watchdog/,/^\$function\$;$/p' ; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — HELPERS DE CENÁRIO
# ══════════════════════════════════════════════════════════════════════════════
rodar()      { P -q -c "SELECT public.data_health_watchdog();" >/dev/null 2>&1 || return 1; }
rodar_erro() { P -q -c "SELECT public.data_health_watchdog();" >/dev/null 2>&1 && return 1 || return 0; }
# Conta e-mails da fonte: o titulo e' '[Saude de dados] <source>' e <source> e' ASCII puro,
# entao o LIKE roda no SQL e nenhuma comparacao de shell toca acento (imune a locale).
emails()  { Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '%$1%';"; }
alertas() { Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo = 'data_health_$1' AND dismissed_at IS NULL;"; }
ctx()     { Pq -c "SELECT contexto->>'$2' FROM public.fin_alertas WHERE tipo = 'data_health_$1' AND dismissed_at IS NULL;"; }
lastok()  { Pq -c "SELECT COALESCE(last_success_at::text,'NULO') FROM public.data_health_watchdog_estado WHERE id;"; }

set_check() { # source status severity message [age_seconds]
  # Sem idade explicita: NULL nas 4 fontes de CONTAGEM (legitimo) e 60 nas de FRESCOR --
  # espelha o contrato que a migration passou a exigir.
  local idade; if [ $# -ge 5 ]; then idade="$5"; else
    case "$1" in reposicao_sayerlack_fabricado|vendas_familia_ausente|custos_proxy_conf_alta|custos_product_cost_revivido) idade=NULL;; *) idade=60;; esac
  fi
  P -q -c "UPDATE public._dh_control SET status='$2', severity='$3', message='$4', age_seconds=$idade WHERE source='$1';" >/dev/null
}
reset_tudo() {
  P -q -c "TRUNCATE public.fin_alertas; TRUNCATE public.fornecedor_alerta;
           DELETE FROM public.data_health_watchdog_estado;
           UPDATE public._dh_control SET status='ok', severity='info', message='tudo certo em '||source,
                  age_seconds=CASE WHEN source IN ('reposicao_sayerlack_fabricado','vendas_familia_ausente',
                                                   'custos_proxy_conf_alta','custos_product_cost_revivido')
                                   THEN NULL ELSE 60 END,
                  dup=false, ausente=false;" >/dev/null
}

echo "-- cenarios --"

# ── C1 · 48 rodadas 'stale' => 48 avaliacoes, 1 unico e-mail ────────────────────────────────
reset_tudo
set_check carteira_scores stale warning 'Scores: 1 pedido aguardando' 176400
for _ in $(seq 1 48); do rodar; done
eq "C1a 48 rodadas stale => 1 alerta aberto"        "$(alertas carteira_scores)" "1"
eq "C1b 48 rodadas stale => 1 e-mail (nao 48)"      "$(emails carteira_scores)"  "1"
eq "C1c estado atualizado a cada rodada (_n_emails)" "$(ctx carteira_scores _n_emails)" "1"
AVAL=$(ctx carteira_scores avaliado_em)
if [ -n "$AVAL" ]; then ok "C1d avaliado_em gravado (UPDATE incondicional do estado)"; else bad "C1d avaliado_em vazio"; fi

# ── C2 · stale -> broken re-emite IMEDIATO, mesmo com severity literal 'warning' ────────────
set_check carteira_scores broken warning 'Scores: 1 pedido aguardando' 700000
rodar
eq "C2a stale->broken => +1 e-mail imediato"        "$(emails carteira_scores)" "2"
eq "C2b motivo registrado = escalada"               "$(ctx carteira_scores _motivo_email)" "escalada"
rodar; rodar
eq "C2c depois da escalada volta a calar"           "$(emails carteira_scores)" "2"

# ── C3 · lembrete so' quando vence T ────────────────────────────────────────────────────────
PROX=$(ctx carteira_scores _prox_email_em)
if [ -n "$PROX" ]; then ok "C3a prazo de lembrete agendado"; else bad "C3a sem _prox_email_em"; fi
eq "C3b antes de T nao ha lembrete"                 "$(emails carteira_scores)" "2"
P -q -c "UPDATE public.fin_alertas SET contexto = contexto || jsonb_build_object('_prox_email_em', to_jsonb(clock_timestamp() - interval '1 minute')) WHERE tipo='data_health_carteira_scores' AND dismissed_at IS NULL;" >/dev/null
rodar
eq "C3c vencido T => +1 lembrete"                   "$(emails carteira_scores)" "3"
eq "C3d motivo registrado = lembrete"               "$(ctx carteira_scores _motivo_email)" "lembrete"
rodar
eq "C3e lembrete reagenda (nao repete na rodada seguinte)" "$(emails carteira_scores)" "3"

# ── C4 · mudanca COSMETICA (so' a idade envelhece) => 0 e-mail ──────────────────────────────
reset_tudo
set_check reposicao_disparo stale warning 'Disparo de compra: 1 pedido(s) aguardando (mais antigo 25/07)' 176400
rodar
eq "C4a episodio novo => 1 e-mail" "$(emails reposicao_disparo)" "1"
for A in 180000 190000 200000 210000; do set_check reposicao_disparo stale warning 'Disparo de compra: 1 pedido(s) aguardando (mais antigo 25/07)' $A; rodar; done
eq "C4b idade envelhece 4x => 0 e-mail novo" "$(emails reposicao_disparo)" "1"
eq "C4c mas o estado ACOMPANHA a idade"      "$(ctx reposicao_disparo age_seconds)" "210000"

# ── C5 · pedido B cruza o threshold com o episodio aberto => e-mail ANTES do lembrete ───────
# A materialidade tem COOLDOWN de 4h (teto contra oscilacao A,A,B,B). Envelhecemos o ultimo
# e-mail para fora dele: o que se mede aqui e' "violacao nova avisa ANTES do lembrete", nao
# "avisa no mesmo segundo".
P -q -c "UPDATE public.fin_alertas SET email_enfileirado_em = clock_timestamp() - interval '5 hours'
         WHERE tipo='data_health_reposicao_disparo' AND dismissed_at IS NULL;" >/dev/null
set_check reposicao_disparo stale warning 'Disparo de compra: 2 pedido(s) aguardando (mais antigo 25/07)' 210000
rodar
eq "C5a 1a rodada da violacao nova AINDA nao emite (confirmacao)" "$(emails reposicao_disparo)" "1"
rodar
eq "C5b 2a rodada confirma => +1 e-mail, sem esperar o lembrete"  "$(emails reposicao_disparo)" "2"
eq "C5c motivo registrado = nova_violacao" "$(ctx reposicao_disparo _motivo_email)" "nova_violacao"
rodar; rodar
eq "C5d violacao estavel volta a calar" "$(emails reposicao_disparo)" "2"

# ── C5e · mensagem VOLATIL nunca se confirma => nunca vira tempestade ───────────────────────
reset_tudo
set_check custos_produtos stale warning 'Custos: parado ha 1h' 3600
rodar
for H in 2 3 4 5 6 7 8 9 10 11; do set_check custos_produtos stale warning "Custos: parado ha ${H}h" $((H*3600)); rodar; done
eq "C5e mensagem que muda TODA rodada => 1 e-mail (nao 11)" "$(emails custos_produtos)" "1"

# ── C6 · duas sessoes simultaneas => 1 alerta e 1 outbox ────────────────────────────────────
reset_tudo
set_check pedidos_compra_sync broken critical 'Pedidos de compra: sync parado' 90000
(
  P -q >/dev/null 2>&1 <<'SQL' || true
BEGIN;
SELECT public._data_health_episodio('oben','data_health_pedidos_compra_sync','broken','critico',
  '[Saude] pedidos_compra_sync','Pedidos de compra: sync parado',NULL,'{}'::jsonb,'FP-CONCORRENTE');
SELECT pg_sleep(2);
COMMIT;
SQL
) &
CONC_PID=$!
sleep 0.8
P -q -c "SELECT public._data_health_episodio('oben','data_health_pedidos_compra_sync','broken','critico','[Saude] pedidos_compra_sync','Pedidos de compra: sync parado',NULL,'{}'::jsonb,'FP-CONCORRENTE');" >/dev/null 2>&1 || true
wait $CONC_PID || true
eq "C6a 2 sessoes simultaneas => 1 alerta aberto" "$(alertas pedidos_compra_sync)" "1"
eq "C6b 2 sessoes simultaneas => 1 e-mail"        "$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '%pedidos_compra_sync%';")" "1"

# ── C7/C8 · status NULL e typo: check falha, alerta ativo NAO e' resolvido, dead-man trava ──
reset_tudo
set_check vendas_pedidos stale warning 'Vendas: pedidos parados' 100000
rodar
eq "C7a alerta aberto antes da sabotagem" "$(alertas vendas_pedidos)" "1"
OK_ANTES=$(lastok)
P -q -c "UPDATE public._dh_control SET status=NULL WHERE source='vendas_pedidos';" >/dev/null
rodar
eq "C7b status NULL NAO resolve o alerta ativo (falha ABERTA fechada)" "$(alertas vendas_pedidos)" "1"
eq "C7c status NULL => check contabilizado como falho" "$(Pq -c "SELECT checks_falhos FROM public.data_health_watchdog_estado WHERE id;")" "1"
if [ "$(lastok)" = "$OK_ANTES" ]; then ok "C7d last_success_at NAO avanca com check falho"; else bad "C7d last_success_at avancou com check falho"; fi
eq "C7e falha e' BARULHENTA (alerta dedicado aberto)" "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_watchdog_erro' AND dismissed_at IS NULL;")" "1"

P -q -c "UPDATE public._dh_control SET status='stalee' WHERE source='vendas_pedidos';" >/dev/null
rodar
eq "C8a status com TYPO NAO resolve o alerta ativo" "$(alertas vendas_pedidos)" "1"
P -q -c "UPDATE public._dh_control SET status='stale', severity='warnin' WHERE source='vendas_pedidos';" >/dev/null
rodar
eq "C8b severity com TYPO NAO resolve nem vira 'aviso' calado" "$(alertas vendas_pedidos)" "1"
P -q -c "UPDATE public._dh_control SET severity='warning' WHERE source='vendas_pedidos';" >/dev/null

# ── C9 · fonte DUPLICADA: aborta antes do laco, nada e' resolvido ───────────────────────────
reset_tudo
set_check estoque_inventario stale warning 'Inventario: parado' 100000
rodar
eq "C9a alerta aberto antes da duplicata" "$(alertas estoque_inventario)" "1"
P -q -c "UPDATE public._dh_control SET dup=true WHERE source='estoque_inventario';" >/dev/null
OK9=$(lastok)
rodar
# NAO aborta a transacao de proposito: abortar desfaria o registro de estado e o meta-alerta
# junto (o BEGIN/EXCEPTION do dead-man e' subtransacao, nao transacao autonoma). Vira rodada
# incompleta ALTA, com o laco pulado.
eq "C9b duplicata NAO resolve nada (laco pulado)" "$(alertas estoque_inventario)" "1"
eq "C9c duplicata e' contabilizada como falha"    "$(Pq -c "SELECT checks_falhos FROM public.data_health_watchdog_estado WHERE id;")" "1"
if [ "$(lastok)" = "$OK9" ]; then ok "C9d duplicata NAO avanca last_success_at"; else bad "C9d duplicata avancou o marcador"; fi
eq "C9e duplicata abre o alerta do vigia"         "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_watchdog_erro' AND dismissed_at IS NULL;")" "1"
P -q -c "UPDATE public._dh_control SET dup=false WHERE source='estoque_inventario';" >/dev/null

# ── C10 · fonte AUSENTE: last_success_at nao avanca ─────────────────────────────────────────
reset_tudo
rodar
OK1=$(lastok)
if [ "$OK1" != "NULO" ]; then ok "C10a rodada COMPLETA avanca last_success_at"; else bad "C10a rodada completa nao carimbou"; fi
P -q -c "UPDATE public._dh_control SET ausente=true WHERE source='tint_cobertura_bases';" >/dev/null
rodar
eq "C10b fonte ausente => last_success_at NAO avanca" "$(lastok)" "$OK1"
eq "C10c fonte ausente => 16 de 17 avaliadas" "$(Pq -c "SELECT checks_avaliados FROM public.data_health_watchdog_estado WHERE id;")" "16"
P -q -c "UPDATE public._dh_control SET ausente=false WHERE source='tint_cobertura_bases';" >/dev/null

# ── C11 · reconhecimento humano cala o lembrete, mas NAO cala a escalada ────────────────────
reset_tudo
set_check custos_proxy_conf_alta stale warning 'Proveniencia: 3 linha(s) forjadas'
rodar
eq "C11a episodio novo => 1 e-mail" "$(emails custos_proxy_conf_alta)" "1"
P -q -c "UPDATE public.fin_alertas SET acknowledged_at = now(), acknowledged_by = gen_random_uuid(),
         contexto = contexto || jsonb_build_object('_prox_email_em', to_jsonb(clock_timestamp() - interval '1 minute'))
         WHERE tipo='data_health_custos_proxy_conf_alta' AND dismissed_at IS NULL;" >/dev/null
rodar
eq "C11b reconhecido: lembrete VENCIDO nao emite" "$(emails custos_proxy_conf_alta)" "1"
set_check custos_proxy_conf_alta broken critical 'Proveniencia: 3 linha(s) forjadas'
rodar
eq "C11c escalada SUPERA o reconhecimento" "$(emails custos_proxy_conf_alta)" "2"
eq "C11d escalada ZERA o reconhecimento (severidade nova exige ack novo)" \
   "$(Pq -c "SELECT COALESCE(acknowledged_at::text,'NULO') FROM public.fin_alertas WHERE tipo='data_health_custos_proxy_conf_alta' AND dismissed_at IS NULL;")" "NULO"

# ── C11e · soneca com vencimento GOVERNA o produtor ─────────────────────────────────────────
reset_tudo
set_check omie_tipo_produto_oben stale warning 'Tipo de produto: cobertura caiu' 90000
rodar
P -q -c "UPDATE public.fin_alertas SET dismissed_until = clock_timestamp() + interval '7 days',
         contexto = contexto || jsonb_build_object('_prox_email_em', to_jsonb(clock_timestamp() - interval '1 minute'))
         WHERE tipo='data_health_omie_tipo_produto_oben' AND dismissed_at IS NULL;" >/dev/null
rodar
eq "C11e soneca vigente segura o lembrete" "$(emails omie_tipo_produto_oben)" "1"
P -q -c "UPDATE public.fin_alertas SET dismissed_until = clock_timestamp() - interval '1 minute'
         WHERE tipo='data_health_omie_tipo_produto_oben' AND dismissed_at IS NULL;" >/dev/null
rodar
eq "C11f soneca VENCIDA volta a emitir" "$(emails omie_tipo_produto_oben)" "2"

# ── C12 · falha no OUTBOX derruba o claim junto ─────────────────────────────────────────────
reset_tudo
set_check vendas_cadastros broken critical 'Cadastros: sync parado' 200000
P -q -c "ALTER DATABASE prove SET test.outbox_falha = 'local';" >/dev/null
rodar
eq "C12a outbox falhando => 0 e-mail"                       "$(emails vendas_cadastros)" "0"
eq "C12b outbox falhando => alerta NAO nasce meio-gravado"  "$(alertas vendas_cadastros)" "0"
eq "C12c falha do outbox e' contabilizada"                  "$(Pq -c "SELECT checks_falhos FROM public.data_health_watchdog_estado WHERE id;")" "1"
P -q -c "ALTER DATABASE prove RESET test.outbox_falha;" >/dev/null
rodar
eq "C12d outbox de volta => e-mail sai"                     "$(emails vendas_cadastros)" "1"
CLAIM=$(Pq -c "SELECT COALESCE(email_enfileirado_em::text,'NULO') FROM public.fin_alertas WHERE tipo='data_health_vendas_cadastros' AND dismissed_at IS NULL;")
if [ "$CLAIM" != "NULO" ]; then ok "C12e claim carimbado junto com o e-mail"; else bad "C12e claim vazio com e-mail enfileirado"; fi

# ── C16 · erro SISTEMICO nao pode ser engolido pelo isolamento por check ────────────────────
# `WHEN OTHERS` cru trocaria 1 erro alto por 17 silencios. Classe 58 (sistema) e' relancada.
reset_tudo
set_check vendas_pedidos broken critical 'Vendas: pedidos parados' 200000
P -q -c "ALTER DATABASE prove SET test.outbox_falha = 'sistemico';" >/dev/null
if rodar_erro; then ok "C16a erro de classe 58 derruba a rodada (nao e' engolido)"; else bad "C16a erro sistemico foi engolido pelo isolamento"; fi
P -q -c "ALTER DATABASE prove RESET test.outbox_falha;" >/dev/null

# ── C13 · broken -> ok -> stale gera DOIS episodios, com resolucao auditavel ────────────────
reset_tudo
set_check reposicao_portal_humano broken critical 'Portal: 2 pedido(s) precisando intervencao' 90000
rodar
ID1=$(Pq -c "SELECT id FROM public.fin_alertas WHERE tipo='data_health_reposicao_portal_humano' AND dismissed_at IS NULL;")
set_check reposicao_portal_humano ok info 'Portal: nada pendente'
rodar
eq "C13a status ok EXPLICITO resolve o episodio" "$(alertas reposicao_portal_humano)" "0"
eq "C13b resolucao AUTOMATICA fica auditavel (resolvido_em)" \
   "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE id='$ID1' AND resolvido_em IS NOT NULL;")" "1"
set_check reposicao_portal_humano stale warning 'Portal: 1 pedido(s) precisando intervencao' 9000
rodar
eq "C13c recaida abre episodio NOVO" "$(alertas reposicao_portal_humano)" "1"
ID2=$(Pq -c "SELECT id FROM public.fin_alertas WHERE tipo='data_health_reposicao_portal_humano' AND dismissed_at IS NULL;")
if [ "$ID1" != "$ID2" ]; then ok "C13d sao 2 episodios distintos"; else bad "C13d reusou o mesmo episodio"; fi
# A recaida e' MENOS grave (aviso/stale=22) do que o ja' notificado (critico/broken=33) e cai
# dentro da cadencia => o anti-flap segura o e-mail. O silencio tem TETO: o lembrete herdou o
# prazo do e-mail real, entao a recaida avisa em 24h no pior caso.
eq "C13e recaida MENOS grave dentro da cadencia nao re-emite" "$(emails reposicao_portal_humano)" "1"
PROX13=$(ctx reposicao_portal_humano _prox_email_em)
if [ -n "$PROX13" ]; then ok "C13f o episodio silenciado herda o prazo do lembrete (silencio com teto)"; else bad "C13f episodio silenciado sem prazo => silencio infinito"; fi
# ...mas uma recaida PIOR do que o ja' notificado fura o anti-flap na hora. Precisa partir de
# uma notificacao MAIS BRANDA: critico+broken e' o teto da escala, e nada e' "pior" que o teto.
reset_tudo
set_check reposicao_portal_pipeline stale warning 'Pipeline: 1 pedido preso'
rodar
eq "C13g-1 1o episodio (aviso) avisa" "$(emails reposicao_portal_pipeline)" "1"
set_check reposicao_portal_pipeline ok info 'Pipeline: ok'
rodar
set_check reposicao_portal_pipeline broken critical 'Pipeline: 9 pedidos presos'
rodar
eq "C13g-2 recaida PIOR que o notificado fura o anti-flap na hora" "$(emails reposicao_portal_pipeline)" "2"

# ── C13h · FLAPPING: ok<->stale a cada rodada NAO vira tempestade ───────────────────────────
# E' o furo ESPELHO do bug corrigido: cada oscilacao encerra e reabre o episodio, e
# "episodio novo => e-mail" daria 48/dia. Vale tambem para o "dispensar" da UI.
reset_tudo
for _ in $(seq 1 12); do
  set_check estoque_reposicao stale warning 'Estoque: marcador parado' 200000; rodar
  set_check estoque_reposicao ok info 'Estoque: ok'; rodar
done
eq "C13h 12 ciclos de flapping ok<->stale => 1 e-mail (nao 12)" "$(emails estoque_reposicao)" "1"

# ── C13j · recorrencia LEGITIMA (depois de horas saudavel) avisa na hora ────────────────────
# O anti-flap tem de separar oscilacao de recorrencia: calar um pedido novo so' porque outro
# foi resolvido ha' pouco recriaria o silencio que esta migration existe para acabar.
reset_tudo
set_check reposicao_disparo stale warning 'Disparo: 1 pedido(s) aguardando'
rodar
eq "C13j-1 1o episodio avisa" "$(emails reposicao_disparo)" "1"
set_check reposicao_disparo ok info 'Disparo: nenhum pedido pendente'
rodar
# envelhece a resolucao para FORA da janela de flap (2h): a fonte ficou saudavel de verdade
P -q -c "UPDATE public.fin_alertas SET dismissed_at = clock_timestamp() - interval '5 hours'
         WHERE tipo='data_health_reposicao_disparo' AND dismissed_at IS NOT NULL;" >/dev/null
set_check reposicao_disparo stale warning 'Disparo: 1 pedido(s) aguardando'
rodar
eq "C13j-2 recaida apos 5h de saude avisa IMEDIATO (nao espera lembrete)" "$(emails reposicao_disparo)" "2"

# ── C13i · "dispensar" da UI nao pode virar rearme com e-mail ───────────────────────────────
reset_tudo
set_check custos_product_cost_revivido stale warning 'Proveniencia: 5 linha(s) PRODUCT_COST'
rodar
eq "C13i-1 episodio novo => 1 e-mail" "$(emails custos_product_cost_revivido)" "1"
P -q -c "UPDATE public.fin_alertas SET dismissed_at = now() WHERE tipo='data_health_custos_product_cost_revivido' AND dismissed_at IS NULL;" >/dev/null
rodar; rodar
eq "C13i-2 dispensa humana reabre o episodio SEM tempestade" "$(emails custos_product_cost_revivido)" "1"

# ── C14 · linha HISTORICA (email_enfileirado_em NULL) => 1 catch-up, nunca 48/dia ───────────
# Reproduz os 3 alertas presos de prod: contexto sem as ancoras novas, sem e-mail desde a criacao.
reset_tudo
P -q -c "INSERT INTO public.fin_alertas (company,tipo,severidade,mensagem,contexto,criado_em)
         VALUES ('oben','data_health_vendas_familia_ausente','aviso',
                 'Catalogo de venda: 12 produto(s) ativo(s) sem familia',
                 jsonb_build_object('source','vendas_familia_ausente','status','stale'),
                 now() - interval '30 days');" >/dev/null
set_check vendas_familia_ausente stale warning 'Catalogo de venda: 12 produto(s) ativo(s) sem familia'
rodar
# O motivo tem de ser lido na rodada que EMITIU: nas seguintes ele volta a NULL de proposito
# (o campo descreve o ultimo disparo, nao um estado pegajoso).
eq "C14b motivo registrado = nunca_enfileirou" "$(ctx vendas_familia_ausente _motivo_email)" "nunca_enfileirou"
for _ in $(seq 1 47); do rodar; done
eq "C14a alerta preso ha 30 dias => exatamente 1 catch-up em 48 rodadas" "$(emails vendas_familia_ausente)" "1"
eq "C14c o episodio historico foi REAPROVEITADO (nao duplicou)" "$(alertas vendas_familia_ausente)" "1"
eq "C14d o anexo da lista foi ao e-mail" \
   "$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '%vendas_familia_ausente%' AND mensagem LIKE '%LISTA-FAMILIA%';")" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4b — ACHADOS DO CHALLENGE CODEX (xhigh, 2026-08-14): cada correcao com cenario proprio
# ══════════════════════════════════════════════════════════════════════════════
echo "-- achados do codex --"

# ── K1 (A2) · REARME NA RECUPERACAO: sem ele, voltar ao patamar anterior fica MUDO sob ack ──
# broken(23) avisa -> melhora p/ stale(22) -> humano reconhece -> volta a broken(23).
# Sem rearme a ancora segue 23, "23 > 23" e' falso, o ack bloqueia tudo e o retorno e' mudo.
reset_tudo
set_check reposicao_disparo broken warning 'Disparo: 3 pedido(s)' 700000
rodar
eq "K1a pico broken avisa" "$(emails reposicao_disparo)" "1"
set_check reposicao_disparo stale warning 'Disparo: 1 pedido(s)' 176400
rodar
P -q -c "UPDATE public.fin_alertas SET acknowledged_at = now()
         WHERE tipo='data_health_reposicao_disparo' AND dismissed_at IS NULL;" >/dev/null
eq "K1b ancora DESCEU junto com a melhora" "$(ctx reposicao_disparo _grav_email)" "22"
set_check reposicao_disparo broken warning 'Disparo: 3 pedido(s)' 700000
rodar
eq "K1c voltar ao patamar anterior volta a ser ESCALADA (supera o ack)" "$(emails reposicao_disparo)" "2"

# ── K2 (B1) · materialidade com COOLDOWN: A,A,B,B,A,A nao vira 24 e-mails/dia ───────────────
# A confirmacao em 2 avaliacoes mata A,B,A,B, mas nao mata A,A,B,B -- cada par confirmaria.
reset_tudo
set_check custos_produtos stale warning 'Custos: variante A' 5000
rodar
for _ in 1 2 3 4 5 6; do
  set_check custos_produtos stale warning 'Custos: variante B' 5000; rodar; rodar
  set_check custos_produtos stale warning 'Custos: variante A' 5000; rodar; rodar
done
eq "K2 12 alternancias confirmadas => 1 e-mail (cooldown de 4h segura)" "$(emails custos_produtos)" "1"

# ── K3 (A1) · linha historica COM carimbo e SEM as ancoras novas nao pode ficar muda ────────
# v_nunca=false, v_escalou=false, v_material=false e v_lembrete=false => silencio eterno.
reset_tudo
P -q -c "INSERT INTO public.fin_alertas (company,tipo,severidade,mensagem,contexto,criado_em,email_enfileirado_em)
         VALUES ('oben','data_health_carteira_scores','aviso','Scores: parado',
                 jsonb_build_object('source','carteira_scores','status','stale'),
                 now() - interval '20 days', now() - interval '20 days');" >/dev/null
set_check carteira_scores stale warning 'Scores: parado' 176400
rodar
eq "K3a linha com carimbo e sem ancoras recebe 1 e-mail de bootstrap" "$(emails carteira_scores)" "1"
for _ in $(seq 1 10); do rodar; done
eq "K3b e depois do bootstrap volta a calar (nao vira tempestade)" "$(emails carteira_scores)" "1"

# ── K4 (A3) · dead-man engata mesmo sem NENHUMA rodada completa na historia ─────────────────
reset_tudo
P -q -c "INSERT INTO public.data_health_watchdog_estado (id,last_run_at,last_success_at,atualizado_em)
         VALUES (true, clock_timestamp() - interval '9 hours', NULL, clock_timestamp())
         ON CONFLICT (id) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, last_success_at = NULL;" >/dev/null
rodar
eq "K4 vigia que NUNCA completou uma rodada abre o alerta de degradado" \
   "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_watchdog_degradado' AND dismissed_at IS NULL;")" "1"

# ── K5 (E1) · check de FRESCOR com age_seconds NULL nao pode resolver alerta ativo ──────────
reset_tudo
set_check vendas_pedidos stale warning 'Vendas: parado' 100000
rodar
eq "K5a alerta aberto" "$(alertas vendas_pedidos)" "1"
# ⚠️ INVERTIDO pela v2 (20260815153218), depois de MEDIR a prod: `ok` com age_seconds NULL e'
# o estado SAUDAVEL de 3 checks de frescor -- eles derivam a idade de min() sobre as linhas
# PENDENTES, entao zero pendente => min NULL => idade NULL => ok. Reprovar isso cegou 7 dos 17
# checks no 1o tick em producao. O oraculo nao era o teste (semeado com a premissa errada) --
# era o corpo vivo de _data_health_compute.
P -q -c "UPDATE public._dh_control SET status='ok', severity='info', age_seconds=NULL WHERE source='vendas_pedidos';" >/dev/null
rodar
eq "K5b frescor 'ok' com idade NULA e' LEGITIMO (zero pendente) e resolve" "$(alertas vendas_pedidos)" "0"
eq "K5c e NAO e' contabilizado como falha" "$(Pq -c "SELECT checks_falhos FROM public.data_health_watchdog_estado WHERE id;")" "0"
# ⚠️ mas o recorte e' SO' no ramo 'ok': frescor legitimamente BROKEN porque a fonte nunca
# sincronizou devolve idade NULL (max(...) nulo => EXTRACT nulo). Barrar ali trocaria um alerta
# especifico por um generico "vigia com check falhando" -- pior que o bug que se quer fechar.
reset_tudo
P -q -c "UPDATE public._dh_control SET status='broken', severity='critical',
         message='Vendas: nunca sincronizou', age_seconds=NULL WHERE source='vendas_pedidos';" >/dev/null
rodar
eq "K5d frescor BROKEN com idade nula (nunca sincronizou) alerta normalmente" "$(alertas vendas_pedidos)" "1"
eq "K5e e NAO e' contabilizado como falha" "$(Pq -c "SELECT checks_falhos FROM public.data_health_watchdog_estado WHERE id;")" "0"

# ── K6 (E1) · combinacao contraditoria status=ok + severity=critical e' recusada ────────────
reset_tudo
set_check pedidos_compra_sync stale critical 'Pedidos: sync parado' 90000
rodar
# ⚠️ INVERTIDO pela v2: `severity` e' LITERAL POR CHECK ('critical'::text sem CASE nenhum) --
# descreve quao grave e' o check QUANDO degrada, nao o estado atual. `ok`+`critical` e' o
# estado normal de um check critico SAUDAVEL, nao contradicao.
P -q -c "UPDATE public._dh_control SET status='ok', severity='critical' WHERE source='pedidos_compra_sync';" >/dev/null
rodar
eq "K6a status=ok com severity=critical e' LEGITIMO e resolve" "$(alertas pedidos_compra_sync)" "0"
eq "K6b e a rodada segue COMPLETA (17/17, zero falhas)" "$(Pq -c "SELECT checks_avaliados||'/'||checks_falhos FROM public.data_health_watchdog_estado WHERE id;")" "17/0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICACAO (Lei #3): sabota => exige VERMELHO => restaura
# ══════════════════════════════════════════════════════════════════════════════
echo "-- falsificacao --"
FALSIF_OK=0; FALSIF_BAD=0
# Sentinelas ASCII puro, caixa fixa, sem -i: identicas sob LC_ALL=C e pt_BR.UTF-8.
verdicto() { # nome  resultado_do_cenario(0=verde,1=vermelho)
  if [ "$2" = "1" ]; then FALSIF_OK=$((FALSIF_OK+1)); echo "  [DENTE] $1 -- sabotagem ficou VERMELHA"
  else FALSIF_BAD=$((FALSIF_BAD+1)); echo "  [SEM-DENTE] $1 -- sabotagem passou VERDE (assert fraco)"; fi
}
# Re-aplicar os arquivos inteiros nao serve mais: o guard da v1 ABORTA sobre o marcador v2
# (de proposito). Restauramos exatamente as duas funcoes sob teste -- _data_health_episodio vem
# da v1 (a v2 nao a recria) e data_health_watchdog vem da v2.
restaurar() {
  P -q -c "$(so_episodio < "$MIG")"  >/dev/null
  P -q -c "$(so_watchdog < "$MIG2")" >/dev/null
}

# Cada cenario abaixo devolve 1 quando o invariante QUEBRA (ou seja: quando a sabotagem pegou).
cen_lembrete() { reset_tudo; set_check carteira_scores stale warning 'M' 1000; rodar
  P -q -c "UPDATE public.fin_alertas SET contexto = contexto || jsonb_build_object('_prox_email_em', to_jsonb(clock_timestamp() - interval '1 minute')) WHERE dismissed_at IS NULL;" >/dev/null
  rodar; [ "$(emails carteira_scores)" = "2" ] && return 0 || return 1; }
cen_escalada() { reset_tudo; set_check carteira_scores stale warning 'M' 1000; rodar
  set_check carteira_scores broken warning 'M' 2000; rodar
  [ "$(emails carteira_scores)" = "2" ] && return 0 || return 1; }
cen_material() { reset_tudo; set_check reposicao_disparo stale warning 'Disparo: 1 pedido' 1000; rodar
  # sai do cooldown de 4h da materialidade -- senao o cenario mede o cooldown, nao o fingerprint
  P -q -c "UPDATE public.fin_alertas SET email_enfileirado_em = clock_timestamp() - interval '5 hours'
           WHERE tipo='data_health_reposicao_disparo' AND dismissed_at IS NULL;" >/dev/null
  set_check reposicao_disparo stale warning 'Disparo: 2 pedido' 1000; rodar; rodar
  [ "$(emails reposicao_disparo)" = "2" ] && return 0 || return 1; }
cen_antispam() { reset_tudo; set_check carteira_scores stale warning 'M' 1000
  for _ in $(seq 1 10); do rodar; done
  [ "$(emails carteira_scores)" = "1" ] && return 0 || return 1; }
cen_nulo() { reset_tudo; set_check vendas_pedidos stale warning 'M' 1000; rodar
  P -q -c "UPDATE public._dh_control SET status=NULL WHERE source='vendas_pedidos';" >/dev/null
  rodar; R=$(alertas vendas_pedidos)
  P -q -c "UPDATE public._dh_control SET status='ok' WHERE source='vendas_pedidos';" >/dev/null
  [ "$R" = "1" ] && return 0 || return 1; }
cen_antiflap() { reset_tudo
  for _ in $(seq 1 6); do
    set_check estoque_reposicao stale warning 'Estoque: marcador parado' 200000; rodar
    set_check estoque_reposicao ok info 'Estoque: ok'; rodar
  done
  [ "$(emails estoque_reposicao)" = "1" ] && return 0 || return 1; }
cen_claim() { reset_tudo; set_check vendas_cadastros broken critical 'M' 1000
  P -q -c "ALTER DATABASE prove SET test.outbox_falha = 'silencioso';" >/dev/null; rodar
  R=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_vendas_cadastros' AND email_enfileirado_em IS NOT NULL;")
  P -q -c "ALTER DATABASE prove RESET test.outbox_falha;" >/dev/null
  [ "$R" = "0" ] && return 0 || return 1; }

# Baseline explicito: os 6 cenarios estao VERDES com a migration INTACTA (senao o vermelho
# da sabotagem nao prova nada -- pode ser o comando quebrado, nao o bug).
BASE_VERDE=0
for c in cen_lembrete cen_escalada cen_material cen_antispam cen_nulo cen_claim cen_antiflap; do
  if $c; then BASE_VERDE=$((BASE_VERDE+1)); else echo "  [XX] baseline de $c JA vermelho -- falsificacao invalida"; fi
done
eq "F0 baseline: 7 cenarios verdes com a migration intacta" "$BASE_VERDE" "7"

# Extrai UMA funcao da migration, aplica a versao sabotada e PROVA que a sabotagem entrou.
# Sem esta prova, um padrao que nao casa deixa o codigo INTACTO, o cenario fica verde e o log
# se le como "o assert nao tem dente" -- convidando a enfraquecer justamente o assert bom.
sabota() { # nome  funcao  marcador_ascii  <sql-na-entrada-padrao>
  local nome="$1" func="$2" marca="$3" sql; sql="$(cat)"
  P -q -c "$sql" >/dev/null 2>&1 || true
  local vivo; vivo=$(Pq -c "SELECT CASE WHEN pg_get_functiondef('$func'::regprocedure) LIKE '%$marca%' THEN 'SIM' ELSE 'NAO' END;")
  if [ "$vivo" != "SIM" ]; then
    FALSIF_BAD=$((FALSIF_BAD+1)); bad "$nome -- SABOTAGEM NAO APLICOU (padrao nao casou); vermelho seria invalido"
    return 1
  fi
  return 0
}
EPIS='public._data_health_episodio(text,text,text,text,text,text,text,jsonb,text)'
WD='public.data_health_watchdog()'

# --- F1: remove o predicado TEMPORAL (lembrete) ---
if sabota "F1 predicado temporal" "$EPIS" "v_lembrete := false;" < <(perl -0pe 's/v_lembrete := [^;]*;/v_lembrete := false;/s' "$MIG" | so_episodio); then
  if cen_lembrete; then verdicto "F1 predicado temporal" 0; else verdicto "F1 predicado temporal" 1; fi
fi
restaurar

# --- F2: remove o predicado de ESCALADA ---
if sabota "F2 predicado de escalada" "$EPIS" "v_escalou := false;" < <(perl -0pe 's/v_escalou := [^;]*;/v_escalou := false;/s' "$MIG" | so_episodio); then
  if cen_escalada; then verdicto "F2 predicado de escalada" 0; else verdicto "F2 predicado de escalada" 1; fi
fi
restaurar

# --- F3: remove a MATERIALIDADE (fingerprint) ---
if sabota "F3 fingerprint/materialidade" "$EPIS" "v_material := false;" < <(perl -0pe 's/v_material := [^;]*;/v_material := false;/s' "$MIG" | so_episodio); then
  if cen_material; then verdicto "F3 fingerprint/materialidade" 0; else verdicto "F3 fingerprint/materialidade" 1; fi
fi
restaurar

# --- F4: remove o GATE anti-spam (tudo notifica) ---
if sabota "F4 gate anti-spam" "$EPIS" "SABOTADO-ANTISPAM" < <(perl -0pe 's/v_deve := v_escalou[^;]*;/v_deve := true; -- SABOTADO-ANTISPAM/s' "$MIG" | so_episodio); then
  if cen_antispam; then verdicto "F4 gate anti-spam" 0; else verdicto "F4 gate anti-spam" 1; fi
fi
restaurar

# --- F5: RESTAURA a falha ABERTA historica (status NULL cai no ramo que RESOLVE) ---
# Nao basta remover a validacao: a ordem do ramo aqui ja e' NULL-safe por construcao
# (IF status = 'ok' THEN resolve ELSE alerta -- NULL cai no ELSE, que alerta). O bug de prod
# era o ramo INVERTIDO (IF status <> 'ok' THEN alerta ELSE resolve), onde NULL <> 'ok' e' NULL
# e portanto cai no ELSE que DISPENSA o alerta. A sabotagem reproduz exatamente essa forma --
# e so' entao a validacao explicita e' a unica coisa entre o vigia e a falha aberta.
if sabota "F5 validacao de status NULL" "$WD" "IS NOT TRUE THEN" < <(
     perl -0pe "s/IF r\.status IS NULL OR r\.status NOT IN \('ok','stale','broken','unknown'\) THEN/IF false THEN/s" "$MIG" \
   | perl -0pe "s/IF r\.status = 'ok' THEN/IF (r.status <> 'ok') IS NOT TRUE THEN/s" | so_watchdog); then
  if cen_nulo; then verdicto "F5 validacao de status NULL" 0; else verdicto "F5 validacao de status NULL" 1; fi
fi
restaurar

# --- F6: quebra a ATOMICIDADE do claim (carimba fora da transacao do outbox) ---
# O outbox fica em modo SILENCIOSO (INSERT com sucesso e zero linhas) e a sabotagem remove o
# GET DIAGNOSTICS que existe justamente para pegar isso -- a "escrita que falha calada".
if sabota "F6 atomicidade do claim" "$EPIS" "SABOTADO-ROWCOUNT" < <(perl -0pe "s/GET DIAGNOSTICS v_upd = ROW_COUNT;\s*\n\s*IF v_upd <> 1 THEN.*?END IF;/-- SABOTADO-ROWCOUNT/gs" "$MIG" | so_episodio); then
  if cen_claim; then verdicto "F6 atomicidade do claim" 0; else verdicto "F6 atomicidade do claim" 1; fi
fi
restaurar

# --- F7: remove o GUARD de drift => a migration passa a aplicar sobre corpo alheio ---
MIG_SEM_GUARD="$(mktemp /tmp/mig-sem-guard.XXXXXX.sql)"
perl -0pe 's/DO \$guard\$.*?\$guard\$;//s' "$MIG" > "$MIG_SEM_GUARD"
P -q -c "CREATE OR REPLACE FUNCTION public.data_health_watchdog() RETURNS void LANGUAGE plpgsql AS \$f\$ BEGIN RAISE NOTICE 'corpo alheio'; END \$f\$;" >/dev/null
# shellcheck disable=SC2016  # literal: e' a TAG do dollar-quote que a sabotagem tem de remover.
if command grep -qF '$guard$' "$MIG_SEM_GUARD"; then
  FALSIF_BAD=$((FALSIF_BAD+1)); bad "F7 guard de drift -- SABOTAGEM NAO APLICOU (o bloco do guard sobreviveu)"
elif P -q -f "$MIG_SEM_GUARD" >/dev/null 2>&1; then verdicto "F7 guard de drift" 1
else verdicto "F7 guard de drift" 0; fi
rm -f "$MIG_SEM_GUARD"
P -q -f "$BASE" >/dev/null
restaurar

# --- F8: remove o ANTI-FLAP (episodio novo volta a emitir sempre) ---
# A sabotagem restaura literalmente o desenho anterior a esta descoberta: "abriu episodio,
# manda e-mail". E' o furo espelho -- e sem este assert ele passaria despercebido, porque
# TODOS os outros cenarios continuam verdes com ele.
if sabota "F8 anti-flap por tipo" "$EPIS" "v_deve := true; -- SABOTADO" < <(perl -0pe 's/v_deve := v_ult_email IS NULL[^;]*;/v_deve := true; -- SABOTADO/s' "$MIG" | so_episodio); then
  if cen_antiflap; then verdicto "F8 anti-flap por tipo" 0; else verdicto "F8 anti-flap por tipo" 1; fi
fi
restaurar

# --- F9: remove o REARME NA RECUPERACAO ---
cen_rearme() { reset_tudo; set_check reposicao_disparo broken warning 'M3' 700000; rodar
  set_check reposicao_disparo stale warning 'M1' 176400; rodar
  P -q -c "UPDATE public.fin_alertas SET acknowledged_at = now() WHERE tipo='data_health_reposicao_disparo' AND dismissed_at IS NULL;" >/dev/null
  set_check reposicao_disparo broken warning 'M3' 700000; rodar
  [ "$(emails reposicao_disparo)" = "2" ] && return 0 || return 1; }
if sabota "F9 rearme na recuperacao" "$EPIS" "SABOTADO-REARME" < <(perl -0pe 's/IF v_grav_email IS NOT NULL AND v_grav < v_grav_email THEN\s*\n\s*v_grav_email := v_grav;\s*\n\s*END IF;/-- SABOTADO-REARME/s' "$MIG" | so_episodio); then
  if cen_rearme; then verdicto "F9 rearme na recuperacao" 0; else verdicto "F9 rearme na recuperacao" 1; fi
fi
restaurar

# --- F10: remove o COOLDOWN da materialidade ---
cen_cooldown() { reset_tudo; set_check custos_produtos stale warning 'vA' 5000; rodar
  for _ in 1 2 3; do
    set_check custos_produtos stale warning 'vB' 5000; rodar; rodar
    set_check custos_produtos stale warning 'vA' 5000; rodar; rodar
  done
  [ "$(emails custos_produtos)" = "1" ] && return 0 || return 1; }
if sabota "F10 cooldown da materialidade" "$EPIS" "SABOTADO-COOLDOWN" < <(perl -0pe 's/AND \(v_ult_email IS NULL OR clock_timestamp\(\) >= v_ult_email \+ v_min_material\);/AND true; -- SABOTADO-COOLDOWN/s' "$MIG" | so_episodio); then
  if cen_cooldown; then verdicto "F10 cooldown da materialidade" 0; else verdicto "F10 cooldown da materialidade" 1; fi
fi
restaurar

eq "F11 as 10 sabotagens ficaram VERMELHAS" "$FALSIF_OK" "10"
eq "F12 nenhuma sabotagem passou verde"   "$FALSIF_BAD" "0"

# Re-roda um cenario apos a restauracao final: prova que o restore devolveu a versao boa
# (uma falsificacao que deixa a sabotagem no banco envenenaria qualquer leitura posterior).
if cen_antispam; then ok "F13 restauracao final devolveu a versao verdadeira"; else bad "F13 apos restaurar, o gate anti-spam segue quebrado"; fi

echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail  (falsificacao: $FALSIF_OK com dente / $FALSIF_BAD sem dente)"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
