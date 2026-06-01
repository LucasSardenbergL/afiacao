-- 20260528133000_tarefas_bloco_d.sql
-- Tarefas — Fase 1, BLOCO D: motor (matcher + escalonamento) + crons + CHECK fornecedor_alerta.
-- ATENÇÃO: migration manual necessária (colar no SQL Editor do Lovable).
-- Crons são chamadas SQL LOCAIS (sem net.http_post → sem timeout_milliseconds; a armadilha de 5s não se aplica).

-- (1) Estende o CHECK de `tipo` de fornecedor_alerta p/ aceitar 'tarefa_atrasada'.
-- Descobre o constraint que menciona 'tipo' (seja qual for o nome) e o substitui.
do $$
declare cn text;
begin
  select conname into cn from pg_constraint
  where conrelid = 'public.fornecedor_alerta'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%tipo%';
  if cn is not null then
    execute format('alter table public.fornecedor_alerta drop constraint %I', cn);
  end if;
end $$;
alter table public.fornecedor_alerta add constraint fornecedor_alerta_tipo_check
  check (tipo in ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro',
                  'mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','outro'));

-- (2) Matcher: casa interação → fecha (interacao) ou cria candidato (conteudo). Idempotente.
create or replace function public.tarefas_matcher_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A) Auto-close por LIGAÇÃO ATENDIDA (exclui sem-contato)
  with fechadas as (
    update public.tarefas t
    set status='concluida', concluida_em=now(), conclusao_origem='auto_interacao', updated_at=now()
    from public.farmer_calls fc
    where t.status='aberta' and t.auto_satisfy_mode='interacao' and t.interacao_tipo='ligacao'
      and fc.customer_user_id = t.customer_user_id
      and fc.created_at > now() - interval '1 day'
      and fc.call_result is not null
      and fc.call_result not in ('sem_resposta','ocupado','caixa_postal','numero_errado')
      and ( fc.farmer_id = t.assigned_to
            or exists (select 1 from public.carteira_coverage cc
                       where cc.covered_user_id=t.assigned_to and cc.covering_user_id=fc.farmer_id
                         and cc.active and now()>=cc.valid_from and (cc.valid_until is null or now()<=cc.valid_until)) )
    returning t.id, t.assigned_to, fc.id as fonte, fc.farmer_id as fechou
  )
  insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
  select id, 'concluida_auto', fechou,
         jsonb_build_object('via','ligacao','source_id',fonte,'responsavel_efetivo',fechou,'assigned_to',assigned_to)
  from fechadas;

  -- B) Auto-close por VISITA/ENTREGA (check-in é presença)
  with fechadas_v as (
    update public.tarefas t
    set status='concluida', concluida_em=now(), conclusao_origem='auto_interacao', updated_at=now()
    from public.route_visits rv
    where t.status='aberta' and t.auto_satisfy_mode='interacao' and t.interacao_tipo in ('visita','entrega')
      and rv.customer_user_id = t.customer_user_id
      and rv.check_in_at > now() - interval '1 day'
      and ( (t.interacao_tipo='visita' and rv.visit_type='comercial')
            or (t.interacao_tipo='entrega' and rv.visit_type='entrega') )
      and ( rv.visited_by = t.assigned_to
            or exists (select 1 from public.carteira_coverage cc
                       where cc.covered_user_id=t.assigned_to and cc.covering_user_id=rv.visited_by
                         and cc.active and now()>=cc.valid_from and (cc.valid_until is null or now()<=cc.valid_until)) )
    returning t.id, t.assigned_to, rv.id as fonte, rv.visited_by as fechou
  )
  insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
  select id, 'concluida_auto', fechou,
         jsonb_build_object('via','visita_entrega','source_id',fonte,'responsavel_efetivo',fechou,'assigned_to',assigned_to)
  from fechadas_v;

  -- C) Candidatos de CONTEÚDO (oferecer/preco) — cria sugestão, NUNCA fecha.
  with novos as (
    insert into public.tarefa_satisfacao_candidatos
      (tarefa_id, source_type, source_id, mode, confidence, motivo, matched_payload, status)
    select t.id, 'farmer_call', fc.id, 'conteudo',
           coalesce(m.confidence, 0.0),
           case when m.value is not null then 'Mencionou na ligação: '||m.value
                else 'Ligação aconteceu — confirmar se ofereceu' end,
           case when m.value is not null
                then jsonb_build_object('entity_type', m.etype, 'value', m.value, 'context', m.context)
                else null end,
           'pending'
    from public.tarefas t
    join public.farmer_calls fc
      on fc.customer_user_id = t.customer_user_id
     and fc.created_at > now() - interval '1 day'
     and ( fc.farmer_id = t.assigned_to
           or exists (select 1 from public.carteira_coverage cc
                      where cc.covered_user_id=t.assigned_to and cc.covering_user_id=fc.farmer_id
                        and cc.active and now()>=cc.valid_from and (cc.valid_until is null or now()<=cc.valid_until)) )
    left join lateral (
      select e->>'value' as value, e->>'type' as etype, e->>'context' as context,
             (e->>'confidence')::numeric as confidence
      from jsonb_array_elements(coalesce(fc.entities_extracted, '[]'::jsonb)) e
      where e->>'type' in ('product','price')
        and t.target_texto is not null
        and e->>'value' ilike '%'||t.target_texto||'%'
      order by (e->>'confidence')::numeric desc nulls last
      limit 1
    ) m on true
    where t.status='aberta' and t.auto_satisfy_mode='conteudo' and t.interacao_tipo='ligacao'
    on conflict (tarefa_id, source_type, source_id) do nothing
    returning tarefa_id, id
  )
  insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
  select tarefa_id, 'sugestao_criada', null, jsonb_build_object('candidato_id', id) from novos;

  -- D) Expira candidatos pendentes velhos (> 14 dias) — tunável.
  update public.tarefa_satisfacao_candidatos
  set status='expired', resolved_at=now()
  where status='pending' and created_at < now() - interval '14 days';
