# Dashboard Principal V3 — Design

> Spec do redesign do Dashboard em `/` (seção **Principal** do menu lateral), substituindo o `StaffHome` inline em [src/pages/Index.tsx:124](../../../src/pages/Index.tsx:124). O `CustomerDashboard` (rota cliente) fica como está.
>
> Data: 2026-05-16 · Branch: `claude/naughty-aryabhata-8da946`

---

## 1. Contexto e problema

### 1.1 Estado atual

O `/` bifurca em duas telas via `isStaff`:
- `!isStaff` → [`<CustomerDashboard />`](../../../src/components/CustomerDashboard.tsx) — mobile-first, aesthetic consumer, **out-of-scope deste redesign**.
- `isStaff` → função `StaffHome` inline em [src/pages/Index.tsx:124](../../../src/pages/Index.tsx:124) — alvo desta spec.

`StaffHome` mostra hoje:
1. Greeting + role badge.
2. 3 `SummaryCard` (Clientes, Pedidos ativos, Prontos entrega) — apenas pra `admin/master`.
3. 3 `BacklogCard` "Pendências" (Triagem, Coleta, Aprovação) — todos navegam pra `/admin` sem filtro.
4. "Resumo do Dia" — lista das últimas 5 ordens.
5. 4 Quick actions + CTA "Gerenciar Pedidos" → `/admin`.

### 1.2 Problemas estruturais

1. **Mono-empresa, mono-módulo.** Só conhece a tabela `orders` (afiação Colacor). Ignora vendas, estoque, reposição, financeiro, tintométrico, approvals — 11 das 13 seções do menu lateral.
2. **Mono-persona.** Trata todos os staff iguais. CLAUDE.md §5/§8 mapeia 5 personas operacionais distintas (vendedor externo, conferente, separador, comprador, tintométrico) + master/gestor — nenhuma é honrada.
3. **Desperdício em desktop wide.** `max-w-4xl` no centro de monitor 16", grid 3-col rígido. Nenhum padrão "cockpit" v3 (`.bg-cockpit-hero`, `.noise`, `font-display`, `.kpi-value`, status-bold).
4. **Navegação cega.** 4 cards diferentes levam todos pra `/admin` sem filtro pré-aplicado.
5. **Zero realtime.** `AdminReposicaoCockpit` tem Supabase Realtime; o `/` só recarrega no F5.
6. **Skeleton genérico.** Suspense fallback de 3 blocos cinza; não adota `PageSkeleton variant="cockpit"` da Fase 4.
7. **Sem "morning brief".** Nenhum item de "o que mudou desde sua última visita" / "agenda do dia".
8. **CTA duplicada.** "Gerenciar Pedidos" no rodapé vai pro mesmo `/admin` dos 5 cards de cima.
9. **Quick actions genéricas.** "Previsão" e "Relatórios" não são as ações mais frequentes de nenhuma persona.
10. **Fora do redesign visual v3.** Continua com `shadow-md`/`rounded-2xl` herdados; não adotou nada de `docs/visual-direction/`.

### 1.3 O que NÃO está quebrado (preservar)

- Bifurcação cliente/staff em `Index.tsx` — manter.
- Noção de "Pendências" como backlog visual com cores warning/info/destructive — pattern certo, falta abrangência.
- `PriorityCard` do `CustomerDashboard` ("Ação Recomendada" com 1 CTA específica) — gold standard que o staff também passa a ter.

---

## 2. Decisões de design (já confirmadas)

1. **Foco arquitetural**: híbrido — brief no topo + cockpit denso embaixo.
2. **Multi-empresa**: dashboard segue o `CompanySwitcher` do topbar e ganha opção `Todas as empresas` agregada.
3. **Persona**: auto-detect via sinais + override manual; transparência sobre fonte da inferência.
4. **Rollout**: full replace de `StaffHome` (sem feature flag). Sem rota nova.
5. **Brief**: misto — 1 PriorityCard + DeltasStrip ("desde sua última visita…").
6. **Realtime**: Supabase `postgres_changes` por zona + `refetchInterval: 60s` como fallback.
7. **Personalização (reorder/hide zonas)**: out-of-scope MVP, estrutura permite.
8. **Mobile**: responsivo (não fork de rota).
9. **Telemetria**: eventos PostHog `dashboard.<area>.<action>` via `@/lib/analytics`.
10. **Skeletons / empty / toast / tokens**: usar entregas da auditoria UX Fase 4.

