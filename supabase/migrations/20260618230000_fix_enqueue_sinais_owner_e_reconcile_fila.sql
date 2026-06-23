-- 20260618230000_fix_enqueue_sinais_owner_e_reconcile_fila.sql
-- Hotfix money-path — semântica de farmer_id no scoring de carteira (Opção A:
-- farmer_client_scores.farmer_id = DONO da carteira, vindo de carteira_assignments).
--
-- Bug A (regressão LATENTE): enqueue_score_recalc_from_sinais, criado em
-- 20260616140941 (Fatia 2), enfileira NEW.farmer_id CRU = o ATOR da ligação, não
-- o DONO da carteira. O comentário daquela migration dizia "espelha
-- enqueue_score_recalc_from_call", mas espelhou a versão PRÉ-Opção-A (ator) em vez
-- da corrigida. Sob UNIQUE(customer_user_id) + drain (scoring-recalc-client), isso
-- sobrescreveria a posse do score para o farmer errado, poluindo a agenda dele
-- (RLS fcs_*_own_or_gestor: pode_ver_carteira_completa(uid) OR farmer_id=uid).
-- Hoje impacto medido = 0 (psql-ro: nenhuma das 1425 linhas divergentes veio
-- deste caminho), mas dispara assim que um não-dono ligar pra cliente da carteira.
-- Fix: resolver o dono via carteira_assignments e enfileirar
-- COALESCE(v_owner, NEW.farmer_id) — idêntico ao sibling enqueue_score_recalc_from_call
-- (20260524180000). Mantém os guards de sinais (status='extraido',
-- IS DISTINCT FROM OLD, gatilho AFTER INSERT OR UPDATE OF sinais_ligacao).
--
-- P0c: reconcile defensivo da FILA pendente. O ON CONFLICT (customer_user_id)
-- WHERE processed_at IS NULL DO NOTHING faz o enqueue corrigido virar no-op se já
-- houver uma linha pendente com farmer_id errado (ator) — então um deploy com fila
-- não-vazia preservaria o item ruim. Fila vazia hoje → no-op seguro; referencia
-- carteira_assignments AO VIVO (não congela o reimport de carteira).
--
-- NÃO toca public.farmer_client_scores. Os 1425 scores divergentes (22%) são drift
-- de REATRIBUIÇÃO de carteira (reimport 2026-06-18 07:30 + calculate-scores
-- preservando farmer_id no update), causa SEPARADA provada por psql-ro → frente B1,
-- DIFERIDA até o founder confirmar o reimport. Raiz durável (B2: calculate-scores
-- reconciliar farmer_id no update) também é frente separada.
--
-- Idempotente: CREATE OR REPLACE FUNCTION + UPDATE filtrado por IS DISTINCT FROM.
-- ⚠️ Esta é a ÚLTIMA migration a recriar enqueue_score_recalc_from_sinais (a última
-- a recriar vence). Pré-flight pg_get_functiondef da PROD conferido em 2026-06-18
-- (corpo batia com 20260616140941). Sem mudança de frontend/edge.

-- 1. P0a — o trigger de sinais resolve o DONO (espelha enqueue_score_recalc_from_call).
CREATE OR REPLACE FUNCTION public.enqueue_score_recalc_from_sinais()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_owner uuid;
BEGIN
  IF NEW.sinais_ligacao IS NOT NULL
     AND (NEW.sinais_ligacao->>'status') = 'extraido'
     AND (TG_OP = 'INSERT' OR NEW.sinais_ligacao IS DISTINCT FROM OLD.sinais_ligacao)
     AND NEW.customer_user_id IS NOT NULL
     AND NEW.farmer_id IS NOT NULL THEN
    SELECT owner_user_id INTO v_owner
      FROM public.carteira_assignments WHERE customer_user_id = NEW.customer_user_id;
    INSERT INTO public.score_recalc_queue (customer_user_id, farmer_id, reason, source_call_id)
    VALUES (NEW.customer_user_id, COALESCE(v_owner, NEW.farmer_id), 'sinais_extraidos', NEW.id)
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- O trigger trg_farmer_calls_enqueue_recalc_sinais (20260616140941) segue apontando
-- para a função; CREATE OR REPLACE troca só o corpo, sem recriar o trigger.

-- 2. P0c — reconcile defensivo da fila pendente (ator → dono).
UPDATE public.score_recalc_queue q
SET farmer_id = a.owner_user_id
FROM public.carteira_assignments a
WHERE q.processed_at IS NULL
  AND q.customer_user_id = a.customer_user_id
  AND q.farmer_id IS DISTINCT FROM a.owner_user_id;
