# Master dashboard "visão de time" (CEO) — preencher os 3 tiles "—"

**Data:** 2026-06-04 · **Tipo:** front puro, read-only, sem migration/edge/deploy · **Branch:** `claude/master-visao-time`

## Problema

O `MasterDashboard` (do CEO/founder) tem 3 tiles placeholder "—": **Vendedores ativos · Receita time hoje · Pipeline total**. Falta a "visão de time" que o cabeçalho promete. (Os KPIs próprios dele como Closer e as sugestões de visita já existem.)

## Solução (v1 — 3 tiles; ranking fica pra v2)

Preenche os 3 tiles com números reais, read-only, **escopados na empresa ativa** (`CompanyContext`). Cada tile **exibe sua definição/fonte** (não mascara). `Pipeline total` é **morto** (não há tabela de pipeline) e vira **Receita time · mês (MTD)**.

> **Ranking de vendedores fica pra v2** (codex P2): é o real valor de "visão de time" mas tem mais ambiguidade (atribuição por `created_by`, vendedor zerado, bucket "não atribuído"). Ship os tiles primeiro.

## Tiles

1. **Vendedores ativos** = distinct vendedores com atividade HOJE = `sales_orders.created_by` (empresa ativa) ∪ `farmer_calls.farmer_id` ∪ `route_visits.visited_by`. Valor = contagem de hoje; microcopy "**7d: X**" (codex: não trocar o principal por 7d). ⚠️ calls/visits não têm coluna `account` → cross-empresa (métrica de atividade soft, aceitável; sales é company-scoped).
2. **Receita time · hoje** = Σ `sales_orders.total` de pedidos **válidos** (status ∉ {`cancelado`,`rascunho`}), `account` = empresa ativa, `deleted_at IS NULL`, `order_date_kpi` = hoje (SP). Label "**pedidos Omie · hoje**". **Erro honesto** (falha de query → "—", nunca R$0).
3. **Receita time · mês** (MTD, substitui Pipeline) = mesma base, `order_date_kpi` ∈ [1º do mês, hoje] (SP). Label "**pedidos Omie · mês**".

## Traps resolvidos (codex P1)

- **Escopo de account:** SEMPRE `.eq('account', companyAtiva)` na receita (senão mistura Oben/Colacor = número politicamente errado). Empresa vem do `useCompany().id` (oben/colacor/colacor_sc — bate com `sales_orders.account`). Limitação: pedido sincronizado com `account` fora desses 3 valores é omitido (degradação honesta > mistura).
- **Data SP, não UTC:** "hoje" = data de negócio **America/Sao_Paulo** (`Intl.DateTimeFormat('en-CA', {timeZone})`). `order_date_kpi` (date) filtra por string SP; `created_at`/`started_at`/`check_in_at` (timestamp) filtram por **janela UTC derivada de SP** (SP = UTC−3 fixo desde 2019; meia-noite SP = `T03:00:00Z`).
- **Status válido centralizado:** `ORDER_STATUS_INVALIDOS = ['cancelado','rascunho']` num único helper (todos os 7 demais = real: enviado/faturado/recebido/em_analise/em_producao/pronto/entregue).
- **Erro honesto:** a query de receita (q1) que falha → `throw` → tile "—"/erro (não R$0). Atividade (q2-q4) é best-effort.

## Implementação

- **`src/lib/dashboard/sp-date.ts`** (puro, TDD): `hojeSP()` (now→SP date), `addDias(iso,n)`, `inicioMes(iso)`, `spMeiaNoiteUTC(iso)`.
- **`src/lib/dashboard/team-kpis.ts`** (puro, TDD): `isPedidoValido(status)`, `somarReceita(orders, deISO, ateISO)` (válidos, order_date_kpi em [de,ate)), `contarAtivos(linhas, desdeUTC)` (distinct id com ts ≥ desde).
- **`src/hooks/useTeamKpis.ts`**: 4 queries (sales MTD by order_date_kpi · sales 7d by created_at · calls 7d · visits 7d), compõe receita hoje/mês + ativos hoje/7d. `account`-scoped via `useCompany`. q1 throws; q2-q4 best-effort.
- **`src/components/dashboard/TeamKpiTiles.tsx`**: 3 tiles + microcopy; loading/erro honestos.
- Substitui o grid placeholder no `MasterDashboard.tsx`.

## Não-objetivos (v1)

Freshness via `fin_sync_log` (hoje só label "Omie" + erro honesto). Activity company-scoped pra calls/visits. Cross-empresa consolidado.

---

# v2 — Ranking de vendedores do mês (ENTREGUE)

Card read-only no Master, abaixo dos tiles de time. **Ordena por receita R$ MTD** (sinal CEO mais claro; sem score composto). Colunas: `nome · pedidos · receita MTD`. Escopo da empresa do switcher.

- **Atribuição = `created_by`** (quem LANÇOU) filtrado a vendedores reais (`commercial_role ∈ farmer/hunter/closer`, mesma def de `useSalespeople`). Label "por quem lançou o pedido". NÃO usa dono-de-carteira (mudaria a pergunta; precisaria `carteira_assignments`).
- **Bucket "não atribuído"** (created_by NULL ou não-vendedor) no rodapé — conta no total, fora do ranking (auditoria sync/admin). **"N sem pedido no mês"** (vendedores cadastrados sem pedido).
- **Conversão de visita FORA** (codex P1): `route_visits` sem `account` → cross-empresa enquanto receita é por-empresa; misturar parece preciso mas não é. v3.
- **Janela MTD** (alinha com o tile receita-mês; evita 3 janelas mentais).
- **Paginação** (`fetchPedidosMTD`, `.range`+`order('id')`): receita do mês não trunca no cap 1000 do PostgREST. **Corrigiu a mesma latência no `useTeamKpis`** (tiles de receita do v1 truncavam >1000 pedidos/mês).

Helper `montarRanking` (TDD) em `team-kpis.ts`; `fetchPedidosMTD`; hook `useTeamRanking`; `RankingVendedoresCard`. **v3:** conversão por vendedor (rotulada), dono-de-carteira, freshness.

---

# v2.1 — Tendência MoM na receita do mês (ENTREGUE)

O tile "Receita time · mês" ganha **▲/▼ X% vs mês passado** — o trend é o que torna o número de receita acionável pra um CEO. **Comparação justa = mesmo período** (`periodoMesAnterior`: do dia 1 do mês passado até o mesmo dia-do-mês de hoje, capado no tamanho do mês anterior — ex. hoje 04/06 compara mai 1–4 vs jun 1–4, NÃO maio inteiro). `variacaoPct` retorna `null` sem base (`anterior ≤ 0`) → não fabrica "+100%"/"∞%" (degradação honesta). Mesmo período do mês passado também é paginado + lança em erro (money). Helpers TDD `periodoMesAnterior` (sp-date) + `variacaoPct` (team-kpis). **v3:** YoY (vs mesmo mês ano passado) p/ negócio sazonal; trend no tile "hoje".

## Codex

Consult adversarial (2026-06-04): matar Pipeline→MTD; receita order-based no time × call-based nos KPIs próprios (menor mal, ambos rotulados); ativos hoje + microcopy 7d; ranking = P2; **4 traps P1** (account scope, data SP, status válido centralizado, erro honesto) incorporados; não bloquear receita (read-only+labels+degradável suficiente).
