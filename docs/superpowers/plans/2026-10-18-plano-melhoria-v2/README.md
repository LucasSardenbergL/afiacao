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

### 4 · I1 · Casts que desligam o tipo — **esforço M** · ✅ **feito (2026-10-21)**
Começar pelos **caminhos ativos**: `usePedidosProgramados.ts:73` (inclui wrapper `from(name as never)`) e reposição; **não** por `useTarefas` (módulo `congelado` ✅). Cada PR: remove casts literais **e** de retorno (`data as X`), baixa a baseline **e o piso** (`castsLiterais: 40` → o que sobrar). Pronto: baseline = piso = contagem real, 0 nos módulos ativos.

**Fecho (2026-10-21, medido na main `b79f1dfd8`):** 0 `as never`/`as unknown as` em código nos módulos ativos, exceto os residuais documentados abaixo. `casts:stale` termina em from/rpc **16/12**, com piso `castsLiterais` **28** = contagem real (`CASTS-STALE-OK`). O que sobra está todo em módulos congelados: knowledge-base 25, loja-afiacao 14, prime 1, producao 8, tarefas 26 e telefonia-whatsapp-rota 34 (contagem só de código, sem comentários). PRs, em ordem:
1. #3158 pedidos programados ([casts-pedidos-programados.md](../../../historico/casts-pedidos-programados.md))
2. #3162 reposição ([casts-reposicao.md](../../../historico/casts-reposicao.md))
3. #3187 governança/DES ([casts-governanca-des.md](../../../historico/casts-governanca-des.md))
4. #3228 admin-crm + tintométrico ([casts-admin-crm-tint.md](../../../historico/casts-admin-crm-tint.md))
5. #3244 estoque-recebimento ([casts-estoque-recebimento.md](../../../historico/casts-estoque-recebimento.md))
6. #3257 e #3262 plataforma, com `comNulo` em `src/lib/rpc-args.ts` ([casts-plataforma.md](../../../historico/casts-plataforma.md))
7. #3265 vendas ([casts-vendas.md](../../../historico/casts-vendas.md))
8. #3268 caça ([casts-caca.md](../../../historico/casts-caca.md))
9. #3272 financeiro, money-path ([casts-financeiro.md](../../../historico/casts-financeiro.md))
10. #3273 farmer-inteligencia, pela sessão-mãe ([casts-farmer-inteligencia.md](../../../historico/casts-farmer-inteligencia.md))

Residual em módulo ativo (2026-10-21, depois do PR de fecho do ciclo 2):
- `useVendaPainel` (farmer-inteligencia, 1): `venda_painel`/`venda_repasse_candidatos` ainda não estão no `types.ts`. É o uso legítimo do cast, sobre nome que o gerador não conhece, e o gate não o conta. Sai na próxima regeneração.
- ~~`useRaioXMutacoes` (reposição, 2)~~ e ~~`useExcecoesGestor` (governança, 3)~~ saíram. O raio-X passou a usar `comNulo`, com as 4 chaves NULL conferidas na prod. O `useExcecoesGestor` é governança no manifesto (o card "Exceções" do MasterDashboard) e só LÊ as views da família tarefas, que já estão no `types.ts`: a borda exige `id`/`descricao`/`effective_due` com `linhasCom`, e `customer_metrics` passou a ser lido por forma (ausente ≠ 0). Detalhe em [plano-v2-ciclo-2.md](../../../historico/plano-v2-ciclo-2.md).

Defeitos que os casts escondiam (detalhe nos docs): 3 queries 400 na reposição; 4 KPIs de /vendas/ferramentas sobre tabelas inexistentes; o DRE consolidado da tela Intercompany quebrava ao renderizar; a RPC intercompany aplica a eliminação ao CMV com o sinal trocado (correção SQL proposta em sessão própria).
### 5 · I2 · Deriva prod ≠ repo em SQL — **esforço M** · 🧭
Focar `reconciliar_pedidos_omie` e `pedido_total_liquido_converter` (correções financeiras aplicadas à mão que um `CREATE OR REPLACE` do repo **apagaria**). Copiar o corpo para `db/` não basta: o auditor reconstrói a expectativa das migrations de `origin/main` (`audit-deriva-corpo-prod.ts:245`) — e migrations são intocáveis (DR). Decisão 🧭 #1 abaixo.

