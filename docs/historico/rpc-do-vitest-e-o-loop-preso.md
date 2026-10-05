# O RPC do vitest e o loop preso — a varredura dos testes que bloqueavam o worker (2026-10-05)

> Continuação de [exclusividade-media-outra-coisa.md](exclusividade-media-outra-coisa.md) §"A causa raiz do
> RPC (2026-09-25)", que isolou o mecanismo e consertou o harness do motor (#2561), e deixou a varredura dos
> outros testes como tarefa própria. Esta é ela.
> Infra: `src/test/loop-livre.ts` (+ teste) · `src/lib/gates/passos.ts`.
>
> **Estado:** medido e falsificado (2026-10-05) — com o RPC escalado a 5s, a main sai rc=1 sem teste falhando (2/2) e o conserto, rc=0 (2/2); arquivos com bloqueio ≥3s fora da coleta, 21 → 0. PR #2802.

## O mecanismo, em uma linha

O worker do vitest chama o RPC `onTaskUpdate` (birpc, timeout FIXO de 60s — `DEFAULT_TIMEOUT = 6e4`,
sem opção de config) no início e no fim de cada teste e hook. Se o event loop do worker fica preso — num
`spawnSync`/`execFileSync`, num laço síncrono de CPU — por mais de 60s, o timer vence durante o bloqueio e,
quando o loop volta, a fase de timers roda antes da de I/O: `Error: [vitest-worker]: Timeout calling
"onTaskUpdate"` com a resposta já na fila, e `bun run test` sai **rc=1 com ZERO teste falhando**.

## Como se achou quem bloqueia — medindo, não lendo

Grep de `spawnSync` acha o subprocesso síncrono no TESTE, mas não o que mora num helper importado, nem o
laço de CPU. A medida direta é o maior trecho em que o loop do worker não girou, por teste:

- **Instrumento descartável** (fora do repo): um setup extra do vitest com um pulso `setInterval` de 10ms
  REAL (capturado no load — imune a fake timers) que registra o maior intervalo entre batidas por janela
  (coleta, cada teste com seus hooks, `afterAll`).
- **Calibrado antes de usar** — e a 1ª versão REPROVOU na calibração: com `monitorEventLoopDelay` +
  `reset()`, o reset zera o carimbo do tick anterior, e o bloqueio logo depois dele vira o tick "inicial",
  que não é registrado — `spawnSync('sleep', ['2'])` media **0 ms**. A v2 (pulso próprio) mede
  `sync 2s → 2049 ms`, `cpu 1.5s → 1508 ms`, `await 2s → 13 ms`.
- **Perfil da suíte inteira** (2026-10-05, load 12→103): 272 arquivos com alguma janela ≥250ms; 60 ≥1s;
  31 ≥2s; 23 ≥3s; 11 ≥5s.

### Bloqueio na COLETA não estoura o RPC (medido)

Metade das janelas grandes era a coleta (topo do arquivo / corpo do `describe`). Discriminador, mesmo
`spawnSync('sleep', ['65'])`, mesma máquina:

| onde | rc | `Timeout calling` | testes |
|---|---|---|---|
| dentro do `it` (controle — o discriminador de 09-25) | **1** | **1** | 2/2 passando |
| no topo do arquivo (coleta) | **0** | **0** | 2/2 passando |

Pelo código do runner (`@vitest/runner`): o `onTaskUpdate` só sai a partir do `suite-prepare`; na coleta não
há chamada em voo (o `onCollected` é EVENTO, sem timer). `beforeAll`/`beforeEach`/`it` rodam com chamada em
voo — contam. A coleta saiu do escopo, com esta prova (o `fronteiras.gate` de 11,5s na coleta, p.ex.).

### O limiar

O próprio repo já mediu o pior fator de contenção: `authz-funcoes` foi de 5,4–7,2 ms/migration (suíte,
load ~30) a 46,9 (load 50+) — ~6,5×. No perfil de 05/10, 60s ÷ 6,5 ≈ 9s é risco demonstrado; com folga de
~3×, o corte foi **≥3s fora da coleta** (21 arquivos). Subprocesso estica mais que CPU sob swap (fork de
processo grande com memória pressionada), então a família de subprocesso entrou abaixo do corte
(`pendencias-prompt`, 2,5s — o que quebrou por timeout sob thrashing).

## O conserto — três formas, uma por natureza de trabalho

