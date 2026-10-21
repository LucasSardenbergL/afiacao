# fin-ic-reconcile: a contraparte vem do código Omie, não do CNPJ do título (2026-10-21)

## Problema

Em 2026-10-21, `fin_ic_matches` tinha **0 linhas** na prod. A edge `fin-ic-reconcile` reconhecia um título intercompany comparando `fin_contas_receber.cnpj_cpf` e `fin_contas_pagar.cnpj_cpf` com `company_cnpjs`. Só que esse campo é `''` em **100%** dos títulos: 45.386 CR e 16.248 CP, medidos com psql-ro. O sync `omie-financeiro` lê `t.cnpj_cpf` da resposta de `ListarContasReceber`/`ListarContasPagar`, e o Omie não manda esse campo. Resultado: o DRE consolidado (`fin_consolidado_intercompany`, #3292) mostrava eliminação 0, que quer dizer "nenhuma identificada", e não "não houve intercompany".

Defeitos que vieram junto:
- A edge fazia `select` de CR/CP sem `.range()`: via só as 1.000 primeiras linhas.
- Apagava e regravava os matches fora de transação; com os índices UNIQUE em `cr_id` e `cp_id`, toda rodada a partir da 2ª falharia.
- Casava um CP para dois CRs, sem unicidade nos dois sentidos.

## Fonte da contraparte

O título só traz o **código do cadastro** (`omie_codigo_cliente` no CR, `omie_codigo_cliente_fornecedor` no CP). No Omie, cliente e fornecedor são o mesmo cadastro.

- O banco não guarda o cadastro completo com CNPJ. `omie_customer_account_map` (`source='document'`) cobre só os cadastros ligados a usuário: tem 8 códigos do grupo, falta o da colacor_sc dentro da colacor, e cadastro só de fornecedor não entra. `fornecedor_omie_cache` tem 3 linhas e `fin_eliminacoes_intercompany` tem 0.
- **Fonte escolhida:** o Omie de cada empresa, via `ListarClientes` com `clientesFiltro.cnpj_cpf` igual ao CNPJ de cada outra empresa do grupo. São 6 consultas por rodada. Um registro só entra se o documento normalizado for **exatamente** o pedido, porque o filtro pode ser parcial. Qualquer falha do Omie aborta a rodada **antes** de tocar a tabela. Código em `contrapartes.ts`.
- **Completude:** o Omie declara `total_de_registros`, e os cadastros distintos lidos têm de alcançá-lo. Total de páginas ausente, página repetida ou eco de outra página abortam a rodada.
- **Contraprova:** se um código que o mapa de identidade conhece não volta do Omie, a rodada aborta com 502 e não grava nada.
- **Por que não corrigir o sync:** seria preciso enumerar o cadastro inteiro de clientes de cada Omie (dezenas de milhares de registros) dentro de um sync quente de dinheiro, só para resolver 6 códigos. O `t.cnpj_cpf` do `omie-financeiro` segue morto.

## Regra do par (`casamento.ts`)

Um par vira `auto_matched` só se todas estas condições valem:
1. CR da empresa A com contraparte B e CP da empresa B com contraparte A.
2. Os dois títulos vivos: status não nulo e diferente de CANCELADO.
3. Mesmo valor, por igualdade exata, que é o que a RPC exige.
4. Emissões a no máximo 5 dias uma da outra.
5. **NF nos dois lados e igual.** Valor, data e unicidade não provam que é a mesma operação. Zeros à esquerda de cada bloco não contam (`00023572` = `000023572`), mas os blocos não se fundem (`23572/1` ≠ `235721`). Sem NF de um lado, com valor e data batendo, o par vira `sem_contrapartida` com o CP ligado e a observação "confirme manualmente".
6. **Unicidade nos dois sentidos.** Se um lado tem mais de um candidato, o par vira `duplicidade_possivel`.

Título que já está numa linha do humano (`manual_matched`, `desconsiderado` ou já resolvida) sai do pool inteiro.

O par vai para a tabela mesmo quando a RPC não vai conseguir eliminá-lo. A elegibilidade é decisão da RPC, que nesse caso devolve o mês NULL com "eliminação pendente". Esconder o par deixaria o consolidado superestimado e sem aviso.

**A escrita é monotônica.** A edge grava `auto_matched` e **nunca o apaga**:
- Par já gravado fica, mesmo que os títulos mudem depois. Ele é a evidência que leva a RPC a NULL quando perde a elegibilidade (valor corrigido, título cancelado). Apagá-lo zeraria a eliminação em silêncio. Quem desfaz um par é o humano (`desconsiderado`).
- Os títulos de um `auto_matched` gravado saem do pool, então a rodada não o recria.
- Só os informativos (a RPC os ignora) são trocados. Primeiro apaga os antigos, depois insere, porque o UNIQUE de `cr_id`/`cp_id` não deixa o mesmo título em duas linhas. O DELETE refiltra status e `resolvido_em IS NULL`: linha que o humano mexeu entre a leitura e o delete sobrevive.
- Duas rodadas concorrentes: a 2ª colide no UNIQUE e falha inteira (500), sem par duplicado.
- Leitura de CR, CP e matches por keyset: OFFSET com escrita concorrente repete linha e fabricaria `duplicidade_possivel`.
- Corpo que não é JSON é recusado com 400, em vez de virar disparo.

`{"simular": true}` roda tudo e não escreve nada; é o modo para conferir a prod logo depois do deploy.

## Medição (prod, mapa de identidade, 2026-10-21)

- Títulos intragrupo: 16 CR e 20 CP, sem contar os auto-cadastros.
- 14 pares por valor, data e unicidade. Com a regra da NF, **11 continuam automáticos** (2024-11 e 2025-05/06). Os 3 de 2026 (R$ 342,00, R$ 700,00 e R$ 1.314,50) não têm NF em nenhum dos lados e viram candidatos a confirmar à mão:

| Mês | Direção | Pares | Valor |
|---|---|---|---|
| 2024-11 | colacor→oben | 6 | R$ 84.516,60 |
| 2025-05 | colacor_sc→oben | 3 | R$ 27.660,06 |
| 2025-06 | colacor_sc→oben | 2 | R$ 17.000,00 |
| 2026-03 | oben→colacor | 1 | R$ 342,00 |
| 2026-06 | colacor→oben e oben→colacor | 2 | R$ 2.014,50 |

- CP sem CR: 2 × R$ 90.000 colacor→oben (2026-01/02, provável mútuo), 2 × R$ 739,52 e R$ 21.597,61.

**Efeito na tela.** Simulei a RPC de prod com os pares no lugar de `fin_ic_matches` (SELECT read-only):
- **2024-11 e 2025-05/06 (11 pares automáticos): NULL.** Os snapshots são anteriores a `detalhamento.composicao_*` (2025 tem 9 de 36 com composição). Sem composição, a RPC não consegue provar que o par entrou no bruto. Recalcular esses snapshots (motor DRE) pode tornar os pares elegíveis.
- **2026-03/06 (os 3 sem NF): sem par automático,** então a RPC não elimina nada e o consolidado desses meses segue com R$ 2.356,50 de IC. Se o humano confirmar (`manual_matched`), o mês vai a NULL: o CP da oben que vem da colacor está na categoria 2.09.05, que o motor compõe como `deducoes`, não como `cmv`.

Antes, 2024-11 e 2025-05/06 mostravam um consolidado não nulo e inflado pelo IC. Agora mostram "—" e a pendência.

## Prova

- **Testes Deno:**
  - `casamento_test.ts`: regra do par e ordem da escrita.
  - `contrapartes_test.ts`: documento divergente, EOF, página vazia antes do fim e fault.
- **Codex adversarial** (gpt-6-astra, reasoning max, 366 s): 5 P1 e 2 P2, nenhum P0. Todos foram tratados: NF obrigatória e por blocos, escrita monotônica, refiltro no DELETE, keyset, completude do Omie e JSON inválido. O UNIQUE de `cr_id`/`cp_id`, que o Codex não viu, foi achado na revisão das correções.
- **Falsificação:** 22 sabotagens, todas vermelhas, com controle verde na mesma invocação, nos locales `C` e `pt_BR.UTF-8`. As rodadas acharam 3 testes cegos:
  - Tolerância de 1 centavo: 9180 contra 9180,01 tem |Δ| > 0,01 em double e escondia o caso; 10 contra 10,01 pega.
  - Página vazia antes do total declarado.
  - Eco de outra página: a contagem truncada pegava o caso antes.
- Gates de baseline quitados: `escrita-critica` (1→0) e `single-shot-truncado` (2→0).

## Deploy e 1ª escrita (2026-10-21)

- **Deploy:** feito pela sessão via MCP do Lovable, com a colagem do `pendencias:pacote` (`ce50ed6797a8`, `origin/main@4218caf1d`). Os 17 hashes bateram. O commit do bot só regenerou `types.ts`.
- **Sonda:** `db/sonda-disparo-fin-ic-reconcile-v1.2.sql`, aplicada pelo `db:aplicar`. Request 125764 → `v1.2-contraparte-por-codigo-omie`, **DEPLOY CONFIRMADO**. `pendencias:deploy` voltou com exit 0.
- **Simular:** `db/simular-fin-ic-reconcile-v1.2.sql`, request 125770.
  - As 6 consultas ao Omie responderam e nenhuma divergiu do mapa.
  - A colacor **não tem** cadastro da colacor_sc. A consulta deu EOF legítimo, então não havia "par a mais" escondido.
  - Resultado: 11 `auto_matched` e 10 `sem_contrapartida`, iguais à medição.
- **1ª escrita:** `db/escrita-fin-ic-reconcile-v1.2.sql`, request 125772. Inseriu 21 linhas: 11 `auto_matched`, somando R$ 129.176,66, e 10 informativas.
- **RPC na prod** (corpo de `pg_get_functiondef` em SELECT, porque o `claude_ro` não tem EXECUTE):
  - 2024-11, 2025-05 e 2025-06: receita e CMV consolidados **NULL**.
  - 2026-03 e 2026-06: eliminação 0.
  - 2025-09 (controle sem IC): 0.

**Pendências de produto** (decisão humana, não da edge), investigadas em 2026-10-21:
- **Os 3 candidatos sem NF** são lançamentos manuais nos dois lados (`id_origem` MANR/MANP), no mesmo dia e com o mesmo valor, todos liquidados. A CR está em 1.01.03 (Revenda de Mercadoria). Têm cara de intercompany real. A confirmação é humana, em `/financeiro/intercompany/fila` (botão Manual):
  - **R$ 342,00 (2026-03) e R$ 700,00 (2026-06), oben→colacor.** A colacor lançou o pagamento em **2.09.05 "Devolução de Clientes"**, que o motor manda para `deducoes`. Confirmado assim, o mês vai a NULL. O conserto é recategorizar no Omie da colacor para 2.01.01 (Compras de Mercadorias para Revenda) e recalcular o DRE.
  - **R$ 1.314,50 (2026-06), colacor→oben.** A oben lançou o pagamento em 2.01.01, que vai para `cmv`. Este par é elegível, mas 2026-06 também tem o de R$ 700,00.
- **Recalcular os snapshots de 2024-11 e 2025-05/06** (`omie-financeiro`, `calcular_dre`, regime competência) para que tenham `detalhamento.composicao_*`.
  - Os 9 snapshots são de 2026-03-29 e 2026-05-30, e esses meses não têm linha em `fin_fechamentos`.
  - O recálculo reescreve o DRE histórico com o motor atual, e os totais podem mudar. Na sessão, o classificador de permissão bloqueou o disparo, então a decisão segue com o founder: botão "Recalcular DRE" da tela, ou uma sessão autorizada.
- **CR colacor_sc→colacor de R$ 3.605,67 (2025-01-02)** fica em **1.04.04 "Empréstimos/Financiamentos"**: é mútuo, não venda. Fica fora de receita e CMV, então não pesa na eliminação. A colacor não tem cadastro da colacor_sc e nenhum CP de mesmo valor; a saída, se houve, não passou por contas a pagar.
