# Central de Telefonia — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma página `/telefonia` com discador livre (ligar pra qualquer número) + histórico de chamadas (feitas/recebidas/perdidas) com BINA, sobre uma tabela nova `call_log`, capturando chamadas app-side e gravando só quando for cliente/fornecedor (ou toggle manual).

**Architecture:** Tabela `call_log` dedicada (separada de `farmer_calls`, que segue sendo coaching). Escrita direta do front via RLS por `farmer_id`, a partir de 3 pontos existentes (`WebRTCCallContext`, `IncomingCallModal`/inbound, fluxo Nvoip). Núcleo testável em libs puras (`src/lib/call-log/`). UI nova em `src/pages/Telefonia.tsx` + `src/components/telefonia/`. Caller-ID único de empresa via `company_config`.

**Tech Stack:** React 18 + TS + Vite, Supabase (Postgres + RLS + pg_cron), JsSIP (WebRTC), `@tanstack/react-query`, vitest, Tailwind/shadcn. Spec: `docs/superpowers/specs/2026-05-23-central-telefonia-design.md`.

> **⚠️ Migrations & deploy:** O Lucas NÃO tem terminal/CLI de banco. Toda migration custom é **aplicada manualmente no SQL Editor do Lovable** (ver CLAUDE.md §5). A Task 1 entrega o SQL pronto pra colar. Tipos gerados do Supabase NÃO incluem `call_log` até o Lovable regenerar → o código usa `as any` no `supabase.from('call_log')` (padrão já usado em `resolve-customer.ts`). Acesso a tabela nova SEMPRE com cast.

> **Convenção de teste:** rodar `bun run test` (vitest, canônico). Tests puros ficam em `__tests__/` ao lado do arquivo ou como `*.test.ts`. Seguir o estilo de `src/lib/call-session/resolve-customer.test.ts`.

---

## File Structure

**Criar:**
- `supabase/migrations/20260523120000_call_log.sql` — tabela, enums, índices, RLS, cron backstop.
- `src/types/call-log.ts` — tipos TS da `call_log` (a generated types não tem).
- `src/lib/call-log/recording-policy.ts` — `shouldAutoRecord`, `resolveCallParty`.
- `src/lib/call-log/recording-policy.test.ts`
- `src/lib/call-log/build-insert.ts` — `buildCallLogInsert` (payload puro).
- `src/lib/call-log/build-insert.test.ts`
- `src/lib/call-log/record.ts` — escrita (upsert/update) via supabase.
- `src/hooks/useCallLog.ts` — query do histórico + acknowledge + contagem de perdidas.
- `src/pages/Telefonia.tsx` — página/rota.
- `src/components/telefonia/DialPad.tsx` — discador livre.
- `src/components/telefonia/CallHistoryTabs.tsx` — abas + lista.
- `src/components/telefonia/CallHistoryRow.tsx` — linha (BINA + ações).

**Modificar:**
- `src/lib/sip/types.ts` — `IncomingCallInfo.sipCallId` + evento `incomingClosed`.
- `src/lib/sip/sip-client.ts` — emitir `sipCallId` e `incomingClosed`.
- `src/contexts/WebRTCCallContext.tsx` — wiring de captura (inbound + outbound) + gating de gravação.
- `src/components/call/IncomingCallModal.tsx` — (sem mudança funcional de captura; captura vive no context).
- `src/components/AppShell.tsx` — item de menu "Telefonia" + badge de perdidas.

> Toggle "gravar": no MVP fica **pré-chamada no `DialPad`** (Task 13, passa `forceRecord` pro `makeCall`). Toggle mid-chamada no `CallDialerView` (começar a gravar com a chamada já em curso) é **Fase 2** — exige injetar o preroll no meio do stream.
- `src/App.tsx` — rota `/telefonia`.
- `nvoip-sip-creds` (edge function) + `company_config` — caller-ID único.

---

## Task 1: Migration — tabela `call_log` + enums + RLS + cron

**Files:**
- Create: `supabase/migrations/20260523120000_call_log.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- Central de Telefonia: ledger telefônico (separado de farmer_calls/coaching)
-- Enums
DO $$ BEGIN
  CREATE TYPE public.call_direction AS ENUM ('inbound','outbound');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.call_status AS ENUM ('ringing','answered','missed','rejected','busy','failed','canceled','ended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tabela
CREATE TABLE IF NOT EXISTS public.call_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  direction public.call_direction NOT NULL,
  status public.call_status NOT NULL DEFAULT 'ringing',
  provider text NOT NULL CHECK (provider IN ('nvoip_click_to_call','nvoip_sip','manual')),
  provider_call_id text,
  sip_call_id text,
  customer_user_id uuid,
  matched_contact_id uuid,
  match_confidence text CHECK (match_confidence IS NULL OR match_confidence IN ('exact','last8','none')),
  display_name text,
  phone_normalized text,
  phone_raw text,
  caller_id_used text,
  recorded boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds int NOT NULL DEFAULT 0,
  acknowledged_at timestamptz,
  source text NOT NULL DEFAULT 'app' CHECK (source IN ('app','cdr','webhook','backfill')),
  source_payload jsonb,
  last_synced_at timestamptz,
  farmer_call_id uuid REFERENCES public.farmer_calls(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Dedup idempotente (parciais — só quando id presente)
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_log_provider_call_id
  ON public.call_log (provider, provider_call_id) WHERE provider_call_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_log_sip_call_id
  ON public.call_log (provider, sip_call_id) WHERE sip_call_id IS NOT NULL;

-- Listagem do histórico
CREATE INDEX IF NOT EXISTS idx_call_log_farmer_started
  ON public.call_log (farmer_id, started_at DESC);
-- Badge de perdidas não-lidas
CREATE INDEX IF NOT EXISTS idx_call_log_missed_unack
  ON public.call_log (farmer_id)
  WHERE direction = 'inbound' AND status = 'missed' AND acknowledged_at IS NULL;

-- RLS
ALTER TABLE public.call_log ENABLE ROW LEVEL SECURITY;

-- Próprio: lê/escreve/atualiza as próprias
CREATE POLICY "call_log own select" ON public.call_log FOR SELECT
  USING (farmer_id = auth.uid());
CREATE POLICY "call_log own insert" ON public.call_log FOR INSERT
  WITH CHECK (farmer_id = auth.uid());
CREATE POLICY "call_log own update" ON public.call_log FOR UPDATE
  USING (farmer_id = auth.uid());

-- Time: gestor/estratégico/super_admin (commercial_roles) ou master (app_role) leem tudo
CREATE POLICY "call_log team select" ON public.call_log FOR SELECT
  USING (
    public.has_role(auth.uid(), 'master'::public.app_role)
    OR EXISTS (
      SELECT 1 FROM public.commercial_roles cr
      WHERE cr.user_id = auth.uid()
        AND cr.commercial_role IN ('gerencial','estrategico','super_admin')
    )
  );

-- Backstop de perdidas: aba fechou no toque → marca ringing antigo como missed
SELECT cron.schedule(
  'call-log-missed-backstop',
  '* * * * *',
  $$UPDATE public.call_log
      SET status = 'missed'
      WHERE direction = 'inbound'
        AND status = 'ringing'
        AND started_at < now() - interval '90 seconds'$$
);
```