---

## 3. Arquitetura

```
src/pages/Index.tsx
 ├─ !isStaff  → <CustomerDashboard />    (inalterado)
 └─ isStaff   → <StaffDashboard />        ◀ NOVO componente, substitui StaffHome inline

src/components/dashboard/StaffDashboard.tsx
 ├─ DashboardShell                       (provê contextos: persona + empresa + lastVisit)
 │   ├─ usePersona()                       (hook detecção + override)
 │   ├─ useDashboardCompany()              (lê CompanyContext, expõe single|all + lista alvo)
 │   └─ useLastVisit()                     (localStorage + refresh ao desmontar)
 │
 ├─ BriefZone                            (hero, zona 1)
 │   ├─ <PriorityCard />                   (1 ação prioritária por persona)
 │   └─ <DeltasStrip />                    ("desde sua última visita…")
 │
 ├─ CockpitGrid                          (zona 2, grid 3/3/2/1 col responsivo, ordem por persona)
 │   ├─ <VendasZone />
 │   ├─ <EstoqueZone />
 │   ├─ <ReposicaoZone />
 │   ├─ <FinanceiroZone />
 │   ├─ <TintometricoZone />
 │   └─ <SistemaZone />                    (Approvals + saúde de integrações)
 │
 └─ DashboardFooter                       (chips persona+empresa + hints de atalho)
```

Cada `<*Zone />` é **componente isolado** com:
- Hook próprio em `src/queries/dashboard/use<Zona>Zone.ts` que sabe filtrar por empresa.
- Card unificado `<CockpitCard />` (header, 3 KPIs, top-3 list, footer "Abrir cockpit").
- Channel realtime opcional declarado pela zona via `useCockpitChannel`.
- Método `getPriority()` consumido pelo `<PriorityCard />` da zona brief.

**Boundary**: trocar uma zona não risca as outras; cada uma é testável isoladamente; toda comunicação cross-zone passa pelos contexts do `DashboardShell`.

---

## 4. Detecção de persona (`usePersona`)

### 4.1 Personas

| Persona | Definição via sinais |
|---|---|
| `vendedor` | `commercial_role = operacional` **ou** CPF em `salesOnlyCpfs` |
| `gestor` | `commercial_role = gerencial` |
| `estrategico` | `commercial_role = estrategico` ou `super_admin` (vê visão consolidada como `master`) |
| `comprador` | heurística: ≥40% das visitas dos últimos 30d em `/admin/reposicao/*` |
| `estoque` | heurística: ≥40% em `/admin/estoque/*` ou `/recebimento` |
| `financeiro` | heurística: ≥40% em `/financeiro/*` |
| `tintometrico` | heurística: ≥40% em `/tintometrico/*` |
| `master` | `role = master` sem heurística clara |
| `geral` | fallback final |

### 4.2 Função pura `inferPersona(signals)` em `src/lib/dashboard/persona-detect.ts`

Ordem de prioridade:
1. Override manual (`localStorage.dashboardPersonaOverride`) — sempre vence.
2. CPF em `salesOnlyCpfs` → `vendedor`.
3. `commercial_role` definido →
   - `operacional` → `vendedor`
   - `gerencial` → `gestor`
   - `estrategico` ou `super_admin` → `master` (visão estratégica consolidada)
4. Heurística de top prefixo (`≥40%`, mínimo 10 visitas no janela 30d) → uma das personas operacionais.
5. Default: `master` se `role=master`, senão `geral`.

### 4.3 Tracker de rotas

`src/lib/dashboard/route-tracker.ts` — hook `useRouteTracker()` montado uma vez no `AppShell`. Em cada `location.pathname`:
- Computa o prefixo conhecido (`/admin/reposicao`, `/financeiro`, `/admin/estoque`, `/recebimento`, `/tintometrico`, etc.).
- Incrementa contador em `localStorage.dashboardRouteCounts` (estrutura: `{ [prefix]: { count, lastSeenIso }[30d window] }`).
- TTL: limpa entradas com `lastSeenIso > 30d` no incremento.
- **Não usa PostHog** — evita custo de query externa pra cada decisão.

