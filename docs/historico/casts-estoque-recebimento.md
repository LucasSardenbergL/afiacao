# Casts que desligam o tipo — módulo estoque-recebimento (plano v2 · item 4 / I1 · PR 5)

2026-10-20. Quinto PR do item 4 do [plano de melhoria v2](../superpowers/plans/2026-10-18-plano-melhoria-v2/README.md), depois de [casts-pedidos-programados.md](casts-pedidos-programados.md), [casts-reposicao.md](casts-reposicao.md), [casts-governanca-des.md](casts-governanca-des.md) e [casts-admin-crm-tint.md](casts-admin-crm-tint.md). Escopo: os arquivos não-teste do módulo ativo `estoque-recebimento` (manifesto), 8 arquivos e 17 casts `as never`/`as unknown as`. O módulo é offline-first ([estoque-picking-recebimento.md](estoque-picking-recebimento.md)): **nenhum payload da fila de mutação mudou**. `ConfirmPickItemVars` e o handler `picking.confirm-item` estão iguais, e só a chamada da RPC dentro de `confirmPickItem` foi tipada.

## O que os casts escondiam

Conferido na PROD via `psql-ro` (CHECKs, `pg_get_function_arguments`, linhas de `RETURN` das funções, `pg_get_viewdef`) antes de corrigir:

- **Todos os comentários "não está no types gerado" eram falsos de novo.** `confirmar_item_picking`, `ensure_picking_task_for_sales_order`, `listar_pedidos_a_separar`, as 4 RPCs de comando do picking v2 e a view `inventory_position_operacional` estavam no `types.ts`. Os `RpcClient` locais (`rpc(fn: string, …)`) e os 2 `.from('inventory_position_operacional' as never)` só desligavam a checagem.
- **`TarefaV2` afirmava vocabulário que a tabela guarda como texto.** `picking_tarefas.account`/`status` são `string` no `types.ts`. O cast da fila e do `lerTarefa` virava união sem conferir. A borda `src/lib/picking/borda-rpc.ts` (`paraTarefaV2`) guarda os dois contra os CHECKs de prod e **lança** fora deles.
- **O retorno `jsonb` das RPCs de comando era fingido como `ResultadoComando`.** `lerResultadoComando` lê por forma. Em prod todo ramo monta `ok`, então `ok` ausente ou não-booleano lança. As chaves opcionais (`motivo`, `atribuicao_id`, `tarefa_revisao`, `estado_seq`) aceitam ausente ou NULL e lançam com tipo trocado. `data` NULL continua `sem_resposta`: é o replay de evento sem resultado gravado (`NULL || jsonb = NULL`).
- **`rpcComando(nome as "picking_pegar_task", args as never)` desligava os argumentos das 4 RPCs.** Agora cada chamada é tipada pelo nome real. A única diferença de payload é `p_observacao`: `null` virou "chave ausente", o que dá no mesmo porque a função tem `DEFAULT NULL`, conferido em prod.
- **`ensure_picking_task_for_sales_order` → `{task_id, created}` por cast.** `lerEnvioSeparacao` exige os dois. O toast "enviado / já estava em separação" depende de `created`.
- **View `inventory_position_operacional` perde o NOT NULL.** `omie_codigo_produto` (NOT NULL na base e chave da linha na tabela de estoque) é exigido com `linhasCom`. `saldo` é nullable na base (0 nulos hoje, 3.320 linhas) e o `Number(null)` o mostrava como `0.00` em vermelho de "crítico". Agora NULL aparece como "—" (ausente ≠ zero).
- **`navigator.locks`/`navigator.wakeLock`** já são tipados pelo `lib.dom` do TS 5.8. Os casts viraram guarda `in`, porque em contexto não-seguro ou navegador antigo a API não existe em runtime.
- **`Recebimento.tsx`:** o embed `nfe_recebimento_itens`/`cte_associados` resolve pelas FKs do `types.ts`. O tipo de retorno anotado substitui o cast.

## O que ficou

- Teste novo, registrado no manifesto: `src/lib/picking/__tests__/borda-rpc.test.ts`.
- Gate `casts:stale`: baseline `{from: 25, rpc: 29}` → `{from: 23, rpc: 29}`; piso `castsLiterais` **54 → 52** = contagem real.
- O único `as unknown as` restante no módulo é texto de comentário histórico em `recebimento-lotes.ts`.

## Residual deliberado (1 asserção estreita, fora da categoria do item 4)

`src/services/picking-confirm.ts` manda `args as ArgsGerados`. `confirmar_item_picking` não tem DEFAULT e aceita NULL semântico em `p_lote_informado`/`p_justificativa`: sem lote informado não há divergência (`v_div`). O gerador declara os dois como `string`. Esta é a mesma classe do residual do raio-X em [casts-reposicao.md](casts-reposicao.md), mas mais estreita.

- O objeto é checado inteiro contra `ArgsConfirmar = Omit<Args, 2 chaves> & {2 chaves: string | null}`, derivado do `types.ts`. Chave errada, chave faltando e tipo trocado reprovam.
- A asserção só estreita a nulidade dessas duas chaves. É `as X`, não `as never`/`as unknown as`.

Tentado e descartado: uma "porta" `{ rpc(fn, args: ArgsConfirmar) }` à qual o cliente seria atribuível por bivariância de método. Não compila, porque o `rpc` genérico do supabase-js compara `args` estritamente. Isso é bom: era um cast disfarçado.

A forma sem asserção nenhuma exige migration. Seria dar DEFAULT NULL aos dois argumentos, o que obriga DEFAULT também em `p_confirmed_at`, que vem depois, ou reordenar com DROP+CREATE, que reseta o ACL. Mudar o contrato do banco só pela pureza do tipo não compensa.

## Lições

- **Cast de linha de tabela esconde vocabulário de texto.** O gerador tipa `CHECK (x IN (…))` como `string`. Quando o tipo local é uma união, a conversão precisa de guarda na borda, e o cast fazia essa conversão sem conferir nada.
- **`jsonb` de RPC com ramo de replay:** o `NULL || jsonb` do replay devolve NULL. A borda precisa distinguir esse NULL de topo (contrato) de chave ausente dentro do objeto (forma desconhecida, lança).
