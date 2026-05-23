# Controle de Acesso por Persona — Design Spec

> **Data:** 2026-05-23
> **Status:** aprovado no brainstorming, pronto pra planejar
> **Escopo:** Sub-projeto A (controle de acesso). O Sub-projeto B (home/agenda por grupo Hunter/farmer/inbound) é um brainstorm separado depois — depende da "tag de grupo" que este entrega.

## Goal

Controle de acesso "de verdade" por persona: cada papel (vendedor, gestor comercial, operação, financeiro, gestão/master, cliente) vê **só os módulos que pode** no menu lateral **e** não consegue abrir as rotas bloqueadas digitando a URL (guard de rota, não só esconder). Determinístico (sem heurística), baseado em `commercial_role` + `department` + `app_role`.

## Contexto (estado atual)

- **Detecção de persona já existe** (`src/lib/dashboard/persona-detect.ts` → `inferPersona`, `persona-config.ts` → `PERSONA_CONFIG`), mas serve pra **ordenar zonas do dashboard**, NÃO pra acesso. Mistura fontes (override, `user_departments`, sales_only, `commercial_role`, heurística de uso, default). **Não usar pra acesso** (heurística = acesso imprevisível).
- **Navegação hoje** (`AppShell.tsx`): gating binário via flag `managerOnly` por item + `useSalesOnlyRestriction` (lockdown por CPF em `company_config.sales_only_cpfs`). Sem granularidade por persona, sem guard de rota.
- **Fontes de dado determinísticas disponíveis:**
  - `useAuth()` → `appRole` (`employee|customer|master`), `isMaster`, `isStaff`.
  - `useCommercialRole()` → enum `commercial_role`: `operacional|gerencial|estrategico|super_admin|farmer|hunter|closer|master`.
  - `useUserDepartment()` → `user_departments.primary_dept`: `vendas|gestao|comprador|separador|conferente|tintometrico|financeiro|outro`.
  - `useSalesOnlyRestriction()` → boolean (CPF sales-only).
- **Admin de tagging já existe** no menu: "Liberar Acessos" (`/admin/approvals`) e "Departamentos" (`/admin/departments`).
- Rotas em `src/App.tsx` agrupadas sob `<ProtectedRoute><AppShellLayout/></ProtectedRoute>`.

## Decisões do brainstorming

1. **Camada de acesso dedicada e determinística** — separada do `inferPersona` (que continua só pro dashboard).
2. **Fonte:** `commercial_role` + `department` + `app_role` (+ `isSalesOnly`). **Código estático** (matriz no código, não config dinâmica).
3. **Frontend-first:** filtro de menu + guard de rota no front. (RLS de banco fica fora deste escopo — observação no roadmap.)
4. **Default de quem não tem tag = Vendedor** (acesso a Vendas + Principal). Ninguém fica trancado fora do básico; ninguém ganha financeiro/admin sem ser taggeado.
5. **Tag de grupo** (`hunter|farmer|closer`, do `commercial_role`) — NÃO muda acesso (todos = Vendedor), mas é exposta pra Performance (escopo) e pra home (Sub-projeto B).
6. **Estoque + Tintométrico (balcão) + Produção = uma persona "Operação".** Sem persona separada de produção. Cockpit analítico de tintométrico fica com Gestão/Master.
7. **Comprador = só o Lucas** → dobra em Master (Reposição + Inteligência = master).
8. **Gestor comercial = puramente comercial:** sem /financeiro módulo, sem reposição/estoque/admin. A parte financeira que ele vê é a **do cliente** (Customer 360).
9. **Vendedor + Gestor + Master veem a situação financeira do CLIENTE** (Customer 360) — distinto do módulo /financeiro.

## Arquitetura

### Personas de acesso + matriz

Personas (de acesso): `vendedor`, `gestor_comercial`, `operacao`, `financeiro`, `gestao` (master tier), `cliente`.

Seções de navegação (colunas): `principal` (Dashboard + Meu dia), `clientes` (Customer 360), `vendas` (Pedidos/Novo/Ferramentas/**Telefonia**/Chamadas), `operacao` (Recebimento/Picking/Tintométrico-balcão/Produção), `reposicao`, `performance`, `inteligencia`, `financeiro` (módulo), `tintometrico_cockpit`, `gestao_admin` (Liberar Acessos/Departamentos/Governança/etc.), `docs` (Ajuda/Design System/UX Rules — todos).

| Persona (fonte) | principal | clientes | vendas+tel | operacao | reposicao | performance | inteligencia | financeiro | tinto_cockpit | gestao_admin |
|---|---|---|---|---|---|---|---|---|---|---|
| **vendedor** (operacional·farmer·hunter·closer / dept vendas / sales-only / default) | ✅ | ✅ | ✅ | ➖ | ➖ | ✅ (própria + grupo + empresa) | ➖ | ➖ | ➖ | ➖ |
| **gestor_comercial** (gerencial / dept gestao) | ✅ | ✅ | ✅ | ➖ | ➖ | ✅ (equipe) | ✅ | ➖ | ➖ | ➖ |
| **operacao** (dept separador·conferente·tintometrico) | ✅ | ➖ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ |
| **financeiro** (dept financeiro) | ✅ | ✅ | 🟡 leitura | ➖ | ➖ | ➖ | ➖ | ✅ | ➖ | ➖ |
| **gestao** (estrategico·super_admin·master / app master) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **cliente** (app customer) | portal do cliente (pedidos/ferramentas próprios) | — | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ |

