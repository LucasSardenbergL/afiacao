-- Sonda pós-deploy da sync-reprocess v1.19-pedidos-operacional, pelo RELÉ seguro (OPTIONS — num
-- bundle velho não executa o fluxo real). O cron `deploy-sonda-cron` rodou às 12:37Z, 2 min ANTES do
-- deploy (12:39Z), e o próximo seria às 14:37Z: este disparo antecipa a atestação, e o colhedor
-- (`deploy-sonda-resultados-colher`, */12) grava o resultado no ledger.
-- Aplicação: `bun run db:aplicar <este arquivo>` (sem BEGIN/COMMIT — a transação é do executor).
-- Leitura: `bun run pendencias:deploy` (sync-reprocess deve sair da lista de pendentes).
do $sonda$
declare
  v_n int;
begin
  select count(*) into v_n from public.deploy_sonda_disparar(array['sync-reprocess']);
  if v_n is distinct from 1 then
    raise exception 'pós-condição: o relé devolveu % disparos para sync-reprocess (esperado 1)', v_n;
  end if;
  raise notice 'SONDA-RELE-SYNC-REPROCESS-DISPARADA-OK';
end $sonda$;
