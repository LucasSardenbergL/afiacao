-- 20260605130000_tarefas_leitura_na_instancia.sql
-- Tarefas Fase 2 — UI-3: denormaliza a faixa de leitura (min/max/unidade) na INSTÂNCIA.
--
-- PROBLEMA: o ComprovacaoDialog mostra a faixa lendo o TEMPLATE via useTemplates(), que
--   depende da RLS tt_select (assigned_to=uid OR gestor). Em COBERTURA/férias a tarefa
--   aparece (responsavel_efetivo inclui cobertura) mas o template NÃO é visível → a faixa
--   some do dialog e a validação client vira no-op. O enforcement seguia intacto (a RPC
--   concluir_com_comprovacao lê tt server-side), mas a UX quebrava (operador só via o erro
--   no round-trip do servidor). Mesma falta atinge a auditoria (sem a unidade — UI-6).
--
-- SOLUÇÃO: copiar leitura_min/max/unidade do template para a instância (colunas em `tarefas`),
--   expor via b.* na view, e o frontend lê da INSTÂNCIA (sem join ao template → sem gap de RLS).
--
-- ATENÇÃO: migration manual necessária (colar no SQL Editor do Lovable).

begin;

-- 1) colunas de faixa na instância (denormalizadas do template)
alter table public.tarefas
  add column if not exists leitura_min numeric,
  add column if not exists leitura_max numeric,
  add column if not exists leitura_unidade text;

-- 2) backfill das instâncias ABERTAS de leitura a partir do template (idempotente)
update public.tarefas t set
  leitura_min     = tpl.leitura_min,
  leitura_max     = tpl.leitura_max,
  leitura_unidade = tpl.leitura_unidade
from public.tarefa_templates tpl
where t.template_id = tpl.id
  and t.status = 'aberta'
  and t.tipo_comprovacao in ('leitura', 'foto_e_leitura')
  and t.leitura_min is null and t.leitura_max is null and t.leitura_unidade is null;

-- 3) v_tarefas_estado re-expande b.* (agora carrega leitura_*). DROP+CREATE porque
--    REPLACE não reordena/adiciona colunas de `select t.*`. Corpo VERBATIM da fase2 bloco_c
--    (20260601102000) — só o conjunto de colunas de `tarefas` mudou (ganhou leitura_*).
drop view if exists public.v_tarefas_estado;
create view public.v_tarefas_estado
with (security_invoker = on) as
with base as (
  select t.*,
    coalesce(
      (t.adiada_para at time zone 'America/Sao_Paulo')::date,
      t.due_date,
      (t.created_at at time zone 'America/Sao_Paulo')::date + t.backstop_days
    ) as effective_due,
    coalesce(
      (select cc.covering_user_id from public.carteira_coverage cc
        where cc.covered_user_id = t.assigned_to and cc.active
          and now() >= cc.valid_from and (cc.valid_until is null or now() <= cc.valid_until)
        order by cc.valid_from desc limit 1),
      t.assigned_to
    ) as responsavel_efetivo
  from public.tarefas t
), nowsp as (
  select (now() at time zone 'America/Sao_Paulo')::date as dia,
         (now() at time zone 'America/Sao_Paulo')::time as hora
)
select b.*,
  (b.status = 'aberta' and (
     n.dia > b.effective_due
     or (n.dia = b.effective_due and b.janela_fim is not null and n.hora > b.janela_fim)
  )) as atrasada,
  (b.status = 'aberta' and b.escalado_em is null and (
     n.dia > (b.effective_due + b.tolerancia_dias)
     or (b.tolerancia_dias = 0 and n.dia = b.effective_due and b.janela_fim is not null and n.hora > b.janela_fim)
  )) as escalavel,
  exists (select 1 from public.tarefa_satisfacao_candidatos c
          where c.tarefa_id = b.id and c.status = 'pending') as tem_sugestao_pendente,
  (b.auditoria_status = 'pendente') as requer_auditoria
from base b cross join nowsp n;

commit;

-- 4) materializador copia leitura_* nas novas instâncias. Corpo VERBATIM da bloco_d
--    (20260601103000) + as 3 colunas de leitura no INSERT/SELECT.
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
           requer_comprovacao, tipo_comprovacao, janela_fim, supervisor_user_id, auditoria_status,
           leitura_min, leitura_max, leitura_unidade)
        select tpl.descricao, tpl.categoria, tpl.customer_user_id, tpl.assigned_to, tpl.created_by, tpl.empresa,
           'data', d, 7, tpl.tolerancia_dias, 'off', 'aberta', tpl.id,
           tpl.requer_comprovacao, tpl.tipo_comprovacao, tpl.janela_fim, tpl.supervisor_user_id,
           case when tpl.requer_comprovacao then 'dispensada' else 'nao_requer' end,
           tpl.leitura_min, tpl.leitura_max, tpl.leitura_unidade
        where not exists (select 1 from public.tarefas t
                          where t.template_id = tpl.id and t.assigned_to = tpl.assigned_to and t.due_date = d);
      end if;
      d := d + 1;
    end loop;
  end loop;
end $$;

-- validação
select 'F2 LEITURA NA INSTANCIA OK' as status,
  (select count(*) from information_schema.columns
     where table_name='tarefas' and column_name in ('leitura_min','leitura_max','leitura_unidade')) as cols_inst,
  (select count(*) from pg_views where viewname='v_tarefas_estado' and definition ilike '%leitura_unidade%') as view_expoe,
  (select (pg_get_functiondef(oid) ilike '%tpl.leitura_unidade%')
     from pg_proc where proname='tarefas_materializar_recorrentes') as mat_copia;
-- Expected: cols_inst=3, view_expoe=1, mat_copia=true
