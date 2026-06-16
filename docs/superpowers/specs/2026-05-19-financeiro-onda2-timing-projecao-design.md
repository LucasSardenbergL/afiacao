# Financeiro Onda 2 — Timing da Projeção 13 Semanas

> Parte 2 de 4 do programa "Estado da Arte do Financeiro". Corrige o modelo de QUANDO o caixa entra na projeção 13s do `fin-cashflow-engine`, sobre a base já corrigida na Onda 1 (NCG). Design validado por 2 consults Codex (review do engine + review da metodologia das curvas de aging).

## 1. Contexto e Objetivo

A projeção 13s hoje coloca cada recebível na data de vencimento, aplica um desconto fixo de inadimplência, **ignora** o `atraso_medio_dias` que calcula, e **some** com recebíveis já vencidos. Resultado: caixa entra cedo demais, vales de liquidez subestimados, cenários mudam só amplitude (não timing). Esta onda substitui isso por **curvas de cobrança por faixa de aging**, calibradas sem viés.

Empresas: Colacor (indústria, presumido), Oben (distribuidora, presumido), Colacor SC (serviços, Simples).

### Achados endereçados (Codex)
- atraso médio calculado mas não aplicado; recebíveis vencidos somem; inadimplência mistura estoque (saldo >90) com fluxo (receita 12m); haircut uniforme; cenários só mudam amplitude; PMR/PMP não ponderados; folha pode duplicar com CP.
- Refinamentos do 2º consult: **viés de calibração** (só liquidados superestima), **+90 mistura timing com perda**, **ponte de horizonte**, **confiança por R$/concentração**, **clamps de cenário**.

### Não-escopo (deferido — documentado como evolução futura)
Segmentação por cliente / faixa de ticket / instrumento de pagamento (boleto/PIX/cheque); overrides manuais de tesouraria ("cliente prometeu sexta"); flags de disputado/protestado/jurídico; cheques pré-datados; sazonalidade; amortização de dívida bancária; recebíveis de cartão/adquirente. (Onda 3 = DRE; A2 = retorno/valor.)

## 2. Modelo de Aging (curvas calibradas por exposição)

### Faixas
`a_vencer` (não vencido), `1-30`, `31-60`, `61-90`, `+90` dias de atraso relativo a hoje.

