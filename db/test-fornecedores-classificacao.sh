#!/usr/bin/env bash
# Prova PG17 de "fornecedor fora da carteira" — a régua de classificação (classificar_clientes_fornecedores),
# a limpeza recorrente (aplicar_exclusao_fornecedores), a reversão pelo master (reverter_exclusao_fornecedor)
# e o trigger que deriva is_fornecedor (cliente_classificacao_derive) — contra o schema que PRODUÇÃO executa
# (db/lib/corpo-vivo.sh: snapshot + ACL medido em prod + a cadeia viva das 4 funções, dos triggers que o
# seed e a limpeza disparam — o da carteira, o guard e os de coerência de sales_orders no seed, o
# farmer_expirar_pendentes_do_dono_anterior no DELETE da aplicar — e das tabelas que elas leem e escrevem;
# hoje 5 migrations: o trigger de coerência e o GRANT por coluna do funil em sales_orders, a
# 20261001014100 do #2726 e as 2 que levam a melhoria_clientes_por_produto até o predecessor que o PRE
# dela exige). Aplicar, reverter e o trigger são IGUAIS aos do snapshot (md5 = o de prod, medido em
# 2026-10-01); a classificar é a PRÓXIMA — a da 20261104113000 (plano v5 lote 10: diff-before-write, só escreve a
# linha cuja classificação mudou), que a prod recebe quando a migration for aplicada.
#
# O que ela assevera (cada regra com sabotagem própria; os positivos são as pré-condições que as
# sabotagens exigem verdes):
#  • a régua A: fornecedor (tag 'fornecedor'/'transportadora', sem caixa nem espaço) SEM venda real sai
#    da carteira; a exceção curada vence; o cliente comum fica; o fornecedor COM venda real fica — e
#    cancelado, rascunho, pendente, orçamento e o pedido APAGADO não são venda, na coluna e na decisão. A RPC reescreve as 3
#    flags nas DUAS direções: o K00 corrompe CADA linha para o valor ERRADO (e lê o estado corrompido),
#    então cada flag é posta e tirada em algum cliente — e devolve a contagem certa;
#  • a limpeza: a aplicar RE-CLASSIFICA antes de limpar (o cron chama só ela), desliga o eligible e apaga
#    os scores (visita e farmer) dos excluídos — e só deles;
#  • a reversão: só o master (o gate é INTERNO — authenticated tem EXECUTE em prod); cria a exceção,
#    tira a flag, religa o eligible (menos o alias fiscal ATIVO, que segue fora; o INATIVO volta) e
#    enfileira as DUAS filas de recálculo, com o motivo e o dono — e toca SÓ o alvo: o eligible, a flag e as
#    filas dos outros clientes ficam como estavam (sem o WHERE, um clique do master reescreveria a carteira
#    inteira); o employee não reverte nem escreve a exceção direto na tabela (a porta dos fundos do gate);
#  • o ACL de prod: classificar e aplicar são só do service_role; o anon não executa a reversão (nega o
#    EXECUTE, camada nomeada);
#  • o trigger: deriva is_fornecedor no INSERT e no UPDATE OF tags_omie (caixa e espaço), e NÃO decide a
#    exclusão (é da RPC, que conhece as vendas e a exceção);
#  • o diff-before-write (bloco D, medido por xmin e updated_at de cada linha): a linha nova é classificada, a
#    2ª execução sem mudança não escreve NADA, a mudança de UMA flag (cada uma das 3, numa linha diferente)
#    escreve só aquela linha, a linha removida só sai da contagem — e o retorno conta total|alterados|excluídos;
#  • a guarda de corrida (bloco R, 2 sessões de verdade): tags mudadas por outra transação DURANTE a execução
#    não são sobrescritas pela régua calculada sobre as tags velhas (R0 mede que a execução ESPEROU o lock).
# Fora daqui, de propósito: o guard fcs_block_flagged_insert, que impede o score de um excluído de
# ressuscitar (db/test-fcs-guard-flagged.sh — FORA do núcleo: verde na varredura de 2026-09-28, mas não
# barra merge). Aqui ele só explica a ordem do seed: os scores nascem antes
# de alguém ser marcado, senão o guard os descartaria calado e "os scores do excluído foram apagados"
# passaria por AUSÊNCIA — por isso A1 mede que eles existem antes da limpeza.
#
# O trigger que FABRICA a pré-condição: trg_carteira_reconcile_score_owner cria a linha de
# farmer_client_scores de todo cliente que entra na carteira. Foi ele que matou a versão anterior (o seed
# a inseria de novo → 23505 farmer_client_scores_customer_unique, medido executando em 2026-10-01); aqui
# os scores de farmer vêm DELE, e V0 mede que as filas de recálculo estão vazias antes da reversão.
#
# Até 2026-10-01 esta prova re-aplicava as migrations de junho (20260606170000/0100) sobre o snapshot —
# revertendo as posteriores (0618, 0621, 0718) — e morreu no seed em 06-25 (re-dump 1c05aa8e3), 95 dias fora
# do núcleo. O assert do gate aceitava qualquer erro (`WHEN others THEN barrou := true`). Histórico:
# docs/historico/provas-db-mortas-fora-do-nucleo.md e docs/historico/provas-carteira-revividas.md.
#
# MODOS
#   bash db/test-fornecedores-classificacao.sh               # cenário no schema vivo → PASS=<n>  FAIL=<m>
#   bash db/test-fornecedores-classificacao.sh --falsificar  # controle VERDE + sabotagens → SABOTAGENS: …
# O banco-base (snapshot + ACL + cadeia + seed) sobe UMA vez; cada rodada roda num clone dele (CREATE
# DATABASE … TEMPLATE), então controle e sabotagens partem do mesmo estado.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5486}"
TMPD="$(mktemp -d /tmp/pgtest-fornec.XXXXXX)"
DATA="$TMPD/data"
export LC_ALL=C LANG=C

MODO=normal
case "${1:-}" in
  '') ;;
  --falsificar) MODO=falsificar ;;
  *) echo "uso: $0 [--falsificar]" >&2; exit 2 ;;
esac

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

# Socket num diretório exclusivo e sem TCP: a porta deixa de ser recurso disputado entre provas.
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMPD -c listen_addresses='' -c autovacuum=off" \
  -l "$TMPD/pg.log" -w start >/dev/null
