#!/usr/bin/env bash
# Teste PG17 da view order_feed (PR2 do #3 — read model da listagem de pedidos).
# Aplica schema-snapshot + a migration 20260606210000_order_feed_view.sql, semeia
# cenários controlados (incl. itens MALFORMADOS, soft-delete, pedido sem profile,
# items não-array, afiação) e assere o contrato da view.
# Base: db/verify-snapshot-replay.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5436
DATA="$(mktemp -d /tmp/pgtest-orderfeed.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-orderfeed.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres orderfeed_verify
P() { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d orderfeed_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-orderfeed.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ migration da view…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260606210000_order_feed_view.sql" >/dev/null

echo "→ seed dos cenários…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- auth.users primeiro (FKs de profiles/sales_orders/orders + trigger auto_assign_user_role).
-- O 99999999 existe em auth.users mas NÃO em profiles (cenário "sem profile").
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('99999999-9999-9999-9999-999999999999')
on conflict do nothing;

insert into public.profiles (id, user_id, name, document, is_approved)
values
  (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'ALICE LTDA', '11.111.111/0001-11', true),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'BOB ME',     '22.222.222/0001-22', true);

-- sales: normal, com 2 itens (qtd 2 + 1 = 3)
insert into public.sales_orders (id, customer_user_id, created_by, account, omie_numero_pedido, omie_pedido_id, items, status, subtotal, total, created_at, deleted_at)
values ('a0000001-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
  'oben','0000123',777,
  '[{"descricao":"Verniz","quantidade":2},{"descricao":"Catalisador","quantidade":1}]'::jsonb,
  'enviado', 100, 100, now() - interval '1 hour', null);

-- sales: SOFT-DELETED → não deve aparecer
insert into public.sales_orders (id, customer_user_id, created_by, account, items, status, subtotal, total, created_at, deleted_at)
values ('a0000002-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
  'oben','[{"descricao":"Apagado","quantidade":9}]'::jsonb,'cancelado',9,9, now(), now());

-- sales: itens MALFORMADOS (quantidade vazia e texto) → view NÃO pode quebrar; qty=0; names=['X','Y']
insert into public.sales_orders (id, customer_user_id, created_by, account, items, status, subtotal, total, created_at, deleted_at)
values ('a0000003-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222222',
  'colacor','[{"descricao":"X","quantidade":""},{"descricao":"Y","quantidade":"abc"}]'::jsonb,'rascunho',0,0, now() - interval '2 hour', null);

-- sales: SEM profile (customer_user_id órfão) → customer_name null
insert into public.sales_orders (id, customer_user_id, created_by, account, items, status, subtotal, total, created_at, deleted_at)
values ('a0000004-0000-0000-0000-000000000004','99999999-9999-9999-9999-999999999999','99999999-9999-9999-9999-999999999999',
  'oben','[{"descricao":"Z","quantidade":5}]'::jsonb,'enviado',5,5, now() - interval '3 hour', null);

-- sales: items NÃO-array (objeto) → item_names '{}', item_quantity 0, não quebra
insert into public.sales_orders (id, customer_user_id, created_by, account, items, status, subtotal, total, created_at, deleted_at)
values ('a0000005-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
  'oben','{}'::jsonb,'rascunho',0,0, now() - interval '4 hour', null);

-- afiação: origin='afiacao', account fixo colacor_sc, order_number null, qty 3
insert into public.orders (id, user_id, delivery_option, service_type, items, status, subtotal, total, created_at)
values ('b0000001-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','retirada','afiacao',
  '[{"category":"Afiacao Serra","quantity":3}]'::jsonb,'em_afiacao',50,50, now() - interval '30 minutes');

-- Cenários da coluna `busca` (20261101221452): nome com acento e entidade HTML, item com acento
-- e descrição vazia, total com centavos; afiação com item só de 'name' e item sem nada.
insert into auth.users (id) values ('33333333-3333-3333-3333-333333333333') on conflict do nothing;
insert into public.profiles (id, user_id, name, document, is_approved)
values (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'JOÃO &amp; FILHOS', '33.333.333/0001-33', true);
insert into public.sales_orders (id, customer_user_id, created_by, account, omie_numero_pedido, items, status, subtotal, total, created_at, deleted_at)
values ('a0000006-0000-0000-0000-000000000006','33333333-3333-3333-3333-333333333333','33333333-3333-3333-3333-333333333333',
  'colacor','0004567','[{"descricao":"Seladora Pólo","quantidade":2},{"descricao":"","quantidade":1}]'::jsonb,
  'enviado',250.5,250.5, now() - interval '5 hour', null);
