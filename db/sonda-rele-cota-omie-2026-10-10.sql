-- Sonda pós-deploy pelo RELÉ (OPTIONS — não executa o fluxo real) das 3 edges da Fase 0.2 do
-- picking v2 que têm o caminho seguro: sync-reprocess, omie-desconto-backfill, omie-vendas-sync.
-- A resposta entra no ledger pelo colhedor (*/12); ler com `bun run pendencias:deploy`.
-- Caminho da sessão: `bun run db:aplicar db/<este arquivo>` (--ensaio antes).
DO $disparo$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.deploy_sonda_disparar(ARRAY['sync-reprocess', 'omie-desconto-backfill', 'omie-vendas-sync']);
  IF v_n IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'POSTCONDICAO: deploy_sonda_disparar devolveu % disparos, esperava 3', v_n;
  END IF;
  RAISE NOTICE 'SONDA_RELE_DISPAROS=%', v_n;
END
$disparo$;