- [ ] **Step 2: Validação (colar após Run no SQL Editor)**

```sql
SELECT 'call_log OK' AS status,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='call_log') AS colunas,
  (SELECT count(*) FROM pg_policies WHERE tablename='call_log') AS policies,
  (SELECT count(*) FROM cron.job WHERE jobname='call-log-missed-backstop') AS cron_jobs;
-- Esperado: colunas=25, policies=4, cron_jobs=1
```

- [ ] **Step 3: Commit (arquivo no repo) + entregar SQL inline pro Lucas colar no Lovable**

```bash
git add supabase/migrations/20260523120000_call_log.sql
git commit -m "feat(telefonia): migration call_log (tabela + enums + RLS + cron backstop)"
```

> **Handoff:** entregar o bloco SQL do Step 1 inline na conversa rotulado "🟣 Lovable → SQL Editor → cola → Run", e o Step 2 como validação. NÃO marcar a task como done de banco até o Lucas confirmar "Success" + a contagem esperada.

---

## Task 2: Tipos TS da `call_log`

**Files:**
- Create: `src/types/call-log.ts`

- [ ] **Step 1: Escrever os tipos**

```ts
export type CallDirection = 'inbound' | 'outbound';
export type CallStatus =
  | 'ringing' | 'answered' | 'missed' | 'rejected'
  | 'busy' | 'failed' | 'canceled' | 'ended';
export type CallProvider = 'nvoip_click_to_call' | 'nvoip_sip' | 'manual';
export type CallSource = 'app' | 'cdr' | 'webhook' | 'backfill';
export type MatchConfidence = 'exact' | 'last8' | 'none';

/** Tipo da parte identificada pela BINA. 'fornecedor' é dormente (sem dado hoje). */
export type CallPartyKind = 'cliente' | 'fornecedor' | 'desconhecido';

export interface CallLogRow {
  id: string;
  farmer_id: string;
  direction: CallDirection;
  status: CallStatus;
  provider: CallProvider;
  provider_call_id: string | null;
  sip_call_id: string | null;
  customer_user_id: string | null;
  matched_contact_id: string | null;
  match_confidence: MatchConfidence | null;
  display_name: string | null;
  phone_normalized: string | null;
  phone_raw: string | null;
  caller_id_used: string | null;
  recorded: boolean;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number;
  acknowledged_at: string | null;
  source: CallSource;
  source_payload: unknown;
  last_synced_at: string | null;
  farmer_call_id: string | null;
  created_at: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types/call-log.ts
git commit -m "feat(telefonia): tipos TS da call_log"
```

---

## Task 3: `shouldAutoRecord` (lib pura, TDD)

**Files:**
- Create: `src/lib/call-log/recording-policy.test.ts`
- Create: `src/lib/call-log/recording-policy.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/call-log/recording-policy.test.ts
import { describe, it, expect } from 'vitest';
import { shouldAutoRecord } from './recording-policy';

describe('shouldAutoRecord', () => {
  it('grava automaticamente para cliente', () => {
    expect(shouldAutoRecord('cliente')).toBe(true);
  });
  it('grava automaticamente para fornecedor (ramo dormente, mas pronto)', () => {
    expect(shouldAutoRecord('fornecedor')).toBe(true);
  });
  it('NÃO grava automaticamente para desconhecido/avulso', () => {
    expect(shouldAutoRecord('desconhecido')).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar pra ver falhar**

Run: `bun run test src/lib/call-log/recording-policy.test.ts`
Expected: FAIL — "shouldAutoRecord is not a function" / module não existe.

- [ ] **Step 3: Implementar o mínimo**

```ts
// src/lib/call-log/recording-policy.ts
import type { CallPartyKind } from '@/types/call-log';

/** Auto-grava (e toca a Sara) quando é cliente OU fornecedor cadastrado. */
export function shouldAutoRecord(kind: CallPartyKind): boolean {
  return kind === 'cliente' || kind === 'fornecedor';
}
```

- [ ] **Step 4: Rodar pra ver passar**

Run: `bun run test src/lib/call-log/recording-policy.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/call-log/recording-policy.ts src/lib/call-log/recording-policy.test.ts
git commit -m "feat(telefonia): shouldAutoRecord (cliente/fornecedor auto)"
```

---

## Task 4: `resolveCallParty` (BINA → kind + confiança, TDD com supabase mockado)

**Files:**
- Modify: `src/lib/call-log/recording-policy.ts`
- Modify: `src/lib/call-log/recording-policy.test.ts`

Reusa `resolveCustomerByPhone` (`src/lib/call-session/resolve-customer.ts`). Hoje só resolve cliente; fornecedor é dormente (sem telefone no banco). O wrapper devolve `kind`, `customerUserId`, `contactName`, `contactCargo`, `matchConfidence`.

- [ ] **Step 1: Escrever o teste que falha (mocka resolveCustomerByPhone)**

```ts
// adicionar ao topo de src/lib/call-log/recording-policy.test.ts
import { vi } from 'vitest';
import { resolveCallParty } from './recording-policy';

