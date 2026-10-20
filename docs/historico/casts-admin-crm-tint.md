# Casts que desligam o tipo — módulos admin-crm e tintométrico (plano v2 · item 4 / I1 · PR 4)

2026-10-20. Quarto PR do item 4 do [plano de melhoria v2](../superpowers/plans/2026-10-18-plano-melhoria-v2/README.md), depois de [casts-pedidos-programados.md](casts-pedidos-programados.md), [casts-reposicao.md](casts-reposicao.md) e [casts-governanca-des.md](casts-governanca-des.md). Escopo: os arquivos não-teste dos módulos ativos `admin-crm` (6 arquivos, 11 casts) e `tintometrico` (4 arquivos, 15 casts) que tinham `as never`, `as unknown as X` ou o wrapper `supabase as unknown as {...}`.

## O que os casts escondiam

Conferido na PROD via `psql-ro` (read-only, catálogo e `pg_get_functiondef`) antes de corrigir:

- **`Admin.tsx` pedia um join que não existe.** A lista de pedidos do Kanban selecionava `profiles!orders_user_id_fkey(...)`. Em prod, `orders` tem **0 foreign keys** (e o `types.ts` diz `Relationships: []`): o embed falhava sempre com 400 e a tela vivia no caminho de fallback, cujos erros eram descartados. O `as unknown as OrderWithProfile[]` escondia o join impossível. Agora a tela carrega pedidos e perfis à parte, tipados por `Tables<'orders'>`/`Tables<'profiles'>`, e erro de leitura vira toast em vez de Kanban vazio calado. A tabela `orders` está com 0 linhas em prod, então nenhum usuário viu número errado.
- **As RPCs de preço do tint devolvem NULL onde o tipo local dizia número.** `get_tint_price`/`get_tint_prices` devolvem `custoBase` e `custoCorantes` **NULL fora do staff** (gate de custo, P1 `20260708234100`). O cast para `TintPriceBreakdown` afirmava `custoCorantes: number`. Agora há uma borda só, `src/lib/tint/preco-rpc.ts`, que lê o `jsonb` campo a campo e **lança** em qualquer desvio de forma. O lançamento cai no `isError` do react-query e o balcão fica sem preço (fail-closed, mesmo contrato do erro de rede). `precoFinal` em texto não vira `Number()`.
- **4 `.rpc('x' as never)` sobre RPCs que já estavam no `types.ts`:** `register_carteira_member`, `get_tint_price`, `get_tint_prices` e `tint_ultimo_preco_cliente`. Os comentários "RPC nova ainda fora do types.ts" sobreviveram à regeneração, como os "temporários" do PR 3.
- **Wrappers `supabase as unknown as { from(t: string) … }` em `useClientesNaoVinculados`/`useExportNaoVinculados`** com o comentário "view nova não está no types.ts". `v_clientes_nao_vinculados_atual` e `omie_nao_vinculados_state` já estavam lá. A view perde o NOT NULL, então `id`/`omie_codigo_cliente` são exigidos na borda com `linhasCom` (linha sem chave não entra no CSV, nunca "0" na coluna `codigo_omie`).
- **`customer_processes.etapas` (jsonb) e `porte` (texto)** eram fingidos como `ProcessEtapa[]` e union de porte. Em prod a tabela está vazia, então não há dado divergente. A borda `src/lib/customer-process/linha.ts` lê a etapa por forma e guarda os vocabulários de `tipo` e `porte`, lançando fora deles. No insert, `ProcessEtapa` virou `type` (não `interface`) para ser atribuível a `Json` sem cast.
- **Embeds tipados que não precisavam de cast:** `user_tools → tool_categories` (FK NOT NULL; `!inner` dá a categoria não-nula; a policy de `tool_categories` é `true` para todos, então o conjunto não muda), `tint_skus → tint_bases`, `tint_formula_itens → tint_corantes`, `omie_products` paginado. `TintPricing` deriva `TintSkuRow` do retorno do próprio hook.

## O que ficou

- Testes novos, registrados no manifesto: `src/lib/tint/__tests__/preco-rpc.test.ts` e `src/lib/customer-process/__tests__/linha.test.ts`.
- Gate `casts:stale`: baseline `{from: 25, rpc: 33}` → `{from: 25, rpc: 29}`; piso `castsLiterais` **58 → 54** = contagem real.

## Lições

- **Comentário de cast "temporário" é dívida sem sensor.** Os 4 `.rpc(... as never)` e os 2 wrappers tinham justificativa por escrito, todas falsas desde a regeneração do `types.ts`. Antes de manter um cast, confira o nome no `types.ts`, não o comentário.
- **Cast de retorno de RPC `jsonb` esconde o gate de staff.** Quando a RPC devolve campos diferentes por papel, o tipo local precisa dizer `| null` e a borda precisa ler por forma. O cast transformava "oculto" em "número".
- **Join que sempre falha não aparece com fallback silencioso.** O caminho de erro do `Admin.tsx` funcionava, então ninguém notou que o caminho principal nunca rodou. O typecheck só apontou depois que o cast saiu.
