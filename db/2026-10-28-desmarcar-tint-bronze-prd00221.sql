-- Desmarca o ACAB BRONZE BRIL10.GL (PRD00221, oben) como tintométrico.
-- Contexto: o founder tirou o bronze da família "Bases MixMachine" no Omie (agora "Verniz Acrílico",
-- chegou pelo sync_all de 2026-10-28 03:00). O cron tint-marcar-bases-diario (jobid 132) só MARCA,
-- nunca desmarca — sem este UPDATE a marca antiga ficaria para sempre.
-- Idempotente: o WHERE só pega a linha enquanto ainda está marcada E fora das famílias MixMachine
-- (se a família voltar a ser MixMachine, não desmarca — senão o alerta tint_cobertura_bases dispara).
-- Transação: fornecida pelo `bun run db:aplicar` (arquivo sem BEGIN/COMMIT por desenho).

UPDATE public.omie_products op
SET is_tintometric = false,
    tint_type = NULL,
    updated_at = now()
WHERE op.account = 'oben'
  AND op.codigo = 'PRD00221'
  AND lower(btrim(op.familia)) NOT IN ('bases mixmachine', 'concentrados mixmachine')
  AND (op.is_tintometric IS NOT FALSE OR op.tint_type IS NOT NULL);

DO $post$
DECLARE
  v_ruins int;
  v_total int;
BEGIN
  SELECT count(*) FILTER (WHERE is_tintometric IS NOT FALSE OR tint_type IS NOT NULL),
         count(*)
    INTO v_ruins, v_total
  FROM public.omie_products
  WHERE account = 'oben' AND codigo = 'PRD00221';

  IF v_total <> 1 THEN
    RAISE EXCEPTION 'postcondição: esperava 1 linha PRD00221/oben, achei %', v_total;
  END IF;
  IF v_ruins <> 0 THEN
    RAISE EXCEPTION 'postcondição: PRD00221 continua marcado como tintométrico (família MixMachine?)';
  END IF;
END
$post$;
