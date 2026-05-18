import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Company = 'oben' | 'colacor' | 'colacor_sc';
type Cenario = 'realista' | 'otimista' | 'pessimista';

type Input = {
  company: Company;
  cenario?: Cenario;
  horizon_weeks?: number;
  save_snapshot?: boolean;
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  let payload: Input;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  if (!payload.company || !['oben', 'colacor', 'colacor_sc'].includes(payload.company)) {
    return jsonResponse({ error: 'company inválido' }, 400);
  }

  const cenario: Cenario = payload.cenario ?? 'realista';
  const horizon = payload.horizon_weeks ?? 13;
  const save = payload.save_snapshot ?? false;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    const result = await calcular(supabase, payload.company, cenario, horizon, save);
    return jsonResponse(result, 200);
  } catch (err) {
    return jsonResponse({ error: String((err as Error).message ?? err) }, 500);
  }
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// === Pipeline (será implementada nas próximas tasks) ===
async function calcular(
  _supabase: ReturnType<typeof createClient>,
  _company: Company,
  _cenario: Cenario,
  _horizon: number,
  _save: boolean,
) {
  return { ok: true, todo: 'pipeline' };
}
