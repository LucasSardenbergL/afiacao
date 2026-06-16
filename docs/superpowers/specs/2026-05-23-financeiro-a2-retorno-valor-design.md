# Financeiro A2 — Retorno & Valor (ROIC / WACC / EVA) — Design

> Parte 4 (final) do programa "Estado da Arte do Financeiro". Sobre a base já corrigida nas Ondas 1 (NCG), 2 (timing) e 3 (DRE v2 regime-aware), adiciona a camada de **retorno sobre capital** pra apoiar a alocação de capital entre as 3 empresas do mesmo dono. Design pré-aprovado e re-validado por consult Codex contra a fundação corrigida.

## 1. Contexto e Objetivo

O dono opera 3 PMEs fechadas (Colacor — indústria, presumido; Oben — distribuidora, presumido; Colacor SC — serviços, Simples) e precisa decidir **onde colocar o próximo R$1**. Hoje o módulo tem caixa (13s), NCG e DRE, mas nada de **retorno sobre o capital empregado**. A A2 entrega ROIC, WACC (hurdle-rate), EVA, spread e — o output headline — **ROIC incremental** por empresa.

Não há balanço, registro de ativo fixo, dívida ou dado de mercado no sistema. Portanto a A2 é **híbrida**: NOPAT e capital de giro são **computados** (reusam DRE v2 + NCG); ativo fixo, dívida, PL, Ke/Kd e normalizações são **inputs manuais** (config), com **degradação honesta** onde faltarem.

### Achados endereçados (Codex, contra a fundação pós-Ondas 1-3)
- **Tax-shield ≈ 0** nos dois regimes (Simples sobre receita; presumido sobre base presumida — juros não reduzem IRPJ/CSLL). WACC usa **Kd pré-imposto**, com flag "tax shield disabled by regime". (Se alguma empresa migrar pra lucro real, o shield reaparece — fora de escopo.)
- **NOPAT NÃO é `EBIT×(1−t)`** — pra Simples o imposto é sobre receita, então a alíquota implícita explode/inverte. Correto: `NOPAT = EBIT − imposto operacional absoluto do regime`.
- **Capital investido** com ativo fixo manual é estimativa gerencial direcional — exige metadados de disciplina (data, fonte, base de valor, flags).
- **Ke é hurdle-rate**, não market WACC (PME fechada, sem beta) — decompor + cenários.
- **Comingling do dono pode "destruir o módulo"** → normalização de pró-labore/aluguel/intercompany; mostrar reportado vs normalizado.
- Output mais útil = **ROIC incremental**, não médio.

### Não-escopo (deferido — documentado)
Leases/aluguéis como quase-dívida; split capex manutenção × crescimento; eliminação intercompany pra view consolidada; registro automático de ativo fixo (sync ERP); real vs nominal / inflação; concentração cliente/fornecedor; obsolescência de estoque; non-operating/excess cash detalhado. Migração de regime pra lucro real (reativaria tax-shield).

## 2. NOPAT regime-aware (reusa DRE v2)

Por empresa, janela **TTM mensal** (soma móvel 12m de `fin_dre_snapshots`, regime competência):
- `EBIT` = `resultado_operacional` (TTM).
- `imposto_operacional_regime` (valor **absoluto**, da DRE v2 / `detalhamento.imposto_teorico`):
  - **Simples**: DAS (teórico ou realizado).
  - **Presumido**: IRPJ + CSLL + PIS + COFINS.
- **`NOPAT = EBIT − imposto_operacional_regime`** (nunca multiplicador `(1−t)`; nunca deixa imposto > EBIT virar NOPAT positivo artificial — clamp documentado).
- Reporta também **`margem_operacional_pre_imposto` = EBIT / receita_liquida** — permite comparar as 3 empresas sem o "wrapper" tributário (Simples vs presumido não são diretamente comparáveis no líquido).

## 3. Capital Investido (operacional)

