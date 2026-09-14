# A edição do app apagava o desconto do Omie — e a régua que SOMA receita não serve para AUTORIZAR apagar

**2026-09-14** · `supabase/functions/omie-vendas-sync/index.ts` (`alterar_pedido`) · money-path · continuação de
[total-liquido-do-pedido-e-a-base-que-compara.md](total-liquido-do-pedido-e-a-base-que-compara.md) (#2469, item
"A edição do app" do que ficou aberto) e de [write-back-da-edicao-sem-as-duas-metades.md](write-back-da-edicao-sem-as-duas-metades.md).

## A pergunta

Desde o #2469 o total da ingestão é LÍQUIDO do desconto de item (trio `tipo_desconto`/`percentual_desconto`/
`valor_desconto` de `det.produto`). A edição pelo app não envia desconto e a RPC `aplicar_edicao_pedido_omie`
recusa `discount <> 0`. Hipóteses (2ª opinião anterior, não verificada): editar um pedido com desconto de item
**(a)** apaga o desconto comercial no ERP, ou **(b)** grava local bruto enquanto o ERP mantém o líquido.

## O que o código faz — lido, não suposto

A action não manda itens pelo `AlterarPedidoVenda` (ele só leva cabeçalho/frete/observações). A sequência é:

1. `ConsultarPedido` → itens atuais; guard anti-duplicação.
2. `ExcluirItemPedido` para **cada** item atual.
3. `IncluirItemPedido` por item com produto, quantidade, preço, CFOP (e cor/ordem de compra) — **nenhum** campo de
   desconto, nem `codigo_tabela_preco`.
4. `AlterarPedidoVenda` (cabeçalho) → `TotalizarPedido` ("recalcula os totais").
5. `ConsultarPedido` final, comparado por `codigo_produto:quantidade:valor_unitario` — **cego a desconto**.
6. Write-back com `discount: 0`, `desconto_valor` ausente (NULL) e `p_total = Σ qtd·preço`.

É a **única** via que muta itens de pedido existente: grep de `IncluirItemPedido`/`ExcluirItemPedido`/
`AlterarItemPedido`/`AlterarPedidoVenda`/`ExcluirItensPedido` em `supabase/functions` só acha esta action.

Na doc oficial, o desconto de capa é distribuído aos itens e, depois disso, fica "exibido apenas nos itens"; no
`incluirItemPedidoRequest` os três campos de desconto são opcionais. Excluir o item leva o desconto junto; reincluir
sem o trio cria item sem desconto.

## Veredito

- **(a) é o desfecho esperado pelo contrato** (código + doc) — **não demonstrado em prod**. A doc não diz que item
  incluído sem o trio fica com desconto zero nem descarta reaplicação automática; "confirmado" seria forte demais
  (o Codex derrubou a palavra, e com razão).
- **(b) também é alcançável, e sem reaplicação nenhuma** — achado do challenge Codex, que reproduziu a action em
  memória: `callOmieVendasApi` devolve `null` quando um transitório esgota os retries, e exclusão/inclusão ignoram o
  retorno. Com os mesmos SKU/quantidade/preço, delete e add "vazios" deixam o item descontado no Omie, a assinatura
  cega aprova e o local grava bruto.

## Medição (psql-ro, 2026-09-14)

- **Censo das edições**: o write-back grava `omie_response.descricao_status = 'Pedido alterado com sucesso!'`
  (marcador desde 2026-04-09; só esta edge escreve `omie_response`, as RPCs do sync não tocam a coluna). **5
  pedidos**, todos oben, `updated_at` 2026-05-25, status `enviado`, **nenhum com linhas em `order_items`** e nenhum
  com `omie_reconciliado_em`. Logo "editados com `desconto_valor > 0`" = **0 de 5, com 0 linhas apuráveis** —
  ausência de dado, não "sem desconto". Ponto cego: edição que mutou o Omie e falhou no write-back não deixa marcador.
- Os **15 canônicos divergentes** do #2363 **não** eram edições do app (sem chaves do formato do app no jsonb e
  `omie_response` NULL nos 15) — a atribuição ao escritor da edição era de CLASSE, não de caso.
- Não há onde medir o desconto pré-edição: `venda_items_history` é NF-e sem desconto, `sales_orders.omie_payload`
  só existe em 26 pedidos (origem app) e o sync não guarda a leitura crua.
- **Universo que o guard passa a recusar**: desde a régua na ingestão (2026-09-10), **5 de 74 pedidos (6,8%)** têm
  desconto de item — oben 4 (R$ 560,60), colacor 1 (R$ 13,50) —; 162 linhas, **0 ilegíveis**, 7 com desconto.
- `venda_bloqueio_credito_log`: **0 linhas** — nem o anti-duplicação nem a trava de crédito da edição jamais
  dispararam. Coerente com o censo: o defeito é **latente e alcançável** (a tela abre para qualquer pedido com
  `omie_pedido_id`), não ativo.

## O guard — o que se decidiu, e por quê

**Régua de presença, não de apuração** (`_shared/edicao-desconto-omie.ts`). `descontoItemOmie` foi feita para
SOMAR receita, e três zeros dela são cegueira quando a pergunta é "é seguro apagar?": campo presente e inválido
(`"abc"`, negativo, `"5,00"`) ela lê como ausente; desconto abaixo de ½ centavo ela arredonda; base lixo produz
`NaN` e `NaN > 0` é falso. O guard só deixa passar o item em que a régua leu **exatamente zero E** nenhum campo cru
informa desconto. Régua e campo discordando é **ilegível**, e ilegível acusa.

**Universo = o det inteiro** (≠ `apurarSubtotalPedido`, que pula item sem SKU ou sem preço): a edição exclui todos.

