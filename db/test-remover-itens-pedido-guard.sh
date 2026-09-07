#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — remover_itens_pedido_sugerido: a 2ª via de cancelamento na fronteira ║
# ║  Migration: 20260906105549_remover_itens_pedido_guard.sql                     ║
# ║  Fecha o [P1] do #2204 na via que o #2204 e a 20260905224959 NÃO cobriram.    ║
# ║                                                                               ║
# ║      bash db/test-remover-itens-pedido-guard.sh > /tmp/t.log 2>&1; echo $?    ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                               ║
# ║  O que este harness prova, e por que cada grupo existe:                        ║
# ║   P  positivos   — remove item, recalcula do BANCO, e cancela quando esvazia   ║
# ║   N  negativos   — status fora da allowlist é RECUSADO **sem tocar a linha**   ║
# ║                    (inclui `aprovado_aguardando_disparo`, que uma DENYLIST     ║
# ║                     deixaria passar — é a diferença que a allowlist compra)    ║
# ║   A  ACL         — authenticated executa, anon NÃO (42501 com re-raise)        ║
# ║   V  vazamento   — id de item de OUTRO pedido não é apagado de carona          ║
# ║   R  CORRIDA     — R1 é o BASELINE DO BUG (a via CRUA do front carimba         ║
# ║                    cancelado sobre a compra real). Sem R1 vermelho, R2 verde   ║
# ║                    não prova nada: poderia ser só a corrida nunca ter ocorrido ║
# ║   F  falsificação — sabota UMA camada por vez e exige o vermelho certo         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="$REPO_ROOT/supabase/migrations/20260906105549_remover_itens_pedido_guard.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5474}"
SLUG="remover-itens-guard"
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
# ── DOIS LOCALES (licao #1483: falsificar num ambiente so nao prova a asrercao) ────────
# O SERVIDOR sempre arranca sob LC_ALL=C (no macOS, sem isso o postmaster aborta). O eixo que
# a licao manda variar e a LINGUA DAS MENSAGENS do servidor, e essa e GUC do BANCO:
#   HARNESS_LC=pt_BR.UTF-8 bash db/test-remover-itens-pedido-guard.sh
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
-- O Supabase concede EXECUTE por DEFAULT PRIVILEGE a anon/authenticated/service_role -- medido
-- na PROD em 2026-09-06: o ACL de `cancelar_pedido_sugerido` traz `anon=X/postgres`, um grant
-- EXPLICITO. Sem reproduzir isso aqui, `REVOKE ... FROM PUBLIC` sozinho ja deixaria anon sem
-- EXECUTE e a sabotagem F5 (que remove o `REVOKE ... FROM anon`) seria SEMPRE-VERDE: o harness
-- estaria provando um ambiente que nao existe. E exatamente a armadilha do CLAUDE.md
-- ("REVOKE FROM PUBLIC NAO tira anon/authenticated -- revogar por nome").
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

