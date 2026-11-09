# Plano de melhoria v4 — velocidade e afins (2026-11-01)

> Levantamento em 3 eixos por varreduras Fable (app no navegador · banco/edges em prod · dev/CI), revisão adversária do Codex e conferência minha no código/prod. Base: `origin/main` `11fe0913a`.
> Codex: desenho=gpt-6-astra·max·236.808 tokens · código=— · extra=nenhum. Parecer cru: [anexos/parecer-codex-2026-11-01.md](anexos/parecer-codex-2026-11-01.md).

## 1. Como ler

- **Número medido** = build de produção (`heavy bun run build`, 2026-11-01), `psql-ro` em prod (contadores `pg_stat_user_*` de **34 h** desde o restart de 2026-10-31), runs do GitHub Actions (15 últimos verdes de PR), cronômetro local.
- **Estimado** = ganho em segundos no app. **Não há RUM** (zero web-vitals; PostHog 30 d só tem `$autocapture`/`$pageview`): bytes e requisições são fatos, segundos são chute.
- Veredito final = meu, depois do Codex. ✔ = conferi no código/prod.

## 2. Itens, um a um

### A. Desenvolvimento e CI

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| A1 | Recalibrar `db/nucleo-ci-custo.txt` + `timeout-minutes` 20→25 no `provas-sql` | Previsão 847 s/parte, real 930–1.130 s; 16 provas sem custo (default 30 s); shard 2 p50 18,9 / max 19,9 min contra teto 20 → 2/15 runs cancelados e re-rodados (+25 min) | MANTER; ganho real é **3,3 min/run** (só os retries), não 6 | **FAZER** — lote 1 |
| A2 | `typecheck:app` com heap 4 GB + `--incremental` | ✔ nenhum tsconfig com `incremental`. Hoje **crasha** (exit 134, tsc pede 2,27 GB, heap default 2.144 MB). Com o ajuste: 44,9 s frio / 4,0 s quente | MANTER; cache por projeto/worktree, heap só no comando | **FAZER** — lote 2 |
| A3 | Comando rápido explícito (`test:rapido`) sem os testes que spawnam processo | `exclusividade-medir.test.ts` = 90 s de 170 s do `bun run test` | MANTER com ajuste: `test` e CI seguem completos; classificar por custo medido (os "28 síncronos" eram 14) | **FAZER** — lote 2 (config estática, não é máquina) |
| A4 | `.gitattributes merge=union` em `db/nucleo-ci.txt` e `docs/historico/README.md` | 104 e 145 commits/30 d; ~21 resoluções/mês | CORTAR: `nucleo-ci.txt` tem contratos editáveis, união gera duplicata que o runner rejeita | **FAZER só no `docs/historico/README.md`** (corte revertido pelo founder em 2026-11-01) — lote 2; `nucleo-ci.txt` segue fora |
| A5 | Tirar lint/typecheck quente do `heavy` | Espera de até ~30 s | CORTAR: cache invalidado volta ao caminho frio de 2,2 GB | **CORTADO** |

Não entram: compartilhar `node_modules` (clonefile APFS, +18 MB), cache de deps no CI (já ok), consolidar hooks (284 ms), podar worktrees.

### B. Banco e edges (prod)

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| B0 | Liberar `pg_stat_statements` (top consultas por tempo) | `claude_ro` recebe `permission denied`; hoje só se sabe **qual tabela**, não **qual consulta** | MOVER ↑: founder pode consultar 1× no SQL Editor sem grant permanente | **DECISÃO DO FOUNDER** — pré-requisito do lote 7 |
| B1 | Scores: retenção 90→30 d + drop de 4 índices sem uso | 807 MB (13% do banco), +92,8 k linhas/7 d cada tabela; 209 MB de índice com 0 scans em 34 h | MOVER ↓ e separar. ✔ cron é **mensal** (`30 4 1 * *`) → corte de 30 d acumula 30–61 d; 34 h não basta para drop; nenhum leitor operacional achado | **DEPOIS** — decidir horizonte de auditoria; drop só com ≥7 d de contador |
| B2 | Diff-before-write em `inventory_position`/`product_costs` | 294 k updates/34 h em 7,1 k linhas, >92% iguais | MOVER ↓: ✔ `_data_health_compute` lê `synced_at`/`updated_at` como frescor (3 h / 30 h) e o CMC é rejeitado após 48 h sem confirmação | **ADIADO** — exige redesenho que preserve frescor por linha; money-path |
| B3 | `fin_contas_receber` incremental | 45.617/45.660 reescritas em 12 h, ~900 páginas Omie/dia | MOVER ↓: "97% baixadas" ≠ imutáveis; full semanal com upsert não reconcilia exclusões; frescor 26 h | **ADIADO** — money-path (crédito/DSO), contrato Omie a validar |
| B4 | Expurgo tintométrico + índice `tint_importacoes(account, created_at DESC)` | 272 MB sem retenção; 137 seq scans × 109 k linhas | MANTER com escopo menor: `tint_sync_runs` guarda idempotência, `tint_importacoes` é referenciada por fórmulas | **Índice: lote 7. Expurgo: depois**, preservando FK e janela de replay |
| B5 | `fin_sync_log`: índice parcial `(completed_at DESC) WHERE status='complete'` | ✔ só índice em `started_at`; 4.938 seq scans/34 h | MANTER condicionado ao plano (filtra também `action`) | **FAZER** — lote 7, após EXPLAIN |
| B6 | `sales_orders(customer_user_id)` | ✔ nenhum índice; 20.249 seq scans/34 h | MANTER corrigindo: a policy de customer **não** tem `deleted_at IS NULL` → índice parcial não serve | **FAZER** — lote 7, índice completo, após EXPLAIN |
| B7 | `addresses(user_id)` | ✔ só pkey; 3.637 seq scans, tabela de 2 MB | MOVER ↓ | **BAIXA** — entra no lote 7 só se o EXPLAIN mostrar ganho |
| B8 | `omie_products(account)` | 56.496 seq scans/34 h, atribuição indireta | MOVER ↓ até B0 (poucas contas → scan pode ser o plano certo) | **ESPERA B0** |
| B9 | Diff-before-write em `omie_products` (vendas-sync) | 136 k updates/34 h em 8 k linhas | MOVER ↓: grava **preço** e serve de frescor; tabela tem outros escritores | **ADIADO** — e só depois de N2 |