`capital_investido = capital_giro + ativo_fixo_operacional − ajustes`
- **`capital_giro`**: reusa o NCG da Onda 1 (`aco.total − pco.total`) OU a definição de capital de giro operacional (CR + estoque − fornecedores) — computado.
- **`ativo_fixo_operacional`**: input manual com metadados obrigatórios: `valor`, `data_ref`, `fonte` (book/avaliação/reposição/seguro), `base` (`reposicao` preferida a `book`), `flag operacional`. Sem ele → capital investido **parcial** + confiança rebaixada.
- **Ajustes (exclusões)**: goodwill (salvo capital realmente desembolsado), caixa não-operacional/excedente, ativos do dono não usados pela empresa.

## 4. WACC = "hurdle-rate" (rótulo honesto)

Não é market WACC. Por empresa:
- **Ke (custo de equity)** — input **decomposto**: `âncora` (CDI/Selic ou NTN-B) `+ prêmio_risco_equity + prêmio_tamanho_private + prêmio_iliquidez/controle`. Base consistente nas 3 (nominal/real, pré/pós, moeda, data, racional). **Cenários**: conservador / base / agressivo.
- **Kd (custo de dívida)** — input manual (taxa média da dívida), **pré-imposto** (sem `×(1−t)` — tax-shield off por regime).
- **Pesos** — `peso_divida = divida / (divida + equity)`; `peso_equity` complementar; dívida e equity (PL) são inputs manuais.
- `WACC = peso_equity × Ke + peso_divida × Kd`.
- Sem inputs de dívida/PL/Ke → WACC **indisponível** (não chuta).

## 5. Saídas: ROIC / EVA / spread / incremental

- **`ROIC = NOPAT / capital_investido`** (TTM).
- **`spread = ROIC − WACC`**.
- **`EVA = spread × capital_investido`** (rótulo: "EVA hurdle-rate", não valor de mercado).
- **`ROIC_incremental = Δ NOPAT / Δ capital_investido`** entre dois pontos (TTM atual vs TTM −12m, ou período configurável) — **output headline**: onde o próximo R$1 rende mais. Exibido com aviso quando Δ capital é pequeno/negativo (ruído).
- Ranking das 3 empresas por spread e por ROIC incremental.

## 6. Normalização de comingling (reportado vs normalizado)

Inputs manuais por empresa:
- **`prolabore_mercado_mensal`**: pró-labore "justo" de mercado pro trabalho do dono. Ajuste = (pró-labore real − mercado) volta/sai do EBIT.
- **`aluguel_mercado_mensal`**: aluguel de mercado de ativos do dono usados sem cobrança. Ajuste reduz EBIT (despesa figurativa) e/ou adiciona o ativo ao capital investido.
- **`intercompany`**: flag + valores de saldos/empréstimos entre as 3 empresas (CR/CP intercompany, empréstimos informais) — marcados; no normalizado, removidos do capital de giro / sinalizados como financiamento.

Saída: **EBIT/NOPAT/capital/ROIC/EVA "reportado" E "normalizado"** lado a lado. O normalizado é o número de decisão; o reportado mostra o gap.

## 7. Confiança / degradação

Nível `alta/media/baixa` + `motivos[]` por **completude dos inputs**:
- Ativo fixo ausente → capital investido parcial → ROIC/EVA "parcial".
- Dívida/PL/Ke ausentes → WACC/EVA/spread "indisponível".
- Normalização ausente (pró-labore/aluguel) → só "reportado", com aviso de comingling.
- Imposto operacional vindo de teórico parcial (config tributária incompleta da Onda 3b) → propaga rebaixamento.
Nunca fabrica número: campo ausente = `null` + motivo.

