#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA das views CRM v_cliente_interacoes + v_carteira_sla      ║
# ║    • v_cliente_interacoes  — timeline 360° (4 fontes) com gate de carteira     ║
# ║    • v_carteira_sla        — fila de SLA de contato vencido (Task 2)           ║
# ║                                                                                ║
# ║  Rode:   bash db/test-crm-carteira.sh > /tmp/t.log 2>&1; echo "exit=$?"        ║
# ║          (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)               ║
# ║                                                                                ║
# ║  FALSIFICAÇÃO (Lei #3) — re-rode com a sabotagem e EXIJA vermelho:             ║
# ║     SABOTAR=gate_om   → ASSERT1 (vazamento entre carteiras) deve FALHAR        ║
# ║     SABOTAR=sla_x100  → ASSERT6 (cliente de 20 dias) deve FALHAR               ║
# ║   Sem SABOTAR (views reais) → tudo VERDE.                                      ║
# ║                                                                                ║
# ║  Lei de Ferro: (1) aplica a MIGRATION REAL                                     ║
# ║  (supabase/migrations/20260623224637_crm_views_cliente_interacoes_e_           ║
# ║   carteira_sla.sql), não um stub da lógica; (2) asserts isolam por carteira    ║
# ║  via GUC; (3) sabota a view (gate_om) e exige vermelho.                        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="crm-carteira"
SABOTAR="${SABOTAR:-}"     # vazio = view real; "gate_om" = falsificação do gate de carteira
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
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup PG17 :$PORT  (SABOTAR='${SABOTAR:-<nenhuma>}') ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: stubs do gate + auth.uid() + tabelas-stub mínimas
# (NÃO replicamos o schema de prod; só as colunas que a view toca + as do seed)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- Roles que o GRANT da view referencia (no Supabase já existem; no PG limpo, não).
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role anon;          exception when duplicate_object then null; end $$;

-- auth.uid() lê do GUC request.jwt.claim.sub (igual ao Supabase em runtime)
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $f$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;

-- Stubs CONTROLÁVEIS do gate de carteira (em PROD são SECURITY DEFINER reais).
-- pode_ver_carteira_completa → ligado pelo GUC test.gestor (impersona gestor).
create or replace function public.pode_ver_carteira_completa(_uid uuid) returns boolean
  language sql stable as $f$ select coalesce(current_setting('test.gestor', true) = 'on', false) $f$;
-- carteira_visivel_para → vê só os clientes cuja carteira (test_carteira) é do _uid.
create table if not exists public.test_carteira (dono uuid, cliente uuid);
create or replace function public.carteira_visivel_para(_customer_user_id uuid, _uid uuid) returns boolean
  language sql stable as $f$
    select exists (select 1 from public.test_carteira c
                   where c.cliente = _customer_user_id and c.dono = _uid)
  $f$;

-- Tabelas-stub mínimas (só colunas usadas pela view + pelo seed).
create table if not exists public.farmer_calls (
  id uuid, farmer_id uuid, customer_user_id uuid,
  call_type text, call_result text,
  started_at timestamptz, created_at timestamptz,
  is_whatsapp boolean, notes text, revenue_generated numeric
);
create table if not exists public.route_visits (
  id uuid, customer_user_id uuid, visited_by uuid,
  visit_date date, check_in_at timestamptz, visit_type text,
  notes text, revenue_generated numeric, created_at timestamptz
);
create table if not exists public.tarefas (
  id uuid, descricao text, categoria text, customer_user_id uuid,
  assigned_to uuid, status text, concluida_em timestamptz,
  nota_conclusao text, created_at timestamptz
);
create table if not exists public.order_messages (
  id uuid, order_id uuid, sender_id uuid, message text,
  is_staff boolean, created_at timestamptz
);
create table if not exists public.orders (id uuid, user_id uuid);

-- Task 2 (v_carteira_sla): scores por cliente + config de SLA
create table if not exists public.farmer_client_scores (
  id uuid, customer_user_id uuid, farmer_id uuid,
  health_class text, churn_risk numeric, priority_score numeric
);
create table if not exists public.farmer_algorithm_config (
  id uuid, key text, value numeric
);
SQL
echo "→ stubs + tabelas-stub criadas (Task 1 + Task 2)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (semeia como postgres; superuser ignora RLS e TEM privilégio)
# 2 carteiras: cliente A → vendedor V1; cliente B → vendedor V2.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- V1=1111..., V2=2222...   A=aaaa...0001  B=bbbb...0002
insert into public.test_carteira(dono, cliente) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-0000-0000-0000-000000000002');

