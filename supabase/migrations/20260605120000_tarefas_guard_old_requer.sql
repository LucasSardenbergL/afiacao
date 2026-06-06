-- 20260605120000_tarefas_guard_old_requer.sql
-- Tarefas Fase 2 — FECHA FURO DE ENFORCEMENT (P1) no trigger anti-bypass.
--
-- BUG: tarefas_guard_comprovacao (bloco_d) só executava o corpo quando
--   `coalesce(NEW.requer_comprovacao, false)`. A policy `tarefas_update` (bloco_c)
--   deixa o assigned_to dar UPDATE na própria tarefa via PostgREST SEM with-check.
--   Logo um operador podia BURLAR a trava com:
--     PATCH /rest/v1/tarefas?id=eq.X  { requer_comprovacao:false, status:'concluida' }
--   → NEW.requer_comprovacao=false → o guard pulava TUDO → tarefa concluída SEM foto/leitura.
--
-- FIX: o guard passa a rodar quando NEW **ou** OLD exigem comprovação. Assim, se a
--   tarefa HOJE exige prova (OLD=true), qualquer tentativa de (a) concluí-la fora da RPC
--   ou (b) mudar/zerar os campos de comprovação/auditoria (incl. requer_comprovacao) é
--   bloqueada — mesmo que o UPDATE tente desligar requer_comprovacao na mesma operação.
--
-- NÃO afeta fluxos legítimos: adiar/cancelar (status≠concluida, sem mexer em campos de prova)
--   continuam passando; as RPCs concluir_com_comprovacao/auditar_tarefa rodam como postgres
--   (SECURITY DEFINER) → current_user na allowlist → seguem isentas. Materialização é INSERT
--   (trigger é BEFORE UPDATE) → não afetada.
--
-- ATENÇÃO: migration manual necessária (CREATE OR REPLACE — colar no SQL Editor do Lovable).

create or replace function public.tarefas_guard_comprovacao()
returns trigger language plpgsql security invoker as $$
begin
  -- roda quando a tarefa exige prova AGORA (new) OU exigia antes (old) — fecha o
  -- truque de zerar requer_comprovacao no mesmo UPDATE que conclui.
  if coalesce(new.requer_comprovacao, false) or coalesce(old.requer_comprovacao, false) then
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

-- validação: o corpo da função agora referencia old.requer_comprovacao (= fix aplicado)
select 'F2 GUARD OLD-REQUER OK' as status,
  (select count(*) from pg_proc where proname='tarefas_guard_comprovacao') as func,
  (select (pg_get_functiondef(oid) ilike '%old.requer_comprovacao, false%')
     from pg_proc where proname='tarefas_guard_comprovacao') as fix_aplicado,
  (select count(*) from pg_trigger where tgname='trg_tarefas_guard_comprovacao') as trg;
-- Expected: func=1, fix_aplicado=true, trg=1
