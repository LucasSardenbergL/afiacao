# Onda 1 / Fase 1 — Ponte + Co-piloto Flutuante (HUD global) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para implementar este plano task-a-task. Steps usam checkbox (`- [ ]`) pra tracking.

**Goal:** Quando há uma ligação WebRTC ativa, um co-piloto flutuante global acompanha a vendedora em qualquer tela (transcrição/SPIN que já existem), municia com contexto read-only do cliente, e leva pro `/sales/new` já com cliente + identidade de atendimento — gravando `origem` e `atendimento_id` no pedido **de forma congelada e à prova de troca de cliente**.

**Architecture:** Builds SOBRE a Fase 0 (idempotência em prod: `sales_orders.checkout_id/origem/atendimento_id` + `submitOrder({checkoutId, origem, atendimentoId})` + `allConfirmed`). O `WebRTCCallContext` passa a expor o cliente resolvido + a direção + um `currentAtendimentoId` (1 por ligação); um HUD montado no `AppShellLayout` consome isso e o `transcriptionTurns`/`spinAnalysis`; "Montar pedido" navega pro `/sales/new?customer=…&atendimento=…&origem=ligacao_…`; a metadata da ponte é **congelada no `CheckoutEnvelope` durável** (não lida ao vivo no submit) e só aplicada se a URL-customer == cliente selecionado.

**Tech Stack:** React 18 + TS strict · react-router-dom (`useSearchParams`/`useNavigate`) · Supabase (read-only + 1 migração aditiva) · `@/lib/analytics` (`track`) · Vitest (helpers puros) · reuso de `TranscriptionPanel`/`SpinSuggestionCard`.

> **Versão:** v2 — incorpora 1 passe adversário do Codex (gpt-5.5/xhigh, 2026-06-13): veredito inicial NÃO + 6 P1, todos confirmados no código e foldados aqui (ver §"Mudanças v1→v2 (Codex)"). Recomendado 1 passe de confirmação do Codex sobre a v2 antes de executar.

---

## 🔴 Dependência de gate (Codex) — LER ANTES DE EXECUTAR

Decisão eu+Codex: **planejar agora; rollout aprovado da Fase 0 = pré-condição de IMPLEMENTAÇÃO/DEPLOY.**

- **NÃO IMPLEMENTAR nem PUBLICAR antes de:** (1) **gate** confirmado (Omie de VENDA rejeita `codigo_pedido_integracao` duplicado — senão escala pra claim server-side); (2) **smoke** (reenviar mesmo checkout = sem 2º PV); (3) **`faultstring` real** capturada (ajusta `isOmieDuplicatePedido`).
- **A maior parte da Fase 1 é gate-independente** (contexto/HUD/munição). **EXCEÇÃO (Codex, Key Tension):** o **congelamento da metadata da ponte** (`origem`/`atendimento_id`) é **co-acoplado ao mecanismo de idempotência**. Hoje o `ensureSalesOrderRow` grava a metadata **só no INSERT**; o **REUSE não atualiza** ([idempotency.ts:60-66](src/services/orderSubmission/idempotency.ts)). A v2 congela a metadata no `CheckoutEnvelope` durável (versão "lean"). **Se o gate falhar e a Fase 0 escalar pra claim server-side, a metadata congelada migra pra dentro do claim** (o claim deve congelar `customer/origem/atendimento` atomicamente). Por isso a **Task 3 deve ser revisitada à luz do desenho final do claim** se houver escalação — não construir a Task 3 antes do gate.
- **DIFERIDO (pós-gate):** estados de UI de envio em-progresso/retry no HUD/bridge. O HUD só **navega**; o submit usa a UX existente do `/sales/new`.

---

## Recap do contrato da Fase 0 (o que JÁ existe — não reconstruir)

- **Migração `20260613120000` (em prod):** `sales_orders.checkout_id uuid` + `origem text` + `atendimento_id uuid` (nuláveis, **sem CHECK** em `origem`) · `UNIQUE(checkout_id, account) WHERE checkout_id IS NOT NULL` · `idx_sales_orders_origem`.
- **`submitOrder(params)`** (`submitOrder.ts:29`): `checkoutId` (obrigatório), `origem = null`, `atendimentoId = null` (`:34`); insere via `ensureSalesOrderRow(..., {checkoutId, account, origem, atendimentoId})` (`:108`, `:203`); retorna `allConfirmed` (`:475`). ⚠️ **`ensureSalesOrderRow` grava `origem`/`atendimento_id` SÓ no INSERT** — o REUSE (`idempotency.ts:60-66`) atualiza items/total/notes/endereço, **não** a metadata. → a metadata tem que ser **congelada e idêntica** entre contas/retries (v2 resolve isso no envelope).
- **`CheckoutEnvelope`** (`checkout-envelope.ts:1`) = `{ checkoutId, fingerprint, committed }`. **A v2 estende** com a metadata da ponte.
- **`useUnifiedOrder.submitOrder`** (`useUnifiedOrder.ts:651`): hoje passa `origem: web_staff/web_customer` + `atendimentoId: null` (`:721-722`); tem `useNavigate` (`:77`) **não** `useSearchParams`.
- **Contexto:** `currentParty`/`currentCustomerUserId`/`callDirection` **NÃO existem** (`callId: null` em `WebRTCCallContext.tsx:527`).

---

## Decisões de design (resolvidas — v2)

