# Auditoria da suíte de testes — Afiação (2026-09-05, read-only)

Worktree: `.claude/worktrees/intelligent-yalow-39d4e7` · branch `claude/code-improvements-plan-2bc5f9` · suíte medida pelo `health.sh` em background (load médio da M2 ≈ 38 durante a rodada — números de parede locais são comparativos, não projetam o CI).

## Panorama

- **751 arquivos vitest** (726 em `src/`, 285 `.tsx`; 25 em `scripts/`) → **7.573 testes executados, 1 falha, 1 skip, 819,7 s** sob load 38. Balde dominante do runner: `environment 2184 s` (jsdom) contra `tests 456 s`.
- **65 testes Deno** (953 `Deno.test`, 13.933 LOC) para **95 edges** — só 19 edges têm teste próprio.
- **270 harnesses PG17** (`db/test-*.sh`, 84.474 LOC, 60 tocados nos últimos 30 dias) — **nenhum roda no CI** (documentado).
- Higiene já boa por desenho: 0 `skip/only/todo`, 0 `toThrow()` pelado real (gate próprio), 0 snapshot, 0 `useFakeTimers` sem `useRealTimers`, 0 teste sem `expect`, mocks do client Supabase roteados por tabela/RPC.

---

## Achados

Formato: `ID | título | categoria | evidência | por que importa | proposta | I·R·E` (I=impacto, R=risco de deixar como está, E=esforço; 1–5).

### A1 | Gate AST `erro-colapsado-em-vazio` custa 37 s contra teto de 20 s — vermelho por CUSTO, não flake (classe do #1893) | teste/infra
- **Evidência:** `src/__tests__/erro-colapsado-em-vazio-gate.test.ts:107-111` (laço sobre ~2.4k fontes de `src/`); `src/lib/gates/erro-colapsado-em-vazio.ts:61` (`ts.createSourceFile(..., setParentNodes: true)` por arquivo, sem pré-filtro); log: `36.979 ms` (9 testes) — o 2º mais lento é 7,4 s; falha observada: `Test timed out in 20000ms` (única falha da rodada). Adicionado em 2026-08-22.
- **Por que importa:** é o único vermelho da suíte e reproduz a receita de `flaky-sob-carga-teto-e-custo.md` (instância 2): o gate vive ACIMA do teto e só passa quando a máquina folga — treina a ignorar vermelho justamente num gate money-path (baseline inclui `useUnifiedOrder.ts`).
- **Proposta:** (1) pré-filtro textual barato antes do parse — só parsear arquivos que contêm `return null`/`? null`/fragmento vazio E um hook de leitura (`useQuery|use[A-Z]\w+\(`); (2) opcionalmente cache do resultado por `(path, mtime)`; (3) medir fora do runner com `performance.now()` antes/depois, e **não** subir teto. Falsificar: sabotar um arquivo da baseline tem de continuar vermelho após o pré-filtro.
- **I=4 · R=3 · E=2**

### A2 | 435 de 466 `.test.ts` puros rodam em jsdom sem tocar DOM — `environment` é o maior balde do runner | infra
- **Evidência:** `vitest.config.ts:8` (`environment: "jsdom"` global; 0 arquivos com `// @vitest-environment`); log: `environment 2184,40 s` vs `tests 455,99 s`; `rg --files-without-match 'document|window|screen|render\(|renderHook|localStorage|navigator|@testing-library|jsdom|HTMLElement'` sobre os 466 `.test.ts` → **435** não referenciam nada de DOM.
- **Por que importa:** o custo de parede da suíte (820 s local; 6–8 min no CI segundo `falsificacao-fora-do-ci.md`) é dominado por montar jsdom em arquivos que só testam funções puras; cada minuto do `validate` é minuto do auto-merge.
- **Proposta:** `environmentMatchGlobs: [['**/*.test.tsx','jsdom'], ['**/*.test.ts','node']]` (vitest 3.2 — deprecado a favor de `test.projects`, ainda funcional) + `// @vitest-environment jsdom` nos 31 `.test.ts` que tocam DOM. O shim de `localStorage` do `setup.ts` já cobre node (o client Supabase referencia `localStorage` no top-level). Medir o ganho **no CI** (o número local varia ~3×).
- **I=4 · R=2 · E=2**

