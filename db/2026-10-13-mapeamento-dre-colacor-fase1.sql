-- Mapeamento DRE da colacor — FASE 1 (operação de dados, NÃO migration) — 2026-10-13
--
-- ⚠️ Bytes APLICADOS (db:aplicar, recibo #433, sha256 a6e1e0cbe494c5eca4ce98a5e854ab29d2bfe552a711479be78819dc9c3af746) tinham `IF v_n <> 97` /
-- `IF v_fora <> 0` na postcondição; trocados depois por IS DISTINCT FROM (gate
-- assert-verde-por-ausencia: .sql novo nasce limpo). Comportamento idêntico — os dois são count(*),
-- nunca NULL. Este arquivo NÃO deve ser reaplicado (o INSERT é ON CONFLICT DO NOTHING, mas o
-- ledger já tem o recibo).
--
-- Pedido do founder: mapear as categorias da colacor. Só entra aqui o que é INEQUÍVOCO pelo nome
-- E fica DENTRO das 5 linhas de despesa que o ponto de equilíbrio reconcilia (cmv, operacionais,
-- administrativas, comerciais, financeiras) — mover entre elas não muda resultado nem a
-- reconciliação. Ficam para a FASE 2 (desenho multi-engine, parecer Codex 2026-10-13):
--   • impostos em linha própria (ded_icms/ded_pis/ded_cofins/irpj/csll) e 2.09 → deduções: tiram
--     valor das 5 linhas ⇒ o ponto de equilíbrio degradaria para snapshot_inconsistente;
--   • fora_dre com "composição pendente": 2.05.03 empréstimos, 2.06.90/96/97 parcelamentos,
--     2.07 CAPEX, 2.01.99 imobilizado, 2.03.76 distribuição de lucros, 2.03.78 adiantamento de
--     salário, 2.08.01 adiantamento a fornecedor, 2.05.99 devolução de cheques;
--   • ambíguos (sem dono claro): 2.06.95 DIFAL, 2.11.85, 2.11.88, 2.11.90, 2.12.87, 2.12.89,
--     2.12.92, 2.05.01, 2.05.02, 2.04.13 ISS.
-- Mapeamento por código EXATO (o gate de fechamento trg_mapping_gate não enxerga prefixo).
-- Só company='colacor' (o _default das outras empresas não muda). Não sobrescreve nada que já
-- exista (ON CONFLICT DO NOTHING).
INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha, notas)
SELECT 'colacor', v.cod, v.linha, 'fase1 2026-10-13: ' || v.motivo
  FROM (VALUES
    ('2.01.96','despesas_administrativas','uso e consumo nao e custo da mercadoria vendida (decisao do founder)'),
    ('2.01.97','cmv','materia-prima importada para revenda'),
    ('2.02.01','despesas_comerciais','viagens (convencao _default 3.02.04)'),
    ('2.02.02','despesas_comerciais','viagens'),
    ('2.02.03','despesas_comerciais','viagens'),
    ('2.02.04','despesas_comerciais','viagens'),
    ('2.02.97','despesas_comerciais','viagens'),
    ('2.02.98','despesas_comerciais','viagens (pedagio)'),
    ('2.02.99','despesas_comerciais','viagens'),
    ('2.03.01','despesas_administrativas','folha (convencao _default 3.01.01)'),
    ('2.03.02','despesas_administrativas','folha'),
    ('2.03.03','despesas_administrativas','folha'),
    ('2.03.04','despesas_administrativas','folha'),
    ('2.03.05','despesas_administrativas','folha'),
    ('2.03.06','despesas_administrativas','encargo social'),
    ('2.03.07','despesas_administrativas','encargo social'),
    ('2.03.08','despesas_administrativas','IRRF retido da folha'),
    ('2.03.09','despesas_administrativas','folha'),
    ('2.03.10','despesas_administrativas','beneficio'),
    ('2.03.11','despesas_administrativas','beneficio'),
    ('2.03.12','despesas_administrativas','beneficio'),
    ('2.03.13','despesas_administrativas','beneficio'),
    ('2.03.14','despesas_administrativas','folha'),
    ('2.03.77','despesas_administrativas','encargo social'),
    ('2.03.79','despesas_administrativas','folha'),
    ('2.03.80','despesas_administrativas','folha'),
    ('2.03.81','despesas_administrativas','beneficio'),
    ('2.03.82','despesas_administrativas','beneficio'),
    ('2.03.83','despesas_administrativas','folha'),
    ('2.03.84','despesas_administrativas','beneficio'),
    ('2.03.85','despesas_administrativas','folha'),
    ('2.03.86','despesas_administrativas','folha'),
    ('2.03.87','despesas_administrativas','folha'),
    ('2.03.88','despesas_administrativas','folha'),
    ('2.03.89','despesas_administrativas','folha'),
    ('2.03.90','despesas_administrativas','folha'),
    ('2.03.91','despesas_administrativas','folha'),
    ('2.03.92','despesas_administrativas','folha'),
    ('2.03.93','despesas_administrativas','folha'),
    ('2.03.94','despesas_administrativas','beneficio'),
    ('2.03.95','despesas_comerciais','comissoes (convencao _default 3.02.01)'),
    ('2.03.96','despesas_administrativas','beneficio'),
    ('2.03.97','despesas_administrativas','folha'),
    ('2.03.98','despesas_administrativas','folha'),
    ('2.03.99','despesas_administrativas','folha'),
    ('2.04.01','despesas_administrativas','aluguel (convencao _default 3.01.03)'),
    ('2.04.02','despesas_administrativas','administrativa'),
    ('2.04.03','despesas_administrativas','utilidade'),
    ('2.04.04','despesas_administrativas','utilidade'),
    ('2.04.05','despesas_administrativas','utilidade'),
    ('2.04.06','despesas_administrativas','administrativa'),
    ('2.04.07','despesas_administrativas','administrativa'),
    ('2.04.08','despesas_administrativas','administrativa'),
    ('2.04.09','despesas_administrativas','IPTU (tributo sobre patrimonio, nao sobre venda)'),
    ('2.04.10','despesas_administrativas','IPVA'),
    ('2.04.11','despesas_administrativas','administrativa'),
    ('2.04.12','despesas_administrativas','administrativa'),
    ('2.04.14','despesas_administrativas','administrativa'),
    ('2.04.96','despesas_administrativas','administrativa'),
    ('2.04.97','despesas_administrativas','administrativa'),
    ('2.04.98','despesas_administrativas','alvara'),
    ('2.04.99','despesas_administrativas','utilidade'),
    ('2.05.04','despesas_financeiras','tarifa bancaria (convencao _default 4.01.02)'),
    ('2.05.98','despesas_financeiras','juros (convencao _default 4.01.01)'),
    ('2.06.92','despesas_administrativas','taxas diversas (nao incide sobre venda/lucro)'),
    ('2.06.98','despesas_administrativas','licenca ambiental'),
    ('2.10.92','despesas_comerciais','marketing (convencao _default 3.02.03)'),
    ('2.10.93','despesas_comerciais','marketing'),
    ('2.10.94','despesas_comerciais','marketing'),
    ('2.10.95','despesas_comerciais','marketing'),
    ('2.10.96','despesas_comerciais','marketing'),
    ('2.10.97','despesas_comerciais','marketing'),
    ('2.10.98','despesas_comerciais','marketing'),
    ('2.10.99','despesas_comerciais','marketing'),
    ('2.11.84','despesas_comerciais','frete para clientes (convencao _default 3.02.02)'),
    ('2.11.86','despesas_administrativas','administrativa'),
    ('2.11.87','despesas_administrativas','administrativa'),
    ('2.11.89','despesas_administrativas','administrativa'),
    ('2.11.91','despesas_administrativas','administrativa'),
    ('2.11.92','despesas_administrativas','administrativa'),
    ('2.11.93','despesas_administrativas','material de escritorio (convencao _default 3.01.05)'),
    ('2.11.94','despesas_comerciais','combustivel de entrega a clientes (Codex, CPC 16 item 16d)'),
    ('2.11.95','despesas_administrativas','administrativa'),
    ('2.11.96','despesas_administrativas','administrativa'),
    ('2.11.97','despesas_administrativas','administrativa'),
    ('2.11.98','despesas_administrativas','administrativa'),
    ('2.11.99','despesas_administrativas','administrativa'),
    ('2.12.88','despesas_administrativas','servico de terceiros'),
    ('2.12.90','despesas_administrativas','TI (convencao _default 3.01.07)'),
    ('2.12.91','despesas_administrativas','TI'),
    ('2.12.93','despesas_administrativas','servico de terceiros'),
    ('2.12.94','despesas_administrativas','servico de terceiros'),
    ('2.12.95','despesas_administrativas','juridico'),
    ('2.12.96','despesas_administrativas','software (convencao _default 3.01.07)'),
    ('2.12.97','despesas_administrativas','contabilidade (convencao _default 3.01.06)'),
    ('2.12.98','despesas_administrativas','consultoria (convencao _default 3.01.06)'),
    ('2.12.99','despesas_administrativas','auditoria')
  ) AS v(cod, linha, motivo)
 -- só código que EXISTE no plano da colacor (defesa contra digitação)
 WHERE EXISTS (SELECT 1 FROM public.fin_categorias c WHERE c.company = 'colacor' AND c.omie_codigo = v.cod)
