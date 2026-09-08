#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — Cenário B do TOCTOU de reposição: a pendência de disparo veta o cancelamento     ║
# ║  Migration: 20260906190615_reposicao_claim_disparo_cenario_b.sql                          ║
# ║                                                                                            ║
# ║      bash db/test-claim-disparo-cenario-b.sh > /tmp/t.log 2>&1; echo $?                    ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)   2º locale: HARNESS_LC=pt_BR.UTF-8 bash …         ║
# ║                                                                                            ║
# ║  O que cada grupo prova, e por que nenhum vale sozinho:                                    ║
# ║   P  claim        — allowlist de status, idempotência, motivo honesto                      ║
# ║   C  cancelamento — recusa com pendência aberta, e sobre disparado/disparado_simulado      ║
# ║   S  SEQUÊNCIA    — a edge modelada como ela é: round-trips SEPARADOS com o Omie no meio.  ║
# ║                     S1 é o BASELINE VERMELHO (edge velha ⇒ o cancelamento é sobrescrito).  ║
# ║   R  CORRIDA      — 2 conexões, bloqueio OBSERVADO (pg_blocking_pids), nos dois sentidos.  ║
# ║   D  DOIS RUNS    — a falha de um NÃO pode limpar a pendência do outro.                    ║
# ║   A  ACL          — 42501 com re-raise, e o eixo falsificado (senão mede tabela, não EXEC) ║
# ║   F  falsificação — sabota UMA camada por vez e exige o vermelho certo                     ║
# ║   Z  restore      — o canário: depois de todas as sabotagens, o corpo real ainda está lá   ║
# ║                                                                                            ║
# ║  A TESTEMUNHA DO OMIE mora em `omie_testemunha`, escrita em transação PRÓPRIA: ela tem de  ║
# ║  sobreviver ao rollback/à recusa da gravação local, senão "o PO existe" seria uma          ║
# ║  afirmação sobre a mesma transação que se quer testar (achado do parecer Codex).           ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5477}"
SLUG="claim-disparo"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferencia
# POSITIVA de que a major e a esperada. Fail-closed: PG ausente e ERRO, nunca skip.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"


cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
# TimeZone fixo: `timestamptz::text` renderiza no fuso da SESSAO -- sem isto as mensagens de
# recusa mudariam de forma conforme o fuso do host e os asserts abaixo seriam frageis.
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET TimeZone='UTC';"
# ── DOIS LOCALES (licao #1483: falsificar num ambiente so nao prova a asrercao) ────────
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
-- Pre-requisitos da CADEIA pos-disparo (copiados da PROD em 2026-09-07): o enum de papel e o
-- `has_role` que a PORTA de conciliacao consulta. Stub por GUC, no mesmo idioma de auth.uid().
CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE AS $f$
  SELECT coalesce(nullif(current_setting('test.approle', true), ''), '') = _role::text
$f$;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

AMOSTRA_MSG=$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -c "SELECT 1/0;" 2>&1 | head -1) || true
echo "=== setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ==="
echo "=== controle do eixo de locale, mensagem do servidor: $AMOSTRA_MSG"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (só o que as funções leem/escrevem; tipos copiados da PROD via
#          information_schema em 2026-09-06. `disparo_claim_*` NÃO entram aqui de propósito:
#          quem as cria é o ALTER TABLE da migration, que assim também fica sob teste.)
# ══════════════════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.pedido_compra_sugerido (
  id                         bigserial PRIMARY KEY,
  empresa                    text NOT NULL,
  status                     text NOT NULL DEFAULT 'pendente_aprovacao',
  status_envio_portal        text DEFAULT 'nao_aplicavel',
  portal_proximo_retry_em    timestamptz,
  cancelado_por              text,
  cancelado_em               timestamptz,
  justificativa_cancelamento text,
  horario_disparo_real       timestamptz,
  omie_pedido_compra_id      text,
  atualizado_em              timestamptz DEFAULT now(),
  -- Carimbos de evidencia que a PORTA (GUC) exige, iguais aos do trigger irmao.
  cancelamento_pos_disparo_motivo    text,
  cancelamento_pos_disparo_evidencia text,
  cancelamento_pos_disparo_por       text,
  cancelamento_pos_disparo_em        timestamptz,
  -- Lidas pela VIEW de auditoria da cadeia pos-disparo (`vw_cancelamento_pos_disparo_sem_evidencia`).
  fornecedor_nome                    text,
  valor_total                        numeric
);

