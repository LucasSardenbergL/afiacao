# PR4 — Persistência de Sessão de Chamada Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando a chamada WebRTC termina, salvar automaticamente em `farmer_calls`: transcript completo (PR2), todas as análises SPIN/Challenger/JOLT geradas durante a chamada (PR3+PR3.5) e as entidades econômicas agregadas (`entitiesExtracted` deduplicadas). Vinculação automática a `customer_user_id` via match de telefone. Vendedor não precisa mais preencher formulário manual pra capturar contexto — só precisa preencher `revenue_generated`/`call_result`/`notes` depois (e mesmo isso fica opcional no rascunho).

**Architecture:** **Aproveita 100% da tabela `farmer_calls` existente** (que já tem `farmer_id`, `customer_user_id`, `started_at`, `ended_at`, `revenue_generated`, `margin_generated`, `linked_sales_order_id`, `call_result`, `call_type`, `notes`). Estende com 5 colunas: `transcript jsonb`, `analyses jsonb`, `entities_extracted jsonb`, `call_backend text`, `phone_dialed text`. `customer_user_id` vira nullable pra permitir auto-save mesmo quando cliente não tem perfil local. Lookup de telefone → `customer_user_id` via match em `profiles.phone` (regex normalizado). Wire no `WebRTCCallContext.endCall()` faz fire-and-forget insert.

**Tech Stack:** Supabase migration SQL · TypeScript helpers puros (TDD) · Vitest 3.2 · regex de normalização BR (`normalizeBrPhone` já existe em `src/lib/phone.ts`) · Edge function não é necessária (insert simples client-side com RLS já cobrindo segurança).

**Não-objetivos (PRs futuros):**
- UI pra editar/preencher `revenue_generated`/`call_result`/`notes` no rascunho auto-criado (segue no form manual atual em `FarmerCalls.tsx`)
- Vincular `linked_sales_order_id` automaticamente (PR10 — atribuição Omie)
- Histórico do cliente UI mostrando transcript+analyses (PR5)
- RLS auditing/refactor — não muda nada (vendedor já vê só suas, master vê todas)
- Migração retrospectiva de chamadas antigas (`farmer_calls` antigas não tem transcript — campos novos ficam NULL)
- Renomear `farmer_calls` pra `call_sessions` (refactor sem ganho, fica pra outro PR se justificado)

---

## File Structure

**Criar:**
- `supabase/migrations/{timestamp}_farmer_calls_persist_session.sql` — ALTER TABLE
- `src/lib/call-session/aggregate-entities.ts` — deduplica `ExtractedEntity[]` de várias análises
- `src/lib/call-session/aggregate-entities.test.ts` — testes
- `src/lib/call-session/build-session-payload.ts` — monta payload de insert a partir do estado do context
- `src/lib/call-session/build-session-payload.test.ts` — testes
- `src/lib/call-session/resolve-customer.ts` — lookup `phone → customer_user_id`
- `src/lib/call-session/resolve-customer.test.ts` — testes (mocka supabase)

**Modificar:**
- `src/integrations/supabase/types.ts` — adicionar 5 campos novos a `farmer_calls.Row/Insert/Update`. Manual nesta passagem; Lovable regenera quando rodar SQL editor.
- `src/contexts/WebRTCCallContext.tsx` — coletar `analysisHistory: SpinAnalysis[]` ao longo da chamada (push a cada nova análise via `useSpinAnalysis`); chamar persist no `endCall`
- `src/contexts/__tests__/WebRTCCallContext.test.tsx` — 1 teste novo: ao endCall, dispara insert

**Não modificar:**
- `src/pages/FarmerCalls.tsx` (form manual de revenue/notes continua igual; ganha capacidade de detectar rascunho auto-criado em PR5 — não aqui)
- `src/hooks/useSpinAnalysis.ts` (já expõe `analysis` reativo — basta consumir do context)

---

## Pré-requisito do operador (Lovable)

Antes de mergear o PR:
1. Rodar a migration SQL no Lovable Cloud SQL Editor (Lovable não auto-aplica migrations do GitHub).
2. Regenerar types Supabase (Lovable faz isso automático no próximo deploy ou via Cloud → Database → Generate Types).

Se a migration NÃO rodar antes do deploy:
- `endCall()` vai tentar inserir colunas que não existem → 500 silencioso (fire-and-forget, não bloqueia UI).
- Hook `useCallSession` (interno ao context) loga `console.error` mas não quebra chamada.
- **Vendedor não percebe nada** — chamada termina normalmente, só não salva contexto rico. Graceful degradation.

---

## Task 1: Migration SQL — estender `farmer_calls`

**Files:** Create `supabase/migrations/{timestamp}_farmer_calls_persist_session.sql`

- [ ] **Step 1: Criar migration**

Gerar timestamp atual no formato `YYYYMMDDHHMMSS`. Ex: `20260517160000_farmer_calls_persist_session.sql`.