-- Cliente A (V1): 1 ligação de SUCESSO há 2 dias, 1 visita com check-in há 10 dias, 1 msg de pedido há 3 dias.
insert into public.farmer_calls(id, farmer_id, customer_user_id, call_type, call_result, started_at, created_at, is_whatsapp, notes, revenue_generated)
  values (gen_random_uuid(),'11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','follow_up','contato_sucesso', now()-interval '2 days', now()-interval '2 days', false, 'falei com comprador', 1500);
insert into public.route_visits(id, customer_user_id, visited_by, visit_date, check_in_at, visit_type, notes, revenue_generated, created_at)
  values (gen_random_uuid(),'aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111', current_date, now()-interval '10 days','relacionamento','visita ok', null, now()-interval '10 days');
insert into public.orders(id, user_id) values ('dddddddd-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001');
insert into public.order_messages(id, order_id, sender_id, message, is_staff, created_at)
  values (gen_random_uuid(),'dddddddd-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','segue seu pedido', true, now()-interval '3 days');

-- Cliente B (V2): 1 tarefa.
insert into public.tarefas(id, descricao, categoria, customer_user_id, assigned_to, status, created_at)
  values (gen_random_uuid(),'oferecer bundle','oferta','bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','ativa', now()-interval '1 day');
-- Cliente B (V2): 1 msg de pedido — fonte order_messages tem RLS STAFF-AMPLO. É a ISCA da falsificação:
-- com o gate, V1 NÃO vê (B não é da carteira dele); sem o gate (SABOTAR=gate_om), V1 veria → vazamento.
insert into public.orders(id, user_id) values ('dddddddd-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002');
insert into public.order_messages(id, order_id, sender_id, message, is_staff, created_at)
  values (gen_random_uuid(),'dddddddd-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','msg do pedido do B', true, now()-interval '5 days');

-- Ramo DONO: V3 fez 1 ligação para o cliente E, que NÃO está na carteira de ninguém.
-- A RLS de farmer_calls inclui o ramo "dono" (farmer_id=uid) → a view deve espelhá-lo:
-- V3 vê (fez a ligação); V1 NÃO vê (nem carteira, nem dono).
insert into public.farmer_calls(id, farmer_id, customer_user_id, call_type, call_result, started_at, created_at, is_whatsapp, notes, revenue_generated)
  values (gen_random_uuid(),'33333333-3333-3333-3333-333333333333','eeeeeeee-0000-0000-0000-000000000004','follow_up','contato_sucesso', now()-interval '1 day', now()-interval '1 day', false, 'ligacao propria fora de carteira', null);

-- Task 2 (SLA): config 14 dias + scores + cliente-borda C (V1) contatado há 20 dias.
insert into public.farmer_algorithm_config(id, key, value) values (gen_random_uuid(),'sla_contact_days',14);
-- A=saudável (contato há 2d → fora da fila); B=crítico (sem contato efetivo → vencido); C=estável (20d → vence por SLA).
insert into public.farmer_client_scores(id, customer_user_id, farmer_id, health_class, churn_risk, priority_score) values
  (gen_random_uuid(),'aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','saudavel',10,50),
  (gen_random_uuid(),'bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','critico', 80,90),
  (gen_random_uuid(),'cccccccc-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','estavel', 30,40);
insert into public.test_carteira(dono, cliente) values
  ('11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000003');
-- C: última ligação de SUCESSO há 20 dias (> SLA 14 → deve vencer). É o discriminador da falsificação sla_x100.
insert into public.farmer_calls(id, farmer_id, customer_user_id, call_type, call_result, started_at, created_at, is_whatsapp, notes, revenue_generated)
  values (gen_random_uuid(),'11111111-1111-1111-1111-111111111111','cccccccc-0000-0000-0000-000000000003','follow_up','contato_sucesso', now()-interval '20 days', now()-interval '20 days', false, 'ult contato', null);
