import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

type OmieGenericResponse = Record<string, unknown> & { faultstring?: string; codigo_status?: number | string; descricao_status?: string };

interface OmieProdutoCadastro {
  codigo_produto?: number;
  codigo_produto_integracao?: string | null;
  codigo?: string;
  descricao?: string;
  unidade?: string;
  ncm?: string | null;
  valor_unitario?: number;
  quantidade_estoque?: number;
  inativo?: string;
  tipo?: string;
  descricao_familia?: string;
  imagens?: Array<{ url_imagem?: string }>;
  marca?: string;
  modelo?: string;
  peso_bruto?: number;
  peso_liq?: number;
  cfop?: string;
  recomendacoes_fiscais?: { tipo_produto?: string };
  // Tipo do item no Omie (00..99; '04' = Produto Acabado = fabricado internamente, nunca comprar).
  // A doc do Omie usa `tipoItem`; o retorno do ListarProdutos pode vir snake_case (`tipo_item`)
  // ou no genérico `tipo`. O batch NÃO traz `recomendacoes_fiscais.tipo_produto` (sempre null),
  // por isso lemos as variações abaixo.
  tipoItem?: string | number;
  tipo_item?: string | number;
}

interface OmiePosEstoque {
  nCodProd?: number;
  nSaldo?: number;
}

interface OmieClienteCadastro {
  codigo_cliente_omie?: number;
  razao_social?: string;
  nome_fantasia?: string;
  cnpj_cpf?: string;
  codigo_vendedor?: number | null;
  recomendacoes?: { codigo_vendedor?: number | null };
  endereco?: string;
  endereco_numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
  cep?: string;
  telefone1_ddd?: string;
  telefone1_numero?: string;
  contato?: string;
  tags?: Array<{ tag?: string } | string>;
  atividade?: string;
  codigo_transportadora?: number | string;
}

interface OmieParcela {
  cInativo?: string;
  cCodigo?: string;
  nCodigo?: number;
  cDescricao?: string;
  cDescParcela?: string;
}

interface OmieDetalheItem {
  ide?: { codigo_item?: number; codigo_item_integracao?: number };
  produto?: {
    codigo_produto?: number;
    descricao?: string;
    quantidade?: number;
    valor_unitario?: number;
    desconto?: number;
    cfop?: string;
  };
  imposto?: { cfop?: string };
  // Observação/dados adicionais do item — o submit grava a cor da tinta aqui
  // ("Cor: ..."). O sync de entrada extrai de volta (ver parseCorObs).
  observacao?: { obs_item?: string };
  inf_adic?: { dados_adicionais_item?: string };
}

/**
 * Extrai a cor da tinta da observação do item do Omie. Espelho VERBATIM de
 * `src/lib/tint/parse-cor-obs.ts` (Deno não importa de src/). Formato gravado
 * pelo submit: "Cor: <label> - <embalagem>". Conservador: só prefixo "Cor:",
 * remove embalagem conhecida no fim, não quebra nome com hífen, null sem cor.
 */
function parseCorObs(obs: string | null | undefined): { tint_nome_cor: string } | null {
  if (!obs) return null;
  const m = /^\s*cor:\s*(.+)$/i.exec(obs);
  if (!m) return null;
  const label = m[1].replace(/\s*-\s*(?:QT|GL|LT|\d+(?:[.,]\d+)?\s*ML)\s*$/i, '').trim();
  if (!label) return null;
  return { tint_nome_cor: label };
}

interface OmiePedidoCabecalho {
  codigo_cliente?: number;
  codigo_pedido?: number;
  numero_pedido?: number | string;
  etapa?: string;
  data_previsao?: string;
  observacoes_pedido?: string;
  codigo_parcela?: string;
}

interface OmiePedidoVendaProduto {
  cabecalho?: OmiePedidoCabecalho;
  det?: OmieDetalheItem[];
  infoCadastro?: { dInc?: string };
}

interface OmieListarPedidosResponse {
  pedido_venda_produto?: OmiePedidoVendaProduto[];
  total_de_paginas?: number;
}

interface ProfileRow { user_id: string; document?: string | null }
interface SalesOrderHashRow { hash_payload?: string | null }
interface OmieClienteMapRow { omie_codigo_cliente: number; user_id: string | null }
interface OmieProductMapRow { id: string; omie_codigo_produto: number }
interface AdminProfileRow { user_id?: string }

interface OrderItemPayload {
  omie_codigo_produto?: number;
  descricao?: string;
  quantidade: number;
  valor_unitario: number;
  desconto?: number;
  tint_cor_id?: string;
  tint_nome_cor?: string;
}

interface OrderBatchRow {
  customer_user_id: string;
  created_by: string;
  items: OrderItemPayload[];
  subtotal: number;
  discount: number;
  total: number;
  status: string;
  omie_pedido_id: number;
  omie_numero_pedido: string;
  account: Account;
  hash_payload: string;
  created_at: string;
  notes: string | null;
  customer_address: string | null;
  customer_phone: string | null;
}

interface OrderItemBatchRow {
  sales_order_id: string;
  customer_user_id: string;
  product_id: string | null;
  omie_codigo_produto: number | null;
  quantity: number;
  unit_price: number;
  discount: number;
  hash_payload: string;
}

interface PriceHistoryBatchRow {
  customer_user_id: string;
  product_id: string;
  unit_price: number;
  sales_order_id: string;
  created_at: string;
}

interface EditItemInput {
  product_id?: string | null;
  omie_codigo_produto?: number;
  codigo?: string;
  descricao?: string;
  unidade?: string;
  quantidade: number;
  valor_unitario: number;
  tint_cor_id?: string;
  tint_nome_cor?: string;
}

interface OpItemInput {
  product_id?: string | null;
  omie_codigo_produto?: number;
  codigo?: string;
  descricao?: string;
  quantidade: number;
  unidade?: string;
  assigned_to?: string | null;
  ready_by_date?: string | null;
}

interface CreatedOP { id?: string; omie_ordem_id: number | null; omie_ordem_numero: string | null; descricao?: string }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

type Account = "oben" | "colacor";

function getCredentials(account: Account) {
  if (account === "colacor") {
    const APP_KEY = Deno.env.get("OMIE_COLACOR_APP_KEY");
    const APP_SECRET = Deno.env.get("OMIE_COLACOR_APP_SECRET");
    if (!APP_KEY || !APP_SECRET) throw new Error("Credenciais da Colacor não configuradas");
    return { APP_KEY, APP_SECRET };
  }
  const APP_KEY = Deno.env.get("OMIE_OBEN_APP_KEY");
  const APP_SECRET = Deno.env.get("OMIE_OBEN_APP_SECRET");
  if (!APP_KEY || !APP_SECRET) throw new Error("Credenciais da Oben não configuradas");
  return { APP_KEY, APP_SECRET };
}

async function callOmieVendasApi(
  endpoint: string,
  call: string,
  params: Record<string, unknown>,
  account: Account = "oben"
): Promise<OmieGenericResponse | null> {
  const { APP_KEY, APP_SECRET } = getCredentials(account);

  const body = {
    call,
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    param: [params],
  };

  console.log(`[Omie Vendas][${account}] Chamando ${endpoint} - ${call}`);

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(`${OMIE_API_URL}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = (await response.json()) as OmieGenericResponse;

    if (result.faultstring) {
      const fs = String(result.faultstring);
      const isRateLimit = fs.includes("Já existe uma requisição desse método")
        || fs.includes("Consumo redundante")
        || fs.includes("REDUNDANT")
        || fs.includes("consumo redundante");
      const isTransient = fs.includes("SOAP-ERROR")
        || fs.includes("Broken response")
        || fs.includes("Application Server")
        || fs.includes("timeout")
        || fs.includes("Timeout");
      if (isRateLimit || isTransient) {
        if (attempt < maxRetries) {
          const waitMatch = fs.match(/Aguarde (\d+) segundos/);
          const requestedDelay = waitMatch ? parseInt(waitMatch[1]) : (attempt + 1) * 5;
          const delay = Math.min(requestedDelay + 2, 15) * 1000;
          console.log(`[Omie Vendas][${account}] ${isRateLimit ? 'Rate limit' : 'Transient error'}, waiting ${delay/1000}s (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.log(`[Omie Vendas][${account}] ${isRateLimit ? 'Rate limit' : 'Transient error'} persists after ${maxRetries} retries, returning null`);
        return null;
      }
      // "No records" is not an error – return empty/null
      if (fs.includes("Não existem registros para a página")) {
        console.log(`[Omie Vendas][${account}] Nenhum registro encontrado, retornando null`);
        return null;
      }
      throw new Error(`Erro Omie Vendas (${account}): ${fs}`);
    }

    if (!response.ok) {
      const httpMessage = result?.descricao_status || `HTTP ${response.status}`;
      throw new Error(`Erro Omie Vendas (${account}): ${httpMessage}`);
    }

    if (
      result?.codigo_status !== undefined
      && result?.codigo_status !== null
      && String(result.codigo_status) !== "0"
    ) {
      throw new Error(
        `Erro Omie Vendas (${account}): ${result?.descricao_status || `status ${result.codigo_status}`}`,
      );
    }

    return result;
  }
  return null;
}

function getOmieItemIntegrationCode(index: number): number {
  const code = index + 1;

  if (!Number.isInteger(code) || code < 1 || code > 999) {
    throw new Error(
      `Código de integração do item inválido (${code}). O Omie aceita apenas valores inteiros entre 1 e 999.`,
    );
  }

  return code;
}

