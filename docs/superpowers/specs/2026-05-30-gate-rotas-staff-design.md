# Gate de acesso por staff nas rotas administrativas — design

**Data:** 2026-05-30
**Autor:** sessão Claude (decisão de estrutura/granularidade validada por codex, 3 rodadas convergentes)
**Status:** aprovado pelo founder (aguardando review do spec antes do plano)

---

## 1. Contexto e problema

`ProtectedRoute` (`src/components/ProtectedRoute.tsx`) envolve **todas** as rotas autenticadas, mas só verifica `user` + `isApproved` — **não verifica role**. Consequência: qualquer usuário com role `customer` aprovado alcança rotas administrativas via deep-link (digitar a URL, bookmark, link compartilhado), p.ex.:

- `/admin/customers/:customerId/360` → `Customer360`/`CustomerHero` (ferramenta de staff: Ligar / WhatsApp / Novo pedido / Agendar visita)
- `/admin/route-planner` → planejador de rotas

Na prática o dano de **dados** já está contido: a RLS no Supabase é a barreira primária (ex.: o botão "Agendar visita" falha no `INSERT` por `carteira_visivel_para`), e a nav (sidebar/cmd-k) já esconde os itens de staff de quem é customer. Mas a **superfície de UX está errada**: o customer vê uma tela de ferramenta de staff e, ao clicar, recebe erro. Isso parece bug, expõe funcionalidade interna e confunde.

**Escopo deste trabalho:** hardening de UX / redução de superfície na **camada de roteamento**. **NÃO** é a barreira primária de segurança (essa continua sendo a RLS, que **não muda**).

## 2. Estado relevante do código

- `App.tsx`: todas as rotas autenticadas num único bloco achatado `<Route element={<ProtectedRoute><AppShellLayout/></ProtectedRoute>}>` (~linhas 206–363). ~95 rotas de staff intercaladas com ~15 customer-facing, em ordem arbitrária.
- Já existe **um sub-bloco protegido por role** dentro desse bloco: `<Route element={<RequireFinanceiroAccess/>}>` envolvendo `/financeiro/*` (linhas 284–304). É o padrão que este trabalho replica.
- `RequireFinanceiroAccess` (`src/components/RequireFinanceiroAccess.tsx`): layout-route que renderiza `<Outlet/>`. Trata `loading`, libera `isStaff` **OU** quem tem `fin_permissoes` (a query só roda `enabled: !isStaff`), senão mostra um Card "Sem acesso" com link "Voltar ao início". Descrito no próprio código como "defesa em profundidade espelhando o backend".
- `useAuth()` (`src/contexts/AuthContext.tsx`): expõe `isStaff = isAdmin || isEmployee || isMaster` e `loading`. Fail-closed: se a query de role falha, `role → null`, `isStaff → false`.
- `Index` (rota `/`) já roteia por role internamente: `isStaff ? <StaffDashboard/> : <CustomerDashboard/>`.
- `Admin.tsx` já tem early-redirect interno `if (!isStaff) navigate('/')`.
- `UnifiedOrder` (rotas `/new-order` **e** `/sales/new`, mesmo componente): `isCustomerMode = !authLoading && !isStaff` (`useUnifiedOrder.ts:313`) — o modo é decidido por **role, não pela rota**. Customer cria a própria OS em modo simplificado (sem seleção de cliente); staff seleciona cliente.

## 3. Decisões (e por quê)

As três decisões de arquitetura foram validadas com o codex em 3 rodadas independentes — todas convergiram para a mesma recomendação.

### 3.1 Estrutura: **default-deny**

As ~15 rotas customer-facing ficam **diretas** sob o `ProtectedRoute` existente. **Todo o resto** vai para dentro de um novo layout-route `<Route element={<RequireStaff/>}>`.

Por quê (vs. allowlist-staff explícita ou prop `requireStaff` rota-a-rota): é o único desenho em que **esquecer** vira falha *segura*. Uma rota administrativa nova criada no futuro nasce **dentro** do bloco staff (protegida por padrão); o erro humano vira "trancado demais", não "vazou". As alternativas dependem de disciplina contínua e, com ~95 rotas crescendo, uma rota nova fora do wrapper vazaria silenciosamente. O diff é maior, mas é mecânico e revisável.

