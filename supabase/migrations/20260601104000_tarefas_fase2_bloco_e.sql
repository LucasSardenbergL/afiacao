-- 20260601104000_tarefas_fase2_bloco_e.sql
insert into storage.buckets (id, name, public)
values ('tarefa-comprovacoes', 'tarefa-comprovacoes', false)
on conflict (id) do nothing;

-- path = {auth.uid}/{tarefa_id}/arquivo  → operador escreve só no próprio prefixo
create policy "tarefa_comprov_insert_own" on storage.objects for insert to authenticated
with check (bucket_id='tarefa-comprovacoes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "tarefa_comprov_select_own_ou_gestor" on storage.objects for select to authenticated
using (bucket_id='tarefa-comprovacoes' and (
  (storage.foldername(name))[1] = (select auth.uid())::text or public.pode_ver_carteira_completa((select auth.uid()))
));

select 'F2 BLOCO E OK' as status, exists(select 1 from storage.buckets where id='tarefa-comprovacoes') as bucket_ok, (select count(*) from pg_policies where tablename='objects' and policyname like 'tarefa_comprov%') as policies;
-- Expected: bucket_ok=true, policies=2
