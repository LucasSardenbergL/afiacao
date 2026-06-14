# KPIs de nível mundial da farmer — Meu Dia (design)

**Data:** 2026-06-06
**Autor:** Claude (decisão solo; ⚠️ Codex fora por usage limit do Plus — **validação adversária retroativa pendente**, padrão do CLAUDE.md "Caminho B")
**Status:** aprovado pelo founder pra implementar ("decido você e o Codex... pode ir implementando sem me perguntar")

## ⚠️ Coerência com o OTE (atualização 2026-06-13, eu+Codex)

Estes KPIs são **placar de visibilidade (gestão)**, NÃO a engine de comissão. A elegibilidade pra remuneração é definida **exclusivamente** pelo spec vigente de OTE (`2026-06-13-ote-remuneracao-variavel-farmer-design.md`) — qualquer rótulo "comissionável/output/higiene" abaixo é classificação de **design de dashboard**, não de pagamento. O OTE está em DESIGN (não-pronto pra virar folha). Divergências a reconciliar quando ele virar implementação:
- **Dados parciais:** receita/positivação vêm de `sales_orders`, que cobre só uma fração do faturamento da Oben (backfill histórico pendente) → `DadosVendaParciaisBanner` avisa no dashboard; **não usar pra comissão até reconciliar**.
- **Janela:** aqui é MTD (operacional); o OTE usa **quota trimestral cumulativa** (anti-Parkinson). A copy "do mês" é descritiva, não imperativa — migrar pra trimestral quando houver quota no sistema.
- **Específico farmer:** **win-back** é placar de gestão (o OTE só talvez paga em V3); a **positivação** aqui **não tem ticket mínimo** (o OTE exige — pedido de R$1 não conta); **Receita MTD** é observação, não base (o OTE paga receita-vs-quota na V1 / margem-padrão na V2). A classificação "comissionável" da tabela abaixo é superseded por este aviso.

## Contexto / problema

A lente "Ver como pessoa" expôs que o dashboard "Meu Dia" da **farmer** (account manager de carteira, tipo a Tatyana) mostra cards de **visita** — que não é o trabalho dela (visita é do "closer"). Investigando, achei que:

- **Já existe dashboard por persona** (`CommercialDashboard` roteia por `useMyCommercialRole`, lente-aware): farmer→`FarmerDashboardV2`, hunter→`HunterDashboard`, closer→`CloserDashboard`, master→`MasterDashboard`.
- Mas os dashboards foram montados **ad-hoc**: o card "Visitas de hoje" (`VisitasHojeCard`) vaza pra farmer/hunter/closer, e a **positivação** (KPI central da farmer) **não está em nenhum dashboard** — só na tela de Ligações (`/farmer/calls`, via `PositivacaoHero`).
- Não há um modelo de "que KPI cada papel vê".

Esta entrega corrige a **farmer** (1ª persona; hunter/closer/master vêm depois, frente "começar pela farmer e expandir"). Decisão do founder: os KPIs devem ser **base de remuneração variável (OTE) futura** — logo, mensuráveis, auditáveis e por-farmer.

## KPIs de nível mundial da farmer (account management B2B)

Framework: **retenção · penetração · expansão · atividade**. Classificação pensando no OTE (comissionável = output à prova de gaming; higiene = atividade medida mas não paga direto).

| KPI | Mede | Tipo | OTE | Dado |
|---|---|---|---|---|
| **Positivação MTD %** ⭐ NORTE | % da carteira elegível que comprou no mês (penetração/active accounts) | output | **comissionável** | `compradores_mtd / total_eligible` ✅ |
| **Receita da carteira MTD** | faturamento do mês da carteira | output | **comissionável** | `receita_mtd` ✅ |
| **Win-back** | clientes recuperados (1ª compra/retorno no mês) | output | **comissionável** | `novos_clientes_positivados` ✅ |
| **Cobertura MTD %** | % da carteira contatada (ligação/WhatsApp) | leading | higiene | `contatados_mtd / total_eligible` ✅ |
| **Ligações hoje** | pulso de atividade do dia | leading | higiene | `calls_today` (useMyKpis) ✅ |
| **Clientes a positivar** | quem ainda não comprou (a ação) | acionável | — | `a_positivar[]` ✅ |
| **Recência crítica** | clientes em risco de churn | acionável | — | `recencia_critica` ✅ |
| **Mix-gap** | cross-sell (famílias que faltam) | acionável | — | `useMyMixGap` ✅ |
| **Ticket médio MTD** | valor médio por comprador | output (apoio) | — | `receita_mtd / compradores_mtd` ✅ |

**Anti-gaming:** positivação em **%** (carteira inchada não infla o número absoluto); atividade (cobertura/ligações) é **higiene**, não comissão direta (senão incentiva ligar/contatar sem vender). Win-back e recência balanceiam (não abandonar cliente difícil pra inflar positivação dos fáceis).

**Pro OTE (criar na sessão dedicada futura, NÃO neste escopo):**
- **Meta de receita por farmer** (não existe) → Receita MTD vira "atingimento %" (o input clássico de OTE).
- **Margem MTD por carteira** (hoje só há margem do *dia* em `useMyKpis`) → comissão por margem evita premiar desconto.
- **Retenção de receita (NRR-like)**: receita da carteira vs período anterior (mesma carteira) — métrica de nível mundial, derivável de séries, fica pra v2.

## Mudança no `FarmerDashboardV2` (Meu Dia da farmer)

1. **Trazer a positivação pro topo** — renderizar o `PositivacaoHero` (já existe, já lente-aware via `useMyPositivacao`) no Meu Dia, logo após o header, como o placar do mês.
2. **Expor 2 KPIs novos no `PositivacaoHero` (farmer):** **Receita MTD** e **Win-back** (output comissionáveis). Requer expor `receitaMtd` no `useMyPositivacao` (o dado já vem, só não é mapeado).
3. **Remover** o `VisitasHojeCard` do `FarmerDashboardV2` (não é trabalho de farmer).
4. **Manter** Fila (ação do dia), `KpisToday` (atividade de hoje), `SlaCardMeuDia` (WhatsApp) e o "modo antigo".

`PositivacaoHero` é compartilhado com `/farmer/calls` → a melhoria do placar (receita+win-back) aparece nos dois (consistência desejada). O bloco do hero em `FarmerCalls` continua funcionando (mesmo componente).

## Não-objetivos (v1)
- OTE/remuneração variável em si (sessão dedicada — o founder vai abrir).
- Hunter/Closer/Master (próximas levas da frente "expandir").
- Criar meta de receita / margem MTD por carteira (dependência do OTE).
- Mexer no roteamento de dashboard (já funciona e é lente-aware).

## Verificação
- `useMyPositivacao` expõe `receitaMtd` (= `receita_mtd`).
- `FarmerDashboardV2` não renderiza `VisitasHojeCard` e renderiza o bloco de positivação.
- Lente: o Meu Dia da farmer reflete a carteira do ALVO (positivação já é lente-aware).
- typecheck + lint + suite.
