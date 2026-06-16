# Sub-PR D — Positivação & KPIs da carteira (Fase 4) — Design

> **Status:** spec aprovado no brainstorm (2026-05-25, founder). Próximo passo: writing-plans.
> **Branch:** `feat/carteira-positivacao-kpis` (a partir de `main`).
> **Pai:** `docs/superpowers/specs/2026-05-23-carteira-omie-fonte-verdade-design.md` (seção "Camada de KPIs / Positivação (Fase 4)"). Este doc resolve as decisões em aberto daquela seção pra v1.
> **2ª opinião:** codex consult (2026-05-25) — arquitetura RPC+helper, achado da data de previsão, enxugar KPIs. Incorporado.
> **Pré-requisito:** Sub-PR B (carteira ativa) em produção — `farmer_client_scores`/`customer_visit_scores` = 1 linha/cliente, `farmer_id` = dono (`carteira_assignments`).

## Problema

A tela `FarmerCalls` (e `useMyKpis`) hoje lidera com KPIs de **atividade** (`calls_today`, `revenue_today`, `margin_today`, `avg_ticket_today`, `pending_link_count`) — todos agregados de `farmer_calls` do dia. Não há nenhuma leitura de **progresso comercial da carteira**: quanto da carteira do vendedor comprou no mês (positivação), quem ainda não comprou e vale agir, cobertura de contato. O vendedor enxerga o que fez hoje, não o que falta fazer no livro dele.

## Decisões (brainstorm 2026-05-25, confirmadas com o founder)

1. **Positivação = % da carteira elegível que fez ≥1 pedido válido no mês comercial corrente (MTD, mês calendário).**
2. **Pedido válido** = linha em `sales_orders` com `status` **NÃO** em (`cancelado`, `rascunho`, `pendente`). Válidos: `faturado`, `enviado`, `separacao`, `importado`. (`sales_orders` é sincronizado do Omie por `omie-vendas-sync`; status derivado da etapa.)
3. **Data da venda = data do PEDIDO, não a previsão de entrega.** O `created_at` dos importados é sobrescrito pela `data_previsao` (previsão de entrega) — semanticamente errado pra positivação. Nova coluna `sales_orders.order_date_kpi`, populada de `infoCadastro.dInc` (data de inclusão no Omie = data do pedido). Leituras usam `COALESCE(order_date_kpi, created_at::date)`.
4. **Escopo v1:** KPIs ao vivo + lista "Clientes a Positivar" + **tabela/cron de snapshot** (pra começar a congelar história já), **SEM** UI de tendência histórica (YAGNI agora).
5. **KPIs por POSSE PRÓPRIA, não cobertura.** Cobertura (Sub-PR B) é visibilidade da *lista de sugestões*; a positivação mede o livro do próprio vendedor (ele é medido por isso).
6. **Conjunto enxuto (codex):** core = Positivação MTD · Clientes a Positivar · Cobertura de Contato MTD · Recência Crítica · Ticket Médio MTD. Hunter = Novos Clientes Positivados. **Cortado da v1:** Mix/Gap cross-sell (ruidoso/arbitrário). "Receita vs Meta" segue fora (sem meta cadastrada).

## Arquitetura — RPC server-side + helper puro (codex)

**A SQL é dona da verdade** (quem é elegível, quem tem 0 pedidos no mês). O JS só formata e ordena — senão a regra de negócio diverge entre SQL e front.

### Objeto novo 1 — coluna `sales_orders.order_date_kpi`
```sql
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS order_date_kpi date;
-- backfill: pedidos existentes não guardam payload Omie → usa created_at (= data_previsao)
UPDATE public.sales_orders SET order_date_kpi = created_at::date WHERE order_date_kpi IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_orders_kpi_date ON public.sales_orders (order_date_kpi);
```
- **Edit no `omie-vendas-sync`:** ao montar a linha importada, setar `order_date_kpi` = parse(`infoCadastro.dInc`, dd/mm/yyyy) → fallback parse(`data_previsao`) → fallback `created_at`. Re-syncs futuros corrigem pedidos recentes (o que importa pro MTD). Pedidos app-criados: `order_date_kpi = created_at::date`.

### Objeto novo 2 — `carteira_positivacao_snapshot` (do spec pai, DDL inalterada)
`UNIQUE(mes, customer_user_id)`; congela `owner_user_id`, `eligible`, `had_order_in_month`, `revenue_month`, `contacted_in_month`, etc. por mês fechado.

### Objeto novo 3 — RPC `get_minha_positivacao()`
- `SECURITY DEFINER`, `SET search_path = public`, **sem parâmetro de uid** (usa `auth.uid()` internamente — evita IDOR já que bypassa RLS). Gate: staff.
- Computa, pro `auth.uid()` como dono, **no mês corrente** (boundary America/Sao_Paulo):
  - `total_eligible` = `carteira_assignments` com `owner_user_id = uid` e `eligible = true`.
  - `positivados` = elegíveis com `EXISTS` pedido válido no mês (por `COALESCE(order_date_kpi, created_at::date)` dentro do mês corrente, status válido).
  - `ticket_medio_mtd` = receita MTD ÷ nº compradores no mês.
  - `cobertura_contato_mtd` = elegíveis contatados (`farmer_calls`) ou visitados (`route_visits`) no mês ÷ elegíveis.
  - `recencia_critica` = nº de elegíveis com `days_since_last_purchase` acima da cadência / `churn_risk` alto.
  - **lista candidata "a positivar"** = elegíveis com 0 pedidos no mês, com `revenue_potential`/`churn_risk`/`recover_score`/`days_since_last_purchase`/score, limitada (ex.: top 200 por prioridade).
