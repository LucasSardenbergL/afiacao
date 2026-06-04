-- 20260601103000_tarefas_fase2_bloco_d.sql

-- FIX 2: tarefa_eventos.tarefa_id passa a aceitar NULL (eventos de SISTEMA sem tarefa, ex. materializacao_pulada).
-- O materializador é SECURITY DEFINER (owner postgres) → bypassa a RLS de tarefa_eventos; ator já é nullable.
alter table public.tarefa_eventos alter column tarefa_id drop not null;

-- (1) Trigger anti-bypass: conclusão/colunas de prova só via RPC (owner) ou service_role.
create or replace function public.tarefas_guard_comprovacao()
returns trigger language plpgsql security invoker as $$
begin
  if coalesce(new.requer_comprovacao, false) then
    if new.status = 'concluida' and old.status is distinct from 'concluida'
       and current_user not in ('postgres','service_role','supabase_admin') then
      raise exception 'Tarefa com comprovação só conclui via concluir_com_comprovacao()';
    end if;
    if current_user not in ('postgres','service_role','supabase_admin') and (
         new.comprovacao_url       is distinct from old.comprovacao_url
      or new.comprovacao_leitura   is distinct from old.comprovacao_leitura
      or new.comprovacao_em        is distinct from old.comprovacao_em
      or new.auditoria_status      is distinct from old.auditoria_status
      or new.auditada_por          is distinct from old.auditada_por
      or new.requer_comprovacao    is distinct from old.requer_comprovacao
    ) then
      raise exception 'Campos de comprovação/auditoria só mudam via RPC';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_tarefas_guard_comprovacao on public.tarefas;
create trigger trg_tarefas_guard_comprovacao
  before update on public.tarefas
  for each row execute function public.tarefas_guard_comprovacao();

-- (2) Conclusão com prova (o enforcement). SECURITY DEFINER.
create or replace function public.concluir_com_comprovacao(p_tarefa_id uuid, p_url text default null, p_leitura numeric default null)
returns void language plpgsql security definer set search_path = public as $$
declare t record; tt record; v_uid uuid := auth.uid(); v_audit text := 'nao_requer'; v_reinc int;
begin
  select * into t from public.tarefas where id = p_tarefa_id for update;
  if not found then raise exception 'Tarefa não encontrada'; end if;
  if not ( t.assigned_to = v_uid
           or public.pode_ver_carteira_completa(v_uid)
           or exists (select 1 from public.carteira_coverage cc where cc.covered_user_id=t.assigned_to
                      and cc.covering_user_id=v_uid and cc.active and now()>=cc.valid_from
                      and (cc.valid_until is null or now()<=cc.valid_until)) ) then
    raise exception 'Sem permissão para concluir esta tarefa';
  end if;
  if t.status <> 'aberta' then raise exception 'Tarefa não está aberta (status=%)', t.status; end if;

  if coalesce(t.requer_comprovacao,false) then
    select * into tt from public.tarefa_templates where id = t.template_id;
    if t.tipo_comprovacao in ('foto','foto_e_leitura') and (p_url is null or btrim(p_url)='') then
      raise exception 'Foto de comprovação obrigatória';
    end if;
    if t.tipo_comprovacao in ('leitura','foto_e_leitura') then
      if p_leitura is null then raise exception 'Leitura obrigatória'; end if;
      if (tt.leitura_min is not null and p_leitura < tt.leitura_min)
         or (tt.leitura_max is not null and p_leitura > tt.leitura_max) then
        raise exception 'Leitura % fora da faixa [%, %]', p_leitura, tt.leitura_min, tt.leitura_max;
      end if;
    end if;
    -- path-check: a url tem que conter {uid}/{tarefa_id}
    if p_url is not null and position((v_uid::text || '/' || p_tarefa_id::text) in p_url) = 0 then
      raise exception 'URL de comprovação não corresponde ao path da tarefa/usuário';
    end if;
    -- auditoria por exceção, decidida 1x
    select count(*) into v_reinc from public.tarefas x
      where x.template_id = t.template_id and x.assigned_to = t.assigned_to and x.id <> t.id
        and x.created_at > now() - interval '30 days'
        and (x.auditoria_status = 'reprovada' or x.status = 'aberta');
    if coalesce(tt.alto_risco,false)
       or v_reinc >= coalesce(tt.reincidente_limite, 3)
       or (random()*100) < coalesce(tt.amostra_auditoria_pct, 10)
    then v_audit := 'pendente'; else v_audit := 'dispensada'; end if;
  end if;

  update public.tarefas set
    status='concluida', conclusao_origem='comprovacao',
    comprovacao_url = coalesce(p_url, comprovacao_url),
    comprovacao_leitura = coalesce(p_leitura, comprovacao_leitura),
    comprovacao_em = now(), concluida_em = now(), concluida_por = v_uid,
    auditoria_status = v_audit, updated_at = now()
  where id = p_tarefa_id;
  insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
  values (p_tarefa_id, 'concluida_comprovacao', v_uid, jsonb_build_object('auditoria', v_audit, 'leitura', p_leitura));
