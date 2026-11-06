# F12: score e margem do Customer 360 em paralelo (plano v7, lote 7)

**2026-11-05.** Item F12 do plano v7 (`docs/superpowers/plans/2026-11-05-plano-melhoria-v7/README.md`, §2 F e §4 lote 7). Padrão do F8 do v6 (#3610, DRE em paralelo), desta vez **medido no lab** antes e depois.

## O que mudou

`useCustomerScore` (`src/components/customer360/hooks.ts`) lia em série: score do farmer → (se vazio) qualquer score do cliente → só então `buscarMargemScore`, que só precisa do cliente. Agora a margem sai **junto** com a primeira leitura do score. A espera do score com margem passa de `soma` para `max`.

Ajustes do Codex no plano, todos cumpridos:

- **O ganho é a sobreposição, não "−1 RTT" fixo.** Cliente com score próprio economiza a ida da margem inteira; com fallback, a margem fica escondida atrás das duas leituras de score.
- **Cliente sem score passa a gerar 1 chamada de margem** que antes era dispensada. A query devolve `null` sem esperar por ela.
- **O fallback só roda quando a leitura própria teve SUCESSO sem linha.** Antes os `error` das duas leituras de score eram descartados: a falha virava `null`, e a tela dizia "Sem score" (ausência afirmada sobre uma leitura que não aconteceu). Agora as duas lançam.
- **O consumidor vê o erro.** `Customer360.tsx` deriva `scoreSemLeitura` (`estadoDeLeitura` + `naoConsegui`, o mesmo par do `ActivityColumn`). O chip do hero diz "Score indisponível" ou "Score: sem rede" em vez de "Sem score", e a coluna de identidade mostra o `AvisoLeituraFalhou` (`aviso-c360-score`) no lugar do card que sumia.

Preservado:

- **A falha da margem não derruba o score.** Ela continua `margem_oculta: true` + `captureException` (achado Codex anterior), sem número e sem legenda que afirme algo sobre o cliente. O `.catch` é preso na criação da promessa, então se o score lançar antes do `await` a rejeição da margem não fica sem dono (há teste).
- A tri-semântica da margem (apurada · não apurada · não concedida) e os dados exibidos nos casos de sucesso.
- A ordem do que a tela mostra.

## Lab (mesmo método do F11/lote 6)

Build de produção servido estático, sessão falsa no localStorage, Supabase interceptado com **400 ms fixos** por requisição, persona master, contexto frio, service worker bloqueado, 1 aquecimento descartado. São 15 cargas por caso no desktop e 10 no mobile (CPU 4×). `cadeia` é o intervalo entre o início da 1ª leitura de `farmer_client_scores` e o fim da última requisição da cadeia (score + `get_scores_margem`). `margem` é o instante (desde `timeOrigin`) em que o chip "N% margem" aparece no DOM. O script ficou no scratchpad: não é gate nem sensor.

As cargas antes e depois foram **intercaladas** por caso (antes, depois, antes…), para a carga da máquina, que divide a CPU com dezenas de sessões, pesar igual nos dois lados. Valores em ms, p50 [p25–p75], p por Mann-Whitney:

| perfil | caso | cadeia antes → depois | p | chip "N% margem" antes → depois | p | chamadas |
|---|---|---|---|---|---|---|
| desktop | próprio | 893 [861–935] → **419** [409–423] | <0,0001 | 1.646 [1.552–2.224] → **1.114** [1.102–1.164] | <0,0001 | 2 → 2 |
| desktop | fallback | 1.317 [1.290–1.326] → **884** [868–889] | <0,0001 | 2.087 [2.022–2.126] → **1.578** [1.528–1.659] | 0,0001 | 3 → 3 |
| desktop | ausente | 909 [877–942] → 905 [883–944] | 0,92 | (sem chip) | — | 2 → **3** |
| mobile | próprio | 869 [853–880] → **414** [410–419] | 0,0002 | 2.219 [2.071–2.681] → **1.924** [1.870–1.995] | 0,019 | 2 → 2 |
| mobile | fallback | 1.252 [1.246–1.257] → **874** [867–891] | 0,0002 | 2.251 [2.190–2.367] → 2.103 [1.994–2.238] | 0,059 | 3 → 3 |
| mobile | ausente | 921 [879–1.363] → 1.019 [884–1.168] | 0,94 | (sem chip) | — | 2 → **3** |

A cascata, numa carga típica (desktop):

- próprio, antes: `score_proprio@628-1042 → margem@1113-1513`. Depois: `margem@622-1046 ∥ score_proprio@622-1047`.
- fallback, antes: `score_proprio@757-1177 → score_fallback@1244-1645 → margem@1649-2051`. Depois: `margem@659-1078 ∥ score_proprio@660-1078 → score_fallback@1145-1547`.

Leitura:

- **Ganho confirmado:** a cadeia perde 1 ida inteira (~400 ms a 400 ms/req) nos dois casos com score. O conteúdo (chip de margem) chega ~530 ms antes no desktop; no mobile o ganho fica em ~150–300 ms, porque o CPU 4× pesa mais que a rede ali.
- **Ausente:** custo de **+1 chamada** (`get_scores_margem` devolve vazio), sem mudar a espera (p ≥ 0,92). É o custo que o Codex previu, e foi aceito no plano.
- **Limites:** 400 ms fixos por requisição, respostas interceptadas, uma só persona (master). O ganho absoluto em produção é ~1 RTT real (rede + PostgREST + RLS da RPC), não os 400 ms do lab.
- Antes deste A/B houve uma rodada só de "antes" (não intercalada), com a máquina mais carregada: mesma forma (próprio 1.048 ms, fallback 1.720 ms de cadeia), mais ruído.

## Prova

`src/components/customer360/__tests__/score-margem-paralelo.test.tsx` (promessas controladas: com resposta imediata, o laço serial passaria verde) e 2 casos novos em `src/pages/__tests__/Customer360.estados.test.tsx` (fiação página → hero).

Falsificação na MESMA invocação (`heavy bash falsificar.sh`, scratchpad), com controle verde antes da 1ª sabotagem e uma camada sabotada por vez (o código estava commitado; restauração por `git checkout --`):

| sabotagem | resultado |
|---|---|
| controle `LC_ALL=C` e `pt_BR.UTF-8` | exit 0 · 25/25 nos dois |
| margem só depois do score (serial) | exit 1: "a margem sai ANTES…", "fallback: a margem também não espera…" |
| erro da leitura própria descartado | exit 1: "falha da leitura PRÓPRIA → erro da query" |
| erro do fallback descartado | exit 1: "falha do FALLBACK → erro da query" |
| ausente espera a margem | exit 1: "ausência legítima … sem esperar a margem" |
| página não repassa a falha | exit 1: "leitura do score FALHA → o hero recebe `erro`" |
| coluna não avisa | exit 1: "coluna: falha → aviso no lugar do card" |
| hero diz "Sem score" | exit 1: "hero: falha → Score indisponível", "hero: sem rede" |

Suíte do módulo (`src/components/customer360`, `Customer360.estados`, `src/lib/scoring`): 358/358, exit 0. `typecheck:app` exit 0. eslint nos arquivos tocados exit 0.

## Deploy

Só **Publish** (front puro; sem migration, sem edge).
