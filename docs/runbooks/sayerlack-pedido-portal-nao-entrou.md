# Runbook — pedido do portal Sayerlack não entrou no Omie

> Citado pela mensagem do CP006 (edge `sayerlack-importar-pedido-portal`), pelo vigia `sayerlack_varredura_portal`
> do `data_health` e pelo card **Pedidos do portal Sayerlack** em Gerir pedidos. Histórico do domínio:
> `docs/historico/importar-pedido-portal-sayerlack.md`.

## Como o pedido entra (para saber onde quebrou)

1. Alguém digita o pedido direto no portal Sayerlack.
2. A **varredura** (`sayerlack-varrer-pedidos-portal`, cron `30 1,15,20 * * *` UTC = 22:30 · 12:30 · 17:30 em SP;
   portal fechado de sábado 12h a segunda 6h) lê a lista dos últimos 7 dias e chama a importadora para cada pedido
   novo. O botão **Importar do portal** chama a MESMA importadora para os números digitados.
3. A **importadora** lê o pedido (só leitura no portal), grava no app pela RPC `sayerlack_importar_pedido_portal`
   (de-para inverso, IPI por NCM, condição de pagamento) e chama `disparar-pedidos-aprovados`, que cria o pedido de
   compra no Omie.

Regra de ouro: **não lance o pedido à mão no Omie** enquanto o app disser "não sei se entrou" ou "está no app sem
pedido de compra". Importar de novo é seguro: não duplica, e se o pedido de compra já existe o app mostra qual é.

## Primeiro: onde está o pedido?

```sql
-- No app (psql-ro):
SELECT id, status, status_envio_portal, omie_pedido_compra_numero, portal_situacao_codigo, portal_situacao_texto,
       importado_portal_em, portal_erro
FROM public.pedido_compra_sugerido WHERE portal_protocolo = '<nº>';
-- Pendência da varredura:
SELECT * FROM public.sayerlack_varredura_falha WHERE protocolo = '<nº>';
-- Tentativas (botão = origem manual, varredura = automatica):
SELECT iniciado_em, origem, status, detalhes->>'etapa', detalhes->>'sqlstate', left(detalhes->>'mensagem', 200)
FROM public.acoes_execucoes WHERE acao = 'reposicao.importar_portal_sayerlack' AND detalhes->>'protocolo' = '<nº>'
ORDER BY iniciado_em DESC LIMIT 10;
-- Pedido de compra lançado à mão com o nº do portal no contrato:
SELECT numero_pedido, numero_contrato_fornecedor FROM public.purchase_orders_tracking
WHERE empresa::text = 'OBEN' AND numero_contrato_fornecedor ~ ('(^|\D)<nº>(\D|$)');
```

## Recusas da importação (código na tela e no ledger)

### CP006 — NCM sem alíquota de IPI

O custo do pedido é provado pelo total do portal **com IPI**; sem a alíquota do NCM não há prova, e nada é gravado.
A mensagem traz o(s) NCM(s). O card mostra quantos SKUs Sayerlack ativos estão nessa situação.

1. Ache uma NF de entrada desse produto (`nfe_recebimento_itens`): alíquota = (valor_total − vProd) ÷ vProd,
   linha a linha. O espelho de PO do Omie **não serve** (PO à mão traz IPI 0; PO do app traz o IPI que a própria
   tabela deu — circular).
2. Sem NF que prove: **não invente** (ausente ≠ zero). Leve o NCM ao founder.
3. Com a alíquota provada: migration idempotente em `ipi_aliquota_ncm` (`ON CONFLICT DO NOTHING`, postcondição),
   aplicada pelo envelope (`bun run db:aplicar`). Modelo: `20261107120000_ipi_aliquota_ncm_seed_nf_onda1.sql`.
4. Importe o número de novo.

Quantos SKUs faltam (o mesmo número do card):

```sql
SELECT count(*), array_agg(DISTINCT regexp_replace(op.ncm, '[^0-9]', '', 'g'))
FROM sku_fornecedor_externo s
JOIN omie_products op ON op.omie_codigo_produto::text = s.sku_omie AND op.account = lower(s.empresa)
LEFT JOIN ipi_aliquota_ncm a ON a.ncm = regexp_replace(op.ncm, '[^0-9]', '', 'g')
WHERE s.ativo AND s.empresa = 'OBEN' AND s.fornecedor_nome ILIKE '%sayer%' AND a.ncm IS NULL;
```

### IP002 — SKU do portal sem de-para no app