- ✅ acesso · 🟡 leitura · ➖ bloqueado.
- **Situação financeira do cliente** (aging/crédito no Customer 360) = liberada pra `vendedor`, `gestor_comercial`, `financeiro`, `gestao` (quem tem `clientes`). É uma seção DENTRO do Customer 360, não o módulo /financeiro.
- **Performance escopada por grupo:** `vendedor` vê própria + agregado do seu grupo (`farmer`→"Farmers Geral"; `hunter`→"Hunters Geral"; `closer`→"Closers Geral") + total da empresa. `gestor_comercial`/`gestao` veem todos os grupos.

### Peça 1 — Resolver determinístico

`src/lib/access/resolve-access.ts`:
```
resolveAccessPersona({ appRole, commercialRole, department, isSalesOnly }): AccessPersona
```
Ordem de precedência (primeira que casar vence):
1. `appRole === 'master'` OU `commercialRole ∈ {estrategico, super_admin, master}` → `gestao`.
2. `commercialRole === 'gerencial'` OU `department === 'gestao'` → `gestor_comercial`.
3. `department === 'financeiro'` → `financeiro`.
4. `department ∈ {separador, conferente, tintometrico}` → `operacao`.
5. `appRole === 'customer'` → `cliente`.
6. `commercialRole ∈ {operacional, farmer, hunter, closer}` OU `department === 'vendas'` OU `isSalesOnly` → `vendedor`.
7. **default** (staff sem tag) → `vendedor`.

`resolveGroupTag(commercialRole): 'hunter'|'farmer'|'closer'|null` — pra Performance/home.

Composição via hook `useAccess()` que junta `useAuth`+`useCommercialRole`+`useUserDepartment`+`useSalesOnlyRestriction` → `{ persona, group, can(section) }`.

### Peça 2 — Matriz como dado estático

`src/lib/access/access-matrix.ts`:
```
ACCESS: Record<AccessPersona, { sections: Set<SectionId>; readOnly: Set<SectionId> }>
```
A matriz acima vira esse objeto. `can(section)` = `ACCESS[persona].sections.has(section)`. `isReadOnly(section)` p/ as células 🟡.

### Peça 3 — Filtro de menu

`AppShell.tsx`: cada item/seção do menu ganha um `section: SectionId`. O filtro passa a ser `useAccess().can(item.section)` em vez de `managerOnly`/`isSalesOnly` soltos. Remove o gating binário antigo (migra `managerOnly`→seção correspondente; mantém `isSalesOnly` só como uma das entradas do resolver).

### Peça 4 — Guard de rota

`src/components/access/RequireAccess.tsx`:
```tsx
<RequireAccess section="financeiro"><Outlet/></RequireAccess>
```
Envolve os grupos de rota no `App.tsx` por seção. Se `!can(section)` → `<Navigate to="/" replace />` (ou uma tela "sem acesso"). É o "de verdade": bloqueia URL digitada na mão.

### Peça 5 — Customer 360: seção financeira do cliente

Dentro do Customer 360, a seção/aba de situação financeira do cliente é renderizada só se `can('clientes')` E persona ∈ {vendedor, gestor_comercial, financeiro, gestao}. (Todos que têm `clientes` já satisfazem; o gate explícito evita vazar se o acesso a `clientes` for ampliado no futuro.)

### Peça 6 — Tag de grupo na Performance

A Performance lê `useAccess().group`: `vendedor` com grupo → filtra "minha + meu grupo + empresa". Sem mudar acesso, só escopo de dados exibidos. (Implementação do filtro de dados pode ser fase incremental — o spec garante a tag disponível.)

## Fora de escopo (este spec)

- **Sub-projeto B — home/agenda por grupo** (Hunter vs farmer vs inbound: o que aparece primeiro). Brainstorm próprio, com mockups. Usa a tag de grupo entregue aqui.
- **RLS de banco por persona** (defesa server-side). Este spec é frontend-first; o gating de UI + rota não substitui RLS pra dados sensíveis — registrar como observação de roadmap (hoje a maior parte do gating sensível já tem RLS própria por tabela).
- **Telas de admin pra criar/editar grupos comerciais** (Farmers/Hunters) — assume `commercial_role` já setado via "Liberar Acessos"/"Departamentos".
- Implementação fina do filtro de dados da Performance por grupo (a tag fica pronta; o filtro pode vir em fase 2).

## Touchpoints no código

- Criar: `src/lib/access/{resolve-access.ts, access-matrix.ts}` (+ testes puros), `src/hooks/useAccess.ts`, `src/components/access/RequireAccess.tsx`.
- Modificar: `src/components/AppShell.tsx` (itens ganham `section`; filtro via `useAccess`), `src/App.tsx` (envolver grupos de rota com `RequireAccess`), Customer 360 (gate da seção financeira do cliente).
- Reusar: `useAuth`, `useCommercialRole`, `useUserDepartment`, `useSalesOnlyRestriction`.
- NÃO tocar: `inferPersona`/`persona-config` (continuam pro dashboard).
