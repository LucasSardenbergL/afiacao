# F4 — Decomposição saneada da despesa no DRE (design)

> **Status:** desenho aprovado pelo founder em 2026-08-13, aguardando plano de implementação.
> **Money-path:** SIM — muda número que sustenta decisão de alocação de capital.
> **Antecedente:** handoff da fatia F4 ("decompor a despesa"). O diagnóstico ampliou o escopo: a base classificada está contaminada, então decompor sem sanear espalharia o erro em três colunas.

## 1. Problema

O DRE joga toda a despesa em `despesas_operacionais`. As colunas `despesas_comerciais`,
`despesas_administrativas` e `despesas_financeiras` existem no schema e valem **zero em 96 de 96
meses-empresa** (R$ 9,67M acumulados, 2023-01 a 2026-05).

Sabe-se QUE a estrutura come o lucro, não QUAL parte.

## 2. Causa raiz (medida, não inferida)

O código de decomposição **existe** desde o #184 (2026-05-23) e a colacor foi recalculada em
2026-05-30 — sete dias depois — e ainda assim gravou zero. Duas causas independentes:

### 2.1 O classificador está cego

`fin_contas_pagar.categoria_descricao` é **string vazia em 100% dos registros** (15.982 títulos,
3 empresas, zero preenchidos). O mesmo vale para as 4.785 linhas de `fin_dre_competencia_base`.

`classificarLinhaDRE` decide por `descrição + código`. Sem descrição ela enxerga só `"2.03.01"`,
nenhuma keyword casa, e todo título cai no `return { linha: 'despesas_operacionais' }` final.

O catálogo com as descrições **existe e está sincronizado**: `fin_categorias`, 508 linhas
(colacor 208 · colacor_sc 145 · oben 155). Nada faz o join.

### 2.2 O mapeamento é de um plano de contas fictício

`fin_categoria_dre_mapping` tem 36 linhas, todas `company='_default'`, num plano
`1.01.x / 3.01.x / 5.01.x`. O plano real do Omie é `2.01.x`–`2.12.x`.

Só 4 códigos casam — `2.01.01`–`2.01.04`, por **coincidência numérica** — e viram `cmv`.
Todo o resto cai no fallback.

**Reconciliação da regra (prova de que o diagnóstico está certo):** reproduzindo em SQL
"tudo que não é 2.01.01–04 vira despesas_operacionais", a colacor dá **6.056.402** contra
**6.056.720** gravado em prod — 0,005% de diferença.

### 2.3 O mesmo código significa coisas diferentes por empresa

Isso invalida qualquer mapeamento `_default` por código:

| código | colacor | oben / colacor_sc |
|---|---|---|
| `2.01.04` | Fretes e Carretos | Compra de Serviços |
| `2.03.02` | Pró Labore | Adiantamento de Salário (csc) |
| `1.04.01` | Aplicações Financeiras | Adiantamento de Clientes |
| `2.06.95` | ICMS Diferença de alíquota | IOF |

**O mapeamento tem de ser por empresa, sem exceção.**

## 3. Impacto: o número já está errado hoje

O DRE é montado sobre `fin_contas_pagar`/`fin_contas_receber` — ou seja, sobre **saída e entrada de
caixa**, não sobre resultado. Por isso amortização de empréstimo e compra de máquina entram como se
fossem despesa, e empréstimo tomado entra como se fosse receita.

### 3.1 O que há dentro de "despesa operacional"

| natureza | colacor | oben | colacor_sc |
|---|---|---|---|
| Amortização de empréstimo | 26,9% | 67,3% | 3,3% |
| Impostos (têm linha própria) | 20,7% | 23,4% | 4,2% |
| CAPEX (máquinas/imobilizado) | 13,7% | 0,0% | — |
| Distribuição de lucros | 2,9% | — | — |
| Devoluções (deduzem receita) | 1,2% | 0,6% | 0,0% |
| **= não é despesa operacional** | **65,4%** | **91,3%** | **7,5%** |

### 3.2 O que há dentro de "receita bruta"

