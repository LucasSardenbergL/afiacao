# Financeiro Onda 3 — DRE v2 (regime-aware + confiança)

> Parte 3 de 4 do programa "Estado da Arte do Financeiro". Corrige a metodologia da DRE do `omie-financeiro` (`calcularDRE`), sobre a base já corrigida nas Ondas 1 (NCG) e 2 (timing da projeção 13s). Design validado por consult Codex (review da metodologia tributária + estrutura de DRE para PMEs).

## 1. Contexto e Objetivo

A DRE mensal hoje (`fin_dre_snapshots`, gerada em `omie-financeiro/calcularDRE`, linhas ~865–1071) tem 4 problemas de metodologia:

1. **Caixa não é caixa**: `regime=caixa` bucketiza por `data_vencimento` (proxy), não pela data real de recebimento/pagamento.
2. **Imposto cego de regime**: linha única agregada de `impostos`, classificada por heurística de string na descrição; o regime tributário da empresa (Simples vs presumido) **nunca** é consultado.
3. **Detecção frágil de imposto**: prefixo `'3.99'` / keyword no fallback do mapping.
4. **Sem gate de confiança**: existe `qtd_categorias_sem_mapeamento` no snapshot, mas sem consequência/sinalização.

Esta onda entrega: **estrutura de DRE regime-aware**, **caixa real (estimado) com flag**, **motor de imposto teórico completo** (Simples progressivo + presumido trimestral) como conferência ao lado do realizado, **mapping explícito** no lugar do prefixo, e **gate de confiança** com sinais reais.

Empresas: Colacor (indústria, **lucro presumido**), Oben (distribuidora, **lucro presumido**), Colacor SC (serviços, **Simples Nacional**).

### Achados endereçados (Codex)
- Simples: **DAS é recolhimento unificado — nunca quebrar** em IRPJ/CSLL/PIS/COFINS/ICMS/ISS (LC 123). Split por categoria Omie = contabilidade fantasia.
- Estrutura: tributos **sobre receita** (ICMS/ISS/PIS/COFINS/IPI) são **deduções** (acima da receita líquida); IRPJ/CSLL são **imposto sobre o lucro** (abaixo, após resultado antes de impostos).
- Teórico ingênuo (alíquota fixa) engana: Simples precisa de RBT12 + anexo + fórmula progressiva (nominal − parcela a deduzir) + fator-r; presumido é **trimestral** + adicional 10% (>R$60k/tri) + presunção por atividade. DAS pago no mês ≈ receita do mês anterior.
- Caixa com fallback relevante = **"caixa estimado"**, não real. Competência deve ser a visão **primária** da DRE numa PME.
- Confiança: unmapped+fallback é pouco — somar % mapeado por valor, categorias genéricas, delta teórico×realizado.

### Não-escopo (deferido — documentado como evolução futura)
Eliminação intercompany; consolidação por competência com calendário de fechamento; CMV/CPV real (estoque/compras/produção/variação de inventário); depreciação/amortização; provisões de 13º/férias/encargos; split pró-labore × folha × distribuição de lucros; capex × despesa; parcelamento/juros/principal de dívida; retenções na fonte; ISS/ICMS/IPI por competência (vs pagamento); receita por operação fiscal (venda/serviço/industrialização/revenda/bonificação); centros de custo; conciliação Omie×NF e imposto×PGDAS/DARF. (Onda 4 = A2 retorno/valor.)

## 2. Estrutura da DRE (regime-aware) — Codex #1, #3

```
  Receita bruta
  (−) Devoluções / cancelamentos / descontos incondicionais
  (−) Deduções [tributos sobre receita]:
        • presumido → ICMS / ISS / PIS / COFINS / IPI  (por linha, via mapping)
        • Simples   → DAS (linha única, gerencial)      ← nunca quebrado
  = Receita líquida
  (−) CMV/CPV
  (−) Despesas operacionais / administrativas / comerciais / financeiras
  (+) Receitas financeiras
  = Resultado antes de IRPJ/CSLL
  (−) Imposto sobre o lucro:
        • presumido → IRPJ + adicional 10% + CSLL  (do realizado; teórico ao lado)
        • Simples   → 0 (já no DAS acima; nota explicativa no detalhamento)
  = Lucro líquido
```

- Ressalva gravada no `detalhamento`: no Simples, a "receita líquida" é **gerencial** (o DAS mistura tributo sobre receita + IRPJ/CSLL + CPP) e **não é diretamente comparável** a presumido.
- O `fin_dre_snapshots` já tem `deducoes` e `impostos`; passam a ser preenchidos pela regra acima. As sub-linhas de imposto vão no `detalhamento.impostos` (`{ icms, iss, pis, cofins, ipi, das, irpj, csll }`), preenchendo só o que o regime usa.

