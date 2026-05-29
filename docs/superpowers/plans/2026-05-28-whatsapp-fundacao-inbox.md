# WhatsApp Fundação — Conectividade + Inbox + Webhook (PR1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma inbox de WhatsApp dentro do OS que recebe mensagens do número central (via 360dialog), persiste, casa com o cliente pelo telefone, roteia pro operador e deixa o staff ver as threads e responder texto livre dentro da janela de 24h. (Sem IA de orçamento — isso é o PR3; sem disparo por rota — PR2.)

**Architecture:** WhatsApp Cloud API (via 360dialog) → webhook edge function `whatsapp-inbound` (verifica segredo, dedup por `wa_message_id`, persiste cru + normalizado, casa cliente, upsert conversa) → Supabase Realtime empurra pra inbox React. Resposta do staff via edge function `whatsapp-send` (360dialog API, gated staff, checa janela 24h). Lógica pura (parser do payload, chave de telefone, janela 24h) isolada em `src/lib/whatsapp/` com testes vitest; edge functions e UI montam em volta.

**Tech Stack:** Supabase (Postgres + Deno edge functions), 360dialog (WhatsApp Cloud API BSP), React + Vite + TypeScript, @tanstack/react-query, Supabase Realtime, vitest. Migrations aplicadas via Lovable SQL Editor; edge functions deployadas via chat do Lovable (ver CLAUDE.md §5).

**Spec:** [docs/superpowers/specs/2026-05-28-whatsapp-ia-orcamento-design.md](../specs/2026-05-28-whatsapp-ia-orcamento-design.md)

---

## Pré-requisitos do FOUNDER (não-código — gatilham o teste ao vivo, não os testes unitários)

Estes itens são do Lucas/operacional. O código e os testes unitários do PR1 podem ser feitos **sem** eles; só o teste end-to-end ao vivo depende deles.

- [ ] **Conta 360dialog criada + número central da empresa onboardado** na Cloud API (verificação do Meta Business Manager). Anotar: `phone_number_id` e a base URL da API.
- [ ] **Secrets no Lovable** (Edge Functions → Secrets, via chat do Lovable): `D360_API_KEY` (chave da 360dialog), `D360_BASE_URL` (ex.: `https://waba-v2.360dialog.io`), `WHATSAPP_WEBHOOK_SECRET` (segredo forte que a gente gera p/ proteger o webhook). `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` já existem.
- [ ] **Webhook configurado na 360dialog** apontando pra `https://<projeto>.supabase.co/functions/v1/whatsapp-inbound?token=<WHATSAPP_WEBHOOK_SECRET>` (a 360dialog roteia inbound pra essa URL).
- [ ] **LGPD:** confirmar DPA/retenção-zero com a Anthropic e definir a base legal do opt-in (decisão de produto; o opt-in em si é PR2).

> Se a conta 360dialog ainda não existir quando o PR1 começar, implemente e rode os **testes unitários** normalmente; marque o **teste ao vivo** (Task 9) como bloqueado até o número estar ativo.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `supabase/migrations/20260528140000_whatsapp_fundacao.sql` | Tabelas `whatsapp_webhook_events`, `whatsapp_conversations`, `whatsapp_messages` + RLS | Criar (entregar SQL p/ Lovable) |
| `src/lib/whatsapp/inbound.ts` | Helpers PUROS: `waPhoneCandidates`, `parseInboundWebhook`, `is24hWindowOpen` | Criar |
| `src/lib/whatsapp/inbound.test.ts` | Testes vitest dos helpers puros | Criar |
| `supabase/functions/whatsapp-inbound/index.ts` | Webhook: verifica segredo, dedup, persiste, casa cliente, upsert conversa, 200 rápido | Criar (deploy via Lovable) |
| `supabase/functions/whatsapp-send/index.ts` | Enviar texto via 360dialog (gated staff, checa janela 24h) | Criar (deploy via Lovable) |
| `supabase/config.toml` | Registrar as 2 functions com `verify_jwt = false` | Modificar |
| `src/queries/useWhatsappInbox.ts` | `useWhatsappConversations` + `useWhatsappThread` (React Query) + Realtime | Criar |
| `src/hooks/useSendWhatsapp.ts` | `useSendWhatsapp` (mutation → invoca `whatsapp-send`) | Criar |
| `src/pages/WhatsappInbox.tsx` | Página da inbox (lista de conversas + thread + composer) | Criar |
| `src/App.tsx` | Rota lazy `/whatsapp` (staff-gated) | Modificar |
| `src/components/AppShell.tsx` | Item de navegação "WhatsApp" (staff) | Modificar |

