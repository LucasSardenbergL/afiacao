# Custo Marginal de Funding — Design (Funding & Dívida)

**Data:** 2026-05-25
**Programa:** Estado da Arte do Financeiro (próxima fronteira após A1–A4, DRE v2, Otimizador Tributário e Otimizador de Compras)
**Status:** aprovado no brainstorming + 1 passe Codex (consult) na metodologia incorporado.

## Objetivo

Cockpit financeiro (master-only) que responde duas perguntas encadeadas, **minimizando custo em R$ no horizonte relevante**:

1. **Decisão por recebível (sub-PR A):** "Vale antecipar este título?" — por título de `fin_contas_receber`, dado o deságio ofertado.
2. **Planejador de cobertura de gap (sub-PR B):** "Qual a mistura de fontes mais barata pra cobrir o gap de caixa da semana W?" — compondo a projeção de 13 semanas.

Compara **4 fontes** de funding, todas reduzidas a **fluxo de caixa datado / custo em R$**: (1) caixa próprio, (2) antecipação/desconto de recebíveis, (3) dívida de capital de giro, (4) cheque especial / conta garantida (piso da inércia).

## Princípio unificador (revisado pelo Codex — [P1])

**Toda fonte vira fluxo de caixa incremental datado; a decisão minimiza custo em R$ no horizonte relevante. A taxa anualizada é só métrica de comparação/governança — nunca o critério de ranking.**

Razão: os horizontes das fontes diferem (dívida de giro = meses, antecipação adianta N dias específicos, caixa próprio é "permanente"). Ranquear por % a.a. pra cobrir um gap **pontual** pode escolher errado (um CET alto sobre poucos dias dá R$ pequeno). Comparo sempre o **custo em R$ de prover M reais por D dias**.

Comparação **pré-imposto** (sem tax-shield), coerente com Simples/Presumido e com o A2 (`tax_shield_aplicado: false`). Não inventar dedutibilidade.

## Custo em R$ de cada fonte (prover M reais por D dias)

Função canônica: `custoEmReais(fonte, M, D)`.

- **Caixa próprio:** `M × ((1 + r_oport)^(D/365) − 1)`, onde `r_oport` = custo de oportunidade (ver "custo do caixa próprio" abaixo). Sem desembolso de tarifa/IOF.
- **Dívida de capital de giro:** `M × ((1 + CET)^(D/365) − 1)`. **Input é o CET a.a.** (custo efetivo total — inclui TAC, tarifas, seguro prestamista, reciprocidade, trava de recebíveis), NÃO a taxa nominal. [Codex P2: "se o input é só CDI+spread, o cockpit escolhe dívida barata que não existe".]
- **Cheque especial / conta garantida:** `M × ((1 + CET_cheque)^(D/365) − 1)`. Juros sobre saldo usado → para D curto o R$ é pequeno mesmo com CET feio.
- **Antecipação de um título** (face V, vence em N dias): você recebe líquido hoje
  `V_liq = V − deságio − IOF − tarifa`, onde:
  - `deságio = V × taxa_desconto_mensal × (N/30)` (desconto comercial "por fora", convenção bancária; o input default é a taxa a.m.).
  - `IOF` (operação de crédito PJ): `V × (0,000082 × N + 0,0038)`, com a parcela diária limitada a 365 dias. **Zero se a fonte é factoring** (compra de direito creditório, não é operação de crédito) — toggle `tipo ∈ {desconto, factoring}`. ⚠️ Factoring tem deságio maior e pode embutir ISS no custo do tomador (v1: capturado no próprio deságio do input; ISS explícito = v2).
  - `tarifa` fixa opcional por operação.
  - **Custo em R$ da antecipação = `V − V_liq`** (o que você abre mão pra ter `V_liq` hoje em vez de `V` em N dias).
  - Taxa efetiva a.a. (só exibição) = `(V / V_liq)^(365/N) − 1`.

## Custo de oportunidade do caixa próprio (sensível à alocação — Codex [P2])

`r_oport` **não** é sempre `max(cm_anual, retorno_A4)`. É o retorno da **próxima unidade de caixa sacrificada**:

