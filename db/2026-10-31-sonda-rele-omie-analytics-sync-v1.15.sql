-- Sonda pós-deploy da omie-analytics-sync v1.15-nao-vinculados-tres-contas (#3446), pelo RELÉ seguro
-- (OPTIONS — num bundle velho não executa o fluxo real). Deploy pelo MCP às 18:15Z de 2026-10-31, no
-- /fecho da sessão do consolidado IC (26/26 hashes conferidos contra 47b9693c). O colhedor
-- (`deploy-sonda-resultados-colher`, */12) grava o resultado no ledger.
-- Aplicação: `bun run db:aplicar <este arquivo>` (sem BEGIN/COMMIT — a transação é do executor).
-- Leitura: `bun run pendencias:deploy` (omie-analytics-sync deve sair da lista de pendentes).
do $sonda$
declare
  v_n int;
begin
  select count(*) into v_n from public.deploy_sonda_disparar(array['omie-analytics-sync']);
  if v_n is distinct from 1 then
    raise exception 'pós-condição: o relé devolveu % disparos para omie-analytics-sync (esperado 1)', v_n;
  end if;
  raise notice 'SONDA-RELE-OMIE-ANALYTICS-SYNC-DISPARADA-OK';
end
$sonda$;
