#!/usr/bin/env bash
# Prova PG17 do picking v2 — supabase/migrations/20261011020000_picking_v2_schema.sql
#   bash db/test-picking-v2.sh > /tmp/t.log 2>&1; echo "exit=$?"
#
# Cada banco nasce do zero (stubs + pré-requisitos de prod + a migration). As RPCs são EXECUTADAS
# (PL/pgSQL é late-bound). Os cenários funcionais rodam como o dono com `request.jwt.claim.sub`
# setado (o gate staff lê auth.uid(); o ACL é provado à parte, sob SET ROLE). A falsificação
# aplica uma CÓPIA sabotada da migration num banco novo e exige o cenário correspondente
# VERMELHO — com o controle (a migration verdadeira pelo MESMO caminho) VERDE antes do 1º sed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5947}"
SLUG="picking-v2"
TMP="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMP/data"
export LC_ALL=C LANG=C
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMP/pg.log" -w start >/dev/null

MIG="$REPO_ROOT/supabase/migrations/20261011020000_picking_v2_schema.sql"

Pd() { local db="$1"; shift; "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
Pq() { Pd "$1" -tA -q -c "$2"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

U1='11111111-1111-1111-1111-111111111111'   # employee
U2='22222222-2222-2222-2222-222222222222'   # employee
UM='33333333-3333-3333-3333-333333333333'   # master
UC='44444444-4444-4444-4444-444444444444'   # customer

# Pré-requisitos que a migration LÊ e não cria, como em prod (has_role, app_role, v1, privilégios).
prereq() {
  local db="$1"
  Pd "$db" -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null || return 1
  Pd "$db" -q >/dev/null <<SQL
-- Como no Supabase: as roles alcançam public/auth (senão o 42501 viria do SCHEMA, não do REVOKE),
-- service_role tem BYPASSRLS, e objeto novo em public nasce com ALL/EXECUTE para as 3 roles —
-- sem isto os REVOKEs da migration não teriam o que morder (assert tautológico).
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
ALTER ROLE service_role BYPASSRLS;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS \$f\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$f\$;
INSERT INTO public.user_roles VALUES ('$U1','employee'), ('$U2','employee'), ('$UM','master'), ('$UC','customer');
-- v1 (assinaturas de prod, corpo irrelevante): a migration revoga a escrita.
CREATE FUNCTION public.ensure_picking_task_for_sales_order(p_sales_order_id uuid) RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER AS \$f\$ SELECT '{}'::jsonb \$f\$;
CREATE FUNCTION public.recalcular_picking_task(p_task_id uuid) RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER AS \$f\$ SELECT '{}'::jsonb \$f\$;
CREATE FUNCTION public.confirmar_item_picking(p_event_id uuid, p_task_id uuid, p_item_id uuid,
  p_quantidade_separada integer, p_lote_informado text, p_justificativa text, p_confirmed_at timestamptz)
  RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS \$f\$ SELECT '{}'::jsonb \$f\$;
REVOKE ALL ON FUNCTION public.ensure_picking_task_for_sales_order(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.recalcular_picking_task(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirmar_item_picking(uuid,uuid,uuid,integer,text,text,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_picking_task_for_sales_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalcular_picking_task(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_item_picking(uuid,uuid,uuid,integer,text,text,timestamptz) TO authenticated;
SQL
}

# Atalhos de teste (schema t, fora da migration): cada um seta o operador e chama a RPC com o
# que o aparelho saberia (atribuição/revisão/seq vigentes), salvo quando o teste passa outro.
helpers() {
  Pd "$1" -q >/dev/null <<'SQL'
CREATE SCHEMA t;
-- As roles alcançam o schema de teste: o 42501 dos asserts de ACL tem de vir da migration, não daqui.
GRANT USAGE ON SCHEMA t TO PUBLIC;
CREATE FUNCTION t.uid(u uuid) RETURNS text LANGUAGE sql AS $f$ SELECT set_config('request.jwt.claim.sub', u::text, false) $f$;
CREATE FUNCTION t.tid(a text, c bigint) RETURNS uuid LANGUAGE sql AS $f$ SELECT id FROM public.picking_tarefas WHERE account = a AND omie_codigo_pedido = c $f$;
CREATE FUNCTION t.st(a text, c bigint) RETURNS text LANGUAGE sql AS $f$ SELECT status FROM public.picking_tarefas WHERE id = t.tid(a, c) $f$;
CREATE FUNCTION t.atr(a text, c bigint) RETURNS uuid LANGUAGE sql AS $f$ SELECT atribuicao_id FROM public.picking_tarefas WHERE id = t.tid(a, c) $f$;
CREATE FUNCTION t.rev(a text, c bigint) RETURNS int LANGUAGE sql AS $f$ SELECT revisao FROM public.picking_tarefas WHERE id = t.tid(a, c) $f$;
CREATE FUNCTION t.seq(a text, c bigint) RETURNS int LANGUAGE sql AS $f$ SELECT estado_seq FROM public.picking_tarefas WHERE id = t.tid(a, c) $f$;
CREATE FUNCTION t.lin(a text, c bigint, ci bigint) RETURNS uuid LANGUAGE sql AS $f$ SELECT id FROM public.picking_linhas WHERE tarefa_id = t.tid(a, c) AND codigo_item = ci $f$;
CREATE FUNCTION t.sep(a text, c bigint, ci bigint) RETURNS numeric LANGUAGE sql AS $f$ SELECT separada FROM public.picking_linhas_progresso WHERE id = t.lin(a, c, ci) $f$;
CREATE FUNCTION t.it(ci int, cp int, q text, un text, ean text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS
  $f$ SELECT jsonb_build_object('codigo_item', ci, 'codigo_produto', cp, 'codigo', 'SKU' || cp, 'descricao', 'Produto ' || cp,
                                'quantidade', q, 'unidade', un, 'ean', ean) $f$;
CREATE FUNCTION t.ped(c bigint, itens jsonb, dalt text DEFAULT '01/10/2026') RETURNS jsonb LANGUAGE sql AS
  $f$ SELECT jsonb_build_object('codigo_pedido', c, 'numero_pedido', 'N' || c, 'cliente_nome', 'Cliente ' || c,
                                'd_alt', dalt, 'h_alt', '10:00:00', 'itens', itens) $f$;
CREATE FUNCTION t.sync(a text, presentes bigint[], pedidos jsonb, fora bigint[] DEFAULT '{}', total int DEFAULT NULL,
                       coleta timestamptz DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS
  $f$ SELECT public.picking_sincronizar_fila(a, coalesce(coleta, clock_timestamp()), presentes,
                                             coalesce(total, cardinality(presentes)), pedidos, fora) $f$;
CREATE FUNCTION t.pegar(u uuid, a text, c bigint, assumir boolean DEFAULT false, rec boolean DEFAULT false,
                        seq int DEFAULT NULL, ev uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS
  $f$ SELECT t.uid(u);
      SELECT public.picking_pegar_task(coalesce(ev, gen_random_uuid()), a, t.tid(a, c), coalesce(seq, t.seq(a, c)), assumir, rec) $f$;
CREATE FUNCTION t.bipe(u uuid, a text, c bigint, cod text, lid uuid DEFAULT NULL, conta text DEFAULT NULL,
                       atr uuid DEFAULT NULL, rev int DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS
  $f$ SELECT t.uid(u);
      SELECT public.picking_registrar_leitura(coalesce(lid, gen_random_uuid()), coalesce(conta, a), t.tid(a, c),
             coalesce(atr, t.atr(a, c)), coalesce(rev, t.rev(a, c)), 'bipe', cod) $f$;
CREATE FUNCTION t.manual(u uuid, a text, c bigint, linha uuid, q numeric, lid uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS
  $f$ SELECT t.uid(u);
      SELECT public.picking_registrar_leitura(coalesce(lid, gen_random_uuid()), a, t.tid(a, c), t.atr(a, c), t.rev(a, c),
             'manual', NULL, linha, q) $f$;
CREATE FUNCTION t.estorno(u uuid, a text, c bigint, orig uuid, lid uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS
  $f$ SELECT t.uid(u);
      SELECT public.picking_registrar_leitura(coalesce(lid, gen_random_uuid()), a, t.tid(a, c), t.atr(a, c), t.rev(a, c),
             'estorno', NULL, NULL, NULL, orig) $f$;
-- Sem lista explícita: todas as leituras GRAVADAS da atribuição vigente (o aparelho em dia).
CREATE FUNCTION t.concluir(u uuid, a text, c bigint, leituras uuid[] DEFAULT NULL, ev uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS
  $f$ SELECT t.uid(u);
      SELECT public.picking_concluir(coalesce(ev, gen_random_uuid()), a, t.tid(a, c), t.atr(a, c), t.rev(a, c),
             coalesce(leituras, (SELECT coalesce(array_agg(id), '{}') FROM public.picking_leituras
                                  WHERE tarefa_id = t.tid(a, c) AND atribuicao_id = t.atr(a, c)))) $f$;
CREATE FUNCTION t.falta(u uuid, a text, c bigint, ci bigint, ev uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS
  $f$ SELECT t.uid(u);
      SELECT public.picking_marcar_falta(coalesce(ev, gen_random_uuid()), a, t.tid(a, c), t.atr(a, c), t.lin(a, c, ci)) $f$;
CREATE FUNCTION t.retomar(u uuid, a text, c bigint, rec boolean, seq int DEFAULT NULL, ev uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS
  $f$ SELECT t.uid(u);
      SELECT public.picking_retomar(coalesce(ev, gen_random_uuid()), a, t.tid(a, c), coalesce(seq, t.seq(a, c)), rec) $f$;
-- SQLSTATE exata do comando (ou SEM_ERRO): o teste compara com o código esperado; nada é engolido.
CREATE FUNCTION t.err(q text) RETURNS text LANGUAGE plpgsql AS
  $f$ BEGIN EXECUTE q; RETURN 'SEM_ERRO'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $f$;
SQL
}

# Cada etapa propaga o erro EXPLICITAMENTE: chamada dentro de `if ! montar`, o bash desliga o
# errexit da função e uma migration que abortou passaria por "aplicada". A migration vai em
# transação única (-1), como no db:aplicar — abortou, não sobra objeto nenhum.
montar() {
  local db="$1" mig="$2"
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$db" || return 1
  prereq "$db" || return 1
  Pd "$db" -1 -q -f "$mig" >/dev/null || return 1
  helpers "$db" || return 1
}

# ── cenários reutilizados pela prova E pela falsificação (cada um imprime um veredito curto) ──

# Duas sessões bipando a ÚLTIMA unidade da mesma linha: A segura a transação; B espera o lock da
# tarefa e, ao entrar, vê o saldo já consumido → excesso. Sem a serialização: 2 aceitas em 1 pedida.
chk_concorrencia() {
  local db="$1"
  Pq "$db" "SELECT t.sync('oben', '{9101}', jsonb_build_array(t.ped(9101, jsonb_build_array(t.it(1,701,'1','UN','E9101')))));
            SELECT t.pegar('$U1','oben',9101);" >/dev/null
  ( Pd "$db" -tA -q -c "BEGIN; SELECT t.bipe('$U1','oben',9101,'E9101')->>'motivo'; SELECT pg_sleep(2); COMMIT;" >"$TMP/conc-a.out" 2>&1 ) &
  local pid=$!
  sleep 0.5
  local b
  b=$(Pq "$db" "SELECT coalesce(t.bipe('$U1','oben',9101,'E9101')->>'motivo','aceita');")
  wait "$pid"
  echo "$b|$(Pq "$db" "SELECT t.sep('oben',9101,1);")"
}

# Sync revisando a linha ENQUANTO uma leitura chega: a sync segura o lock da tarefa; a leitura
# espera e, ao entrar, vê a tarefa suspensa → rejeitada (nunca conta numa revisão que já morreu).
chk_sync_vs_leitura() {
  local db="$1"
  Pq "$db" "SELECT t.sync('oben', '{9102}', jsonb_build_array(t.ped(9102, jsonb_build_array(t.it(1,702,'5','UN','E9102')))));
            SELECT t.pegar('$U1','oben',9102);" >/dev/null
  local atr rev
  atr=$(Pq "$db" "SELECT t.atr('oben',9102);"); rev=$(Pq "$db" "SELECT t.rev('oben',9102);")
  ( Pd "$db" -tA -q -c "BEGIN; SELECT t.sync('oben', '{9102}', jsonb_build_array(t.ped(9102, jsonb_build_array(t.it(1,702,'4','UN','E9102'))))); SELECT pg_sleep(2); COMMIT;" >"$TMP/svl-a.out" 2>&1 ) &
  local pid=$!
  sleep 0.5
  local b
  b=$(Pq "$db" "SELECT coalesce(t.bipe('$U1','oben',9102,'E9102',NULL,NULL,'$atr'::uuid,$rev)->>'motivo','aceita');")
  wait "$pid"
  echo "$b|$(Pq "$db" "SELECT t.st('oben',9102);")"
}

# Revisão: 3 de 5 bipados; o Omie muda a quantidade → a linha sobe de revisão e a tarefa vai a
# suspensa (o volume tem 3 peças que o banco não conta mais). Duas camadas leem a revisão vigente:
# a VIEW (o que a tela mostra) e a função de saldo (o que DECIDE excesso/conclusão) — o cenário
# mede as duas: separado na view e quantos dos 5 bipes pós-retomada a linha de 4 aceita.
chk_revisao() {
  local db="$1"
  Pq "$db" "SELECT t.sync('oben', '{9201}', jsonb_build_array(t.ped(9201, jsonb_build_array(t.it(1,711,'5','UN','E9201')))));
            SELECT t.pegar('$U1','oben',9201);
            SELECT t.bipe('$U1','oben',9201,'E9201'); SELECT t.bipe('$U1','oben',9201,'E9201'); SELECT t.bipe('$U1','oben',9201,'E9201');
            SELECT t.sync('oben', '{9201}', jsonb_build_array(t.ped(9201, jsonb_build_array(t.it(1,711,'4','UN','E9201')))));" >/dev/null
  local estado n=0 r
  estado=$(Pq "$db" "SELECT t.st('oben',9201) || '|' || t.sep('oben',9201,1);")
  Pq "$db" "SELECT t.retomar('$U1','oben',9201,true);" >/dev/null
  for _ in 1 2 3 4 5; do
    r=$(Pq "$db" "SELECT t.bipe('$U1','oben',9201,'E9201')->>'ok';")
    [ "$r" = "true" ] && n=$((n+1))
  done
  echo "$estado|$n"
}

# Fecha por LINHA: A completa, B vazia → concluir recusa.
chk_por_linha() {
  local db="$1"
  Pq "$db" "SELECT t.sync('oben', '{9301}', jsonb_build_array(t.ped(9301, jsonb_build_array(t.it(1,721,'1','UN','EA9301'), t.it(2,722,'1','UN','EB9301')))));
            SELECT t.pegar('$U1','oben',9301); SELECT t.bipe('$U1','oben',9301,'EA9301');" >/dev/null
  Pq "$db" "SELECT coalesce(t.concluir('$U1','oben',9301)->>'motivo','ok');"
}

# Idempotência: o mesmo UUID reenviado devolve o veredito gravado e não soma de novo.
chk_idempotencia() {
  local db="$1"
  Pq "$db" "SELECT t.sync('oben', '{9401}', jsonb_build_array(t.ped(9401, jsonb_build_array(t.it(1,731,'3','UN','E9401')))));
            SELECT t.pegar('$U1','oben',9401);
            SELECT t.bipe('$U1','oben',9401,'E9401','94010000-0000-0000-0000-000000000001');" >/dev/null
  local r
  r=$(Pq "$db" "SELECT t.err(\$q\$SELECT t.bipe('$U1','oben',9401,'E9401','94010000-0000-0000-0000-000000000001')\$q\$);")
  echo "$r|$(Pq "$db" "SELECT (t.bipe('$U1','oben',9401,'E9401','94010000-0000-0000-0000-000000000001')->>'replay');" 2>/dev/null || echo ERRO)|$(Pq "$db" "SELECT t.sep('oben',9401,1);")"
}

# Isolamento de conta: o mesmo nº de pedido existe nas 2 contas; chamar com a conta errada é 22023.
chk_conta() {
  local db="$1"
  Pq "$db" "SELECT t.sync('colacor', '{9501}', jsonb_build_array(t.ped(9501, jsonb_build_array(t.it(1,741,'1','UN','E9501')))));" >/dev/null
  Pq "$db" "SELECT t.uid('$U1'); SELECT t.err(\$q\$SELECT public.picking_pegar_task(gen_random_uuid(), 'oben', t.tid('colacor',9501), t.seq('colacor',9501))\$q\$);" | tail -1
}

# Listagem incompleta (total ≠ presentes) NÃO interrompe nada, nem com confirmação.
chk_incompleta() {
  local db="$1"
  Pq "$db" "SELECT t.sync('oben', '{9601}', jsonb_build_array(t.ped(9601, jsonb_build_array(t.it(1,751,'1','UN','E9601')))));
            SELECT t.sync('oben', '{}', '[]'::jsonb, '{9601}', 5);" >/dev/null
  Pq "$db" "SELECT t.st('oben',9601);"
}

# Geração monotônica: coleta iniciada antes da última aplicada é recusada sem efeito.
chk_geracao() {
  local db="$1"
  Pq "$db" "SELECT t.sync('colacor', '{9701}', jsonb_build_array(t.ped(9701, jsonb_build_array(t.it(1,761,'1','UN','E9701')))));" >/dev/null
  Pq "$db" "SELECT coalesce((t.sync('colacor', '{9701,9702}', jsonb_build_array(t.ped(9701, jsonb_build_array(t.it(1,761,'1','UN','E9701'))), t.ped(9702, jsonb_build_array(t.it(1,762,'1','UN','E9702')))), '{}', NULL, clock_timestamp() - interval '1 hour'))->>'motivo','aplicada') || '|' || (t.tid('colacor',9702) IS NULL);"
}

# Retomar uma tarefa suspensa exige reconciliação física.
chk_reconciliacao() {
  local db="$1"
  Pq "$db" "SELECT t.sync('oben', '{9801}', jsonb_build_array(t.ped(9801, jsonb_build_array(t.it(1,771,'2','UN','E9801')))));
            SELECT t.pegar('$U1','oben',9801); SELECT t.bipe('$U1','oben',9801,'E9801');
            SELECT t.sync('oben', '{9801}', jsonb_build_array(t.ped(9801, jsonb_build_array(t.it(1,771,'3','UN','E9801')))));" >/dev/null
  Pq "$db" "SELECT coalesce(t.retomar('$U1','oben',9801,false)->>'motivo','ok');"
}

# Concluir com uma leitura que o aparelho emitiu e o servidor ainda não recebeu → pendente.
chk_pendentes() {
  local db="$1"
  Pq "$db" "SELECT t.sync('oben', '{9901}', jsonb_build_array(t.ped(9901, jsonb_build_array(t.it(1,781,'1','UN','E9901')))));
            SELECT t.pegar('$U1','oben',9901);
            SELECT t.bipe('$U1','oben',9901,'E9901','99010000-0000-0000-0000-000000000001');" >/dev/null
  Pq "$db" "SELECT coalesce(t.concluir('$U1','oben',9901, ARRAY['99010000-0000-0000-0000-000000000001','99010000-0000-0000-0000-000000000002']::uuid[])->>'motivo','ok');"
}

# Código cadastrado (fator 6) que também é o EAN da linha (fator 1): duas leituras físicas
# possíveis → recusa. Sem isso, 1 peça bipada valeria 6 e a linha de 6 fecharia.
chk_ambiguo() {
  local db="$1"
  Pq "$db" "INSERT INTO public.picking_codigos_barras (account, codigo, omie_codigo_produto, unidade, unidades_por_leitura, origem, status, aprovado_por)
            VALUES ('oben','EAMB9111',791,'UN',6,'aprendido','aprovado','$UM');
            SELECT t.sync('oben', '{9111}', jsonb_build_array(t.ped(9111, jsonb_build_array(t.it(1,791,'6','UN','EAMB9111')))));
            SELECT t.pegar('$U1','oben',9111);" >/dev/null
  Pq "$db" "SELECT coalesce(t.bipe('$U1','oben',9111,'EAMB9111')->>'motivo','ok');"
}

# Mesmo UUID de evento em DUAS tarefas, ao mesmo tempo (locks diferentes): a 2ª espera o INSERT
# da 1ª e sai 22023 (reuso), nunca 23505 cru.
chk_evento_concorrente() {
  local db="$1"
  Pq "$db" "SELECT t.sync('oben', '{9121,9122}', jsonb_build_array(t.ped(9121, jsonb_build_array(t.it(1,792,'1','UN','E9121'))), t.ped(9122, jsonb_build_array(t.it(1,793,'1','UN','E9122')))));" >/dev/null
  ( Pd "$db" -tA -q -c "BEGIN; SELECT t.pegar('$U1','oben',9121,false,false,NULL,'91210000-0000-0000-0000-0000000000e1')->>'ok'; SELECT pg_sleep(2); COMMIT;" >"$TMP/ev-a.out" 2>&1 ) &
  local pid=$!
  sleep 0.5
  local b
  b=$(Pq "$db" "SELECT t.err(\$q\$SELECT t.pegar('$U1','oben',9122,false,false,NULL,'91210000-0000-0000-0000-0000000000e1')\$q\$);")
  wait "$pid"
  echo "$b"
}

# Mesmo EAN em 2 linhas do mesmo produto com unidades diferentes (UN e CX), sem cadastro: o bipe
# não sabe se é 1 peça ou 1 caixa → recusa.
chk_ean_unidades() {
  local db="$1"
  Pq "$db" "SELECT t.sync('oben', '{9131}', jsonb_build_array(t.ped(9131, jsonb_build_array(t.it(1,794,'1','UN','EU9131'), t.it(2,794,'1','CX','EU9131')))));
            SELECT t.pegar('$U1','oben',9131);" >/dev/null
  Pq "$db" "SELECT coalesce(t.bipe('$U1','oben',9131,'EU9131')->>'motivo','ok');"
}

# ACL da sync (catálogo): anon/authenticated sem EXECUTE.
chk_acl_sync() {
  Pq "$1" "SELECT (has_function_privilege('anon','public.picking_sincronizar_fila(text,timestamptz,bigint[],integer,jsonb,bigint[])','EXECUTE')
                OR has_function_privilege('authenticated','public.picking_sincronizar_fila(text,timestamptz,bigint[],integer,jsonb,bigint[])','EXECUTE'))::text;"
}

echo "═══ PROVA — migration real ═══"
montar real "$MIG"
Q() { Pq real "$1"; }

P1001="t.ped(1001, jsonb_build_array(t.it(1,501,'2','UN','7891000000011'), t.it(2,502,'1','UN',NULL), t.it(3,503,'1.5','L',NULL)))"
P1002="t.ped(1002, jsonb_build_array(t.it(1,501,'12','UN','7891000000011')))"
P1003="t.ped(1003, jsonb_build_array(t.it(1,504,'abc','UN')))"
Q "INSERT INTO public.picking_codigos_barras (account, codigo, omie_codigo_produto, unidade, unidades_por_leitura, origem, status, aprovado_por)
   VALUES ('oben','17891000000018',501,'UN',6,'aprendido','aprovado','$UM'),
          ('oben','999',501,'UN',1,'aprendido','pendente',NULL);" >/dev/null

echo "── sync ──"
eq "S1 1ª coleta: criadas|bloqueadas|completa" \
   "$(Q "SELECT j->>'criadas' || '|' || (j->>'bloqueadas') || '|' || (j->>'listagem_completa') FROM t.sync('oben','{1001,1002,1003}', jsonb_build_array($P1001,$P1002,$P1003)) j;")" "3|1|true"
eq "S2 item ilegível bloqueia o pedido inteiro (sem linhas)" "$(Q "SELECT t.st('oben',1003) || '|' || (SELECT count(*) FROM public.picking_linhas WHERE tarefa_id = t.tid('oben',1003));")" "bloqueado_dado|0"
eq "S3 linhas: qtd decimal, fracionária pela unidade" "$(Q "SELECT string_agg(codigo_item || ':' || trim_scale(quantidade) || ':' || fracionaria, ',' ORDER BY codigo_item) FROM public.picking_linhas WHERE tarefa_id = t.tid('oben',1001);")" "1:2:false,2:1:false,3:1.5:true"
eq "S4 coleta mais velha que a última → coleta_velha" "$(Q "SELECT t.sync('oben','{1001,1002,1003}', jsonb_build_array($P1001,$P1002,$P1003), '{}', NULL, clock_timestamp() - interval '1 minute')->>'motivo';")" "coleta_velha"
eq "S5 pedido detalhado fora de p_presentes → 22023" "$(Q "SELECT t.err(\$q\$SELECT t.sync('oben','{1001,1002,1003}', jsonb_build_array($P1001,$P1002,$P1003, t.ped(1999, jsonb_build_array(t.it(1,1,'1','UN')))))\$q\$);")" "22023"
eq "S6 tarefa acompanhada presente sem detalhe (corte) → 22023" "$(Q "SELECT t.err(\$q\$SELECT t.sync('oben','{1001,1002,1003}', jsonb_build_array($P1001,$P1002))\$q\$);")" "22023"
eq "S7 conta inválida → 22023" "$(Q "SELECT t.err(\$q\$SELECT t.sync('vendas','{}', '[]'::jsonb)\$q\$);")" "22023"
eq "S8 pedido duplicado no lote → 22023" "$(Q "SELECT t.err(\$q\$SELECT t.sync('oben','{1001,1002,1003}', jsonb_build_array($P1001,$P1001,$P1002,$P1003))\$q\$);")" "22023"

echo "── ACL / RLS ──"
eq "A1 catálogo: sync fechada para anon/authenticated" "$(chk_acl_sync real)" "false"
eq "A2 catálogo: service_role executa a sync" "$(Q "SELECT has_function_privilege('service_role','public.picking_sincronizar_fila(text,timestamptz,bigint[],integer,jsonb,bigint[])','EXECUTE')::text;")" "true"
eq "A3 authenticated chamando a sync → 42501" "$(Q "SET ROLE authenticated; SELECT t.err(\$q\$SELECT public.picking_sincronizar_fila('oben', clock_timestamp(), '{}', 0, '[]'::jsonb, '{}')\$q\$);")" "42501"
eq "A4 catálogo: anon sem EXECUTE nas 5 RPCs do aparelho; authenticated com" \
   "$(Q "SELECT bool_or(has_function_privilege('anon', f, 'EXECUTE'))::text || '|' || bool_and(has_function_privilege('authenticated', f, 'EXECUTE'))::text
         FROM unnest(ARRAY['public.picking_pegar_task(uuid,text,uuid,integer,boolean,boolean)',
                           'public.picking_registrar_leitura(uuid,text,uuid,uuid,integer,text,text,uuid,numeric,uuid,timestamptz)',
                           'public.picking_marcar_falta(uuid,text,uuid,uuid,uuid,text)',
                           'public.picking_retomar(uuid,text,uuid,integer,boolean)',
                           'public.picking_concluir(uuid,text,uuid,uuid,integer,uuid[])']) f;")" "false|true"
eq "A5 anon chamando pegar → 42501" "$(Q "SET ROLE anon; SELECT t.err(\$q\$SELECT public.picking_pegar_task(gen_random_uuid(),'oben',gen_random_uuid(),1)\$q\$);")" "42501"
# authenticated TEM o EXECUTE (A4) → o 42501 do customer só pode vir do gate staff no corpo.
eq "A6 customer (authenticated) chamando pegar → 42501 do gate" "$(Q "SET ROLE authenticated; SET request.jwt.claim.sub = '$UC'; SELECT t.err(\$q\$SELECT public.picking_pegar_task(gen_random_uuid(),'oben',t.tid('oben',1001),1)\$q\$);")" "42501"
eq "A7 authenticated não insere direto em picking_tarefas → 42501" "$(Q "SET ROLE authenticated; SELECT t.err(\$q\$INSERT INTO public.picking_tarefas (account, omie_codigo_pedido, status, ultima_coleta_em) VALUES ('oben', 5, 'aguardando', now())\$q\$);")" "42501"
eq "A8 service_role (BYPASSRLS) não escreve direto em picking_leituras → 42501" "$(Q "SET ROLE service_role; SELECT t.err(\$q\$DELETE FROM public.picking_leituras\$q\$);")" "42501"
eq "A9 RLS: customer lê 0 tarefas, employee lê as 3" "$(Q "SET ROLE authenticated; SET request.jwt.claim.sub = '$UC'; SELECT count(*) FROM public.picking_tarefas;")|$(Q "SET ROLE authenticated; SET request.jwt.claim.sub = '$U1'; SELECT count(*) FROM public.picking_tarefas;")" "0|3"
eq "A10 v1: escrita revogada de authenticated" "$(Q "SELECT bool_or(has_function_privilege('authenticated', f, 'EXECUTE'))::text FROM unnest(ARRAY['public.ensure_picking_task_for_sales_order(uuid)','public.recalcular_picking_task(uuid)','public.confirmar_item_picking(uuid,uuid,uuid,integer,text,text,timestamptz)']) f;")" "false"
eq "A11 caminho real: employee pega a tarefa SOB SET ROLE authenticated" "$(Q "SET ROLE authenticated; SET request.jwt.claim.sub = '$U2'; SELECT public.picking_pegar_task(gen_random_uuid(),'oben',t.tid('oben',1002),t.seq('oben',1002))->>'ok';")" "true"
eq "A12 view de progresso com security_invoker" "$(Q "SELECT (reloptions && ARRAY['security_invoker=on','security_invoker=true'])::text FROM pg_class WHERE oid = 'public.picking_linhas_progresso'::regclass;")" "true"

echo "── fluxo 1001 (U1) ──"
eq "F1 pegar com estado_seq velho → estado_mudou" "$(Q "SELECT t.pegar('$U1','oben',1001,false,false,999)->>'motivo';")" "estado_mudou"
SEQ1001=$(Q "SELECT t.seq('oben',1001);")
eq "F2 pegar → em_separacao" "$(Q "SELECT t.pegar('$U1','oben',1001,false,false,$SEQ1001,'10010000-0000-0000-0000-0000000000e1')->>'ok'; ")|$(Q "SELECT t.st('oben',1001);")" "true|em_separacao"
eq "F3 replay do pegar (mesmo comando) devolve o gravado" "$(Q "SELECT t.pegar('$U1','oben',1001,false,false,$SEQ1001,'10010000-0000-0000-0000-0000000000e1')->>'replay';")" "true"
eq "F4 bipe pelo EAN da linha → aceita na linha 1" "$(Q "SELECT (j->>'ok') || '|' || (j->>'linha_id' = t.lin('oben',1001,1)::text) FROM t.bipe('$U1','oben',1001,'7891000000011','10010000-0000-0000-0000-000000000001') j;")" "true|true"
eq "F5 replay do mesmo UUID → replay, sem somar" "$(Q "SELECT t.bipe('$U1','oben',1001,'7891000000011','10010000-0000-0000-0000-000000000001')->>'replay';")|$(Q "SELECT t.sep('oben',1001,1);")" "true|1"
eq "F6 mesmo UUID com OUTRO código → 22023" "$(Q "SELECT t.err(\$q\$SELECT t.bipe('$U1','oben',1001,'999','10010000-0000-0000-0000-000000000001')\$q\$);")" "22023"
eq "F7 mesmo UUID com a conta errada → 22023 antes do replay" "$(Q "SELECT t.err(\$q\$SELECT t.bipe('$U1','oben',1001,'7891000000011','10010000-0000-0000-0000-000000000001','colacor')\$q\$);")" "22023"
eq "F8 2º bipe aceito; 3º → excesso (gravado)" "$(Q "SELECT t.bipe('$U1','oben',1001,'7891000000011')->>'ok';")|$(Q "SELECT t.bipe('$U1','oben',1001,'7891000000011','10010000-0000-0000-0000-000000000003')->>'motivo';")|$(Q "SELECT motivo_rejeicao FROM public.picking_leituras WHERE id = '10010000-0000-0000-0000-000000000003';")" "true|excesso|excesso"
eq "F9 caixa (fator 6) numa linha com saldo 0 → excesso" "$(Q "SELECT t.bipe('$U1','oben',1001,'17891000000018')->>'motivo';")" "excesso"
eq "F10 manual numa linha COM EAN → manual_nao_permitido" "$(Q "SELECT t.manual('$U1','oben',1001,t.lin('oben',1001,1),1)->>'motivo';")" "manual_nao_permitido"
eq "F11 manual negativo → 22023" "$(Q "SELECT t.err(\$q\$SELECT t.manual('$U1','oben',1001,t.lin('oben',1001,2),-1)\$q\$);")" "22023"
eq "F12 manual NaN → 22023" "$(Q "SELECT t.err(\$q\$SELECT t.manual('$U1','oben',1001,t.lin('oben',1001,2),'NaN')\$q\$);")" "22023"
eq "F13 manual em linha de OUTRA tarefa → 22023" "$(Q "SELECT t.err(\$q\$SELECT t.manual('$U1','oben',1001,t.lin('oben',1002,1),1)\$q\$);")" "22023"
eq "F13b manual com código lido junto → 22023" "$(Q "SELECT t.uid('$U1'); SELECT t.err(\$q\$SELECT public.picking_registrar_leitura(gen_random_uuid(),'oben',t.tid('oben',1001),t.atr('oben',1001),t.rev('oben',1001),'manual','7891000000011',t.lin('oben',1001,2),1)\$q\$);" | tail -1)" "22023"
eq "F13c estorno com linha (de outra tarefa) junto → 22023" "$(Q "SELECT t.uid('$U1'); SELECT t.err(\$q\$SELECT public.picking_registrar_leitura(gen_random_uuid(),'oben',t.tid('oben',1001),t.atr('oben',1001),t.rev('oben',1001),'estorno',NULL,t.lin('oben',1002,1),NULL,'10010000-0000-0000-0000-000000000001')\$q\$);" | tail -1)" "22023"
eq "F14 manual fracionado em linha inteira → quantidade_nao_inteira" "$(Q "SELECT t.manual('$U1','oben',1001,t.lin('oben',1001,2),0.5)->>'motivo';")" "quantidade_nao_inteira"
eq "F15 manual na linha sem código → aceita" "$(Q "SELECT t.manual('$U1','oben',1001,t.lin('oben',1001,2),1)->>'ok';")" "true"
eq "F16 manual 1.5 L na fracionária → aceita, separada 1.5" "$(Q "SELECT t.manual('$U1','oben',1001,t.lin('oben',1001,3),1.5)->>'ok';")|$(Q "SELECT t.sep('oben',1001,3);")" "true|1.5"
eq "F17 bipe de código pendente → codigo_pendente_aprovacao" "$(Q "SELECT t.bipe('$U1','oben',1001,'999')->>'motivo';")" "codigo_pendente_aprovacao"
eq "F18 bipe de código desconhecido → codigo_desconhecido" "$(Q "SELECT t.bipe('$U1','oben',1001,'000')->>'motivo';")" "codigo_desconhecido"
eq "F19 tudo completo, mas uma leitura emitida ainda não chegou → leituras_pendentes" "$(Q "SELECT t.concluir('$U1','oben',1001, (SELECT array_agg(id) || '10010000-0000-0000-0000-0000000000ff'::uuid FROM public.picking_leituras WHERE tarefa_id = t.tid('oben',1001)))->>'motivo';")" "leituras_pendentes"
eq "F20 concluir com todas as leituras → separado" "$(Q "SELECT t.concluir('$U1','oben',1001)->>'ok';")|$(Q "SELECT t.st('oben',1001);")" "true|separado"
eq "F21 bipe após separado → tarefa_fora_de_separacao" "$(Q "SELECT t.bipe('$U1','oben',1001,'7891000000011')->>'motivo';")" "tarefa_fora_de_separacao"
eq "F22 leitura é imutável (UPDATE → 55000)" "$(Q "SELECT t.err(\$q\$UPDATE public.picking_leituras SET unidades = 9\$q\$);")" "55000"

echo "── 1002: caixa, estorno fora de ordem, assumir, falta, retomar (U2 pegou em A11) ──"
eq "G1 U1 bipando a tarefa de U2 → atribuicao_antiga" "$(Q "SELECT t.bipe('$U1','oben',1002,'7891000000011')->>'motivo';")" "atribuicao_antiga"
eq "G2 caixa (fator 6) → aceita 6" "$(Q "SELECT (j->>'ok') || '|' || (j->>'unidades') FROM t.bipe('$U2','oben',1002,'17891000000018','10020000-0000-0000-0000-000000000001') j;")" "true|6"
# Offline fora de ordem: o aparelho fez L2 (caixa) e depois E (estorno de L2); E chega primeiro.
eq "G3 estorno antes do original → pendente, NÃO gravado" "$(Q "SELECT t.estorno('$U2','oben',1002,'10020000-0000-0000-0000-000000000002','10020000-0000-0000-0000-0000000000e2')->>'motivo';")|$(Q "SELECT count(*) FROM public.picking_leituras WHERE id = '10020000-0000-0000-0000-0000000000e2';")" "original_nao_recebido|0"
eq "G4 L2 chega → 12/12" "$(Q "SELECT t.bipe('$U2','oben',1002,'17891000000018','10020000-0000-0000-0000-000000000002')->>'ok';")|$(Q "SELECT t.sep('oben',1002,1);")" "true|12"
eq "G5 E reenviado → estorno aceito, 6/12" "$(Q "SELECT t.estorno('$U2','oben',1002,'10020000-0000-0000-0000-000000000002','10020000-0000-0000-0000-0000000000e2')->>'ok';")|$(Q "SELECT t.sep('oben',1002,1);")" "true|6"
eq "G6 concluir não fabrica separado com volume 6/12" "$(Q "SELECT t.concluir('$U2','oben',1002)->>'motivo';")" "linhas_incompletas"
eq "G7 estornar de novo → ja_estornada; estornar o estorno → estorno_invalido" "$(Q "SELECT t.estorno('$U2','oben',1002,'10020000-0000-0000-0000-000000000002')->>'motivo';")|$(Q "SELECT t.estorno('$U2','oben',1002,'10020000-0000-0000-0000-0000000000e2')->>'motivo';")" "ja_estornada|estorno_invalido"
eq "G8 U1 assumir sem reconciliação → exige_reconciliacao_fisica" "$(Q "SELECT t.pegar('$U1','oben',1002,true,false)->>'motivo';")" "exige_reconciliacao_fisica"
eq "G9 U1 assume com reconciliação; leitura de U2 → atribuicao_antiga" "$(Q "SELECT t.pegar('$U1','oben',1002,true,true)->>'ok';")|$(Q "SELECT t.bipe('$U2','oben',1002,'7891000000011',NULL,NULL,(SELECT atribuicao_id FROM public.picking_leituras WHERE id='10020000-0000-0000-0000-000000000001'))->>'motivo';")" "true|atribuicao_antiga"
eq "G10 falta → aguardando_ajuste; replay devolve o gravado" "$(Q "SELECT t.falta('$U1','oben',1002,1,'10020000-0000-0000-0000-0000000000f1')->>'faltante';")|$(Q "SELECT t.st('oben',1002);")|$(Q "SELECT t.falta('$U1','oben',1002,1,'10020000-0000-0000-0000-0000000000f1')->>'replay';")" "6|aguardando_ajuste|true"
eq "G11 UUID da falta reusado como retomar → 22023" "$(Q "SELECT t.err(\$q\$SELECT t.retomar('$U1','oben',1002,true,NULL,'10020000-0000-0000-0000-0000000000f1')\$q\$);")" "22023"
eq "G12 retomar sem reconciliação → exige; com seq velho → estado_mudou" "$(Q "SELECT t.retomar('$U1','oben',1002,false)->>'motivo';")|$(Q "SELECT t.retomar('$U1','oben',1002,true,1)->>'motivo';")" "exige_reconciliacao_fisica|estado_mudou"
eq "G13 retomar com reconciliação → em_separacao, progresso mantido" "$(Q "SELECT t.retomar('$U1','oben',1002,true)->>'ok';")|$(Q "SELECT t.st('oben',1002) || '|' || t.sep('oben',1002,1);")" "true|em_separacao|6"

echo "── revisão pelo Omie (coleta 2) ──"
P1002b="t.ped(1002, jsonb_build_array(t.it(1,501,'10','UN','7891000000011')), '02/10/2026')"
P1001preco="t.ped(1001, jsonb_build_array(t.it(1,501,'2','UN','7891000000011'), t.it(2,502,'1','UN',NULL), t.it(3,503,'1.5','L',NULL)), '03/10/2026')"
P1003ok="t.ped(1003, jsonb_build_array(t.it(1,504,'3','UN','E1003')))"
REV_ANTES=$(Q "SELECT t.rev('oben',1002);"); ATR_ANTES=$(Q "SELECT t.atr('oben',1002);")
Q "SELECT t.sync('oben','{1001,1002,1003}', jsonb_build_array($P1001preco,$P1002b,$P1003ok));" >/dev/null
eq "R1 qtd mudou em separação → suspensa_alteracao, revisão +1" "$(Q "SELECT t.st('oben',1002) || '|' || (t.rev('oben',1002) - $REV_ANTES);")" "suspensa_alteracao|1"
eq "R2 progresso da revisão antiga deixa de contar (view: separada 0, saldo 10)" "$(Q "SELECT separada || '|' || trim_scale(saldo) FROM public.picking_linhas_progresso WHERE id = t.lin('oben',1002,1);")" "0|10"
eq "R3 só preço mudou (hash igual) → separado intacto, versão atualizada" "$(Q "SELECT t.st('oben',1001) || '|' || versao_omie FROM public.picking_tarefas WHERE id = t.tid('oben',1001);")" "separado|03/10/2026 10:00:00"
eq "R4 1003 corrigido no Omie (nunca pega) → aguardando com linhas" "$(Q "SELECT t.st('oben',1003) || '|' || (SELECT count(*) FROM public.picking_linhas WHERE tarefa_id = t.tid('oben',1003));")" "aguardando|1"
eq "R5 retomar + leitura offline da revisão ANTIGA → revisao_antiga (gravada)" "$(Q "SELECT t.retomar('$U1','oben',1002,true)->>'ok';")|$(Q "SELECT t.bipe('$U1','oben',1002,'7891000000011',NULL,NULL,NULL,$REV_ANTES)->>'motivo';")" "true|revisao_antiga"
eq "R6 leitura com a atribuição de ANTES da suspensão → atribuicao_antiga" "$(Q "SELECT t.bipe('$U1','oben',1002,'7891000000011',NULL,NULL,'$ATR_ANTES'::uuid)->>'motivo';")" "atribuicao_antiga"
P1001ean="t.ped(1001, jsonb_build_array(t.it(1,501,'2','UN','7891000000099'), t.it(2,502,'1','UN',NULL), t.it(3,503,'1.5','L',NULL)), '04/10/2026')"
Q "SELECT t.sync('oben','{1001,1002,1003}', jsonb_build_array($P1001ean,$P1002b,$P1003ok));" >/dev/null
eq "R7 EAN corrigido no Omie num separado → suspensa (reconciliar) e EAN novo na linha" "$(Q "SELECT t.st('oben',1001) || '|' || (SELECT ean FROM public.picking_linhas WHERE id = t.lin('oben',1001,1));")" "suspensa_alteracao|7891000000099"
REV1003=$(Q "SELECT t.rev('oben',1003) || '|' || (SELECT revisao FROM public.picking_linhas WHERE id = t.lin('oben',1003,1));")
Q "SELECT t.sync('oben','{1001,1002,1003}', jsonb_build_array($P1001ean,$P1002b, t.ped(1003, jsonb_build_array(t.it(1,504,'3','UN','E1003') || '{\"descricao\":\"Nome novo\",\"codigo\":\"SKU-NOVO\"}'::jsonb))));" >/dev/null
eq "R8 descrição/código mudam no Omie → acompanham SEM subir revisão" "$(Q "SELECT descricao || '|' || codigo_produto FROM public.picking_linhas WHERE id = t.lin('oben',1003,1);")|$(Q "SELECT t.rev('oben',1003) || '|' || (SELECT revisao FROM public.picking_linhas WHERE id = t.lin('oben',1003,1));")" "Nome novo|SKU-NOVO|$REV1003"

echo "── ausência (coletas 3–5) ──"
P1004="t.ped(1004, jsonb_build_array(t.it(1,505,'1','UN','E1004')))"
Q "SELECT t.sync('oben','{1001,1002,1003,1004}', jsonb_build_array($P1001ean,$P1002b,$P1003ok,$P1004));
   SELECT t.pegar('$U2','oben',1004); SELECT t.bipe('$U2','oben',1004,'E1004'); SELECT t.concluir('$U2','oben',1004);" >/dev/null
eq "N1 ausente sem confirmação → só ausentes_a_confirmar" "$(Q "SELECT (j->'ausentes_a_confirmar')::text FROM t.sync('oben','{1001,1002}', jsonb_build_array($P1001ean,$P1002b)) j;")|$(Q "SELECT t.st('oben',1003);")" "[1003, 1004]|aguardando"
eq "N2 listagem incompleta + confirmação → nada muda (fail-closed)" "$(Q "SELECT (j->>'listagem_completa') FROM t.sync('oben','{1001,1002}', jsonb_build_array($P1001ean,$P1002b), '{1003,1004}', 3) j;")|$(Q "SELECT t.st('oben',1003);")" "false|aguardando"
eq "N3 completa + confirmada: aberta → interrompida_externa; separada → fora da etapa" "$(Q "SELECT (j->>'interrompidas') || '|' || (j->>'saidas_da_etapa') FROM t.sync('oben','{1001,1002}', jsonb_build_array($P1001ean,$P1002b), '{1003,1004}') j;")|$(Q "SELECT t.st('oben',1003) || '|' || t.st('oben',1004);")" "1|1|interrompida_externa|separado"
eq "N4 separado fora da etapa não reabre" "$(Q "SELECT t.retomar('$U2','oben',1004,true)->>'motivo';")" "fora_da_etapa"
eq "N5 reentrada na etapa 10: interrompida nunca pega → aguardando; separado volta a acompanhar" \
   "$(Q "SELECT t.sync('oben','{1001,1002,1003,1004}', jsonb_build_array($P1001ean,$P1002b,$P1003ok,$P1004));" >/dev/null; Q "SELECT t.st('oben',1003) || '|' || (SELECT (fora_da_etapa_em IS NULL)::text FROM public.picking_tarefas WHERE id = t.tid('oben',1004));")" "aguardando|true"

echo "── cenários compartilhados com a falsificação ──"
eq "C1 2 sessões, última unidade: B espera e vê excesso" "$(chk_concorrencia real)" "excesso|1"
eq "C2 sync segura a tarefa; leitura que espera vê suspensa" "$(chk_sync_vs_leitura real)" "tarefa_fora_de_separacao|suspensa_alteracao"
eq "C3 revisão zera o separado vigente, suspende e a linha nova aceita 4" "$(chk_revisao real)" "suspensa_alteracao|0|4"
eq "C4 fecha por linha" "$(chk_por_linha real)" "linhas_incompletas"
eq "C5 idempotência por UUID" "$(chk_idempotencia real)" "SEM_ERRO|true|1"
eq "C6 conta errada → 22023" "$(chk_conta real)" "22023"
eq "C7 listagem incompleta não interrompe" "$(chk_incompleta real)" "aguardando"
eq "C8 geração monotônica" "$(chk_geracao real)" "coleta_velha|true"
eq "C9 retomar exige reconciliação" "$(chk_reconciliacao real)" "exige_reconciliacao_fisica"
eq "C10 concluir exige todas as leituras" "$(chk_pendentes real)" "leituras_pendentes"
eq "C11 código cadastrado x EAN da linha com fator diferente → ambíguo" "$(chk_ambiguo real)" "codigo_ambiguo"
eq "C13 mesmo EAN em UN e CX do mesmo produto → ambíguo" "$(chk_ean_unidades real)" "codigo_ambiguo"
eq "C12 mesmo UUID de evento em 2 tarefas ao mesmo tempo → 22023" "$(chk_evento_concorrente real)" "22023"

echo
echo "═══ FALSIFICAÇÃO — controle verde pelo MESMO caminho, depois cada sabotagem VERMELHA ═══"
cp "$MIG" "$TMP/controle.sql"
montar controle "$TMP/controle.sql"
CTRL="$(chk_concorrencia controle)/$(chk_sync_vs_leitura controle)/$(chk_revisao controle)/$(chk_por_linha controle)/$(chk_idempotencia controle)/$(chk_conta controle)/$(chk_incompleta controle)/$(chk_geracao controle)/$(chk_reconciliacao controle)/$(chk_pendentes controle)/$(chk_acl_sync controle)/$(chk_ambiguo controle)/$(chk_evento_concorrente controle)/$(chk_ean_unidades controle)"
CTRL_ESPERADO="excesso|1/tarefa_fora_de_separacao|suspensa_alteracao/suspensa_alteracao|0|4/linhas_incompletas/SEM_ERRO|true|1/22023/aguardando/coleta_velha|true/exige_reconciliacao_fisica/leituras_pendentes/false/codigo_ambiguo/22023/codigo_ambiguo"
if [ "$CTRL" != "$CTRL_ESPERADO" ]; then
  bad "CONTROLE não ficou verde ($CTRL) — falsificação abortada antes do 1º sed"
else
  ok "controle verde pelo caminho da sabotagem"

  sabotar() {  # $1 nome, $2 programa sed; exige que o sed MUDE o arquivo e que a cópia aplique
    local nome="$1" prog="$2"
    sed "$prog" "$MIG" > "$TMP/$nome.sql"
    if cmp -s "$MIG" "$TMP/$nome.sql"; then bad "F $nome: o sed não mudou nada (sabotagem inerte)"; return 1; fi
    if ! montar "$nome" "$TMP/$nome.sql" >"$TMP/$nome.log" 2>&1; then
      bad "F $nome: a cópia sabotada não aplicou ($(grep -m1 -E 'ERROR|ERRO' "$TMP/$nome.log" | head -c 300))"; return 1
    fi
  }
  # $1 rótulo, $2 obtido, $3 veredito verde, $4 o vermelho ESPERADO desta sabotagem. Exigir o
  # vermelho exato (e não "qualquer coisa ≠ verde") impede que um erro sem relação com a
  # sabotagem — cópia que nem montou, helper quebrado — conte como dente.
  vermelho() {
    if [ "$2" = "$3" ]; then bad "$1 e o cenário seguiu verde — assert sem dente"
    elif [ "$2" = "$4" ]; then ok "$1 → vermelho ($2)"
    else bad "$1 → saiu [$2], nem o verde [$3] nem o vermelho esperado [$4]"; fi
  }
  # Trecho só da RPC de leitura (o lock e o FOR UPDATE se repetem nas outras funções).
  # shellcheck disable=SC2016  # \$function\$ é o dollar-quote LITERAL do SQL, não expansão do bash
  LEIT='/^CREATE OR REPLACE FUNCTION public.picking_registrar_leitura(/,/^\$function\$;$/'

  # X1 — DUAS camadas serializam a leitura (advisory lock e FOR UPDATE da tarefa); cada uma
  # sozinha basta. Sem só uma, C1 segue verde (redundância esperada); sem as duas, vermelho.
  if sabotar x1a_sem_advisory "$LEIT{/pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || p_tarefa_id::text, 0));/d;}"; then
    v=$(chk_concorrencia x1a_sem_advisory)
    if [ "$v" = "excesso|1" ]; then ok "X1a só sem advisory → C1 verde (o FOR UPDATE serializa)"; else bad "X1a só sem advisory e C1 vermelho ($v) — o FOR UPDATE não serializa"; fi
  fi
  if sabotar x1b_sem_ambos "$LEIT{/pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || p_tarefa_id::text, 0));/d;s/WHERE t.id = p_tarefa_id FOR UPDATE;/WHERE t.id = p_tarefa_id;/;}"; then
    vermelho "X1b leitura sem lock nenhum (C1)" "$(chk_concorrencia x1b_sem_ambos)" "excesso|1" "aceita|2"
    vermelho "X1b leitura sem lock nenhum (C2 sync×leitura)" "$(chk_sync_vs_leitura x1b_sem_ambos)" "tarefa_fora_de_separacao|suspensa_alteracao" "aceita|suspensa_alteracao"
  fi

  # X2 — soma de TODAS as revisões (sem o filtro da vigente), uma camada por vez: a função de
  # saldo (decide excesso → aceita menos que 4) e a view (a tela volta a mostrar o progresso morto).
  if sabotar x2a_saldo_todas_revisoes 's/WHERE r.linha_id = p_linha_id AND r.aceita AND r.linha_revisao = p_revisao;/WHERE r.linha_id = p_linha_id AND r.aceita;/'; then
    vermelho "X2a saldo sem filtro de revisão (C3)" "$(chk_revisao x2a_saldo_todas_revisoes)" "suspensa_alteracao|0|4" "suspensa_alteracao|0|1"
  fi
  if sabotar x2b_view_todas_revisoes 's/WHERE r.linha_id = l.id AND r.aceita AND r.linha_revisao = l.revisao$/WHERE r.linha_id = l.id AND r.aceita/'; then
    vermelho "X2b view sem filtro de revisão (C3)" "$(chk_revisao x2b_view_todas_revisoes)" "suspensa_alteracao|0|4" "suspensa_alteracao|3|4"
  fi

  # X3 — concluir sem a igualdade por linha.
  if sabotar x3_sem_igualdade_por_linha '/^  ELSIF EXISTS (SELECT 1 FROM public.picking_linhas l$/,/^    v_res := jsonb_build_object(.ok., false, .motivo., .linhas_incompletas.);$/d'; then
    vermelho "X3 concluir sem igualdade por linha (C4)" "$(chk_por_linha x3_sem_igualdade_por_linha)" "linhas_incompletas" "ok"
  fi

  # X4 — leitura sem o replay por UUID: o reenvio vira erro (ou soma de novo).
  if sabotar x4_sem_replay "$LEIT{/^  SELECT \* INTO v_ex FROM public.picking_leituras r WHERE r.id = p_leitura_id;$/,/^  END IF;$/d;}"; then
    vermelho "X4 leitura sem replay por UUID (C5)" "$(chk_idempotencia x4_sem_replay)" "SEM_ERRO|true|1" "22023|ERRO|1"
  fi

  # X5 — pegar sem a checagem de conta.
  # shellcheck disable=SC2016  # \$function\$ é o dollar-quote LITERAL do SQL, não expansão do bash
  if sabotar x5_sem_conta '/^CREATE OR REPLACE FUNCTION public.picking_pegar_task(/,/^\$function\$;$/{/^  IF v_t.account <> p_account THEN$/,/^  END IF;$/d;}'; then
    vermelho "X5 pegar sem validar a conta (C6)" "$(chk_conta x5_sem_conta)" "22023" "SEM_ERRO"
  fi

  # X6 — listagem tratada como completa sempre.
  if sabotar x6_sempre_completa 's/^  v_completa := cardinality(p_presentes) = p_total_de_registros$/  v_completa := true OR cardinality(p_presentes) = p_total_de_registros/'; then
    vermelho "X6 listagem sempre completa (C7)" "$(chk_incompleta x6_sempre_completa)" "aguardando" "interrompida_externa"
  fi

  # X7 — sem a geração monotônica.
  if sabotar x7_sem_geracao 's/^  IF v_ultima IS NOT NULL AND p_coleta_iniciada_em <= v_ultima THEN$/  IF false THEN/'; then
    vermelho "X7 sem geração monotônica (C8)" "$(chk_geracao x7_sem_geracao)" "coleta_velha|true" "aplicada|false"
  fi

  # X8 — retomar sem exigir reconciliação física.
  if sabotar x8_sem_reconciliacao 's/^  ELSIF p_reconciliacao_fisica IS NOT TRUE THEN$/  ELSIF false THEN/'; then
    vermelho "X8 retomar sem reconciliação (C9)" "$(chk_reconciliacao x8_sem_reconciliacao)" "exige_reconciliacao_fisica" "ok"
  fi

  # X9 — concluir sem exigir as leituras em voo.
  if sabotar x9_sem_pendentes 's/^  ELSIF v_faltam > 0 THEN$/  ELSIF false THEN/'; then
    vermelho "X9 concluir sem leituras pendentes (C10)" "$(chk_pendentes x9_sem_pendentes)" "leituras_pendentes" "ok"
  fi

  # X10 — sync sem REVOKE de authenticated (a postcondição cai junto, senão a cópia nem aplica).
  if sabotar x10_sync_aberta '/^REVOKE ALL ON FUNCTION public.picking_sincronizar_fila(/,/^  FROM PUBLIC, anon, authenticated;$/s/FROM PUBLIC, anon, authenticated;/FROM PUBLIC, anon;/; /POSTCONDICAO: % executável por anon\/authenticated., v_fn;$/s/RAISE EXCEPTION/RAISE NOTICE/'; then
    vermelho "X10 sync executável por authenticated (A1)" "$(chk_acl_sync x10_sync_aberta)" "false" "true"
  fi

  # X12 — ambiguidade só por produto (a versão que o Codex reprovou): fator 6 vale 1 peça.
  if sabotar x12_ambiguo_so_produto 's/AND (l.omie_codigo_produto <> v_prod OR l.unidade <> v_cb_unid$/AND (l.omie_codigo_produto <> v_prod/; s/^                                       OR v_fator <> 1)) THEN$/                                       )) THEN/'; then
    vermelho "X12 ambiguidade só por produto (C11)" "$(chk_ambiguo x12_ambiguo_so_produto)" "codigo_ambiguo" "ok"
  fi

  # X13 — pegar sem ON CONFLICT: o UUID concorrente sai 23505 cru.
  # shellcheck disable=SC2016  # \$function\$ é o dollar-quote LITERAL do SQL, não expansão do bash
  if sabotar x13_evento_sem_on_conflict '/^CREATE OR REPLACE FUNCTION public.picking_pegar_task(/,/^\$function\$;$/{s/^  ON CONFLICT (id) DO NOTHING;$/  ;/;}'; then
    vermelho "X13 evento sem ON CONFLICT (C12)" "$(chk_evento_concorrente x13_evento_sem_on_conflict)" "22023" "23505"
  fi

  # X14 — EAN contado só por produto (a versão que o Codex reprovou na rodada 2).
  if sabotar x14_ean_so_produto 's/SELECT count(DISTINCT (l.omie_codigo_produto, l.unidade)) INTO v_nprod/SELECT count(DISTINCT l.omie_codigo_produto) INTO v_nprod/'; then
    vermelho "X14 EAN ambíguo só por produto (C13)" "$(chk_ean_unidades x14_ean_so_produto)" "codigo_ambiguo" "ok"
  fi

  # X11 — a postcondição morde E desfaz tudo: aplicada numa transação única (como o db:aplicar),
  # migration que deixa authenticated INSERIR em picking_leituras tem de ABORTAR sem deixar nada.
  # awk, não sed: o \n na substituição não existe no sed do macOS.
  awk '{print} /^  TO service_role;$/ && !feito {print "GRANT INSERT ON TABLE public.picking_leituras TO authenticated;"; feito=1}' "$MIG" > "$TMP/x11.sql"
  if cmp -s "$MIG" "$TMP/x11.sql"; then
    bad "X11: o sed não mudou nada"
  else
    "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres x11
    prereq x11
    if Pd x11 -1 -q -f "$TMP/x11.sql" >"$TMP/x11.log" 2>&1; then
      bad "X11 INSERT a authenticated e a migration NÃO abortou — postcondição sem dente"
    elif ! grep -q "POSTCONDICAO: picking_leituras gravável direto por authenticated" "$TMP/x11.log"; then
      bad "X11 abortou por OUTRO motivo: $(head -c 300 "$TMP/x11.log")"
    else
      ok "X11 INSERT direto a authenticated → postcondição abortou a migration"
      eq "X11b rollback integral: nem tabela nem RPC ficaram" \
        "$(Pq x11 "SELECT (to_regclass('public.picking_tarefas') IS NULL AND to_regprocedure('public.picking_concluir(uuid,text,uuid,uuid,integer,uuid[])') IS NULL)::text;")" "true"
    fi
  fi
fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
