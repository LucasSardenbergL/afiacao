# Financeiro — referência operacional (engines, money-path)

> Lições do módulo financeiro (CFO mode). Princípios money-path em `docs/agent/money-path.md`. Classificação de confiabilidade + regras de ouro por onda: `docs/FINANCEIRO_CONFIABILIDADE.md`. Specs: `docs/superpowers/specs/2026-05-*financeiro*`. Diário em `docs/historico/bugs-resolvidos.md`.

## Regra-mãe (vale para TODA engine financeira)

- **Direcional ≠ verdade contábil.** As engines melhoram a DECISÃO de alocação de capital; não substituem balanço/valuation/conciliação fiscal. Caveat fixo na UI.
- **Nunca fabrica número.** Input ausente = `null` + **motivo/confiança**, jamais valor inventado (`Number(null)===0` é fabricação — ver money-path). Guards explícitos: NCG indisponível **≠ R$0** (A2); hurdle indisponível **≠ "20%" fabricado** (A3).
- **Recomenda, não executa/declara.** O dono decide (trocar regime exige contador + substância econômica; só cresce depois de consertar preço/prazo). Economia < banda de erro → status `empate_tecnico`.
- **Caixa por-CNPJ, NÃO-fungível** — o caixa de uma empresa nunca cobre o gap de outra (sem mútuo intercompany implícito). Engines escopam por `omie_products.account`/empresa.
- **CET, não taxa nominal** (dívida/funding: o input já é all-in — TAC/tarifas/seguro/reciprocidade); **coobrigação é campo obrigatório**.

## Engines (mapa)

- **A1** Inteligência de Caixa (projeção 13 semanas, CFO mode). **A2** Retorno & Valor (ROIC/WACC/EVA). **A3** Cockpit de Valor (cliente/produto, escopo Oben). **A4** Próxima Melhor Ação (compõe A1/A2/A3 via `service_role`).
- **DRE** regime-aware (Onda 3a) + **imposto teórico de conferência** (Onda 3b — plausibilidade, não verdade fiscal; o realizado do Omie continua sendo o número).
- **Otimizador Tributário** (Simples×Presumido×Real, master-only). **Otimizador de Compras** (net-R$ marginal — helper TS puro + view `v_otimizador_compras_insumos` que só junta fatos, **SEM edge** porque é dado operacional client-readable com RLS de staff). **Funding** (custo marginal de antecipação + planejador de gap, master-only).
- **Tipologia de Fleuriet/Braga** (selo de cobertura estrutural do giro no Cockpit, [PR #1147], master-only): `CDG=(PL+PNC)−ANC` de `fin_balanco_inputs` (por `data_ref`) + NCG real casado ao snapshot **as-of a data do balancete** (±7d por calendário, **nunca `NCG_hoje` com `CDG` do balanço** — a identidade `T=CDG−NCG` só fecha na mesma data; senão o Tipo troca com ruído). Selo primário = **status de cobertura** (o capital permanente cobre a NCG?); Tipo I–VI = etiqueta 2ª, tom pela qualidade do tipo (NCG<0 só é saudável se T>0 **e** CDG>0 — senão falso conforto). Helper puro `fleuriet-helpers.ts`; narrativa em `docs/historico/bugs-resolvidos.md` (2026-07-03).
- **Padrão de arquitetura:** **helper TS puro (vitest) espelhado no edge** (Deno não importa de `src/`); engines `fin-*` master-only (algumas gestor+master); tabelas `fin_*` com RLS; `service_role` Bearer para composição interna entre engines.

## Data de baixa / liquidação (DSO/DPO) — a armadilha-raiz

- ⚠️ **`fin_contas_receber.data_recebimento` / `fin_contas_pagar.data_pagamento` (a data de baixa REAL) são SEMPRE NULL** — o endpoint LIST do Omie (`ListarContasReceber/Pagar`) **não retorna a baixa** (só emissão/previsão/registro/vencimento). Não é bug de mapeamento; o dado não vem nessa rota.
- A baixa real vem da rota **`ListarMovimentos`** → derivada na tabela lateral **`fin_titulo_baixas`** (`data_baixa_final`, `prazo_ponderado_dias`, `confianca`), recalculável de `fin_movimentacoes`.
- **Cascata:** 5 engines caem no **fallback de vencimento** quando a baixa é NULL — DRE-caixa marca **"estimado"** (degradação honesta, não erro silencioso). PMR/PMP (≈ DSO/DPO) só da baixa derivada **com flag de confiança**; senão degrada. Spec: `docs/superpowers/specs/2026-05-27-omie-baixa-date-root-fix-design.md`.
- Vocabulário de status de título é **nativo do Omie** — usar `OPEN_TITLE_STATUSES` de `src/lib/financeiro/titulo-status.ts` (ver `docs/agent/database.md`).
