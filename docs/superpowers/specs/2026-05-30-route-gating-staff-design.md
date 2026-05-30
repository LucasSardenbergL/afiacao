# Gating de rota por staff — `RequireStaff` (fail-closed)

**Data:** 2026-05-30
**Autor:** Lucas + Claude
**Status:** aprovado (design + classificação de rotas confirmados pelo founder)

---

## 1. Problema

`src/components/ProtectedRoute.tsx` só verifica `user` + `isApproved` — **não** exige role de staff. Como **staff e customer são ambos "aprovados"**, um **customer aprovado** consegue, por **deep-link**, alcançar rotas administrativas (`/admin/*`, `/sales/*`, `/farmer/*`, `/tintometrico/*`, `/governance/*`, `/gestao/*`, `/admin/reposicao/*`, `/intelligence`, `/ai-ops`, `/recebimento`, `/producao`, etc.).

**Mitigações já existentes** (por isso NÃO é incidente crítico, é hardening de autorização de UI): (a) a **nav** (sidebar) esconde os itens de staff pra customer (flags `managerOnly`/`masterOnly`); (b) a **RLS** protege os DADOS e as ESCRITAS; (c) algumas telas têm gate interno. Mas a **UI de ferramenta de staff renderiza** pra um customer que digitar a URL — ruim de confiança e expõe fluxos que alguém pode esquecer de proteger depois.

> Achado registrado durante a feature "Agendar visita"; priorizado pós-validação dela (recomendação do codex).

## 2. Decisões travadas (Q&A com o founder)

1. **Fail-closed (default-deny)** — gateia **tudo** por staff, e **libera explicitamente** a lista pequena de rotas do cliente. Rota nova nasce protegida (sem whack-a-mole). Escolhido sobre o "gate-list" (que deixaria rota staff nova/esquecida exposta).
2. **Não-staff → redirect pra `/`** (não tela de bloqueio). O cliente cai no próprio dashboard (o `/` já renderiza `CustomerDashboard` pra não-staff), sem uma tela "restrito" pra uma rota que ele nem deveria conhecer.
3. **Lista de rotas do cliente CONFIRMADA como completa** (ver §4) — as ambíguas (`/meu-dia`, `/admin/standard-processes`, `/nfe-receipt`, `/admin/des/*`, `/admin/portal-sayerlack`) vão pra **staff**.
4. **`/admin/calculadora` é customer-facing** (o cliente calcula o próprio rendimento) → fica **aberta**, apesar do prefixo `/admin/`.
5. **`/financeiro/*` é exceção** — mantém o gate próprio `RequireFinanceiroAccess` (que **permite não-staff COM permissão explícita** em `fin_permissoes`). **NÃO** entra sob `RequireStaff` (senão quebraria esse acesso intencional).

## 3. `RequireStaff` — componente

Espelha o `RequireFinanceiroAccess` já existente em `App.tsx` (mesmo formato: guard com `<Outlet/>`).

```tsx
import { Navigate, Outlet } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Gate de rota: só staff (isAdmin || isEmployee || isMaster) passa.
 * Não-staff (customer) é redirecionado pra '/' (cai no CustomerDashboard).
 * Fail-closed: se o role falhou ao carregar, isStaff=false → redirect (seguro).
 */
export const RequireStaff = () => {
  const { isStaff, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!isStaff) return <Navigate to="/" replace />;
  return <Outlet />;
};
```

- `isStaff` vem do `useAuth()` (`isAdmin || isEmployee || isMaster`), já **fail-closed** (role/approval falham → `null`/`false`).
- Arquivo: `src/components/RequireStaff.tsx` (ou colocar junto do `RequireFinanceiroAccess` se ele virar um módulo — mas hoje o `RequireFinanceiroAccess` vive inline no `App.tsx`; criar arquivo próprio é mais limpo e testável).

## 4. Reestruturação do `<Routes>` (`App.tsx`)

Hoje as rotas são **irmãs planas** sob `<Route element={<ProtectedRoute><AppShellLayout/></ProtectedRoute>}>` (com o `financeiro/*` já aninhado sob `<Route element={<RequireFinanceiroAccess/>}>`). Reorganizar em **3 grupos**:

### 4.1 Abertas (cliente + staff) — SEM `RequireStaff`
As únicas rotas que o customer usa de verdade:
- `index` (`/`) — `Index` (já renderiza por role)
- `orders`, `orders/:id`, `new-order`
- `profile`, `addresses`
- `tools`, `tools/:toolId`, `tools/:toolId/reports`
- `support`
- `loyalty`, `gamification`, `training`, `recurring-schedules`, `savings`
- **`admin/calculadora`** (customer-facing, confirmado)

(A pública `tool/:toolId` já fica fora do `ProtectedRoute` — sem mudança.)

