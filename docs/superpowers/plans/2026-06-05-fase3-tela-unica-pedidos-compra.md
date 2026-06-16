# Plano — Fase 3: tela única de pedidos de compra (Reposição/OBEN)

> Fase 3 do programa de unificação (`specs/2026-06-05-unificacao-pedidos-compra-design.md`
> §4.1/§4.4/§4.5/§5). A dor ORIGINAL do founder: 2 painéis empilhados (`CicloHojePanel`
> embute `AdminReposicaoPedidos`) + a 3ª tela `/admin/portal-sayerlack` pouco usada.
> Data: 2026-06-05. Status: **PLANO** (design no spec; este doc decompõe em sub-PRs).

## Contexto / o que já mudou no programa
- **Fase 1 (idempotência) ✅ #628** — o "já cadastrado"→reconciliação + claim do portal endurecido já existem. **NÃO refazer.** ⚠️ Gate de build: **#628 precisa estar smokado** (a Fase 3 mexe na UX de disparo).
- **Gate de condição (§4.2) ⏸️ DROPPED** (à vista universal — `2026-06-05-fase2-condicao-memoria-design.md`). **Só a trilha de aprovação canônica sobrevive**, SEM validação de condição / micro-confirm / memória.
- **Check de taxa de erro (§4.4 observabilidade) ⏸️ deferido** — aposentar o portal-sayerlack **só descarta** os KPIs/gráficos; não adiciona vigia novo.

## Mapa do código (verificado 2026-06-05)
| ponto | arquivo:linha | hoje |
| --- | --- | --- |
| Embedding redundante | `components/reposicao/CicloHojePanel.tsx:145` | `<Suspense><AdminReposicaoPedidos/></Suspense>` |
| Aprovar cicloHoje (inline) | `cicloHoje/PedidoRow.tsx:54-99` (`act`) | `UPDATE status='aprovado_aguardando_disparo'`, **sem disparo** |
| Aprovar cicloHoje (lote/auto) | `cicloHoje/useCicloHoje.ts:88-137`/`139-176` | idem `UPDATE`, sem disparo |
| Aprovar modal (canônico) | `pedidos/useDetalhesModal.ts:181-236` | RPC `aprovar_pedido_sugerido`(:195) + edge `disparar-pedidos-aprovados`(:207) + `interpretarRespostaDisparo`(:211) |
| Conciliação | `portalSayerlack/ConciliarTab.tsx` + `PortalDetailDrawer.tsx:104-136` (`handleConciliar`) | edge `conciliar-pedido-portal` |
| "Forçar reenvio" | `portalSayerlack/PortalDetailDrawer.tsx:138-161` (`handleForceReset`) + `pedidos/PortalDrawer.tsx:145` | reset→`pendente_envio_portal` + zera retry |
| Edge conciliar | `functions/conciliar-pedido-portal/index.ts:124,175` | checa `STATUS_CONCILIAVEIS`; **NÃO** checa `omie_pedido_compra_id IS NULL` antes do `dispararOmie` → **risco PO duplo** |
| Stepper | `hooks/useReposicaoSessao.ts:35-53` (`useItensDoDia`), `:81-94` (`deriveCurrentStep`) | deriva o passo por **contagem de status** (não pela fonte do painel) |
| Labels | `pedidos/shared.ts:12-22` (`statusMeta`) | 8 status; `falha_envio`/`disparado_simulado` = string crua |
| Deep-link | `AdminReposicaoPedidos.tsx:62-79` | `?id=` abre modal **só do ciclo de hoje**; `?pedido=` não tratado |

## Decomposição em sub-PRs

### Sub-PR 3a — Trilha de aprovação canônica + labels (FUNDAÇÃO)
Unifica os 3 caminhos de aprovar → todos passam pelo MESMO helper `aprovarEDisparar`
(RPC `aprovar_pedido_sugerido` → edge `disparar-pedidos-aprovados` → `interpretarRespostaDisparo`).
Conserta o §1.2 (aprovar pelo ✓ inline hoje NÃO dispara — fica parado até o cron). **SEM gate de
condição** (dropado). Depende do smoke do #628.

- **T1 — Helper compartilhado** `src/components/reposicao/pedidos/aprovar-disparar.ts` (puro/testável):
  extrai o miolo de `useDetalhesModal.aprovarMutation:195-215` (RPC → invoke edge → interpretar).
  TDD: dado uma resposta da edge, retorna `{ tipo, mensagem }` (success/info/warning) via
  `interpretarRespostaDisparo`. (O helper `interpretarRespostaDisparo` já existe e é puro — reusar.)
- **T2 — cicloHoje passa pelo helper:** `PedidoRow.tsx:54-99` (`act`) + `useCicloHoje.ts:88-137`
  (`runBatch`) + `:139-176` (`runAutoApprove`) deixam de fazer `UPDATE` direto e chamam
  `aprovarEDisparar(pedidoId)`. ⚠️ **Preservar a edição de `num_skus`/qtd do ✓ inline ANTES da
  RPC** (a RPC não toca `num_skus`; hoje o `act` grava junto — fazer o UPDATE da edição, depois a RPC).
- **T3 — Labels faltantes:** `statusMeta` ganha `falha_envio` (label "Falha no envio", variant
  destructive) + `disparado_simulado` (label "Disparo simulado", variant outline/secondary).
- **⚠️ Decisão de comportamento (founder):** o **auto-approve** (`runAutoApprove`) passa a
  **disparar na hora** em vez de esperar o cron. Net-effect = o mesmo (o cron `disparar-pedidos-aprovados`
  já dispara todos os `aprovado_aguardando_disparo` depois) — só muda o TIMING (imediato vs cron). É
  consistente com "aprovar=dispara". **Confirmar com o founder** se quer auto-approve disparando na
  hora, ou só o approve MANUAL (✓ inline/lote) dispara e o auto continua deixando pro cron.
