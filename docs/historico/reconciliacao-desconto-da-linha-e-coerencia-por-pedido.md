# A reconciliação não carregava o desconto da linha — e UM pedido incoerente parou o reprocesso por 6 dias

**2026-09-14** · `supabase/migrations/20260914180104_reconciliar_carrega_desconto_e_isola_coerencia.sql` · `supabase/functions/sync-reprocess/index.ts` (v1.8) · money-path · continuação de [total-liquido-do-pedido-e-a-base-que-compara.md](total-liquido-do-pedido-e-a-base-que-compara.md) e [invariante-do-agregado-sem-dono.md](invariante-do-agregado-sem-dono.md)

## O defeito pedido

`reconciliar_pedidos_omie` não recebia `order_items.desconto_valor`. Invalidava para NULL quando qtd/preço/produto mudavam, inseria linha nova com NULL e — o cenário do parecer Codex — quando **só o desconto** mudava no Omie o UPDATE nem disparava. Desde o #2469 o cabeçalho recebe o total **líquido** novo, então a linha ficava com o desconto **velho** sob ele: linha 1×100 com desconto 10, o Omie muda para 20, o pai vira 80, a linha segue 10 e `fin-valor-cockpit` calcula 90.

## O incidente que o pré-flight achou antes da primeira linha de código

Medido via `psql-ro` em 2026-09-14 (~20:30 UTC): o reprocesso de pedidos da oben **não completava desde 2026-09-08 20:15 UTC** — **79 runs em erro** (73 operacionais + 6 estratégicas), **todas** no mesmo pedido (`7b6f5f03…`, omie 12180025234), com `pedido … incoerente: order_items e items(jsonb) descrevem conjuntos diferentes`. O pedido estava coerente no banco. Incoerente era a **escrita proposta**.