insert into public.orders (id, user_id, delivery_option, service_type, items, status, subtotal, total, created_at)
values ('b0000002-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','retirada','afiacao',
  '[{"name":"Faca"},{"quantity":"x"}]'::jsonb,'em_afiacao',10,10, now() - interval '6 hour');
SQL

asserts() {
P -v ON_ERROR_STOP=1 -q <<'SQL'
do $$
declare r record;
begin
  -- 1. soft-deleted fora
  if exists (select 1 from public.order_feed where id='a0000002-0000-0000-0000-000000000002') then
    raise exception 'FALHOU: pedido soft-deleted apareceu na view';
  end if;

  -- 2. sales normal: nome via join, qtd somada, names em ordem, order_number, account, origin
  select * into r from public.order_feed where id='a0000001-0000-0000-0000-000000000001';
  if r.origin is distinct from 'sales' then raise exception 'FALHOU: origin sales (got %)', r.origin; end if;
  if r.customer_name is distinct from 'ALICE LTDA' then raise exception 'FALHOU: customer_name join (got %)', r.customer_name; end if;
  if r.item_quantity is distinct from 3 then raise exception 'FALHOU: item_quantity 2+1=3 (got %)', r.item_quantity; end if;
  if r.item_names is distinct from array['Verniz','Catalisador']::text[] then raise exception 'FALHOU: item_names ordem (got %)', r.item_names; end if;
  if r.order_number is distinct from '0000123' then raise exception 'FALHOU: order_number (got %)', r.order_number; end if;
  if r.account is distinct from 'oben' then raise exception 'FALHOU: account (got %)', r.account; end if;
  if r.omie_pedido_id is distinct from 777 then raise exception 'FALHOU: omie_pedido_id (got %)', r.omie_pedido_id; end if;

  -- 3. itens malformados: view não quebrou, qty=0, names preservados
  select * into r from public.order_feed where id='a0000003-0000-0000-0000-000000000003';
  if r.item_quantity is distinct from 0 then raise exception 'FALHOU: malformado item_quantity=0 (got %)', r.item_quantity; end if;
  if r.item_names is distinct from array['X','Y']::text[] then raise exception 'FALHOU: malformado item_names (got %)', r.item_names; end if;

  -- 4. sem profile → customer_name null (mas pedido aparece)
  select * into r from public.order_feed where id='a0000004-0000-0000-0000-000000000004';
  if not found or r.customer_name is not null then raise exception 'FALHOU: sem profile deveria ser null e o pedido aparecer (achado=%, got %)', found, r.customer_name; end if;
  if r.item_quantity is distinct from 5 then raise exception 'FALHOU: sem profile qty (got %)', r.item_quantity; end if;

  -- 5. items não-array → '{}' e 0
  select * into r from public.order_feed where id='a0000005-0000-0000-0000-000000000005';
  if r.item_names is distinct from '{}'::text[] then raise exception 'FALHOU: nao-array item_names vazio (got %)', r.item_names; end if;
  if r.item_quantity is distinct from 0 then raise exception 'FALHOU: nao-array item_quantity 0 (got %)', r.item_quantity; end if;

  -- 6. afiação
  select * into r from public.order_feed where id='b0000001-0000-0000-0000-000000000001';
  if r.origin is distinct from 'afiacao' then raise exception 'FALHOU: origin afiacao (got %)', r.origin; end if;
  if r.account is distinct from 'colacor_sc' then raise exception 'FALHOU: afiacao account colacor_sc (got %)', r.account; end if;
  if not found or r.order_number is not null then raise exception 'FALHOU: afiacao order_number null (achado=%, got %)', found, r.order_number; end if;
  if not found or r.omie_pedido_id is not null then raise exception 'FALHOU: afiacao omie_pedido_id null (achado=%, got %)', found, r.omie_pedido_id; end if;
  if r.customer_name is distinct from 'ALICE LTDA' then raise exception 'FALHOU: afiacao nome via join (got %)', r.customer_name; end if;
  if r.item_quantity is distinct from 3 then raise exception 'FALHOU: afiacao qty (got %)', r.item_quantity; end if;
  if r.item_names is distinct from array['Afiacao Serra']::text[] then raise exception 'FALHOU: afiacao names (got %)', r.item_names; end if;

  -- 7. a view inteira roda sem erro de cast (conta os 6 vivos: 5 sales nao-deletados + 1 afiacao)
  if (select count(*) from public.order_feed
      where id in ('a0000001-0000-0000-0000-000000000001','a0000003-0000-0000-0000-000000000003',
                   'a0000004-0000-0000-0000-000000000004','a0000005-0000-0000-0000-000000000005',
                   'b0000001-0000-0000-0000-000000000001')) IS DISTINCT FROM 5 then
    raise exception 'FALHOU: contagem dos pedidos vivos esperados';
  end if;

  raise notice 'TODOS OS ASSERTS PASSARAM';
end $$;
SQL
}

