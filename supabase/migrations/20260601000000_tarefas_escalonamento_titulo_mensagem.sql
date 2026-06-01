-- 20260601000000_tarefas_escalonamento_titulo_mensagem.sql
-- Tarefas — Fase 1, FIX P1 + qualidade do e-mail de cobrança.
-- (1) BUG LATENTE: fornecedor_alerta.titulo é NOT NULL e a escalação não o setava →
--     o INSERT quebraria no PRIMEIRO alerta de tarefa atrasada. Agora preenche titulo+mensagem.
-- (2) O dispatch-notifications já renderiza titulo (assunto+cabeçalho) e mensagem (corpo) —
--     então o e-mail bom sai SEM tocar a edge function. Cópia cuidadosa: "possível cumprimento
--     NÃO confirmado", nunca "não fez". Separa "sem sinal" vs "detectado". metadata dropado
--     (e-mail limpo; o registro estruturado vive em tarefa_eventos, 1 evento 'escalada' por tarefa).
-- ATENÇÃO: migration manual necessária (CREATE OR REPLACE — colar no SQL Editor do Lovable).

create or replace function public.tarefas_escalonamento_tick()
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_nome text;
  v_titulo text;
  v_msg text;
begin
  for r in
    select v.responsavel_efetivo, v.empresa,
           array_agg(v.id) as ids,
           count(*) as n,
           string_agg(
             case when not v.tem_sugestao_pendente then
               format('- %s (%s, venceu %s)%s', v.descricao, v.categoria, v.effective_due,
                      case when v.motivo_adiamento is not null and btrim(v.motivo_adiamento) <> ''
                           then ' · adiada: '||v.motivo_adiamento else '' end)
             end, E'\n' order by v.effective_due
           ) as linhas_sem_sinal,
           string_agg(
             case when v.tem_sugestao_pendente then
               format('- %s (%s, venceu %s)', v.descricao, v.categoria, v.effective_due)
             end, E'\n' order by v.effective_due
           ) as linhas_detectado
    from public.v_tarefas_estado v
    where v.escalavel
    group by v.responsavel_efetivo, v.empresa
  loop
    select name into v_nome from public.profiles where user_id = r.responsavel_efetivo;
    v_nome := coalesce(nullif(btrim(v_nome), ''), 'A vendedora');

    v_titulo := format('%s tarefa(s) atrasada(s) — %s', r.n, v_nome);

    v_msg := format('%s tem %s tarefa(s) atrasada(s) (vencidas além da tolerância).', v_nome, r.n);
    if r.linhas_sem_sinal is not null then
      v_msg := v_msg || E'\n\nNão tocou (nenhum sinal detectado):\n' || r.linhas_sem_sinal;
    end if;
    if r.linhas_detectado is not null then
      v_msg := v_msg
        || E'\n\nPossível cumprimento NÃO confirmado (o app detectou menção numa interação, mas a vendedora não confirmou — verifique):\n'
        || r.linhas_detectado;
    end if;

    insert into public.fornecedor_alerta (tipo, empresa, severidade, status, titulo, mensagem)
    values ('tarefa_atrasada', r.empresa, 'atencao', 'pendente_notificacao', v_titulo, v_msg);

    insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
    select unnest(r.ids), 'escalada', null, jsonb_build_object('responsavel', r.responsavel_efetivo);

    update public.tarefas set escalado_em = now(), updated_at = now()
    where id = any(r.ids) and escalado_em is null;
  end loop;
end $$;
