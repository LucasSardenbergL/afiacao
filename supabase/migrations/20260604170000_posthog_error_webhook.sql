-- ============================================================================
-- PostHog → erro de produção por e-mail: tabela de dedupe + RPC atômica + CHECK
-- Spec: docs/superpowers/specs/2026-06-04-posthog-erro-email-design.md
-- ⚠️ Migration MANUAL: colar no SQL Editor. APLICAR ANTES de habilitar o alerta no PostHog.
-- ============================================================================

create table if not exists public.posthog_error_webhook_log (
  id          bigint generated always as identity primary key,
  dedupe_key  text not null unique,
  issue_id    text,
  action      text,
  payload_raw text,
  alerta_id   bigint,
  criado_em   timestamptz not null default now()
);
alter table public.posthog_error_webhook_log enable row level security;
-- sem policies → só service_role/definer escrevem (padrão das tabelas de motor)

-- RPC atômica: dedupe + circuit breaker + insert numa única transação.
create or replace function public.enfileirar_erro_app(
  p_dedupe_key text,
  p_issue_id   text,
  p_action     text,
  p_payload_raw text,
  p_titulo     text,
  p_mensagem   text,
  p_metadata   jsonb,
  p_rollup_key text,
  p_lista_url  text,
  p_cap        int default 10
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log_id    bigint;
  v_rollup_id bigint;
  v_count     int;
  v_alerta_id bigint;
begin
  -- 1. dedupe (atômico): grava a chave; se já existe, no-op (mata retry/reenvio)
  insert into public.posthog_error_webhook_log(dedupe_key, issue_id, action, payload_raw)
    values (p_dedupe_key, p_issue_id, p_action, left(coalesce(p_payload_raw,''), 8000))
    on conflict (dedupe_key) do nothing
    returning id into v_log_id;
  if v_log_id is null then
    return jsonb_build_object('status','deduped');
  end if;

  -- 2. circuit breaker: conta erro_app INDIVIDUAIS na janela de 30min (exclui rollups)
  select count(*) into v_count from public.fornecedor_alerta
    where tipo = 'erro_app'
      and coalesce(metadata->>'kind','') <> 'rollup'
      and criado_em > now() - interval '30 minutes';

  if v_count >= p_cap then
    -- tempestade: 1 rollup por janela (dedupado por rollup_key)
    insert into public.posthog_error_webhook_log(dedupe_key, action)
      values (p_rollup_key, 'rollup')
      on conflict (dedupe_key) do nothing
      returning id into v_rollup_id;
    if v_rollup_id is null then
      return jsonb_build_object('status','rollup_suprimido');  -- já há rollup nesta janela
    end if;
    insert into public.fornecedor_alerta(tipo, empresa, severidade, status, titulo, mensagem, metadata)
      values ('erro_app','oben','atencao','pendente_notificacao',
              'Tempestade de erros no app',
              'Muitos erros novos em 30 min. Veja a lista no PostHog: ' || coalesce(p_lista_url,'(sem link)'),
              jsonb_build_object('kind','rollup'))
      returning id into v_alerta_id;
    update public.posthog_error_webhook_log set alerta_id = v_alerta_id where id = v_rollup_id;
    return jsonb_build_object('status','rollup','alerta_id',v_alerta_id);
  end if;

  -- 3. alerta individual
  insert into public.fornecedor_alerta(tipo, empresa, severidade, status, titulo, mensagem, metadata)
    values ('erro_app','oben','atencao','pendente_notificacao',
            p_titulo, p_mensagem, coalesce(p_metadata,'{}'::jsonb))
    returning id into v_alerta_id;
  update public.posthog_error_webhook_log set alerta_id = v_alerta_id where id = v_log_id;
  return jsonb_build_object('status','enfileirado','alerta_id',v_alerta_id);
end;
$$;

-- só a edge (service_role) executa; no Supabase REVOKE FROM PUBLIC não basta
revoke execute on function public.enfileirar_erro_app(text,text,text,text,text,text,jsonb,text,text,int)
  from public, anon, authenticated;
grant execute on function public.enfileirar_erro_app(text,text,text,text,text,text,jsonb,text,text,int)
  to service_role;

-- estende o CHECK de tipo (9 valores atuais + erro_app)
alter table public.fornecedor_alerta drop constraint if exists fornecedor_alerta_tipo_check;
alter table public.fornecedor_alerta add constraint fornecedor_alerta_tipo_check
  check (tipo in ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro',
                  'mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','whatsapp_sla',
                  'erro_app','outro'));
