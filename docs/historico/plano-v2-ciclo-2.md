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

O resto da Frente A (farmer-inteligencia, vendas, financeiro, governanca) ficou com a sessão irmã "Casts item 4 — terminar", que já tinha um PR de plataforma mais amplo (inclui os `as unknown as`) quando as duas se cruzaram; esta sessão cedeu e foi para a Frente B.

## Frente B — deriva prod ≠ repo

Medido em 2026-10-20 (`bun run deriva:corpo:prod`, psql-ro, ref `origin/main@3b9ab93d7`): 399 identidades, exit 0 — EM_DIA 326 · COSMETICO 66 · **ACEITA 6** · NAO_MENSURAVEL 1 · aposentadas 20. A baseline tem **23** entradas, não 24: o ciclo 1 terminou com 24 e uma saiu depois. Por entrada:

| Classe | Entradas | Funções | Decisão |
|---|---|---|---|
| PATCH `SO_CITA` | 10 | has_role ×2, pode_ver_carteira_completa, registrar_exibicao_regua, pode_ler_custo, reposicao_marco_pre_omie, tint_promocao_tick, tint_promocao_watchdog, pedido_total_liquido_classificar, get_planos_margem | **Fica.** A migration posterior só menciona a função (guard, postcondição). Zero deriva; é conciliação do extrator. |
| PATCH `ALTERA` | 10 | despinar_parametro ×2, reverter_parametro_auto ×2, reverter_run_auto ×2 (gate FU4-E), tint_promote_sync_run ×4 | **Fica.** Prod = repo + patches por âncora commitados, conciliados por md5. É corpo que o modelo não reconstitui, não corpo fora do repo. Codex (desenho) recompôs os 2 patches FU4-E: tokens iguais nas 3, md5 bruto diferente só em `reverter_parametro_auto`. Não recomenda 4 canônicas só para satisfazer o extrator. |
| NAO_MENSURAVEL | 1 | omie_sync_identity_snapshot | **Fica.** `prosqlbody`, sem `prosrc` para comparar. |
| EDICAO_MANUAL | 1 | detectar_skus_sem_grupo | **Fica, aceita.** Difere só no literal de justificativa gravado em `eventos_outlier`; predicados e efeitos iguais (346 tokens); aceita pelo founder em 2026-09-26. |
| EDICAO_MANUAL | 1 | **analytics_outbox_pedido_compra** | **Canonizada.** Ver abaixo. |

### `analytics_outbox_pedido_compra` — a única com corpo money-path fora do repo