| empresa | receita registrada | empréstimo/capital | devolução | receita real | % real |
|---|---|---|---|---|---|
| colacor | 8.596.276 | 1.079.202 | 164.974 | 7.352.101 | 85,5% |
| colacor_sc | 665.441 | **376.262** | 0 | **289.179** | **43,5%** |
| oben | 7.271.541 | 140.712 | 19.994 | 7.110.835 | 97,8% |

**56,5% da "receita" da colacor_sc é empréstimo tomado.**

### 3.3 Margem líquida — hoje vs. saneada

| empresa | margem hoje | receita real | resultado saneado | margem saneada |
|---|---|---|---|---|
| colacor | −10,8% | 7.352.101 | +534.558 | **+7,3%** |
| oben | +1,5% | 7.110.835 | +2.112.389 | **+29,7%** |
| colacor_sc | −11,2% | 289.179 | −428.599 | **−148,2%** |

**O DRE atual inventa um problema na colacor e esconde o da colacor_sc.** A premissa de que "duas
das três BUs operam no vermelho e a despesa é o motivo" é artefato de classificação.

⚠️ **Caveats obrigatórios** (regra-mãe de `docs/agent/financeiro.md`: direcional ≠ verdade contábil):

1. **A margem saneada é teto, não número final.** Se a parcela de `2.05.03` embute juros, essa parte
   é despesa financeira legítima. O dado atual não separa principal de juros.
2. **A colacor_sc não é interpretável isolada.** Ela carrega a folha da OBEN (`financeiro.md`:
   folha compartilhada intercompany, códigos `2.03.*`). Os −148,2% e os +29,7% da OBEN são duas
   faces do mesmo rateio ausente — é o que a F3 resolve. Não tirar conclusão de BU sem o rateio.
3. Nada aqui substitui balanço, conciliação fiscal ou parecer do contador.

## 4. Decisões tomadas (founder, 2026-08-13)

| # | Decisão | Escolha |
|---|---|---|
| 1 | Escopo | **Sanear + decompor** (decompor a base contaminada foi descartado) |
| 2 | Curadoria do mapeamento | **Claude propõe, founder revisa** antes de virar migration |
| 3 | Tratamento do não-despesa | **Seção não-operacional explícita** (não excluir silenciosamente) |
| 4 | Snapshots históricos | **Recomputar os 96 meses** |

## 5. Design

### 5.1 Devolver a visão ao classificador

`classificarLinhaDRE` passa a receber a descrição resolvida via `fin_categorias` por
`(company, omie_codigo)`, em vez de confiar em `categoria_descricao` (sempre vazia).

Escolha: resolver no consumidor (join), **não** corrigir o sync agora. O join não depende de
re-sync, é reversível e não toca no caminho de ingestão. O fix do sync fica como follow-up.

### 5.2 Mapeamento real, por empresa

- Popular `fin_categoria_dre_mapping` com os códigos reais por `company`.
- **Deletar as 36 linhas `_default`** — são elas que produzem o falso-CMV de R$ 9,07M por
  coincidência numérica. Enquanto existirem, qualquer código não mapeado por empresa volta a cair
  nelas.
- A tabela já tem `company NOT NULL` e `notas` — a estrutura correta sempre existiu, nunca foi usada.

Curadoria concentrada: **18 códigos cobrem 90% do valor na colacor, 5 na oben, 14 na colacor_sc.**

### 5.3 Nova linha `nao_operacional` + coluna no snapshot

- `DreLinha` ganha `'nao_operacional'`.
- `montarDRE` **não** soma esses valores em nenhuma linha de resultado.
- Migration: `ALTER TABLE fin_dre_snapshots ADD COLUMN movimentos_nao_operacionais numeric`
  **e** `ADD COLUMN valor_nao_classificado numeric` (ver §5.4).
- ⚠️ **Ambas são colunas dedicadas, nunca dentro do `detalhamento` jsonb.** Regra do CLAUDE.md:
  sinal money-path em jsonb multi-writer morre em upsert destrutivo. Coluna dedicada + 1 writer.
