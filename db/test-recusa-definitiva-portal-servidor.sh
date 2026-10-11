#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — recusa definitiva do portal: pré-claim recusa terminal + encerramento ║
# ║  Migration: 20261011150000_reposicao_recusa_definitiva_portal_servidor.sql     ║
# ║  Incidente: #3169 (11 dias aprovado + erro_nao_retentavel, re-disparável).     ║
# ║                                                                                ║
# ║      bash db/test-recusa-definitiva-portal-servidor.sh > /tmp/t.log 2>&1; echo $? ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                                ║
# ║   B  BASELINE  — corpo VELHO do pré-claim reabre erro_nao_retentavel (o bug).  ║
# ║   C  controles — estados que entravam no pré-claim seguem entrando.            ║
# ║   N  negativos — terminais/conciliáveis recusados E a linha não é tocada.      ║
# ║   E  encerramento — só o pedido provadamente não-efetivado, após p_dias.       ║
# ║   A  ACL       — authenticated/anon sem EXECUTE no encerramento (42501).       ║
# ║   M  migration — postcondição do próprio .sql passa (cron, ACL, execução).     ║
# ║   F  falsificação — remove UMA condição por vez; o caso que ela protege fica   ║
# ║                    vermelho. Com controle verde na MESMA invocação do laço.    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5481}"
SLUG="recusa-definitiva"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$RODADA/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = p_jobname;
  IF v_id IS NULL THEN
    SELECT COALESCE(MAX(jobid),0)+1 INTO v_id FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v_id, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v_id;
  END IF;
  RETURN v_id;
END $$;

