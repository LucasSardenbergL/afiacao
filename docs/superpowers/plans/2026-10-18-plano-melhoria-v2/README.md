# Plano de melhoria do código — v2 (2026-10-18)

> Sucede o [plano de 2026-09-05](../2026-09-05-plano-melhorias-codebase/README.md), cujos lotes A–G fecharam em 2026-10-13. Herda as decisões do §0.3/§0.5 daquele plano (5 usuários · 1 dev · **"canônico quando tocar"** · motores/monólitos cortados salvo incidente · 1 lote = 1 sessão · arquivo quente = 1 dono). Não reabre o que foi cortado.
>
> **Método:** 2 varreduras (Fable) + health stack local + 2ª opinião adversária do **Codex** (gpt-6-astra · reasoning max · 307 s · 160k tokens) sobre o rascunho — parecer cru em [anexos/parecer-codex-2026-10-18.md](anexos/parecer-codex-2026-10-18.md). O Codex derrubou ~40% do rascunho; o que ele afirmou e foi **conferido no código** está marcado ✅, o que ficou plausível sem conferência, ⚠️.
> `Codex: desenho=gpt-6-astra·max·307s·160k · código=n/a (plano) · extra=nenhum`

## 0. Baseline medida (worktree sobre `895198047`)

| Medida | Valor |
|---|---|
| typecheck · lint · knip · shellcheck | **exit 0** (lint: 0 erros, 74 warnings: 47 `exhaustive-deps`, 27 `react-refresh`) |
| `src/` | 2.464 ts/tsx · 902 testes · 17 módulos |
| edges | 97 · 36 com `_test.ts` (37%) · money-path **26 de 49 sem teste** |
| CI `validate` | **16–21 min**; caminho crítico `falsificacao` 16 min **e** `provas-sql (1)` 15 min (fatias 15/8/13/8). `bun run test`/`lint:shell`/`test:falsificacao` rodam **1×** (a varredura dizia 3×: errado) |
| Pós-merge | `auto-merge.yml:65` dispara o CI da main só se o **workflow inteiro** do PR foi verde — inclui `mutation-check` (12–20 min, informativo) ✅ |
| Gate `authorizeCronOrStaff` | `_shared/auth.ts:45` + **13 cópias locais** ✅; o handler testa booleano (`disparar-pedidos-aprovados:1723`) — `AuthResult` `{ok:false}` é truthy ✅ |
| Casts que desligam o tipo | `casts:stale` mede **49/47** (não 49/33); piso `castsLiterais: 40` em `casts-stale-gate.ts:42` **impede chegar a 0** ✅; wrappers `from(name as never)` ficam fora da medição ⚠️ |
| Deriva prod ≠ repo | `deriva-corpo-baseline.json`: 26 entradas = 18 funções · 21 PATCH · 4 EDICAO_MANUAL · 1 NAO_MENSURAVEL ⚠️ (Codex) |
| `docs/agent/` | 1,0 MB; `database`/`money-path`/`deploy` ≈ 190 KB cada; `gates:frescura` **lê `deploy.md`** (`gates-frescura-check.ts:645`) ⚠️ |
| Falsos problemas (não perseguir) | `useMutation` cru (100% pré-convenção) · `Loader2` de página (2) · toast (0) · TODO/FIXME (19 reais, não 163) · `test-wt-*` órfãos (**já rodam no `test:hooks`** ✅) · `anthropic`/`anthropic-cliente` e `omie-deadline`/`omie-chamada-relogio` (são camadas, não duplicatas ⚠️) · `sonda-fingerprints` órfão (consumidor transitivo em `sonda-versao.ts:14` ⚠️) |

## 1. Tese (pós-Codex)

Critério de ordem: **impacto em dinheiro/produção × evidência do defeito ÷ custo de corrigir, verificar e entregar**. Sobraram do plano anterior quatro passivos que não diminuem sozinhos — dívida congelada em baseline, segurança replicada, CI longo, "canônico quando tocar" sem dente — e o Codex acrescentou um **defeito concreto** (NF-e) que vai na frente de toda melhoria estrutural.

## 2. Top 5 — na ordem (1 item = 1 PR · 1 lote = 1 sessão)

### 1 · NF-e: gravação completa e repetição após falha — **money-path, esforço M**
`omie-nfe-webhook/index.ts`: o cabeçalho é inserido (`:194`) antes dos itens; se os itens falham, a resposta é 500 e o cabeçalho fica; a repetição encontra o cabeçalho no duplicate-check (`:105`) e responde "já importada" **sem reparar os itens** ⚠️ (achado Codex; inserts conferidos, caminho de falha a confirmar no PR). Entrega: transação/compensação + teste Deno da sequência (falha nos itens → retry recupera). Ritual money-path completo (`RÉGUA:` + adversarial no diff).

### 2 · H · Segurança replicada — **esforço P–M** (arquivo quente `_shared/auth.ts`)
Ordem corrigida pelo Codex: **(a) testes negativos nos 13 HANDLERS** (sem token → 401 **e zero efeito**), **(b) só então** apagar as 13 cópias e importar `_shared/auth.ts`, trocando o teste booleano por `.ok` (`fin-cashflow-engine` já retorna `AuthResult`). Corrigir o comentário de `auth.ts:43`. `sonda:bump` em cada edge; deploy em 2 levas de ~7 (founder). Pronto: 0 cópias · 13 testes negativos verdes · `pendencias:deploy` zerado.