1. **Ciclo de vida do `atendimento_id`** — cunhado no contexto, **1 por ligação**, **só após as validações de início** (telefone/cliente SIP OK — não vazar id pra ligação inválida) e **limpo em toda falha de início** + no terminal. Sem tabela nova.
2. **Metadata da ponte CONGELADA no `CheckoutEnvelope`** (Codex P1-1/P1-2/Key Tension) — `customerUserId` + `origem` + `atendimentoId` entram no envelope durável, capturados **uma vez** na criação do envelope (1º submit do carrinho), e **só** se a URL-`customer` == cliente selecionado. Submit usa o envelope (**nunca** lê a URL ao vivo). Reuse mantém a metadata congelada → todas as contas/retries usam a MESMA. (Se escalar pra claim: migra pro claim.)
3. **Guard contra troca de cliente** (Codex P1-1) — o aviso (toast) NÃO é o mecanismo; o mecanismo é: a metadata da ponte só vale se `searchParams.customer === selectedCustomer.userId` na criação do envelope. Mismatch (entrante de B durante pedido de A) → `origem=web_staff`, `atendimento=null` (nunca a metadata errada).
4. **Guard de async-race por geração + start-mutex** (Codex P1-3) — `callGenerationRef` (resolução tardia de party só aplica se a geração ainda é a corrente) **+ um `startingCallRef`** que **rejeita makeCall/acceptIncoming concorrente** (sem ele, um `makeCall` stale ainda DISCA → SIP de A com identidade de B). `cleanupAudioResources` **não** mexe em party.
5. **Party inbound chaveada por `sipCallId`** (Codex P1-4) — `incomingPartyRef = { sipCallId, party }`; o lookup do ring é amarrado ao `sipCallId`; `acceptIncoming` usa a party do ref **se o `sipCallId` bater**, senão **re-resolve** (await) amarrado à geração do accept. Sem isso: accept antes do lookup → party=null pra sempre; ref compartilhado → caller A vaza pra B.
6. **`callDirection` no contexto** (Codex P1-6) — `'inbound'|'outbound'|null`; o HUD deriva `origem` (`ligacao_entrante`/`ligacao_sainte`) daí, em vez de hardcodar.
7. **HUD coexiste com o painel do `/farmer/calls`** — card flutuante compacto; **não tocar** `FarmerCalls.tsx` nesta fase; consolidar = Fase 3.
8. **Munição read-only honesta** (Codex P2) — só leitura barata, **filtrando pedido válido** (exclui `rascunho`/`orcamento`/`cancelado`/`cancelado_humano`); escopo = **dias desde a última + última compra + ticket médio**. **"Recompra provável" sai do escopo** (não implementada). Defasagem de preço = Fase 2.
9. **`origem` validado por allowlist + `atendimento` validado como UUID** (Codex P1-6) — `origem` ∈ `{ligacao_sainte, ligacao_entrante}` (senão fallback da role); `atendimento` rejeitado se não-UUID (money-path: não passar lixo da URL pro insert).
10. **Reverse-link `farmer_calls.atendimento_id` é BEST-EFFORT** (Codex P1-5) — escrito no `persistCallSession` existente (só roda no `endCall` com conteúdo). Remote-hangup / chamada curta sem transcrição → sem linha reversa. **O link primário é `sales_orders.atendimento_id` (confiável, gravado no submit).** Finalizador-terminal idempotente + constraint única = **follow-up de telefonia** (fora do escopo do bridge).

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/contexts/webrtc-call-context.ts` | Contrato — `currentParty`/`currentCustomerUserId`/`currentAtendimentoId`/`callDirection` | Modify |
| `src/contexts/WebRTCCallContext.tsx` | Provider — state/refs + set/clear + generation guard + start-mutex + party inbound por sipCallId + persist | Modify |
| `src/contexts/__tests__/WebRTCCallContext.test.tsx` | Testes (party reativo, guard de geração, start-mutex, inbound antes/depois do accept, clear no terminal/falha) | Modify |
| `supabase/migrations/2026XXXXXXXXXX_onda1_fase1_farmer_calls_atendimento.sql` | Reverse-link `farmer_calls.atendimento_id` (aditiva, manual) | Create |
| `src/lib/call-session/build-session-payload.ts` + `.test.ts` | Payload do `farmer_calls` — add `atendimento_id` | Modify |
| `src/services/orderSubmission/checkout-envelope.ts` + `.test.ts` | `CheckoutEnvelope` estendido com metadata da ponte congelada | Modify |
| `src/services/orderSubmission/origem.ts` + `.test.ts` | Helper puro — allowlist de `origem` + validação UUID do `atendimento` | Create |
| `src/hooks/useUnifiedOrder.ts` | Congela a metadata da ponte no envelope (URL-customer-match) + repassa ao submit | Modify |
| `src/hooks/useMunicaoLigacao.ts` + `src/lib/call/municao.ts` (+ `.test.ts`) | Munição read-only (pedido válido) | Create |
| `src/components/call/CallCopilotHud.tsx` | HUD flutuante global (origem por `callDirection`, currency inline) | Create |
| `src/components/AppShellLayout.tsx` | Monta o HUD | Modify |

---

## Task 1 — Contexto: cliente + direção + identidade de atendimento (geração + start-mutex + inbound por sipCallId)

**Files:**
- Modify: `src/contexts/webrtc-call-context.ts`
- Modify: `src/contexts/WebRTCCallContext.tsx`
- Test: `src/contexts/__tests__/WebRTCCallContext.test.tsx`

**Contexto pro implementador:** Contrato no módulo LEVE (`webrtc-call-context.ts`, type-only imports — guardrail `webrtc-context-split.test.ts`). `resolveCallParty(phone): Promise<ResolvedCallParty>` (`recording-policy.ts:24`). Hoje: `makeCall` (`:282`) valida telefone (`:291`) + clientRef (`:298`), depois `await resolveCallParty` (`:306`); `acceptIncoming` (`:425`) NÃO resolve party; ring listener resolve em `:163` **depois** do `logCallStart` (`:153`); terminal effect (`:217-232`); `cleanupAudioResources` (`:260`) é chamado no INÍCIO do makeCall (`:329`) — **não** limpar party lá; `value` (`:525`).

- [ ] **Step 1: Testes falhando (reusar helpers existentes do arquivo; não criar harness novo)**

Adicionar ao `WebRTCCallContext.test.tsx`:

```tsx
describe('currentParty / atendimento / direção (Fase 1)', () => {
  it('makeCall expõe party + customerUserId + atendimento (uuid) + direção outbound', async () => {
    mockResolveCallParty.mockResolvedValue({ kind: 'cliente', customerUserId: 'cust-1', matchConfidence: 'last8', phoneNormalized: '5531999999999' });
    const { result } = renderWebRTCProvider();
    await act(async () => { await result.current.makeCall('31999999999'); });
    expect(result.current.currentCustomerUserId).toBe('cust-1');
    expect(result.current.currentParty?.kind).toBe('cliente');
    expect(result.current.currentAtendimentoId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.current.callDirection).toBe('outbound');
  });

  it('NÃO cunha atendimento quando o telefone é inválido (guard antes do mint)', async () => {
    const { result } = renderWebRTCProvider();
    await act(async () => { await result.current.makeCall('123'); }); // inválido
    expect(result.current.currentAtendimentoId).toBeNull();
    expect(result.current.callDirection).toBeNull();
  });

  it('start-mutex: rejeita makeCall concorrente (sem dialar 2×)', async () => {
    let resolveA!: (p: ResolvedCallParty) => void;
    mockResolveCallParty.mockImplementationOnce(() => new Promise((r) => { resolveA = r; }));
    const { result } = renderWebRTCProvider();
    act(() => { void result.current.makeCall('31111111111'); }); // A em andamento (resolve pendente)
    await act(async () => { await result.current.makeCall('31222222222'); }); // B rejeitado pelo mutex
    await act(async () => { resolveA({ kind: 'cliente', customerUserId: 'cust-A', matchConfidence: 'last8', phoneNormalized: '...' }); });
    expect(mockSipMakeCall).toHaveBeenCalledTimes(1); // só A discou
  });

  it('inbound: accept ANTES do lookup do ring re-resolve e seta party (não fica null)', async () => {
    // ring sem party pronta; accept dispara re-resolve
    mockResolveCallParty.mockResolvedValue({ kind: 'cliente', customerUserId: 'cust-IN', matchConfidence: 'last8', phoneNormalized: '...' });
    const { result } = renderWebRTCProvider();
    act(() => { emitIncoming({ sipCallId: 'sip-1', phone: '31999999999', displayName: null }); });
    await act(async () => { await result.current.acceptIncoming(); });
    expect(result.current.currentCustomerUserId).toBe('cust-IN');
    expect(result.current.callDirection).toBe('inbound');
  });

  it('limpa party/atendimento/direção no terminal', async () => {
    mockResolveCallParty.mockResolvedValue({ kind: 'cliente', customerUserId: 'cust-1', matchConfidence: 'last8', phoneNormalized: '...' });
    const { result } = renderWebRTCProvider();
    await act(async () => { await result.current.makeCall('31999999999'); });
    act(() => { emitSipState('ended'); });
    expect(result.current.currentCustomerUserId).toBeNull();
    expect(result.current.currentAtendimentoId).toBeNull();
    expect(result.current.callDirection).toBeNull();
  });
});
```

> Ajustar `mockSipMakeCall`/`emitIncoming`/`emitSipState`/`renderWebRTCProvider` aos helpers que JÁ existem no arquivo (ele testa o ciclo de chamada). Se algum não existir, derivar do mock de `SipClient` já presente.

- [ ] **Step 2: Roda e confirma a falha**

Run: `heavy bun run test src/contexts/__tests__/WebRTCCallContext.test.tsx`

- [ ] **Step 3: Contrato (módulo leve)**

`src/contexts/webrtc-call-context.ts` — import type + campos na interface:

```ts
import type { ResolvedCallParty } from '@/lib/call-log/recording-policy';
```
```ts
  /** Cliente resolvido da ligação ATIVA (guardado por geração; resolução tardia descartada). */
  currentParty: ResolvedCallParty | null;
  currentCustomerUserId: string | null;
  /** Identidade do ATENDIMENTO (1 por ligação). Liga ligação ↔ N pedidos. */
  currentAtendimentoId: string | null;
  /** Direção da ligação ativa — define a origem do pedido (entrante/sainte). */
  callDirection: 'inbound' | 'outbound' | null;
