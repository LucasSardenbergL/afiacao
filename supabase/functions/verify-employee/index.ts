import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
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
        // Only allow setting own role or admin setting others
        const targetUserId = userId || user.id;
        
        // Check if caller is admin or setting their own role
        const { data: callerRole } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id)
          .single();

        if (targetUserId !== user.id && callerRole?.role !== "admin") {
          return new Response(
            JSON.stringify({ error: "Sem permissão" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

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

        if (roleData?.role !== "admin") {
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
