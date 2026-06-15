-- Fase 2a (cockpit de preço): ledger append-only de mudanças de CMC.
-- Alimentado por TRIGGER no inventory_position (o sync já atualiza; o banco
-- observa a mudança exata). Sem backfill (não temos CMC passado). Insumo da
-- Fase 2b (defasagem). observed_at = "alta observada pelo sistema", NÃO data
-- contábil real da compra. Aplicar via SQL Editor; validar no fim.

CREATE TABLE IF NOT EXISTS public.cmc_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  omie_codigo_produto bigint NOT NULL,
  cmc_anterior numeric,
  cmc_novo numeric NOT NULL,
  saldo numeric,
  observed_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_cmc_ledger_lookup
  ON public.cmc_ledger (account, omie_codigo_produto, observed_at DESC);

ALTER TABLE public.cmc_ledger ENABLE ROW LEVEL SECURITY;

-- Leitura staff (employee/master); escrita só pelo trigger (SECURITY DEFINER da função).
DROP POLICY IF EXISTS "cmc_ledger_select_staff" ON public.cmc_ledger;
CREATE POLICY "cmc_ledger_select_staff" ON public.cmc_ledger
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role));

-- Trigger: grava SÓ quando o CMC realmente muda (anti-ruído de sync que reescreve igual).
CREATE OR REPLACE FUNCTION public.cmc_ledger_capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $ledger$
BEGIN
  IF NEW.cmc IS NOT NULL
     AND NEW.cmc > 0
     AND (TG_OP = 'INSERT' OR NEW.cmc IS DISTINCT FROM OLD.cmc) THEN
    INSERT INTO public.cmc_ledger (account, omie_codigo_produto, cmc_anterior, cmc_novo, saldo, synced_at)
    VALUES (
      NEW.account,
      NEW.omie_codigo_produto,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.cmc ELSE NULL END,
      NEW.cmc,
      NEW.saldo,
      NEW.synced_at
    );
  END IF;
  RETURN NEW;
END;
$ledger$;

DROP TRIGGER IF EXISTS trg_cmc_ledger_capture ON public.inventory_position;
CREATE TRIGGER trg_cmc_ledger_capture
  AFTER INSERT OR UPDATE OF cmc ON public.inventory_position
  FOR EACH ROW
  EXECUTE FUNCTION public.cmc_ledger_capture();

-- ── Validação pós-apply ──
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='cmc_ledger') AS tabela_1,
  (SELECT count(*) FROM pg_trigger WHERE tgname='trg_cmc_ledger_capture') AS trigger_1,
  (SELECT count(*) FROM pg_policies WHERE tablename='cmc_ledger') AS policies_1;
-- esperado: 1, 1, 1
