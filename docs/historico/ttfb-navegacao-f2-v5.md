# F2 do plano v5: o sensor tem 1 usuário porque o app tem 1 usuário, e o TTFB alto vem da abertura fria

**Data:** 2026-11-16 · **Área:** web-vitals (`telemetria_vitals`), SW ponte (`src/sw/sw.ts`) · **Money-path:** não · **PR:** só docs, nenhum código mudou.

Fecha o item F2 do [plano v5](../superpowers/plans/2026-11-03-plano-melhoria-v5/README.md) §2 F ("TTFB de navegação 1,5 s").
Os planos v6 e v7 deixaram o F2 aberto com "reabre com amostra de mais de 1 usuário".

## 1. Cobertura: não é defeito do sensor

O ponto de partida era `telemetria_vitals` com **1 `user_id`** em todas as métricas desde 02/11. Em duas semanas, isso parecia defeito de cobertura.
Não é. **Só 1 pessoa usa o app em produção.** Medido em 2026-11-16:

| Fonte (prod) | Desde 02/11 | Leitura |
|---|---|---|
| `auth.users.last_sign_in_at` (conector Lovable) | **1** conta logou (o `master`). Os 2 `employee` e as 16.087 contas `customer` não logaram nenhuma vez, nem desde 01/08 | as 16.087 são todas `@placeholder.local` (aliases fiscais de import, `database.md` §5) |
| `auth.sessions` com refresh desde 02/11 | **1** usuário (o `master`, último refresh 15/11 23:08 UTC) | descarta sessão antiga viva que o `last_sign_in_at` não mostraria |
| `dashboard_visits` | 1 usuário. Os 2 `employee` têm **0 visitas na história** | |
| `telemetria_probes` (outro sensor, outro writer) | 1 usuário, 328 boots | |
| `analytics_outbox` com `user_id` | 1 usuário. Os 240 eventos sem `user_id` são do cron de reposição | |
| `picking_events`, `push_subscriptions`, `webauthn_credentials`, `ia_uso_evento`, `radar_card_exibicoes` | **0** usuários | |

As 4 hipóteses de defeito, uma por uma:

1. **Gate no front:** refutada. `iniciarVitals()` (`src/lib/analytics-vitals.ts`) só exige `telemetriaAtiva()` = `VITE_POSTHOG_KEY` presente e build não-DEV. Não há persona, `isMaster`, amostragem nem flag. Só a lente "ver como" e a tela sem sessão (`sem_usuario`) deixam de gravar, e as duas são de propósito.
2. **RLS ou GRANT:** refutada. Em `pg_policies` da prod, o INSERT exige só `auth.uid() = user_id` mais a janela do `criado_em`, sem papel. `has_table_privilege` dá INSERT/UPDATE/SELECT para `authenticated` (e `anon`, barrado pela policy). A prova PG17 `db/test-telemetria-vitals.sh` grava e lê como um `authenticated` comum, sem `user_roles`: **27 ok / 0 fail, 6 falsificações vermelhas, exit 0** (rodada hoje).
3. **Erro silencioso no envio:** não se aplica. Para o único usuário que existe, a série tem 308 TTFB contra 328 boots em `telemetria_probes` (94%). A diferença cabe nas cargas em `/auth`, onde ainda não há sessão.
4. **SW servindo build sem o sensor:** não se aplica, porque não existem outros usuários para estarem num build velho.

**Lição:** a premissa "o app tem dezenas de usuários" contava **contas**, não pessoas. Antes de suspeitar da cobertura de um sensor, o denominador é `auth.sessions` (refresh no período), e não `user_roles`.

## 2. O TTFB: de onde vem o 1,5 s

Série inteira (02/11 a 15/11, `psql-ro`): 308 TTFB, 5 `device_id`, 92 builds. p25/p50/p75/p90 = 937 / 1.345 / 1.890 / 2.352 ms.

### O tipo de navegação explica tudo

| `navegacao` | n | p50 | p75 | ≤ 100 ms |
|---|---|---|---|---|
| `navegacao` (abertura: ícone, link, aba nova) | 275 | 1.475 | 1.951 | 4 |
| `recarga` | 23 | **5** | 17 | 20 |
| `voltar_avancar` | 7 | 238 | 265 | 1 |
| `prerender` | 3 | 0 | 0 | 3 |

O PostHog, que só vê os aparelhos sem bloqueador, confirma em todos os navegadores. Recarga no Mobile Safari: p50 4 ms. Recarga no Chrome: p50 18 ms. Abertura no Mobile Safari: p50 393 ms. Abertura no Chrome, Firefox e Edge: 470 a 540 ms. **Com o SW quente, o cache-first funciona** (`sw.ts:269-273`). O que é lento é a abertura fria.

### Um aparelho é 84% da amostra e nunca sai do cache

