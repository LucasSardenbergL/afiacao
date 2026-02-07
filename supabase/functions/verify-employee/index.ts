import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

// Call Omie API
async function callOmieApi(
  endpoint: string,
  call: string,
  params: Record<string, unknown>
): Promise<OmieListResponse> {
  const OMIE_APP_KEY = Deno.env.get("OMIE_APP_KEY");
  const OMIE_APP_SECRET = Deno.env.get("OMIE_APP_SECRET");

  if (!OMIE_APP_KEY || !OMIE_APP_SECRET) {
    throw new Error("Credenciais do Omie não configuradas");
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
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const result = await response.json();
  console.log(`[Omie API] Resposta:`, JSON.stringify(result, null, 2));

  return result;
}

// Check if client has employee tag
function hasEmployeeTag(cliente: OmieCliente, employeeTag: string): boolean {
  // Check tags array
  if (cliente.tags && Array.isArray(cliente.tags)) {
    const hasTag = cliente.tags.some(
      (t) => t.tag?.toUpperCase() === employeeTag.toUpperCase()
    );
    if (hasTag) return true;
  }

  // Check caracteristicas array
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

// Search for employee by CPF in Omie
async function buscarFuncionarioPorCPF(
  cpf: string,
  employeeTag: string
): Promise<{ isEmployee: boolean; cliente: OmieCliente | null }> {
  const cpfLimpo = cpf.replace(/\D/g, "");

  if (cpfLimpo.length !== 11) {
    throw new Error("CPF inválido. Deve ter 11 dígitos");
  }

  try {
    // Search client by CPF in Omie
    const result = await callOmieApi("geral/clientes/", "ListarClientes", {
      pagina: 1,
      registros_por_pagina: 1,
      clientesFiltro: {
        cnpj_cpf: cpfLimpo,
      },
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

    // Get full client details
    const clienteResumo = clientes[0];
    if (clienteResumo.codigo_cliente) {
      const detalheResult = (await callOmieApi(
        "geral/clientes/",
        "ConsultarCliente",
        {
          codigo_cliente: clienteResumo.codigo_cliente,
        }
      )) as unknown as OmieCliente;

      const isEmployee = hasEmployeeTag(detalheResult, employeeTag);
      console.log(
        `[Verify Employee] CPF: ${cpfLimpo}, Tag: ${employeeTag}, IsEmployee: ${isEmployee}`
      );

      return { isEmployee, cliente: detalheResult };
    }

    return { isEmployee: false, cliente: clienteResumo };
  } catch (error) {
    console.error("[Verify Employee] Erro:", error);
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
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const { action, cpf, userId } = body;

    console.log(`[Verify Employee] Ação: ${action}`);

    // Get employee tag from config
    const { data: configData } = await supabase
      .from("company_config")
      .select("value")
      .eq("key", "employee_omie_tag")
      .single();

    const employeeTag = configData?.value || "FUNCIONARIO";

    switch (action) {
      case "verify_employee": {
        if (!cpf) {
          return new Response(
            JSON.stringify({ error: "CPF é obrigatório" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        const { isEmployee, cliente } = await buscarFuncionarioPorCPF(
          cpf,
          employeeTag
        );

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
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      case "set_employee_role": {
        if (!userId) {
          return new Response(
            JSON.stringify({ error: "userId é obrigatório" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        // Update profile to mark as employee
        await supabase
          .from("profiles")
          .update({ is_employee: true })
          .eq("user_id", userId);

        // Insert employee role
        await supabase.from("user_roles").upsert(
          {
            user_id: userId,
            role: "employee",
          },
          { onConflict: "user_id,role" }
        );

        return new Response(
          JSON.stringify({ success: true }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      case "get_master_cnpj": {
        const { data: masterCnpj } = await supabase
          .from("company_config")
          .select("value")
          .eq("key", "master_cnpj")
          .single();

        return new Response(
          JSON.stringify({ masterCnpj: masterCnpj?.value || null }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      default:
        return new Response(
          JSON.stringify({ error: "Ação não reconhecida" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
    }
  } catch (error) {
    console.error("[Verify Employee] Erro:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Erro desconhecido";
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
