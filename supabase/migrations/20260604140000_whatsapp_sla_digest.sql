-- ============================================================================
-- SLA de resposta do WhatsApp — F2: digest diário por e-mail
-- Spec: docs/superpowers/specs/2026-06-04-whatsapp-sla-resposta-design.md
-- Depende da F1 (20260604130000_whatsapp_sla.sql) estar aplicada.
-- ⚠️ Migration MANUAL: colar no SQL Editor.
-- ============================================================================

-- estende o CHECK de tipo (lista canônica de prod + whatsapp_sla)
alter table public.fornecedor_alerta drop constraint if exists fornecedor_alerta_tipo_check;
alter table public.fornecedor_alerta add constraint fornecedor_alerta_tipo_check
  check (tipo in ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro',
                  'mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','whatsapp_sla','outro'));

-- guarda de idempotência: 1 digest por dia local (cron repetido/retry não duplica e-mail)
create table if not exists public.whatsapp_sla_digest_log (
  data_local date primary key,
  created_at timestamptz not null default now()
);
alter table public.whatsapp_sla_digest_log enable row level security;
-- sem policies → só service_role/definer escrevem (padrão das tabelas de motor)

create or replace function public.whatsapp_sla_digest_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hoje      date := (now() at time zone 'America/Sao_Paulo')::date;
  v_habil     text;
  v_vermelhos int;
  v_titulo    text;
  v_msg       text;
begin
  select value into v_habil from public.company_config where key='whatsapp_sla_digest_habilitado';
  if coalesce(v_habil,'true') <> 'true' then return; end if;

  -- idempotência: marca o dia; se já marcado, sai (sem duplicar)
  insert into public.whatsapp_sla_digest_log(data_local) values (v_hoje) on conflict do nothing;
  if not found then return; end if;

  select count(*) into v_vermelhos from public.v_whatsapp_sla where nivel='vermelho';
  if v_vermelhos = 0 then return; end if;  -- dia marcado, nada atrasado → sem e-mail

  -- corpo: por vendedora (nome via profiles) + balde sem-dono; sem-dono por último, mais-vermelhos primeiro
  select string_agg(linha, E'\n' order by ord) into v_msg from (
    select
      coalesce(p.name, '⚠️ Sem dono (cliente sem carteira)') || ': '
        || count(*) || ' esperando, '
        || count(*) filter (where s.nivel='vermelho') || ' atrasado(s), pior '
        || max(s.minutos_uteis_aguardando) || ' min' as linha,
      (case when s.owner_user_id is null then 1 else 0 end) * 1000000
        - count(*) filter (where s.nivel='vermelho') as ord
    from public.v_whatsapp_sla s
    left join public.profiles p on p.user_id = s.owner_user_id
    group by s.owner_user_id, p.name
  ) t;

  v_titulo := 'WhatsApp: ' || v_vermelhos || ' cliente(s) atrasado(s) hoje';

  insert into public.fornecedor_alerta(tipo, empresa, severidade, status, titulo, mensagem)
  values ('whatsapp_sla', 'oben', 'atencao', 'pendente_notificacao', v_titulo, v_msg);
end;
$$;

-- cron: 21:00 UTC = 18:00 BRT, seg-sex (chamada SQL LOCAL, sem net.http_post)
select cron.schedule('whatsapp-sla-digest-diario', '0 21 * * 1-5', $$select public.whatsapp_sla_digest_tick()$$);
