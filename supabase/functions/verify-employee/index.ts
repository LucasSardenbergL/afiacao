import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

interface OmieCliente {
  codigo_cliente?: number;
  codigo_cliente_integracao?: string;
  razao_social?: string;
  nome_fantasia?: string;
  cnpj_cpf?: string;
  email?: string;
  telefone1_numero?: string;
  tags?: Array<{ tag: string }>;
  caracteristicas?: Array<{ campo: string; conteudo: string }>;
  pessoa_fisica?: string;
  codigo_vendedor?: number;
}

interface OmieListResponse {
  pagina?: number;
  total_de_paginas?: number;
  registros?: number;
  total_de_registros?: number;
  clientes_cadastro?: OmieCliente[];
  clientes_cadastro_resumido?: OmieCliente[];
  faultstring?: string;
  faultcode?: string;
}

async function callOmieApi(
  endpoint: string,
  call: string,
  params: Record<string, unknown>
): Promise<OmieListResponse> {
  const OMIE_APP_KEY = Deno.env.get("OMIE_COLACOR_SC_APP_KEY");
  const OMIE_APP_SECRET = Deno.env.get("OMIE_COLACOR_SC_APP_SECRET");

  if (!OMIE_APP_KEY || !OMIE_APP_SECRET) {
    throw new Error("Credenciais do Omie (Colacor SC) não configuradas");
  }

  const body = {
    call,
    app_key: OMIE_APP_KEY,
    app_secret: OMIE_APP_SECRET,
    param: [params],
  };

  console.log(`[Omie API] Chamando ${endpoint} - ${call}`);

  const response = await fetch(`${OMIE_API_URL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await response.json();

  // `faultstring` ANTES do status (ordem canônica do #1614 — docs/agent/sync.md): este wrapper
  // NÃO lança em fault, de propósito — quem separa a ausência legítima ("Nenhum registro" /
  // "não encontrado" ⇒ CPF não cadastrado) do erro real é o call-site, pelo TEXTO. Como o EOF
  // do contrato Omie chega às vezes acompanhado de 5xx, checar o status primeiro converteria
  // "não é cliente" em exceção.
  if (result.faultstring) return result;

  // Sem faultstring, só um 2xx é resposta. `fetch` NÃO lança em HTTP não-2xx: um 429/5xx cujo
  // corpo parseia sem fault chegava ao call-site sem `clientes_cadastro`, e o
  // `if (!clientes || clientes.length === 0)` respondia `isEmployee: false` — o Omie fora do ar
  // virava o FATO "este CPF não é funcionário", indistinguível de uma consulta bem-sucedida.
  // A mensagem não casa os marcadores de ausência do catch, então a falha SOBE em vez de virar
  // veredito (money-path §2 — degradação honesta: ausente ≠ inexistente).
  if (!response.ok) {
    throw new Error(`Erro Omie: HTTP ${response.status} em ${call}`);
  }

  // `faultcode` sem `faultstring` fecha a ordem canônica do #1614: um `200 {"faultcode":"5113"}`
  // chegava ao call-site sem `clientes_cadastro` e virava `isEmployee:false` — erro sinalizado
  // pelo Omie lido como veredito sobre a pessoa (achado Codex xhigh). A mensagem não casa os
  // marcadores de ausência do catch, então sobe em vez de virar "não é funcionário".
  if (result.faultcode) {
    throw new Error(`Erro Omie: faultcode ${result.faultcode} em ${call}`);
  }

  return result;
}

function hasEmployeeTag(cliente: OmieCliente, employeeTag: string): boolean {
  if (cliente.tags && Array.isArray(cliente.tags)) {
    const hasTag = cliente.tags.some(
      (t) => t.tag?.toUpperCase() === employeeTag.toUpperCase()
    );
    if (hasTag) return true;
  }

  if (cliente.caracteristicas && Array.isArray(cliente.caracteristicas)) {
    const hasCarac = cliente.caracteristicas.some(
      (c) =>
        c.campo?.toUpperCase() === "TAG" &&
        c.conteudo?.toUpperCase() === employeeTag.toUpperCase()
    );
    if (hasCarac) return true;
  }

  return false;
}

async function buscarFuncionarioPorCPF(
  cpf: string,
  employeeTag: string
): Promise<{ isEmployee: boolean; cliente: OmieCliente | null }> {
  const cpfLimpo = cpf.replace(/\D/g, "");

  if (cpfLimpo.length !== 11) {
    throw new Error("CPF inválido. Deve ter 11 dígitos");
  }

  try {
    const result = await callOmieApi("geral/clientes/", "ListarClientes", {
      pagina: 1,
      registros_por_pagina: 1,
      clientesFiltro: { cnpj_cpf: cpfLimpo },
    });

    if (result.faultstring) {
      if (
        result.faultstring.includes("Nenhum registro") ||
        result.faultstring.includes("não encontrado")
      ) {
        return { isEmployee: false, cliente: null };
      }
      throw new Error(`Erro Omie: ${result.faultstring}`);
    }

    const clientes = result.clientes_cadastro || result.clientes_cadastro_resumido;
    if (!clientes || clientes.length === 0) {
      return { isEmployee: false, cliente: null };
    }

    const clienteResumo = clientes[0];
    if (clienteResumo.codigo_cliente) {
      const detalheResult = (await callOmieApi(
        "geral/clientes/",
        "ConsultarCliente",
        { codigo_cliente: clienteResumo.codigo_cliente }
      )) as unknown as OmieCliente;

      const isEmployee = hasEmployeeTag(detalheResult, employeeTag);
      return { isEmployee, cliente: detalheResult };
    }

    return { isEmployee: false, cliente: clienteResumo };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("Nenhum registro") ||
        error.message.includes("não encontrado"))
    ) {
      return { isEmployee: false, cliente: null };
    }
    throw error;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    // Authentication required
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Não autorizado" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Token inválido" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const { action, cpf, userId } = body;

    // Input validation
    if (!action || typeof action !== "string") {
      return new Response(
        JSON.stringify({ error: "Ação inválida" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get employee tag from config
    const { data: configData } = await supabase
      .from("company_config")
      .select("value")
      .eq("key", "employee_omie_tag")
      .single();

    const employeeTag = configData?.value || "FUNCIONARIO";

    switch (action) {
      case "verify_employee": {
        if (!cpf || typeof cpf !== "string" || cpf.replace(/\D/g, "").length !== 11) {
          return new Response(
            JSON.stringify({ error: "CPF inválido" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const { isEmployee, cliente } = await buscarFuncionarioPorCPF(cpf, employeeTag);

        return new Response(
          JSON.stringify({
            isEmployee,
            cliente: cliente
              ? {
                  codigo_cliente: cliente.codigo_cliente,
                  razao_social: cliente.razao_social,
                  nome_fantasia: cliente.nome_fantasia,
                  email: cliente.email,
                  telefone: cliente.telefone1_numero,
                }
              : null,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "set_employee_role": {
        // SECURITY: Only super_admin (master role) can grant the employee role.
        // Self-promotion is forbidden — fixes privilege escalation
        // (any authenticated user could previously self-grant employee).
        const { data: callerRoles } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id);

        const isSuperAdmin = (callerRoles ?? []).some(
          (r: { role: string }) => r.role === "master"
        );

        if (!isSuperAdmin) {
          return new Response(
            JSON.stringify({ error: "Sem permissão" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const targetUserId = userId || user.id;

        await supabase
          .from("profiles")
          .update({ is_employee: true })
          .eq("user_id", targetUserId);

        await supabase.from("user_roles").upsert(
          { user_id: targetUserId, role: "employee" },
          { onConflict: "user_id,role" }
        );

        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "get_master_cnpj": {
        // Only admins can get master CNPJ
        const { data: roleData } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id)
          .single();

        if (roleData?.role !== "master") {
          return new Response(
            JSON.stringify({ error: "Sem permissão" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const { data: masterCnpj } = await supabase
          .from("company_config")
          .select("value")
          .eq("key", "master_cnpj")
          .single();

        return new Response(
          JSON.stringify({ masterCnpj: masterCnpj?.value || null }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      default:
        return new Response(
          JSON.stringify({ error: "Ação não reconhecida" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
  } catch (error) {
    console.error("[Verify Employee] Erro:", error);
    return new Response(
      JSON.stringify({ error: "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