DB=base
P()   { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d "$DB" "$@"; }
adm() { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
adm -c "CREATE DATABASE base;"

# Os objetos que esta prova assevera — as 4 funções, os triggers que as escritas delas disparam e as
# tabelas que elas leem e escrevem: a migration nova que fizer DDL sobre eles entra na cadeia sozinha.
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_FUNCOES=(classificar_clientes_fornecedores aplicar_exclusao_fornecedores reverter_exclusao_fornecedor
            cliente_classificacao_derive reconcile_score_owner_from_carteira fcs_block_flagged_insert
            farmer_expirar_pendentes_do_dono_anterior pedido_venda_coerencia_cab pedido_venda_coerencia_lin has_role
            melhoria_clientes_por_produto)
# melhoria_clientes_por_produto não é asseverada aqui: está na lista porque a 20261001014100 (#2726), que a
# cadeia pega pela classificar, confere no PRE o predecessor de prod dela — e só a cadeia dela o alcança.
# O de v_grupo_comercial, que a cadeia NÃO alcança (o PRE das migrations que a levaram até ele reprova o
# snapshot, que perdeu barras de literais de regex), vem do fixture verbatim da prova do #2726, pelo md5.
# shellcheck disable=SC2329  # chamada pelo cv_montar (db/lib/corpo-vivo.sh), que o shellcheck sem -x não segue
cv_antes_da_cadeia() {
  cv_predecessora_view db/fixtures/universo-pedidos-predecessoras-prod-20261001.sql public.v_grupo_comercial \
    73de52bd7737a62d2828589f97661e9a
}
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_TABELAS=(cliente_classificacao fornecedor_excecao carteira_assignments sales_orders customer_visit_scores
            farmer_client_scores visit_score_recalc_queue score_recalc_queue customer_canonical_alias user_roles)
# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/corpo-vivo.sh"
echo "→ banco-base: stubs + prelude + snapshot + ACL de prod + cadeia viva…"
cv_montar

MASTER='00000000-0000-0000-0000-0000000000aa'   # master: o único que reverte
EMP='00000000-0000-0000-0000-0000000000bb'      # employee: lê, não reverte
F1='00000000-0000-0000-0000-0000000000f1'       # o dono da carteira
cid() { printf '00000000-0000-0000-0000-0000000000c%s' "$1"; }
# c1 fornecedor só com cancelado/rascunho/pendente e um enviado APAGADO · c2 fornecedor com exceção curada · c3 comum ·
# c4 'FORNECEDOR' (caixa) · c5 ' Transportadora ' (espaço; alias fiscal ATIVO de c3) · c6 fornecedor com
# venda enviada · c8 fornecedor só com orçamento · ca fornecedor sem venda, alias fiscal INATIVO de c3 ·
# c7 e c9 entram no cenário (o trigger).
echo "→ seed-base: papéis, exceção curada, carteira (o trigger cria os scores de farmer), vendas, tags, alias…"
P -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
INSERT INTO auth.users (id) VALUES ('$MASTER'), ('$EMP'), ('$F1'),
  ('$(cid 1)'), ('$(cid 2)'), ('$(cid 3)'), ('$(cid 4)'), ('$(cid 5)'), ('$(cid 6)'), ('$(cid 7)'), ('$(cid 8)'), ('$(cid 9)'),
  ('$(cid a)');
INSERT INTO public.user_roles (user_id, role) VALUES ('$MASTER', 'master'), ('$EMP', 'employee'), ('$F1', 'employee');
INSERT INTO public.fornecedor_excecao (user_id, motivo) VALUES ('$(cid 2)', 'cliente real — compra recorrente');
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, source, eligible) VALUES
  ('$(cid 1)', '$F1', 'omie', true), ('$(cid 2)', '$F1', 'omie', true), ('$(cid 3)', '$F1', 'omie', true),
  ('$(cid 4)', '$F1', 'omie', true), ('$(cid 5)', '$F1', 'omie', true), ('$(cid 6)', '$F1', 'omie', true),
  ('$(cid 8)', '$F1', 'omie', true), ('$(cid a)', '$F1', 'omie', true);
INSERT INTO public.customer_visit_scores (customer_user_id, farmer_id) VALUES ('$(cid 1)', '$F1'), ('$(cid 3)', '$F1');
INSERT INTO public.sales_orders (customer_user_id, created_by, status) VALUES
  ('$(cid 6)', '$F1', 'enviado'),  ('$(cid 1)', '$F1', 'cancelado'), ('$(cid 1)', '$F1', 'rascunho'),
  ('$(cid 1)', '$F1', 'pendente'), ('$(cid 8)', '$F1', 'orcamento');
INSERT INTO public.sales_orders (customer_user_id, created_by, status, deleted_at) VALUES ('$(cid 1)', '$F1', 'enviado', now());
INSERT INTO public.cliente_classificacao (user_id, tags_omie) VALUES
  ('$(cid 1)', ARRAY['Fornecedor']), ('$(cid 2)', ARRAY['Fornecedor']), ('$(cid 3)', ARRAY['Cliente VIP']),
  ('$(cid 4)', ARRAY['FORNECEDOR']), ('$(cid 5)', ARRAY[' Transportadora ']), ('$(cid 6)', ARRAY['Fornecedor']),
  ('$(cid 8)', ARRAY['Fornecedor']), ('$(cid a)', ARRAY['Fornecedor']);
INSERT INTO public.customer_canonical_alias (alias_user_id, canonical_user_id, status) VALUES
  ('$(cid 5)', '$(cid 3)', 'active'), ('$(cid a)', '$(cid 3)', 'inactive');
COMMIT;
SQL

