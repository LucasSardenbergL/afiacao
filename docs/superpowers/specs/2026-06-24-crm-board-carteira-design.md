# Board da Carteira (CRM — passo 3) — Design Spec

**Status:** design ratificado (2026-06-24); **revisado** após achado de implementação (ver §Virada). Próximo: `superpowers:writing-plans`.
**Antecede:** [#1040](timeline 360 `v_cliente_interacoes` + fila de SLA `v_carteira_sla`) e [#1045](tipagem). 3ª e última peça da fatia de CRM da carteira.

## Problema / dor
O vendedor inside sales não tem uma **visão única acionável** da carteira. A priorização existe (`useFarmerScoring` → agenda + scores) mas vive numa **aba** do `FarmerDashboard` (tela mobile compacta). Falta a "fila de trabalho do dia" lado a lado — recuperar / expandir / follow-up — com ação direta no card.

NÃO é pipeline de oportunidades (B2B recorrente; decidido no painel triagem-3-modelos). NÃO é gestão de time.

## Decisões travadas
1. **Agrupamento por tipo de ação** (`agendaType`: `risco` | `expansao` | `follow_up`) — 3 colunas lado a lado. Saúde e SLA são *sinais no card* (badge), não eixos.
2. **Read-only + ações no card** (founder): **Ligar** (CallButton, que já registra a ligação) + **Abrir Customer360**. Sem drag-drop, sem writer novo.
3. **Front puro — sem banco** (ver Virada).

## Virada de design (achado de implementação — 2026-06-24)
O spec inicial assumia uma view `v_carteira_board` sobre a tabela `farmer_agenda`. **Leitura do código mostrou que a agenda viva é recalculada no client** por `useFarmerScoring` (`src/hooks/useFarmerScoring.ts:393-446`); o hook é **display-only** e **não lê nem escreve `farmer_agenda`** (comentário `:448-454`). Basear o board em `farmer_agenda` seria frágil (pode não estar populada no fluxo atual).

**Decisão:** o board é **100% front**, reusando o que já existe e é a fonte viva:
- `useFarmerScoring()` → `agenda` (já agrupável por `agendaType`) + `clientScores` (nome, `customer_phone`, `healthClass`, `churnRisk`, `priorityScore`).
- `useCarteiraSla()` (#1040) → badge de SLA por `customer_user_id`.

**Ganho:** zero migration, zero deploy de banco, zero risco de RLS — só `Publish`. Mesmo resultado visual, muito menos superfície. A ação "concluir agenda" (que não faz sentido com agenda recalculada) é substituída por **Ligar** (o registro da ligação naturalmente tira o cliente do "vencido" no próximo recálculo).

## Arquitetura (front)
- **Página/rota** `/farmer/carteira` (lazy, mesmo wrapper de auth das rotas `/farmer/*` vizinhas, ex.: `/farmer/calls`). Tela **desktop/analítica** (3 colunas), distinta do FarmerDashboard mobile.
- **`src/lib/carteira/board.ts`** (helpers PUROS, testáveis): `AGENDA_TIPOS` (ordem + label + tom) e `healthBadge(healthClass)` → `{label, className}` com tokens `text-status-*`. + `montarColunasBoard(agenda, clientScores, slaRows)` → 3 colunas com os cards já cruzados.
- **`src/components/farmer/CardCarteira.tsx`**: nome, badge de saúde, `churnRisk` %, badge **"SLA vencido (N d)"** quando aplicável; ações `CallButton` (phone do clientScore, `variant="icon"`) + botão "Abrir 360" (`navigate('/admin/customers/:id/360')`).
- **`src/components/farmer/BoardCarteira.tsx`**: 3 colunas (`risco`/`expansao`/`follow_up`), cabeçalho com contagem, `<EmptyState>` por coluna vazia; filtro opcional "só SLA vencido" via `useUrlState`.
- **`src/pages/CarteiraBoard.tsx`**: chama os 2 hooks, `montarColunasBoard`, `<PageSkeleton variant="cockpit">` no loading.
- **Reuso:** `CallButton` (`{phone, customerName, variant}`), `useFarmerScoring`, `useCarteiraSla`, `EmptyState`, `PageSkeleton`, `useUrlState`, tokens `text-status-*`, `HealthClass` (de `useCarteiraSla.ts`).

## Escopo
**Inclui (v1):** página/rota; helpers puros + testes; board 3 colunas; card com badge de SLA; ações ligar + 360; link de entrada a partir do FarmerDashboard.
**Fora (YAGNI):** drag-drop/reclassificação; mobile dedicado (v1 desktop); "concluir agenda"; qualquer view/migration; refatorar o FarmerDashboard (os helpers `healthColors`/`agendaTypeConfig` ficam duplicados por ora — follow-up para unificar, evita tocar arquivo quente agora).

## Provas / verificação
- **vitest** nos helpers puros: `healthBadge`, `montarColunasBoard` (cruzamento agenda×scores×SLA, agrupamento nas 3 colunas, badge de vencido correto, coluna vazia).
- **`typecheck` + `lint`** verdes; **smoke manual** em `/farmer/carteira`.
- **Deploy:** só **Publish** do frontend (sem banco). Verificar com `lovable-deploy-verify` (bytes do bundle).

## Riscos / atenção
- `useFarmerScoring` é **client-side pesado** (carrega sales_orders/scores e recalcula) — é o **status quo** do FarmerDashboard; o board não piora. Melhoria futura: migrar para react-query/cache compartilhado.
- **Divergência mínima** possível: `useFarmerScoring` recalcula health no client; `useCarteiraSla` lê `farmer_client_scores` do cron. Mesmos dados de origem; divergência desprezível para a v1 (badge de SLA vem do SLA; saúde vem do scoring).
- **Domínio farmer quente** (PRs #1037/#1043/#1046): conferir `origin/main` antes de implementar.

## Open questions (defaults ratificados)
1. Ação do card: **Ligar + Abrir 360** (default). "Concluir agenda" descartado pela virada.
2. Ordenação da coluna: ordem da `agenda` (já priorizada) — default; opção de pôr SLA vencido no topo dentro da coluna.
