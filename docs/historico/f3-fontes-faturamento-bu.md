# F3 — a "verdade fiscal" das 3 BUs: a fatia que a medição reescreveu

> 2026-08-13. Sessão F3. A entrega pedida era "fazer `venda_items_history` cobrir as três empresas". A medição mostrou que a pergunta estava certa e o alvo errado. Regra viva destilada em [`docs/agent/financeiro.md`](../agent/financeiro.md) §Faturamento por BU.

## O que se pediu

`venda_items_history` tinha **6.009 linhas, `empresa='OBEN'` apenas**. Sem cobrir as três BUs, era impossível comparar performance entre elas — e dois dos três indicadores de F2 ficariam restritos a uma empresa. O handoff levantou três hipóteses: (a) sync configurado só para a app-key da Oben, (b) as outras emitem por outro ERP, (c) a Colacor SC é serviço e legitimamente não tem "itens de venda".

## O que a medição achou

**A causa (a), confirmada — e mais rasa que o esperado.** A edge `omie-sync-vendas-items` **não tem cron próprio**: ela só roda como 5º step do orquestrador `omie-cron-diario`, e existe **um único** cron chamando esse orquestrador, com `{empresa:'OBEN'}` fixo. A edge **já suporta COLACOR** (`OMIE_COLACOR_APP_KEY` existe e é usada por 18 edges). Faltava o cron, não a credencial.

A cadeia foi provada por **correlação temporal**, não por leitura de código: inserções às `22:16:10` e `20:16:13` casam com o log `sync_sku_items` iniciado às `22:16:04` e `20:16:06`. (Antes disso, duas pistas falsas foram descartadas: o único cron que casava por nome apontava para outra edge, `omie-sync-sku-items`; e o webhook de NF-e está sem receber evento há 90 dias.)

**A hipótese (c), confirmada com evidência.** `colacor_sc` é Simples/serviços: **0 produtos** no catálogo, **0 pedidos** de venda, 49 posições de estoque residuais — **mas fatura R$ 751,8k**, via NFS-e. Ela não está ausente do histórico de itens por falha; está ausente por natureza.

**O achado que reescreveu a fatia.** O módulo financeiro **já cobre as três BUs**, hoje:

| fonte | colacor | oben | colacor_sc |
|---|---|---|---|
| `fin_dre_competencia_base` (`origem='CR'`) | R$ 17,79M | R$ 9,62M | R$ 751,8k |
| `fin_contas_receber` | R$ 18,32M | R$ 9,85M | R$ 774,9k |

E `venda_items_history` não é a verdade fiscal do grupo: é o histórico de saída por SKU **do módulo Reposição** — e *todo* esse módulo é OBEN-only por desenho (`fornecedor_habilitado_reposicao`, `reposicao_alerta_pedido_minimo`, `reposicao_cold_start_log`, `eventos_outlier`: só `OBEN`). Seus dois únicos consumidores são telas de reposição.

Ou seja: **para comparar faturamento entre BUs não era preciso sync nenhum.** A fonte comparável já existia e cobria as três.

## As armadilhas que a medição desenterrou

- **`fin_contas_receber` ≠ faturamento.** É título/parcela: 1 NF gera N parcelas, mais cancelamento/renegociação/adiantamento. Diverge do DRE em **R$ 527k só na colacor**. Somá-la como receita é erro silencioso — o número fecha, só não é o número.
- **3 grafias para as MESMAS contas Omie:** `{oben,colacor,colacor_sc}` (financeiro) · `{vendas,colacor_vendas,servicos}` (estoque/CMC) · `OBEN` maiúsculo (reposição). Filtro com a grafia errada volta **zero silencioso**, não erro — dashboard parcialmente correto é mais perigoso que erro explícito.
- **Devolução soma como positivo** em `venda_items_history`: 5 linhas CFOP 6202, R$ 10.043 de R$ 3,23M (0,31%).
- **2,13% das linhas são consolidação** (128 de 6.009): a edge soma qtd/valor quando o mesmo SKU se repete na NF — valor e quantidade ficam **certos**, mas o `cfop` gravado é o da 1ª linha. A chave natural `(nfe_chave_acesso, sku_codigo_omie)` não distingue linha de documento (falta `nfProdInt.nCodItem`).

## A 2ª opinião (Codex, gpt-5.6-sol)

Consultado por ser money-path + decisão de arquitetura. Confirmou o financeiro como fonte do comparativo e trouxe **dois pontos que a análise inicial não tinha**: (1) `fin_contas_receber` não deve ser somada como faturamento — o que a medição então confirmou nos R$ 527k de divergência; (2) o risco na chave natural dos itens — que a medição **parcialmente refutou** (a edge já consolida somando, então valor/quantidade não se perdem; sobra a perda de discriminação por linha, medida em 2,13%).

Também recomendou o contrato explícito por métrica (`receita_competencia` · `faturamento_emitido` · `contas_receber` · `recebimento`), uma fonte única por KPI, e `bu_id` canônico com tabela de aliases para matar as 3 grafias.

## Decisão do founder

1. **Financeiro primeiro:** os indicadores que só precisam de valor por BU leem `fin_dre_competencia_base` — cobrem as 3 empresas **hoje**, sem sync, e o rótulo "só Oben" cai sem trabalho de ingestão.
2. **Colacor depois:** ligar COLACOR em `venda_items_history` para dar granularidade de item à maior BU (19.627 pedidos vs 11.225 da Oben) — aditivo e seguro (consumo filtra `empresa` dinamicamente, unique é por chave de NF-e, nenhum número da Oben muda).
3. **Colacor SC fica fora do schema de itens**, rotulada com evidência. Precisão > recall: uma BU rotulada vale mais que três números incomparáveis.

## Se/quando ligar a COLACOR — a armadilha do orquestrador

⚠️ **Não basta clonar o cron da Oben.** O cron existente (`afiacao_omie_oben_sync_incremental_2h`) chama o **orquestrador** `omie-cron-diario`, que roda **5 steps** (pedidos de compra, NF-es recebidas, CT-es, sku-items, vendas-items) **e ainda dispara RPCs de parâmetros** — e para empresa ≠ OBEN ele cai em `atualizar_parametros_numericos_skus`, escrita em massa no domínio Reposição. Um cron gêmeo com `{empresa:'COLACOR'}` ligaria **a Reposição inteira da Colacor** de lambuja, muito além de "cobrir o histórico de vendas".

O caminho cirúrgico é um cron **dedicado** chamando apenas `omie-sync-vendas-items` com `{empresa:'COLACOR'}` — com `timeout_milliseconds` explícito (default 5s do `pg_net` mata a função em silêncio). Reversível, e não toca reposição.

**E não ligue por sequência automática.** Pela regra do #1726 (fase N+1 exige sinal da fase N) e pelo parecer do Codex, estender os itens para COLACOR só se justifica com **caso real de análise por produto** da Colacor — não porque a fatia estava no plano. O total comparável entre BUs já vem do DRE, sem isto.

## A lição

O handoff mandava "comece medindo, não codando" e antecipou que a hipótese de modelagem era séria. Foi mais longe: a medição não só escolheu entre as hipóteses — mostrou que **a entrega pedida não era o caminho mais curto para o resultado pedido**. Ligar as três empresas no histórico de itens teria funcionado, custado sync + deploy + backfill, e ainda assim deixado a Colacor SC de fora, porque ela não emite NF-e de produto. A fonte que já respondia a pergunta estava a uma query de distância.