PASS=0; FAIL=0; FALHOS=" "
chk() {  # <id> <descrição> <obtido> <esperado>
  if [ "$3" = "$4" ]; then echo "  ✓ $1 $2"; PASS=$((PASS+1))
  else echo "  ✗ $1 $2 — got[$3] exp[$4]"; FAIL=$((FAIL+1)); FALHOS="$FALHOS$1 "; fi
}
# q_como <papel> <uid ou ''> <sql> — a leitura COMO o app: o papel e o JWT fixados na MESMA sessão que
# lê (vários -c, um psql só), como o PostgREST faz. ON_ERROR_STOP: um SET ROLE que falhe aborta, em vez
# de deixar a leitura rodar como superusuário. Na falha, o valor é o erro — assert vermelho com o porquê.
q_como() {
  local claims ctx out
  if [ -n "$2" ]; then claims="{\"sub\":\"$2\",\"role\":\"$1\"}"; else claims="{\"role\":\"$1\"}"; fi
  ctx=(-c "SET ROLE $1" -c "SET request.jwt.claims = '$claims'" -c "$3")
  if out="$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>/dev/null)"; then printf '%s' "$out" | tr '\n' ' ' | sed 's/ *$//'
  else printf 'ERRO: %s' "$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>&1 >/dev/null | tr '\n' ' ' | cut -c1-300)"; fi
}
# st_como <papel> <uid ou ''> <sql> — o veredito do comando COMO o app: 'OK' ou a SQLSTATE, com a camada
# e o objeto que negaram quando é 42501 (prova.sqlstate, em db/lib/corpo-vivo.sh).
st_como() { q_como "$1" "$2" "SELECT prova.sqlstate(\$cmd\$$3\$cmd\$);"; }
# campo <medição em lote "k=v k=v…"> <k> — o valor de UMA chave; a medição que errou passa INTEIRA (o
# assert fica vermelho com o erro, e o juiz o reconhece como erro de execução, não como dente).
campo() { case "$1" in ERRO:*) printf '%s' "$1" ;; *) printf '%s\n' "$1" | tr ' ' '\n' | sed -n "s/^$2=//p" ;; esac; }
b() { printf "left((%s)::text, 1)" "$1"; }   # boolean → 't'/'f' (NULL vira '' e o assert acusa)
# A régua inteira numa leitura: c<n>=is_fornecedor|tem_venda_real|excluir_da_carteira (a chave é o último
# dígito do uuid de cid).
CLASSES="SELECT string_agg('c' || right(user_id::text, 1) || '=' || $(b is_fornecedor) || '|' || $(b tem_venda_real) || '|' || $(b excluir_da_carteira), ' ' ORDER BY user_id) FROM public.cliente_classificacao;"
ELEGIVEIS="SELECT string_agg('c' || right(customer_user_id::text, 1) || '=' || $(b eligible), ' ' ORDER BY customer_user_id) FROM public.carteira_assignments;"
# scores <n> — farmer|visita do cliente c<n>.
scores() { printf "(SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id = '%s') || '|' || (SELECT count(*) FROM public.customer_visit_scores WHERE customer_user_id = '%s')" "$(cid "$1")" "$(cid "$1")"; }
# fila <tabela> <n> [motivo] — pendências de recálculo do cliente c<n> (do dono F1, se o motivo vier).
fila() {
  local filtro=''
  [ -z "${3:-}" ] || filtro=" AND reason = '$3' AND farmer_id = '$F1'"
  printf "(SELECT count(*) FROM public.%s WHERE customer_user_id = '%s' AND processed_at IS NULL%s)" "$1" "$(cid "$2")" "$filtro"
}
reverter() { printf "SELECT public.reverter_exclusao_fornecedor('%s', '%s')" "$(cid "$1")" "$2"; }
# as pendências INTEIRAS das 2 filas (visita|score): o reverter enfileira só o alvo
TOTAL_FILAS="(SELECT count(*) FROM public.visit_score_recalc_queue WHERE processed_at IS NULL) || '|' || (SELECT count(*) FROM public.score_recalc_queue WHERE processed_at IS NULL)"
# A execução da RPC com o retorno inteiro: total|alterados|excluídos.
RODA="SELECT (r->>'classificados') || '|' || (r->>'alterados') || '|' || (r->>'excluidos') FROM (SELECT public.classificar_clientes_fornecedores() AS r) s;"
# foto — xmin e updated_at de cada linha, ANTES da execução; ESCRITAS/CARIMBOS — quem mudou desde a foto
# ('-' = ninguém). O xmin é a prova de escrita (versão nova da tupla); o carimbo é o contrato da coluna.
foto() {
  if P -v ON_ERROR_STOP=1 -q -c "DROP TABLE IF EXISTS prova_foto" \
       -c "CREATE TABLE prova_foto AS SELECT user_id, xmin::text AS x, updated_at FROM public.cliente_classificacao" >/dev/null 2>&1
  then printf 'OK'; else printf 'ERRO: foto'; fi
}
# roda_upd — a RPC (como service_role) e, na MESMA transação, o n_tup_upd dela (pg_stat_xact_user_tables): o nº
# FÍSICO de updates, que é o que o lote 10 cobra — o xmin diz QUAIS linhas, não QUANTAS vezes (Codex: reescrever
# 2× a mesma linha deixaria o xmin final igual). Imprime total|alterados|excluídos|updates.
roda_upd() {
  local out
  if out="$(P -v ON_ERROR_STOP=1 -tA -q -c "SET ROLE service_role" -c "BEGIN" -c "$RODA" \
       -c "SELECT n_tup_upd FROM pg_stat_xact_user_tables WHERE relid = 'public.cliente_classificacao'::regclass" -c "COMMIT" 2>&1)"
  then printf '%s' "$out" | tr '\n' '|' | sed 's/|$//'
  else printf 'ERRO: %s' "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"; fi
}
ESCRITAS="SELECT coalesce(string_agg('c' || right(cc.user_id::text, 1), ' ' ORDER BY cc.user_id), '-') FROM public.cliente_classificacao cc JOIN prova_foto f USING (user_id) WHERE cc.xmin::text <> f.x;"
CARIMBOS="SELECT coalesce(string_agg('c' || right(cc.user_id::text, 1), ' ' ORDER BY cc.user_id), '-') FROM public.cliente_classificacao cc JOIN prova_foto f USING (user_id) WHERE cc.updated_at IS DISTINCT FROM f.updated_at;"
# corrida — a sessão A (psql lendo de um FIFO) abre a transação e troca as tags de c4; a B roda a RPC, que
# bloqueia no lock de c4; só então A dá COMMIT. Imprime esperou(sim|nao)|<retorno da B>. "nao" = a corrida
# não aconteceu (a B terminou sem esperar) — o R0 acusa, e o R1 não vale por vacuidade.
corrida() {
  local fifo="$TMPD/corrida.fifo" esperou=nao pa pb
  rm -f "$fifo"; mkfifo "$fifo"
  P -v ON_ERROR_STOP=1 -q < "$fifo" > "$TMPD/corrida-a.log" 2>&1 & pa=$!
  exec 7> "$fifo"
  printf "BEGIN;\nUPDATE public.cliente_classificacao SET tags_omie = ARRAY['Cliente'] WHERE user_id = '%s';\n" "$(cid 4)" >&7
  for _ in $(seq 1 100); do
    [ "$(P -tA -c "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'")" = 1 ] && break
    sleep 0.1
  done
  q_como service_role '' "$RODA" > "$TMPD/corrida-b.out" & pb=$!
  for _ in $(seq 1 100); do
    if [ "$(P -tA -c "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")" = 1 ]; then
      esperou=sim; break
    fi
    sleep 0.1
  done
  printf 'COMMIT;\n' >&7; exec 7>&-
  wait "$pa" || true; wait "$pb" || true
  printf '%s|%s' "$esperou" "$(cat "$TMPD/corrida-b.out")"
}

cenario() {
  PASS=0; FAIL=0; FALHOS=" "
  local classes elegiveis
  echo "→ classificar (régua A) sobre flags CORROMPIDAS linha a linha para o valor ERRADO — a RPC reescreve as 3"
  # O trigger do seed deixou is_fornecedor certo; o NOT o inverte. tem_venda_real certo só no c6, e
  # excluir certo só em c1 c4 c5 c8 ca: a corrupção é o oposto disso, cliente a cliente.
  chk K00 "a corrupção entra e TODA flag fica errada (pré-condição: corrompe|régua corrompida)" \
    "$(st_como service_role '' "UPDATE public.cliente_classificacao SET is_fornecedor = NOT is_fornecedor, tem_venda_real = (user_id <> '$(cid 6)'), excluir_da_carteira = NOT (user_id IN ('$(cid 1)', '$(cid 4)', '$(cid 5)', '$(cid 8)', '$(cid a)'))")|$(q_como service_role '' "$CLASSES")" \
    "OK|c1=f|t|f c2=f|t|t c3=t|t|t c4=f|t|f c5=f|t|f c6=f|f|t c8=f|t|f ca=f|t|f"
  chk K0 "a RPC devolve classificados|excluidos (c1, c4, c5, c8, ca)" \
    "$(q_como service_role '' "SELECT (r->>'classificados') || '|' || (r->>'excluidos') FROM (SELECT public.classificar_clientes_fornecedores() AS r) s;")" "8|5"
  classes="$(q_como service_role '' "$CLASSES")"
  chk K1 "fornecedor só com cancelado/rascunho/pendente sai (is|venda|exclui)" "$(campo "$classes" c1)" "t|f|t"
  chk K2 "a exceção curada vence: o fornecedor fica" "$(campo "$classes" c2)" "t|f|f"
  chk K3 "o cliente comum fica (e as 3 flags corrompidas voltam)" "$(campo "$classes" c3)" "f|f|f"
  chk K4 "'FORNECEDOR' (caixa) é fornecedor" "$(campo "$classes" c4)" "t|f|t"
  chk K5 "' Transportadora ' (espaço) é fornecedor" "$(campo "$classes" c5)" "t|f|t"
  chk K6 "fornecedor COM venda real (enviado) fica" "$(campo "$classes" c6)" "t|t|f"
  chk K7 "orçamento não é venda: o fornecedor só com orçamento sai" "$(campo "$classes" c8)" "t|f|t"

  echo "→ aplicar (o que o cron chama): re-classifica, desliga o eligible e apaga os scores dos excluídos"
  chk A0 "a classificação está velha antes da limpeza: ninguém marcado (pré-condição)" \
    "$(st_como service_role '' "UPDATE public.cliente_classificacao SET excluir_da_carteira = false")" "OK"
  chk A1 "os scores existem antes da limpeza — farmer|visita de c1, farmer|visita de c3 (pré-condição)" \
    "$(q_como service_role '' "SELECT $(scores 1) || '|' || $(scores 3);")" "1|1|1|1"
  chk A2 "a aplicar roda (pré-condição)" "$(st_como service_role '' "SELECT public.aplicar_exclusao_fornecedores()")" "OK"
  elegiveis="$(q_como service_role '' "$ELEGIVEIS")"
  chk A3 "eligible desligado só dos excluídos (c1 c2 c3 c4 c5 c6 c8 ca)" \
    "$(for n in 1 2 3 4 5 6 8 a; do printf '%s ' "$(campo "$elegiveis" "c$n")"; done | sed 's/ $//')" "f t t f f t f f"
  chk A4 "scores apagados só dos excluídos — c1 farmer|visita, c3 farmer|visita, c6 farmer" \
    "$(q_como service_role '' "SELECT $(scores 1) || '|' || $(scores 3) || '|' || (SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id = '$(cid 6)');")" "0|0|1|1|1"

  echo "→ reverter: só o master; exceção, flag, eligible (menos o alias ativo) e as DUAS filas"
  chk V0 "antes: filas vazias — de c1 e inteiras (visita|score|total visita|total score) —, c1 excluído e fora (exclui|eligible) — pré-condição" \
    "$(q_como service_role '' "SELECT $(fila visit_score_recalc_queue 1) || '|' || $(fila score_recalc_queue 1) || '|' || $TOTAL_FILAS || '|' || (SELECT $(b excluir_da_carteira) FROM public.cliente_classificacao WHERE user_id = '$(cid 1)') || '|' || (SELECT $(b eligible) FROM public.carteira_assignments WHERE customer_user_id = '$(cid 1)');")" "0|0|0|0|t|f"
  chk V1 "o master reverte c1" "$(st_como authenticated "$MASTER" "$(reverter 1 teste-reversao)")" "OK"
  chk V2 "c1: exceção criada PELO master | flag tirada | eligible religado — e o c4 intacto (exclui|eligible)" \
    "$(q_como service_role '' "SELECT (SELECT count(*) FROM public.fornecedor_excecao WHERE user_id = '$(cid 1)' AND criado_por = '$MASTER') || '|' || (SELECT $(b excluir_da_carteira) FROM public.cliente_classificacao WHERE user_id = '$(cid 1)') || '|' || (SELECT $(b eligible) FROM public.carteira_assignments WHERE customer_user_id = '$(cid 1)') || '|' || (SELECT $(b excluir_da_carteira) FROM public.cliente_classificacao WHERE user_id = '$(cid 4)') || '|' || (SELECT $(b eligible) FROM public.carteira_assignments WHERE customer_user_id = '$(cid 4)');")" "1|f|t|t|f"
  chk V3 "as DUAS filas de recálculo de c1, com o motivo e o dono — e só ele (visita|score|total visita|total score)" \
    "$(q_como service_role '' "SELECT $(fila visit_score_recalc_queue 1 reversao_fornecedor) || '|' || $(fila score_recalc_queue 1 reversao_fornecedor) || '|' || $TOTAL_FILAS;")" "1|1|1|1"
  chk V4 "o alias fiscal ATIVO (c5) sai da exclusão mas segue fora da carteira (reverte|exclui|eligible)" \
    "$(st_como authenticated "$MASTER" "$(reverter 5 alias)")|$(q_como service_role '' "SELECT (SELECT $(b excluir_da_carteira) FROM public.cliente_classificacao WHERE user_id = '$(cid 5)') || '|' || (SELECT $(b eligible) FROM public.carteira_assignments WHERE customer_user_id = '$(cid 5)');")" "OK|f|f"
  chk V5 "o alias INATIVO (ca) não segura ninguém: volta para a carteira (reverte|exclui|eligible)" \
    "$(st_como authenticated "$MASTER" "$(reverter a alias-inativo)")|$(q_como service_role '' "SELECT (SELECT $(b excluir_da_carteira) FROM public.cliente_classificacao WHERE user_id = '$(cid a)') || '|' || (SELECT $(b eligible) FROM public.carteira_assignments WHERE customer_user_id = '$(cid a)');")" "OK|f|t"

  echo "→ o gate e o ACL (a camada que nega é nomeada)"
  chk G1 "o employee não reverte (P0001 do gate interno) e c4 fica intacto (sqlstate|exceção|exclui)" \
    "$(st_como authenticated "$EMP" "$(reverter 4 tentativa)")|$(q_como service_role '' "SELECT (SELECT count(*) FROM public.fornecedor_excecao WHERE user_id = '$(cid 4)') || '|' || (SELECT $(b excluir_da_carteira) FROM public.cliente_classificacao WHERE user_id = '$(cid 4)');")" "P0001|0|t"
  chk G2 "o anon não executa a reversão — nega o EXECUTE da função" \
    "$(st_como anon '' "$(reverter 4 anon)")" "42501/acl-funcao:reverter_exclusao_fornecedor"
  chk G3 "classificar|aplicar são só do service_role: nem o master (authenticated) executa" \
    "$(st_como authenticated "$MASTER" "SELECT public.classificar_clientes_fornecedores()")|$(st_como authenticated "$MASTER" "SELECT public.aplicar_exclusao_fornecedores()")" \
    "42501/acl-funcao:classificar_clientes_fornecedores|42501/acl-funcao:aplicar_exclusao_fornecedores"
  chk G4 "o employee não escreve a exceção direto na tabela (a porta dos fundos do gate)" \
    "$(st_como authenticated "$EMP" "INSERT INTO public.fornecedor_excecao (user_id, motivo) VALUES ('$(cid 4)', 'porta dos fundos')")" "42501/rls:fornecedor_excecao"

  echo "→ o trigger: deriva is_fornecedor no INSERT e no UPDATE OF tags_omie, e não decide a exclusão"
  chk T1 "INSERT com tag 'Fornecedor' → is_fornecedor sim, exclusão NÃO (insere|is|exclui)" \
    "$(st_como service_role '' "INSERT INTO public.cliente_classificacao (user_id, tags_omie) VALUES ('$(cid 7)', ARRAY['Fornecedor'])")|$(q_como service_role '' "SELECT $(b is_fornecedor) || '|' || $(b excluir_da_carteira) FROM public.cliente_classificacao WHERE user_id = '$(cid 7)';")" "OK|t|f"
  chk T2 "UPDATE OF tags_omie re-deriva, com espaço (nasce comum | vira ' Transportadora ')" \
    "$(st_como service_role '' "INSERT INTO public.cliente_classificacao (user_id, tags_omie) VALUES ('$(cid 9)', ARRAY['Cliente'])")|$(q_como service_role '' "SELECT $(b is_fornecedor) FROM public.cliente_classificacao WHERE user_id = '$(cid 9)';")|$(st_como service_role '' "UPDATE public.cliente_classificacao SET tags_omie = ARRAY[' Transportadora '] WHERE user_id = '$(cid 9)'")|$(q_como service_role '' "SELECT $(b is_fornecedor) FROM public.cliente_classificacao WHERE user_id = '$(cid 9)';")" \
    "OK|f|OK|t"

  # Estado aqui (K→T): exceção de c1 c2 c5 ca; c7 e c9 recém-inseridos (o trigger pôs is_fornecedor, a RPC
  # ainda não rodou para eles). A foto guarda xmin e updated_at de cada linha antes da execução: xmin diferente
  # = a linha foi ESCRITA (o UPDATE grava versão nova mesmo com valor igual — é o defeito que o lote 10 tirou).
  echo "→ diff-before-write: só a linha cuja classificação mudou é escrita (xmin e updated_at por linha)"
  chk D0 "linhas novas (c7, c9) são classificadas e só elas escritas — foto|total|alterados|excluídos|updates|xmin|carimbo|c7|c9" \
    "$(foto)|$(roda_upd)|$(q_como postgres '' "$ESCRITAS")|$(q_como postgres '' "$CARIMBOS")|$(classes="$(q_como service_role '' "$CLASSES")"; printf '%s|%s' "$(campo "$classes" c7)" "$(campo "$classes" c9)")" \
    "OK|10|2|4|2|c7 c9|c7 c9|t|f|t|t|f|t"
  chk D1 "2ª execução sem mudança: NENHUMA linha escrita (foto|total|alterados|excluídos|updates|xmin|carimbo)" \
    "$(foto)|$(roda_upd)|$(q_como postgres '' "$ESCRITAS")|$(q_como postgres '' "$CARIMBOS")" \
    "OK|10|0|4|0|-|-"
  # UMA flag por linha: c3 ganha venda real (só tem_venda_real), c2 perde a exceção (só excluir_da_carteira),
  # c6 tem is_fornecedor corrompido sem passar pelo trigger (só is_fornecedor) — cada flag sozinha tem de
  # bastar para a linha ser escrita.
  chk D2 "UMA flag muda em c2 c3 c6: só elas escritas, com a régua certa — setup|foto|total|alterados|excluídos|updates|xmin|carimbo|c2|c3|c6" \
    "$(st_como postgres '' "INSERT INTO public.sales_orders (customer_user_id, created_by, status) VALUES ('$(cid 3)', '$F1', 'enviado')")$(st_como postgres '' "DELETE FROM public.fornecedor_excecao WHERE user_id = '$(cid 2)'")$(st_como postgres '' "UPDATE public.cliente_classificacao SET is_fornecedor = false WHERE user_id = '$(cid 6)'")|$(foto)|$(roda_upd)|$(q_como postgres '' "$ESCRITAS")|$(q_como postgres '' "$CARIMBOS")|$(classes="$(q_como service_role '' "$CLASSES")"; printf '%s|%s|%s' "$(campo "$classes" c2)" "$(campo "$classes" c3)" "$(campo "$classes" c6)")" \
    "OKOKOK|OK|10|3|5|3|c2 c3 c6|c2 c3 c6|t|f|t|f|t|f|t|t|f"
  chk D3 "linha removida (c8) só sai da contagem — remove|foto|total|alterados|excluídos|updates|xmin" \
    "$(st_como postgres '' "DELETE FROM public.cliente_classificacao WHERE user_id = '$(cid 8)'")|$(foto)|$(roda_upd)|$(q_como postgres '' "$ESCRITAS")" \
    "OK|OK|9|0|4|0|-"

  # A corrida: c4 com excluir corrompido (a régua vai querer escrevê-lo) e, numa 2ª sessão ABERTA, as tags
  # dele trocadas para 'Cliente' (o trigger já põe is_fornecedor=f). A execução lê o snapshot velho (c4
  # fornecedor), espera o lock de c4 e reavalia o WHERE contra a versão nova: sem a guarda, gravaria t|f|t —
  # excluiria da carteira quem deixou de ser fornecedor.
  echo "→ corrida: tags trocadas por outra transação durante a execução não são sobrescritas"
  local corr
  corr="$(st_como postgres '' "UPDATE public.cliente_classificacao SET excluir_da_carteira = false WHERE user_id = '$(cid 4)'")|$(corrida)"
  chk R0 "a execução ESPEROU o lock da linha que a outra sessão segurava (pré-condição: corrompe|esperou)" \
    "$(printf '%s' "$corr" | cut -d'|' -f1-2)" "OK|sim"
  chk R1 "a régua velha não sobrescreve as tags novas: total|alterados|excluídos|c4 (is|venda|exclui)" \
    "$(printf '%s' "$corr" | cut -d'|' -f3-5)|$(campo "$(q_como service_role '' "$CLASSES")" c4)" "9|0|3|f|f|f"
  return 0
}

# SABOTAGENS: <nome>:<VERMELHOS>[:<VERDES>] — os asserts que TÊM de acusar a sabotagem e as
# pré-condições que TÊM de seguir verdes (`,` = E; `|` = OU). Vermelho em outra camada (setup
# quebrado, erro de execução) é quebra, não dente. As das funções trocam UM trecho do corpo vivo (âncora
# única, cv_sabotar — com contexto de linha onde o trecho se repete: a régua de tags e a lista de status
# aparecem duas vezes na classificar, uma para a coluna e outra para a decisão). As `migracao_nova_*`
# são a regressão chegando pela PRÓXIMA migration; as drop_create são a armadilha do CLAUDE.md —
# DROP+CREATE devolve o EXECUTE ao default de prod (authenticated e anon EXPLÍCITOS), que o
# `REVOKE … FROM PUBLIC` não tira: só G2/G3 distinguem, porque nomeiam a camada e o objeto.
SABOTAGENS="excecao_ignorada:K2:K1,K3,K6 venda_real_ignorada:K6:K1,K2,K3
            cancelado_vira_venda:K1:K3,K6,K7 rascunho_vira_venda:K1:K3,K6,K7 pendente_vira_venda:K1:K3,K6,K7
            orcamento_vira_venda:K7:K1,K3,K6 coluna_venda_conta_apagado:K1:K6 decisao_conta_apagado:K1:K3,K6
            coluna_venda_conta_cancelado:K1:K6 coluna_venda_conta_rascunho:K1:K6
            coluna_venda_conta_pendente:K1:K6 coluna_venda_conta_orcamento:K7:K1,K6
            coluna_tag_sem_caixa:K4:K3 coluna_tag_sem_espaco:K5:K3,K4 decisao_tag_sem_caixa:K4:K3
            decisao_tag_sem_espaco:K5:K3,K4
            isforn_pegajoso:K3:K1 isforn_nunca_liga:K1:K3 venda_pegajosa:K1:K6 venda_nunca_liga:K6:K1
            excluir_pegajoso:K3:K1 excluir_nunca_liga:K1:K3 contagem_mente:K0:K1,K3
            aplicar_sem_reclassificar:A3,A4:A2 elegivel_nao_desliga:A3:A2,A4 elegivel_desliga_todos:A3:A2,A4
            visita_fica:A4:A2,A3 farmer_fica:A4:A2,A3 visita_apaga_todos:A4:A2,A3 farmer_apaga_todos:A4:A2,A3
            reverter_sem_gate:G1:V1,G2 reverter_sem_excecao:V2:V1,V3 excecao_sem_autor:V2:V1,V3
            reverter_nao_desmarca:V2:V1,V3 reverter_nao_religa:V2:V1,V3 reverter_religa_todos:V2:V1,V3
            reverter_desmarca_todos:V2:V1,V3 reverter_ignora_alias:V4:V2,V5
            alias_qualquer_status:V5:V2,V4 reverter_sem_fila_visita:V3:V2 reverter_sem_fila_score:V3:V2
            fila_sem_motivo:V3:V2 fila_dono_errado:V3:V2 fila_toda_carteira:V3:V2
            anon_executa_reverter:G2:G1 authenticated_executa_classificar:G3:K0
            authenticated_executa_aplicar:G3:A2 excecao_employee_escreve:G4:G1
            trigger_sem_caixa:T1:K1 trigger_sem_espaco:T2:T1 trigger_decide_exclusao:T1:T2 trigger_so_no_insert:T2:T1
            migracao_nova_excecao_ignorada:K2:K1,K3 migracao_nova_drop_create_classificar:G3:K0
            migracao_nova_drop_create_sem_anon_reverter:G2:V1
            diff_ausente:D1:K0 diff_cego_isforn:D2:D1 diff_cego_venda:D2:D1 diff_cego_excluir:A3,D2:K0
            guarda_ausente:R1:R0,D1 alterados_mente:D1:K0 classificados_conta_escritas:D1:K0"

# sabotagem <nome> — troca UMA camada do schema vivo no banco da rodada. Status ≠0 = não aplicou.
sabotagem() {
  local cl='public.classificar_clientes_fornecedores()' ap='public.aplicar_exclusao_fornecedores()'
  local rv='public.reverter_exclusao_fornecedor(uuid,text)' dv='public.cliente_classificacao_derive()'
  local status="NOT IN ('cancelado','rascunho','pendente','orcamento')"
  local apagado=' AND so.deleted_at IS NULL'
  local decisao="$apagado"$'\n        )\n        AND NOT EXISTS (SELECT 1 FROM public.fornecedor_excecao'
  local coluna_venda=$'AS is_fornecedor,\n      EXISTS (\n        SELECT 1 FROM public.sales_orders so\n        WHERE so.customer_user_id = cc.user_id\n          AND so.status '
  local coluna_tag=$'cc.tags_omie,\n      EXISTS (\n        SELECT 1 FROM unnest(cc.tags_omie) t\n        WHERE '
  local decisao_tag=$'AS tem_venda_real,\n      (\n        EXISTS (\n          SELECT 1 FROM unnest(cc.tags_omie) t\n          WHERE '
  local diff_flags=$'(cc.is_fornecedor, cc.tem_venda_real, cc.excluir_da_carteira)\n          IS DISTINCT FROM (r.is_fornecedor, r.tem_venda_real, r.excluir_da_carteira)'
  local fila_fim=$'FROM public.carteira_assignments ca WHERE ca.customer_user_id = p_user_id\n  ON CONFLICT DO NOTHING;\n  GET DIAGNOSTICS '
  local so_excluidos=' IN (SELECT user_id FROM public.cliente_classificacao WHERE excluir_da_carteira)'
  case "$1" in
    excecao_ignorada)     cv_sabotar "$cl" "AND NOT EXISTS (SELECT 1 FROM public.fornecedor_excecao e WHERE e.user_id = cc.user_id)" "" ;;
    venda_real_ignorada)  cv_sabotar "$cl" $'AND NOT EXISTS (\n          SELECT 1 FROM public.sales_orders so\n          WHERE so.customer_user_id' \
                            $'AND NOT EXISTS (\n          SELECT 1 FROM public.sales_orders so\n          WHERE false AND so.customer_user_id' ;;
    cancelado_vira_venda) cv_sabotar "$cl" "$status$decisao" "NOT IN ('rascunho','pendente','orcamento')$decisao" ;;
    rascunho_vira_venda)  cv_sabotar "$cl" "$status$decisao" "NOT IN ('cancelado','pendente','orcamento')$decisao" ;;
    pendente_vira_venda)  cv_sabotar "$cl" "$status$decisao" "NOT IN ('cancelado','rascunho','orcamento')$decisao" ;;
    orcamento_vira_venda) cv_sabotar "$cl" "$status$decisao" "NOT IN ('cancelado','rascunho','pendente')$decisao" ;;
    coluna_venda_conta_cancelado)
                          cv_sabotar "$cl" "$coluna_venda$status" "${coluna_venda}NOT IN ('rascunho','pendente','orcamento')" ;;
    coluna_venda_conta_rascunho)
                          cv_sabotar "$cl" "$coluna_venda$status" "${coluna_venda}NOT IN ('cancelado','pendente','orcamento')" ;;
    coluna_venda_conta_pendente)
                          cv_sabotar "$cl" "$coluna_venda$status" "${coluna_venda}NOT IN ('cancelado','rascunho','orcamento')" ;;
    coluna_venda_conta_orcamento)
                          cv_sabotar "$cl" "$coluna_venda$status" "${coluna_venda}NOT IN ('cancelado','rascunho','pendente')" ;;
    # o pedido APAGADO não é venda (#2726), na coluna e na decisão — o c1 tem um enviado apagado
    coluna_venda_conta_apagado)
                          cv_sabotar "$cl" "$coluna_venda$status$apagado" "$coluna_venda$status" ;;
    decisao_conta_apagado) cv_sabotar "$cl" "$status$decisao" "$status${decisao#"$apagado"}" ;;
    coluna_tag_sem_caixa) cv_sabotar "$cl" "${coluna_tag}lower(trim(t))" "${coluna_tag}trim(t)" ;;
    coluna_tag_sem_espaco) cv_sabotar "$cl" "${coluna_tag}lower(trim(t))" "${coluna_tag}lower(t)" ;;
    decisao_tag_sem_caixa) cv_sabotar "$cl" "${decisao_tag}lower(trim(t))" "${decisao_tag}trim(t)" ;;
    decisao_tag_sem_espaco) cv_sabotar "$cl" "${decisao_tag}lower(trim(t))" "${decisao_tag}lower(t)" ;;
    # as 3 flags em cada direção: "pegajosa" nunca TIRA o valor corrompido, "nunca liga" nunca o PÕE
    isforn_pegajoso)      cv_sabotar "$cl" $'cc.tags_omie,\n      EXISTS (' $'cc.tags_omie,\n      cc.is_fornecedor OR EXISTS (' ;;
    isforn_nunca_liga)    cv_sabotar "$cl" $'cc.tags_omie,\n      EXISTS (' $'cc.tags_omie,\n      cc.is_fornecedor AND EXISTS (' ;;
    venda_pegajosa)       cv_sabotar "$cl" $'AS is_fornecedor,\n      EXISTS (' $'AS is_fornecedor,\n      cc.tem_venda_real OR EXISTS (' ;;
    venda_nunca_liga)     cv_sabotar "$cl" $'AS is_fornecedor,\n      EXISTS (' $'AS is_fornecedor,\n      cc.tem_venda_real AND EXISTS (' ;;
    excluir_pegajoso)     cv_sabotar "$cl" $'AS tem_venda_real,\n      (' $'AS tem_venda_real,\n      cc.excluir_da_carteira OR (' ;;
    excluir_nunca_liga)   cv_sabotar "$cl" $'AS tem_venda_real,\n      (' $'AS tem_venda_real,\n      cc.excluir_da_carteira AND (' ;;
    # o diff-before-write: sem o filtro, reescreve tudo (o defeito que o lote 10 tirou); cego a UMA flag, a
    # mudança só dela não é escrita; a guarda de corrida; e o retorno que mente sobre o que escreveu
    diff_ausente)         cv_sabotar "$cl" $'\n      AND '"$diff_flags" "" ;;
    diff_cego_isforn)     cv_sabotar "$cl" "$diff_flags" $'(cc.tem_venda_real, cc.excluir_da_carteira)\n          IS DISTINCT FROM (r.tem_venda_real, r.excluir_da_carteira)' ;;
    diff_cego_venda)      cv_sabotar "$cl" "$diff_flags" $'(cc.is_fornecedor, cc.excluir_da_carteira)\n          IS DISTINCT FROM (r.is_fornecedor, r.excluir_da_carteira)' ;;
    diff_cego_excluir)    cv_sabotar "$cl" "$diff_flags" $'(cc.is_fornecedor, cc.tem_venda_real)\n          IS DISTINCT FROM (r.is_fornecedor, r.tem_venda_real)' ;;
    guarda_ausente)       cv_sabotar "$cl" "AND cc.tags_omie IS NOT DISTINCT FROM r.tags_omie" "" ;;
    alterados_mente)      cv_sabotar "$cl" "(SELECT count(*) FROM escrita)" "(SELECT count(*) FROM regua)" ;;
    classificados_conta_escritas)
                          cv_sabotar "$cl" "SELECT (SELECT count(*) FROM regua)," "SELECT (SELECT count(*) FROM escrita)," ;;
    contagem_mente)       cv_sabotar "$cl" "FROM public.cliente_classificacao WHERE excluir_da_carteira;" "FROM public.cliente_classificacao WHERE is_fornecedor;" ;;
    aplicar_sem_reclassificar)
                          cv_sabotar "$ap" "v_class := public.classificar_clientes_fornecedores();" "v_class := '{}'::jsonb;" ;;
    elegivel_nao_desliga) cv_sabotar "$ap" "UPDATE public.carteira_assignments SET eligible = false" "UPDATE public.carteira_assignments SET eligible = eligible" ;;
    # o "só dos excluídos" de cada escrita da aplicar
    elegivel_desliga_todos) cv_sabotar "$ap" $'WHERE eligible\n     AND customer_user_id'"$so_excluidos" $'WHERE eligible\n     OR customer_user_id'"$so_excluidos" ;;
    visita_apaga_todos)   cv_sabotar "$ap" $'DELETE FROM public.customer_visit_scores\n   WHERE customer_user_id IN' $'DELETE FROM public.customer_visit_scores\n   WHERE true OR customer_user_id IN' ;;
    farmer_apaga_todos)   cv_sabotar "$ap" $'DELETE FROM public.farmer_client_scores\n   WHERE customer_user_id IN' $'DELETE FROM public.farmer_client_scores\n   WHERE true OR customer_user_id IN' ;;
    visita_fica)          cv_sabotar "$ap" $'DELETE FROM public.customer_visit_scores\n   WHERE customer_user_id IN' $'DELETE FROM public.customer_visit_scores\n   WHERE false AND customer_user_id IN' ;;
    farmer_fica)          cv_sabotar "$ap" $'DELETE FROM public.farmer_client_scores\n   WHERE customer_user_id IN' $'DELETE FROM public.farmer_client_scores\n   WHERE false AND customer_user_id IN' ;;
    reverter_sem_gate)    cv_sabotar "$rv" "IF NOT public.has_role(auth.uid(), 'master'::public.app_role) THEN" "IF false THEN" ;;
    reverter_sem_excecao) cv_sabotar "$rv" "VALUES (p_user_id, p_motivo, auth.uid()) ON CONFLICT (user_id) DO NOTHING;" "SELECT p_user_id, p_motivo, auth.uid() WHERE false;" ;;
    excecao_sem_autor)    cv_sabotar "$rv" "VALUES (p_user_id, p_motivo, auth.uid())" "VALUES (p_user_id, p_motivo, NULL)" ;;
    reverter_nao_desmarca) cv_sabotar "$rv" "SET excluir_da_carteira = false, updated_at = now() WHERE user_id = p_user_id;" "SET updated_at = now() WHERE user_id = p_user_id;" ;;
    reverter_nao_religa)  cv_sabotar "$rv" "SET eligible = NOT EXISTS (" "SET eligible = eligible AND NOT EXISTS (" ;;
    # o reverter toca SÓ o alvo: sem o WHERE, o eligible / a flag da carteira INTEIRA viram os do alvo
    reverter_religa_todos) cv_sabotar "$rv" $'\n   WHERE customer_user_id = p_user_id;' ";" ;;
    reverter_desmarca_todos) cv_sabotar "$rv" "SET excluir_da_carteira = false, updated_at = now() WHERE user_id = p_user_id;" "SET excluir_da_carteira = false, updated_at = now();" ;;
    reverter_ignora_alias) cv_sabotar "$rv" "WHERE cca.alias_user_id = p_user_id AND cca.status = 'active'" "WHERE false" ;;
    alias_qualquer_status) cv_sabotar "$rv" "WHERE cca.alias_user_id = p_user_id AND cca.status = 'active'" "WHERE cca.alias_user_id = p_user_id" ;;
    reverter_sem_fila_visita)
                          cv_sabotar "$rv" "${fila_fim}v_enfileirados" "$(printf '%s' "${fila_fim}v_enfileirados" | sed 's/ca.customer_user_id = p_user_id/false/')" ;;
    reverter_sem_fila_score)
                          cv_sabotar "$rv" "${fila_fim}v_tmp" "$(printf '%s' "${fila_fim}v_tmp" | sed 's/ca.customer_user_id = p_user_id/false/')" ;;
    # o motivo e o dono que o V3 filtra: a fila de visita sem o motivo, a de score com o cliente no lugar do dono
    fila_sem_motivo)      cv_sabotar "$rv" "'reversao_fornecedor'"$'\n    '"${fila_fim}v_enfileirados" "'outro_motivo'"$'\n    '"${fila_fim}v_enfileirados" ;;
    fila_dono_errado)     cv_sabotar "$rv" "ca.owner_user_id, 'reversao_fornecedor'"$'\n    '"${fila_fim}v_tmp" "ca.customer_user_id, 'reversao_fornecedor'"$'\n    '"${fila_fim}v_tmp" ;;
    fila_toda_carteira)   cv_sabotar "$rv" "${fila_fim}v_enfileirados" "$(printf '%s' "${fila_fim}v_enfileirados" | sed 's/ca.customer_user_id = p_user_id/true/')" ;;
    anon_executa_reverter)  P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION $rv TO anon;" ;;
    authenticated_executa_classificar) P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION $cl TO authenticated;" ;;
    authenticated_executa_aplicar)     P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION $ap TO authenticated;" ;;
    excecao_employee_escreve)
                          P -v ON_ERROR_STOP=1 -q -c "ALTER POLICY \"master manage excecao\" ON public.fornecedor_excecao WITH CHECK (public.has_role(auth.uid(), 'master'::app_role) OR public.has_role(auth.uid(), 'employee'::app_role));" ;;
    trigger_sem_caixa)    cv_sabotar "$dv" "lower(trim(t))" "trim(t)" ;;
    trigger_sem_espaco)   cv_sabotar "$dv" "lower(trim(t))" "lower(t)" ;;
    trigger_decide_exclusao) cv_sabotar "$dv" "RETURN NEW;" $'NEW.excluir_da_carteira := NEW.is_fornecedor;\n  RETURN NEW;' ;;
    trigger_so_no_insert) P -v ON_ERROR_STOP=1 -q -c "DROP TRIGGER trg_cliente_classificacao_derive ON public.cliente_classificacao;" \
                            -c "CREATE TRIGGER trg_cliente_classificacao_derive BEFORE INSERT ON public.cliente_classificacao FOR EACH ROW EXECUTE FUNCTION public.cliente_classificacao_derive();" ;;
    migracao_nova_excecao_ignorada)
                          cv_migracao_nova "$cl" "AND NOT EXISTS (SELECT 1 FROM public.fornecedor_excecao e WHERE e.user_id = cc.user_id)" "" ;;
    migracao_nova_drop_create_classificar)
                          cv_migracao_nova "$cl" "CREATE OR REPLACE FUNCTION public.classificar_clientes_fornecedores(" \
                            $'DROP FUNCTION public.classificar_clientes_fornecedores();\nCREATE FUNCTION public.classificar_clientes_fornecedores(' ;;
    migracao_nova_drop_create_sem_anon_reverter)
                          cv_migracao_nova "$rv" "CREATE OR REPLACE FUNCTION public.reverter_exclusao_fornecedor(" \
                            $'DROP FUNCTION public.reverter_exclusao_fornecedor(uuid, text);\nCREATE FUNCTION public.reverter_exclusao_fornecedor(' \
                            "REVOKE ALL ON FUNCTION $rv FROM PUBLIC; GRANT EXECUTE ON FUNCTION $rv TO authenticated, service_role;" ;;
    *) echo "sabotagem desconhecida: $1" >&2; return 1 ;;
  esac
}