```sql
-- PR4: Persistência de sessão de chamada
-- Estende farmer_calls com transcript, análises do copilot, entidades extraídas
-- e metadados de auto-save (backend usado, telefone discado).

-- 1. Permite customer_user_id ser null (auto-save antes de vincular cliente)
ALTER TABLE public.farmer_calls
  ALTER COLUMN customer_user_id DROP NOT NULL;

-- 2. Novas colunas
ALTER TABLE public.farmer_calls
  ADD COLUMN IF NOT EXISTS transcript jsonb,
  ADD COLUMN IF NOT EXISTS analyses jsonb,
  ADD COLUMN IF NOT EXISTS entities_extracted jsonb,
  ADD COLUMN IF NOT EXISTS call_backend text,
  ADD COLUMN IF NOT EXISTS phone_dialed text;

-- 3. Constraint de check pro call_backend (valores permitidos)
ALTER TABLE public.farmer_calls
  DROP CONSTRAINT IF EXISTS farmer_calls_call_backend_check;
ALTER TABLE public.farmer_calls
  ADD CONSTRAINT farmer_calls_call_backend_check
    CHECK (call_backend IS NULL OR call_backend IN ('nvoip', 'webrtc', 'manual'));

-- 4. Index parcial: chamadas com transcript (consultas de copilot history)
CREATE INDEX IF NOT EXISTS idx_farmer_calls_has_transcript
  ON public.farmer_calls (farmer_id, started_at DESC)
  WHERE transcript IS NOT NULL;

-- 5. Comentários (documentação no banco)
COMMENT ON COLUMN public.farmer_calls.transcript IS
  'Array de TranscriptTurnLite: [{ speaker, text, isFinal, startedAt }]. Capturado do PR2 (Deepgram).';
COMMENT ON COLUMN public.farmer_calls.analyses IS
  'Array de SpinAnalysis snapshots ao longo da chamada (cada vez que useSpinAnalysis disparou). Capturado do PR3+PR3.5.';
COMMENT ON COLUMN public.farmer_calls.entities_extracted IS
  'Array deduplicado de ExtractedEntity agregando todas as análises. Pronto pra alimentar perfil 360 do cliente (PR5).';
COMMENT ON COLUMN public.farmer_calls.call_backend IS
  'Qual backend foi usado: nvoip | webrtc | manual.';
COMMENT ON COLUMN public.farmer_calls.phone_dialed IS
  'Telefone normalizado (dígitos apenas) que foi discado. Útil quando customer_user_id ainda é NULL.';
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260517160000_farmer_calls_persist_session.sql
git commit -m "feat(call-session): migration ALTER farmer_calls add transcript/analyses/entities/backend/phone"
```

---

## Task 2: Atualizar types Supabase manualmente

**Files:** Modify `src/integrations/supabase/types.ts`

> NOTA: types geralmente são auto-gerados pelo Supabase CLI ou Lovable. Como o projeto é Lovable e não tem CLI ativo aqui, edito manualmente. Quando Lovable regerar (após operador rodar migration), pode haver merge — manter o diff cirúrgico minimiza conflito.

- [ ] **Step 1: Localizar bloco `farmer_calls`**

Em `src/integrations/supabase/types.ts` linha ~1404. Tem 3 sub-blocos: `Row`, `Insert`, `Update`. Cada um precisa dos 5 campos novos + `customer_user_id` opcional.

- [ ] **Step 2: Adicionar campos em `Row`** (todos opcionais, podem ser NULL em rows antigas):

```ts
Row: {
  // ... campos existentes ...
  customer_user_id: string | null  // ANTES: string (mudar pra | null)
  // ADICIONAR no fim, antes de }
  transcript: Json | null
  analyses: Json | null
  entities_extracted: Json | null
  call_backend: string | null
  phone_dialed: string | null
}
```

- [ ] **Step 3: Adicionar em `Insert` e `Update`** (mesmos campos, todos opcionais):

```ts
Insert: {
  customer_user_id?: string | null  // ANTES: customer_user_id: string
  transcript?: Json | null
  analyses?: Json | null
  entities_extracted?: Json | null
  call_backend?: string | null
  phone_dialed?: string | null
}
Update: {
  // mesmos campos, sempre opcionais
  customer_user_id?: string | null
  transcript?: Json | null
  analyses?: Json | null
  entities_extracted?: Json | null
  call_backend?: string | null
  phone_dialed?: string | null
}
```

- [ ] **Step 4: Verificar tsc**

```bash
bun run tsc --noEmit
```

Expected: clean. Se quebrar em algum lugar que assumia `customer_user_id` nunca null, **NÃO** mexer nos consumers nesta task — esses casos ficam pro PR5 (UI da lista de calls). Aqui, se necessário, adicionar `@ts-expect-error` localizado com TODO, ou usar `// eslint-disable` pra suprimir.

