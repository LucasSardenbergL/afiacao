import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";
const RECEITA_API_URL = "https://receitaws.com.br/v1/cnpj";

// CNAEs industriais comuns
const CNAES_INDUSTRIAIS = [
  "10", // Fabricação de produtos alimentícios
  "13", // Fabricação de produtos têxteis
  "14", // Confecção de artigos do vestuário
  "15", // Preparação de couros e fabricação de artefatos
  "16", // Fabricação de produtos de madeira
  "25", // Fabricação de produtos de metal
  "31", // Fabricação de móveis
  "47", // Comércio varejista (alguns)
  "56", // Alimentação (restaurantes, bares)
  "96.02", // Cabeleireiros e outras atividades de tratamento de beleza
  "96.01", // Lavanderias
];

interface OmieCliente {
  codigo_cliente?: number;
  codigo_cliente_integracao?: string;
  razao_social?: string;
  nome_fantasia?: string;
  cnpj_cpf?: string;
  email?: string;
  telefone1_numero?: string;
  endereco?: string;
  endereco_numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
  cep?: string;
  pessoa_fisica?: string;
  inscricao_estadual?: string;
}

interface CNPJData {
  cnpj?: string;
  nome?: string;
  fantasia?: string;
  email?: string;
  telefone?: string;
  atividade_principal?: Array<{ code: string; text: string }>;
  logradouro?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  municipio?: string;
  uf?: string;
  cep?: string;
  status?: string;
  message?: string;
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

// Função para fazer chamadas à API do Omie
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

// Função para verificar CNAE e determinar se é industrial
function isIndustrialByCNAE(cnae: string): boolean {
  if (!cnae) return false;
  const cnaeCode = cnae.replace(/\D/g, '');
  return CNAES_INDUSTRIAIS.some(prefix => cnaeCode.startsWith(prefix.replace('.', '')));
}

// Função para consultar CNPJ na Receita Federal
async function consultarCNPJ(cnpj: string): Promise<CNPJData | null> {
  const cnpjLimpo = cnpj.replace(/\D/g, '');
  
  if (cnpjLimpo.length !== 14) {
    return null;
  }

  try {
    console.log(`[ReceitaWS] Consultando CNPJ: ${cnpjLimpo}`);
    const response = await fetch(`${RECEITA_API_URL}/${cnpjLimpo}`, {
      headers: {
        'Accept': 'application/json',
      },
    });
    
    const data = await response.json();
    console.log(`[ReceitaWS] Resposta:`, JSON.stringify(data, null, 2));
    
    if (data.status === 'ERROR') {
      console.log(`[ReceitaWS] Erro: ${data.message}`);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('[ReceitaWS] Erro:', error);
    return null;
  }
}

// Função para buscar cliente por CPF/CNPJ
async function buscarClientePorDocumento(documento: string): Promise<{ cliente: OmieCliente | null; cnpjData: CNPJData | null; isIndustrial: boolean }> {
  // Limpar documento (remover pontos, traços, barras)
  const docLimpo = documento.replace(/\D/g, "");
  
  if (docLimpo.length !== 11 && docLimpo.length !== 14) {
    throw new Error("Documento inválido. Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)");
  }

  let cnpjData: CNPJData | null = null;
  let isIndustrial = false;

  // Se for CNPJ, consultar na Receita para obter CNAE
  if (docLimpo.length === 14) {
    cnpjData = await consultarCNPJ(docLimpo);
    if (cnpjData?.atividade_principal?.[0]?.code) {
      isIndustrial = isIndustrialByCNAE(cnpjData.atividade_principal[0].code);
      console.log(`[CNAE] Atividade: ${cnpjData.atividade_principal[0].code} - Industrial: ${isIndustrial}`);
    }
  }

  try {
    // Buscar cliente pelo CPF/CNPJ no Omie
    const result = await callOmieApi(
      "geral/clientes/",
      "ListarClientes",
      {
        pagina: 1,
        registros_por_pagina: 1,
        clientesFiltro: {
          cnpj_cpf: docLimpo,
        },
      }
    );

    if (result.faultstring) {
      // Se não encontrou, retornar null
      if (result.faultstring.includes("Nenhum registro") || result.faultstring.includes("não encontrado")) {
        return { cliente: null, cnpjData, isIndustrial };
      }
      throw new Error(`Erro Omie: ${result.faultstring}`);
    }

    // Verificar se encontrou algum cliente
    const clientes = result.clientes_cadastro || result.clientes_cadastro_resumido;
    if (!clientes || clientes.length === 0) {
      return { cliente: null, cnpjData, isIndustrial };
    }

    // Buscar dados completos do cliente
    const clienteResumo = clientes[0];
    if (clienteResumo.codigo_cliente) {
      const detalheResult = await callOmieApi(
        "geral/clientes/",
        "ConsultarCliente",
        {
          codigo_cliente: clienteResumo.codigo_cliente,
        }
      ) as unknown as OmieCliente;

      return { cliente: detalheResult, cnpjData, isIndustrial };
    }

    return { cliente: clienteResumo, cnpjData, isIndustrial };
  } catch (error) {
    console.error("[Omie] Erro ao buscar cliente:", error);
    // Se for erro de "não encontrado", retornar null
    if (error instanceof Error && 
        (error.message.includes("Nenhum registro") || 
         error.message.includes("não encontrado") ||
         error.message.includes("não localizado"))) {
      return { cliente: null, cnpjData, isIndustrial };
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
    const body = await req.json();
    const { action, documento } = body;

    console.log(`[Omie Cliente] Ação: ${action}`);

    let result: Record<string, unknown> = {};

    switch (action) {
      case "buscar_por_documento": {
        if (!documento) {
          return new Response(
            JSON.stringify({ error: "Documento é obrigatório" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const { cliente, cnpjData, isIndustrial } = await buscarClientePorDocumento(documento);

        if (cliente) {
          result = {
            found: true,
            isIndustrial,
            cnae: cnpjData?.atividade_principal?.[0]?.code || null,
            cnaeDescricao: cnpjData?.atividade_principal?.[0]?.text || null,
            cliente: {
              codigo_cliente: cliente.codigo_cliente,
              razao_social: cliente.razao_social,
              nome_fantasia: cliente.nome_fantasia,
              cnpj_cpf: cliente.cnpj_cpf,
              email: cliente.email,
              telefone: cliente.telefone1_numero,
              endereco: cliente.endereco,
              endereco_numero: cliente.endereco_numero,
              complemento: cliente.complemento,
              bairro: cliente.bairro,
              cidade: cliente.cidade,
              estado: cliente.estado,
              cep: cliente.cep,
              pessoa_fisica: cliente.pessoa_fisica,
              inscricao_estadual: cliente.inscricao_estadual,
            },
          };
        } else if (cnpjData) {
          // CNPJ encontrado na Receita, mas não no Omie
          result = {
            found: false,
            isIndustrial,
            cnae: cnpjData.atividade_principal?.[0]?.code || null,
            cnaeDescricao: cnpjData.atividade_principal?.[0]?.text || null,
            cliente: {
              razao_social: cnpjData.nome,
              nome_fantasia: cnpjData.fantasia,
              email: cnpjData.email,
              telefone: cnpjData.telefone,
              endereco: cnpjData.logradouro,
              endereco_numero: cnpjData.numero,
              complemento: cnpjData.complemento,
              bairro: cnpjData.bairro,
              cidade: cnpjData.municipio,
              estado: cnpjData.uf,
              cep: cnpjData.cep,
            },
          };
        } else {
          result = {
            found: false,
            isIndustrial: false,
            cnae: null,
            cliente: null,
          };
        }
        break;
      }

      default:
        return new Response(
          JSON.stringify({ error: "Ação não reconhecida" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Omie Cliente] Erro:", error);
    const errorMessage = error instanceof Error ? error.message : "Erro desconhecido";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
