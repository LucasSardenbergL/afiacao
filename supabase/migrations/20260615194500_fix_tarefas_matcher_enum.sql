-- 20260615194500_fix_tarefas_matcher_enum.sql
-- FIX: tarefas_matcher_tick() usava 'numero_errado' (valor INEXISTENTE no enum
-- farmer_call_result, cujos valores são contato_sucesso/sem_resposta/ocupado/
-- caixa_postal/numero_invalido/reagendado). O cast falhava em RUNTIME → o cron
-- tarefas-matcher-15min abortava a cada 15min DESDE 2026-06-01 (~1.399 falhas).
-- Correção cirúrgica: 'numero_errado' -> 'numero_invalido' (1 linha, na CTE `fechadas`).
-- Corpo recriado verbatim do pg_get_functiondef de PROD (2026-06-15) — só o valor mudou.
-- Provado no PG17 local: db/test-tarefas-matcher-enum.sh (positivo + negativo + falsificação).

CREATE OR REPLACE FUNCTION public.tarefas_matcher_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  with fechadas as (
    update public.tarefas t
    set status='concluida', concluida_em=now(), conclusao_origem='auto_interacao', updated_at=now()
    from public.farmer_calls fc
    where t.status='aberta' and t.auto_satisfy_mode='interacao' and t.interacao_tipo='ligacao'
      and fc.customer_user_id = t.customer_user_id
      and fc.created_at > t.created_at
      and fc.created_at > now() - interval '1 day'
      and fc.call_result is not null
      and fc.call_result not in ('sem_resposta','ocupado','caixa_postal','numero_invalido')
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

  with fechadas_v as (
    update public.tarefas t
    set status='concluida', concluida_em=now(), conclusao_origem='auto_interacao', updated_at=now()
    from public.route_visits rv
    where t.status='aberta' and t.auto_satisfy_mode='interacao' and t.interacao_tipo in ('visita','entrega')
      and rv.customer_user_id = t.customer_user_id
      and rv.check_in_at > t.created_at
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
     and fc.created_at > t.created_at
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

  update public.tarefa_satisfacao_candidatos
  set status='expired', resolved_at=now()
  where status='pending' and created_at < now() - interval '14 days';
end $function$;

-- validação pós-apply: a função NÃO deve mais referenciar 'numero_errado'
SELECT 'FIX OK' AS status,
  (pg_get_functiondef('public.tarefas_matcher_tick()'::regprocedure) ILIKE '%numero_errado%') AS ainda_tem_bug,
  (pg_get_functiondef('public.tarefas_matcher_tick()'::regprocedure) ILIKE '%numero_invalido%') AS tem_valor_correto;