**Assignment de operador no PR1 = mínimo:** `assigned_operator_id` = dono da carteira do cliente, se houver (`carteira_assignments.owner_user_id`), senão `null` (fila "sem dono"). Todo staff enxerga todas as conversas. A camada de atribuição operacional completa (§7a/§14) é PR2.

---

## Task 1: Migração — tabelas da fundação

**Files:**
- Create: `supabase/migrations/20260528140000_whatsapp_fundacao.sql`

- [ ] **Step 1: Criar o arquivo de migração**

```sql
-- WhatsApp Fundação (PR1): inbox do número central. Tabelas de eventos crus (auditoria/dedup),
-- conversas (1 por telefone, roteada por operador) e mensagens (in/out). RLS: só staff
-- (employee/master) lê/escreve via app; service_role (edge functions) bypassa.
-- Dedup idempotente via UNIQUE(wa_message_id) em whatsapp_messages.

-- 1) Eventos crus do webhook (auditoria; processamento assíncrono)
CREATE TABLE IF NOT EXISTS public.whatsapp_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

-- 2) Conversas: 1 por telefone (chave normalizada). Reabrimos a mesma conversa quando o cliente volta.
CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_key text NOT NULL UNIQUE,
  phone_e164 text,
  contact_name text,
  customer_user_id uuid,
  assigned_operator_id uuid,
  status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','aguardando_cliente','fechada')),
  opt_in_status text NOT NULL DEFAULT 'unknown',
  last_inbound_at timestamptz,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_conv_customer ON public.whatsapp_conversations(customer_user_id);
CREATE INDEX IF NOT EXISTS idx_wa_conv_operator ON public.whatsapp_conversations(assigned_operator_id);
CREATE INDEX IF NOT EXISTS idx_wa_conv_last_msg ON public.whatsapp_conversations(last_message_at DESC);

-- 3) Mensagens (in/out). UNIQUE(wa_message_id) = idempotência do webhook.
CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  wa_message_id text UNIQUE,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  type text NOT NULL DEFAULT 'text' CHECK (type IN ('text','audio','image','template','system')),
  body text,
  media_id text,
  media_url text,
  transcript text,
  status text,
  sender_user_id uuid,
  wa_timestamp timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_msg_conv ON public.whatsapp_messages(conversation_id, created_at);

-- RLS
ALTER TABLE public.whatsapp_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

-- Helper inline de staff (employee/master). service_role bypassa RLS automaticamente.
CREATE POLICY "wa_events_staff_select" ON public.whatsapp_webhook_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));

CREATE POLICY "wa_conv_staff_all" ON public.whatsapp_conversations
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));

CREATE POLICY "wa_msg_staff_all" ON public.whatsapp_messages
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_messages;
```

- [ ] **Step 2: Entregar o SQL pro founder aplicar no Lovable**

Postar na conversa: "🟣 Lovable → SQL Editor → cola o bloco → Run". (Migration custom NÃO é aplicada sozinha pelo Lovable — ver CLAUDE.md §5.)

- [ ] **Step 3: Validar o apply (query de checagem pro SQL Editor)**

```sql
SELECT 'WA FUNDACAO OK' AS status,
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('whatsapp_webhook_events','whatsapp_conversations','whatsapp_messages')) AS tabelas,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'whatsapp_%') AS policies;
```
Esperado: `tabelas = 3`, `policies = 3`.

- [ ] **Step 4: Regenerar o audit + commitar a migração**

```bash
bun run audit:migrations
git add supabase/migrations/20260528140000_whatsapp_fundacao.sql docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "feat(whatsapp): migration fundacao — conversations/messages/webhook_events + RLS"
```

---

## Task 2: Helper puro — `waPhoneCandidates` (casar telefone WA com cliente)

WhatsApp entrega o número em E.164 sem `+` (ex.: `553798765432` ou `5537998765432`). O banco guarda em formatos variados e tem o problema do **9º dígito** (móveis antigos sem o 9). `waPhoneCandidates` gera as variantes pra casar contra `profiles.phone` / `addresses` etc.

**Files:**
- Create: `src/lib/whatsapp/inbound.ts`
- Test: `src/lib/whatsapp/inbound.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```typescript
// src/lib/whatsapp/inbound.test.ts
import { describe, it, expect } from 'vitest';
import { waPhoneCandidates } from './inbound';