O mecanismo: os triggers de coerência do agregado (#2363) são `DEFERRABLE INITIALLY DEFERRED` e checam no COMMIT — que, numa RPC em lote, é o da **chamada inteira**, fora do `BEGIN … EXCEPTION` por pedido. Um pedido derrubava a chamada, a página e a run, a cada 2 h. E **nada vigiava**: 0 funções, 0 crons e 0 views da prod leem `sync_reprocess_log`.

Reproduzido no PG17 (assert H0): a função antiga, com o trigger da prod instalado, perde a chamada inteira com 23514 e não reconcilia nem os pedidos bons do lote.

## O que mudou

1. **O desconto da linha.** A edge manda `desconto_valor = descontoItemOmie(prod, qty·preço)` — a base que vai para a linha e que `apurarSubtotalPedido` soma. A RPC separa chave **ausente** (edge velha: regra antiga) de chave **presente** (`null` = não apurado → NULL, nunca 0), trata o desconto como motivo próprio de escrita, grava no UPDATE e no INSERT com a régua de finitude do preço, e separa **correção** de desconto conhecido (conta em `corrections`) de **apuração** NULL→valor (não conta: 1.024 linhas NULL na janela de 30 dias). Dois sensores novos no retorno: `desconto_corrigido` e `desconto_apurado`.
2. **Escrita exata no que a coerência fiscaliza** (achados do parecer Codex). O UPDATE casado por `omie_codigo_item` não gravava `omie_codigo_produto` — um SKU trocado no Omie deixava a linha com o SKU velho sob o jsonb novo — e decidia por tolerância 1e-6 enquanto o trigger compara exato. Agora o SKU é gravado e a decisão de escrever é `IS NOT DISTINCT FROM`; a tolerância ficou só na classificação das métricas.
3. **Coerência checada dentro do bloco do pedido.** `PERFORM pedido_venda_exigir_coerencia(v_order_id)` quando o pedido escreveu: o 23514 cai no handler, o pedido vai para `falhas` revertido inteiro, e o lote segue. Os contadores só somam depois da checagem.
4. **Edge.** Pedido com item sem código de produto utilizável é recusado inteiro (`item_sem_codigo`); página com **um** pedido que falha não derruba mais a run; `falhas_amostra` e os sensores (`null` = RPC antiga) vão ao `metadata`.

## A forma generalizável

> **Isolamento por subtransação só isola o que falha DENTRO dela.** Um constraint trigger `DEFERRED` checa no COMMIT — numa função em lote, o da chamada. O `BEGIN … EXCEPTION` por item parece conter a falha e não contém nada que o banco adia. Chame o MESMO predicado dentro do bloco, só quando o item escreveu (é quando o trigger teria evento dele).

- **Não `SET CONSTRAINTS … IMMEDIATE`** — foi o primeiro desenho. Ele checa os eventos pendentes da transação **inteira**, e um item pagaria pela pendência de outro (parecer Codex).
- **O rollback do bloco desfaz o banco, não as variáveis PL/pgSQL.** Contador somado antes da última checagem conta trabalho revertido: `corrections` afirmaria correção que não aconteceu (FH2 prova), e `identidade_usada` contaria o pedido que falhou por dado (H4/FH3).
- **Decidir por tolerância e gravar sob um fiscal exato não fecham.** Se a invariante compara igualdade exata, a DECISÃO de escrever tem de ser exata; a tolerância pode morar na métrica, não no gatilho.
- **Invariante de CONJUNTO não prova correspondência ELEMENTO a elemento.** Duas linhas de conteúdo idêntico com identidades permutadas: sem gravar o SKU, a função antiga commita **calada** com o `product_id` de um produto colado no SKU do outro — a chave de custo da margem trocada — e o trigger aprova, porque (SKU, qtd, preço, desconto) é o mesmo multiconjunto antes e depois (H4c). O fiscal do agregado pega o defeito barulhento e deixa passar o silencioso; quem fecha os dois é gravar a coluna.
- **"Todos os itens da página falharam", com um item só, é veredito sem denominador.**
- **ACL herdado de DEFAULT PRIVILEGES não está em migration nenhuma.** O `service_role` executa o validador na prod, mas a cadeia de migrations não reproduz isso: a pós-condição A5b abortou a migration no smoke PG17. Dependência nova de privilégio vira `GRANT` explícito (no-op em prod).
- **Diferencial prova a compatibilidade — e só ela.** Toda mudança INTENCIONAL para o payload antigo fica fora dele e precisa de assert próprio, medido nos dois lados (G11, G12, H, H4, H4c). Sem isso, "idêntico onde devia ser" esconde "diferente onde ninguém olhou": a auto-revisão achou o H4 exatamente assim.
- **Sonda por `to_jsonb(linha)->>'coluna'` é cega a coluna inexistente.** O primeiro filtro em `fin_sync_log` usou `created_at` — a coluna é `started_at` — e devolveu 0 em 7 dias, sem erro: ausência de dado com cara de "ingestão sã". Refeito com a coluna certa.

## Evidência

- `db/test-desconto-valor-escritores.sh` — **110 ok / 0 fail** (eram 35). §G: o cenário do parecer, idempotência por `xmin`, null presente, NULL==NULL, apuração, base e desconto juntos, edge velha, linha nova, lixo (-5/NaN/Infinity), adoção simultânea, SKU trocado, ruído de 4e-7, e o SKU mudando de dono sob a mesma identidade — permutação (G13), só o SKU (G14), conteúdo idêntico (G15). §H: lote com o pedido ruim no meio (o contrafactual é o incidente), o contador de pedido revertido por dado (H4) e a corrupção calada da função antiga (H4c), as duas mudanças intencionais medidas nos dois lados. §I: diferencial sem a chave — 11 saídas e 29 linhas de retrato idênticas. **14 sabotagens de efeito** (FG1–FG10, FH1–FH3, FI1), mais a pós-condição (FP1) e a pré-condição (FP2) com dente, cada uma em banco próprio e com o controle verde na mesma invocação.
- **Validação independente por execução**: a sessão quirky-rosalind-ac9c16, que chegou ao mesmo mecanismo por conta própria, rodou 31 cenários adversariais contra esta migration (com o pedido 7b6f transcrito da prod) — 31/31 verdes. Os três cenários que esta prova não isolava viraram G13–G15, e o H1d dela revelou a corrupção calada do H4c.
- Predicados da pós-condição avaliados contra a **prod** (`psql-ro`): falham exatamente A2, A4 e A5 — o que a migration muda. A8 é inavaliável sob `claude_ro` (o papel não executa a RPC) e está provado no PG17.
- Corpo base = `pg_get_functiondef` vivo, md5(prosrc) `136b40ad…`, idêntico no PG17 (assert H0.0); 15 patches por âncora única.
- **A fonte lê o campo que a origem manda.** A ingestão e o backfill leem o MESMO `ListarPedidos` do reprocesso, e a prod tem 7 linhas com desconto real apurado por ele (de 0,53% a 20,39%). O reprocesso não repete a armadilha de [desconto-a-sonda-lia-campo-que-nao-existe.md](desconto-a-sonda-lia-campo-que-nao-existe.md) — o risco de "campo ausente vira 0 sobre desconto real" foi medido, não suposto.
- `src/__tests__/edge-money-path-invariants.test.ts` — fiação da edge, defesas da migration e calibração.
- Parecer Codex de desenho: `gpt-6-astra · max · 2581s · 123.863 tokens`.

## O que ficou aberto, de propósito

- **O pedido 7b6f5f03 em si.** Sem payload do Omie persistido não há como afirmar a causa com certeza. A hipótese mais forte é o SKU trocado sob o mesmo `codigo_item`, corrigido aqui; a validação independente reforça por eliminação (0 pedidos gravados incoerentes, 0 `discount` NULL e 0 itens de jsonb sem `omie_codigo_produto` na prod) e pela nota fiscal do pedido. Se não for, ele passa a aparecer em `metadata.falhas_amostra` com a SQLSTATE, sem parar a run.
- **Follow-ups do parecer, fora desta função:** a régua lê campo de desconto **presente e inválido** como ausente (→ 0); o carimbo do CAS é tirado depois da resposta do Omie; o backfill pode ressuscitar desconto velho depois de uma invalidação; a edição aceita `desconto_valor` com `p_total` bruto; e ninguém vigia `sync_reprocess_log`.
- **REVISÃO INDEPENDENTE PENDENTE do código final.** O challenge Codex sobre o diff bateu na cota (`COTA_ESGOTADA`, plano declarado no token `prolite`, janela reabre em 2026-09-19 13:21). No intervalo, o Caminho B: a prova PG17 falsificável, uma auto-revisão adversária sobre as mesmas perguntas (achou o H4 e mediu a fonte do desconto) e a validação por execução de outra sessão. Nenhuma das três substitui a revisão por outro modelo; o challenge retroativo roda quando a cota voltar.