### 4.4 Hook `usePersona()`

`src/hooks/usePersona.ts`:

```ts
type PersonaSource = 'manual' | 'commercial_role' | 'sales_only' | 'inference' | 'default';

type UsePersonaReturn = {
  persona: Persona;
  source: PersonaSource;
  allPersonas: Persona[];
  setOverride: (p: Persona) => void;
  clearOverride: () => void;
};
```

Internamente combina:
- `useAuth().role`
- `useCommercialRole()`
- `useSalesOnlyRestriction()` (extraído pra hook reusável; hoje vive inline em `AppShell.tsx:151`)
- `localStorage.dashboardRouteCounts`
- `localStorage.dashboardPersonaOverride`

Disponibilizado via `<DashboardPersonaContext />` envolvendo `<StaffDashboard />`.

### 4.5 UI da persona

Chip no header da `BriefZone`: `Visão: Vendedor · via cargo comercial ▼`. Click abre `Popover` com:
- Lista das 7 personas (cada uma com 1 linha "exemplos de KPIs que verá").
- Indicador "Atual" na ativa.
- "Limpar override" se houve override.

`source` impresso em caption pequena embaixo do nome ("via cargo comercial", "via inferência de uso", "definido por você", "padrão").

### 4.6 Efeito no layout

Cada persona define:
- `zoneOrder: ZoneId[]` — sequência dos 6 cards no grid.
- `priorityZones: ZoneId[]` — quais zonas contribuem pro `PriorityCard` (subset).

Mapeamento em `src/lib/dashboard/persona-config.ts`. Exemplos:

| Persona | `zoneOrder` | `priorityZones` |
|---|---|---|
| vendedor | Vendas, Sistema, Reposição, Estoque, Financeiro, Tintométrico | Vendas, Sistema (intel/agenda), Estoque |
| gestor | Vendas, Financeiro, Sistema, Reposição, Estoque, Tintométrico | Vendas, Financeiro, Sistema |
| comprador | Reposição, Estoque, Sistema, Vendas, Financeiro, Tintométrico | Reposição, Estoque |
| estoque | Estoque, Reposição, Vendas, Sistema, Financeiro, Tintométrico | Estoque, Reposição |
| financeiro | Financeiro, Vendas, Sistema, Reposição, Estoque, Tintométrico | Financeiro |
| tintometrico | Tintométrico, Estoque, Vendas, Sistema, Reposição, Financeiro | Tintométrico, Estoque |
| master / geral | Vendas, Estoque, Reposição, Financeiro, Tintométrico, Sistema | todas |

---

## 5. Sistema multi-empresa (`useDashboardCompany`)

### 5.1 Mudança no `CompanySwitcher`

Adiciona opção `Todas as empresas` no topo da lista, com **monograma triplo** (cores Colacor/Oben/SC empilhadas) e label "Grupo Colacor". Quando selecionada, `CompanyContext` armazena sentinela `'all'`.

### 5.2 Hook `useDashboardCompany()`

`src/hooks/useDashboardCompany.ts`:

```ts
type UseDashboardCompanyReturn = {
  mode: 'single' | 'all';
  companies: Company[];      // ['colacor','oben','colacor_sc'] em modo 'all'
  primary: Company;          // 'colacor' como fallback canônico em modo 'all'
};
```

`primary` resolve o caso de KPI que não pode somar (ex: status de fechamento contábil é por empresa) — mostra o da `primary` + aviso "ver outras".

### 5.3 Compatibilidade com páginas legadas

Páginas atuais não quebram: hook adapter `useRequiredCompany()` ignora `'all'` e devolve a última empresa single ativa salva em `localStorage`. Páginas que sabem lidar com agregado (Financeiro já tem em `getResumoFinanceiro(['oben','colacor','colacor_sc'])`) adotam `useDashboardCompany`.