```

> `import type` (apagado na compilação) — confirmar que o guardrail `webrtc-context-split.test.ts` segue verde.

- [ ] **Step 4: Provider — state/refs**

`WebRTCCallContext.tsx` (~`:97`):

```tsx
  const [currentParty, setCurrentParty] = useState<ResolvedCallParty | null>(null);
  const [currentAtendimentoId, setCurrentAtendimentoId] = useState<string | null>(null);
  const [callDirection, setCallDirection] = useState<'inbound' | 'outbound' | null>(null);
  const callGenerationRef = useRef(0);                          // guard de async-race
  const startingCallRef = useRef(false);                        // start-mutex (anti-concorrência)
  const atendimentoIdRef = useRef<string | null>(null);         // snapshot pro persist
  const incomingPartyRef = useRef<{ sipCallId: string; party: ResolvedCallParty } | null>(null);
```
+ `import type { ResolvedCallParty } from '@/lib/call-log/recording-policy';`

- [ ] **Step 5: makeCall — start-mutex + mint pós-validação + gen guard + direção**

Em `makeCall` (`:282`):
- Logo após o guard de lente (`:283-286`): `if (startingCallRef.current) { toast.error('Já há uma chamada sendo iniciada.'); return; } startingCallRef.current = true;`
- ⚠️ **Liberar o mutex em TODOS os caminhos de saída** (telefone inválido `:293-295`, sem clientRef `:299-300`, sucesso após `clientRef.current.makeCall`, catch `:354-358`): `startingCallRef.current = false;` (usar `try/finally` ao redor do corpo a partir da validação, OU setar `false` em cada `return`/catch — preferir `try { ... } finally { startingCallRef.current = false; }`).
- **Cunhar atendimento SÓ depois** das validações (após `:301`, antes do `await resolveCallParty`):

```tsx
    const gen = ++callGenerationRef.current;
    const atendimentoId = crypto.randomUUID();
    atendimentoIdRef.current = atendimentoId;
    setCurrentAtendimentoId(atendimentoId);
    setCallDirection('outbound');