ON CONFLICT (company, omie_codigo) DO NOTHING;

-- Postcondição: os 97 códigos estão mapeados para a colacor com a linha desta fase, e NENHUM
-- caiu fora das 5 linhas que o ponto de equilíbrio reconcilia.
DO $post$
DECLARE v_n int; v_fora int;
BEGIN
  SELECT count(*) INTO v_n FROM public.fin_categoria_dre_mapping
   WHERE company = 'colacor' AND notas LIKE 'fase1 2026-10-13:%';
  SELECT count(*) INTO v_fora FROM public.fin_categoria_dre_mapping
   WHERE company = 'colacor' AND notas LIKE 'fase1 2026-10-13:%'
     AND dre_linha NOT IN ('cmv','despesas_operacionais','despesas_administrativas','despesas_comerciais','despesas_financeiras');
  IF v_n IS DISTINCT FROM 97 THEN RAISE EXCEPTION 'POSTCONDICAO: esperado 97 mapeamentos fase1 da colacor, ha %', v_n; END IF;
  IF v_fora IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'POSTCONDICAO: % mapeamento(s) fora das 5 linhas reconciliadas', v_fora; END IF;
  RAISE NOTICE 'fase1: 97 categorias da colacor mapeadas dentro das 5 linhas de despesa';
END
$post$;
