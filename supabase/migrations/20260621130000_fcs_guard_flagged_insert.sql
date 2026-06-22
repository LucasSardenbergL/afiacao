-- ============================================================================
-- fcs_block_flagged_insert — GUARD de fronteira: NENHUMA via INSERE score de fornecedor excluído.
-- Money-path · anti-ressurreição (defesa DEFINITIVA, fronteira que toda via cruza). Achado /codex 2026-06-21.
--
-- PROBLEMA: farmer_client_scores tem MÚLTIPLAS vias de INSERT, e qualquer uma ressuscita um fornecedor
-- excluído (excluir_da_carteira=true) que o cleanup aplicar_exclusao_fornecedores() acabou de deletar —
-- ele reaparece na agenda do farmer (que lê fcs por farmer_id). Vias enumeradas:
--   1. SEED do calculate-scores — a RPC seed_targets_faltantes (20260621120000) fecha a inconsistência
--      das 3 leituras, MAS resta um TOCTOU: a RPC computa os alvos e, ANTES do upsert, o cleanup pode
--      flaggar/deletar → o edge re-insere o agora-flagged (/codex P1 2026-06-21).
--   2. trigger reconcile_score_owner_from_carteira (20260619120000): UPSERT em fcs a partir de
--      carteira_assignments SEM guard de excluir → um reimport/reatribuição de carteira ressuscita o
--      fornecedor flagged (com defaults 0/'critico', mas VISÍVEL na agenda).
--   3. qualquer via FUTURA de INSERT em fcs.
-- Guardar na lógica de CADA via é frágil (cada uma tem de lembrar) e NULL-blind sob RLS.
--
-- FIX (guard na FRONTEIRA — money-path "guard que TODA via cruza"): trigger BEFORE INSERT que PULA
-- (RETURN NULL) a linha cujo customer_user_id está flagged. Cobre as 3 vias e FECHA o TOCTOU (a
-- checagem é no instante do INSERT, no mesmo statement — não há janela).
--   • SECURITY DEFINER: lê cliente_classificacao bypassando RLS. CRÍTICO — o reconcile pode disparar
--     sob authenticated; com INVOKER o EXISTS viria NULL-blind (RLS esconde a linha) e DEIXARIA passar
--     o flagged. DEFINER garante que o flag é SEMPRE visto.
--   • RETURN NULL pula SÓ a linha-fornecedor — NÃO aborta o batch do seed nem o statement do reconcile
--     (as demais linhas entram). É fail-closed POR LINHA.
--   • Só BEFORE INSERT: a reversão (reverter_exclusao_fornecedor zera o flag ANTES de reprovisionar) e o
--     recompute (apply_score_updates, UPDATE-only) seguem livres. O cleanup (DELETE) não é tocado.
--
-- Idempotente: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS antes do CREATE TRIGGER.
-- Provado em PG17 com falsificação + RLS (SET ROLE): db/test-fcs-guard-flagged.sh.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fcs_block_flagged_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.cliente_classificacao cc
    WHERE cc.user_id = NEW.customer_user_id AND cc.excluir_da_carteira
  ) THEN
    RETURN NULL;  -- fornecedor excluído: NÃO insere (anti-ressurreição). O cleanup é o dono da exclusão.
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.fcs_block_flagged_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_fcs_block_flagged_insert ON public.farmer_client_scores;
CREATE TRIGGER trg_fcs_block_flagged_insert
  BEFORE INSERT ON public.farmer_client_scores
  FOR EACH ROW
  EXECUTE FUNCTION public.fcs_block_flagged_insert();

-- ============================================================
-- Validação (cole no SQL Editor; confira: func_ok=t, trig_ok=t, def_ok=t)
-- ============================================================
SELECT
  (SELECT count(*) FROM pg_proc WHERE proname = 'fcs_block_flagged_insert') = 1 AS func_ok,
  (SELECT prosecdef FROM pg_proc WHERE proname = 'fcs_block_flagged_insert')      AS def_ok,
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_fcs_block_flagged_insert'
      AND tgrelid = 'public.farmer_client_scores'::regclass
      AND NOT tgisinternal
  ) AS trig_ok;
