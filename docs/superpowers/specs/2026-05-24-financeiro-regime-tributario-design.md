# Financeiro — Otimizador Tributário: Comparador de Regime (fase 1)

> Spec aprovado em 2026-05-24. Branch `feat/financeiro-regime-tributario`.
> Linhagem: completa a engine de DRE v2 (regime-aware) transformando-a de **diagnóstico**
> em **decisão de regime**. Codex rankeou esta como a fronteira financeira #1 em R$ × reuso.

## 1. Contexto e objetivo

O grupo Colacor opera 3 CNPJs em regimes fixos hoje:

| Empresa | Negócio | Regime atual | Anexo/Presunção |
|---|---|---|---|
| `colacor` | Indústria de abrasivos | Lucro Presumido | IRPJ 8% / CSLL 12% |
| `oben` | Distribuidora (compra-e-revende) | Lucro Presumido | IRPJ 8% / CSLL 12% |
| `colacor_sc` | Serviços | Simples Nacional | Anexo III (fator-r ≥ 28%) |

A escolha de regime é o **lever fiscal nº 1** de uma PME brasileira — uma decisão única que
pode mover dezenas de milhares de reais/ano. Hoje o sistema só calcula o imposto **teórico do
regime atual** (DRE v2). Este módulo calcula o imposto anual sob **cada regime elegível** por
empresa, aponta o ótimo, quantifica a economia em R$, e degrada honestamente quando falta dado.

**Objetivo (fase 1):** comparador de regime por empresa + consolidado do grupo, com degradação
honesta e flags de confiança. Roda **agora** com os dados que já temos (DRE TTM + RBT12) e
enriquece com os dados da contabilidade (folha detalhada, créditos de insumo) quando chegarem.

**Fora de escopo (fase 2, deferida):** engenharia fiscal-operacional — realocação de receita
entre os 3 CNPJs, efeito do crédito tributário do cliente no preço líquido, simulação de
NCM/CFOP/CST por item. Mexe em "substância econômica" (risco fiscal) e exige contador + dados
de NCM/CFOP/contratos no loop. A engine da fase 1 (motor multi-regime por empresa) é exatamente
a fundação da fase 2 — zero retrabalho.

## 2. Metodologia por regime

> ⚠️ **Revisão Codex (2026-05-24, effort alto):** 7 achados materiais incorporados abaixo. O mais
> importante: comparar o **DAS "cheio" do Simples** (que embute IRPJ/CSLL/PIS/COFINS/CPP + ICMS/ISS/IPI)
> contra os **federais "parciais"** do Presumido/Real **pode inverter a recomendação**. Por isso a base
> de comparação é o **eixo federal+CPP**, decompondo o DAS pela tabela de partilha (§2.5), com ICMS/ISS/IPI
> num eixo indireto separado (§2.6). Sem conseguir comparar a **mesma cesta de tributos**, o resultado
> Simples × (Presumido/Real) aparece como **"estimativa incompleta"**, não como ranking definitivo.

Base de comparação: **carga anual no eixo federal + CPP (INSS patronal)** sobre 12 meses móveis (TTM).

### 2.1 Simples Nacional — federal+CPP via partilha (reusa DRE v2)
- Alíquota efetiva = `aliquotaEfetivaSimples(anexo, rbt12)` (já existe: `(RBT12×nominal − deduzir)/RBT12`).
- DAS anual ≈ `aliquotaEfetiva(RBT12_TTM) × receita_TTM` → **flag de aproximação** (RBT12 varia mês a mês;
  refinar mês-a-mês se o histórico permitir).
- **Decomposição (§2.5):** federal+CPP = DAS × (1 − %ICMS/ISS/IPI da faixa/anexo). Só o naco federal+CPP
  entra na comparação; ICMS/ISS/IPI vão pro eixo indireto (§2.6).
- **CPP embutido** no DAS dos anexos **I/II/III/V** (não some à parte — Codex 2º passe). ⚠️ Só o **Anexo IV**
  recolhe CPP **à parte** (fora do DAS) — guard documentado (não aplicável às 3 empresas, mas a função deve tratar).
