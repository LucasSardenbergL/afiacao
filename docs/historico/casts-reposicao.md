# Casts que desligam o tipo — módulo reposição (plano v2 · item 4 / I1 · PR 2 de 2)

2026-10-18. Segundo PR do item 4 do [plano de melhoria v2](../superpowers/plans/2026-10-18-plano-melhoria-v2/README.md); o primeiro foi [casts-pedidos-programados.md](casts-pedidos-programados.md). Escopo: todo arquivo não-teste do módulo `reposicao` (manifesto: `src/components/reposicao/**`, `src/pages/AdminReposicao*.tsx`, `src/hooks/useParamAutoMudancas.ts`, `src/lib/reposicao/**`) — 33 arquivos, 132 casts (`as never` sobre literal/variável/payload e `as unknown as X` de retorno).

## Método

1. Passada **mecânica** (script no scratchpad da sessão, não versionado): tira `as never` e `as unknown as <tipo balanceado>` (inclusive multi-linha) de todos os arquivos da lista; o typecheck passa a ver as colunas reais e aponta o que o cast escondia.
2. Cada erro do `tsc` é tratado na origem: interface local divergente do `types.ts` → deriva de `Tables<>`/`Returns`, ou mapeia na borda (`Number()` para numeric que chega string).
3. Gate `casts:stale`: baseline `{from: 49, rpc: 47}` → `{from: 30, rpc: 35}` (os 2 rpc de `fin_*` saíram pelo #3153 no meio do caminho); piso `castsLiterais` **40 → 65** = contagem real. A sincronização com a main provou o ratchet: com o piso em 67 e 65 casts na árvore, o gate acusou `CEGO` até o piso descer. A partir daqui o piso é ratchet junto com a baseline: remover cast exige baixar o piso no mesmo PR.

## O que os casts escondiam (achados do typecheck)

Conferido na PROD via `psql-ro` (2026-10-18) antes de corrigir — o `types.ts` estava certo, o código errado:

- **`AdminReposicaoAlertas` (drill de outlier):** três queries quebradas em runtime (400 do PostgREST) desde que nasceram, todas com `as never`/`as unknown as` e uma delas descartando o `error`:
  - lista de grupos selecionava `codigo_grupo`; a coluna de `fornecedor_grupo_producao` é **`grupo_codigo`**;
  - `insert` em `sku_grupo_producao` mandava `fornecedor_grupo_id`/`fornecedor_nome`/`codigo_grupo`; a tabela tem só `(empresa, sku_codigo_omie, grupo_codigo)` — "Atribuir grupo" nunca gravou;
  - painel do SKU lia `demanda_sigma_diario`/`preco_compra_real` de `sku_parametros`, que não tem essas colunas (vivem em `v_sku_parametros_sugeridos`); o `error` era descartado e o painel ficava vazio em silêncio. Fonte trocada para a view (`lead_time_medio` = LT médio em dias úteis aplicado pelo motor).
- **`SkuDetailSheet`:** select concatenado com `+` → `GenericStringError` (mesma lição do PR 1); `ViewStats` tinha `dias_seguranca`, coluna que nunca entrou no select — removida do tipo.
- **Views são `| null` em tudo:** `SkuCompliance`, `Sugestao`, `Oportunidade`, `SkuAfetado`, `ItemEfetivo`, `SkuSemFornecedor` declaravam colunas não-nulas que o banco não garante. Agora derivam de `Tables<'v_…'>` e a borda exige as colunas-chave com `linhasCom`/`exigirColunas` (`src/lib/reposicao/linha-view.ts`, lança nomeando fonte e coluna) e estreita enums por guarda (`ehSlaStatus`, `ehStatusSugestao`, `ehCenario`) — valor fora do vocabulário vira erro visível, não card inventado. `aumentos_json` (jsonb) é lido por forma (`aumentosDe`), não por cast.
- **`useCadeiaLogistica`:** `valores_anteriores/novos` recebiam `Record<string, unknown>` (não é `Json`); o insert de etapa aceitava `descricao`/`lt_dias` ausentes (`Partial<Etapa>`) — agora lança antes de gravar.
- **`Campanha`, `ItemRow`, `Evento`, `Aumento`, `Etapa`:** `criado_em`/`ativo` são `| null` no banco; os tipos locais diziam não-nulo. Passaram a ser `Tables<'…'>`.
- **Raio-X (`useRaioX`):** caso inverso — o `Returns` gerado da RPC declara TUDO não-nulo e todo texto como `string`, e o domínio em `src/lib/reposicao/raio-x/tipos.ts` é o honesto (nullables, unions `Destino`/`Categoria`). O `as unknown as Pagina<FatoSku>` fazia a conversão às cegas; agora `raio-x/borda.ts` (`comoFatoSku`/`comoDecisaoRow`/`comoLinhaManual`/`comoLinhaMedicao`, com teste) estreita destino/origem/empresa/categoria por guarda e lê `clientes` (jsonb) por forma — cliente torto lança em vez de virar fantasma.
- **`TendenciaIcon`:** a view entrega `tendencia` nula; o ícone recebia `Tendencia` e o cast fazia o `null` cair no ramo "estável". Agora `null` = sem ícone.
- **`useParamAutoMudancas`:** RPCs `reverter_*`/`despinar_parametro` já tinham `Args`/`Returns` no types — os `as unknown as { data…; error… }` só repetiam (às vezes errado) o que o gerador já dizia.

## Residual deliberado (2 casts, fora da medição do gate)

`src/components/reposicao/raioX/useRaioXMutacoes.ts`: `as unknown as Fns['raio_x_decidir']['Args']` e `['raio_x_contar']['Args']`. O gerador do Supabase declara **todo** argumento de função como não-nulo, mas a RPC (migration 20261016120000, sem DEFAULT) aceita NULL em destino/observação/fornecedor/crédito. Não há forma tipada de passar NULL; não é cast sobre nome. Comentado no código.

## Lições

- `fetchAllPages<T>(…)` **não precisa de cast**: o builder do supabase-js já é `PromiseLike<{ data: Row[] | null; error }>` e `T` sai da inferência do select. O `as unknown as PromiseLike<…>` só servia para impor uma interface local — o exemplo da doc em `src/lib/postgrest.ts` ensinava o cast e foi corrigido.
- `SelectItem value` é string: o `as unknown as string` sobre um id numérico escondia que o valor voltava como número pelo `onValueChange` e a comparação `g.id === grupoEscolhido` só funcionava por acidente de runtime; agora o id vai como texto e a comparação é por texto.
- Cast sobre **variável** (`.from(VIEW as never)`) e sobre payload (`.insert({...} as never)`) não aparecem no `casts:stale` — o gate conta só literal; a varredura por módulo é o único jeito de achá-los.