SQL
echo "→ seed: 2 carteiras (A→V1, B→V2) + isca de vazamento (msg de B) + Task 2 (scores A/B/C, cliente-borda 20d)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1: o .sql commitado que vai pro Lovable)
# (As tabelas-stub já existem → o create view resolve as colunas.)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260623224637_crm_views_cliente_interacoes_e_carteira_sla.sql"
P -q -f "$MIG"
echo "→ migration aplicada: $(basename "$MIG")"

# ── FALSIFICAÇÃO opcional: re-cria a view furada DEPOIS do SQL real (a última vence) ──
if [ "$SABOTAR" = "gate_om" ]; then
  echo "  ⚠️  SABOTAGEM ativa: removendo o gate de carteira da subquery de order_messages"
  P -q <<'SQL'
  create or replace view public.v_cliente_interacoes
  with (security_invoker = true) as
  select fc.customer_user_id, coalesce(fc.started_at, fc.created_at) as at,
    case when fc.is_whatsapp then 'whatsapp' else 'ligacao' end as canal,
    case fc.call_type when 'reativacao' then 'Reativação' when 'cross_sell' then 'Cross-sell'
      when 'up_sell' then 'Up-sell' when 'follow_up' then 'Follow-up' else 'Contato' end as titulo,
    nullif(fc.notes, '') as resumo, 'farmer_calls'::text as ref_tabela, fc.id as ref_id,
    fc.farmer_id as autor_id, fc.revenue_generated as revenue
  from public.farmer_calls fc
  where fc.customer_user_id is not null
    and (pode_ver_carteira_completa(auth.uid()) or fc.farmer_id = auth.uid() or carteira_visivel_para(fc.customer_user_id, auth.uid()))
  union all
  select rv.customer_user_id, coalesce(rv.check_in_at, rv.visit_date::timestamptz, rv.created_at),
    'visita', coalesce(nullif(rv.visit_type,''), 'Visita'), nullif(rv.notes,''),
    'route_visits', rv.id, rv.visited_by, rv.revenue_generated
  from public.route_visits rv
  where rv.customer_user_id is not null
    and (pode_ver_carteira_completa(auth.uid()) or rv.visited_by = auth.uid() or carteira_visivel_para(rv.customer_user_id, auth.uid()))
  union all
  select t.customer_user_id, coalesce(t.concluida_em, t.created_at), 'tarefa',
    coalesce(nullif(t.categoria,''), 'Tarefa'),
    coalesce(nullif(t.nota_conclusao,''), nullif(t.descricao,'')),
    'tarefas', t.id, t.assigned_to, null::numeric
  from public.tarefas t
  where t.customer_user_id is not null
    and (pode_ver_carteira_completa(auth.uid()) or carteira_visivel_para(t.customer_user_id, auth.uid()))
  union all
  -- ↓↓↓ GATE REMOVIDO de propósito: a fonte order_messages tem RLS staff-amplo, então
  --     sem o predicado de carteira, V1 passaria a ver msg de pedido de QUALQUER cliente.
  select o.user_id, om.created_at, 'mensagem_pedido',
    case when om.is_staff then 'Mensagem da equipe' else 'Mensagem do cliente' end,
    nullif(om.message,''), 'order_messages', om.id, om.sender_id, null::numeric
  from public.order_messages om
  join public.orders o on o.id = om.order_id
  where o.user_id is not null;
SQL
fi

# ── FALSIFICAÇÃO SLA: SABOTAR=sla_x100 → SLA absurdo (dias*100); cliente C (20d) NÃO venceria ──
if [ "$SABOTAR" = "sla_x100" ]; then
  echo "  ⚠️  SABOTAGEM ativa: sla.dias * 100 (cliente de 20 dias deixaria de vencer)"
  P -q <<'SQL'
  create or replace view public.v_carteira_sla
  with (security_invoker = true) as
  with sla as (select coalesce((select value from public.farmer_algorithm_config where key='sla_contact_days'),14)::int as dias),
  ultimo_contato as (
    select customer_user_id, max(at) as last_contact_at from (
      select customer_user_id, coalesce(started_at, created_at) as at
        from public.farmer_calls where customer_user_id is not null and call_result='contato_sucesso'
      union all
      select customer_user_id, check_in_at as at
        from public.route_visits where customer_user_id is not null and check_in_at is not null
    ) x group by customer_user_id)
  select fcs.customer_user_id, fcs.farmer_id, fcs.health_class, fcs.churn_risk, fcs.priority_score,
    uc.last_contact_at,
    case when uc.last_contact_at is null then null
         else floor(extract(epoch from (now()-uc.last_contact_at))/86400)::int end as dias_sem_contato,
    sla.dias as sla_dias,
    (uc.last_contact_at is null or (now()-uc.last_contact_at) > make_interval(days => sla.dias * 100)) as vencido
  from public.farmer_client_scores fcs cross join sla
  left join ultimo_contato uc on uc.customer_user_id = fcs.customer_user_id
  where fcs.health_class in ('atencao','critico') or uc.last_contact_at is null
     or (now()-uc.last_contact_at) > make_interval(days => sla.dias * 100);