-- A testemunha do efeito EXTERNO. Escrita em transacao propria (cada `psql -c` e a sua), de modo
-- que ela sobrevive a recusa/rollback da gravacao no pedido. Sem isso, "o PO existe no Omie" seria
-- afirmado pela mesma transacao que o teste quer avaliar.
CREATE TABLE public.omie_testemunha (
  pedido_id bigint PRIMARY KEY,
  po        text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
SQL

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — AS MIGRATIONS REAIS (Lei #1)
#   MIG_A = o estado ATUAL da prod (Cenario A fechado, Cenario B aberto)  → BASELINE de B
#   MIG   = esta entrega
# ⚠️ O baseline NAO e o corpo pre-Cenario-A: isso misturaria dois defeitos. O que se quer medir
#    e o que o sistema de HOJE faz, com A ja corrigido (achado do parecer Codex).
# ══════════════════════════════════════════════════════════════════════════════════════════
MIG_A="$REPO_ROOT/supabase/migrations/20260905224959_cancelar_pedido_guard_atomico.sql"
# A CADEIA que a prod ja serve entre A e esta entrega. Sem ela o teste provaria contra um corpo de
# `cancelar_pedido_sugerido` que nao existe mais em lugar nenhum -- e a conviv~encia com o trigger
# irmao (`trg_valida_cancelamento_pos_disparo`, #2246/#2309) ficaria por SUPOSICAO.
MIG_POS1="$REPO_ROOT/supabase/migrations/20260906152235_cancelamento_pos_disparo_trigger_e_rpc.sql"
MIG_POS1B="$REPO_ROOT/supabase/migrations/20260906154202_cancelar_pedido_revoke_anon.sql"
MIG_POS2="$REPO_ROOT/supabase/migrations/20260906172718_cancelamento_pos_disparo_gate_canonico.sql"
MIG_POS3="$REPO_ROOT/supabase/migrations/20260907095841_disparado_simulado_e_estado_pos_disparo.sql"
MIG="$REPO_ROOT/supabase/migrations/20260906190615_reposicao_claim_disparo_cenario_b.sql"
POSTBLOCO="$(mktemp /tmp/postbloco-claim.XXXXXX)"
# shellcheck disable=SC2016  # `$post$` e a TAG de dollar-quote do SQL: tem de ficar literal.
sed -n '/^DO \$post\$/,/^\$post\$;/p' "$MIG" > "$POSTBLOCO"
[ -s "$POSTBLOCO" ] || { echo "INFRA: nao extrai o bloco de postcondicao do .sql"; exit 1; }

P -q -f "$MIG_A"
P -q -f "$MIG_POS1"
P -q -f "$MIG_POS1B"
P -q -f "$MIG_POS2"
P -q -f "$MIG_POS3"
P -q -f "$MIG"
echo "migrations aplicadas: $(basename "$MIG_A") + cadeia pos-disparo (4) + $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + a EDGE MODELADA
# ══════════════════════════════════════════════════════════════════════════════════════════
semear() {
  P -q <<'SQL'
TRUNCATE public.pedido_compra_sugerido RESTART IDENTITY;
TRUNCATE public.omie_testemunha;
INSERT INTO public.pedido_compra_sugerido (id, empresa, status, status_envio_portal, portal_proximo_retry_em, horario_disparo_real) VALUES
  (1, 'OBEN', 'pendente_aprovacao',          'nao_aplicavel',           NULL,                      NULL),
  (2, 'OBEN', 'aprovado_aguardando_disparo', 'pendente_envio_portal',   now() + interval '15 min', NULL),
  (3, 'OBEN', 'bloqueado_guardrail',         'nao_aplicavel',           NULL,                      NULL),
  (4, 'OBEN', 'disparado',                   'enviado_portal',          NULL,                      timestamptz '2026-09-01 10:00:00+00'),
  (5, 'OBEN', 'concluido_recebido',          'enviado_portal',          NULL,                      timestamptz '2026-08-20 09:00:00+00'),
  (6, 'OBEN', 'falha_envio',                 'nao_aplicavel',           NULL,                      NULL),
  (7, 'OBEN', 'aprovado_aguardando_disparo', 'nao_aplicavel',           NULL,                      NULL),
  (8, 'OBEN', 'disparado_simulado',          'nao_aplicavel',           NULL,                      timestamptz '2026-09-02 11:00:00+00'),
  (9, 'OBEN', 'cancelado_humano',            'nao_aplicavel',           NULL,                      NULL);
SQL
}
cancelar() { Pq -c "SELECT public.cancelar_pedido_sugerido($1, 'lucas', 'motivo do teste')::text;"; }
# O veto agora e um TRIGGER: ele ABORTA a instrucao em vez de a RPC devolver {"error": …}. Este
# helper normaliza os dois desfechos -- ou o jsonb da RPC, ou `EXC:[SENTINELA]`. As sentinelas sao
# ASCII de caixa fixa, entao o assert nao depende do locale das mensagens do servidor.
cancelar_x() {
  local out rc
  out="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -tA \
        -c "SELECT public.cancelar_pedido_sugerido($1, 'lucas', 'motivo do teste')::text;" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then printf '%s\n' "$out" | tail -1
  else printf 'EXC:%s\n' "$(printf '%s' "$out" | grep -o '\[[A-Z][A-Z-]*\]' | head -1)"; fi
}
# Veredito ASCII de caixa fixa: le a CHAVE do jsonb (`? 'error'`), nunca o texto da mensagem --
# que tem acento, travessao e muda de idioma com lc_messages.
cancelar_veredito() {
  Pq -c "SELECT CASE WHEN public.cancelar_pedido_sugerido($1,'lucas','motivo do teste') ? 'error' THEN 'RECUSADO' ELSE 'PASSOU' END;"
}
porta_veredito() {
  local out rc
  out="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -tA \
        -c "SET test.role='service_role'; SELECT CASE WHEN public.corrigir_cancelamento_pos_disparo($1,'lucas','cancelado_junto_ao_fornecedor','PO cancelado no Omie em 2026-09-07, protocolo 4711') ? 'error' THEN 'RECUSADO' ELSE 'PASSOU' END;" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then printf '%s\n' "$out" | tail -1
  else printf 'EXC:%s\n' "$(printf '%s' "$out" | grep -o '\[[A-Z][A-Z-]*\]' | head -1)"; fi
}
claim()    { Pq -c "SELECT public.reposicao_claim_disparo($1, '${2:-producao@run-1}')::text;"; }
campo()    { Pq -c "SELECT COALESCE($2::text,'<null>') FROM public.pedido_compra_sugerido WHERE id=$1;"; }
pos_omie() { Pq -c "SELECT count(*) FROM public.omie_testemunha WHERE pedido_id=$1;"; }

# ── A EDGE, modelada como ela realmente e: cada passo e um round-trip/transacao SEPARADA ──
edge_seleciona()  { Pq -c "SELECT count(*) FROM public.pedido_compra_sugerido WHERE id=$1 AND status IN ('aprovado_aguardando_disparo','falha_envio');"; }
omie_incluir()    { Pq -c "INSERT INTO public.omie_testemunha (pedido_id, po) VALUES ($1, 'PO-REAL-$1') ON CONFLICT (pedido_id) DO NOTHING;" >/dev/null; }
# Gravacao final ANTIGA: incondicional, sem claim. E o que a edge faz hoje.
edge_grava_velha() { Pq -c "UPDATE public.pedido_compra_sugerido SET status='disparado', omie_pedido_compra_id='PO-REAL-$1', horario_disparo_real=timestamptz '2026-09-06 12:00:00+00', atualizado_em=now() WHERE id=$1;" >/dev/null; }
# Gravacao final NOVA: incondicional nos identificadores (o PO existe -- fato consumado) e LIMPANDO
# a pendencia, porque so aqui a compra passa a estar registrada.
edge_grava_nova()  { Pq -c "UPDATE public.pedido_compra_sugerido SET status='disparado', omie_pedido_compra_id='PO-REAL-$1', horario_disparo_real=timestamptz '2026-09-06 12:00:00+00', disparo_claim_em=NULL, disparo_claim_por=NULL, atualizado_em=now() WHERE id=$1;" >/dev/null; }
# Desfecho de FALHA da edge nova: allowlist de status e NAO limpa a pendencia.
edge_grava_falha() { Pq -c "UPDATE public.pedido_compra_sugerido SET status='falha_envio', atualizado_em=now() WHERE id=$1 AND status IN ('aprovado_aguardando_disparo','falha_envio');" >/dev/null; }

semear

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════════════════
echo "-- grupo P: o claim (allowlist, idempotencia, motivo honesto) --"
ATU_ANTES="$(campo 2 atualizado_em)"
eq "P1 claim em aprovado_aguardando_disparo reivindica" \
   "$(Pq -c "SELECT (public.reposicao_claim_disparo(2,'producao@r1') ->> 'claimed');")" "true"
eq "P1b a pendencia ficou na linha"       "$(Pq -c "SELECT (disparo_claim_em IS NOT NULL)::text FROM public.pedido_compra_sugerido WHERE id=2;")" "true"
eq "P1c com o autor do run"               "$(campo 2 disparo_claim_por)" "producao@r1"
eq "P1d e o status NAO mudou (o claim nao entra no vocabulario de status)" "$(campo 2 status)" "aprovado_aguardando_disparo"
eq "P1e e atualizado_em NAO foi tocado pelo claim (relogio de staleness alheio)" \
   "$(campo 2 atualizado_em)" "$ATU_ANTES"

eq "P2 claim em falha_envio reivindica (o re-disparo continua possivel)" \
   "$(Pq -c "SELECT (public.reposicao_claim_disparo(6,'producao@r1') ->> 'claimed');")" "true"
eq "P3 claim em pendente_aprovacao NAO reivindica (allowlist)" \
   "$(Pq -c "SELECT (public.reposicao_claim_disparo(1,'producao@r1') ->> 'claimed');")" "false"
eq "P3b e a linha nao foi tocada"          "$(campo 1 disparo_claim_em)" "<null>"
eq "P4 claim em cancelado_humano NAO reivindica -- ESTE e o Cenario B fechado na origem" \
   "$(Pq -c "SELECT (public.reposicao_claim_disparo(9,'producao@r1') ->> 'claimed');")" "false"
eq "P4b com o motivo dizendo o status real" \
   "$(Pq -c "SELECT (public.reposicao_claim_disparo(9,'producao@r1') ->> 'motivo');")" \
   "pedido não está mais disparável (status atual: cancelado_humano)"
eq "P5 claim em id inexistente NAO reivindica, e diz que nao achou" \
   "$(Pq -c "SELECT (public.reposicao_claim_disparo(NULL::bigint,'producao@r1') ->> 'motivo');")" "pedido não encontrado"

# P6 IDEMPOTENCIA: a pendencia guarda o INICIO. Sobrescrever faria uma pendencia de ontem parecer
# eternamente "de agora" -- e a idade e a unica coisa que diz a quem investiga que ela esta presa.
semear
P -q -c "UPDATE public.pedido_compra_sugerido SET disparo_claim_em = timestamptz '2026-09-05 08:00:00+00', disparo_claim_por='producao@run-ontem' WHERE id=2;" >/dev/null
eq "P6 2o claim sobre pendencia aberta AINDA reivindica (retomada possivel)" \
   "$(Pq -c "SELECT (public.reposicao_claim_disparo(2,'producao@run-hoje') ->> 'claimed');")" "true"
eq "P6b e PRESERVA o instante da pendencia original" "$(campo 2 disparo_claim_em)" "2026-09-05 08:00:00+00"
eq "P6c e preserva quem a abriu"                     "$(campo 2 disparo_claim_por)" "producao@run-ontem"
# ISO-8601 e nao o `::text` do psql: dentro do jsonb o timestamptz sai no formato que a edge de
# fato recebe -- e e esse que o `Date.parse` do `reivindicarDisparo` consome para medir a idade.
eq "P6d o claim devolve a idade REAL da pendencia, nao 'agora' (ISO-8601, como a edge le)" \
   "$(Pq -c "SELECT (public.reposicao_claim_disparo(2,'x') ->> 'desde');")" "2026-09-05T08:00:00+00:00"

echo "-- grupo C: o cancelamento respeita a pendencia --"
semear
eq "C1 sem pendencia, cancelar segue funcionando"  "$(cancelar 2)" '{"status": "ok", "pedido_id": 2}'
eq "C1b e a higiene do portal foi aplicada"        "$(campo 2 status_envio_portal)" "nao_aplicavel"

semear
P -q -c "SELECT public.reposicao_claim_disparo(2,'producao@r1');" >/dev/null
eq "C2 COM pendencia aberta, cancelar ABORTA pelo trigger (em QUALQUER via de escrita)" \
   "$(cancelar_x 2)" "EXC:[CANCEL-COM-DISPARO-PENDENTE]"
eq "C2b a linha NAO foi carimbada como cancelada"  "$(campo 2 status)" "aprovado_aguardando_disparo"
eq "C2c nem ganhou cancelado_em"                   "$(campo 2 cancelado_em)" "<null>"
eq "C2d nem sofreu a higiene do portal (o retry agendado continua de pe)" \
   "$(campo 2 status_envio_portal)" "pendente_envio_portal"

# `disparado_simulado` era PENDENCIA DECLARADA desta entrega; o #2309 a fechou (o dry_run cria PO
# REAL no Omie, logo o estado e POS-disparo). Com a cadeia real aplicada, o assert vira o oposto --
# e continua sendo o mesmo sensor: se alguem reabrir o buraco, esta linha fica vermelha.
eq "C3 disparado_simulado NAO e mais cancelavel pela via normal (fechado no #2309)" \
   "$(cancelar_veredito 8)" "RECUSADO"

# ── CONVIVENCIA com a cadeia pos-disparo (#2246/#2309): dois triggers BEFORE na MESMA tabela ──
# O meu (`trg_veta_...`) roda por ULTIMO (ordem alfabetica). O eixo aqui nao e o meu guard: e provar
# que eu nao fechei a PORTA de conciliacao do vizinho no caminho em que ela deve passar.
eq "C3b a PORTA de conciliacao do #2309 continua passando quando NAO ha disparo pendente" \
   "$(porta_veredito 8)" "PASSOU"
eq "C3c e o pedido de fato ficou cancelado por ela"  "$(campo 8 status)" "cancelado_humano"

semear
P -q -c "UPDATE public.pedido_compra_sugerido SET disparo_claim_em=NOW(), disparo_claim_por='edge@r9' WHERE id=8;" >/dev/null
eq "C3d mas com disparo PENDENTE a porta tambem e vetada -- conciliar nao prova que a execucao em voo nao vai comprar" \
   "$(porta_veredito 8)" "EXC:[CANCEL-COM-DISPARO-PENDENTE]"
eq "C3e e a linha seguiu intacta"                    "$(campo 8 status)" "disparado_simulado"

# C8 e o assert que o 2o parecer Codex exigiu: a GUC de correcao pos-disparo NAO libera pendencia de
# disparo. Conciliar nao prova que uma execucao em voo nao vai comprar depois.
semear
P -q -c "SELECT public.reposicao_claim_disparo(2,'producao@r1');" >/dev/null
C8="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -tA 2>&1 <<'SQL'
BEGIN;
SELECT set_config('app.correcao_cancelamento_pos_disparo', '2', true);
UPDATE public.pedido_compra_sugerido
   SET status='cancelado_humano',
       cancelamento_pos_disparo_motivo='po_excluido_no_omie',
       cancelamento_pos_disparo_evidencia='PO 12345 excluido',
       cancelamento_pos_disparo_por='lucas',
       cancelamento_pos_disparo_em=now()
 WHERE id=2;
COMMIT;
SQL
)" || true
if printf '%s' "$C8" | grep -q 'CANCEL-COM-DISPARO-PENDENTE'; then
  ok "C8 a porta de correcao pos-disparo NAO libera pendencia de disparo (o veto nao tem porta)"
else
  bad "C8 a porta liberou um cancelamento com disparo pendente: $(printf '%s' "$C8" | head -c 200)"
fi
semear

eq "C4 cancelar disparado continua RECUSADO (nao-regressao do #2204)" \
   "$(cancelar 4)" '{"error": "pedido já foi disparado em 2026-09-01 10:00:00+00"}'
eq "C5 cancelar concluido_recebido continua RECUSADO" \
   "$(cancelar 5)" '{"error": "pedido já foi disparado em 2026-08-20 09:00:00+00"}'

echo "-- grupo S: a SEQUENCIA da edge (round-trips separados, Omie no meio) --"
# S1 BASELINE VERMELHO: a edge de HOJE. Seleciona, o cancelamento commita, e a gravacao final
# incondicional passa por cima. Sem este vermelho, o verde de S2 poderia significar so que a
# ordem testada nunca aconteceu.
semear
eq "S1-pre a edge velha selecionou a linha"        "$(edge_seleciona 2)" "1"
eq "S1-pre2 e o cancelamento foi aceito"           "$(cancelar 2)" '{"status": "ok", "pedido_id": 2}'
omie_incluir 2
edge_grava_velha 2
eq "S1 BASELINE: a edge velha GRAVA POR CIMA do cancelamento" "$(campo 2 status)" "disparado"
eq "S1b e o operador tinha visto 'rejeitado' -- o carimbo de cancelamento continua na linha" \
   "$(Pq -c "SELECT (cancelado_em IS NOT NULL)::text FROM public.pedido_compra_sugerido WHERE id=2;")" "true"
eq "S1c com uma compra REAL do outro lado"         "$(pos_omie 2)" "1"

# S2 COM O FIX: mesma ordem. O claim reverifica o status DENTRO do UPDATE e recusa, e a edge nao
# chega a chamar o Omie. O assert que carrega o peso e o ZERO da testemunha.
semear
eq "S2-pre a edge nova selecionou a linha"         "$(edge_seleciona 2)" "1"
eq "S2-pre2 e o cancelamento foi aceito"           "$(cancelar 2)" '{"status": "ok", "pedido_id": 2}'
S2_CLAIM="$(Pq -c "SELECT (public.reposicao_claim_disparo(2,'producao@r1') ->> 'claimed');")"
eq "S2 FIX: o claim RECUSA depois do cancelamento" "$S2_CLAIM" "false"
if [ "$S2_CLAIM" = "false" ]; then :; else omie_incluir 2; edge_grava_nova 2; fi
eq "S2b FIX: ZERO chamadas ao Omie -- nenhuma compra foi criada" "$(pos_omie 2)" "0"
eq "S2c FIX: o cancelamento do operador permanece"  "$(campo 2 status)" "cancelado_humano"

# S3 ordem inversa: o claim vence. O cancelamento e recusado e a edge conclui em paz.
semear
eq "S3-pre o claim veio primeiro" "$(Pq -c "SELECT (public.reposicao_claim_disparo(2,'producao@r1') ->> 'claimed');")" "true"
eq "S3 o cancelamento e recusado enquanto a compra esta em voo" \
   "$(cancelar_x 2)" "EXC:[CANCEL-COM-DISPARO-PENDENTE]"
omie_incluir 2
edge_grava_nova 2
eq "S3b a edge fecha o desfecho como disparado"     "$(campo 2 status)" "disparado"
eq "S3c e a pendencia foi encerrada junto"          "$(campo 2 disparo_claim_em)" "<null>"
eq "S3d dai em diante quem veta o cancelamento e o STATUS" \
   "$(cancelar 2)" '{"error": "pedido já foi disparado em 2026-09-06 12:00:00+00"}'

echo "-- grupo D: dois runs -- a falha de um nao pode liberar o outro --"
# O contraexemplo que derrubou o primeiro desenho: com o `catch` limpando a pendencia, o run B
# (que falhou) liberaria a linha enquanto o run A ainda pode comprar.
semear
eq "D1 run A reivindica"  "$(Pq -c "SELECT (public.reposicao_claim_disparo(2,'producao@runA') ->> 'claimed');")" "true"
eq "D1b run B tambem reivindica (idempotente)" "$(Pq -c "SELECT (public.reposicao_claim_disparo(2,'producao@runB') ->> 'claimed');")" "true"
edge_grava_falha 2
eq "D1c o desfecho de FALHA de B NAO limpou a pendencia" \
   "$(Pq -c "SELECT (disparo_claim_em IS NOT NULL)::text FROM public.pedido_compra_sugerido WHERE id=2;")" "true"
eq "D1d e o cancelamento continua RECUSADO -- o run A ainda pode comprar" \
   "$(cancelar_x 2)" "EXC:[CANCEL-COM-DISPARO-PENDENTE]"
omie_incluir 2
edge_grava_nova 2
eq "D1e quando A conclui, a pendencia se encerra" "$(campo 2 disparo_claim_em)" "<null>"
eq "D1f e existe EXATAMENTE um PO"                "$(pos_omie 2)" "1"

# D2: falha ANTES de qualquer claim nao pode sobrescrever um cancelamento (allowlist do catch).
semear
eq "D2-pre cancelamento aceito antes de qualquer claim" "$(cancelar 7)" '{"status": "ok", "pedido_id": 7}'
edge_grava_falha 7
eq "D2 a escrita de falha_envio NAO sobrescreve o cancelamento (allowlist de status)" \
   "$(campo 7 status)" "cancelado_humano"

echo "-- grupo R: corrida real (2 conexoes, barreira observada) --"
P -q -c "CREATE TABLE IF NOT EXISTS public.barreira (nome text PRIMARY KEY);" >/dev/null

# A trava a linha COM O CLAIM (dentro de um DO que exige FOUND) e sinaliza com advisory lock.
lancar_bloqueador() {   # $1 = id que A reivindica
  P -q >/dev/null <<SQL &
BEGIN;
DO \$u\$
DECLARE v jsonb;
BEGIN
  v := public.reposicao_claim_disparo($1, 'producao@A');
  IF v IS NULL OR (v ->> 'claimed') <> 'true' THEN
    RAISE EXCEPTION 'BLOQUEADOR: o claim nao pegou a linha % (%) -- a corrida nao mediria nada', $1, v;
  END IF;
  PERFORM pg_advisory_xact_lock(918273646);
END
\$u\$;
DO \$w\$
BEGIN
  FOR i IN 1..2000 LOOP
    PERFORM pg_sleep(0.05);
    IF EXISTS (SELECT 1 FROM public.barreira WHERE nome = 'liberar') THEN RETURN; END IF;
  END LOOP;
  RAISE EXCEPTION 'BARREIRA: o orquestrador nunca liberou o bloqueador';
END
\$w\$;
COMMIT;
SQL
  BLOQ_PID=$!
}

esperar_A_travar() {
  local n
  for _ in $(seq 1 300); do
    n=$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted AND pid <> pg_backend_pid();" | tail -1)
    if [ "${n:-0}" -ge 1 ]; then echo "sim"; return; fi
    sleep 0.05
  done
  echo "nao"
}

esperar_bloqueio() {
  local n
  for _ in $(seq 1 "${1:-300}"); do
    n=$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND cardinality(pg_blocking_pids(pid)) > 0 AND query ILIKE '%cancelar_pedido_sugerido%';" | tail -1)
    if [ "${n:-0}" -ge 1 ]; then echo "sim"; return; fi
    sleep 0.05
  done
  echo "nao"
}

liberar_A() { P -q -c "INSERT INTO public.barreira VALUES ('liberar') ON CONFLICT DO NOTHING;" >/dev/null; }

corrida() {   # $1 = id; ecoa "<retorno da RPC>|<status final>|<bloqueio observado>"
  local id="$1" out bpid visto
  out="$(mktemp /tmp/corrida-claim.XXXXXX)"
  P -q -c "DELETE FROM public.barreira;" >/dev/null
  lancar_bloqueador "$id"
  if [ "$(esperar_A_travar)" != "sim" ]; then
    liberar_A; wait "$BLOQ_PID" || true; rm -f "$out"
    echo "A-NAO-TRAVOU|A-NAO-TRAVOU|A-NAO-TRAVOU"; return
  fi
  Pq -c "SELECT public.cancelar_pedido_sugerido($id, 'lucas', 'cancelei durante o disparo')::text;" > "$out" 2>&1 &
  bpid=$!
  visto="$(esperar_bloqueio)"
  liberar_A
  wait "$bpid" || true
  if ! wait "$BLOQ_PID"; then rm -f "$out"; echo "BLOQUEADOR-FALHOU|BLOQUEADOR-FALHOU|BLOQUEADOR-FALHOU"; return; fi
  # Normaliza os DOIS desfechos, como `cancelar_x`: quando o trigger aborta, a saida do psql tem
  # varias linhas (ERROR + CONTEXT) e um `tail -1` cru pegaria a linha do CONTEXT -- um assert que
  # falharia com o comportamento CERTO.
  local ret
  if grep -q '\[[A-Z][A-Z-]*\]' "$out"; then
    ret="EXC:$(grep -o '\[[A-Z][A-Z-]*\]' "$out" | head -1)"
  else
    ret="$(tail -1 "$out")"
  fi
  echo "$ret|$(campo "$id" status)|$visto"
  rm -f "$out"
}

# R1 BASELINE DO BUG: o sistema de HOJE = a RPC do Cenario A (que esta na prod) SEM o veto novo.
# Tem de PERDER: mesmo com A segurando a linha ja reivindicada, o cancelamento vence.
# ⚠️ O baseline NAO e o corpo pre-Cenario-A: misturaria dois defeitos (achado Codex).
P -q -c "DROP TRIGGER IF EXISTS trg_veta_cancelamento_com_disparo_pendente ON public.pedido_compra_sugerido;" >/dev/null
semear
R1="$(corrida 2)"
eq "R1 BASELINE: sem o veto, o cancelamento VENCE a pendencia (bug reproduzido, bloqueio observado)" \
   "$R1" '{"status": "ok", "pedido_id": 2}|cancelado_humano|sim'

# R2 COM O FIX: mesma corrida. O UPDATE da RPC espera o lock; o EvalPlanQual RE-BUSCA a linha ja
# commitada com a pendencia, e o BEFORE ROW roda sobre essa versao NOVA -- e aborta.
P -q -f "$MIG"
semear
R2="$(corrida 2)"
R2_JSON="${R2%%|*}"; R2_RESTO="${R2#*|}"
if [ "$R2_JSON" = "EXC:[CANCEL-COM-DISPARO-PENDENTE]" ] && [ "$R2_RESTO" = "aprovado_aguardando_disparo|sim" ]; then
  ok "R2 FIX: o trigger ABORTA sob bloqueio OBSERVADO (EvalPlanQual re-busca a linha) e a linha fica intacta"
else
  bad "R2 FIX: esperado veto por pendencia + linha intacta + bloqueio observado, veio [$R2]"
fi
eq "R2b FIX: nenhum carimbo de cancelamento"  "$(campo 2 cancelado_em)" "<null>"
eq "R2c FIX: a higiene do portal NAO foi aplicada" "$(campo 2 status_envio_portal)" "pendente_envio_portal"

# R3 CONTROLE INOCUO: A reivindica OUTRA linha. O cancelamento tem de terminar SEM esperar A --
# senao "recusa sempre sob concorrencia" passaria por fix.
semear
P -q -c "DELETE FROM public.barreira;" >/dev/null
lancar_bloqueador 7
eq "R3-pre A reivindicou a OUTRA linha antes de B comecar" "$(esperar_A_travar)" "sim"
OUT3="$(mktemp /tmp/corrida-r3-claim.XXXXXX)"
Pq >"$OUT3" 2>&1 <<'SQL' || true
SET statement_timeout = '2s';
SELECT public.cancelar_pedido_sugerido(2, 'lucas', 'linha diferente')::text;
SQL
R3="$(tail -1 "$OUT3")"
A_SEGURANDO=$(Pq -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM public.barreira WHERE nome='liberar') THEN 'ja_liberado' ELSE 'ainda_segurando' END;" | tail -1)
liberar_A
wait "$BLOQ_PID" || true
rm -f "$OUT3"
eq "R3 CONTROLE: cancelar OUTRA linha nao espera o disparo em voo" "$R3" '{"status": "ok", "pedido_id": 2}'
eq "R3b e A ainda segurava a linha dele quando B terminou"          "$A_SEGURANDO" "ainda_segurando"

echo "-- grupo A: ACL do claim --"
P -q <<'SQL'
GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT, UPDATE ON public.pedido_compra_sugerido TO anon;
SQL
# Captura a CONDICAO NOMEADA (insufficient_privilege = 42501) e RE-LANCA o resto: um
# `WHEN OTHERS THEN 'OK'` aprovaria qualquer erro, inclusive "funcao nao existe". As sentinelas sao
# ASCII de caixa fixa, para casar sem depender do locale das mensagens do servidor.
acl_anon() {
  P -q >/dev/null 2>"$1" <<'SQL'
SET ROLE anon;
DO $acl$
BEGIN
  PERFORM public.reposicao_claim_disparo(2, 'anon');
  RAISE EXCEPTION '[ACL-FUROU] anon executou reposicao_claim_disparo';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE '[ACL-BARROU] 42501 como esperado';
END
$acl$;
RESET ROLE;
SQL
}
ERRACL="$(mktemp /tmp/acl-claim.XXXXXX)"
if acl_anon "$ERRACL"; then
  ok "A1 anon recebe 42501 (insufficient_privilege) ao chamar o claim"
elif grep -q 'ACL-FUROU' "$ERRACL"; then
  bad "A1 anon EXECUTOU reposicao_claim_disparo -- o REVOKE nominal nao pegou"
else
  bad "A1 anon falhou por outro motivo (nao foi 42501): $(head -c 200 "$ERRACL")"
fi
# A2 FALSIFICA O EIXO: com EXECUTE concedido, a MESMA chamada tem de passar. Sem isto, A1 poderia
# estar medindo privilegio de TABELA (a funcao e SECURITY INVOKER) e ficaria verde por engano.
P -q -c "GRANT EXECUTE ON FUNCTION public.reposicao_claim_disparo(bigint, text) TO anon;" >/dev/null
if acl_anon "$ERRACL"; then
  bad "A2 anon continuou barrado mesmo com EXECUTE concedido -- A1 estava medindo privilegio de TABELA, nao EXECUTE"
elif grep -q 'ACL-FUROU' "$ERRACL"; then
  ok "A2 com EXECUTE concedido a MESMA chamada passa -- A1 mede EXECUTE, nao privilegio de tabela"
else
  bad "A2 falhou por outro motivo: $(head -c 200 "$ERRACL")"
fi
P -q -c "REVOKE ALL ON FUNCTION public.reposicao_claim_disparo(bigint, text) FROM anon;" >/dev/null
eq "A3 service_role executa o claim" \
   "$(Pq -c "SELECT has_function_privilege('service_role','public.reposicao_claim_disparo(bigint, text)','EXECUTE')::text;")" "true"
eq "A3b e o cancelamento continua SECURITY INVOKER (prosecdef=false)" \
   "$(Pq -c "SELECT prosecdef::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='cancelar_pedido_sugerido';")" "false"

echo "-- grupo F: falsificacoes (uma camada por vez, vermelho exigido) --"
# F1: tira o TRIGGER. C2 tem de virar VERDE-ERRADO (o cancelamento passa por cima da pendencia).
P -q -c "DROP TRIGGER IF EXISTS trg_veta_cancelamento_com_disparo_pendente ON public.pedido_compra_sugerido;" >/dev/null
semear
P -q -c "SELECT public.reposicao_claim_disparo(2,'producao@r1');" >/dev/null
F1="$(cancelar_x 2)"
if [ "$F1" = '{"status": "ok", "pedido_id": 2}' ]; then
  ok "F1 sem o trigger, cancelar durante o disparo PASSA -- C2 tem dente"
else
  bad "F1 sabotagem nao mudou nada (veio [$F1]) -- C2 nao esta medindo o veto"
fi

# F1b: na MESMA sabotagem (trigger fora), a PORTA de conciliacao deixa de ser vetada. Sem isto, C3d
# poderia estar verde por causa do gate do VIZINHO -- e eu estaria creditando ao meu trigger uma
# recusa que nao e minha.
semear
P -q -c "UPDATE public.pedido_compra_sugerido SET disparo_claim_em=NOW(), disparo_claim_por='edge@r9' WHERE id=8;" >/dev/null
F1B="$(porta_veredito 8)"
if [ "$F1B" = "PASSOU" ]; then
  ok "F1b sem o trigger, a porta passa mesmo com disparo pendente -- C3d mede o MEU veto"
else
  bad "F1b sabotagem nao mudou nada (veio [$F1B]) -- C3d nao esta medindo o meu trigger"
fi
# F1c: o CONTROLE da MESMA sabotagem -- os gates do vizinho seguem de pe, entao eu dropei UM trigger,
# nao a cadeia inteira. Sem este par, F1b passaria tambem num banco onde nada mais funciona.
F1C="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -tA \
      -c "SET test.role='service_role'; SELECT public.corrigir_cancelamento_pos_disparo(7,'lucas','motivo_invalido','evidencia');" 2>&1)" || true
if printf '%s' "$F1C" | grep -q 'CANCEL-POS-DISPARO-MOTIVO'; then
  ok "F1c CONTROLE: na MESMA sabotagem o gate de motivo do #2309 ainda recusa -- a sabotagem foi cirurgica"
else
  bad "F1c a sabotagem derrubou a cadeia inteira, nao so o meu trigger: $(printf '%s' "$F1C" | head -c 160)"
fi

# F2: claim SEM a allowlist de status. S2 tem de quebrar: ele reivindicaria um cancelado.
P -q -f "$MIG"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.reposicao_claim_disparo(p_pedido_id bigint, p_origem text)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE v_status text;
BEGIN
  UPDATE pedido_compra_sugerido
     SET disparo_claim_em = COALESCE(disparo_claim_em, NOW()), disparo_claim_por = p_origem
   WHERE id = p_pedido_id
  RETURNING status INTO v_status;
  RETURN jsonb_build_object('claimed', v_status IS NOT NULL, 'pedido_id', p_pedido_id);
END $$;
SQL
semear
P -q -c "SELECT public.cancelar_pedido_sugerido(2,'lucas','cancelei');" >/dev/null
F2="$(Pq -c "SELECT (public.reposicao_claim_disparo(2,'producao@r1') ->> 'claimed');")"
if [ "$F2" = "true" ]; then
  ok "F2 sem a allowlist, o claim reivindica um pedido CANCELADO -- S2 tem dente"
else
  bad "F2 sabotagem nao mudou nada (veio [$F2]) -- S2 nao mede a allowlist do claim"
fi

# F3: claim SEM o COALESCE. P6b tem de quebrar (a pendencia velha vira "de agora").
P -q -f "$MIG"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.reposicao_claim_disparo(p_pedido_id bigint, p_origem text)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE v_status text;
BEGIN
  UPDATE pedido_compra_sugerido
     SET disparo_claim_em = NOW(), disparo_claim_por = p_origem
   WHERE id = p_pedido_id AND status IN ('aprovado_aguardando_disparo','falha_envio')
  RETURNING status INTO v_status;
  RETURN jsonb_build_object('claimed', v_status IS NOT NULL, 'pedido_id', p_pedido_id);
END $$;
SQL
semear
P -q -c "UPDATE public.pedido_compra_sugerido SET disparo_claim_em = timestamptz '2026-09-05 08:00:00+00' WHERE id=2;" >/dev/null
P -q -c "SELECT public.reposicao_claim_disparo(2,'producao@run-hoje');" >/dev/null
F3="$(campo 2 disparo_claim_em)"
if [ "$F3" != "2026-09-05 08:00:00+00" ]; then
  ok "F3 sem COALESCE a pendencia de ontem vira 'de agora' -- P6b tem dente"
else
  bad "F3 sabotagem nao mudou nada (a pendencia foi preservada) -- P6b nao mede idempotencia"
fi

# F4: troca o prefixo `cancelad%` por uma LISTA fechada sem `cancelado_humano`. O veto tem de
# deixar passar -- e o que prova que o assert C2 mede o predicado de transicao, e nao "aborta sempre".
P -q -f "$MIG"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.reposicao__veta_cancelamento_com_disparo_pendente()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status <> 'cancelado' THEN RETURN NEW; END IF;   -- lista fechada: perde cancelado_humano
  IF OLD.disparo_claim_em IS NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION '[CANCEL-COM-DISPARO-PENDENTE] sabotado' USING ERRCODE='P0001';
END $$;
SQL
semear
P -q -c "SELECT public.reposicao_claim_disparo(2,'producao@r1');" >/dev/null
F4="$(cancelar_x 2)"
if [ "$F4" = '{"status": "ok", "pedido_id": 2}' ]; then
  ok "F4 com lista fechada no lugar do prefixo, cancelado_humano ESCAPA -- C2 mede a transicao"
else
  bad "F4 sabotagem nao mudou nada (veio [$F4]) -- C2 nao mede o predicado de transicao"
fi
# F4b: o CONTROLE na MESMA sabotagem -- o eixo da pendencia continua de pe para `cancelado` puro.
semear
P -q -c "SELECT public.reposicao_claim_disparo(2,'producao@r1');" >/dev/null
F4B="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -tA \
      -c "UPDATE public.pedido_compra_sugerido SET status='cancelado' WHERE id=2;" 2>&1)" || true
if printf '%s' "$F4B" | grep -q 'CANCEL-COM-DISPARO-PENDENTE'; then
  ok "F4b CONTROLE: na MESMA sabotagem o veto ainda dispara para 'cancelado' -- a sabotagem foi cirurgica"
else
  bad "F4b a sabotagem desligou o trigger inteiro, nao so o prefixo: $(printf '%s' "$F4B" | head -c 160)"
fi

# F5: a POSTCONDICAO da propria migration, nos DOIS lados.
P -q -f "$MIG"
P -q -c "DROP TRIGGER IF EXISTS trg_veta_cancelamento_com_disparo_pendente ON public.pedido_compra_sugerido;" >/dev/null
ERRLOG="$(mktemp /tmp/post-erro-claim.XXXXXX)"
if P -q -f "$POSTBLOCO" >/dev/null 2>"$ERRLOG"; then
  bad "F5a a postcondicao PASSOU com o trigger DROPADO -- ela e decorativa"
else
  if grep -q 'VETO-TRIGGER-AUSENTE' "$ERRLOG"; then
    ok "F5a a postcondicao aborta com o trigger ausente, pelo motivo CERTO"
  else
    bad "F5a a postcondicao abortou por outro motivo: $(head -c 200 "$ERRLOG")"
  fi
fi
P -q -f "$MIG"
if P -q -f "$POSTBLOCO" >/dev/null 2>"$ERRLOG"; then
  ok "F5b a postcondicao PASSA sobre o corpo certo (ela nao e sempre-vermelha)"
else
  bad "F5b a postcondicao reprovou o corpo certo: $(head -c 300 "$ERRLOG")"
fi

# F6: falsifica a propria BARREIRA. Com A reivindicando OUTRA linha, ela tem de dizer 'nao'.
semear
P -q -c "DELETE FROM public.barreira;" >/dev/null
lancar_bloqueador 7
esperar_A_travar >/dev/null
Pq -c "SELECT public.cancelar_pedido_sugerido(2,'lucas','outra linha')::text;" >/dev/null 2>&1 &
F6PID=$!
F6="$(esperar_bloqueio 20)"
liberar_A; wait "$F6PID" || true; wait "$BLOQ_PID" || true
if [ "$F6" = "nao" ]; then
  ok "F6 a barreira sabe dizer 'nao' quando nao ha bloqueio -- o '|sim' de R1/R2 e testemunho real"
else
  bad "F6 a barreira disse 'sim' sem haver bloqueio -- ela aprova qualquer corrida"
fi

echo "-- grupo Z: canario do restore --"
P -q -f "$MIG"
semear
P -q -c "SELECT public.reposicao_claim_disparo(2,'producao@r1');" >/dev/null
eq "Z1 depois de TODAS as sabotagens, o veto real esta de volta" \
   "$(cancelar_x 2)" "EXC:[CANCEL-COM-DISPARO-PENDENTE]"
semear
eq "Z1c e o claim real tambem voltou (allowlist de status)" \
   "$(Pq -c "SELECT (public.reposicao_claim_disparo(1,'x') ->> 'claimed');")" "false"
eq "Z1b e o claim real tambem voltou (allowlist)" \
   "$(Pq -c "SELECT (public.reposicao_claim_disparo(1,'x') ->> 'claimed');")" "false"

echo "=================================================="
echo "PASS=$PASS FAIL=$FAIL   (lc_messages=$HARNESS_LC)"
[ "$FAIL" -eq 0 ]