end $$;

-- (3) Escalonamento: agrupa vencidas+tolerância por responsável efetivo × empresa → fornecedor_alerta.
create or replace function public.tarefas_escalonamento_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  for r in
    select v.responsavel_efetivo, v.empresa,
           array_agg(v.id) as ids,
           count(*) as n,
           jsonb_agg(jsonb_build_object(
             'tarefa_id', v.id, 'descricao', v.descricao, 'categoria', v.categoria,
             'customer_user_id', v.customer_user_id, 'effective_due', v.effective_due,
             'tem_sugestao', v.tem_sugestao_pendente, 'motivo_adiamento', v.motivo_adiamento
           ) order by v.effective_due) as tarefas
    from public.v_tarefas_estado v
    where v.escalavel
    group by v.responsavel_efetivo, v.empresa
  loop
    insert into public.fornecedor_alerta (tipo, empresa, severidade, status, metadata)
    values ('tarefa_atrasada', r.empresa, 'atencao', 'pendente_notificacao',
            jsonb_build_object('responsavel', r.responsavel_efetivo, 'total', r.n, 'tarefas', r.tarefas));

    insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
    select unnest(r.ids), 'escalada', null, jsonb_build_object('responsavel', r.responsavel_efetivo);

    update public.tarefas set escalado_em = now(), updated_at = now()
    where id = any(r.ids) and escalado_em is null;
  end loop;
end $$;

-- (4) Crons — chamadas SQL LOCAIS (upsert por nome). 21:00 UTC = 18:00 BRT (America/Sao_Paulo, UTC-3).
select cron.schedule('tarefas-matcher-15min', '*/15 * * * *', $$ select public.tarefas_matcher_tick(); $$);
select cron.schedule('tarefas-escalonamento-diario', '0 21 * * *', $$ select public.tarefas_escalonamento_tick(); $$);