vi.mock('@/lib/call-session/resolve-customer', () => ({
  resolveCustomerByPhone: vi.fn(),
}));
import { resolveCustomerByPhone } from '@/lib/call-session/resolve-customer';

describe('resolveCallParty', () => {
  it('cliente identificado → kind cliente + last8', async () => {
    vi.mocked(resolveCustomerByPhone).mockResolvedValue({
      customerUserId: 'u1', phoneDialed: '37999998888', contactName: 'João', contactCargo: 'comprador',
    });
    const r = await resolveCallParty('(37) 99999-8888');
    expect(r.kind).toBe('cliente');
    expect(r.customerUserId).toBe('u1');
    expect(r.contactName).toBe('João');
    expect(r.matchConfidence).toBe('last8');
  });

  it('não identificado → kind desconhecido + none', async () => {
    vi.mocked(resolveCustomerByPhone).mockResolvedValue({ customerUserId: null, phoneDialed: '1140028922' });
    const r = await resolveCallParty('11 4002-8922');
    expect(r.kind).toBe('desconhecido');
    expect(r.customerUserId).toBeNull();
    expect(r.matchConfidence).toBe('none');
  });
});
```

- [ ] **Step 2: Rodar pra ver falhar**

Run: `bun run test src/lib/call-log/recording-policy.test.ts`
Expected: FAIL — "resolveCallParty is not a function".

- [ ] **Step 3: Implementar**

```ts
// adicionar a src/lib/call-log/recording-policy.ts
import { resolveCustomerByPhone } from '@/lib/call-session/resolve-customer';
import type { MatchConfidence } from '@/types/call-log';

export interface ResolvedCallParty {
  kind: CallPartyKind;
  customerUserId: string | null;
  contactName?: string;
  contactCargo?: string;
  matchConfidence: MatchConfidence;
  phoneNormalized: string;
}

/**
 * Resolve quem é o número. Hoje cobre CLIENTE (customer_contacts/profiles).
 * Fornecedor é dormente: não há telefone de fornecedor no banco — quando existir,
 * adicionar a fonte aqui e devolver kind='fornecedor'. shouldAutoRecord já trata os dois.
 */
export async function resolveCallParty(rawPhone: string): Promise<ResolvedCallParty> {
  const r = await resolveCustomerByPhone(rawPhone);
  if (r.customerUserId) {
    return {
      kind: 'cliente',
      customerUserId: r.customerUserId,
      contactName: r.contactName,
      contactCargo: r.contactCargo,
      matchConfidence: 'last8',
      phoneNormalized: r.phoneDialed,
    };
  }
  return { kind: 'desconhecido', customerUserId: null, matchConfidence: 'none', phoneNormalized: r.phoneDialed };
}
```

- [ ] **Step 4: Rodar pra ver passar**

Run: `bun run test src/lib/call-log/recording-policy.test.ts`
Expected: PASS (5 tests no total).

- [ ] **Step 5: Commit**

```bash
git add src/lib/call-log/recording-policy.ts src/lib/call-log/recording-policy.test.ts
git commit -m "feat(telefonia): resolveCallParty (BINA → kind + confiança)"
```

---

## Task 5: `buildCallLogInsert` (payload puro, TDD)

**Files:**
- Create: `src/lib/call-log/build-insert.test.ts`
- Create: `src/lib/call-log/build-insert.ts`

Constrói o objeto de insert (sem tocar supabase). Normaliza telefone via `normalizeBrPhone`.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/call-log/build-insert.test.ts
import { describe, it, expect } from 'vitest';
import { buildCallLogInsert } from './build-insert';

describe('buildCallLogInsert', () => {
  it('monta insert outbound manual sem cliente', () => {
    const row = buildCallLogInsert({
      farmerId: 'f1',
      direction: 'outbound',
      provider: 'nvoip_sip',
      phoneRaw: '(31) 3222-4040',
      party: { kind: 'desconhecido', customerUserId: null, matchConfidence: 'none', phoneNormalized: '3132224040' },
      recorded: false,
      callerIdUsed: '553735143571',
      sipCallId: 'abc123',
    });
    expect(row.farmer_id).toBe('f1');
    expect(row.direction).toBe('outbound');
    expect(row.status).toBe('ringing');
    expect(row.phone_normalized).toBe('3132224040');
    expect(row.phone_raw).toBe('(31) 3222-4040');
    expect(row.customer_user_id).toBeNull();
    expect(row.match_confidence).toBe('none');
    expect(row.recorded).toBe(false);
    expect(row.sip_call_id).toBe('abc123');
    expect(row.caller_id_used).toBe('553735143571');
    expect(row.source).toBe('app');
  });

  it('inbound de cliente identificado carrega customer + contato', () => {
    const row = buildCallLogInsert({
      farmerId: 'f1',
      direction: 'inbound',
      provider: 'nvoip_sip',
      phoneRaw: '37999998888',
      party: { kind: 'cliente', customerUserId: 'c1', matchConfidence: 'last8', phoneNormalized: '37999998888', contactName: 'João' },
      recorded: true,
      sipCallId: 'sip-9',
    });
    expect(row.direction).toBe('inbound');
    expect(row.customer_user_id).toBe('c1');
    expect(row.match_confidence).toBe('last8');
    expect(row.display_name).toBe('João');
    expect(row.recorded).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar pra ver falhar**

Run: `bun run test src/lib/call-log/build-insert.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

```ts
// src/lib/call-log/build-insert.ts
import { normalizeBrPhone } from '@/lib/phone';
import type { CallDirection, CallProvider } from '@/types/call-log';
import type { ResolvedCallParty } from './recording-policy';

export interface BuildInsertArgs {
  farmerId: string;
  direction: CallDirection;
  provider: CallProvider;
  phoneRaw: string;
  party: ResolvedCallParty;
  recorded: boolean;
  callerIdUsed?: string | null;
  sipCallId?: string | null;
  providerCallId?: string | null;
}

/** Monta o objeto de insert da call_log no estado inicial 'ringing'. */
export function buildCallLogInsert(args: BuildInsertArgs) {
  return {
    farmer_id: args.farmerId,
    direction: args.direction,
    status: 'ringing' as const,
    provider: args.provider,
    provider_call_id: args.providerCallId ?? null,
    sip_call_id: args.sipCallId ?? null,
    customer_user_id: args.party.customerUserId,
    match_confidence: args.party.matchConfidence,
    display_name: args.party.contactName ?? null,
    phone_normalized: args.party.phoneNormalized || normalizeBrPhone(args.phoneRaw),
    phone_raw: args.phoneRaw,
    caller_id_used: args.callerIdUsed ?? null,
    recorded: args.recorded,
    source: 'app' as const,
  };
}
```

