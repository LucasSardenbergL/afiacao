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
// Edge function: sugere linha DRE para categorias Omie sem mapping
// =============================================================
type DreLinha =
  | 'receita_bruta' | 'deducoes' | 'cmv'
  | 'despesas_operacionais' | 'despesas_administrativas' | 'despesas_comerciais'
  | 'despesas_financeiras' | 'receitas_financeiras'
  | 'outras_receitas' | 'outras_despesas' | 'impostos';

type Suggestion = {
  omie_codigo: string;
  categoria_nome: string;
  valor_periodo: number;
  sugestao: { linha_dre: DreLinha | null; confianca: 'alta' | 'media' | 'baixa'; razao: string };
};

const KEYWORDS: Array<[RegExp, DreLinha]> = [
  [/honor|advog|contador|consultor/i, 'despesas_administrativas'],
  [/aluguel|condom[íi]nio|iptu/i, 'despesas_administrativas'],
  [/sal[áa]rio|folha|enc(argo|argos)|inss|fgts/i, 'despesas_administrativas'],
  [/marketing|propaganda|publicidade|google ads|facebook|meta ads/i, 'despesas_comerciais'],
  [/frete|transporte|combust[íi]vel|pedágio/i, 'despesas_comerciais'],
  [/juros|tarifa banc[áa]ria|iof/i, 'despesas_financeiras'],
  [/rendimento|aplica[çc][ãa]o/i, 'receitas_financeiras'],
  [/icms|pis|cofins|iss|irpj|csll|simples nacional/i, 'impostos'],
  [/cmv|mercador|insumo|mat[ée]ria.prima/i, 'cmv'],
];

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const company = url.searchParams.get('company');
  const ano = Number(url.searchParams.get('ano'));
  const mes = Number(url.searchParams.get('mes'));

  if (!company || !ano || !mes) {
    return new Response(JSON.stringify({ error: 'company, ano, mes obrigatórios' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
  const startDate = `${ano}-${String(mes).padStart(2,'0')}-01`;
  const endDate = new Date(ano, mes, 0).toISOString().slice(0, 10);

  const { data: pendentes, error: pendErr } = await supabase.rpc('fin_categorias_sem_mapping', {
    p_company: company, p_start: startDate, p_end: endDate,
  });
  if (pendErr) {
    return new Response(JSON.stringify({ error: pendErr.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: mappings } = await supabase
    .from('fin_categoria_dre_mapping')
    .select('company, omie_codigo, dre_linha');

  const byCodigo = new Map<string, { dre_linha: DreLinha; company: string }[]>();
  for (const m of (mappings ?? []) as Array<{ company: string; omie_codigo: string; dre_linha: DreLinha }>) {
    if (!byCodigo.has(m.omie_codigo)) byCodigo.set(m.omie_codigo, []);
    byCodigo.get(m.omie_codigo)!.push({ dre_linha: m.dre_linha, company: m.company });
  }

  const suggestions: Suggestion[] = ((pendentes ?? []) as Array<{
    omie_codigo: string; categoria_nome: string; valor_periodo: number;
  }>).map(p => {
    const matchesByCode = byCodigo.get(p.omie_codigo)?.filter(m => m.company !== company);
    if (matchesByCode && matchesByCode.length > 0) {
      const top = matchesByCode[0];
      return {
        ...p,
        sugestao: {
          linha_dre: top.dre_linha,
          confianca: 'alta',
          razao: `Empresa ${top.company} mapeou esta categoria como ${top.dre_linha}`,
        },
      };
    }
    for (const [rx, linha] of KEYWORDS) {
      if (rx.test(p.categoria_nome)) {
        return {
          ...p,
          sugestao: { linha_dre: linha, confianca: 'baixa', razao: `Keyword '${rx.source}' sugere ${linha}` },
        };
      }
    }
    return {
      ...p,
      sugestao: { linha_dre: null, confianca: 'baixa', razao: 'Sem sugestão automática' },
    };
  });

  return new Response(JSON.stringify({ suggestions }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
