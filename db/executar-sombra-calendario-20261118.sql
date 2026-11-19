-- 1ª execução MANUAL do job da sombra da Etapa 2 do calendário (20261120090000), para validar em PROD no mesmo dia do
-- apply (PL/pgSQL é late-bound: o job só falha ao EXECUTAR; o cron 10:20 UTC seria a 1ª vez). Idempotente: o job faz
-- upsert por (data_ref, empresa, sku). Só grava na tabela da sombra — não alimenta PP/máximo.
--   bun run db:aplicar db/executar-sombra-calendario-20261118.sql
DO $x$
DECLARE
  v_n integer := public.reposicao_demanda_calendario_sombra_registrar('OBEN');
BEGIN
  IF v_n IS NULL OR v_n < 1 THEN
    RAISE EXCEPTION 'POS FALHOU: a sombra gravou % linha(s)', v_n;
  END IF;
  RAISE NOTICE 'POST sombra calendario OK: % SKU(s)', v_n;
END
$x$;
