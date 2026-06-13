# Onda 1 / Fase 1 — Ponte + Co-piloto Flutuante (HUD global) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para implementar este plano task-a-task. Steps usam checkbox (`- [ ]`) pra tracking.

**Goal:** Quando há uma ligação WebRTC ativa, um co-piloto flutuante global acompanha a vendedora em qualquer tela (transcrição/SPIN que já existem), municia com contexto read-only do cliente, e leva pro `/sales/new` já com cliente + identidade de atendimento — gravando `origem` e `atendimento_id` no pedido.

**Architecture:** Builds SOBRE a Fase 0 (idempotência já em prod: colunas `sales_orders.checkout_id/origem/atendimento_id` + `submitOrder({checkoutId, origem, atendimentoId})` + `allConfirmed`). Fase 1 = **só plumbing de contexto + UI + leitura** — zero mudança no mecanismo de idempotência. O `WebRTCCallContext` passa a expor o cliente resolvido da ligação (`currentParty`/`currentCustomerUserId`) + um `currentAtendimentoId` cunhado por ligação; um HUD montado no `AppShellLayout` consome isso e o `transcriptionTurns`/`spinAnalysis` do contexto; "Montar pedido" navega pro `/sales/new?customer=…&atendimento=…&origem=ligacao_…`; o `useUnifiedOrder` lê esses params e os repassa ao `submitOrder` (contrato já pronto). Reverse-link `farmer_calls.atendimento_id` fecha o laço ligação↔pedidos.

**Tech Stack:** React 18 + TS strict · react-router-dom (`useSearchParams`/`useNavigate`) · Supabase (read-only RPC/queries + 1 migração aditiva) · `@/lib/analytics` (`track`) · Vitest (helpers puros) · reuso de `TranscriptionPanel`/`SpinSuggestionCard`.

---

## 🔴 Dependência de gate (Codex) — LER ANTES DE EXECUTAR

Decisão eu+Codex (2026-06-13): **escrever o plano da Fase 1 agora; tratar o rollout aprovado da Fase 0 como pré-condição de IMPLEMENTAÇÃO/DEPLOY, não de planejamento.** Concretamente:

- **PODE planejar/revisar** este plano agora (é o que este doc é).
- **NÃO IMPLEMENTAR nem PUBLICAR a Fase 1 antes de:** (1) o **gate** da Fase 0 confirmado (o Omie de VENDA rejeita `codigo_pedido_integracao` duplicado — se NÃO rejeitar, a Fase 0 escala pra claim server-side antes); (2) o **smoke** da Fase 0 (reenviar mesmo checkout = sem 2º PV; reconciliação OK); (3) a **`faultstring` real** capturada (ajusta o detector `isOmieDuplicatePedido` se a frase diferir).
- **Por que é seguro planejar agora:** a Fase 1 NÃO depende do mecanismo de idempotência por baixo. O bridge só **navega + passa `origem`/`atendimento_id`** (contrato já existente no `submitOrder`). `currentParty`/HUD/munição são independentes. Se o gate falhar e a Fase 0 escalar pra claim, a interface do `submitOrder` que a Fase 1 usa **não muda** (o claim é encapsulado dentro do submit).
- **DIFERIDO (decisão pendente pós-gate):** qualquer **estado de UI de envio em-progresso/retry** no HUD/bridge (ex.: "enviando…", TTL de claim, "claim ocupado"). Hoje o HUD só **navega** pro `/sales/new`; o submit acontece lá, com a UX de envio EXISTENTE da página. **Não adicionar** estados de submit ao HUD nesta fase. Se a Fase 0 escalar pra claim, revisitar se o bridge precisa surfacar um estado "claim ocupado" — registrar como follow-up, não construir às cegas.

> **Recomendação de processo:** como na Fase 0, rodar **1 passe adversário do Codex sobre este plano** (gpt-5.5/xhigh) antes da execução — foco no ciclo de vida do `currentAtendimentoId`, no guard de geração (async-race) e na política de entrante. (Codex pode estar em usage-limit; se estiver, "Caminho B" = auto-revisão adversária + validar com os testes.)

---

## Recap do contrato da Fase 0 (o que JÁ existe — não reconstruir)

- **Migração `20260613120000` (em prod):** `sales_orders.checkout_id uuid` + `origem text` + `atendimento_id uuid` (todas nuláveis, **sem CHECK** em `origem`) · `UNIQUE(checkout_id, account) WHERE checkout_id IS NOT NULL` · `idx_sales_orders_origem`.
- **`submitOrder(params: SubmitOrderParams)`** (`src/services/orderSubmission/submitOrder.ts:29`): aceita `checkoutId` (obrigatório), `origem = null`, `atendimentoId = null` (`:34`); ambos os blocos de insert chamam `ensureSalesOrderRow(..., {checkoutId, account, origem, atendimentoId})` (`:108`, `:203`); retorna `allConfirmed` (`:475`).
- **`useUnifiedOrder.submitOrder`** (`src/hooks/useUnifiedOrder.ts:651`): computa o envelope de checkout durável (fingerprint) e hoje passa `origem: isCustomerMode ? 'web_customer' : 'web_staff'` + `atendimentoId: null` (`:721-722`); reseta o envelope só em `allConfirmed` (`:727-730`).
- **Contexto:** `currentParty`/`currentCustomerUserId` **NÃO existem** ainda (`value` em `webrtc-call-context.ts:26-73`; `callId: null` em `WebRTCCallContext.tsx:527`). **Esta fase adiciona.**

---

## Decisões de design (resolvidas neste plano)