# rodada <sabotagem|""> — clona o banco-base e roda o cenário no clone. Exit 3 = a sabotagem não
# aplicou (âncora sumiu do schema vivo); exit 4 = o clone falhou (a rodada não pode seguir no banco da
# sabotagem anterior). Os dois são FALHA da falsificação, nunca dente.
rodada() {
  adm -c "DROP DATABASE IF EXISTS rodada;" -c "CREATE DATABASE rodada TEMPLATE base;" || return 4
  DB=rodada
  if [ -n "$1" ]; then sabotagem "$1" || return 3; fi
  cenario
}

if [ "$MODO" = normal ]; then
  rodada ""
  echo ""
  echo "════════════════════════════════════════"
  echo "  PASS=$PASS  FAIL=$FAIL"
  echo "════════════════════════════════════════"
  [ "$FAIL" -eq 0 ]
  exit $?
fi

# ── --falsificar ───────────────────────────────────────────────────────────────────────────────
# Sabotar sem CONTROLE verde na MESMA invocação é teatro: uma suíte sempre-vermelha (ambiente
# quebrado, snapshot que não sobe) aprovaria todas as sabotagens. O controle roda primeiro, aqui, e
# um controle vermelho aborta ANTES da primeira sabotagem.
echo "══ CONTROLE (versão viva, sem sabotagem) — tem de ficar VERDE ══"
rodada "" > "$TMPD/controle.log" 2>&1
executados_controle=$((PASS + FAIL))
if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 1 ]; then
  echo "  ❌ CONTROLE VERMELHO (PASS=$PASS FAIL=$FAIL) — abortando antes de sabotar"
  tail -30 "$TMPD/controle.log"
  exit 1