### A3 | 270 harnesses PG17 (84.474 LOC) nunca rodam no CI — a única prova executável de RPC/trigger/RLS money-path é manual | infra
- **Evidência:** `ls db/test-*.sh` = 270; `rg 'db/test-' .github/workflows/ci.yml package.json` = 0; `docs/historico/schema-migrations-fail-open.md:172-178` ("CI não tem service de Postgres… o harness fixa `/opt/homebrew` e exige `brew`"); `.claude/skills/prove-sql-money-path/references/harness-template.sh:18,24` (`PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"`; `brew install` no erro); 60 harnesses modificados nos últimos 30 dias.
- **Por que importa:** é a maior massa de teste do repo e cobre exatamente o que o CLAUDE.md chama de mais caro (PL/pgSQL late-bound, RLS, `security_invoker`). Depois do merge, uma migration posterior que quebre uma função só é pega se alguém lembrar de rodar o harness certo — "teste que existe e não roda é ausência de dado" (regra do próprio repo, `hooks-suites-baseline.ts`). O job `authz-sentinela` cobre só o carimbo de ACL.
- **Proposta:** job `db-harness` com `services: postgres:17` (+ `pgvector`), `PGBIN` por variável de ambiente (bootstrap portátil: no runner apontar para `/usr/lib/postgresql/17/bin`), **allowlist inicial** de 8–12 harnesses money-path (pedido/preço/crédito/carteira/ATP) rodando em PR que toca `db/` ou `supabase/migrations/` + no cron das 09:17; expandir por medição de tempo. Falsificar: sabotar uma migration coberta tem de dar vermelho no job.
- **I=5 · R=4 · E=4**

### A4 | `disparar-pedidos-aprovados` (1.923 LOC, cron diário, cria pedido de compra na Omie) sem teste de lógica — só o contrato da sonda | teste
- **Evidência:** `supabase/functions/disparar-pedidos-aprovados/index.ts:1-5` (cron 13:00 UTC; "DRY-RUN: cria pedido no Omie via IncluirPedidoCompra… PRODUÇÃO: cria no Omie + dispara ao fornecedor"); 81 menções Omie/IncluirPedido; único teste: marcador em `_shared/sonda-versao-contrato_test.ts`. Não está entre os 25 paths lidos por `edge-money-path-invariants`. Mesma situação: `fin-valor-engine` (400 LOC, 0 imports `_shared` testados), `fin-cashflow-engine` (1.488), `omie-sync-vendas-items` (720), `pedido-programado-enviar` (513), `gerar-pedidos-diario` (486), `conciliar-pedido-portal` (268), `sayerlack-captura-precos` (1.280).
- **Por que importa:** 76 de 95 edges não têm teste Deno próprio; 40 delas têm nome money-path e 11 são cobertas só por gate textual vitest. Uma edge que emite pedido de compra ao fornecedor é money-path por definição e hoje só tem `edges:typecheck` + sonda como rede.
- **Proposta:** extrair o núcleo decisório (seleção dos pedidos do ciclo, DRY-RUN × produção, idempotência de reenvio, agregação por fornecedor) para módulo puro local (`disparar-pedidos-aprovados/selecao.ts`) e cobrir com Deno test `--no-remote`; começar por esta edge e por `fin-valor-engine`. Padrão já existe em `generate-tactical-plan/plano-helpers_test.ts` (594 LOC).
- **I=5 · R=4 · E=3**

### A5 | `useRoutePlanner.ts` (1.456 LOC numa função só) tem zero testes; `useUnifiedOrder.ts` (1.053) só por gate textual + sub-hooks | teste
- **Evidência:** `src/hooks/useRoutePlanner.ts:86` (`export function useRoutePlanner()` até o fim do arquivo; 19 menções inline a carteira/roteiro/`PROSPECTS_POR_CIDADE`); `rg -l useRoutePlanner src --glob '*.test.*'` = 0 (os helpers extraídos em `src/lib/route/*` têm 13 testes). `src/hooks/__tests__/useUnifiedOrder.accountGuard.test.ts` lê a fonte (`readFileSync` ×2); os 6 testes de `src/hooks/unifiedOrder/__tests__/` cobrem sub-hooks (`useCart`, `useProductCatalog`, helpers). Contraste: bundle/cross-sell/tático têm **31/32** testes de comportamento via `renderHook`.
- **Por que importa:** a lógica que já quebrou (`docs/historico/roteirizador-corte-cidades.md`: corte por ranking, união com a fonte que conhece a decisão) vive inline no hook, sem teste; `useUnifiedOrder` orquestra o checkout (money-path) e a única prova do orquestrador é textual.
- **Proposta:** extrair a montagem de alvos (carteira ∪ prospects ∪ agenda, dedupe, corte) para `src/lib/route/montar-alvos.ts` puro + teste unitário; para `useUnifiedOrder`, 2–3 testes `renderHook` do fluxo (cliente → carrinho → `submitOrder` chamado com o envelope certo) com mocks roteados como os dos engines (`bundle-conta-unica.test.tsx`).
- **I=4 · R=3 · E=3**

