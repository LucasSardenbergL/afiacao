# Web-vitals também pelo nosso banco (plano v4, lote 0b)

**2026-11-02.** Migration `supabase/migrations/20261102093527_telemetria_vitals.sql`, prova
`db/test-telemetria-vitals.sh` (PG17, 27 asserts, 6 falsificações, no núcleo do CI). Cliente em
`src/lib/analytics-vitals.ts` (`criarCanoBanco`).

## Por que existe

O lote 0 (#3507) manda `app.vitals` só ao PostHog. Medido em 7 dias: o aparelho `1aedeba2…` fez 103
boots em `telemetria_probes` (nosso banco) e **0** `telemetria.probe` no PostHog; os outros 3
aparelhos chegam 100%. É o aparelho mais usado (103 de 155 boots). Só pelo PostHog, a linha de base
de velocidade sairia da minoria do uso. O `analytics_ledger` não serve: deduplica por
chave/titular/dia, e uma linha por dia não dá p75.

## Desenho

- 1 linha por instância de métrica, chave `(user_id, metrica_id)`. INP/CLS podem sair 2× na mesma
  carga; o cliente faz UPSERT e a linha fica com o último valor (o `argMax` da query do PostHog).
- Pelo client oficial do supabase, não por `fetch keepalive`: INP/CLS saem no `hidden`, com a
  página viva, e é esse o caminho que o `useLastVisit` mediu entregando. O keepalive cru mediu não
  entregando.
- Mesmo gate do `track()` (`telemetriaAtiva()`): em DEV o `.env` aponta para o banco de produção.
- Fail-open: falha vira `logger.warn`, nunca erro na tela. Lente "ver como" e tela sem sessão não
  gravam.
- `device_id` é o mesmo do `telemetria_probes`, e é ele que separa o aparelho que o PostHog não vê.

## O que a falsificação ensinou

No `INSERT … ON CONFLICT DO UPDATE` o Postgres aplica a policy de **SELECT** também à linha nova, e
no `UPDATE … WHERE` também. A 1ª versão da prova sabotava a policy de INSERT e a de UPDATE e as
duas seguiam **verdes**: a de SELECT barrava sozinha. Cada policy só tem dente próprio no ataque
que não passa pela de SELECT: INSERT puro (sem ON CONFLICT) para a de INSERT; UPDATE sem WHERE e
com SET constante para a de UPDATE. Também por isso a policy de SELECT própria é obrigatória: sem
ela o upsert do próprio usuário falha (F3).

## Query do p75 (banco)

```sql
SELECT rota, metrica, count(*) AS amostras, count(DISTINCT user_id) AS usuarios,
       count(DISTINCT device_id) AS aparelhos,
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY valor)::numeric, 3) AS p75
FROM public.telemetria_vitals
WHERE criado_em > now() - interval '7 days'
GROUP BY rota, metrica
ORDER BY metrica, p75 DESC;
```

Para comparar builds, acrescente `AND build_id = '<entry do build>'`. O PostHog usa `quantile`
(aproximado); aqui é `percentile_cont` (exato, interpolado). Com poucas amostras os dois divergem.

## Retenção

180 dias, escrita no `COMMENT ON TABLE`. Ainda não há expurgo automático: o volume é ~5 linhas por
carga de página.
