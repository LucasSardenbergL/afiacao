# Lente "Ver como pessoa" — Fase 2 (telas internas) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans pra implementar task-by-task. Steps usam checkbox (`- [ ]`).

**Goal:** Na lente, as telas internas que o alvo alcança refletem o acesso/role do ALVO (não do master) — começando pelo `/meu-dia` — e os CTAs de escrita dos dashboards mostrados na lente ficam visivelmente read-only.

**Architecture:** Tornar `useMyCommercialRole` lente-aware (na lente retorna o `commercial_role` do ALVO via `useImpersonatedAccessProfile` — RPC master-only já buscada; fora da lente, a query real). Isso **cascateia** pros 2 únicos consumidores, ambos display (`CommercialDashboard` em `/meu-dia` + `FarmerCalls` `isHunter`). Depois, desabilitar (`disabled={isImpersonating}`) os CTAs de escrita ainda não-gated nos cards mostrados na lente (o write-guard da Fase 1 já BLOQUEIA a mutação; isto é honestidade visual). Gating write-identity (route-gates `if (!isStaff)`, mutations com `user.id`, governance) **fica em `useAuth` real**.

**Tech Stack:** React 18 + TS strict + `@tanstack/react-query` + vitest. Sem migration, sem edge function (tudo client-side). Assenta sobre a Fase 1 (PR #653).

> ⚠️ **Sequenciamento:** este plano depende da Fase 1 (`useDisplayAccess`, `useImpersonatedAccessProfile`, write-guard — PR #653). **Executar só após o #653 mergear** (ou rebasar sobre ele). Antes de começar: `git fetch && git rebase origin/main` e confirmar que `src/hooks/useImpersonatedAccessProfile.ts` existe.

---

## File Structure

- `src/hooks/useMyCommercialRole.ts` (modify) — passa a ser lente-aware. Responsabilidade: role comercial V2 do "eu efetivo" (master real, ou alvo na lente). Read-only.
- `src/hooks/__tests__/useMyCommercialRole.test.tsx` (create) — cobre sem-lente / na-lente / loading.
- `src/components/fila/AcaoOutcomeMenu.tsx` (modify) — desabilita os triggers de outcome (tarefa/mixgap) na lente.
- `src/components/call/OutcomeMenu.tsx` (modify) — desabilita o trigger de outcome de rota na lente (cobre o branch 'rota' do AcaoOutcomeMenu **e** a página `/rota/ligacoes`).
- `src/components/fila/__tests__/AcaoOutcomeMenu.test.tsx` (create) — trigger disabled na lente.
- `src/components/call/CallDialerView.tsx` (modify) — desabilita os botões "Ligar" na lente.
- `src/components/call/WebRTCDialer.tsx` (modify) — barra `onMakeCall` na FONTE com `isLensActive()` (WebRTC fura o write-guard).

`CommercialDashboard.tsx` e `FarmerCalls.tsx` **NÃO mudam** — herdam o comportamento via `useMyCommercialRole`.

---

## Task 1: `useMyCommercialRole` lente-aware (núcleo — cascateia pro /meu-dia + FarmerCalls)

**Files:**
- Modify: `src/hooks/useMyCommercialRole.ts`
- Test: `src/hooks/__tests__/useMyCommercialRole.test.tsx`

- [ ] **Step 1: Escreve o teste falhando**

Create `src/hooks/__tests__/useMyCommercialRole.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMyCommercialRole } from '@/hooks/useMyCommercialRole';

const authMock = vi.fn();
const impMock = vi.fn();
const profileMock = vi.fn();
const maybeSingleMock = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authMock() }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/hooks/useImpersonatedAccessProfile', () => ({ useImpersonatedAccessProfile: () => profileMock() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => maybeSingleMock() }) }) }) },
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockReturnValue({ user: { id: 'master-1' } });
  impMock.mockReturnValue({ isImpersonating: false });
  profileMock.mockReturnValue({ data: null, isLoading: false });
  maybeSingleMock.mockResolvedValue({ data: { commercial_role: 'master' } });
});

describe('useMyCommercialRole', () => {
  it('sem lente: retorna o role real consultado', async () => {
    const { result } = renderHook(() => useMyCommercialRole(), { wrapper });
    await waitFor(() => expect(result.current.data).toBe('master'));
  });

  it('na lente: retorna o commercial_role do ALVO sem consultar o do master', async () => {
    impMock.mockReturnValue({ isImpersonating: true });
    profileMock.mockReturnValue({ data: { commercialRole: 'farmer' }, isLoading: false });
    const { result } = renderHook(() => useMyCommercialRole(), { wrapper });
    expect(result.current.data).toBe('farmer');
    expect(maybeSingleMock).not.toHaveBeenCalled(); // realQuery disabled na lente
  });

  it('na lente, perfil do alvo carregando: isLoading=true', () => {
    impMock.mockReturnValue({ isImpersonating: true });
    profileMock.mockReturnValue({ data: null, isLoading: true });
    const { result } = renderHook(() => useMyCommercialRole(), { wrapper });
    expect(result.current.isLoading).toBe(true);
  });
});
```

- [ ] **Step 2: Roda o teste pra ver falhar**

Run: `heavy bun run test src/hooks/__tests__/useMyCommercialRole.test.tsx`
Expected: FAIL — o teste "na lente" pega o role do master (ou o shape `{data,isLoading}` não bate).

- [ ] **Step 3: Implementa o hook lente-aware**

Replace `src/hooks/useMyCommercialRole.ts` inteiro por:

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useImpersonatedAccessProfile } from '@/hooks/useImpersonatedAccessProfile';

/**
 * Role comercial do "eu efetivo": o user real, ou o ALVO na lente "Ver como".
 * Os 4 novos (farmer/hunter/closer/master) convivem com os legados.
 * Read-only + display-only (escolhe dashboard em /meu-dia; isHunter em FarmerCalls).
 */
export type MyCommercialRole =
  | 'farmer'
  | 'hunter'
  | 'closer'
  | 'master'
  | 'operacional'
  | 'gerencial'
  | 'estrategico'
  | 'super_admin'
  | null;

export function useMyCommercialRole(): { data: MyCommercialRole; isLoading: boolean } {
  const { user } = useAuth();
  const { isImpersonating } = useImpersonation();
  const { data: targetProfile, isLoading: profileLoading } = useImpersonatedAccessProfile();

  // Sem lente: consulta o role do master. Na lente, `enabled:false` evita consultar
  // o role do master (que renderizaria o dashboard ERRADO — o do master).
  const realQuery = useQuery({
    queryKey: ['my-commercial-role', user?.id],
    enabled: !!user && !isImpersonating,
    staleTime: 60_000,
    queryFn: async (): Promise<MyCommercialRole> => {
      if (!user) return null;
      const { data } = await supabase.from('commercial_roles')
        .select('commercial_role')
        .eq('user_id', user.id)
        .maybeSingle();
      return (data?.commercial_role ?? null) as MyCommercialRole;
    },
  });

  // Na lente: role do ALVO. Vem do RPC master-only get_user_access_profile_for, que o
  // useImpersonatedAccessProfile já buscou — sem query nova, sem depender de RLS de
  // commercial_roles cross-user. É o mesmo perfil que alimenta o useDisplayAccess.
  if (isImpersonating) {
    return {
      data: (targetProfile?.commercialRole ?? null) as MyCommercialRole,
      isLoading: profileLoading,
    };
  }
  return { data: realQuery.data ?? null, isLoading: realQuery.isLoading };
}
```

> Nota: o retorno foi normalizado pra `{ data, isLoading }` (os 2 consumidores — `CommercialDashboard`, `FarmerCalls` — só usam esses campos). Mantém a mesma desestruturação.

- [ ] **Step 4: Roda o teste pra ver passar**

Run: `heavy bun run test src/hooks/__tests__/useMyCommercialRole.test.tsx`
Expected: PASS (3 testes).

- [ ] **Step 5: typecheck (o contrato do retorno mudou)**

Run: `heavy bun run typecheck`
Expected: limpo. Se algum consumidor usava `.error`/`.refetch` de `useMyCommercialRole`, o tsc acusa — só `CommercialDashboard`/`FarmerCalls` consomem e usam só `data`/`isLoading` (verificado).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useMyCommercialRole.ts src/hooks/__tests__/useMyCommercialRole.test.tsx
git commit -m "feat(lente): useMyCommercialRole reflete o alvo na lente (/meu-dia + FarmerCalls)"
```

---

## Task 2: Desabilitar CTAs de escrita dos outcomes na lente (honestidade visual)

> O write-guard JÁ bloqueia essas mutações na lente (`registrar_contato_rota`, `mark_mixgap_feedback`, `concluir_com_comprovacao` são RPC mutante / passam pelo client guarded). Esta task é UX: greyar os botões em vez de deixá-los falhar silenciosamente. Padrão idêntico ao de `MinhasTarefasCard`/`MixGapCard` (já fazem isso).

**Files:**
- Modify: `src/components/fila/AcaoOutcomeMenu.tsx`
- Modify: `src/components/call/OutcomeMenu.tsx`
- Test: `src/components/fila/__tests__/AcaoOutcomeMenu.test.tsx`

- [ ] **Step 1: Escreve o teste falhando (trigger disabled na lente)**

Create `src/components/fila/__tests__/AcaoOutcomeMenu.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AcaoOutcomeMenu } from '@/components/fila/AcaoOutcomeMenu';
import type { AcaoSugerida } from '@/lib/fila/types';

const impMock = vi.fn();
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/hooks/useTarefas', () => ({ useTarefaMutations: () => ({ concluir: vi.fn() }) }));
vi.mock('@/hooks/useMarkMixGapFeedback', () => ({ useMarkMixGapFeedback: () => ({ mutate: vi.fn() }) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

const acaoTarefa = {
  fonte: 'tarefa', dedupeKey: 'k1', clienteNome: 'Cliente X',
  payload: { kind: 'tarefa', tarefaId: 't1' },
} as unknown as AcaoSugerida;

beforeEach(() => { vi.clearAllMocks(); });

describe('AcaoOutcomeMenu — guard de lente', () => {
  it('na lente: o trigger de opções fica disabled', () => {
    impMock.mockReturnValue({ isImpersonating: true });
    render(<AcaoOutcomeMenu acao={acaoTarefa} onNaoUtilAgora={vi.fn()} />);
    expect(screen.getByTitle(/Ver como/i)).toBeDisabled();
  });

  it('fora da lente: o trigger de opções fica habilitado', () => {
    impMock.mockReturnValue({ isImpersonating: false });
    render(<AcaoOutcomeMenu acao={acaoTarefa} onNaoUtilAgora={vi.fn()} />);
    expect(screen.getByTitle('Opções')).not.toBeDisabled();
  });
});
```

- [ ] **Step 2: Roda pra ver falhar**

Run: `heavy bun run test src/components/fila/__tests__/AcaoOutcomeMenu.test.tsx`
Expected: FAIL (não existe título "Ver como"; o trigger não está disabled).

- [ ] **Step 3: Gate em `AcaoOutcomeMenu.tsx`**

Add o import (junto dos outros imports no topo):

```ts
import { useImpersonation } from '@/contexts/ImpersonationContext';
```

Logo no início da função, junto das outras linhas de hook (`const tarefas = ...; const markGap = ...;`):

```ts
  const { isImpersonating } = useImpersonation();
```

No trigger Button do branch `tarefa` (hoje `<Button variant="ghost" size="icon" className="h-8 w-8" title="Opções">`), trocar por:

```tsx
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={isImpersonating}
            title={isImpersonating ? 'Indisponível em modo Ver como' : 'Opções'}
          >
            <MoreHorizontal className="w-4 h-4" />
          </Button>
```

No trigger Button do branch `mixgap` (idêntico, mais abaixo), aplicar a MESMA troca (mesmo `disabled`/`title`).

> O branch `rota` delega ao `<OutcomeMenu>`, gateado na Step 5 abaixo. O `'whatsapp'` retorna `null`.

- [ ] **Step 4: Roda pra ver passar**

Run: `heavy bun run test src/components/fila/__tests__/AcaoOutcomeMenu.test.tsx`
Expected: PASS (2 testes).

- [ ] **Step 5: Gate em `OutcomeMenu.tsx` (branch rota + /rota/ligacoes)**

Add o import no topo:

```ts
import { useImpersonation } from '@/contexts/ImpersonationContext';
```

Dentro de `OutcomeMenu(...)`, junto dos hooks existentes (`const reg = ...; const undo = ...;`):

```ts
  const { isImpersonating } = useImpersonation();
```

No trigger Button (hoje `<Button variant="ghost" size="icon" className="h-8 w-8" title="Registrar resultado" disabled={reg.isPending}>`), trocar por:

```tsx
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title={isImpersonating ? 'Indisponível em modo Ver como' : 'Registrar resultado'}
          disabled={reg.isPending || isImpersonating}
        >
```

- [ ] **Step 6: typecheck + lint + commit**

```bash
heavy bun run typecheck && bun lint
git add src/components/fila/AcaoOutcomeMenu.tsx src/components/call/OutcomeMenu.tsx src/components/fila/__tests__/AcaoOutcomeMenu.test.tsx
git commit -m "feat(lente): CTAs de outcome (fila/rota/mixgap) viram read-only na lente"
```

---

## Task 3: Bloquear o Dialer / "Nova ligação" na lente (fura o write-guard)

> O Dialer hoje é **WebRTC-only** (`Dialer.tsx` → `WebRTCDialer`; JsSIP/WebSocket — NÃO passa pelo Supabase), então o write-guard do client **NÃO o cobre**. Na lente, "Ligar" colocaria uma ligação REAL pro cliente como o master. Gate duplo: desabilita o botão (UX) **+** barra na FONTE com `isLensActive()` (backstop, mesmo padrão do `DispararAgoraButton` / F3 da Fase 1). O `onMakeCall` único do WebRTCDialer é o ponto onde a chamada de fato inicia.

**Files:**
- Modify: `src/components/call/CallDialerView.tsx`
- Modify: `src/components/call/WebRTCDialer.tsx`

- [ ] **Step 1: Gate visual no `CallDialerView.tsx`**

Add o import (junto dos outros no topo):

```ts
import { useImpersonation } from '@/contexts/ImpersonationContext';
```

No início do componente (junto do `const [dismissed, ...]` e demais hooks):

```ts
  const { isImpersonating } = useImpersonation();
```

No botão **compacto** (hoje `disabled={!hasValidPhone}` + `title={hasValidPhone ? ... : 'Telefone inválido'}`), trocar essas 2 linhas por:

```tsx
        disabled={!hasValidPhone || isImpersonating}
        title={isImpersonating ? 'Ligação indisponível em modo Ver como' : (hasValidPhone ? `Ligar para ${displayPhone}` : 'Telefone inválido')}
```

No botão **full** (hoje só `disabled={!hasValidPhone}`), trocar por:

```tsx
        disabled={!hasValidPhone || isImpersonating}
        title={isImpersonating ? 'Ligação indisponível em modo Ver como' : undefined}
```

- [ ] **Step 2: Gate na FONTE no `WebRTCDialer.tsx`**

Add o import (junto dos outros; `toast` já está importado):

```ts
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
```

No handler `onMakeCall` (hoje começa `if (!ctx) return;`), inserir a checagem ANTES do `if (busy && !owned)`:

```tsx
      onMakeCall={() => {
        if (!ctx) return;
        if (isLensActive()) {
          toast.error('Ligação indisponível na lente (somente leitura). Saia da lente para ligar.');
          return;
        }
        if (busy && !owned) {
          toast.info('Já existe uma chamada em andamento');
          return;
        }
        ctx.claimCall(id);
        void ctx.makeCall(props.phoneNumber);
      }}
```

- [ ] **Step 3: typecheck + lint**

Run: `heavy bun run typecheck && bun lint`
Expected: limpo.

- [ ] **Step 4: Commit**

```bash
git add src/components/call/CallDialerView.tsx src/components/call/WebRTCDialer.tsx
git commit -m "feat(lente): bloqueia o Dialer (WebRTC fura o write-guard) na lente"
```

> **Verificação:** sem teste unitário automático (montar o `WebRTCCallContext`/JsSIP em jsdom é caro; `CallDialerView` exige muitos props de estado de chamada). O `isLensActive()` da fonte já é coberto pelos testes de `lens-write-guard`. QA manual no Chrome: na lente de uma Farmer, abrir uma tela com o Dialer → botão "Ligar" **disabled**; se forçado, o guard barra com toast e NÃO inicia a chamada.

> ⚠️ **CORREÇÃO P1 do review final (commit `9b1288f5`):** o gate só no `WebRTCDialer.onMakeCall` (Steps 1-2) **era INCOMPLETO**. O review (opus) achou que `useCallBackend()` retorna WebRTC **incondicional** (a nota do CLAUDE.md sobre Nvoip default está stale) e que há **≥3 callsites** que iniciam ligação WebRTC SEM passar pelo `WebRTCDialer`: `AgendaTodayList` (no FarmerDashboardV2 → exposto no `/meu-dia` da Farmer pela própria Task 1!), `Telefonia` (`/telefonia`, sem gate algum) e `NewCallDialog`→`FarmerCalls`. **Fix:** guard na **FONTE** — `isLensActive()` no topo de `WebRTCCallContext.makeCall` (`:320`, a função única por onde `useWebRTCCall`/`useWebRTCCallContext` e portanto TODOS os callsites passam — `useWebRTCCall` é só `return useWebRTCCallContext()`) **+** `acceptIncoming` (`:447`, ligação ENTRANTE = P2). Isso torna os `disabled` dos Steps 1-2 cosméticos (UX) e fecha os 3 callsites + futuros. Verificado: não há SIP invite/call fora dessas 2 funções.

---

## Task 4: Validação final + suíte

- [ ] **Step 1: Suíte completa**

Run: `heavy bun run test > /tmp/fase2.log 2>&1; echo $?; tail -6 /tmp/fase2.log`
Expected: exit 0, tudo verde (≥ 2416 + os novos testes).

- [ ] **Step 2: typecheck + lint finais**

Run: `heavy bun run typecheck` (limpo) + `bun lint` (0 errors).

- [ ] **Step 3: Codex adversarial no diff (se disponível)**

`timeout 540 codex exec "<brief + git diff>" -C <repo> -s read-only < /dev/null > /tmp/codex.log 2>&1` — ⚠️ pendura neste ambiente; se time-out, fallback solo: confirmar que (a) `useMyCommercialRole` na lente não dispara a query do master (`enabled:false`), (b) nenhum consumidor de `useMyCommercialRole` usa o role pra ESCRITA (só `CommercialDashboard`/`FarmerCalls`, ambos display — verificado), (c) os gates são só `disabled` visual (write-guard é o backstop real).

---

## Self-Review (checklist do autor)

**Spec coverage** (escopo escolhido = núcleo + polish de CTAs + Dialer):
- ✅ `/meu-dia` reflete o alvo → Task 1 (cascateia via `useMyCommercialRole`).
- ✅ `FarmerCalls` `isHunter` reflete o alvo → Task 1 (mesmo hook).
- ✅ CTAs de escrita dos dashboards da lente viram read-only → Task 2 (`AcaoOutcomeMenu` + `OutcomeMenu`; os demais cards de visita são read-only — só `<Link>`/toggle local; `MinhasTarefasCard`/`MixGapCard`/`RecorrentesHojeCard` JÁ gateiam).
- ✅ Dialer / "Nova ligação" (WebRTC fura o write-guard) bloqueado na lente → Task 3 (botões `disabled` em CallDialerView/WebRTCDialer) **+ correção P1 do review:** guard na FONTE em `WebRTCCallContext.makeCall`+`acceptIncoming` (`isLensActive()`) — cobre TODOS os callsites WebRTC (AgendaTodayList/Telefonia/FarmerCalls), não só o WebRTCDialer.

**Placeholder scan:** sem TBD/TODO; todo step tem código exato.

**Type consistency:** `MyCommercialRole` inalterado; retorno normalizado `{ data, isLoading }` bate com os 2 consumidores; `targetProfile.commercialRole` é `string|null` (de `TargetAccessProfile`), cast pra `MyCommercialRole`.

---

## Riscos e follow-ups

- ✅ **Dialer / "Nova ligação" — agora é a Task 3** (investigado: WebRTC-only fura o write-guard; gate na fonte). Resolvido no escopo deste plano.
- **`/meu-dia` na lente assume que o master pode ler o perfil do alvo** — verdade (o RPC `get_user_access_profile_for` é master-only e já é a fonte). Se falhar, `useImpersonatedAccessProfile` erra → o banner já sai da lente com toast (F2 da Fase 1).
- **Outros `fetch` crus / canais que furam o write-guard:** a Fase 1 mapeou `DispararAgoraButton` (gateado na F3 — porém **APOSENTADO na main pelo #643**, que retirou a tela portal-sayerlack; o disparo é server-side agora, sem botão = sem vetor) e `useSuggestedMapping` (leitura, ok). A Task 3 fecha o Dialer (WebRTC). Se surgir nova ação com efeito externo fora do PostgREST/storage/`functions.invoke`/rpc, aplicar o mesmo `isLensActive()`.
- **Deploy:** Publish manual no Lovable (frontend não auto-deploya). Sem migration/edge.

---

## Execution Handoff

Plano salvo em `docs/superpowers/plans/2026-06-06-lente-fase-2-telas-internas.md`. Duas opções:

1. **Subagent-Driven (recomendado)** — subagente fresco por task + review entre tasks.
2. **Inline** — executo nesta sessão com checkpoints.

⚠️ Executar **após o PR #653 (Fase 1) mergear** (ou rebasar sobre ele).