O portal usou um código que não tem `sku_fornecedor_externo` ativo (OBEN, Sayerlack), ou tem mais de um.
Abra **Mapeamento de SKU** (botão na própria tela), cadastre exatamente 1 de-para para o código citado e importe
de novo. IP003 (quantidade não vira inteira no Omie) resolve no mesmo lugar: o fator de conversão está errado.

### IP006 — já existe pedido de compra no Omie com esse contrato

Alguém lançou o pedido de compra à mão no Omie com o nº do portal no campo contrato. **Esse é o pedido de compra
que vale** — não lance outro. O app não cria um segundo. Se o pedido está no app sem pedido de compra, ele fica
assim até a vinculação manual (item 7.1 do plano); até lá, anote no pedido qual é o PO do Omie.

### IP007 — condição de pagamento do portal sem correspondente único no Omie

A condição lida no portal (`#condicoes_pagamento`) não tem tradução, ou tem mais de uma (ex.: "Para 30 dias" e
"Para 30 dias (C)" no catálogo OBEN). A mensagem traz a lista de opções lida.

1. Confira a condição no portal.
2. Se o de-para está faltando: linha em `sayerlack_condicao_portal_de_para` (texto normalizado → código OBEN), por
   migration. Caso ambíguo ("(C)" ou não) **vai ao founder** com a lista — não escolha.
3. Importe de novo.

### Condição de pagamento ilegível (`motivo=condicao_ilegivel`)

A importadora leu o pedido (situação, itens, total), mas não a condição de pagamento da tela de detalhe
(`/order-creation-form-edit/<nº>/route/order-viewer`). **Nada é gravado**: a condição nunca é presumida (à vista
fabricado foi o bug que isto corrigiu). A resposta traz `causa_condicao` e o retrato da tela (`condicao_diag`, também
no `trace` da evidência, passo `condicao_diag`):

| `causa_condicao` | O que a tela tinha | Repetir resolve? |
|---|---|---|
| `fora_do_detalhe` | o portal abriu outra página (login, home) | sim, tente de novo. **Exceto** se o passo `detalhe_aberto` do trace tiver `status: 404`: aí a edge não chegou à tela (C16, até a v1.12, que fazia `goto` direto). Desde a v1.13 ela abre a tela clicando no nº na consulta. Se aparecer `via_clique: false`, o link do nº não estava na linha da consulta, e repetir não adianta: ver `docs/historico/sayerlack-condicao-ilegivel-c16.md` |
| `campo_ausente` | detalhe aberto, sem `#condicoes_pagamento` nesta leitura | uma vez; repetiu → o leitor precisa de ajuste |
| `campo_sem_opcoes` | o select veio sem nenhuma opção nesta leitura | uma vez; repetiu → o leitor precisa de ajuste |
| `sem_selecao` | select com opções, "Selecione" escolhido | confira o pedido no portal |
| `fora_do_prazo` | a condição apareceu depois dos 15 s | sim — tente de novo |
| `sem_retrato` | leitura anterior ao C16 (sem retrato) ou o retrato falhou | sim, uma vez |

```sql
-- O que a tela de detalhe tinha (psql-ro):
SELECT id, gravado_em, condicao, jsonb_array_length(condicoes_opcoes) n_opcoes,
       jsonb_path_query_first(trace, '$[*] ? (@.step == "detalhe_aberto")') detalhe,
       jsonb_path_query_first(trace, '$[*] ? (@.step == "condicao_diag")') retrato
FROM public.sayerlack_portal_evidencia WHERE protocolo = '<nº>' ORDER BY id DESC LIMIT 3;
```

Precisa do pedido de compra antes do conserto? Lance-o à mão no Omie **com a condição que aparece no portal** e o nº do
portal no campo contrato, nesta ordem:

1. Confira com as queries de "onde está o pedido" que não há PO nem importação em andamento.
2. Lance o PO à mão.
3. **Não importe de novo** (nem deploy de leitor consertado) até o PO aparecer em `purchase_orders_tracking`. O
   bloqueio IP006 da RPC lê esse espelho, que tem a defasagem do sync: PO digitado minutos antes escapa e a importação
   duplicaria. A varredura importa sozinha 3×/dia; enquanto o leitor recusar, ela não grava. Histórico: `docs/historico/sayerlack-condicao-ilegivel-c16.md`.

### IP008 — pedido do app em envio/conciliação no portal

Um pedido do app ainda está sendo enviado ao portal, ou ficou em `indeterminado_requer_conciliacao`. Importar agora
poderia duplicar. Espere o envio terminar (minutos) ou concilie o pedido citado em Gerir pedidos, e importe de novo.