1. **Ciclo de vida do `atendimento_id`** — cunhado no **contexto da ligação** (`crypto.randomUUID()`), **1 por ligação**, estável durante a chamada. Sem tabela `atendimentos` nova (YAGNI). O HUD passa via URL; o `submitOrder` grava em `sales_orders.atendimento_id` (contrato já pronto); o reverse-link grava em **`farmer_calls.atendimento_id`** (1 coluna nova, Task 2) → "quais pedidos vieram desta ligação" = `sales_orders WHERE atendimento_id = farmer_calls.atendimento_id`. N pedidos multi-conta do mesmo checkout compartilham o `atendimento_id`.
2. **Guard de async-race (geração da chamada)** — `resolveCallParty` é assíncrono (lookup no banco). Um `callGenerationRef` é incrementado no início de `makeCall`/`acceptIncoming` e no terminal; a resolução captura a geração e **só aplica `currentParty` se a geração ainda for a atual** (descarta resultado de uma ligação que já terminou/foi substituída). O `atendimento_id` é cunhado **antes** do await (síncrono), então independe da resolução.
3. **HUD coexiste com o painel do `/farmer/calls`** — o HUD é um **card flutuante compacto** (chamador + duração + mute/encerrar + 1 linha de SPIN + munição + CTA "Montar pedido" + toggle "Ver transcrição" que abre o `TranscriptionPanel` EXISTENTE). O `/farmer/calls` mantém seu painel inline próprio (`FarmerCalls.tsx:496`) — **não tocar nesta fase**. O valor único do HUD é **persistir na navegação** + o **bridge "Montar pedido"** (o painel do `/farmer/calls` some quando ela sai da tela). Sobreposição leve no `/farmer/calls` é aceitável; consolidar é a Fase 3 (palco). Toggle de transcrição do HUD começa **fechado**.
4. **Política de entrante durante pedido sujo** (P2 do spec §18) — uma ligação entrante só **atualiza o estado do contexto** (o HUD reflete a ligação ativa). O pedido aberto no `/sales/new` é **independente** (estado próprio + URL congelada). Sem auto-clobber: o guard de preselect existente (`UnifiedOrder.tsx:103`, `!h.selectedCustomer`) já impede a troca silenciosa de cliente. Quando "Montar pedido" é clicado e há um carrinho **sujo de OUTRO cliente**, mostramos um **aviso honesto** (toast) — não destrói o pedido em andamento. Multi-pedido por abas = futuro.
5. **Escopo da munição na Fase 1 = só leitura barata** — gancho (dias desde a última compra) + última compra (data/valor) + recompra provável (se houver sinal barato). **`defasagem` de preço é DIFERIDA pra Fase 2** (depende do cockpit/CMC RPC, que é Fase 2). **Sem** `selectCustomer`/`useProductCatalog` no mount (mandato read-only do spec §4.3/§7.3).
6. **`origem` validado por allowlist no client** (não há CHECK no banco) — `useUnifiedOrder` só aceita da URL valores ∈ `{ligacao_sainte, ligacao_entrante}`; desconhecido → fallback pro default (`web_staff`/`web_customer`). Bloqueia `origem` injetado via URL.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/contexts/webrtc-call-context.ts` | Contrato (type) do contexto — add `currentParty`/`currentCustomerUserId`/`currentAtendimentoId` | Modify |
| `src/contexts/WebRTCCallContext.tsx` | Provider — state/refs + set em makeCall/acceptIncoming/ring + clear no terminal + generation guard + atendimento no persist | Modify |
| `src/contexts/__tests__/WebRTCCallContext.test.tsx` | Testes do contexto (party reativo, guard de geração, clear no terminal) | Modify |
| `supabase/migrations/2026XXXXXXXXXX_onda1_fase1_farmer_calls_atendimento.sql` | Reverse-link `farmer_calls.atendimento_id` (aditiva, manual) | Create |
| `src/lib/call-session/build-session-payload.ts` | Payload do `farmer_calls` — add `atendimento_id` | Modify |
| `src/lib/call-session/build-session-payload.test.ts` | Cobre o novo campo | Modify |
| `src/services/orderSubmission/origem.ts` | Helper puro — allowlist/validação de `origem` da URL | Create |
| `src/services/orderSubmission/origem.test.ts` | Testes do helper | Create |
| `src/hooks/useUnifiedOrder.ts` | Lê `?atendimento`/`?origem` (useSearchParams), repassa ao submit | Modify |
| `src/hooks/useMunicaoLigacao.ts` | Hook read-only de munição (leituras baratas, sem efeito colateral) | Create |
| `src/lib/call/municao.ts` | Helper puro — deriva gancho/recompra a partir das leituras | Create |
| `src/lib/call/municao.test.ts` | Testes do helper | Create |
| `src/components/call/CallCopilotHud.tsx` | HUD flutuante global (consome contexto, CTA bridge, telemetria) | Create |
| `src/components/AppShellLayout.tsx` | Monta o HUD junto dos overlays globais | Modify |
| `src/pages/UnifiedOrder.tsx` | Aviso de entrante (carrinho sujo de outro cliente) | Modify |

---

## Task 1 — Contexto: expõe o cliente da ligação + identidade de atendimento (com guard de geração)

**Files:**
- Modify: `src/contexts/webrtc-call-context.ts` (interface `WebRTCCallContextValue`)
- Modify: `src/contexts/WebRTCCallContext.tsx` (state/refs + makeCall + acceptIncoming + ring listener + terminal clear + value)
- Test: `src/contexts/__tests__/WebRTCCallContext.test.tsx`

**Contexto pro implementador:** O `WebRTCCallProvider` é o provider pesado (importa jssip). O contrato vive no módulo LEVE `webrtc-call-context.ts` (type-only imports → ~zero bytes; **não** importar o `.tsx` fora do `ConditionalWebRTCProvider` — guardrail de CI `webrtc-context-split.test.ts`). `resolveCallParty(phone): Promise<ResolvedCallParty>` (`src/lib/call-log/recording-policy.ts:24`) retorna `{ kind, customerUserId, contactName?, contactCargo?, matchConfidence, phoneNormalized }`. Hoje: `makeCall` (`:282`) faz `await resolveCallParty(phoneNumber)` em `:306` (inline, antes de conectar); `acceptIncoming` (`:425`) NÃO resolve party; o listener de ring (`:148-167`) resolve party em `:163` só pra enriquecer o `call_log`. `cleanupAudioResources` (`:260`) é chamado no INÍCIO de makeCall (`:329`) — então **NÃO** limpar `currentParty` lá. O efeito de estado terminal (`:217-232`) é o lugar certo pra limpar.

- [ ] **Step 1: Escreve o teste falhando — `currentParty` reativo + guard de geração + clear no terminal**

No `src/contexts/__tests__/WebRTCCallContext.test.tsx`, adicionar (seguindo o padrão de mock já usado no arquivo — `SipClient` mockado, `resolveCallParty` mockado):

```tsx
describe('currentParty / atendimento', () => {
  it('expõe currentParty/currentCustomerUserId/currentAtendimentoId após makeCall resolver', async () => {
    mockResolveCallParty.mockResolvedValue({
      kind: 'cliente', customerUserId: 'cust-1', matchConfidence: 'last8', phoneNormalized: '5531999999999',
    });
    const { result } = renderWebRTCProvider();
    await act(async () => { await result.current.makeCall('31999999999'); });
    expect(result.current.currentCustomerUserId).toBe('cust-1');
    expect(result.current.currentParty?.kind).toBe('cliente');
    expect(result.current.currentAtendimentoId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('descarta resolução de party de uma ligação substituída (guard de geração)', async () => {
    let resolveFirst!: (p: ResolvedCallParty) => void;
    mockResolveCallParty
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
      .mockResolvedValueOnce({ kind: 'cliente', customerUserId: 'cust-2', matchConfidence: 'last8', phoneNormalized: '...' });
    const { result } = renderWebRTCProvider();
    act(() => { void result.current.makeCall('31111111111'); }); // call A — resolve pendente
    await act(async () => { await result.current.makeCall('31222222222'); }); // call B — resolve já
    await act(async () => { resolveFirst({ kind: 'cliente', customerUserId: 'cust-1', matchConfidence: 'last8', phoneNormalized: '...' }); });
    expect(result.current.currentCustomerUserId).toBe('cust-2'); // B venceu; A (tardio) descartado
  });

  it('limpa currentParty/atendimento quando a chamada vai a terminal', async () => {
    mockResolveCallParty.mockResolvedValue({ kind: 'cliente', customerUserId: 'cust-1', matchConfidence: 'last8', phoneNormalized: '...' });
    const { result } = renderWebRTCProvider();
    await act(async () => { await result.current.makeCall('31999999999'); });
    act(() => { emitSipState('ended'); }); // helper que dispara stateChange -> 'finished'
    expect(result.current.currentCustomerUserId).toBeNull();
    expect(result.current.currentAtendimentoId).toBeNull();
  });
});
```

> Se o harness de teste do arquivo não tiver `emitSipState`/`renderWebRTCProvider`, reusar os utilitários já presentes no arquivo (ele já testa o ciclo de chamada). Ajustar os nomes aos helpers existentes — **não** criar harness novo se já houver um.

- [ ] **Step 2: Roda o teste e confirma a falha**

Run: `heavy bun run test src/contexts/__tests__/WebRTCCallContext.test.tsx`
Expected: FAIL (`currentParty`/`currentCustomerUserId`/`currentAtendimentoId` não existem no value).

- [ ] **Step 3: Adiciona os campos ao contrato**

Em `src/contexts/webrtc-call-context.ts`, adicionar o import de tipo e os campos na interface (após `incomingCall`/`acceptIncoming`/`rejectIncoming`, antes do `}`):

```ts
import type { ResolvedCallParty } from '@/lib/call-log/recording-policy';
```

```ts
  /** Cliente resolvido da ligação ATIVA (por telefone). null se desconhecido/sem chamada.
   *  Setado por makeCall/acceptIncoming via resolveCallParty, guardado por geração de
   *  chamada (resolução tardia de uma ligação já encerrada é descartada). */
  currentParty: ResolvedCallParty | null;
  /** Atalho pra currentParty?.customerUserId (o que o bridge/munição usam). */
  currentCustomerUserId: string | null;
  /** Identidade do ATENDIMENTO (1 por ligação, cunhada no início). Liga ligação ↔ N
   *  pedidos: o bridge passa via URL e o submitOrder grava em sales_orders.atendimento_id. */
  currentAtendimentoId: string | null;
```

> `ResolvedCallParty` é importado de um módulo que importa `resolve-customer` (que importa `@/integrations/supabase/client`). Como `webrtc-call-context.ts` deve ficar LEVE (type-only), confirmar que o import é **`import type`** (apagado na compilação) — não arrasta runtime. O guardrail `webrtc-context-split.test.ts` valida o split; rodar pra garantir que segue verde.

- [ ] **Step 4: Implementa no Provider — state, refs, generation guard, set/clear**

Em `src/contexts/WebRTCCallContext.tsx`:

(a) State + refs (junto dos demais, ~`:97`):

```tsx
  const [currentParty, setCurrentParty] = useState<ResolvedCallParty | null>(null);
  const [currentAtendimentoId, setCurrentAtendimentoId] = useState<string | null>(null);
  // Guard de async-race: cada nova chamada incrementa; resolução tardia de party só
  // aplica se a geração ainda for a corrente (ligação anterior já encerrada é descartada).
  const callGenerationRef = useRef(0);
  const atendimentoIdRef = useRef<string | null>(null);     // snapshot pro persistCallSession
  const incomingPartyRef = useRef<ResolvedCallParty | null>(null); // party resolvida no ring (inbound)
```

Import do tipo no topo: `import { resolveCustomerByPhone } from ...` já existe; adicionar `import type { ResolvedCallParty } from '@/lib/call-log/recording-policy';` (o `resolveCallParty`/`shouldAutoRecord` já são importados de lá em `:15`).

(b) `makeCall` (`:282`) — no TOPO (logo após o guard de lente `:283-286`, antes do `await`), cunhar atendimento + bumpar geração; após o `await resolveCallParty` (`:306`), setar party guardado:

```tsx
    // (novo) identidade do atendimento + geração — ANTES de qualquer await
    const gen = ++callGenerationRef.current;
    const atendimentoId = crypto.randomUUID();
    atendimentoIdRef.current = atendimentoId;
    setCurrentAtendimentoId(atendimentoId);
```

Logo após `const party = await resolveCallParty(phoneNumber);` (`:306`):

```tsx
    if (callGenerationRef.current === gen) {
      setCurrentParty(party);
    }
```

> `currentCustomerUserId` é derivado de `currentParty` no `value` (não precisa de state próprio).

(c) `acceptIncoming` (`:425`) — após o guard de lente, cunhar atendimento + setar party do ring (síncrono, é ação do usuário; sem race):

```tsx
    callGenerationRef.current += 1;
    const atendimentoId = crypto.randomUUID();
    atendimentoIdRef.current = atendimentoId;
    setCurrentAtendimentoId(atendimentoId);
    setCurrentParty(incomingPartyRef.current); // resolvido no ring; null se não cliente
```

(d) Listener de ring (`:163`) — guardar a party resolvida no ref (pra o accept usar). Após `const party = await resolveCallParty(info.phone);` (`:163`):

```tsx
          incomingPartyRef.current = party;
```

E limpar em `rejectIncoming` (`:477`) e quando `incomingClosed` sem answer: `incomingPartyRef.current = null;`.

(e) Clear no terminal — no efeito de estado terminal (`:217-232`), após o `cleanupAudioResources()` (`:223`):

```tsx
    callGenerationRef.current += 1; // invalida qualquer resolução de party em voo
    setCurrentParty(null);
    setCurrentAtendimentoId(null);
    atendimentoIdRef.current = null;
    incomingPartyRef.current = null;
```

(f) `value` (`:525`) — adicionar:

```tsx
    currentParty,
    currentCustomerUserId: currentParty?.customerUserId ?? null,
    currentAtendimentoId,
```

- [ ] **Step 5: Roda o teste e confirma que passa**

Run: `heavy bun run test src/contexts/__tests__/WebRTCCallContext.test.tsx`
Expected: PASS (3 novos casos + os existentes intactos).

- [ ] **Step 6: Guardrail do split + typecheck**

Run: `heavy bun run test src/contexts/__tests__/webrtc-context-split.test.ts && heavy bun run typecheck`
Expected: PASS (o import-type não arrastou runtime pro módulo leve; sem erro de tipo).

- [ ] **Step 7: Commit**

```bash
git add src/contexts/webrtc-call-context.ts src/contexts/WebRTCCallContext.tsx src/contexts/__tests__/WebRTCCallContext.test.tsx
git commit -m "feat(onda1/fase1): currentParty/currentAtendimentoId no WebRTCCallContext (guard de geração)"
```

---

## Task 2 — Reverse-link: `farmer_calls.atendimento_id` + persistência

**Files:**
- Create: `supabase/migrations/2026XXXXXXXXXX_onda1_fase1_farmer_calls_atendimento.sql`
- Modify: `src/lib/call-session/build-session-payload.ts`
- Modify: `src/lib/call-session/build-session-payload.test.ts`
- Modify: `src/contexts/WebRTCCallContext.tsx` (`persistCallSession` + `endCall` snapshot)

**Contexto pro implementador:** `persistCallSession` (`WebRTCCallContext.tsx:46-78`) roda no `endCall`, monta o payload via `buildSessionPayload` (`src/lib/call-session/build-session-payload.ts:37`) e faz `supabase.from('farmer_calls').insert(payload)`. `endCall` (`:362`) tira snapshots (`turnsRef`/`analysisHistoryRef`/`dialedPhoneRef`) ANTES do hangUp; adicionar o `atendimentoIdRef` ao snapshot. A migração é **aditiva** (1 coluna nuável + índice) → aplicar manualmente no SQL Editor do Lovable (skill `lovable-db-operator`).

- [ ] **Step 1: Cria a migração**

`supabase/migrations/2026XXXXXXXXXX_onda1_fase1_farmer_calls_atendimento.sql` (usar timestamp real `date +%Y%m%d%H%M%S`):

```sql
-- Onda 1 / Fase 1 — reverse-link ligação ↔ pedidos.
-- atendimento_id: o MESMO uuid gravado em sales_orders.atendimento_id (cunhado no
-- WebRTCCallContext por ligação). Permite "quais pedidos vieram desta ligação".
-- Aditiva, nuável — aplicar via SQL Editor do Lovable.

ALTER TABLE public.farmer_calls
  ADD COLUMN IF NOT EXISTS atendimento_id uuid;

CREATE INDEX IF NOT EXISTS idx_farmer_calls_atendimento_id
  ON public.farmer_calls (atendimento_id)
  WHERE atendimento_id IS NOT NULL;

-- ── Validação pós-apply ──
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='farmer_calls' AND column_name='atendimento_id') AS coluna_1, -- 1
  (SELECT count(*) FROM pg_indexes WHERE indexname='idx_farmer_calls_atendimento_id') AS idx_1;               -- 1
```

- [ ] **Step 2: Escreve o teste do payload (falhando)**

Em `src/lib/call-session/build-session-payload.test.ts`, adicionar caso:

```ts
it('inclui atendimento_id quando fornecido (e null quando ausente)', () => {
  const base = {
    farmerId: 'f1', customerUserId: 'c1', phoneDialed: '5531999999999',
    callBackend: 'webrtc' as const, startedAt: new Date('2026-06-13T10:00:00Z'),
    endedAt: new Date('2026-06-13T10:05:00Z'), turns: [], analyses: [],
  };
  expect(buildSessionPayload({ ...base, atendimentoId: 'atend-1' }).atendimento_id).toBe('atend-1');
  expect(buildSessionPayload(base).atendimento_id).toBeNull();
});
```

- [ ] **Step 3: Roda e confirma a falha**

Run: `heavy bun run test src/lib/call-session/build-session-payload.test.ts`
Expected: FAIL (`atendimentoId`/`atendimento_id` não existem).

- [ ] **Step 4: Implementa no helper**

Em `src/lib/call-session/build-session-payload.ts`:
- `BuildSessionPayloadInput` (`:5`): adicionar `atendimentoId?: string | null;`
- `SessionPayload` (`:17`): adicionar `atendimento_id: string | null;`
- No `return` (`:51`): adicionar `atendimento_id: input.atendimentoId ?? null,`

- [ ] **Step 5: Roda e confirma que passa**

Run: `heavy bun run test src/lib/call-session/build-session-payload.test.ts`
Expected: PASS.

- [ ] **Step 6: Liga o snapshot no Provider**

Em `WebRTCCallContext.tsx`:
- `endCall` (`:362-369`): adicionar ao bloco de snapshots `const atendimentoIdSnapshot = atendimentoIdRef.current;`
- Na chamada a `persistCallSession({...})` (dentro de `endCall`), passar `atendimentoId: atendimentoIdSnapshot`.
- `persistCallSession` (`:46`): adicionar `atendimentoId: string | null;` ao `opts` e repassar a `buildSessionPayload({ ..., atendimentoId: opts.atendimentoId })`.

> O `insert(payload as any)` (`:71`) já existe (cast legado); o novo campo entra no payload sem mexer no cast. **Não** adicionar `atendimento_id` ao `types.ts` à mão (o Lovable regenera pós-migração; até lá o `as any` cobre — padrão do CLAUDE.md §10).

- [ ] **Step 7: Typecheck + commit**

Run: `heavy bun run typecheck`
Expected: PASS.

```bash
git add supabase/migrations/2026*onda1_fase1_farmer_calls_atendimento.sql src/lib/call-session/build-session-payload.ts src/lib/call-session/build-session-payload.test.ts src/contexts/WebRTCCallContext.tsx
git commit -m "feat(onda1/fase1): farmer_calls.atendimento_id (reverse-link ligação↔pedidos)"
```

> **PR description / handoff:** marcar "**ATENÇÃO: migração manual necessária**" + colar o bloco SQL inline.

---

## Task 3 — Bridge: ler `?atendimento`/`?origem` no submit + aviso de entrante

**Files:**
- Create: `src/services/orderSubmission/origem.ts`
- Create: `src/services/orderSubmission/origem.test.ts`
- Modify: `src/hooks/useUnifiedOrder.ts`
- Modify: `src/pages/UnifiedOrder.tsx`

**Contexto pro implementador:** `useUnifiedOrder` já tem `useNavigate` (`:77`) mas NÃO `useSearchParams`. O submit (`:651-722`) passa hoje `origem: isCustomerMode ? 'web_customer' : 'web_staff'` + `atendimentoId: null`. A página `UnifiedOrder.tsx` já lê `?customer` (`:82-83`) e tem o guard de preselect (`:99-109`, só roda se `!h.selectedCustomer`). Não há CHECK de `origem` no banco → validar no client.

- [ ] **Step 1: Escreve os testes do helper de origem (falhando)**

`src/services/orderSubmission/origem.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveOrigemFromUrl, ORIGEM_LIGACAO } from './origem';

