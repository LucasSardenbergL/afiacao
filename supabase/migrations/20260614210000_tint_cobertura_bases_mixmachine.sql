-- Follow-up de COBERTURA do mapeamento tintométrico (sessão tint-mapeamento-assistido, 2026-06-14).
--
-- Problema: o edge `tint-omie-sync` tem teto de 20 páginas (rate-limit) → bases novas
-- (família "Bases MixMachine") entram no catálogo pelo `omie-sync-metadados` (que pagina
-- TUDO + grava a coluna `familia`) mas ficam SEM `is_tintometric` → somem da tela de
-- mapeamento. Até hoje isso exigia backfill manual a cada base nova.
--
-- Solução: função idempotente + cron que marca por família, SEM tocar o edge (money-path
-- de compra). Marcar por família é CONSISTENTE com o que o `tint-omie-sync` já faz pras
-- bases que alcança (mesmo critério) — não introduz comportamento novo de venda.
--
-- Codex (2026-06-14) — fixes incorporados:
--   (1) corrige DRIFT de tint_type (não só `is_tintometric` ausente): a condição inclui
--       `tint_type IS DISTINCT FROM esperado`, então tipo NULL/errado/trocado é reparado.
--   (2) usa a coluna `familia` AUTORITATIVA (sem fallback `metadata->>'descricao_familia'`,
--       que é jsonb compartilhado e sofre sobrescrita por outros syncs).
-- Só ADITIVO/corretivo — NUNCA desmarca (desmarcar base já mapeada quebraria a venda;
-- drift "saiu da família"/"ficou inativo" fica pro vigia do Sentinela = follow-up).

create or replace function public.tint_marcar_bases_mixmachine()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with alvo as (
    select op.id,
      case lower(btrim(op.familia))
        when 'bases mixmachine' then 'base'
        when 'concentrados mixmachine' then 'concentrado'
      end as tipo_esperado
    from public.omie_products op
    where op.account = 'oben'
      and op.ativo = true
      and lower(btrim(op.familia)) in ('bases mixmachine', 'concentrados mixmachine')
  )
  update public.omie_products op
  set is_tintometric = true,
      tint_type = alvo.tipo_esperado,
      updated_at = now()
  from alvo
  where op.id = alvo.id
    and (op.is_tintometric is not true or op.tint_type is distinct from alvo.tipo_esperado);
  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

-- SECURITY DEFINER: só o cron (local) precisa executar. No Supabase, REVOKE FROM PUBLIC
-- NÃO tira anon/authenticated (têm grant explícito via default privileges) → revogar deles.
revoke execute on function public.tint_marcar_bases_mixmachine() from anon, authenticated, public;

-- Cron SQL LOCAL (sem net.http_post → sem a armadilha do timeout 5s). Idempotente por nome.
-- 11:00 UTC = 08:00 BRT, após os syncs matinais que preenchem `familia`. A função é
-- idempotente: se rodar antes do sync, a próxima passada pega a base nova.
select cron.schedule(
  'tint-marcar-bases-diario',
  '0 11 * * *',
  $$select public.tint_marcar_bases_mixmachine();$$
);
