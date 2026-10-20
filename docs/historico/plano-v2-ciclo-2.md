# Plano v2 — ciclo 2: casts restantes (I1) e deriva prod ≠ repo (I2)

2026-10-20. Segundo ciclo dos itens 4 e 5 do [plano de melhoria v2](../superpowers/plans/2026-10-18-plano-melhoria-v2/README.md). O ciclo 1 fechou com 16 PRs ([casts-estoque-recebimento.md](casts-estoque-recebimento.md) é o último de casts). Ponto de partida medido na main `61e6e5252`: `casts:stale` = 23 `from` + 29 `rpc`, piso `castsLiterais` 52 (todo cast literal `as never` do `src/` era sobre nome já tipado); `deriva-corpo-baseline.json` = 24 entradas.

## Frente A — casts por módulo (1 PR por módulo ativo)

Mapa de partida (dono pelo `src/lib/modulos/manifesto.ts`):

| Módulo | Status | from | rpc |
|---|---|---|---|
| farmer-inteligencia | ativo | 3 | 6 |
| vendas | ativo | 1 | 4 |
| plataforma | ativo | 2 | 3 |
| financeiro | ativo | 1 | 3 |
| governanca | ativo | 2 | 0 |
| tarefas | congelado | 7 | 2 |
| telefonia-whatsapp-rota | congelado | 3 | 5 |
| knowledge-base | congelado | 3 | 2 |
| loja-afiacao | congelado | 0 | 3 |
| producao | congelado | 1 | 1 |

Os congelados (27 casts) ficam: não se migra sem pedido.

### PR 1 — plataforma (5 → 0; piso 52 → 47)

Foi primeiro, fora da ordem por tamanho, porque é dono de `src/lib/farmer/**`: o helper e o tipo que farmer-inteligencia e vendas consomem nascem aqui.

- **`src/lib/rpc-args.ts` (`comNulo`).** O gerador declara todo argumento de RPC não-nulo, e o argumento com DEFAULT vira opcional sem `| null`. Várias RPCs aceitam NULL semântico ("sem head visto", "sem motivo", margem ausente). O `args as never` desligava o objeto inteiro. `comNulo<'fn', 'p_x'>({…})` reabre `| null` só nas chaves nomeadas e checa o resto contra o `types.ts`. A asserção que sobra estreita só essas chaves, como o residual de `picking-confirm.ts`. Teste de tipo com `@ts-expect-error` (chave não reaberta, chave inventada, chave nomeada omitida).
- **`InsumoLido` virou `type`.** Como `interface`, não tinha a assinatura de índice implícita e o snapshot não era atribuível a `Json`. Era isso que o `as never` do `farmer_geracao_registrar` escondia.
- **`registrarNoLedger` tipa `props` como objeto `Json`.** Era `Record<string, unknown>`, que aceitava valor não serializável e só passava pelo cast.
- **`authz_contract_version`, `farmer_geracao_vigente` e `analytics_ledger_registrar` já estavam no `types.ts`.** Os comentários "entra na próxima regeneração" eram falsos, como nos PRs do ciclo 1.
- **O 5º "cast" era fixture de teste** (`universo-pedidos-ts-gate.test.ts`, string que alimenta outro gate). O `as never` agora vem interpolado para o regex do `casts:stale` não contá-lo.