**2º eixo na capa** — `total_pedido.valor_descontos` ("Valor dos descontos", preenchimento automático). Não depende
dos campos do item: se o trio sumir da resposta, a capa ainda acusa. Ausente não acusa; presente e inválido acusa.

**Onde**: logo depois do anti-duplicação, **antes** do verify-before-edit, da trava de crédito e de qualquer
mutação, sobre a leitura ATUAL do Omie. **200 estruturado** (`blocked: "desconto_omie"`, como
`credito`/`tint_preco`/`atp`): um `throw` vira 500 e o `functions.invoke` entrega ao app só "non-2xx" — a
instrução de editar no Omie se perderia. Sem override: é contrato, não exposição. Efeito colateral bom: todo pedido
que passa tem desconto zero, então o `totalAtualOmie` BRUTO da trava de crédito passa a ser também o líquido — o
bypass "bruto 200, líquido 180, edita para 190 e pula o crédito" (Codex) fica fechado por construção.

**Pós-checagem na leitura final** — a mesma régua sobre o `ConsultarPedido` final, antes do write-back. Acusar ali é o
Omie contradizendo o contrato (reaplicou desconto, ou uma exclusão devolveu `null` e o item descontado ficou): o Omie
já foi mutado, então **lança** em vez de gravar um bruto que o ERP desmente — fecha o (b) qualquer que seja a causa.

**Rastro durável**: `venda_bloqueio_credito_log` com `acao = 'gate_indisponivel'` e `detalhe 'edicao: …'` — o
precedente do anti-duplicação desta mesma action (aborto de integridade antes de mutar). `acao` é CHECK ao
vocabulário do crédito, e o fluxo de exceção (`useExcecaoCredito`) só lê `bloqueado`/`bloqueado_edicao`, então a
linha não aparece como bloqueio de crédito. No app, `track('pedido.edicao_bloqueada')`. Falha do insert não vira 500.

**Mensagem honesta**: com algum item/capa `desconto`, "este pedido tem desconto de item no Omie"; só `ilegivel`,
"não foi possível verificar o desconto" — ilegível não afirma desconto.

## 2ª opinião — rodada 1 no Codex, rodada 2 no Caminho B

- **Rodada 1** (metodologia; gpt-6-astra · max · 403 s · 116.548 tokens). Concordou com o bloqueio e mudou o desenho
  em quatro pontos: derrubou "confirmado por contrato"; mostrou o (b) sem reaplicação; mostrou que a régua de
  apuração não detecta presença; apontou a capa `total_pedido.valor_descontos`. Recusei duas sugestões:
  `order_items.desconto_valor` como veto (o local pode estar não apurado) e reconsultar contra o TOCTOU (só estreita
  a janela).
- **Rodada 2** (código): **cota esgotada** — o servidor recusou com "try again at Sep 19th, 2026 1:21 PM", e o plano
  declarado no token (`prolite`) é a assinatura paga, então o limite é real. **Caminho B**: refiz contra o diff as 7
  perguntas que a rodada 2 levaria. Dois furos nos pins, ambos de verde por FORMA: o guard **embrulhado num `if`**
  (escopado a uma conta) passava em todos, e trocar a **extração de `total_pedido` por `null`** desligava o 2º eixo
  sem nenhum pin reclamar. Um menor: `acao: 'bloqueado_edicao'` na trilha poria a recusa no fluxo de exceção de
  crédito. Os três viraram asserção (âncora no nível do `case`, pins das extrações, pin negativo) e sabotagem com
  vermelho exigido.
- ⚠️ **REVISÃO INDEPENDENTE PENDENTE.** A auto-revisão cobre o intervalo, não substitui: rodar a rodada 2 do Codex
  retroativa quando a cota voltar.

## A forma generalizável

> **Régua que APURA não é régua que AUTORIZA.** Uma função feita para somar receita tem de degradar para um número
> utilizável — trata campo inválido como ausente, arredonda o que não chega a centavo. Uma decisão DESTRUTIVA
> precisa da pergunta oposta: *existe algum sinal de que há algo aqui?* Reusar a régua de apuração como guard herda
> os zeros dela como "pode apagar". Presença se mede no campo cru, com a apuração como segundo sinal — e a
> discordância entre os dois é o caso que acusa.

E uma de método, pega na mesma entrega: **resumo de documentação por ferramenta não é leitura da fonte.** O
extrator do WebFetch afirmou que `total_pedido` não tinha campo de descontos; o Codex afirmou que tinha; o HTML cru
(`curl` + grep) resolveu — `valor_descontos` existe, com descrição. Quando duas leituras de segunda mão discordam,
a terceira leitura de segunda mão não desempata.

## O que ficou aberto, de propósito

- **Mutações da edição ignoram `null` de transitório esgotado** (`throwOnTransient` ausente nas 4 chamadas
  destrutivas). O guard fecha o eixo do desconto; o eixo geral — edição que "sucede" sem ter mutado — segue aberto.
- **TOCTOU** entre o `ConsultarPedido` e a primeira exclusão (identidade e crédito no meio): desconto aplicado no Omie
  nesses segundos seria apagado. Reconsultar só estreita a janela; é o mesmo "último a escrever vence" de qualquer
  edição simultânea app × Omie.
- **Ilegível de item sem SKU/preço não está calibrado**: os 0 ilegíveis da ingestão só cobrem itens que viram linha.
- **Editar pedido com desconto pelo app** (enviar o trio no `IncluirItemPedido`, RPC aceitando desconto, total
  líquido) é decisão de produto — o guard só impede o dano enquanto ela não existe.