describe('resolveOrigemFromUrl', () => {
  it('aceita origens de ligação da allowlist', () => {
    expect(resolveOrigemFromUrl('ligacao_sainte', false)).toBe('ligacao_sainte');
    expect(resolveOrigemFromUrl('ligacao_entrante', false)).toBe('ligacao_entrante');
  });
  it('ignora valor desconhecido/injetado → fallback pro default da role', () => {
    expect(resolveOrigemFromUrl('hacker', false)).toBe('web_staff');
    expect(resolveOrigemFromUrl('hacker', true)).toBe('web_customer');
    expect(resolveOrigemFromUrl(null, false)).toBe('web_staff');
  });
  it('customer nunca herda origem de ligação da URL (ligação é staff-only)', () => {
    expect(resolveOrigemFromUrl('ligacao_sainte', true)).toBe('web_customer');
  });
  it('expõe a lista de origens de ligação', () => {
    expect(ORIGEM_LIGACAO).toContain('ligacao_sainte');
  });
});
```

- [ ] **Step 2: Roda e confirma a falha**

Run: `heavy bun run test src/services/orderSubmission/origem.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementa o helper**

`src/services/orderSubmission/origem.ts`:

```ts
/** Origens de pedido gravadas em sales_orders.origem (sem CHECK no banco → validar aqui). */
export const ORIGEM_LIGACAO = ['ligacao_sainte', 'ligacao_entrante'] as const;
export type OrigemLigacao = (typeof ORIGEM_LIGACAO)[number];

/**
 * Resolve a `origem` do pedido a partir do param da URL, com allowlist.
 * Ligação é staff-only: customer SEMPRE grava 'web_customer' (nunca herda da URL).
 * Valor desconhecido/injetado → default da role (anti-origem-forjada via URL).
 */
export function resolveOrigemFromUrl(raw: string | null, isCustomerMode: boolean): string {
  if (isCustomerMode) return 'web_customer';
  if (raw && (ORIGEM_LIGACAO as readonly string[]).includes(raw)) return raw;
  return 'web_staff';
}
```