- **Variante Hunter** (mesmo RPC, ramo por papel): `novos_clientes_positivados` = clientes `source='hunter_orphan'` ou `is_prospect` com 1ª compra válida no mês.

### Helper puro — `src/lib/positivacao/` (TDD)
- `mesComercialCorrente(now, tz='America/Sao_Paulo')` → `{ inicio, fim }` (1º dia 00:00 → 1º dia do mês seguinte).
- `pctPositivacao(positivados, elegiveis)`, `ticketMedio(receita, compradores)` — null/zero-safe.
- Ordenação da lista "a positivar" reusando `pickDailyMix` sobre as linhas da RPC.
- Espelho mínimo no edge function do snapshot onde precisar (mesma fronteira de mês).

### Hook — `useMyPositivacao()`
Chama a RPC, aplica o helper (ordenação/format), expõe os KPIs + a lista. `staleTime` ~60s.

## UI — revamp do `FarmerCalls`

- **Hero (Farmer):** Positivação MTD · **Clientes a Positivar** (lista — o coração) · Cobertura de Contato MTD.
- **Hero (Hunter):** Novos Clientes Positivados · Clientes a Positivar (pool órfão) · Recência Crítica.
- **Linha secundária:** Ticket Médio MTD · Recência Crítica (a que não estiver no hero).
- **Atividade do dia (rebaixada):** `calls_today`/`revenue_today`/`margin_today`/`avg_ticket`/`pending_link_count` viram faixa secundária discreta (não-hero). `pending_link_count` = tarefa de qualidade de dado, não KPI de venda.
- Papel (Farmer vs Hunter) resolvido por `useMyCommercialRole` / persona.
- Status colors via `text-status-*` (ver CLAUDE.md §4). "Clientes a Positivar" reusa o padrão visual do `VisitSuggestionsCard`.

## Snapshot — edge function + cron

- Edge fn `carteira-positivacao-snapshot`: materializa o **mês recém-fechado** em `carteira_positivacao_snapshot` (idempotente `ON CONFLICT (mes, customer_user_id) DO UPDATE`). Auth cron via vault `x-cron-secret`.
- Cron mensal dia 1 (`0 8 1 * *` BRT-ish, definir no rollout).
- **Boundary de leitura:** `mes = mês corrente` → ao vivo (RPC); `mes < corrente` → só snapshot. Snapshot de mês fechado ausente → "snapshot pendente" / backfill service-role; **nunca** recalcular passado com a posse de hoje.

## Anti-vanity (codex)

- KPI dominante = **"quem não comprou no mês e vale agir agora"** (a lista), não contadores de atividade.
- Sem ranking entre vendedores / benchmark de produtividade na tela do vendedor (induz gaming).
- Positivação por POSSE, não cobertura.

## RLS / segurança
- RPC `SECURITY DEFINER` sem param de uid (usa `auth.uid()`). Gate staff.
- `carteira_positivacao_snapshot`: SELECT staff (pela regra de visibilidade da carteira) / escrita service-role + master.

## Rollout (coordenado, padrão Sub-PR B)
1. SQL Editor: BLOCO A = `ALTER` coluna `order_date_kpi` + backfill + índice + `carteira_positivacao_snapshot` + RPC `get_minha_positivacao`.
2. Chat Lovable: edit do `omie-vendas-sync` (grava `order_date_kpi` de `dInc`) + nova edge fn `carteira-positivacao-snapshot`.
3. SQL Editor: agendar cron mensal (vault).
4. Validar: RPC retorna positivação coerente pra Regina/Tati; snapshot roda idempotente.

## TDD / testes
- Helpers puros `src/lib/positivacao/` 100% TDD (fronteira de mês, %, ticket, ordenação) — `bun run test` (vitest) canônico.
- RPC validada via SQL no Lovable (contagens batem com queries manuais).

## YAGNI (cortado de propósito)
- UI de tendência histórica (gráficos de positivação mês a mês) — só quando houver meses congelados pra comparar.
- Mix/Gap cross-sell KPI — ruidoso na v1.
- Receita vs Meta — sem meta cadastrada.
- Re-fetch do Omie pra backfillar `order_date_kpi` de pedidos antigos (heavy; antigos usam `created_at`, novos pegam `dInc`).

## Riscos conhecidos
1. **Backfill limitado da data:** pedidos importados antigos não têm payload → `order_date_kpi = created_at` (data_previsao). Positivação de meses passados (no snapshot) herda essa imperfeição; mês corrente fica correto conforme re-syncs gravam `dInc`.
2. **Cron tardio / sync atrasado após virada de mês:** mitigado por idempotência + leitura ao vivo do mês corrente + checagem de frescor do snapshot.
3. **Volume:** carteira de um dono pode ter milhares de clientes — por isso o agregado + `EXISTS` é server-side (RPC), nunca puxando linhas pro front.
