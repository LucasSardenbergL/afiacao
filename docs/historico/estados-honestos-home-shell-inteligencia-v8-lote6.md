# Estados honestos na home, no shell e na inteligência (plano v8, lote 6: C13, C14 e C15)

> Plano: [`2026-11-10-plano-melhoria-v8`](../superpowers/plans/2026-11-10-plano-melhoria-v8/README.md) §2 C.
> Precedente: o C11 do v7 ([reposicao-kpis-badge-leitura-v7-lote3.md](reposicao-kpis-badge-leitura-v7-lote3.md)),
> que criou o contrato de 3 faces `faceDoBadge`. Só front: **Publish** (do founder), sem edge e sem migration.

## O que mudou

- **C13, HOME-DELTA-FANTASMA** (`src/hooks/dashboard/useBriefDeltas.ts`). O delta "aumentos
  anunciados" saiu. Ele filtrava `eventos_outlier` por `created_at`, coluna que a tabela não tem
  (`detectado_em`/`data_evento`), então toda carga da home fazia um request 400. E o que ele contava
  eram outliers, não aumentos. Apontar para `fornecedor_aumento_anunciado` não valia a pena: a
  tabela tem 0 linhas, e essa superfície nunca foi usada. Os outros 3 deltas (pedidos, NF,
  orçamentos) agora leem o `error` e tratam `count` nulo como falha (ausente ≠ zero). A falha vai
  para `falhas`, e a `DeltasStrip` mostra "Não foi possível verificar X" (âncora
  `data-testid="deltas-falha"`) **em vez de** "Sem mudanças desde sua última visita". Se houver
  novidade, mostra os bullets e o aviso juntos.
- **C14, SHELL-BADGES-ERRO-ZERO.** As 4 queries que faziam `return count ?? 0` dentro do `AppShell`
  (pedidos pendentes de aprovação, aumentos ativos, negociação paralela e notificações) foram para
  `src/components/shell/useContagensDoShell.ts`. Os hooks **lançam** no erro e no `count` nulo, que
  é a pré-condição do `faceDoBadge`. O shell aplica o contrato de 3 faces (número / oculto / "?") com
  `primitivosDoBadge` (helper novo em `badge-de-contagem.ts`, que devolve os dois primitivos do item
  da nav e não quebra o memo, como no C8 do v4). As queryKeys e os intervalos de poll não mudaram.
  - `useNotificacoes.ts`: `total7d`, `taxaSucesso` e `esgotados` passam a ser `number | null`. Sem
    leitura, a `StatsTab` mostra "—" e o `<AvisoLeituraFalhou testId="stats-notificacoes-sem-leitura">`.
    Com dado antigo em cache, os números ficam e o aviso aparece. Sem notificação concluída no
    período, a taxa é `null`, porque "0%" afirmaria "tudo falhou". Sem leitura, o gráfico fica vazio
    em vez de mostrar 30 barras zeradas.
  - `useRevisaoParametros.ts`: o `error` de `v_sku_parametros_sugeridos` sobe como
    `precosIndisponiveis`. As linhas base continuam, porque vêm de outra leitura, e a tela ganha um
    aviso inline. Na mesma linha, a falha da leitura **principal** (`sku_parametros`) dava
    "Nenhum SKU encontrado". Agora sobe como `leituraSemLeitura` (aviso em bloco, e a tabela troca o
    vazio pela referência ao aviso).
- **C15, INTEL-CAC-LTV-FABRICADO** (`IntelligenceStrategicTab.tsx`). Os cards "LTV Projetado (3a)"
  e "CAC Estimado" foram removidos. O CAC era Σ(intervalo de recompra × 0,1 h) × R$ 50/h, com
  constantes inventadas e nenhum dado de aquisição. O LTV era gasto médio × 36, com `Number(x || 0)`
  puxando a média para baixo. Nenhum dos dois é medido. A linha de KPIs estratégicos ficou com
  Concentração e Margem Bruta.

## Fora do escopo (de propósito)

- A truncagem do `useNotificacoes` (`.limit(5000)` sem `.order`): `fornecedor_alerta` tem 104
  linhas em 30 dias.
- O "Market Share Est." da mesma aba (`estimatedMarket` no código) é da mesma família do C15, mas
  não estava no plano.

## Evidência

Testes novos (cada um com o seu CONTROLE de leitura boa): `useBriefDeltas.leitura`,
`DeltasStrip.falha`, `useContagensDoShell.badge-leitura` (os 4 hooks × 3 casos, mais o helper),
`useNotificacoes.stats-leitura`, `useRevisaoParametros.leitura`, e os casos novos em `StatsTab.test`
e `tabs-erro-honesto` (LTV/CAC ausentes no mesmo render em que Concentração aparece). A falsificação
(sabotar cada conserto e exigir vermelho, nos dois locales) está no corpo do PR.