- [ ] **Step 4: Roda e confirma que passa**

Run: `heavy bun run test src/services/orderSubmission/origem.test.ts`
Expected: PASS.

- [ ] **Step 5: Liga no `useUnifiedOrder`**

Em `src/hooks/useUnifiedOrder.ts`:
- Import: `import { useNavigate, useSearchParams } from 'react-router-dom';` + `import { resolveOrigemFromUrl } from '@/services/orderSubmission/origem';`
- Após `const navigate = useNavigate();` (`:77`): `const [searchParams] = useSearchParams();`
- No submit (`:721-722`), trocar:

```tsx
        origem: resolveOrigemFromUrl(searchParams.get('origem'), isCustomerMode),
        atendimentoId: isCustomerMode ? null : (searchParams.get('atendimento') || null),
```

> `atendimento` da URL é uuid string (não validamos formato aqui — é nosso próprio param; o banco aceita uuid nulável; valor malformado falharia no insert, mas a fonte é o nosso HUD). `isCustomerMode` já está no escopo (`:335`). Adicionar `searchParams` às deps do `useCallback` do submit.

- [ ] **Step 6: Aviso de entrante (carrinho sujo de outro cliente) no `UnifiedOrder.tsx`**

Em `src/pages/UnifiedOrder.tsx`, após o bloco de preselect (`:99-109`), adicionar um efeito que avisa (uma vez) quando há `?customer` na URL ≠ do cliente já selecionado com carrinho não-vazio (= ligação entrou durante um pedido sujo):