fi
echo "  ✅ controle verde: $PASS asserts"

# O vermelho que conta é o do assert DECLARADO, verde no controle e vermelho na rodada; os verdes
# declarados seguem verdes; a rodada executa tantos asserts quanto o controle; e vermelho com ERRO
# de execução não é dente (docs/historico/falsificacao-exit-nao-e-dente.md) — em QUALQUER parte do got: os
# asserts compostos (K00, G1, V4, V5, T1, T2) juntam medições com '|', e um ERRO na 2ª valeria "por valor".
falhas=0
for item in $SABOTAGENS; do
  sab="${item%%:*}"; resto="${item#*:}"
  verm="${resto%%:*}"; verdes=""
  [ "$resto" = "$verm" ] || verdes="${resto#*:}"
  log="$TMPD/sab-$sab.log"
  rc=0; rodada "$sab" > "$log" 2>&1 || rc=$?
  motivo=""
  if [ "$rc" -ne 0 ]; then
    motivo=" sabotagem não aplicou (exit $rc): $({ grep -m1 -E 'ERRO|ERROR|cv_' "$log" || true; } | cut -c1-200)"
  elif [ "$((PASS + FAIL))" -ne "$executados_controle" ]; then
    motivo=" a rodada executou $((PASS + FAIL)) asserts e o controle $executados_controle: vermelho de aborto, não de assert"
  elif grep -Eq '^  ✗ .*got\[.*ERRO: ' "$log"; then
    motivo=" vermelho com ERRO de execução: a medição que erra cai pelo erro, não pelo valor"
  else
    for id in ${verm//,/ }; do
      if ! grep -Eq "^  ✓ ($id) " "$TMPD/controle.log" || ! grep -Eq "^  ✗ ($id) " "$log"; then
        motivo="$motivo $id não virou (verde no controle → vermelho aqui);"
      fi
    done
    for id in ${verdes//,/ }; do
      grep -Eq "^  ✓ ($id) " "$log" || motivo="$motivo $id ficou VERMELHO (pré-condição: a sabotagem quebrou outra camada);"
    done
  fi
  if [ -z "$motivo" ]; then
    echo "  ✅ $sab — vermelho no assert declarado ($verm)"
  else
    falhas=$((falhas+1)); echo "  ❌ $sab —$motivo"
    { grep -E '^  ✗ ' "$log" || true; } | head -8 | sed 's/^/       /'
  fi
done

# Recibo EXCLUSIVO deste modo (o normal nunca o emite): é como o runner confere que a flag não foi
# ignorada.
total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
[ "$falhas" -eq 0 ]