- [ ] **Step 4: Rodar pra ver passar**

Run: `bun run test src/lib/call-log/build-insert.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/call-log/build-insert.ts src/lib/call-log/build-insert.test.ts
git commit -m "feat(telefonia): buildCallLogInsert (payload puro)"
```

---

## Task 6: `record.ts` — camada de escrita (supabase)

**Files:**
- Create: `src/lib/call-log/record.ts`

Funções finas que escrevem na `call_log`. Usam `as any` (tipos gerados não têm a tabela). Fire-and-forget: erro loga, não quebra a chamada.

- [ ] **Step 1: Implementar**

```ts
// src/lib/call-log/record.ts
import { supabase } from '@/integrations/supabase/client';
import { buildCallLogInsert, type BuildInsertArgs } from './build-insert';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tbl = () => supabase.from('call_log') as any;

/** Cria a linha inicial (ringing). Idempotente por sip_call_id (ON CONFLICT DO NOTHING). */
export async function logCallStart(args: BuildInsertArgs): Promise<void> {
  try {
    const row = buildCallLogInsert(args);
    await tbl().upsert(row, { onConflict: 'provider,sip_call_id', ignoreDuplicates: true });
  } catch (e) {
    console.error('[call-log] logCallStart', e);
  }
}

/** Marca answered (condicional: só se ainda ringing — em multi-aba só quem atende ganha). */
export async function logAnswered(sipCallId: string): Promise<void> {
  try {
    await tbl().update({ status: 'answered', answered_at: new Date().toISOString() })
      .eq('sip_call_id', sipCallId).eq('status', 'ringing');
  } catch (e) { console.error('[call-log] logAnswered', e); }
}

/** Fecha a chamada: ended (atendida) ou missed/rejected (não). */
export async function logClosed(sipCallId: string, opts: { answered: boolean; rejected?: boolean; durationSeconds: number }): Promise<void> {
  try {
    const status = opts.answered ? 'ended' : opts.rejected ? 'rejected' : 'missed';
    await tbl().update({
      status,
      ended_at: new Date().toISOString(),
      duration_seconds: opts.durationSeconds,
    }).eq('sip_call_id', sipCallId).neq('status', 'ended');
  } catch (e) { console.error('[call-log] logClosed', e); }
}

/** Marca perdidas como lidas (zera badge). */
export async function acknowledgeMissed(farmerId: string): Promise<void> {
  try {
    await tbl().update({ acknowledged_at: new Date().toISOString() })
      .eq('farmer_id', farmerId).eq('direction', 'inbound').eq('status', 'missed').is('acknowledged_at', null);
  } catch (e) { console.error('[call-log] acknowledgeMissed', e); }
}
```

- [ ] **Step 2: Verificar typecheck/lint do arquivo**

