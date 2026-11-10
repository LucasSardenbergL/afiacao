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

## Aplicação (2026-11-02)

- **Aplicada pela sessão via `db:aplicar`** antes do merge (a ordem é DDL → Publish): ensaio ok
  (ROLLBACK), depois tentativa **#861** → recibo (sha `4dc5bb14…`, commit `f335a8717`).
- **2ª testemunha (psql-ro):** RLS ligada, as 4 policies (insert/update/select próprios +
  service_role), trigger de carimbo, PK `(user_id, metrica_id)`, 0 linhas.

## Desfecho (2026-11-02)

- PR #3521 mergeado às 12:00 UTC (`7ff3068e`); o ar passou a servir a main (`f162f19d`, entry
  `index-BSTKUhBH`, que contém `telemetria_vitals`).
- **Canal imune provado:** o aparelho `1aedeba2` (0 eventos no PostHog) gravou CLS, FCP, LCP e TTFB a
  partir das 16:06 UTC, no build `index-C460KMMi`. Era a fatia do uso que a linha de base não via.

## Retenção

180 dias, escrita no `COMMENT ON TABLE`. Ainda não há expurgo automático: o volume é ~5 linhas por
carga de página.

## Leitura dos lotes de tela (plano v7, §0): 2026-11-10

Leitura em 2026-11-10 19:41 UTC (`psql-ro -v ON_ERROR_STOP=1`, rc 0, marcador `FIM_OK`). "Lotes de tela" são os
PRs de tela do v6, no ar a partir do build de 2026-11-05 14:27:19Z (`5ab78cba`, §0 do plano v7).

**Veredito: 🟡 amostra insuficiente.** O sensor mede o founder, não o uso.

| denominador | valor |
|---|---|
| linhas | 542 (02/11 16:06 → 10/11 19:33) |
| `user_id` distintos | **1**, papel `master` |
| aparelhos | 3: `1aedeba2` 405 linhas e 60 builds · `fa401591` 102 e 11 · `a90b7e30` 35 e 7 |
| builds | 78, com vida mediana de **52 min** entre um build e o seguinte (máx. 19 h 25) |
| maior amostra de UMA métrica num build | 11 (TTFB); CLS e LCP 5; FCP e INP 7 |
| builds com ≥ 30 linhas (todas as métricas) | 0 |

**Build adotado:** todo build da tabela foi carregado de verdade (a linha só nasce na carga), mas por uma pessoa
só, que troca de build a cada ~1 h. Com no máximo 11 amostras de uma métrica por build, o p75 de um build é
ruído. O corte por build não fecha.

**Antes/depois do build de 05/11 14:27Z** (pela 1ª aparição de cada build), só para registro:

| métrica | antes: n · p75 | depois: n · p75 |
|---|---|---|
| CLS | 20 · 0,345 | 37 · 0,239 |
| FCP (ms) | 39 · 4.074 | 63 · 3.324 |
| INP (ms) | 19 · 172 | 41 · 128 |
| LCP (ms) | 29 · 6.312 | 49 · 4.032 |
| TTFB (ms) | 94 · 1.960 | 151 · 1.643 |

**Isto não é tendência.** O TTFB é o controle: é tempo de servidor e rede, nenhum PR de tela mexe nele, e ele
caiu 16%. A queda das métricas de tela tem o mesmo sinal e a mesma ordem de grandeza, então o mix (rede, rota,
aparelho, recarga × navegação) explica o movimento tanto quanto o código. No aparelho `1aedeba2` sozinho, o
padrão se repete (TTFB 2.194 → 1.815).

Nota de leitura: `metrica` é minúscula (`cls`, `fcp`, `inp`, `lcp`, `ttfb`) e `classificacao` é
`bom`/`melhorar`/`ruim`. Filtro por `'good'` ou `'LCP'` volta 0 linhas sem erro.

**O que fica:** os itens F do v7 valem pelo laboratório antes/depois (§0, linha "sensores de uso continuam com
1 usuário"), e este sensor não substitui o laboratório. Reler só quando houver **≥ 3 `user_id` fora do staff**
na janela de 7 dias. Uma data nova não traz amostra:

```sql
SELECT count(DISTINCT v.user_id) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM public.user_roles r
          WHERE r.user_id = v.user_id AND r.role IN ('master', 'employee'))) AS usuarios_fora_do_staff,
       count(DISTINCT v.user_id) AS usuarios, count(*) AS linhas
  FROM public.telemetria_vitals v
 WHERE v.criado_em > now() - interval '7 days';
```