### A6 | `prime` (money-path, assinatura B2B): 33 asserts na matemática pura, zero no writer | teste
- **Evidência:** único teste `src/lib/prime/prime.test.ts` (328 linhas, 33 `it`: `valorAfiacao`, `parseValorBR`, `format`, `competência`, `montarInsertUso`, `usoFormSchema`, `traduzirErroPrime`); código do módulo 2.391 LOC — `src/queries/usePrimeAdmin.ts` (344 LOC, 14 hits de `rpc|insert|update|valor`) e 4 dialogs/tabs de 184–307 LOC sem teste. Manifesto: `prime` `moneyPath: true`.
- **Por que importa:** o CHECK `valor = round(q × snapshot, 2)` está espelhado no teste, mas o caminho que monta e envia o insert não é exercitado — se o writer calcular `valor` de outro jeito, o teste da fórmula segue verde (padrão "helper espelhado sem prova de uso" de `money-path.md`).
- **Proposta:** teste `renderHook` de `usePrimeAdmin` gravando o payload do `insert`/`rpc` e casando com `montarInsertUso` (prova de que o writer USA o helper), como em `bundle-conta-unica`.
- **I=3 · R=3 · E=2**

### A7 | Cobertura não é medida; a única cobertura "com dente" é mutação em 20 contratos — nenhum cobre `orderSubmission/*` | infra
- **Evidência:** `package.json` sem `@vitest/coverage-*`, sem `playwright`; `scripts/mutcheck.d/*.mut` = 20 contratos (`@src:` = 7 hooks `.claude/hooks/*.sh`, 2 scripts de sonda, 7 `src/lib/financeiro/*-helpers.ts`, `reposicao/compras-otimizador-helpers.ts`, `route/route-outcome.ts`, 2 edges); `src/services/orderSubmission/` (submitOrder 676 LOC, priceGuard, idempotency, atp) fora do mutcheck.
- **Por que importa:** "726 arquivos" não diz o que o checkout tem de cobertura; sem mapa por módulo de risco, priorizar é chute. Mutação já existe como infra (`mutation-check` job) e é o instrumento certo no money-path.
- **Proposta:** NÃO coverage global (ruído, gate frágil). (1) Relatório semanal, não gate: `vitest --coverage --coverage.include='src/services/orderSubmission/**,src/lib/prime/**,src/lib/tint/**,src/lib/picking/**,src/lib/recebimento/**'` (adicionar `@vitest/coverage-v8`); (2) 2 contratos `.mut` novos: `priceGuard.ts` e `idempotency.ts`.
- **I=3 · R=2 · E=2**

### A8 | Não existe E2E — o "cron de smoke E2E" citado em `vite.config.ts:11` é um monitor de paridade de SHA | documentação/infra
- **Evidência:** `vite.config.ts:11` ("lido pela verificação de deploy / cron de smoke E2E"); `.claude/skills/lovable-deploy-verify/scripts/monitor-deploy.sh` (58 linhas; `:28` extrai `/assets/index-*.js` do HTML, `:35` baixa o bundle e compara SHA com `origin/main`); `SKILL.md:861,918`. Nenhum `playwright`/`cypress` no repo.
- **Por que importa:** quem lê o comentário assume que existe prova funcional pós-deploy; o que existe prova "bytes no ar", não "login + pedido funcionam" — a distinção disponibilidade ≠ adoção do CLAUDE.md.
- **Proposta:** renomear o comentário ("monitor de paridade de SHA do deploy"). Se quiser smoke real: 1 fluxo Playwright read-only (login staff → `/pedidos` lista dados) no cron das 09:17, **sem** gate de PR.
- **I=2 · R=2 · E=1 (rename) / E=4 (smoke real)**