Se necessário, ajustar o tipo de `CallLog` em `FarmerCalls.tsx:48` pra refletir nullable, e validar com `?.` nos acessos.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/supabase/types.ts src/pages/FarmerCalls.tsx
git commit -m "feat(call-session): supabase types reflect new farmer_calls columns + nullable customer_user_id"
```

---

## Task 3: Helper `aggregateEntities` (TDD)

**Files:**
- Create: `src/lib/call-session/aggregate-entities.ts`
- Create: `src/lib/call-session/aggregate-entities.test.ts`

**Comportamento esperado:** recebe array de `SpinAnalysis[]` (snapshots ao longo da chamada), extrai todos os `entitiesExtracted`, deduplica por `(type, value normalizado em lowercase)`, agrega `confidence` (mantém o max), conta ocorrências e mantém o primeiro `context` capturado.

- [ ] **Step 1: Escrever testes**

```ts
// src/lib/call-session/aggregate-entities.test.ts
import { describe, it, expect } from 'vitest';
import { aggregateEntities } from './aggregate-entities';
import type { SpinAnalysis } from '@/lib/spin/types';

// Factory mínimo — preenche só os campos relevantes pro teste
const analysis = (entities: SpinAnalysis['entitiesExtracted']): SpinAnalysis => ({
  spinStage: 'situation',
  confidence: 0.8,
  playbook: 'discovery',
  whatClientRevealed: { situationFacts: [], problemsAdmitted: [], implications: [], desiredOutcomes: [] },
  nextBestAction: { type: 'question', spinType: 'situation', exactPhrasing: '', whyNow: '' },
  ticketLeverage: { tactic: 'none', suggestion: '' },
  risks: [],
  crossSellTriggers: [],
  entitiesExtracted: entities,
});

