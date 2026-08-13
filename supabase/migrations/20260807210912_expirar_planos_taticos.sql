-- ============================================================
-- expirar_planos_taticos — dá SAÍDA para a fila do Plano Tático (PTPL)
--
-- PROBLEMA (medido em prod via psql-ro, 2026-08-07):
--   A cron `tactical-plans-batch-nightly` (0 8 * * *) gera ~30 planos/dia para
--   3 donos. O `loadPlans` do front lia os 50 mais RECENTES, sem filtro de
--   status e sem paginação. Resultado medido:
--     · 533 planos vivos (21/07 a 07/08), 100% `gerado`
--     · 0 `concluido`, 0 com `actual_margin` — nenhum desfecho, jamais
--     · 383 de 533 (72%) FORA dos 50 slots = inalcançáveis pela UI
--     · janela real de visibilidade: 6,7 dias antes de ser empurrado para fora
--
--   Sem uma SAÍDA, qualquer ordenação estável entope: os mesmos 50 planos
--   ficam no topo para sempre, porque nada os remove. Trocar só o critério de
--   ordenação (created_at → churn_risk) moveria o problema, não o resolveria.
--
-- ESTA FUNÇÃO É A SAÍDA: plano `gerado` com mais de N dias vira `expirado`.
--   O front passa a ler `status='gerado'` dentro da janela, ordenado por
--   churn_risk desc (53 valores distintos, 33..89 — discrimina de verdade;
--   `bundle_lie` e `best_individual_lie` estão NULL em 100% das 533 linhas e
--   NÃO servem para ordenar).
--
-- `expirado` é honesto: aquele plano nunca vai receber desfecho. Deixá-lo
-- `gerado` para sempre é o mesmo tipo de mentira do "aprendizado que nunca
-- aprendeu" (docs/historico/farmer-aprendizado-conversao.md) — um estado que
-- afirma pendência quando não há pendência real.
-- ============================================================

CREATE OR REPLACE FUNCTION public.expirar_planos_taticos(_dias integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _n integer;
BEGIN
  -- Guard: `_dias` <= 0 expiraria a fila INTEIRA, inclusive o lote gerado hoje
  -- de madrugada. NULL vindo de chamada malformada faria o `<` devolver NULL e
  -- o UPDATE não pegar nada — falha silenciosa. Fail-closed nos dois casos.
  IF _dias IS NULL OR _dias < 1 THEN
    RAISE EXCEPTION 'expirar_planos_taticos: _dias deve ser >= 1 (recebido: %)', _dias
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.farmer_tactical_plans
     SET status     = 'expirado',
         updated_at = now()
   WHERE status = 'gerado'
     AND generated_at < now() - make_interval(days => _dias);

  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

-- SECURITY DEFINER bypassa RLS → só cron/service_role pode executar.
-- `REVOKE ... FROM PUBLIC` NÃO tira anon/authenticated no Supabase (eles têm
-- grant EXPLÍCITO via default privileges) → revogar por NOME. Ver database.md.
REVOKE ALL ON FUNCTION public.expirar_planos_taticos(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expirar_planos_taticos(integer) FROM anon;
REVOKE ALL ON FUNCTION public.expirar_planos_taticos(integer) FROM authenticated;

-- Cron: 30 min DEPOIS do batch noturno (`tactical-plans-batch-nightly`, 0 8 * * *),
-- para que o lote novo já esteja no lugar quando o velho sair da fila.
-- SQL nomeado (não inline com o UPDATE cru): `cron.job.command` é invisível a
-- `grep` e a `pg_proc`, então um UPDATE inline sumiria do preflight de
-- dependência de tabela. Ver database.md §preflight.
SELECT cron.unschedule('expirar-planos-taticos')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expirar-planos-taticos');

SELECT cron.schedule(
  'expirar-planos-taticos',
  '30 8 * * *',
  $$ SELECT public.expirar_planos_taticos(7); $$
);