### A9 | `bunfig.toml` mantém `bun test` (runner errado) quase-funcionando com um preload que já divergiu do `setup.ts` | infra
- **Evidência:** `bunfig.toml:1-2` (`[test] preload = "./src/test/bun-setup.ts"`); `src/test/bun-setup.ts:8` usa `typeof globalThis.localStorage === "undefined"` — o guard que `src/test/setup.ts:22-27` documenta como insuficiente ("Node's is defined-but-broken"); sem `sessionStorage`, sem `configure({ asyncUtilTimeout })`; nenhum hook/guard contra `bun test` (`rg 'bun test' .claude/hooks scripts` só casa um fixture do pipestatus). CLAUDE.md: "`bun test` (runner nativo) ≠ disto".
- **Por que importa:** um preload que faz o runner errado "quase rodar" produz resultado parcial (`vi.mock` não existe em `bun:test`) em vez de erro claro; é dívida que ninguém mantém (`knip.json` o lista como entry).
- **Proposta:** trocar o preload por um arquivo que lança `throw new Error("use bun run test (vitest); bun test não é o runner deste repo")`, ou remover `[test]` do bunfig + `bun-setup.ts` (ajustar `knip.json`).
- **I=2 · R=2 · E=1**

### A10 | `build-id-paridade` "contra o dist/ real" é o `1 skipped` da suíte e nunca roda no CI (test antes do build) | teste
- **Evidência:** `src/lib/__tests__/build-id-paridade.test.ts:49-53` (`describe.skipIf(!existsSync(DIST))`; comentário: "o CI não builda antes de testar — o guard de paridade acima sustenta a garantia"); `ci.yml:153` `bun run test` < `ci.yml:285` `bun run build`.
- **Por que importa:** `resolverBuildId` é o que o monitor de deploy (A8) lê; o único teste contra o HTML que o Vite realmente gera está permanentemente pulado. Desenho documentado, mas o fix custa segundos.
- **Proposta:** step após o build: `bunx vitest run src/lib/__tests__/build-id-paridade.test.ts` (~2 s).
- **I=2 · R=2 · E=1**

### A11 | `SalesQuotes.priceGuard.test.tsx` repete o par de tetos que mascarou o flake do irmão `accountGuard` (P0-B) | teste
- **Evidência:** `src/pages/__tests__/SalesQuotes.priceGuard.test.tsx:74` (`FOLGA = { timeout: 10_000 }`), `:84`, `:93` (`}, 15000)`); 6º arquivo mais lento (5.708 ms, 2 testes); `docs/historico/flaky-sob-carga-teto-e-custo.md` removeu exatamente os `it(..., 15000)` do irmão. Únicos overrides locais do repo: estes 2 + `AdminReposicaoPromocaoDetail.test.tsx` (1).
- **Por que importa:** money-path (price guard) com 3 tetos visíveis; o `waitFor` a 10 s fica a 5 s do teto do runner — se piscar, o diagnóstico vira timeout opaco do vitest em vez de dump de DOM.
- **Proposta:** medir o caminho real (receita do doc), remover os `15000`, deixar o `waitFor` no `asyncUtilTimeout` global (5 s) ou justificar o 10 s em comentário com o número medido.
- **I=2 · R=2 · E=1**

### A12 | ~11 gates/parity textuais em `src/lib` e 1 em `src/__tests__` sem sentinela de "varredura vazia" (heurística — conferir um a um) | teste
- **Evidência:** `rg --files-without-match 'CEGUEIRA|cegueira|enxerga o repo|toBeGreaterThan\(|sentinela'` → `src/__tests__/import-tint-formulas-aposentada-gate.test.ts`; em `src/lib`: `reposicao/__tests__/edges-onorder-guardrail.test.ts`, `embalagem-captura-edge-invariants.test.ts`, `modulos/__tests__/fronteiras.gate.test.ts`, `manifesto.gate.test.ts`, `scoring/__tests__/aggregate.test.ts`, `custos/__tests__/cost-source.parity.test.ts`… Em `src/__tests__` 11/12 gates têm sentinela (idioma em `erro-colapsado-em-vazio-gate.test.ts:100-104`).
- **Por que importa:** gate que lista zero arquivos ou cujo padrão deixou de casar fica verde por cegueira (`gates-textuais-cegos.md`). **Incerteza:** heurística lexical — `manifesto.gate` tem a regra 3 ("glob que não casa é ERRO") que age como sentinela; os `*.parity.test.ts` comparam arquivo inteiro e `readFileSync` lança se faltar (descartados).
- **Proposta:** em cada gate textual sem sentinela, 1 assert "o walker viu ≥N arquivos e contém `<alvo conhecido>`" + 1 "o padrão casa o alvo conhecido".
- **I=3 · R=2 · E=2**