-- Só as colunas que as duas funções leem/escrevem; tipos copiados da PROD (information_schema,
-- 2026-10-11): protocolo/omie são TEXT, portal_resposta JSONB.
CREATE TABLE public.pedido_compra_sugerido (
  id                         bigint PRIMARY KEY,
  status                     text NOT NULL,
  status_envio_portal        text DEFAULT 'nao_aplicavel',
  portal_erro                text,
  portal_resposta            jsonb,
  portal_protocolo           text,
  portal_proximo_retry_em    timestamptz,
  portal_recusa_motivo       text,
  omie_pedido_compra_id      text,
  omie_pedido_compra_numero  text,
  disparo_claim_em           timestamptz,
  cancelado_por              text,
  cancelado_em               timestamptz,
  justificativa_cancelamento text,
  aprovado_por               text,
  aprovado_em                timestamptz,
  condicao_origem            text,
  origem_evento_tipo         text,
  atualizado_em              timestamptz DEFAULT now()
);
CREATE TABLE public.pedidos_portal_tentativas (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id        bigint NOT NULL,
  iniciado_em      timestamptz NOT NULL,
  concluido_em     timestamptz,
  status_resultado text NOT NULL,
  evidence         jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE public.analytics_outbox (
  id          bigserial PRIMARY KEY,
  evento      text NOT NULL,
  distinct_id text NOT NULL,
  user_id     uuid,
  props       jsonb NOT NULL DEFAULT '{}',
  chave_dedup text NOT NULL UNIQUE,
  ocorrido_em timestamptz NOT NULL DEFAULT now()
);
GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT, UPDATE ON public.pedido_compra_sugerido TO authenticated, anon;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

MIG="$REPO_ROOT/supabase/migrations/20261011150000_reposicao_recusa_definitiva_portal_servidor.sql"
[ -s "$MIG" ] || { echo "INFRA: migration ausente: $MIG"; exit 1; }

# Corpo VELHO real do pré-claim (pg_get_functiondef da PROD em 2026-10-11 = 20260906170000).
pre_claim_velho() {
  P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.iniciar_envio_portal_pre_claim(p_pedido_id bigint)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_claimed boolean;
BEGIN
  UPDATE public.pedido_compra_sugerido
     SET status_envio_portal = 'pendente_envio_portal', portal_erro = NULL,
         portal_proximo_retry_em = now() + interval '15 minutes'
   WHERE id = p_pedido_id
     AND COALESCE(status_envio_portal, 'nao_aplicavel') <> 'enviando_portal'
     AND status IN ('aprovado_aguardando_disparo', 'disparado', 'falha_envio')
     AND portal_recusa_motivo IS NULL
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END;
$function$;
-- ACL da PROD (proacl 2026-10-11): {postgres, service_role, sandbox_exec} — sem PUBLIC/anon/authenticated.
REVOKE EXECUTE ON FUNCTION public.iniciar_envio_portal_pre_claim(bigint) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.iniciar_envio_portal_pre_claim(bigint) TO service_role;
SQL
}

# Forma exata do #3169 (efetivarAttempted=false, sem protocolo/Omie), parametrizada.
EV_FALSE='{"evidence":{"efetivarAttempted":false,"erroTipo":"GRUPO_LEADTIME_MISMATCH"}}'
semear() {
  P -q <<SQL
TRUNCATE public.pedido_compra_sugerido;
INSERT INTO public.pedido_compra_sugerido
  (id, status, status_envio_portal, portal_erro, portal_resposta, portal_protocolo, omie_pedido_compra_id, omie_pedido_compra_numero, disparo_claim_em, atualizado_em) VALUES
  -- pré-claim
  (101, 'aprovado_aguardando_disparo', 'nao_aplicavel',                    NULL, NULL, NULL, NULL, NULL, NULL, now()),
  (102, 'aprovado_aguardando_disparo', 'erro_retentavel',                  'timeout', NULL, NULL, NULL, NULL, NULL, now()),
  (103, 'aprovado_aguardando_disparo', 'falha_envio_portal',               'x', NULL, NULL, NULL, NULL, NULL, now()),
  (104, 'aprovado_aguardando_disparo', 'pendente_envio_portal',            NULL, NULL, NULL, NULL, NULL, NULL, now()),
  (111, 'aprovado_aguardando_disparo', 'erro_nao_retentavel',              'Grupo errado', '$EV_FALSE', NULL, NULL, NULL, NULL, now()),
  (112, 'aprovado_aguardando_disparo', 'aceito_portal_sem_protocolo',      NULL, NULL, NULL, NULL, NULL, NULL, now()),
  (113, 'aprovado_aguardando_disparo', 'indeterminado_requer_conciliacao', NULL, NULL, NULL, NULL, NULL, NULL, now()),
  (114, 'disparado',                   'sucesso_portal',                   NULL, NULL, NULL, NULL, NULL, NULL, now()),
  (115, 'disparado',                   'enviado_portal',                   NULL, NULL, NULL, NULL, NULL, NULL, now()),
  (116, 'aprovado_aguardando_disparo', 'enviando_portal',                  NULL, NULL, NULL, NULL, NULL, NULL, now()),
  (117, 'cancelado_humano',            'nao_aplicavel',                    NULL, NULL, NULL, NULL, NULL, NULL, now()),
  -- encerramento (atualizado_em é o relógio do prazo)
  (201, 'aprovado_aguardando_disparo', 'erro_nao_retentavel', 'Grupo errado (Prz 5 != 8)', '$EV_FALSE', NULL, NULL, NULL, NULL, now() - interval '4 days'),
  (202, 'aprovado_aguardando_disparo', 'erro_nao_retentavel', 'x', '$EV_FALSE', NULL, NULL, NULL, NULL, now() - interval '2 days'),
  (203, 'aprovado_aguardando_disparo', 'erro_nao_retentavel', 'x', '{"evidence":{"efetivarAttempted":true}}', NULL, NULL, NULL, NULL, now() - interval '4 days'),
  (204, 'aprovado_aguardando_disparo', 'erro_nao_retentavel', 'x', '{"evidence":{}}', NULL, NULL, NULL, NULL, now() - interval '4 days'),
  (205, 'aprovado_aguardando_disparo', 'erro_nao_retentavel', 'x', '$EV_FALSE', '2134225', NULL, NULL, NULL, now() - interval '4 days'),
  (206, 'aprovado_aguardando_disparo', 'erro_nao_retentavel', 'x', '$EV_FALSE', NULL, '999', NULL, NULL, now() - interval '4 days'),
  (207, 'aprovado_aguardando_disparo', 'erro_nao_retentavel', 'x', '$EV_FALSE', NULL, NULL, NULL, now() - interval '1 hour', now() - interval '4 days'),
  (208, 'falha_envio',                 'erro_nao_retentavel', 'x', '$EV_FALSE', NULL, NULL, NULL, NULL, now() - interval '4 days'),
  (209, 'aprovado_aguardando_disparo', 'erro_retentavel',     'x', '$EV_FALSE', NULL, NULL, NULL, NULL, now() - interval '4 days'),
  (210, 'aprovado_aguardando_disparo', 'erro_nao_retentavel', 'x', '$EV_FALSE', NULL, NULL, '12345', NULL, now() - interval '4 days'),
  (211, 'aprovado_aguardando_disparo', 'erro_nao_retentavel', NULL, '$EV_FALSE', '  ', NULL, NULL, NULL, now() - interval '4 days'),
  (212, 'aprovado_aguardando_disparo', 'erro_nao_retentavel', 'x', '{"evidence":{"efetivarAttempted":"false"}}', NULL, NULL, NULL, NULL, now() - interval '4 days'),
  -- relógio: linha tocada AGORA (ex.: salvou condição de pagamento) mas a recusa foi há 4 dias → encerra
  (213, 'aprovado_aguardando_disparo', 'erro_nao_retentavel', 'x', '$EV_FALSE', NULL, NULL, NULL, NULL, now()),
  -- última tentativa NÃO é a recusa definitiva (houve tentativa depois) → intocado
  (214, 'aprovado_aguardando_disparo', 'erro_nao_retentavel', 'x', '$EV_FALSE', NULL, NULL, NULL, NULL, now() - interval '4 days'),
  -- sem tentativa registrada → intocado (precisão > recall)
  (215, 'aprovado_aguardando_disparo', 'erro_nao_retentavel', 'x', '$EV_FALSE', NULL, NULL, NULL, NULL, now() - interval '4 days');
-- Uma tentativa erro_nao_retentavel por candidato, concluída há 4 dias (202: há 2 dias).
INSERT INTO public.pedidos_portal_tentativas (pedido_id, iniciado_em, concluido_em, status_resultado)
SELECT id, now() - interval '4 days' - interval '1 min', now() - interval '4 days', 'erro_nao_retentavel'
  FROM public.pedido_compra_sugerido WHERE id BETWEEN 201 AND 214 AND id <> 202;
INSERT INTO public.pedidos_portal_tentativas (pedido_id, iniciado_em, concluido_em, status_resultado) VALUES
  (202, now() - interval '2 days' - interval '1 min', now() - interval '2 days', 'erro_nao_retentavel'),
  (214, now() - interval '3 days 12 hours' - interval '1 min', now() - interval '3 days 12 hours', 'erro_retentavel');
TRUNCATE public.analytics_outbox;
SQL
}
claim()  { Pq -c "SELECT public.iniciar_envio_portal_pre_claim($1)::text;"; }
campo()  { Pq -c "SELECT COALESCE($2::text,'<null>') FROM public.pedido_compra_sugerido WHERE id=$1;"; }
encerrar() { Pq -c "SELECT public.reposicao_encerrar_recusas_definitivas(${1:-3})::text;"; }

echo "=== setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ==="

# ── B: BASELINE DO BUG (corpo velho) ────────────────────────────────────────────
echo "-- grupo B: baseline (corpo velho reabre o terminal) --"
pre_claim_velho; semear
eq "B1 corpo VELHO: erro_nao_retentavel É reaberto (o bug do #3169)" "$(claim 111)" "true"
eq "B1b corpo VELHO: virou pendente_envio_portal" "$(campo 111 status_envio_portal)" "pendente_envio_portal"

# ── migration real ──────────────────────────────────────────────────────────────
P -q -f "$MIG"
P -q -c "CREATE TRIGGER trg_analytics_outbox_pedido_compra AFTER INSERT OR UPDATE ON public.pedido_compra_sugerido FOR EACH ROW EXECUTE FUNCTION public.analytics_outbox_pedido_compra();"
echo "migration aplicada: $(basename "$MIG")"
ok "M1 postcondição do .sql passou (ON_ERROR_STOP)"
P -q -f "$MIG"
ok "M2 re-aplicar é idempotente (postcondição passou de novo)"
eq "M3 um único job de cron" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname='reposicao-encerrar-recusas-definitivas';")" "1"

semear
echo "-- grupo C: controles (o que entrava segue entrando) --"
eq "C1 nao_aplicavel (1º envio) entra"         "$(claim 101)" "true"
eq "C1b virou pendente_envio_portal"           "$(campo 101 status_envio_portal)" "pendente_envio_portal"
eq "C2 erro_retentavel entra (retry-órfãos)"   "$(claim 102)" "true"
eq "C2b portal_erro limpo"                     "$(campo 102 portal_erro)" "<null>"
eq "C3 falha_envio_portal entra (legado)"      "$(claim 103)" "true"
eq "C4 pendente_envio_portal entra ('Forçar reenvio' grava isto ANTES do disparo)" "$(claim 104)" "true"

echo "-- grupo N: negativos (recusa E não toca a linha) --"
eq "N1 erro_nao_retentavel RECUSADO"           "$(claim 111)" "false"
eq "N1b status_envio_portal intacto"           "$(campo 111 status_envio_portal)" "erro_nao_retentavel"
eq "N1c portal_erro preservado"                "$(campo 111 portal_erro)" "Grupo errado"
eq "N2 aceito_portal_sem_protocolo RECUSADO"   "$(claim 112)" "false"
eq "N3 indeterminado_requer_conciliacao RECUSADO" "$(claim 113)" "false"
eq "N4 sucesso_portal RECUSADO"                "$(claim 114)" "false"
eq "N4b sucesso_portal intacto"                "$(campo 114 status_envio_portal)" "sucesso_portal"
eq "N5 enviado_portal RECUSADO"                "$(claim 115)" "false"
eq "N6 enviando_portal RECUSADO (já era)"      "$(claim 116)" "false"
eq "N7 cancelado RECUSADO (já era)"            "$(claim 117)" "false"

echo "-- grupo E: encerramento automático --"
semear
R=$(encerrar 3)
eq "E1 só o #3169-like, o de protocolo só com espaços e o de linha recém-tocada encerrados" "$(Pq -c "SELECT '$R'::jsonb->>'ids';")" "[201, 211, 213]"
eq "E1b status cancelado"                      "$(campo 201 status)" "cancelado"
eq "E1c autor sistema"                         "$(campo 201 cancelado_por)" "sistema:recusa_portal"
eq "E1d higiene: portal nao_aplicavel"         "$(campo 201 status_envio_portal)" "nao_aplicavel"
eq "E1e cancelado_em carimbado"                "$(Pq -c "SELECT cancelado_em IS NOT NULL FROM pedido_compra_sugerido WHERE id=201;")" "t"
eq "E1f justificativa cita o motivo do portal" "$(Pq -c "SELECT position('Grupo errado (Prz 5 != 8)' in justificativa_cancelamento) > 0 FROM pedido_compra_sugerido WHERE id=201;")" "t"
eq "E1g portal_erro preservado (rastro)"       "$(campo 201 portal_erro)" "Grupo errado (Prz 5 != 8)"
eq "E1h portal_erro NULL não anula a justificativa" "$(Pq -c "SELECT position('(não registrado)' in justificativa_cancelamento) > 0 FROM pedido_compra_sugerido WHERE id=211;")" "t"
eq "E1i relógio = tentativa, não atualizado_em (#213 tocado agora, recusa há 4 dias)" "$(campo 213 status)" "cancelado"
eq "E1j analytics: cancelamento automático emitido como sistema" \
   "$(Pq -c "SELECT props->>'origem_cancelamento' FROM analytics_outbox WHERE chave_dedup='pcs:201:reposicao.sugestao_cancelada';")" "sistema"
eq "E1k analytics: 3 eventos de cancelamento (1 por encerrado)" \
   "$(Pq -c "SELECT count(*) FROM analytics_outbox WHERE evento='reposicao.sugestao_cancelada';")" "3"
for id in 202 203 204 205 206 207 208 209 210 212 214 215; do
  eq "E2 #$id intocado" "$(campo $id status)/$(campo $id cancelado_em)" "$(Pq -c "SELECT status FROM pedido_compra_sugerido WHERE id=$id;")/<null>"
done
eq "E2b <3 dias segue erro_nao_retentavel"     "$(campo 202 status_envio_portal)" "erro_nao_retentavel"
eq "E3 idempotente: 2ª chamada encerra 0"      "$(Pq -c "SELECT (public.reposicao_encerrar_recusas_definitivas(3)->>'encerrados');")" "0"
eq "E4 prazo menor alcança o de 2 dias (e não os sem tentativa/retentável depois)" "$(Pq -c "SELECT public.reposicao_encerrar_recusas_definitivas(1)->>'ids';")" "[202]"

if P -q -c "SELECT public.reposicao_encerrar_recusas_definitivas(0);" >/dev/null 2>"$RODADA/e5.err"; then
  bad "E5 p_dias=0 deveria ser recusado"
elif grep -q 'ENCERRAR-RECUSA' "$RODADA/e5.err"; then ok "E5 p_dias=0 recusado com a marca do ramo"
else bad "E5 p_dias=0: erro inesperado: $(head -1 "$RODADA/e5.err")"; fi

echo "-- grupo A: ACL --"
for r in authenticated anon; do
  if P -q <<SQL >/dev/null 2>&1
SET ROLE $r;
DO \$t\$
BEGIN
  PERFORM public.reposicao_encerrar_recusas_definitivas(3);
  RAISE EXCEPTION 'TEATRO: $r executou';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN RAISE;
END \$t\$;
SQL
  then ok "A1 $r sem EXECUTE no encerramento (42501)"; else bad "A1 $r: não veio 42501"; fi
done
# Controle de A1: com EXECUTE concedido a chamada PASSA (o 42501 era do EXECUTE, não da tabela).
P -q -c "GRANT EXECUTE ON FUNCTION public.reposicao_encerrar_recusas_definitivas(integer) TO authenticated;"
A1C=$(Pq <<'SQL' | tail -1
SET ROLE authenticated;
SELECT public.reposicao_encerrar_recusas_definitivas(36500)->>'encerrados';
SQL
)
eq "A1c controle: com EXECUTE, authenticated executa" "$A1C" "0"
P -q -c "REVOKE EXECUTE ON FUNCTION public.reposicao_encerrar_recusas_definitivas(integer) FROM authenticated;"

# ── F: FALSIFICAÇÃO — uma condição por vez, controle verde na MESMA invocação ─
echo "-- grupo F: falsificação --"
# formato: "<expressão sed s#…#…#>|<id que passa a ser encerrado indevidamente>". Cada uma desliga
# UMA condição; a substituição tem de acontecer exatamente 1 vez (conferido), senão a sabotagem é teatro.
SABOTAGENS=(
  "__CONTROLE__|"
  "s#AND portal_resposta -> 'evidence' -> 'efetivarAttempted' = 'false'::jsonb##|203"
  "s#AND disparo_claim_em IS NULL##|207"
  "s#AND NULLIF(btrim(portal_protocolo), '') IS NULL##|205"
  "s#AND NULLIF(btrim(omie_pedido_compra_id), '') IS NULL##|206"
  "s#AND NULLIF(btrim(omie_pedido_compra_numero), '') IS NULL##|210"
  "s#AND ult.concluido_em < now() - make_interval(days => p_dias))#)#|202"
  "s#WHERE ult.status_resultado = 'erro_nao_retentavel'#WHERE true#|214"
  "s#WHERE status = 'aprovado_aguardando_disparo'#WHERE status IN ('aprovado_aguardando_disparo','falha_envio')#|208"
)
for s in "${SABOTAGENS[@]}"; do
  expr="${s%%|*}"; vitima="${s##*|}"
  COPIA="$RODADA/sab.sql"
  # Só o CREATE da função de encerramento (sem cron/postcondição: a sabotagem não é da migration).
  # shellcheck disable=SC2016  # `$function$` é a TAG de dollar-quote do SQL: tem de ficar literal.
  sed -n '/^CREATE OR REPLACE FUNCTION public.reposicao_encerrar_recusas_definitivas/,/^\$function\$;/p' "$MIG" > "$COPIA"
  [ -s "$COPIA" ] || { echo "INFRA: não extraí a função do .sql"; exit 1; }
  if [ "$expr" = "__CONTROLE__" ]; then
    P -q -f "$COPIA"; semear
    eq "F0 controle (função intacta extraída): só [201, 211, 213]" "$(Pq -c "SELECT public.reposicao_encerrar_recusas_definitivas(3)->>'ids';")" "[201, 211, 213]"
    continue
  fi
  sed "$expr" "$COPIA" > "$COPIA.n"
  mudou=$(diff "$COPIA" "$COPIA.n" | grep -c '^<' || true)
  [ "$mudou" = "1" ] || { bad "F sabotagem não alterou exatamente 1 linha ($mudou): $expr"; continue; }
  P -q -f "$COPIA.n"; semear
  ids=$(Pq -c "SELECT public.reposicao_encerrar_recusas_definitivas(3)->>'ids';")
  if echo "$ids" | grep -qE "(\[|, )$vitima(,|\])"; then ok "F [$expr] → #$vitima encerrado indevidamente (a condição protege) ids=$ids"
  else bad "F [$expr] → #$vitima NÃO foi encerrado: condição redundante ou caso inalcançado (ids=$ids)"; fi
done
# Restaura a função verdadeira (o laço deixa a última sabotagem instalada).
P -q -f "$MIG"

echo
echo "=== RESULTADO: $PASS OK, $FAIL FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
echo "PROVA-RECUSA-DEFINITIVA-OK"
