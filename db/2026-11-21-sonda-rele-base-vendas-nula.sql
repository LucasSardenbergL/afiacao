-- Sonda da leva do #4088 (dias/gasto NULL sem venda), pelo relé SEGURO (OPTIONS, sem efeito).
-- Só as 2 edges da allowlist do relé: calculate-scores v1.8 e generate-tactical-plan v1.7.
-- visit-score-recalc-client e tactical-plans-batch não estão na allowlist; a sonda legada faz POST
-- no fluxo real; foram sondadas DEPOIS do deploy confirmado (db/2026-11-21-sonda-disparo-base-vendas-2edges.sql).
-- APLICAR: bun run db:aplicar db/2026-11-21-sonda-rele-base-vendas-nula.sql
-- VALIDAR: bun run pendencias:deploy em ≤ 15 min.
DO $sonda$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.deploy_sonda_disparar(ARRAY['calculate-scores', 'generate-tactical-plan']);
  RAISE NOTICE 'sonda via rele disparada: % linha(s)', v_n;
END
$sonda$;