## 3. Mapping explícito (substitui o `'3.99'`/keyword) — issue #3

Cada categoria de imposto no `fin_categoria_dre_mapping` ganha um `dre_linha` específico em vez do balde `impostos`:
- `ded_icms`, `ded_iss`, `ded_pis`, `ded_cofins`, `ded_ipi` (deduções, presumido)
- `das` (Simples)
- `irpj`, `csll` (imposto sobre lucro, presumido)

A classificação passa a ser: **lookup no mapping (exato → prefixo) → `dre_linha`**. A heurística de keyword vira **último fallback** e, quando usada para imposto, **conta para o gate de confiança** (categoria de imposto não mapeada = sinal de baixa confiança). Sem `dre_linha` de imposto reconhecido, o valor cai em `outras_despesas` + flag.

## 4. Caixa estimado (real + fallback + flag) — issue #1, Codex #4

- `regime=caixa`: bucketiza por `data_recebimento` (CR) / `data_pagamento` (CP) quando presentes; **fallback** para `data_vencimento` quando faltam.
- `fallback_pct` = (Σ valor com fallback) / (Σ valor total) por período, calculado separado para entradas e saídas.
- Rótulo: quando `fallback_pct > 0.10`, o snapshot é **"caixa estimado"** (campo `caixa_estimado: true` no `detalhamento`); alimenta o gate de confiança.
- `regime=competencia` segue por `data_emissao` (inalterado) e é tratado como **visão primária** na UI (caixa = secundária). Filtro de status do caixa inalterado (RECEBIDO/PAGO/PARCIAL/LIQUIDADO).

## 5. Motor de imposto teórico (completo) — issue #2, Codex #1, #2

Conferência ao lado do realizado (do Omie). **Degradação honesta**: onde faltar dado, o teórico daquele imposto = `null` ("indisponível") e rebaixa a confiança — **nunca inventa número**.

### 5.1 Constantes legais embutidas (lei nacional, estáveis)
- **Simples Anexos I–V**: faixas de RBT12 → (`aliquota_nominal`, `parcela_a_deduzir`). Embutidas como tabela constante no helper.
- **Presumido**: presunção IRPJ por atividade (8% comércio/indústria, 32% serviços; 16% alguns serviços), presunção CSLL (12% / 32%), IRPJ 15% + **adicional 10%** sobre base presumida que exceder R$60k/trimestre, CSLL 9%, PIS 0,65%, COFINS 3% (cumulativo).

### 5.2 RBT12
Soma de `receita_bruta` dos **12 meses anteriores** à apuração (de `fin_dre_snapshots`, regime competência). Disponível na base.

### 5.3 Config por empresa (`fin_config_cashflow.dre_tributario` — JSONB novo, opcional)
```jsonc
{
  "regime": "simples" | "presumido",
  "atividades": [               // segregação de receita por atividade/anexo
    { "peso": 1.0, "anexo": "I", "presuncao_irpj": 0.08, "presuncao_csll": 0.12 }
  ],
  "fator_r": { "habilitado": false }  // serviços que alternam Anexo III/V
}
```
Sem config → regime herdado de um default por empresa (Colacor/Oben presumido, Colacor SC Simples) e teórico marcado "config incompleta" (confiança média).

### 5.4 Cálculo
- **Simples**: `aliquota_efetiva = (RBT12 × nominal − parcela) / RBT12`, aplicada à receita do mês segregada por anexo. **Fator-r**: se `folha12m / receita12m ≥ 0,28` → Anexo III, senão V (quando aplicável). Comparação alinha competência: DAS pago no mês M vs receita de M−1.
- **Presumido**: agrega por **trimestre**. IRPJ = `15% × (presuncao_irpj × receita_tri)` + `10% × max(0, base − 60000)`. CSLL = `9% × (presuncao_csll × receita_tri)`. PIS/COFINS mensais sobre receita. Teórico exibido no fechamento do trimestre (meses 1–2 do tri = "parcial").
- Saída: `{ realizado, teorico, delta }` por imposto + total. `teorico = null` quando dado insuficiente (sem segregação por atividade; sem folha p/ fator-r).

## 6. Gate de confiança — Codex #5

Sinais (só os que temos dado), combinados num nível `alta | media | baixa` + `motivos[]`:
- `pct_mapeado_valor` = (receita+despesa mapeada por valor) / total. <90% → rebaixa.
- `fallback_pct` do caixa (§4). >10% → media; >20% → baixa.
- `share_generico` = categorias "outros/diversos/ajuste/transferência" por valor. Alto → rebaixa.
- Categoria de imposto caída no fallback keyword (não mapeada) → rebaixa.
- `delta` teórico×realizado de imposto além de banda (ex.: >25%) → sinaliza (não rebaixa sozinho; pode ser timing/competência).
- Config tributária incompleta → no máximo `media` no teórico.