```tsx
  // Política de entrante (Fase 1): ligação para B chegou enquanto o pedido de A está
  // sujo. Não trocamos o cliente (o guard de preselect acima já impede) — só avisamos.
  const entranteWarnedRef = useRef(false);
  useEffect(() => {
    if (
      preselectCustomerId &&
      h.selectedCustomer &&
      h.customerUserId &&
      preselectCustomerId !== h.customerUserId &&
      h.cart.length > 0 &&
      !entranteWarnedRef.current
    ) {
      entranteWarnedRef.current = true;
      toast.info('Pedido em andamento para outro cliente', {
        description: 'Finalize ou limpe este pedido antes de montar um novo a partir da ligação.',
      });
    }
  }, [preselectCustomerId, h.selectedCustomer, h.customerUserId, h.cart.length]);
```

> `toast` já é importado (`:27`). `useRef`/`useEffect` já importados (`:1`).

- [ ] **Step 7: Typecheck + testes + commit**

Run: `heavy bun run typecheck && heavy bun run test src/services/orderSubmission/origem.test.ts`
Expected: PASS.

```bash
git add src/services/orderSubmission/origem.ts src/services/orderSubmission/origem.test.ts src/hooks/useUnifiedOrder.ts src/pages/UnifiedOrder.tsx
git commit -m "feat(onda1/fase1): bridge grava origem/atendimento_id da ligação + aviso de entrante"
```

