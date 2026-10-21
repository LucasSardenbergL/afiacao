# RASCUNHO — Plano de melhoria do código v3 (2026-10-21)

Contexto do repo: Afiação, ERP B2B de 3 empresas do grupo (colacor, colacor_sc, oben). 5 usuários, 1 dev (founder) + dezenas de sessões de agente em worktrees paralelas. React 18 + TS strict + Supabase (Lovable Cloud) + edges Deno + Omie ERP. Regras vigentes: "canônico quando tocar"; motores/monólitos cortados salvo incidente; 1 lote = 1 sessão; **máquina meta nova (gate/sensor/sonda/hook) só com INCIDENTE citado por ID** (exceção: sensor de uso de PRODUTO que nasce com a superfície); "ausente ≠ zero" no money-path; "fase N+1 exige sinal da fase N" (sensor no ledger `analytics_outbox` via RPC `analytics_ledger_registrar`, porque o PostHog é censurado no Chrome do founder); `supabase/migrations/` intocável (DR) — mudança de banco vai por `db/*.sql` aplicado no envelope ou SQL Editor.

Plano v2 (2026-10-18) concluído inteiro em 2026-10-21: NF-e webhook completa itens (#3142), auth canônico 13→0 cópias (#3143), CI fila de runners (#3160/#3313: 38,7→19,5 min), casts `as never` 49/47→0/0 (último #3322), deriva prod≠repo 26→23 entradas aceitas (#3179–#3267), piloto N money-path.md 194→75 KB com busca 16/18→18/18 (#3185/#3318).

## 0. Baseline medida (worktree sobre origin/main `728b0cbeb`, 2026-10-21)

| Medida | Valor |
|---|---|
| typecheck | EXIT=0 (112 s) |
| lint | EXIT=0 — 0 erros, 73 warnings (46 exhaustive-deps, 27 react-refresh) |
| test (vitest) | EXIT=0 — 1064 arquivos, 13.051 passed, 2 skipped (283 s) |
| knip | EXIT=0, saída vazia |
| lint:shell | EXIT=0 — 0 achados em 573 arquivos |
| casts:stale | EXIT=0 — from 0 · rpc 0 = baseline; 0 casts literais `as never` |
| deriva:corpo:prod (psql-ro) | EXIT=0 — 410 identidades: 337 em dia · 66 cosméticas · 6 aceitas · 1 não-mensurável declarada · 20 aposentadas; baseline 23 entradas |
| pendencias:deploy | EXIT=0 — 83/83 edges conferem; 14/97 fora do alcance da sonda (sem `versao.ts`) |
| CI `validate` no PR | p50 19,4 min (n=12 PRs verdes de 16:05 a 18:13Z, depois do #3313; 12,4–29,1) |
| edges | 97 · 44 com `_test.ts` (v2: 36) · 53 sem |
| src/ | 970 arquivos de teste · 0 `.skip/.only/.todo` · 0 `any` explícito · nenhum módulo ativo com 0 testes |
| edges `as unknown` | 108 em código (64 em contexto Omie: `callOmie(...) as unknown as XResponse`) · `await req.json()` sem tipo: 34 |

Achado de método: **"edge money-path" não tem definição versionada** — o manifesto (`src/lib/modulos/manifesto.ts`) não tem glob para `supabase/functions`; o "26 de 49 sem teste" do v2 não é reprodutível. Proxy desta varredura: ~22 das 53 edges sem teste tocam Omie/estoque/pedido/preço/caixa.

## 1. Tese

O v2 fechou os passivos estruturais (tipos, auth, CI, deriva). O que sobra com dinheiro em jogo são **defeitos de dado pontuais e latentes** no financeiro e no recebimento, mais uma **fase de produto sem sinal** (aba Ciclo). Estrutura (duplicação, `as unknown` nas edges Omie, hotspots) vai para "quando tocar". Critério: impacto em dinheiro/produção × evidência ÷ custo.

## 2. Top 5 (rascunho)

### 1 · Capital de giro do cockpit de valor lê os snapshots com eixo errado — P, money-path
`supabase/functions/fin-valor-engine/index.ts:324-325`: `fin_projecao_snapshots` com `.eq(company).order(snapshot_at desc).limit(400)`, **sem filtro de `cenario` e sem janela**; `const { data: snaps }` descarta o `error`. Prod (psql-ro): 412–424 linhas por empresa em 140–145 dias, **3 cenários/dia** (realista/otimista/pessimista) → 400 linhas = ~133 dias. O ponto "−12m" do ROIC incremental (`acharCapitalGiroAnterior`, `src/lib/financeiro/valor-helpers.ts`) busca 365±60 dias → quando existir (snapshots começam 2026-05-25 → ~2027-03-26) **já terá sido cortado** e o ROIC incremental fica `null` para sempre (degrada honesto, não fabrica). Cenário misturado também afeta o "atual" se o mais recente for otimista/pessimista. Contraste correto: `src/services/financeiroV2Service.ts:772-790` (`getNcgNaJanela`: `.eq('cenario','realista')` + janela). Entrega: filtro de cenário + janela + `error` → indisponível + `_test.ts` da edge (hoje sem). Esforço P.

### 2 · NF-e efetivadas sem itens: passivo de 5 meses — medir consumidores, depois decidir — P (medir) / M (reparar)
Prod: **26 NF-e (modelo 55) `efetivado` + 1 `falha_efetivacao` sem nenhuma linha em `nfe_recebimento_itens`** (2026-04-13 a 2026-09-04); só 18 NF-e têm itens. Ou seja, 60% das NF-e efetivadas não têm itens no app. Causa (inserção do cabeçalho antes dos itens, retry caía no "já importada") corrigida no #3142; os CT-e (modelo 57) já são pulados (`omie-nfe-recebimento-sync/listagem.ts:187`). A RPC transacional responde `bloqueada` para efetivados — reparo não é automático. `docs/historico/nfe-recebimento-rpc-transacional.md:76` deixou "decisão do founder". Consumidores de `nfe_recebimento_itens`: `recebimento-lotes.ts`, `recebimento-divergencia.ts`, `recebimento-confirm.ts`, `RecebimentoConferencia.tsx`, `efetivacao-helpers.ts`. Entrega: (a) medir o que cada consumidor mostra/decide para esses 27 (rastreabilidade de lote? CMC? divergência?) → (b) 🧭 founder decide backfill read-only dos itens do Omie (sem nova baixa de estoque) ou marcar "itens não importados" na tela.

### 3 · `process-nfe`: escreve recebimento no Omie sem relógio e sem teste — M, money-path/estoque
`supabase/functions/process-nfe/index.ts` (554 linhas, sem `_test.ts`): chama `AlterarRecebimento`/`AlterarEtapaRecebimento` (`:462,482`) com `fetch` sem `AbortSignal`/timeout (`:90-110`; grep `AbortSignal|signal:|timeout` = 0); `qtdRecebida = Math.round(qtdeNfe / fatorConversao)` (`:390`) com `fatorConversao` caindo para `|| 1`, enquanto `omie-nfe-webhook/index.ts:37` e `omie-nfe-recebimento-sync/itens.ts:40` têm cada um sua cópia idêntica de `smartRound` (`|q-round|<0.05 ? round : ceil`). Três regras de quantidade para o mesmo recebimento. Uso: chamado por `NfeReceipt.tsx:72`, embutida em `/admin/estoque/recebimento` (ledger: 1 rota servida em 7 dias; sonda viu v1.2 há 8 d). Entrega: passar o Omie por `_shared/omie-chamada-relogio`; `_shared/qtd-recebimento.ts` único com `_test.ts`; teste da sequência de escrita. Divergência numérica real = INFERÊNCIA → exigir caso real antes de mudar a regra.

### 4 · Saldo de conta corrente nulo vira R$ 0 no capital de giro e no fluxo de 13 semanas — P, money-path (latente)
`src/services/financeiroService.ts:763` (`getCapitalGiro`): `c.saldo_atual || 0` alimenta `saldo_cc`, `capital_giro_liquido` (`:805`) e `saldo_projetado_30d` (`:813`). Espelho em `supabase/functions/fin-cashflow-engine/index.ts:480-481` (`Number(c.saldo_atual ?? 0)`; `exigirLinhas` cobre só a lista vazia) — saldo inicial das 13 semanas e da NCG; zero falso dispara alerta de caixa negativo. `fin_contas_correntes.saldo_atual` é nullable e `omie-financeiro/index.ts:682-699` deixa NULL quando o extrato falha em conta nova. **O mesmo arquivo já trata a classe em `:256-271`** (`saldoIndisponivel`). Prod hoje: **0 nulos** em 62 contas → latente. Entrega: replicar `saldoIndisponivel` nos dois pontos + teste.

### 5 · Sensor da aba Ciclo financeiro no ledger — M (exceção de máquina meta: sensor de produto)
`CicloTab.tsx:39,88`, `CicloGiroEstoque.tsx:125,173`, `CicloFornecedoresSecao.tsx:214,240`, `CicloDescontoPainel.tsx:16` só fazem `track()` (PostHog), que é censurado no Chrome do founder (`src/lib/analytics-ledger.ts:53-56`), e a aba é master-only (`FinanceiroCapitalGiro.tsx:47`) → o único leitor é invisível. Ledger só tem 4 eventos; `navegacao.rota_servida` vê `/financeiro/capital-giro` (5× em 7 dias), não a aba. Duas specs condicionam a fase seguinte a esse sinal: `docs/superpowers/specs/2026-10-18-ciclo-pmp-fornecedor-design.md:179` e `2026-10-14-ciclo-financeiro-cockpit-cliente-design.md:155`. Entrega: evento novo na allowlist de `analytics_ledger_registrar` (db/*.sql, ritual lovable-db-operator) + chamada nas seções. Só faz sentido se a fase seguinte do Ciclo ainda é desejada (🧭).

## 3. Depois do Top 5 (quando tocar)
- **L′** Lista versionada de edges money-path (dado, não gate) para o KPI "money-path sem teste" voltar a ser medível; a regra L do v2 (tocou → sai com `_test.ts`) segue sem dente.
- `omie-vendas-sync/index.ts:2742` (4.557 linhas, 23 commits desde 1/9; escreve PV/OP no Omie): `const { action, account, ...params } = await req.json()` — `params.*` é `any` em todos os `case`. Parse quando tocar.
- `as unknown as XResponse` nas edges Omie (64): parse na borda quando tocar a edge.
- Tintométrico: `Math.ceil(v*10)/10` inline em 9 pontos de 6 arquivos; `round2` com 3 semânticas em 7 lugares (EPSILON, sem, `floor(+0.5)` — difere em negativos). Helper único quando tocar.
- Limiar R$50/h em 3 cópias "espelha" sem teste cruzado (`useTacticalPlan.ts:268`, `_shared/tactical-margem.ts:13`, `src/lib/tactical/pregeracao.ts:7`).
- `authorizeMaster` local em `fin-funding:43`, `fin-valor-engine:24`, `fin-regime-tributario:26` (já devolvem `{ok}` e o handler testa `.ok` — sem risco de auth aberta); `timingSafeEq` em 4 edges. Trocar por `_shared/auth.ts` quando tocar.
- 11 `@ts-expect-error` "tabela não está nos types" em `fin-cashflow-engine` (`:405-456,1392,1456`): somem na regeneração de tipos das edges.
- `supabase/cron-jobs-snapshot.tsv` defasado: 107 linhas vs 115 jobs em prod (107 ativos); falta `fin-dre-recalculo-diario` (jobid 215) e os novos 222/223 → induziu um falso positivo nesta varredura. Regenerar.
- `AdminReposicaoCadastros.tsx:252`: `.limit(2000)` (capa é 1.000) + `if (error) return []`.
- Piloto N → generalizar para `database.md` (195 KB) — 🧭.

## 4. Cortado (com motivo)
- `omie-sync/index.ts:1642` `deleteOrphanOs`: `Promise.all` de 6 deletes sem checar `error`; FK `order_messages/order_reviews/loyalty_points → orders` é NO ACTION em prod (`confdeltype='a'`) → corrida real. **Mas `orders` tem 0 linhas criadas em 180 dias** → superfície dormante. Idem `useAdminOrderDetail.ts:248` (preço vazio vira R$0 e vai ao Omie).
- `useFarmerPerformance.ts:102` (IPF null→0): `farmer_performance_scores` tem **0 linhas** em prod.
- "DRE sem recomputo automático": **falso** — cron `fin-dre-recalculo-diario` (jobid 215, 15:30 UTC) ativo e recalculou mês corrente+anterior hoje (`docs/historico/dre-sem-escritor-automatico.md`).
- Falhas do snapshot de caixa (colacor sem snapshot em 14–20/10): já tratadas por outra entrega (#3252/#3319; jobs por empresa 222/223 criados, 3/3 em 21/10) → só KPI.
- Pinar `npm:@supabase/supabase-js@2` nas 89 edges: sem incidente em edge.
- Gate "edge money-path tocada exige `_test.ts`": máquina meta sem incidente.
- `whatsapp-send-template` (módulo congelado); `omie-webhook` TOCTOU (handlers são stubs).
- Hotspots de conflito (`manifesto.ts` 82 commits, `sonda-fingerprints.ts` 162, `db/nucleo-ci.txt` 126): custo real de dev, mas mexer = máquina meta/refactor sem incidente.
- Continuam cortados do v2: I3, K3, mutirão M, J2-mover, M-57, M-58, M-50, majors.

## 5. Decisões do founder 🧭 (rascunho)
1. NF-e: depois da medição do item 2, backfill read-only dos itens das 27 NF-e ou marcar "itens não importados"? Recomendo: decidir pela medição; se lote/divergência/CMC leem os itens, backfill.
2. Ciclo: a fase seguinte do Ciclo (alerta de vencimento com desconto; piloto desconto/degrau) ainda é desejada? Se sim, item 5; se não, cortar o item 5.
3. Piloto N → `database.md`: generalizar com as lições (2º leitor + regressão de âncoras antes do merge)?

## 6. KPIs
- ROIC incremental do cockpit: snapshots lidos por cenário e janela (teste) · edges money-path sem `_test.ts` (após L′) · NF-e efetivadas sem itens (27 → decisão) · contas com `saldo_atual` nulo mostradas como 0 (0 hoje) · eventos da aba Ciclo no ledger (com denominador: rota `/financeiro/capital-giro`) · CI p50 até `validate` (19,4 min) · dias com 3/3 snapshots de caixa por empresa.