describe('waPhoneCandidates', () => {
  it('normaliza E.164 do WhatsApp (móvel 13 dígitos) e gera variante sem o 9', () => {
    const c = waPhoneCandidates('5537998765432'); // 55 + 37 + 9 8765 4321
    expect(c).toContain('37998765432'); // com 9
    expect(c).toContain('3798765432');  // sem 9 (cadastro antigo)
  });

  it('normaliza fixo (12 dígitos) sem inventar 9', () => {
    const c = waPhoneCandidates('553733334444'); // 55 + 37 + 3333 4444
    expect(c).toContain('3733334444');
    expect(c).not.toContain('37933334444');
  });

  it('aceita número já sem 55 e com máscara', () => {
    const c = waPhoneCandidates('(37) 99876-5432');
    expect(c).toContain('37998765432');
  });

  it('retorna vazio pra entrada inválida', () => {
    expect(waPhoneCandidates('')).toEqual([]);
    expect(waPhoneCandidates(null as unknown as string)).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bunx vitest run src/lib/whatsapp/inbound.test.ts -t waPhoneCandidates`
Esperado: FAIL ("waPhoneCandidates is not exported" / não definido).

- [ ] **Step 3: Implementar o mínimo**

```typescript
// src/lib/whatsapp/inbound.ts

/** Gera variantes de um telefone (E.164 do WhatsApp ou cadastro) pra casar com o cliente.
 *  Lida com prefixo 55 e o 9º dígito de móveis BR. Retorna só dígitos. */
export function waPhoneCandidates(input: string | null | undefined): string[] {
  if (!input) return [];
  let d = String(input).replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2); // tira código do país
  d = d.replace(/^0+/, '');
  if (d.length < 10) return [];
  const out = new Set<string>([d]);
  // DDD (2) + número. Móvel = 9 dígitos (começa com 9); fixo = 8.
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  if (rest.length === 9 && rest.startsWith('9')) {
    out.add(ddd + rest.slice(1)); // variante SEM o 9 (cadastro antigo)
  } else if (rest.length === 8 && /^[6-9]/.test(rest)) {
    out.add(ddd + '9' + rest); // variante COM o 9
  }
  return [...out];
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bunx vitest run src/lib/whatsapp/inbound.test.ts -t waPhoneCandidates`
Esperado: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/inbound.ts src/lib/whatsapp/inbound.test.ts
git commit -m "feat(whatsapp): waPhoneCandidates — casa telefone WA com cliente (9º dígito)"
```

---

## Task 3: Helper puro — `parseInboundWebhook`

Extrai as mensagens do payload do webhook (formato Meta/360dialog) numa forma normalizada. Ignora payloads de status/sem-mensagem (retorna `[]`).

**Files:**
- Modify: `src/lib/whatsapp/inbound.ts`
- Test: `src/lib/whatsapp/inbound.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```typescript
// adicionar em src/lib/whatsapp/inbound.test.ts
import { parseInboundWebhook } from './inbound';

describe('parseInboundWebhook', () => {
  const textPayload = {
    entry: [{ changes: [{ value: {
      contacts: [{ profile: { name: 'Marcenaria Silva' }, wa_id: '5537998765432' }],
      messages: [{ from: '5537998765432', id: 'wamid.ABC', timestamp: '1716900000', type: 'text', text: { body: 'preciso de lixa 120' } }],
    } }] }],
  };

  it('extrai mensagem de texto com remetente, id, corpo, nome e timestamp', () => {
    const r = parseInboundWebhook(textPayload);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      waMessageId: 'wamid.ABC',
      fromPhone: '5537998765432',
      type: 'text',
      body: 'preciso de lixa 120',
      contactName: 'Marcenaria Silva',
    });
    expect(r[0].waTimestamp).toBeInstanceOf(Date);
  });

  it('extrai áudio com media_id e body nulo', () => {
    const p = { entry: [{ changes: [{ value: {
      messages: [{ from: '5537998765432', id: 'wamid.AUD', timestamp: '1716900001', type: 'audio', audio: { id: 'media-1' } }],
    } }] }] };
    const r = parseInboundWebhook(p);
    expect(r[0]).toMatchObject({ type: 'audio', mediaId: 'media-1', body: null });
  });

  it('retorna [] pra payload de status (sem messages)', () => {
    const status = { entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.X', status: 'delivered' }] } }] }] };
    expect(parseInboundWebhook(status)).toEqual([]);
  });

  it('retorna [] pra payload malformado/nulo', () => {
    expect(parseInboundWebhook(null)).toEqual([]);
    expect(parseInboundWebhook({})).toEqual([]);
    expect(parseInboundWebhook({ entry: [{}] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bunx vitest run src/lib/whatsapp/inbound.test.ts -t parseInboundWebhook`
Esperado: FAIL (não exportado).

- [ ] **Step 3: Implementar o mínimo**

```typescript
// adicionar em src/lib/whatsapp/inbound.ts

export interface ParsedInbound {
  waMessageId: string;
  fromPhone: string;
  type: 'text' | 'audio' | 'image' | 'template' | 'system';
  body: string | null;
  mediaId: string | null;
  contactName: string | null;
  waTimestamp: Date | null;
}

const KNOWN_TYPES = new Set(['text', 'audio', 'image']);

export function parseInboundWebhook(payload: unknown): ParsedInbound[] {
  const out: ParsedInbound[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      const messages = value?.messages as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(messages)) continue;
      const contacts = value?.contacts as Array<{ profile?: { name?: string } }> | undefined;
      const contactName = contacts?.[0]?.profile?.name ?? null;
      for (const m of messages) {
        const rawType = String(m.type ?? '');
        const type = (KNOWN_TYPES.has(rawType) ? rawType : 'system') as ParsedInbound['type'];
        const tsRaw = m.timestamp ? Number(m.timestamp) : NaN;
        out.push({
          waMessageId: String(m.id ?? ''),
          fromPhone: String(m.from ?? ''),
          type,
          body: type === 'text' ? String((m.text as { body?: string })?.body ?? '') : null,
          mediaId:
            (m.audio as { id?: string })?.id ??
            (m.image as { id?: string })?.id ??
            null,
          contactName,
          waTimestamp: Number.isFinite(tsRaw) ? new Date(tsRaw * 1000) : null,
        });
      }
    }
  }
  return out.filter((x) => x.waMessageId && x.fromPhone);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bunx vitest run src/lib/whatsapp/inbound.test.ts -t parseInboundWebhook`
Esperado: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/inbound.ts src/lib/whatsapp/inbound.test.ts
git commit -m "feat(whatsapp): parseInboundWebhook — normaliza payload Meta/360 (texto/áudio/imagem)"
```

---

## Task 4: Helper puro — `is24hWindowOpen`

**Files:**
- Modify: `src/lib/whatsapp/inbound.ts`
- Test: `src/lib/whatsapp/inbound.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```typescript
// adicionar em src/lib/whatsapp/inbound.test.ts
import { is24hWindowOpen } from './inbound';

describe('is24hWindowOpen', () => {
  const now = new Date('2026-05-28T15:00:00Z');
  it('aberta se última entrada do cliente < 24h', () => {
    expect(is24hWindowOpen(new Date('2026-05-28T10:00:00Z'), now)).toBe(true);
  });
  it('fechada se >= 24h', () => {
    expect(is24hWindowOpen(new Date('2026-05-27T14:59:00Z'), now)).toBe(false);
  });
  it('fechada se nunca houve entrada', () => {
    expect(is24hWindowOpen(null, now)).toBe(false);
  });
  it('aceita string ISO', () => {
    expect(is24hWindowOpen('2026-05-28T14:00:00Z', now)).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bunx vitest run src/lib/whatsapp/inbound.test.ts -t is24hWindowOpen`
Esperado: FAIL.

- [ ] **Step 3: Implementar o mínimo**

```typescript
// adicionar em src/lib/whatsapp/inbound.ts

/** A janela de serviço de 24h conta da ÚLTIMA mensagem do cliente. */
export function is24hWindowOpen(lastInboundAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!lastInboundAt) return false;
  const t = lastInboundAt instanceof Date ? lastInboundAt.getTime() : new Date(lastInboundAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < 24 * 60 * 60 * 1000;
}
```

- [ ] **Step 4: Rodar e ver passar (suite inteira do arquivo)**

Run: `bunx vitest run src/lib/whatsapp/inbound.test.ts`
Esperado: PASS (todos: waPhoneCandidates + parseInboundWebhook + is24hWindowOpen).

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/inbound.ts src/lib/whatsapp/inbound.test.ts
git commit -m "feat(whatsapp): is24hWindowOpen — janela de serviço de 24h"
```

---

## Task 5: Edge function `whatsapp-inbound` (webhook)

Verifica o segredo (header `x-whatsapp-secret` OU query `?token=`), responde 200 rápido, e processa: dedup por `wa_message_id`, persiste cru, casa cliente pelos `waPhoneCandidates`, faz upsert da conversa (1 por `phone_key`), insere a mensagem, atualiza `last_inbound_at`/`last_message_at` e reabre (`status='aberta'`).

**Files:**
- Create: `supabase/functions/whatsapp-inbound/index.ts`
- Modify: `supabase/config.toml`

- [ ] **Step 1: Escrever o index.ts**

```typescript
// supabase/functions/whatsapp-inbound/index.ts
import { createClient } from "npm:@supabase/supabase-js@2";

// Espelho do helper puro testado em src/lib/whatsapp/inbound.ts (Deno não importa do src/).
function waPhoneCandidates(input: string | null | undefined): string[] {
  if (!input) return [];
  let d = String(input).replace(/\D/g, "");
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  d = d.replace(/^0+/, "");
  if (d.length < 10) return [];
  const out = new Set<string>([d]);
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  if (rest.length === 9 && rest.startsWith("9")) out.add(ddd + rest.slice(1));
  else if (rest.length === 8 && /^[6-9]/.test(rest)) out.add(ddd + "9" + rest);
  return [...out];
}

interface ParsedInbound {
  waMessageId: string; fromPhone: string;
  type: "text" | "audio" | "image" | "template" | "system";
  body: string | null; mediaId: string | null; contactName: string | null; waTimestamp: Date | null;
}
const KNOWN = new Set(["text", "audio", "image"]);
function parseInboundWebhook(payload: unknown): ParsedInbound[] {
  const out: ParsedInbound[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      const messages = value?.messages as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(messages)) continue;
      const contacts = value?.contacts as Array<{ profile?: { name?: string } }> | undefined;
      const contactName = contacts?.[0]?.profile?.name ?? null;
      for (const m of messages) {
        const rawType = String(m.type ?? "");
        const type = (KNOWN.has(rawType) ? rawType : "system") as ParsedInbound["type"];
        const ts = m.timestamp ? Number(m.timestamp) : NaN;
        out.push({
          waMessageId: String(m.id ?? ""), fromPhone: String(m.from ?? ""), type,
          body: type === "text" ? String((m.text as { body?: string })?.body ?? "") : null,
          mediaId: (m.audio as { id?: string })?.id ?? (m.image as { id?: string })?.id ?? null,
          contactName, waTimestamp: Number.isFinite(ts) ? new Date(ts * 1000) : null,
        });
      }
    }
  }
  return out.filter((x) => x.waMessageId && x.fromPhone);
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function matchCustomer(supabase: ReturnType<typeof createClient>, fromPhone: string): Promise<string | null> {
  const cands = waPhoneCandidates(fromPhone);
  if (cands.length === 0) return null;
  const { data } = await supabase.from("profiles").select("user_id, phone").not("phone", "is", null);
  // Casa pelo conjunto de candidatos normalizados (telefone do cadastro é texto livre).
  for (const p of (data ?? []) as Array<{ user_id: string; phone: string }>) {
    const pc = waPhoneCandidates(p.phone);
    if (pc.some((x) => cands.includes(x))) return p.user_id;
  }
  return null;
}

async function processMessage(supabase: ReturnType<typeof createClient>, msg: ParsedInbound) {
  const phoneKey = waPhoneCandidates(msg.fromPhone)[0] ?? msg.fromPhone.replace(/\D/g, "");
  const customerUserId = await matchCustomer(supabase, msg.fromPhone);
  let operatorId: string | null = null;
  if (customerUserId) {
    const { data: ca } = await supabase.from("carteira_assignments")
      .select("owner_user_id").eq("customer_user_id", customerUserId).limit(1).maybeSingle();
    operatorId = (ca as { owner_user_id?: string } | null)?.owner_user_id ?? null;
  }
  const nowIso = new Date().toISOString();
  // Upsert conversa por phone_key; reabre e seta last_inbound_at.
  const { data: conv } = await supabase.from("whatsapp_conversations").upsert({
    phone_key: phoneKey, phone_e164: msg.fromPhone, contact_name: msg.contactName,
    customer_user_id: customerUserId, assigned_operator_id: operatorId,
    status: "aberta", last_inbound_at: nowIso, last_message_at: nowIso,
  }, { onConflict: "phone_key" }).select("id").single();
  const conversationId = (conv as { id: string }).id;
  // Insere a mensagem (idempotente via UNIQUE(wa_message_id)).
  await supabase.from("whatsapp_messages").insert({
    conversation_id: conversationId, wa_message_id: msg.waMessageId, direction: "in",
    type: msg.type, body: msg.body, media_id: msg.mediaId,
    wa_timestamp: msg.waTimestamp?.toISOString() ?? null,
  });
}

Deno.serve(async (req) => {
  // 1) Verifica segredo (header OU query token).
  const expected = Deno.env.get("WHATSAPP_WEBHOOK_SECRET");
  const provided = req.headers.get("x-whatsapp-secret") ?? new URL(req.url).searchParams.get("token") ?? "";
  if (!expected || !timingSafeEq(expected, provided)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  let payload: unknown;
  try { payload = await req.json(); } catch { return new Response(JSON.stringify({ ok: true, ignored: "no-json" }), { status: 200 }); }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  await supabase.from("whatsapp_webhook_events").insert({ payload });

  const messages = parseInboundWebhook(payload);
  const work = (async () => { for (const m of messages) { try { await processMessage(supabase, m); } catch (e) { console.error("[whatsapp-inbound] processMessage", e); } } })();
  // @ts-ignore EdgeRuntime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(work); else await work;

  return new Response(JSON.stringify({ ok: true, received: messages.length }), { status: 200, headers: { "Content-Type": "application/json" } });
});
```

- [ ] **Step 2: Registrar no config.toml**

Adicionar em `supabase/config.toml`:
```toml
[functions.whatsapp-inbound]
verify_jwt = false
```

- [ ] **Step 3: Commit do código**

```bash
git add supabase/functions/whatsapp-inbound/index.ts supabase/config.toml
git commit -m "feat(whatsapp): edge whatsapp-inbound — webhook (verify, dedup, match, upsert conversa)"
```

- [ ] **Step 4: Deploy via Lovable + handoff**

Montar o prompt pro chat do Lovable: "Create a new Supabase edge function named `whatsapp-inbound`, read the code from `supabase/functions/whatsapp-inbound/index.ts` in the repo and deploy it verbatim (do not modify)." Founder cola, confirma "Active" no Cloud → Edge functions. (CLAUDE.md §5.)

---

## Task 6: Edge function `whatsapp-send` (responder texto)

Recebe `{ conversationId, text }` de um staff (gated por `authorizeCronOrStaff`), checa a janela de 24h (texto livre só é grátis/permitido dentro dela), envia via 360dialog, e grava a mensagem `out`.

**Files:**
- Create: `supabase/functions/whatsapp-send/index.ts`
- Modify: `supabase/config.toml`

- [ ] **Step 1: Escrever o index.ts**

```typescript
// supabase/functions/whatsapp-send/index.ts
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const D360_BASE = Deno.env.get("D360_BASE_URL")!;       // ex.: https://waba-v2.360dialog.io
const D360_KEY = Deno.env.get("D360_API_KEY")!;

function is24hWindowOpen(lastInboundAt: string | null, now = new Date()): boolean {
  if (!lastInboundAt) return false;
  const t = new Date(lastInboundAt).getTime();
  return Number.isFinite(t) && now.getTime() - t < 24 * 60 * 60 * 1000;
}

Deno.serve(async (req) => {
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const { conversationId, text } = await req.json().catch(() => ({}));
  if (!conversationId || !text) return new Response(JSON.stringify({ error: "conversationId e text obrigatórios" }), { status: 400 });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: conv, error: cErr } = await supabase.from("whatsapp_conversations")
    .select("phone_e164, last_inbound_at").eq("id", conversationId).single();
  if (cErr || !conv) return new Response(JSON.stringify({ error: "conversa não encontrada" }), { status: 404 });

  if (!is24hWindowOpen((conv as { last_inbound_at: string | null }).last_inbound_at)) {
    return new Response(JSON.stringify({ error: "window_closed", detail: "Janela de 24h fechada — use template (PR2)" }), { status: 409 });
  }

  const to = (conv as { phone_e164: string }).phone_e164.replace(/\D/g, "");
  const resp = await fetch(`${D360_BASE}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "D360-API-KEY": D360_KEY },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error("[whatsapp-send] 360dialog erro", resp.status, result);
    return new Response(JSON.stringify({ error: "send_failed", status: resp.status, detail: result }), { status: 502 });
  }
  const waId = (result as { messages?: Array<{ id?: string }> })?.messages?.[0]?.id ?? null;
  const nowIso = new Date().toISOString();
  await supabase.from("whatsapp_messages").insert({
    conversation_id: conversationId, wa_message_id: waId, direction: "out", type: "text",
    body: text, status: "sent", sender_user_id: auth.via === "staff" ? auth.userId : null, wa_timestamp: nowIso,
  });
  await supabase.from("whatsapp_conversations").update({ last_message_at: nowIso, status: "aguardando_cliente" }).eq("id", conversationId);

  return new Response(JSON.stringify({ ok: true, wa_message_id: waId }), { status: 200, headers: { "Content-Type": "application/json" } });
});
```

- [ ] **Step 2: Registrar no config.toml**

```toml
[functions.whatsapp-send]
verify_jwt = false
```
(Gateamento é via `authorizeCronOrStaff` — JWT do staff no header Authorization.)

- [ ] **Step 3: Commit + deploy via Lovable**

```bash
git add supabase/functions/whatsapp-send/index.ts supabase/config.toml
git commit -m "feat(whatsapp): edge whatsapp-send — resposta texto (gated staff + janela 24h)"
```
Prompt pro Lovable: "Create edge function `whatsapp-send` from `supabase/functions/whatsapp-send/index.ts`, deploy verbatim." Confirmar "Active".

---

## Task 7: Frontend — hooks de inbox (React Query + Realtime)

**Files:**
- Create: `src/queries/useWhatsappInbox.ts`
- Create: `src/hooks/useSendWhatsapp.ts`

- [ ] **Step 1: `useWhatsappInbox.ts` (lista + thread + Realtime)**

```typescript
// src/queries/useWhatsappInbox.ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface WaConversation {
  id: string; phone_e164: string | null; contact_name: string | null;
  customer_user_id: string | null; assigned_operator_id: string | null;
  status: string; last_inbound_at: string | null; last_message_at: string | null;
}
export interface WaMessage {
  id: string; conversation_id: string; direction: 'in' | 'out'; type: string;
  body: string | null; status: string | null; created_at: string; wa_timestamp: string | null;
}

export function useWhatsappConversations() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['whatsapp', 'conversations'],
    queryFn: async () => {
      const { data, error } = await supabase.from('whatsapp_conversations')
        .select('*').order('last_message_at', { ascending: false, nullsFirst: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as WaConversation[];
    },
  });
  useEffect(() => {
    const channel = supabase.channel('wa-conversations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_conversations' },
        () => qc.invalidateQueries({ queryKey: ['whatsapp', 'conversations'] }))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [qc]);
  return q;
}

export function useWhatsappThread(conversationId: string | undefined) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['whatsapp', 'thread', conversationId],
    queryFn: async () => {
      const { data, error } = await supabase.from('whatsapp_messages')
        .select('*').eq('conversation_id', conversationId!).order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as WaMessage[];
    },
    enabled: !!conversationId,
  });
  useEffect(() => {
    if (!conversationId) return;
    const channel = supabase.channel(`wa-thread-${conversationId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'whatsapp_messages', filter: `conversation_id=eq.${conversationId}` },
        () => qc.invalidateQueries({ queryKey: ['whatsapp', 'thread', conversationId] }))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [conversationId, qc]);
  return q;
}
```

- [ ] **Step 2: `useSendWhatsapp.ts` (mutation → edge `whatsapp-send`)**

```typescript
// src/hooks/useSendWhatsapp.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export function useSendWhatsapp(conversationId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      const { data, error } = await supabase.functions.invoke('whatsapp-send', {
        body: { conversationId, text },
      });
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string; detail?: string }).error);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp', 'thread', conversationId] }),
    onError: (e: Error) => {
      toast.error(e.message === 'window_closed' ? 'Janela de 24h fechada — precisa de template (PR2).' : 'Falha ao enviar.');
    },
  });
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `bunx tsc --noEmit -p tsconfig.app.json`
Esperado: sem novos erros nos arquivos criados.
```bash
git add src/queries/useWhatsappInbox.ts src/hooks/useSendWhatsapp.ts
git commit -m "feat(whatsapp): hooks de inbox (conversas/thread Realtime + envio)"
```

---

## Task 8: Frontend — página da inbox + rota + nav

**Files:**
- Create: `src/pages/WhatsappInbox.tsx`
- Modify: `src/App.tsx` (rota lazy `/whatsapp`)
- Modify: `src/components/AppShell.tsx` (item de nav, staff)

- [ ] **Step 1: Página da inbox**

```tsx
// src/pages/WhatsappInbox.tsx
import { useState } from 'react';
import { useWhatsappConversations, useWhatsappThread } from '@/queries/useWhatsappInbox';
import { useSendWhatsapp } from '@/hooks/useSendWhatsapp';
import { formatBrPhone } from '@/lib/phone';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/EmptyState';

export default function WhatsappInbox() {
  const { data: conversations = [] } = useWhatsappConversations();
  const [activeId, setActiveId] = useState<string | undefined>();
  const { data: messages = [] } = useWhatsappThread(activeId);
  const send = useSendWhatsapp(activeId);
  const [draft, setDraft] = useState('');

  return (
    <div className="flex h-[calc(100vh-var(--topbar))]">
      <aside className="w-80 border-r overflow-y-auto">
        {conversations.length === 0 ? (
          <EmptyState tone="operational" title="Sem conversas" description="As conversas aparecem quando um cliente responde." />
        ) : conversations.map((c) => (
          <button key={c.id} onClick={() => setActiveId(c.id)}
            className={`block w-full text-left p-3 border-b hover:bg-muted ${activeId === c.id ? 'bg-muted' : ''}`}>
            <div className="font-medium">{c.contact_name ?? formatBrPhone(c.phone_e164)}</div>
            <div className="text-xs text-muted-foreground">{c.status}{c.customer_user_id ? '' : ' · sem cadastro'}</div>
          </button>
        ))}
      </aside>
      <main className="flex-1 flex flex-col">
        {!activeId ? (
          <EmptyState tone="operational" title="Selecione uma conversa" description="" />
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {messages.map((m) => (
                <div key={m.id} className={`max-w-[70%] rounded p-2 text-sm ${m.direction === 'out' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted'}`}>
                  {m.type === 'text' ? m.body : `[${m.type}]`}
                </div>
              ))}
            </div>
            <form className="p-3 border-t flex gap-2"
              onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { send.mutate(draft.trim()); setDraft(''); } }}>
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Responder…" />
              <Button type="submit" disabled={send.isPending}>Enviar</Button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Rota lazy em `src/App.tsx`**

Adicionar junto às outras rotas lazy (seguir o padrão de `App.tsx:16-136`):
```tsx
const WhatsappInbox = lazy(() => import('./pages/WhatsappInbox'));
// ...dentro das <Route> protegidas por staff:
<Route path="/whatsapp" element={<WhatsappInbox />} />
```

- [ ] **Step 3: Item de nav em `src/components/AppShell.tsx`**

Adicionar na seção apropriada (ex.: Vendas/Principal), gated por `isStaff` (seguir o padrão dos itens existentes do AppShell): rótulo "WhatsApp", rota `/whatsapp`, ícone `MessageCircle` do lucide.

- [ ] **Step 4: Typecheck + build + commit**

Run: `bunx tsc --noEmit -p tsconfig.app.json && bun run build`
Esperado: sem erros; build OK.
```bash
git add src/pages/WhatsappInbox.tsx src/App.tsx src/components/AppShell.tsx
git commit -m "feat(whatsapp): página da inbox + rota /whatsapp + nav (staff)"
```

---

## Task 9: Validação end-to-end (BLOQUEADA até o número 360dialog estar ativo)

- [ ] **Step 1:** Com o número ativo e o webhook apontado, mandar uma mensagem de teste do seu celular pro número central.
- [ ] **Step 2:** Conferir no SQL Editor que chegou:
```sql
SELECT direction, type, body, created_at FROM whatsapp_messages ORDER BY created_at DESC LIMIT 5;
SELECT phone_e164, contact_name, customer_user_id, status FROM whatsapp_conversations ORDER BY last_message_at DESC LIMIT 5;
```
Esperado: 1 mensagem `in`; 1 conversa (com `customer_user_id` preenchido se o telefone casar com um cadastro).
- [ ] **Step 3:** Abrir `/whatsapp` no app, ver a conversa via Realtime, responder texto, confirmar que chega no celular e grava `out`.
- [ ] **Step 4:** Esperar >24h (ou forçar `last_inbound_at` antigo numa conversa de teste) e confirmar que o envio retorna `window_closed` (409) — prova o gate da janela.

> ⚠️ O `/browse` headless do gstack NÃO renderiza esta SPA (CLAUDE.md §5) — o smoke de UI é no Chrome real do founder. O maior sinal é o backend (queries acima).

---

## Self-Review (preenchido)

**1. Cobertura do spec (PR1 = fundação):** canal central via 360dialog ✓ (Task 5/6 + prereqs); inbox no OS ✓ (Task 7/8); webhook verify+dedup+persist ✓ (Task 5); match por telefone ✓ (Task 2/5); atribuição operacional mínima ✓ (Task 5, completa em PR2); janela 24h no envio ✓ (Task 4/6); RLS staff ✓ (Task 1). **Fora do PR1 (próximos planos):** opt-in/disparo por rota (PR2), pipeline de extração IA + accept-a-proposal + margem/gap (PR3), observabilidade Sentinela (PR4). Áudio: a mensagem `audio` é persistida com `media_id`; transcrição/download é PR3.

**2. Placeholders:** nenhum "TODO/TBD"; todo passo tem código/comando reais.

**3. Consistência de tipos:** `waPhoneCandidates`/`parseInboundWebhook`/`is24hWindowOpen` definidos na Task 2-4 e espelhados verbatim no edge (Task 5/6); `WaConversation`/`WaMessage` (Task 7) batem com as colunas da migração (Task 1); `whatsapp-send` espera `{ conversationId, text }` e o hook envia exatamente isso.

**4. Ambiguidade:** o segredo do webhook aceita header `x-whatsapp-secret` OU query `?token=` (a 360dialog roteia por URL) — explícito na Task 5.

---

## Decisões deixadas pro PR2/PR3 (não esquecer)
- Camada de **atribuição operacional** completa (§7a) — depende da query de cobertura cidade→vendedora (§14 #1).
- **Opt-in** (`whatsapp_opt_in`) + STOP/"PARAR" + **motor de disparo por rota** com **abertura accept-a-proposal** (§8/§11b) — PR2.
- **Pipeline pricing-safe** (extração→candidatos→preço determinístico→portões de confiança→guarda de margem→gap de cesta) + **transcrição de áudio** — PR3.
- **Observabilidade** (webhook/envio/preço/Omie) no padrão Sentinela — PR4.
- O espelhamento dos helpers puros no Deno (Task 5/6) deve ficar **verbatim** com `src/lib/whatsapp/inbound.ts`; se mudar um, mude o outro (mesma disciplina dos helpers financeiros).