---

## Task 4 — Munição read-only (gancho + última compra + recompra)

**Files:**
- Create: `src/lib/call/municao.ts` (helper puro)
- Create: `src/lib/call/municao.test.ts`
- Create: `src/hooks/useMunicaoLigacao.ts` (leituras read-only)

**Contexto pro implementador:** Mandato read-only (spec §4.3/§7.3): **NUNCA** chamar `selectCustomer` (cria cadastro no Omie) nem `useProductCatalog` (sync de estoque) no mount. Só leituras baratas: últimas vendas do cliente (`sales_orders` por `customer_user_id`, `deleted_at is null`, `order by order_date_kpi/created_at desc limit 5`) + `customer_metrics_mv` se útil. **Defasagem de preço NÃO entra** (Fase 2). Helper puro deriva os números; o hook só busca + chama o helper.

- [ ] **Step 1: Escreve o teste do helper (falhando)**

`src/lib/call/municao.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { derivarMunicao } from './municao';

const hoje = new Date('2026-06-13T12:00:00Z');

describe('derivarMunicao', () => {
  it('calcula dias desde a última compra + último valor', () => {
    const r = derivarMunicao({
      pedidos: [{ data: '2026-06-01', valor: 1200 }, { data: '2026-05-01', valor: 800 }],
      agora: hoje,
    });
    expect(r.diasDesdeUltima).toBe(12);
    expect(r.ultimaCompra).toEqual({ data: '2026-06-01', valor: 1200 });
    expect(r.ticketMedio).toBe(1000);
  });
  it('degrada honesto sem histórico', () => {
    const r = derivarMunicao({ pedidos: [], agora: hoje });
    expect(r.diasDesdeUltima).toBeNull();
    expect(r.ultimaCompra).toBeNull();
    expect(r.ticketMedio).toBeNull();
  });
  it('ignora datas futuras (order_date_kpi pode vir adiantado do Omie)', () => {
    const r = derivarMunicao({ pedidos: [{ data: '2026-07-01', valor: 999 }, { data: '2026-06-10', valor: 500 }], agora: hoje });
    expect(r.ultimaCompra?.data).toBe('2026-06-10');
    expect(r.diasDesdeUltima).toBe(3);
  });
});
```

- [ ] **Step 2: Roda e confirma a falha**

Run: `heavy bun run test src/lib/call/municao.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa o helper puro**

`src/lib/call/municao.ts`:

```ts
export interface MunicaoPedido { data: string; valor: number; }
export interface MunicaoInput { pedidos: MunicaoPedido[]; agora: Date; }
export interface Municao {
  diasDesdeUltima: number | null;
  ultimaCompra: MunicaoPedido | null;
  ticketMedio: number | null;
}

/** Deriva munição read-only a partir das últimas compras. Ignora datas futuras
 *  (order_date_kpi pode vir adiantado do Omie). Degradação honesta: sem histórico → null. */
