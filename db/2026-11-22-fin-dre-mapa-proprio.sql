-- ============================================================================================
-- APLICAÇÃO via `bun run db:aplicar` — DRE v1.13: mapa PRÓPRIO por empresa (colacor, oben, colacor_sc)
--
-- SÓ DEPOIS de: (1) migration 20261122140000_fin_dre_nao_resultado.sql aplicada; (2) edge
-- omie-financeiro v1.13 SERVIDA e atestada (sonda). A PRECONDIÇÃO confere as duas dentro da MESMA
-- transação: motor velho + mapa novo = `nao_resultado` caindo em valor_desconhecido (degrada, não
-- fabrica — mas o mapa não teria efeito e o recálculo mentiria sobre a entrega).
--
-- Escopo (desenho docs/superpowers/specs/2026-11-22-dre-fluxo-caixa-mapa-proprio-design.md §A.2,
-- reescopado pelo parecer Codex de 2026-11-22):
--   • decisão EXATA por (empresa, código) só para as contas COM USO no histórico de
--     fin_dre_competencia_base (+ as que a colacor já tinha). Conta nunca usada, slot <Disponível>
--     e grupo ambíguo ficam SEM mapa: título futuro nelas cai na heurística com mapeado:false.
--   • duas classificações independentes (Claude por regra+exceção, Fable às cegas) reconciliadas;
--     divergência resolvida mantendo a decisão vigente da colacor quando era só adm×operacional.
--   • toda linha respeita a DIREÇÃO (CR em linha credora, CP em devedora, ou fora_dre/nao_resultado):
--     o motor soma sem sinal. Por isso devolução de compra (1.03.01, CR) vai para outras_receitas,
--     não cmv. Exceções conhecidas: colacor 2.01.01 e 2.09.01 têm uso MISTO CR/CP (R$ 2,1 mil no
--     histórico) — nenhuma linha acerta as duas direções sem sinal por natureza (onda futura).
--   • a colacor troca 10 linhas fora_dre → nao_resultado (imobilizado, CAPEX, distribuição de lucro):
--     não têm composição pendente e deixavam a DRE provisória por motivo falso.
--
-- Anti-deriva: UPDATE só onde a linha atual é a esperada; INSERT com ON CONFLICT DO NOTHING; a
-- POSTCONDIÇÃO exige os 236 pares exatos E a descrição de cada código em fin_categorias igual à
-- da decisão (código reutilizado/renomeado no Omie ⇒ aborta em vez de classificar a conta nova
-- com a decisão da velha).
-- ⚠️ `v_fonte_esperada` = hash de `omie-financeiro` em supabase/functions/_shared/sonda-fingerprints.ts
--    no commit que vai para prod. Mudou a edge → regrave o fingerprint E este literal.
-- ============================================================================================

DO $pre$
DECLARE
  v_versao_esperada constant text := 'v1.13-dre-nao-resultado';
  v_fonte_esperada  constant text := 'c81090bcaa7e35391f16010559883cded8a77a474c889dbc88006786c327416e';
  v record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.fin_categoria_dre_mapping'::regclass
                    AND conname = 'fin_categoria_dre_mapping_dre_linha_check'
                    AND position('''nao_resultado''' IN pg_get_constraintdef(oid)) > 0) THEN
    RAISE EXCEPTION 'precondicao: migration 20261122140000 (nao_resultado no CHECK) nao aplicada';
  END IF;
  SELECT t.versao, t.fonte, t.via, t.observado_em INTO v
    FROM (
      SELECT request_id, observado_em, versao, fonte, via FROM public.deploy_atestacoes WHERE edge = 'omie-financeiro'
      UNION ALL
      SELECT request_id, observado_em, versao, fonte, via FROM public.deploy_atestacoes_janela_viva() WHERE edge = 'omie-financeiro'
    ) t
   ORDER BY t.observado_em DESC, t.request_id DESC
   LIMIT 1;
  IF v.versao IS DISTINCT FROM v_versao_esperada OR v.fonte IS DISTINCT FROM v_fonte_esperada THEN
    RAISE EXCEPTION 'precondicao: omie-financeiro servida = % / % (via %, %) — esperado % / %',
      v.versao, v.fonte, v.via, v.observado_em, v_versao_esperada, v_fonte_esperada;
  END IF;
END
$pre$;