// Sincronizar todos os produtos da empresa de vendas
async function syncProducts(supabase: SupabaseClient, startPage = 1, maxPages = 12, account: Account = "oben") {
  let pagina = startPage;
  let totalPaginas = 1;
  let totalSynced = 0;
  let pagesProcessed = 0;

  // `pagesProcessed === 0` força a 1ª iteração mesmo com startPage > 1: totalPaginas (init=1) só é
  // aprendido DENTRO do loop, então `pagina <= totalPaginas` era falso de cara p/ startPage>1 →
  // no-op silencioso (não paginava além da pág. 12; bug pego pelo founder 2026-05-31). startPage=1 inalterado.
  while ((pagina <= totalPaginas || pagesProcessed === 0) && pagesProcessed < maxPages) {
    const result = await callOmieVendasApi(
      "geral/produtos/",
      "ListarProdutos",
      {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N",
      },
      account
    );

    if (!result) {
      console.log(`[Omie Vendas][${account}] Products sync interrupted by rate limit at page ${pagina}`);
      break;
    }

    totalPaginas = (result.total_de_paginas as number) || 1;
    const produtos: OmieProdutoCadastro[] = (result.produto_servico_cadastro as OmieProdutoCadastro[] | undefined) || [];

    const EXCLUDED_FAMILIES = ['imobilizado', 'uso e consumo', 'matérias primas para conversão de cintas', 'jumbos de lixa para discos', 'material para tingimix'];

    const rows = produtos
      .filter((prod) => {
        // Excluir produtos do tipo Kit (apenas Simples)
        if (prod.tipo && prod.tipo.toUpperCase() === "K") return false;
        const familia = (prod.descricao_familia || '').toLowerCase().trim();
        if (EXCLUDED_FAMILIES.some(ex => familia.includes(ex)) || familia.startsWith('jumbo')) return false;
        const desc = (prod.descricao || '').toLowerCase();
        if (desc.includes('810ml') || desc.includes('810 ml')) return false;
        return true;
      })
      .map((prod) => ({
        omie_codigo_produto: prod.codigo_produto,
        omie_codigo_produto_integracao: prod.codigo_produto_integracao || null,
        codigo: prod.codigo || `PROD-${prod.codigo_produto}`,
        descricao: prod.descricao || prod.descricao_familia || "Produto sem descrição",
        unidade: prod.unidade || "UN",
        ncm: prod.ncm || null,
        valor_unitario: prod.valor_unitario || 0,
        estoque: prod.quantidade_estoque || 0,
        ativo: prod.inativo !== "S",
        familia: prod.descricao_familia || null,
        imagem_url: prod.imagens?.[0]?.url_imagem || null,
        metadata: {
          marca: prod.marca,
          modelo: prod.modelo,
          peso_bruto: prod.peso_bruto,
          peso_liq: prod.peso_liq,
          descricao_familia: prod.descricao_familia,
          cfop: prod.cfop,
          // tipo_produto saiu daqui (2026-06-04): virou COLUNA dedicada de omie_products,
          // escrita SÓ pelo writer autoritativo omie-sync-metadados. Mantê-lo aqui criava
          // dado vestigial divergente da coluna — e este sync nem cobre o catálogo inteiro
          // (maxPages=12). Ver docs/superpowers/specs/2026-06-04-tipo-produto-coluna-dedicada-design.md
        },
        account,
        updated_at: new Date().toISOString(),
      }));

    if (rows.length > 0) {
      const { error } = await supabase.from("omie_products").upsert(rows, { onConflict: "omie_codigo_produto,account" });
      if (error) {
        console.error(`[Omie Vendas][${account}] Erro batch upsert página ${pagina}:`, error);
      } else {
        totalSynced += rows.length;
      }
    }

    console.log(`[Omie Vendas][${account}] Página ${pagina}/${totalPaginas} - ${produtos.length} produtos processados`);
    pagina++;
    pagesProcessed++;
  }

  const complete = pagina > totalPaginas;
  return { totalSynced, totalPaginas, lastPage: pagina - 1, nextPage: complete ? null : pagina, complete };
}

// Sincronizar estoque real dos produtos via ListarPosEstoque (paginado)
async function syncEstoque(supabase: SupabaseClient, startPage = 1, maxPages = 3, account: Account = "oben") {
  let pagina = startPage;
  let totalPaginas = 1;
  let totalUpdated = 0;
  let pagesProcessed = 0;

  // mesmo fix do syncProducts: força a 1ª iteração p/ startPage>1 funcionar (era no-op). startPage=1 inalterado.
  while ((pagina <= totalPaginas || pagesProcessed === 0) && pagesProcessed < maxPages) {
    const result = await callOmieVendasApi(
      "estoque/consulta/",
      "ListarPosEstoque",
      {
        nPagina: pagina,
        nRegPorPagina: 100,
        dDataPosicao: new Date().toLocaleDateString("pt-BR"),
      },
      account
    );

    if (!result) {
      console.log(`[Omie Vendas][${account}] Estoque sync interrupted by rate limit at page ${pagina}`);
      break;
    }

    totalPaginas = (result.nTotPaginas as number) || 1;
    const produtos: OmiePosEstoque[] = Array.isArray(result.produtos) ? (result.produtos as OmiePosEstoque[]) : [];
    const updatedAt = new Date().toISOString();

    const productCodes = produtos
      .map((prod) => Number(prod.nCodProd))
      .filter((code: number) => Number.isFinite(code));

    if (productCodes.length > 0) {
      const { data: existingProducts, error: existingError } = await supabase
        .from("omie_products")
        .select("id, omie_codigo_produto")
        .eq("account", account)
        .in("omie_codigo_produto", productCodes);

      if (existingError) {
        console.error(`[Omie Vendas][${account}] Erro buscando produtos para atualizar estoque na página ${pagina}:`, existingError);
      } else {
        const existingMap = new Map<number, string>(
          ((existingProducts ?? []) as OmieProductMapRow[]).map((product) => [Number(product.omie_codigo_produto), product.id])
        );

        type StockRow = { id: string; omie_codigo_produto: number; account: Account; estoque: number; updated_at: string };
        const stockRows = produtos.reduce<StockRow[]>((rows, prod) => {
          const omieCodigoProduto = Number(prod.nCodProd);
          const existingId = existingMap.get(omieCodigoProduto);

          if (!Number.isFinite(omieCodigoProduto) || !existingId) {
            return rows;
          }

          rows.push({
            id: existingId,
            omie_codigo_produto: omieCodigoProduto,
            account,
            estoque: Number(prod.nSaldo ?? 0),
            updated_at: updatedAt,
          });

          return rows;
        }, []);

        if (stockRows.length > 0) {
          // Não há unique constraint (omie_codigo_produto,account) — usar UPDATE por id
          // em vez de upsert para evitar tentativas de INSERT que violam NOT NULL.
          let okCount = 0;
          for (const row of stockRows) {
            const { error: updErr } = await supabase
              .from("omie_products")
              .update({ estoque: row.estoque, updated_at: row.updated_at })
              .eq("id", row.id);
            if (updErr) {
              console.error(`[Omie Vendas][${account}] Erro update estoque ${row.omie_codigo_produto}:`, updErr.message);
            } else {
              okCount++;
            }
          }
          totalUpdated += okCount;
        }

        const skippedProducts = productCodes.length - stockRows.length;
        if (skippedProducts > 0) {
          console.log(`[Omie Vendas][${account}] ${skippedProducts} produtos da página ${pagina} foram ignorados por não existirem localmente`);
        }
      }
    }

    console.log(`[Omie Vendas][${account}] Estoque página ${pagina}/${totalPaginas} - ${produtos.length} produtos`);
    pagina++;
    pagesProcessed++;
  }

  const complete = pagina > totalPaginas;
  return { totalUpdated, totalPaginas, lastPage: pagina - 1, nextPage: complete ? null : pagina, complete };
}

// Buscar/listar clientes na empresa de vendas
async function listarClientesVendas(searchTerm: string, account: Account = "oben") {
  const results: Array<{
    codigo_cliente: number;
    razao_social: string;
    nome_fantasia: string;
    cnpj_cpf: string;
    codigo_vendedor: number | null;
    endereco: string;
    endereco_numero: string;
    complemento: string;
    bairro: string;
    cidade: string;
    estado: string;
    cep: string;
    telefone: string;
    contato: string;
    tags: string[];
    atividade: string;
  }> = [];

  // Try searching by name first
  try {
    const result = await callOmieVendasApi(
      "geral/clientes/",
      "ListarClientes",
      {
        pagina: 1,
        registros_por_pagina: 20,
        clientesFiltro: {
          razao_social: searchTerm,
        },
      },
      account
    );

    const clientes = result?.clientes_cadastro as OmieClienteCadastro[] | undefined;
    if (clientes) {
      for (const c of clientes) {
            results.push({
              codigo_cliente: c.codigo_cliente_omie ?? 0,
              razao_social: c.razao_social || "",
              nome_fantasia: c.nome_fantasia || "",
              cnpj_cpf: c.cnpj_cpf || "",
              codigo_vendedor: c.recomendacoes?.codigo_vendedor || c.codigo_vendedor || null,
              endereco: c.endereco || "",
              endereco_numero: c.endereco_numero || "",
              complemento: c.complemento || "",
              bairro: c.bairro || "",
              cidade: c.cidade || "",
              estado: c.estado || "",
              cep: c.cep || "",
              telefone: c.telefone1_ddd && c.telefone1_numero ? `(${c.telefone1_ddd}) ${c.telefone1_numero}` : "",
              contato: c.contato || "",
              tags: (c.tags || []).map((t) => typeof t === 'string' ? t : (t.tag ?? '')),
              atividade: c.atividade || "",
            });
      }
    }
  } catch (e) {
    console.log(`[Omie Vendas][${account}] Busca por razão social falhou:`, e);
  }

  // Also try by document if search looks like a number
  const cleanSearch = searchTerm.replace(/\D/g, "");
  if (cleanSearch.length >= 3 && results.length === 0) {
    try {
      const result = await callOmieVendasApi(
        "geral/clientes/",
        "ListarClientes",
        {
          pagina: 1,
          registros_por_pagina: 10,
          clientesFiltro: {
            cnpj_cpf: cleanSearch,
          },
        },
        account
      );

      const clientes2 = result?.clientes_cadastro as OmieClienteCadastro[] | undefined;
      if (clientes2) {
        for (const c of clientes2) {
          if (!results.find(r => r.codigo_cliente === c.codigo_cliente_omie)) {
            results.push({
              codigo_cliente: c.codigo_cliente_omie ?? 0,
              razao_social: c.razao_social || "",
              nome_fantasia: c.nome_fantasia || "",
              cnpj_cpf: c.cnpj_cpf || "",
              codigo_vendedor: c.recomendacoes?.codigo_vendedor || c.codigo_vendedor || null,
              endereco: c.endereco || "",
              endereco_numero: c.endereco_numero || "",
              complemento: c.complemento || "",
              bairro: c.bairro || "",
              cidade: c.cidade || "",
              estado: c.estado || "",
              cep: c.cep || "",
              telefone: c.telefone1_ddd && c.telefone1_numero ? `(${c.telefone1_ddd}) ${c.telefone1_numero}` : "",
              contato: c.contato || "",
              tags: (c.tags || []).map((t) => typeof t === 'string' ? t : (t.tag ?? '')),
              atividade: c.atividade || "",
            });
          }
        }
      }
    } catch (e) {
      console.log(`[Omie Vendas][${account}] Busca por documento falhou:`, e);
    }
  }

  return results;
}

// Buscar cliente na empresa de vendas pelo CPF/CNPJ
async function buscarClienteVendas(document: string, account: Account = "oben") {
  const documentClean = document.replace(/\D/g, "");

  const result = await callOmieVendasApi(
    "geral/clientes/",
    "ListarClientes",
    {
      pagina: 1,
      registros_por_pagina: 1,
      clientesFiltro: { cnpj_cpf: documentClean },
    },
    account
  );

  const clientesArr = result?.clientes_cadastro as OmieClienteCadastro[] | undefined;
  if (!result || !clientesArr?.[0]?.codigo_cliente_omie) {
    return null;
  }

  const cliente = clientesArr[0];
  const codigoVendedor = cliente.recomendacoes?.codigo_vendedor || cliente.codigo_vendedor || null;
  console.log(`[Omie Vendas][${account}] Cliente ${cliente.codigo_cliente_omie} vendedor: recomendacoes=${cliente.recomendacoes?.codigo_vendedor}, root=${cliente.codigo_vendedor}, resolved=${codigoVendedor}`);
  return {
    codigo_cliente: cliente.codigo_cliente_omie,
    razao_social: cliente.razao_social,
    codigo_vendedor: codigoVendedor,
  };
}