end $$;

-- (3) Auditoria (gestor/master). Reprovar reabre + zera escalado_em.
create or replace function public.auditar_tarefa(p_tarefa_id uuid, p_aprovar boolean, p_motivo text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.pode_ver_carteira_completa(v_uid) then raise exception 'Só gestor/master audita'; end if;
  if p_aprovar then
    update public.tarefas set auditoria_status='aprovada', auditada_por=v_uid, auditada_em=now(), updated_at=now()
      where id=p_tarefa_id and auditoria_status='pendente';
    insert into public.tarefa_eventos (tarefa_id,tipo_evento,ator,payload)
    values (p_tarefa_id,'auditoria_aprovada',v_uid,'{}'::jsonb);
  else
    update public.tarefas set auditoria_status='reprovada', auditada_por=v_uid, auditada_em=now(),
      status='aberta', comprovacao_em=null, escalado_em=null, auditoria_motivo=p_motivo, updated_at=now()
      where id=p_tarefa_id and auditoria_status='pendente';
    insert into public.tarefa_eventos (tarefa_id,tipo_evento,ator,payload)
    values (p_tarefa_id,'auditoria_reprovada',v_uid,jsonb_build_object('motivo',p_motivo));
  end if;
end $$;

-- (4) Materialização (backfill 7d, idempotente, pula assignee sem perfil).
create or replace function public.tarefas_materializar_recorrentes()
returns void language plpgsql security definer set search_path = public as $$
declare tpl record; d date; hoje date := (now() at time zone 'America/Sao_Paulo')::date; dispara boolean;
begin
  for tpl in select * from public.tarefa_templates where ativo loop
    if not exists (select 1 from public.profiles p where p.user_id = tpl.assigned_to) then
      insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
      values (null, 'materializacao_pulada', null, jsonb_build_object('template_id', tpl.id, 'motivo', 'assignee_sem_perfil'));
      continue;
    end if;
    d := hoje - 6;  -- backfill janela 7 dias
    while d <= hoje loop
      dispara := case tpl.cadencia
        when 'diaria' then true
        when 'dias_uteis' then (extract(dow from d) between 1 and 5)
                               and not exists (select 1 from public.calendario_feriados f where f.data = d)
        when 'semanal' then extract(dow from d)::int = any(tpl.dias_semana)
        when 'dias_especificos' then extract(dow from d)::int = any(tpl.dias_semana)
        else false end;
      if dispara then
        insert into public.tarefas
          (descricao, categoria, customer_user_id, assigned_to, created_by, empresa, modo, due_date,
           backstop_days, tolerancia_dias, auto_satisfy_mode, status, template_id,
           requer_comprovacao, tipo_comprovacao, janela_fim, supervisor_user_id, auditoria_status)
        select tpl.descricao, tpl.categoria, tpl.customer_user_id, tpl.assigned_to, tpl.created_by, tpl.empresa,
           'data', d, 7, tpl.tolerancia_dias, 'off', 'aberta', tpl.id,
           tpl.requer_comprovacao, tpl.tipo_comprovacao, tpl.janela_fim, tpl.supervisor_user_id,
           case when tpl.requer_comprovacao then 'dispensada' else 'nao_requer' end
        where not exists (select 1 from public.tarefas t
                          where t.template_id = tpl.id and t.assigned_to = tpl.assigned_to and t.due_date = d);
      end if;
      d := d + 1;
    end loop;
  end loop;
end $$;

-- (5) Cron — chamada SQL local (sem net.http_post). ~06:00 BRT = 09:00 UTC.
select cron.schedule('tarefas-materializar-recorrentes', '0 9 * * *', $$ select public.tarefas_materializar_recorrentes(); $$);

select 'F2 BLOCO D OK' as status,
  (select count(*) from pg_proc where proname in ('tarefas_guard_comprovacao','concluir_com_comprovacao','auditar_tarefa','tarefas_materializar_recorrentes')) as funcs,
  (select count(*) from pg_trigger where tgname='trg_tarefas_guard_comprovacao') as trg,
  (select count(*) from cron.job where jobname='tarefas-materializar-recorrentes') as cron,
  (select proowner::regrole::text from pg_proc where proname='concluir_com_comprovacao') as owner_definer;
-- Expected: funcs=4, trg=1, cron=1, owner_definer='postgres'