Já cortado/resolvido (não reabrir): `tint-promocao-tick` (M-43); watchdog fase 5 (v5 aplicada hoje, 600 s → 25 s); `picking-fila-omie` serial (M-58 adjacente). Sem número: índices de `radar_empresas` (403 MB, 0 scans em 34 h — medir ≥7 d).

### C. App no navegador

| # | Item | Evidência | Codex | Veredito |
|---|---|---|---|---|
| C1 | `@babel/runtime` em `vendorChunk` → home sem recharts | ✔ regra ausente (`vite.config.ts:348`). Home do gestor +169 KB gz além do entry, **114 KB gz** é `vendor-charts` puxado pelo drag-and-drop por 2 helpers; 13 chunks puxam recharts, ~8 têm gráfico | MANTER, alta prioridade; verificar o fecho no build novo | **FAZER** — lote 3 |
| C2 | Home: tirar leituras duplicadas e paralelizar zonas | ✔ `Index.tsx:35,44` refaz `profiles`/`commercial_roles` antes do dashboard; 4 `await` em série por zona | MANTER fatiado: o profile não é usado pela home staff; o cargo **respeita "Ver como"** (não trocar por `useAuth`); `Promise.all` só nas independentes | **FAZER a fatia 1** (gate do profile) — lote 5; paralelização depois |
| C3 | `/pedidos`: busca no servidor + recorte limitado | ✔ drain de 5×1.000 linhas por abertura (1,19 MB), recorte arbitrário de 5 k de 32 k; até 5 k cards no DOM | MANTER com contrato de busca (o próprio código prevê busca no servidor); virtualizar só se sobrar gargalo | **FAZER** — lote 8 |
| C4 | Farmer: janela de 12 meses e sem `items` | 32 k linhas / 14 MB, 33 requisições em série | CORTAR: muda população, recência e cestas — é regra comercial | **NÃO como está** — ✔ prod: **724 de 1.233 clientes (59%)** não compram há >12 meses e sairiam do score; 81% dos pedidos (25.955/32.155) são >12 meses. Trocado por **C4′** (decisão do founder em 2026-11-01) |
| C4′ | Farmer sem mudar o score: os 3 motores (`useFarmerScoring`, `useCrossSellEngine`, `useBundleEngine`) baixam o **mesmo universo** (mesma denylist + `deleted_at IS NULL`) cada um por conta, em páginas de 1.000 **em série** | ✔ `fetchAllPages` é laço sequencial (`postgrest.ts:230`) | — | **FAZER** — lote 16: uma consulta compartilhada (react-query, união das colunas) com páginas em paralelo, local a esses 3 hooks (não mexe nos 82 call sites → não reabre M-50) |
| C5 | Badges da sidebar com `count` | — | CORTAR: ✔ os dois já têm `enabled: !CONGELADO` | **CORTADO** → substituído por N4 |
| C6 | Cockpit financeiro: RPC `sum(saldo)` + react-query | Varreduras paginadas por mount, sem cache | MOVER: separar RPC de cache; "60 k linhas" não demonstrado (filtra empresa/status) | **DEPOIS** — money-path, prova SQL + Codex |
| C7 | WebRTC (263 KB / 61 KB gz) baixado no boot de todo staff | ✔ provider só checa `isStaff`; ✔ módulo Telefonia **congelado** até 2027-01-10 (0 uso) | MOVER ↑ reformulado: respeitar o congelamento; adiar até "ligar" quebraria recebimento passivo | **FAZER** — lote 4 |
| C8 | `useMemo`/`memo` em AdminReposicaoPedidos e sidebar | Ausência de memo, ≤771 itens | CORTAR sem perfil de render | **FAZER** (corte revertido pelo founder em 2026-11-01) — lote 10, com React Profiler antes/depois |
| C0 | RUM (web-vitals) | Não existe | Fora sem incidente (regra de máquina meta) | **FAZER — lote 0**: exceção à regra de máquina meta **autorizada pelo founder em 2026-11-01** (citar no PR). Linha de base antes dos lotes de app; com ~5 usuários staff a amostra é pequena — comparar por rota, p75, semanas inteiras |