Run: `bunx eslint src/lib/call-log/record.ts`
Expected: 0 erros (os `as any` têm disable inline via a const `tbl`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/call-log/record.ts
git commit -m "feat(telefonia): record.ts (escrita da call_log)"
```

---

## Task 7: SIP — propagar `sipCallId` + evento `incomingClosed`

**Files:**
- Modify: `src/lib/sip/types.ts`
- Modify: `src/lib/sip/sip-client.ts:56-72` e `:146-157`

- [ ] **Step 1: Estender os tipos**

Em `src/lib/sip/types.ts`, adicionar `sipCallId` a `IncomingCallInfo` e o evento `incomingClosed`:

```ts
export interface IncomingCallInfo {
  phone: string;
  displayName: string | null;
  receivedAt: number;
  /** SIP Call-ID (JsSIP session.id) — chave de dedup do call_log. */
  sipCallId: string;
}

export interface SipClientEvents {
  stateChange: (state: SipCallState) => void;
  localStream: (stream: MediaStream) => void;
  remoteStream: (stream: MediaStream) => void;
  error: (err: Error) => void;
  incomingCall: (info: IncomingCallInfo) => void;
  /** Sessão inbound terminou — answered (ended) ou não (missed/cancel). */
  incomingClosed: (info: { sipCallId: string; answered: boolean; durationSeconds: number }) => void;
}
```

- [ ] **Step 2: Emitir `sipCallId` no `incomingCall` + `incomingClosed`**

Em `src/lib/sip/sip-client.ts`, no handler `newRTCSession` (originator remote), substituir o bloco que emite `incomingCall` e o `session.on('failed', ...)`:

```ts
      this.pendingIncoming = session;

      const fromUri = session.remote_identity?.uri;
      const displayName = session.remote_identity?.display_name ?? null;
      const phone = fromUri?.user ?? 'desconhecido';
      const sipCallId: string = session.id;

      this.emit('incomingCall', { phone, displayName, receivedAt: Date.now(), sipCallId });

      // Caller cancelou antes do answer → missed
      session.on('failed', () => {
        if (this.pendingIncoming === session) {
          this.pendingIncoming = null;
          this.emit('incomingClosed', { sipCallId, answered: false, durationSeconds: 0 });
          this.emit('stateChange', 'idle');
        }
      });
```

Em `acceptIncoming`, capturar o `sipCallId` da sessão atendida e emitir `incomingClosed` ao terminar. Substituir os handlers `confirmed/failed/ended` por:

```ts
    const sipCallId: string = session.id;
    session.on('confirmed', () => this.extractRemoteStream());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.on('failed', (e: any) => {
      this.setState('failed');
      this.emit('incomingClosed', { sipCallId, answered: true, durationSeconds: this.getCallDurationSeconds() });
      this.emit('error', new Error(`Inbound call failed: ${e?.cause ?? 'unknown'}`));
    });
    session.on('ended', () => {
      this.setState('ended');
      this.emit('incomingClosed', { sipCallId, answered: true, durationSeconds: this.getCallDurationSeconds() });
    });
```

- [ ] **Step 3: Verificar build/lint**

Run: `bunx eslint src/lib/sip/sip-client.ts src/lib/sip/types.ts`
Expected: 0 erros novos.

- [ ] **Step 4: Commit**

```bash
git add src/lib/sip/types.ts src/lib/sip/sip-client.ts
git commit -m "feat(telefonia): SIP propaga sipCallId + evento incomingClosed"
```

---

## Task 8: `WebRTCCallContext` — captura inbound no call_log

**Files:**
- Modify: `src/contexts/WebRTCCallContext.tsx` (handler `incomingCall` ~165; `acceptIncoming`; `rejectIncoming`; novo handler `incomingClosed`)

- [ ] **Step 1: Importar helpers no topo**

```ts
import { resolveCallParty, shouldAutoRecord } from '@/lib/call-log/recording-policy';
import { logCallStart, logAnswered, logClosed } from '@/lib/call-log/record';
```

- [ ] **Step 2: No registro de listeners do SipClient (junto de `client.on('incomingCall', ...)`)**

Substituir o `client.on('incomingCall', (info) => setIncomingCall(info));` por:

```ts
        client.on('incomingCall', async (info) => {
          setIncomingCall(info);
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return;
          const party = await resolveCallParty(info.phone);
          await logCallStart({
            farmerId: user.id,
            direction: 'inbound',
            provider: 'nvoip_sip',
            phoneRaw: info.phone,
            party,
            recorded: shouldAutoRecord(party.kind),
            sipCallId: info.sipCallId,
          });
        });
        client.on('incomingClosed', async ({ sipCallId, answered, durationSeconds }) => {
          await logClosed(sipCallId, { answered, durationSeconds });
        });
```

- [ ] **Step 3: Em `acceptIncoming`** — após chamar `clientRef.current.acceptIncoming(...)`, registrar answered. Guardar o `sipCallId` da `incomingCall` atual num ref/closure. Adicionar logo após o accept bem-sucedido:

```ts
    if (incomingCall?.sipCallId) {
      await logAnswered(incomingCall.sipCallId);
    }
```

- [ ] **Step 4: Em `rejectIncoming`** — antes de limpar o `incomingCall`, marcar rejected:

```ts
    if (incomingCall?.sipCallId) {
      void logClosed(incomingCall.sipCallId, { answered: false, rejected: true, durationSeconds: 0 });
    }
```

- [ ] **Step 5: Rodar a suíte (regressão)**

Run: `bun run test`
Expected: PASS (nada quebrado; sem novos testes aqui — integração validada manualmente).

- [ ] **Step 6: Commit**

```bash
git add src/contexts/WebRTCCallContext.tsx
git commit -m "feat(telefonia): captura inbound (ringing/answered/rejected/closed) no call_log"
```

---

## Task 9: `WebRTCCallContext` — captura outbound + gating de gravação

**Files:**
- Modify: `src/contexts/WebRTCCallContext.tsx` (`makeCall` ~248; `persistCallSession` ~81)

A regra: outbound resolve a parte ANTES de conectar. Se `shouldAutoRecord(kind)` OU `forceRecord` → toca preroll + transcrição + persiste farmer_calls (fluxo atual). Senão → liga sem preroll/gravação/transcrição, e só registra no `call_log`.

- [ ] **Step 1: `makeCall` aceita opção `forceRecord` e grava call_log no início**

Mudar a assinatura `makeCall(phoneNumber: string)` → `makeCall(phoneNumber: string, opts?: { forceRecord?: boolean })`. No começo do `makeCall`, antes do mix de preroll:

```ts
    const { data: { user } } = await supabase.auth.getUser();
    const party = await resolveCallParty(phoneNumber);
    const record = (opts?.forceRecord ?? false) || shouldAutoRecord(party.kind);
    const sipCallId = crypto.randomUUID(); // dedup local até termos o id real do provider
    if (user) {
      await logCallStart({
        farmerId: user.id, direction: 'outbound', provider: 'nvoip_sip',
        phoneRaw: phoneNumber, party, recorded: record, sipCallId,
      });
    }
    dialedSipCallIdRef.current = sipCallId; // novo ref pra fechar no fim
```

Adicionar `const dialedSipCallIdRef = useRef<string | null>(null);` junto dos outros refs (~144).

- [ ] **Step 2: Gating do preroll/transcrição**

Envolver o trecho que mixa o preroll LGPD + inicia transcrição com `if (record) { ... } else { /* usa rawMic direto, sem preroll, sem transcription */ }`. Onde hoje o stream mixado é montado, quando `!record` passar `rawMic` direto pro `clientRef.current.makeCall(normalized, rawMic)` e NÃO setar `setPrerollPlaying`/iniciar Deepgram.

- [ ] **Step 3: Fechar o call_log no fim da chamada**

No `endCall`/quando a chamada termina (onde hoje chama `persistCallSession`), adicionar:

```ts
    if (dialedSipCallIdRef.current) {
      void logAnswered(dialedSipCallIdRef.current); // se chegou a established
      void logClosed(dialedSipCallIdRef.current, { answered: callStartedAtRef.current != null, durationSeconds: callDuration });
      dialedSipCallIdRef.current = null;
    }
```

- [ ] **Step 4: `persistCallSession` só roda se gravou**

Onde `persistCallSession(...)` é chamado no fim, condicionar a `if (record)` (guardar `record` num ref `recordingRef`). Se não gravou, NÃO cria farmer_calls/transcript.

- [ ] **Step 5: Atualizar tipo de `makeCall` na interface do context** (`WebRTCCallContextValue.makeCall`) e o `useNvoipCall.makeCall` (mesma assinatura `opts?: { forceRecord?: boolean }`, mesmo que o Nvoip ignore por ora). Atualizar `useCallBackend` consumidores se necessário (a assinatura é compatível — `opts` é opcional).

- [ ] **Step 6: Rodar a suíte**

Run: `bun run test`
Expected: PASS (regressão verde).

- [ ] **Step 7: Commit**

```bash
git add src/contexts/WebRTCCallContext.tsx src/hooks/useNvoipCall.ts
git commit -m "feat(telefonia): captura outbound + gating de gravação (cliente/fornecedor/forceRecord)"
```

---

## Task 10: `useCallLog` — query do histórico + acknowledge + contagem de perdidas

**Files:**
- Create: `src/hooks/useCallLog.ts`

- [ ] **Step 1: Implementar**

```ts
// src/hooks/useCallLog.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { acknowledgeMissed } from '@/lib/call-log/record';
import type { CallLogRow, CallDirection, CallStatus } from '@/types/call-log';

export type CallLogTab = 'recentes' | 'recebidas' | 'perdidas' | 'feitas' | 'time';

function applyTab(query: any, tab: CallLogTab, userId: string) {
  switch (tab) {
    case 'recebidas': return query.eq('direction', 'inbound').neq('status', 'missed');
    case 'perdidas': return query.eq('direction', 'inbound').eq('status', 'missed');
    case 'feitas': return query.eq('direction', 'outbound');
    case 'time': return query; // RLS de time já filtra; sem .eq farmer_id
    case 'recentes':
    default: return query;
  }
}

export function useCallLog(tab: CallLogTab, userId: string | undefined) {
  return useQuery({
    queryKey: ['call_log', tab, userId],
    enabled: !!userId,
    queryFn: async (): Promise<CallLogRow[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = (supabase.from('call_log') as any).select('*').order('started_at', { ascending: false }).limit(50);
      if (tab !== 'time') q = q.eq('farmer_id', userId);
      q = applyTab(q, tab, userId!);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as CallLogRow[];
    },
    staleTime: 30_000,
  });
}

export function useMissedCount(userId: string | undefined) {
  return useQuery({
    queryKey: ['call_log_missed_count', userId],
    enabled: !!userId,
    queryFn: async (): Promise<number> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count } = await (supabase.from('call_log') as any)
        .select('id', { count: 'exact', head: true })
        .eq('farmer_id', userId).eq('direction', 'inbound').eq('status', 'missed').is('acknowledged_at', null);
      return count ?? 0;
    },
    refetchInterval: 30_000,
  });
}