echo "→ asserts (view de 20260606210000)…"
asserts

# ── 20261101221452: busca no servidor + itens calculados na projeção final ──────────────
# As 13 colunas têm de sair IGUAIS às da view anterior (linha a linha), e `busca` entra no fim.
P -v ON_ERROR_STOP=1 -q -c "create table public._feed_antes as select * from public.order_feed"

echo "→ migration da busca (2× — a 2ª prova a idempotência)…"
MIG_BUSCA="$REPO_ROOT/supabase/migrations/20261101221452_order_feed_busca_servidor.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$MIG_BUSCA" >/dev/null
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$MIG_BUSCA" >/dev/null

echo "→ asserts (view nova)…"
asserts

P -v ON_ERROR_STOP=1 -q <<'SQL'
do $$
declare r record; v_dif int;
begin
  -- 8. mesmas linhas e colunas que a view anterior (nos dois sentidos, com multiplicidade)
  select count(*) into v_dif from (
    (select origin,id,created_at,account,order_number,omie_pedido_id,customer_user_id,customer_name,
            item_names,item_quantity,status,subtotal,total from public.order_feed
     except all select * from public._feed_antes)
    union all
    (select * from public._feed_antes
     except all select origin,id,created_at,account,order_number,omie_pedido_id,customer_user_id,customer_name,
            item_names,item_quantity,status,subtotal,total from public.order_feed)) d;
  if v_dif <> 0 then raise exception 'FALHOU: view nova difere da anterior em % linha(s)', v_dif; end if;

  -- 9. busca: sem acento, minúsculas, entidade decodificada, item vazio fora, total nos 2 formatos
  select * into r from public.order_feed where id='a0000006-0000-0000-0000-000000000006';
  if r.busca is distinct from E'joao & filhos\n0004567\nseladora polo\n250.50\n250,50' then
    raise exception 'FALHOU: busca sales (got %)', r.busca;
  end if;
  if r.item_names is distinct from array['Seladora Pólo']::text[] then raise exception 'FALHOU: item vazio fora (got %)', r.item_names; end if;

  -- 10. afiação: name e o padrão 'Afiação' entram na busca; quantidade ausente/malformada conta 1
  select * into r from public.order_feed where id='b0000002-0000-0000-0000-000000000002';
  if r.item_names is distinct from array['Faca','Afiação']::text[] then raise exception 'FALHOU: afiacao names padrao (got %)', r.item_names; end if;
  if r.item_quantity is distinct from 2 then raise exception 'FALHOU: afiacao qty padrao 1+1 (got %)', r.item_quantity; end if;
  if r.busca is distinct from E'joao & filhos\n\nfaca afiacao\n10.00\n10,00' then raise exception 'FALHOU: busca afiacao (got %)', r.busca; end if;

  -- 11. sem profile e items não-array: busca existe (não vira NULL) e não quebra
  select * into r from public.order_feed where id='a0000004-0000-0000-0000-000000000004';
  if r.busca is distinct from E'\n\nz\n5.00\n5,00' then raise exception 'FALHOU: busca sem profile (got %)', r.busca; end if;
  select * into r from public.order_feed where id='a0000005-0000-0000-0000-000000000005';
  if r.busca is distinct from E'alice ltda\n\n\n0.00\n0,00' then raise exception 'FALHOU: busca items nao-array (got %)', r.busca; end if;

  -- 12. o filtro que o front manda: um termo não casa atravessando dois campos
  if (select count(*) from public.order_feed where busca ilike '%filhos%0004567%') <> 1 then
    raise exception 'FALHOU: ilike dentro da coluna';
  end if;
  if exists (select 1 from public.order_feed where busca ilike '%filhos 0004567%') then
    raise exception 'FALHOU: termo casou atravessando nome e número';
  end if;

  -- 13. security_invoker sobreviveu ao replace (omitir o WITH reseta e a view fura a RLS)
  if not exists (select 1 from pg_class c, unnest(c.reloptions) o
                 where c.oid='public.order_feed'::regclass and o in ('security_invoker=true','security_invoker=on')) then
    raise exception 'FALHOU: order_feed perdeu security_invoker';
  end if;

  raise notice 'ASSERTS DA BUSCA PASSARAM';
end $$;
SQL

echo "✅ order_feed: todos os asserts passaram (PG17)"
