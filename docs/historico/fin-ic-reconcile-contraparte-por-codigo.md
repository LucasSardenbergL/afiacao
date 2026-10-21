# fin-ic-reconcile: a contraparte vem do código Omie, não do CNPJ do título (2026-10-21)

## Problema

Em 2026-10-21, `fin_ic_matches` tinha **0 linhas** na prod. A edge `fin-ic-reconcile` reconhecia um título intercompany comparando `fin_contas_receber.cnpj_cpf` e `fin_contas_pagar.cnpj_cpf` com `company_cnpjs`. Só que esse campo é `''` em **100%** dos títulos: 45.386 CR e 16.248 CP, medidos com psql-ro. O sync `omie-financeiro` lê `t.cnpj_cpf` da resposta de `ListarContasReceber`/`ListarContasPagar`, e o Omie não manda esse campo. Resultado: o DRE consolidado (`fin_consolidado_intercompany`, #3292) mostrava eliminação 0, que quer dizer "nenhuma identificada", e não "não houve intercompany".

Defeitos que vieram junto:
- A edge fazia `select` de CR/CP sem `.range()`: via só as 1.000 primeiras linhas.
- Apagava e regravava os matches fora de transação.
- Casava um CP para dois CRs, sem unicidade nos dois sentidos.

## Fonte da contraparte

O título só traz o **código do cadastro** (`omie_codigo_cliente` no CR, `omie_codigo_cliente_fornecedor` no CP). No Omie, cliente e fornecedor são o mesmo cadastro.

- O banco não guarda o cadastro completo com CNPJ. `omie_customer_account_map` (`source='document'`) cobre só os cadastros ligados a usuário: tem 8 códigos do grupo, falta o da colacor_sc dentro da colacor, e cadastro só de fornecedor não entra. `fornecedor_omie_cache` tem 3 linhas e `fin_eliminacoes_intercompany` tem 0.
- **Fonte escolhida:** o Omie de cada empresa, via `ListarClientes` com `clientesFiltro.cnpj_cpf` igual ao CNPJ de cada outra empresa do grupo. São 6 consultas por rodada. Um registro só entra se o documento normalizado for **exatamente** o pedido, porque o filtro pode ser parcial. Qualquer falha do Omie aborta a rodada **antes** de tocar a tabela. Código em `contrapartes.ts`.
- **Contraprova:** se um código que o mapa de identidade conhece não volta do Omie, a rodada aborta com 502 e não grava nada. Filtro quebrado ou parcial apagaria pares reais sem ninguém ver.
- **Por que não corrigir o sync:** seria preciso enumerar o cadastro inteiro de clientes de cada Omie (dezenas de milhares de registros) dentro de um sync quente de dinheiro, só para resolver 6 códigos. O `t.cnpj_cpf` do `omie-financeiro` segue morto.

## Regra do par (`casamento.ts`)

Um par vira `auto_matched` só se todas estas condições valem:
1. CR da empresa A com contraparte B e CP da empresa B com contraparte A.
2. Os dois títulos vivos: status não nulo e diferente de CANCELADO.
3. Mesmo valor, por igualdade exata, que é o que a RPC exige.
4. Emissões a no máximo 5 dias uma da outra.
5. Se os dois títulos têm NF, a mesma NF. Zeros à esquerda não contam: `00023572` casa com `000023572`.
6. **Unicidade nos dois sentidos.** Se um lado tem mais de um candidato, o par vira `duplicidade_possivel`.

Título que já está numa linha do humano (`manual_matched`, `desconsiderado` ou já resolvida) sai do pool inteiro.

O par vai para a tabela mesmo quando a RPC não vai conseguir eliminá-lo. A elegibilidade é decisão da RPC, que nesse caso devolve o mês NULL com "eliminação pendente". Esconder o par deixaria o consolidado superestimado e sem aviso.

A escrita é **insert e depois delete**, apagando pelos ids lidos antes:
- Se o insert falha, nada é apagado.
- Se o delete falha, linhas velhas e novas convivem; o título aparece em dois pares e a RPC devolve NULL (fail-closed).
- Nenhum caminho deixa a tabela com zero matches em silêncio.

`{"simular": true}` roda tudo e não escreve nada; é o modo para conferir a prod logo depois do deploy.

## Medição (prod, mapa de identidade, 2026-10-21)

- Títulos intragrupo: 16 CR e 20 CP, sem contar os auto-cadastros.
- 14 pares:

| Mês | Direção | Pares | Valor |
|---|---|---|---|
| 2024-11 | colacor→oben | 6 | R$ 84.516,60 |
| 2025-05 | colacor_sc→oben | 3 | R$ 27.660,06 |
| 2025-06 | colacor_sc→oben | 2 | R$ 17.000,00 |
| 2026-03 | oben→colacor | 1 | R$ 342,00 |
| 2026-06 | colacor→oben e oben→colacor | 2 | R$ 2.014,50 |

- CP sem CR: 2 × R$ 90.000 colacor→oben (2026-01/02, provável mútuo), 2 × R$ 739,52 e R$ 21.597,61.

**Efeito na tela.** Simulei a RPC de prod com esses 14 pares no lugar de `fin_ic_matches` (SELECT read-only). Os 5 meses saem **NULL**:
- **2024 e 2025-05/06:** os snapshots são anteriores a `detalhamento.composicao_*`; 2025 tem 9 de 36 com composição. Sem composição, a RPC não consegue provar que o par entrou no bruto. Recalcular esses snapshots (motor DRE) pode tornar os pares elegíveis.
- **2026-03/06:** o CP da oben que vem da colacor está na categoria 2.09.05, que o motor compõe como `deducoes`, não como `cmv`. A RPC trata isso como par confirmado e não elegível.

Antes, esses meses mostravam um consolidado não nulo e inflado pelo IC. Agora mostram "—" e a pendência.

## Prova

- **Testes Deno:**
  - `casamento_test.ts`: regra do par e ordem da escrita.
  - `contrapartes_test.ts`: documento divergente, EOF, página vazia antes do fim e fault.
- **Falsificação:** 13 sabotagens, todas vermelhas, com controle verde na mesma invocação, nos locales `C` e `pt_BR.UTF-8`. A primeira rodada achou 2 testes cegos:
  - Tolerância de 1 centavo: 9180 contra 9180,01 tem |Δ| > 0,01 em double e escondia o caso; 10 contra 10,01 pega.
  - Página vazia antes do total declarado.
- Gates de baseline quitados: `escrita-critica` (1→0) e `single-shot-truncado` (2→0).