### N. Achados novos do Codex (todos ✔ conferidos por mim)

| # | Item | Evidência | Veredito |
|---|---|---|---|
| N1 | `FarmerGovernance` monta `useFarmerScoring` só para ler `{ config }` → baixa histórico e calcula a carteira à toa | ✔ `FarmerGovernance.tsx:35` | **FAZER** — lote 5 |
| N2 | `omie-vendas-sync`: erro no upsert de produtos só loga e segue → run termina `complete`/`success:true` | ✔ `index.ts:506-511` | **FAZER** — lote 6 (robustez; edge deploy; precede B9) |
| N3 | Zona Sistema da home fabrica zero em erro (`count ?? 0`, ignora `error`) | ✔ `useSistemaZone.ts:42-49` | **FAZER** — lote 5 (regra ausente ≠ zero) |
| N4 | `useCriticaFila` chama SLA WhatsApp, rota e tarefas **sem** respeitar o congelamento | ✔ `useCriticaFila.ts:48-50` | **FAZER** — lote 4 (preservar "indisponível", nunca zero) |

## 3. Roteiro (1 lote = 1 PR)

| Lote | Conteúdo | Quem aplica | Ganho |
|---|---|---|---|
| 0 | C0 — web-vitals por rota via `track()` (linha de base; Publish antes dos lotes 3–5 e 8, que esperam ~1 semana de dado — os lotes 1, 2, 6 e 7 não dependem dele) | sessão + **Publish** | medir em vez de estimar |
| 1 | A1 — custos do núcleo + timeout 25 | sessão (merge = no ar) | −3,3 min/run médio; fim dos 13% de re-run |
| 2 | A2 + A3 + A4 — loop local (heap + incremental; `test:rapido`; `merge=union` no `docs/historico/README.md`) | sessão | typecheck de crash → 45 s/4 s; teste local −60 a −90 s |
| 3 | C1 — `@babel/runtime` fora do vendor-charts | sessão + **Publish** | −114 KB gz na home do gestor |
| 4 | C7 + N4 — congelamento da Telefonia/WhatsApp/Rota nos consumidores ainda ativos | sessão + **Publish** | −61 KB gz no boot de todo staff; menos polling |
| 5 | N1 + C2 fatia 1 + N3 — leituras inúteis e zero fabricado | sessão + **Publish** | menos round-trips na home e no Farmer; dado honesto |
| 6 | N2 — falso sucesso do catálogo | sessão + **deploy de edge** (`pendencias:deploy`) | robustez |
| 7 | B5 + B6 (+B7, +índice de B4) — índices justificados por EXPLAIN | sessão escreve migration nova; **founder aplica** | fim de ~25 k seq scans/34 h |
| 8 | C3 — busca de Pedidos no servidor | sessão + **Publish** | abertura sem 1,2 MB; busca alcança os 32 k |

### Segunda leva (decisão ou desenho próprio)

| Lote | Conteúdo | Depende de | Quem aplica |
|---|---|---|---|
| 9 | B0 — top consultas por tempo (consulta pontual no SQL Editor) → decide B8 | — | **founder** (SQL Editor) |
| 10 | C2 fatia 2 + C8 — `Promise.all` nas consultas independentes das zonas da home; memo em AdminReposicaoPedidos e na sidebar | lote 5 | sessão + Publish |
| 11 | B1 — retenção dos scores (horizonte + expurgo semanal em vez de mensal) e drop dos índices mortos | horizonte de auditoria decidido; ≥7 d de contador | sessão escreve migration; founder aplica |
| 12 | B4 expurgo — tintométrico preservando FK de fórmulas e janela de idempotência | lote 7 | sessão escreve migration; founder aplica |
| 13 | C6 — RPC agregada do cockpit financeiro + react-query | prova SQL + Codex (money-path) | sessão + migration + Publish |
| 14 | B2 + B9 — reduzir custo da reescrita **sem** perder frescor por linha (avaliar fillfactor/HOT antes de pular escrita) | N2 (lote 6); Codex | sessão + edge deploy |
| 15 | B3 — `fin_contas_receber` incremental com reconciliação | contrato Omie validado; prova SQL + Codex (money-path) | sessão + edge deploy |
| 16 | C4′ — consulta compartilhada e paralela dos 3 motores do Farmer (mesmo dado, mesmo score) | lote 0 (linha de base) | sessão + Publish |

## 4. Cortado neste ciclo

A5 (risco de RAM) e C5 (badges já desligados; intenção coberta por N4). C4 como formulado (tiraria 59% dos clientes do score) → substituído por C4′. A4, C8 e C0 foram cortados pela análise e **revertidos pelo founder em 2026-11-01**.
