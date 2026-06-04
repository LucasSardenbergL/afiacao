-- ============================================================================
-- SLA de resposta do WhatsApp — funções base + view
-- Spec: docs/superpowers/specs/2026-06-04-whatsapp-sla-resposta-design.md
-- Plano: docs/superpowers/plans/2026-06-04-whatsapp-sla-resposta.md
-- ⚠️ Migration MANUAL (Lovable não aplica custom): colar no SQL Editor.
-- ============================================================================

-- ===== PARTE 1 — funções =====================================================

-- stop-keyword: espelha src/lib/whatsapp/stop-keyword.ts (lista canônica).
-- Só dispara quando a mensagem É a palavra (1 token), não numa frase.
create or replace function public.wa_is_stop_keyword(p_body text)
returns boolean
language sql
immutable
as $$
  -- translate() remove acentos comuns (paridade c/ o NFD do TS) antes do strip/upper.
  select case
    when p_body is null then false
    else trim(upper(regexp_replace(
           translate(p_body,
             'àáâãäåèéêëìíîïòóôõöùúûüçñÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÇÑ',
             'aaaaaaeeeeiiiiooooouuuucnAAAAAAEEEEIIIIOOOOOUUUUCN'),
           '[^A-Za-z ]', '', 'g')))
         in ('PARAR','SAIR','STOP','CANCELAR','DESCADASTRAR')
  end;
$$;

-- minutos de expediente entre dois instantes (default seg-sex 07:30-17:30 SP).
-- Semântica meio-aberta [desde, ate) ∩ [h_inicio, h_fim) por dia útil.
create or replace function public.whatsapp_minutos_uteis(
  p_desde     timestamptz,
  p_ate       timestamptz,
  p_h_inicio  time   default '07:30',
  p_h_fim     time   default '17:30',
  p_dias      int[]  default array[1,2,3,4,5]   -- ISO DOW: 1=seg … 7=dom
) returns integer
language plpgsql
stable
as $$
declare
  v_total   interval := interval '0';
  v_dia     date;
  v_dia_fim date;
  v_jan_ini timestamptz;
  v_jan_fim timestamptz;
  v_ov_ini  timestamptz;
  v_ov_fim  timestamptz;
  v_guard   int := 0;
begin
  if p_desde is null or p_ate is null or p_desde >= p_ate then
    return 0;
  end if;
  v_dia     := (p_desde at time zone 'America/Sao_Paulo')::date;
  v_dia_fim := (p_ate   at time zone 'America/Sao_Paulo')::date;
  while v_dia <= v_dia_fim loop
    v_guard := v_guard + 1;
    exit when v_guard > 400;  -- guard anti-loop p/ conversa órfã de anos (já estaria no vermelho)
    if extract(isodow from v_dia)::int = any(p_dias) then
      v_jan_ini := (v_dia + p_h_inicio) at time zone 'America/Sao_Paulo';
      v_jan_fim := (v_dia + p_h_fim)    at time zone 'America/Sao_Paulo';
      v_ov_ini  := greatest(p_desde, v_jan_ini);
      v_ov_fim  := least(p_ate, v_jan_fim);
      if v_ov_fim > v_ov_ini then
        v_total := v_total + (v_ov_fim - v_ov_ini);
      end if;
    end if;
    v_dia := v_dia + 1;
  end loop;
  return floor(extract(epoch from v_total) / 60)::int;
end;
$$;

-- responsável efetivo de um cliente (dono da carteira + cobertura/férias), bypassando RLS
-- (security definer) p/ a view dar o MESMO dono pra QUALQUER leitor staff — senão o
-- security_invoker resolveria só a carteira visível ao leitor → falso "sem dono" pro gestor.
create or replace function public.wa_owner_efetivo(p_customer uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select cc.covering_user_id from public.carteira_coverage cc
      where cc.covered_user_id = ca.owner_user_id and cc.active
        and now() >= cc.valid_from and (cc.valid_until is null or now() <= cc.valid_until)
      order by cc.valid_from desc limit 1),
    ca.owner_user_id)
  from public.carteira_assignments ca
  where ca.customer_user_id = p_customer and ca.eligible
  order by ca.valid_from desc limit 1;