- Caixa ocioso acima da reserva mínima e **sem ação A4 aprovada pendente** → `r_oport = cm_anual` (SELIC + spread + armazenagem, %/ano, já exposto como `custo_capital_efetivo_perc`).
- Fila A4 com projetos de spread positivo e **caixa insuficiente** → `r_oport = retorno marginal do projeto deslocado` (vem do A4).
- Risco alto na projeção / sazonalidade / covenant → o custo de consumir caixa sobe como **prêmio de liquidez** (eleva a reserva mínima), **não** como retorno de investimento. v1: aumenta `reserva_dias_min` quando a confiança da projeção é baixa (haircut, igual ao A4).

## Fronteira limpa com o A4 (anti double-count — Codex [P1])

- **A4 decide o USO** do caixa (consertar valor / liberar caixa / crescer). **Este cockpit decide como FINANCIAR** um déficit obrigatório ou uma ação já aprovada pelo A4.
- O cockpit consome do A4 **apenas dois outputs**: `caixa_livre_nao_alocado` e `retorno_marginal_melhor_uso`. **Não re-decide uso.**
- Se o caixa já foi consumido por uma ação A4 aprovada, ele **não entra** como fonte livre no planejador.
- **sub-PR A** pode rodar SEM compor o A4: usa `cm_anual` como benchmark de sobra e **sinaliza** "se você tem uso melhor (A4), o bar sobe". **sub-PR B** faz a composição A4 completa (chama `fin-next-best-action` via service_role, padrão A4↔A1/A2/A3).

## Decisão por recebível (sub-PR A)

Antecipar adianta `V_liq` hoje e **perde** o recebimento de `V` em N dias. Se vale depende do uso do caixa e do efeito no calendário:

### Detecção gap × sobra (no MENOR saldo projetado — Codex [P2])

Classificar pelo **menor saldo projetado entre hoje e N** (após compromissos já aprovados e reserva mínima), não pelo saldo de uma semana isolada. Com a projeção 13s disponível:

- **Simulação de 2 cenários** por título:
  - **Base:** sem antecipar.
  - **Alternativo:** recebe `V_liq` hoje e **não** recebe `V` em `T = hoje+N`.
- Se o cenário alternativo **melhora um vale antes de T mas cria/piora um vale em T** (saldo < reserva), o custo real inclui a fonte necessária em T. **v1 (sub-PR A): FLAG** "antecipar este título empurra o saldo abaixo da reserva em/depois de T (semana X)"; o re-custo completo é do planejador (sub-PR B).
- Sem projeção 13s → assume necessidade, benchmark = `cm_anual`, sem check de 2 cenários (degradação honesta).

### Regra de decisão (em R$)

- **Constrained (há gap até N):** antecipar vale se `custo_R$_antecipação < custo_R$ da fonte que ela substitui` (a próxima mais barata pra prover `V_liq` por N dias — dívida de giro, cheque especial). **Net-R$ = custo_substituída − custo_antecipação** (>0 → antecipar).
- **Surplus (sem gap até N):** antecipar vale só se o caixa liberado for **deployado** a retorno > custo da antecipação. Benchmark = `retorno_marginal_melhor_uso` do A4 (sub-PR B) ou `cm_anual` (sub-PR A). Como o deságio anualizado (~25–40% a.a.) quase sempre supera `cm_anual` (~15–20%), em sobra a recomendação costuma ser **"não antecipe"** — e a tela diz isso explicitamente, com o número.

### Estrutural × calendário (Codex [P2])

Antecipar pra cobrir NCG **recorrente** é rolagem que institucionaliza destruição de margem. Classificar:
- **Gap pontual** (buraco de calendário) → fonte flexível barata no período (antecipação/cheque pode fazer sentido).
- **Gap recorrente/estrutural** (NCG) → a recomendação muda para "isto é estrutural — renegocie prazo de fornecedor/cliente, ajuste preço/margem/estoque, ou tome dívida de **prazo adequado**; antecipar toda semana destrói margem". v1: heurística — se há gap em ≥X das próximas semanas (ex.: ≥6 de 13) → marca `estrutural` e exibe o aviso.

### Campos obrigatórios e por-CNPJ

- **Coobrigação é campo obrigatório** por operação/fonte (Codex [P2]): com coobrigação = dívida disfarçada (consome limite de crédito do grupo); sem coobrigação = transfere risco de crédito (o deságio compra funding + seguro de inadimplência). v1: captura o flag e exibe a natureza; valoração do risco transferido = v2.
- **Por-CNPJ, sem pool de grupo** (Codex [P2], já é princípio do A4): caixa de uma empresa **não** cobre gap de outra sem fonte explícita (mútuo intercompany → IOF + contrato + risco societário). O cockpit opera por empresa.

