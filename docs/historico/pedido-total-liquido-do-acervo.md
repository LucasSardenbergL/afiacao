# O acervo converte onde as linhas PROVAM — e a prova tem data, mês inteiro e as duas contas

**2026-09-14** · `supabase/migrations/20260914181500_pedido_total_liquido_acervo.sql` + `20260914193000_pedido_total_liquido_acervo_mes_entre_contas.sql` · money-path · continuação de [total-liquido-do-pedido-e-a-base-que-compara.md](total-liquido-do-pedido-e-a-base-que-compara.md) (#2469)

## O problema

O #2469 passou `sales_orders.subtotal`/`total` do pedido NOVO a líquido. O acervo seguiu bruto, e quem compara períodos erra: presente líquido × passado bruto dá a um cliente com 10% de desconto uma "queda" de 10% (`faturamento_90d × prev_90d` da `customer_metrics_mv`, `useTeamKpis`). Esta entrega é a passada que converte o cabeçalho do acervo — só onde as linhas de `order_items` provam o desconto.

## Medido antes de escrever (psql-ro, 2026-09-14 ~20:15–21:45 UTC)

- **Pré-requisito não cumprido:** 71.038 de 71.195 linhas com `desconto_valor` NULL (99,8%, o mesmo de 10/09). O backfill só rodou um dry-run de 1 página; não escreveu nada.
- **Pedidos Omie (31.384):** 31.282 com linha não apurada · 70 sem desconto · 27 sem linha · **4 convertíveis** (oben, Σ −R$ 560,60) · 1 tocado depois do corte (um colacor que a v1.6 inseriu hoje). **Nenhum mês está completo nas duas contas** ⇒ um apply hoje converte 0.
- **Pedidos sem prova de desconto, por mês:** 95–100% de março a agosto nas duas contas; setembro 63% (colacor) e 71% (oben).
- **Deploy:** `sync-reprocess` v1.7 visto desde 20:37 UTC (a última v1.6, 18:37); `omie-vendas-sync` **ainda v1.6** — a ingestão segue gravando bruto. E o reprocesso está em erro desde 08/09 (79 runs; conserto em voo no #2496).
- 0 pedidos incoerentes pela trigger de coerência; máximo de 28 linhas por pedido; 7 totais colacor a exatamente 0,01 de `round(Σ qtd·preço, 2)` (float do TS legado), nenhum além.
- O maior "total" do acervo, R$ 615 mi, é o pedido oben 9647, **cancelado**, com preço digitado errado no ERP. A MV exclui cancelado.

## O que se decidiu

1. **A regra.** Converte ⇔ todas as linhas apuradas e sãs (qtd > 0; preço ≥ 0; desconto ≥ 0 e ≤ base + ½ centavo; os três finitos; líquido do pedido ≥ 0), cabeçalho no padrão da ingestão (subtotal = total, discount = 0), total ainda bruto (≤ 0,01) e não líquido (> 0,01). Grava `total = subtotal = round(Σ (qtd·preço − desconto_valor), 2)`, arredondando uma vez no fim como `apurarSubtotalPedido`. Desconto de até ~2 centavos cabe nas duas tolerâncias: `ambiguo`, não se toca.
2. **O corte (P1-1/P1-2 da 2ª opinião).** A regra confia que linha e cabeçalho são a mesma revisão do pedido. Isso vale para cabeçalho escrito por quem gravava BRUTO; deixa de valer quando um escritor novo reescreve o cabeçalho depois — o reprocess v1.7 não atualizava `desconto_valor` se só o desconto mudava, e a edição pelo app grava bruto. Cabeçalho com `updated_at ≥ p_corte` vira `tocado_pos_corte`. **Corte recomendado: `2026-09-14 20:09:13+00`, o merge do #2469** — nenhum código v1.7 existia antes. (Medido depois: a edge de edição não envia `desconto_valor`, então a linha editada volta a NULL e cai em "não apurado" — o P1-2 não está vivo hoje; o corte cobre o dia em que estiver.)
3. **Mês inteiro, e através das contas (P1-3).** Converter meio mês cria base mista dentro do período, e a distorção pode até inverter o sinal: com dois períodos iguais (bruto 1.000, desconto 100), converter só o atual dá −10%; só o anterior, +11,1%. Com `p_exigir_mes_completo` (default), um mês só converte quando **nenhuma conta do escopo** tem pedido `nao_apurado` ou `linha_invalida` nele. A primeira versão bloqueava por conta×mês — corrigida na 2ª migration, porque a MV, o painel de vendas e o `v_grupo_comercial` somam as duas contas. Converter uma conta sozinha é escolha explícita (`p_contas`).
4. **Teto que recusa.** Escopo com mais convertíveis que `p_limite` não grava nada (TL002) — money-path.md §8.
5. **Concorrência.** `FOR UPDATE SKIP LOCKED` nos pais (nunca espera ⇒ sem deadlock com a ordem de lock dos escritores; o pulado fica para a próxima rodada); a escrita re-classifica num statement posterior ao lock e só reescreve o total que acabou de ler; advisory lock contra duas conversões; a função de coerência roda antes, para um pedido incoerente não derrubar o lote no COMMIT.
6. **Registro append-only** (`pedido_total_liquido_conversoes`: lote, antes, depois, corte), com RLS sem policy e sem UPDATE/DELETE para `service_role`. Desfazer um lote: `UPDATE sales_orders so SET total = c.total_antes, subtotal = c.total_antes FROM pedido_total_liquido_conversoes c WHERE c.lote = '<lote>' AND so.id = c.sales_order_id AND so.total = c.total_depois;`.

## A forma generalizável

> **"Onde a evidência prova" tem três eixos além do registro: TEMPO, AGREGAÇÃO e PERÍODO.** A prova precisa ser da mesma revisão do valor que ela corrige — depois que um escritor novo entra, o valor pode ser mais novo que a evidência. Ela precisa cobrir tudo que o leitor SOMA — se o comparador junta duas contas, converter uma é base mista. E precisa cobrir o período inteiro que o leitor compara — meio mês convertido distorce, e pode inverter o sinal.

É o #2469 visto do outro lado: lá, corrigir o nível criou erro de comparação; aqui, corrigir o acervo aos pedaços recria o mesmo erro em escala menor. Um erro consistente compara certo; uma correção inconsistente, não.

## Lições de processo

- **Commitar a migration fecha a iteração nela.** O auto-challenge achou o gate por conta depois do primeiro commit; o hook de imutabilidade barrou o Edit, e a correção virou migration nova (a `_mes_entre_contas`), com o gêmeo do `db:aplicar` passando a encadear as duas. Iterar a migration ANTES de commitar — o hook permite, e é para isso.
- **A postcondição da migration pegou uma sabotagem antes do harness** — o ensaio que escreve (F12a): ela executa o ensaio e vê `modo: aplicado`. O primeiro run abortou ali. Daí a disciplina: toda sabotagem é instalada SEM a postcondição (o assert do harness responde sozinho) e a postcondição é conferida à parte onde é a camada sob teste.
- **Janela entre a escolha e o lock, reproduzível.** K2 segura `order_items` em `ACCESS EXCLUSIVE`: o SELECT que escolhe o lote pega o snapshot e só então trava, porque a classificação é função SQL não-inlinável (`SET search_path`), analisada dentro da execução. O controle da janela é o próprio resultado (`elegiveis 7`, `mudaram_sob_lock 1`): se alguém tornar a função inlinável, o teste fica vermelho em vez de verde por ausência de janela.
- `psql -tA -c "SET ROLE x; SELECT ..."` ecoa a tag `SET` na saída capturada — use `-q` (a mesma família do `psql-ro` em database.md §1).

## 2ª opinião

- **Rodada 1 (desenho)** — `gpt-6-astra · max · 374 s · 77.163 tokens`. Sem P0; P1: desconto vencido sob reprocess/edição · conversão parcial distorce comparadores (inclusive o sinal) e ignora as duas contas · líquido negativo passava pela pós-condição; P2: deadlock pela ordem de lock · limite do float não é matemático · `db:aplicar` não roda lote repetido e descarta retorno · ACL de `service_role` implícita. Todos tratados (acima), exceto o do float, que ficou medido: 28 linhas e 6,2×10⁸ no pior pedido ⇒ erro < 10⁻⁵.
- **Rodada 2 (código)** — `COTA_ESGOTADA` até 2026-09-19 13:21 (horário do servidor), plano `prolite` no token = o pago. **Caminho B**: PG17 com 68 asserts e 18 sabotagens + auto-challenge (que achou o gate por conta). **REVISÃO INDEPENDENTE PENDENTE** — rodar o `/codex challenge` retroativo quando a cota voltar.

## Como operar

**Pré-condições, todas:** (1) `omie-vendas-sync` e `sync-reprocess` na v1.7, atestados em `bun run pendencias:deploy`, e o reprocesso sem erro (#2496 no ar); (2) backfill de `desconto_valor` nas DUAS contas cobrindo as janelas dos comparadores (≥ 6 meses + o mês corrente); (3) as funções criadas em prod (`bun run db:aplicar db/aplicar-pedido-total-liquido-rpc.sql`).

**Passos:** ensaio com o escopo e o corte (`p_aplicar => false`) — `meses_bloqueados` vazio e `incoerentes = 0` no escopo → apply por rodada, um arquivo próprio por rodada (o `db:aplicar` recusa bytes repetidos) → `SELECT public.refresh_customer_metrics()` → `pedido_total_liquido_relatorio(corte)` para o resíduo por mês → validação por fora pelo `psql-ro` (query independente das funções). O `claude_ro` não executa as funções (REVOKE de PUBLIC): o relatório em prod sai por `db:aplicar --ensaio` com `RAISE NOTICE`.

## Evidência

- `db/test-pedido-total-liquido-acervo.sh` — `RESULTADO: 68 ok / 0 fail`; `--falsificar`: linha de base verde e `SABOTAGENS: 18 vermelhas / 0 falhas` (classificador, corte, arredondamento, tolerância, ambíguo, líquido negativo, SKIP LOCKED, re-classificação sob lock, coerência, gate de mês e o gate por conta, limite, ensaio que escreve, ACL, pós-condição do conversor). No núcleo de CI.
- `bun run db:aplicar db/aplicar-pedido-total-liquido-rpc.sql --ensaio` em prod: `ENSAIO ok — rodou inteiro e fez ROLLBACK` (sha256 `84ec821f…`) — DDL, as duas postcondições com a ACL real e o ensaio do conversor sobre os 31 mil pedidos.
- Predicado da postcondição pré-voado por `psql-ro` contra o estado antigo: falhou só em "a função não existe".
- `authz:check`, `exclusividade` e shellcheck verdes.

## O que ficou aberto

- **O apply dos dados**, até as pré-condições acima. O que já está pronto: as funções, a prova e o roteiro.
- **Recall:** cabeçalho reescrito depois do corte por quem não muda total (a v1.6 inserindo pedido novo, backfill de cor, write-back do envio) fica fora — hoje 1 pedido. Medir depois do deploy da ingestão v1.7.
- **colacor sem reprocess:** desconto que muda no ERP depois da inserção não chega à linha — lacuna de sync da colacor (vale para status e itens também), não desta passada.
- **Revisão independente** retroativa do código (cota do Codex).