// Buscar histórico de preços no Omie (pedidos anteriores do cliente)
async function buscarHistoricoPrecosOmie(codigoCliente: number, account: Account = "oben") {
  try {
    const result = await callOmieVendasApi(
      "produtos/pedido/",
      "ListarPedidos",
      {
        pagina: 1,
        registros_por_pagina: 50,
        filtrar_por_cliente: codigoCliente,
        filtrar_apenas_inclusao: "N",
      },
      account
    );

    const precos: Record<number, number> = {};
    const pedidos: OmiePedidoVendaProduto[] = (result?.pedido_venda_produto as OmiePedidoVendaProduto[] | undefined) || [];

    // Percorrer pedidos do mais recente ao mais antigo
    for (const pedido of pedidos) {
      const itens = pedido.det || [];
      for (const item of itens) {
        const codigoProduto = item.produto?.codigo_produto;
        const valorUnit = item.produto?.valor_unitario;
        if (codigoProduto && valorUnit && !precos[codigoProduto]) {
          precos[codigoProduto] = valorUnit;
        }
      }
    }

    return precos;
  } catch (error) {
    console.error(`[Omie Vendas][${account}] Erro ao buscar histórico de preços:`, error);
    return {};
  }
}

// Listar formas de pagamento (parcelas) do Omie
async function listarFormasPagamento(account: Account = "oben") {
  // Common payment conditions used as hardcoded fallback
  const defaultFormas = [
    { codigo: "999", descricao: "A Vista" },
    { codigo: "000", descricao: "A Vista (faturamento)" },
    { codigo: "001", descricao: "30 dias" },
    { codigo: "002", descricao: "30/60 dias" },
    { codigo: "003", descricao: "30/60/90 dias" },
    { codigo: "030", descricao: "30dd" },
    { codigo: "A03", descricao: "30/60/90 DDL" },
    { codigo: "A04", descricao: "28/56/84 DDL" },
  ];

  try {
    const allParcelas: OmieParcela[] = [];
    let pagina = 1;
    let totalPaginas = 1;

    do {
      const result = await callOmieVendasApi(
        "geral/parcelas/",
        "ListarParcelas",
        { pagina, registros_por_pagina: 500 },
        account
      );

      const parcelas: OmieParcela[] =
        (result?.cadastros as OmieParcela[] | undefined)
        || (result?.parcela_cadastro as OmieParcela[] | undefined)
        || (result?.lista_parcelas as OmieParcela[] | undefined)
        || [];
      totalPaginas = (result?.total_de_paginas as number) || 1;
      console.log(`[Omie Vendas][${account}] ListarParcelas página ${pagina}/${totalPaginas} retornou ${parcelas.length} parcelas.`);
      allParcelas.push(...parcelas);
      pagina++;
    } while (pagina <= totalPaginas);

    if (allParcelas.length > 0) {
      return allParcelas
        .filter((f) => f.cInativo !== "S")
        .map((f) => ({
          codigo: f.cCodigo || f.nCodigo?.toString() || '',
          descricao: f.cDescricao || f.cDescParcela || '',
        }))
        .filter((f) => f.codigo && f.descricao);
    }
  } catch (error) {
    console.error(`[Omie Vendas][${account}] Erro ao buscar parcelas:`, error);
  }

  // Fallback: return common payment conditions
  console.log(`[Omie Vendas][${account}] Usando formas de pagamento padrão (fallback)`);
  return defaultFormas;
}

// Buscar última forma de pagamento e ranking de parcelas do cliente
async function buscarUltimaParcela(codigoCliente: number, account: Account = "oben") {
  try {
    const result = await callOmieVendasApi(
      "produtos/pedido/",
      "ListarPedidos",
      {
        pagina: 1,
        registros_por_pagina: 50,
        filtrar_por_cliente: codigoCliente,
        filtrar_apenas_inclusao: "N",
      },
      account
    );

    const pedidos: OmiePedidoVendaProduto[] = (result?.pedido_venda_produto as OmiePedidoVendaProduto[] | undefined) || [];
    const parcelaCount: Record<string, number> = {};
    let ultimaParcela: string | null = null;

    for (const pedido of pedidos) {
      const parcela = pedido.cabecalho?.codigo_parcela;
      if (parcela) {
        if (!ultimaParcela) ultimaParcela = parcela;
        parcelaCount[parcela] = (parcelaCount[parcela] || 0) + 1;
      }
    }

    // Sort by frequency descending
    const parcelaRanking = Object.entries(parcelaCount)
      .sort((a, b) => b[1] - a[1])
      .map(([codigo, count]) => ({ codigo, count }));

    return { ultima_parcela: ultimaParcela, parcela_ranking: parcelaRanking };
  } catch (error) {
    console.error(`[Omie Vendas][${account}] Erro ao buscar última parcela:`, error);
    return { ultima_parcela: null, parcela_ranking: [] };
  }
}

// Fase 2: CONTEXTO COMERCIAL do cliente numa ÚNICA passada de ListarPedidos.
// Substitui buscar_precos_cliente + buscar_ultima_parcela + buscar_cliente (colacor) +
// historico_produtos_cliente, que disparavam VÁRIAS ListarPedidos concorrentes na mesma
// conta → rate-limit do Omie ("Já existe uma requisição desse método") → retries 5-15s×3
// → ~40s. Aqui: 1 ListarPedidos/conta (ordenar_por DATA_INCLUSAO) devolve preço + dInc
// por produto + parcela + ranking. Para colacor (sem código conhecido), resolve o código
// por documento ANTES (ListarClientes → ListarPedidos, SERIAL → métodos diferentes, sem
// colisão). dInc (inclusão) é a data de precedência — NÃO data_previsao.
async function buscarContextoComercialCliente(
  opts: { codigoCliente?: number | null; document?: string | null },
  account: Account = "oben",
) {
  let codigoCliente = opts.codigoCliente ?? null;
  let codigoVendedor: number | null = null;

  if (!codigoCliente && opts.document) {
    const cli = await buscarClienteVendas(opts.document, account);
    if (cli?.codigo_cliente) {
      codigoCliente = cli.codigo_cliente;
      codigoVendedor = cli.codigo_vendedor ?? null;
    }
  }

  const empty = {
    codigo_cliente: codigoCliente,
    codigo_vendedor: codigoVendedor,
    precos: {} as Record<number, number>,
    datas: {} as Record<number, string>,
    ultima_parcela: null as string | null,
    parcela_ranking: [] as Array<{ codigo: string; count: number }>,
  };
  if (!codigoCliente) return empty;

  const result = await callOmieVendasApi(
    "produtos/pedido/",
    "ListarPedidos",
    {
      pagina: 1,
      registros_por_pagina: 50,
      filtrar_por_cliente: codigoCliente,
      filtrar_apenas_inclusao: "N",
      ordenar_por: "DATA_INCLUSAO",
    },
    account,
  );

  const pedidos: OmiePedidoVendaProduto[] =
    (result?.pedido_venda_produto as OmiePedidoVendaProduto[] | undefined) || [];

  const precos: Record<number, number> = {};
  const datas: Record<number, string> = {};
  const parcelaCount: Record<string, number> = {};
  let ultimaParcela: string | null = null;

  // Pedidos vêm do mais recente ao mais antigo (DATA_INCLUSAO) → o 1º por produto é o último.
  for (const pedido of pedidos) {
    const dataInc = pedido.infoCadastro?.dInc || pedido.cabecalho?.data_previsao || "";
    const parcela = pedido.cabecalho?.codigo_parcela;
    if (parcela) {
      if (!ultimaParcela) ultimaParcela = parcela;
      parcelaCount[parcela] = (parcelaCount[parcela] || 0) + 1;
    }
    for (const item of pedido.det || []) {
      const cod = item.produto?.codigo_produto;
      const val = item.produto?.valor_unitario;
      if (cod && val && val > 0 && precos[cod] === undefined) {
        precos[cod] = val;
        datas[cod] = dataInc;
      }
    }
  }

  const parcela_ranking = Object.entries(parcelaCount)
    .sort((a, b) => b[1] - a[1])
    .map(([codigo, count]) => ({ codigo, count }));

  return {
    codigo_cliente: codigoCliente,
    codigo_vendedor: codigoVendedor,
    precos,
    datas,
    ultima_parcela: ultimaParcela,
    parcela_ranking,
  };
}