export function derivarMunicao({ pedidos, agora }: MunicaoInput): Municao {
  const hojeMs = agora.getTime();
  const validos = pedidos
    .filter((p) => Number.isFinite(new Date(p.data).getTime()) && new Date(p.data).getTime() <= hojeMs)
    .sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime());
  if (validos.length === 0) return { diasDesdeUltima: null, ultimaCompra: null, ticketMedio: null };
  const ultima = validos[0];
  const diffDias = Math.floor((hojeMs - new Date(ultima.data).getTime()) / 86_400_000);
  const ticket = Math.round(validos.reduce((s, p) => s + p.valor, 0) / validos.length);
  return { diasDesdeUltima: diffDias, ultimaCompra: ultima, ticketMedio: ticket };
}
```

- [ ] **Step 4: Roda e confirma que passa**

Run: `heavy bun run test src/lib/call/municao.test.ts`
Expected: PASS.

- [ ] **Step 5: Implementa o hook read-only**

`src/hooks/useMunicaoLigacao.ts` — `useQuery` (React Query, padrão do projeto) escopado a `customerUserId`, **enabled só com id**, leitura única de `sales_orders`:

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { derivarMunicao, type Municao } from '@/lib/call/municao';

/** Munição READ-ONLY pra o co-piloto. NÃO seleciona cliente nem monta catálogo
 *  (mandato read-only do spec §4.3 — selectCustomer/useProductCatalog têm efeito no Omie). */
export function useMunicaoLigacao(customerUserId: string | null): { municao: Municao | null; loading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['municao-ligacao', customerUserId],
    enabled: !!customerUserId,
    staleTime: 60_000,
    queryFn: async (): Promise<Municao> => {
      const { data: pedidos, error } = await supabase
        .from('sales_orders')
        .select('order_date_kpi, created_at, total')
        .eq('customer_user_id', customerUserId!)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(5);
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

> Verificar os nomes reais das colunas em `sales_orders` (`total` × `total_estimated`? `order_date_kpi` existe — CLAUDE.md §279). Se `total` não existir, usar a coluna de valor real do pedido. **Confirmar via o `types.ts` antes de finalizar** (não chutar nome de coluna).

- [ ] **Step 6: Typecheck + testes + commit**

Run: `heavy bun run typecheck && heavy bun run test src/lib/call/municao.test.ts`
Expected: PASS.

```bash
git add src/lib/call/municao.ts src/lib/call/municao.test.ts src/hooks/useMunicaoLigacao.ts
git commit -m "feat(onda1/fase1): munição read-only da ligação (gancho/última compra/ticket)"
```

---

## Task 5 — HUD co-piloto flutuante global + bridge "Montar pedido"

**Files:**
- Create: `src/components/call/CallCopilotHud.tsx`
- Modify: `src/components/AppShellLayout.tsx`

**Contexto pro implementador:** O HUD é global, montado no `AppShellLayout` (`:55-66`, junto de `IncomingCallModal`/`TransferSpikePanel`). Consome `useWebRTCCallContextOptional()` (null-safe — customer não tem provider). Mostra quando `callState === 'established'`. Reusa `SpinSuggestionCard` (props `{status, analysis, error}`) inline + abre o `TranscriptionPanel` EXISTENTE (props em `TranscriptionPanel.tsx:11-20`) via toggle (começa fechado). NÃO duplicar a lógica de transcrição — só renderizar o componente. CTA "Montar pedido" navega pro `/sales/new` com os params. Telemetria via `track` (`@/lib/analytics`).

- [ ] **Step 1: Cria o componente HUD**

`src/components/call/CallCopilotHud.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, ShoppingCart, MessageSquareText, X, Mic, MicOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track } from '@/lib/analytics';
import { useWebRTCCallContextOptional } from '@/contexts/webrtc-call-context';
import { useMunicaoLigacao } from '@/hooks/useMunicaoLigacao';
import { SpinSuggestionCard } from './SpinSuggestionCard';
import { TranscriptionPanel } from './TranscriptionPanel';
import { formatBrPhone } from '@/lib/phone';
import { formatCurrency } from '@/lib/format';

/** Co-piloto flutuante GLOBAL: aparece em qualquer tela quando há ligação ativa,
 *  acompanha a navegação, e leva pro pedido com o contexto da ligação (origem +
 *  atendimento_id). Coexiste com o painel inline do /farmer/calls (Fase 3 consolida). */
export function CallCopilotHud() {
  const ctx = useWebRTCCallContextOptional();
  const navigate = useNavigate();
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const { municao } = useMunicaoLigacao(ctx?.currentCustomerUserId ?? null);

  if (!ctx || ctx.callState !== 'established') return null;

  const customerId = ctx.currentCustomerUserId;
  const partyName = ctx.currentParty?.contactName ?? null;

  const montarPedido = () => {
    if (!customerId) {
      track('ligacao.montar_pedido', { tem_cliente: false });
      navigate('/sales/new'); // número desconhecido: abre vazio (sem origem de ligação)
      return;
    }
    const params = new URLSearchParams({
      customer: customerId,
      origem: 'ligacao_sainte', // entrante usa o mesmo palco na v1 (spec §12); refino depois
    });
    if (ctx.currentAtendimentoId) params.set('atendimento', ctx.currentAtendimentoId);
    track('ligacao.montar_pedido', { tem_cliente: true });
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
              <Phone className="w-4 h-4 text-status-error rotate-[135deg]" />
            </Button>
          </div>
        </header>

        {/* Munição read-only */}
        {municao && (
          <div className="px-3 py-2 border-b border-border text-xs text-muted-foreground space-y-0.5">
            {municao.ultimaCompra ? (
              <div>
                Última compra: <span className="text-foreground font-medium">{formatCurrency(municao.ultimaCompra.valor)}</span>
                {municao.diasDesdeUltima != null && <> · há {municao.diasDesdeUltima}d</>}
              </div>
            ) : (
              <div>Sem compras anteriores registradas.</div>
            )}
            {municao.ticketMedio != null && <div>Ticket médio: {formatCurrency(municao.ticketMedio)}</div>}
          </div>
        )}

        {/* SPIN inline (1 card existente) */}
        <div className="max-h-[40vh] overflow-y-auto">
          <SpinSuggestionCard status={ctx.spinAnalysisStatus} analysis={ctx.spinAnalysis} error={ctx.spinAnalysisError} />
        </div>

        <footer className="flex items-center gap-2 p-2 border-t border-border">
          <Button size="sm" variant="outline" className="flex-1 gap-1.5" onClick={() => { setTranscriptOpen((v) => { if (!v) track('ligacao.transcricao_aberta'); return !v; }); }}>
            <MessageSquareText className="w-3.5 h-3.5" /> Transcrição
          </Button>
          <Button size="sm" className="flex-1 gap-1.5" onClick={montarPedido}>
            <ShoppingCart className="w-3.5 h-3.5" /> Montar pedido
          </Button>
        </footer>
      </div>

      <TranscriptionPanel
        status={ctx.transcriptionStatus}
        turns={ctx.transcriptionTurns}
        error={ctx.transcriptionError}
        open={transcriptOpen}
        onClose={() => setTranscriptOpen(false)}
        spinStatus={ctx.spinAnalysisStatus}
        spinAnalysis={ctx.spinAnalysis}
        spinError={ctx.spinAnalysisError}
      />
    </>
  );
}
```

> Verificar os nomes/assinaturas reais de `formatBrPhone` (`@/lib/phone`) e `formatCurrency` (`@/lib/format`) — usar os que existem (o projeto tem ambos; confirmar o nome exato do export de moeda). Se o ícone de "encerrar" via `Phone` rotacionado não agradar, usar `PhoneOff` do lucide.

- [ ] **Step 2: Monta no `AppShellLayout`**

Em `src/components/AppShellLayout.tsx`:
- Import: `import { CallCopilotHud } from './call/CallCopilotHud';`
- Dentro do `<AppShell>`, após `<TransferSpikePanel />` (`:63`):

```tsx
      {/* Onda 1 / Fase 1: co-piloto flutuante global durante a ligação */}
      <CallCopilotHud />