- **Elegibilidade por RBA (receita bruta acumulada do ano-calendário), NÃO RBT12** (achado Codex #5):
  teto R$4,8M, sublimite R$3,6M (valor 2026 confirmado p/ todos os estados). Excesso >20% → exclusão /
  ICMS-ISS fora **no mês seguinte**; ≤20% → **ano seguinte**. Fase 1 expõe o status (`elegivel` /
  `sublimite_excedido` / `inelegivel`) + motivo; não modela o timing fino (flag). RBA aproximada por
  TTM quando não houver a acumulada do ano corrente (flag).
- **fator-r** (serviços III×V): `anexoPorFatorR(massa_fator_r / receita)`. **Massa do fator-r** =
  salários + pró-labore + CPP + FGTS (achado Codex #6) — input próprio, **distinto** da base de CPP.
  Sem massa → **banda de sensibilidade** (calcula III e V + break-even de fator-r).

### 2.2 Lucro Presumido (reusa DRE v2, anualizado + corrigido)
- Reusa `impostoTeoricoPresumido`, mas **anualizado somando 4 trimestres**, cada um com seu **próprio
  limite de R$60k** para o adicional de IRPJ de 10%. ⚠️ NÃO aplicar o teto anual (R$240k) de uma vez.
- **Trimestres reais do histórico quando disponíveis** (achado Codex #1): dividir TTM em 4 partes iguais
  subestima o adicional sob sazonalidade (um trimestre alto + três baixos gera adicional que a média
  esconde). Usar receita trimestral real do histórico; só cair no TTM/4 com **flag de aproximação**.
- Presunção por atividade: comércio/indústria IRPJ 8% / CSLL 12%; serviços IRPJ 32% / CSLL 32%.
- **Receitas financeiras** (achado Codex #7): entram **integralmente** na base de IRPJ/CSLL (NÃO via
  presunção). Computar `base_irpj = receita_operacional×presunção + receitas_financeiras`.
- PIS/COFINS **cumulativo** 3,65% (0,65% + 3%) sobre **receita tributável** (ver §2.6 — segregar
  monofásico/ST/alíquota-zero; receita financeira no cumulativo tem alíquota zero — Decreto 8.426/2015).
- CPP = **encargo patronal sobre a folha** (separado) — ver §2.4.

### 2.3 Lucro Real — triagem de baixa confiança (novo)
- **Apuração trimestral** assumida na fase 1 (adicional R$60k/trimestre). ⚠️ Real também pode ser
  **anual** (adicional R$240k/ano no ajuste) — documentar a premissa; não afirmar "nunca anual" (Codex #1).
- **IRPJ** 15% + adicional 10% sobre lucro trimestral > R$60k. **CSLL** 9% sobre o lucro.
- **Lucro real** aproximado pelo `resultado_antes_impostos` da DRE TTM, **sem** adições/exclusões do
  LALUR nem compensação de prejuízo (limitada a 30%/período — Codex #2) → **confiança do Real = baixa**
  por construção, sempre. Lucro ≤ 0 → IRPJ/CSLL = 0 (flag "prejuízo fiscal: base negativa não modelada").
- **PIS/COFINS não-cumulativo** 9,25% (1,65% + 7,6%) sobre receita tributável **− créditos de insumo**.
  Crédito precisa de NCM/CFOP/CST que **não temos** → calcula com **crédito = 0 (pior caso pro Real)** +
  flag *"Real pode ser ainda melhor — créditos não estimados (faltam NCM/CFOP)."* Override opcional
  `credito_pis_cofins_estimado` (% de insumos creditáveis) destrava quando o contador fornecer.
- **PIS/COFINS sobre receitas financeiras** (Codex 2º passe — Decreto 8.426/2015): no não-cumulativo,
  `receitas_financeiras × 4,65%` (0,65% + 4%), **sem crédito**. ⚠️ Omitir isso pode **inverter Real × Presumido**
  se a receita financeira for material (no presumido cumulativo a receita financeira é alíquota-zero — §2.2).
- CPP = encargo patronal sobre a folha (igual presumido) — §2.4.
- **Empate técnico** (Codex #2): quando a economia estimada cair dentro da banda de erro do Real (driven
  pela aproximação do LALUR + crédito ausente), o status vira `empate_tecnico` ("exige validação do
  contador") em vez de recomendação confiante.

### 2.4 Encargo patronal sobre a folha (CPP + RAT/FAP + terceiros)
- No Simples (anexos I/II/III/V) o CPP está **dentro do DAS**; só o anexo IV recolhe à parte. No
  Presumido/Real é recolhido **à parte**.
- **CPP básica = 20% da folha**, mas RAT/FAP (1–3% × FAP) e terceiros/Sistema S (~5,8%) são custo
  patronal material (achado Codex #4). Fase 1: `encargo_patronal_pct` configurável (default **20%** =
  CPP estrita) com flag quando usar o default; o contador pode subir p/ ~25,8–26,8% (carga cheia).
  Documentar que o default subestima o custo patronal do Presumido/Real (viés pró-esses-regimes).
- A **folha base de CPP** é distinta da **massa do fator-r** (§2.1) — inputs separados.

### 2.5 Decomposição do DAS pela tabela de partilha (federal+CPP)
Para comparar a **mesma cesta** (federal+CPP) entre Simples e Presumido/Real (Codex #3), decompor o DAS
pelas tabelas de **repartição (partilha)** da LC 123 — % de cada faixa/anexo alocado a IRPJ/CSLL/PIS/
COFINS/CPP/ICMS/ISS/IPI. Necessárias para as 3 empresas: anexos **I** (comércio), **II** (indústria, com
IPI), **III** e **V** (serviços, com ISS). Adicionar a constante `PARTILHA_SIMPLES` (espelho do
`dre-tabelas-tributarias`).

⚠️ **Algoritmo correto (Codex 2º passe) — não é só `% estático da faixa`:**
1. Calcular o **indireto efetivo dentro do DAS** (ICMS/ISS/IPI) já com **teto e redistribuição**.
2. `federal+CPP = DAS − indireto_no_DAS` (o excedente do teto vai pros federais, não some).

**Armadilhas a capturar na tabela/algoritmo:**
- **Anexo III:** o teto de **ISS** ocorre já na **5ª faixa** quando a alíquota efetiva passa de **14,92537%**
  (não só na "faixa superior") — a diferença é redistribuída pros tributos federais. Modelar a faixa onde o ISS
  satura.
- **Anexo II:** regra específica para incidência **simultânea de IPI e ISS** — capturar.
- A soma das frações (federal+CPP + indireto pós-teto) = 1 por faixa.

### 2.6 Eixo indireto (ICMS/ISS/IPI) — separado e sinalizado (Codex #3, #7)
- **ICMS/ISS/IPI** são **iguais entre Presumido e Real** (cancelam no delta entre os dois) → excluídos do
  delta Presumido×Real, comparação válida nesse par.
- Para **Simples × (Presumido/Real)**, a decomposição (§2.5) tira ICMS/ISS/IPI do DAS, então o eixo
  federal+CPP é comparável; o eixo indireto é mostrado **à parte** ("ICMS/ISS/IPI comparados separadamente
  / constantes"). Quando a empresa tem **monofásico/ST/alíquota-zero** (relevante p/ Oben distribuidora,
  pode zerar PIS/COFINS de certos produtos), a base de PIS/COFINS dos federais fica superestimada →
  input opcional `receita_tributavel_pis_cofins_pct` refina; sem ele, **flag forte** + status
  "estimativa incompleta" no par Simples×outros.

## 3. Arquitetura (padrão A2/A3/A4)

### 3.1 Helper puro `src/lib/financeiro/regime-tributario-helpers.ts` (TDD)
Importa `dre-tabelas-tributarias` + `dre-helpers`. Adiciona a constante `PARTILHA_SIMPLES` (§2.5).
Todas as funções devolvem **eixo federal+CPP** (ICMS/ISS/IPI ficam no eixo indireto, §2.6). Funções:

- `partilhaFederalCpp(anexo, rbt12): number` — fração do DAS que é federal+CPP (1 − %ICMS/ISS/IPI da faixa).
- `impostoAnualSimples(input): { total_federal_cpp, das_total, icms_iss_ipi, aproximado } | degradado` —
  decompõe via partilha; CPP embutido.
- `elegibilidadeSimples(rba): { status: 'elegivel'|'sublimite_excedido'|'inelegivel', motivo }` — usa **RBA**.
- `impostoAnualPresumido(input): { irpj, csll, pis, cofins, cpp, total_federal_cpp }` — 4 trimestres
  (reais ou TTM/4 com flag), adicional por trimestre, receitas financeiras integrais na base IRPJ/CSLL.
- `impostoAnualReal(input): { irpj, csll, pis_cofins, cpp, total_federal_cpp, credito_aplicado, lucro_usado }`
  — lucro ≈ resultado_antes_impostos; crédito=0 default; lucro≤0 → IRPJ/CSLL=0.
- `encargoPatronal(folha_cpp_anual, pct): number | null` — pct default 0,20; null se folha desconhecida.
- `anexoEfetivoFatorR(massa_fator_r, receita): { anexo: 'III'|'V', fator_r } | banda` — banda se massa null.
- `compararRegimes(input): RegimeComparado[]` — calcula os elegíveis no eixo federal+CPP, ordena asc.
- `recomendarRegime(comparados, regimeAtual): { recomendado, economia_anual, vs_atual, status, confianca }`
  — `status` pode ser `empate_tecnico` quando economia < banda de erro (§2.3).
- `breakEvenMargemReal(input): number | null` — margem líquida abaixo da qual Real ganha do Presumido.
- `scoreConfiancaRegime(input): { nivel, motivos }` — Real sempre ≤ media (LALUR); ver §4.

Cada função devolve `null`/`degradado` com motivo quando falta input essencial (nunca fabrica).

### 3.2 Edge function `supabase/functions/fin-regime-tributario/index.ts`
- **Gate: master-only** (estratégia tributária é sensível, igual A2 `fin-valor-engine`).
  Aceita `service_role` como Bearer para chamadas internas.
- Espelha o helper **verbatim** (sem `@/`, tipos inline, aspas duplas, `deno check`).
- Lê: `fin_dre_snapshots` (TTM por empresa: receita, lucro, deduções), histórico de receita mensal
  para RBT12, e `fin_regime_inputs` (tabela master-only: folha anual, presunções, crédito estimado,
  override de anexo). Compõe por empresa + consolidado do grupo. Eco dos inputs para pré-preencher o dialog.
- Paginação `fetchAll` onde houver risco de truncamento PostgREST (>1000 linhas).

### 3.3 Tabela `fin_regime_inputs` (master-only)
Migration idempotente. Espelha o padrão de `fin_valor_inputs` (A2):
```
create table if not exists fin_regime_inputs (
  empresa text primary key,
  folha_cpp_anual numeric,                  -- base do encargo patronal (Presumido/Real)
  massa_fator_r_anual numeric,              -- salários+pró-labore+CPP+FGTS (fator-r Simples)
  encargo_patronal_pct numeric,             -- default 0.20 (CPP estrita); cheia ~0.268
  presuncao_irpj numeric,                   -- override (default por atividade)
  presuncao_csll numeric,
  credito_pis_cofins_estimado numeric,      -- % de insumos creditáveis (Real)
  receita_tributavel_pis_cofins_pct numeric,-- 1 − monofásico/ST/alíquota-zero
  anexo_simples text,                       -- override (default por atividade)
  atualizado_em timestamptz default now(),
  atualizado_por uuid
);
```
RLS master-only (select/insert/update). Seed das 3 empresas com defaults. **Entregue via SQL Editor
do Lovable** (workflow §5 do CLAUDE.md), não CLI.

### 3.4 Frontend
- Hook `src/hooks/useRegimeTributario.ts` (React Query, `enabled` param).
- Página `src/pages/FinanceiroRegimeTributario.tsx` (master-only).
- Dialog `src/components/financeiro/RegimeInputsDialog.tsx` (folha, presunções, crédito, anexo).
- Tipos em `src/services/financeiroService.ts` (append: `RegimeInputs`, `RegimeComparado`, `RegimeTributarioResult`).
- Link na sidebar `AppShell.tsx` (flag `masterOnly`, igual A2).
- Rota lazy em `App.tsx`.

### 3.5 Docs
Seção nova em `docs/FINANCEIRO_CONFIABILIDADE.md` documentando metodologia, inputs, degradação e
a base de comparação (§2.5).

## 4. Degradação honesta (achados do Codex incorporados)
- **Real é sempre ≤ media** (LALUR/adições/exclusões não modelados — Codex #2). Nunca 'alta'.
- Sem NCM/CFOP/CST → crédito PIS/COFINS do Real = 0 (pior caso) + flag "Real pode ser melhor".
- Sem `folha_cpp_anual` → encargo patronal não estimado → comparação Simples×outros **incompleta** + banda.
- Sem `massa_fator_r_anual` → fator-r indeciso → banda de sensibilidade (anexo III e V + break-even).
- `encargo_patronal_pct` no default 0,20 → flag "CPP estrita; RAT/FAP/terceiros não inclusos" (viés pró-Presumido/Real).
- Sem `receita_tributavel_pis_cofins_pct` e empresa com perfil de revenda (Oben) → PIS/COFINS pode estar
  superestimado (monofásico/ST/alíquota-zero) → flag + status "estimativa incompleta" no par Simples×outros.
- Sem imposto realizado (DAS/DARF) → usa só teórico + flag "sem validação contra recolhido".
- **RBA > R$4,8M** → Simples `inelegivel`; R$3,6M < RBA ≤ R$4,8M → `sublimite_excedido` (ICMS/ISS fora do DAS).
- RBA aproximada por TTM (sem acumulado do ano corrente) → flag.
- **Empate técnico:** economia < banda de erro → status `empate_tecnico` ("exige validação do contador").
- `scoreConfiancaRegime` agrega o pior sinal; 'alta' exige folha conhecida + dentro dos limites + sem flags fortes.

## 5. Produto (o que o master vê)
Por empresa: tabela de regimes (atual destacado) — **imposto anual R$, alíquota efetiva, regime
recomendado, economia anual R$ vs atual, confiança + motivos de degradação**. Consolidado do grupo:
imposto atual total → otimizado total → economia, com ressalva de validação contábil/legal.
Sensibilidade: break-even de margem (Real × Presumido) e de fator-r (III × V).

## 6. Invariantes e testes
- Imposto federal+CPP de cada regime ≥ 0; regime inelegível (RBA) não entra no ranking.
- `recomendado` = menor total_federal_cpp entre os elegíveis; `economia_anual` = atual − recomendado ≥ 0.
- **Adicional IRPJ por trimestre** (Codex #1): testar receita sazonal (1 trimestre alto + 3 baixos) que
  gera adicional real mas a média TTM/4 esconde → confirmar que trimestres reais capturam e TTM/4 sinaliza.
- **Partilha (§2.5):** `federal+CPP = DAS − indireto_no_DAS`; soma das frações (federal+CPP + indireto pós-teto)
  = 1 por faixa. **Testar o teto de ISS no Anexo III na 5ª faixa** (alíquota efetiva > 14,92537% → excedente
  redistribuído pros federais) e CPP embutido no Anexo V.
- **Presumido:** receitas financeiras entram integrais na base IRPJ/CSLL (não via presunção); receita
  financeira no PIS/COFINS cumulativo = alíquota zero.
- **Real:** lucro ≤ 0 → IRPJ/CSLL = 0; confiança sempre ≤ media; crédito=0 default reduz vantagem (flag);
  **PIS/COFINS sobre receitas financeiras = 4,65% sem crédito** (testar que não-omissão muda Real × Presumido).
- **Empate técnico:** economia < banda → status `empate_tecnico`.
- **fator-r:** massa/receita ≥ 0,28 → anexo III; < 0,28 → V; massa null → banda (III e V).
- Degradação: input ausente → `null`/flag, nunca número fabricado.
- Cobertura mínima: **~35 testes** no helper (partilha + cada regime + receitas financeiras + adicional
  sazonal + comparação + recomendação + empate técnico + break-even + elegibilidade RBA + degradação).

## 7. Segurança
- Página, hook e edge function **master-only**. Tabela `fin_regime_inputs` RLS master-only.
- Engine aceita `service_role` Bearer p/ composição interna (igual A2/A3/A4).
- Zero `no-explicit-any` novo (tipar shapes do raw).

## 8. Plano de validação
1. Revisão de metodologia com **Codex** (effort alto) **antes** de codar — focar: anualização do
   adicional, base do Real, tratamento do CPP/ICMS na base de comparação, sublimite, fator-r.
2. TDD do helper (vitest) + `deno check` no espelho.
3. Revisão adversária com Codex pós-implementação (igual A2/A3/A4).
4. `bun run test` + `bun lint` + CI `validate` verde.

## 9. Riscos e decisões em aberto (pós-Codex)
- **Base de comparação federal+CPP via partilha** (§2.5/§2.6) — decisão tomada: comparar a mesma cesta
  (federal+CPP), ICMS/ISS/IPI no eixo indireto. Risco residual: monofásico/ST/alíquota-zero (Oben) sem
  segregação → status "estimativa incompleta" no par Simples×outros até o input chegar.
- **Anualização TTM vs trimestres reais** — fase 1 usa trimestres reais do histórico quando disponíveis;
  TTM/4 só com flag (Codex #1, sazonalidade do adicional).
- **LALUR / Real** — lucro real ≈ resultado contábil; sem adições/exclusões/compensação 30%. Confiança do
  Real sempre ≤ media; `empate_tecnico` quando dentro da banda. Sinalização, **não** declaração.
- **Encargo patronal** — default CPP estrita 20%; RAT/FAP/terceiros via input. Default subestima custo de
  Presumido/Real (viés) — flag fixa.
- **RBA vs RBT12** — elegibilidade/sublimite por RBA do ano-calendário (Codex #5), RBT12 só p/ alíquota.
- **Validação contábil obrigatória** — o produto **recomenda, não declara**. Troca de regime exige contador
  + substância econômica. Caveat fixo na UI. Os dados finos (NCM/CFOP/CST, folha detalhada, créditos) vêm
  da contabilidade (founder pega na segunda) e **enriquecem** a confiança — o núcleo roda já, degradado e honesto.