- A UI ganha um bloco abaixo do resultado operacional, para o valor continuar visível e
  reconciliável com o extrato.
- Espelhado em `src/lib/financeiro/dre-helpers.ts` (Deno não importa de `src/`; o helper puro é o
  que tem teste vitest).

### 5.4 Fail-closed honesto (money-path §2)

- Categoria sem mapeamento **não cai mais em `despesas_operacionais`**. Acumula em
  `valor_nao_classificado` (+ `qtd_categorias_sem_mapeamento`, que já existe).
- Se a cobertura ficar **< 95% do valor de despesa**, as três colunas decompostas gravam **NULL**
  + motivo — porque abaixo disso a *repartição* não significa nada.
- **Distinção que o desenho preserva:** o total de despesa é conhecido e nunca vira null; o que é
  incerto é a repartição. Só a repartição degrada.
- Títulos **sem código de categoria** (R$ 420k na colacor, 383 títulos) entram direto no
  não-classificado — sem código não há o que mapear.

**Consumidores que fabricam zero e precisam ser corrigidos junto** (senão o NULL vira 0 rio abaixo,
que é exatamente o defeito que o fail-closed existe para eliminar):

- `src/hooks/usePontoEquilibrio.ts:99` — `Number(row.despesas_operacionais ?? 0)`
- `src/lib/financeiro/orcamento-forecast-helpers.ts:561` — `i.despesas_operacionais ?? 0`

**Não há risco de dupla contagem:** a fórmula já é
`resultado_operacional = lucro_bruto − (operacionais + administrativas + comerciais) + rec_fin − desp_fin`.
As quatro colunas já somam em paralelo — `despesas_operacionais` sempre foi o balde residual, então
mover valor de um balde para outro é neutro no resultado. Só a exclusão do não-operacional muda o número.

### 5.5 Recompute dos 96 meses

Recomputar exige evidência positiva de conclusão (não "enfileirado"), e a data do dado passa a
aparecer na tela.

**Descoberta adjacente registrada:** não existe **nenhum** cron de DRE entre os 88 jobs
(`cron.job`). `calculated_at` está congelado em 2026-03-29 / 2026-05-30 — o recompute sempre foi
100% manual. Essa é a causa da defasagem levantada no §4 do handoff: não é fechamento contábil.

### 5.6 Precedente existente que o DRE ignora

`fin_dre_custo_tipo` (23 linhas, curada por humano, com `updated_by`/`observacao`) **já** classifica
por empresa e **já** marca `2.05.03` como `nao_operacional`. Só cobre a oben, e quem a consome é o
ponto de equilíbrio — o DRE nunca leu essa tabela. O mapeamento novo deve ficar consistente com ela
(mesma conclusão para os códigos que as duas cobrem).

## 6. Mapeamento proposto — os que valem 90% do valor

Proposta para revisão do founder. **Ambíguos marcados com ⚠️ exigem decisão** e não serão
mapeados por conta própria.

### colacor

| código | descrição | linha proposta |
|---|---|---|
| 2.01.01 | Compras de Mercadorias para Revenda | `cmv` |
| 2.05.03 | Pagamento de Empréstimos | `nao_operacional` ⚠️ (separar juros?) |
| 2.01.99 | Compra de Ativo Imobilizado | `nao_operacional` (CAPEX) |
| 2.01.03 | Compras de Matéria Prima | `cmv` |
| 2.06.01 | ICMS | `ded_icms` |
| 2.04.07 | Aluguel de Veículo | `despesas_administrativas` |
| 2.06.04 | COFINS | `ded_cofins` |
| 2.11.94 | Combustível | ⚠️ comercial (distribuição) ou administrativa? |
| 2.03.76 | Distribuição de Lucros | `nao_operacional` |
| 2.03.01 / 2.03.02 / 2.03.06 | Salários / Pró Labore / INSS | `despesas_administrativas` |
| 2.04.01 | Aluguel e Condomínio | `despesas_administrativas` |
| 2.01.96 | Compra de Material Uso e Consumo | `despesas_administrativas` (não é CMV) |
| 2.06.05 / 2.06.91 | IRPJ / CSLL | `irpj` / `csll` |
| 2.01.02 | Frete | ⚠️ frete de compra (`cmv`) ou de venda (`despesas_comerciais`)? |
| 2.12.97 / 2.12.98 | Contabilidade / Consultoria | `despesas_administrativas` |
| 2.03.78 | Adiantamento de Salário | ⚠️ despesa ou conta patrimonial? |
| 2.09.01 | Cancelamento de Vendas | `deducoes` |
| (sem código) | R$ 420k, 383 títulos | — (não mapeável: vai para `valor_nao_classificado`) |