SQL
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS (Task 1: gate/isolamento + normalização)
# ══════════════════════════════════════════════════════════════════════════════
# A partir daqui erros de SQL num assert devem virar ❌ contado (não abortar mudo).
set +e
echo "── asserts Task 1: v_cliente_interacoes ──"

# ASSERT 1 (positivo + isolamento): V1 vê as 3 interações do cliente A e NÃO vê o cliente B.
A1=$(P -tA 2>&1 <<'SQL'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111'; set test.gestor='off';
do $$
declare n int;
begin
  select count(*) into n from public.v_cliente_interacoes where customer_user_id='aaaaaaaa-0000-0000-0000-000000000001';
  if n <> 3 then raise exception 'A1_CONTAGEM_ERRADA n=%', n; end if;
  perform 1 from public.v_cliente_interacoes where customer_user_id='bbbbbbbb-0000-0000-0000-000000000002';
  if found then raise exception 'A1_VAZAMENTO_B'; end if;
  raise notice 'A1_VERDE';
end $$;
SQL
) || true
case "$A1" in
  *A1_VERDE*)           ok "A1 V1 vê 3 interações de A e NÃO vê B (isolamento)" ;;
  *A1_VAZAMENTO_B*)     bad "A1 VAZAMENTO: V1 viu interação do cliente B (carteira de outro) — $A1" ;;
  *A1_CONTAGEM_ERRADA*) bad "A1 contagem de A != 3 — $A1" ;;
  *)                    bad "A1 erro inesperado — $A1" ;;
esac

# ASSERT 2 (gate por carteira): V2 NÃO vê NADA do cliente A.
A2=$( { Pq -c "set request.jwt.claim.sub='22222222-2222-2222-2222-222222222222'; set test.gestor='off'; select count(*) from public.v_cliente_interacoes where customer_user_id='aaaaaaaa-0000-0000-0000-000000000001';" 2>&1 || true; } | tail -1)
eq "A2 V2 não vê interações de A (isolamento de carteira)" "$A2" "0"

# ASSERT 3 (gestor): pode_ver_carteira_completa=on vê A e B (>=4 interações no total).
A3=$( { Pq -c "set request.jwt.claim.sub='99999999-9999-9999-9999-999999999999'; set test.gestor='on'; select count(*) from public.v_cliente_interacoes;" 2>&1 || true; } | tail -1)
if [[ "${A3:-}" =~ ^[0-9]+$ ]] && [ "$A3" -ge 4 ]; then ok "A3 gestor vê a carteira toda (>=4 interações, veio $A3)"; else bad "A3 gestor deveria ver >=4, veio [$A3]"; fi

# ASSERT 4 (normalização): canais e revenue corretos (ligacao+revenue=1500; visita presente; mensagem da equipe).
A4=$(P -tA 2>&1 <<'SQL'
set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111'; set test.gestor='off';
do $$
begin
  perform 1 from public.v_cliente_interacoes where ref_tabela='farmer_calls' and canal='ligacao' and revenue=1500 and titulo='Follow-up';
  if not found then raise exception 'A4_LIGACAO_NORM'; end if;
  perform 1 from public.v_cliente_interacoes where ref_tabela='route_visits' and canal='visita' and revenue is null;
  if not found then raise exception 'A4_VISITA'; end if;
  perform 1 from public.v_cliente_interacoes where ref_tabela='order_messages' and canal='mensagem_pedido' and titulo='Mensagem da equipe';
  if not found then raise exception 'A4_MENSAGEM'; end if;
  raise notice 'A4_VERDE';
end $$;
SQL
) || true
case "$A4" in
  *A4_VERDE*) ok "A4 normalização: ligacao(rev=1500), visita(rev null), mensagem da equipe" ;;
  *)          bad "A4 normalização incorreta — $A4" ;;