### 5.4 Estratégia de agregação por zona

| Zona | Empresas suportadas | Em `mode=all` |
|---|---|---|
| Vendas | 3 | Sum dos KPIs + breakdown visual (dots coloridos por empresa abaixo do número, hover mostra %) |
| Estoque | 3 | Union de `picking_tasks` + `nfe_recebimentos` com badge de empresa em cada linha |
| Reposição | 3 | KPIs somados; lista top-3 agrupada por empresa |
| Financeiro | 3 | `getResumoFinanceiro([...])`; aging por empresa em mini-tabs |
| Tintométrico | **só Oben** | Em `mode=all`: renderiza normal. Em `mode=single ≠ oben`: `<EmptyState tone="operational">` com CTA "Trocar pra Oben" |
| Sistema | 3 | Approvals somados, integrações por empresa |

### 5.5 Visual do agregado

Padrão consistente em todos os KPIs `mode=all`:
- KPI grande em `.kpi-value`: ex. `R$ 1.247k`
- Mini-row de 3 dots coloridos abaixo (largura proporcional à participação)
- Hover/tap → tooltip "Colacor R$ 750k (60%) · Oben R$ 374k (30%) · SC R$ 123k (10%)"

### 5.6 Realtime e `mode=all`

Cada channel é por empresa. Em `mode=all` subscrevemos 3 channels paralelos. Cap teórico: **6 zonas × 3 empresas = 18 canais simultâneos** — confortável pro Supabase Realtime.

### 5.7 Persistência

Escolha do switcher continua em `localStorage`. Outras páginas que recebem `'all'` mas não sabem lidar caem no fallback de `useRequiredCompany()` silenciosamente (com `logger.warn` em dev).

---

## 6. Brief Zone (hero do topo)

Dois componentes empilhados dentro de um hero com `.bg-cockpit-hero + .noise`.

### 6.1 `<PriorityCard />` — 1 ação por dia

**Modelo**: cada zona expõe `getPriority(): { score: 0–100, item: PriorityItem | null }`. `DashboardShell` chama os `getPriority` das zonas listadas em `personaConfig[persona].priorityZones` e elege o maior score. Empates resolvidos pela ordem das zonas.

```ts
type PriorityItem = {
  id: string;
  variant: 'critical' | 'warning' | 'info' | 'success';
  icon: LucideIcon;
  title: string;          // "Cliente Acme em risco — sem contato há 18d"
  description: string;    // contexto curto, 1 linha
  cta: { label: string; path: string };
  metadata?: Record<string, unknown>;  // telemetria
};
```

### 6.2 Escala de score

- **90–100 critical**: bloqueia operação, prejuízo direto, regulatório (divergência conciliação, NF não conferida >24h, alerta crítico cliente).
- **60–89 warning**: atrasado mas recuperável (aging crítico >90d, fechamento mensal aberto após dia 5).
- **30–59 info**: atenção, deadline próximo (promoção fechando hoje, próxima ligação da agenda).
- **0–29**: nada qualifica → success card "Tudo sob controle, confira o cockpit abaixo."

### 6.3 Regras por persona (`src/lib/dashboard/priority-rules.ts`)

| Persona | Top fontes de prioridade |
|---|---|
| vendedor | Cliente em risco crítico (FarmerScoring) · orçamento >24h aguardando · próxima ligação da agenda |
| gestor | Meta semanal em risco · vendedor sem ligação após 14h · backlog >3d |
| comprador | `pedido_compra_sugerido` pronto pra aplicar · promoção fechando hoje · fornecedor anunciou aumento |
| estoque | NF >24h sem conferência · `picking_task` FEFO vencendo hoje |
| financeiro | Divergência conciliação · aging >90d · fechamento mensal atrasado |
| tintometrico | Última importação com erro · SKU sem map Omie bloqueando pedido |
| master / geral | Top alerta cross-módulo (max score de tudo) |

### 6.4 Visual do PriorityCard

Card `max-w-2xl`, padding generoso, ícone 40×40 com `bg-status-*-bg` à esquerda, título `font-display` h3, descrição muted, CTA `<Button size="touch">` (44px) à direita. Cor do card via `border-status-*-bold/30` + `bg-status-*-bg/40`.