### 4.2 Financeiro — mantém `RequireFinanceiroAccess` (intacto)
`financeiro/*` (18 rotas) seguem no `<Route element={<RequireFinanceiroAccess/>}>` **como hoje** — NÃO envolver em `RequireStaff`.

### 4.3 Staff-only — sob `<Route element={<RequireStaff/>}>`
**Todo o resto** (~120 rotas): `admin/*` (exceto `admin/calculadora`), `sales/*`, `farmer/*`, `meu-dia`, `recebimento*`, `producao`, `admin/estoque/*`, `admin/reposicao/*` (+ a sessão e os redirects), `tintometrico/*`, `governance/*`, `gestao/*`, `intelligence`, `ai-ops`, `executive/dashboard`, `performance`, `telefonia`, `whatsapp`, `vendas/ferramentas`, `nfe-receipt`, `coaching`, `settings`, `design-system`, `design-preview`, `ux-rules`, `docs`, etc.

> ⚠️ **`settings`** (`SettingsConfig`) — contém toggles de feature flags/telefonia/visual. **Decisão:** tratar como **staff** (é configuração do app, não do cliente). Se o cliente precisar de alguma config própria, ela já vive em `/profile`. (Se isso estiver errado, é só mover `settings` pro grupo aberto — sem risco estrutural.)

**Forma final (esqueleto):**
```tsx
<Route element={<ProtectedRoute><AppShellLayout /></ProtectedRoute>}>
  {/* 4.1 abertas */}
  <Route index element={<Index />} />
  <Route path="orders" element={<Orders />} />
  {/* ...demais abertas... */}
  <Route path="admin/calculadora" element={<AdminCalculadora />} />

  {/* 4.2 financeiro (gate próprio) */}
  <Route element={<RequireFinanceiroAccess />}>
    <Route path="financeiro" element={<FinanceiroDashboard />} />
    {/* ...18 rotas... */}
  </Route>

  {/* 4.3 staff (tudo o resto) */}
  <Route element={<RequireStaff />}>
    <Route path="admin" element={<Admin />} />
    {/* ...~120 rotas... */}
  </Route>
</Route>
```

A `<Route path="*" element={<NotFound/>}>` (catch-all) e as rotas públicas (`/auth`, `/reset-password`, `/tool/:toolId`) ficam **fora** do shell, inalteradas.

## 5. Testes

- **Unitário** `src/components/__tests__/RequireStaff.test.tsx` (vitest, mock de `useAuth` + `MemoryRouter`/`Routes`): `loading` → spinner; `isStaff=true` → renderiza o `<Outlet/>` (filho); `isStaff=false` → não renderiza o filho e redireciona pra `/` (assertar via uma rota `/` sentinela ou `useLocation`).
- **Manual / por perfil (founder, no device):** logar como **customer** → digitar `/admin/customers` (ou `/sales`, `/farmer`) na URL → deve cair em `/` (dashboard do cliente); confirmar que `/admin/calculadora` e as abertas **continuam acessíveis** pro cliente. Logar como **staff** → todas as rotas acessíveis (nada bloqueado). Logar como **não-staff com permissão de financeiro** → `/financeiro` continua acessível (a exceção do §2.5).
- **Suíte:** typecheck + lint + `bun run test` verdes (a reestruturação do `App.tsx` não muda lógica de tela, só o aninhamento das rotas).

## 6. Fora de escopo / notas
- **Não muda RLS** (a RLS já protege os dados; isto é hardening de navegação/UI).
- **Não muda a sidebar** (a nav já filtra por role; isto cobre o deep-link).
- **Não cria roles novos** nem mexe no `AuthContext`/`ProtectedRoute`.
- **Granularidade fina por persona** (separador só picking, comprador só reposição, etc.) — **fora de escopo**; isto é o gate grosso staff-vs-customer. A granularidade fina é trabalho de produto futuro (CLAUDE.md §5).
- **`useSalesOnlyRestriction`** (esconde tudo menos Vendas por CPF) — inalterado; é ortogonal (restringe staff dentro do staff).

## 7. Risco
- **Único risco real:** classificar uma rota no grupo errado → bloquear cliente (rota aberta foi pro staff) ou expor staff (rota staff foi pro aberto). **Mitigação:** a auditoria + a lista de abertas confirmada pelo founder + o teste dos 2 perfis. O grupo "aberto" é pequeno e explícito; tudo que não está nele cai em staff (fail-closed).
- **`isStaff` fail-closed:** um staff com falha transitória de query de role vira `isStaff=false` → redirect pra `/` (vê o CustomerDashboard até dar refresh). Comportamento de segurança aceitável (já é o comportamento atual do `AuthContext`).

## 8. Referência
Auditoria completa das ~153 rotas (classificação staff vs customer-facing + guards existentes: `isStaff`/`isMaster`/`isGestorComercial`, `useSalesOnlyRestriction`, `RequireFinanceiroAccess`, e o filtro da sidebar por `managerOnly`/`masterOnly`) feita nesta sessão.