### oben (5 códigos = 92%)

| código | descrição | linha proposta |
|---|---|---|
| 2.01.01 | Compras de Mercadorias para Revenda | `cmv` |
| 2.05.03 | Pagamento de Empréstimos | `nao_operacional` ⚠️ |
| 2.06.01 / 2.06.04 | ICMS / COFINS | `ded_icms` / `ded_cofins` |
| 2.01.02 | Frete | ⚠️ mesmo caso |

### colacor_sc (Simples)

| código | descrição | linha proposta |
|---|---|---|
| 2.03.* (folha) | Salários, VA, FGTS, INSS, férias, 13º | `despesas_administrativas` |
| 2.03.02 | Adiantamento de Salário (≠ colacor!) | ⚠️ |
| 2.01.01 | Compras de Mercadorias para Revenda | `cmv` |
| 2.05.03 | Pagamento de Empréstimos | `nao_operacional` |
| 2.06.99 | Simples Nacional (DAS) | `das` |
| 2.06.01 | ICMS | ⚠️ por que há ICMS numa empresa do Simples? (ST/DIFAL?) |

### Receitas (todas as empresas)

| código | descrição | linha proposta |
|---|---|---|
| 1.01.02 / 1.01.03 | Prestação de Serviços / Revenda | `receita_bruta` |
| 1.04.03 / 1.04.04 | Empréstimos / Aumento de Capital | `nao_operacional` |
| 1.04.06 | Venda de Bens | `outras_receitas` |
| 1.03.01 | Devoluções de Compra | ⚠️ redutor de `cmv`? |

## 7. Fora de escopo (registrado, não esquecido)

- **Cron de recompute do DRE** — causa da defasagem conhecida (não existe job), mas criar o cron é
  outra fatia. Exige `timeout_milliseconds` explícito (`docs/agent/sync.md`).
- **Fix do sync que deixa `categoria_descricao` vazia** — a origem do problema 2.1. O join resolve o
  consumo; a ingestão continua torta.
- **Separar juros de principal na amortização** — exige dado que não temos hoje.
- **Rateio da folha compartilhada** (F3) — sem ele, colacor_sc e oben não são interpretáveis isoladas.

## 8. Provas exigidas antes de entregar

- Helper puro em vitest: classificação por empresa · fail-closed (< 95% → NULL, não 0) · ausência de
  dupla contagem · **reconciliação dos R$ 6.056.402 da colacor**.
- Teste de edge Deno **sem import remoto** (`test:edges` roda com `--no-remote`).
- `prove-sql-money-path` na migration (PG17 local, com falsificação nos locales `C` e `pt_BR.UTF-8`).
- Recompute com evidência positiva de conclusão e `exit 0` capturado.
- 2ª opinião via `/codex` sobre o desenho do fail-closed e do limiar de 95% (regra money-path).

## 9. Riscos

| risco | mitigação |
|---|---|
| Deletar `_default` quebra empresa não mapeada | O mapeamento por empresa entra na mesma migration; o fail-closed cobre o resto sem fabricar |
| NULL vira 0 em consumidor esquecido | Os dois consumidores conhecidos estão nomeados em §5.4; varredura por `?? 0` antes de entregar |
| Margem histórica muda na tela | Decisão 4 do founder foi explícita; a mudança é a correção |
| Mapeamento errado dá confiança para cortar errado | Ambíguos não são mapeados por conta própria (§6); resíduo fica visível |