-- ── 1. trocas de linha (só onde a linha vigente é a que a decisão leu) ──
UPDATE public.fin_categoria_dre_mapping m
   SET dre_linha = u.nova, notas = u.nota, updated_at = now()
  FROM (VALUES
  ('colacor', '2.01.99', 'fora_dre', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Compra de Ativo Imobilizado · patrimonial definitivo (sem pendência)'),
  ('colacor', '2.03.76', 'fora_dre', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Distribuição de Lucros · patrimonial definitivo (sem pendência)'),
  ('colacor', '2.07', 'fora_dre', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=CAPEX · patrimonial definitivo (sem pendência)'),
  ('colacor', '2.07.01', 'fora_dre', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Compra de Máquinas e Equipamentos · patrimonial definitivo (sem pendência)'),
  ('colacor', '2.07.02', 'fora_dre', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Veículos · patrimonial definitivo (sem pendência)'),
  ('colacor', '2.07.03', 'fora_dre', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Instalações · patrimonial definitivo (sem pendência)'),
  ('colacor', '2.07.04', 'fora_dre', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Equipamentos de Informática · patrimonial definitivo (sem pendência)'),
  ('colacor', '2.07.05', 'fora_dre', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Móveis e Utensílios · patrimonial definitivo (sem pendência)'),
  ('colacor', '2.07.06', 'fora_dre', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Comunicação · patrimonial definitivo (sem pendência)'),
  ('colacor', '2.07.99', 'fora_dre', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Ativo Imobilizado · patrimonial definitivo (sem pendência)')
  ) u(company, codigo, antiga, nova, nota)
 WHERE m.company = u.company AND m.omie_codigo = u.codigo AND m.dre_linha = u.antiga;

-- ── 2. decisões novas ──
INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha, notas) VALUES
  ('colacor', '1.01.01', 'receita_bruta', 'mapa-proprio 2026-11-22 · desc=Venda de Mercadorias Fabricadas'),
  ('colacor', '1.01.02', 'receita_bruta', 'mapa-proprio 2026-11-22 · desc=Prestação de Serviços'),
  ('colacor', '1.01.03', 'receita_bruta', 'mapa-proprio 2026-11-22 · desc=Revenda de Mercadoria'),
  ('colacor', '1.02.99', 'outras_receitas', 'mapa-proprio 2026-11-22 · desc=Estorno'),
  ('colacor', '1.03.01', 'outras_receitas', 'mapa-proprio 2026-11-22 · desc=Devoluções de Compra de Mercadoria de Revenda'),
  ('colacor', '1.04.02', 'outras_receitas', 'mapa-proprio 2026-11-22 · desc=Reembolso de Despesas'),
  ('colacor', '1.04.03', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Empréstimos/Financiamentos · patrimonial definitivo (sem pendência)'),
  ('colacor', '1.04.05', 'outras_receitas', 'mapa-proprio 2026-11-22 · desc=Outras Receitas'),
  ('colacor', '1.04.06', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Venda de Bens · patrimonial definitivo (sem pendência)'),
  ('colacor', '2.01.01', 'cmv', 'mapa-proprio 2026-11-22 · desc=Compras de Mercadorias para Revenda'),
  ('colacor', '2.01.02', 'cmv', 'mapa-proprio 2026-11-22 · desc=Frete'),
  ('colacor', '2.01.03', 'cmv', 'mapa-proprio 2026-11-22 · desc=Compras de Materia Prima'),
  ('colacor', '2.01.98', 'deducoes', 'mapa-proprio 2026-11-22 · desc=Credito de Clientes'),
  ('colacor', '2.03.78', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Adiantamento De Salário'),
  ('colacor', '2.04.13', 'ded_iss', 'mapa-proprio 2026-11-22 · desc=ISS'),
  ('colacor', '2.05.01', 'despesas_financeiras', 'mapa-proprio 2026-11-22 · desc=Seguros'),
  ('colacor', '2.05.02', 'despesas_financeiras', 'mapa-proprio 2026-11-22 · desc=Multas'),
  ('colacor', '2.06.93', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Ret de Nota Fiscal de Serviço'),
  ('colacor', '2.06.94', 'cmv', 'mapa-proprio 2026-11-22 · desc=ICMS ST'),
  ('colacor', '2.06.95', 'ded_icms', 'mapa-proprio 2026-11-22 · desc=ICMS Diferença de alíquota'),
  ('colacor', '2.06.99', 'das', 'mapa-proprio 2026-11-22 · desc=Simples Nacional'),
  ('colacor', '2.11.85', 'cmv', 'mapa-proprio 2026-11-22 · desc=Material uso produção'),
  ('colacor', '2.11.90', 'despesas_operacionais', 'mapa-proprio 2026-11-22 · desc=Fretes e Carretos'),
  ('colacor', '2.12.87', 'cmv', 'mapa-proprio 2026-11-22 · desc=Mão de obra de Serviços prestados'),
  ('colacor', '2.12.89', 'cmv', 'mapa-proprio 2026-11-22 · desc=Despachante Aduaneiro'),
  ('colacor_sc', '1.01.01', 'receita_bruta', 'mapa-proprio 2026-11-22 · desc=Venda de Mercadoria Fabricadas'),
  ('colacor_sc', '1.01.02', 'receita_bruta', 'mapa-proprio 2026-11-22 · desc=Prestação de Serviços'),
  ('colacor_sc', '1.01.03', 'receita_bruta', 'mapa-proprio 2026-11-22 · desc=Revenda de Mercadoria'),
  ('colacor_sc', '1.04.03', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Empréstimos Bancários · patrimonial definitivo (sem pendência)'),
  ('colacor_sc', '1.04.04', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Empréstimos/Financiamentos · patrimonial definitivo (sem pendência)'),
  ('colacor_sc', '2.01.01', 'cmv', 'mapa-proprio 2026-11-22 · desc=Compras de Mercadorias para Revenda'),
  ('colacor_sc', '2.01.02', 'cmv', 'mapa-proprio 2026-11-22 · desc=Frete'),
  ('colacor_sc', '2.01.99', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Compra de Material Uso e Consumo'),
  ('colacor_sc', '2.03.01', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Salários'),
  ('colacor_sc', '2.03.02', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Adiantamento De Salário'),
  ('colacor_sc', '2.03.03', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Férias'),
  ('colacor_sc', '2.03.04', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Rescisões'),
  ('colacor_sc', '2.03.05', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=13º Salário'),
  ('colacor_sc', '2.03.06', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=INSS'),
  ('colacor_sc', '2.03.07', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=FGTS'),
  ('colacor_sc', '2.03.08', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=IRRF'),
  ('colacor_sc', '2.03.11', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Vale Transporte'),
  ('colacor_sc', '2.03.14', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Outros Benefícios'),
  ('colacor_sc', '2.03.94', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Alimentação e Lanches'),
  ('colacor_sc', '2.03.95', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Seguro de Vida e Grupo'),
  ('colacor_sc', '2.03.96', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Segurança e Medicina do Trabalho'),
  ('colacor_sc', '2.03.97', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Pró Labore'),
  ('colacor_sc', '2.03.98', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Plano de Saúde'),
  ('colacor_sc', '2.03.99', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Vale Alimentação'),
  ('colacor_sc', '2.04.03', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Água e Esgoto'),
  ('colacor_sc', '2.04.09', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=IPTU'),
  ('colacor_sc', '2.04.11', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Advogados'),
  ('colacor_sc', '2.05.03', 'fora_dre', 'mapa-proprio 2026-11-22 · desc=Pagamento de Empréstimos · parcela principal+encargos sem separação (composição pendente)'),
  ('colacor_sc', '2.06.01', 'ded_icms', 'mapa-proprio 2026-11-22 · desc=ICMS'),
  ('colacor_sc', '2.06.97', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Taxas Diversas'),
  ('colacor_sc', '2.06.98', 'ded_icms', 'mapa-proprio 2026-11-22 · desc=ICMS Diferença de alíquota'),
  ('colacor_sc', '2.06.99', 'das', 'mapa-proprio 2026-11-22 · desc=Simples Nacional (DAS)'),
  ('colacor_sc', '2.09.01', 'deducoes', 'mapa-proprio 2026-11-22 · desc=Devoluções de Vendas de Mercadoria'),
  ('colacor_sc', '2.09.02', 'deducoes', 'mapa-proprio 2026-11-22 · desc=Devoluções de Vendas de Serviços Prestados'),
  ('colacor_sc', '2.10.99', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Softwares'),
  ('oben', '1.01.01', 'receita_bruta', 'mapa-proprio 2026-11-22 · desc=Venda de Mercadoria Fabricadas'),
  ('oben', '1.01.03', 'receita_bruta', 'mapa-proprio 2026-11-22 · desc=Revenda de Mercadoria'),
  ('oben', '1.03.01', 'outras_receitas', 'mapa-proprio 2026-11-22 · desc=Devoluções de Compra de Mercadoria de Revenda'),
  ('oben', '1.04.02', 'outras_receitas', 'mapa-proprio 2026-11-22 · desc=Reembolso de Despesas'),
  ('oben', '1.04.03', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Empréstimos Bancários · patrimonial definitivo (sem pendência)'),
  ('oben', '1.04.04', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Aumento de Capital · patrimonial definitivo (sem pendência)'),
  ('oben', '2.01.01', 'cmv', 'mapa-proprio 2026-11-22 · desc=Compras de Mercadorias para Revenda'),
  ('oben', '2.01.02', 'cmv', 'mapa-proprio 2026-11-22 · desc=Frete'),
  ('oben', '2.01.03', 'cmv', 'mapa-proprio 2026-11-22 · desc=Compras de Materia Prima'),
  ('oben', '2.01.04', 'cmv', 'mapa-proprio 2026-11-22 · desc=Compra de Serviços'),
  ('oben', '2.01.98', 'deducoes', 'mapa-proprio 2026-11-22 · desc=Devolução de Clientes'),
  ('oben', '2.01.99', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Compra de Material de Uso e Consumo'),
  ('oben', '2.02.03', 'despesas_comerciais', 'mapa-proprio 2026-11-22 · desc=Despesas de Viagens'),
  ('oben', '2.02.04', 'despesas_comerciais', 'mapa-proprio 2026-11-22 · desc=Bonificações'),
  ('oben', '2.03.01', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Salários'),
  ('oben', '2.03.04', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Rescisões'),
  ('oben', '2.03.06', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=INSS'),
  ('oben', '2.03.08', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=IRRF'),
  ('oben', '2.03.10', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Assistência Médica'),
  ('oben', '2.03.14', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Outros Benefícios'),
  ('oben', '2.03.99', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Pró Labore'),
  ('oben', '2.04.01', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Aluguel'),
  ('oben', '2.04.03', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Água e Esgoto'),
  ('oben', '2.04.04', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Energia Elétrica'),
  ('oben', '2.04.06', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Material de Escritório'),
  ('oben', '2.04.07', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Manutenção de Imobilizado'),
  ('oben', '2.04.08', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Seguros'),
  ('oben', '2.04.10', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Contabilidade'),
  ('oben', '2.04.11', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Advogados'),
  ('oben', '2.04.14', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Limpeza'),
  ('oben', '2.04.97', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Manutenção de Veiculos'),
  ('oben', '2.04.98', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Manutenção e Reparos'),
  ('oben', '2.04.99', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Consultoria'),
  ('oben', '2.05.03', 'fora_dre', 'mapa-proprio 2026-11-22 · desc=Pagamento de Empréstimos · parcela principal+encargos sem separação (composição pendente)'),
  ('oben', '2.06.01', 'ded_icms', 'mapa-proprio 2026-11-22 · desc=ICMS'),
  ('oben', '2.06.03', 'ded_pis', 'mapa-proprio 2026-11-22 · desc=PIS'),
  ('oben', '2.06.04', 'ded_cofins', 'mapa-proprio 2026-11-22 · desc=COFINS'),
  ('oben', '2.06.05', 'irpj', 'mapa-proprio 2026-11-22 · desc=IRPJ'),
  ('oben', '2.06.06', 'csll', 'mapa-proprio 2026-11-22 · desc=Contribuição Social'),
  ('oben', '2.06.94', 'fora_dre', 'mapa-proprio 2026-11-22 · desc=Parcelamento Impostos Federais · parcela principal+encargos sem separação (composição pendente)'),
  ('oben', '2.06.96', 'ded_icms', 'mapa-proprio 2026-11-22 · desc=ICMS Diferença de alíquota'),
  ('oben', '2.06.97', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Taxas Diversas'),
  ('oben', '2.06.98', 'csll', 'mapa-proprio 2026-11-22 · desc=CSLL'),
  ('oben', '2.07.02', 'nao_resultado', 'mapa-proprio 2026-11-22 · desc=Veículos · patrimonial definitivo (sem pendência)'),
  ('oben', '2.08.02', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Softwares'),
  ('oben', '2.08.97', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Juridíco'),
  ('oben', '2.08.98', 'despesas_comerciais', 'mapa-proprio 2026-11-22 · desc=Fretes para clientes'),
  ('oben', '2.08.99', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Serviços Virtuais'),
  ('oben', '2.09.01', 'deducoes', 'mapa-proprio 2026-11-22 · desc=Devoluções de Vendas de Mercadoria'),
  ('oben', '2.10.97', 'despesas_comerciais', 'mapa-proprio 2026-11-22 · desc=Pedágio'),
  ('oben', '2.10.98', 'despesas_comerciais', 'mapa-proprio 2026-11-22 · desc=Refeições'),
  ('oben', '2.10.99', 'despesas_comerciais', 'mapa-proprio 2026-11-22 · desc=Outras Despesas de Viagem'),
  ('oben', '2.11.97', 'despesas_comerciais', 'mapa-proprio 2026-11-22 · desc=Combustível'),
  ('oben', '2.11.98', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Alimentação e Lanches'),
  ('oben', '2.11.99', 'despesas_administrativas', 'mapa-proprio 2026-11-22 · desc=Cartório')
ON CONFLICT (company, omie_codigo) DO NOTHING;

-- ── postcondição ──
DO $post$
DECLARE
  v_ok int;
  v_desc_divergente text;
  v_vazou int;
BEGIN
  CREATE TEMP TABLE _mapa_esperado(company text, codigo text, linha text, descricao text) ON COMMIT DROP;
  INSERT INTO _mapa_esperado VALUES
  ('colacor', '1.01.01', 'receita_bruta', 'Venda de Mercadorias Fabricadas'),
  ('colacor', '1.01.02', 'receita_bruta', 'Prestação de Serviços'),
  ('colacor', '1.01.03', 'receita_bruta', 'Revenda de Mercadoria'),
  ('colacor', '1.02.99', 'outras_receitas', 'Estorno'),
  ('colacor', '1.03.01', 'outras_receitas', 'Devoluções de Compra de Mercadoria de Revenda'),
  ('colacor', '1.04.02', 'outras_receitas', 'Reembolso de Despesas'),
  ('colacor', '1.04.03', 'nao_resultado', 'Empréstimos/Financiamentos'),
  ('colacor', '1.04.05', 'outras_receitas', 'Outras Receitas'),
  ('colacor', '1.04.06', 'nao_resultado', 'Venda de Bens'),
  ('colacor', '2.01.01', 'cmv', 'Compras de Mercadorias para Revenda'),
  ('colacor', '2.01.02', 'cmv', 'Frete'),
  ('colacor', '2.01.03', 'cmv', 'Compras de Materia Prima'),
  ('colacor', '2.01.96', 'despesas_administrativas', 'Compra de Material Uso e Consumo'),
  ('colacor', '2.01.97', 'cmv', 'Compras de Matéria Prima Importadas para Revenda'),
  ('colacor', '2.01.98', 'deducoes', 'Credito de Clientes'),
  ('colacor', '2.01.99', 'nao_resultado', 'Compra de Ativo Imobilizado'),
  ('colacor', '2.02.01', 'despesas_comerciais', 'Viagens Aéreas'),
  ('colacor', '2.02.02', 'despesas_comerciais', 'Hospedagem'),
  ('colacor', '2.02.03', 'despesas_comerciais', 'Viagens Terrestres'),
  ('colacor', '2.02.04', 'despesas_comerciais', 'Refeições'),
  ('colacor', '2.02.97', 'despesas_comerciais', 'Quilometragem'),
  ('colacor', '2.02.98', 'despesas_comerciais', 'Pedágio'),
  ('colacor', '2.02.99', 'despesas_comerciais', 'Outras Despesas de Viagem'),
  ('colacor', '2.03.01', 'despesas_administrativas', 'Salários e Ordenados'),
  ('colacor', '2.03.02', 'despesas_administrativas', 'Pró Labore'),
  ('colacor', '2.03.03', 'despesas_administrativas', 'Férias'),
  ('colacor', '2.03.04', 'despesas_administrativas', 'Rescisões e Aviso Prévio'),
  ('colacor', '2.03.05', 'despesas_administrativas', '13 Salário'),
  ('colacor', '2.03.06', 'despesas_administrativas', 'INSS'),
  ('colacor', '2.03.07', 'despesas_administrativas', 'FGTS'),
  ('colacor', '2.03.08', 'despesas_administrativas', 'IRRF'),
  ('colacor', '2.03.09', 'despesas_administrativas', 'Pensão Alimentícia'),
  ('colacor', '2.03.10', 'despesas_administrativas', 'Plano de Saúde'),
  ('colacor', '2.03.11', 'despesas_administrativas', 'Vale Transporte'),
  ('colacor', '2.03.12', 'despesas_administrativas', 'Vale Alimentação'),
  ('colacor', '2.03.13', 'despesas_administrativas', 'Seguro de Vida e Grupo'),
  ('colacor', '2.03.14', 'despesas_administrativas', 'Premios de Produtividade'),
  ('colacor', '2.03.76', 'nao_resultado', 'Distribuição de Lucros'),
  ('colacor', '2.03.77', 'despesas_administrativas', 'FGTS RESCISÓRIO'),
  ('colacor', '2.03.78', 'despesas_administrativas', 'Adiantamento De Salário'),
  ('colacor', '2.03.79', 'despesas_administrativas', 'Segurança e Medicina do Trabalho'),
  ('colacor', '2.03.80', 'despesas_administrativas', 'Paq CCT Contribuição Sindical'),
  ('colacor', '2.03.81', 'despesas_administrativas', 'Benefícios Concedidos'),
  ('colacor', '2.03.82', 'despesas_administrativas', 'Vale Combustível'),
  ('colacor', '2.03.83', 'despesas_administrativas', 'Descanso Semanal Remunerado'),
  ('colacor', '2.03.84', 'despesas_administrativas', 'Assistência Odontológica'),
  ('colacor', '2.03.85', 'despesas_administrativas', 'Acordo Trabalhista'),
  ('colacor', '2.03.86', 'despesas_administrativas', 'Exames Médicos'),
  ('colacor', '2.03.87', 'despesas_administrativas', 'PLR'),
  ('colacor', '2.03.88', 'despesas_administrativas', 'Adicional Noturno'),
  ('colacor', '2.03.89', 'despesas_administrativas', 'Hora Extra'),
  ('colacor', '2.03.90', 'despesas_administrativas', 'Treinamento'),
  ('colacor', '2.03.91', 'despesas_administrativas', 'Recrutamento e Seleção'),
  ('colacor', '2.03.92', 'despesas_administrativas', 'Uniforme'),
  ('colacor', '2.03.93', 'despesas_administrativas', 'Trabalho Temporário'),
  ('colacor', '2.03.94', 'despesas_administrativas', 'Previdência Privada'),
  ('colacor', '2.03.95', 'despesas_comerciais', 'Comissões'),
  ('colacor', '2.03.96', 'despesas_administrativas', 'Auxilio Educação'),
  ('colacor', '2.03.97', 'despesas_administrativas', 'Autônomo'),
  ('colacor', '2.03.98', 'despesas_administrativas', 'Bolsa Auxilio/Estágio'),
  ('colacor', '2.03.99', 'despesas_administrativas', 'Gratificações'),
  ('colacor', '2.04.01', 'despesas_administrativas', 'Aluguel e Condomínio'),
  ('colacor', '2.04.02', 'despesas_administrativas', 'Manutenção e Reparos'),
  ('colacor', '2.04.03', 'despesas_administrativas', 'Água e Esgoto'),
  ('colacor', '2.04.04', 'despesas_administrativas', 'Energia Elétrica'),
  ('colacor', '2.04.05', 'despesas_administrativas', 'Telefonia'),
  ('colacor', '2.04.06', 'despesas_administrativas', 'Manutenção de Veículos'),
  ('colacor', '2.04.07', 'despesas_administrativas', 'Aluguel de Veículo'),
  ('colacor', '2.04.08', 'despesas_administrativas', 'Seguros Predial'),
  ('colacor', '2.04.09', 'despesas_administrativas', 'IPTU'),
  ('colacor', '2.04.10', 'despesas_administrativas', 'IPVA'),
  ('colacor', '2.04.11', 'despesas_administrativas', 'Advogados'),
  ('colacor', '2.04.12', 'despesas_administrativas', 'Auditorias'),
  ('colacor', '2.04.13', 'ded_iss', 'ISS'),
  ('colacor', '2.04.14', 'despesas_administrativas', 'Serviço de Limpeza'),
  ('colacor', '2.04.96', 'despesas_administrativas', 'Manutenção de Máquinas'),
  ('colacor', '2.04.97', 'despesas_administrativas', 'Taxa Licenciamento Veiculo'),
  ('colacor', '2.04.98', 'despesas_administrativas', 'GUIA ARRECADAÇÃO LICENÇA ALVARA T.L.L.F'),
  ('colacor', '2.04.99', 'despesas_administrativas', 'Internet'),
  ('colacor', '2.05.01', 'despesas_financeiras', 'Seguros'),
  ('colacor', '2.05.02', 'despesas_financeiras', 'Multas'),
  ('colacor', '2.05.03', 'fora_dre', 'Pagamento de Empréstimos'),
  ('colacor', '2.05.04', 'despesas_financeiras', 'Despesas Bancárias'),
  ('colacor', '2.05.98', 'despesas_financeiras', 'Juros'),
  ('colacor', '2.06.01', 'ded_icms', 'ICMS'),
  ('colacor', '2.06.02', 'ded_ipi', 'IPI'),
  ('colacor', '2.06.03', 'ded_pis', 'PIS'),
  ('colacor', '2.06.04', 'ded_cofins', 'COFINS'),
  ('colacor', '2.06.05', 'irpj', 'IRPJ'),
  ('colacor', '2.06.07', 'ded_iss', 'ISS'),
  ('colacor', '2.06.90', 'fora_dre', 'Parcelamento Impostos Federais'),
  ('colacor', '2.06.91', 'csll', 'CSLL'),
  ('colacor', '2.06.92', 'despesas_administrativas', 'Taxas Diversas'),
  ('colacor', '2.06.93', 'despesas_administrativas', 'Ret de Nota Fiscal de Serviço'),
  ('colacor', '2.06.94', 'cmv', 'ICMS ST'),
  ('colacor', '2.06.95', 'ded_icms', 'ICMS Diferença de alíquota'),
  ('colacor', '2.06.96', 'fora_dre', 'Simples Nacional parcelados'),
  ('colacor', '2.06.97', 'fora_dre', 'ICMS Parcelados'),
  ('colacor', '2.06.98', 'despesas_administrativas', 'Licença Ambiental'),
  ('colacor', '2.06.99', 'das', 'Simples Nacional'),
  ('colacor', '2.07', 'nao_resultado', 'CAPEX'),
  ('colacor', '2.07.01', 'nao_resultado', 'Compra de Máquinas e Equipamentos'),
  ('colacor', '2.07.02', 'nao_resultado', 'Veículos'),
  ('colacor', '2.07.03', 'nao_resultado', 'Instalações'),
  ('colacor', '2.07.04', 'nao_resultado', 'Equipamentos de Informática'),
  ('colacor', '2.07.05', 'nao_resultado', 'Móveis e Utensílios'),
  ('colacor', '2.07.06', 'nao_resultado', 'Comunicação'),
  ('colacor', '2.07.99', 'nao_resultado', 'Ativo Imobilizado'),
  ('colacor', '2.09.01', 'deducoes', 'Cancelamento de Vendas de Mercadoria'),
  ('colacor', '2.09.02', 'deducoes', 'Cancelamento de Vendas de Serviços Prestados'),
  ('colacor', '2.09.05', 'deducoes', 'Devolução de Clientes'),
  ('colacor', '2.10.92', 'despesas_comerciais', 'Despesas com gráfica'),
  ('colacor', '2.10.93', 'despesas_comerciais', 'Stand de Vendas'),
  ('colacor', '2.10.94', 'despesas_comerciais', 'Patrocínio'),
  ('colacor', '2.10.95', 'despesas_comerciais', 'Feiras e Eventos'),
  ('colacor', '2.10.96', 'despesas_comerciais', 'Brindes e Donativos'),
  ('colacor', '2.10.97', 'despesas_comerciais', 'Pesquisa de Mercado'),
  ('colacor', '2.10.98', 'despesas_comerciais', 'Publicidade'),
  ('colacor', '2.10.99', 'despesas_comerciais', 'Propaganda'),
  ('colacor', '2.11.84', 'despesas_comerciais', 'Fretes para clientes'),
  ('colacor', '2.11.85', 'cmv', 'Material uso produção'),
  ('colacor', '2.11.86', 'despesas_administrativas', 'Material de Limpeza'),
  ('colacor', '2.11.87', 'despesas_administrativas', 'Compras de Bens de Pequeno Valor'),
  ('colacor', '2.11.89', 'despesas_administrativas', 'Despesas com Conselho de Administração'),
  ('colacor', '2.11.90', 'despesas_operacionais', 'Fretes e Carretos'),
  ('colacor', '2.11.91', 'despesas_administrativas', 'Confraternizações'),
  ('colacor', '2.11.92', 'despesas_administrativas', 'Locação de Maquinas e Equipamentos'),
  ('colacor', '2.11.93', 'despesas_administrativas', 'Material de Escritório'),
  ('colacor', '2.11.94', 'despesas_comerciais', 'Combustível'),
  ('colacor', '2.11.95', 'despesas_administrativas', 'Alimentação e Lanches'),
  ('colacor', '2.11.96', 'despesas_administrativas', 'Cartório'),
  ('colacor', '2.11.97', 'despesas_administrativas', 'Estacionamento'),
  ('colacor', '2.11.98', 'despesas_administrativas', 'Correio e Malotes'),
  ('colacor', '2.11.99', 'despesas_administrativas', 'Taxi e Conduções'),
  ('colacor', '2.12.87', 'cmv', 'Mão de obra de Serviços prestados'),
  ('colacor', '2.12.88', 'despesas_administrativas', 'Associação Comercial(SPC)'),
  ('colacor', '2.12.89', 'cmv', 'Despachante Aduaneiro'),
  ('colacor', '2.12.90', 'despesas_administrativas', 'Servidores e Hospedagem de Dados'),
  ('colacor', '2.12.91', 'despesas_administrativas', 'Serviços Virtuais'),
  ('colacor', '2.12.93', 'despesas_administrativas', 'Recursos Humanos'),
  ('colacor', '2.12.94', 'despesas_administrativas', 'Manutenção de Equipamentos'),
  ('colacor', '2.12.95', 'despesas_administrativas', 'Juridíco'),
  ('colacor', '2.12.96', 'despesas_administrativas', 'Softwares'),
  ('colacor', '2.12.97', 'despesas_administrativas', 'Contabilidade'),
  ('colacor', '2.12.98', 'despesas_administrativas', 'Consultoria'),
  ('colacor', '2.12.99', 'despesas_administrativas', 'Auditoria'),
  ('colacor_sc', '1.01.01', 'receita_bruta', 'Venda de Mercadoria Fabricadas'),
  ('colacor_sc', '1.01.02', 'receita_bruta', 'Prestação de Serviços'),
  ('colacor_sc', '1.01.03', 'receita_bruta', 'Revenda de Mercadoria'),
  ('colacor_sc', '1.04.03', 'nao_resultado', 'Empréstimos Bancários'),
  ('colacor_sc', '1.04.04', 'nao_resultado', 'Empréstimos/Financiamentos'),
  ('colacor_sc', '2.01.01', 'cmv', 'Compras de Mercadorias para Revenda'),
  ('colacor_sc', '2.01.02', 'cmv', 'Frete'),
  ('colacor_sc', '2.01.99', 'despesas_administrativas', 'Compra de Material Uso e Consumo'),
  ('colacor_sc', '2.03.01', 'despesas_administrativas', 'Salários'),
  ('colacor_sc', '2.03.02', 'despesas_administrativas', 'Adiantamento De Salário'),
  ('colacor_sc', '2.03.03', 'despesas_administrativas', 'Férias'),
  ('colacor_sc', '2.03.04', 'despesas_administrativas', 'Rescisões'),
  ('colacor_sc', '2.03.05', 'despesas_administrativas', '13º Salário'),
  ('colacor_sc', '2.03.06', 'despesas_administrativas', 'INSS'),
  ('colacor_sc', '2.03.07', 'despesas_administrativas', 'FGTS'),
  ('colacor_sc', '2.03.08', 'despesas_administrativas', 'IRRF'),
  ('colacor_sc', '2.03.11', 'despesas_administrativas', 'Vale Transporte'),
  ('colacor_sc', '2.03.14', 'despesas_administrativas', 'Outros Benefícios'),
  ('colacor_sc', '2.03.94', 'despesas_administrativas', 'Alimentação e Lanches'),
  ('colacor_sc', '2.03.95', 'despesas_administrativas', 'Seguro de Vida e Grupo'),
  ('colacor_sc', '2.03.96', 'despesas_administrativas', 'Segurança e Medicina do Trabalho'),
  ('colacor_sc', '2.03.97', 'despesas_administrativas', 'Pró Labore'),
  ('colacor_sc', '2.03.98', 'despesas_administrativas', 'Plano de Saúde'),
  ('colacor_sc', '2.03.99', 'despesas_administrativas', 'Vale Alimentação'),
  ('colacor_sc', '2.04.03', 'despesas_administrativas', 'Água e Esgoto'),
  ('colacor_sc', '2.04.09', 'despesas_administrativas', 'IPTU'),
  ('colacor_sc', '2.04.11', 'despesas_administrativas', 'Advogados'),
  ('colacor_sc', '2.05.03', 'fora_dre', 'Pagamento de Empréstimos'),
  ('colacor_sc', '2.06.01', 'ded_icms', 'ICMS'),
  ('colacor_sc', '2.06.97', 'despesas_administrativas', 'Taxas Diversas'),
  ('colacor_sc', '2.06.98', 'ded_icms', 'ICMS Diferença de alíquota'),
  ('colacor_sc', '2.06.99', 'das', 'Simples Nacional (DAS)'),
  ('colacor_sc', '2.09.01', 'deducoes', 'Devoluções de Vendas de Mercadoria'),
  ('colacor_sc', '2.09.02', 'deducoes', 'Devoluções de Vendas de Serviços Prestados'),
  ('colacor_sc', '2.10.99', 'despesas_administrativas', 'Softwares'),
  ('oben', '1.01.01', 'receita_bruta', 'Venda de Mercadoria Fabricadas'),
  ('oben', '1.01.03', 'receita_bruta', 'Revenda de Mercadoria'),
  ('oben', '1.03.01', 'outras_receitas', 'Devoluções de Compra de Mercadoria de Revenda'),
  ('oben', '1.04.02', 'outras_receitas', 'Reembolso de Despesas'),
  ('oben', '1.04.03', 'nao_resultado', 'Empréstimos Bancários'),
  ('oben', '1.04.04', 'nao_resultado', 'Aumento de Capital'),
  ('oben', '2.01.01', 'cmv', 'Compras de Mercadorias para Revenda'),
  ('oben', '2.01.02', 'cmv', 'Frete'),
  ('oben', '2.01.03', 'cmv', 'Compras de Materia Prima'),
  ('oben', '2.01.04', 'cmv', 'Compra de Serviços'),
  ('oben', '2.01.98', 'deducoes', 'Devolução de Clientes'),
  ('oben', '2.01.99', 'despesas_administrativas', 'Compra de Material de Uso e Consumo'),
  ('oben', '2.02.03', 'despesas_comerciais', 'Despesas de Viagens'),
  ('oben', '2.02.04', 'despesas_comerciais', 'Bonificações'),
  ('oben', '2.03.01', 'despesas_administrativas', 'Salários'),
  ('oben', '2.03.04', 'despesas_administrativas', 'Rescisões'),
  ('oben', '2.03.06', 'despesas_administrativas', 'INSS'),
  ('oben', '2.03.08', 'despesas_administrativas', 'IRRF'),
  ('oben', '2.03.10', 'despesas_administrativas', 'Assistência Médica'),
  ('oben', '2.03.14', 'despesas_administrativas', 'Outros Benefícios'),
  ('oben', '2.03.99', 'despesas_administrativas', 'Pró Labore'),
  ('oben', '2.04.01', 'despesas_administrativas', 'Aluguel'),
  ('oben', '2.04.03', 'despesas_administrativas', 'Água e Esgoto'),
  ('oben', '2.04.04', 'despesas_administrativas', 'Energia Elétrica'),
  ('oben', '2.04.06', 'despesas_administrativas', 'Material de Escritório'),
  ('oben', '2.04.07', 'despesas_administrativas', 'Manutenção de Imobilizado'),
  ('oben', '2.04.08', 'despesas_administrativas', 'Seguros'),
  ('oben', '2.04.10', 'despesas_administrativas', 'Contabilidade'),
  ('oben', '2.04.11', 'despesas_administrativas', 'Advogados'),
  ('oben', '2.04.14', 'despesas_administrativas', 'Limpeza'),
  ('oben', '2.04.97', 'despesas_administrativas', 'Manutenção de Veiculos'),
  ('oben', '2.04.98', 'despesas_administrativas', 'Manutenção e Reparos'),
  ('oben', '2.04.99', 'despesas_administrativas', 'Consultoria'),
  ('oben', '2.05.03', 'fora_dre', 'Pagamento de Empréstimos'),
  ('oben', '2.06.01', 'ded_icms', 'ICMS'),
  ('oben', '2.06.03', 'ded_pis', 'PIS'),
  ('oben', '2.06.04', 'ded_cofins', 'COFINS'),
  ('oben', '2.06.05', 'irpj', 'IRPJ'),
  ('oben', '2.06.06', 'csll', 'Contribuição Social'),
  ('oben', '2.06.94', 'fora_dre', 'Parcelamento Impostos Federais'),
  ('oben', '2.06.96', 'ded_icms', 'ICMS Diferença de alíquota'),
  ('oben', '2.06.97', 'despesas_administrativas', 'Taxas Diversas'),
  ('oben', '2.06.98', 'csll', 'CSLL'),
  ('oben', '2.07.02', 'nao_resultado', 'Veículos'),
  ('oben', '2.08.02', 'despesas_administrativas', 'Softwares'),
  ('oben', '2.08.97', 'despesas_administrativas', 'Juridíco'),
  ('oben', '2.08.98', 'despesas_comerciais', 'Fretes para clientes'),
  ('oben', '2.08.99', 'despesas_administrativas', 'Serviços Virtuais'),
  ('oben', '2.09.01', 'deducoes', 'Devoluções de Vendas de Mercadoria'),
  ('oben', '2.10.97', 'despesas_comerciais', 'Pedágio'),
  ('oben', '2.10.98', 'despesas_comerciais', 'Refeições'),
  ('oben', '2.10.99', 'despesas_comerciais', 'Outras Despesas de Viagem'),
  ('oben', '2.11.97', 'despesas_comerciais', 'Combustível'),
  ('oben', '2.11.98', 'despesas_administrativas', 'Alimentação e Lanches'),
  ('oben', '2.11.99', 'despesas_administrativas', 'Cartório');

  SELECT count(*) INTO v_ok
    FROM _mapa_esperado e JOIN public.fin_categoria_dre_mapping m
      ON m.company = e.company AND m.omie_codigo = e.codigo AND m.dre_linha = e.linha;
  IF v_ok IS DISTINCT FROM 236 THEN
    RAISE EXCEPTION 'postcondicao: % de 236 pares (codigo ja mapeado para outra linha por outra mao?)', v_ok;
  END IF;

  SELECT string_agg(e.company || ' ' || e.codigo || ' [' || coalesce(c.descricao, '<ausente>') || ']', '; ')
    INTO v_desc_divergente
    FROM _mapa_esperado e
    LEFT JOIN LATERAL (SELECT fc.descricao FROM public.fin_categorias fc
                        WHERE fc.company = e.company AND fc.omie_codigo = e.codigo
                        ORDER BY fc.updated_at DESC LIMIT 1) c ON true
   WHERE c.descricao IS DISTINCT FROM e.descricao;
  IF v_desc_divergente IS NOT NULL THEN
    RAISE EXCEPTION 'postcondicao: descricao do Omie mudou desde a decisao: %', v_desc_divergente;
  END IF;

  SELECT count(*) INTO v_vazou FROM public.fin_categoria_dre_mapping
   WHERE company = '_default' AND dre_linha IN ('fora_dre', 'nao_resultado');
  IF v_vazou IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'postcondicao: % mapa(s) patrimonial/fora_dre no _default', v_vazou; END IF;
END
$post$;