### 6.5 `<DeltasStrip />` — "desde sua última visita…"

Faixa fina abaixo do PriorityCard. Compara estado atual vs `lastVisit` (timestamp em `localStorage.dashboardLastVisit`). Refresh do `lastVisit` **ao desmontar** o dashboard (não ao montar — senão o usuário nunca vê os próprios deltas).

### 6.6 Deltas por zona

Mostrados só os **relevantes pra persona** (cap em 5 bullets):

```
Desde sua última visita (há 4h 23min) • +12 pedidos • +3 NF chegaram •
2 aumentos anunciados • 1 cliente entrou em risco • +R$ 47k faturados
```

Linha única, `font-mono` nos números, bullets `•` como separadores. Cada delta é **clicável** e vai pra view filtrada por janela (ex: `/sales?createdAfter=2026-05-15T14:00`).

### 6.7 Edge cases do DeltasStrip

- `lastVisit === null` (primeiro acesso ou novo browser): strip mostra "Bem-vindo. Comece pelo cockpit abaixo." sem números.
- `lastVisit < 30min`: strip se esconde (nada material a reportar; evita ruído de quem ficou refrescando).
- Tudo zerado: strip mostra "Sem mudanças desde sua última visita há Xh." discreto.

### 6.8 Layout do Brief

```
┌─────────────────────────────────────────────────────────┐
│  .bg-cockpit-hero + .noise (atmospheric)                │
│                                                          │
│      [chip Visão: Vendedor ▼]  [chip Empresa: Todas ▼]  │
│                                                          │
│          ┌─────────────────────────────────────┐         │
│          │  [icon]  Cliente Acme em risco      │         │
│          │          Último contato há 18d…    │         │
│          │                          [Ligar →] │         │
│          └─────────────────────────────────────┘         │
│                                                          │
│  Desde sua última visita (4h) • +12 pedidos • 1 risco   │
└─────────────────────────────────────────────────────────┘
```

Chips persona+empresa **espelham** os states dos respectivos contexts mas dão affordance local — usuário não precisa subir até o topbar.

---

## 7. CockpitGrid + CockpitCard

### 7.1 Layout do grid

6 zonas no mesmo tamanho (sem spans variáveis no MVP — rítmico e previsível):

| Breakpoint | Colunas |
|---|---|
| `xl` ≥1280px | 3 |
| `lg` 1024–1279 | 3 |
| `md` 768–1023 | 2 |
| `sm` <768 | 1 |

Cada card altura fixa **~320px** pra ritmo visual. Ordem definida por `personaConfig[persona].zoneOrder`.

### 7.2 Anatomia do `<CockpitCard />`

```
┌────────────────────────────────────────┐
│ [icon] Vendas                  · Live  │  header  (48px)
│ Pipeline operacional · 3 empresas      │  caption (16px)
├────────────────────────────────────────┤
│                                         │
│   R$ 1.247k       72        12         │  KPI row  (~96px)
│   Faturado mês    Pedidos   Aguardando │
│   ↑ 8% vs ontem   ●●●       —          │
│                                         │
├────────────────────────────────────────┤
│  Acme — orçamento aguardando 24h   →   │  top-3
│  Beta — em rota há 3h              →   │  list
│  Gama — picking incompleto         →   │  (~96px)
├────────────────────────────────────────┤
│           Abrir cockpit →               │  footer (32px)
└────────────────────────────────────────┘
```

### 7.3 Subcomponentes

Todos em `src/components/dashboard/cockpit/`:

- `<CockpitCard>` — wrapper com border, padding, hover lift sutil
- `<CockpitCardHeader icon title caption liveBadge />` — LiveBadge pulsa via `.animate-ping-slow` só quando channel ativo
- `<CockpitKpiRow kpis={[{label, value, delta?, breakdown?, intent?}]} />` — 3 KPIs em row; valores em `.kpi-value` (Geist Mono); `delta` com seta + cor status; `breakdown` = dots de empresa em `mode=all`
- `<CockpitTopList items={[…]} max={3} emptyLabel />` — lista densa com hover, cada item é `<Link>` direto pro registro
- `<CockpitCardFooter ctaLabel path />` — texto centralizado, hover translate-x

