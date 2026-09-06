#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — aprovar_pedido_sugerido: a 3ª via da mesma classe de TOCTOU          ║
# ║  Migration: 20260906151715_aprovar_pedido_guard_atomico.sql                   ║
# ║                                                                               ║
# ║      bash db/test-aprovar-pedido-guard.sh > /tmp/t.log 2>&1; echo $?          ║
# ║  (NAO pipe pra tail — engole o exit!=0.)                                      ║
# ║  Dois locales (licao #1483):                                                  ║
# ║      HARNESS_LC=pt_BR.UTF-8 bash db/test-aprovar-pedido-guard.sh              ║
# ║                                                                               ║
# ║  O que este harness prova, e por que cada grupo existe:                        ║
# ║   P  positivos   — aprova a partir dos DOIS status da allowlist e carimba      ║
# ║   C  contrato    — `sera_disparado_em` vem da linha GRAVADA (RETURNING)        ║
# ║   N  negativos   — status fora da allowlist e RECUSADO **sem tocar a linha**   ║
# ║   A  ACL         — authenticated executa (com falsificacao por REVOKE)         ║
# ║   R  CORRIDA     — R1 e o BASELINE DO BUG: o corpo VELHO REAL (copiado da PROD ║
# ║                    via pg_get_functiondef) carimba a aprovacao POR CIMA de um  ║
# ║                    cancelamento recem-commitado. Sem R1 vermelho, R2 verde nao ║
# ║                    prova nada: poderia ser so a corrida nunca ter ocorrido.    ║
# ║   F  falsificacao — controle verde primeiro; depois sabota UMA camada por vez  ║
# ╚═══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="$REPO_ROOT/supabase/migrations/20260906151715_aprovar_pedido_guard_atomico.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5475}"
SLUG="aprovar-guard"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
[ -f "$MIGRATION" ] || { echo "INFRA: migration ausente em $MIGRATION"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET TimeZone='UTC';"
# O SERVIDOR sempre arranca sob LC_ALL=C (no macOS, sem isso o postmaster aborta). O eixo que a
# licao manda variar e a LINGUA DAS MENSAGENS do servidor, e essa e GUC do BANCO.
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
-- O Supabase concede EXECUTE por DEFAULT PRIVILEGE a anon/authenticated/service_role -- medido na
-- PROD em 2026-09-06: o ACL de `aprovar_pedido_sugerido` traz `anon=X/postgres` e
-- `authenticated=X/postgres`, grants EXPLICITOS. Sem reproduzir isso aqui, a falsificacao F4
-- (que troca o GRANT por um REVOKE) mediria um ambiente que nao existe.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

# Controle do proprio eixo de locale: provoca um erro do SERVIDOR e mostra em que lingua vem.
AMOSTRA_MSG=$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -c "SELECT 1/0;" 2>&1 | head -1) || true
echo "=== setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ==="
echo "=== controle do eixo de locale, mensagem do servidor: $AMOSTRA_MSG"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRE-REQUISITOS (so o que a funcao le/escreve; tipos copiados da PROD via
#          information_schema em 2026-09-06: `status` e NOT NULL, o resto e nullable)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.pedido_compra_sugerido (
  id                         bigint PRIMARY KEY,
  status                     text NOT NULL DEFAULT 'pendente_aprovacao',
  aprovado_por               text,
  aprovado_em                timestamptz,
  horario_corte_planejado    timestamptz,
  cancelado_por              text,
  cancelado_em               timestamptz,
  justificativa_cancelamento text,
  atualizado_em              timestamptz DEFAULT now()
);
-- A RPC e SECURITY INVOKER: o role do chamador precisa de acesso a TABELA, como na PROD.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pedido_compra_sugerido TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL (Lei #1: prova o ARQUIVO, nao uma copia) + o CORPO VELHO
#          REAL, para o baseline do bug no grupo R
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$MIGRATION"

# Transcricao BYTE-A-BYTE do corpo VIVO lido da PROD em 2026-09-06 (`pg_get_functiondef`),
# so renomeada. Existe SO para o grupo R provar que a corrida REALMENTE corrompe sem a fronteira.
P -q <<'SQL'
CREATE FUNCTION public.via_velha_aprovar(p_pedido_id bigint, p_usuario text)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_pedido RECORD;
BEGIN
  SELECT * INTO v_pedido FROM pedido_compra_sugerido WHERE id = p_pedido_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'pedido nao encontrado');
  END IF;
  IF v_pedido.status NOT IN ('pendente_aprovacao', 'bloqueado_guardrail') THEN
    RETURN jsonb_build_object('error', 'pedido ja esta no estado ' || v_pedido.status);
  END IF;
  UPDATE pedido_compra_sugerido
  SET status = 'aprovado_aguardando_disparo',
      aprovado_por = p_usuario,
      aprovado_em = NOW(),
      atualizado_em = NOW()
  WHERE id = p_pedido_id;
  RETURN jsonb_build_object('status', 'ok', 'pedido_id', p_pedido_id,
                             'sera_disparado_em', v_pedido.horario_corte_planejado);