export function useAcknowledgeMissed(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => { if (userId) await acknowledgeMissed(userId); },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['call_log_missed_count', userId] });
      qc.invalidateQueries({ queryKey: ['call_log'] });
    },
  });
}
```

- [ ] **Step 2: Lint**

Run: `bunx eslint src/hooks/useCallLog.ts`
Expected: 0 erros (casts com disable).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useCallLog.ts
git commit -m "feat(telefonia): useCallLog (histórico + perdidas + acknowledge)"
```

---

## Task 11: `CallHistoryRow` — linha do histórico (BINA + ações)

**Files:**
- Create: `src/components/telefonia/CallHistoryRow.tsx`

- [ ] **Step 1: Implementar**

```tsx
// src/components/telefonia/CallHistoryRow.tsx
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Mic } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { formatBrPhone } from '@/lib/phone';
import { cn } from '@/lib/utils';
import type { CallLogRow } from '@/types/call-log';

const STATUS_LABEL: Record<string, string> = {
  ringing: 'tocando', answered: 'atendida', missed: 'perdida', rejected: 'rejeitada',
  busy: 'ocupado', failed: 'falhou', canceled: 'cancelada', ended: 'encerrada',
};

export function CallHistoryRow({ row, onCallBack }: { row: CallLogRow; onCallBack: (phone: string) => void }) {
  const navigate = useNavigate();
  const missed = row.direction === 'inbound' && row.status === 'missed';
  const Icon = missed ? PhoneMissed : row.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing;
  const phone = row.phone_raw ?? row.phone_normalized ?? '';
  const known = !!row.customer_user_id;
  const name = row.display_name ?? (known ? 'Cliente' : 'Desconhecido');

  return (
    <div className="flex items-center gap-3 border-b border-border py-2.5 text-sm">
      <span className={cn('flex h-7 w-7 items-center justify-center rounded-md',
        missed ? 'bg-status-error-bg text-status-error' :
        row.direction === 'inbound' ? 'bg-status-success-bg text-status-success' : 'bg-status-info-bg text-status-info')}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate flex items-center gap-1.5">
          {name}
          {row.recorded && <Mic className="h-3 w-3 text-muted-foreground" />}
        </p>
        <p className="text-xs text-muted-foreground">{formatBrPhone(phone)}</p>
      </div>
      <div className="text-right text-xs">
        <p className={cn(missed ? 'text-status-error font-medium' : 'text-muted-foreground')}>
          {STATUS_LABEL[row.status]}
        </p>
        <p className="text-muted-foreground">{new Date(row.started_at).toLocaleString('pt-BR')}</p>
      </div>
      <div className="flex gap-1">
        {known && (
          <Button size="sm" variant="ghost" className="h-7 text-xs"
            onClick={() => navigate(`/admin/customers/${row.customer_user_id}`)}>ver cliente</Button>
        )}
        <Button size="sm" variant="outline" className="h-7 text-xs"
          onClick={() => onCallBack(phone)}>religar</Button>
      </div>
    </div>
  );
}
```

> O nome vem de `row.display_name` (snapshot gravado na captura via `buildCallLogInsert`, Task 5) — sem join no front. Cai em "Cliente"/"Desconhecido" quando não há nome.

- [ ] **Step 2: Lint + commit**

```bash
bunx eslint src/components/telefonia/CallHistoryRow.tsx
git add src/components/telefonia/CallHistoryRow.tsx
git commit -m "feat(telefonia): CallHistoryRow (linha com BINA + ações)"
```

---

## Task 12: `CallHistoryTabs` — abas + lista + nomes

**Files:**
- Create: `src/components/telefonia/CallHistoryTabs.tsx`

- [ ] **Step 1: Implementar**