### A13 | 837 asserções `ByText('literal')` (75% de 1.111) — copy pt-BR vira contrato de teste | teste
- **Evidência:** `rg -c "ByText\(['\"]"` = 837 em 184 arquivos vs 74 com regex `/…/i`; `getByRole({ name })` literal 146 vs regex 214.
- **Por que importa:** mudar uma vírgula de copy quebra testes que não medem comportamento e incentiva "arrumar o teste sem ler". Contrapeso legítimo: nos testes de estado honesto (erro ≠ vazio) o texto É o comportamento.
- **Proposta:** convenção para código novo — estado/decisão por `role`+`name` regex ou `data-state`; literal só quando a copy é o contrato ("Nenhum DRE calculado"). Sem migração em massa.
- **I=2 · R=1 · E=3**

### A14 | `edge-money-path-invariants.test.ts`: 37 guardrails / 253 `it` / 3.597 LOC / 61 commits num arquivo só — barato, mas sem dono por módulo | teste/organização
- **Evidência:** lê 25 paths de edge + 17 de `src/`, usa o stripper compartilhado 36×, roda em **73 ms**; manifesto o atribui a `vendas`, mas há describes de `omie-analytics-sync`, `carteira-rebuild`, `fin-valor-cockpit`, `ai-ops-agent` (financeiro/plataforma/farmer).
- **Por que importa:** custo de runtime zero; o custo é de atribuição no boletim (tudo conta como `vendas`) e de conflito de merge (61 commits, ímã de sessões paralelas).
- **Proposta:** quebrar por edge alvo em `src/__tests__/edge-invariants/<edge>.test.ts` mantendo o padrão e o stripper; registrar cada um no `testes:` do módulo dono. Não urgente.
- **I=2 · R=1 · E=2**

---

## Medições

### Inventário
| Camada | Arquivos | Testes | LOC |
|---|---|---|---|
| `src/**/*.test.{ts,tsx}` | 726 (285 tsx; 18 em `src/__tests__`) | 7.232 `it` estáticos | 72.713 + 8.010 (`src/__tests__`) |
| `scripts/**/*.test.ts` | 25 | (incluídos no vitest) | — |
| vitest total (log) | 751 | 7.573 exec. (1 falha, 1 skip) | — |
| `supabase/functions/**/*_test.ts` | 65 (40 em `_shared`) | 953 `Deno.test` | 13.933 |
| `db/test-*.sh` (PG17) | 270 | — | 84.474 |
| `scripts/test-*.sh` + `.claude/hooks/*.sh` (`test:hooks`) | 33 + 17 | — | — |

### Tipologia
- **Textual (lê fonte com `readFileSync`/`readdirSync`):** 55/726 em `src` (7,6%; 16 em `src/__tests__`, 8 em `lib/reposicao`, 6 em `hooks/__tests__`, 4 em `lib/custo`…), 10/25 em `scripts`, 10/65 em edges. **Desenho** (5º gate de edge) — não é dívida per se.
- **Comportamento:** 217 arquivos com `render(`; `hooks/__tests__` 68/79 com `renderHook`; engines bundle/cross-sell/tático 31/32 via `renderHook`.
- **Snapshot:** 0 (`toMatchSnapshot|InlineSnapshot`, `__snapshots__`).
- **Presença-só (`toBeTruthy/Defined` única forma de assert):** 24 arquivos (1.029 ocorrências no total) — sobre `getByText`, que lança se ausente: não é assert vazio.
- **Deno:** 60/65 importam módulo real (comportamento); 10 leem texto; 5 arquivos de sonda/contrato (`sonda-versao-contrato_test` 1.294 LOC + 4) = 2.398 LOC ≈ 17% — desenho documentado no cabeçalho.

