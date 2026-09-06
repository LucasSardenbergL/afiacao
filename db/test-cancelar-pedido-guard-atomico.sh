#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — cancelar_pedido_sugerido: o guard de status DENTRO da escrita         ║
# ║  Migration: 20260905224959_cancelar_pedido_guard_atomico.sql                   ║
# ║  Fecha o [P1] TOCTOU do parecer Codex xhigh no PR #2204.                       ║
# ║                                                                                ║
# ║      bash db/test-cancelar-pedido-guard-atomico.sh > /tmp/t.log 2>&1; echo $?  ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                                ║
# ║  O que este harness prova, e por que cada grupo existe:                        ║
# ║   P  positivos  — cancelar funciona e faz a higiene do portal                  ║
# ║   N  negativos  — disparado/concluido é RECUSADO **e a linha não é tocada**    ║
# ║   A  ACL        — 42501 com re-raise (Lei #2), o eixo que DROP+CREATE quebra   ║
# ║   R  CORRIDA    — R1 é o BASELINE DO BUG (corpo velho ⇒ o cancelamento vence   ║
# ║                   a compra real). Sem R1 vermelho, R2 verde não prova nada:    ║
# ║                   poderia significar só que a corrida nunca aconteceu.         ║
# ║   F  falsificação — sabota UMA camada por vez e exige o vermelho certo.        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="cancelar-guard"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
# TimeZone fixo: `timestamptz::text` renderiza no fuso da SESSAO -- sem isto as mensagens de
# recusa mudariam de forma conforme o fuso do host e os asserts abaixo seriam frageis.
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET TimeZone='UTC';"
# ── DOIS LOCALES (licao #1483: falsificar num ambiente so nao prova a asrercao) ────────
# O SERVIDOR sempre arranca sob LC_ALL=C -- no macOS, sem isso o postmaster aborta. O eixo
# que a licao manda variar e a LINGUA DAS MENSAGENS do servidor, e essa e GUC do BANCO.
# HARNESS_LC=pt_BR.UTF-8 bash db/test-cancelar-pedido-guard-atomico.sh
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
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

