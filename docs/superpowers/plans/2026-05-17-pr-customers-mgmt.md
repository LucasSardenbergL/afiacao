# PR-CUSTOMERS-MGMT — Criar prospect a partir de chamada órfã

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Quando cliente novo liga pra loja (chamada inbound do PR-INBOUND-CALLS), e `farmer_calls.customer_user_id = NULL`, vai pra `/farmer/calls/pending-link`. Vendedor já podia "Vincular cliente existente" — agora ganha botão **"🆕 Criar cliente novo"** que cria profile com `is_prospect=true` via edge function (service role pra criar auth.users dummy) + atualiza retroativamente a chamada órfã com o novo `customer_user_id`. Próximas chamadas do mesmo número são auto-vinculadas via `resolveCustomerByPhone`.

**Architecture:**
- Migration: `profiles ADD COLUMN is_prospect boolean DEFAULT false`, `prospect_source text`, `prospect_origin_call_id uuid FK farmer_calls`, `razao_social text`, `cnpj text`
- Edge function `create-prospect-customer`: usa service role pra `supabase.auth.admin.createUser` (email dummy `prospect-{uuid}@colacor.local`, password random, email_confirm=true) + cria profile com `is_prospect=true`, `is_approved=true`, `role='customer'` + retroativa farmer_calls.customer_user_id se origin_call_id passado
- Hook `useCreateProspect` (mutation)
- UI em `/farmer/calls/pending-link`: botão "Criar cliente novo" abre Dialog com form (razão social, nome contato, phone readonly, email opcional, CNPJ opcional, segmento select, tags CSV)
- Página `/admin/prospects` (lista filtrada `is_prospect=true`) com badge "Prospect" + filtro por vendedor

---

## Tasks

### Task 1: Migration

```sql
-- PR-CUSTOMERS-MGMT: prospect (cliente novo cadastrado pelo vendedor)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_prospect boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS prospect_source text
    CHECK (prospect_source IN ('chamada_inbound', 'chamada_outbound', 'walk_in', 'manual', 'omie_import')),
  ADD COLUMN IF NOT EXISTS prospect_origin_call_id uuid REFERENCES public.farmer_calls(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS razao_social text,
  ADD COLUMN IF NOT EXISTS cnpj text;

CREATE INDEX IF NOT EXISTS idx_profiles_is_prospect
  ON public.profiles (is_prospect, created_at DESC)
  WHERE is_prospect = true;

COMMENT ON COLUMN public.profiles.is_prospect IS 'Prospect = cliente cadastrado pelo vendedor (não auto-signup). Auth.users dummy. Quando user real fizer signup, flipa pra false.';
COMMENT ON COLUMN public.profiles.prospect_origin_call_id IS 'Chamada que originou o cadastro (PR-CUSTOMERS-MGMT). Permite traceability.';
```

### Task 2: Edge function `create-prospect-customer`

Usa service role pra criar auth.users dummy + profile + retroativa farmer_calls.

```ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

interface Req {
  razao_social: string;
  phone: string;
  nome_contato?: string;
  email?: string;
  cnpj?: string;
  segmento?: string;
  tags?: string[];
  origin_call_id?: string;
  source?: 'chamada_inbound' | 'chamada_outbound' | 'walk_in' | 'manual';
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Req;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (!body.razao_social || !body.phone) {
    return new Response(JSON.stringify({ error: "razao_social + phone required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    // 1. Cria auth.users dummy via service role
    const dummyEmail = body.email || `prospect-${crypto.randomUUID()}@colacor.local`;
    const dummyPassword = crypto.randomUUID() + '-' + crypto.randomUUID();
    const { data: userData, error: userErr } = await supabase.auth.admin.createUser({
      email: dummyEmail,
      password: dummyPassword,
      email_confirm: true,
      user_metadata: {
        is_prospect: true,
        razao_social: body.razao_social,
        created_via: 'create-prospect-customer',
      },
    });
    if (userErr || !userData?.user) {
      console.error('[create-prospect] auth.admin.createUser failed:', userErr);
      return new Response(JSON.stringify({ error: `Falha ao criar usuário: ${userErr?.message}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const newUserId = userData.user.id;

    // 2. Cria profile com is_prospect=true. Profile pode já existir via trigger handle_new_user — usar upsert.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: profileErr } = await (supabase.from('profiles') as any).upsert({
      user_id: newUserId,
      name: body.nome_contato || body.razao_social,
      razao_social: body.razao_social,
      phone: body.phone.replace(/\D/g, ''),
      email: body.email || null,
      cnpj: body.cnpj || null,
      role: 'customer',
      is_approved: true,
      is_prospect: true,
      prospect_source: body.source ?? 'manual',
      prospect_origin_call_id: body.origin_call_id ?? null,
    }, { onConflict: 'user_id' });
    if (profileErr) {
      console.error('[create-prospect] profile upsert failed:', profileErr);
      // Rollback auth.users
      await supabase.auth.admin.deleteUser(newUserId);
      return new Response(JSON.stringify({ error: `Falha ao criar profile: ${profileErr.message}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 3. Retroativa farmer_calls.customer_user_id se origin_call_id passado
    if (body.origin_call_id) {
      await supabase.from('farmer_calls')
        .update({ customer_user_id: newUserId })
        .eq('id', body.origin_call_id);
    }

    // 4. Cria customer_contact primary com o phone que ligou
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase.from('customer_contacts') as any).insert({
      customer_user_id: newUserId,
      phone: body.phone,
      nome: body.nome_contato || null,
      is_primary: true,
      source: body.source === 'chamada_inbound' ? 'auto_detected_call' : 'manual',
    });

    // 5. Se passou tags/segmento, cria customer_segments (precisa omie_codigo dummy ou skip — vamos skipar por enquanto)

    return new Response(JSON.stringify({
      ok: true,
      user_id: newUserId,
      profile: {
        user_id: newUserId,
        razao_social: body.razao_social,
        phone: body.phone,
        is_prospect: true,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[create-prospect-customer]", msg);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
```

### Task 3: Hook + UI

`src/hooks/useCreateProspect.ts`:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';

interface CreateInput {
  razao_social: string;
  phone: string;
  nome_contato?: string;
  email?: string;
  cnpj?: string;
  segmento?: string;
  tags?: string[];
  origin_call_id?: string;
  source?: 'chamada_inbound' | 'chamada_outbound' | 'walk_in' | 'manual';
}

interface CreateResponse {
  ok: boolean;
  user_id: string;
  profile: {
    user_id: string;
    razao_social: string;
    phone: string;
    is_prospect: boolean;
  };
}

export function useCreateProspect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInput): Promise<CreateResponse> => {
      return await invokeFunction<CreateResponse>('create-prospect-customer', input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['farmer-pending-link'] });
      qc.invalidateQueries({ queryKey: ['prospects'] });
      toast.success('Cliente cadastrado como prospect');
    },
    onError: (err) => toast.error('Erro ao criar prospect', { description: err instanceof Error ? err.message : '' }),
  });
}
```

### Task 4: Botão + Dialog em FarmerCallsPendingLink

Adicionar ao lado do "Vincular cliente existente": "🆕 Criar cliente novo". Dialog com form: razão social, nome contato, phone readonly (vem da chamada), email, CNPJ, segmento.

### Task 5: Página `/admin/prospects`

Lista profiles WHERE is_prospect=true, filtros (vendedor, segmento, criado em).

### Task 6: Wire + QA + PR
