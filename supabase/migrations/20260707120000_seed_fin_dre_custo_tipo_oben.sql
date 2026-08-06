-- supabase/migrations/20260707120000_seed_fin_dre_custo_tipo_oben.sql
-- F3 — SEED da classificacao de comportamento de custo da OBEN (fixo/variavel/nao_operacional).
-- Baseline v1 aplicado em producao 2026-07-06 (validado: cobertura 99,0%, 0 categoria material
-- sem classe). Aterrado no TTM real (12m competencia) das categorias de detalhamento.despesas
-- da OBEN puxadas via psql-ro. Escopo OBEN-only (spec §5).
--
-- Idempotente (ON CONFLICT DO UPDATE): re-aplicar RESTAURA este baseline. A fonte de verdade
-- corrente e o BANCO (master refina pela UI "Classificar custos" no card de Ponto de Equilibrio);
-- este arquivo e o baseline reproduzivel para DR, nao um trava de edicoes posteriores.
--
-- Deixados INTENCIONALMENTE sem classe (imateriais, ~0,6%): 2.06.98 (CSLL, imposto sobre lucro,
-- abaixo da linha operacional) e "Sem categoria" (sem descricao — nao chutar). Nao puxam
-- inconclusivo: nenhum e material (>5% despesas / >2% receita).
-- Spec: docs/superpowers/specs/2026-07-04-ponto-equilibrio-dre-design.md (§3, §5).

INSERT INTO public.fin_dre_custo_tipo (company, categoria_codigo, tipo, observacao) VALUES
  ('oben','2.01.01','variavel',NULL),                                                       -- Compras Mercadorias p/ Revenda (CMV)
  ('oben','2.06.01','variavel',NULL),                                                       -- ICMS
  ('oben','2.06.96','variavel',NULL),                                                       -- ICMS Dif. aliquota
  ('oben','2.06.04','variavel',NULL),                                                       -- COFINS
  ('oben','2.06.03','variavel',NULL),                                                       -- PIS
  ('oben','2.01.02','variavel',NULL),                                                       -- Frete
  ('oben','2.01.04','variavel',NULL),                                                       -- Compra de Servicos
  ('oben','2.09.01','variavel',NULL),                                                       -- Devolucoes de Vendas
  ('oben','2.01.98','variavel',NULL),                                                       -- Devolucao de Clientes
  ('oben','2.05.03','nao_operacional','Amortizacao de principal de emprestimo — financiamento, nao e custo da operacao'),
  ('oben','2.06.94','nao_operacional','Quitacao parcelada de divida tributaria federal — financiamento, nao imposto corrente'),
  ('oben','2.03.99','fixo',NULL),                                                           -- Pro Labore
  ('oben','2.04.01','fixo',NULL),                                                           -- Aluguel
  ('oben','2.04.11','fixo',NULL),                                                           -- Advogados
  ('oben','2.01.99','fixo',NULL),                                                           -- Material de Uso e Consumo
  ('oben','2.03.01','fixo',NULL),                                                           -- Salarios
  ('oben','2.04.10','fixo',NULL),                                                           -- Contabilidade
  ('oben','2.08.02','fixo',NULL),                                                           -- Softwares
  ('oben','2.04.98','fixo',NULL),                                                           -- Manutencao e Reparos
  ('oben','2.04.14','fixo',NULL),                                                           -- Limpeza
  ('oben','2.11.98','fixo',NULL),                                                           -- Alimentacao e Lanches
  ('oben','2.04.97','fixo',NULL),                                                           -- Manutencao de Veiculos
  ('oben','2.10.99','fixo',NULL)                                                            -- Outras Despesas de Viagem
ON CONFLICT (company, categoria_codigo)
DO UPDATE SET tipo = EXCLUDED.tipo, observacao = EXCLUDED.observacao;