END;
$$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (o universo de status MEDIDO na PROD em 2026-09-06 + os dois da allowlist)
# ══════════════════════════════════════════════════════════════════════════════
CORTE="2026-09-06 21:00:00+00"
semear() {
  P -q <<SQL
TRUNCATE public.pedido_compra_sugerido CASCADE;
INSERT INTO public.pedido_compra_sugerido (id, status, horario_corte_planejado) VALUES
  (1, 'pendente_aprovacao',          timestamptz '$CORTE'),
  (2, 'bloqueado_guardrail',         timestamptz '$CORTE'),
  (3, 'aprovado_aguardando_disparo', timestamptz '$CORTE'),
  (4, 'disparado',                   timestamptz '$CORTE'),
  (5, 'cancelado_humano',            timestamptz '$CORTE'),
  (6, 'concluido_recebido',          timestamptz '$CORTE'),
  (7, 'expirado_sem_aprovacao',      timestamptz '$CORTE'),
  (8, 'split_em_filhos',             timestamptz '$CORTE'),
  (9, 'cancelado',                   timestamptz '$CORTE'),
  (10,'falha_envio',                 timestamptz '$CORTE'),
  (11,'pendente_aprovacao',          NULL),
  (12,'pendente_aprovacao',          timestamptz '$CORTE'),
  (20,'pendente_aprovacao',          timestamptz '$CORTE'),
  (21,'pendente_aprovacao',          timestamptz '$CORTE'),
  (22,'pendente_aprovacao',          timestamptz '$CORTE');
SQL
}
campo()   { Pq -c "SELECT COALESCE($2::text,'<null>') FROM public.pedido_compra_sugerido WHERE id=$1;"; }
# Ecoa uma CHAVE do jsonb de retorno (ASCII-safe: nao casamos a frase, so a presenca/valor).
chave()   { Pq -c "SELECT COALESCE(public.aprovar_pedido_sugerido($1,'lucas')->>'$2','<null>');"; }

semear

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "-- grupo P: positivos (os DOIS status da allowlist aprovam) --"
eq "P1 pendente_aprovacao  -> status"       "$(chave 1 status)"       'ok'
eq "P1b ... a linha virou aprovado"         "$(campo 1 status)"       'aprovado_aguardando_disparo'
eq "P1c ... carimbou quem aprovou"          "$(campo 1 aprovado_por)" 'lucas'
eq "P1d ... carimbou quando"                "$(Pq -c "SELECT (aprovado_em IS NOT NULL)::text FROM public.pedido_compra_sugerido WHERE id=1;")" 'true'
eq "P2 bloqueado_guardrail -> status"       "$(chave 2 status)"       'ok'
eq "P2b ... a linha virou aprovado"         "$(campo 2 status)"       'aprovado_aguardando_disparo'

echo "-- grupo C: contrato de retorno (sera_disparado_em vem da linha GRAVADA) --"
semear
# ⚠️ UMA chamada por linha, e todos os fatos extraidos do MESMO retorno. Chamar a RPC duas
# vezes na mesma linha APROVA na primeira e RECUSA na segunda: a chave sumiria do retorno e um
# assert de "sera_disparado_em nulo" ficaria verde pelo motivo ERRADO (falso verde).
C1="$(Pq -c "WITH r AS (SELECT public.aprovar_pedido_sugerido(12,'lucas') j)
             SELECT COALESCE(j->>'status','<sem>') || '|' ||
                    ((j->>'sera_disparado_em')::timestamptz = timestamptz '$CORTE')::text FROM r;")"
