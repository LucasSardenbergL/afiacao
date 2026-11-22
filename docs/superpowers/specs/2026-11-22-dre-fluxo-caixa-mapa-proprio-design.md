# DRE e Fluxo de Caixa — mapa próprio de categorias (3 empresas) — desenho

> 2026-11-22. Money-path. Levantamento: medido em prod via `psql-ro` (janela 12m fechados 2025-11..2026-10).
> Ordem: **Onda A (DRE: motor v1.6 + mapa explícito por empresa)** → **Onda B (DRE: extrato sem título)** → **Onda C (DFC: fluxo_linha + realizado por atividade)**.
>
> ⚠️ **REESCOPADO após o parecer Codex (2026-11-22) — o que foi entregue está em `docs/historico/dre-mapa-proprio-nao-resultado.md`:** A.1 (sinal por natureza) foi **descartado** nesta onda (quebra PE/orçamento); entrou a linha `nao_resultado` (v1.13) e o mapa só das contas com uso, respeitando a direção. Ondas B e C exigem antes resolver identidade/dedupe de `fin_movimentacoes` (P0 do Codex).

## 1. Diagnóstico (fatos medidos)

| Empresa | Regime | Receita 12m | CP 12m | CP mapa explícito | CP heurística | CP fora_dre |
|---|---|---|---|---|---|---|
| colacor | Presumido | 755,7k | 1.278,8k | 65,9% | 4,2% | 29,9% |
| oben | Presumido | 4.006,5k | 3.769,9k | 65,6% (só CMV via `_default`) | 34,4% | 0% |
| colacor_sc | Simples | 159,6k | 463,7k | 0,2% | 99,8% | 0% |

- Só a colacor tem mapa próprio (121 linhas). oben e colacor_sc vivem do `_default` (36 linhas, 27 com códigos 3.x/4.x/5.x inexistentes no plano real).
- **A heurística está morta:** `categoria_descricao` é NULL em 100% dos títulos de CP → todo código sem mapa cai em `receita_bruta` (CR) ou `despesas_operacionais` (CP), com `mapeado:false`.
- **Código não é global:** 2.01.99 = imobilizado (colacor) / uso e consumo (oben, colacor_sc); 1.04.04 = aumento de capital (oben) / empréstimos (colacor_sc); CSLL = 2.06.98 (oben) / 2.06.91 (colacor). ⇒ `_default` por código é inseguro; mapa por (empresa, código).
- **Erros por R$ (12m):** oben 2.05.03 empréstimo 612k como despesa operacional · oben impostos sobre venda 348k fora das deduções (ICMS 171k, COFINS 98k, DIFAL 56k, PIS 24k) · oben 2.06.94 parcelamento 154k como despesa · oben IRPJ/CSLL 59k como despesa operacional · colacor_sc folha 382k sem linha (despesa operacional genérica) · colacor_sc empréstimo 26k como despesa · devoluções de venda da oben (13k) como despesa e devoluções de compra (11k) como receita bruta · aumento de capital da oben (7k) como receita bruta.
- **Motor soma sem sinal** (`omie-financeiro/index.ts:1985`, `totais[linha] += val`): um CR mapeado em linha devedora (devolução de compra → CMV) AUMENTARIA o CMV. Hoje não ocorre (nenhum CR mapeado em linha devedora) — o mapa novo precisa disso.
- Despesa bancária/juros **nunca** entram na DRE: são lançamentos de extrato (origem `EXTP`/`EXTR`, sem título) — colacor_sc ~80k, oben 11,5k (Onda B).
- `fin_fechamentos` vazio (nenhum mês fechado) ⇒ reclassificar o histórico não esbarra em trava de período.

## 2. Onda A — DRE

### A.1 Motor v1.6 (`omie-financeiro` + espelho `src/lib/financeiro/dre-helpers.ts`)
- **Acumulação com sinal pela natureza da linha.** Credoras: `receita_bruta`, `receitas_financeiras`, `outras_receitas`. Devedoras: as demais (`deducoes`, `ded_*`, `das`, `cmv`, `despesas_*`, `outras_despesas`, `irpj`, `csll`). `contribuicao = (isReceita === credora(linha)) ? val : −val`. `fora_dre` inalterado (já separa entradas/saídas).
- Universo de confiança (`valorTotal`/`valorMapeado`) continua em valor absoluto (é medida de cobertura, não de resultado).
- `composicao_*` registra o valor COM sinal aplicado (é o que a linha recebeu).
- Versão `v1.6-dre-sinal-natureza`; fingerprint + `VERSAO` da sonda.