```tsx
// src/components/telefonia/CallHistoryTabs.tsx
import { useMemo, useEffect } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useCallLog, useAcknowledgeMissed, type CallLogTab } from '@/hooks/useCallLog';
import { CallHistoryRow } from './CallHistoryRow';
import { EmptyState } from '@/components/EmptyState';

const TABS: { id: CallLogTab; label: string }[] = [
  { id: 'recentes', label: 'Recentes' },
  { id: 'recebidas', label: 'Recebidas' },
  { id: 'perdidas', label: 'Perdidas' },
  { id: 'feitas', label: 'Feitas' },
];

export function CallHistoryTabs({
  userId, tab, onTabChange, onCallBack, isManager,
}: {
  userId: string | undefined; tab: CallLogTab; onTabChange: (t: CallLogTab) => void;
  onCallBack: (phone: string) => void; isManager: boolean;
}) {
  const { data: rows = [], isLoading } = useCallLog(tab, userId);
  const ack = useAcknowledgeMissed(userId);

  // Ao abrir a aba Perdidas, marca como lidas (zera badge)
  useEffect(() => { if (tab === 'perdidas') ack.mutate(); /* eslint-disable-next-line */ }, [tab]);

  const allTabs = useMemo(() => isManager ? [...TABS, { id: 'time' as CallLogTab, label: 'Time' }] : TABS, [isManager]);

  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as CallLogTab)}>
      <TabsList>{allTabs.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}</TabsList>
      <TabsContent value={tab} className="mt-3">
        {isLoading ? <p className="text-sm text-muted-foreground py-6 text-center">Carregando…</p>
          : rows.length === 0 ? <EmptyState tone="operational" title="Sem chamadas" description="Nada por aqui ainda." />
          : rows.map((r) => <CallHistoryRow key={r.id} row={r} onCallBack={onCallBack} />)}
      </TabsContent>
    </Tabs>
  );
}
```

- [ ] **Step 2: Lint + commit**

```bash
bunx eslint src/components/telefonia/CallHistoryTabs.tsx
git add src/components/telefonia/CallHistoryTabs.tsx
git commit -m "feat(telefonia): CallHistoryTabs (abas + lista + acknowledge ao abrir perdidas)"
```

---

## Task 13: `DialPad` — discador livre

**Files:**
- Create: `src/components/telefonia/DialPad.tsx`

- [ ] **Step 1: Implementar**

```tsx
// src/components/telefonia/DialPad.tsx
import { useState } from 'react';
import { Phone, Delete } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useCallBackend } from '@/hooks/useCallBackend';
import { formatBrPhone, normalizeBrPhone } from '@/lib/phone';

const KEYS = ['1','2','3','4','5','6','7','8','9','*','0','#'];

export function DialPad({ initialPhone = '' }: { initialPhone?: string }) {
  const [value, setValue] = useState(initialPhone);
  const [forceRecord, setForceRecord] = useState(false);
  const call = useCallBackend();
  const valid = normalizeBrPhone(value).length >= 10;

  return (
    <div className="w-full max-w-[240px] rounded-lg border border-border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">Discar</div>
      <div className="flex items-center gap-1">
        <Input value={value} onChange={(e) => setValue(e.target.value)}
          placeholder="número" className="text-center font-mono" />
        <Button size="icon" variant="ghost" className="h-9 w-9 shrink-0"
          onClick={() => setValue((v) => v.slice(0, -1))}><Delete className="h-4 w-4" /></Button>
      </div>
      <div className="grid grid-cols-3 gap-1.5 mt-2">
        {KEYS.map((k) => (
          <Button key={k} variant="outline" className="h-10" onClick={() => setValue((v) => v + k)}>{k}</Button>
        ))}
      </div>
      <div className="flex items-center justify-between mt-2 text-xs">
        <span className="text-muted-foreground">Gravar esta chamada</span>
        <Switch checked={forceRecord} onCheckedChange={setForceRecord} />
      </div>
      <Button className="w-full mt-2 bg-status-success hover:bg-status-success/90" disabled={!valid}
        onClick={() => call.makeCall(normalizeBrPhone(value), { forceRecord })}>
        <Phone className="h-4 w-4 mr-1.5" /> Ligar {valid ? formatBrPhone(value) : ''}
      </Button>
      <p className="text-[10px] text-center text-muted-foreground mt-1.5">
        backend: {call.backend.toUpperCase()} · cliente/fornecedor grava automático
      </p>
    </div>
  );
}
```

> Se `src/components/ui/switch.tsx` não existir, usar `bunx shadcn@latest add switch` — verificar antes em `src/components/ui/`.

- [ ] **Step 2: Lint + commit**

```bash
bunx eslint src/components/telefonia/DialPad.tsx
git add src/components/telefonia/DialPad.tsx
git commit -m "feat(telefonia): DialPad (discador livre + toggle gravar)"
```

---

## Task 14: `Telefonia` page + rota

**Files:**
- Create: `src/pages/Telefonia.tsx`
- Modify: `src/App.tsx` (lazy import + `<Route path="telefonia" ... />` dentro do grupo AppShellLayout)

- [ ] **Step 1: Página**

```tsx
// src/pages/Telefonia.tsx
import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { DialPad } from '@/components/telefonia/DialPad';
import { CallHistoryTabs } from '@/components/telefonia/CallHistoryTabs';
import { useCallBackend } from '@/hooks/useCallBackend';
import { useCommercialRole } from '@/hooks/useFarmerGovernance'; // ver Step 2
import type { CallLogTab } from '@/hooks/useCallLog';

export default function Telefonia() {
  const { user } = useAuth();
  const [tab, setTab] = useState<CallLogTab>('recentes');
  const [dialPrefill, setDialPrefill] = useState('');
  const call = useCallBackend();
  const isManager = useIsTelefoniaManager(); // helper: master OU commercial_role gerencial/estrategico/super_admin

  return (
    <div className="container py-6">
      <h1 className="text-xl font-semibold mb-4">Central de Telefonia</h1>
      <div className="flex flex-col md:flex-row gap-4">
        <DialPad key={dialPrefill} initialPhone={dialPrefill} />
        <div className="flex-1 rounded-lg border border-border bg-card p-3">
          <CallHistoryTabs
            userId={user?.id} tab={tab} onTabChange={setTab}
            isManager={isManager}
            onCallBack={(phone) => { setDialPrefill(phone); call.makeCall(phone); }}
          />
        </div>
      </div>
    </div>
  );
}
```