### 3.2 Granularidade: **só binário staff**

`RequireStaff` apenas separa `customer` de `staff` (qualquer `employee`/`master` passa). A granularidade fina (`managerOnly` / `masterOnly` / `gestorComercialOuMaster`) **não** é replicada na camada de rota — continua só na nav (`AppShell.tsx`) + RLS, como hoje.

Por quê: o problema relatado é customer alcançando superfície de staff. A RLS já é a barreira primária e a nav já expressa a segmentação fina. Replicar dezenas de decisões de role por rota aumentaria muito o escopo e o risco de divergência/quebra de fluxo interno, sem resolver melhor o bug. O CLAUDE.md (§5) trata personas/departamentos como trabalho de produto futuro. Promover um guard fino por rota fica para quando houver requisito explícito para uma área específica.

### 3.3 Rotas ambíguas

- **`/new-order` → customer-facing (NÃO gatear).** É o mesmo componente que vira modo-cliente por role (`isCustomerMode = !isStaff`). Gatear quebraria o cliente criar a própria OS.
- **`/settings` → staff-only.** É configuração de app/empresa (feature flags, toggle de backend de chamada WebRTC/Nvoip, company config), não preferência de conta do cliente.

### 3.4 Financeiro fica **fora** do `RequireStaff` (irmão, não filho)

`/financeiro/*` permanece sob `RequireFinanceiroAccess`, como **bloco irmão** do `RequireStaff` — **não** aninhado dentro dele.

Por quê: `RequireFinanceiroAccess` é *mais permissivo* que staff — libera `isStaff` **OU** quem tem `fin_permissoes` (suporta, por design, um não-staff com permissão financeira, ex.: contador externo). Aninhar `/financeiro/*` dentro de `RequireStaff` bloquearia esse caso. O guard financeiro **não é tocado** por este trabalho.

## 4. Arquitetura proposta

### 4.1 Novo componente `src/components/RequireStaff.tsx`

Gêmeo enxuto do `RequireFinanceiroAccess`. Layout-route que renderiza `<Outlet/>`:

```tsx
import { Link, Outlet } from 'react-router-dom';
import { Loader2, Lock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Defesa em profundidade da superfície de staff. O ProtectedRoute só checa
 * auth+aprovação (não role), então sem este guard um customer logado alcança
 * rotas administrativas pela URL. Libera staff (employee/master); bloqueia o
 * resto com uma tela clara. O gate real continua no banco (RLS) — isto é UX +
 * redução de superfície, não a barreira primária.
 */
export const RequireStaff = () => {
  const { isStaff, loading } = useAuth();

  if (loading) {
    return (/* spinner centralizado, igual ao RequireFinanceiroAccess */);
  }

  if (!isStaff) {
    return (/* Card "Área restrita à equipe" + Button asChild <Link to="/">Voltar ao início</Link> */);
  }

  return <Outlet />;
};
```

Pontos de comportamento:
- **Trata `loading`**: não renderiza o Card de bloqueio antes do role resolver (senão pisca bloqueio / falso-negativo em refresh). Enquanto `loading`, mostra spinner.
- **Fail-closed**: se `role` falhou ao carregar, `isStaff` já vem `false` do AuthContext → bloqueia. Correto.
- **Saída clara**: customer que cai numa rota staff (deep-link/bookmark) vê "Área restrita à equipe" com CTA "Voltar ao início" — não redirect silencioso (ajuda em deep-link/suporte). Texto/estilo espelham o Card do `RequireFinanceiroAccess`, trocando o copy para staff.

### 4.2 Reorganização do `App.tsx`

Sem tocar nas páginas — apenas reposicionar rotas na árvore. O wrapper `RequireStaff` é um **pathless layout route**, então os `path` dos filhos permanecem idênticos: **nenhuma URL muda**.