### 7.4 O que cada zona mostra

| Zona | KPIs | Top-3 | Realtime tables |
|---|---|---|---|
| **Vendas** | Faturado hoje (Δ vs ontem) · Pedidos hoje · Orçamentos aguardando | Pedidos sem ação >24h por valor | `sales_orders`, `orders` |
| **Estoque** | NF pendentes (alerta >24h) · Picking abertos (badge FEFO vencendo) · Recebimentos hoje | NF/picking mais urgentes por FEFO | `nfe_recebimentos`, `picking_tasks` |
| **Reposição** | Pedidos sugeridos prontos · Alertas ativos · Aumentos 7d | Top alertas (reusa lógica de `SmartAlertsSection`) | `pedido_compra_sugerido`, `eventos_outlier`, `sku_parametros` |
| **Financeiro** | Aging >90d (R$) · Fluxo 13sem projetado · Confiabilidade DRE (%) | Top inadimplentes (reusa `getTopInadimplentes`) | `fin_lancamentos` (a confirmar no implementation; se ausente, polling apenas) |
| **Tintométrico** | Total fórmulas · SKUs mapeados/total · Status última importação | Últimos erros de importação | `tint_importacoes` |
| **Sistema** | Aprovações pendentes (ringing badge se >0) · Sync Omie · Sync Sayerlack | Integrações com erro/atraso | `pending_user_approvals` (a confirmar), `sync_logs` (a confirmar) |

> Tabelas "a confirmar" exigem checagem de schema no implementation. Se ausentes, o KPI fica como stub leve (1-shot via query existente) e o gap vira follow-up nomeado na PR.

### 7.5 Hook `useCockpitChannel` (realtime padronizado)

`src/hooks/dashboard/useCockpitChannel.ts`:

```ts
useCockpitChannel({
  table: 'sales_orders',
  filter: company !== 'all' ? `company=eq.${company}` : undefined,
  queryKeys: [['dashboard', 'vendas', company]],
  onConnect: () => setLive(true),
  onDisconnect: () => setLive(false),
});
```

Subscreve via `postgres_changes`, invalida queries do React Query no evento, expõe estado de conexão pro LiveBadge. Reusa pattern do `AdminReposicaoCockpit:54-85`.

Fallback: react-query `refetchInterval: 60_000`. Se channel cair, refetch de 60s mantém dados ~frescos.

### 7.6 Estados por card

- **Loading**: skeleton **interno** ao card (header real + KPI/list shimmer). Não bloqueia grid — cards aparecem assim que cada query resolve.
- **Empty** (zona não aplica à empresa atual, ex: Tintométrico em `mode=single=colacor`): `<EmptyState tone="operational">` dentro do card com CTA contextual ("Trocar pra Oben").
- **Erro**: `<CockpitCardError onRetry />` discreto — não derruba grid.
- **Sem permissão**: card não renderiza (vendedor sem acesso financeiro → grid mostra 5 cards).

---

## 8. DashboardFooter

Linha discreta no rodapé:
- Echo dos chips persona/empresa (paridade com brief, evita scroll-back).
- Hint de atalhos: `? atalhos · ⌘K busca · r recarregar · g d dashboard`.
- Botão "Personalizar dashboard" `disabled` com tooltip "em breve" — sinaliza intenção sem custo.

---

## 9. Telemetria PostHog

Todos via wrapper `@/lib/analytics`, namespace `dashboard.*`:

| Evento | Quando | Props |
|---|---|---|
| `dashboard.viewed` | mount | `{ persona, persona_source, company_mode, company_id, time_since_last_visit_min }` |
| `dashboard.brief.priority_shown` | render | `{ zone, variant, score, item_id }` |
| `dashboard.brief.priority_cta_clicked` | click | `{ zone, score, item_id }` |
| `dashboard.brief.delta_clicked` | click | `{ delta_type, count }` |
| `dashboard.persona.switched` | override | `{ from, to, source }` |
| `dashboard.company.switched_from_dashboard` | switch | `{ from, to }` |
| `dashboard.kpi.clicked` | click | `{ zone, kpi, persona }` |
| `dashboard.zone.list_item_clicked` | click | `{ zone, item_type, item_id }` |
| `dashboard.zone.open_cockpit` | footer CTA | `{ zone, persona }` |
| `dashboard.realtime.channel_connected` | channel state | `{ zone, table }` |
| `dashboard.realtime.channel_disconnected` | channel state | `{ zone, table }` |
| `dashboard.empty_state.shown` | render | `{ zone, reason }` |

