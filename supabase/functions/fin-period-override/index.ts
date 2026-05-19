import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// =============================================================
// Helper de autorização inlineado (de _shared/auth.ts)
// =============================================================
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function unauthorized(message = "Unauthorized"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type AuthResult =
  | { ok: true; via: "cron" | "service_role" | "staff"; userId?: string }
  | { ok: false; response: Response };

async function authorizeCronOrStaff(req: Request): Promise<AuthResult> {
  const expected = Deno.env.get("CRON_SECRET");
  const cronSecret = req.headers.get("x-cron-secret");
  if (expected && cronSecret && cronSecret === expected) {
    return { ok: true, via: "cron" };
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, response: unauthorized() };
  }
  const token = authHeader.slice(7);
  if (token === SERVICE_ROLE) {
    return { ok: true, via: "service_role" };
  }

  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: SERVICE_ROLE },
    });
    if (!userRes.ok) return { ok: false, response: unauthorized() };
    const user = await userRes.json();
    if (!user?.id) return { ok: false, response: unauthorized() };

    const roleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (!roleRes.ok) return { ok: false, response: unauthorized() };
    const roles = (await roleRes.json()) as Array<{ role: string }>;
    const allowed = new Set(["employee", "master"]);
    if (roles.some((r) => allowed.has(r.role))) {
      return { ok: true, via: "staff", userId: user.id };
    }
    return { ok: false, response: unauthorized("Forbidden") };
  } catch {
    return { ok: false, response: unauthorized() };
  }
}

// =============================================================
// Edge function: abre janela de 15 min de override de período fechado
// =============================================================
type OverridePayload = {
  company: 'oben' | 'colacor' | 'colacor_sc';
  ano: number;
  mes: number;
  justificativa: string;
  acao_planejada: string;
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  let userId: string | null = null;
  if (auth.via === 'staff' && auth.userId) {
    userId = auth.userId;
    const { data: role } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle();
    if (role?.role !== 'master') {
      return new Response(JSON.stringify({ error: 'apenas master pode abrir override' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } else if (auth.via !== 'cron' && auth.via !== 'service_role') {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let payload: OverridePayload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!payload.company || !payload.ano || !payload.mes || !payload.justificativa?.trim() || !payload.acao_planejada?.trim()) {
    return new Response(JSON.stringify({ error: 'company, ano, mes, justificativa e acao_planejada são obrigatórios' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('fin_period_overrides')
    .insert({
      company: payload.company,
      ano: payload.ano,
      mes: payload.mes,
      opened_by: userId,
      justificativa: payload.justificativa.trim(),
      acao_planejada: payload.acao_planejada.trim(),
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    override_id: data.id,
    expires_at: data.expires_at,
    opened_at: data.opened_at,
  }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