Gravado no snapshot (`detalhamento.confianca = { nivel, motivos, pct_mapeado_valor, fallback_pct }`). Banner na UI. _Deferidos: conciliação Omie×NF e imposto×PGDAS/DARF, separação competência×pagamento._

## 7. Onde mexe
- **Helper testável (lar do TDD)**: novo `src/lib/financeiro/dre-helpers.ts` (puro, vitest): `classificarLinhaDRE` (mapping → dre_linha regime-aware), `resolverDataCaixa` (real + fallback + flag), `calcularRBT12`, `aliquotaEfetivaSimples` (tabela anexos + fórmula), `impostoTeoricoPresumido` (trimestral + adicional), `montarDRE` (ladder), `scoreConfianca`. Tabelas legais como constantes.
- **Engine** `omie-financeiro/calcularDRE`: espelha os helpers verbatim (Deno). Re-deploy via chat do Lovable.
- **Frontend**: `useFinanceiro` (loadDRE/tipos), `FinanceiroCockpit` + componente de DRE — sub-linhas de imposto regime-aware, coluna teórico×realizado, banner de confiança, rótulo "caixa estimado", ênfase competência-primária.
- **Schema**: nada obrigatório (lógica runtime; sub-linhas em `detalhamento`). Config tributária = coluna JSONB opcional `dre_tributario` em `fin_config_cashflow` (SQL idempotente entregue à parte, default ausente → degrade).
- **Docs**: `FINANCEIRO_CONFIABILIDADE.md` seção Onda 3.

## 8. Testes (vitest no espelho `dre-helpers.ts`)
- `classificarLinhaDRE`: categoria de ICMS → `ded_icms` (presumido); DAS → `das` (Simples); IRPJ → `irpj`; categoria de imposto não mapeada → fallback + flag.
- `resolverDataCaixa`: usa data real quando presente; fallback p/ vencimento quando ausente; `fallback_pct` correto; rótulo "caixa estimado" acima de 10%.
- `calcularRBT12`: soma 12 meses anteriores; ignora o mês corrente.
- `aliquotaEfetivaSimples`: faixa correta da tabela → (RBT12×nominal−parcela)/RBT12; fator-r alterna anexo no limiar 28%.
- `impostoTeoricoPresumido`: presunção por atividade; adicional 10% só sobre excedente de R$60k/tri; CSLL/PIS/COFINS corretos; receita mista segrega base.
- `montarDRE`: ladder regime-aware (Simples sem IRPJ/CSLL abaixo + DAS nas deduções; presumido com indiretos nas deduções + IRPJ/CSLL abaixo); receita líquida e lucro líquido não duplicam imposto.
- `scoreConfianca`: pct_mapeado baixo → rebaixa; fallback alto → rebaixa; config incompleta → teórico no máximo "media"; delta alto → motivo sem rebaixar sozinho.
- Degradação: sem segregação de atividade / sem folha → teórico `null`, não 0.

## 9. Migração / Pré-requisitos
- Sem migration obrigatória. Config tributária opcional = coluna JSONB `dre_tributario` em `fin_config_cashflow` (SQL idempotente `ADD COLUMN IF NOT EXISTS ... default '{}'`), entregue pra colar no SQL Editor; sem ela, o motor degrada (regime por default por empresa, teórico parcial, confiança média).
- Re-deploy `omie-financeiro` via chat do Lovable (lê o arquivo do repo).

## 10. Definição de Pronto
- DRE com estrutura regime-aware: deduções (indiretos presumido / DAS Simples) acima da receita líquida; IRPJ/CSLL abaixo (presumido); Simples sem duplicar imposto.
- Caixa por data real + fallback rotulado "caixa estimado" + `fallback_pct`; competência como visão primária na UI.
- Motor teórico completo (Simples progressivo com RBT12/anexo/fator-r; presumido trimestral + adicional) ao lado do realizado, com degradação honesta (`null`, nunca inventado).
- Mapping explícito substitui o `'3.99'`/keyword; imposto não mapeado → confiança.
- Gate de confiança (nível + motivos) gravado e exibido.
- Testes vitest do `dre-helpers.ts` verdes; `bun run test` 100%; zero lint novo; `validate` (CI) verde.
- CONFIABILIDADE.md seção Onda 3 honesta: "materialmente melhor e menos enganoso, ainda direcional até fechamento contábil + conciliação fiscal + CMV real + intercompany — deferidos".
- Onda 3 não regride NCG (Onda 1) nem timing (Onda 2).
