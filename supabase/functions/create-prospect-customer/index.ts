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
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!body.razao_social || !body.phone) {
    return new Response(JSON.stringify({ error: "razao_social + phone required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // 1. Cria auth.users dummy via service role.
    // Email dummy se vendedor não passou email (cliente ainda não acessa app).
    const dummyEmail = body.email || `prospect-${crypto.randomUUID()}@colacor.local`;
    const dummyPassword = `${crypto.randomUUID()}-${crypto.randomUUID()}`;

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
      return new Response(
        JSON.stringify({ error: `Falha ao criar usuário: ${userErr?.message ?? 'unknown'}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const newUserId = userData.user.id;
    const phoneDigits = body.phone.replace(/\D/g, '');

    // 2. Upsert profile com is_prospect=true (trigger handle_new_user pode ter criado linha vazia).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: profileErr } = await (supabase.from('profiles') as any).upsert(
      {
        user_id: newUserId,
        name: body.nome_contato || body.razao_social,
        razao_social: body.razao_social,
        phone: phoneDigits,
        email: body.email || null,
        cnpj: body.cnpj || null,
        role: 'customer',
        is_approved: true,
        is_prospect: true,
        prospect_source: body.source ?? 'manual',
        prospect_origin_call_id: body.origin_call_id ?? null,
      },
      { onConflict: 'user_id' }
    );

    if (profileErr) {
      console.error('[create-prospect] profile upsert failed:', profileErr);
      // Rollback: deleta auth.users criado
      await supabase.auth.admin.deleteUser(newUserId);
      return new Response(
        JSON.stringify({ error: `Falha ao criar profile: ${profileErr.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Retroativa farmer_calls.customer_user_id se chamada origem foi passada
    if (body.origin_call_id) {
      await supabase
        .from('farmer_calls')
        .update({ customer_user_id: newUserId })
        .eq('id', body.origin_call_id);
    }

    // 4. Cria customer_contact primary com o phone que ligou (PR-CONTACTS integração)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase.from('customer_contacts') as any).insert({
      customer_user_id: newUserId,
      phone: phoneDigits,
      nome: body.nome_contato || null,
      is_primary: true,
      source: body.source === 'chamada_inbound' ? 'auto_detected_call' : 'manual',
    });

    return new Response(
      JSON.stringify({
        ok: true,
        user_id: newUserId,
        profile: {
          user_id: newUserId,
          razao_social: body.razao_social,
          phone: phoneDigits,
          is_prospect: true,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[create-prospect-customer]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
