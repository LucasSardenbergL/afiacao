-- Sonda pós-deploy da edge omie-vendas-sync v1.22-lookup-confere-documento (PR #3215, deploy pela
-- sessão via MCP do Lovable em 2026-10-20 15:26Z, pacote 64cf7b9931b2 @ origin/main 20327ce79),
-- pelo RELÉ seguro (OPTIONS — num bundle velho não executa o fluxo real). O `sonda:sql` recusa o
-- bloco legado para quem já tem o relé e manda este one-liner; o colhedor
-- (`deploy-sonda-resultados-colher`, */12) grava o resultado no ledger `deploy_atestacoes`.
-- Disparado pelo conector Lovable em 2026-10-20 ~15:30Z: request_id 124428 → HTTP 200
-- {"versao":"v1.22-lookup-confere-documento","fonte":"11b664bf…"}; `pendencias:deploy` exit 0 (CONFERE).
-- Aplicação: `bun run db:aplicar <este arquivo>` (sem BEGIN/COMMIT — a transação é do executor).
-- Leitura: `bun run pendencias:deploy` (a edge deve sair da lista de pendentes).
do $sonda$
declare
  v_n int;
begin
  select count(*) into v_n
    from public.deploy_sonda_disparar(array['omie-vendas-sync']);
  if v_n is distinct from 1 then
    raise exception 'pós-condição: o relé devolveu % disparos para omie-vendas-sync v1.22 (esperado 1)', v_n;
  end if;
  raise notice 'SONDA-RELE-OMIE-VENDAS-SYNC-V122-DISPARADA-OK';
end $sonda$;