O trigger do pedido de compra roda desde 2026-10-18 o corpo do envelope `db/aplicar-analytics-outbox-insert-ja-aprovado.sql` (#3149). O pedido inserido já aprovado emite criada E aprovada. É a classe do ciclo 1: a última migration (20261011150000) é um ancestral do corpo vivo, e um replay dela apagaria o ramo em silêncio.

- `supabase/migrations/20261020200000_analytics_outbox_pedido_compra_canonica_insert_ja_aprovado.sql`: o `pg_get_functiondef` da prod byte a byte (hex → arquivo; md5 do functiondef `03613cda…` igual ao lido por psql-ro; md5(prosrc) `ae665653…`), no molde TRAVA → PRE → CREATE → PÓS, `BEGIN ISOLATION LEVEL READ COMMITTED`. A PRE aceita só {predecessor `049e1b52…`, este} e confere o contrato fora do `prosrc` e o **owner** (P1 do Codex de desenho: SECURITY DEFINER com outro dono sem INSERT na outbox calaria o funil pelo fail-open). A PÓS confere corpo, atributos, owner, a definição do trigger e o `tgfoid`. Confere também o árbitro do `ON CONFLICT`: UNIQUE válido e imediato em `chave_dedup`, e nenhum diferível. O diferível foi P2 do Codex de código: é inferido, dá 55000, e o fail-open engole.
- Fora, de propósito: o backfill (one-shot; re-rodá-lo depois da purga da outbox duplicaria evento no destino) e a ACL (preservada, inclusive se mais restrita).
- Prova `db/test-analytics-outbox-canonica.sh`, no núcleo do CI com `falsificar=11`. Os dois caminhos terminam no mesmo md5 da prod: o restore (cadeia + canônica) e a prod (cadeia + envelope, com a canônica por cima). O funil se comporta como o do envelope. Reaplicar é no-op preservando oid, dono e ACL. São 11 sabotagens, cada uma com a marca de erro declarada e com rollback conferido por outra conexão. O controle verde roda na mesma invocação, nos dois locales (`C` e `pt_BR.UTF-8`). Camada a camada: sem o `tgfoid`, a homônima noutro schema passa pela regex da definição e a migration aplica.
- Auditor sobre as migrations do worktree contra a prod real (visão pós-merge): EM_DIA 327 · ACEITA 5, e a entrada vira `BASELINE_OBSOLETA`. Ela fica neste PR, porque o auditor lê `origin/main` e a baseline é contrato do carimbo. O follow-up remove a entrada e regrava o carimbo (`authz:carimbo:gravar`). Baseline final: **22 entradas, todas justificadas acima**.
- O audit de migrations extraía um "trigger" falso de dentro da regex da PÓS (parent `public`), e isso viraria um ❌ MISSING fantasma. Por isso o nome vai entre parênteses na regex.
- **Não impede** que alguém cole de novo o CREATE antigo depois. O que a canônica faz é dar a definição para reconstruir e tornar essa regressão detectável pelo auditor.
- **Aplicada na prod em 2026-10-20 pela sessão, via MCP do Lovable, com aval do founder, depois do merge (#3260, `07dc8f834`).**
  - Ensaio antes: o mesmo arquivo terminando em `RAISE EXCEPTION 'ENSAIO_OK'` passou TRAVA, PRE, CREATE e PÓS e reverteu. O psql-ro confirmou `xmin` intacto (12288805).
  - Aplicação na íntegra sem erro. A transcrição é fail-closed, porque a PÓS exige o md5 exato.
  - Por fora (psql-ro): md5 `ae665653…`, `xmin` novo **12436730**, owner postgres, trigger com `tgfoid` certo e ACL idêntica à de antes.
- **Follow-up (este PR):** a entrada saiu da baseline (**22**) e o carimbo foi regravado. Os 5 audits de authz deram exit 0. A deriva deu exit 1 só por 2 `SEM_PAR` de outras entregas em voo, aplicadas minutos antes: `get_defasagem_cliente` (#3259, migration já aplicada, resolve no merge) e `claim_nfe_efetivacao_lock` (envelope do #3258, sem baseline nem canônica; a sessão do NF-e foi avisada). Por isso a prova E (`db/test-deriva-baseline-prod.sh --repo-local`) abortou no controle, como deve. Ela roda de novo quando a prod voltar a bater.

## Lições

- **Duas sessões no mesmo item: confira o artefato da irmã antes de cada PR, não só a lista de PRs.** O commit dela estava local, sem push nem PR. Só o `git log` do worktree dela mostrou a colisão.
- **Mapped type homomórfico preserva o `?`.** `{ [P in K]: … }` com `K extends keyof T` herda a opcionalidade. O helper que deveria obrigar o NULL explícito aceitava a chave omitida, e só o `@ts-expect-error` do teste (TS2578) mostrou isso. Precisa de `-?`.
- **O fail-open de telemetria é um amplificador de verde-falso.** Todo pré-requisito do INSERT interno (dono, árbitro do `ON CONFLICT`) que falhe vira WARNING e funil mudo. A PÓS de quem recria a função tem de provar esses pré-requisitos, não só o corpo.
- **Laço de falsificação com `set -o pipefail`:** `grep … | head` sem `|| true` aborta o laço inteiro no primeiro vermelho de ambiente. O template do ciclo 1 (`db/test-pedido-total-liquido-excecao.sh:76`) tem o mesmo idioma.
