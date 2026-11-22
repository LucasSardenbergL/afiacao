-- Sonda pós-deploy de omie-vendas-sync v1.46 e sync-reprocess v1.22 (cancelado no Omie vence a etapa,
-- #4121), pelo RELÉ seguro (OPTIONS — num bundle velho não executa o fluxo real). Antecipa a atestação
-- que o cron faria; o colhedor (`deploy-sonda-resultados-colher`) grava o resultado no ledger.
-- O backfill db/backfill-pedido-cancelado-omie-20261121.sql só roda DEPOIS de o ledger atestar as duas.
-- Aplicação: `bun run db:aplicar <este arquivo>` (sem BEGIN/COMMIT — a transação é do executor).
-- Leitura: `bun run pendencias:deploy` (as duas devem sair da lista de pendentes).
do $sonda$
declare
  v_n int;
begin
  select count(*) into v_n from public.deploy_sonda_disparar(array['omie-vendas-sync', 'sync-reprocess']);
  if v_n is distinct from 2 then
    raise exception 'pós-condição: o relé devolveu % disparos (esperado 2)', v_n;
  end if;
  raise notice 'SONDA-RELE-CANCELADO-2EDGES-DISPARADA-OK';
end $sonda$;