- **Validação:** testes do helper; comportamento dos 3 caminhos verbatim exceto o disparo; `bun run typecheck` no tree.

### Sub-PR 3b — Conciliação inline + chip cross-ciclo + deep-link cross-ciclo
Dá à tela de pedidos as funções ÚTEIS do portal-sayerlack, ANTES de aposentá-lo (§4.4: só
aposentar quando a conciliação inline existir no destino).

- **T1 — Conciliação inline:** dialog reusando a lógica de `PortalDetailDrawer.handleConciliar:104-136`
  + a edge `conciliar-pedido-portal`, acessível pela linha/Detalhes do pedido na tela de pedidos.
  Distinguir `aceito_portal_sem_protocolo` (PO quase certo existe) de `indeterminado_requer_conciliacao`
  (ambíguo — avisar "confira no portal ANTES") — hoje usam o mesmo fluxo.
- **T2 — Guard `omie_pedido_compra_id IS NULL` na edge** `conciliar-pedido-portal` (antes do
  `dispararOmie:175`): se o pedido já tem número do Omie, NÃO re-criar (evita PO duplo). ⚠️ money-path
  → PG17/teste + deploy via Lovable APÓS merge.
- **T3 — Chip "⚠ N precisam de atenção" (cross-ciclo):** query DEDICADA (não a `data_ciclo=hoje`):
  `status_envio_portal IN (aceito_portal_sem_protocolo, indeterminado_requer_conciliacao)` OR
  `status='falha_envio'` OR preso em `enviando_portal`/`pendente_envio_portal` antigo, de QUALQUER
  ciclo. Cobertura nova (hoje nada mostra falha de ciclo passado).
- **T4 — Deep-link cross-ciclo:** `?id=N` passa a buscar o pedido fora do ciclo de hoje se não estiver
  na lista (em vez de "não encontrado no ciclo de hoje"); aceitar `?pedido=N` como alias.
- **T5 — Remover/gatear "Forçar reenvio":** `handleForceReset` (`PortalDetailDrawer:138-161` +
  `pedidos/PortalDrawer.tsx:145`) → substituir por Conciliar nos estados de conciliação (reset cego
  re-abre pro retry e pode re-mandar; nos estados ambíguos é risco). Manter reset só onde for seguro.

### Sub-PR 3c — Tela única + aposenta portal-sayerlack (a CONSOLIDAÇÃO)
A dor original do founder. Requer 3b (conciliação inline) pronto.

- **T1 — Componente canônico único:** um painel de lista usado na etapa 3 do wizard E na rota
  standalone. `CicloHojePanel` para de embutir `AdminReposicaoPedidos` (`:145`). Uma tabela só.
  ⚠️ **Preservar a contagem de status que alimenta `deriveCurrentStep`** (o stepper acopla por
  contagem, não pela fonte — `useReposicaoSessao:81-94`) → manter os contadores `pedidosPendentes/
  Aprovados/Disparados` vivos.
- **T2 — Ação contextual por linha (§4.1):** pendente/bloqueado→Aprovar(=dispara)·Cancelar·Detalhes
  (motivo do bloqueio no tooltip); aprovado/falha_envio→Disparar·Detalhes (erro `resposta_canal.erro`
  visível); conciliação→Conciliar·Detalhes; disparado→Omie/protocolo; disparado_simulado→badge.
- **T3 — Esconder/agrupar o pai `split_em_filhos`** (sem ação útil; senão a lista mostra 1 pai morto
  + N filhos e o "valor do ciclo" infla).
- **T4 — Aposenta `/admin/portal-sayerlack`:** rota → `Navigate` redirect pra `/admin/reposicao/pedidos`.
  Remove `KpiCards`, `EstatisticasTab`, `HistoricoTab`, `PendentesTab`, export CSV, `DispararAgoraButton`
  ("disparar lote", cortado §9.2). Mantém só o que migrou (conciliação inline + chip + Detalhes).
- **T5 — Toolbar:** busca + fornecedor + status + o chip do 3b. Ciclos anteriores = filtro de data discreto.

## Riscos
- **3a:** mudança de timing do disparo (auto-approve dispara na hora vs cron) — confirmar com founder.
  Depende do smoke do #628 (idempotência sólida embaixo).
- **3b:** o guard `omie_pedido_compra_id` é money-path (PO duplo) → PG17 + deploy cuidadoso.
- **3c:** o acoplamento do stepper (preservar contagens) + a troca da fonte do painel no wizard.
- **Multi-sessão:** a Reposição é tocada por sessões paralelas (frente '04', mínimo forçado, etc.) →
  conferir `gh pr list` + rebase antes de cada sub-PR.

## Validação
- 3a: TDD do helper; os 3 caminhos disparam consistente. 3b: PG17 no guard da edge; testes do chip/deep-link.
  3c: o stepper não quebra (contagens preservadas); smoke da tela única (1 painel, ações por linha,
  redirect do portal-sayerlack, conciliação inline funciona).
- Cada sub-PR: subagent-driven (implementer + spec-review + code-quality-review), CI `validate` verde.

## Não-objetivos
- Wizard re-think (adiado pro Codex).
- Gate de condição / memória / prazos (dropado — à vista universal).
- Estado novo de status (`disparando`) — idempotência é o `cCodIntPed` (§4.3/§5).
- Esconder "quem aprovou".