```tsx
<Route element={<ProtectedRoute><AppShellLayout /></ProtectedRoute>}>

  {/* ── Customer-facing (abertas a qualquer aprovado) ── */}
  <Route index element={<Index />} />
  <Route path="orders" element={<Orders />} />
  <Route path="orders/:id" element={<OrderDetail />} />
  <Route path="new-order" element={<UnifiedOrder />} />
  <Route path="profile" element={<Profile />} />
  <Route path="addresses" element={<Addresses />} />
  <Route path="tools" element={<Tools />} />
  <Route path="tools/:toolId" element={<ToolHistory />} />
  <Route path="tools/:toolId/reports" element={<ToolReports />} />
  <Route path="support" element={<Support />} />
  <Route path="loyalty" element={<Loyalty />} />
  <Route path="gamification" element={<Gamification />} />
  <Route path="training" element={<Training />} />
  <Route path="recurring-schedules" element={<RecurringSchedules />} />
  <Route path="savings" element={<SavingsDashboard />} />

  {/* ── Financeiro (guard próprio, mais permissivo — irmão, intocado) ── */}
  <Route element={<RequireFinanceiroAccess />}>
    {/* /financeiro/* — exatamente como hoje */}
  </Route>

  {/* ── Staff-only (default-deny: todo o resto) ── */}
  <Route element={<RequireStaff />}>
    {/* ~95 rotas, incluindo o ReposicaoSessionLayout aninhado e os redirects legados */}
  </Route>

</Route>
```

Ordem de aninhamento dos guards: `ProtectedRoute` → `AppShellLayout` → (customer direto | `RequireFinanceiroAccess` | `RequireStaff`). Layout-routes aninhados dentro do staff (`ReposicaoSessionLayout`) ficam `RequireStaff > ReposicaoSessionLayout > rotas` — dois `Outlet` encadeados, padrão suportado pelo React Router v6.

## 5. Classificação completa das rotas

### 5.1 Customer-facing (15 — ficam diretas, abertas a qualquer aprovado)

`/` · `/orders` · `/orders/:id` · `/new-order` · `/profile` · `/addresses` · `/tools` · `/tools/:toolId` · `/tools/:toolId/reports` · `/support` · `/loyalty` · `/gamification` · `/training` · `/recurring-schedules` · `/savings`

**Validação de navegação:** mapeei todos os destinos clicáveis que um customer alcança (CustomerDashboard + 5 subcomponentes + `config.ts` `QUICK_ACTIONS` + páginas customer + `OnboardingWizard`). Os destinos reais são `/`, `/new-order`, `/orders`, `/profile`, `/tools`, `/gamification`, `/support`, `/training`, `/loyalty`, `/addresses` — **todos dentro da allowlist**. Nenhuma navegação legítima do cliente cai numa rota que será trancada.

**Nota sobre "as 15 para o farmer do cliente" (decisão founder + codex, 2026-05-30):** as 15 telas são **self-scoped** — mostram dados do `user.id` LOGADO (`useCustomerPendingOrders(user.id)`, `useUserToolsSummary(user.id)`, `Index` roteia `isStaff ? Staff : Customer`). Por isso elas ficam **abertas** (fora do `RequireStaff`): o vendedor/farmer (staff) **não fica bloqueado** delas. Mas, sendo self-scoped, abrir essas telas logado como farmer mostraria os *próprios* dados do farmer (vazios) — **não** os do cliente. A necessidade real do farmer ("ver a vida do cliente": pedidos/ferramentas/fidelidade) **já é atendida pela Visão 360** (`/admin/customers/:customerId/360` → `Customer360View`, parametrizada por `customerId`, gated por RLS, já com `useUserToolsSummaryById`), que é **staff-only e fica DENTRO do `RequireStaff`**. **Decisão:** este trabalho **não** parametriza as 15 por cliente nem cria impersonação farmer→cliente — isso seria feature grande (15 telas + cada query → by-id), arriscada, e ~80-90% já coberta pelo 360. "Farmer ver as 15 no contexto do cliente" fica como **possível incremento FUTURO no Customer 360** (spec próprio; o passo anterior seria perguntar ao founder *o que falta no 360* — provavelmente nada ou 1-2 abas, ex.: fidelidade/gamificação do cliente). **Não** quebrar o self-scoping das 15 (trocar `user.id` por param em massa vazaria dados entre clientes e duplicaria o 360).

### 5.2 Financeiro (já protegido — `RequireFinanceiroAccess`, fica como está)