### 3 · J · CI: corrigir dependência e encurtar sem perder a falsificação pré-merge — **esforço P–M** (arquivo quente `ci.yml`/`auto-merge.yml`)
- **J0** Pós-merge depende indevidamente de `mutation-check` (informativo): uma falha dele cala o CI da main ✅. Corrigir a condição em `auto-merge.yml:65`.
- **J1** Rebalancear as 4 fatias de `provas-sql` (15/8/13/8 → ~11).
- **J2** `falsificacao` (16 min): fatiar em 2–3 jobs **obrigatórios** (todas no `needs` do `validate`), nunca mover para main/schedule — o próprio `ci.yml:899` registra falsificação vermelha pós-merge. `gates:rapidos` não substitui.
- **J3** Medir **no PR** (tempo até `validate`, fila, minutos de runner), antes/depois no corpo do PR. Pronto: `validate` ≤ 12 min no PR.

### 4 · I1 · Casts que desligam o tipo — **esforço M**
Começar pelos **caminhos ativos**: `usePedidosProgramados.ts:73` (inclui wrapper `from(name as never)`) e reposição; **não** por `useTarefas` (módulo `congelado` ✅). Cada PR: remove casts literais **e** de retorno (`data as X`), baixa a baseline **e o piso** (`castsLiterais: 40` → o que sobrar). Pronto: baseline = piso = contagem real, 0 nos módulos ativos.

### 5 · I2 · Deriva prod ≠ repo em SQL — **esforço M** · 🧭
Focar `reconciliar_pedidos_omie` e `pedido_total_liquido_converter` (correções financeiras aplicadas à mão que um `CREATE OR REPLACE` do repo **apagaria**). Copiar o corpo para `db/` não basta: o auditor reconstrói a expectativa das migrations de `origin/main` (`audit-deriva-corpo-prod.ts:245`) — e migrations são intocáveis (DR). Decisão 🧭 #1 abaixo.

## 3. Depois do Top 5 (quando tocar / piloto)
- **L** · Edge money-path **tocada** sai do PR com `_test.ts` (26/49 sem teste; próximas: `fin-cashflow-engine`, `fin-valor-engine`, `omie-webhook`, `omie-cliente` ramos de escrita). Não é extrair monólito (M-58 segue cortado).
- **K1** · Moeda: usar `formatPrecoOuAusente` (`src/lib/format.ts:149`) quando tocar; **não** criar sinônimo nem regra ESLint (barrar `style:'currency'` não corrige cálculo).
- **K2** · `functions.invoke`: migrar só os **9** `if (error) throw error` que escondem o corpo do erro; `invokeFunction` exige sessão (`invoke-function.ts:31`), não é substituto universal.
- **N** · `docs/agent/` — **piloto em 1 domínio** (sugestão: `money-path.md`, 195 KB; `deploy.md` não, pois `gates:frescura` o lê): regras vivas com condição · obrigação · exceções · ponteiro para a evidência; casos vão para `docs/historico/`. Medir contexto carregado e erros de execução antes de generalizar.
- **Pontuais sobreviventes do antigo lote M**: `FinanceiroGestao.tsx:64` mostra saldo bancário **0 fixo = informação falsa** ✅ → ocultar o indicador ou "indisponível" (não implementar a tela); `manifesto.ts` desatualizado (`caca` tem 11 testes, manifesto diz 0); 3 `keydown` redundantes (`HelpDrawer.tsx:64`, `CockpitGrid.tsx:56,66`, `ShortcutsDialog.tsx:43`).

## 4. Cortado (com motivo)
- **I3** ratchet de fronteiras: M-56 já estava cortado; contador global editado por dezenas de sessões = conflito permanente. Se voltar (só com incidente): comparar arestas **adicionadas pelo PR** contra a base do merge, remoções independentes, sem redução obrigatória.
- **K3** `useUrlState` por nome de variável: busca temporária/debounce são contraexemplos; nome não determina estado persistível.
- **M como mutirão**: metade dos "órfãos" era falso positivo (ver §0).
- **J2-mover** falsificação para fora do PR: remove barreira do auto-merge por ~1 min.
- Continuam cortados: M-57 motores · M-58 monólitos · M-50 paginação em massa · gate novo sem incidente (`maquinas-meta.md:11`) · majors.

## 5. Decisões do founder 🧭
1. **I2**: como fechar a representação reconstituível das 18 funções sem tocar `supabase/migrations/` (DR)? Opções: (a) migration "canônica" nova via Lovable com o corpo da prod + prova de comportamento; (b) baseline aceita + teste `db/test-*.sh` que falha se o corpo da prod mudar. Recomendo (a) para as 2 funções financeiras, (b) para o resto.
2. **N**: aprovar o piloto em `money-path.md`?
3. **Saldo bancário**: ocultar o indicador em `FinanceiroGestao` até existir `fin_saldo_bancario`?

## 6. KPIs
tempo até `validate` **no PR** (p50) · cópias de `authorizeCronOrStaff` · `casts:stale` from/rpc e piso · entradas de deriva (por função) · edges money-path sem teste · bytes de `money-path.md` (piloto N).

## 7. Calibração do parecer (separada do parecer cru)
Conferido no código ✅: 1723 (booleano), piso 40, `auto-merge.yml:65`, `formatPrecoOuAusente`, `saldoBancario = 0`, `test-wt-*` no `test:hooks`, `tarefas` congelado, inserts da NF-e em 105/194. Não conferido ⚠️: caminho de falha dos itens da NF-e, contagem 18/21/4/1 da deriva, camadas `anthropic*`/`omie-*`, consumidor transitivo de `sonda-fingerprints`. Discordância: nenhuma de fundo; o Codex viu o rascunho **antes** da minha correção do lote J (que ele também apontou).