```
- Após `const party = await resolveCallParty(phoneNumber);` (`:306`):

```tsx
    if (callGenerationRef.current === gen) setCurrentParty(party);
```

- [ ] **Step 6: ring listener — party chaveada por sipCallId**

No listener de ring, após `const party = await resolveCallParty(info.phone);` (`:163`):

```tsx
          incomingPartyRef.current = { sipCallId: info.sipCallId, party };
```

- [ ] **Step 7: acceptIncoming — mint + direção + party por sipCallId (re-resolve se preciso)**

Em `acceptIncoming` (`:425`), após o guard de lente e o `if (!incomingCall ...) return;` (`:430`):

```tsx
    const gen = ++callGenerationRef.current;
    const atendimentoId = crypto.randomUUID();
    atendimentoIdRef.current = atendimentoId;
    setCurrentAtendimentoId(atendimentoId);
    setCallDirection('inbound');
    const sipId = incomingCall.sipCallId;
    const ringParty = incomingPartyRef.current?.sipCallId === sipId ? incomingPartyRef.current.party : null;
    if (ringParty) {
      setCurrentParty(ringParty);
    } else {
      // accept antes do lookup do ring → re-resolve amarrado à geração do accept
      void resolveCallParty(incomingCall.phone).then((p) => {
        if (callGenerationRef.current === gen) setCurrentParty(p);
      });
    }
```

- [ ] **Step 8: clear no terminal + reset do mutex/ref**

No efeito terminal (`:217-232`), após `cleanupAudioResources()` (`:223`):

```tsx
    callGenerationRef.current += 1; // invalida resoluções de party em voo
    startingCallRef.current = false;
    setCurrentParty(null);
    setCurrentAtendimentoId(null);
    setCallDirection(null);
    atendimentoIdRef.current = null;
    incomingPartyRef.current = null;
```
E em `rejectIncoming` (`:477`): `incomingPartyRef.current = null;`

- [ ] **Step 9: value**

`value` (`:525`):

```tsx
    currentParty,
    currentCustomerUserId: currentParty?.customerUserId ?? null,
    currentAtendimentoId,
    callDirection,
```

- [ ] **Step 10: Testes + guardrail + typecheck**

Run: `heavy bun run test src/contexts/__tests__/WebRTCCallContext.test.tsx src/contexts/__tests__/webrtc-context-split.test.ts && heavy bun run typecheck`
Expected: PASS (todos os novos casos + split verde + sem erro de tipo).

- [ ] **Step 11: Commit**

```bash
git add src/contexts/webrtc-call-context.ts src/contexts/WebRTCCallContext.tsx src/contexts/__tests__/WebRTCCallContext.test.tsx
git commit -m "feat(onda1/fase1): contexto da ligação (party/atendimento/direção + geração + start-mutex + inbound por sipCallId)"
```

---

## Task 2 — Reverse-link best-effort: `farmer_calls.atendimento_id`

**Files:** Create migration · Modify `build-session-payload.ts` (+ test) · Modify `WebRTCCallContext.tsx` (snapshot + persist).

**Contexto:** `persistCallSession` (`:46`) roda **só no `endCall`** e **só** com `wasRecording && (turns||analyses)` (`:388`). Reverse-link é **best-effort** (Codex P1-5): remote-hangup/curta sem transcrição não gera linha. O link primário (`sales_orders.atendimento_id`) é confiável. **Não** refatorar a persistência pra finalizador-terminal nesta fase (follow-up de telefonia).

- [ ] **Step 1: Migração** — `supabase/migrations/<ts>_onda1_fase1_farmer_calls_atendimento.sql` (ts = `date +%Y%m%d%H%M%S`):

```sql
-- Onda 1 / Fase 1 — reverse-link ligação ↔ pedidos (best-effort).
-- atendimento_id: o MESMO uuid de sales_orders.atendimento_id (cunhado no contexto).
-- Aditiva, nuável — aplicar via SQL Editor do Lovable.
ALTER TABLE public.farmer_calls
  ADD COLUMN IF NOT EXISTS atendimento_id uuid;

CREATE INDEX IF NOT EXISTS idx_farmer_calls_atendimento_id
  ON public.farmer_calls (atendimento_id) WHERE atendimento_id IS NOT NULL;

SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
     AND table_name='farmer_calls' AND column_name='atendimento_id') AS coluna_1, -- 1
  (SELECT count(*) FROM pg_indexes WHERE indexname='idx_farmer_calls_atendimento_id') AS idx_1; -- 1