`/financeiro` e todos os `/financeiro/*` (dashboard, sync, mapping, capital-giro, fechamento, analytics, cockpit, conciliacao, orcamento, intercompany, intercompany/fila, tributario, valor, valor-cockpit, proxima-acao, regime-tributario, funding, gestao, analise).

### 5.3 Staff-only (entram no `RequireStaff`)

Todo o restante do bloco. Agrupado para referência do plano:

- **Admin/clientes/pedidos:** `/admin`, `/admin/approvals`, `/admin/departments`, `/admin/customers`, `/admin/customers/:customerId`, `/admin/customers/:customerId/360`, `/admin/orders/:id`, `/admin/orders/:id/quality`, `/admin/demand-forecast`, `/admin/route-planner`, `/admin/monthly-reports`, `/admin/productivity`, `/admin/loyalty`, `/admin/gamification`, `/admin/training`, `/admin/price-table`, `/admin/analytics-sync`, `/admin/clientes-nao-vinculados`
- **Vendas:** `/sales`, `/sales/products`, `/sales/new`, `/sales/print`, `/sales/quotes`, `/sales/edit/:id`, `/unified-order` (redirect legado → `/sales/new`), `/vendas/ferramentas`
- **Farmer/comercial:** `/farmer`, `/meu-dia`, `/farmer/calls`, `/farmer/calls/pending-link`, `/farmer/governance`, `/farmer/recommendations`, `/farmer/locc`, `/farmer/bundles`, `/farmer/copilot`, `/farmer/tactical-plan`, `/farmer/ipf`
- **Executivo/intel:** `/executive/dashboard`, `/intelligence`, `/ai-ops`
- **Config/dev/docs:** `/settings`, `/coaching`, `/docs`, `/design-system`, `/design-preview`, `/ux-rules`
- **Governança:** `/governance/users`, `/governance/permissions`, `/governance/math`, `/governance/audit`, `/governance/settings`, `/governance/companies`
- **Tintométrico:** `/tintometrico`, `/tintometrico/importar`, `/tintometrico/mapeamento`, `/tintometrico/precos`, `/tintometrico/formulas`, `/tintometrico/corantes`, `/tintometrico/integracoes`, `/tintometrico/reconciliacao`, `/tintometrico/sync-runs`, `/tintometrico/api-contract`, `/tintometrico/catalogo`, `/tintometrico/integracao`
- **Estoque/recebimento/produção:** `/recebimento`, `/recebimento/:id`, `/nfe-receipt`, `/producao`, `/admin/estoque/recebimento`, `/admin/estoque/picking`, `/admin/estoque/picking/mobile`
- **Reposição:** `/admin/reposicao/revisao`, `/historico`, `/alertas`, `/aplicacao` (redirect), `/grupos-producao`, `/cadeia-logistica`, `/pedidos`, `/sla-fornecedor`, `/promocoes`, `/promocoes/novo`, `/promocoes/:id`, `/aumentos`, `/aumentos/novo`, `/aumentos/:id`, `/oportunidades`, `/negociacao-paralela`, `/cadastros`, `/cockpit` (LegacyCockpitRedirect), `/mercado` (redirect), `/parametros` (redirect); o bloco `ReposicaoSessionLayout` (`/admin/reposicao/sessao` + `/mercado`, `/parametros`, `/pedidos`, `/aplicacao`, `/confirmacao`, `/historico`); `/admin/sku-mapeamento`
- **Gestão/automação/outros:** `/performance`, `/gestao/admin`, `/gestao/governanca`, `/gestao/saude-dados`, `/admin/ajuda`, `/admin/des/trimestre-atual`, `/admin/notificacoes`, `/admin/portal-sayerlack`, `/admin/sip-credentials`, `/admin/knowledge-base`, `/admin/knowledge-base/:id`, `/admin/standard-processes`, `/admin/standard-processes/new`, `/admin/standard-processes/:id`, `/admin/calculadora`, `/telefonia`, `/whatsapp`

> **Redirects legados** (`/unified-order`, `/admin/reposicao/cockpit|mercado|parametros|aplicacao`) ficam no staff. Um customer que acerte um deles vê "Área restrita" em vez do redirect — aceitável (são caminhos de staff; o customer usa `/new-order`).