### Filtros de recebível antecipável

v1: `status_titulo = 'ABERTO'` AND `saldo > 0` AND `data_vencimento > hoje`. Exclui vencidos (sinaliza à parte). Permite o usuário **excluir título na mão** + **aviso** de concentração por sacado (não constraint dura). Filtros ricos (NF autorizada, sem protesto/disputa, não cedido em garantia, elegibilidade por banco) = v2.

## Planejador de cobertura de gap (sub-PR B)

Dado o gap de R$ X na semana W (projeção 13s):

- **Merit order em R$ no horizonte do gap** (D = dias até o gap fechar): empilha as fontes da menor pra maior **custo em R$**, respeitando limites:
  - caixa próprio até `caixa_livre_nao_alocado` (A4, preserva reserva);
  - dívida de capital de giro (CET, sem limite duro no v1 ou limite informado);
  - antecipar os recebíveis **mais baratos de antecipar** que vençam **depois** de W (deságio ∝ dias adiantados), com **check de 2 cenários** pra não criar vale pior adiante;
  - cheque especial por último **por governança**, mas o solver **permite que ele vença em R$** pra gap curtíssimo (flag "menor custo, mas fonte de emergência" — Codex [P2]).
- **Saída:** a mistura mais barata + custo total em R$ + **"custo da inércia em R$"** ("não fazer nada custa R$ X até a semana W, assumindo conta garantida por Y dias" — Codex [P3]).

## Degradação honesta

- Sem taxa/CET de uma fonte → fonte **excluída** + flag.
- Sem projeção 13s → planejador não roda; decisão por título funciona com benchmark `cm_anual` (sem check de 2 cenários).
- Sem distinguir gap × sobra (sem projeção) → mostra as duas lentes.
- Recebível sem `valor`/`vencimento` → pula o título.
- **Nunca fabrica recomendação** (padrão do programa).

## Dados & Arquitetura

Padrão consagrado do financeiro (CFO-sensível + compõe engines service_role) — **NÃO** o client-side do Otimizador de Compras:

- **Helper puro** `src/lib/financeiro/funding-helpers.ts` (TDD, funções puras) **espelhado verbatim** na edge function Deno `supabase/functions/fin-funding/index.ts` (master-only). Sem `@/`, tipos inline, aspas duplas.
- **Migration** `fin_funding_inputs` (jsonb por empresa) — taxas default das fontes + flags. RLS **master-only** (espelha `fin_valor_inputs`/`fin_regime_inputs`). Seed das 3 empresas.
- **Reusa:** `cm_anual` (de `fin_config_cashflow` / `custo_capital_efetivo_perc`), Kd/WACC (A2 `fin_valor_inputs`, fallback), `caixa_livre`/`retorno_marginal` (A4 `fin-next-best-action`, sub-PR B), gap da projeção 13s (`fin-cashflow-engine`), títulos (`fin_contas_receber`).
- **Rota** `/financeiro/funding` + item na sidebar (seção Financeiro, master-only, ícone tipo `Landmark`/`Banknote`).
- **Hook** `useFunding` (React Query) + **dialog** `FundingInputsDialog` (edição das taxas, espelha `RegimeInputsDialog`).

### Estrutura de `fin_funding_inputs.funding_inputs` (jsonb)

```jsonc
{
  "fontes": {
    "antecipacao":    { "taxa_desconto_mensal_perc": 2.2, "tarifa_fixa": 0, "tipo": "desconto", "coobrigacao": true, "ativo": true },
    "capital_giro":   { "cet_anual_perc": 28.0, "ativo": true },
    "cheque_especial":{ "cet_anual_perc": 130.0, "ativo": true }
  },
  "reserva_dias_min": 15,
  "gap_estrutural_semanas_min": 6
}
```

## Contrato de tipos (esboço)