describe('aggregateEntities', () => {
  it('array vazio retorna array vazio', () => {
    expect(aggregateEntities([])).toEqual([]);
  });

  it('analyses sem entidades retorna array vazio', () => {
    const result = aggregateEntities([analysis([]), analysis([])]);
    expect(result).toEqual([]);
  });

  it('deduplica por (type, value lowercase)', () => {
    const result = aggregateEntities([
      analysis([{ type: 'competitor', value: 'Farben', context: 'compro farben', confidence: 0.7 }]),
      analysis([{ type: 'competitor', value: 'farben', context: 'farben de novo', confidence: 0.9 }]),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('Farben'); // mantém o primeiro valor (preserva casing)
    expect(result[0].occurrences).toBe(2);
    expect(result[0].confidence).toBe(0.9); // max
    expect(result[0].context).toBe('compro farben'); // primeiro
  });

  it('mantém entidades de tipos diferentes mesmo com mesmo value', () => {
    const result = aggregateEntities([
      analysis([
        { type: 'competitor', value: 'PU 6000', context: '', confidence: 0.8 },
        { type: 'product', value: 'PU 6000', context: '', confidence: 0.8 },
      ]),
    ]);
    expect(result).toHaveLength(2);
  });

  it('preserva ordem de primeira aparição', () => {
    const result = aggregateEntities([
      analysis([
        { type: 'competitor', value: 'Farben', context: '', confidence: 0.8 },
        { type: 'price', value: 'R$ 35/L', context: '', confidence: 0.7 },
      ]),
      analysis([
        { type: 'volume', value: '200L/mês', context: '', confidence: 0.9 },
      ]),
    ]);
    expect(result.map(e => e.type)).toEqual(['competitor', 'price', 'volume']);
  });

  it('soma occurrences corretamente em 3+ ocorrências da mesma entidade', () => {
    const result = aggregateEntities([
      analysis([{ type: 'competitor', value: 'Farben', context: '', confidence: 0.5 }]),
      analysis([{ type: 'competitor', value: 'Farben', context: '', confidence: 0.6 }]),
      analysis([{ type: 'competitor', value: 'farben', context: '', confidence: 0.8 }]),
    ]);
    expect(result[0].occurrences).toBe(3);
    expect(result[0].confidence).toBe(0.8);
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

```bash
bun run vitest run src/lib/call-session/aggregate-entities.test.ts
```

Expected: FAIL (`Cannot find module './aggregate-entities'`).

- [ ] **Step 3: Implementar**

```ts
// src/lib/call-session/aggregate-entities.ts
import type { ExtractedEntity, SpinAnalysis } from '@/lib/spin/types';

export interface AggregatedEntity extends ExtractedEntity {
  /** Quantas análises mencionaram essa entidade */
  occurrences: number;
}

/**
 * Recebe snapshots de SpinAnalysis ao longo da chamada e deduplica as entidades
 * extraídas por `(type, value lowercase)`. Mantém:
 * - primeiro `value` (preserva casing original)
 * - primeiro `context` capturado
 * - `confidence` = max de todas as ocorrências
 * - `occurrences` = total de vezes mencionada
 *
 * Output pronto pra ir em `farmer_calls.entities_extracted` (jsonb) e alimentar
 * perfil 360 do cliente no PR5.
 */
export function aggregateEntities(analyses: SpinAnalysis[]): AggregatedEntity[] {
  // Map de chave → entidade agregada. Map preserva ordem de inserção.
  const byKey = new Map<string, AggregatedEntity>();

  for (const a of analyses) {
    for (const entity of a.entitiesExtracted) {
      const key = `${entity.type}::${entity.value.trim().toLowerCase()}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.occurrences += 1;
        if (entity.confidence > existing.confidence) {
          existing.confidence = entity.confidence;
        }
      } else {
        byKey.set(key, { ...entity, occurrences: 1 });
      }
    }
  }

  return Array.from(byKey.values());
}
```

- [ ] **Step 4: Rodar — deve passar**

```bash
bun run vitest run src/lib/call-session/aggregate-entities.test.ts
```

Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/call-session/aggregate-entities.ts src/lib/call-session/aggregate-entities.test.ts
git commit -m "feat(call-session): aggregateEntities dedupes ExtractedEntity[] across analyses"
```

---

## Task 4: Helper `resolveCustomerByPhone` (TDD)

**Files:**
- Create: `src/lib/call-session/resolve-customer.ts`
- Create: `src/lib/call-session/resolve-customer.test.ts`

**Comportamento:** dado um telefone (string crua), normaliza pra dígitos só, busca em `profiles` por match normalizado, retorna `{ customerUserId: string | null, phoneDialed: string }`.

- [ ] **Step 1: Escrever testes**

```ts
// src/lib/call-session/resolve-customer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, maybeSingleMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  maybeSingleMock: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: fromMock },
}));

import { resolveCustomerByPhone } from './resolve-customer';

beforeEach(() => {
  vi.clearAllMocks();
  // Mock chain: supabase.from().select().filter().maybeSingle()
  const chain = {
    select: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    maybeSingle: maybeSingleMock,
  };
  fromMock.mockReturnValue(chain);
});

describe('resolveCustomerByPhone', () => {
  it('normaliza telefone pra dígitos só', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    const result = await resolveCustomerByPhone('(31) 99999-1234');
    expect(result.phoneDialed).toBe('31999991234');
  });

  it('retorna customerUserId quando encontra match', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { user_id: 'uuid-cliente-1' },
      error: null,
    });
    const result = await resolveCustomerByPhone('(31) 99999-1234');
    expect(result.customerUserId).toBe('uuid-cliente-1');
    expect(result.phoneDialed).toBe('31999991234');
  });

  it('retorna customerUserId=null quando não encontra', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    const result = await resolveCustomerByPhone('31999991234');
    expect(result.customerUserId).toBeNull();
    expect(result.phoneDialed).toBe('31999991234');
  });

  it('telefone vazio retorna ambos null/empty sem chamar supabase', async () => {
    const result = await resolveCustomerByPhone('');
    expect(result.customerUserId).toBeNull();
    expect(result.phoneDialed).toBe('');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('erro do supabase resulta em null silenciosamente', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: new Error('rls denied') });
    const result = await resolveCustomerByPhone('31999991234');
    expect(result.customerUserId).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

```bash
bun run vitest run src/lib/call-session/resolve-customer.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implementar**

```ts
// src/lib/call-session/resolve-customer.ts
import { supabase } from '@/integrations/supabase/client';

export interface ResolvedCustomer {
  /** UUID do profile do cliente; null se não encontrou match local */
  customerUserId: string | null;
  /** Telefone normalizado (dígitos apenas) — sempre preenchido pra fallback */
  phoneDialed: string;
}

/**
 * Busca em `profiles` por telefone normalizado e retorna o `user_id` do cliente.
 * Se não houver match, retorna `customerUserId: null` mas sempre preserva o
 * `phoneDialed` normalizado pra salvar em `farmer_calls.phone_dialed`.
 *
 * Vinculação posterior (operador clica "vincular cliente" na UI) pode atualizar
 * o registro depois — implementação futura no PR5.
 */
export async function resolveCustomerByPhone(rawPhone: string): Promise<ResolvedCustomer> {
  const phoneDialed = rawPhone.replace(/\D/g, '');

  if (!phoneDialed) {
    return { customerUserId: null, phoneDialed: '' };
  }

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id')
      // Match em regex normalizado (cobre formatos diversos no banco)
      .filter('phone', 'ilike', `%${phoneDialed.slice(-8)}%`)
      .maybeSingle();

    if (error || !data) {
      return { customerUserId: null, phoneDialed };
    }

    return { customerUserId: data.user_id, phoneDialed };
  } catch {
    return { customerUserId: null, phoneDialed };
  }
}
```

> **Decisão de design**: match em `phone ILIKE '%últimos 8 dígitos%'` é tolerante a variações de DDI/DDD no banco. Mais robusto seria query SQL com `regexp_replace`, mas exige RPC dedicada. ILIKE é "good enough" pra MVP — falsos positivos são raros (8 dígitos coincidentes é improvável); falsos negativos (perfil cadastrado sem DDD) viram `null` e cliente fica não-vinculado, vendedor resolve depois.

- [ ] **Step 4: Rodar — deve passar**

```bash
bun run vitest run src/lib/call-session/resolve-customer.test.ts
```

Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/call-session/resolve-customer.ts src/lib/call-session/resolve-customer.test.ts
git commit -m "feat(call-session): resolveCustomerByPhone matches profiles.phone via normalized digits"
```

---

## Task 5: Helper `buildSessionPayload` (TDD)

**Files:**
- Create: `src/lib/call-session/build-session-payload.ts`
- Create: `src/lib/call-session/build-session-payload.test.ts`

**Comportamento:** dado o estado capturado no fim da chamada (turns + analyses + metadata), monta o payload pronto pro `INSERT INTO farmer_calls`.

- [ ] **Step 1: Escrever testes**

```ts
// src/lib/call-session/build-session-payload.test.ts
import { describe, it, expect } from 'vitest';
import { buildSessionPayload } from './build-session-payload';
import type { SpinAnalysis } from '@/lib/spin/types';
import type { TranscriptTurn } from '@/lib/transcription/types';

const fakeAnalysis = (overrides: Partial<SpinAnalysis> = {}): SpinAnalysis => ({
  spinStage: 'situation',
  confidence: 0.7,
  playbook: 'discovery',
  whatClientRevealed: { situationFacts: [], problemsAdmitted: [], implications: [], desiredOutcomes: [] },
  nextBestAction: { type: 'question', spinType: 'situation', exactPhrasing: '', whyNow: '' },
  ticketLeverage: { tactic: 'none', suggestion: '' },
  risks: [],
  crossSellTriggers: [],
  entitiesExtracted: [],
  ...overrides,
});

const fakeTurn = (overrides: Partial<TranscriptTurn> = {}): TranscriptTurn => ({
  id: 't1',
  speaker: 'cliente',
  text: 'oi',
  isFinal: true,
  startedAt: 1000,
  endedAt: 2000,
  ...overrides,
});

describe('buildSessionPayload', () => {
  it('mapeia campos obrigatórios', () => {
    const payload = buildSessionPayload({
      farmerId: 'farmer-1',
      customerUserId: 'cliente-1',
      phoneDialed: '31999991234',
      callBackend: 'webrtc',
      startedAt: new Date('2026-05-17T10:00:00Z'),
      endedAt: new Date('2026-05-17T10:18:00Z'),
      turns: [fakeTurn()],
      analyses: [fakeAnalysis()],
    });

    expect(payload.farmer_id).toBe('farmer-1');
    expect(payload.customer_user_id).toBe('cliente-1');
    expect(payload.phone_dialed).toBe('31999991234');
    expect(payload.call_backend).toBe('webrtc');
    expect(payload.duration_seconds).toBe(1080); // 18min = 1080s
    expect(payload.call_type).toBe('venda'); // default no schema
    expect(payload.call_result).toBe('atendeu'); // default — vendedor edita depois
  });

  it('serializa turns como TranscriptTurnLite (sem id, sem endedAt)', () => {
    const payload = buildSessionPayload({
      farmerId: 'farmer-1',
      customerUserId: null,
      phoneDialed: '31999991234',
      callBackend: 'webrtc',
      startedAt: new Date(0),
      endedAt: new Date(1000),
      turns: [fakeTurn({ id: 'should-be-stripped', endedAt: 999 })],
      analyses: [],
    });

    const transcript = payload.transcript as Array<Record<string, unknown>>;
    expect(transcript[0]).toEqual({
      speaker: 'cliente',
      text: 'oi',
      isFinal: true,
      startedAt: 1000,
    });
    expect(transcript[0]).not.toHaveProperty('id');
    expect(transcript[0]).not.toHaveProperty('endedAt');
  });

  it('agrega entities das múltiplas análises', () => {
    const payload = buildSessionPayload({
      farmerId: 'farmer-1',
      customerUserId: null,
      phoneDialed: '',
      callBackend: 'webrtc',
      startedAt: new Date(0),
      endedAt: new Date(0),
      turns: [],
      analyses: [
        fakeAnalysis({ entitiesExtracted: [{ type: 'competitor', value: 'Farben', context: '', confidence: 0.7 }] }),
        fakeAnalysis({ entitiesExtracted: [{ type: 'competitor', value: 'farben', context: '', confidence: 0.9 }] }),
      ],
    });

    const entities = payload.entities_extracted as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ type: 'competitor', value: 'Farben', occurrences: 2, confidence: 0.9 });
  });

  it('chamada sem analyses gera analyses=[] e entities=[]', () => {
    const payload = buildSessionPayload({
      farmerId: 'farmer-1',
      customerUserId: null,
      phoneDialed: '',
      callBackend: 'webrtc',
      startedAt: new Date(0),
      endedAt: new Date(0),
      turns: [],
      analyses: [],
    });

    expect(payload.analyses).toEqual([]);
    expect(payload.entities_extracted).toEqual([]);
  });

  it('duration_seconds=0 quando ended_at <= started_at', () => {
    const payload = buildSessionPayload({
      farmerId: 'farmer-1',
      customerUserId: null,
      phoneDialed: '',
      callBackend: 'webrtc',
      startedAt: new Date(1000),
      endedAt: new Date(500),
      turns: [],
      analyses: [],
    });

    expect(payload.duration_seconds).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

```bash
bun run vitest run src/lib/call-session/build-session-payload.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implementar**

```ts
// src/lib/call-session/build-session-payload.ts
import type { SpinAnalysis } from '@/lib/spin/types';
import type { TranscriptTurn } from '@/lib/transcription/types';
import { aggregateEntities } from './aggregate-entities';

export interface BuildSessionPayloadInput {
  farmerId: string;
  customerUserId: string | null;
  phoneDialed: string;
  callBackend: 'webrtc' | 'nvoip' | 'manual';
  startedAt: Date;
  endedAt: Date;
  turns: TranscriptTurn[];
  analyses: SpinAnalysis[];
}

/** Subset de Insert<farmer_calls> que este helper preenche */
export interface SessionPayload {
  farmer_id: string;
  customer_user_id: string | null;
  phone_dialed: string;
  call_backend: 'webrtc' | 'nvoip' | 'manual';
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  transcript: unknown;          // jsonb
  analyses: unknown;            // jsonb
  entities_extracted: unknown;  // jsonb
  // defaults pra campos que vendedor edita depois
  call_type: string;
  call_result: string;
}

/**
 * Monta o payload pronto pra `supabase.from('farmer_calls').insert(payload)`.
 * Defaults conservadores em call_type e call_result — vendedor edita pelo form.
 */
export function buildSessionPayload(input: BuildSessionPayloadInput): SessionPayload {
  const durationMs = input.endedAt.getTime() - input.startedAt.getTime();
  const durationSeconds = durationMs > 0 ? Math.round(durationMs / 1000) : 0;

  // TranscriptTurn → TranscriptTurnLite (sem id/endedAt — fica jsonb mais leve)
  const transcriptLite = input.turns.map((t) => ({
    speaker: t.speaker,
    text: t.text,
    isFinal: t.isFinal,
    startedAt: t.startedAt,
  }));

  const entities = aggregateEntities(input.analyses);

  return {
    farmer_id: input.farmerId,
    customer_user_id: input.customerUserId,
    phone_dialed: input.phoneDialed,
    call_backend: input.callBackend,
    started_at: input.startedAt.toISOString(),
    ended_at: input.endedAt.toISOString(),
    duration_seconds: durationSeconds,
    transcript: transcriptLite,
    analyses: input.analyses,
    entities_extracted: entities,
    // Defaults — vendedor edita depois no form
    call_type: 'venda',
    call_result: 'atendeu',
  };
}
```

- [ ] **Step 4: Rodar — deve passar**

```bash
bun run vitest run src/lib/call-session/build-session-payload.test.ts
```

Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/call-session/build-session-payload.ts src/lib/call-session/build-session-payload.test.ts
git commit -m "feat(call-session): buildSessionPayload assembles farmer_calls insert payload"
```

---

## Task 6: Wire no `WebRTCCallContext`

**Files:**
- Modify: `src/contexts/WebRTCCallContext.tsx`
- Modify: `src/contexts/__tests__/WebRTCCallContext.test.tsx`

**Comportamento:**
- Acumular cada `SpinAnalysis` que o hook `useSpinAnalysis` produz num ref `analysisHistoryRef`.
- Em `endCall()`: ANTES de cleanup, capturar snapshot (turns, analyses, started_at, ended_at, phone_dialed) e disparar fire-and-forget insert (não bloqueia UI).
- Em caso de erro do insert: `console.error` apenas. Não toast, não modal. UI seguinte é responsabilidade do PR5.
- Resetar `analysisHistoryRef` em cada `makeCall()` novo.

- [ ] **Step 1: Ler arquivo atual** pra entender:
   - Onde `useTranscription` e `useSpinAnalysis` são chamados (Tasks 5+ do PR3)
   - Onde `analysisHistoryRef.current = []` deve ser resetado (no `makeCall`)
   - Onde fica o `endCall` — precisa do auth user (`supabase.auth.getUser()`)
   - Como conhecer o `phoneDialed` (state do componente, vem do makeCall)

- [ ] **Step 2: Imports + state novo**

```ts
import { useEffect, useRef } from 'react'; // useRef já existe; manter
import { supabase } from '@/integrations/supabase/client';
import { resolveCustomerByPhone } from '@/lib/call-session/resolve-customer';
import { buildSessionPayload } from '@/lib/call-session/build-session-payload';
import type { SpinAnalysis } from '@/lib/spin/types';
```

Dentro do Provider, adicionar refs:

```ts
const analysisHistoryRef = useRef<SpinAnalysis[]>([]);
const dialedPhoneRef = useRef<string>('');
const callStartedAtRef = useRef<Date | null>(null);
```

- [ ] **Step 3: Capturar análises ao longo da chamada**

Logo após o `const spin = useSpinAnalysis({ ... })` existente, adicionar:

```ts
// Acumula cada nova análise (deduplicada por referência — se mesmo objeto, ignora)
useEffect(() => {
  if (spin.analysis && !analysisHistoryRef.current.includes(spin.analysis)) {
    analysisHistoryRef.current.push(spin.analysis);
  }
}, [spin.analysis]);
```

- [ ] **Step 4: Resetar refs no `makeCall`**

No início do `makeCall(phoneNumber)`, ANTES de qualquer outra coisa:

```ts
analysisHistoryRef.current = [];
dialedPhoneRef.current = phoneNumber;
callStartedAtRef.current = new Date();
```

- [ ] **Step 5: Persistir no `endCall`**

ANTES de qualquer cleanup ou state reset, capturar e disparar (fire-and-forget):

```ts
// Persistir sessão antes do cleanup (fire-and-forget — não bloqueia UI)
const startedAt = callStartedAtRef.current;
const turnsSnapshot = transcription.turns;
const analysesSnapshot = [...analysisHistoryRef.current];
const dialedPhone = dialedPhoneRef.current;

if (startedAt && (turnsSnapshot.length > 0 || analysesSnapshot.length > 0)) {
  void persistCallSession({
    startedAt,
    endedAt: new Date(),
    turns: turnsSnapshot,
    analyses: analysesSnapshot,
    dialedPhone,
  });
}
```

E definir `persistCallSession` como função privada FORA do `useCallback`/render (pra não ser recriada):

```ts
async function persistCallSession(opts: {
  startedAt: Date;
  endedAt: Date;
  turns: TranscriptTurn[];
  analyses: SpinAnalysis[];
  dialedPhone: string;
}) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { customerUserId, phoneDialed } = await resolveCustomerByPhone(opts.dialedPhone);

    const payload = buildSessionPayload({
      farmerId: user.id,
      customerUserId,
      phoneDialed,
      callBackend: 'webrtc',
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      turns: opts.turns,
      analyses: opts.analyses,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await supabase.from('farmer_calls').insert(payload as any);
    if (error) {
      console.error('[WebRTCCallContext] persistCallSession failed:', error);
    }
  } catch (err) {
    console.error('[WebRTCCallContext] persistCallSession error:', err);
  }
}
```

`as any` no insert é temporário até types regenerarem com os novos campos (regeneração acontece quando operador roda a migration no Lovable).

- [ ] **Step 6: Atualizar mock de useSpinAnalysis nos testes**

Em `src/contexts/__tests__/WebRTCCallContext.test.tsx`, garantir que o mock devolve uma análise mutável (pro effect rodar). Já existente da PR3.5 deve estar OK; **adicionar 1 teste novo**:

```tsx
it('endCall dispara persistência da sessão quando há transcript ou análises', async () => {
  // Mock supabase.from('farmer_calls').insert
  const insertMock = vi.fn().mockResolvedValue({ error: null });
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    if (table === 'farmer_calls') {
      return { insert: insertMock } as any;
    }
    // fallback existente
    return { select: vi.fn().mockReturnThis(), filter: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) } as any;
  });

  // Setup: render provider, simular makeCall + 1 turn + endCall
  // (adaptar ao padrão existente do arquivo de testes — pode usar setTimeout/act)

  // Assertion mínima: insertMock foi chamado com payload contendo farmer_id e call_backend
  await waitFor(() => {
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        farmer_id: expect.any(String),
        call_backend: 'webrtc',
        transcript: expect.any(Array),
        analyses: expect.any(Array),
        entities_extracted: expect.any(Array),
      })
    );
  });
});
```

> Se o teste ficar complexo demais por causa dos mocks já existentes (SipClient, useTranscription, useSpinAnalysis), simplifica pra um teste mais rasteiro que só chame `persistCallSession` direto via export auxiliar — ou pula o teste e cobre via integration no PR5. Não bloquear PR4 por causa de 1 teste de integração.

- [ ] **Step 7: Verificar**

```bash
bun run tsc --noEmit
bun run vitest run
```

Expected: clean + 207 + (5+5+5+1) = 223 testes passing.

- [ ] **Step 8: Commit**

```bash
git add src/contexts/WebRTCCallContext.tsx src/contexts/__tests__/WebRTCCallContext.test.tsx
git commit -m "feat(call-session): WebRTCCallContext.endCall auto-persists session to farmer_calls"
```

---

## Task 7: QA + PR

- [ ] **Step 1: Suite completa**

```bash
bun run vitest run
```

Expected: ~223 passing.

- [ ] **Step 2: Lint dos arquivos tocados**

```bash
bun lint 2>&1 | grep -E "call-session|farmer_calls|WebRTCCallContext" | head -10
```

Expected: zero erros (a não ser pré-existentes documentados em CLAUDE.md §10).

- [ ] **Step 3: TypeScript**

```bash
bun run tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Build production**

```bash
bun build
```

Expected: passa.

- [ ] **Step 5: Push + PR**

```bash
git push -u origin claude/pr4-call-session-persistence
gh pr create --base main --head claude/pr4-call-session-persistence \
  --title "feat: persistência de sessão de chamada — transcript + analyses + entities (PR4)" \
  --body "..."
```

Body do PR:

```md
## Summary

PR4 — Quando chamada WebRTC termina, salva **automaticamente** em `farmer_calls`:
- `transcript` (turns Deepgram do PR2)
- `analyses` (todas as `SpinAnalysis` geradas durante a chamada — PR3+PR3.5)
- `entities_extracted` (deduplicado de concorrentes/preços/volumes/produtos citados)
- `call_backend = 'webrtc'`
- `phone_dialed` normalizado

Vinculação automática a `customer_user_id` via match de telefone em `profiles`. Se não acha, `customer_user_id = NULL` e vendedor vincula depois.

**Vendedor não preenche mais formulário pra capturar contexto** — chamada termina, rascunho fica salvo. Form manual atual segue existindo pra editar `revenue_generated`/`call_result`/`notes` depois (PR5 vai dar UI dedicada).

### Mudanças

- **Migration**: estende `farmer_calls` com 5 colunas + `customer_user_id` nullable + index parcial pra queries de "chamadas com transcript".
- **3 helpers TDD** em `src/lib/call-session/`: `aggregateEntities`, `resolveCustomerByPhone`, `buildSessionPayload` (15 testes).
- **`WebRTCCallContext`**: refs acumulam análises ao longo da chamada; `endCall()` dispara fire-and-forget insert antes do cleanup.

### Pré-requisito de deploy

1. Rodar a migration SQL manualmente no Lovable Cloud SQL Editor (Lovable não auto-aplica de GitHub).
2. Regenerar types Supabase (Cloud → Database → Generate Types) — depois disso, remover o `as any` no insert.

Sem migration rodada → insert retorna 500, fire-and-forget loga `console.error`, **chamada termina normalmente**. Graceful degradation.

### Não incluso

- UI pra ver/editar transcript+analyses salvos → PR5 (histórico do cliente)
- Vincular `customer_user_id` posterior pra rascunhos não-vinculados → PR5
- Atribuição automática de `revenue_generated`/`linked_sales_order_id` via cross-ref Omie → PR10

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-Review

**1. Spec coverage:**

| Spec | Task |
|---|---|
| Salvar transcript+analyses+entities por chamada | Tasks 1, 5, 6 |
| Vincular cliente automaticamente | Task 4 (resolveCustomerByPhone) |
| Não bloquear UI / fire-and-forget | Task 6 (try/catch, void promise) |
| Estender `farmer_calls` (não criar tabela nova) | Task 1 (ALTER) |
| Aproveitar campos existentes (revenue/margin/sales_order) | Task 1 (mantém todos os campos atuais) |
| Customer pode ser NULL quando não há perfil local | Task 1 (DROP NOT NULL) |

**2. Placeholder scan:** Sem TBD. Cada step tem código completo.

**3. Type consistency:**

- `SpinAnalysis` (de `@/lib/spin/types`) — usado em aggregate-entities, build-session-payload, WebRTCCallContext
- `TranscriptTurn` (de `@/lib/transcription/types`) — usado em build-session-payload e WebRTCCallContext
- `ExtractedEntity` → `AggregatedEntity` (extends adicionando `occurrences`) → vai pro `entities_extracted` jsonb
- Migration adiciona colunas; types.ts reflete; insert client preenche; PR5 vai consumir

**4. Riscos:**

- **Match de telefone via ILIKE `%últimos 8 dígitos%`** pode dar falso-positivo em escala (improvável até ~10k clientes; raro acima). PR posterior pode refatorar pra função SQL com regexp_replace + index.
- **`as any` no insert** é débito técnico até types regenerarem. Documentado como TODO no commit.
- **Teste de integração da Task 6** pode ficar frágil — mocks de SipClient + useTranscription + useSpinAnalysis no mesmo teste. Plan permite simplificar pra teste unit-level se virar pesadelo de mock.
- **Tamanho de jsonb**: chamada de 30min com 60 análises + 200 turns pode dar ~50-100KB de jsonb. Postgres lida bem; index parcial cuida da consulta. Nenhum problema esperado.
- **Lovable e migrations**: se operador esquecer de rodar migration antes do deploy, persistência silenciosamente falha. Mitigação: log explícito + documentado no PR body.

---

## Execution Handoff

Plan salvo em `docs/superpowers/plans/2026-05-17-pr4-call-session-persistence.md`.

Execução: **Subagent-Driven**. Tasks 1+2 (SQL+types) podem ir num subagent só. Tasks 3, 4, 5 são helpers TDD isolados — 1 subagent cada. Task 6 (wire) e 7 (PR) ficam no main agent porque cruzam o context inteiro.
