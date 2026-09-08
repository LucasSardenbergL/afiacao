# O write-back da edição escrevia meia história — e a metade que faltava era a do dinheiro

**2026-09-07.** Conserto do escritor que a frente [invariante-do-agregado-sem-dono.md](invariante-do-agregado-sem-dono.md)
(#2363) nomeou e deixou de propósito para depois: `supabase/functions/omie-vendas-sync/index.ts`, action
`alterar_pedido`. Sem este conserto, aplicar a CONSTRAINT TRIGGER daquele PR faria a edição de
pedido **falhar** — com o Omie já mutado — em vez de parar de corromper.

## O defeito, em uma frase

Depois de EXCLUIR e RE-INCLUIR todos os itens no Omie, o write-back local era um `.update()`
PostgREST em `sales_orders` gravando `items` (jsonb), `subtotal`, `total`, `notes`, `omie_payload`
e `omie_response` — e **nunca** tocava `order_items`. Em pedido canônico, o jsonb ia para a revisão
NOVA e as linhas ficavam na VELHA.

Aquele bloco era cuidadoso: checava 0 linhas, devolvia erro honesto ("não re-salve sem
recarregar"), passou por revisão. O revisor perguntou *"esta escrita está correta?"* — e não *"o
pedido segue coerente depois dela?"*.

**Medido na prod (psql-ro, 2026-09-07):** 15 pedidos canônicos divergentes, 14 `faturado`,
R$ 27.795,25, 63 diferenças de item. Como `fin-valor-cockpit`, `algorithm-a-audit` e
`_shared/apriori.ts` ancoram em `order_items`, item não escrito vira **vazio, não erro** —
R$ 10.676,56 de venda faturada invisível para o money-path.

## Por que uma RPC nova em vez da `reconciliar_pedidos_omie`

A RPC atômica do pull já existia. O parecer Codex (gpt-6-astra, max) **concordou com a RPC nova e
derrubou dois dos meus argumentos** — ficam registrados como não-motivos: `(account, hash_payload)`
não é chave ambígua dentro do predicado do índice único, e o silêncio dos pulos seria contornável
no caller. Os motivos que ficaram de pé:

- **Pulo silencioso.** `sem_pai`/`sem_item`/`ambiguo`/`stale`/`falhas[]` saem como contador no
  retorno. Neste caminho o Omie **já foi mutado** quando o write-back roda: pular em silêncio é o
  pior desfecho possível.
- **Colunas de menos.** Ela não grava `notes`/`omie_payload`/`omie_response`. Usá-la exigiria um 2º
  UPDATE em outra transação — e com duas edições intercaladas isso termina com itens da edição 2 e
  `omie_payload` da edição 1. O payload é **reusado na edição seguinte**: chamá-lo de "só
  metadado" subestima a consequência (achado do Codex).
- **Semântica diferente.** Ela diffa duas observações independentes. Aqui não há o que casar: a
  edição apagou e recriou todas as linhas no Omie, as identidades `omie_codigo_item` antigas
  deixaram de existir, e o conjunto novo é a verdade **declarada**. Por isso a substituição é
  integral.

## O que a RPC nova faz (`20260907210000_pedido_edicao_omie_atomica.sql`)

Cabeçalho e linhas na MESMA transação, sob `FOR UPDATE` do pai, chaveada pelo `id`. Tudo LANÇA:
`items`/`itens`/`total`/`lido_em` ausentes, item sem preço, desconto ≠ 0, total que não bate com a
soma dos itens, pai inexistente. Pedido **sem** linhas segue sem linhas (push do app é desenho
legítimo e a invariante o isenta — criar linhas ali mudaria *quais* pedidos são canônicos, o que é
decisão de produto).

Três decisões que só existem porque foram medidas, não deduzidas:

- **`desconto: 0` passou a viajar no jsonb.** A invariante compara `(produto, quantidade, preço,
  desconto)` e **NULL é distinto de 0**. O jsonb da edição não tinha a chave; `order_items.discount`
  é 0 em 100% das 70.860 linhas e o jsonb do sync tem `desconto` em 100% dos 70.889 itens. Sem
  acrescentar a chave, escrever as linhas certas **ainda** seria recusado.
- **A recência é carregada explicitamente.** `order_items.created_at` é o sinal que o
  `fin-valor-cockpit` prefiltra. O trigger `trg_order_items_created_at_omie` reinjeta o `created_at`
  do pai — mas **só** quando `hash_payload LIKE 'omie\_%'`, e a RPC é chaveada por uuid, que não
  restringe esse domínio (achado do Codex). Hoje são 0 pedidos com linhas fora do predicado; o
  carregamento é a rede, não a aposta.
- **O `product_id` é herdado por SKU.** Achado na revisão do próprio diff, e o mais fácil de
  passar batido: `construirItemsJson` (o caminho de PULL) **não grava a chave `product_id`** no
  items-jsonb. Como o front monta a edição a partir desse jsonb, um pedido canônico chega ao
  write-back com `product_id` só nos itens que o usuário acrescentou pelo catálogo. Substituir as
  linhas sem mais nada **zeraria** o `product_id` dos itens preexistentes — que é FK para
  `omie_products` **e** a chave de custo da margem. Regra: payload vence; onde ele não sabe, herda
  o da linha substituída do MESMO SKU, e só quando aquele SKU tem UM `product_id` só. Ambíguo →
  NULL, não adivinha.
- **Compare-and-set de revisão.** Sem carimbar `omie_reconciliado_em`, um pull que leu o Omie
  ANTES da edição e escreve DEPOIS **reverte tudo — e reverte de forma coerente**, então nenhuma
  invariante de agregado pegaria (achado do Codex). A coluna passou a ter DOIS escritores com a
  MESMA semântica ("instante em que a edge buscou no Omie a revisão gravada"), e o comentário da
  coluna foi reescrito para dizer isso.

## O escritor irmão: o backfill de cor

`backfill_tint_cor` (mesma edge) tinha a MESMA classe: achava a linha canônica por
`(account, omie_pedido_id)` e reconstruía o items-jsonb inteiro a partir da leitura atual do Omie,
sem tocar `order_items`. `mesclarPrecoPreservado` tapava metade do buraco — o preço.

A correção inverte quem manda: `aplicarCorPreservandoItens(bfRow.items, bfItems)` usa o que **está
gravado** como base e só acrescenta `tint_nome_cor`, onde o código é 1-1 nos dois lados. O conjunto
de itens, os valores e o desconto ficam intocados, e **a invariante vale por construção**. O
guardrail em `src/lib/scoring/__tests__/margem-sem-preco.test.ts` deixou de exigir a mescla e passou
a exigir a DIREÇÃO (`bfRow.items` como 1º argumento) — inverter os argumentos devolveria a
reconstrução com outro rótulo, e é o único jeito de o bloco voltar a mexer em preço sem que ninguém
veja. `mesclarPrecoPreservado` ficou sem chamador de produção e foi removido junto com seu teste.

## Prova

`db/test-pedido-edicao-atomica.sh` — PG17 descartável, **54 asserts, exit 0**. Inclui:

- **ANTES**: reproduz o defeito — o update só-cabeçalho é aceito e o agregado fica incoerente pelo
  MESMO `EXCEPT ALL` com que a trigger vai medir.
- **DEPOIS**: pedido canônico com linhas editado no Omie fica coerente; recência, `customer_user_id`
  do pai, `hash_payload` derivado do pai, `product_id` herdado por SKU (com a FK real para
  `omie_products` no stub, senão o assert passaria com qualquer uuid) e `omie_codigo_item` novo
  (NULL onde não se sabe, nunca o código velho).
- **Fail-closed**: 14 caminhos negativos casando **SQLSTATE**, com `WHEN OTHERS THEN RAISE`.
- **Atomicidade**: recusa da postcondição não deixa NENHUMA das metades gravada.
- **Interação com a trigger irmã**: com ela instalada, o escritor velho é recusado e a RPC passa.
- **Falsificação** com CONTROLE VERDE na mesma invocação: sabotar a postcondição, o compare-and-set
  e o guard de desconto faz cada recusa SUMIR; sabotar a herança faz o `product_id` ZERAR; sabotar
  o GRANT/REVOKE faz o **apply abortar**.

Duas armadilhas que a própria prova pegou e viraram comentário no harness: `VAR="$(cmd)"` sob
`set -e` aborta o script e enterra o erro dentro da variável; e comentar só a 1ª linha de um
`GRANT` de duas linhas faz o apply abortar por **sintaxe** — vermelho pelo motivo errado, que é a
forma mais fácil de uma falsificação virar teatro.

## Ordem de implantação e o que NÃO foi feito

1. `20260907210000_pedido_edicao_omie_atomica.sql` (SQL Editor) → 2. deploy da edge (Publish) →
3. `20260907220000_pedido_venda_coerencia_agregado.sql` (do #2363). **Invertido, a edição de
pedido passa a falhar com o Omie já mutado.**

⚠️ O #2363 **mergeou antes deste PR** (2026-09-08). Merge não é apply: as duas migrations chegaram
à `main` na ordem inversa da que precisam ser COLADAS. A ordem acima é a que vale — e ela não se
lê no histórico do git, só aqui e no corpo dos dois PRs.

Não foi feito, e continua aberto:

- **Reparo dos 15 divergentes** — mexer em itens de pedido faturado é correção financeira, pede
  decisão caso a caso, e o deploy não os corrige sozinho.
- **Tolerância de `1e-6` na `reconciliar_pedidos_omie` × igualdade exata da trigger.** O diff pode
  manter `unit_price = 10` na linha e gravar `valor_unitario = 10.0000005` no jsonb; a trigger
  recusaria. Medido hoje: **0 ocorrências** — mas é alcançável, e a violação **diferida** estoura no
  COMMIT, depois do bloco `EXCEPTION` por pedido, o que aborta a **página inteira** em vez de cair
  em `falhas[]`. É compatibilidade do PR #2363 com o escritor do sync, não deste conserto.
- **Recuperação de edição interrompida no meio do Omie** (falha na 3ª exclusão, na 2ª inclusão):
  o ERP fica parcialmente alterado e o fluxo nem chega ao write-back. Dívida anterior, segue aberta.
- **Política de editar pedido `faturado`**: o cabeçalho enviado fixa `etapa: "10"` e a RPC preserva
  o status local. 14 dos 15 divergentes são faturados — a política precisa ser explícita.
- **`recommend-leituras.ts` pagina `order_items` por `id`**: substituir linhas pode repetir ou pular
  um item entre páginas. Não é novo (a `reconciliar_pedidos_omie` já faz DELETE+INSERT) e não é
  corrigível por escrita atômica — várias requisições de leitura não são um snapshot.
- **A isenção não distingue push legítimo de perda total dos filhos**: apagar todas as linhas de um
  pedido canônico também o torna isento. Limitação estrutural da invariante condicional (#2363).