// Sincronizar pedidos de venda do Omie para o banco local (OPTIMIZED)
async function syncPedidos(
  supabase: SupabaseClient,
  startPage = 1,
  maxPages = 10,
  account: Account = "oben",
  dateFrom?: string, // DD/MM/YYYY
  dateTo?: string,   // DD/MM/YYYY
) {
  let pagina = startPage;
  let totalPaginas = 1;
  let totalSynced = 0;
  let totalItems = 0;
  let pagesProcessed = 0;
  let skippedNoClient = 0;
  let skippedExisting = 0;

  // ── Pre-load document -> user_id mapping from profiles ──
  const docToUserMap = new Map<string, string>();
  let cPage = 0;
  const pgSize = 1000;
  let hasMore = true;
  while (hasMore) {
    const { data: batch } = await supabase
      .from('profiles')
      .select('user_id, document')
      .not('document', 'is', null)
      .range(cPage * pgSize, (cPage + 1) * pgSize - 1);
    if (!batch || batch.length === 0) { hasMore = false; }
    else {
      for (const p of batch) {
        if (p.document) {
          const cleanDoc = p.document.replace(/\D/g, '');
          if (cleanDoc.length >= 11) docToUserMap.set(cleanDoc, p.user_id);
        }
      }
      if (batch.length < pgSize) hasMore = false;
      cPage++;
    }
  }
  console.log(`[sync_pedidos][${account}] Document map: ${docToUserMap.size} profiles`);

  // ── Pre-load ALL existing hash_payloads for this account (skip duplicates in bulk) ──
  const existingHashes = new Set<string>();
  let hPage = 0;
  hasMore = true;
  while (hasMore) {
    const { data: batch } = await supabase
      .from('sales_orders')
      .select('hash_payload')
      .eq('account', account)
      .not('hash_payload', 'is', null)
      .range(hPage * pgSize, (hPage + 1) * pgSize - 1);
    if (!batch || batch.length === 0) { hasMore = false; }
    else {
      for (const row of batch) if (row.hash_payload) existingHashes.add(row.hash_payload);
      if (batch.length < pgSize) hasMore = false;
      hPage++;
    }
  }
  console.log(`[sync_pedidos][${account}] Existing hashes: ${existingHashes.size}`);

  // ── Pre-load omie_clientes mapping (codigo_cliente -> user_id) to AVOID API calls ──
  const clientCache = new Map<number, string | null>();
  let ocPage = 0;
  hasMore = true;
  while (hasMore) {
    const { data: batch } = await supabase
      .from('omie_clientes')
      .select('omie_codigo_cliente, user_id')
      .range(ocPage * pgSize, (ocPage + 1) * pgSize - 1);
    if (!batch || batch.length === 0) { hasMore = false; }
    else {
      for (const oc of batch) {
        clientCache.set(oc.omie_codigo_cliente, oc.user_id);
      }
      if (batch.length < pgSize) hasMore = false;
      ocPage++;
    }
  }
  console.log(`[sync_pedidos][${account}] Client cache from omie_clientes: ${clientCache.size}`);

  // ── Pre-load product mapping ──
  const productMap = new Map<number, string>();
  let pPage = 0;
  hasMore = true;
  while (hasMore) {
    const { data: batch } = await supabase
      .from('omie_products')
      .select('id, omie_codigo_produto')
      .eq('account', account)
      .range(pPage * pgSize, (pPage + 1) * pgSize - 1);
    if (!batch || batch.length === 0) { hasMore = false; }
    else {
      for (const p of batch) productMap.set(p.omie_codigo_produto, p.id);
      if (batch.length < pgSize) hasMore = false;
      pPage++;
    }
  }
  console.log(`[sync_pedidos][${account}] Product map: ${productMap.size}`);

  // System user for created_by
  const { data: adminProfile } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('is_employee', true)
    .limit(1)
    .single();
  const systemUserId = adminProfile?.user_id;
  if (!systemUserId) throw new Error('Nenhum funcionário encontrado para created_by');

  // Cache for client address/phone (populated during ConsultarCliente calls)
  const clientAddressCache = new Map<number, { address: string; phone: string }>();

  // Helper: resolve codigo_cliente -> user_id (cache-first, API fallback only for unknown)
  async function resolveClientUserId(codigoCliente: number): Promise<string | null> {
    if (clientCache.has(codigoCliente)) return clientCache.get(codigoCliente) || null;
    // Fallback: call Omie API only for clients NOT in omie_clientes table
    try {
      const result = (await callOmieVendasApi(
        "geral/clientes/",
        "ConsultarCliente",
        { codigo_cliente_omie: codigoCliente },
        account
      )) as OmieClienteCadastro | null;
      if (!result) {
        clientCache.set(codigoCliente, null);
        return null;
      }
      const doc = (result.cnpj_cpf || '').replace(/\D/g, '');
      // Cache address/phone from ConsultarCliente result
      const addrParts = [result.endereco, result.endereco_numero, result.complemento, result.bairro, result.cidade, result.estado, result.cep].filter(Boolean);
      const phone = result.telefone1_ddd && result.telefone1_numero ? `(${result.telefone1_ddd}) ${result.telefone1_numero}` : '';
      clientAddressCache.set(codigoCliente, { address: addrParts.join(', '), phone });

      if (doc.length >= 11) {
        const userId = docToUserMap.get(doc) || null;
        clientCache.set(codigoCliente, userId);
        return userId;
      }
    } catch (e) {
      console.warn(`[sync_pedidos][${account}] ConsultarCliente ${codigoCliente} falhou:`, (e as Error).message);
    }
    clientCache.set(codigoCliente, null);
    return null;
  }

  // Helper: get address/phone for a client code (from cache or fetch)
  async function getClientAddressPhone(codigoCliente: number): Promise<{ address: string; phone: string }> {
    if (clientAddressCache.has(codigoCliente)) return clientAddressCache.get(codigoCliente)!;
    try {
      const result = (await callOmieVendasApi(
        "geral/clientes/",
        "ConsultarCliente",
        { codigo_cliente_omie: codigoCliente },
        account
      )) as OmieClienteCadastro | null;
      if (result) {
        const addrParts = [
          result.endereco,
          result.endereco_numero ? `nº ${result.endereco_numero}` : '',
          result.complemento,
          result.bairro ? `– ${result.bairro}` : '',
          result.cidade && result.estado ? `${result.cidade}/${result.estado}` : '',
          result.cep ? `CEP: ${result.cep}` : '',
        ].filter(Boolean);
        const phone = result.telefone1_ddd && result.telefone1_numero ? `(${result.telefone1_ddd}) ${result.telefone1_numero}` : (result.contato || '');
        const entry = { address: addrParts.join(', '), phone };
        clientAddressCache.set(codigoCliente, entry);
        return entry;
      }
    } catch (e) {
      console.warn(`[sync_pedidos][${account}] getClientAddressPhone ${codigoCliente} falhou:`, (e as Error).message);
    }
    return { address: '', phone: '' };
  }

  // mesmo fix (syncPedidos): força a 1ª iteração p/ startPage>1 funcionar (era no-op). startPage=1 inalterado —
  // o fluxo do cron (start_page=1 + janela de data) NÃO muda; só destrava paginação manual além de maxPages.
  while ((pagina <= totalPaginas || pagesProcessed === 0) && pagesProcessed < maxPages) {
    const listParams: Record<string, unknown> = { pagina, registros_por_pagina: 50, filtrar_apenas_inclusao: "N" };
    if (dateFrom) listParams.filtrar_por_data_de = dateFrom;
    if (dateTo) listParams.filtrar_por_data_ate = dateTo;

    const result = await callOmieVendasApi(
      "produtos/pedido/",
      "ListarPedidos",
      listParams,
      account
    );

    if (!result) {
      console.log(`[sync_pedidos][${account}] Pedidos sync interrupted by rate limit at page ${pagina}`);
      break;
    }

    totalPaginas = (result.total_de_paginas as number) || 1;
    const pedidos: OmiePedidoVendaProduto[] = (result.pedido_venda_produto as OmiePedidoVendaProduto[] | undefined) || [];

    // Resolve only unknown client codes (most should be in cache from omie_clientes)
    const uniqueClientCodes = [...new Set(pedidos.map((p) => p.cabecalho?.codigo_cliente).filter((c): c is number => Boolean(c)))];
    const unknownCodes = uniqueClientCodes.filter(c => !clientCache.has(c));
    if (unknownCodes.length > 0) {
      console.log(`[sync_pedidos][${account}] Resolving ${unknownCodes.length} unknown clients via API (concurrency=5)`);
      // Antes: for of await (serial). Agora: chunks de 5 em paralelo pra acelerar
      // sem floodar API Omie (rate limits Omie não documentados; 5 é conservador).
      const CHUNK = 5;
      for (let i = 0; i < unknownCodes.length; i += CHUNK) {
        await Promise.all(unknownCodes.slice(i, i + CHUNK).map(c => resolveClientUserId(c)));
      }
    }

    // Pre-fetch address/phone for all clients on this page that aren't cached yet
    const codesNeedingAddress = uniqueClientCodes.filter(c => !clientAddressCache.has(c) && clientCache.has(c) && clientCache.get(c));
    if (codesNeedingAddress.length > 0) {
      console.log(`[sync_pedidos][${account}] Fetching address/phone for ${codesNeedingAddress.length} clients (concurrency=5)`);
      const CHUNK = 5;
      for (let i = 0; i < codesNeedingAddress.length; i += CHUNK) {
        await Promise.all(codesNeedingAddress.slice(i, i + CHUNK).map(c => getClientAddressPhone(c)));
      }
    }

    // ── Prepare batch arrays ──
    const orderBatch: OrderBatchRow[] = [];
    const orderMeta: Array<{ hashPayload: string; detalhes: OmieDetalheItem[]; customerUserId: string; createdAt: string }> = [];

    for (const pedido of pedidos) {
      const cab = pedido.cabecalho || {};
      const codigoCliente = cab.codigo_cliente;
      const codigoPedido = cab.codigo_pedido;
      const numeroPedido = cab.numero_pedido;
      if (!codigoCliente || !codigoPedido) continue;

      const customerUserId = clientCache.get(codigoCliente) || null;
      if (!customerUserId) { skippedNoClient++; continue; }

      const hashPayload = `omie_${account}_${codigoPedido}`;

      // Skip if already synced (in-memory check, no DB call)
      if (existingHashes.has(hashPayload)) { skippedExisting++; continue; }
      existingHashes.add(hashPayload); // prevent duplicates within same run

      const detalhes: OmieDetalheItem[] = pedido.det || [];
      const itemsJson: OrderItemPayload[] = [];
      let subtotal = 0;

      for (const det of detalhes) {
        const prod = det.produto || {};
        const qty = prod.quantidade || 1;
        const price = prod.valor_unitario || 0;
        const desc = prod.desconto || 0;
        subtotal += qty * price * (1 - desc / 100);
        // Cor da tinta: preferimos obs_item (onde a cor sempre vai); o
        // dados_adicionais_item pode conter ordem de compra (parseCorObs filtra
        // por "Cor:", então não confunde). Sem cor → item comum.
        const cor = parseCorObs(det.observacao?.obs_item ?? det.inf_adic?.dados_adicionais_item);
        itemsJson.push({
          omie_codigo_produto: prod.codigo_produto,
          descricao: prod.descricao || '',
          quantidade: qty,
          valor_unitario: price,
          desconto: desc,
          ...(cor ? { tint_nome_cor: cor.tint_nome_cor } : {}),
        });
      }

      let status = 'importado';
      const etapa = cab.etapa || '';
      if (etapa === '60' || etapa === '70') status = 'faturado';
      else if (etapa === '50') status = 'separacao';
      else if (etapa === '20') status = 'enviado';
      else if (etapa === '80') status = 'cancelado';

      let createdAt = new Date().toISOString();
      if (cab.data_previsao) {
        const parts = cab.data_previsao.split('/');
        if (parts.length === 3) createdAt = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).toISOString();
      }

      // order_date_kpi: data do PEDIDO (dInc = inclusão no Omie) p/ KPI de positivação.
      // dInc > previsão de entrega (data_previsao) > hoje. Previsão de entrega ≠ data do pedido.
      let orderDateKpi: string = createdAt.slice(0, 10);
      const dIncParts = pedido.infoCadastro?.dInc?.split('/');
      const dPrevParts = cab.data_previsao?.split('/');
      if (dIncParts && dIncParts.length === 3) {
        orderDateKpi = `${dIncParts[2]}-${dIncParts[1].padStart(2, '0')}-${dIncParts[0].padStart(2, '0')}`;
      } else if (dPrevParts && dPrevParts.length === 3) {
        orderDateKpi = `${dPrevParts[2]}-${dPrevParts[1].padStart(2, '0')}-${dPrevParts[0].padStart(2, '0')}`;
      }

      // Get cached address/phone for this client
      const clientInfo = clientAddressCache.get(codigoCliente) || { address: '', phone: '' };

      orderBatch.push({
        customer_user_id: customerUserId,
        created_by: systemUserId,
        items: itemsJson,
        subtotal: Math.round(subtotal * 100) / 100,
        discount: 0,
        total: Math.round(subtotal * 100) / 100,
        status,
        omie_pedido_id: codigoPedido,
        omie_numero_pedido: String(numeroPedido || codigoPedido),
        account,
        hash_payload: hashPayload,
        created_at: createdAt,
        order_date_kpi: orderDateKpi,
        notes: cab.observacoes_pedido || null,
        customer_address: clientInfo.address || null,
        customer_phone: clientInfo.phone || null,
      });
      orderMeta.push({ hashPayload, detalhes, customerUserId, createdAt });
    }

    // ── Batch insert orders ──
    if (orderBatch.length > 0) {
      const { data: insertedOrders, error: orderErr } = await supabase
        .from('sales_orders')
        .insert(orderBatch)
        .select('id, hash_payload');

      if (orderErr) {
        console.error(`[sync_pedidos][${account}] Batch insert error pág ${pagina}:`, orderErr.message);
        // Fallback: try one-by-one
        for (let idx = 0; idx < orderBatch.length; idx++) {
          const { data: single, error: singleErr } = await supabase
            .from('sales_orders')
            .insert(orderBatch[idx])
            .select('id')
            .single();
          if (!singleErr && single) {
            totalSynced++;
            // Insert items + prices for this order
            const meta = orderMeta[idx];
            const itemRows = meta.detalhes.map((det) => {
              const prod = det.produto || {};
              return {
                sales_order_id: single.id,
                customer_user_id: meta.customerUserId,
                product_id: (prod.codigo_produto ? productMap.get(prod.codigo_produto) : null) || null,
                omie_codigo_produto: prod.codigo_produto || null,
                quantity: prod.quantidade || 1,
                unit_price: prod.valor_unitario || 0,
                discount: prod.desconto || 0,
                hash_payload: `${meta.hashPayload}_${prod.codigo_produto}`,
              };
            }).filter((i) => i.omie_codigo_produto);
            if (itemRows.length > 0) {
              await supabase.from('order_items').insert(itemRows);
              totalItems += itemRows.length;
            }
          }
        }
      } else if (insertedOrders) {
        totalSynced += insertedOrders.length;

        // Build hash -> id map for inserted orders
        const hashToId = new Map<string, string>();
        for (const o of insertedOrders) if (o.hash_payload) hashToId.set(o.hash_payload, o.id);

        // ── Batch insert order_items ──
        const allItemRows: OrderItemBatchRow[] = [];
        const allPriceRows: PriceHistoryBatchRow[] = [];

        for (const meta of orderMeta) {
          const orderId = hashToId.get(meta.hashPayload);
          if (!orderId) continue;

          for (const det of meta.detalhes) {
            const prod = det.produto || {};
            if (!prod.codigo_produto) continue;

            allItemRows.push({
              sales_order_id: orderId,
              customer_user_id: meta.customerUserId,
              product_id: productMap.get(prod.codigo_produto) || null,
              omie_codigo_produto: prod.codigo_produto,
              quantity: prod.quantidade || 1,
              unit_price: prod.valor_unitario || 0,
              discount: prod.desconto || 0,
              hash_payload: `${meta.hashPayload}_${prod.codigo_produto}`,
            });

            const productId = productMap.get(prod.codigo_produto);
            if (productId && prod.valor_unitario > 0) {
              allPriceRows.push({
                customer_user_id: meta.customerUserId,
                product_id: productId,
                unit_price: prod.valor_unitario,
                sales_order_id: orderId,
                created_at: meta.createdAt,
              });
            }
          }
        }

        // Insert items in batches of 200
        for (let i = 0; i < allItemRows.length; i += 200) {
          const batch = allItemRows.slice(i, i + 200);
          const { error: itemsErr } = await supabase.from('order_items').insert(batch);
          if (itemsErr) console.error(`[sync_pedidos][${account}] Items batch error:`, itemsErr.message);
          else totalItems += batch.length;
        }

        // Insert prices in batches of 200
        for (let i = 0; i < allPriceRows.length; i += 200) {
          const batch = allPriceRows.slice(i, i + 200);
          await supabase.from('sales_price_history').insert(batch);
        }
      }
    }

    console.log(`[sync_pedidos][${account}] Página ${pagina}/${totalPaginas} — ${orderBatch.length} novos, ${skippedExisting} existentes`);
    pagina++;
    pagesProcessed++;
  }

  const complete = pagina > totalPaginas;
  return { totalSynced, totalItems, skippedNoClient, skippedExisting, totalPaginas, lastPage: pagina - 1, nextPage: complete ? null : pagina, complete };
}