```

- [ ] **Step 2: Teste do payload (falhando)** — em `build-session-payload.test.ts`:

```ts
it('inclui atendimento_id quando fornecido (e null quando ausente)', () => {
  const base = { farmerId:'f1', customerUserId:'c1', phoneDialed:'5531999999999',
    callBackend:'webrtc' as const, startedAt:new Date('2026-06-13T10:00:00Z'),
    endedAt:new Date('2026-06-13T10:05:00Z'), turns:[], analyses:[] };
  expect(buildSessionPayload({ ...base, atendimentoId:'atend-1' }).atendimento_id).toBe('atend-1');
  expect(buildSessionPayload(base).atendimento_id).toBeNull();
});
```

- [ ] **Step 3: Roda e confirma a falha** — `heavy bun run test src/lib/call-session/build-session-payload.test.ts`

- [ ] **Step 4: Helper** — `build-session-payload.ts`: `BuildSessionPayloadInput` += `atendimentoId?: string | null;`; `SessionPayload` += `atendimento_id: string | null;`; no return += `atendimento_id: input.atendimentoId ?? null,`.

- [ ] **Step 5: Roda e confirma que passa** — `heavy bun run test src/lib/call-session/build-session-payload.test.ts`

- [ ] **Step 6: Snapshot + persist** — `WebRTCCallContext.tsx`: no bloco de snapshots do `endCall` (`:365-369`) add `const atendimentoIdSnapshot = atendimentoIdRef.current;`; na chamada `persistCallSession({...})` (`:388`) passar `atendimentoId: atendimentoIdSnapshot`; `persistCallSession` (`:46`) += `atendimentoId: string | null;` no opts → repassa a `buildSessionPayload`.

> `insert(payload as any)` (`:71`) já existe; não tocar o `types.ts` à mão (Lovable regenera). Comentar no código: reverse-link best-effort (não cobre remote-hangup/sem-conteúdo).

- [ ] **Step 7: Typecheck + commit** — `heavy bun run typecheck`

```bash
git add supabase/migrations/2026*onda1_fase1_farmer_calls_atendimento.sql src/lib/call-session/build-session-payload.ts src/lib/call-session/build-session-payload.test.ts src/contexts/WebRTCCallContext.tsx
git commit -m "feat(onda1/fase1): farmer_calls.atendimento_id (reverse-link best-effort)"
```

> **PR:** "ATENÇÃO: migração manual" + bloco SQL inline.

---

## Task 3 — Bridge: metadata congelada no envelope (URL-customer-match + UUID)

**Files:** Modify `checkout-envelope.ts` (+ test) · Create `origem.ts` (+ test) · Modify `useUnifiedOrder.ts`.

**Contexto (Codex P1-1/P1-2/Key Tension):** o submit hoje passa `origem/atendimentoId` lidos **ao vivo** da URL → pedido de A pode receber `atendimento` de B (entrante), e contas/retries podem divergir (reuse não atualiza metadata). **Fix:** congelar `{customerUserId, origem, atendimentoId}` no `CheckoutEnvelope` durável, **uma vez** na criação, **só se** a URL-`customer` == cliente selecionado; o submit lê do envelope.

- [ ] **Step 1: Testes do helper de origem + UUID (falhando)** — `src/services/orderSubmission/origem.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveOrigemFromUrl, sanitizeAtendimentoId, ORIGEM_LIGACAO } from './origem';