### Qualidade
- `it.skip/only/todo/xit`: **0**. `describe.skipIf`: 1 (A10).
- `toThrow()` pelado: 20 matches brutos → 16 são `not.toThrow()` (legítimo), 4 são comentários/o próprio gate `tothrow-pelado-gate` (cobre `src`, `supabase/functions`, `scripts`, sem baseline). **0 real.** Deno: 8 `assertThrows/Rejects`, 0 sem marca.
- Arquivo de teste sem `expect(`/`assert`: **0**.
- `vi.mock('@/integrations/supabase/client')`: 96/726 arquivos; amostra de 6 lidos (bundle-escopo-sob-falha, CarteiraSaudePanel.estados, FarmerBundles.erro-honesto, FarmerRecommendations.erro-honesto, offline-flow-integration, useImpersonationTargets): **6/6 roteados** por tabela/RPC com seed e queries gravadas; 0 "vazio para tudo".
- `useFakeTimers` 8 arquivos / `useRealTimers` 8 / sem par: **0**.
- Copy pt-BR: A13.

### Runtime (log local, load 38)
- `Duration 819,69 s` — transform 112,5 · setup 1.016,9 · collect 666,9 · **tests 456,0** · **environment 2.184,4** · prepare 381,0.
- 753 durações: ≥2 s **67** · ≥5 s **9** · ≥10 s **1**.
- Top 8: `erro-colapsado-em-vazio-gate` 36.979 ms · `reposicao/promocaoDetail/EventoDialog` 7.417 · `reposicao/cicloHoje/FiltersToolbar` 7.193 · `analyticsSync/ImportCards` 6.659 · `farmer/locc/NewExperimentDialog` 6.074 · `SalesQuotes.priceGuard` 5.708 · `farmer/copilot/SessionStartCard` 5.452 · `skuMapeamento/ValidacaoDialog` 5.403.
- Tetos: `testTimeout` 20 s (`vitest.config.ts`), `asyncUtilTimeout` 5 s (`setup.ts:18`); overrides `it(...,15000)` ×3; `waitFor timeout` 10_000/5000/4000 (1 cada).
- Flaky: 6 docs em `docs/historico` citam "flaky"; 16 commits `--grep=flaky` (últimos: #271 asyncUtilTimeout; #1960/#1954/#192x heavy-guard).

### Módulo de risco × cobertura (arquivos de teste resolvidos pelos globs do manifesto; soma = 726, 0 não-classificados)
| Módulo | Risco | Testes | Código (LOC, aprox.) | Leitura |
|---|---|---|---|---|
| farmer-inteligencia | — | 148 | — | densa |
| reposicao | MP | 134 | — | densa |
| plataforma | AUTH+OFF | 113 | — | densa |
| vendas | MP | 91 | — | densa (submitOrder 676 LOC → 11 testes + `origem.test.ts`) |
| telefonia-whatsapp-rota | MP+AUTH | 70 | — | ok |
| financeiro | MP+AUTH | 60 | — | ok + 7 contratos mutcheck |
| tintometrico | MP | 12 (`testes: []` no manifesto = só fora dos globs) | 2.082 lib/components + 3.696 pages/hooks | lib ok (compute/select-price), páginas 0 |
| caca | AUTH | 11 | — | ok |
| estoque-recebimento | MP+OFF | 6 (+ `offline-flow-integration`) | 1.676 | rasa nas telas de picking |
| projeto-verificado | MP | 3 | 156 | proporcional |
| prime | MP | **1** | 2.391 | **A6** |
| tarefas / producao / admin-crm | — | 8 / 0 / 6 | — | não-risco |

### Engines (hooks gigantes)
| Hook | LOC | Testes de comportamento |
|---|---|---|
| useBundleEngine | 1.369 | sim (`renderHook`, ~10 arquivos `bundle-*`) |
| useCrossSellEngine | 1.227 | sim (`cross-sell-*`) |
| useTacticalPlan | 989 | sim (`lens-tactical-plan`, `fila-plano-tatico`, …) |
| useUnifiedOrder | 1.053 | sub-hooks 6 + 1 gate textual (A5) |
| useRoutePlanner | 1.456 | **0** (helpers de `lib/route` 13) (A5) |

### Edges
- 95 dirs (sem `_shared`): 19 com teste próprio, **76 sem**; por nome money-path sem teste: 40; destas, 11 cobertas só pelo gate textual vitest (`ai-ops-agent`, `algorithm-a-audit`, `carteira-rebuild`, `fin-valor-cockpit`, `omie-cliente`, `omie-financeiro`, `omie-sync`, `omie-sync-pedidos-compra`, `omie-sync-sku-items`, `recommend`, `visit-score-recalc-client`).

### Falsificação
- `.sh` com guarda `--falsificar`: 5 (4 suítes no laço `test:falsificacao` + `codex-prompt-paginacao.sh`, que é alvo); `scripts/falsificacao-cobertura.test.ts` vigia que o laço passe a flag de verdade; `evals:deploy-verify:falsificacao` também no `validate`.
- Sentinelas: `src/__tests__` 11/12 gates; `src/lib` ~11 sem (A12, heurística).

### Infra
- `vitest.config.ts`: jsdom global, `globals`, `setupFiles` `src/test/setup.ts`, include `src/**` + `scripts/**`, `testTimeout` 20000, sem `pool`/`coverage`.
- `src/test/setup.ts` (98 linhas): `configure({ asyncUtilTimeout: 5000 })`, shim de `localStorage`/`sessionStorage` com sonda funcional, `MediaStream`, `matchMedia`. `bun-setup.ts` (69): cópia divergente (A9).
- CI (`ci.yml`, job `validate` único required): test → test:edges → edges:typecheck → sonda:bump/fingerprint/nova → canaria:bump → build → lint → claude:size → test:hooks → test:falsificacao → evals → authz → docs → knip; jobs `authz-sentinela` e `mutation-check` (20 contratos). Sem Postgres, sem E2E, sem coverage.

---

## Descartei porque…

1. **"Testes que leem edge como TEXTO são dívida"** — 55+10+10 arquivos. É o 5º gate de edge por desenho (`ci-testes-edge-deno.md` §"a TERCEIRA perna"); todos usam o stripper compartilhado onde medi (`edge-money-path-invariants` 36×, `regex local` 0). Só listei o custo do gate AST (A1) e a organização (A14).
2. **"`testes: []` = 4 módulos sem teste"** — o campo `testes:` é para arquivos FORA dos globs de `codigo` (`tipos.ts:11`); resolvendo os globs, `tintometrico` tem 12, `caca` 11, `tarefas` 8 — só `producao` tem 0, e não é módulo de risco.
3. **"`toThrow()` pelado esquecido"** — 16 dos 20 matches são `not.toThrow()`; os 4 restantes são comentários e o próprio gate `tothrow-pelado-gate` (que já cobre src/edges/scripts sem baseline). 0 real.
4. **"Mock do Supabase devolve vazio para tudo"** — 84/96 contêm `data: []` em algum lugar, mas os 6 corpos lidos são roteados por `from(tabela)`/`rpc(nome)` com seed e gravação de queries; o `data: []` é a resposta de UMA tabela, não de todas.
5. **"`render` sem asserção"** — 0 arquivos com só `toBeInTheDocument`/`not.toThrow`; os 24 com `toBeTruthy` como única forma aplicam-no sobre `getByText`, que lança se ausente (assert de presença, não vazio).
6. **"`*.parity.test.ts` sem sentinela podem ficar verdes por vazio == vazio"** — comparam arquivo inteiro (`costCompute.parity.test.ts:17-23`, `costLadder:15-17`) e `readFileSync` lança se o espelho sumir; não há extração que possa devolver vazio dos dois lados.
7. **"Timers vazando entre testes"** — 8 arquivos com `useFakeTimers`, 8 com `useRealTimers`, diferença 0.

## Arquivos de apoio (scratchpad)
`t-src-all.txt` (726), `t-edges.txt` (65), `t-scripts.txt` (25), `tip-textual-*.txt`, `modulo-cobertura.txt`, `manifesto-globs.txt` (594 globs), `edge-dirs-sem-teste.txt` (76), `mock-supabase.txt` (96) + `mock-sample-bodies.txt`, `q-truthy-only.txt` (24), `durs.txt` (753 durações), `health-test.log` (219 KB).
