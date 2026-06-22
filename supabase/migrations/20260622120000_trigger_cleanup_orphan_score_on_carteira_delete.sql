-- 20260622120000_trigger_cleanup_orphan_score_on_carteira_delete.sql
-- DELETE-policy (Opção A) — blindagem da invariante de posse contra REMOÇÃO de carteira.
--
-- Invariante: farmer_client_scores é 1:1 com carteira_assignments (por customer_user_id),
-- farmer_id = dono. O trigger trg_carteira_reconcile_score_owner (INSERT/UPDATE OF owner_user_id,
-- 20260619120000) já mantém isso na atribuição/reatribuição. FALTAVA o caminho DELETE: se uma
-- linha de carteira_assignments for REMOVIDA (cliente sai da carteira de vez), a linha de score
-- ficaria órfã (farmer_id aponta pro dono antigo) → cliente preso na agenda do vendedor errado.
--
-- Impacto HOJE = 0 (psql-ro 2026-06): NADA deleta carteira_assignments no código — carteira-rebuild
-- faz UPSERT (eligible=false p/ "remover"), exclusão de fornecedor usa flag; grep de DELETE = vazio;
-- sem_carteira=0. Logo este trigger é BLINDAGEM contra um DELETE manual/manutenção futura (SQL
-- Editor): o banco defende a própria invariante. /codex 2026-06-22 recomendou construir (A vs monitor).
--
-- DESIGN (refinado por /codex):
--   • CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED → dispara no COMMIT, não no statement. Um
--     delete+insert do MESMO cliente na mesma transação (replace manual) NÃO perde as colunas ricas
--     do score: no commit a linha de carteira existe de novo → NOT EXISTS falso → não deleta. Só
--     remoção DEFINITIVA (sem re-insert no txn) limpa o score.
--   • NOT EXISTS guard → só deleta o score se NÃO sobrou NENHUMA carteira pro cliente.
--   • Deletar (não flaggear): manter = agenda errada; farmer_id é NOT NULL (sem estado neutro de
--     posse); 0 FKs referenciam farmer_client_scores (delete é seguro); único trigger de fcs é
--     AFTER UPDATE → deletar não dispara cascata.
-- Follow-up recomendado (NÃO aqui): monitor sem_carteira>0 no data-health (defesa em profundidade).
--
-- Idempotente: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS antes do CREATE.
-- Prova: db/test-cleanup-orphan-score-carteira-delete.sh (PG17 + falsificação do deferred/guard).

CREATE OR REPLACE FUNCTION public.cleanup_orphan_score_on_carteira_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- No COMMIT (deferred): só remove o score se o cliente não tem mais NENHUMA carteira.
  IF NOT EXISTS (
    SELECT 1 FROM public.carteira_assignments WHERE customer_user_id = OLD.customer_user_id
  ) THEN
    DELETE FROM public.farmer_client_scores WHERE customer_user_id = OLD.customer_user_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_carteira_cleanup_orphan_score ON public.carteira_assignments;
CREATE CONSTRAINT TRIGGER trg_carteira_cleanup_orphan_score
  AFTER DELETE ON public.carteira_assignments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_orphan_score_on_carteira_delete();

-- Validação (read-only): função existe + constraint trigger DEFERIDO ligado em carteira_assignments.
SELECT
  CASE WHEN pg_get_functiondef('public.cleanup_orphan_score_on_carteira_delete'::regproc)
            ILIKE '%NOT EXISTS%carteira_assignments%'
       THEN '✅ função (NOT EXISTS guard)' ELSE '❌ FALTANDO/sem guard' END AS func_ok,
  CASE WHEN EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_carteira_cleanup_orphan_score'
          AND tgrelid = 'public.carteira_assignments'::regclass
          AND NOT tgisinternal AND tgdeferrable AND tginitdeferred)
       THEN '✅ constraint trigger deferred' ELSE '❌ FALTANDO/não-deferred' END AS trig_ok;