```

> O `CallCopilotHud` usa `useWebRTCCallContextOptional()` → seguro mesmo quando não há provider (customer). Ele importa `TranscriptionPanel`/`SpinSuggestionCard` (componentes leves) e `useWebRTCCallContextOptional` (módulo LEVE) — **não** importa o `.tsx` pesado → não arrasta jssip pro entry. Confirmar que o guardrail `webrtc-context-split.test.ts` segue verde (o HUD entra no grafo estático do AppShellLayout, como o IncomingCallModal — ambos importam só do módulo leve).

- [ ] **Step 3: Typecheck + guardrail do split + build**

Run: `heavy bun run typecheck && heavy bun run test src/contexts/__tests__/webrtc-context-split.test.ts && heavy bun build`
Expected: PASS (sem regressão de bundle; HUD não puxa jssip pro main).

- [ ] **Step 4: Commit**

```bash
git add src/components/call/CallCopilotHud.tsx src/components/AppShellLayout.tsx
git commit -m "feat(onda1/fase1): HUD co-piloto flutuante global + bridge Montar pedido"
```

---

## Self-Review (rodar após escrever, antes de executar)

**1. Cobertura do escopo da Fase 1 (spec §7.2/§7.3/§10):**
- [x] `currentParty`/`currentCustomerUserId` no contexto → Task 1.
- [x] `currentAtendimentoId` (identidade de atendimento) → Task 1 + reverse-link Task 2.
- [x] HUD global montado no AppShellLayout, aparece em `established`, persiste na navegação, reusa TranscriptionPanel/SpinSuggestionCard → Task 5.
- [x] "Montar pedido" → `/sales/new?customer=…&atendimento=…` (+ origem) → Task 5 + Task 3.
- [x] Munição read-only (sem selectCustomer/catálogo) → Task 4.
- [x] Grava `origem`/`atendimento_id` no submit → Task 3 (contrato da Fase 0).
- [x] Política de entrante (P2 §18) → Task 3 (aviso, sem auto-clobber).
- [x] Instrumentado (telemetria) → Task 5 (`ligacao.montar_pedido`/`ligacao.transcricao_aberta`).
- [x] **Diferido conscientemente:** defasagem de preço (Fase 2), estados de submit em-progresso no HUD (pós-gate), consolidação do painel /farmer/calls (Fase 3).

**2. Type/consistência:**
- `currentParty: ResolvedCallParty | null`, `currentCustomerUserId: currentParty?.customerUserId ?? null`, `currentAtendimentoId: string | null` — coerentes entre `webrtc-call-context.ts` (contrato), `WebRTCCallContext.tsx` (value) e o consumo no HUD.
- `submitOrder`/`useUnifiedOrder` já têm `origem`/`atendimentoId` (Fase 0) — Task 3 só preenche.
- `derivarMunicao`/`Municao` consistente entre helper, teste e hook.

**3. Riscos a confirmar na execução (não chutar):**
- Nomes reais das colunas de `sales_orders` no Task 4 (`total` vs `total_estimated`) — checar `types.ts`.
- Nome do export de moeda em `@/lib/format` e de telefone em `@/lib/phone` (Task 5).
- Helpers de teste existentes no `WebRTCCallContext.test.tsx` (Task 1) — reusar, não recriar harness.
- O guardrail `webrtc-context-split.test.ts` deve seguir verde após Tasks 1 e 5 (imports type-only / módulo leve).

---

## Execution Handoff

Plano salvo em `docs/superpowers/plans/2026-06-13-jornada-comercial-onda1-fase1-ponte-hud.md`.

🔴 **Pré-condição de execução:** o rollout da Fase 0 (gate + smoke + faultstring) — ver o callout do topo. **Não iniciar a implementação antes disso** (decisão eu+Codex). Recomendado: 1 passe adversário do Codex sobre este plano (foco em `currentAtendimentoId`/guard de geração/entrante) antes de executar.

Quando liberado, duas opções:

**1. Subagent-Driven (recomendado)** — dispatch de subagente fresco por task, review entre tasks (spec + qualidade), iteração rápida. Sugestão de modelo: Tasks 1/2/3 = **opus** (ciclo de vida da ligação + money-path-adjacent do submit/persist); Tasks 4/5 = **sonnet** (read-only + UI com spec clara).

**2. Inline Execution** — executar as tasks nesta sessão via executing-plans, com checkpoints.