```ts
type FonteFunding = 'caixa_proprio' | 'antecipacao' | 'capital_giro' | 'cheque_especial';

type TituloAntecipavel = {
  id: string; empresa: string; nome_cliente: string | null;
  valor: number; dias_ate_vencimento: number; // N
};

type DecisaoTitulo = {
  titulo: TituloAntecipavel;
  v_liq: number; custo_rs_antecipacao: number; taxa_efetiva_aa: number;
  contexto: 'gap' | 'sobra' | 'indefinido';
  benchmark_fonte: FonteFunding | 'melhor_uso_a4';
  custo_rs_benchmark: number | null;
  net_rs: number | null; // custo_substituída − custo_antecipação (gap) | retorno_uso − custo (sobra)
  recomendacao: 'antecipar' | 'nao_antecipar' | 'falta_dado';
  flags: string[]; // ex.: 'cria_vale_em_T', 'estrutural', 'coobrigacao', 'concentracao_sacado'
};

type PlanoCobertura = { // sub-PR B
  empresa: string; semana_gap: string; gap_rs: number; horizonte_dias: number;
  stack: { fonte: FonteFunding; montante_rs: number; custo_rs: number; flag?: string }[];
  custo_total_rs: number; custo_inercia_rs: number;
  confianca: 'alta' | 'media' | 'baixa'; motivos: string[];
};
```

## Gating / Persona

**Master-only** (tesouraria/CFO), igual A2 valor e regime tributário. Rota gated + item de sidebar `masterOnly` + RLS master-only na tabela + `validateCaller` na edge function aceita só master (e `x-cron-secret` se algum cron futuro precisar — v1 sem cron).

## Escopo v1 vs v2

**v1 (correção — sem isso recomenda errado):** R$-no-horizonte como critério · custo do caixa próprio sensível à alocação · fronteira A4 (consome só `caixa_livre` + `retorno_marginal`) · simulação 2-cenários no menor saldo (flag em A, re-custo em B) · classificação estrutural × calendário · por-CNPJ · flag de coobrigação obrigatório · input **CET** pra dívida · cheque especial pode vencer gap curto (flagged) · custo da inércia em R$ · exclusão manual de título + aviso de concentração.

**v2 (rico, não trava o v1):** engine de elegibilidade/concentração por sacado (limites duros, cedido em garantia, protesto/disputa, glosa) · valoração do risco transferido sem coobrigação (seguro de inadimplência) · modelagem de mútuo intercompany · tributação de receita financeira do caixa-como-aplicação · ISS de factoring explícito.

## Plano de testes (casos-chave do helper, TDD)

- `custoEmReais`: caixa próprio / dívida / cheque pra (M, D) — confere a fórmula `M×((1+r)^(D/365)−1)`; D curto vs longo.
- `custoAntecipacao`: desconto (com IOF) vs factoring (IOF 0); deságio por fora; V_liq; taxa efetiva a.a.; N pequeno (15d) e grande (90d).
- IOF: parcela diária + 0,38% fixo; teto 365 dias.
- `decidirTitulo`: **gap** (antecipação mais barata que cheque → antecipar, net>0) · **gap** (antecipação mais cara que dívida → não antecipar) · **sobra** (deságio > cm_anual → não antecipar, com número) · **sobra com uso A4** (retorno A4 > custo → antecipar).
- 2 cenários: título cujo recebimento em T é necessário → flag `cria_vale_em_T`.
- estrutural: gap em ≥6 de 13 semanas → flag `estrutural` + aviso.
- degradação: sem taxa → fonte excluída; sem projeção → benchmark cm_anual; recebível sem valor → pulado.
- `montarPlanoCobertura` (sub-PR B): merit order em R$; cheque vence gap curtíssimo (flag emergência); custo da inércia.
- por-CNPJ: caixa de empresa A nunca aparece como fonte de empresa B.

## Codex — findings incorporados (rastreabilidade)

- [P1] Princípio R$-no-horizonte (não % a.a. pra ranking). ✅
- [P1] Fronteira A4 limpa (consome só 2 outputs, não re-decide uso). ✅
- [P2] Custo do caixa próprio = uso marginal deslocado + prêmio de liquidez via reserva. ✅
- [P2] Gap × sobra no menor saldo projetado + simulação 2 cenários. ✅
- [P2] Concentração por sacado (aviso no v1, engine no v2). ✅
- [P2] Coobrigação como campo obrigatório. ✅
- [P2] CET (não taxa nominal) pra dívida. ✅
- [P2] Cheque especial pode vencer gap curto (flag emergência). ✅
- [P2] Dedutibilidade: mantém pré-imposto; ressalva intercompany/aplicação = v2. ✅
- [P2] Por-CNPJ, sem pool de grupo. ✅
- [P2] Estrutural × calendário muda a recomendação. ✅
- [P3] Filtros de recebível ricos = v2; v1 filtra o óbvio + exclusão manual. ✅
- [P3] Custo da inércia em R$. ✅
- [P3 — bom] Pré-imposto coerente; A4(uso) vs cockpit(fonte) correto. ✅ mantido.