describe('resolveOrigemFromUrl', () => {
  it('aceita ligação da allowlist; ignora desconhecido', () => {
    expect(resolveOrigemFromUrl('ligacao_sainte', false)).toBe('ligacao_sainte');
    expect(resolveOrigemFromUrl('ligacao_entrante', false)).toBe('ligacao_entrante');
    expect(resolveOrigemFromUrl('x', false)).toBe('web_staff');
    expect(resolveOrigemFromUrl(null, true)).toBe('web_customer');
  });
  it('customer nunca herda ligação da URL', () => {
    expect(resolveOrigemFromUrl('ligacao_sainte', true)).toBe('web_customer');
  });
});
describe('sanitizeAtendimentoId', () => {
  it('aceita só UUID; rejeita lixo', () => {
    expect(sanitizeAtendimentoId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(sanitizeAtendimentoId('drop table')).toBeNull();
    expect(sanitizeAtendimentoId(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Roda e confirma a falha** — `heavy bun run test src/services/orderSubmission/origem.test.ts`

- [ ] **Step 3: Helper** — `src/services/orderSubmission/origem.ts`:

```ts
export const ORIGEM_LIGACAO = ['ligacao_sainte', 'ligacao_entrante'] as const;
export type OrigemLigacao = (typeof ORIGEM_LIGACAO)[number];

/** Origem do pedido a partir da URL (sem CHECK no banco → validar aqui).
 *  Ligação é staff-only: customer SEMPRE 'web_customer'. Desconhecido → default da role. */
export function resolveOrigemFromUrl(raw: string | null, isCustomerMode: boolean): string {
  if (isCustomerMode) return 'web_customer';
  if (raw && (ORIGEM_LIGACAO as readonly string[]).includes(raw)) return raw;
  return 'web_staff';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Aceita só UUID (money-path: não passar lixo da URL pro insert). */
export function sanitizeAtendimentoId(raw: string | null): string | null {
  return raw && UUID_RE.test(raw) ? raw : null;
}
```

- [ ] **Step 4: Roda e confirma que passa** — `heavy bun run test src/services/orderSubmission/origem.test.ts`

- [ ] **Step 5: Estende o envelope (+ teste)** — `checkout-envelope.ts`:

```ts
export interface CheckoutEnvelope {
  checkoutId: string; fingerprint: string; committed: boolean;
  // Metadata da ponte CONGELADA na criação (Fase 1): nunca lida ao vivo no submit.
  customerUserId?: string | null; origem?: string | null; atendimentoId?: string | null;
}
```

> `decideCheckoutEnvelope` não muda (decide por fingerprint/committed). Adicionar teste garantindo que `reuse` preserva a metadata congelada e que a criação aceita os campos.

- [ ] **Step 6: Congela no `useUnifiedOrder`** — em `useUnifiedOrder.ts`:
- Imports: `useSearchParams` (de react-router) + `resolveOrigemFromUrl, sanitizeAtendimentoId` (de `@/services/orderSubmission/origem`).
- Após `const navigate = useNavigate();` (`:77`): `const [searchParams] = useSearchParams();`
- No submit (`:679-685`), na criação do envelope (decision `'new'`), capturar a metadata congelada **com guard de match**:

```tsx
    if (decision === 'new') {
      const urlCustomer = searchParams.get('customer');
      const matches = !!urlCustomer && selectedCustomer?.user_id === urlCustomer; // ⚠️ confirmar o campo (user_id/customer_user_id)
      checkoutEnvRef.current = {
        checkoutId: crypto.randomUUID(), fingerprint, committed: true,
        customerUserId: selectedCustomer?.user_id ?? null,
        origem: matches ? resolveOrigemFromUrl(searchParams.get('origem'), isCustomerMode) : (isCustomerMode ? 'web_customer' : 'web_staff'),
        atendimentoId: matches ? sanitizeAtendimentoId(searchParams.get('atendimento')) : null,
      };
    } else { // reuse: mantém a metadata CONGELADA
      checkoutEnvRef.current = { ...checkoutEnvRef.current!, committed: true } as CheckoutEnvelope;
    }
```
- E na chamada `submitOrderService({...})` (`:719-722`), trocar pra ler do envelope:

```tsx
        origem: checkoutEnvRef.current.origem ?? (isCustomerMode ? 'web_customer' : 'web_staff'),
        atendimentoId: checkoutEnvRef.current.atendimentoId ?? null,
```

> ⚠️ Confirmar o nome do campo do user_id em `selectedCustomer` (no `useUnifiedOrder` há `customerUserId` derivado — usar a fonte certa; `searchParams.get('customer')` é um `user_id`). O guard `matches` é o anti-troca-de-cliente (Codex P1-1).

- [ ] **Step 7: Typecheck + testes + commit**

Run: `heavy bun run typecheck && heavy bun run test src/services/orderSubmission/origem.test.ts src/services/orderSubmission/checkout-envelope.test.ts`

```bash
git add src/services/orderSubmission/origem.ts src/services/orderSubmission/origem.test.ts src/services/orderSubmission/checkout-envelope.ts src/services/orderSubmission/checkout-envelope.test.ts src/hooks/useUnifiedOrder.ts
git commit -m "feat(onda1/fase1): congela metadata da ponte no envelope (URL-customer-match + UUID; anti-troca-de-cliente)"
```

---

## Task 4 — Munição read-only (pedido válido)

**Files:** Create `src/lib/call/municao.ts` (+ test) · Create `src/hooks/useMunicaoLigacao.ts`.

**Contexto:** Read-only (spec §4.3). **NUNCA** `selectCustomer`/`useProductCatalog`. Filtrar **pedido válido** (Codex P2): excluir `rascunho`/`orcamento`/`cancelado`/`cancelado_humano`. Escopo: dias desde a última + última compra + ticket. (Push/pull dup tem o mesmo valor → não enviesa última/ticket.)

- [ ] **Step 1: Teste do helper (falhando)** — `src/lib/call/municao.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { derivarMunicao } from './municao';
const hoje = new Date('2026-06-13T12:00:00Z');
describe('derivarMunicao', () => {
  it('dias desde a última + última + ticket', () => {
    const r = derivarMunicao({ pedidos: [{ data:'2026-06-01', valor:1200 }, { data:'2026-05-01', valor:800 }], agora: hoje });
    expect(r.diasDesdeUltima).toBe(12);
    expect(r.ultimaCompra).toEqual({ data:'2026-06-01', valor:1200 });
    expect(r.ticketMedio).toBe(1000);
  });
  it('sem histórico → null honesto', () => {
    const r = derivarMunicao({ pedidos: [], agora: hoje });
    expect(r).toEqual({ diasDesdeUltima:null, ultimaCompra:null, ticketMedio:null });
  });
  it('ignora datas futuras', () => {
    const r = derivarMunicao({ pedidos: [{ data:'2026-07-01', valor:999 }, { data:'2026-06-10', valor:500 }], agora: hoje });
    expect(r.ultimaCompra?.data).toBe('2026-06-10'); expect(r.diasDesdeUltima).toBe(3);
  });
});
```

- [ ] **Step 2: Roda e confirma a falha** — `heavy bun run test src/lib/call/municao.test.ts`

- [ ] **Step 3: Helper** — `src/lib/call/municao.ts`:

```ts
export interface MunicaoPedido { data: string; valor: number; }
export interface MunicaoInput { pedidos: MunicaoPedido[]; agora: Date; }
export interface Municao { diasDesdeUltima: number | null; ultimaCompra: MunicaoPedido | null; ticketMedio: number | null; }

/** Munição read-only. Ignora datas futuras (order_date_kpi pode vir adiantado). Sem histórico → null. */
export function derivarMunicao({ pedidos, agora }: MunicaoInput): Municao {
  const hojeMs = agora.getTime();
  const validos = pedidos
    .filter((p) => { const t = new Date(p.data).getTime(); return Number.isFinite(t) && t <= hojeMs; })
    .sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime());
  if (validos.length === 0) return { diasDesdeUltima: null, ultimaCompra: null, ticketMedio: null };
  const ultima = validos[0];
  return {
    diasDesdeUltima: Math.floor((hojeMs - new Date(ultima.data).getTime()) / 86_400_000),
    ultimaCompra: ultima,
    ticketMedio: Math.round(validos.reduce((s, p) => s + p.valor, 0) / validos.length),
  };
}
```

- [ ] **Step 4: Roda e confirma que passa** — `heavy bun run test src/lib/call/municao.test.ts`

- [ ] **Step 5: Hook read-only** — `src/hooks/useMunicaoLigacao.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { derivarMunicao, type Municao } from '@/lib/call/municao';

const STATUS_INVALIDOS = ['rascunho', 'orcamento', 'cancelado', 'cancelado_humano'];

/** Munição READ-ONLY (NÃO seleciona cliente nem monta catálogo — efeitos no Omie). */
export function useMunicaoLigacao(customerUserId: string | null): { municao: Municao | null; loading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['municao-ligacao', customerUserId],
    enabled: !!customerUserId,
    staleTime: 60_000,
    queryFn: async (): Promise<Municao> => {
      const { data: pedidos, error } = await supabase
        .from('sales_orders')
        .select('order_date_kpi, created_at, total, status')
        .eq('customer_user_id', customerUserId!)
        .is('deleted_at', null)
        .not('status', 'in', `(${STATUS_INVALIDOS.map((s) => `"${s}"`).join(',')})`)
        .order('created_at', { ascending: false })
        .limit(8);
      if (error) throw error;
      return derivarMunicao({
        pedidos: (pedidos ?? []).map((p) => ({
          data: (p.order_date_kpi as string | null) ?? (p.created_at as string),
          valor: Number(p.total ?? 0),
        })),
        agora: new Date(),
      });
    },
  });
  return { municao: data ?? null, loading: isLoading };
}
```

> `sales_orders.total` + `order_date_kpi` existem (confirmado no `types.ts`). Confirmar a sintaxe do `.not('status','in', ...)` no supabase-js do projeto (alternativa: `.or('status.is.null,...')` se necessário).

- [ ] **Step 6: Typecheck + testes + commit**

Run: `heavy bun run typecheck && heavy bun run test src/lib/call/municao.test.ts`

```bash
git add src/lib/call/municao.ts src/lib/call/municao.test.ts src/hooks/useMunicaoLigacao.ts
git commit -m "feat(onda1/fase1): munição read-only (pedido válido; última/ticket/dias)"
```

---

## Task 5 — HUD co-piloto flutuante global

**Files:** Create `src/components/call/CallCopilotHud.tsx` · Modify `src/components/AppShellLayout.tsx`.

**Contexto:** Global, montado no `AppShellLayout` (`:55-66`). `useWebRTCCallContextOptional()` (null-safe). Mostra em `callState==='established'`. Reusa `SpinSuggestionCard` (`{status, analysis, error}`) + abre `TranscriptionPanel` por toggle. Origem do pedido = **`callDirection`** (Codex P1-6, sem hardcode). ⚠️ **`@/lib/format` NÃO exporta `formatCurrency`** (Codex P2) → usar `toLocaleString` inline.

- [ ] **Step 1: Componente** — `src/components/call/CallCopilotHud.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingCart, MessageSquareText, Mic, MicOff, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track } from '@/lib/analytics';
import { useWebRTCCallContextOptional } from '@/contexts/webrtc-call-context';
import { useMunicaoLigacao } from '@/hooks/useMunicaoLigacao';
import { SpinSuggestionCard } from './SpinSuggestionCard';
import { TranscriptionPanel } from './TranscriptionPanel';
import { formatBrPhone } from '@/lib/phone';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Co-piloto flutuante GLOBAL durante a ligação. Persiste na navegação; leva pro pedido
 *  com origem (por direção) + atendimento_id. Coexiste com o painel do /farmer/calls (Fase 3 consolida). */
export function CallCopilotHud() {
  const ctx = useWebRTCCallContextOptional();
  const navigate = useNavigate();
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const { municao } = useMunicaoLigacao(ctx?.currentCustomerUserId ?? null);

  if (!ctx || ctx.callState !== 'established') return null;

  const customerId = ctx.currentCustomerUserId;
  const partyName = ctx.currentParty?.contactName ?? null;
  const origem = ctx.callDirection === 'inbound' ? 'ligacao_entrante' : 'ligacao_sainte';

  const montarPedido = () => {
    if (!customerId) { track('ligacao.montar_pedido', { tem_cliente: false }); navigate('/sales/new'); return; }
    const params = new URLSearchParams({ customer: customerId, origem });
    if (ctx.currentAtendimentoId) params.set('atendimento', ctx.currentAtendimentoId);
    track('ligacao.montar_pedido', { tem_cliente: true, origem });
    navigate(`/sales/new?${params.toString()}`);
  };

  return (
    <>
      <div className="fixed bottom-4 left-4 z-40 w-[320px] rounded-lg border border-border bg-card shadow-lg">
        <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-status-success animate-pulse shrink-0" />
            <span className="text-sm font-medium truncate">
              {partyName ?? (ctx.currentParty?.phoneNormalized ? formatBrPhone(ctx.currentParty.phoneNormalized) : 'Em ligação')}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={ctx.toggleMute} title={ctx.isMuted ? 'Reativar mic' : 'Mutar'}>
              {ctx.isMuted ? <MicOff className="w-4 h-4 text-status-error" /> : <Mic className="w-4 h-4" />}
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void ctx.endCall()} title="Encerrar">
              <PhoneOff className="w-4 h-4 text-status-error" />
            </Button>
          </div>
        </header>

        {municao && (
          <div className="px-3 py-2 border-b border-border text-xs text-muted-foreground space-y-0.5">
            {municao.ultimaCompra ? (
              <div>Última compra: <span className="text-foreground font-medium">{brl(municao.ultimaCompra.valor)}</span>
                {municao.diasDesdeUltima != null && <> · há {municao.diasDesdeUltima}d</>}</div>
            ) : <div>Sem compras anteriores registradas.</div>}
            {municao.ticketMedio != null && <div>Ticket médio: {brl(municao.ticketMedio)}</div>}
          </div>
        )}

        <div className="max-h-[40vh] overflow-y-auto">
          <SpinSuggestionCard status={ctx.spinAnalysisStatus} analysis={ctx.spinAnalysis} error={ctx.spinAnalysisError} />
        </div>

        <footer className="flex items-center gap-2 p-2 border-t border-border">
          <Button size="sm" variant="outline" className="flex-1 gap-1.5"
            onClick={() => setTranscriptOpen((v) => { if (!v) track('ligacao.transcricao_aberta'); return !v; })}>
            <MessageSquareText className="w-3.5 h-3.5" /> Transcrição
          </Button>
          <Button size="sm" className="flex-1 gap-1.5" onClick={montarPedido}>
            <ShoppingCart className="w-3.5 h-3.5" /> Montar pedido
          </Button>
        </footer>
      </div>

      <TranscriptionPanel status={ctx.transcriptionStatus} turns={ctx.transcriptionTurns} error={ctx.transcriptionError}
        open={transcriptOpen} onClose={() => setTranscriptOpen(false)}
        spinStatus={ctx.spinAnalysisStatus} spinAnalysis={ctx.spinAnalysis} spinError={ctx.spinAnalysisError} />
    </>
  );
}
```

> Confirmar `formatBrPhone` em `@/lib/phone` (existe). Currency = `brl` inline (não há `formatCurrency` em `@/lib/format`).

- [ ] **Step 2: Monta no AppShellLayout** — `src/components/AppShellLayout.tsx`: import `CallCopilotHud` + após `<TransferSpikePanel />` (`:63`):

```tsx
      {/* Onda 1 / Fase 1: co-piloto flutuante global durante a ligação */}
      <CallCopilotHud />
```

- [ ] **Step 3: Typecheck + split guardrail + build (checar tamanho do bundle)**

Run: `heavy bun run typecheck && heavy bun run test src/contexts/__tests__/webrtc-context-split.test.ts && heavy bun build`
Expected: PASS. ⚠️ Conferir no output do build que o **entry/main chunk NÃO cresceu** com jssip (o HUD importa só o módulo leve + componentes leves — Codex P2: o guardrail checa imports, não a composição do chunk; olhar os tamanhos).

- [ ] **Step 4: Commit**

```bash
git add src/components/call/CallCopilotHud.tsx src/components/AppShellLayout.tsx
git commit -m "feat(onda1/fase1): HUD co-piloto flutuante global + bridge Montar pedido (origem por direção)"
```

---

## Mudanças v1→v2 (Codex, 2026-06-13)

| Achado Codex | Severidade | Resolução na v2 |
|---|---|---|
| Metadata lida ao vivo no submit → pedido de A pega atendimento de B; reuse não atualiza; contas divergem | P1×3 + Key Tension | **Congelada no `CheckoutEnvelope`** + URL-customer-match (Task 3). Co-acoplada ao mecanismo de idempotência (migra pro claim se escalar). |
| makeCall stale ainda DISCA (gen guard só cobre setParty) | P1 | **start-mutex** `startingCallRef` (Task 1). |
| Inbound racy: accept antes do lookup → party null; ref compartilhado vaza A→B | P1 | **party por `sipCallId`** + re-resolve no accept (Task 1). |
| HUD hardcoda `ligacao_sainte` | P1 | **`callDirection` no contexto** → origem derivada (Tasks 1+5). |
| Reverse-link só no endCall com conteúdo (remote-hangup não grava) | P1 | **Documentado best-effort** + follow-up (finalizador-terminal idempotente). Link primário = `sales_orders.atendimento_id`. |
| `atendimento` da URL aceito malformado (money-path) | P1 | **`sanitizeAtendimentoId` (UUID)** (Task 3). |
| Atendimento cunhado antes da validação (vaza em ligação inválida) | P2 | **Mint pós-validação** + clear em falha (Task 1). |
| Munição inclui rascunho/cancelado; "recompra provável" não-implementada | P2 | **Filtro de pedido válido** + escopo honesto (Task 4). |
| `formatCurrency` não existe em `@/lib/format` | P2 | **`toLocaleString` inline** (Task 5). |
| Staff pode forjar origem via URL | P2 | **Aceito** (campo de analytics, não fronteira de segurança) — documentado. |

---

## Self-Review

**Cobertura (spec §7.2/§7.3/§10):** ✅ currentParty/customerUserId/atendimento/direção (T1) · ✅ reverse-link (T2, best-effort) · ✅ bridge congelado (T3) · ✅ munição read-only (T4) · ✅ HUD global (T5) · grava origem/atendimento (T3). **Diferido:** defasagem (Fase 2), submit-em-progresso no HUD (pós-gate), consolidação /farmer/calls (Fase 3), finalizador-terminal de farmer_calls (follow-up telefonia).

**Riscos a confirmar na execução (não chutar):** campo `user_id` vs `customer_user_id` em `selectedCustomer` (T3); sintaxe `.not('status','in',...)` no supabase-js (T4); helpers de teste existentes no `WebRTCCallContext.test.tsx` (T1); `formatBrPhone`/`@/lib/phone` (T5); guardrail do split verde após T1/T5.

---

## Execution Handoff

Plano salvo em `docs/superpowers/plans/2026-06-13-jornada-comercial-onda1-fase1-ponte-hud.md` (v2).

🔴 **Pré-condição:** rollout da Fase 0 (gate+smoke+faultstring). **A Task 3 depende do desenho final do mecanismo de idempotência** (lean vs claim) — não construir antes do gate. Recomendado: 1 passe de confirmação do Codex sobre a v2.

Quando liberado: **(1) Subagent-Driven (recomendado)** — Tasks 1/3 = **opus** (ciclo da ligação + money-path da metadata), Tasks 2/4/5 = **sonnet**. **(2) Inline** via executing-plans.
