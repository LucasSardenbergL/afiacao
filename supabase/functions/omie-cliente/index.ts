import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// In-memory rate limit for unauthenticated buscar_por_documento (5/IP/min)
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

const OMIE_API_URL = "https://app.omie.com.br/api/v1";
const RECEITA_API_URL = "https://receitaws.com.br/v1/cnpj";

const CNAES_INDUSTRIAIS = [
  "10", "13", "14", "15", "16", "25", "31", "47", "56", "96.02", "96.01",
];

interface OmieCliente {
  codigo_cliente?: number;
  codigo_cliente_omie?: number;
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
  tags?: Array<{ tag: string }>;
  codigo_vendedor?: number;
  recomendacoes?: {
    codigo_vendedor?: number;
    codigo_transportadora?: number;
    gerar_boletos?: string;
    tipo_assinante?: string;
  };
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

async function callOmieApiWithCredentials(
  endpoint: string,
  call: string,
  params: Record<string, unknown>,
  appKey: string,
  appSecret: string
): Promise<OmieListResponse> {
  const body = {
    call,
    app_key: appKey,
    app_secret: appSecret,
    param: [params],
  };

  const response = await fetch(`${OMIE_API_URL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return await response.json();
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

  return callOmieApiWithCredentials(endpoint, call, params, OMIE_APP_KEY, OMIE_APP_SECRET);
}

// Slug canônico da conta, igual ao domínio de omie_customer_account_map.account
// (CHECK chk_ocam_account: 'oben' | 'colacor' | 'colacor_sc'). É a chave que amarra a credencial
// Omie usada na chamada à linha correspondente da proof — o `name` é rótulo de UI e não serve
// (buscar_logos_empresas já erra ao casar por nome), e o ÍNDICE em getOmieAccounts() é instável:
// a lista é montada condicionalmente, então faltar OMIE_OBEN_APP_KEY faz o índice 1 virar Colacor.
type OmieAccountSlug = "colacor_sc" | "oben" | "colacor";

interface OmieAccountConfig {
  name: string;
  account: OmieAccountSlug;
  appKey: string;
  appSecret: string;
}

function getOmieAccounts(): OmieAccountConfig[] {
  const accounts: OmieAccountConfig[] = [];

  const colacorScKey = Deno.env.get("OMIE_COLACOR_SC_APP_KEY");
  const colacorScSecret = Deno.env.get("OMIE_COLACOR_SC_APP_SECRET");
  if (colacorScKey && colacorScSecret) {
    accounts.push({ name: "Colacor SC (Afiação)", account: "colacor_sc", appKey: colacorScKey, appSecret: colacorScSecret });
  }

  const obenKey = Deno.env.get("OMIE_OBEN_APP_KEY");
  const obenSecret = Deno.env.get("OMIE_OBEN_APP_SECRET");
  if (obenKey && obenSecret) {
    accounts.push({ name: "Oben", account: "oben", appKey: obenKey, appSecret: obenSecret });
  }

  const colacorKey = Deno.env.get("OMIE_COLACOR_APP_KEY");
  const colacorSecret = Deno.env.get("OMIE_COLACOR_APP_SECRET");
  if (colacorKey && colacorSecret) {
    accounts.push({ name: "Colacor", account: "colacor", appKey: colacorKey, appSecret: colacorSecret });
  }

  return accounts;
}

async function buscarNomeVendedor(
  codigoVendedor: number,
  appKey: string,
  appSecret: string
): Promise<string | null> {
  try {
    // Omie API: ListarVendedores to get seller name by code
    const result = await callOmieApiWithCredentials(
      "geral/vendedores/",
      "ListarVendedores",
      { pagina: 1, registros_por_pagina: 50, filtrar_por_codigo: codigoVendedor },
      appKey,
      appSecret
    ) as unknown as { cadastro?: Array<{ codigo?: number; nome?: string }> };

    if (result?.cadastro && result.cadastro.length > 0) {
      return result.cadastro[0].nome || null;
    }
    return null;
  } catch (e) {
    console.error(`[buscarNomeVendedor] Erro ao buscar vendedor ${codigoVendedor}:`, e);
    return null;
  }
}

async function validarVendedorMultiOmie(cnpjCpf: string): Promise<{
  consistente: boolean;
  vendedores: Array<{ conta: string; codigo_vendedor: number | null; nome_vendedor: string | null; encontrado: boolean }>;
  divergencias: string[];
}> {
  const docLimpo = cnpjCpf.replace(/\D/g, "");
  const accounts = getOmieAccounts();
  
  const resultados = await Promise.all(
    accounts.map(async (account) => {
      try {
        const result = await callOmieApiWithCredentials(
          "geral/clientes/",
          "ListarClientes",
          { pagina: 1, registros_por_pagina: 1, clientesFiltro: { cnpj_cpf: docLimpo } },
          account.appKey,
          account.appSecret
        );

        if (result.faultstring) {
          return { conta: account.name, codigo_vendedor: null as number | null, nome_vendedor: null as string | null, encontrado: false };
        }

        const clientes = result.clientes_cadastro || result.clientes_cadastro_resumido || [];
        if (clientes.length === 0) {
          return { conta: account.name, codigo_vendedor: null as number | null, nome_vendedor: null as string | null, encontrado: false };
        }

        const cliente = clientes[0];
        const codigoCliente = cliente.codigo_cliente_omie || cliente.codigo_cliente;
        
        let vendedor: number | null = cliente.recomendacoes?.codigo_vendedor || cliente.codigo_vendedor || null;
        
        if (codigoCliente && !vendedor) {
          try {
            const detalhe = await callOmieApiWithCredentials(
              "geral/clientes/",
              "ConsultarCliente",
              { codigo_cliente_omie: codigoCliente },
              account.appKey,
              account.appSecret
            ) as unknown as OmieCliente;
            vendedor = detalhe?.recomendacoes?.codigo_vendedor || detalhe?.codigo_vendedor || null;
          } catch (e) {
            console.error(`[validarVendedor] Erro ao consultar detalhe em ${account.name}:`, e);
          }
        }

        // Buscar o NOME do vendedor para comparação
        let nomeVendedor: string | null = null;
        if (vendedor) {
          nomeVendedor = await buscarNomeVendedor(vendedor, account.appKey, account.appSecret);
        }

        return { conta: account.name, codigo_vendedor: vendedor, nome_vendedor: nomeVendedor, encontrado: true };
      } catch (error) {
        console.error(`[validarVendedor] Erro em ${account.name}:`, error);
        return { conta: account.name, codigo_vendedor: null as number | null, nome_vendedor: null as string | null, encontrado: false };
      }
    })
  );

  // Compare by seller NAME (normalized), not by code
  const encontrados = resultados.filter(r => r.encontrado);
  const nomesNormalizados = encontrados.map(r => (r.nome_vendedor || '').trim().toLowerCase());
  const nomesUnicos = [...new Set(nomesNormalizados)];
  const consistente = nomesUnicos.length <= 1;

  const divergencias: string[] = [];
  if (!consistente) {
    for (const r of encontrados) {
      divergencias.push(`${r.conta}: vendedor "${r.nome_vendedor || 'não definido'}" (cód. ${r.codigo_vendedor || '-'})`);
    }
  }

  return { consistente, vendedores: resultados, divergencias };
}

async function upsertAddressFromOmie(
  adminClient: SupabaseClient,
  userId: string,
  cliente: OmieCliente
): Promise<boolean> {
  try {
    if (!cliente.endereco || !cliente.cidade) return false;

    // Check if user already has an Omie address
    const { data: existing, error: lookupError } = await adminClient
      .from("addresses")
      .select("id")
      .eq("user_id", userId)
      .eq("is_from_omie", true)
      .maybeSingle();

    // Erro de consulta ≠ "não tem endereço": seguir com `existing` undefined tentaria um INSERT
    // por cima de uma linha que pode existir.
    if (lookupError) {
      console.error(`[upsertAddressFromOmie] Lookup failed for user ${userId}:`, lookupError);
      return false;
    }

    const addressData = {
      user_id: userId,
      label: "Omie",
      street: cliente.endereco || "",
      number: cliente.endereco_numero || "S/N",
      complement: cliente.complemento || null,
      neighborhood: cliente.bairro || "",
      city: cliente.cidade || "",
      state: cliente.estado || "",
      zip_code: (cliente.cep || "").replace(/\D/g, ""),
      is_default: true,
      is_from_omie: true,
    };

    // O supabase-js NÃO lança em falha de escrita: devolve { error }. Ignorá-lo fazia esta função
    // retornar `true` sem ter gravado nada — e o `synced` do sync_addresses contava esse endereço
    // como criado. Progresso fabricado: o relatório fechava "concluído" com o trabalho por fazer.
    if (existing) {
      const { error: updateError } = await adminClient
        .from("addresses")
        .update(addressData)
        .eq("id", existing.id);
      if (updateError) {
        console.error(`[upsertAddressFromOmie] Update failed for user ${userId}:`, updateError);
        return false;
      }
    } else {
      const { error: insertError } = await adminClient.from("addresses").insert(addressData);
      if (insertError) {
        console.error(`[upsertAddressFromOmie] Insert failed for user ${userId}:`, insertError);
        return false;
      }
    }
    return true;
  } catch (err) {
    console.error(`[upsertAddressFromOmie] Error for user ${userId}:`, err);
    return false;
  }
}

/**
 * Páginas de `profiles` com documento, por KEYSET em user_id.
 *
 * O PostgREST capa a resposta em 1.000 linhas SILENCIOSAMENTE — sem erro, sem sinal. Uma leitura
 * crua de `profiles` (5.276 hoje) devolve 1.000 (19%), e os 4.276 restantes ficam indistinguíveis
 * de "não existe": quem dedupa por documento cria um usuário Auth NOVO para cliente que já tem
 * cadastro. É a morfologia dos 1.633 placeholders sem profile que já estão no banco.
 *
 * Keyset (`.gt("user_id", cursor)`) e não `.range()`: com offset, uma inserção concorrente desloca
 * as páginas seguintes e pula linhas — e o sync_all_clients INSERE profiles enquanto varre.
 */
async function* paginarProfilesComDocumento(
  adminClient: SupabaseClient,
): AsyncGenerator<Array<{ user_id: string; document: string }>> {
  const pageSize = 1000;
  let cursor: string | null = null;

  while (true) {
    let query = adminClient
      .from("profiles")
      .select("user_id, document")
      .not("document", "is", null)
      .order("user_id")
      .limit(pageSize);
    if (cursor) query = query.gt("user_id", cursor);

    const { data, error } = await query;
    // Fail-closed: erro engolido vira página vazia, que vira "cliente não existe" → clone.
    if (error) throw new Error(`Falha ao paginar profiles: ${error.message}`);
    if (!data || data.length === 0) return;

    const rows = data as Array<{ user_id: string; document: string | null }>;
    yield rows.filter((r): r is { user_id: string; document: string } => !!r.document);

    cursor = rows[rows.length - 1].user_id;
    if (rows.length < pageSize) return;
  }
}

/** Abaixo disto a proof fresca não serve como dedup: importar criaria duplicatas em massa. */
const COBERTURA_MINIMA_PROOF = 0.5;

/**
 * Barra a importação em massa quando a proof fresca está degradada.
 *
 * `omie_customer_account_map_fresco` é a base filtrada por `updated_at >= now() - 7 dias`. Se o
 * omie-analytics-sync ficar uma semana parado (já aconteceu neste repo), a view ESVAZIA — e uma
 * consulta bem-sucedida com zero linhas não acusa erro nenhum. O dedup então enxerga "nenhum
 * código mapeado" e o handler recria do zero milhares de clientes que já existem, cada um com
 * user_id novo. Zero linhas não é "nada a fazer": é cegueira.
 *
 * A base entra aqui só como DENOMINADOR (count) — nunca como fonte de vínculo. Ler vínculo da
 * base é o que reabre o stale infinito que o épico-drop existe para fechar.
 */
async function assertProofFrescaSaudavel(
  adminClient: SupabaseClient,
  account: string,
  codigosFrescos: number,
): Promise<void> {
  const { count, error } = await adminClient
    .from("omie_customer_account_map")
    .select("*", { count: "exact", head: true })
    .eq("account", account);

  if (error) throw new Error(`Falha ao medir cobertura da proof (${account}): ${error.message}`);
  if (!count) return; // conta sem histórico na base: não há baseline com que comparar

  const cobertura = codigosFrescos / count;
  if (cobertura < COBERTURA_MINIMA_PROOF) {
    throw new Error(
      `Proof fresca degradada em ${account}: ${codigosFrescos}/${count} códigos ` +
        `(${(cobertura * 100).toFixed(1)}% < ${COBERTURA_MINIMA_PROOF * 100}%). ` +
        `Rode o omie-analytics-sync antes — importar agora criaria clientes duplicados.`,
    );
  }
}

function isIndustrialByCNAE(cnae: string): boolean {
  if (!cnae) return false;
  const cnaeCode = cnae.replace(/\D/g, '');
  return CNAES_INDUSTRIAIS.some(prefix => cnaeCode.startsWith(prefix.replace('.', '')));
}

async function consultarCNPJ(cnpj: string): Promise<CNPJData | null> {
  const cnpjLimpo = cnpj.replace(/\D/g, '');
  if (cnpjLimpo.length !== 14) return null;

  try {
    const response = await fetch(`${RECEITA_API_URL}/${cnpjLimpo}`, {
      headers: { 'Accept': 'application/json' },
    });
    const data = await response.json();
    if (data.status === 'ERROR') return null;
    return data;
  } catch (error) {
    console.error('[ReceitaWS] Erro:', error);
    return null;
  }
}

function isEmployeeByTags(tags: Array<{ tag: string }> | undefined): boolean {
  if (!tags || !Array.isArray(tags)) return false;
  return tags.some(t => 
    t.tag?.toLowerCase().includes('funcionário') || 
    t.tag?.toLowerCase().includes('funcionario')
  );
}

async function buscarClientePorDocumento(documento: string): Promise<{ cliente: OmieCliente | null; cnpjData: CNPJData | null; isIndustrial: boolean; isEmployee: boolean }> {
  const docLimpo = documento.replace(/\D/g, "");
  
  if (docLimpo.length !== 11 && docLimpo.length !== 14) {
    throw new Error("Documento inválido. Informe um CPF (11 dígitos) ou CNPJ (14 dígitos)");
  }

  let cnpjData: CNPJData | null = null;
  let isIndustrial = false;

  if (docLimpo.length === 14) {
    cnpjData = await consultarCNPJ(docLimpo);
    if (cnpjData?.atividade_principal?.[0]?.code) {
      isIndustrial = isIndustrialByCNAE(cnpjData.atividade_principal[0].code);
    }
  }

  try {
    const result = await callOmieApi("geral/clientes/", "ListarClientes", {
      pagina: 1,
      registros_por_pagina: 1,
      clientesFiltro: { cnpj_cpf: docLimpo },
    });

    if (result.faultstring) {
      if (result.faultstring.includes("Nenhum registro") || result.faultstring.includes("não encontrado")) {
        return { cliente: null, cnpjData, isIndustrial, isEmployee: false };
      }
      throw new Error(`Erro Omie: ${result.faultstring}`);
    }

    const clientes = result.clientes_cadastro || result.clientes_cadastro_resumido;
    if (!clientes || clientes.length === 0) {
      return { cliente: null, cnpjData, isIndustrial, isEmployee: false };
    }

    const clienteResumo = clientes[0];
    let clienteCompleto = clienteResumo;
    
    if (clienteResumo.codigo_cliente) {
      const detalheResult = await callOmieApi("geral/clientes/", "ConsultarCliente", {
        codigo_cliente: clienteResumo.codigo_cliente,
      }) as unknown as OmieCliente;
      clienteCompleto = detalheResult;
    }

    const isEmployee = isEmployeeByTags(clienteCompleto.tags);
    return { cliente: clienteCompleto, cnpjData, isIndustrial, isEmployee };
  } catch (error) {
    if (error instanceof Error && 
        (error.message.includes("Nenhum registro") || 
         error.message.includes("não encontrado") ||
         error.message.includes("não localizado"))) {
      return { cliente: null, cnpjData, isIndustrial, isEmployee: false };
    }
    throw error;
  }
}


async function pesquisarClientes(query: string, pagina: number = 1): Promise<{ clientes: OmieCliente[]; total: number }> {
  try {
    // Use ListarClientes (full) instead of ListarClientesResumido to get codigo_vendedor
    const result = await callOmieApi("geral/clientes/", "ListarClientes", {
      pagina,
      registros_por_pagina: 50,
      clientesFiltro: { nome_fantasia: query },
    });

    if (result.faultstring) {
      if (result.faultstring.includes("Nenhum registro") || result.faultstring.includes("não encontrado")) {
        return { clientes: [], total: 0 };
      }
      throw new Error(`Erro Omie: ${result.faultstring}`);
    }

    const clientes = result.clientes_cadastro || result.clientes_cadastro_resumido || [];
    return { 
      clientes, 
      total: result.total_de_registros || clientes.length 
    };
  } catch (error) {
    if (error instanceof Error && 
        (error.message.includes("Nenhum registro") || 
         error.message.includes("não encontrado"))) {
      return { clientes: [], total: 0 };
    }
    throw error;
  }
}

async function consultarClienteCompleto(codigoCliente: number): Promise<OmieCliente | null> {
  try {
    const result = await callOmieApi("geral/clientes/", "ConsultarCliente", {
      codigo_cliente_omie: codigoCliente,
    }) as unknown as OmieCliente;
    return result;
  } catch (error) {
    console.error('[Omie] Erro ao consultar cliente:', error);
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, documento, query, codigo_cliente } = body;

    // Input validation
    if (!action || typeof action !== "string") {
      return new Response(
        JSON.stringify({ error: "Ação inválida" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // buscar_por_documento is allowed without auth (used during signup)
    // All other actions require authentication
    if (action !== "buscar_por_documento") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return new Response(
          JSON.stringify({ error: "Não autorizado" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
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

      // Staff-only gate for sensitive/privileged actions. Only buscar_por_documento
      // remains JWT-only (used by the public client lookup flow with rate limit).
      const STAFF_ONLY_ACTIONS = new Set([
        "pesquisar_clientes",
        "consultar_cliente",
        "criar_perfil_local",
        "sync_all_clients",
        "sync_addresses",
        "buscar_logos_empresas",
        "validar_vendedor",
      ]);
      if (STAFF_ONLY_ACTIONS.has(action)) {
        const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const adminClient = createClient(supabaseUrl, serviceRoleKey);
        const { data: roleRows, error: roleErr } = await adminClient
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id);
        if (roleErr) {
          return new Response(
            JSON.stringify({ error: "Falha ao verificar permissões" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const allowed = new Set(["employee", "master"]);
        const hasStaff = (roleRows ?? []).some((r: { role: string }) => allowed.has(r.role));
        if (!hasStaff) {
          return new Response(
            JSON.stringify({ error: "Acesso restrito a equipe interna" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
    } else {
      // Pre-signup: rate-limit por IP (5/min)
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
        || req.headers.get("cf-connecting-ip")
        || "unknown";
      if (!checkRateLimit(ip)) {
        return new Response(
          JSON.stringify({ error: "Muitas requisições. Tente novamente em alguns instantes." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    let result: Record<string, unknown> = {};

    switch (action) {
      case "buscar_por_documento": {
        if (!documento || typeof documento !== "string" || documento.length > 20) {
          return new Response(
            JSON.stringify({ error: "Documento inválido" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const { cliente, cnpjData } = await buscarClientePorDocumento(documento);

        // Pre-signup: retorna apenas {existe, razao_social} (sem PII)
        if (cliente) {
          result = { existe: true, razao_social: cliente.razao_social ?? null };
        } else if (cnpjData) {
          result = { existe: false, razao_social: cnpjData.nome ?? null };
        } else {
          result = { existe: false, razao_social: null };
        }
        break;
      }

      case "pesquisar_clientes": {
        if (!query || typeof query !== "string" || query.length < 3) {
          return new Response(
            JSON.stringify({ error: "Informe pelo menos 3 caracteres para pesquisar" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const searchResult = await pesquisarClientes(query);
        result = {
          clientes: searchResult.clientes.map(c => ({
            codigo_cliente: c.codigo_cliente_omie || c.codigo_cliente,
            razao_social: c.razao_social,
            nome_fantasia: c.nome_fantasia,
            cnpj_cpf: c.cnpj_cpf,
            email: c.email,
            telefone: c.telefone1_numero,
            cidade: c.cidade,
            estado: c.estado,
            codigo_vendedor: c.recomendacoes?.codigo_vendedor || c.codigo_vendedor || null,
          })),
          total: searchResult.total,
        };
        break;
      }

      case "consultar_cliente": {
        if (!codigo_cliente || typeof codigo_cliente !== "number") {
          return new Response(
            JSON.stringify({ error: "Código do cliente inválido" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const clienteCompleto = await consultarClienteCompleto(codigo_cliente);
        if (clienteCompleto) {
          result = {
            found: true,
            cliente: {
              codigo_cliente: clienteCompleto.codigo_cliente,
              razao_social: clienteCompleto.razao_social,
              nome_fantasia: clienteCompleto.nome_fantasia,
              cnpj_cpf: clienteCompleto.cnpj_cpf,
              email: clienteCompleto.email,
              telefone: clienteCompleto.telefone1_numero,
              endereco: clienteCompleto.endereco,
              endereco_numero: clienteCompleto.endereco_numero,
              complemento: clienteCompleto.complemento,
              bairro: clienteCompleto.bairro,
              cidade: clienteCompleto.cidade,
              estado: clienteCompleto.estado,
              cep: clienteCompleto.cep,
              pessoa_fisica: clienteCompleto.pessoa_fisica,
              inscricao_estadual: clienteCompleto.inscricao_estadual,
              codigo_vendedor: clienteCompleto.recomendacoes?.codigo_vendedor || clienteCompleto.codigo_vendedor,
            },
          };
        } else {
          result = { found: false, cliente: null };
        }
        break;
      }

      case "criar_perfil_local": {
        const { cliente } = body;
        if (!cliente || !cliente.codigo_cliente) {
          return new Response(
            JSON.stringify({ error: "Dados do cliente inválidos" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const adminClient = createClient(supabaseUrl, supabaseServiceKey);

        // Resolve codigo->user_id pela proof fresca account-correta (account='oben').
        // O ÚNICO chamador é o fluxo de vendas OBEN (useUnifiedOrder.handleStaffAddTool), que passa
        // selectedCustomer.codigo_cliente — código da conta OBEN — e JÁ resolve esse mesmo código pela
        // fresca com .eq('account','oben') antes de invocar (#1331). Buscá-lo no espelho omie_clientes
        // SEM conta lia um código de conta INDETERMINADA: o espelho é UNIQUE(user_id) (1 linha/user,
        // sobrescrita pelo writer da vez) e empresa_omie é 'colacor' em 100% das linhas — rótulo
        // mentiroso. Divergir da conta do chamador aqui anexaria a ferramenta ao cliente ERRADO.
        // Miss (ausente ou stale >7d) cai no fallback por documento abaixo — fail-closed.
        const { data: existingMapping, error: mappingLookupError } = await adminClient
          .from("omie_customer_account_map_fresco")
          .select("user_id")
          .eq("omie_codigo_cliente", cliente.codigo_cliente)
          .eq("account", "oben")
          .maybeSingle();

        // Erro de consulta NÃO é miss. Tratar os dois igual seguiria para a criação de um usuário
        // Auth novo por indisponibilidade momentânea do banco — clone permanente por falha
        // transitória. Fail-closed: aborta e o chamador reporta (ele tem o próprio fallback).
        if (mappingLookupError) {
          throw new Error(`Falha ao consultar vínculo na proof fresca: ${mappingLookupError.message}`);
        }

        // user_id da view é nulável (view sem NOT NULL) → null = miss, cai no fallback por documento.
        if (existingMapping?.user_id) {
          result = { user_id: existingMapping.user_id };
          break;
        }

        // Check if a profile with the same document (CPF/CNPJ) already exists
        if (cliente.cnpj_cpf) {
          const docLimpo = cliente.cnpj_cpf.replace(/\D/g, "");
          if (docLimpo.length >= 11) {
            // Caminho rápido: o documento é gravado já normalizado por este edge e pelo
            // sync_all_clients, então o match direto resolve o caso comum sem varrer a tabela.
            // `.order("created_at")` não é cosmético: documento duplicado EXISTE (é o rastro dos
            // clones). Sem ordem, o PostgREST devolve uma linha arbitrária e o mesmo cliente podia
            // cair ora no perfil real, ora no clone. O mais ANTIGO é o canônico — o clone veio depois.
            const { data: docHit, error: docHitError } = await adminClient
              .from("profiles")
              .select("user_id")
              .eq("document", docLimpo)
              .order("created_at")
              .limit(1);
            if (docHitError) {
              throw new Error(`Falha ao buscar perfil por documento: ${docHitError.message}`);
            }

            let matchedUserId = (docHit?.[0] as { user_id: string } | undefined)?.user_id;

            // Legado formatado ("12.345.678/0001-90") só casa normalizando os dois lados — varredura
            // PAGINADA. Antes era um SELECT cru da tabela inteira, capado em 1.000 linhas pelo
            // PostgREST: perfil fora dessa janela lia como inexistente e o fluxo criava um usuário
            // novo para quem já tinha cadastro.
            if (!matchedUserId) {
              for await (const pagina of paginarProfilesComDocumento(adminClient)) {
                const hit = pagina.find((p) => p.document.replace(/\D/g, "") === docLimpo);
                if (hit) {
                  matchedUserId = hit.user_id;
                  break;
                }
              }
            }

            if (matchedUserId) {
              // Profile exists — admite o membro na carteira (ledger + proof). P0-B-bis Fatia 4: era um
              // INSERT no espelho `omie_clientes`, que grava SEM conta (rótulo 'colacor' default, falso).
              // A conta aqui é 'oben' e não é chute: o único chamador deste case é o fluxo de vendas OBEN
              // (`useUnifiedOrder.handleStaffAddTool`), e a resolução logo acima usa `.eq("account","oben")`.
              console.log(`[criar_perfil_local] Found existing profile by document ${docLimpo}, linking to user ${matchedUserId}`);
              const { error: mappingError } = await adminClient.rpc("register_carteira_member", {
                p_user_id: matchedUserId,
                p_account: "oben",
                p_omie_codigo_cliente: cliente.codigo_cliente,
                p_omie_codigo_vendedor: cliente.codigo_vendedor || null,
              });
              // [HOTFIX Codex-B] FAIL-LOUD. Antes isto só logava e devolvia user_id como SUCESSO — o
              // tratamento herdado de quando o destino era o espelho poluído, onde um erro era inócuo.
              // Com a UNIQUE(codigo,account) fail-closed da proof, `23505` significa "este código Omie
              // pertence a OUTRO user nesta conta". Devolver sucesso faz a UI seguir e anexar a
              // ferramenta ao cliente ERRADO (useUnifiedOrder.handleStaffAddTool usa o user_id de volta).
              if (mappingError) {
                console.error("[criar_perfil_local] Mapping error:", mappingError);
                return new Response(
                  JSON.stringify({
                    error: mappingError.code === "23505"
                      ? `O código Omie ${cliente.codigo_cliente} já está vinculado a outro usuário na conta oben — vínculo bloqueado por segurança.`
                      : `Falha ao registrar o vínculo do cliente: ${mappingError.message}`,
                  }),
                  { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
                );
              }
              result = { user_id: matchedUserId };
              break;
            }
          }
        }

        // Create a real auth user via admin API (with a placeholder email)
        const placeholderEmail = `omie_${cliente.codigo_cliente}@placeholder.local`;
        const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
          email: placeholderEmail,
          email_confirm: true,
          user_metadata: {
            omie_codigo_cliente: cliente.codigo_cliente,
            is_placeholder: true,
          },
        });

        if (authError) {
          console.error("[criar_perfil_local] Auth error:", authError);
          throw new Error("Erro ao criar usuário placeholder");
        }

        const newUserId = authData.user.id;

        // Create profile (trigger auto_assign_user_role will assign 'customer')
        const { error: profileError } = await adminClient
          .from("profiles")
          .insert({
            user_id: newUserId,
            name: cliente.nome_fantasia || cliente.razao_social || "Cliente",
            email: cliente.email || null,
            phone: cliente.telefone || null,
            document: cliente.cnpj_cpf ? cliente.cnpj_cpf.replace(/\D/g, "") : null,
          });

        if (profileError) {
          console.error("[criar_perfil_local] Profile error:", profileError);
          // Don't throw - user was created, profile might have partial issues
        }

        // Admite o placeholder recém-criado na carteira (ledger + proof). Mesma conta 'oben' do ramo
        // acima — é o mesmo case, mesmo chamador (fluxo de vendas OBEN).
        const { error: mappingError } = await adminClient.rpc("register_carteira_member", {
          p_user_id: newUserId,
          p_account: "oben",
          p_omie_codigo_cliente: cliente.codigo_cliente,
          p_omie_codigo_vendedor: cliente.codigo_vendedor || null,  // Already extracted by frontend from recomendacoes
        });

        // [HOTFIX Codex-B] FAIL-LOUD, mesmo motivo do ramo acima — e aqui é PIOR: o auth user e o
        // profile já foram criados em transações anteriores, então devolver sucesso entregaria à UI um
        // user_id recém-criado SEM vínculo, e a ferramenta seria anexada a um placeholder órfão enquanto
        // o código real pertence a outro cliente. O placeholder criado antes da colisão fica para
        // reconciliação (o erro nomeia o código, que é a chave para achá-lo).
        if (mappingError) {
          console.error("[criar_perfil_local] Mapping error (placeholder já criado:", newUserId, "):", mappingError);
          return new Response(
            JSON.stringify({
              error: mappingError.code === "23505"
                ? `O código Omie ${cliente.codigo_cliente} já está vinculado a outro usuário na conta oben — vínculo bloqueado por segurança.`
                : `Falha ao registrar o vínculo do cliente: ${mappingError.message}`,
              placeholder_user_id: newUserId,
            }),
            { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        // Upsert address from Omie data
        await upsertAddressFromOmie(adminClient, newUserId, cliente);

        result = { user_id: newUserId };
        break;
      }

      case "sync_all_clients": {
        // Bulk import clients from one Omie account at a time (to avoid timeout)
        // Pass account_index: 0, 1, 2 and start_page (default 1)
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const adminClient = createClient(supabaseUrl, supabaseServiceKey);

        const accounts = getOmieAccounts();
        const accountIndex = body.account_index ?? 0;
        const startPage = body.start_page ?? 1;
        const maxPages = 3; // Process max 3 pages per call (~150 clients) to stay within timeout

        if (accountIndex >= accounts.length) {
          result = { done: true, message: "All accounts processed" };
          break;
        }

        const account = accounts[accountIndex];
        let page = startPage;
        let totalPages = startPage;
        let accImported = 0;
        let accSkipped = 0;
        let accErrors = 0;
        let pagesProcessed = 0;

        // Códigos JÁ mapeados NESTA conta, pela proof fresca account-correta. Antes vinha de
        // .select("omie_codigo_cliente") do espelho omie_clientes: (a) SEM filtro de conta — e o
        // espelho é UNIQUE(user_id), 1 linha/user sobrescrita pelo writer da vez, com empresa_omie
        // 'colacor' em 100% das linhas → o Set misturava códigos de contas diferentes; (b) SEM
        // .range() → capado em 1.000 linhas silencioso (armadilha PostgREST) de 6.909 → o dedup
        // enxergava 1/7 dos códigos e o loop reprocessava o resto. A fresca dá os códigos DESTA
        // conta, paginados com .order estável.
        const existingCodes = new Set<number>();
        let codeCursor: number | null = null;
        const codePageSize = 1000;
        while (true) {
          // Keyset, não `.range()`: a fresca é uma view DESLIZANTE (TTL de 7 dias). Com offset, uma
          // linha que expira entre duas páginas desloca todas as seguintes e o dedup PULA códigos —
          // e código pulado aqui vira cliente RECRIADO no laço de importação abaixo.
          let codeQuery = adminClient
            .from("omie_customer_account_map_fresco")
            .select("omie_codigo_cliente")
            .eq("account", account.account)
            .order("omie_codigo_cliente")
            .limit(codePageSize);
          if (codeCursor !== null) codeQuery = codeQuery.gt("omie_codigo_cliente", codeCursor);

          const { data: codePage, error: codeErr } = await codeQuery;
          // Fail-closed: engolir o erro deixaria o Set vazio/parcial e o loop tentaria RECRIAR
          // milhares de clientes já existentes (Codex P2 do PR-2, mesma armadilha).
          if (codeErr) throw new Error(`Falha ao carregar códigos já mapeados (${account.account}): ${codeErr.message}`);
          if (!codePage || codePage.length === 0) break;
          for (const row of codePage) existingCodes.add(row.omie_codigo_cliente as number);
          codeCursor = codePage[codePage.length - 1].omie_codigo_cliente as number;
          if (codePage.length < codePageSize) break;
        }

        // O `codeErr` acima só pega erro SQL. Uma consulta BEM-SUCEDIDA com zero linhas (view
        // expirada porque o omie-analytics-sync parou) passa limpo e é o cenário mais destrutivo:
        // dedup cego reimporta a conta inteira. Barra ANTES de qualquer criação de identidade.
        await assertProofFrescaSaudavel(adminClient, account.account, existingCodes.size);

        // Dedup por documento — paginado. Era um SELECT cru de `profiles` capado em 1.000 de 5.276
        // (19%): para os outros 81%, `profileByDoc.get()` devolvia undefined e o laço abaixo criava
        // um usuário Auth NOVO para cliente que já tinha cadastro. Esta é a fábrica dos clones.
        const profileByDoc = new Map<string, string>();
        for await (const pagina of paginarProfilesComDocumento(adminClient)) {
          for (const p of pagina) profileByDoc.set(p.document.replace(/\D/g, ""), p.user_id);
        }

        console.log(`[sync_all_clients] Starting ${account.name} from page ${startPage}...`);

        while (page <= totalPages && pagesProcessed < maxPages) {
          try {
            const listResult = await callOmieApiWithCredentials(
              "geral/clientes/",
              "ListarClientes",
              { pagina: page, registros_por_pagina: 50 },
              account.appKey,
              account.appSecret
            );

            if (listResult.faultstring) {
              console.error(`[sync_all_clients] ${account.name} page ${page} error: ${listResult.faultstring}`);
              break;
            }

            totalPages = listResult.total_de_paginas || 1;
            const clientes = listResult.clientes_cadastro || [];

            for (const cliente of clientes) {
              const codigoCliente = cliente.codigo_cliente_omie || cliente.codigo_cliente;
              const cnpjCpf = cliente.cnpj_cpf?.replace(/\D/g, "") || "";

              if (!codigoCliente || cnpjCpf.length < 11) {
                accSkipped++;
                continue;
              }

              if (existingCodes.has(codigoCliente)) {
                accSkipped++;
                continue;
              }

              try {
                let userId = profileByDoc.get(cnpjCpf);

                if (!userId) {
                  // Create placeholder user
                  const placeholderEmail = `omie_${codigoCliente}@placeholder.local`;
                  const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
                    email: placeholderEmail,
                    email_confirm: true,
                    user_metadata: { omie_codigo_cliente: codigoCliente, is_placeholder: true },
                  });

                  if (authError) {
                    accErrors++;
                    continue;
                  }

                  userId = authData.user.id;
                  // O supabase-js NÃO lança em falha de escrita: devolve { error }. Ignorá-lo
                  // deixava o usuário Auth recém-criado SEM profile — órfão — e o laço seguia
                  // contando "importado". Nenhum UNIQUE segura: o user_id acabou de nascer.
                  const { error: profileError } = await adminClient.from("profiles").insert({
                    user_id: userId,
                    name: cliente.nome_fantasia || cliente.razao_social || "Cliente",
                    email: cliente.email || null,
                    phone: cliente.telefone1_numero || null,
                    document: cnpjCpf,
                  });
                  if (profileError) {
                    console.error(`[sync_all_clients] profile insert falhou (user ${userId}, código ${codigoCliente}):`, profileError);
                    accErrors++;
                    continue;
                  }
                  profileByDoc.set(cnpjCpf, userId);
                }

                const codigoVendedor = cliente.recomendacoes?.codigo_vendedor || cliente.codigo_vendedor || null;
                // P0-B-bis Fatia 4: era um INSERT no espelho. `account.account` é o slug canônico da
                // conta DESTE run do import (o mesmo usado no dedup por `omie_customer_account_map_fresco`
                // acima) — o espelho gravava sem conta e rotulava tudo 'colacor'.
                // `omie_codigo_cliente_integracao` foi descartado com o espelho (resíduo §9: 41 linhas em
                // 6909, todas de março, zero leitores).
                const { error: mappingError } = await adminClient.rpc("register_carteira_member", {
                  p_user_id: userId,
                  p_account: account.account,
                  p_omie_codigo_cliente: codigoCliente,
                  p_omie_codigo_vendedor: codigoVendedor,
                });
                // Sem o vínculo o cliente NÃO foi importado: fica invisível ao dedup da próxima
                // execução e seria recriado. Conta erro em vez de sucesso silencioso. (#1425)
                // Um 23505 aqui é o fail-closed da UNIQUE(codigo,account): o código já é de OUTRO user
                // nesta conta — não roubamos o vínculo, contamos o erro e seguimos.
                if (mappingError) {
                  console.error(`[sync_all_clients] register_carteira_member falhou (user ${userId}, código ${codigoCliente}):`, mappingError);
                  accErrors++;
                  continue;
                }

                existingCodes.add(codigoCliente);
                
                // Upsert address from Omie data
                await upsertAddressFromOmie(adminClient, userId, cliente);
                
                accImported++;
              } catch (clientError) {
                accErrors++;
              }
            }

            console.log(`[sync_all_clients] ${account.name} page ${page}/${totalPages}: +${clientes.length} clientes`);
            page++;
            pagesProcessed++;
          } catch (pageError) {
            console.error(`[sync_all_clients] ${account.name} page ${page} failed:`, pageError);
            break;
          }
        }

        const hasMore = page <= totalPages;
        const nextAccountIndex = hasMore ? accountIndex : accountIndex + 1;
        const nextPage = hasMore ? page : 1;

        result = {
          account: account.name,
          imported: accImported,
          skipped: accSkipped,
          errors: accErrors,
          totalPages,
          lastPage: page - 1,
          hasMore: hasMore || nextAccountIndex < accounts.length,
          next: { account_index: nextAccountIndex, start_page: nextPage },
        };
        break;
      }

      case "sync_addresses": {
        // Bulk sync addresses in batches. Supports offset for iterative calls.
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const adminClient = createClient(supabaseUrl, supabaseServiceKey);

        const accounts = getOmieAccounts();
        const batchSize = body.batch_size || 30; // max per call to avoid timeout
        const offset = body.offset || 0;

        let totalSynced = 0;
        let totalSkipped = 0;
        let totalErrors = 0;

        // Get ALL user_ids that already have addresses (paginate to bypass 1000 row limit)
        let allAddressUserIds: string[] = [];
        let addrOffset = 0;
        while (true) {
          const { data: addrPage } = await adminClient
            .from("addresses")
            .select("user_id")
            .range(addrOffset, addrOffset + 999);
          if (!addrPage || addrPage.length === 0) break;
          const addrRows = addrPage as unknown as Array<{ user_id: string }>;
          allAddressUserIds = allAddressUserIds.concat(addrRows.map((a) => a.user_id));
          if (addrPage.length < 1000) break;
          addrOffset += 1000;
        }
        const usersWithAddress = new Set(allAddressUserIds);

        // Mapeamentos (user, conta, código) pela proof fresca account-correta, paginado com .order
        // estável. Antes vinha de .select("user_id, omie_codigo_cliente") do espelho omie_clientes,
        // que é UNIQUE(user_id): 1 linha por user com o código da ÚLTIMA conta que escreveu (e
        // empresa_omie 'colacor' em 100% das linhas, rótulo mentiroso) — o loop abaixo então chutava
        // esse código indeterminado nas 3 contas até uma responder. A proof tem 1 linha por
        // (user, conta), então sabemos a conta CERTA de cada código.
        const allMappings: Array<{ user_id: string; account: string; omie_codigo_cliente: number }> = [];
        const paresVistos = new Set<string>();
        let userCursor: string | null = null;
        const fetchPageSize = 1000;
        while (true) {
          // Keyset, não `.range()`: a fresca é uma view DESLIZANTE (TTL de 7 dias) e, com offset,
          // uma linha que expira entre duas páginas desloca as seguintes e PULA users — que ficam
          // sem endereço sem ninguém notar. `.gte` e não `.gt` para não perder as contas restantes
          // do user partido na fronteira da página; o Set desduplica a sobra reprocessada.
          let query = adminClient
            .from("omie_customer_account_map_fresco")
            .select("user_id, account, omie_codigo_cliente")
            .order("user_id")
            .order("account")
            .limit(fetchPageSize);
          if (userCursor) query = query.gte("user_id", userCursor);

          const { data: page, error: pageErr } = await query;
          // Fail-closed: engolir o erro daria "No client mappings found" — um NO-OP mudo que parece sucesso.
          if (pageErr) throw new Error(`Falha ao carregar mapeamentos da proof: ${pageErr.message}`);
          if (!page || page.length === 0) break;

          const rows = page as typeof allMappings;
          let novos = 0;
          for (const m of rows) {
            const chave = `${m.user_id}|${m.account}`;
            if (paresVistos.has(chave)) continue;
            paresVistos.add(chave);
            allMappings.push(m);
            novos++;
          }

          const ultimoUser = rows[rows.length - 1].user_id;
          // Guard de não-avanço: só ocorreria com um user ocupando a página inteira (>1.000 contas),
          // mas sem ele um cursor parado é laço infinito.
          if (rows.length < fetchPageSize || (novos === 0 && ultimoUser === userCursor)) break;
          userCursor = ultimoUser;
        }

        // Agrupa por user: a proof tem até 1 linha por (user, conta) e o batch conta USERS (o espelho
        // tinha 1 linha/user, então sem agrupar um batch_size=30 viraria ~10 users e o lote encolheria).
        const codesByUser = new Map<string, Array<{ account: string; codigo: number }>>();
        for (const m of allMappings) {
          const list = codesByUser.get(m.user_id) ?? [];
          list.push({ account: m.account, codigo: m.omie_codigo_cliente });
          codesByUser.set(m.user_id, list);
        }
        const totalCount = codesByUser.size;

        if (totalCount === 0) {
          // Proof fresca vazia NÃO é "nada a fazer": a fresca é a base filtrada por TTL de 7 dias,
          // então zero linhas com a base cheia significa sync parado há uma semana. Responder
          // 200/zeros pinta "concluído" na UI e esconde a base inteira por processar (fail-open).
          const { count: baseCount } = await adminClient
            .from("omie_customer_account_map")
            .select("*", { count: "exact", head: true });
          if (baseCount && baseCount > 0) {
            throw new Error(
              `Proof fresca vazia com ${baseCount} vínculos na base: o omie-analytics-sync está ` +
                `parado (TTL de 7 dias). Rode-o antes de sincronizar endereços.`,
            );
          }
          result = { synced: 0, skipped: 0, errors: 0, hasMore: false, message: "No client mappings found" };
          break;
        }

        // Filter to those without addresses
        const clientsNeedingAddress = [...codesByUser.keys()].filter((userId) => !usersWithAddress.has(userId));
        const totalNeeding = clientsNeedingAddress.length;

        // A lista encolhe sozinha a cada endereço criado (quem sincroniza sai do filtro acima), então
        // o offset só precisa saltar quem NÃO drena: user sem credencial da conta, sem endereço na
        // Omie, ou com erro. Sem esse salto, `slice(0, batchSize)` devolve eternamente os mesmos 30
        // "poison users" e o caller (useAnalyticsSync: `while (hasMore)`) nunca termina — Codex P1.
        const batch = clientsNeedingAddress.slice(offset, offset + batchSize);
        console.log(`[sync_addresses] Processing batch size=${batch.length}, offset=${offset}, totalNeeding=${totalNeeding}`);

        // Chave `string` de propósito: o account vem da proof (dado externo). Slug desconhecido ou
        // sem credencial nesta edge → .get() undefined → o guard abaixo pula (fail-closed).
        const accountBySlug = new Map<string, OmieAccountConfig>(accounts.map((a) => [a.account, a]));

        // Prioridade EXPLÍCITA de qual conta dá o endereço de um user multi-conta: a ordem em que
        // esta edge declara as contas (getOmieAccounts → colacor_sc, oben, colacor), a mesma que o
        // account_index do sync_all_clients já usa. Antes a ordem saía do `.order("account")` da
        // consulta — alfabética (colacor < colacor_sc < oben): collation virando regra de negócio,
        // com o endereço default vindo de uma conta que ninguém escolheu (Codex).
        // Chave `string` pelo mesmo motivo do accountBySlug: o account vem da proof (dado externo).
        // Slug fora da lista → rank MAX_SAFE_INTEGER → tentado por último, nunca antes de uma conta
        // conhecida (fail-closed).
        const accountRank = new Map<string, number>(accounts.map((a, i) => [a.account, i]));

        for (const userId of batch) {
          try {
            let clienteData: OmieCliente | null = null;

            // Só as contas onde o user REALMENTE tem cadastro, cada uma com o código DAQUELA conta
            // (a proof garante o par). Antes: o mesmo código indeterminado era chutado nas 3 contas
            // até uma responder — até 3x chamadas Omie e, sob colisão de código entre contas, o
            // endereço de OUTRO cliente. Mantém "tenta até achar endereço" entre as contas do user.
            const entradasDoUser = [...(codesByUser.get(userId) ?? [])].sort(
              (a, b) =>
                (accountRank.get(a.account) ?? Number.MAX_SAFE_INTEGER) -
                (accountRank.get(b.account) ?? Number.MAX_SAFE_INTEGER),
            );

            for (const entry of entradasDoUser) {
              const conta = accountBySlug.get(entry.account);
              // Conta sem credencial nesta edge → pula (fail-closed: não tenta o código em outra conta).
              if (!conta) continue;
              try {
                const detailResult = await callOmieApiWithCredentials(
                  "geral/clientes/",
                  "ConsultarCliente",
                  { codigo_cliente_omie: entry.codigo },
                  conta.appKey,
                  conta.appSecret
                ) as unknown as OmieCliente;

                if (detailResult && detailResult.endereco && detailResult.cidade) {
                  clienteData = detailResult;
                  break;
                }
              } catch {
                // Sem cadastro/endereço nesta conta do user → tenta a próxima conta DELE
              }
            }

            if (!clienteData || !clienteData.endereco || !clienteData.cidade) {
              totalSkipped++;
              continue;
            }

            const inserted = await upsertAddressFromOmie(adminClient, userId, clienteData);
            if (inserted) {
              totalSynced++;
            } else {
              totalSkipped++;
            }
          } catch (err) {
            console.error(`[sync_addresses] Error for user ${userId}:`, err);
            totalErrors++;
          }
        }

        // Quem sincronizou sai da lista sozinho; quem foi pulado/errou continua nela e precisa ser
        // SALTADO no próximo lote.
        const naoDrenados = batch.length - totalSynced;
        const nextOffset = offset + naoDrenados;

        // Caller que pagina (passa `offset`) drena até o fim, inclusive a cauda de poison users.
        // O caller legado recomeça do zero a cada chamada — então só continua se ALGO drenou aqui;
        // senão o próximo lote seria idêntico a este, e o `while (hasMore)` dele giraria para sempre.
        const chamadorPagina = body.offset !== undefined;
        const hasMore = chamadorPagina
          ? nextOffset < totalNeeding
          : totalSynced > 0 && nextOffset < totalNeeding;

        result = {
          synced: totalSynced,
          skipped: totalSkipped,
          errors: totalErrors,
          totalNeeding,
          totalClients: totalCount,
          processed: batch.length,
          hasMore,
          next: { offset: nextOffset },
          // Lote inteiro sem drenar: o que resta só é alcançável passando `offset`.
          stalled: batch.length > 0 && totalSynced === 0,
        };
        break;
      }

      case "buscar_logos_empresas": {
        const logos: Record<string, string | null> = {};
        const accounts = getOmieAccounts();
        const accountLabels: Record<string, string> = {
          "Colacor (Afiação)": "afiacao",
          "Oben (Vendas)": "oben",
          "Colacor (Vendas)": "colacor",
        };
        for (const account of accounts) {
          const label = accountLabels[account.name] || account.name;
          try {
            const empresaResult = await callOmieApiWithCredentials(
              "geral/empresas/",
              "ListarEmpresas",
              { pagina: 1, registros_por_pagina: 1 },
              account.appKey,
              account.appSecret
            ) as unknown as Record<string, unknown>;
            console.log(`[buscar_logos] ${account.name} response keys:`, JSON.stringify(Object.keys(empresaResult)));
            const empresas = (empresaResult?.empresas_cadastro || empresaResult?.empresa_cadastro) as Array<Record<string, unknown>> | undefined;
            if (empresas && empresas.length > 0) {
              const empresa = empresas[0];
              console.log(`[buscar_logos] ${account.name} empresa keys:`, JSON.stringify(Object.keys(empresa)));
              // Try multiple possible field names
              logos[label] = (empresa.cUrlLogoEmpresa || empresa.logo || empresa.cLogoBase64 || empresa.url_logo || null) as string | null;
            } else {
              console.log(`[buscar_logos] ${account.name} no empresas found in response`);
              logos[label] = null;
            }
          } catch (e) {
            console.error(`[buscar_logos] Erro em ${account.name}:`, e);
            logos[label] = null;
          }
        }
        result = { logos };
        break;
      }

      case "validar_vendedor": {
        const { cnpj_cpf } = body;
        if (!cnpj_cpf || typeof cnpj_cpf !== "string") {
          return new Response(
            JSON.stringify({ error: "CPF/CNPJ inválido" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const validacao = await validarVendedorMultiOmie(cnpj_cpf);
        result = validacao;
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
    return new Response(
      JSON.stringify({ error: "Erro ao processar solicitação" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