| `device_id` | conexão | TTFB | p50 | ≤ 100 ms | tipos |
|---|---|---|---|---|---|
| `1aedeba2` (02 a 11/11) | 4g | 204 | 1.500 | **0** | só `navegacao` |
| `c5ab56c7` (11 a 15/11) | 4g | 56 | 1.542 | **0** | só `navegacao` |
| `fa401591` (iPhone Safari, `conexao` nula) | — | 38 | 90 | 20 | as 4 |
| `a90b7e30` (Chrome) | 4g | 9 | 16 | 8 | recarga/prerender |

O `1aedeba2` sai de cena no mesmo dia em que o `c5ab56c7` aparece, com o mesmo perfil. É quase certamente o mesmo navegador com o `localStorage` renovado.
É o aparelho que bloqueia o PostHog ([vitals-pelo-banco.md](vitals-pelo-banco.md)), e ele nunca recarrega, só abre. Mesmo em `/`, aberto 112 vezes, nenhum TTFB ficou em 100 ms ou menos.

### Medido por fora: quanto custa cada caminho

No navegador embutido do app desktop (Chromium, Mac do founder, borda GRU do Cloudflare), lendo `PerformanceNavigationTiming`:

| caminho | TTFB | `transferSize` |
|---|---|---|
| 1ª visita (sem SW, rede fria) | **1.078 ms** | 4.981 B (rede) |
| aba nova, SW quente, release promovida | **17 ms** | 0 (SW) |
| aba nova após ~75 s ocioso (SW frio, `workerStart` 88 ms) | **239 ms** | 0 (SW) |

`curl` ao HTML de prod (`cache-control: no-cache, must-revalidate`):

- 1ª conexão fria: TTFB **1,33 s**, com ~1 s de servidor depois do TLS;
- conexões seguintes (processo novo, TLS novo): **92 a 295 ms**;
- após 150 s ociosos (6 amostras, 05:54 a 06:07 BRT de 16/11): **312 / 550 / 603 / 1.128 / 1.049 / 1.241 ms**. Os ~1,0 a 1,2 s depois do TLS são do servidor.

O HTML pela rede só é rápido logo depois de outro pedido. Após alguns minutos parado, volta a custar ~0,5 a 1,2 s mesmo num Mac cabeado. Abrir o app depois de um tempo sem uso é exatamente esse caso.

### Veredito

O 1,5 s **não** vem de release não promovida em geral, e não vem do caminho cache-first, que custa 17 ms quente e ~240 ms frio.
Ele vem das **aberturas frias de um único navegador**, cujo número (1,2 a 1,5 s, zero abaixo de 100 ms) bate com o caminho de **rede fria** (1,08 a 1,33 s medidos).

Com as colunas que o sensor tem, **não dá para provar** se esse navegador busca o HTML na rede (SW sem controle ou sem release promovida) ou se tem um boot de SW muito mais lento que o Mac.
Falta `transferSize`/`workerStart` por linha. Instalar isso seria sensor novo, e a regra pede incidente.

**O que fazer: nada no código agora, com número.** São 260 amostras de **1 pessoa** num caminho (abertura fria), em que o mesmo app mede 4 a 18 ms ao recarregar e 90 ms de p50 no iPhone.
Não existe 2º usuário cuja experiência a mudança melhoraria. Mexer no SW, que já prendeu um iPhone por 9 dias, para servir 1 navegador seria trocar risco real por ganho de 1 pessoa sem diagnóstico fechado.

**Se o founder quiser fechar a dúvida no próprio navegador (1 minuto, sem sensor):** no Chrome em que abre o app, DevTools → Network → abrir o app numa aba nova.
Se o documento mostra `(ServiceWorker)` na coluna Size, é SW frio. Se mostra bytes, é rede, e então Application → Service Workers e `await caches.keys()` no console dizem se há release `afiacao-release-*` promovida.
Rede com SW ativo e release promovida seria bug do SW, e aí reabre o F2 como conserto.

### Critério objetivo para reabrir

Reabre quando houver **≥ 3 usuários com ≥ 30 TTFB de `navegacao` cada em 14 dias** e o **p75 passar de 800 ms em ≥ 2 deles**. Também reabre se a checagem manual acima der "rede com release promovida".

```sql
-- psql-ro; hoje (2026-11-16) devolve usuarios_com_amostra=1 · usuarios_lentos=1 · reabrir=f (exit 0)
with base as (
  select user_id, valor from telemetria_vitals
  where metrica = 'ttfb' and navegacao = 'navegacao' and criado_em > now() - interval '14 days'
), por_usuario as (
  select user_id, count(*) n, percentile_cont(0.75) within group (order by valor) p75
  from base group by 1
)
select count(*) filter (where n >= 30) as usuarios_com_amostra,
       count(*) filter (where n >= 30 and p75 > 800) as usuarios_lentos,
       (count(*) filter (where n >= 30) >= 3 and count(*) filter (where n >= 30 and p75 > 800) >= 2) as reabrir
from por_usuario;
```

O denominador vem de `auth.sessions` (refresh no período, via conector Lovable): enquanto der 1, a query acima não tem como reabrir, e isso é o certo.