# Controle do proprio eixo de locale: provoca um erro do SERVIDOR e mostra em que lingua vem.
# `|| true`: o psql SAI 1 de proposito aqui (a divisao por zero e o provocador) e o `set -e`
# mataria o script antes de qualquer assert.
AMOSTRA_MSG=$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -c "SELECT 1/0;" 2>&1 | head -1) || true
echo "=== setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ==="
echo "=== controle do eixo de locale, mensagem do servidor: $AMOSTRA_MSG"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRE-REQUISITOS (so o que a funcao le/escreve; tipos copiados da PROD via
#          information_schema em 2026-09-06: status/valor_total/num_skus sao NOT NULL)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.pedido_compra_sugerido (
  id                         bigint PRIMARY KEY,
  status                     text NOT NULL,
  valor_total                numeric NOT NULL DEFAULT 0,
  num_skus                   integer NOT NULL DEFAULT 0,
  cancelado_por              text,
  cancelado_em               timestamptz,
  justificativa_cancelamento text,
  status_envio_portal        text,
  portal_proximo_retry_em    timestamptz,
  omie_pedido_compra_id      text,
  horario_disparo_real       timestamptz,
  atualizado_em              timestamptz
);
CREATE TABLE public.pedido_compra_item (
  id             bigint PRIMARY KEY,
  pedido_id      bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie text NOT NULL,
  qtde_sugerida  numeric NOT NULL,
  qtde_final     numeric,
  preco_unitario numeric
);
-- A RPC e SECURITY INVOKER: o role do chamador precisa de acesso as TABELAS, como na PROD.
-- Concedido aos DOIS roles de proposito: assim o unico eixo que separa `authenticated` de
-- `anon` no grupo A e o EXECUTE da FUNCAO -- se o grant de tabela faltasse em `anon`, o A2
-- ficaria verde pelo motivo errado (barrado pela tabela, nao pelo privilegio da funcao).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pedido_compra_sugerido TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pedido_compra_item     TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL (Lei #1: prova o ARQUIVO, nao uma copia) + a VIA CRUA
#          REAL (o que `useDetalhesModal.recalcularPedido` fazia), para o baseline do bug
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$MIGRATION"

# A via CRUA, transcrita do front: DELETE sem guard + UPDATE sem NENHUM predicado de status.
# Existe SO para o grupo R provar que a corrida REALMENTE corrompe sem a fronteira.
P -q <<'SQL'
CREATE FUNCTION public.via_crua_do_front(p_pedido_id bigint, p_item_ids bigint[], p_usuario text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_rest integer; v_total numeric;
BEGIN
  DELETE FROM pedido_compra_item WHERE id = ANY(p_item_ids);
  SELECT count(*)::integer, COALESCE(SUM(COALESCE(qtde_final,qtde_sugerida,0)*COALESCE(preco_unitario,0)),0)
    INTO v_rest, v_total FROM pedido_compra_item WHERE pedido_id = p_pedido_id;
  IF v_rest = 0 THEN
    UPDATE pedido_compra_sugerido
       SET valor_total=0, num_skus=0, status='cancelado_humano', cancelado_por=p_usuario,
           cancelado_em=NOW(), justificativa_cancelamento='Todos os itens foram removidos manualmente',
           status_envio_portal='nao_aplicavel', portal_proximo_retry_em=NULL, atualizado_em=NOW()
     WHERE id = p_pedido_id;
  ELSE
    UPDATE pedido_compra_sugerido SET valor_total=v_total, num_skus=v_rest, atualizado_em=NOW()
     WHERE id = p_pedido_id;
  END IF;
  RETURN 'via-crua-gravou';
END $$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
semear() {
  P -q <<'SQL'
TRUNCATE public.pedido_compra_sugerido CASCADE;
INSERT INTO public.pedido_compra_sugerido (id, status, status_envio_portal, portal_proximo_retry_em, horario_disparo_real, valor_total, num_skus) VALUES
  (1, 'pendente_aprovacao',          'nao_aplicavel',         NULL,                      NULL,                                    250, 2),
  (2, 'bloqueado_guardrail',         'nao_aplicavel',         NULL,                      NULL,                                    100, 1),
  (3, 'aprovado_aguardando_disparo', 'pendente_envio_portal', now() + interval '15 min', NULL,                                    100, 1),
  (4, 'disparado',                   'enviado_portal',        NULL,                      timestamptz '2026-09-01 10:00:00+00',    100, 1),
  (5, 'concluido_recebido',          'enviado_portal',        NULL,                      timestamptz '2026-08-20 09:00:00+00',    100, 1),
  (6, 'falha_envio',                 'nao_aplicavel',         NULL,                      NULL,                                    100, 1),
  (7, 'pendente_aprovacao',          'nao_aplicavel',         NULL,                      NULL,                                    100, 1),
  (8, 'aprovado_aguardando_disparo', 'nao_aplicavel',         NULL,                      NULL,                                    100, 1),
  (9, 'aprovado_aguardando_disparo', 'nao_aplicavel',         NULL,                      NULL,                                    100, 1),
  (10,'aprovado_aguardando_disparo', 'nao_aplicavel',         NULL,                      NULL,                                    100, 1);
INSERT INTO public.pedido_compra_item (id, pedido_id, sku_codigo_omie, qtde_sugerida, qtde_final, preco_unitario) VALUES
  (11, 1, 'SKU-A', 2, 2, 100),   -- 200
  (12, 1, 'SKU-B', 1, 1,  50),   --  50  => pedido 1 vale 250
  (21, 2, 'SKU-C', 1, 1, 100),
  (31, 3, 'SKU-D', 1, 1, 100),
  (41, 4, 'SKU-E', 1, 1, 100),
  (51, 5, 'SKU-F', 1, 1, 100),
  (61, 6, 'SKU-G', 1, 1, 100),
  (71, 7, 'SKU-H', 1, 1, 100),
  (81, 8, 'SKU-I', 1, 1, 100),
  (91, 9, 'SKU-J', 1, 1, 100),
  (101,10,'SKU-K', 1, 1, 100);
SQL
}
remover() { Pq -c "SELECT public.remover_itens_pedido_sugerido($1, ARRAY[$2]::bigint[], 'lucas')::text;"; }
campo()   { Pq -c "SELECT COALESCE($2::text,'<null>') FROM public.pedido_compra_sugerido WHERE id=$1;"; }
itens()   { Pq -c "SELECT count(*) FROM public.pedido_compra_item WHERE pedido_id=$1;"; }

semear

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "-- grupo P: positivos (remove, recalcula DO BANCO, cancela ao esvaziar) --"
eq "P1 remove 1 de 2 itens: ok, sobra 1"         "$(remover 1 12)" '{"status": "ok", "cancelado": false, "pedido_id": 1, "removidos": 1, "restantes": 1, "valor_total": 200}'
eq "P2 o total foi RECALCULADO (250 -> 200)"     "$(campo 1 valor_total)" '200'
eq "P3 num_skus recalculado (2 -> 1)"            "$(campo 1 num_skus)"    '1'
eq "P4 status intacto (nao cancelou)"            "$(campo 1 status)"      'pendente_aprovacao'
eq "P5 remove o ULTIMO item: cancela"            "$(remover 1 11)" '{"status": "ok", "cancelado": true, "pedido_id": 1, "removidos": 1, "restantes": 0, "valor_total": 0}'
eq "P6 status virou cancelado_humano"            "$(campo 1 status)" 'cancelado_humano'
eq "P7 justificativa carimbada"                  "$(campo 1 justificativa_cancelamento)" 'Todos os itens foram removidos manualmente'
eq "P8 cancelado_por carimbado"                  "$(campo 1 cancelado_por)" 'lucas'
eq "P9 higiene do portal: nao_aplicavel"         "$(campo 1 status_envio_portal)" 'nao_aplicavel'
eq "P10 higiene do portal: retry zerado"         "$(campo 1 portal_proximo_retry_em)" '<null>'
eq "P11 valor_total zerado no cancelamento"      "$(campo 1 valor_total)" '0'
eq "P12 bloqueado_guardrail tambem passa"        "$(remover 2 21)" '{"status": "ok", "cancelado": true, "pedido_id": 2, "removidos": 1, "restantes": 0, "valor_total": 0}'
eq "P13 remocao em LOTE (2 ids de uma vez)"      "$(Pq -c "SELECT (public.remover_itens_pedido_sugerido(7, ARRAY[71,999]::bigint[], 'lucas'))->>'removidos';")" '1'

echo "-- grupo N: negativos (fora da allowlist: RECUSA e NAO TOCA a linha) --"
semear
eq "N1 disparado e recusado"                     "$(remover 4 41)" '{"error": "pedido não permite remoção de itens (status atual: disparado)"}'
eq "N2 ... e o item CONTINUA la"                 "$(itens 4)" '1'
eq "N3 ... e o status nao mudou"                 "$(campo 4 status)" 'disparado'
eq "N4 concluido_recebido e recusado"            "$(remover 5 51)" '{"error": "pedido não permite remoção de itens (status atual: concluido_recebido)"}'
eq "N5 ... e o item CONTINUA la"                 "$(itens 5)" '1'
# N6 e o CENTRO da allowlist: a DENYLIST do cancelamento (`NOT IN ('disparado','concluido_recebido')`)
# deixaria este caso PASSAR -- e este e o estado que a edge `disparar-pedidos-aprovados`
# seleciona para chamar o Omie. Se este assert ficar verde com uma denylist, ele nao mede nada.
eq "N6 aprovado_aguardando_disparo e recusado"   "$(remover 3 31)" '{"error": "pedido não permite remoção de itens (status atual: aprovado_aguardando_disparo)"}'
eq "N7 ... e o item CONTINUA la (o Omie vai le-lo)" "$(itens 3)" '1'
eq "N8 falha_envio e recusado"                   "$(remover 6 61)" '{"error": "pedido não permite remoção de itens (status atual: falha_envio)"}'
eq "N9 pedido inexistente"                       "$(remover 4242 41)" '{"error": "pedido não encontrado"}'
eq "N10 lista de itens vazia"                    "$(Pq -c "SELECT public.remover_itens_pedido_sugerido(1, ARRAY[]::bigint[], 'lucas')::text;")" '{"error": "nenhum item informado"}'
eq "N11 lista de itens NULL"                     "$(Pq -c "SELECT public.remover_itens_pedido_sugerido(1, NULL::bigint[], 'lucas')::text;")" '{"error": "nenhum item informado"}'

echo "-- grupo V: vazamento entre pedidos (o id de item de OUTRO pedido nao vai de carona) --"
semear
# 41 pertence ao pedido 4 (disparado). Pedir a remocao dele PELO pedido 7 (que passa no guard)
# nao pode apaga-lo: sem o `pedido_id = p_pedido_id` no DELETE, apagaria.
eq "V1 id de item alheio nao e removido"         "$(Pq -c "SELECT (public.remover_itens_pedido_sugerido(7, ARRAY[41]::bigint[], 'lucas'))->>'removidos';")" '0'
eq "V2 ... o item do pedido disparado sobrevive" "$(itens 4)" '1'
# V3: o recalculo assume visibilidade TOTAL dos itens (policy uniforme `cap_compras_ler(uid)`,
# medida na PROD em 2026-09-06). Se um dia entrar policy POR LINHA nesta tabela, `restantes=0`
# deixa de significar "pedido vazio" e a funcao passa a cancelar pedido que ainda tem item.
# Este assert congela a premissa: o pedido 7 tem 1 item e o recalculo TEM de enxerga-lo.
eq "V3 recalculo enxerga o item que sobrou"      "$(Pq -c "SELECT (public.remover_itens_pedido_sugerido(7, ARRAY[999]::bigint[], 'lucas'))->>'restantes';")" '1'

echo "-- grupo A: ACL (o eixo que DROP+CREATE quebra) --"
# A1: authenticated (quem o botao usa) executa. RLS desligada aqui de proposito: o eixo
# medido e o EXECUTE da FUNCAO, nao a policy da tabela -- misturar os dois faria o assert
# ficar verde/vermelho pelo motivo errado.
semear
eq "A1 authenticated EXECUTA a RPC" \
  "$(Pq -c "SET ROLE authenticated; SELECT (public.remover_itens_pedido_sugerido(7, ARRAY[71]::bigint[], 'lucas'))->>'status';" 2>&1 | tail -1)" 'ok'
# A2: anon NAO executa. Captura a SQLSTATE ESPERADA e RE-LANCA o resto (regra anti-teatro:
# `WHEN OTHERS THEN 'OK'` aprovaria qualquer erro, inclusive um typo no nome da funcao).
eq "A2 anon recebe 42501 (insufficient_privilege)" \
  "$(Pq -c "SET ROLE anon; DO \$t\$ BEGIN PERFORM public.remover_itens_pedido_sugerido(7, ARRAY[71]::bigint[], 'x'); RAISE EXCEPTION 'NAO-BARROU'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'BARROU-42501'; END \$t\$;" 2>&1 | grep -c 'BARROU-42501')" '1'
# A2b: falsifica A2 -- concede o EXECUTE a anon e exige que a chamada PASSE. Se continuasse
# negada, o 42501 de A2 nao vinha do EXECUTE e A2 nao mediria nada.
semear
P -q -c "GRANT EXECUTE ON FUNCTION public.remover_itens_pedido_sugerido(bigint,bigint[],text) TO anon;"
eq "A2b com EXECUTE concedido, anon PASSA (falsifica A2)" \
  "$(Pq -c "SET ROLE anon; SELECT (public.remover_itens_pedido_sugerido(7, ARRAY[71]::bigint[], 'x'))->>'status';" 2>&1 | tail -1)" 'ok'
P -q -c "REVOKE EXECUTE ON FUNCTION public.remover_itens_pedido_sugerido(bigint,bigint[],text) FROM anon;"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4b — A CORRIDA (o centro desta migration), com BARREIRA OBSERVAVEL
#
# ⚠️ `sleep 0.8` NAO e barreira: se o disparador commitar antes de B comecar, ate a VIA CRUA
# produz o resultado "certo" -- R2 ficaria verde sem nunca ter exercitado a espera no lock.
# Aqui a ordem e OBSERVADA, nao esperada:
#   1. A abre transacao, trava a linha do pedido, leva a 'disparado' e segura um advisory lock;
#   2. B e lancada e vai bloquear no lock de A;
#   3. o orquestrador POLLA `pg_blocking_pids` ate VER B bloqueada -- e so entao libera A;
#   4. se o bloqueio nao for observado, o assert falha dizendo que nao mediu a corrida.
# ══════════════════════════════════════════════════════════════════════════════
P -q -c "CREATE TABLE IF NOT EXISTS public.barreira (nome text PRIMARY KEY);" >/dev/null

lancar_bloqueador() {   # $1 = id que A trava; $2 = status destino (default 'disparado')
  # O UPDATE vive DENTRO de um DO para poder exigir `FOUND`: se ele nao pegar a linha, a
  # transacao aborta e o `wait` reprova -- em vez de a corrida "acontecer" sobre zero linhas
  # e o assert medir nada. O advisory lock e adquirido DEPOIS do UPDATE: e o sinal, observavel
  # de outra sessao, de que A ja travou a linha e so entao B pode ser lancada.
  P -q >/dev/null <<SQL &
BEGIN;
DO \$u\$
BEGIN
  UPDATE public.pedido_compra_sugerido
     SET status = '${2:-disparado}',
         omie_pedido_compra_id = 'PO-REAL-NO-OMIE',
         horario_disparo_real = timestamptz '2026-09-06 12:00:00+00'
   WHERE id = $1 AND status = 'aprovado_aguardando_disparo';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BLOQUEADOR: o UPDATE do disparador nao pegou a linha % -- a corrida nao mediria nada', $1;
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

# Ecoa "sim" quando A ja segura o advisory lock (⇒ o UPDATE dele ja pegou a linha).
# ⚠️ Sem esta espera o harness FICA FLAKY e mente: se B rodar antes de A, o UPDATE de A nao
# casa `status='aprovado_aguardando_disparo'`, ninguem bloqueia e o assert mede outra coisa.
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

# $1 = id do pedido; $2 = SQL da chamada de B. Ecoa "<status final>|<itens restantes>|<bloqueio visto>"
corrida() {   # $3 = status destino do bloqueador (default 'disparado')
  local id="$1" chamada="$2" destino="${3:-disparado}" out bpid visto
  out="$(mktemp /tmp/corrida-b.XXXXXX)"
  P -q -c "DELETE FROM public.barreira;" >/dev/null
  lancar_bloqueador "$id" "$destino"
  if [ "$(esperar_A_travar)" != "sim" ]; then
    liberar_A; wait "$BLOQ_PID" || true; rm -f "$out"
    echo "A-NAO-TRAVOU|A-NAO-TRAVOU|A-NAO-TRAVOU"; return
  fi
  Pq -c "$chamada" > "$out" 2>&1 &
  bpid=$!
  visto="$(esperar_bloqueio)"
  liberar_A
  wait "$bpid" || true
  if ! wait "$BLOQ_PID"; then rm -f "$out"; echo "BLOQUEADOR-FALHOU|BLOQUEADOR-FALHOU|BLOQUEADOR-FALHOU"; return; fi
  echo "$(campo "$id" status)|$(itens "$id")|$visto"
  rm -f "$out"
}

echo "-- grupo R: corrida real (2 conexoes, barreira observada) --"
semear
# R1 = BASELINE DO BUG. A via CRUA do front nao tem predicado de status: quando A commita
# 'disparado', o `UPDATE ... WHERE id` continua casando e carimba o cancelamento por cima de
# uma COMPRA REAL. Se este assert vier verde (= nao corrompeu), a corrida nao aconteceu e R2
# nao prova nada.
R1="$(corrida 8 "SELECT public.via_crua_do_front(8, ARRAY[81]::bigint[], 'lucas');")"
eq "R1 BASELINE: a via CRUA corrompe (cancela sobre a compra real)" "$R1" 'cancelado_humano|0|sim'
# R2 = a fronteira, na MESMA corrida. O `SELECT ... FOR NO KEY UPDATE` espera A commitar e
# rele 'disparado' (EvalPlanQual) -> a allowlist recusa e NADA e escrito.
R2="$(corrida 9 "SELECT public.remover_itens_pedido_sugerido(9, ARRAY[91]::bigint[], 'lucas')::text;")"
eq "R2 a FRONTEIRA recusa na mesma corrida e nao toca a linha" "$R2" 'disparado|1|sim'

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICACAO. Sabota UMA camada por vez e exige o vermelho CERTO.
#
# ⚠️ CONTROLE VERDE NA MESMA INVOCACAO (licao do #2219): uma sabotagem sempre-vermelha
# aprova qualquer coisa. Antes de sabotar, o mesmo predicado roda sobre o corpo BOM e TEM de
# vir verde -- se o controle falhar, o laco aborta ANTES do primeiro `sed`.
# ══════════════════════════════════════════════════════════════════════════════
echo "-- grupo F: falsificacao (controle verde primeiro, depois sabotagem) --"
SAB_DIR="$(mktemp -d /tmp/sabotagem.XXXXXX)"

# aplica_variante <arquivo-sql> -> ecoa 'ABORTOU' se a postcondicao gritou, 'PASSOU' se nao.
aplica_variante() {
  P -q -c "DROP FUNCTION IF EXISTS public.remover_itens_pedido_sugerido(bigint, bigint[], text);" >/dev/null 2>&1
  if P -q -f "$1" >"$SAB_DIR/out.txt" 2>&1; then echo "PASSOU"; else echo "ABORTOU"; fi
}

# ── F-post: a POSTCONDICAO da propria migration pega a sabotagem estrutural? ──
# CONTROLE: o arquivo INTACTO tem de aplicar limpo. Sem isto, um "ABORTOU" abaixo poderia ser
# so a migration estando quebrada por outro motivo, e as 4 sabotagens aprovariam qualquer coisa.
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

# ⚠️ O padrao ancora o `;` final: sem ele o sed batia TAMBEM nas duas mencoes dentro da
# postcondicao (o regex do assert e a mensagem), e a migration abortava por SYNTAX ERROR --
# vermelho pelo motivo errado, que aprovaria a sabotagem sem medir o assert.
sabota "F1 sem o lock do pai, a postcondicao grita" \
       's/^     FOR NO KEY UPDATE;$/     ;/' 'SEM-LOCK'
sabota "F2 allowlist -> denylist, a postcondicao grita" \
       "s/v_status NOT IN ('pendente_aprovacao', 'bloqueado_guardrail')/v_status IN ('disparado', 'concluido_recebido')/" 'ALLOWLIST'
sabota "F3 SECURITY INVOKER -> DEFINER, a postcondicao grita" \
       's/^LANGUAGE plpgsql$/LANGUAGE plpgsql SECURITY DEFINER/' 'SECDEF'
# ⚠️ F4 REVOGA em vez de apenas apagar a linha do GRANT. Sob os default privileges do Supabase
# (reproduzidos no setup), `authenticated` ja recebe EXECUTE ao criar a funcao -- entao apagar o
# GRANT explicito NAO tira o privilegio e a sabotagem seria SEMPRE-VERDE. O que o assert
# ACL-EXECUTE da postcondicao promete e o RESULTADO ("authenticated executa"), e a unica
# sabotagem que o testa e remover esse resultado. (O GRANT explicito na migration continua
# valendo como defesa se os default privileges mudarem -- ele so nao e o que este assert mede.)
sabota "F4 sem o EXECUTE de authenticated, a postcondicao grita" \
       's/^GRANT EXECUTE ON FUNCTION public.remover_itens_pedido_sugerido(bigint, bigint\[\], text) TO authenticated;/REVOKE ALL ON FUNCTION public.remover_itens_pedido_sugerido(bigint, bigint[], text) FROM authenticated;/' 'ACL-EXECUTE'
sabota "F5 sem o REVOKE de anon, a postcondicao grita" \
       's/^REVOKE ALL ON FUNCTION public.remover_itens_pedido_sugerido(bigint, bigint\[\], text) FROM anon;/-- revoke removido pela sabotagem/' 'ACL-ANON'

# ── F-comp: sabotagem de COMPORTAMENTO (variantes que a postcondicao nao veria) ──
# A postcondicao e TEXTUAL; estas provas sao de EFEITO. Cada variante e criada com OUTRO nome,
# para nao passar pelos asserts estruturais, e o assert-alvo tem de ficar VERMELHO.
P -q -f "$MIGRATION" >/dev/null   # restaura o corpo bom antes das provas de efeito
semear

# F6: variante SEM o `pedido_id = p_pedido_id` no DELETE -> o item alheio DEVE ser apagado
# (= V1/V2 ficariam vermelhos). Prova que V1/V2 medem esse predicado, e nao outra coisa.
P -q <<'SQL'
CREATE FUNCTION public.variante_sem_escopo(p_pedido_id bigint, p_item_ids bigint[])
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v integer;
BEGIN
  WITH a AS (DELETE FROM pedido_compra_item WHERE id = ANY(p_item_ids) RETURNING id)
  SELECT count(*)::integer INTO v FROM a;
  RETURN v;
END $$;
SQL
eq "F6 sem o escopo por pedido, o item alheio CAI (falsifica V1/V2)" \
   "$(Pq -c "SELECT public.variante_sem_escopo(7, ARRAY[41]::bigint[]);")" '1'
eq "F6b ... confirmando que o pedido 4 ficou sem o item"  "$(itens 4)" '0'

# F7: o CONTROLE do proprio R1/R2 -- a via crua e a fronteira sobre o MESMO estado, SEM corrida.
# Se a fronteira recusasse sempre (bug que faria R2 verde de graca), este assert pegaria.
# F7 falsifica o proprio R2: se a fronteira recusasse por ESPERAR NO LOCK (e nao por reler o
# status), R2 ficaria verde de graca. Aqui a corrida e IDENTICA -- mesma barreira, mesmo lock --
# mas o bloqueador leva o pedido a um status AINDA DENTRO da allowlist. A fronteira tem de
# ACEITAR. Verde aqui + verde em R2 = a recusa de R2 veio do STATUS RELIDO, nao da espera.
semear
F7="$(corrida 10 "SELECT public.remover_itens_pedido_sugerido(10, ARRAY[101]::bigint[], 'lucas')::text;" 'bloqueado_guardrail')"
eq "F7 corrida que NAO sai da allowlist: a fronteira ACEITA (falsifica R2)" "$F7" 'cancelado_humano|0|sim'

rm -rf "$SAB_DIR"

# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== RESULTADO: $PASS OK, $FAIL FAIL (lc_messages=$HARNESS_LC) ==="
[ "$FAIL" -eq 0 ]