## 3. Depois do Top 5 (quando tocar / piloto)
- **L** · Edge money-path **tocada** sai do PR com `_test.ts` (26/49 sem teste; próximas: `fin-cashflow-engine`, `fin-valor-engine`, `omie-webhook`, `omie-cliente` ramos de escrita). Não é extrair monólito (M-58 segue cortado).
- **K1** · Moeda: usar `formatPrecoOuAusente` (`src/lib/format.ts:149`) quando tocar; **não** criar sinônimo nem regra ESLint (barrar `style:'currency'` não corrige cálculo).
- **K2** · `functions.invoke`: migrar só os **9** `if (error) throw error` que escondem o corpo do erro; `invokeFunction` exige sessão (`invoke-function.ts:31`), não é substituto universal.
- **N** · `docs/agent/` — **piloto em 1 domínio** (sugestão: `money-path.md`, 195 KB; `deploy.md` não, pois `gates:frescura` o lê): regras vivas com condição · obrigação · exceções · ponteiro para a evidência; casos vão para `docs/historico/`. Medir contexto carregado e erros de execução antes de generalizar. ✅ **feito** — reescrita no [#3185](https://github.com/LucasSardenbergL/afiacao/pull/3185) (2026-10-19, 194.593 → 73.038 bytes) + verificação pós-merge (2026-10-21: auditoria de cobertura, âncoras, proxy de grep e a regra do jsonb multi-writer que o CLAUDE.md apontava para cá e nunca esteve lá) → [money-path-regras-vivas-piloto-n.md](../../../historico/money-path-regras-vivas-piloto-n.md). Generalizar a outro doc de `docs/agent/` é decisão nova, com essa medição na mão.
- **Pontuais sobreviventes do antigo lote M**: `FinanceiroGestao.tsx:64` mostra saldo bancário **0 fixo = informação falsa** ✅ → ocultar o indicador ou "indisponível" (não implementar a tela); `manifesto.ts` desatualizado (`caca` tem 11 testes, manifesto diz 0); 3 `keydown` redundantes (`HelpDrawer.tsx:64`, `CockpitGrid.tsx:56,66`, `ShortcutsDialog.tsx:43`).

## 4. Cortado (com motivo)
- **I3** ratchet de fronteiras: M-56 já estava cortado; contador global editado por dezenas de sessões = conflito permanente. Se voltar (só com incidente): comparar arestas **adicionadas pelo PR** contra a base do merge, remoções independentes, sem redução obrigatória.
- **K3** `useUrlState` por nome de variável: busca temporária/debounce são contraexemplos; nome não determina estado persistível.
- **M como mutirão**: metade dos "órfãos" era falso positivo (ver §0).
- **J2-mover** falsificação para fora do PR: remove barreira do auto-merge por ~1 min.
- Continuam cortados: M-57 motores · M-58 monólitos · M-50 paginação em massa · gate novo sem incidente (`maquinas-meta.md:11`) · majors.

## 5. Decisões do founder 🧭
1. **I2**: como fechar a representação reconstituível das 18 funções sem tocar `supabase/migrations/` (DR)? Opções: (a) migration "canônica" nova via Lovable com o corpo da prod + prova de comportamento; (b) baseline aceita + teste `db/test-*.sh` que falha se o corpo da prod mudar. Recomendo (a) para as 2 funções financeiras, (b) para o resto.
2. **N**: aprovar o piloto em `money-path.md`? ✅ **aprovado (2026-10-21)**: "reescrever o money-path.md como regras vivas (condição · obrigação · exceções · ponteiro), casos para docs/historico, medindo contexto antes e depois" — a reescrita já estava na main desde o #3185; a aprovação ratificou e pediu a medição, entregue na verificação pós-merge.
3. **Saldo bancário**: ocultar o indicador em `FinanceiroGestao` até existir `fin_saldo_bancario`?

## 6. KPIs
tempo até `validate` **no PR** (p50) · cópias de `authorizeCronOrStaff` · `casts:stale` from/rpc e piso · entradas de deriva (por função) · edges money-path sem teste · bytes de `money-path.md` (piloto N).

| KPI | Baseline (2026-10-18) | Fim do ciclo 1 | Ciclo 2 (2026-10-20) |
|---|---|---|---|
| `casts:stale` from/rpc · piso `castsLiterais` | 49/47 · 40 | 23/29 · 52 | **14/12 · 26** (2026-10-21, item 4 ✅: plataforma #3257/#3262, vendas #3265, caça #3268, financeiro #3272, farmer #3273, governança + raio-X no PR de fecho do ciclo 2); em módulo ativo resta só o `useVendaPainel` (nome ainda fora do `types.ts`); o resto está em congelados |
| entradas de deriva (`deriva-corpo-baseline.json`) | 26 | 24 | **23** (2026-10-21) = as 22 do ciclo 2 + `claim_nfe_efetivacao_lock` (#3258, outra entrega); `analytics_outbox_pedido_compra` canonizada (#3260), aplicada na prod e fora da baseline (#3261); auditor exit 0 e prova E 32/0 contra a prod; justificativas por entrada ([plano-v2-ciclo-2.md](../../../historico/plano-v2-ciclo-2.md)) |
| cópias locais de `authorizeCronOrStaff` | 13 | 0 | 0 |
| bytes de `money-path.md` | ≈190 KB | — | 73 KB |
| tempo até `validate` no PR (p50) · edges money-path sem teste | 16–21 min · 26/49 | — | não medidos neste ciclo |

## 7. Calibração do parecer (separada do parecer cru)
Conferido no código ✅: 1723 (booleano), piso 40, `auto-merge.yml:65`, `formatPrecoOuAusente`, `saldoBancario = 0`, `test-wt-*` no `test:hooks`, `tarefas` congelado, inserts da NF-e em 105/194. Não conferido ⚠️: caminho de falha dos itens da NF-e, contagem 18/21/4/1 da deriva, camadas `anthropic*`/`omie-*`, consumidor transitivo de `sonda-fingerprints`. Discordância: nenhuma de fundo; o Codex viu o rascunho **antes** da minha correção do lote J (que ele também apontou).