$$;
revoke execute on function public.wa_owner_efetivo(uuid) from public, anon;
grant execute on function public.wa_owner_efetivo(uuid) to authenticated, service_role;

-- ===== PARTE 2 — config + view ==============================================

-- Config global (company_config é key-value text). Idempotente.
insert into public.company_config(key, value) values
  ('whatsapp_sla_hora_inicio', '07:30'),
  ('whatsapp_sla_hora_fim',    '17:30'),
  ('whatsapp_sla_dias',        '1,2,3,4,5'),
  ('whatsapp_sla_atencao_min', '15'),
  ('whatsapp_sla_atrasado_min','30'),
  ('whatsapp_sla_digest_habilitado', 'true')
on conflict (key) do nothing;

create or replace view public.v_whatsapp_sla
with (security_invoker = on) as
with cfg as (
  select
    coalesce((select value from public.company_config where key='whatsapp_sla_hora_inicio'), '07:30')::time as h_inicio,
    coalesce((select value from public.company_config where key='whatsapp_sla_hora_fim'),    '17:30')::time as h_fim,
    coalesce((select string_to_array(value, ',')::int[] from public.company_config where key='whatsapp_sla_dias'),
             array[1,2,3,4,5]) as dias,
    coalesce((select value::int from public.company_config where key='whatsapp_sla_atencao_min'), 15) as atencao_min,
    coalesce((select value::int from public.company_config where key='whatsapp_sla_atrasado_min'), 30) as atrasado_min
),
-- âncora = hora real do WhatsApp, com guarda contra wa_timestamp FUTURO (clock-skew/webhook ruim
-- → cai pro created_at confiável, senão esconderia a espera real).
msgs as (
  select conversation_id, direction, body, sender_user_id, id, created_at,
    case when wa_timestamp is not null and wa_timestamp <= now() then wa_timestamp else created_at end as anchor
  from public.whatsapp_messages
),
-- última resposta HUMANA por conversa (out com sender_user_id; exclui blast/IA e template automático)
last_out as (
  select distinct on (conversation_id)
    conversation_id, anchor, created_at, id
  from msgs
  where direction = 'out' and sender_user_id is not null
  order by conversation_id, anchor desc, created_at desc, id desc
),
-- primeira mensagem do cliente ainda não respondida (exclui stop-keyword); tie-break determinístico
aguardando as (
  select distinct on (i.conversation_id)
    i.conversation_id,
    i.anchor as aguardando_desde
  from msgs i
  left join last_out lo on lo.conversation_id = i.conversation_id
  where i.direction = 'in'
    and not public.wa_is_stop_keyword(i.body)
    and (lo.conversation_id is null
         or (i.anchor, i.created_at, i.id) > (lo.anchor, lo.created_at, lo.id))
  order by i.conversation_id, i.anchor asc, i.created_at asc, i.id asc
),
-- responsável efetivo via função SECURITY DEFINER (mesmo dono pra qualquer leitor staff)
owner as (
  select c.id as conversation_id, public.wa_owner_efetivo(c.customer_user_id) as owner_user_id
  from public.whatsapp_conversations c
),
calc as (
  select a.conversation_id, a.aguardando_desde,
    public.whatsapp_minutos_uteis(a.aguardando_desde, now(), cfg.h_inicio, cfg.h_fim, cfg.dias) as minutos
  from aguardando a cross join cfg
)
select
  calc.conversation_id,
  conv.customer_user_id,
  conv.phone_e164,
  conv.contact_name,
  o.owner_user_id,
  calc.aguardando_desde,
  calc.minutos as minutos_uteis_aguardando,
  case
    when calc.minutos >= cfg.atrasado_min then 'vermelho'
    when calc.minutos >= cfg.atencao_min  then 'amarelo'
    else 'verde'
  end as nivel
from calc
join public.whatsapp_conversations conv on conv.id = calc.conversation_id
join owner o on o.conversation_id = calc.conversation_id
cross join cfg
where conv.status <> 'fechada';
