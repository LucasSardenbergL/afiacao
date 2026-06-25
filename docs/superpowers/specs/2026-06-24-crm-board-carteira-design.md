# Board da Carteira (CRM — passo 3) — Design Spec

**Status:** design ratificado em conversa (2026-06-24). Próximo passo: `superpowers:writing-plans`.
**Antecede:** [#1040](timeline 360 `v_cliente_interacoes` + fila de SLA `v_carteira_sla`) e [#1045](tipagem). Esta é a 3ª e última peça da fatia de CRM da carteira.

## Problema / dor
O vendedor inside sales não tem uma **visão única acionável** da carteira. Hoje a priorização existe (`farmer_agenda` + `farmer_client_scores`) mas está espalhada em abas do `FarmerDashboard`. Falta a "fila de trabalho do dia" — ver, de uma vez, o que recuperar, o que expandir e o que dar follow-up, e agir sem trocar de tela.

NÃO é pipeline de oportunidades (negócio é B2B recorrente, decidido no painel triagem-3-modelos). NÃO é gestão de time. É a tela operacional do vendedor sobre a própria carteira.

## Decisões travadas
1. **Agrupamento por tipo de ação** (`agenda_type`: `risco` | `expansao` | `follow_up`) — 3 colunas lado a lado. (Founder delegou; decidido com justificativa abaixo.)
2. **Read-only + ações no card** (founder). Sem drag-drop, sem writer de estado **novo**. As ações reusam writers que já existem.
3. **Read-model no banco** (`v_carteira_board`), coerente com a família `v_cliente_interacoes`/`v_carteira_sla`. Sem 2ª fonte de verdade.

### Por que agrupar por ação (e não por saúde nem por SLA)
- **Saúde** (`health_class`) é *urgência*, não *tarefa* — é atributo do card (badge + ordenação), não eixo de coluna.
- **SLA** já tem o card dedicado (#1040) e vira **badge/filtro** dentro do board, não eixo concorrente.
- **`agenda_type`** é o eixo de **ação** (recuperar / expandir / manter cadência) — muda o script da ligação. Reusa dado que já existe e o board fica *superior* às abas atuais ao mostrar os três **lado a lado** (balanço da carteira de relance), não escondidos em abas.

## Arquitetura

### Banco — nova view `v_carteira_board` (read-only)
`create or replace view public.v_carteira_board with (security_invoker = true)` consolidando:
- **Driver:** `farmer_agenda` com `status` ativo (exclui `completed`/cancelado) → `agenda_id`, `agenda_type`, `priority_score`, `farmer_id`, `customer_user_id`.
- **JOIN `farmer_client_scores`** (por `customer_user_id` + `farmer_id`) → `health_class`, `churn_risk`.
- **JOIN `profiles`** (por `customer_user_id`) → `customer_name`.
- **Colunas expostas:** `agenda_id, customer_user_id, customer_name, agenda_type, priority_score, health_class, churn_risk, farmer_id`.

**Gate de autorização (crítico — RLS de `farmer_agenda` é staff-ampla):** a policy real de `farmer_agenda` é `"Staff can manage agenda"` (`employee`/`master`, **sem escopo de carteira**). Logo, igual a `order_messages` em #1040, **o gate da view é a cerca real**. Espelhar o modelo de 3 ramos:
```
pode_ver_carteira_completa(auth.uid())
  OR fa.farmer_id = auth.uid()
  OR carteira_visivel_para(fa.customer_user_id, auth.uid())
```
`grant select on public.v_carteira_board to authenticated;`

**SLA fora da view (DRY):** `dias_sem_contato`/`vencido` **não** são recalculados aqui — o front cruza com a `v_carteira_sla` (já existe) por `customer_user_id` para o badge. Evita duplicar a lógica de "contato efetivo" que já vive em `v_carteira_sla`.

### Front (rota própria, desktop)
- **Rota** `/farmer/carteira` (`RequireStaff`, lazy) — link a partir do `FarmerDashboard`.
- **`useCarteiraBoard`** (`src/hooks/useCarteiraBoard.ts`): react-query lendo `v_carteira_board` (tipada — as views entram em `types.ts` na regeneração; usar o tipo gerado, sem `as never`, já que estamos pós-#1045).
- **`BoardCarteira`** (`src/components/farmer/BoardCarteira.tsx`): 3 colunas por `agenda_type`, cada uma ordenada por `priority_score desc`, cabeçalho com contagem. Filtro opcional via `useUrlState` ("só SLA vencido").
- **`CardCarteira`** (`src/components/farmer/CardCarteira.tsx`): `customer_name`; badge de saúde (`text-status-*`, sem cor crua); `churn_risk` %; badge **"SLA vencido"** + dias sem contato (cruzando `useCarteiraSla`). Ações:
  - **Ligar** — reusa o `CallButton`/fluxo de telefonia existente.
  - **Abrir Customer360** — `navigate('/admin/customers/:id/360')` (rota existe).
  - **Concluir agenda** — `UPDATE farmer_agenda SET status='completed', completed_at=now() WHERE id`. **Reusar** o fluxo de conclusão de agenda do `FarmerDashboard` se já existir; senão, hook mínimo `useConcluirAgenda`. (É writer **existente** no domínio, não novo conceito.)
- **Reuso:** `CallButton`, `EmptyState`, `PageSkeleton`, `useUrlState`, tokens `text-status-*`.

## Escopo
**Inclui (v1):** view `v_carteira_board` + prova PG17; rota/hook/board/card; badge de SLA; ações ligar/360/concluir.
**Fora (YAGNI):** drag-drop / reclassificação; mobile (v1 é desktop, tela analítica); gestão de time/multi-vendedor; qualquer estágio de "pipeline".

## Provas / verificação
- **`v_carteira_board`** via `prove-sql-money-path` (PG17): (1) vendedor V1 vê só agenda da carteira/própria; (2) V2 não vê a de V1 (isolamento); (3) gestor vê tudo; (4) **falsificação**: remover o gate → vazamento entre vendedores fica VERMELHO. Estender `db/test-crm-carteira.sh`.
- **Front:** `typecheck` + `lint` + smoke manual em `/farmer/carteira`.
- **Deploy (Lovable):** migration no SQL Editor (handoff `lovable-db-operator`) + validação `psql-ro` (view existe, `security_invoker=true`, grant) + **Publish** + verificação por bytes (`lovable-deploy-verify`).

## Riscos / pontos de atenção
- **Domínio farmer quente** (PRs #1037/#1043/#1046 mexeram em RLS/plano tático de farmer): conferir `origin/main` antes de implementar; o gate usa `carteira_visivel_para`/`pode_ver_carteira_completa` (estáveis), mas reconfirmar que não mudaram.
- **`farmer_agenda` é gerada por scoring (TOP N por tipo)** — o board mostra a *fila priorizada*, não a carteira inteira. Confirmar que é o comportamento desejado (é: fila de trabalho, não lista exaustiva).
- **Concluir agenda** é o único toque de escrita — garantir que reusa o fluxo/permissão existente, sem inventar writer.

## Open questions (ratificar no review do spec)
1. "Concluir agenda" deve **gerar a próxima** (recadastrar na agenda) ou só marcar concluída? (v1 sugerido: só marcar; o scoring regenera no próximo ciclo.)
2. Filtro/ordenação default da coluna: `priority_score` desc (sugerido) — confirmar se prefere SLA vencido no topo.
