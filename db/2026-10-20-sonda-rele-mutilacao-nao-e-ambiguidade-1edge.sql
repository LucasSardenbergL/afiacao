-- Sonda pós-deploy (1ª atestação) da edge omie-analytics-sync v1.14-mutilacao-nao-e-ambiguidade
-- (PR #3201, deploy pela sessão em 2026-10-20 01:55Z), pelo RELÉ seguro (OPTIONS — num bundle
-- velho não executa o fluxo real). O `sonda:sql` recusa o bloco legado para quem já tem o relé;
-- o colhedor (`deploy-sonda-resultados-colher`, */12) grava o resultado no ledger `deploy_atestacoes`.
-- Aplicação: `bun run db:aplicar <este arquivo>` (sem BEGIN/COMMIT — a transação é do executor).
-- Leitura: `bun run pendencias:deploy` (a edge deve sair da lista de pendentes).
do $sonda$
declare
  v_n int;
begin
  select count(*) into v_n
    from public.deploy_sonda_disparar(array['omie-analytics-sync']);
  if v_n is distinct from 1 then
    raise exception 'pós-condição: o relé devolveu % disparos para omie-analytics-sync (esperado 1)', v_n;
  end if;
  raise notice 'SONDA-RELE-MUTILACAO-NAO-E-AMBIGUIDADE-DISPARADA-OK';
end $sonda$;
