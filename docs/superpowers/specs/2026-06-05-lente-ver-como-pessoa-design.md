# Lente "Ver como pessoa" — visão de menu + telas do outro usuário (read-only)

> Spec de design · 2026-06-05 · status: **aguardando revisão do founder**
> Brainstorming conduzido com o founder + 1 consult adversarial `/codex` (gpt-5.5 xhigh) no design.

## 1. Contexto e problema

O founder clica no chip **"Visão: X"** do Dashboard esperando **ver o app como outra pessoa** (menu lateral + telas), pra **comparar o que cada um acessa** e, principalmente, **reproduzir bugs que as vendedoras (Farmers) relatam**. Hoje isso não acontece — e a confusão vem de existirem **dois sistemas distintos** que parecem a mesma coisa:

1. **Chip "Visão: X"** = `PersonaSwitcherChip` (`src/components/dashboard/PersonaSwitcherChip.tsx`). Troca a **persona do Dashboard**, que **só reordena os cards do cockpit** e muda a "ação prioritária" (`src/lib/dashboard/persona-config.ts`). **Não toca menu, dados nem acesso.** As "personas" (vendedor/gestor/comprador/estoque/financeiro/tintométrico/master/**geral**) são abstratas.
   - O **"Geral"** é o *fallback* da inferência automática (`src/lib/dashboard/persona-detect.ts:96-98`): quando nenhum sinal identifica a pessoa e ela não é master, cai em `geral` ("todos os módulos com peso igual"). **Não representa ninguém** — é só rede de segurança. Sai da lista de opções escolhíveis (vira fallback interno).

2. **Card "Ver como"** = `ViewAsPicker` + `ImpersonationContext` (`src/components/impersonation/`, `src/contexts/ImpersonationContext.tsx`). Lista **pessoas reais** e troca os **dados** (somente leitura, via `effectiveUserId`), com guard de CI `no-write-leak` por allowlist. **Não toca o menu** — a "camada de menu" foi deixada adiada de propósito.

**Achado-chave do gating do menu** (`src/components/AppShell.tsx`): hoje só existem **3 níveis efetivos** — sales-only (CPF restrito → só "Vendas"), staff comum (vê quase tudo) e gestor/master (vê tudo). Os itens `managerOnly` liberam pra **qualquer** employee. **O código não distingue "menu de vendedor" de "menu de comprador"** — essa diferença fina só existe nas personas abstratas, que não controlam acesso. Logo, "ver o menu do vendedor" só é fiel se **espelharmos o perfil de acesso REAL da pessoa**, não um papel inventado.

## 2. Objetivo e não-objetivos

**Objetivo.** Uma **lente read-only** acionada por pessoa real: o master entra na lente de uma Farmer e o app passa a se comportar como ela — **menu lateral**, **bloqueio de rota** e **telas internas** refletem o acesso dela, com os **dados** dela (reaproveitando o `ImpersonationContext`). Serve pra (a) comparar acesso entre pessoas e (b) reproduzir bugs de navegação/render que elas relatam.

**Não-objetivos.**
- **Não é barreira de segurança.** No servidor, o RLS continua sendo o master. A lente muda **só exibição e navegação no cliente**. (Pra testar RLS de verdade → login real / sandbox.)
- Não criar um modelo de RBAC novo nem "papéis abstratos" com acesso curado (rejeitado — divergiria da realidade).
- Não impersonar cliente final; não permitir que gestor (não-master) use a lente (segue master-only, como o `ImpersonationContext` atual).
- Não reproduzir bug de **dado** específico além do que o `effectiveUserId` já entrega (isso já existe).

## 3. Decisões (founder + consult)

| # | Decisão | Origem |
|---|---------|--------|
| D1 | Lente **por pessoa real** (não por papel abstrato). Some sozinha quando não há ninguém num papel. | founder |
| D2 | Profundidade: **menu + rotas + telas internas** (Fase 1 + Fase 2). | founder |
| D3 | Entrada **no lugar do chip "Visão"** → vira **"Ver como: [pessoa]"**; banner global quando ativa. | founder |
| D4 | **Aposentar o seletor manual de papel** do `PersonaSwitcherChip`. A reordenação **automática** de cards continua (e passa a refletir a persona do alvo dentro da lente). "Geral" sai como opção. | founder |
| D5 | **Travar toda escrita enquanto a lente está ativa** (pra "somente leitura" ser verdade — senão o master grava como master sem perceber). | founder |
| D6 | Hook de display **separado e renomeado** `useDisplayAccess()` (campos `display*`), **nunca** `useEffectiveAccess` genérico. Escrita/identidade ficam **sempre** no `useAuth()` real. | codex |
| D7 | **Guardrails de CI ANTES de migrar** (ESLint + teste AST) + **Fase 1.5 de auditoria** classificando cada callsite. | codex |

## 4. Achados do consult `/codex` (resumo)

O codex aprovou a intenção mas reprovou o **contrato** do hook genérico. Furo real encontrado:

- **`src/components/carteira/CoveragePanel.tsx:41`**: `const coveredId = isMaster ? covered : user.id;` → grava `covered_user_id: coveredId`. **`isMaster` decide o destinatário de uma escrita.** Se a lente rebaixasse esse booleano via um `useEffectiveAccess` genérico que alguém migrasse "porque parecia UI", a cobertura seria gravada no usuário errado. Money-path silencioso.
- **`src/pages/AdminStandardProcessDetail.tsx:52,93,105`**: `isMaster` habilita editar/publicar/arquivar (ações mutantes).
- **`src/components/RequireFinanceiroAccess.tsx`**: `isStaff` é **bypass de permissão**; e pra não-staff ele busca `getMinhaPermissao()` — a permissão **do master**. Rebaixar ingenuamente faria a lente liberar/barrar com base no master, não no alvo.
- **`src/components/AppShell.tsx`**: `isStaff/isMaster` **misturam** "filtrar menu" com "habilitar query de badge".

Conclusão do codex: **hook separado é o menor risco.** Interceptar o `AuthProvider` economizaria trabalho nos 86 consumidores de `useAuth`, mas é o caminho mais provável de quebrar money-path, auditoria e payloads de escrita.

## 5. Arquitetura

### 5.1 `useDisplayAccess()` — a única coisa que a lente altera

Novo hook `src/hooks/useDisplayAccess.ts`. Combina o real (`useAuth`) com o perfil **real** do alvo (`useImpersonatedAccessProfile`, que chama `get_user_access_profile_for`).

- **Sem lente** → devolve o real, 1:1.
- **Com lente** → deriva do perfil do alvo:
  - `displayRole = profile.appRole`
  - `displayIsStaff = appRole ∈ {employee, master}`
  - `displayIsMaster = appRole === 'master'`
  - `displayIsGestorComercial = commercialRole ∈ {gerencial, estrategico, super_admin}`
  - `displayIsSalesOnly = profile.isSalesOnly`
  - `displayCommercialRole`, `displayDepartment` (pra persona/cards)
- **Nomes `display*` de propósito** (sem colidir com `isMaster` real) — o nome grita "exibição", então ninguém usa pra decidir escrita por engano.
- **Loading**: enquanto o perfil do alvo carrega, a lente mostra estado de carregamento (não pisca o menu do master). Erro ao carregar o perfil → não entra na lente (degradação honesta) + toast.

**`useAuth()` permanece intocado**: sessão, `user.id`, escrita, auditoria, analytics, permissões reais — tudo continua sendo o master. **A lente nunca toca identidade nem escrita.**

### 5.2 Bloqueio de escrita durante a lente (D5)

Sem isto, "read-only" é mentira: o servidor ainda autoriza o master, então um clique em "Salvar" grava de verdade.

- Módulo `src/lib/impersonation/lens-write-guard.ts`: flag global `isLensActive()` (setada pelo `ImpersonationProvider`), e um **proxy do supabase client** que, quando a lente está ativa, **rejeita** `.insert/.update/.upsert/.delete`, `storage.upload/remove` e `.rpc()` **fora de uma allowlist de RPCs de leitura** (o app lê muito via RPC SECURITY DEFINER — ex. `get_minha_positivacao`, `get_user_access_profile_for`).
- Erro amigável ("Ação indisponível na lente — saia da lente pra editar"), não exceção crua.
- Defesa em profundidade: os controles de escrita já tendem a sumir pela camada de display (botões gated por `displayIsMaster` etc.), mas o guard fecha o que escapar.

### 5.3 Banner honesto (não mentir)

Banner global fixo (estende o atual do `ImpersonationBanner.tsx`), texto preciso:

> **Lente de navegação/leitura como [Fulana].** Escritas bloqueadas. RLS e permissões do banco continuam sendo do master (ator real: [você]). · **Sair**

Mostra ator real, alvo, role/empresa/departamento do alvo. Opcional: link "pra testar RLS real, use login real".

### 5.4 Entrada e fusão (D3, D4)

- O `PersonaSwitcherChip` deixa de oferecer **troca manual de papel**. Vira **"Ver como: [pessoa]"** listando pessoas reais (via `list_impersonation_targets`, já existente). Selecionar = `startImpersonation`.
- A inferência automática de persona (`usePersona`) **continua** e passa a ler `useDisplayAccess` → dentro da lente, os cards reordenam pela persona do **alvo**.
- O card "Ver como" do `/meu-dia` é absorvido por essa entrada (uma superfície só).

## 6. Faseamento

**Fase 0 — Guardrails primeiro (CI).** Antes de migrar qualquer callsite:
- ESLint `no-restricted-imports`: `useDisplayAccess` proibido em `src/services/**`, hooks de mutação e arquivos com escrita Supabase.
- Teste AST (vitest): arquivo que importa `useDisplayAccess` **não pode** conter `.insert(/.update(/.upsert(/.delete(/.rpc(` fora de allowlist read-only.
- Teste AST: `effectiveUserId` nunca em payload de escrita (estende o `no-write-leak` atual).
- `useDisplayAccess` nasce com **allowlist de importadores** pequena (Fase 1): `AppShell`, `Require*`, `usePersona`, módulo central de rotas.

**Fase 1 — Menu + rotas + persona (via allowlist).**
- `AppShell` lê `displayIsStaff/displayIsMaster/displayIsGestorComercial/displayIsSalesOnly` pra filtrar seções/itens. **Os badges numéricos do menu são suprimidos na lente** (não mostrar contagem do master no menu do alvo).
- `RequireStaff` lê display. `RequireFinanceiroAccess` **na lente decide pelo perfil do alvo** (`displayIsSalesOnly`/`displayRole`) e **não** chama `getMinhaPermissao()` (que é do master).
- Banner global + bloqueio de escrita (5.2) ativos.

**Fase 1.5 — Auditoria obrigatória.** Classificar **todos** os ~24+31+10 callsites de `isMaster/isStaff/isGestorComercial` em: `display` / `read-enabled` / `write-identity`. Só os dois primeiros são elegíveis pra Fase 2. Saída: tabela versionada no anexo deste spec.

**Fase 2 — Telas, incremental.** Só telas que o alvo **acessa** e cujo callsite é `display` ou `read-enabled`. Uma a uma, com teste. `write-identity` fica **sempre** em `useAuth` real (ex.: `CoveragePanel`, `AdminStandardProcessDetail` — **não migrar**).

## 7. Furos conhecidos da Fase 1 (codex) e mitigações

| Furo | Mitigação |
|------|-----------|
| Deep-link em rota self-gated por componente (não `RequireStaff`) | Fase 1.5 mapeia rotas self-gated; tratar caso a caso na Fase 2 |
| Telas abertas a cliente+staff que mudam por dentro (home, perfil, ferramentas, pedidos, telefonia) | Entram na auditoria 1.5; migrar só o callsite de display |
| Componente compartilhado entre tela barrada e acessível | Auditoria marca o componente; preferir prop explícita a hook global |
| Redirect por `useEffect` (tela monta e dispara query antes de navegar) | Guard de rota deve barrar **antes** do render do conteúdo (Outlet), não via effect tardio |
| `RequireFinanceiroAccess` consultar permissão do master na lente | Na lente, decidir pelo perfil do alvo; não chamar `getMinhaPermissao` |
| `AppShell` badges = dado do master no menu do alvo | Suprimir badges na lente |

## 8. Aposentadoria do `PersonaSwitcherChip` manual

- Remover a troca manual de papel (e o "Geral"/"Master" da lista). Manter `inferPersona` + `DashboardPersonaContext` (inferência automática) — agora alimentados por `useDisplayAccess`.
- Bug cosmético oportunista: `SOURCE_LABEL` em `PersonaSwitcherChip.tsx` não tem a chave `'department'` → mostraria "· undefined". Corrigir ou tornar irrelevante ao remover o chip.

## 9. Telemetria

Eventos `track()`: `lente.iniciada` (grupo do alvo), `lente.encerrada`, `lente.escrita_bloqueada` (quando o guard barra algo — sinaliza tela com gate de escrita mal classificado), `lente.rota_barrada` (alvo sem acesso).

## 10. Testes

- **Unit** `useDisplayAccess`: sem lente = real 1:1; com lente = derivação correta por cada perfil (sales-only, employee, gestor, master).
- **AST/CI** (Fase 0): regras acima.
- **Guard de escrita**: mutação bloqueada na lente; RPC de leitura allowlistada passa; fora da lente tudo normal.
- **Guards de rota**: alvo sales-only barrado de `/financeiro`, `/admin/reposicao/*`; Financeiro decide pelo alvo, não pelo master.
- **Regressão**: sem lente, menu/rotas/telas idênticos a hoje (snapshot dos itens visíveis pro master).

## 11. Riscos e mitigações

- **Vazamento da lente pra escrita** → hook renomeado + ESLint/AST + guard de escrita + auditoria 1.5 (defesa em camadas).
- **Falsa sensação de segurança** → banner honesto + bloqueio de escrita real.
- **Escopo da Fase 2 maior que o previsto** → a auditoria 1.5 dá o número antes de migrar; Fase 1 já entrega o grosso (menu + rotas) e é independente.
- **`get_user_access_profile_for` não cobre algum sinal** (ex.: department) → confirmar retorno na Fase 1; se faltar, estender a RPC (master-only, já existe).

## 12. Esforço estimado (ordem de grandeza)

- Fase 0 (CI guardrails): pequeno.
- Fase 1 (hook + menu + 2 guards + banner + entrada/aposentadoria + bloqueio de escrita): médio.
- Fase 1.5 (auditoria): pequeno-médio (levantamento).
- Fase 2 (telas): variável — **dimensionado pela auditoria**; provavelmente uma dúzia de arquivos, não as ~50 brutas (as gerenciais caem por rota na Fase 1).

Entregável incremental: **Fase 0+1+1.5 já dão valor real** (ver menu/rotas do outro + base segura). Fase 2 entra depois, telas priorizadas pelas que as Farmers usam.

## 13. Anexo — callsites a classificar na Fase 1.5

(A preencher na Fase 1.5.) Já conhecidos como **`write-identity` (não migrar)**: `CoveragePanel.tsx`, `AdminStandardProcessDetail.tsx`. Já conhecido como **bypass de permissão**: `RequireFinanceiroAccess.tsx` (tratamento especial). Demais `isMaster/isStaff/isGestorComercial` em telas operacionais: classificar.