**Novo dashboard PostHog "Afiação — Dashboard V3"** (criado durante implementation) com:
- Funil adoção (viewed → first interaction).
- Persona accuracy (% override / total).
- Top KPIs clicados por persona.
- Realtime reliability (% sessões com ≥1 channel conectado).
- Bounce zones (zonas com 0 cliques na sessão).

---

## 10. Atalhos de teclado

Registry via `useRegisterShortcuts` existente, montado no `StaffDashboard`:

| Tecla | Ação |
|---|---|
| `g d` | navegar pra dashboard (de qualquer lugar) |
| `p` | abrir popover persona switch |
| `e` | abrir popover empresa switch |
| `r` | refresh forçado (invalida `['dashboard']`) |
| `1` … `6` | scroll-to + outline da zona N (ordem da persona) |
| `?` | dialog global (já existe) |

Automaticamente listados no dialog `?` agrupados como "Dashboard".

---

## 11. Responsivo / mobile

- Grid: 3/3/2/1 colunas.
- Brief em mobile: chips persona+empresa empilhados; PriorityCard `w-full`; DeltasStrip vira `overflow-x-auto snap-x` se passa de 5 bullets.
- Atmosphere mantida (`.bg-cockpit-hero + .noise`) com padding menor (`py-6`).
- LiveBadge mobile: só dot, sem caption "Live".
- **Todos os CTAs do dashboard usam `<Button size="touch">` (44px)** — vendedor externo opera daqui no celular.
- `<EmptyState tone="operational">` é responsivo nativo.

---

## 12. Acessibilidade

- `focus-visible` herdado dos tokens v3.
- `aria-live="polite"` no `DeltasStrip` (anuncia delta novo).
- `aria-label` descritivo nos LiveBadges (`"Vendas — dados ao vivo"` / `"Vendas — sem conexão ao vivo"`).
- Skip-link "Pular pro cockpit" no `StaffDashboard` mount (para leitores de tela).
- Contraste KPIs `.kpi-value` validado em `docs/visual-direction/03-validacao.md`.

---

## 13. Métricas-alvo

| Métrica | Baseline (hoje) | Meta 30 dias após deploy |
|---|---|---|
| Tempo até 1ª ação no dashboard | ~15s estimado (clicando pra `/admin`) | < 8s |
| % sessões com `priority_cta_clicked` | 0% | > 30% |
| % usuários com persona override | n/a | < 15% (sinal: auto-detect OK) |
| % sessões com ≥1 `open_cockpit` | n/a | > 60% |
| LCP em 3G simulado | medir antes do deploy | < 2.5s |

---

## 14. Out-of-scope explícito

| Item | Por que fora | Quando entra |
|---|---|---|
| Drag-and-drop reorder de zonas | Complexity-cost > value MVP | Backlog v2 |
| Hide/show individual de zonas | Idem | Backlog v2 |
| Tabela `dashboard_visits` no DB | `localStorage` cobre 95%; cross-device é luxo | Quando houver dor real cross-device |
| Tabela `user_departments` | Inferência por uso cobre MVP; persistir exige produto + RLS | Sprint próprio |
| Salvar "visões nomeadas" | Premature | Backlog v2 |
| Onboarding tour | `OnboardingWizard` já existe pro cliente; staff sente menos | Backlog v2 |
| Modo TV / fullscreen pra painel | Caso de uso específico, baixa frequência | Sob demanda |
| Refactor das 19 outras telas pra `useDashboardCompany` | Cada uma tem seu pattern; converter sob demanda quando tocar | Por tela conforme uso |
| `CustomerDashboard.tsx` | Foco do redesign é staff; cliente já está OK | Não planejado |
| Feature flag de rollback | Decisão de rollout: full replace | Não planejado |

