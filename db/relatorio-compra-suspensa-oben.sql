-- RELATÓRIO prévio do apply em massa "segurar compra" (Oben) — SÓ LEITURA. É a lista que o founder aprova; os SKUs
-- aprovados vão literais em v_aprovados do envelope db/aplicar-compra-suspensa-oben-180d.sql.
--
-- Como rodar:  bun run db:aplicar db/relatorio-compra-suspensa-oben.sql --ensaio
--   · o ensaio roda o corpo e faz ROLLBACK (nada gravado); a saída sai em RAISE NOTICE no log que o executor imprime
--     (o EXECUTE server-side de aplicar_sql DESCARTA resultado de SELECT — por isso NOTICE, não SELECT);
--   · NÃO roda no psql-ro nem no psql-rw cru: as RPCs têm EXECUTE só para authenticated/service_role (REVOKE PUBLIC);
--     o executor eleva via aplicar_sql (dono postgres). Medido 2026-11-01: 42501 nos dois canais crus.
--   · sem meta-comandos do psql (\pset etc.): o corpo é executado pelo servidor, não pelo psql.
DO $rel$
DECLARE
  r record;
  v_arr text;
BEGIN
  FOR r IN
    SELECT count(*) AS skus, round(sum(valor)) AS rs_estoque,
           count(*) FILTER (WHERE no_motor) AS no_motor, round(sum(valor) FILTER (WHERE no_motor)) AS rs_no_motor,
           count(*) FILTER (WHERE valor IS NULL) AS sem_custo,
           count(*) FILTER (WHERE coalesce(valor_vendido_90d, 0) > 0) AS com_venda_90d
      FROM public.reposicao_compra_suspensa_candidatos('OBEN', 180)
  LOOP
    RAISE NOTICE 'RESUMO skus=% rs_estoque=% no_motor=% rs_no_motor=% sem_custo=% com_venda_90d=%',
      r.skus, r.rs_estoque, r.no_motor, r.rs_no_motor, r.sem_custo, r.com_venda_90d;
  END LOOP;

  -- lista completa, da maior venda recente para a menor (é a ordem de REATIVAR rápido se algo faltar)
  FOR r IN
    SELECT sku_codigo_omie AS sku, left(descricao, 40) AS descricao, left(fornecedor_nome, 14) AS fornecedor,
           saldo, valor AS rs, dias_365, dias_90, no_motor, valor_vendido_90d AS venda_90d
      FROM public.reposicao_compra_suspensa_candidatos('OBEN', 180)
     ORDER BY valor_vendido_90d DESC NULLS LAST, valor DESC NULLS LAST
  LOOP
    RAISE NOTICE 'SKU %|%|%|saldo=%|rs=%|d365=%|d90=%|motor=%|venda90=%',
      r.sku, r.descricao, r.fornecedor, r.saldo, r.rs, r.dias_365, r.dias_90, r.no_motor, r.venda_90d;
  END LOOP;

  -- array pronto para colar em v_aprovados do envelope
  SELECT 'ARRAY[' || string_agg(sku_codigo_omie::text, ',' ORDER BY sku_codigo_omie) || ']::bigint[]'
    INTO v_arr
    FROM public.reposicao_compra_suspensa_candidatos('OBEN', 180);
  RAISE NOTICE 'V_APROVADOS %', coalesce(v_arr, '(nenhum candidato)');
  RAISE NOTICE 'RELATORIO-COMPRA-SUSPENSA-FIM';
END
$rel$;