## 8. Onde mexe
- **Helper testável**: novo `src/lib/financeiro/valor-helpers.ts` (puro, vitest): `calcularNOPAT`, `margemOperacionalPreImposto`, `capitalInvestido`, `waccHurdle` (Ke decomposto + cenários), `roic`, `eva`, `roicIncremental`, `normalizarComingling`, `scoreConfiancaValor`. + `dre-tabelas` reuso se preciso.
- **Engine**: novo cálculo no `fin-cashflow-engine` (ou função dedicada) que lê TTM da DRE + NCG + inputs manuais e devolve o bloco "valor". Espelha o helper verbatim. Re-deploy via chat Lovable.
- **Config/inputs manuais**: coluna JSONB opcional (ex.: `fin_config_cashflow.valor_inputs`) com `{ ativo_fixo, divida, equity, ke:{ancora,premios,cenarios}, kd, prolabore_mercado, aluguel_mercado, intercompany }`. Leitura defensiva (sem migration obrigatória; SQL idempotente entregue à parte).
- **UI**: nova rota `/financeiro/valor` + página (cards ROIC/WACC/EVA/spread por empresa, ranking por ROIC incremental, toggle reportado×normalizado, banner de confiança, formulário dos inputs manuais — master only).
- **Tipos**: `financeiroService.ts` / hook novo `useValor`.
- **Docs**: `FINANCEIRO_CONFIABILIDADE.md` seção A2.

## 9. Testes (vitest no `valor-helpers.ts`)
- `calcularNOPAT`: presumido = EBIT − (IRPJ+CSLL+PIS+COFINS); Simples = EBIT − DAS; EBIT negativo → NOPAT negativo (sem multiplicador); imposto > EBIT → NOPAT negativo coerente.
- `margemOperacionalPreImposto`: EBIT/receita; receita 0 → 0.
- `capitalInvestido`: giro + ativo fixo − ajustes; sem ativo fixo → parcial (flag).
- `waccHurdle`: Ke = âncora + Σ prêmios; Kd pré-imposto (sem shield); pesos; cenários conservador/base/agressivo; sem dívida/PL/Ke → null.
- `roic`/`eva`/`spread`: fórmulas; capital 0 → null.
- `roicIncremental`: ΔNOPAT/Δcapital; Δcapital ≈ 0 → null + aviso.
- `normalizarComingling`: pró-labore mercado ajusta EBIT; aluguel ajusta EBIT + capital; intercompany removido do giro; reportado ≠ normalizado.
- `scoreConfiancaValor`: faltou ativo fixo → parcial; faltou Ke → WACC indisponível; sem normalização → só reportado + aviso.

## 10. Migração / Pré-requisitos
- Sem migration obrigatória. Inputs manuais = coluna JSONB opcional `valor_inputs` em `fin_config_cashflow` (SQL idempotente `ADD COLUMN IF NOT EXISTS ... default '{}'`), entregue pro SQL Editor. Sem ela → tudo degrada (só NOPAT + margem + capital de giro computados; ROIC parcial; WACC/EVA indisponíveis).
- Re-deploy do engine via chat Lovable. Rota nova no `src/App.tsx`.
- Depende da Onda 3 (DRE v2 / imposto operacional) já em produção — ✅.

## 11. Definição de Pronto
- NOPAT regime-aware (EBIT − imposto absoluto, nunca ×(1−t)) + margem pré-imposto.
- Capital investido = giro computado + ativo fixo manual (com metadados) − ajustes; parcial+flag sem ativo fixo.
- WACC hurdle-rate (Ke decomposto + cenários; Kd pré-imposto; pesos manuais), rotulado honesto; indisponível sem inputs.
- ROIC / EVA / spread + **ROIC incremental** (headline) + ranking das 3 empresas.
- Normalização de comingling (pró-labore/aluguel/intercompany) com **reportado vs normalizado**.
- Confiança por completude; nunca fabrica número (`null` + motivo).
- Testes vitest do `valor-helpers.ts` verdes; `bun run test` 100%; `validate` (CI) verde; zero lint novo.
- UI `/financeiro/valor` (master only) + docs CONFIABILIDADE seção A2 honesta: "melhora a decisão de alocação de capital, mas **direcional** até leases/quase-dívida, capex de manutenção, eliminação intercompany e registro de ativo fixo — deferidos".
- A2 não regride Ondas 1-3.