eq "C1 aprova e sera_disparado_em = o corte da linha gravada" "$C1" 'ok|true'
# C2: corte NULL nao pode virar erro nem sumir a chave. `? 'sera_disparado_em'` prova que a
# CHAVE existe (com JSON null) -- distingue "campo nulo" de "campo que sumiu do contrato".
C2="$(Pq -c "WITH r AS (SELECT public.aprovar_pedido_sugerido(11,'lucas') j)
             SELECT COALESCE(j->>'status','<sem>') || '|' ||
                    COALESCE(j->>'sera_disparado_em','<null>') || '|' ||
                    (j ? 'sera_disparado_em')::text FROM r;")"
eq "C2 corte NULL: aprova, chave PRESENTE e valor nulo" "$C2" 'ok|<null>|true'
eq "C3 pedido ausente devolve a chave error" "$(Pq -c "SELECT (public.aprovar_pedido_sugerido(999999,'lucas') ? 'error')::text;")" 'true'

echo "-- grupo N: negativos (fora da allowlist RECUSA e NAO toca a linha) --"
semear
for par in "3:aprovado_aguardando_disparo" "4:disparado" "5:cancelado_humano" "6:concluido_recebido" \
           "7:expirado_sem_aprovacao" "8:split_em_filhos" "9:cancelado" "10:falha_envio"; do
  id="${par%%:*}"; st="${par##*:}"
  eq "N($st) recusa (devolve error)"       "$(Pq -c "SELECT (public.aprovar_pedido_sugerido($id,'lucas') ? 'error')::text;")" 'true'
  eq "N($st) ... status intacto"           "$(campo "$id" status)"       "$st"
  eq "N($st) ... nao carimbou aprovado_por" "$(campo "$id" aprovado_por)" '<null>'
done
# N9 e o CENTRO da allowlist: `aprovado_aguardando_disparo` (id 3) e o estado que a edge
# `disparar-pedidos-aprovados` seleciona para chamar o Omie. Uma DENYLIST copiada do
# cancelamento (`NOT IN ('disparado','concluido_recebido')`) deixaria este caso PASSAR.

echo "-- grupo A: ACL (authenticated executa) --"
# Probe locale-proof: nao casa a FRASE do erro (que muda com lc_messages) -- casa a SQLSTATE,
# que e invariante. Marcador POSITIVO de fim ('EXECUTOU') + ON_ERROR_STOP=1.
acl_probe() {   # $1 = role -> 'EXECUTOU' | 'SQLSTATE-<codigo>'
  local out
  if out=$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -v ON_ERROR_STOP=1 2>&1 <<SQL
\set VERBOSITY verbose
SET ROLE $1;
SELECT public.aprovar_pedido_sugerido(999999, 'acl-probe');
SELECT 'EXECUTOU';
SQL
  ); then printf '%s\n' "$out" | tail -1
  else echo "SQLSTATE-$(printf '%s\n' "$out" | sed -nE 's/.*[[:space:]]([0-9][0-9A-Z]{4}):.*/\1/p' | head -1)"; fi
}
eq "A1 authenticated executa a RPC" "$(acl_probe authenticated)" 'EXECUTOU'
# A1b FALSIFICA A1: sem o EXECUTE, a MESMA chamada tem de virar 42501. Se continuasse
# 'EXECUTOU', o A1 nao estaria medindo o privilegio da funcao. Revoga de PUBLIC tambem: o
# ACL da PROD tem `=X/postgres` e `has_function_privilege` e verdadeiro via PUBLIC.
P -q -c "REVOKE ALL ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) FROM authenticated, PUBLIC;" >/dev/null
eq "A1b sem EXECUTE, a MESMA chamada e negada (falsifica A1)" "$(acl_probe authenticated)" 'SQLSTATE-42501'
P -q -c "GRANT EXECUTE ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) TO authenticated;" >/dev/null
eq "A1c privilegio restaurado" "$(acl_probe authenticated)" 'EXECUTOU'

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4b — A CORRIDA (o centro desta migration), com BARREIRA OBSERVAVEL
#
# ⚠️ `sleep 0.8` NAO e barreira: se o cancelamento commitar antes de B comecar, ate o corpo
# VELHO produz o resultado "certo" -- R2 ficaria verde sem nunca ter exercitado a espera no
# lock. Aqui a ordem e OBSERVADA, nao esperada:
#   1. A abre transacao, trava a linha, leva-a ao status destino e segura um advisory lock;
#   2. B e lancada e vai bloquear no lock de A;
#   3. o orquestrador POLLA `pg_blocking_pids` ate VER B bloqueada -- e so entao libera A;
#   4. se o bloqueio nao for observado, o assert falha dizendo que nao mediu a corrida.
# ══════════════════════════════════════════════════════════════════════════════
P -q -c "CREATE TABLE IF NOT EXISTS public.barreira (nome text PRIMARY KEY);" >/dev/null