### A.2 Mapa próprio por empresa — cobertura do plano INTEIRO
- Linha explícita para **todas** as contas de `fin_categorias` das 3 empresas (510), inclusive as nunca usadas — título futuro num código existente já nasce classificado. Código criado depois continua caindo na heurística com `mapeado:false` (honesto).
- Classificação por DESCRIÇÃO daquela empresa (nunca por prefixo cego), com duas classificações independentes (Claude + Fable cego) reconciliadas; divergência = revisão manual registrada em `notas`.
- Decisões-chave: empréstimo (tomado/pago), parcelamento de tributo, aporte, distribuição, imobilizado, aplicação, adiantamento, transferência → `fora_dre`. Impostos sobre venda → `ded_*` (Presumido) / `das` (Simples). IRPJ/CSLL → `irpj`/`csll` (Presumido). Devolução de venda → `deducoes`. Devolução de compra (CR) → `cmv` (abate, via A.1). Folha → `despesas_administrativas`. Tarifa/juros/IOF → `despesas_financeiras`.
- Escritor: `db/2026-11-22-fin-dre-mapa-proprio.sql` (upsert por (empresa, código); `notas` com origem da decisão), com **precondição** de motor v1.6 servido (versão+fonte atestadas na MESMA transação, como a fase 2) e **postcondição** = o conjunto gravado é exatamente o esperado.
- `_default` NÃO é apagado (outras leituras/UI podem usar), mas deixa de ser alcançado pelas 3 empresas.

### A.3 Recálculo
- `calcular_dre_year` caixa **e** competência das 3 empresas para todos os anos com dado; antes/depois por linha × mês registrado no PR.

### Fora de escopo (registrado, não fabricado)
- **Rateio da folha OBEN↔colacor_sc na DRE**: input humano (`fin_custo_rateio`); a DRE por CNPJ segue honesta por CNPJ.
- **CMV por variação de estoque**: não há histórico de estoque mensal; CMV = compras do período (rótulo na UI).

## 3. Onda B — extrato sem título na DRE
- O motor passa a somar `fin_movimentacoes` ótica `CONTA_CORRENTE_*`, origem `EXTP`/`EXTR`, `valor>0`, classificadas pelo MESMO mapa (competência = caixa = data do movimento). Exclui `TRAP`/`TRAR`.

## 4. Onda C — Fluxo de caixa (DFC, método direto)
- Coluna `fluxo_linha` em `fin_categoria_dre_mapping` (mesmo registro da DRE — uma decisão por (empresa, código)); atividade derivada do prefixo: `op_*` operacional, `inv_*` investimento, `fin_*` financiamento, `transferencia_interna` fora do fluxo.
- Vocabulário: `op_recebimento_clientes · op_outros_recebimentos · op_fornecedores · op_pessoal · op_impostos · op_despesas · op_tarifas_bancarias · op_adiantamentos · inv_imobilizado · inv_venda_ativo · inv_aplicacoes · fin_captacao · fin_amortizacao · fin_parcelamento_tributos · fin_aporte · fin_distribuicao · fin_intercompany · transferencia_interna`.
- Fonte do realizado: `fin_movimentacoes` ótica `CONTA_CORRENTE_REC/PAG`, `valor>0` (cada linha = um evento de caixa; `CONTA_A_*` dobraria). Origem `TRAP/TRAR` ⇒ `transferencia_interna` independentemente da categoria. Sem mapa ⇒ `nao_classificado` VISÍVEL.
- View `v_fluxo_caixa_realizado_mensal` (`security_invoker=on`) + aba DFC (operacional/investimento/financiamento por mês, com o não-classificado e o selo "saldo contábil do ERP, não conciliado").

## 5. RÉGUA
- **Unidade decisória:** R$ por (empresa, mês, linha da DRE) e (empresa, mês, atividade/linha do DFC).
- **Onde o sistema expõe:** `fin_dre_snapshots` (1 writer `calcularDRE`) → DRETab/Comparativo/Cockpit/PE/regime tributário/valor; DFC → view nova.
- **Denominador:** valor 12m por empresa (cobertura = mapeado explícito / total).
- **Como a prova falsifica:** PG17 local com fixture de títulos CR/CP nas linhas credora/devedora; sabotar o sinal (volta ao `+=`) ⇒ vermelho em "devolução de compra abate CMV"; sabotar o mapa (tirar 1 linha) ⇒ postcondição aborta; vitest do helper com o mesmo caso.
- **Ordem das etapas irreversíveis:** (1) PR com motor + script + testes → (2) deploy edge `omie-financeiro` + atestação → (3) script do mapa (precondição confere v1.6 servida) → (4) recálculo caixa+competência → (5) Publish do front.