### "Não consegui ler o pedido no portal"

Leitura falhou antes de qualquer gravação. Veja **Detalhes técnicos** na tela (passos do navegador remoto). Causas
comuns: senha do portal, cota do Browserless, portal fora do ar, pedido digitado como **proposta** (só "Pedido"
efetivado é importado), situação ilegível.

### "Não sei se o pedido entrou"

A resposta não trouxe um desfecho reconhecido (prazo do gateway, rede, `{}`, erro 500 sem contrato). A importação
pode ter gravado. Espere 1 minuto e **importe de novo** — o app mostra o pedido de compra se ele já existe. Se o
aviso se repetir, use as queries de "onde está o pedido".

### "A situação lida no portal não foi gravada no app"

A importadora leu a situação (ex.: Cancelado) mas o escritor `sayerlack_registrar_situacao_portal` falhou. Se o
pedido foi cancelado na Sayerlack, o disparador ainda não sabe. Confira no portal; se cancelado, não crie o pedido de
compra e avise para a próxima varredura gravar (ou rode a varredura).

## Senha do portal

Sintoma: toda rodada falha antes do protocolo (`causa_pre_protocolo` = `leitura:…` com login recusado) e o botão diz
"Não consegui ler". Os segredos das edges são `SAYERLACK_PORTAL_USER`, `SAYERLACK_PORTAL_PASS`,
`SAYERLACK_PORTAL_URL` e `SAYERLACK_PORTAL_CLIENTE_CODIGO` (Supabase secrets — **nunca** cole o valor no chat ou num
arquivo). Trocou a senha no portal → atualize `SAYERLACK_PORTAL_PASS` nos secrets e rode a varredura em
`modo=listar` para conferir antes do próximo cron.

## Cota do Browserless

Cada leitura da lista e cada importação abre uma sessão (`BROWSERLESS_TOKEN`). Sintoma: `leitura:REDE` /
`BUDGET_EXHAUSTED` ou HTTP 429 no trace. A contagem por rodada fica em `detalhes->'sessoes_browserless'`:

```sql
SELECT date_trunc('day', iniciado_em) dia, sum((detalhes->'sessoes_browserless'->>'total')::int)
FROM acoes_execucoes WHERE acao = 'reposicao.varrer_portal_sayerlack' GROUP BY 1 ORDER BY 1 DESC LIMIT 14;
```

Cota estourada: espere o reset do plano (não fique reimportando — cada tentativa gasta sessão) ou aumente o plano.
Importar vários números pelo botão roda um por vez de propósito.

## Cron parado ou sem prova

Sintoma: e-mail do vigia `sayerlack_varredura_portal` (stale ou broken) e, no card, "sem rodada efetiva desde X".

```sql
SELECT iniciado_em, status, detalhes->>'modo', detalhes->>'pulado', detalhes->>'causa_pre_protocolo',
       detalhes->>'prova_leitura', left(detalhes->>'erro', 200)
FROM public.acoes_execucoes WHERE acao = 'reposicao.varrer_portal_sayerlack' ORDER BY iniciado_em DESC LIMIT 6;
SELECT start_time, status, return_message FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'sayerlack-varrer-pedidos-portal') ORDER BY start_time DESC LIMIT 6;
-- A verdade HTTP do net.http_post (o cron "succeeded" só prova o enqueue):
SELECT created, status_code, left(content::text, 200) FROM net._http_response ORDER BY created DESC LIMIT 6;
```

- `pulado = portal_fechado`: normal no fim de semana.
- `prova_leitura` ≠ `ok` (`total_nao_anunciado`, `colunas_ausentes`, `zero_lidos_sem_prova`…): o portal mudou o DOM;
  a rodada não decide nada até corrigir o leitor (edge — sessão de código).
- Sem linha nenhuma no ledger: o cron não disparou ou a edge não subiu; confira `cron.job` (ativo) e o deploy.
- Rodada só em `modo=listar` **não** conta como efetiva para importar.

Corrigida a causa: rode a varredura (ou espere a próxima) e confira no card que a rodada efetiva apareceu.

## Backlog antigo (pedido de mais de 7 dias)

A varredura lê só os últimos 7 dias de emissão. Fora disso, ela só reconsulta por número o que já é pendência
aberta (`sayerlack_varredura_falha`) ou pedido do app sem pedido de compra — até 4 por rodada, 1×/20 h por número.
Pedido antigo que nunca entrou: importe pelo botão (aceita vários números de uma vez, um por linha). Antes, confira
que não há pedido de compra lançado à mão (query de "onde está o pedido") para não duplicar.