### Calibração por exposição (corrige o viés — Codex #1)
Sobre os títulos dos últimos 12m (não só os liquidados):
- **`exposicao[faixa]`** = Σ `valor_documento` dos títulos que **alcançaram** aquela faixa. Faixa alcançada: pra liquidado, derivada de `data_recebimento − data_vencimento`; pra aberto, a faixa de aging atual.
- **`pago[faixa]`** = Σ `valor_recebido` dos títulos liquidados naquela faixa.
- **`aberto[faixa]`** = Σ `saldo` dos títulos ainda abertos naquela faixa (observação **censurada** — não invisível).
- **`taxa_recebimento[faixa]` = `pago / exposicao`** — abertos não-pagos puxam a taxa pra baixo, removendo o viés otimista. Cap [0,1].
- **`lag_dias[faixa]`** = média **ponderada por R$** de `(data_recebimento − data_entrada_na_faixa)` sobre os liquidados; guardar também **mediana e p75** (Codex #5 — média sozinha engana com lumpiness).

### +90 = recuperação separada de perda (Codex #2)
O `+90` é faixa de **risco de crédito**, não só caixa lento. Duas premissas:
- **`recuperacao_esperada[+90]`** = quanto do saldo +90 ainda entra (= taxa_recebimento[+90]).
- **`perda_esperada[+90]`** = `1 − recuperacao_esperada` → provisão.
Pro forecast 13s, separar **recuperação dentro do horizonte** (lag ≤ 13 semanas) de **recuperação após horizonte** e **perda**.

### Confiança (por R$ e concentração — Codex #5)
`amostra_suficiente[faixa]` exige: contagem mínima (≥20) **E** volume R$ mínimo **E** concentração top-1 abaixo de limite. Quando fraca → usa **defaults sensatos** + flag de confiança rebaixada. Default por faixa (ex.): a_vencer 0.98/+5d, 1-30 0.95/+20d, 31-60 0.90/+40d, 61-90 0.80/+70d, +90 0.50/+150d (editável).

## 3. Alocação na projeção (`gerarSemanas`) — Codex #3

Pra cada recebível aberto:
1. Identifica a faixa (dias de atraso vs hoje).
2. `valor_esperado = saldo × taxa_recebimento[faixa]` (cenário aplicado — §5).
3. Data esperada de recebimento:
   - `a_vencer`: `data_vencimento + lag_dias[faixa]`.
   - vencido: `hoje + lag_dias[faixa]` (reagenda pra frente — não some mais).
4. Se a data esperada cai **dentro das 13 semanas** → entra na semana correspondente.
5. Se cai **fora do horizonte** → **não entra no caixa projetado**, mas é somado numa linha **"esperado após horizonte"** + a perda esperada vai pra **"AR impaired"**. Exclusão deliberada e reportada (≠ bug antigo de sumir com vencido).

CP (saídas) segue na data de vencimento como hoje (simetria de timing de pagáveis = deferida; Codex #9). Eventos recorrentes/eventuais inalterados.

## 4. Inadimplência redefinida (Codex #3 do 1º review)
O `inadimplencia_observada_pct` exibido/alertado passa a ser a **média ponderada por R$ de `(1 − taxa_recebimento[faixa])`** sobre o CR aberto — taxa de perda limpa, não mistura mais estoque com fluxo. O alerta `inadimplencia_alta` usa esse número.

## 5. Cenários com clamps (Codex #6)
Reaproveita os deltas de `fin_config_cashflow.overrides_cenario`, agora aplicados à curva:
- **otimista**: `taxa_recebimento ↑`, `lag ↓`. **pessimista**: `taxa ↓`, `lag ↑`.
- **Clamps obrigatórios**: `taxa ∈ [0,1]`; `lag ≥ 0`; `lag ≤ lag_max[faixa]` (ex.: a_vencer 45, 1-30 60, 31-60 90, 61-90 120, +90 365). Cenário não move +90 pra "caixa fantasia".

## 6. PMR/PMP ponderado por R$ (Codex #7)
`calcularIndicadores`: PMR/PMP passam a ser **ponderados por valor** (não média simples por título). Adiantamentos separados dos recebíveis normais. Limitação de pagamentos parciais documentada (usamos data de liquidação final; parcial fino fica como evolução).

## 7. Guard de folha por janela (Codex #8)
No PCO (NCG): se houver CP de categoria de folha na janela de competência/pagamento, **usa o CP do ERP** e **não soma** o evento recorrente de folha na mesma janela (fallback só quando não há CP). Guard por **data + categoria**, não só categoria.

## 8. Onde mexe
- **Engine** `fin-cashflow-engine`: novo `calcularCurvasAging` (substitui parte de `calcularTaxasHistoricas`), `aplicarCenario` (clamps), `gerarSemanas` (alocação por aging + ponte de horizonte), `calcularIndicadores` (PMR/PMP ponderado + inadimplência ponderada), NCG (`calcularNCG`/PCO guard de folha). Re-deploy via chat do Lovable.
- **Espelho frontend testável**: novo `src/lib/financeiro/aging-helpers.ts` (faixa de um título, calibração por exposição, lag ponderado, clamps de cenário, alocação) + testes vitest. É o lar do TDD.
- **UI** `Fluxo13Semanas` + `NcgDecomposicao`: mostra a curva de aging por faixa (taxa + lag + confiança), a linha "esperado após horizonte / AR impaired", e PMR/PMP/inadimplência atualizados. Tooltip explicando calibração por exposição.
- **Schema**: nada novo obrigatório. As curvas calibradas + confiança vão em `premissas` do snapshot (auditoria). (Defaults editáveis podem reusar `fin_config_cashflow`.)
- **Docs**: CONFIABILIDADE.md seção Onda 2 (o que mudou, o que segue direcional/deferido).

## 9. Testes (vitest no espelho `aging-helpers.ts`)
- faixa de um título por dias de atraso (limites: 0, 1, 30, 31, 90, 91).
- calibração por exposição: taxa = pago/exposição com abertos puxando pra baixo (caso com aberto não-pago na faixa → taxa < 100% mesmo sem perda registrada).
- lag ponderado por R$ ≠ média simples (caso com 1 título grande lento + N pequenos rápidos).
- clamps de cenário: taxa não passa de 1, lag não fica negativo nem acima do max.
- alocação: a_vencer em venc+lag; vencido em hoje+lag; recebimento esperado > 13s → fora do caixa, na ponte.
- +90: recuperação dentro vs fora do horizonte + perda.
- confiança: faixa com <20 títulos OU concentração top-1 alta → flag rebaixada + default.

## 10. Migração / Pré-requisitos
- Sem migration obrigatória (lógica em runtime). Se adicionar defaults editáveis de curva, é uma coluna em `fin_config_cashflow` (SQL via Editor do Lovable).
- Re-deploy `fin-cashflow-engine` via chat do Lovable (lê o arquivo do repo).

## 11. Definição de Pronto
- Curvas calibradas por exposição (sem viés de liquidados), com confiança por R$/concentração.
- Vencidos reagendados (não somem); recebimentos fora de 13s na ponte "após horizonte", não no caixa.
- +90 com recuperação/perda separadas. Cenários com clamps. PMR/PMP ponderado. Inadimplência ponderada. Guard de folha por janela.
- Testes vitest do `aging-helpers.ts` verdes; `bun run test` 100%; zero lint novo.
- CONFIABILIDADE.md seção Onda 2 (honesta: "materialmente melhor, ainda direcional até segmentação/overrides — deferidos").
- Onda 2 não regride NCG (Onda 1) nem alertas.
