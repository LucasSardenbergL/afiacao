-- Sonda pós-deploy (1ª atestação) das edges omie-analytics-sync v1.13-cnpj-mascara-exata e
-- omie-vendas-sync v1.21-cnpj-mascara-exata (PR #3199, deploy pela sessão em 2026-10-20 01:40Z),
-- pelo RELÉ seguro (OPTIONS — num bundle velho não executa o fluxo real). O `sonda:sql` recusa o
-- bloco legado para quem já tem o relé e manda este one-liner; o colhedor
-- (`deploy-sonda-resultados-colher`, */12) grava o resultado no ledger `deploy_atestacoes`.
-- Aplicação: `bun run db:aplicar <este arquivo>` (sem BEGIN/COMMIT — a transação é do executor).
-- Leitura: `bun run pendencias:deploy` (as duas devem sair da lista de pendentes).
do $sonda$
declare
  v_n int;
begin
  select count(*) into v_n
    from public.deploy_sonda_disparar(array['omie-analytics-sync', 'omie-vendas-sync']);
  if v_n is distinct from 2 then
    raise exception 'pós-condição: o relé devolveu % disparos para a leva cnpj-mascara-exata (esperado 2)', v_n;
  end if;
  raise notice 'SONDA-RELE-CNPJ-MASCARA-EXATA-DISPARADA-OK';
end $sonda$;