// Buscar transportadora pelo nome (razão social) no Omie
async function buscarTransportadoraPorNome(nomeTransportadora: string, account: Account): Promise<number | null> {
  try {
    const result = await callOmieVendasApi(
      "geral/clientes/",
      "ListarClientes",
      {
        pagina: 1,
        registros_por_pagina: 5,
        clientesFiltro: { razao_social: nomeTransportadora },
      },
      account
    );
    const clientes: OmieClienteCadastro[] = (result?.clientes_cadastro as OmieClienteCadastro[] | undefined) || [];
    if (clientes.length > 0) {
      const codigo = clientes[0].codigo_cliente_omie ?? null;
      console.log(`[Omie Vendas][${account}] Transportadora '${nomeTransportadora}' encontrada: ${codigo}`);
      return codigo;
    }
  } catch (e) {
    console.warn(`[Omie Vendas][${account}] Erro ao buscar transportadora '${nomeTransportadora}':`, (e as Error).message);
  }
  return null;
}

// Buscar transportadora do cadastro do cliente
async function buscarTransportadoraCliente(codigoCliente: number, account: Account): Promise<number | null> {
  try {
    const result = (await callOmieVendasApi(
      "geral/clientes/",
      "ConsultarCliente",
      { codigo_cliente_omie: codigoCliente },
      account
    )) as OmieClienteCadastro | null;
    const codTransp = result?.codigo_transportadora;
    if (codTransp && Number(codTransp) > 0) {
      console.log(`[Omie Vendas][${account}] Cliente ${codigoCliente} tem transportadora: ${codTransp}`);
      return Number(codTransp);
    }
  } catch (e) {
    console.warn(`[Omie Vendas][${account}] Erro ao consultar transportadora do cliente ${codigoCliente}:`, (e as Error).message);
  }
  return null;
}

// Cache de transportadora padrão por empresa (evitar busca repetida)
const transportadoraCache: Record<string, number | null> = {};

async function getTransportadoraPadrao(account: Account): Promise<number | null> {
  if (account in transportadoraCache) return transportadoraCache[account];
  const nome = account === "oben" ? "Oben Comercio LTDA" : "Colacor Comercial LTDA";
  const codigo = await buscarTransportadoraPorNome(nome, account);
  transportadoraCache[account] = codigo;
  return codigo;
}

// Config por empresa para criação de pedido
function getAccountConfig(account: Account) {
  if (account === "colacor") {
    return {
      codigo_categoria: "1.01.01",
      codigo_conta_corrente: 394054131,
      obs_prefix: "Pedido de venda via App Colacor",
    };
  }
  return {
    codigo_categoria: "1.01.01",
    codigo_conta_corrente: 8693825504,
    obs_prefix: `Pedido de venda via App Oben\n\nRECIBO DE ENTREGA DE VENDA NÃO PRESENCIAL\nE-PTA-RE Nº: 45.000035717-51 / OBEN COMÉRCIO LTDA.\nTRANSPORTADORA: Transporte próprio: Oben Comercio\nDeclaro que recebi as mercadorias constantes dessa Nota Fiscal, e que as mercadorias se destinam a uso e consumo, e que estão em perfeito estado e conferem com pedido feito no âmbito do comércio de telemarketing ou eletrônico e que foram recebidas no local por mim no local indicado acima.\nCPF/CNPJ:___________________________________\nDATA DA ENTREGA:___/__/____\nNome/ASSINATURA:_________________________________________________`,
  };
}

// Criar pedido de venda no Omie
async function criarPedidoVenda(
  supabase: SupabaseClient,
  salesOrderId: string,
  codigoCliente: number,
  codigoVendedor: number | null,
  items: Array<{
    omie_codigo_produto: number;
    quantidade: number;
    valor_unitario: number;
    descricao?: string;
    tint_cor_id?: string;
    tint_nome_cor?: string;
  }>,
  observacao?: string,
  codigoParcela?: string,
  account: Account = "oben",
  quantidadeVolumes?: number,
  ordemCompra?: string
) {
  const cCodIntPed = `PV_${salesOrderId.substring(0, 8)}_${Date.now()}`;
  const config = getAccountConfig(account);

  const det = items.map((item, index) => {
    const itemIntegrationCode = getOmieItemIntegrationCode(index);
    const entry: Record<string, unknown> = {
      ide: { codigo_item_integracao: itemIntegrationCode },
      produto: {
        codigo_produto: item.omie_codigo_produto,
        quantidade: item.quantidade,
        valor_unitario: item.valor_unitario,
      },
    };
    // Add tint color info or ordem de compra to item observations + NF-e
    if (ordemCompra) {
      entry.inf_adic = {
        dados_adicionais_item: ordemCompra,
        numero_pedido_compra: ordemCompra,
      };
    } else if (item.tint_cor_id && item.tint_nome_cor) {
      // Always build label with cor_id visible, without base info
      const nomeJaTemCodigo = item.tint_nome_cor.toUpperCase().includes(item.tint_cor_id.toUpperCase());
      const corLabel = nomeJaTemCodigo ? item.tint_nome_cor : `${item.tint_cor_id} - ${item.tint_nome_cor}`;
      // Extract embalagem from description (e.g. "...QT", "...GL", "...405ML")
      const descUpper = (item.descricao || '').toUpperCase();
      let embTag = '';
      if (descUpper.includes(' QT') || descUpper.endsWith('QT')) embTag = 'QT';
      else if (descUpper.includes(' GL') || descUpper.endsWith('GL')) embTag = 'GL';
      else if (descUpper.includes(' LT') || descUpper.endsWith('LT')) embTag = 'LT';
      else {
        const embMatch = descUpper.match(/(\d+(?:[.,]\d+)?)\s*ML\b/);
        if (embMatch) embTag = embMatch[1].replace(',', '.') + 'ML';
      }
      const corInfo = `Cor: ${corLabel}${embTag ? ` - ${embTag}` : ''}`;
      entry.inf_adic = {
        dados_adicionais_item: corInfo,
      };
      entry.observacao = {
        obs_item: corInfo,
      };
    }
    return entry;
  });

  const cabecalho: Record<string, unknown> = {
    codigo_pedido_integracao: cCodIntPed,
    codigo_cliente: codigoCliente,
    data_previsao: new Date().toISOString().split("T")[0].split("-").reverse().join("/"),
    etapa: "10",
    codigo_parcela: codigoParcela || "999",
  };

  const informacoes_adicionais: Record<string, unknown> = {
    codigo_categoria: config.codigo_categoria,
    codigo_conta_corrente: config.codigo_conta_corrente,
  };

  if (codigoVendedor && codigoVendedor > 0) {
    informacoes_adicionais.codVend = codigoVendedor;
  }

  // Buscar transportadora: primeiro do cadastro do cliente, senão usa a padrão da empresa
  let codigoTransportadora: number | null = await buscarTransportadoraCliente(codigoCliente, account);
  if (!codigoTransportadora) {
    codigoTransportadora = await getTransportadoraPadrao(account);
  }

  const frete: Record<string, unknown> = {
    modalidade: "0",
    especie_volumes: "VOL",
  };
  if (codigoTransportadora && codigoTransportadora > 0) {
    frete.codigo_transportadora = codigoTransportadora;
  }
  if (quantidadeVolumes && quantidadeVolumes > 0) {
    frete.quantidade_volumes = quantidadeVolumes;
  }

  const payload: Record<string, unknown> = {
    cabecalho,
    frete,
    det,
    observacoes: {
      obs_venda: observacao || config.obs_prefix,
    },
    informacoes_adicionais,
  };

  console.log(`[Omie Vendas][${account}] Payload PedidoVenda:`, JSON.stringify(payload, null, 2));

  const result = await callOmieVendasApi(
    "produtos/pedido/",
    "IncluirPedido",
    payload,
    account
  );

  if (!result) {
    throw new Error(
      `Omie (${account}) não respondeu ao incluir pedido (provável rate limit 429 após retries). Tente novamente em alguns segundos.`
    );
  }

  const omie_pedido_id = (result.codigo_pedido as number | undefined) || null;
  const omie_numero_pedido = (result.numero_pedido as string | number | undefined) || cCodIntPed;

  // Atualizar sales_order com dados do Omie
  await supabase
    .from("sales_orders")
    .update({
      omie_pedido_id,
      omie_numero_pedido: String(omie_numero_pedido),
      omie_payload: payload,
      omie_response: result,
      status: "enviado",
    })
    .eq("id", salesOrderId);

  return { omie_pedido_id, omie_numero_pedido };
}