> **Step 1b — `useIsTelefoniaManager`:** criar um hook simples em `src/hooks/useIsTelefoniaManager.ts` que lê `commercial_roles` do usuário + app role. Reusar `useAuth().isMaster` + uma query de `commercial_role`. Retorna `true` se master OU `commercial_role IN ('gerencial','estrategico','super_admin')`.

```ts
// src/hooks/useIsTelefoniaManager.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export function useIsTelefoniaManager(): boolean {
  const { user, isMaster } = useAuth();
  const { data } = useQuery({
    queryKey: ['commercial_role', user?.id], enabled: !!user?.id,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase.from('commercial_roles') as any)
        .select('commercial_role').eq('user_id', user!.id).maybeSingle();
      return data?.commercial_role as string | undefined;
    },
  });
  return isMaster || ['gerencial', 'estrategico', 'super_admin'].includes(data ?? '');
}
```

Trocar o import/uso no `Telefonia.tsx` por esse hook.

- [ ] **Step 2: Rota em `src/App.tsx`**

Adicionar lazy import junto dos outros (~linha 60):
```ts
const Telefonia = lazy(() => import("./pages/Telefonia"));
```
E a rota dentro do grupo `<Route element={<ProtectedRoute><AppShellLayout /></ProtectedRoute>}>`:
```tsx
<Route path="telefonia" element={<Telefonia />} />
```

- [ ] **Step 3: Build pra validar lazy + tipos**

Run: `bun run build`
Expected: build OK (chunk de Telefonia gerado).

- [ ] **Step 4: Commit**

```bash
git add src/pages/Telefonia.tsx src/hooks/useIsTelefoniaManager.ts src/App.tsx
git commit -m "feat(telefonia): página /telefonia (discador + histórico) + rota"
```

---

## Task 15: Sidebar — item "Telefonia" + badge de perdidas

**Files:**
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1: Adicionar o item de menu na seção Vendas**

Localizar o array de itens da seção "Vendas" em `AppShell.tsx` e adicionar (seguindo o shape dos itens existentes — `{ icon, label, path }`):
```ts
{ icon: Phone, label: 'Telefonia', path: '/telefonia' },
```
Garantir `import { Phone } from 'lucide-react';` (já deve existir).

- [ ] **Step 2: Badge de perdidas não-lidas**

Usar `useMissedCount(user?.id)` (do `useCallLog`) e renderizar o badge vermelho no item "Telefonia" seguindo o MESMO padrão dos badges numéricos já existentes na sidebar (procurar por `Badge` / contadores em tempo real no `AppShell.tsx`). Mostrar o número só quando `> 0`.

- [ ] **Step 3: Build + lint**

Run: `bun run build && bunx eslint src/components/AppShell.tsx`
Expected: OK.

- [ ] **Step 4: Commit**

```bash
git add src/components/AppShell.tsx
git commit -m "feat(telefonia): item de menu Telefonia + badge de perdidas não-lidas"
```

---

## Task 16: Caller-ID único da empresa

**Files:**
- Modify: `supabase/functions/nvoip-sip-creds/index.ts`
- Migration/seed: chave `nvoip_outbound_caller_id` em `company_config`

A edge function hoje retorna `callerId: vendorCred.sip_caller_id` (por vendedor). Mudar pra um caller-ID único de empresa.

- [ ] **Step 1: Seed da config (SQL pro Lovable)**

```sql
INSERT INTO public.company_config (key, value)
VALUES ('nvoip_outbound_caller_id', '553735143571')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
SELECT 'caller id OK' AS status, value FROM public.company_config WHERE key='nvoip_outbound_caller_id';
```
> Confirmar com o Lucas o número/DID correto da empresa antes de inserir.

- [ ] **Step 2: `nvoip-sip-creds` lê o caller-ID de empresa**

No bloco do `vendorCred` (linhas 30-54), trocar `callerId: vendorCred.sip_caller_id ?? null` por uma leitura do `company_config`:

```ts
const { data: cfg } = await supabase
  .from("company_config").select("value").eq("key", "nvoip_outbound_caller_id").maybeSingle();
const companyCallerId = cfg?.value ?? null;
// ...no JSON de resposta:
callerId: companyCallerId ?? vendorCred.sip_caller_id ?? null,
```

- [ ] **Step 3: Gravar `caller_id_used` no call_log** — o `WebRTCCallContext.makeCall` já recebe as creds (`creds.callerId`); passar `callerIdUsed: creds.callerId` no `logCallStart` outbound (Task 9 Step 1).

- [ ] **Step 4: Commit + handoff de deploy**

```bash
git add supabase/functions/nvoip-sip-creds/index.ts
git commit -m "feat(telefonia): caller-ID único de empresa (company_config)"
```
> **Handoff:** edge function `nvoip-sip-creds` precisa ser **re-deployada via chat do Lovable** (CLAUDE.md §5). Entregar o SQL do Step 1 pro Lucas colar no SQL Editor.

---

## Task 17: Validação final

- [ ] **Step 1: Suíte + lint + build**

Run: `bun run test && bun run build`
Expected: testes verdes (incluindo os novos de recording-policy + build-insert), build OK.

- [ ] **Step 2: Lint dos arquivos tocados**

Run: `bunx eslint src/lib/call-log src/components/telefonia src/pages/Telefonia.tsx src/hooks/useCallLog.ts src/hooks/useIsTelefoniaManager.ts`
Expected: 0 erros.

- [ ] **Step 3: Abrir PR** (seguir `/ship` ou gh pr create) com a nota:
> **ATENÇÃO: migrations manuais necessárias** — colar no SQL Editor do Lovable: (1) `20260523120000_call_log.sql`, (2) seed `nvoip_outbound_caller_id`. **Re-deploy via chat Lovable:** `nvoip-sip-creds`.

---

## Itens fora deste plano (Fase 2 / dependências)
- Sync CDR/webhook do Nvoip (completude com app fechado) — depende de confirmação do suporte Nvoip.
- "Salvar como contato" do número avulso.
- Auto-detecção de fornecedor por telefone (sem dado no banco hoje).
- Ramais por vendedor + ring-group do DID único na Nvoip (operacional).