---

## 15. Plano de migração

1. Criar todos os novos arquivos em paralelo ao `StaffHome` atual (sem tocar `Index.tsx`).
2. **Dev-only**: validar `<StaffDashboard />` em rota temporária `/dashboard-v3` durante implementação. Essa rota **não vai pra produção** e é removida antes de abrir PR — o rollout final continua sendo full replace em `/`, sem rota nova exposta ao usuário.
3. Quando o componente estiver pronto, atualizar `Index.tsx` pra usar `<StaffDashboard />` no lugar do `StaffHome` inline.
4. Remover função `StaffHome`, `SummaryCard`, `BacklogCard` órfãs de `Index.tsx`.
5. Remover rota temporária `/dashboard-v3` antes do commit final.

---

## 16. Riscos e mitigações

| Risco | Severidade | Mitigação |
|---|---|---|
| Tabelas marcadas "a confirmar" não existem | Médio | Cair pra stub leve (1 KPI via query existente) e listar gap como follow-up |
| 18 channels Supabase simultâneos em `mode=all` impactam billing/perf | Baixo | Limites de Realtime no plano atual comportam; instrumentar `channel_connected/disconnected` pra observabilidade |
| Heurística de persona inferida classifica errado e usuário não percebe override disponível | Médio | `source` mostrado em caption explícita no chip; meta de "<15% override" é alarme se for alto demais |
| `lastVisit` em localStorage some quando usuário muda de browser → DeltasStrip silencia | Baixo | Edge case já tratado (mostra "Bem-vindo" sem números) |
| Performance do grid com 6 cards + 18 channels + queries | Médio | Cada zona tem skeleton interno; grid não bloqueia; cap em 60s de refetch; LCP medido pré-deploy |
| Páginas legadas recebem sentinela `'all'` e quebram | Médio | `useRequiredCompany()` adapter intercepta e cai pra última single ativa; warning no logger |
| Realtime channel não conecta → usuário vê dados estagnados sem aviso | Baixo | LiveBadge desaparece; refetch 60s mantém frescor; instrumentação pra observar |

---

## 17. Arquivos a criar

```
src/components/dashboard/
  StaffDashboard.tsx
  DashboardShell.tsx
  BriefZone.tsx
  PriorityCard.tsx
  DeltasStrip.tsx
  CockpitGrid.tsx
  DashboardFooter.tsx
  cockpit/
    CockpitCard.tsx
    CockpitCardHeader.tsx
    CockpitKpiRow.tsx
    CockpitTopList.tsx
    CockpitCardFooter.tsx
    CockpitCardError.tsx
  zones/
    VendasZone.tsx
    EstoqueZone.tsx
    ReposicaoZone.tsx
    FinanceiroZone.tsx
    TintometricoZone.tsx
    SistemaZone.tsx

src/contexts/
  DashboardPersonaContext.tsx

src/hooks/
  usePersona.ts
  useDashboardCompany.ts
  useRequiredCompany.ts
  useLastVisit.ts

src/hooks/dashboard/
  useCockpitChannel.ts

src/queries/dashboard/
  useVendasZone.ts
  useEstoqueZone.ts
  useReposicaoZone.ts
  useFinanceiroZone.ts
  useTintometricoZone.ts
  useSistemaZone.ts
  useBriefDeltas.ts

src/lib/dashboard/
  persona-detect.ts
  persona-config.ts
  priority-rules.ts
  route-tracker.ts
  delta-aggregators.ts
```

## 18. Arquivos a editar

```
src/pages/Index.tsx                      → substituir StaffHome inline por <StaffDashboard />
src/components/AppShell.tsx              → montar useRouteTracker() no shell
src/components/shell/CompanySwitcher.tsx → adicionar opção "Todas as empresas"
src/contexts/CompanyContext.tsx          → aceitar sentinela 'all'
```

## 19. Arquivos a remover

```
(removidos de Index.tsx)
  - StaffHome function
  - SummaryCard component
  - BacklogCard component
```