| natureza | forma | onde |
|---|---|---|
| laço de CPU no PRÓPRIO teste | `for await (… of emFatias(itens))` / `await cederAoLoop()` entre passadas | `erro-colapsado`, `limpeza-fonte`, `segredo-em-log`, `erro-object-object`, `universo-pedidos-ts` (G5), `psql-ro-error-stop`, `authz-funcoes` |
| analisador de PRODUÇÃO que varre o repo | o analisador vira **gerador** (`Passos<R>`, `yield` entre arquivos/migrations); a CLI drena com `drenar` (síncrono, o mesmo resultado), o teste com `drenarCedendo` | `auditCompleto` (authz), `modelarRepo` (deriva-corpo), `varrerMigrations`, `analisar` de 6 gates de SQL/shell, `modelar`/`rodarGate` (universo-pedidos-sql) |
| subprocesso | `rodar()`/`rodarOk()` — `spawn` assíncrono (a forma do #2561) | `mapa-coerente-na-ref`, `pendencias-prompt`, `pendencias-deploy-allowlist`, `exclusividade-gate` |

E dois casos que não são "fatiar":

- **ESLint** (`eslint-mutacao-env-bun`, `eslint-postgrest-pattern-like`): o bloqueio é a AVALIAÇÃO do módulo
  `typescript` na inicialização do parser (3,1s no 1º `it`) — import de módulo não se fatia. O aquecimento
  foi para a **coleta** (top-level `await`), onde a tabela acima prova que o RPC não estoura.
- **A regex `into` do `fuso-da-sessao-gate`**: depois de fatiar a varredura, sobrou um PASSO de 0,7s — um
  único corpo (`_data_health_compute()`, ~100 KB). Cronometrando cada regex do detector: 703 de 724ms numa
  linha, `/\bselect\s+([^;]*?)\s+into\s+…/gi`, **quadrática** (para cada `select` sem INTO, o `[^;]*?`
  preguiçoso anda o comando até o `;`). Nenhuma parte dela casa `;` → todo match cabe num trecho entre
  `;` → rodá-la só nos trechos com `into` é o MESMO conjunto de matches. Diferencial antigo × novo sobre
  todo o corpus (760 migrations + 671 versões de corpo): **1.431/1.431 idênticos, 74 com achado**; o
  corpus inteiro caiu de 14,7s para 0,75s, o `varrerMigrations` de 1.047 para 318ms. Fatiar não divide UMA
  chamada — o conserto foi na fonte.

**Por que gerador, e não reimplementar o laço no teste:** o teste que refaz a agregação do analisador
testa uma cópia, que deriva. O gerador é a MESMA implementação com dois motoristas; o `yield` não sabe de
event loop nenhum — quem decide ceder é o motorista.

**Por que não `worker_threads`:** o worker teria de carregar TS com `@/` e imports sem extensão — um
mini-build só para isso. Subprocesso assíncrono e fatia cobrem os casos medidos.

## A guarda — pulso por COMPORTAMENTO, e só sobre trabalho substancial

`contarPulsos(trabalho)`: um pulso de 10ms tem de bater DURANTE o trabalho; com o loop preso ele bate
ZERO. Cada conversão confere `batidas ≥ 2` no caminho REAL (o memo da varredura guarda o pulso dela; a CLI
confere o pulso de toda execução; o helper de análise confere o de toda análise). O teste do helper carrega
o **controle permanente**: `spawnSync`, laço de CPU e `await` em promise resolvida batem zero.

Duas lições de robustez, ambas vindas de vermelho real no lote 2:

- **Guarda sobre trabalho curto é flaky.** Seis `it`s do `like-cru`/`relogio-nu` passavam `corpos`
  prontos e a análise custava 1–80ms (o `lerSql` tem memo por texto+caminho): o pulso não bate nem
  cedendo. Converter esses foi excesso — voltaram ao síncrono. Regra: só guardar trabalho ≥~200ms.
  Medido no lote 3 (77 guardas): todas ≥10 batidas, exceto as de 4 cessões (`authz-*`: 3 — o piso
  determinístico, pois só a 1ª cessão pode cair na mesma volta em que a fase de timers já passou).
- **Subprocesso curto não serve de guarda.** 6 forks de git no Linux do CI somam menos que um pulso. A
  guarda roda o `git` do próprio arquivo com `-c alias.dorme=!sleep 0.2` — duração determinística.

Limite assumido: `batidas ≥ 2` pega a volta ao TOTALMENTE síncrono (e a cessão só no fim); não pega a
regressão PARCIAL (um de dois laços volta a síncrono). Medir o maior intervalo relativo à duração pegaria,
mas pausa de GC/escalonamento num trabalho de ~1s o deixaria flaky.

## Falsificação

Código COMMITADO antes; controle verde na MESMA invocação (abortaria antes da 1ª sabotagem); os DOIS
locales; uma camada por vez; veredito por arquivo no JSON do vitest, pela marca ASCII `PRENDE o event loop
do worker` (no ESLint, `o aquecimento saiu da coleta`). Rodada no estado FINAL (pós-rebase):

| camada | o que se sabotou | esperado vermelho | `C` e `pt_BR.UTF-8` |
|---|---|---|---|
| controle | nada | — | rc=0, 892/892 testes, 25 arquivos |
| **T** — o teste | no próprio arquivo, as primitivas viram bloqueantes (`cederAoLoop`→`Promise.resolve`, `emFatias`→`yield*` sem cessão, `drenarCedendo`→`drenar`, `rodar`→`spawnSync`); no ESLint, o aquecimento sai da coleta | 24 | **24/24** pela marca; o resto verde |
| **H** — o helper | `cederAoLoop` só cede a microtarefas | 18 (CPU) | **18/18**; subprocesso e ESLint verdes |
| **R** — o helper | `rodar()` por `spawnSync` | 4 (subprocesso) | **4/4**; CPU verde |
| **P** — a produção | os 13 `yield` dos geradores `Passos` removidos | 11 (quem passa por `Passos`) | **11/11**; o resto verde |

Cada camada sozinha deixa a guarda vermelha, e cada sabotagem só derruba a família dela — nenhuma camada é
redundante nem inalcançada.

## Antes × depois

Com a máquina calma, antes e depois dão rc=0: nenhum bloqueio chega a 60s (3 rodadas na main, 05/10:
rc=0, 0 RPC, 186–305s). Então a medida que DISCRIMINA escala o fenômeno em vez da carga: o
`DEFAULT_TIMEOUT` do birpc foi a **5s só durante a rodada** (patch no `node_modules` local, aplicado e
restaurado dentro da vaga do `heavy`, conferido `6e4` depois), o mesmo nos dois lados, alternando
antes/depois, cada rodada partindo de pressão 1 (`CI=1 FORCE_COLOR=0 bun run test`):

| rodada | RPC | rc | `Timeout calling` | resultado da suíte | load (início→fim) |
|---|---|---|---|---|---|
| antes #1 (main `e80fe16ec`) | 5s | **1** | **3** | 892/892 arquivos passando — ZERO teste falhando | 3 → 59 |
| depois #1 | 5s | 0 | 0 | 893/893 | 43 → **136** |
| antes #2 | 5s | **1** | **4** | 892/892 passando — ZERO falhando | 104 → 29 |
| depois #2 | 5s | 0 | 0 | 893/893 | 22 → 24 |
| depois #1–3 | 60s (normal) | 0 · 0 · 0 | 0 · 0 · 0 | 893/893, 10.788 testes | 22–28 → 30–38 |

O "antes" reproduz o sintoma exato (rc=1 sem teste falhando) nas duas; o "depois" sai limpo nas duas —
o #1 sob mais carga que os "antes".

**O perfil** (o instrumento, maior bloqueio fora da coleta, por arquivo): arquivos com janela ≥3s, na
suíte inteira, **21 → 0**; o maior entre os 24 convertidos, **14,8s → 1,3s**; 18 dos 24 abaixo de 250ms.

| arquivo | antes | depois |
|---|---|---|
| `authz-gate-check` | 14.811 ms | 1.313 (uma parte do `auditCompleto`) |
| `authz-funcoes` | 13.572 | 797 (uma passada) |
| `fuso-da-sessao-gate` | 8.885 | <250 |
| `psql-local-X-gate` | 6.939 | <250 |
| `assert-verde-por-ausencia-gate` | 6.514 | <250 |
| `relogio-nu-da-sessao-gate` | 5.224 | <250 |
| `universo-pedidos-ts-gate` | 5.174 | 261 |
| `mapa-coerente-na-ref` | 3.963 | 908 (o `git` síncrono do `main()` de produção) |
| `pendencias-prompt` | 2.454 | 562 (idem) |
| os outros 15 | 1.758–5.057 | <250 a 528 |

Ressalva honesta: o perfil "antes" pegou carga mais alta no fim (load até 103) que o "depois" (21–31) — a
tabela acelerada acima é a comparação robusta a isso.

**Efeito colateral no CI:** o `deriva-corpo.ts` é arquivo do AUDITOR do eixo `corpo` do carimbo de authz
— mudar o instrumento invalida a medição anterior, e o `authz:carimbo` reprovou
(`CARIMBO_CONTRATO_MUDOU`/`CARIMBO_AUDITOR_MUDOU`). A saída foi a prevista pelo gate: `authz:carimbo:gravar`
(as 6 auditorias de prod sob `psql-ro`, read-only, todas exit 0) e o carimbo novo commitado — não tirar a
lógica do arquivo vigiado, que seria burlar o gate.

## O que fica de fora (medido)

- **Coleta**: não estoura (tabela acima). Inclui o custo de import de `.tsx` (2,3–2,5s) e as varreduras
  no topo (`fronteiras.gate` 11,5s, `universo-pedidos-ts` 9s, `falsificar-exige-assert` 6,4s…).
- **Abaixo do limiar**: `sonda-versao-sql` (0,67s), `sonda-fan-out` (1,17s), `sonda-versao-bump-gate`
  (1,47s), `ordem-entre-edges-declaracao` (1,49s), `leitura-single-shot` (2,8s), `rpc-set-returning` (2,6s),
  `authz-carimbo` e `vitest-rpc` (<250ms).
- **O `main()` de produção** de `pendencias-prompt`/`pendencias-pacote` continua com `git` síncrono
  (`gitBytes`): converter seria tornar assíncronas as CLIs do deploy. O que o teste fazia por cima foi
  convertido; sobra ~0,75–1,1s por `it` (lote 3).
- **As partes do `auditCompleto`**: cada uma ~0,4–0,5s isolada (1,8s sob load 8) — fatiar por dentro seria
  mexer no analisador de authz.
