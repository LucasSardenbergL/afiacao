# fin-valor-cockpit: as 4 leituras de apoio em paralelo (2026-11-03)

Lote 5 do plano v5 (item VAL-IO; contestação do Codex em `anexos/codex-contestacao.md`).

## Problema

A edge `fin-valor-cockpit` lia quatro mapas de apoio em série: o vínculo do cliente (`omie_customer_account_map_fresco`), o nome (`profiles`), o custo por produto (`product_costs`) e o valor de estoque por SKU (`inventory_position`). Os filtros são independentes, mas cada leitura só começava depois de a anterior paginar até o fim.

Volumes medidos com psql-ro em 2026-11-03: 15.790 vínculos oben, 16.074 profiles, 3.806 custos e 1.772 linhas de estoque. Com o `fetchAll` (página de 1.000 e EOF observado numa página vazia), isso dá 17 + 18 + 5 + 3 = **43 requisições em série**. Em paralelo, a espera passa a ser a da fonte mais lenta. Pela contagem, são as 18 requisições de profiles, mas a latência real decide qual fonte é a mais lenta.

## O que mudou

`mapas-apoio.ts` dispara as quatro `fetchAll` num `Promise.all`. Os laços de processamento do `index.ts` não mudaram.

**O que NÃO muda** (contestação do Codex):
- **Paginação:** cada fonte continua no `fetchAll`, e um erro em qualquer página lança.
- **Falha integral:** a primeira falha rejeita o conjunto na hora. Nenhum mapa sai vazio no lugar de um erro, e nada é calculado com 3 de 4 mapas. O handler responde 500, sem payload parcial. Uma rejeição tardia de outra leitura não vira `unhandledrejection`, porque o `Promise.all` trata todas (o Codex confirmou isso no Deno).
- **Não é snapshot transacional.** São quatro requisições PostgREST, como antes. O TTL de 7 dias da view continua avaliado por página.

**Efeitos observáveis:**
- O erro exposto passa a ser o primeiro no tempo, e não o da primeira leitura da lista.
- O warning de custo legado só aparece depois que o estoque também termina.
- O pico de conexões por invocação sobe de 1 para até 4.
- `Promise.all` não cancela as outras paginações quando uma falha.

Não há evidência de que isso sature o pool. Se aparecer, a assinatura é `PGRST003` (espera de conexão), não `57014`.

## Prova

- 6 testes Deno em `mapas-apoio.test.ts`:
  - as 4 leituras começam antes de qualquer uma terminar;
  - paginação em todas as fontes (mais de 1.000 linhas em cada);
  - 2.345 linhas de uma fonte voltam inteiras;
  - falha em cada fonte rejeita com a `fonte` certa;
  - falha na 2ª página derruba o conjunto;
  - a falha rejeita sem esperar as outras leituras.
- Falsificação: 7 sabotagens × 2 locales, **14/14 vermelhas**, com controle verde na mesma invocação:
  - `await` dentro do array (série);
  - `.catch(() => [])` no estoque;
  - rótulo trocado;
  - só a 1ª página;
  - estoque truncado em 1.000;
  - clientes truncados em 1.000;
  - `allSettled`, que espera todas antes de relançar.

  As três últimas sobreviviam à suíte original (achado do Codex).
- Gates verdes: `edges:typecheck`, `edges:sintaxe`, `sonda:bump` (`VERSAO v1.9-mapas-apoio-paralelos`) e `sonda:fingerprint`.
- Codex (`-r high`): **APROVAR**, sem P0/P1. Os dois P2 (comentário "até a curta" errado e cobertura) estão aplicados.

## Deploy

Só edge (`fin-valor-cockpit`), feito pelo founder no Lovable. Quem decide se há deploy é o `bun run pendencias:deploy`; a sonda confirma `VERSAO v1.9-mapas-apoio-paralelos`.
