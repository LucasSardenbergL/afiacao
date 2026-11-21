-- Sonda única da leva do #4060 (churn NULL sem_historico), pelo relé SEGURO (OPTIONS, sem efeito).
-- Só as 2 edges da allowlist do relé: calculate-scores v1.7 e generate-tactical-plan v1.6.
-- visit-score-recalc-client e tactical-plans-batch não estão na allowlist; a sonda legada faz POST
-- no fluxo real (fila de visita / geração de planos), então ficam de fora de propósito.
-- APLICAR: bun run db:aplicar db/2026-11-21-sonda-rele-churn-nulo.sql
-- VALIDAR: bun run pendencias:deploy em ≤ 15 min.
DO $sonda$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.deploy_sonda_disparar(ARRAY['calculate-scores', 'generate-tactical-plan']);
  RAISE NOTICE 'sonda via rele disparada: % linha(s)', v_n;
END
$sonda$;
