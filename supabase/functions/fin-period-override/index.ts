import { createClient } from "npm:@supabase/supabase-js@2";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // Sonda de versão (M-26; docs/agent/deploy.md): `{ probe: true }` responde a versão no ar sem tocar
  // banco — antes do client. O corpo é lido UMA vez aqui; o JSON inválido segue no 400 de antes.
  const corpoBruto: unknown = await req.json().catch(() => undefined);
  const decisaoSonda = classificarSonda(corpoBruto ?? null);
  if (decisaoSonda.tipo === "sonda") {
    return new Response(JSON.stringify(respostaSonda(VERSAO)), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  if (decisaoSonda.tipo === "ambiguo") {
    return new Response(JSON.stringify({ versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

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
  if (corpoBruto !== undefined) {
    payload = corpoBruto as OverridePayload;
  } else {
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