# Controle do proprio eixo: provoca um erro do SERVIDOR e mostra em que lingua ele vem.
# `|| true`: o psql SAI 1 de proposito aqui (divisao por zero e o provocador) e o `set -e`
# mataria o script antes de qualquer assert.
AMOSTRA_MSG=$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -c "SELECT 1/0;" 2>&1 | head -1) || true
echo "=== setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ==="
echo "=== controle do eixo de locale, mensagem do servidor: $AMOSTRA_MSG"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (só o que a função lê/escreve; tipos copiados da PROD
#          via information_schema em 2026-09-05 — status é text NOT NULL)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.pedido_compra_sugerido (
  id                         bigserial PRIMARY KEY,
  status                     text NOT NULL DEFAULT 'pendente_aprovacao',
  status_envio_portal        text DEFAULT 'nao_aplicavel',
  portal_proximo_retry_em    timestamptz,
  cancelado_por              text,
  cancelado_em               timestamptz,
  justificativa_cancelamento text,
  horario_disparo_real       timestamptz,
  omie_pedido_compra_id      text,
  atualizado_em              timestamptz DEFAULT now()
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL (Lei #1) + o corpo VELHO REAL (para o baseline do bug)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260905224959_cancelar_pedido_guard_atomico.sql"
MIG_VELHA="$REPO_ROOT/supabase/migrations/20260530210001_cancelar_pedido_limpa_portal.sql"
POSTBLOCO="$(mktemp /tmp/postbloco.XXXXXX.sql)"
# shellcheck disable=SC2016  # `$post$` e a TAG de dollar-quote do SQL: tem de ficar literal.
sed -n '/^DO \$post\$/,/^\$post\$;/p' "$MIG" > "$POSTBLOCO"
[ -s "$POSTBLOCO" ] || { echo "INFRA: não extraí o bloco de postcondição do .sql"; exit 1; }

P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
semear() {
  P -q <<'SQL'
TRUNCATE public.pedido_compra_sugerido RESTART IDENTITY;
INSERT INTO public.pedido_compra_sugerido (id, status, status_envio_portal, portal_proximo_retry_em, horario_disparo_real) VALUES
  (1, 'pendente_aprovacao',          'nao_aplicavel',          NULL,                    NULL),
  (2, 'aprovado_aguardando_disparo', 'pendente_envio_portal',  now() + interval '15 min', NULL),
  (3, 'bloqueado_guardrail',         'nao_aplicavel',          NULL,                    NULL),
  (4, 'disparado',                   'enviado_portal',         NULL,                    timestamptz '2026-09-01 10:00:00+00'),
  (5, 'concluido_recebido',          'enviado_portal',         NULL,                    timestamptz '2026-08-20 09:00:00+00'),
  (6, 'disparado',                   'enviado_portal',         NULL,                    NULL),
  (7, 'aprovado_aguardando_disparo', 'nao_aplicavel',          NULL,                    NULL),
  (8, 'falha_envio',                 'nao_aplicavel',          NULL,                    NULL);
SQL
}
cancelar() { Pq -c "SELECT public.cancelar_pedido_sugerido($1, 'lucas', 'motivo do teste')::text;"; }
campo()    { Pq -c "SELECT COALESCE($2::text,'<null>') FROM public.pedido_compra_sugerido WHERE id=$1;"; }

semear

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "-- grupo P: positivos (o cancelamento acontece e faz a higiene do portal) --"
eq "P1 pendente_aprovacao cancela"          "$(cancelar 1)" '{"status": "ok", "pedido_id": 1}'
eq "P1b status virou cancelado_humano"      "$(campo 1 status)" "cancelado_humano"
eq "P1c carimbo de quem cancelou"           "$(campo 1 cancelado_por)" "lucas"
eq "P1d justificativa gravada"              "$(campo 1 justificativa_cancelamento)" "motivo do teste"

eq "P2 aprovado_aguardando_disparo cancela (veto individual do auto-aprovado)" "$(cancelar 2)" '{"status": "ok", "pedido_id": 2}'
eq "P2b higiene: status_envio_portal zerado"  "$(campo 2 status_envio_portal)" "nao_aplicavel"
eq "P2c higiene: retry do portal cancelado"   "$(campo 2 portal_proximo_retry_em)" "<null>"

eq "P3 bloqueado_guardrail cancela"         "$(cancelar 3)" '{"status": "ok", "pedido_id": 3}'
eq "P4 falha_envio cancela"                 "$(cancelar 8)" '{"status": "ok", "pedido_id": 8}'

echo "-- grupo N: negativos (recusa E NAO TOCA a linha) --"
eq "N1 disparado e RECUSADO"                "$(cancelar 4)" '{"error": "pedido já foi disparado em 2026-09-01 10:00:00+00"}'
eq "N1b disparado: status intacto"          "$(campo 4 status)" "disparado"
eq "N1c disparado: NAO carimbou cancelado_em" "$(campo 4 cancelado_em)" "<null>"
eq "N1d disparado: NAO mexeu no portal"     "$(campo 4 status_envio_portal)" "enviado_portal"

eq "N2 concluido_recebido e RECUSADO"       "$(cancelar 5)" '{"error": "pedido já foi disparado em 2026-08-20 09:00:00+00"}'
eq "N2b concluido: status intacto"          "$(campo 5 status)" "concluido_recebido"
eq "N2c concluido: NAO carimbou cancelado_em" "$(campo 5 cancelado_em)" "<null>"

eq "N3 pedido inexistente"                  "$(cancelar 999)" '{"error": "pedido não encontrado"}'

# N4: 'texto' || NULL colapsa a STRING INTEIRA para NULL. Sem o COALESCE a recusa vira
# {"error": null}, que o front le como "sem erro" -> a recusa SOME da tela.
eq "N4 disparado SEM horario: a recusa continua visivel" \
   "$(cancelar 6)" '{"error": "pedido já foi disparado em (horário não registrado)"}'
eq "N4b disparado sem horario: status intacto" "$(campo 6 status)" "disparado"

echo "-- grupo A: ACL (Lei #2 -- SQLSTATE esperada + re-raise) --"
P -q <<'SQL'
REVOKE EXECUTE ON FUNCTION public.cancelar_pedido_sugerido(bigint,text,text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cancelar_pedido_sugerido(bigint,text,text) TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
-- ⚠️ anon recebe os privilegios de TABELA de proposito (achado Codex): a funcao e INVOKER, entao
-- sem eles um anon COM EXECUTE falharia com o MESMO 42501 vindo da tabela, e A2 ficaria verde
-- medindo a coisa errada. Com a tabela liberada, o unico privilegio que falta e o EXECUTE.
GRANT SELECT, UPDATE ON public.pedido_compra_sugerido TO authenticated, anon;
SQL
A1=$(Pq <<'SQL'
SET ROLE authenticated;
SELECT public.cancelar_pedido_sugerido(7, 'lucas', 'via authenticated')->>'status';
SQL
)
A1="${A1##*$'\n'}"   # so a ultima linha: `SET ROLE` emite a tag "SET" antes do tuple
eq "A1 authenticated (com grant nominal) EXECUTA" "$A1" "ok"

if P -q <<'SQL' >/dev/null 2>&1
SET ROLE anon;
DO $t$
BEGIN
  PERFORM public.cancelar_pedido_sugerido(1, 'x', 'y');
  RAISE EXCEPTION 'TEATRO: anon sem EXECUTE e a chamada PASSOU';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;   -- 42501: exatamente o esperado
  WHEN OTHERS THEN RAISE;                  -- qualquer outro erro NAO conta como prova
END
$t$;
SQL
then ok "A2 anon sem EXECUTE recebe 42501 (com privilegio de TABELA concedido: o 42501 e do EXECUTE)"
else bad "A2 anon: nao veio 42501 -- ou passou, ou veio outro erro"; fi

# A2b: falsifica A2 -- concede o EXECUTE e exige que a chamada PASSE. Se continuasse negada, o
# 42501 de A2 nao vinha do EXECUTE e A2 nao mediria nada.
P -q -c "GRANT EXECUTE ON FUNCTION public.cancelar_pedido_sugerido(bigint,text,text) TO anon;" >/dev/null
A2B=$(Pq <<'SQL' | tail -1
SET ROLE anon;
SELECT public.cancelar_pedido_sugerido(3, 'anon', 'com EXECUTE concedido')->>'status';
SQL
)
eq "A2b com EXECUTE concedido o mesmo anon PASSA -- A2 media o EXECUTE" "$A2B" "ok"
P -q -c "REVOKE EXECUTE ON FUNCTION public.cancelar_pedido_sugerido(bigint,text,text) FROM anon;" >/dev/null

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4b — A CORRIDA (o centro desta migration), com BARREIRA OBSERVAVEL
#
# ⚠️ `sleep 0.8` NAO e barreira (achado Codex gpt-6-astra max): se o disparador commitar antes
# de a RPC comecar, ate o corpo VELHO produz a recusa esperada -- R2 fica verde sem nunca ter
# exercitado o EvalPlanQual. Aqui a ordem e OBSERVADA, nao esperada:
#   1. A abre transacao, trava a linha e fica esperando um sinal na tabela `barreira`;
#   2. B (a RPC) e lancada e vai bloquear no lock de A;
#   3. o orquestrador POLLA `pg_blocking_pids` ate VER B bloqueada -- e so entao libera A;
#   4. se o bloqueio nao for observado, o assert falha dizendo que nao mediu EPQ.
# ══════════════════════════════════════════════════════════════════════════════
P -q -c "CREATE TABLE IF NOT EXISTS public.barreira (nome text PRIMARY KEY);" >/dev/null

lancar_bloqueador() {   # $1 = id que A trava e leva a 'disparado'
  # O UPDATE vive DENTRO de um DO para poder exigir `FOUND`: se ele nao pegar a linha, a
  # transacao aborta e `wait` reprova -- em vez de a corrida "acontecer" sobre zero linhas e o
  # assert medir nada. O advisory lock e adquirido DEPOIS do UPDATE: e o sinal, observavel de
  # outra sessao, de que A ja travou a linha e so entao B pode ser lancada.
  P -q >/dev/null <<SQL &
BEGIN;
DO \$u\$
BEGIN
  UPDATE public.pedido_compra_sugerido
     SET status = 'disparado',
         omie_pedido_compra_id = 'PO-REAL-NO-OMIE',
         horario_disparo_real = timestamptz '2026-09-05 12:00:00+00'
   WHERE id = $1 AND status = 'aprovado_aguardando_disparo';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BLOQUEADOR: o UPDATE do disparador nao pegou a linha % -- a corrida nao mediria nada', $1;
  END IF;
  PERFORM pg_advisory_xact_lock(918273645);
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

# Ecoa "sim" quando A ja segura o advisory lock (⇒ o UPDATE dele ja pegou a linha).
# ⚠️ Sem esta espera o harness FICA FLAKY e mente: se B rodar antes de A, o UPDATE de A nao
# casa `status='aprovado_aguardando_disparo'`, ninguem bloqueia e o assert mede outra coisa.
# Foi assim que o run em pt_BR.UTF-8 reprovou enquanto o run em C passava (licao #1483: um
# ambiente so nao prova a asrercao).
esperar_A_travar() {
  local n
  for _ in $(seq 1 300); do
    n=$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted AND pid <> pg_backend_pid();" | tail -1)
    if [ "${n:-0}" -ge 1 ]; then echo "sim"; return; fi
    sleep 0.05
  done
  echo "nao"
}

# Ecoa "sim" se chegou a OBSERVAR alguem bloqueado dentro da chamada da RPC; "nao" no timeout.
esperar_bloqueio() {   # $1 = tentativas de 50ms (default 300 = 15s)
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
  out="$(mktemp /tmp/corrida-b.XXXXXX)"
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
  echo "$(tail -1 "$out")|$(campo "$id" status)|$visto"
  rm -f "$out"
}

echo "-- grupo R: corrida real (2 conexoes, barreira observada) --"

# R1 BASELINE DO BUG: corpo VELHO REAL (migration 20260530210001, commitada). Tem de REPRODUZIR
# o bug -- senao a corrida nao esta acontecendo e o R2 abaixo seria verde por acidente.
P -q -f "$MIG_VELHA"
semear
R1="$(corrida 2)"
eq "R1 BASELINE: corpo VELHO -- o cancelamento VENCE a compra real (bug reproduzido, bloqueio observado)" \
   "$R1" '{"status": "ok", "pedido_id": 2}|cancelado_humano|sim'
eq "R1b BASELINE: o PO real ficou orfao sob um status cancelado" \
   "$(campo 2 omie_pedido_compra_id)" "PO-REAL-NO-OMIE"

# R2 COM O FIX: mesma corrida. O UPDATE condicional espera o lock, RE-AVALIA o predicado contra a
# linha ja commitada como 'disparado' (EvalPlanQual) e PULA a linha.
P -q -f "$MIG"
semear
R2="$(corrida 2)"
eq "R2 FIX: a RPC RECUSA e o status permanece disparado (bloqueio observado)" \
   "$R2" '{"error": "pedido já foi disparado em 2026-09-05 12:00:00+00"}|disparado|sim'
eq "R2b FIX: nenhum carimbo de cancelamento na compra real" "$(campo 2 cancelado_em)" "<null>"
eq "R2c FIX: a higiene do portal NAO foi aplicada sobre a compra real" \
   "$(campo 2 status_envio_portal)" "pendente_envio_portal"
eq "R2d FIX: a TESTEMUNHA do PO real continua na linha" \
   "$(campo 2 omie_pedido_compra_id)" "PO-REAL-NO-OMIE"

# R3 CONTROLE INOCUO: A trava OUTRA linha. O cancelamento tem de terminar SEM esperar A -- e a
# testemunha disso e que, no instante em que B termina, A AINDA nao foi liberado. Sem este
# controle, um R2 verde poderia significar so "esta RPC recusa tudo sob concorrencia".
# `statement_timeout` de 2s: se B bloquear, ela morre com 57014 em vez de pendurar o harness.
semear
P -q -c "DELETE FROM public.barreira;" >/dev/null
lancar_bloqueador 7
eq "R3-pre A travou a OUTRA linha antes de B comecar" "$(esperar_A_travar)" "sim"
OUT3="$(mktemp /tmp/corrida-r3.XXXXXX)"
Pq >"$OUT3" 2>&1 <<'SQL' || true
SET statement_timeout = '2s';
SELECT public.cancelar_pedido_sugerido(2, 'lucas', 'linha diferente')::text;
SQL
R3="$(tail -1 "$OUT3")"
A_SEGURANDO=$(Pq -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM public.barreira WHERE nome='liberar') THEN 'ja_liberado' ELSE 'ainda_segurando' END;" | tail -1)
liberar_A
wait "$BLOQ_PID" || bad "R3-infra: o bloqueador falhou"
eq "R3 CONTROLE: disparo de OUTRA linha nao bloqueia este cancelamento" \
   "$R3" '{"status": "ok", "pedido_id": 2}'
eq "R3b TESTEMUNHA: B terminou enquanto A ainda segurava o lock" "$A_SEGURANDO" "ainda_segurando"
rm -f "$OUT3"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÕES (uma camada por vez; a que ficar VERDE e redundante)
# ══════════════════════════════════════════════════════════════════════════════
echo "-- falsificacoes --"

# F1: tira o guard do UPDATE por completo. N1 (recusar disparado) TEM de ficar vermelho.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.cancelar_pedido_sugerido(p_pedido_id bigint, p_usuario text, p_justificativa text)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE v_id bigint;
BEGIN
  UPDATE pedido_compra_sugerido SET status='cancelado_humano', cancelado_em=NOW()
   WHERE id = p_pedido_id
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN jsonb_build_object('status','ok','pedido_id',p_pedido_id); END IF;
  RETURN jsonb_build_object('error','pedido nao encontrado');
END $$;
SQL
semear
F1="$(cancelar 4)"
if [ "$F1" = '{"status": "ok", "pedido_id": 4}' ]; then
  ok "F1 sem o guard, cancelar um DISPARADO passa -- N1 tem dente"
else
  bad "F1 sabotagem nao mudou nada (veio [$F1]) -- N1 nao esta medindo o guard"
fi

# F2: A FALSIFICACAO QUE IMPORTA. Corpo VELHO REAL: o guard EXISTE, mas fora da escrita.
# N1 (sequencial) fica VERDE -- e a CORRIDA tem de ficar VERMELHA. E o que separa
# "tem guard" de "o guard e atomico". Se R2 sobrevivesse a isto, R2 seria teatro.
P -q -f "$MIG_VELHA"
semear
F2_SEQ="$(cancelar 4)"
eq "F2a corpo velho AINDA recusa no caso sequencial (o guard existe)" \
   "$F2_SEQ" '{"error": "pedido já foi disparado em 2026-09-01 10:00:00+00"}'
semear
F2_RACE="$(corrida 2)"
# A testemunha `|sim` (bloqueio OBSERVADO) e o `PO-REAL-NO-OMIE` sao o que impede este assert de
# passar por ordenamento sequencial acidental: sem elas, "cancelamento terminou antes de o
# disparador comecar" produziria o mesmo JSON (achado Codex).
if [ "$F2_RACE" = '{"status": "ok", "pedido_id": 2}|cancelado_humano|sim' ]; then
  ok "F2b corpo velho PERDE a corrida sob bloqueio observado -- R2 mede ATOMICIDADE, nao a existencia do guard"
else
  bad "F2b corpo velho sobreviveu a corrida (veio [$F2_RACE]) -- R2 e teatro"
fi
eq "F2c e o PO real estava mesmo na linha quando o cancelamento venceu" \
   "$(campo 2 omie_pedido_compra_id)" "PO-REAL-NO-OMIE"

# F3: tira o COALESCE do horario. N4 tem de ficar vermelho (a recusa vira {"error": null}).
P -q -f "$MIG"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.cancelar_pedido_sugerido(p_pedido_id bigint, p_usuario text, p_justificativa text)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE v_id bigint; v_status text; v_disparo timestamptz;
BEGIN
  UPDATE pedido_compra_sugerido
     SET status='cancelado_humano', cancelado_por=p_usuario, cancelado_em=NOW(),
         justificativa_cancelamento=p_justificativa, status_envio_portal='nao_aplicavel',
         portal_proximo_retry_em=NULL, atualizado_em=NOW()
   WHERE id = p_pedido_id AND status NOT IN ('disparado','concluido_recebido')
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN jsonb_build_object('status','ok','pedido_id',p_pedido_id); END IF;
  SELECT status, horario_disparo_real INTO v_status, v_disparo FROM pedido_compra_sugerido WHERE id=p_pedido_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','pedido nao encontrado'); END IF;
  RETURN jsonb_build_object('error', 'pedido ja foi disparado em ' || v_disparo::text);
END $$;
SQL
semear
F3="$(cancelar 6)"
if [ "$F3" = '{"error": null}' ]; then
  ok "F3 sem COALESCE a recusa vira {error:null} e some da tela -- N4 tem dente"
else
  bad "F3 sabotagem nao mudou nada (veio [$F3]) -- N4 nao mede o colapso por NULL"
fi

# F4: a POSTCONDICAO da propria migration. Dois lados, senao nao prova nada:
#     (a) contra o corpo velho ela tem de ABORTAR com a mensagem do guard;
#     (b) contra o corpo certo ela tem de PASSAR.
P -q -f "$MIG_VELHA"
ERRLOG="$(mktemp /tmp/post-erro.XXXXXX.log)"
if P -q -f "$POSTBLOCO" >/dev/null 2>"$ERRLOG"; then
  bad "F4a a postcondicao PASSOU sobre o corpo velho vulneravel -- ela e decorativa"
else
  if grep -q 'TOCTOU do #2204 continua aberto' "$ERRLOG"; then
    ok "F4a a postcondicao aborta sobre o corpo velho, pelo motivo CERTO (guard fora do UPDATE)"
  else
    bad "F4a a postcondicao abortou, mas por outro motivo: $(head -c 200 "$ERRLOG")"
  fi
fi
P -q -f "$MIG"
if P -q -f "$POSTBLOCO" >/dev/null 2>&1; then
  ok "F4b a mesma postcondicao PASSA sobre o corpo certo (nao e sempre-vermelha)"
else
  bad "F4b a postcondicao reprova o corpo CERTO -- falso-positivo"
fi

# F5: o eixo ACL da postcondicao -- e o seu PONTO CEGO, MEDIDO em vez de deduzido.
# Nota: em PROD o ACL e MAIS FROUXO do que o testado aqui -- `proacl` tem `=X/postgres`,
# ou seja PUBLIC TEM EXECUTE, alem dos grants nominais a anon/authenticated/service_role.
# O F5a abaixo aperta de proposito para isolar o eixo; nao o leia como 'o ACL de prod'.
P -q -f "$MIG"
P -q <<'SQL'
REVOKE EXECUTE ON FUNCTION public.cancelar_pedido_sugerido(bigint,text,text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cancelar_pedido_sugerido(bigint,text,text) TO authenticated;
SQL
if P -q -f "$POSTBLOCO" >/dev/null 2>&1; then
  ok "F5a com ACL sintetico MAIS restrito que o de prod (PUBLIC revogado, so authenticated nominal) a postcondicao passa"
else
  bad "F5a a postcondicao reprova um ACL que ainda concede EXECUTE a authenticated -- falso-positivo"
fi

# F5b: perda EFETIVA de EXECUTE -> a postcondicao TEM de abortar, pelo sentinela certo.
P -q -c "REVOKE EXECUTE ON FUNCTION public.cancelar_pedido_sugerido(bigint,text,text) FROM authenticated;" >/dev/null
ERRLOG2="$(mktemp /tmp/post-acl.XXXXXX.log)"
if P -q -f "$POSTBLOCO" >/dev/null 2>"$ERRLOG2"; then
  bad "F5b authenticated sem EXECUTE e a postcondicao passou -- o eixo ACL e decorativo"
else
  if grep -q 'ACL-EXECUTE' "$ERRLOG2"; then
    ok "F5b perda de EXECUTE aborta a postcondicao pelo sentinela [ACL-EXECUTE]"
  else
    bad "F5b abortou por outro motivo: $(head -c 200 "$ERRLOG2")"
  fi
fi

# F5c: O PONTO CEGO, medido. `DROP FUNCTION` + `CREATE` APAGA o grant nominal a authenticated,
# mas recria com o default `EXECUTE TO PUBLIC` -- e `has_function_privilege` e verdadeiro por
# PUBLIC. Logo este eixo NAO detecta DROP+CREATE. O harness afirma o limite em vez de fingir
# cobertura: se um dia a postcondicao PASSAR a pegar isso, este assert fica vermelho e alguem
# reescreve a linha do doc.
P -q -c "DROP FUNCTION public.cancelar_pedido_sugerido(bigint,text,text);" >/dev/null
P -q -f "$MIG" >/dev/null
ACL_APOS=$(Pq -c "SELECT COALESCE(array_to_string(proacl,','),'<default:EXECUTE-TO-PUBLIC>') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='cancelar_pedido_sugerido';")
eq "F5c1 DROP+CREATE apagou o ACL nominal (o grant a authenticated sumiu)" \
   "$ACL_APOS" "<default:EXECUTE-TO-PUBLIC>"
if P -q -f "$POSTBLOCO" >/dev/null 2>&1; then
  ok "F5c2 PONTO CEGO CONFIRMADO: a postcondicao NAO ve o DROP+CREATE (PUBLIC ainda executa)"
else
  bad "F5c2 a postcondicao viu o DROP+CREATE -- otimo, mas o comentario do .sql esta desatualizado"
fi

# V: a QUERY DE VALIDACAO que vai no handoff do SQL Editor, nos DOIS sentidos. E o unico
# instrumento que o founder tem para saber se o apply pegou -- se ela nao souber dizer
# "nao aplicada", ela nao valida nada.
VALIDA="$REPO_ROOT/db/valida-cancelar-pedido-guard-atomico.sql"
P -q -f "$MIG"
eq "V1 validacao diz OK sobre o corpo NOVO" \
   "$(Pq -f "$VALIDA" | tail -1)" \
   "OK - guard atomico no ar, INVOKER, search_path preso, authenticated executa"
P -q -f "$MIG_VELHA"
eq "V2 validacao ACUSA o corpo VELHO (nao e sempre-verde)" \
   "$(Pq -f "$VALIDA" | tail -1)" \
   "NAO APLICADA - o guard de status NAO esta no WHERE do UPDATE (TOCTOU do #2204 segue aberto)"

# F6: a propria BARREIRA, falsificada. Se `esperar_bloqueio` nao soubesse dizer "nao", o sufixo
# `|sim` de R1/R2/F2b seria decorativo -- casaria sempre e nao provaria bloqueio nenhum.
P -q -f "$MIG"
semear
P -q -c "DELETE FROM public.barreira;" >/dev/null
lancar_bloqueador 7                    # A trava a linha 7
eq "F6-pre A travou a linha 7 antes de B comecar" "$(esperar_A_travar)" "sim"
OUT6="$(mktemp /tmp/corrida-f6.XXXXXX)"
Pq -c "SELECT public.cancelar_pedido_sugerido(2, 'lucas', 'sem colisao')::text;" > "$OUT6" 2>&1 &
B6=$!
VISTO6="$(esperar_bloqueio 20)"        # ~1s: B cancela OUTRA linha, nao ha bloqueio a observar
wait "$B6" || true
liberar_A
wait "$BLOQ_PID" || bad "F6-infra: o bloqueador falhou"
eq "F6 a barreira sabe dizer 'nao' quando nao ha bloqueio -- o sufixo |sim nao e decorativo" \
   "$VISTO6" "nao"
rm -f "$OUT6"

# restaura o estado verdadeiro e re-prova o caminho feliz (o teste nao termina sabotado)
P -q -f "$MIG"
semear
eq "Z1 apos todas as sabotagens, a migration real volta a valer" "$(cancelar 1)" '{"status": "ok", "pedido_id": 1}'
eq "Z2 e continua recusando o disparado"  "$(cancelar 4)" '{"error": "pedido já foi disparado em 2026-09-01 10:00:00+00"}'

rm -f "$POSTBLOCO" "$ERRLOG" "$ERRLOG2"
echo "═══════════════════════════════════════"
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "VERDE"
