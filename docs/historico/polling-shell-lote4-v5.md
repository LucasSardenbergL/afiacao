# Polling do shell staff: dedup feita, RPC única descartada (plano v5, lote 4 — F4)

Plano: `docs/superpowers/plans/2026-11-03-plano-melhoria-v5/README.md` (F4). Entrega: #3562 (mergeado e
publicado em 2026-11-03). O mesmo PR levou o BND (laço de trios do motor de cestas, sem leitor).

## Fatia 1 — feita

`AppShell` (`['outlier-pendentes-count']`) e `useAlertasCriticos` (`['alertas-criticos-count']`) faziam a
MESMA contagem em `eventos_outlier` (mesmos 60 s, mesmo `staleTime` de 30 s). Agora os dois badges leem
`useAlertasCriticos` sob `CHAVE_OUTLIER_PENDENTES_COUNT`, e `AdminReposicaoAlertas` invalida pela constante:
o badge destrutivo de `/sessao/parametros` passou a acompanhar a resolução (antes, só o de `/alertas`).
Staff com a aba em foco: **~9,6 → ~8,6 req/min** (master: ~10,6 → ~9,6), contado pelo código.

## Fase 2 (RPC `shell_contadores()`) — descartada pelo founder em 2026-11-03, com medição

| Medida | Valor | Fonte |
|---|---|---|
| Custo das contagens no banco | nenhuma entra no top 20 (piso ~85 s somados em 61 h) | top 20 do `pg_stat_statements` em [consultas-pesadas-lote9.md](consultas-pesadas-lote9.md) |
| Abas staff em foco | `get_data_health()` (120 s, só com a aba em foco): 249 chamadas em 61 h (~4/h) | idem |
| Uso pelo master | `melhoria_itens`: ~840 scans em ~86 h (só o badge do master lê) ≈ 14 h de aba em foco em 3,5 dias | `pg_stat_user_tables` desde o restart de 2026-10-31 10:33 UTC, lido via `psql-ro` |

**Por que não:** a RPC rodaria as mesmas contagens, então o banco não ganha nada. O ganho seria só de
chamadas HTTP no navegador (~8,6 → ~3 req/min por aba em foco, com pedidos em 30 s e tint em 5 min fora
dela para não mudar o frescor), e o volume real é de 1 a 2 abas. O custo seria uma migration manual, a
2ª opinião do Codex que o plano exige, isolar a falha de cada contador em PL/pgSQL e religar as telas que
compartilham cache com o shell (`AdminReposicaoOportunidades` usa a chave da contagem de negociação;
`AdminReposicaoAlertas` invalida a de outliers; `useOportunidadesAtivasCount` é usado fora do shell).

**Reabrir se:** o número de abas staff em foco crescer muito (refaça a conta pelo `get_data_health()` no
`pg_stat_statements`, que o founder roda no SQL Editor) ou alguma contagem de badge entrar no top 20.