lancar_bloqueador() {   # $1 = id que A trava; $2 = status destino (default 'cancelado_humano')
  # O UPDATE vive DENTRO de um DO para poder exigir `FOUND`: se ele nao pegar a linha, a
  # transacao aborta e o `wait` reprova -- em vez de a corrida "acontecer" sobre zero linhas.
  # O advisory lock e adquirido DEPOIS do UPDATE: e o sinal, observavel de outra sessao, de
  # que A ja travou a linha e so entao B pode ser lancada.
  P -q >/dev/null <<SQL &
BEGIN;
DO \$u\$
BEGIN
  UPDATE public.pedido_compra_sugerido
     SET status = '${2:-cancelado_humano}',
         cancelado_por = CASE WHEN '${2:-cancelado_humano}' = 'cancelado_humano' THEN 'humano-que-cancelou' ELSE cancelado_por END,
         cancelado_em  = CASE WHEN '${2:-cancelado_humano}' = 'cancelado_humano' THEN NOW() ELSE cancelado_em END,
         atualizado_em = NOW()
   WHERE id = $1 AND status = 'pendente_aprovacao';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BLOQUEADOR: o UPDATE concorrente nao pegou a linha % -- a corrida nao mediria nada', $1;
  END IF;
  PERFORM pg_advisory_xact_lock(918273647);
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

# Ecoa "sim" quando A ja segura o advisory lock (=> o UPDATE dele ja pegou a linha).
# ⚠️ Sem esta espera o harness FICA FLAKY e mente: se B rodar antes de A, o UPDATE de A nao
# casa `status='pendente_aprovacao'`, ninguem bloqueia e o assert mede outra coisa.
esperar_A_travar() {
  local n
  for _ in $(seq 1 300); do
    n=$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted AND pid <> pg_backend_pid();" | tail -1)
    if [ "${n:-0}" -ge 1 ]; then echo "sim"; return; fi
    sleep 0.05
  done
  echo "nao"
}

# Ecoa "sim" se chegou a OBSERVAR alguem bloqueado; "nao" no timeout.
esperar_bloqueio() {
  local n
  for _ in $(seq 1 "${1:-300}"); do
    n=$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND cardinality(pg_blocking_pids(pid)) > 0;" | tail -1)
    if [ "${n:-0}" -ge 1 ]; then echo "sim"; return; fi
    sleep 0.05
  done
  echo "nao"
}

liberar_A() { P -q -c "INSERT INTO public.barreira VALUES ('liberar') ON CONFLICT DO NOTHING;" >/dev/null; }

# ⚠️ CAMINHO FIXO, nao variavel: `corrida()` e sempre chamada dentro de `$( )`, que e um
# SUBSHELL -- uma global atribuida la dentro morre com ele e o pai leria string vazia (o
# assert entao "passaria" ou falharia por arquivo inexistente, sem medir nada).
B_OUT="/tmp/corrida-b-saida-aprovar.txt"
# $1 = id; $2 = SQL da chamada de B; $3 = status destino de A. Ecoa "<status>|<aprovado_por>|<bloqueio>"
corrida() {
  local id="$1" chamada="$2" destino="${3:-cancelado_humano}" out bpid visto
  out="$B_OUT"; : > "$out"
  P -q -c "DELETE FROM public.barreira;" >/dev/null
  lancar_bloqueador "$id" "$destino"
  if [ "$(esperar_A_travar)" != "sim" ]; then
    liberar_A; wait "$BLOQ_PID" || true
    echo "A-NAO-TRAVOU|A-NAO-TRAVOU|A-NAO-TRAVOU"; return
  fi
  Pq -c "$chamada" > "$out" 2>&1 &
  bpid=$!
  visto="$(esperar_bloqueio)"
  liberar_A
  wait "$bpid" || true
  if ! wait "$BLOQ_PID"; then echo "BLOQUEADOR-FALHOU|BLOQUEADOR-FALHOU|BLOQUEADOR-FALHOU"; return; fi
  echo "$(campo "$id" status)|$(campo "$id" aprovado_por)|$visto"
}

echo "-- grupo R: corrida real (2 conexoes, barreira observada) --"
semear
# R1 = BASELINE DO BUG. O corpo VELHO le o snapshot ANTIGO (o SELECT nao bloqueia em READ
# COMMITTED), passa no guard, ESPERA no lock e, quando A commita 'cancelado_humano', o
# `UPDATE ... WHERE id` continua casando e carimba a aprovacao POR CIMA do cancelamento.
# Se este assert vier verde (= nao corrompeu), a corrida nao aconteceu e R2 nao prova nada.
R1="$(corrida 20 "SELECT public.via_velha_aprovar(20, 'lucas')::text;")"
eq "R1 BASELINE: o corpo VELHO aprova POR CIMA do cancelamento" "$R1" 'aprovado_aguardando_disparo|lucas|sim'
# R2 = a fronteira, na MESMA corrida. O predicado no WHERE faz o EvalPlanQual reler
# 'cancelado_humano' -> fora da allowlist -> 0 linhas -> recusa, e NADA e escrito.
R2="$(corrida 21 "SELECT public.aprovar_pedido_sugerido(21, 'lucas')::text;")"
eq "R2 a FRONTEIRA recusa na mesma corrida e nao toca a linha" "$R2" 'cancelado_humano|<null>|sim'
# R2b: a recusa chega ao chamador nomeando o status REAL (ASCII, caixa fixa, sem -i).
if grep -q 'cancelado_humano' "$B_OUT"; then ok "R2b a recusa nomeia o status real (cancelado_humano)"
else bad "R2b a recusa NAO nomeia o status real: [$(head -c 200 "$B_OUT")]"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICACAO. Sabota UMA camada por vez e exige o vermelho CERTO.
#
# ⚠️ CONTROLE VERDE NA MESMA INVOCACAO (licao do #2219): uma sabotagem sempre-vermelha aprova
# qualquer coisa. Antes de sabotar, o arquivo INTACTO tem de aplicar limpo -- se o controle
# falhar, o laco aborta ANTES do primeiro `sed`.
# ══════════════════════════════════════════════════════════════════════════════
echo "-- grupo F: falsificacao (controle verde primeiro, depois sabotagem) --"
SAB_DIR="$(mktemp -d /tmp/sabotagem-aprovar.XXXXXX)"

aplica_variante() {   # $1 = arquivo sql -> 'PASSOU' | 'ABORTOU'
  P -q -c "DROP FUNCTION IF EXISTS public.aprovar_pedido_sugerido(bigint, text);" >/dev/null 2>&1
  if P -q -f "$1" >"$SAB_DIR/out.txt" 2>&1; then echo "PASSOU"; else echo "ABORTOU"; fi
}

cp "$MIGRATION" "$SAB_DIR/controle.sql"
FAIL_ANTES_F0="$FAIL"
eq "F0 CONTROLE: a migration intacta aplica limpo" "$(aplica_variante "$SAB_DIR/controle.sql")" 'PASSOU'
# ⚠️ O DELTA do proprio F0, nao o FAIL global: com o global, uma falha em QUALQUER grupo
# anterior abortaria o laco mesmo com o controle verde -- e a mensagem culparia o F0.
if [ "$FAIL" -ne "$FAIL_ANTES_F0" ]; then
  echo "ABORTANDO: o controle F0 falhou -- sabotar a partir daqui aprovaria qualquer coisa."
  cat "$SAB_DIR/out.txt"; exit 1
fi

sabota() {   # $1 = rotulo; $2 = expressao sed; $3 = trecho esperado na mensagem de aborto
  local f="$SAB_DIR/sab.sql"
  sed "$2" "$MIGRATION" > "$f"
  if cmp -s "$f" "$MIGRATION"; then bad "$1 -- o sed NAO alterou nada (padrao nao casou): a sabotagem nao existiu"; return; fi
  local r; r="$(aplica_variante "$f")"
  if [ "$r" != "ABORTOU" ]; then bad "$1 -- a postcondicao NAO gritou (a migration aplicou sabotada)"; return; fi
  if grep -q "$3" "$SAB_DIR/out.txt"; then ok "$1 (abortou com [$3])"; else
    bad "$1 -- abortou, mas NAO por [$3]: $(head -c 200 "$SAB_DIR/out.txt")"; fi
}

# ⚠️ Os padroes ancoram a linha INTEIRA (^...$): sem isso o sed bateria TAMBEM nas mencoes
# dentro da postcondicao (o regex do assert e a mensagem), e a migration abortaria por SYNTAX
# ERROR -- vermelho pelo motivo errado, que aprovaria a sabotagem sem medir o assert.
sabota "F1 guard fora do WHERE do UPDATE, a postcondicao grita" \
       "s/^    AND status IN ('pendente_aprovacao', 'bloqueado_guardrail')\$/    AND TRUE/" 'GUARD-NO-UPDATE'
sabota "F2 allowlist -> denylist, a postcondicao grita" \
       "s/^    AND status IN ('pendente_aprovacao', 'bloqueado_guardrail')\$/    AND status NOT IN ('disparado', 'concluido_recebido')/" 'ALLOWLIST'
sabota "F3 SECURITY INVOKER -> DEFINER, a postcondicao grita" \
       's/^LANGUAGE plpgsql$/LANGUAGE plpgsql SECURITY DEFINER/' 'SECDEF'
sabota "F4 sem o EXECUTE de authenticated, a postcondicao grita" \
       's/^GRANT EXECUTE ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) TO authenticated;$/REVOKE ALL ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) FROM authenticated, PUBLIC;/' 'ACL-EXECUTE'
sabota "F5 search_path solto, a postcondicao grita" \
       "s/^SET search_path TO 'public', 'pg_temp'\$/SET search_path TO 'public'/" 'SEARCH-PATH'
# F6 prova que o assert de EXECUCAO nao e decorativo: `CREATE OR REPLACE` ACEITA um corpo com
# coluna inexistente (plpgsql e late-bound) -- so a CHAMADA quebra. O Postgres devolve o
# identificador em MINUSCULAS (nao-citado), por isso o token esperado e minusculo.
sabota "F6 coluna inexistente passa no CREATE e so o assert de EXECUCAO pega" \
       's/^      atualizado_em = NOW()$/      atualizado_em_INEXISTENTE = NOW()/' 'atualizado_em_inexistente'

# ── F-comp: sabotagem de COMPORTAMENTO (o que a postcondicao TEXTUAL nao veria) ──
P -q -f "$MIGRATION" >/dev/null   # restaura o corpo bom antes das provas de efeito
semear
# F7 falsifica o proprio R2: se a fronteira recusasse por ESPERAR NO LOCK (e nao por reler o
# status), R2 ficaria verde de graca. Aqui a corrida e IDENTICA -- mesma barreira, mesmo lock --
# mas A leva o pedido a um status AINDA DENTRO da allowlist. A fronteira tem de ACEITAR.
# Verde aqui + verde em R2 = a recusa de R2 veio do STATUS RELIDO, nao da espera.
F7="$(corrida 22 "SELECT public.aprovar_pedido_sugerido(22, 'lucas')::text;" 'bloqueado_guardrail')"
eq "F7 corrida que NAO sai da allowlist: a fronteira ACEITA (falsifica R2)" "$F7" 'aprovado_aguardando_disparo|lucas|sim'

rm -rf "$SAB_DIR"

# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== RESULTADO: $PASS OK, $FAIL FAIL (lc_messages=$HARNESS_LC) ==="
[ "$FAIL" -eq 0 ]