esac

# ASSERT 8 (ramo DONO): V3 vê a PRÓPRIA ligação do cliente E (fora de qualquer carteira).
A8=$( { Pq -c "set request.jwt.claim.sub='33333333-3333-3333-3333-333333333333'; set test.gestor='off'; select count(*) from public.v_cliente_interacoes where customer_user_id='eeeeeeee-0000-0000-0000-000000000004';" 2>&1 || true; } | tail -1)
eq "A8 V3 vê a própria ligação (ramo dono) de cliente fora da carteira" "$A8" "1"

# ASSERT 8b (não-vazamento do DONO): V1 NÃO vê a ligação de E (nem carteira, nem dono dele).
A8b=$( { Pq -c "set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111'; set test.gestor='off'; select count(*) from public.v_cliente_interacoes where customer_user_id='eeeeeeee-0000-0000-0000-000000000004';" 2>&1 || true; } | tail -1)
eq "A8b V1 não vê ligação de E (o ramo dono é só do próprio autor)" "$A8b" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — ASSERTS (Task 2: v_carteira_sla — fila de SLA de contato)
# (gestor vê a carteira toda; A=saudável+em dia deve ficar FORA da fila.)
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts Task 2: v_carteira_sla ──"

# ASSERT 5: cliente B (crítico, sem contato efetivo) está na fila e VENCIDO.
A5=$(P -tA 2>&1 <<'SQL'
set request.jwt.claim.sub='99999999-9999-9999-9999-999999999999'; set test.gestor='on';
do $$
declare v boolean;
begin
  select vencido into v from public.v_carteira_sla where customer_user_id='bbbbbbbb-0000-0000-0000-000000000002';
  if v is distinct from true then raise exception 'A5_B_NAO_VENCIDO v=%', v; end if;
  raise notice 'A5_VERDE';
end $$;
SQL
) || true
case "$A5" in
  *A5_VERDE*) ok "A5 cliente B (sem contato efetivo) na fila e vencido" ;;
  *)          bad "A5 B deveria estar vencido — $A5" ;;
esac

# ASSERT 6 (borda + discriminador da falsificação sla_x100): C contatado há 20 dias VENCE o SLA de 14.
A6=$(P -tA 2>&1 <<'SQL'
set request.jwt.claim.sub='99999999-9999-9999-9999-999999999999'; set test.gestor='on';
do $$
declare v boolean; d int;
begin
  select vencido, dias_sem_contato into v, d from public.v_carteira_sla where customer_user_id='cccccccc-0000-0000-0000-000000000003';
  if not found then raise exception 'A6_C_AUSENTE'; end if;
  if v is distinct from true then raise exception 'A6_C_NAO_VENCIDO v=% d=%', v, d; end if;
  raise notice 'A6_VERDE_d=%', d;
end $$;
SQL
) || true
case "$A6" in
  *A6_VERDE*) ok "A6 cliente C (20 dias) vence o SLA de 14 ($(echo "$A6" | grep -o 'A6_VERDE_d=[0-9]*'))" ;;
  *A6_C_AUSENTE*)      bad "A6 C sumiu da fila (SLA frouxo?) — $A6" ;;
  *A6_C_NAO_VENCIDO*)  bad "A6 C (20d) NÃO venceu — $A6" ;;
  *)                   bad "A6 erro inesperado — $A6" ;;
esac

# ASSERT 7 (filtro da fila): cliente A (saudável, contato há 2 dias) NÃO aparece na fila de SLA.
A7=$( { Pq -c "set request.jwt.claim.sub='99999999-9999-9999-9999-999999999999'; set test.gestor='on'; select count(*) from public.v_carteira_sla where customer_user_id='aaaaaaaa-0000-0000-0000-000000000001';" 2>&1 || true; } | tail -1)
eq "A7 cliente A (saudável, em dia) fora da fila de SLA" "$A7" "0"

# ── veredito ──
set -e
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail   (SABOTAR='${SABOTAR:-<nenhuma>}')"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