## 6. Fix incluído (bug pré-existente)

`src/pages/Gamification.tsx` (linhas 27 e 49) aponta o pilar "Organização" para `/orders/new` — **rota que não existe** (a correta é `/new-order`). Hoje já cai em `NotFound`. **Entra neste PR** (decisão do founder, 2026-05-30): corrigir `/orders/new` → `/new-order` nas duas linhas (`PILLAR_CONFIG` linha 27 e `PILLAR_ACTIONS` linha 49). É a única rota de cliente que estava quebrada; coerente corrigir junto, já que o trabalho toca a navegação do cliente.

## 7. Não-objetivos

- Mudar RLS ou qualquer coisa no backend/Supabase.
- Granularidade fina (manager/master/gestor) na camada de rota.
- Tocar `RequireFinanceiroAccess` ou o early-redirect interno do `Admin.tsx` (vira redundância inofensiva — defesa em profundidade).
- Remover itens de staff da nav (já estão gateados lá).
- Mover rotas/mudar URLs (a reorganização é estrutural; paths inalterados).

## 8. Estratégia de teste

Existe um template direto a espelhar: **`src/components/__tests__/RequireFinanceiroAccess.test.tsx`** — testa o guard gêmeo com vitest + `@testing-library/react`, `useAuth` mockado via `vi.mock('@/contexts/AuthContext')`, renderizando dentro de `<MemoryRouter>`. O `RequireStaff.test.tsx` segue o mesmo padrão (mais simples, pois `RequireStaff` não tem a query `fin_permissoes`).

- **Teste de unidade do `RequireStaff`** (`src/components/__tests__/RequireStaff.test.tsx`), espelhando `RequireFinanceiroAccess.test.tsx`:
  1. `loading: true` → renderiza spinner (não o Card de bloqueio).
  2. `loading: false, isStaff: false` (customer) → renderiza o Card "Área restrita à equipe" e **não** o conteúdo filho.
  3. `loading: false, isStaff: true` → renderiza o `<Outlet/>` (conteúdo filho).
  - Renderiza dentro de `<MemoryRouter>` com uma rota filha sentinela sob `<Route element={<RequireStaff/>}>` para exercitar o `Outlet`.
- **Garantia de que as rotas certas estão sob o guard:** verificada por **review do diff** + **smoke manual no Chrome real do founder** (logar como customer e tentar `/admin/customers/:id/360`, `/admin/route-planner`, `/sales/new`, `/settings` → "Área restrita"; e `/new-order`, `/orders`, `/tools` → normais; logar como staff → tudo passa). Renderizar o `App` inteiro num teste exigiria mockar dezenas de páginas lazy + Supabase — custo desproporcional para um wrapper trivial; e o `/browse` headless não renderiza esta SPA (CLAUDE.md §5), então o smoke de UI é no navegador real.

Gates do CI (`bun run typecheck:strict`, `tsc -p tsconfig.app.json`, `bun run test`, `bun build`, `bun lint`) precisam passar.

## 9. Riscos e armadilhas (mapeados)

- **Flicker/falso-bloqueio no refresh:** mitigado tratando `loading` antes de decidir (igual ao guard financeiro).
- **Aninhar financeiro por engano dentro do staff:** explicitamente evitado (§3.4) — bloquearia não-staff com `fin_permissoes`.
- **Layout-routes aninhados (`ReposicaoSessionLayout`):** ficam dentro do `RequireStaff`; encadeamento de `Outlet` é suportado. Confirmar no plano que o aninhamento JSX está correto.
- **Index route `/`:** permanece filho direto do `AppShellLayout` (fora do `RequireStaff`), pois `Index` já roteia por role.
- **Diff grande e mecânico:** risco de mover uma rota para o grupo errado. Mitigado pela classificação completa (§5) + review do diff como gate.

## 10. Entregáveis

1. `src/components/RequireStaff.tsx` (novo).
2. `src/App.tsx` reorganizado em 3 grupos (customer / financeiro / staff).
3. `src/components/__tests__/RequireStaff.test.tsx` (novo, 3 casos).
4. Fix `/orders/new` → `/new-order` em `Gamification.tsx` (linhas 27 e 49) — incluído neste PR.