// ─── Observabilidade do sync em fin_sync_log (best-effort) ───
// Só as actions de SYNC logam (não as interativas de PV). Com action LIKE 'sync_%'
// + companies=[account], a varredura de órfãs (>30min) e o sinal sync_error do
// watchdog (#330) passam a cobrir vendas SEM mudar o watchdog. BEST-EFFORT: uma
// falha de log NUNCA pode derrubar o sync (indisponibilidade por observabilidade).
async function logVendaSync(
  db: SupabaseClient,
  action: string,
  companies: string[],
  triggeredBy: string,
): Promise<string> {
  try {
    const { data } = await db
      .from("fin_sync_log")
      .insert({ action, companies, status: "running", triggered_by: triggeredBy, started_at: new Date().toISOString() })
      .select("id")
      .single();
    return (data as { id?: string } | null)?.id || "";
  } catch (e) {
    console.error("[Omie Vendas] logVendaSync falhou (segue sem log):", e);
    return "";
  }
}

async function completeVendaSync(
  db: SupabaseClient,
  logId: string,
  results: unknown,
  errorMsg?: string,
): Promise<void> {
  if (!logId) return;
  try {
    await db
      .from("fin_sync_log")
      .update({
        status: errorMsg ? "error" : "complete",
        results: (results as Record<string, unknown>) ?? {},
        error_message: errorMsg ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", logId);
  } catch (e) {
    console.error("[Omie Vendas] completeVendaSync falhou (best-effort):", e);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  const __auth = await authorizeCronOrStaff(req);
  if (!__auth.ok) return __auth.response;

  // Admin client (service_role, bypassa RLS) + estado do log órfão-safe içados
  // pra fora do try: o catch precisa finalizar o log de sync como 'error' em vez
  // de deixar 'running' (senão o watchdog veria órfã eterna).
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const SYNC_ACTIONS = ["sync_products", "sync_estoque", "sync_pedidos"];
  let vendaLogId = "";
  let vendaSyncFinalized = false;

  try {
    const authHeader = req.headers.get("Authorization");

    // Resolve userId quando vier JWT staff; cron/service_role passam sem user.
    let userId: string | null = null;
    if (__auth.via === "staff" && authHeader?.startsWith("Bearer ")) {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );
      const { data: { user } } = await supabase.auth.getUser(
        authHeader.replace("Bearer ", "")
      );
      userId = user?.id ?? null;
    }

    const { action, account: rawAccount, ...params } = await req.json();
    const account: Account = (rawAccount === "colacor") ? "colacor" : "oben";

    // Loga só as actions de SYNC (não as interativas de PV) — best-effort.
    if (SYNC_ACTIONS.includes(action)) {
      vendaLogId = await logVendaSync(
        supabaseAdmin,
        action,
        [account],
        __auth.via === "cron" ? "cron" : (userId || "staff"),
      );
    }

    let result: unknown;

    switch (action) {
      case "sync_products": {
        const startPage = params.start_page || 1;
        const syncResult = await syncProducts(supabaseAdmin, startPage, 12, account);
        result = { success: true, ...syncResult };
        break;
      }

      case "sync_estoque": {
        const startPageEstoque = params.start_page || 1;
        const maxPagesEstoque = Number(params.max_pages) || 2;
        const estoqueResult = await syncEstoque(supabaseAdmin, startPageEstoque, maxPagesEstoque, account);
        result = { success: true, ...estoqueResult };
        break;
      }

      case "backfill_tint_cor": {
        // Fase 2 — backfill da cor da tinta nos pedidos JÁ sincronizados: re-lê a
        // observação do item no Omie (que o sync de entrada descartava) e popula
        // tint_nome_cor no jsonb `sales_orders.items`.
        //   dry_run=true  → PROBE: amostra o que o Omie devolve (obs crua + cor
        //                   parseada), NÃO altera nada. Use p/ confirmar a fonte.
        //   dry_run=false → atualiza SÓ registros sem cor (idempotente, não toca
        //                   o registro do wizard que já tem cor; não-destrutivo).
        // Cursor por `start_page`; retorna `next_page` p/ retomar. Rate-limit via callOmie.
        const bfDryRun = params.dry_run === true;
        const bfNumeroPedido = params.numero_pedido ? Number(params.numero_pedido) : undefined;
        let bfPagina = Number(params.start_page) || 1;
        const bfMaxPages = Number(params.max_pages) || 5;
        let bfTotalPaginas = 1;
        let bfPages = 0;
        let bfPedidosComCor = 0;
        let bfPedidosAtualizados = 0;
        const bfAmostra: Array<Record<string, unknown>> = [];

        while ((bfPagina <= bfTotalPaginas || bfPages === 0) && bfPages < bfMaxPages) {
          const bfParams: Record<string, unknown> = { pagina: bfPagina, registros_por_pagina: 50, filtrar_apenas_inclusao: "N" };
          if (bfNumeroPedido) { bfParams.numero_pedido_de = bfNumeroPedido; bfParams.numero_pedido_ate = bfNumeroPedido; }
          const bfRes = (await callOmieVendasApi("produtos/pedido/", "ListarPedidos", bfParams, account)) as OmieListarPedidosResponse | null;
          if (!bfRes) break; // rate limit → retoma na próxima invocação
          bfTotalPaginas = bfRes.total_de_paginas || 1;
          const bfPedidos = bfRes.pedido_venda_produto || [];

          for (const bfPedido of bfPedidos) {
            const bfCab = bfPedido.cabecalho || {};
            const bfCodigoPedido = bfCab.codigo_pedido;
            if (!bfCodigoPedido) continue;
            const bfDet: OmieDetalheItem[] = bfPedido.det || [];
            let bfTemCor = false;
            const bfItems: OrderItemPayload[] = bfDet.map((d) => {
              const prod = d.produto || {};
              const obsItem = d.observacao?.obs_item ?? d.inf_adic?.dados_adicionais_item;
              const cor = parseCorObs(obsItem);
              if (cor) bfTemCor = true;
              // amostra do probe: só itens com observação preenchida (mostra a fonte crua).
              if (bfDryRun && bfAmostra.length < 25 && obsItem) {
                bfAmostra.push({
                  numero_pedido: bfCab.numero_pedido,
                  descricao: prod.descricao ?? null,
                  obs_item: d.observacao?.obs_item ?? null,
                  dados_adicionais_item: d.inf_adic?.dados_adicionais_item ?? null,
                  cor_parseada: cor?.tint_nome_cor ?? null,
                });
              }
              return {
                omie_codigo_produto: prod.codigo_produto,
                descricao: prod.descricao || '',
                quantidade: prod.quantidade || 1,
                valor_unitario: prod.valor_unitario || 0,
                desconto: prod.desconto || 0,
                ...(cor ? { tint_nome_cor: cor.tint_nome_cor } : {}),
              };
            });
            if (bfTemCor) bfPedidosComCor++;
            if (!bfDryRun && bfTemCor) {
              // UPDATE só registros SEM cor (idempotente; não toca o do wizard que já tem).
              const { data: bfRows } = await supabaseAdmin
                .from('sales_orders')
                .select('id, items')
                .eq('account', account)
                .eq('omie_pedido_id', bfCodigoPedido);
              for (const bfRow of bfRows || []) {
                const jaTemCor = JSON.stringify(bfRow.items ?? []).includes('tint_nome_cor');
                if (!jaTemCor) {
                  const { error: bfUpErr } = await supabaseAdmin.from('sales_orders').update({ items: bfItems }).eq('id', bfRow.id);
                  if (!bfUpErr) bfPedidosAtualizados++;
                }
              }
            }
          }
          bfPages++;
          bfPagina++;
        }
        result = {
          success: true,
          dry_run: bfDryRun,
          account,
          pedidos_com_cor: bfPedidosComCor,
          pedidos_atualizados: bfPedidosAtualizados,
          next_page: bfPagina <= bfTotalPaginas ? bfPagina : null,
          ...(bfDryRun ? { amostra: bfAmostra } : {}),
        };
        break;
      }

      case "listar_clientes": {
        const { search } = params;
        if (!search || String(search).length < 2) throw new Error("Busca deve ter ao menos 2 caracteres");
        const clientes = await listarClientesVendas(String(search), account);
        result = { success: true, clientes };
        break;
      }

      case "buscar_cliente": {
        const { document } = params;
        if (!document) throw new Error("Documento é obrigatório");
        const cliente = await buscarClienteVendas(document, account);
        result = { success: true, cliente };
        break;
      }

      case "criar_cliente": {
        const { document: docCriar, razao_social, nome_fantasia, endereco, endereco_numero, bairro, cidade, estado, cep, telefone, contato } = params;
        if (!docCriar || !razao_social) throw new Error("Documento e razão social são obrigatórios");
        const docClean = String(docCriar).replace(/\D/g, "");
        // First check if already exists
        const existingCliente = await buscarClienteVendas(docCriar, account);
        if (existingCliente) {
          result = { success: true, ...existingCliente, created: false };
          break;
        }
        // Create the client
        const clienteParams: Record<string, unknown> = {
          codigo_cliente_integracao: `APP_${docClean}_${Date.now()}`,
          razao_social,
          nome_fantasia: nome_fantasia || razao_social,
          cnpj_cpf: docClean,
          pessoa_fisica: docClean.length <= 11 ? "S" : "N",
        };
        if (endereco) clienteParams.endereco = endereco;
        if (endereco_numero) clienteParams.endereco_numero = endereco_numero;
        if (bairro) clienteParams.bairro = bairro;
        if (cidade) clienteParams.cidade = cidade;
        if (estado) clienteParams.estado = estado;
        if (cep) clienteParams.cep = String(cep).replace(/\D/g, "");
        if (telefone) clienteParams.telefone1_numero = telefone;
        if (contato) clienteParams.contato = contato;
        console.log(`[Omie Vendas][${account}] Criando cliente: ${razao_social} (${docClean})`);
        const createRes = await callOmieVendasApi("geral/clientes/", "IncluirCliente", clienteParams, account);
        const createResTyped = createRes as { codigo_cliente_omie?: number; nCodCli?: number } | null;
        result = {
          success: true,
          codigo_cliente: createResTyped?.codigo_cliente_omie ?? createResTyped?.nCodCli ?? null,
          razao_social,
          codigo_vendedor: null,
          created: true,
        };
        break;
      }

      case "buscar_precos_cliente": {
        const { codigo_cliente } = params;
        if (!codigo_cliente) throw new Error("Código do cliente é obrigatório");
        const precos = await buscarHistoricoPrecosOmie(codigo_cliente, account);
        result = { success: true, precos };
        break;
      }

      case "criar_pedido": {
        const { sales_order_id, codigo_cliente, codigo_vendedor, items, observacao, codigo_parcela, quantidade_volumes, ordem_compra } = params;
        if (!sales_order_id || !codigo_cliente || !items?.length) {
          throw new Error("Dados insuficientes para criar pedido de venda");
        }
        const pedido = await criarPedidoVenda(
          supabaseAdmin,
          sales_order_id,
          codigo_cliente,
          codigo_vendedor,
          items,
          observacao,
          codigo_parcela,
          account,
          quantidade_volumes,
          ordem_compra
        );
        result = { success: true, ...pedido };
        break;
      }

      case "listar_formas_pagamento": {
        const formas = await listarFormasPagamento(account);
        result = { success: true, formas };
        break;
      }

      case "buscar_ultima_parcela": {
        const { codigo_cliente: codCli } = params;
        if (!codCli) throw new Error("Código do cliente é obrigatório");
        const parcelaData = await buscarUltimaParcela(codCli, account);
        result = { success: true, ...parcelaData };
        break;
      }

      // Fase 2: 1 chamada consolidada (preço+dInc por produto + parcela + ranking +
      // código resolvido p/ colacor). Substitui as ListarPedidos concorrentes que
      // colidiam no rate-limit (~40s). codigo_cliente p/ oben; document p/ colacor.
      case "buscar_contexto_comercial_cliente": {
        const { codigo_cliente: ctxCod, document: ctxDoc } = params;
        const ctx = await buscarContextoComercialCliente(
          { codigoCliente: ctxCod ?? null, document: ctxDoc ?? null },
          account,
        );
        result = { success: true, ...ctx };
        break;
      }

      case "alterar_pedido": {
        const {
          sales_order_id: editSoId,
          items: editItems,
          observacao: editObs,
          codigo_parcela: editParcela,
          quantidade_volumes: editVolumes,
          ordem_compra: editOrdemCompra,
        } = params;
        if (!editSoId || !editItems?.length) throw new Error("Dados insuficientes para alterar pedido");

        // Load existing order
        const { data: existingOrder } = await supabaseAdmin
          .from("sales_orders")
          .select("*")
          .eq("id", editSoId)
          .single();
        if (!existingOrder) throw new Error("Pedido não encontrado");
        if (!existingOrder.omie_pedido_id) throw new Error("Pedido não possui ID no Omie para alteração");

        const editAccount: Account = (existingOrder.account === "colacor") ? "colacor" : "oben";
        const editConfig = getAccountConfig(editAccount);

        // Build updated items payload for local DB
        const editItemsTyped: EditItemInput[] = editItems;
        const updatedItemsPayload = editItemsTyped.map((item) => ({
          product_id: item.product_id,
          omie_codigo_produto: item.omie_codigo_produto,
          codigo: item.codigo,
          descricao: item.descricao,
          unidade: item.unidade,
          quantidade: item.quantidade,
          valor_unitario: item.valor_unitario,
          valor_total: item.quantidade * item.valor_unitario,
          ...(item.tint_cor_id ? { tint_cor_id: item.tint_cor_id, tint_nome_cor: item.tint_nome_cor } : {}),
        }));
        const updatedSubtotal = updatedItemsPayload.reduce((s: number, i) => s + i.valor_total, 0);

        // Build Omie payload
        const origPayload = existingOrder.omie_payload as {
          informacoes_adicionais?: { codVend?: number };
          frete?: { codigo_transportadora?: number };
        } | null;
        const codigoPedido = Number(existingOrder.omie_pedido_id);
        const buildExpectedSignature = (items: EditItemInput[]) => items
          .map((item) => `${Number(item.omie_codigo_produto)}:${Number(item.quantidade)}:${Number(item.valor_unitario).toFixed(4)}`)
          .sort()
          .join("|");
        const buildOmieSignature = (items: OmieDetalheItem[]) => items
          .map((item) => {
            const prod = item?.produto || {};
            return `${Number(prod.codigo_produto)}:${Number(prod.quantidade)}:${Number(prod.valor_unitario).toFixed(4)}`;
          })
          .sort()
          .join("|");

        // Step 1: Consult the real order in Omie to get actual item codes
        let omieCurrentItems: OmieDetalheItem[] = [];
        try {
          const consultResult = (await callOmieVendasApi(
            "produtos/pedido/",
            "ConsultarPedido",
            { codigo_pedido: codigoPedido },
            editAccount
          )) as { pedido_venda_produto?: { det?: OmieDetalheItem[] }; det?: OmieDetalheItem[] } | null;
          // Omie returns items under pedido_venda_produto.det
          omieCurrentItems = consultResult?.pedido_venda_produto?.det
            || consultResult?.det
            || [];
          console.log(`[Omie Vendas][${editAccount}] Pedido consultado: ${omieCurrentItems.length} itens no Omie`);
        } catch (consultErr) {
          const msg = consultErr instanceof Error ? consultErr.message : String(consultErr);
          console.warn(`[Omie Vendas][${editAccount}] Erro ao consultar pedido: ${msg}`);
        }

        // Step 2: Delete all existing items
        for (const omieItem of omieCurrentItems) {
          const codItem = omieItem?.ide?.codigo_item;
          const codItemInt = omieItem?.ide?.codigo_item_integracao;
          if (codItem || codItemInt) {
            try {
              await callOmieVendasApi(
                "produtos/pedidovenda/",
                "ExcluirItemPedido",
                {
                  codigo_pedido: codigoPedido,
                  ...(codItem ? { codigo_item: Number(codItem) } : {}),
                  ...(codItemInt ? { codigo_item_integracao: codItemInt } : {}),
                },
                editAccount
              );
              console.log(`[Omie Vendas][${editAccount}] Item ${codItemInt || codItem} excluído`);
            } catch (delErr) {
              const msg = delErr instanceof Error ? delErr.message : String(delErr);
              throw new Error(`Falha ao excluir item existente do pedido no Omie: ${msg}`);
            }
          }
        }

        // Step 3: Add each new item individually
        const newDetForPayload: Array<{ ide: { codigo_item_integracao: number }; produto: { codigo_produto: number; quantidade: number; valor_unitario: number } }> = [];

        // Extract default CFOP from existing items (before deletion)
        const defaultCfop = (() => {
          for (const oi of omieCurrentItems) {
            const cfop = oi?.produto?.cfop || oi?.imposto?.cfop;
            if (cfop) return String(cfop);
          }
          return "5102"; // Venda de mercadoria adquirida (padrão)
        })();
        console.log(`[Omie Vendas][${editAccount}] CFOP padrão extraído: ${defaultCfop}`);

        for (let index = 0; index < editItems.length; index++) {
          const item = editItems[index];
          const itemCode = getOmieItemIntegrationCode(index);
          const inclPayload: Record<string, unknown> = {
            codigo_pedido: codigoPedido,
            codigo_item_integracao: itemCode,
            codigo_produto: item.omie_codigo_produto,
            quantidade: item.quantidade,
            valor_unitario: item.valor_unitario,
            cfop: defaultCfop,
          };

          if (editOrdemCompra) {
            inclPayload.dados_adicionais_item = editOrdemCompra;
            inclPayload.numero_pedido_compra = editOrdemCompra;
          } else if (item.tint_cor_id && item.tint_nome_cor) {
            const nomeJaTemCodigo = item.tint_nome_cor.toUpperCase().includes(item.tint_cor_id.toUpperCase());
            const corLabel = nomeJaTemCodigo ? item.tint_nome_cor : `${item.tint_cor_id} - ${item.tint_nome_cor}`;
            const descUpper = (item.descricao || '').toUpperCase();
            let embTag = '';
            if (descUpper.includes(' QT') || descUpper.endsWith('QT')) embTag = 'QT';
            else if (descUpper.includes(' GL') || descUpper.endsWith('GL')) embTag = 'GL';
            else if (descUpper.includes(' LT') || descUpper.endsWith('LT')) embTag = 'LT';
            const corInfo = `Cor: ${corLabel}${embTag ? ` - ${embTag}` : ''}`;
            inclPayload.dados_adicionais_item = corInfo;
            inclPayload.obs_item = corInfo;
          }

          try {
            await callOmieVendasApi("produtos/pedidovenda/", "IncluirItemPedido", inclPayload, editAccount);
            console.log(`[Omie Vendas][${editAccount}] Item ${index + 1} incluído: ${item.descricao}`);
          } catch (inclErr) {
            const msg = inclErr instanceof Error ? inclErr.message : String(inclErr);
            throw new Error(`Falha ao incluir item ${index + 1} no Omie: ${msg}`);
          }

          newDetForPayload.push({
            ide: { codigo_item_integracao: itemCode },
            produto: { codigo_produto: item.omie_codigo_produto, quantidade: item.quantidade, valor_unitario: item.valor_unitario },
          });
        }

        // Step 4: Update header (payment, freight, obs) without det
        const editCabecalho: Record<string, unknown> = {
          codigo_pedido: codigoPedido,
          data_previsao: new Date().toISOString().split("T")[0].split("-").reverse().join("/"),
          etapa: "10",
          codigo_parcela: editParcela || "999",
        };

        const editInfoAdic: Record<string, unknown> = {
          codigo_categoria: editConfig.codigo_categoria,
          codigo_conta_corrente: editConfig.codigo_conta_corrente,
        };
        if (origPayload?.informacoes_adicionais?.codVend) {
          editInfoAdic.codVend = origPayload.informacoes_adicionais.codVend;
        }

        const editFrete: Record<string, unknown> = { modalidade: "0", especie_volumes: "VOL" };
        if (origPayload?.frete?.codigo_transportadora) {
          editFrete.codigo_transportadora = origPayload.frete.codigo_transportadora;
        }
        if (editVolumes && editVolumes > 0) {
          editFrete.quantidade_volumes = editVolumes;
        }

        try {
          await callOmieVendasApi("produtos/pedido/", "AlterarPedidoVenda",
            { cabecalho: editCabecalho, frete: editFrete, observacoes: { obs_venda: editObs || editConfig.obs_prefix }, informacoes_adicionais: editInfoAdic },
            editAccount);
        } catch (headerErr) {
          const msg = headerErr instanceof Error ? headerErr.message : String(headerErr);
          throw new Error(`Falha ao atualizar cabeçalho do pedido no Omie: ${msg}`);
        }

        await callOmieVendasApi(
          "produtos/pedidovenda/",
          "TotalizarPedido",
          { codigo_pedido: codigoPedido },
          editAccount,
        );

        const finalConsultResult = (await callOmieVendasApi(
          "produtos/pedido/",
          "ConsultarPedido",
          { codigo_pedido: codigoPedido },
          editAccount,
        )) as { pedido_venda_produto?: { det?: OmieDetalheItem[] }; det?: OmieDetalheItem[] } | null;
        const finalOmieItems: OmieDetalheItem[] = finalConsultResult?.pedido_venda_produto?.det
          || finalConsultResult?.det
          || [];
        const expectedSignature = buildExpectedSignature(editItems);
        const omieSignature = buildOmieSignature(finalOmieItems);

        console.log(
          `[Omie Vendas][${editAccount}] Validação final do pedido ${codigoPedido}: esperado=${editItems.length}, omie=${finalOmieItems.length}`,
        );

        if (finalOmieItems.length !== editItems.length || expectedSignature !== omieSignature) {
          console.error(
            `[Omie Vendas][${editAccount}] Divergência após alteração. esperado=${expectedSignature} omie=${omieSignature}`,
          );
          throw new Error(
            `Omie não confirmou a substituição completa dos itens do pedido (esperado ${editItems.length} itens e recebeu ${finalOmieItems.length}).`,
          );
        }

        const editPayload: Record<string, unknown> = {
          cabecalho: editCabecalho, frete: editFrete, det: newDetForPayload,
          observacoes: { obs_venda: editObs || editConfig.obs_prefix }, informacoes_adicionais: editInfoAdic,
        };

        console.log(`[Omie Vendas][${editAccount}] Pedido atualizado: ${editItems.length} itens`);
        const editResult = {
          descricao_status: "Pedido alterado com sucesso!",
          validated: true,
          validated_items: finalOmieItems.length,
        };

        // Update local DB
        await supabaseAdmin
          .from("sales_orders")
          .update({
            items: updatedItemsPayload,
            subtotal: updatedSubtotal,
            total: updatedSubtotal,
            notes: editObs || existingOrder.notes,
            omie_payload: editPayload,
            omie_response: editResult,
            updated_at: new Date().toISOString(),
          })
          .eq("id", editSoId);

        result = { success: true, omie_response: editResult };
        break;
      }

      case "excluir_pedido": {
        const { omie_pedido_id: pedidoId, sales_order_id: soId } = params;
        if (!soId) throw new Error("ID do pedido é obrigatório");

        // Determine the account of this order
        const { data: orderData } = await supabaseAdmin
          .from("sales_orders")
          .select("account")
          .eq("id", soId)
          .single();
        const orderAccount: Account = (orderData?.account === "colacor") ? "colacor" : "oben";

        // Try to cancel in Omie if it was synced
        if (pedidoId && Number(pedidoId) > 0) {
          try {
            await callOmieVendasApi(
              "produtos/pedido/",
              "CancelarPedido",
              { codigo_pedido: Number(pedidoId) },
              orderAccount
            );
            console.log(`[Omie Vendas][${orderAccount}] Pedido ${pedidoId} cancelado no Omie`);
          } catch (omieErr) {
            const msg = omieErr instanceof Error ? omieErr.message : String(omieErr);
            console.warn(`[Omie Vendas][${orderAccount}] Erro ao cancelar no Omie (continuando exclusão local):`, msg);
          }
        }

        // Delete locally
        const { error: delError } = await supabaseAdmin
          .from("sales_orders")
          .delete()
          .eq("id", soId);
        if (delError) throw delError;

        result = { success: true };
        break;
      }

      case "sync_pedidos": {
        const startPagePedidos = params.start_page || 1;
        const maxPagesPedidos = params.max_pages || 10;
        const dateFrom = params.date_from || undefined; // DD/MM/YYYY
        const dateTo = params.date_to || undefined;     // DD/MM/YYYY
        const syncPedidosResult = await syncPedidos(supabaseAdmin, startPagePedidos, maxPagesPedidos, account, dateFrom, dateTo);
        result = { success: true, ...syncPedidosResult };
        break;
      }

      case "historico_produtos_cliente": {
        const { codigo_cliente: codCliHist } = params;
        if (!codCliHist) throw new Error("Código do cliente é obrigatório");
        // Fetch last 5 pages of orders for this client from Omie
        const productHistory: Record<string, string> = {}; // omie_codigo_produto -> last date
        try {
          for (let page = 1; page <= 5; page++) {
            const pedidos = await callOmieVendasApi(
              "produtos/pedido/",
              "ListarPedidos",
              {
                pagina: page,
                registros_por_pagina: 50,
                filtrar_por_cliente: codCliHist,
                ordenar_por: "DATA_INCLUSAO",
              },
              account
            );
            const lista = pedidos?.pedido_venda_produto || [];
            for (const pedido of lista) {
              const dataPedido = pedido?.cabecalho?.data_previsao || pedido?.infoCadastro?.dInc || '';
              const itens = pedido?.det || [];
              for (const item of itens) {
                const codProd = item?.produto?.codigo_produto || 0;
                if (codProd && !productHistory[String(codProd)]) {
                  productHistory[String(codProd)] = dataPedido;
                }
              }
            }
            const totalPages = pedidos?.total_de_paginas || 1;
            if (page >= totalPages) break;
          }
        } catch (e) {
          console.log("[Omie Vendas] Erro ao buscar histórico de pedidos:", e);
        }
        // Also save preferred items to DB
        if (Object.keys(productHistory).length > 0) {
          try {
            // Get product details from omie_products
            const omieCodes = Object.keys(productHistory).map(Number);
            const { data: prods } = await supabaseAdmin
              .from('omie_products')
              .select('omie_codigo_produto, codigo, descricao, familia')
              .in('omie_codigo_produto', omieCodes)
              .eq('account', account);
            
            const prodMap = new Map((prods || []).map(p => [p.omie_codigo_produto, p]));
            
            for (const [omieCod, dateStr] of Object.entries(productHistory)) {
              const prod = prodMap.get(Number(omieCod));
              const parts = dateStr.split('/');
              const isoDate = parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : dateStr;
              
              await supabaseAdmin.from('customer_preferred_items').upsert({
                omie_codigo_cliente: codCliHist,
                omie_codigo_produto: Number(omieCod),
                product_codigo: prod?.codigo || null,
                product_descricao: prod?.descricao || null,
                familia: prod?.familia || null,
                account,
                last_ordered_at: isoDate,
                added_manually: false,
              }, { onConflict: 'omie_codigo_cliente,omie_codigo_produto,account' });
            }
          } catch (saveErr) {
            console.log("[Omie Vendas] Erro ao salvar itens preferidos:", saveErr);
          }
        }
        
        result = { success: true, history: productHistory };
        break;
      }

      case "salvar_segmento_cliente": {
        const { codigo_cliente: codCliSeg, tags: clientTags, atividade: clientAtividade, segment: clientSegment } = params;
        if (!codCliSeg) throw new Error("Código do cliente é obrigatório");
        
        await supabaseAdmin.from('customer_segments').upsert({
          omie_codigo_cliente: codCliSeg,
          account,
          segment: clientSegment || null,
          tags: clientTags || [],
          atividade: clientAtividade || null,
        }, { onConflict: 'omie_codigo_cliente,account' });
        
        result = { success: true };
        break;
      }

      case "buscar_itens_preferidos": {
        const { codigo_cliente: codCliPref } = params;
        if (!codCliPref) throw new Error("Código do cliente é obrigatório");
        
        const { data: items } = await supabaseAdmin
          .from('customer_preferred_items')
          .select('*')
          .eq('omie_codigo_cliente', codCliPref)
          .eq('account', account)
          .order('last_ordered_at', { ascending: false });
        
        const { data: seg } = await supabaseAdmin
          .from('customer_segments')
          .select('*')
          .eq('omie_codigo_cliente', codCliPref)
          .eq('account', account)
          .maybeSingle();
        
        result = { success: true, items: items || [], segment: seg };
        break;
      }

      case "criar_ordem_producao": {
        const { sales_order_id: opSalesId, items: opItems } = params;
        if (!opSalesId || !opItems?.length) throw new Error("Dados insuficientes para criar ordem de produção");

        const opItemsTyped: OpItemInput[] = opItems;
        const createdOPs: CreatedOP[] = [];
        for (const opItem of opItemsTyped) {
          // Create production order in Omie
          const opPayload = {
            cCodIntOP: `OP_${opSalesId.substring(0, 8)}_${opItem.omie_codigo_produto}_${Date.now()}`,
            nCodProd: opItem.omie_codigo_produto,
            nQtde: opItem.quantidade,
            dDtPrevisao: new Date().toISOString().split("T")[0].split("-").reverse().join("/"),
            cObservacao: `Gerado automaticamente via App - Pedido ${opSalesId.substring(0, 8)}`,
          };

          let omieOrdemId: number | null = null;
          let omieOrdemNumero: string | null = null;
          try {
            const opResult = (await callOmieVendasApi(
              "manufatura/ordemproducao/",
              "IncluirOrdemProducao",
              opPayload,
              account
            )) as { nCodOP?: number; cNumOP?: string } | null;
            omieOrdemId = opResult?.nCodOP || null;
            omieOrdemNumero = opResult?.cNumOP || String(omieOrdemId);
            console.log(`[Omie Vendas][${account}] OP criada: ${omieOrdemNumero}`);
          } catch (opErr) {
            const msg = opErr instanceof Error ? opErr.message : String(opErr);
            console.error(`[Omie Vendas][${account}] Erro ao criar OP:`, msg);
          }

          // Save to local DB
          const { data: insertedOP } = await supabaseAdmin.from("production_orders").insert({
            sales_order_id: opSalesId,
            product_id: opItem.product_id || null,
            product_codigo: opItem.codigo || null,
            product_descricao: opItem.descricao || null,
            quantidade: opItem.quantidade,
            unidade: opItem.unidade || 'UN',
            status: 'pending',
            omie_ordem_producao_id: omieOrdemId,
            omie_ordem_numero: omieOrdemNumero,
            assigned_to: opItem.assigned_to || null,
            ready_by_date: opItem.ready_by_date || null,
            account,
            created_by: userId,
          }).select('id').single();

          createdOPs.push({ id: insertedOP?.id, omie_ordem_id: omieOrdemId, omie_ordem_numero: omieOrdemNumero, descricao: opItem.descricao });
        }

        result = { success: true, production_orders: createdOPs };
        break;
      }

      case "finalizar_ordem_producao": {
        const { production_order_id } = params;
        if (!production_order_id) throw new Error("ID da ordem de produção é obrigatório");

        const { data: poData } = await supabaseAdmin
          .from("production_orders")
          .select("*")
          .eq("id", production_order_id)
          .single();
        if (!poData) throw new Error("Ordem de produção não encontrada");

        const po = poData as { account?: string; omie_ordem_producao_id?: number | null; omie_ordem_numero?: string | null };
        const poAccount: Account = po.account === "colacor" ? "colacor" : "oben";

        // Finalize in Omie if it has an Omie ID
        if (po.omie_ordem_producao_id) {
          try {
            await callOmieVendasApi(
              "manufatura/ordemproducao/",
              "AlterarOrdemProducao",
              {
                nCodOP: po.omie_ordem_producao_id,
                cEtapa: "50", // Encerrada
              },
              poAccount
            );
            console.log(`[Omie Vendas][${poAccount}] OP ${po.omie_ordem_numero} finalizada no Omie`);
          } catch (omieErr) {
            const msg = omieErr instanceof Error ? omieErr.message : String(omieErr);
            console.warn(`[Omie Vendas][${poAccount}] Erro ao finalizar OP no Omie:`, msg);
          }
        }

        await supabaseAdmin
          .from("production_orders")
          .update({ status: "completed", completed_at: new Date().toISOString() })
          .eq("id", production_order_id);

        result = { success: true };
        break;
      }

      default:
        throw new Error(`Ação desconhecida: ${action}`);
    }

    if (vendaLogId && !vendaSyncFinalized) {
      await completeVendaSync(supabaseAdmin, vendaLogId, result);
      vendaSyncFinalized = true;
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Omie Vendas] Erro:", error);
    // Finaliza o log de sync órfão como 'error' (best-effort interno → não
    // mascara nem altera a resposta 500 original).
    if (vendaLogId && !vendaSyncFinalized) {
      await completeVendaSync(
        supabaseAdmin,
        vendaLogId,
        null,
        error instanceof Error ? error.message : String(error),
      );
      vendaSyncFinalized = true;
    }
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Erro desconhecido",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
