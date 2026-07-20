import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { omieDateToIso, classifyOmieTransient, classifyPedidosPage, gerarJanelasMensais } from "./pagination.ts";

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
  // Fase 3 tint: metadados de precificação do picker — insumo do gate de
  // revalidação (tint_gate_revalida) na fronteira. Ausentes = item legado.
  tint_formula_id?: string;
  tint_price_source?: string;
  tint_discount_pct?: number;
  tint_preco_sem_desconto?: number;
}

// (OrderBatchRow/OrderItemBatchRow/PriceHistoryBatchRow removidos: o sync agora monta o payload
//  da RPC criar_pedidos_com_itens — pai+itens+preços atômicos — em vez de 3 inserts soltos.)

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
  // Fase 3 tint: metadados de precificação (ver OrderItemPayload)
  tint_formula_id?: string;
  tint_price_source?: string;
  tint_discount_pct?: number;
  tint_preco_sem_desconto?: number;
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
  account: Account = "oben",
  // throwOnTransient: erro transitório que ESGOTOU os retries vira THROW em
  // vez de null. Sem isso, o null é AMBÍGUO ("não existe" × "Omie fora do
  // ar") — e no caminho de criação de cliente a ambiguidade vira DUPLICATA
  // no ERP (lookup falho lido como ausência → IncluirCliente). Usar nos
  // lookups de identidade; syncs paginados continuam tratando null como fim.
  opts?: { throwOnTransient?: boolean },
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
        if (opts?.throwOnTransient) {
          throw new Error(`OMIE_TRANSIENT (${account}): ${isRateLimit ? 'rate limit' : 'erro transitório'} persistiu após ${maxRetries} tentativas — não dá pra afirmar ausência`);
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

// Buscar cliente na empresa de vendas pelo CPF/CNPJ.
// opts.throwOnTransient: falha transitória do Omie LANÇA em vez de retornar
// null (null = ausência CONFIRMADA) — obrigatório nos caminhos de decisão de
// criação (anti-duplicata); enriquecimentos best-effort ficam sem.
async function buscarClienteVendas(
  document: string,
  account: Account = "oben",
  opts?: { throwOnTransient?: boolean },
) {
  const documentClean = document.replace(/\D/g, "");

  const result = await callOmieVendasApi(
    "geral/clientes/",
    "ListarClientes",
    {
      pagina: 1,
      registros_por_pagina: 1,
      clientesFiltro: { cnpj_cpf: documentClean },
    },
    account,
    opts
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

// dInc do Omie é DD/MM/YYYY → ms UTC (0 se ausente/ilegível, p/ NÃO vencer o merge
// por data no frontend). Usado p/ escolher, por produto/parcela, o pedido de maior data.
function parseDIncMs(s: string): number {
  const m = (s || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return 0;
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return 0;
  return Date.UTC(y, mo - 1, d);
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

  // Order-independent: por produto/parcela mantém o de MAIOR dInc (a ordem da lista do
  // Omie NÃO é garantida). dInc = precedência; NÃO data_previsao (data futura de entrega
  // venceria o merge indevidamente). Sem dInc → '' → o frontend trata como sem-data e o
  // local datado vence (seguro).
  const dIncMs: Record<number, number> = {};
  let ultimaParcelaMs = -1;
  for (const pedido of pedidos) {
    const dataInc = pedido.infoCadastro?.dInc || "";
    const incMs = parseDIncMs(dataInc);
    const parcela = pedido.cabecalho?.codigo_parcela;
    if (parcela) {
      parcelaCount[parcela] = (parcelaCount[parcela] || 0) + 1;
      if (ultimaParcela === null || incMs > ultimaParcelaMs) {
        ultimaParcela = parcela;
        ultimaParcelaMs = incMs;
      }
    }
    for (const item of pedido.det || []) {
      const cod = item.produto?.codigo_produto;
      const val = item.produto?.valor_unitario;
      if (cod && val && val > 0 && (precos[cod] === undefined || incMs > (dIncMs[cod] ?? -1))) {
        precos[cod] = val;
        datas[cod] = dataInc;
        dIncMs[cod] = incMs;
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
  // Modo cursor (backfill): presença ⟹ heartbeat do lease por página + completude
  // null-discriminada (vendas_sync_cursor). df/dt são as datas ISO (PK do cursor).
  cursor?: { df: string; dt: string },
) {
  let pagina = startPage;
  let totalPaginas = 1;
  let totalSynced = 0;
  let totalItems = 0;
  let pagesProcessed = 0;
  let skippedNoClient = 0;
  let skippedExisting = 0;
  let totalFailed = 0;
  let reachedEnd = false;            // true SÓ no fim real do Omie (null = "Não existem registros", ou página vazia)
  let lastErrorKind: 'rate_limit' | 'transient' | 'http' | null = null;

  // ── Snapshot atômico de identidade doc→user (RPC server-side) — fecha a corrida A1 ──
  // Antes: paginação KEYSET de profiles montava o docToUserMap com buildDocUserMapFailClosed. Era
  // não-atômica (Codex xhigh 2026-07-10): um profile que nascia/mudava ENTRE páginas escapava da
  // detecção de doc-ambíguo. Agora a unicidade doc→user é resolvida num ÚNICO snapshot MVCC server-side
  // (omie_sync_identity_snapshot, sql STABLE): doc com 2+ users DISTINTOS já vem FORA de doc_to_user e
  // listado em ambiguous_docs (métrica). O fail-closed (precisão>recall) vive no SQL, não mais no TS.
  // .rpc() NÃO lança em erro (resolve {error}) → checar e FAIL-CLOSED (throw): um mapa PARCIAL silencioso
  // causaria miss no fallback resolveClientUserId → skip/atribuição arbitrária. Aborta e retoma.
  const { data: snap, error: snapErr } = await supabase.rpc('omie_sync_identity_snapshot', { p_account: account });
  if (snapErr) throw new Error(`identity snapshot (${account}): ${snapErr.message}`);
  // Validação ESTRITA do contrato (Codex challenge PR-1): .rpc() error=null só prova HTTP/SQL, NÃO o JSON.
  // Uma RPC revertida devolvendo {doc_to_user:null,...} (HTTP 200) degradaria p/ Map(0) SILENCIOSO → pedidos
  // pulados. parseIdentitySnapshot LANÇA em shape inválido (null/array/não-UUID/doc ambíguo vazado) — fail-closed.
  const { docToUserMap, ambiguousDocs } = parseIdentitySnapshot(snap);
  console.log(`[sync_pedidos][${account}] Identity snapshot: ${docToUserMap.size} doc(s) único(s), ${ambiguousDocs.size} ambíguo(s) excluído(s) (fail-closed server-side)`);

  // pgSize/hasMore ficam declarados aqui pois o pré-load do clientCache (abaixo) os reusa.
  const pgSize = 1000;
  let hasMore = true;

  // Dedupe DENTRO da run (evita mandar o mesmo pedido 2x na mesma chamada). NÃO pré-carregamos
  // hashes do banco: todos os pedidos válidos da janela vão para a RPC criar_pedidos_com_itens,
  // que decide insert/skip-completo/reparo atomicamente (ON CONFLICT parcial + SELECT FOR UPDATE
  // + NOT EXISTS). Assim um órfão (pai sem itens) que reaparece na janela é AUTO-REPARADO — antes
  // era pulado pelo hash do pai e os itens nunca eram restaurados.
  const seenHashes = new Set<string>();

  // ── Pre-load mapping (codigo_cliente -> user_id) da VIEW FRESCA account-correta p/ EVITAR chamadas API ──
  // P0-B-bis PR-2: a fonte era o espelho poluído omie_clientes SEM filtro de conta. Como o código Omie é
  // numerado POR conta, um código desta conta podia colidir com o mesmo número em OUTRA conta e o cache (1
  // chave global codigo->user) mapeava o user_id ERRADO — pedido atribuído ao cliente errado (bug #4 do
  // design; o espelho é sobrescrito ao longo do dia pelos writers colacor_sc, então a colisão é intermitente).
  // A view omie_customer_account_map_fresco é account-correta (UNIQUE(codigo,account)) e document-first; o
  // miss aqui cai no resolveClientUserId → API ConsultarCliente (fail-safe).
  // Paginação KEYSET (.gt no código + .limit), não offset: a view filtra updated_at>=now()-7d, então uma
  // linha pode cruzar o TTL ENTRE páginas; keyset é imune a esse deslocamento (offset .range pularia/repetiria
  // — Codex P2). O código é UNIQUE(codigo,account) → ordenação sem empate. Erro de query é FAIL-CLOSED (throw):
  // engolir o error (capa silenciosa do PostgREST) deixaria um cache parcial → milhares de miss → rate-limit
  // no Omie → skip/atribuição arbitrária no fallback. Melhor abortar o run e retomar na próxima janela.
  const clientCache = new Map<number, string | null>();
  let lastCodigo = 0;
  hasMore = true;
  while (hasMore) {
    const { data: batch, error: cacheErr } = await supabase
      .from('omie_customer_account_map_fresco')
      .select('omie_codigo_cliente, user_id')
      .eq('account', account)
      .gt('omie_codigo_cliente', lastCodigo)
      .order('omie_codigo_cliente')
      .limit(pgSize);
    if (cacheErr) throw new Error(`pre-load client cache (${account}): ${cacheErr.message}`);
    if (!batch || batch.length === 0) { hasMore = false; }
    else {
      for (const oc of batch) {
        clientCache.set(oc.omie_codigo_cliente, oc.user_id);
      }
      lastCodigo = batch[batch.length - 1].omie_codigo_cliente;
      if (batch.length < pgSize) hasMore = false;
    }
  }
  console.log(`[sync_pedidos][${account}] Client cache from omie_customer_account_map_fresco: ${clientCache.size}`);

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
    // Fallback: chama a API Omie só p/ clientes fora do cache. throwOnTransient em AMBOS os modos (cursor
    // E incremental — P2 Codex xhigh 2026-07-10): um rate-limit/transitório do ConsultarCliente NÃO pode
    // virar "cliente ausente" cacheado. No incremental (sem cursor) isso pulava o pedido (skippedNoClient++)
    // e a janela COMPLETAVA success:true; se a falha persistisse até o pedido sair da janela de ~5 dias →
    // PERDA PERMANENTE silenciosa. SEM try/catch: o transitório (e qualquer erro de lookup) PROPAGA — no
    // cursor o loop PAUSA e retoma; no incremental propaga (500 + fin_sync_log error) e a próxima run
    // reprocessa a janela (idempotente, a RPC decide skip/reparo). Só o caminho SEM erro cacheia null:
    // result null ("Não existem registros" no Omie) ou doc<11 (cliente sem CPF/CNPJ usável) = ausência
    // CONFIRMADA. Ver callOmieVendasApi: "Não existem registros"/HTTP-erro independem de throwOnTransient.
    const result = (await callOmieVendasApi(
      "geral/clientes/",
      "ConsultarCliente",
      { codigo_cliente_omie: codigoCliente },
      account,
      { throwOnTransient: true },
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

  // Loop de paginação. A COMPLETUDE vem do FIM REAL do Omie — `null` ("Não existem
  // registros", desambiguado por throwOnTransient) ou página vazia — NUNCA de
  // total_de_paginas (que mente; CLAUDE.md: "paginar até página vazia + guard").
  // maxPages limita a invocação; no modo cursor a próxima retoma do next_page.
  // throwOnTransient distingue rate-limit/transitório (throw → PAUSA, não completa)
  // de fim real (null) — conserta o defeito #1 do spec (null ambíguo).
  while (pagesProcessed < maxPages) {
    // Modo cursor: renova o lease + persiste progresso (next_page := pagina em curso)
    // ANTES da página longa (~40s/pág + lookups). Crash → retoma daqui, não do run-start.
    if (cursor) await heartbeatVendasCursor(supabase, account, cursor.df, cursor.dt, pagina);

    const listParams: Record<string, unknown> = { pagina, registros_por_pagina: 50, filtrar_apenas_inclusao: "N" };
    if (dateFrom) listParams.filtrar_por_data_de = dateFrom;
    if (dateTo) listParams.filtrar_por_data_ate = dateTo;

    let result: OmieGenericResponse | null = null;
    try {
      result = await callOmieVendasApi(
        "produtos/pedido/",
        "ListarPedidos",
        listParams,
        account,
        { throwOnTransient: true },
      );
    } catch (e) {
      const msg = (e as Error).message || '';
      if (msg.startsWith('OMIE_TRANSIENT')) {
        // rate-limit/transitório esgotado → PAUSA (nextPage retoma, NÃO marca completo).
        lastErrorKind = classifyOmieTransient(msg);
        console.log(`[sync_pedidos][${account}] transitório (${lastErrorKind}) na pág ${pagina} — pausa, não marca completo`);
        break;
      }
      if (cursor) {
        // Erro Omie não-transitório no backfill: pausa graciosa (kind fica visível no
        // cursor p/ o relatório §4.4), sem derrubar o edge nem marcar completo.
        lastErrorKind = 'http';
        console.error(`[sync_pedidos][${account}] erro Omie não-transitório na pág ${pagina} (cursor pausa):`, msg);
        break;
      }
      throw e; // incremental: propaga (comportamento de hoje → 500 + fin_sync_log error)
    }

    const pageClass = classifyPedidosPage(result, pagina);
    if (pageClass === 'end') {
      // FIM REAL: result null ("Não existem registros") OU página vazia que não
      // contradiz total_de_paginas. throwOnTransient garante que NÃO é rate-limit.
      // Só ISTO completa a janela (nunca total_de_paginas como autoridade de fim).
      reachedEnd = true;
      console.log(`[sync_pedidos][${account}] fim real na pág ${pagina} (sem registros)`);
      break;
    }
    if (pageClass === 'anomaly') {
      // Página vazia CONTRADIZENDO total_de_paginas → suspeito → PAUSA, não completa
      // (precisão > recall: janela presa visível no cursor > falsa completude silenciosa).
      lastErrorKind = 'http';
      console.error(`[sync_pedidos][${account}] ANOMALIA pág ${pagina} vazia mas total_de_paginas diz que há mais — pausa, NÃO completa`);
      break;
    }

    totalPaginas = (result!.total_de_paginas as number) || 1; // só p/ log/ETA — NÃO decide completude
    const pedidos: OmiePedidoVendaProduto[] = (result!.pedido_venda_produto as OmiePedidoVendaProduto[] | undefined) || [];

    // Resolve only unknown client codes (most should be in cache from omie_clientes)
    const uniqueClientCodes = [...new Set(pedidos.map((p) => p.cabecalho?.codigo_cliente).filter((c): c is number => Boolean(c)))];
    const unknownCodes = uniqueClientCodes.filter(c => !clientCache.has(c));
    if (unknownCodes.length > 0) {
      console.log(`[sync_pedidos][${account}] Resolving ${unknownCodes.length} unknown clients via API (concurrency=5)`);
      // Antes: for of await (serial). Agora: chunks de 5 em paralelo pra acelerar
      // sem floodar API Omie (rate limits Omie não documentados; 5 é conservador).
      const CHUNK = 5;
      try {
        for (let i = 0; i < unknownCodes.length; i += CHUNK) {
          await Promise.all(unknownCodes.slice(i, i + CHUNK).map(c => resolveClientUserId(c)));
        }
      } catch (e) {
        // #4/#A: no backfill, QUALQUER erro ao resolver cliente PAUSA a janela (não
        // cacheia ausência falsa nem completa sem o pedido). `break` sai do while.
        const msg = (e as Error).message || '';
        if (cursor) {
          lastErrorKind = msg.startsWith('OMIE_TRANSIENT') ? classifyOmieTransient(msg) : 'http';
          console.log(`[sync_pedidos][${account}] erro (${lastErrorKind}) ao resolver cliente na pág ${pagina} — pausa, não marca completo`);
          break;
        }
        throw e; // incremental: propaga (comportamento de hoje)
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

    // ── Monta o array de pedidos (pai + itens + preços) para a RPC transacional ──
    const pedidosRpc: Array<Record<string, unknown>> = [];

    for (const pedido of pedidos) {
      const cab = pedido.cabecalho || {};
      const codigoCliente = cab.codigo_cliente;
      const codigoPedido = cab.codigo_pedido;
      const numeroPedido = cab.numero_pedido;
      if (!codigoCliente || !codigoPedido) continue;

      const customerUserId = clientCache.get(codigoCliente) || null;
      if (!customerUserId) { skippedNoClient++; continue; }

      const hashPayload = `omie_${account}_${codigoPedido}`;

      // Dedupe dentro da run (a RPC decide skip-completo/reparo no banco — não pulamos por hash aqui).
      if (seenHashes.has(hashPayload)) continue;
      seenHashes.add(hashPayload);

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

      // Data canônica do pedido: dInc (inclusão no Omie = quando o cliente comprou) → previsão de
      // entrega → hoje (civil SP). UMA verdade para order_date_kpi (KPI de positivação) E created_at
      // (recência/scoring/cockpit). Antes o created_at vinha de data_previsao (entrega FUTURA) ou now(),
      // divergindo do dInc e re-sujando a recência a cada sync — o patch 20260618130000 era anulado em
      // dias (100% dos pedidos novos divergiam, psql-ro 2026-06-24). Money-path/recência.
      let orderDateKpi: string = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
      const dIncParts = pedido.infoCadastro?.dInc?.split('/');
      const dPrevParts = cab.data_previsao?.split('/');
      if (dIncParts && dIncParts.length === 3) {
        orderDateKpi = `${dIncParts[2]}-${dIncParts[1].padStart(2, '0')}-${dIncParts[0].padStart(2, '0')}`;
      } else if (dPrevParts && dPrevParts.length === 3) {
        orderDateKpi = `${dPrevParts[2]}-${dPrevParts[1].padStart(2, '0')}-${dPrevParts[0].padStart(2, '0')}`;
      }
      // created_at = MEIO-DIA UTC da data canônica. 12h de folga → created_at::date bate order_date_kpi
      // em UTC (edge) E America/Sao_Paulo (app); meia-noite UTC recuaria 1 dia em fuso negativo. Paridade
      // EXATA com o backfill/trigger (G6 universalizado em 20260624170000).
      const createdAt = `${orderDateKpi}T12:00:00.000Z`;

      // Get cached address/phone for this client
      const clientInfo = clientAddressCache.get(codigoCliente) || { address: '', phone: '' };

      // Itens (order_items) e preços (sales_price_history) deste pedido — entram na MESMA
      // transação da RPC (atômico com o pai). Mantém o filtro por codigo_produto e a regra
      // de preço (>0 + produto mapeado) do comportamento anterior.
      const itensRpc: Array<Record<string, unknown>> = [];
      const precosRpc: Array<Record<string, unknown>> = [];
      for (const det of detalhes) {
        const prod = det.produto || {};
        if (!prod.codigo_produto) continue;
        const productId = productMap.get(prod.codigo_produto) || null;
        itensRpc.push({
          customer_user_id: customerUserId,
          product_id: productId,
          omie_codigo_produto: prod.codigo_produto,
          quantity: prod.quantidade || 1,
          unit_price: prod.valor_unitario || 0,
          discount: prod.desconto || 0,
          hash_payload: `${hashPayload}_${prod.codigo_produto}`,
        });
        if (productId && (prod.valor_unitario || 0) > 0) {
          precosRpc.push({
            customer_user_id: customerUserId,
            product_id: productId,
            unit_price: prod.valor_unitario,
          });
        }
      }

      pedidosRpc.push({
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
        itens: itensRpc,
        precos: precosRpc,
      });
    }

    // ── Escrita ATÔMICA pai+filhos via RPC (substitui os 2 inserts PostgREST não-transacionais
    // que deixavam pedidos órfãos sem itens). A RPC decide por pedido: insert (novo) / repair
    // (órfão de cabeçalho compatível) / skip (completo ou divergente). Ver migration
    // 20260617160000_criar_pedidos_com_itens.sql + prove em db/test-criar-pedidos-com-itens.sh.
    if (pedidosRpc.length > 0) {
      const { data: rpcRes, error: rpcErr } = await supabase.rpc('criar_pedidos_com_itens', { p_pedidos: pedidosRpc });
      if (rpcErr) {
        // Money-path: a RPC é o ÚNICO caminho de escrita agora. Se ela falha (migration não
        // aplicada, grant, schema, conexão), LANÇAR — senão o sync fica verde sem gravar nada e
        // o fin_sync_log marca 'complete' mascarando perda total (achado /codex challenge).
        throw new Error(`[sync_pedidos][${account}] RPC criar_pedidos_com_itens falhou pág ${pagina}: ${rpcErr.message}`);
      } else if (rpcRes) {
        const r = rpcRes as { inserted?: number; repaired?: number; items?: number; skipped_complete?: number; skipped_no_items?: number; divergence?: unknown[]; failed?: unknown[] };
        totalSynced += (r.inserted || 0) + (r.repaired || 0);
        totalItems += r.items || 0;
        skippedExisting += r.skipped_complete || 0;
        const divs = r.divergence || [];
        const fails = r.failed || [];
        totalFailed += fails.length;
        if (divs.length > 0) console.warn(`[sync_pedidos][${account}] ${divs.length} pedido(s) com cabeçalho divergente (Fase 2, NÃO reconciliado):`, JSON.stringify(divs.slice(0, 5)));
        if (fails.length > 0) console.error(`[sync_pedidos][${account}] ${fails.length} pedido(s) FALHARAM na RPC pág ${pagina}:`, JSON.stringify(fails.slice(0, 5)));
        console.log(`[sync_pedidos][${account}] RPC pág ${pagina}: inserted=${r.inserted || 0} repaired=${r.repaired || 0} items=${r.items || 0} skip_completo=${r.skipped_complete || 0} skip_sem_item=${r.skipped_no_items || 0} divergencia=${divs.length} falhas=${fails.length}`);
      }
    }

    console.log(`[sync_pedidos][${account}] Página ${pagina}/${totalPaginas} — ${pedidosRpc.length} processados, ${skippedNoClient} sem cliente`);
    pagina++;
    pagesProcessed++;
  }

  // Completude = FIM REAL alcançado (null/página vazia), NUNCA pagina>totalPaginas.
  // Pausa (transitório/erro) ou budget de página esgotado ⟹ complete=false, retoma do `pagina`.
  const complete = reachedEnd;
  return { totalSynced, totalItems, totalFailed, skippedNoClient, skippedExisting, totalPaginas, lastPage: pagina - 1, nextPage: complete ? null : pagina, complete, lastErrorKind };
}

// ── Reparo dos órfãos PRESOS (pai sem itens, fora da janela do cron) ──────────────────
// Recebe a lista de omie_pedido_id a reparar (calculada via psql-ro). Para cada um:
// ConsultarPedido no Omie → monta itens → chama a MESMA RPC criar_pedidos_com_itens, que só
// repara se o cabeçalho local for compatível (guard de divergência). customer_user_id/created_by/
// order_date_kpi vêm do PAI existente; total/status vêm do Omie ATUAL, para a RPC detectar pedido
// alterado (→ relatório, não reconcilia). Idempotente: reprocessar é seguro (RPC faz NOT EXISTS).
async function repararOrfaosItens(
  supabase: SupabaseClient,
  account: Account,
  pedidoIds: number[],
) {
  let reparados = 0, itens = 0, divergencias = 0, falhas = 0, semDados = 0, jaCompletos = 0;
  const divergenciaAmostra: unknown[] = [];
  if (!Array.isArray(pedidoIds) || pedidoIds.length === 0) {
    return { reparados, itens, divergencias, falhas, semDados, jaCompletos, total: 0, divergenciaAmostra };
  }

  // Pre-load product map (codigo_produto -> product_id)
  const productMap = new Map<number, string>();
  {
    let page = 0; const sz = 1000; let more = true;
    while (more) {
      const { data: batch } = await supabase
        .from('omie_products').select('id, omie_codigo_produto')
        .eq('account', account).range(page * sz, (page + 1) * sz - 1);
      if (!batch || batch.length === 0) { more = false; }
      else { for (const p of batch) productMap.set(p.omie_codigo_produto, p.id); if (batch.length < sz) more = false; page++; }
    }
  }

  // Busca os pais por hash_payload determinístico (omie_<account>_<pid>), NÃO por omie_pedido_id:
  // (account, omie_pedido_id) é duplicado por design (push×pull, ver onda1_fase0) → buscar por id
  // pegaria a linha errada (ex.: a do push com hash_payload NULL). O hash é único (índice parcial).
  const paiByHash = new Map<string, { customer_user_id: string; created_by: string; hash_payload: string; order_date_kpi: string | null }>();
  for (let i = 0; i < pedidoIds.length; i += 300) {
    const hashes = pedidoIds.slice(i, i + 300).map((pid) => `omie_${account}_${pid}`);
    const { data: pais } = await supabase
      .from('sales_orders')
      .select('customer_user_id, created_by, hash_payload, order_date_kpi')
      .in('hash_payload', hashes);
    for (const p of (pais || [])) paiByHash.set(p.hash_payload, p);
  }

  const LOTE = 20;
  for (let i = 0; i < pedidoIds.length; i += LOTE) {
    const lote = pedidoIds.slice(i, i + LOTE);
    const pedidosRpc: Array<Record<string, unknown>> = [];

    for (const pid of lote) {
      const pai = paiByHash.get(`omie_${account}_${pid}`);
      if (!pai) { semDados++; continue; } // sem pai (com hash omie) p/ esse id

      const consulta = await callOmieVendasApi(
        "produtos/pedido/", "ConsultarPedido", { codigo_pedido: pid }, account,
      ) as { pedido_venda_produto?: OmiePedidoVendaProduto } | OmiePedidoVendaProduto | null;
      if (!consulta) { semDados++; continue; }
      const pv = ((consulta as { pedido_venda_produto?: OmiePedidoVendaProduto }).pedido_venda_produto ?? consulta) as OmiePedidoVendaProduto;
      const det: OmieDetalheItem[] = pv.det || [];
      const cab = pv.cabecalho || {};

      const itensRpc: Array<Record<string, unknown>> = [];
      const precosRpc: Array<Record<string, unknown>> = [];
      let subtotal = 0;
      for (const d of det) {
        const prod = d.produto || {};
        if (!prod.codigo_produto) continue;
        const qty = prod.quantidade || 1, price = prod.valor_unitario || 0, desc = prod.desconto || 0;
        subtotal += qty * price * (1 - desc / 100);
        const productId = productMap.get(prod.codigo_produto) || null;
        itensRpc.push({
          customer_user_id: pai.customer_user_id, product_id: productId,
          omie_codigo_produto: prod.codigo_produto,
          quantity: qty, unit_price: price, discount: desc,
          hash_payload: `${pai.hash_payload}_${prod.codigo_produto}`,
        });
        if (productId && price > 0) precosRpc.push({ customer_user_id: pai.customer_user_id, product_id: productId, unit_price: price });
      }
      if (itensRpc.length === 0) { semDados++; continue; } // Omie tb não tem item válido (limite L2)

      let status = 'importado';
      const etapa = cab.etapa || '';
      if (etapa === '60' || etapa === '70') status = 'faturado';
      else if (etapa === '50') status = 'separacao';
      else if (etapa === '20') status = 'enviado';
      else if (etapa === '80') status = 'cancelado';

      pedidosRpc.push({
        account, hash_payload: pai.hash_payload, omie_pedido_id: pid,
        customer_user_id: pai.customer_user_id, created_by: pai.created_by,
        total: Math.round(subtotal * 100) / 100, status, order_date_kpi: pai.order_date_kpi,
        itens: itensRpc, precos: precosRpc,
      });
    }

    if (pedidosRpc.length > 0) {
      const { data: r, error } = await supabase.rpc('criar_pedidos_com_itens', { p_pedidos: pedidosRpc });
      if (error) {
        falhas += pedidosRpc.length;
        console.error(`[reparar_orfaos][${account}] RPC falhou no lote ${i}:`, error.message);
      } else if (r) {
        const rr = r as { repaired?: number; items?: number; skipped_complete?: number; divergence?: unknown[]; failed?: unknown[] };
        reparados += rr.repaired || 0;
        itens += rr.items || 0;
        jaCompletos += rr.skipped_complete || 0;
        divergencias += (rr.divergence || []).length;
        falhas += (rr.failed || []).length;
        for (const d of (rr.divergence || [])) if (divergenciaAmostra.length < 20) divergenciaAmostra.push(d);
      }
    }
    console.log(`[reparar_orfaos][${account}] lote ${Math.floor(i / LOTE) + 1}: reparados=${reparados} itens=${itens} divergencias=${divergencias} falhas=${falhas} semDados=${semDados}`);
  }

  return { reparados, itens, divergencias, falhas, semDados, jaCompletos, total: pedidoIds.length, divergenciaAmostra };
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

// ── Guard money-path (espelha src/services/orderSubmission/priceGuard.ts —
// `isInvalidProductPrice`; Deno não importa de src/). Item de PRODUTO a preço ≤ 0 / NaN /
// Infinity NUNCA pode virar PV no Omie: valor zerado = pedido cobrado errado / prejuízo, e
// fica invisível ao cockpit de markup / Régua de Preço (que filtram preco > 0). Esta é a
// fronteira definitiva — cobre TODAS as vias num só ponto: envio do unified-order
// (submitOrder), conversão de orçamento (SalesQuotes) e edição de pedido (useSalesOrderEdit).
// Só trafegam produtos aqui (afiação tem fluxo próprio), logo não há R$0 legítimo.
// `typeof === "number"` endurece a borda: o payload é JSON cru, não confiável. ──
function isInvalidOmieItemPrice(valor: unknown): boolean {
  return !(typeof valor === "number" && Number.isFinite(valor) && valor > 0);
}

function assertOmieItemPricesValid(
  items: Array<{ valor_unitario?: number; descricao?: string; omie_codigo_produto?: number | string }>,
): void {
  const invalidos = items.filter((it) => isInvalidOmieItemPrice(it.valor_unitario));
  if (invalidos.length > 0) {
    const nomes = invalidos
      .map((it) => it.descricao || (it.omie_codigo_produto != null ? String(it.omie_codigo_produto) : "item sem nome"))
      .join(", ");
    throw new Error(
      `Pedido rejeitado (preço inválido): item(ns) de produto com preço R$ 0 ou negativo: ${nomes}. Corrija o preço antes de enviar ao Omie.`,
    );
  }
}

// ── Guard money-path (ATIVO) — par do assertOmieItemPricesValid acima. Produto desativado no
// Omie (omie_products.ativo=false) NUNCA pode virar/alterar PV: orçamento antigo carrega produto
// depois desativado, e ~50–75% do espelho está inativo. Espelha a semântica do gate de ativo do
// tint (#894): SÓ ativo===false bloqueia (coluna default true; ausente do espelho = desatualizado,
// NÃO desativação → libera, pra não travar venda legítima). Cobre conversão de orçamento + edição
// (vias que furam o preflight de ativo do #897, só no wizard); valida por omie_codigo_produto +
// account (a conversão só tem o código). Oráculo puro em src/services/orderSubmission/ativoGate.ts. ──
async function assertOmieItemsAtivos(
  supabase: SupabaseClient,
  items: Array<{ omie_codigo_produto?: number | string; descricao?: string }>,
  account: Account,
): Promise<void> {
  const codigos = Array.from(
    new Set((items ?? []).map((it) => Number(it?.omie_codigo_produto)).filter((c) => Number.isFinite(c))),
  );
  if (codigos.length === 0) return;
  const { data, error } = await supabase
    .from("omie_products")
    .select("omie_codigo_produto, ativo")
    .eq("account", account)
    .in("omie_codigo_produto", codigos);
  // Fail-closed: sem confirmar o status no espelho, não cria/altera PV (venda atrasada é recuperável;
  // PV de produto desativado, não).
  if (error) {
    throw new Error(`Pedido rejeitado: falha ao validar produtos ativos no Omie (${error.message}). Tente novamente.`);
  }
  const inativos = new Set<number>();
  for (const r of (data ?? []) as Array<{ omie_codigo_produto: number | string; ativo: boolean | null }>) {
    if (r.ativo === false) {
      const c = Number(r.omie_codigo_produto);
      if (Number.isFinite(c)) inativos.add(c);
    }
  }
  const vistos = new Set<number>();
  const bloqueados: string[] = [];
  for (const it of items) {
    const cod = Number(it?.omie_codigo_produto);
    if (!Number.isFinite(cod) || vistos.has(cod) || !inativos.has(cod)) continue;
    vistos.add(cod);
    bloqueados.push(it.descricao || String(cod));
  }
  if (bloqueados.length > 0) {
    throw new Error(
      `Pedido rejeitado (produto desativado no Omie): ${bloqueados.join(", ")}. Reative o produto no Omie ou remova-o do pedido.`,
    );
  }
}

// [2026-07-16] `codeBelongsToWrongAccount` (P0-A) foi REMOVIDO daqui — não restaure sem ler isto.
// Ele provava "conta errada" pelo rótulo `empresa_omie` do espelho `omie_clientes`, e o rótulo é
// DEFAULT POLUÍDO: 6909/6909 linhas da prod são 'colacor' (ZERO 'oben'), com código oben do bulk
// syncCustomers morando sob esse rótulo. Para account='oben' a prova positiva era estruturalmente
// falsa — `matchesTarget` nunca casava e QUALQUER código conhecido acusava. Barrou o PC 214820 com
// o código oben CORRETO. O design do P0-B (§4.3) já o dava como redundante: a divergência
// advisory×derivado em decideAccountIdentity é fail-closed e cobre o mesmo ataque com a âncora certa
// (documento + API Omie), sem depender de rótulo local. Invariante em edge-money-path-invariants.

// MIRROR-START omie derive-account-identity — espelhado verbatim em supabase/functions/omie-vendas-sync/index.ts
// Decisão de identidade Omie por conta (money-path P0-B). PURA: recebe dados já buscados (espelho local
// + matches da API Omie) e decide o código autoritativo OU fail-closed. Precisão>recall: ambiguidade,
// ausência confirmada, divergência com o código do payload, ou código não-representável = REJECT.
// A âncora (documento) e o I/O (buscar espelho/Omie, backfill) ficam no chamador; aqui só a decisão.
interface MirrorRow { omie_codigo_cliente: number; omie_codigo_vendedor: number | null; empresa_omie: string }
interface OmieMatch { codigo_cliente: number; codigo_vendedor: number | null }
interface DecideInput {
  account: string;
  /** Código que o cliente mandou no payload — ADVISORY (verificado contra o derivado). */
  suppliedCodigo: number | null;
  /** Linhas de omie_clientes dos users do documento (qualquer empresa). */
  mirrorRows: ReadonlyArray<MirrorRow>;
  /** buscarClienteVendas(registros_por_pagina:2) na conta; null = o chamador ainda não buscou. */
  omieMatches: ReadonlyArray<OmieMatch> | null;
}
type DecideResult =
  | { ok: true; source: 'mirror' | 'omie'; codigo_cliente: number; codigo_vendedor: number | null; backfill: boolean }
  | { ok: false; needOmie: true }
  | { ok: false; reason: 'ambiguous_mirror' | 'ambiguous_omie' | 'absent' | 'divergence' | 'unsafe_integer' };

// bigint-safe: compara como string decimal canônica (códigos Omie são bigint; Number perde precisão ≥ 2^53).
const sameCode = (a: number, b: number): boolean => String(a) === String(b);

function decideAccountIdentity(input: DecideInput): DecideResult {
  const { account, suppliedCodigo, mirrorRows, omieMatches } = input;

  // 1. Espelho, restrito à conta alvo (linhas de OUTRA conta são ignoradas — não acusam nem servem).
  const naConta = mirrorRows.filter((r) => r.empresa_omie === account);
  const distintos = [...new Map(naConta.map((r) => [String(r.omie_codigo_cliente), r])).values()];

  let cand: { codigo_cliente: number; codigo_vendedor: number | null; source: 'mirror' | 'omie'; backfill: boolean };

  if (distintos.length === 1) {
    cand = { codigo_cliente: distintos[0].omie_codigo_cliente, codigo_vendedor: distintos[0].omie_codigo_vendedor, source: 'mirror', backfill: false };
  } else if (distintos.length > 1) {
    return { ok: false, reason: 'ambiguous_mirror' };
  } else {
    // 0 no espelho → precisa da API Omie
    if (omieMatches === null) return { ok: false, needOmie: true };
    if (omieMatches.length > 1) return { ok: false, reason: 'ambiguous_omie' }; // duplicata-CNPJ — não chuta
    if (omieMatches.length === 0) return { ok: false, reason: 'absent' };
    cand = { codigo_cliente: omieMatches[0].codigo_cliente, codigo_vendedor: omieMatches[0].codigo_vendedor, source: 'omie', backfill: true };
  }

  // 2. Segurança de representação (bigint): código fora do range seguro não vai pro Omie.
  if (!Number.isSafeInteger(cand.codigo_cliente) || cand.codigo_cliente <= 0) return { ok: false, reason: 'unsafe_integer' };

  // 3. Divergência: o código do payload é advisory; se contradiz o derivado, fail-closed (não override).
  if (suppliedCodigo != null && !sameCode(suppliedCodigo, cand.codigo_cliente)) return { ok: false, reason: 'divergence' };

  return { ok: true, source: cand.source, codigo_cliente: cand.codigo_cliente, codigo_vendedor: cand.codigo_vendedor, backfill: cand.backfill };
}
// MIRROR-END

// [PR-1/A1] O fail-closed doc→user (doc com 2+ users FORA do mapa) migrou do TS para a RPC SQL
// omie_sync_identity_snapshot (snapshot atômico). O helper abaixo valida o CONTRATO da resposta.
// MIRROR-START omie identity-snapshot-parse — espelhado verbatim nos edges omie-vendas-sync e omie-analytics-sync
// Valida o CONTRATO JSON da RPC omie_sync_identity_snapshot e constrói os mapas. FAIL-CLOSED (Codex
// challenge PR-1): supabase-js .rpc() resolve {error} — error=null só prova HTTP/SQL bem-sucedido, NÃO o
// contrato. Uma RPC revertida/malformada pode devolver HTTP 200 com {doc_to_user:null,...}; o `?? {}` a
// degradaria para Map(0) SILENCIOSO (vendas pula pedidos, analytics não vincula) sem SQLSTATE. Aqui shape
// inválido (null/array/tipo errado/valor não-UUID/doc ambíguo vazado em doc_to_user) LANÇA — precisão>recall.
const OMIE_SNAPSHOT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseIdentitySnapshot(
  snap: unknown,
): { docToUserMap: Map<string, string>; ambiguousDocs: Set<string> } {
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
    throw new Error("identity snapshot: resposta não é objeto (fail-closed)");
  }
  const s = snap as Record<string, unknown>;
  const d2u = s.doc_to_user;
  const amb = s.ambiguous_docs;
  if (!d2u || typeof d2u !== "object" || Array.isArray(d2u)) {
    throw new Error("identity snapshot: doc_to_user ausente ou não-objeto (fail-closed)");
  }
  if (!Array.isArray(amb)) {
    throw new Error("identity snapshot: ambiguous_docs ausente ou não-array (fail-closed)");
  }
  const ambiguousDocs = new Set<string>();
  for (const doc of amb) {
    if (typeof doc !== "string") throw new Error("identity snapshot: ambiguous_docs com item não-string (fail-closed)");
    ambiguousDocs.add(doc);
  }
  const docToUserMap = new Map<string, string>();
  for (const [doc, user] of Object.entries(d2u)) {
    if (typeof user !== "string" || !OMIE_SNAPSHOT_UUID_RE.test(user)) {
      throw new Error("identity snapshot: user_id não-UUID em doc_to_user (fail-closed)");
    }
    // disjunção: um doc não pode estar em doc_to_user E em ambiguous_docs (seria fail-open da RPC)
    if (ambiguousDocs.has(doc)) {
      throw new Error("identity snapshot: doc presente em doc_to_user E ambiguous_docs — fail-open da RPC (fail-closed)");
    }
    docToUserMap.set(doc, user);
  }
  return { docToUserMap, ambiguousDocs };
}
// MIRROR-END

// Resolve os matches de cliente por documento na conta (registros_por_pagina:2 p/ detectar duplicata-CNPJ).
// throwOnTransient: erro Omie transitório LANÇA (ausência só como array vazio confirmado, nunca timeout).
async function buscarClienteVendasMatches(document: string, account: Account = "oben"): Promise<OmieMatch[]> {
  const documentClean = document.replace(/\D/g, "");
  const result = await callOmieVendasApi(
    "geral/clientes/",
    "ListarClientes",
    { pagina: 1, registros_por_pagina: 2, clientesFiltro: { cnpj_cpf: documentClean } },
    account,
    { throwOnTransient: true },
  );
  const arr = (result?.clientes_cadastro as OmieClienteCadastro[] | undefined) ?? [];
  return arr
    .filter((c) => c.codigo_cliente_omie)
    .map((c) => ({
      codigo_cliente: c.codigo_cliente_omie as number,
      codigo_vendedor: c.recomendacoes?.codigo_vendedor ?? c.codigo_vendedor ?? null,
    }));
}

// Deriva a identidade Omie AUTORITATIVA de (documento do pedido, conta) — money-path P0-B. Âncora = documento
// (imune ao fallback customer_user_id || user.id). Omie-por-doc → fail-closed. Sem espelho: ver o bloco
// abaixo (o rótulo local não prova conta e o backfill barrava PV legítimo).
async function deriveOmieAccountIdentity(
  supabase: SupabaseClient,
  soRow: { customer_user_id: string | null; customer_document: string | null; created_by: string | null },
  account: Account,
  suppliedCodigo: number | null,
): Promise<{ codigo_cliente: number; codigo_vendedor: number | null }> {
  const rawDoc = (soRow.customer_document || "").trim();
  let doc = rawDoc.replace(/\D/g, "");
  // Fallback p/ profiles.document SÓ quando customer_user_id é CONFIÁVEL (≠ created_by). O submit faz
  // customer_user_id = customerUserId || created_by → quando cai no created_by (staff sem cliente local),
  // derivar do doc do VENDEDOR rotearia o PV pro vendedor (Codex P1 #1). Sem doc confiável → fail-closed.
  if (!doc && soRow.customer_user_id && soRow.customer_user_id !== soRow.created_by) {
    const { data: prof } = await supabase.from("profiles").select("document").eq("user_id", soRow.customer_user_id).maybeSingle();
    doc = ((prof?.document as string | undefined) || "").trim().replace(/\D/g, "");
  }
  if (!doc) {
    throw new Error(`Pedido rejeitado: sem documento CONFIÁVEL do cliente para provar a identidade Omie na conta ${account} — envio bloqueado (não roteia pelo vendedor).`);
  }

  // [2026-07-16] Espelho `omie_clientes` FORA do caminho de PV — a leitura era morta e a escrita
  // bloqueava. Não religue sem antes re-rotular o espelho por conta (a "Fatia 3" nunca aconteceu):
  //  • LER era inútil: mirrorRows filtrava `empresa_omie = account`, e o rótulo é DEFAULT POLUÍDO —
  //    6909/6909 linhas da prod são 'colacor' (ZERO 'oben'/'colacor_sc'), e 'colacor' já era forçado
  //    a [] pelo BUG-1. O fast-path NUNCA casava em NENHUMA conta: a API Omie por documento sempre
  //    foi o caminho real. Remover não muda comportamento nem adiciona 1 chamada sequer.
  //  • ESCREVER bloqueava: o backfill upsertava sob `unique_user_omie UNIQUE(user_id)` — a constraint
  //    REAL da prod (o design §4.4 assumiu `(user_id, empresa)`, e o harness espelhou a suposição, por
  //    isso o teste nunca viu). Com a linha 'colacor' do user já presente, o INSERT 'oben' violava a
  //    UNIQUE → a RPC devolve 'contested' → este edge barrava um PV LEGÍTIMO (2º bloqueio, em série
  //    com o P0-A; ambos atingiram o PC 214820). Auto-cura do espelho é trabalho do sync diário, não
  //    do caminho de dinheiro — e a proof-table account-correta é `omie_customer_account_map`.
  // Sobra UMA fonte autoritativa: documento (âncora) + API Omie, com divergência advisory×derivado,
  // ambiguidade, ausência e bigint fora de range todos fail-closed em decideAccountIdentity.
  const omieMatches = await buscarClienteVendasMatches(doc, account);
  const decision = decideAccountIdentity({ account, suppliedCodigo, mirrorRows: [], omieMatches });
  if (!decision.ok) {
    const reason = "reason" in decision ? decision.reason : "unknown";
    throw new Error(`Pedido rejeitado: identidade Omie do cliente na conta ${account} não pôde ser provada (${reason}) — envio bloqueado para não registrar no cliente errado.`);
  }
  return { codigo_cliente: decision.codigo_cliente, codigo_vendedor: decision.codigo_vendedor };
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
  ordemCompra?: string,
  // Pedidos programados (Lider): mensagem fixa + nº do PC nas informações
  // complementares da NF e no campo dedicado "Nº do Pedido do Cliente".
  dadosAdicionaisNf?: string,
  numeroPedidoCliente?: string
) {
  // Determinístico (espelha src/lib/omie/pedido-integration-code.ts): re-enviar o mesmo
  // sales_order_id gera a MESMA chave → o Omie rejeita a duplicata (idempotência).
  const cCodIntPed = `PV_${salesOrderId}`;
  // Espelha src/lib/omie/pedido-duplicate.ts (callOmieVendasApi LANÇA em fault).
  const isOmieDuplicatePedido = (e: unknown): boolean => {
    const m = (e instanceof Error ? e.message : typeof e === 'string' ? e : '').toLowerCase();
    return !!m && (m.includes('já cadastrad') || m.includes('ja cadastrad') || (m.includes('integra') && m.includes('cadastrad')));
  };
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

  if (dadosAdicionaisNf) {
    informacoes_adicionais.dados_adicionais_nf = dadosAdicionaisNf;
  }
  if (numeroPedidoCliente) {
    informacoes_adicionais.numero_pedido_cliente = numeroPedidoCliente;
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

  let omie_pedido_id: number | null;
  let omie_numero_pedido: string | number;
  let omie_response: unknown = null;
  try {
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
    const codPed = result.codigo_pedido as number | undefined;
    if (typeof codPed !== "number" || codPed <= 0) {
      // P1-1: Omie respondeu "ok" mas SEM número → NÃO escrever 'enviado' (senão o retry
      // acha omie_pedido_id=null, reusa e reenvia). Lançar → o retry tenta de novo
      // (e a chave determinística + dedup do Omie reconciliam se o pedido já existir).
      throw new Error(`Omie (${account}) retornou sucesso sem codigo_pedido válido (${JSON.stringify(result?.codigo_pedido)}).`);
    }
    omie_pedido_id = codPed;
    omie_numero_pedido = (result.numero_pedido as string | number | undefined) || cCodIntPed;
    omie_response = result;
  } catch (e) {
    // Reconciliação (idempotência): se a chave determinística já existe no Omie (tentativa
    // anterior criou o pedido mas o write-back falhou), consultar e vincular em vez de falhar.
    if (!isOmieDuplicatePedido(e)) throw e;
    const consulta = await callOmieVendasApi(
      "produtos/pedido/", "ConsultarPedido", { codigo_pedido_integracao: cCodIntPed }, account,
    ) as {
      pedido_venda_produto?: { cabecalho?: { codigo_pedido?: number; numero_pedido?: string | number } };
      cabecalho?: { codigo_pedido?: number; numero_pedido?: string | number };
    } | null;
    const cab = consulta?.pedido_venda_produto?.cabecalho ?? consulta?.cabecalho;
    if (!cab?.codigo_pedido) {
      throw new Error(`Omie (${account}) reportou pedido duplicado mas ConsultarPedido(${cCodIntPed}) não retornou o pedido — reconciliação falhou.`);
    }
    omie_pedido_id = cab.codigo_pedido;
    omie_numero_pedido = cab.numero_pedido ?? cab.codigo_pedido;
    omie_response = { reconciled: true, consulta };
  }

  // Write-back COM erro checado E exigindo EXATAMENTE 1 linha (P1-2: o PostgREST devolve
  // error:null mesmo atualizando 0 linhas → deixaria pedido órfão no Omie com "sucesso").
  // Casa por id + account.
  const { data: wbRows, error: wbError } = await supabase
    .from("sales_orders")
    .update({
      omie_pedido_id,
      omie_numero_pedido: String(omie_numero_pedido),
      omie_payload: payload,
      omie_response,
      status: "enviado",
    })
    .eq("id", salesOrderId)
    .eq("account", account)
    .select("id");
  if (wbError) {
    // Qualquer erro de DB no write-back DEPOIS do pedido existir no Omie = linha potencialmente
    // órfã → surfaça (NÃO engolir). (Não há UNIQUE(account, omie_pedido_id): push+pull gravam o
    // mesmo omie_pedido_id em linhas distintas por design — ver a migração 20260613120000.)
    throw new Error(`Pedido no Omie (${omie_pedido_id}) mas o write-back em sales_orders falhou: ${wbError.message}.`);
  }
  if (!wbRows || wbRows.length !== 1) {
    throw new Error(`Pedido no Omie (${omie_pedido_id}) mas o write-back não casou exatamente 1 linha (id=${salesOrderId}, account=${account}) — linha órfã, investigar.`);
  }

  return { omie_pedido_id, omie_numero_pedido };
}

// ─── Observabilidade do sync em fin_sync_log (best-effort) ───
// ── Trava de crédito Fase 2 — gate na fronteira comum (TODAS as vias de pedido
// passam por aqui). Spec + veredito Codex: docs/superpowers/specs/trava-credito-fase2.md
// Prova PG17 da RPC: db/test-trava-credito-fase2.sh. Regras:
//  - bloqueia só com EVIDÊNCIA POSITIVA (vencido 60+ na conta do pedido, sem exceção do pedido);
//  - fail-open em indisponibilidade SÓ depois de log durável (log falhou → erro, não allow cego);
//  - toda decisão relevante vira linha em venda_bloqueio_credito_log (medição da fase).
interface GateCreditoResultado {
  bloqueado: boolean;
  vencido: number | null;
  titulos: number;
  vencimento_mais_antigo: string | null;
  excecao_id: string | null;
  motivo: string;
}

async function gateCredito(
  supabase: SupabaseClient,
  company: Account,
  codigo: number | null,
  salesOrderId: string,
  userId: string | null,
  contexto: "criacao" | "edicao",
): Promise<{ permitido: true } | { permitido: false; gate: GateCreditoResultado }> {
  let gate: GateCreditoResultado;
  try {
    const { data, error } = await supabase.rpc("venda_gate_credito", {
      p_company: company,
      p_codigo: codigo,
      p_sales_order_id: salesOrderId,
    });
    if (error) throw new Error(error.message);
    gate = data as GateCreditoResultado;
  } catch (rpcErr) {
    const msg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);
    const { error: logErr } = await supabase.from("venda_bloqueio_credito_log").insert({
      company,
      omie_codigo_cliente: codigo,
      sales_order_id: salesOrderId,
      acao: "gate_indisponivel",
      user_id: userId,
      detalhe: `${contexto}: ${msg}`.slice(0, 500),
    });
    if (logErr) {
      // Nem o log gravou → infraestrutura degradada; allow cego seria invisível.
      throw new Error(`Gate de crédito indisponível e sem log (${logErr.message}) — tente novamente.`);
    }
    console.warn(`[gate-credito][${company}] indisponível (${contexto}): ${msg} — liberado COM log`);
    return { permitido: true };
  }

  if (!gate.bloqueado) {
    if (gate.excecao_id) {
      // Liberação por exceção é auditada (best-effort: falha de auditoria de sucesso não trava venda).
      const { error: logErr } = await supabase.from("venda_bloqueio_credito_log").insert({
        company,
        omie_codigo_cliente: codigo,
        sales_order_id: salesOrderId,
        acao: "liberado_excecao",
        vencido: gate.vencido,
        titulos: gate.titulos,
        user_id: userId,
        excecao_id: gate.excecao_id,
      });
      if (logErr) console.warn(`[gate-credito] log liberado_excecao falhou: ${logErr.message}`);
    }
    return { permitido: true };
  }

  const { error: logErr } = await supabase.from("venda_bloqueio_credito_log").insert({
    company,
    omie_codigo_cliente: codigo,
    sales_order_id: salesOrderId,
    acao: contexto === "edicao" ? "bloqueado_edicao" : "bloqueado",
    vencido: gate.vencido,
    titulos: gate.titulos,
    user_id: userId,
  });
  if (logErr) {
    // (a) Log de bloqueio DURÁVEL — simétrico ao ramo gate_indisponivel acima. A aprovação
    // REMOTA do gestor (SalesOrderDetailSheet → useBloqueioCreditoLog) resolve o contexto do
    // form pelo ÚLTIMO log do pedido; um bloqueio sem rastro deixaria o gestor SEM form
    // (exceção às cegas não). Se nem o log grava = infra degradada → ERRO, nunca devolver
    // {blocked:'credito'} silencioso e irrastreável. O caller (submitOrder) reexecuta — o
    // gate é STABLE/idempotente e reprova o mesmo bloqueio (com log, na retentativa saudável).
    throw new Error(`Bloqueio de crédito sem log durável (${logErr.message}) — tente novamente.`);
  }
  return { permitido: false, gate };
}

// ── Gate tintométrico Fase 3 — revalidação de preço na fronteira comum ──
// TODA via de pedido (submit, conversão de orçamento, edição, retry) cruza
// criar_pedido/alterar_pedido; o guard do preço tint mora AQUI, não na UI
// (money-path §5). A RPC tint_gate_revalida (provada em db/test-tint-gate-
// revalida.sh) revalida cada item COM tint_cor_id contra o estado ATUAL:
// canônica viva + preço recomputado + fonte declarada pela vendedora.
// ⚠️ FAIL-CLOSED na indisponibilidade — deliberadamente ≠ gateCredito (que é
// fail-open com log durável): (a) o blast radius é só pedido COM item tint
// (o caminho comum nem chama a RPC); (b) o risco real aqui é a migration
// custom NÃO aplicada no Lovable (falha silenciosa clássica) — fail-open
// criaria um gate fantasma invisível; fail-closed grita na primeira venda.
interface GateTintResultado {
  ok: boolean;
  bloqueios: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
}

async function gateTintPreco(
  supabase: SupabaseClient,
  account: Account,
  customerUserId: string | null,
  salesOrderId: string,
  contexto: "criacao" | "edicao",
  items: Array<{ tint_cor_id?: string; omie_codigo_produto?: number | string }>,
): Promise<{ permitido: true } | { permitido: false; bloqueios: Array<Record<string, unknown>> }> {
  if (items.length === 0) return { permitido: true };

  // Classificação em BATCH antes da RPC (Codex P1 do diff): a RPC só roda
  // quando há marcador tint, produto classificado como BASE tintométrica ou
  // código ilegível (que a RPC bloqueia como payload_invalido). Assim uma
  // migration ausente/RPC indisponível NÃO derruba venda comum — o blast
  // radius do fail-closed fica restrito a pedido com cara de tint. A
  // classificação lê omie_products (tabela pré-existente — funciona mesmo
  // sem a migration da Fase 3).
  const temMarcador = items.some((i) => typeof i.tint_cor_id === "string" && i.tint_cor_id.length > 0);
  const codigos = [...new Set(items.map((i) => Number(i.omie_codigo_produto)).filter((n) => Number.isFinite(n) && n > 0))];
  const temCodigoIlegivel = items.some((i) => !Number.isFinite(Number(i.omie_codigo_produto)) || Number(i.omie_codigo_produto) <= 0);
  let temBaseTint = false;
  if (!temMarcador && !temCodigoIlegivel && codigos.length > 0) {
    const { data: prods, error: clsErr } = await supabase
      .from("omie_products")
      .select("omie_codigo_produto, is_tintometric, tint_type")
      .eq("account", account)
      .in("omie_codigo_produto", codigos);
    if (clsErr) {
      // classificação indisponível = não sei se há base tint ⇒ fail-closed
      // (mesma infra da RPC; se isto falhou, nada do pedido funcionaria)
      throw new Error(`Classificação tintométrica indisponível (${clsErr.message}) — pedido não enviado (fail-closed).`);
    }
    temBaseTint = (prods ?? []).some(
      (p) => (p as { is_tintometric?: boolean; tint_type?: string | null }).is_tintometric === true &&
        (p as { tint_type?: string | null }).tint_type === "base",
    );
  }
  if (!temMarcador && !temBaseTint && !temCodigoIlegivel) return { permitido: true };

  const { data, error } = await supabase.rpc("tint_gate_revalida", {
    p_account: account,
    p_customer_user_id: customerUserId,
    p_sales_order_id: salesOrderId,
    p_contexto: contexto,
    p_items: items,
  });
  if (error) {
    throw new Error(
      `Gate tintométrico indisponível (${error.message}) — pedido com item de tinta NÃO enviado (fail-closed). ` +
        `Confira se a migration 20260722100001_tint_gate_revalida_submit foi aplicada.`,
    );
  }
  const r = data as GateTintResultado | null;
  if (!r || typeof r.ok !== "boolean") {
    throw new Error("Gate tintométrico devolveu resposta inválida — pedido NÃO enviado (fail-closed).");
  }
  if (!r.ok) {
    console.warn(`[gate-tint][${account}] pedido bloqueado:`, JSON.stringify(r.bloqueios));
    return { permitido: false, bloqueios: r.bloqueios };
  }
  if (r.warnings && r.warnings.length > 0) {
    console.log(`[gate-tint][${account}] warnings:`, JSON.stringify(r.warnings));
  }
  return { permitido: true };
}

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

// ─── Cursor + lease do BACKFILL de pedidos (tabela vendas_sync_cursor) ───
// Espelha o state-machine SQL da migration 20260617133633 (lease_acquire/heartbeat/
// finish — SECURITY DEFINER gated a service_role). `omieDateToIso` (DD/MM/YYYY → ISO,
// PK date) vem de ./pagination.ts (puro/testado).
// O lease atômico tem que ser RPC: `.or()` em UPDATE do PostgREST quebra (42703, CLAUDE.md).

// Tenta tomar o lease ATOMICAMENTE. Retorna a página de retomada, ou null se NÃO
// conseguiu (outra invocação viva / janela completa / inexistente / RPC ausente)
// ⟹ o caller sai no-op. Degradação segura: sem a migration aplicada, é sempre no-op.
async function acquireVendasLease(
  db: SupabaseClient, account: Account, dfIso: string, dtIso: string,
): Promise<number | null> {
  const { data, error } = await db.rpc('vendas_sync_lease_acquire', {
    p_account: account, p_date_from: dfIso, p_date_to: dtIso,
  });
  if (error) {
    console.error(`[sync_pedidos][${account}] lease_acquire falhou (no-op):`, error.message);
    return null;
  }
  return typeof data === 'number' ? data : null;
}

// Renova o lease por página (best-effort: uma falha de heartbeat não derruba o sync).
// supabase-js .rpc() NÃO lança em erro de RPC — resolve {error} (Codex). Por isso
// checamos `error` (try/catch não pegaria), pra ao menos LOGAR um heartbeat negado.
// Renova o lease E persiste o progresso: next_page := a página EM CURSO (`page`).
// Assim um crash retoma da página em curso (re-faz ≤1 página, idempotente), nunca o run.
async function heartbeatVendasCursor(
  db: SupabaseClient, account: Account, dfIso: string, dtIso: string, page: number,
): Promise<void> {
  const { error } = await db.rpc('vendas_sync_heartbeat', { p_account: account, p_date_from: dfIso, p_date_to: dtIso, p_page: page });
  if (error) console.warn(`[sync_pedidos][${account}] heartbeat falhou (segue):`, error.message);
}

// Encerra e LIBERA o lease. complete=true ⟹ fecha completed_at (fim real); false ⟹
// pausa (retoma do nextPage, grava last_error_kind). A RPC zera running_since sempre.
async function finishVendasCursor(
  db: SupabaseClient, account: Account, dfIso: string, dtIso: string,
  complete: boolean, nextPage: number | null, lastErrorKind: string | null,
): Promise<void> {
  const { error } = await db.rpc('vendas_sync_finish', {
    p_account: account, p_date_from: dfIso, p_date_to: dtIso,
    p_complete: complete,
    p_next_page: complete ? null : nextPage,
    p_last_error_kind: complete ? null : lastErrorKind,
  });
  if (error) console.error(`[sync_pedidos][${account}] finish falhou:`, error.message);
}

// LIBERA o lease preservando o next_page (o progresso que o heartbeat persistiu). Para
// o erro INESPERADO escapado do syncPedidos: solta o lease + grava o kind sem rebobinar.
async function releaseVendasCursor(
  db: SupabaseClient, account: Account, dfIso: string, dtIso: string, lastErrorKind: string,
): Promise<void> {
  const { error } = await db.rpc('vendas_sync_release', {
    p_account: account, p_date_from: dfIso, p_date_to: dtIso, p_last_error_kind: lastErrorKind,
  });
  if (error) console.error(`[sync_pedidos][${account}] release falhou:`, error.message);
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
        // Estrito: transient esgotado vira ERRO da action (o invoke do client
        // rejeita → o tri-state marca lookupFalhou e NÃO cria às cegas) em vez
        // de 200 com null, que o client lia como "não existe".
        const cliente = await buscarClienteVendas(document, account, { throwOnTransient: true });
        result = { success: true, cliente };
        break;
      }

      case "criar_cliente": {
        const { document: docCriar, razao_social, nome_fantasia, endereco, endereco_numero, bairro, cidade, estado, cep, telefone, contato } = params;
        if (!docCriar || !razao_social) throw new Error("Documento e razão social são obrigatórios");
        const docClean = String(docCriar).replace(/\D/g, "");
        // Lookup anti-duplicação ESTRITO (retroativo Codex): com o null
        // ambíguo, um flake do Omie pós-retries era lido como "não existe" e
        // o IncluirCliente abaixo criava DUPLICATA no ERP. Transient → throw
        // → a action falha honesta e o client não cria.
        const existingCliente = await buscarClienteVendas(docCriar, account, { throwOnTransient: true });
        if (existingCliente) {
          result = { success: true, ...existingCliente, created: false };
          break;
        }
        // Create the client. Chave de integração DETERMINÍSTICA por
        // conta+documento (era Date.now()): se dois caminhos tentarem criar o
        // mesmo cliente, o Omie rejeita a 2ª por integração duplicada
        // ("já cadastrado") em vez de aceitar uma duplicata.
        const clienteParams: Record<string, unknown> = {
          codigo_cliente_integracao: `APP_${account.toUpperCase()}_${docClean}`,
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
        const { sales_order_id, codigo_cliente, codigo_vendedor, items, observacao, codigo_parcela, quantidade_volumes, ordem_compra, dados_adicionais_nf, numero_pedido_cliente } = params;
        // codigo_cliente é ADVISORY (o edge deriva o autoritativo do documento). convertToOrder nem manda.
        if (!sales_order_id || !items?.length) {
          throw new Error("Dados insuficientes para criar pedido de venda");
        }
        // Guard money-path: rejeita ANTES de montar o payload Omie (ver assertOmieItemPricesValid).
        assertOmieItemPricesValid(items);
        await assertOmieItemsAtivos(supabaseAdmin, items, account);
        // Anti-downgrade de conta (veredito Codex): account desconhecido normaliza
        // silenciosamente pra 'oben' — o pedido local é a âncora server-side.
        const { data: soRow } = await supabaseAdmin
          .from("sales_orders")
          .select("account, customer_user_id, customer_document, created_by")
          .eq("id", sales_order_id)
          .maybeSingle();
        if (soRow?.account && soRow.account !== account) {
          throw new Error(
            `Conta do payload (${account}) diverge do pedido local (${soRow.account}) — pedido não enviado`,
          );
        }
        // [2026-07-16] O guard de coerência conta×código (P0-A) saiu daqui: ele lia o rótulo
        // `empresa_omie` do espelho `omie_clientes`, que é default poluído (ver o tombstone acima),
        // e barrava pedido oben LEGÍTIMO por prova positiva falsa. A cobertura real do cross-conta
        // é a derivação abaixo: âncora no DOCUMENTO + API Omie, com divergência advisory×derivado
        // fail-closed — o mesmo ataque, provado pela fonte certa.
        // P0-B: identidade Omie AUTORITATIVA derivada do DOCUMENTO do pedido (prova positiva). Fecha o gap
        // do guard acima (código de OUTRO user passava) e destrava a conversão oben. codigo_cliente do
        // payload é advisory; fail-closed em ambiguidade/ausência/divergência/contested. USA o derivado.
        const ident = await deriveOmieAccountIdentity(
          supabaseAdmin,
          {
            customer_user_id: soRow?.customer_user_id ?? null,
            customer_document: (soRow as { customer_document?: string | null } | null)?.customer_document ?? null,
            created_by: (soRow as { created_by?: string | null } | null)?.created_by ?? null,
          },
          account,
          codigo_cliente != null ? Number(codigo_cliente) : null,
        );
        // Trava de crédito Fase 2: bloqueia cliente com vencido 60+ sem exceção DESTE pedido.
        const credito = await gateCredito(
          supabaseAdmin,
          account,
          ident.codigo_cliente,
          sales_order_id,
          userId,
          "criacao",
        );
        if (!credito.permitido) {
          result = { success: false, blocked: "credito", gate: credito.gate };
          break;
        }
        // Gate tintométrico Fase 3: revalida preço/fórmula dos itens tint contra
        // o estado ATUAL, IMEDIATAMENTE antes da mutação Omie (janela TOCTOU
        // mínima — veredito Codex). Bloqueio = 200 estruturado, pedido local
        // intacto p/ retry após reprecificar no balcão.
        const gateTint = await gateTintPreco(
          supabaseAdmin,
          account,
          soRow?.customer_user_id ?? null,
          sales_order_id,
          "criacao",
          items as Array<{ tint_cor_id?: string }>,
        );
        if (!gateTint.permitido) {
          result = { success: false, blocked: "tint_preco", bloqueios: gateTint.bloqueios };
          break;
        }
        const pedido = await criarPedidoVenda(
          supabaseAdmin,
          sales_order_id,
          ident.codigo_cliente,
          ident.codigo_vendedor,
          items,
          observacao,
          codigo_parcela,
          account,
          quantidade_volumes,
          ordem_compra,
          dados_adicionais_nf,
          numero_pedido_cliente
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
        // Guard money-path: rejeita ANTES de consultar/excluir itens no Omie (passo destrutivo).
        assertOmieItemPricesValid(editItems);

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

        // Guard money-path (ativo): aqui, após resolver editAccount e ANTES de consultar/excluir
        // itens no Omie (passo destrutivo). O caminho de edição re-envia itens pré-existentes sem
        // revalidar — é onde um produto desativado depois da criação do PV passaria batido.
        await assertOmieItemsAtivos(supabaseAdmin, editItems, editAccount);

        // Gate tintométrico Fase 3: a edição re-envia TODOS os itens ao Omie.
        // Revalida ANTES do delete+add destrutivo, contra o BASELINE persistido
        // (o front só persiste APÓS o sucesso — o baseline é o estado pré-
        // edição): item tint IDÊNTICO passa com warning (já está no Omie);
        // novo/alterado revalida; base-sem-cor só passa intocada (inbound).
        const gateTintEdit = await gateTintPreco(
          supabaseAdmin,
          editAccount,
          (existingOrder as { customer_user_id?: string | null }).customer_user_id ?? null,
          editSoId,
          "edicao",
          editItems as Array<{ tint_cor_id?: string }>,
        );
        if (!gateTintEdit.permitido) {
          result = { success: false, blocked: "tint_preco", contexto: "edicao", bloqueios: gateTintEdit.bloqueios };
          break;
        }

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
          ...(item.tint_cor_id
            ? {
                tint_cor_id: item.tint_cor_id,
                tint_nome_cor: item.tint_nome_cor,
                // Fase 3: preservar auditoria de precificação no jsonb local
                ...(item.tint_formula_id ? { tint_formula_id: item.tint_formula_id } : {}),
                ...(item.tint_price_source ? { tint_price_source: item.tint_price_source } : {}),
                ...(typeof item.tint_discount_pct === "number" ? { tint_discount_pct: item.tint_discount_pct } : {}),
                ...(typeof item.tint_preco_sem_desconto === "number"
                  ? { tint_preco_sem_desconto: item.tint_preco_sem_desconto }
                  : {}),
              }
            : {}),
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
        let consultEditOk = false;
        let omieCodigoClienteEdit: number | null = null;
        try {
          const consultResult = (await callOmieVendasApi(
            "produtos/pedido/",
            "ConsultarPedido",
            { codigo_pedido: codigoPedido },
            editAccount
          )) as {
            pedido_venda_produto?: { det?: OmieDetalheItem[]; cabecalho?: { codigo_cliente?: number } };
            det?: OmieDetalheItem[];
            cabecalho?: { codigo_cliente?: number };
          } | null;
          // Omie returns items under pedido_venda_produto.det
          omieCurrentItems = consultResult?.pedido_venda_produto?.det
            || consultResult?.det
            || [];
          consultEditOk = true;
          // Cabeçalho sofre o MESMO drift de shape do det (aninhado ou no topo).
          omieCodigoClienteEdit =
            Number(consultResult?.pedido_venda_produto?.cabecalho?.codigo_cliente) ||
            Number(consultResult?.cabecalho?.codigo_cliente) ||
            null;
          console.log(`[Omie Vendas][${editAccount}] Pedido consultado: ${omieCurrentItems.length} itens no Omie`);
        } catch (consultErr) {
          const msg = consultErr instanceof Error ? consultErr.message : String(consultErr);
          console.warn(`[Omie Vendas][${editAccount}] Erro ao consultar pedido: ${msg}`);
        }

        // Guard anti-duplicação [P1+P2 Codex 2026-07-04]: a edição é DESTRUTIVA — o Step 2 apaga
        // TODOS os itens que o ConsultarPedido revelou e o Step 3 re-inclui a lista nova. Ela
        // ASSUME que `omieCurrentItems` reflete o pedido real E que cada item é deletável. Três
        // formas de o estado ser NÃO confiável, todas levando a DUPLICAÇÃO no Omie (dobra o valor
        // faturado) se seguíssemos para o delete+add:
        //   (1) consult FALHOU (rate-limit/transiente → catch acima): lista `[]`, o delete não acha
        //       nada e os novos entram por cima dos antigos;
        //   (2) consult voltou SEM itens (shape drift): idem — e um PV existente sempre tem ≥1
        //       item, então lista vazia aqui já é sinal de estado não confiável;
        //   (3) [P2 Codex] algum item atual SEM identificador deletável (ide.codigo_item /
        //       codigo_item_integracao): o Step 2 o PULA em silêncio e o Step 3 inclui os novos →
        //       duplicação PARCIAL (a validação final pegaria, mas só DEPOIS da mutação).
        // Qualquer uma → ABORTAR antes de qualquer mutação. Fail-closed OBSERVÁVEL (log durável +
        // erro; o transiente do Omie passa no reenvio). NÃO é o gate de crédito: é integridade da
        // edição destrutiva (antes, o ramo `else` fazia fail-open e SEGUIA — a duplicação).
        const itemSemIdDeletavel = omieCurrentItems.some(
          (oi) => !oi?.ide?.codigo_item && !oi?.ide?.codigo_item_integracao,
        );
        if (!consultEditOk || omieCurrentItems.length === 0 || itemSemIdDeletavel) {
          const { error: logErr } = await supabaseAdmin.from("venda_bloqueio_credito_log").insert({
            company: editAccount,
            omie_codigo_cliente: omieCodigoClienteEdit,
            sales_order_id: editSoId,
            acao: "gate_indisponivel",
            user_id: userId,
            detalhe: !consultEditOk
              ? "edicao: ConsultarPedido falhou — itens atuais desconhecidos, edição abortada (anti-duplicação)"
              : omieCurrentItems.length === 0
                ? "edicao: ConsultarPedido sem itens — estado do Omie não confiável, edição abortada (anti-duplicação)"
                : "edicao: item atual sem identificador deletável — delete+add duplicaria, edição abortada (anti-duplicação)",
          });
          if (logErr) {
            throw new Error(`Edição não aplicada e sem log durável (${logErr.message}) — tente novamente.`);
          }
          throw new Error(
            "Edição não aplicada: não foi possível confirmar com segurança os itens atuais do pedido no Omie. Nada foi alterado — tente novamente.",
          );
        }

        // P0-B: verify-before-edit (princípio 5) — a edição destrutiva pode mutar um PV historicamente
        // mal-atribuído. SÓ verifica com ÂNCORA CONFIÁVEL (customer_document presente): pedidos LEGADOS
        // (customer_document NULL, customer_user_id podendo ser o vendedor) derivariam do vendedor/ausente
        // → divergência → fail-closariam uma edição LEGÍTIMA (Codex P1 #4). Sem âncora, pula (a edição não
        // troca o cliente do PV; barrar toda edição legada é pior que o risco raro de PV mal-atribuído).
        const editDoc = ((existingOrder as { customer_document?: string | null }).customer_document || "").trim();
        if (omieCodigoClienteEdit !== null && editDoc.length > 0) {
          await deriveOmieAccountIdentity(
            supabaseAdmin,
            {
              customer_user_id: (existingOrder as { customer_user_id?: string | null }).customer_user_id ?? null,
              customer_document: editDoc,
              created_by: (existingOrder as { created_by?: string | null }).created_by ?? null,
            },
            editAccount,
            omieCodigoClienteEdit,
          );
        }

        // Trava de crédito Fase 2 na EDIÇÃO — sobre estado CONFIÁVEL (consult ok + itens provados),
        // antes da fase destrutiva. Só bloqueia AUMENTO de exposição: total atual provado pelo
        // ConsultarPedido do Omie (nunca client/DB local — veredito Codex); reduzir dívida sempre pode.
        const totalAtualOmie = omieCurrentItems.reduce(
          (s, oi) =>
            s + (Number(oi?.produto?.quantidade) || 0) * (Number(oi?.produto?.valor_unitario) || 0),
          0,
        );
        if (updatedSubtotal > totalAtualOmie) {
          if (omieCodigoClienteEdit === null) {
            // Aumento PROVADO mas consult veio sem codigo_cliente — gate(null) responderia
            // 'sem_codigo' e liberaria por AUSÊNCIA de dado. Fail-open do CRÉDITO (os itens já
            // são confiáveis pelo guard acima; só o gate é pulado) — allow SÓ com log durável.
            const { error: logErr } = await supabaseAdmin.from("venda_bloqueio_credito_log").insert({
              company: editAccount,
              omie_codigo_cliente: null,
              sales_order_id: editSoId,
              acao: "gate_indisponivel",
              user_id: userId,
              detalhe: "edicao: aumento provado, mas ConsultarPedido sem codigo_cliente — gate não avaliável",
            });
            if (logErr) {
              throw new Error(
                `Gate de crédito sem cliente identificado na edição e sem log (${logErr.message}) — tente novamente.`,
              );
            }
          } else {
            const creditoEdit = await gateCredito(
              supabaseAdmin,
              editAccount,
              omieCodigoClienteEdit,
              editSoId,
              userId,
              "edicao",
            );
            if (!creditoEdit.permitido) {
              result = { success: false, blocked: "credito", contexto: "edicao", gate: creditoEdit.gate };
              break;
            }
          }
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

        // Write-back local CHECADO (Codex P1 do diff): o front agora depende
        // EXCLUSIVAMENTE deste update (não persiste antes do gate — o baseline
        // é sagrado). Erro/0-linhas aqui com o Omie JÁ mutado = estado
        // divergente → devolver ERRO explícito (nunca success), para o caller
        // avisar e ninguém re-salvar por cima sem recarregar.
        const { data: editWb, error: editWbErr } = await supabaseAdmin
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
          .eq("id", editSoId)
          .select("id");
        if (editWbErr || !editWb || editWb.length !== 1) {
          throw new Error(
            `Omie ATUALIZADO (${editItems.length} itens) mas o registro local falhou ` +
              `(${editWbErr?.message ?? `${editWb?.length ?? 0} linhas`}) — NÃO re-salve sem recarregar o pedido; ` +
              `o Omie está com a versão nova e o app com a antiga.`,
          );
        }

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
        const maxPagesPedidos = Number(params.max_pages) || 10;
        const dateFrom = params.date_from || undefined; // DD/MM/YYYY
        const dateTo = params.date_to || undefined;     // DD/MM/YYYY

        // Modo BACKFILL (cursor + lease) — o cron de continuação */6 passa use_cursor:true.
        if (params.use_cursor === true) {
          if (!dateFrom || !dateTo) throw new Error("use_cursor exige date_from e date_to");
          const dfIso = omieDateToIso(dateFrom);
          const dtIso = omieDateToIso(dateTo);
          if (!dfIso || !dtIso) throw new Error(`Datas inválidas (esperado DD/MM/YYYY): ${dateFrom}..${dateTo}`);

          // Lease atômico: serialização REAL (não intervalo de cron). 0 linhas = outra
          // invocação viva / janela já completa → sai no-op (não processa).
          const resumePage = await acquireVendasLease(supabaseAdmin, account, dfIso, dtIso);
          if (resumePage == null) {
            result = { success: true, skipped: "lease_nao_adquirido", account, date_from: dateFrom, date_to: dateTo };
            break;
          }
          try {
            const r = await syncPedidos(supabaseAdmin, resumePage, maxPagesPedidos, account, dateFrom, dateTo, { df: dfIso, dt: dtIso });
            // Fecha o cursor: completo (fim real) OU pausa (budget/transitório/erro Omie).
            await finishVendasCursor(supabaseAdmin, account, dfIso, dtIso, r.complete, r.nextPage, r.lastErrorKind);
            result = { success: true, use_cursor: true, resume_page: resumePage, ...r };
          } catch (e) {
            // Erro inesperado (DB/bug) escapou do syncPedidos: LIBERA o lease preservando
            // o next_page que o heartbeat persistiu (retoma da página EM CURSO, re-faz ≤1
            // página idempotente — NÃO o run inteiro, achado Codex). Propaga p/ visibilidade.
            await releaseVendasCursor(supabaseAdmin, account, dfIso, dtIso, "error");
            throw e;
          }
          break;
        }

        // Modo INCREMENTAL (rolante, sem cursor) — inalterado: cron 2h, start_page=1, janela today-5..today.
        const startPagePedidos = params.start_page || 1;
        const syncPedidosResult = await syncPedidos(supabaseAdmin, startPagePedidos, maxPagesPedidos, account, dateFrom, dateTo);
        result = { success: true, ...syncPedidosResult };
        break;
      }

      case "reparar_orfaos_itens": {
        // Reparo dos órfãos PRESOS (pai sem itens, fora da janela do cron). A lista de
        // omie_pedido_id é calculada via psql-ro (read-only) e passada em pedido_ids.
        const pedidoIdsReparo = Array.isArray(params.pedido_ids) ? (params.pedido_ids as number[]) : [];
        if (pedidoIdsReparo.length === 0) throw new Error("reparar_orfaos_itens requer pedido_ids: number[] (omie_pedido_id dos órfãos)");
        const reparoResult = await repararOrfaosItens(supabaseAdmin, account, pedidoIdsReparo);
        result = { success: true, ...reparoResult };
        break;
      }

      case "probe_count_pedidos": {
        // SONDA read-only (Fase 2b): contagem APROXIMADA de pedidos/mês no Omie p/ achar janelas
        // sub-sincronizadas SEM semear às cegas (achado Codex — o buraco do colacor é ~5 anos).
        // NÃO escreve nada. registros_por_pagina:1 → total_de_paginas ≈ nº de pedidos (subreporta,
        // mas serve de SCREEN: 0 vs tem-dado + ordem de grandeza); a contagem EXATA vem do backfill
        // (paginar-até-vazio). Chunk por ~2-3 anos se a janela grande estourar o timeout (150s).
        const pdFrom = String(params.date_from || "");
        const pdTo = String(params.date_to || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(pdFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(pdTo)) {
          throw new Error("probe_count_pedidos requer date_from/date_to ISO 'YYYY-MM-DD'");
        }
        const janelasProbe = gerarJanelasMensais(pdFrom, pdTo);
        const probe: Array<{ mes: string; omie_aprox: number; tem_dado: boolean }> = [];
        for (const w of janelasProbe) {
          const rp = (await callOmieVendasApi(
            "produtos/pedido/",
            "ListarPedidos",
            { pagina: 1, registros_por_pagina: 1, filtrar_apenas_inclusao: "N", filtrar_por_data_de: w.de, filtrar_por_data_ate: w.ate },
            account,
          )) as { total_de_paginas?: number; pedido_venda_produto?: unknown[] } | null;
          const lista = Array.isArray(rp?.pedido_venda_produto) ? (rp!.pedido_venda_produto as unknown[]) : [];
          probe.push({ mes: w.mes, omie_aprox: Number(rp?.total_de_paginas ?? 0), tem_dado: lista.length > 0 });
        }
        result = { success: true, account, meses: probe.length, probe };
        break;
      }

      case "credito_gate_probe": {
        // CANÁRIA de deploy da trava de crédito Fase 2 — NÃO escreve, NÃO chama o Omie, NÃO
        // cria PV. Prova, sobre o edge DEPLOYADO (não a `main`), duas coisas que o commit de
        // deploy não prova: (1) esta action RESPONDE → o gate subiu no MESMO build (senão viria
        // "ação desconhecida" = binário velho); (2) a RPC venda_gate_credito MORDE — para um par
        // sabidamente bloqueável ela retorna bloqueado=true. A RPC é STABLE (100% read-only), o
        // sales_order_id é sintético (sem exceção → bloqueia se o par é bloqueável). Gated por
        // authorizeCronOrStaff como toda action.
        // [P2 Codex] `codigo` é OBRIGATÓRIO: sem ele, um gate_no_ar:true sozinho daria falsa
        // tranquilidade (só provaria que a action respondeu, não a MORDIDA). E a resposta expõe
        // apenas {bloqueado, motivo} — NÃO vencido/títulos: a canária não precisa ser um oracle
        // de saldo por código arbitrário.
        const codigoProbe = Number(params.codigo) || null;
        if (!codigoProbe) {
          result = {
            success: false,
            gate_no_ar: true, // a action respondeu → o gate da Fase 2 está no build deployado
            account,
            erro: "credito_gate_probe requer `codigo` de um cliente sabidamente bloqueável (senão não prova a mordida)",
          };
          break;
        }
        const { data, error } = await supabaseAdmin.rpc("venda_gate_credito", {
          p_company: account,
          p_codigo: codigoProbe,
          p_sales_order_id: crypto.randomUUID(),
        });
        if (error) throw new Error(`credito_gate_probe: RPC venda_gate_credito falhou: ${error.message}`);
        const gp = data as { bloqueado?: boolean; motivo?: string } | null;
        result = {
          success: true,
          gate_no_ar: true, // a action respondeu → o gate está no build deployado
          account,
          codigo: codigoProbe,
          provado_morde: gp?.bloqueado === true, // true = a RPC bloqueou o par bloqueável (morde)
          motivo: gp?.motivo ?? null,
        };
        break;
      }

      case "identidade_probe": {
        // CANÁRIA COMPORTAMENTAL da derivação de identidade Omie por conta (P0-B) — NÃO escreve, NÃO
        // chama o Omie, NÃO cria PV, NÃO toca o DB. Roda a DECISÃO PURA `decideAccountIdentity`
        // DEPLOYADA (não a `main`) sobre fixtures fixos e compara com o esperado. Prova duas coisas que
        // o commit de deploy NÃO prova: (1) esta action RESPONDE → a derivação P0-B subiu no MESMO build
        // (senão viria "Ação desconhecida" = binário velho); (2) a tabela-verdade certa está no ar —
        // 1-dono resolve, divergência/ambiguidade/ausência fail-closam. É a contraparte-DEPLOY do guard
        // TEXTUAL (que cobre a FONTE/paridade src×edge): a probe cobre o COMPORTAMENTO deployado.
        // ⚠️ Chama a função PURA (não `deriveOmieAccountIdentity`, que busca espelho/Omie): determinística
        // e read-only. NÃO prova que o real-path usa a decisão (isso é o guard textual + paridade) —
        // prova que a DECISÃO deployada está correta. [Codex] Quebra no WRAPPER de I/O (âncora do
        // documento, query do espelho, fallback Omie, backfill, confirmação de espelho stale) fica FORA
        // por design (cobri-la exigiria tocar DB/Omie = deixaria de ser dry-run): isso é o quote OBEN
        // e2e pós-deploy. Gated por authorizeCronOrStaff como toda action.
        // Igualdade estrutural ESTÁVEL: ordena chaves em qualquer nível (os ramos de DecideResult
        // retornam chaves em ordens distintas → comparar string crua daria falso-negativo).
        const stableId = (o: unknown): string =>
          JSON.stringify(o, (_k, v) =>
            v && typeof v === "object" && !Array.isArray(v)
              ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
              : v);
        // Cobertura COMPLETA da tabela-verdade de decideAccountIdentity (9 casos = enumeração do
        // oráculo em src/lib/omie/derive-account-identity.test.ts). [Codex] cobrir só 5 deixaria
        // um bug deployado em omie/backfill, ambiguous_omie, unsafe_integer ou supplied-equality
        // passar como ok:true — precisão>recall pede a tabela inteira.
        const fixturesId: Array<{ caso: string; input: DecideInput; expected: DecideResult }> = [
          { // caminho feliz: espelho 1-dono na conta resolve (source mirror, sem backfill)
            caso: "mirror_1_dono",
            input: { account: "oben", suppliedCodigo: null, mirrorRows: [{ omie_codigo_cliente: 123, omie_codigo_vendedor: 7, empresa_omie: "oben" }], omieMatches: null },
            expected: { ok: true, source: "mirror", codigo_cliente: 123, codigo_vendedor: 7, backfill: false },
          },
          { // advisory que CONFIRMA o derivado (supplied == derived) → ok, NÃO diverge
            caso: "supplied_confirma",
            input: { account: "oben", suppliedCodigo: 123, mirrorRows: [{ omie_codigo_cliente: 123, omie_codigo_vendedor: 7, empresa_omie: "oben" }], omieMatches: null },
            expected: { ok: true, source: "mirror", codigo_cliente: 123, codigo_vendedor: 7, backfill: false },
          },
          { // advisory divergente do derivado → fail-closed (não override) — o coração do P0-B
            caso: "divergencia_supplied",
            input: { account: "oben", suppliedCodigo: 999, mirrorRows: [{ omie_codigo_cliente: 123, omie_codigo_vendedor: 7, empresa_omie: "oben" }], omieMatches: null },
            expected: { ok: false, reason: "divergence" },
          },
          { // 2 códigos distintos na conta → não chuta (precisão>recall)
            caso: "ambiguous_mirror",
            input: { account: "oben", suppliedCodigo: null, mirrorRows: [{ omie_codigo_cliente: 123, omie_codigo_vendedor: 7, empresa_omie: "oben" }, { omie_codigo_cliente: 124, omie_codigo_vendedor: 7, empresa_omie: "oben" }], omieMatches: null },
            expected: { ok: false, reason: "ambiguous_mirror" },
          },
          { // espelho só tem linha de OUTRA conta → ignora e pede Omie (não vaza cross-conta)
            caso: "outra_conta_ignorada_pede_omie",
            input: { account: "oben", suppliedCodigo: null, mirrorRows: [{ omie_codigo_cliente: 123, omie_codigo_vendedor: 7, empresa_omie: "colacor" }], omieMatches: null },
            expected: { ok: false, needOmie: true },
          },
          { // espelho vazio + Omie 1 match → resolve por Omie COM backfill (grava o código no espelho)
            caso: "omie_1match_backfill",
            input: { account: "oben", suppliedCodigo: null, mirrorRows: [], omieMatches: [{ codigo_cliente: 200, codigo_vendedor: 7 }] },
            expected: { ok: true, source: "omie", codigo_cliente: 200, codigo_vendedor: 7, backfill: true },
          },
          { // Omie >1 match (duplicata-CNPJ) → não chuta (precisão>recall)
            caso: "ambiguous_omie",
            input: { account: "oben", suppliedCodigo: null, mirrorRows: [], omieMatches: [{ codigo_cliente: 200, codigo_vendedor: 7 }, { codigo_cliente: 201, codigo_vendedor: 7 }] },
            expected: { ok: false, reason: "ambiguous_omie" },
          },
          { // Omie confirmou ausência (0 match) → fail-closed absent (ausência ≠ zero)
            caso: "omie_ausente_absent",
            input: { account: "oben", suppliedCodigo: null, mirrorRows: [], omieMatches: [] },
            expected: { ok: false, reason: "absent" },
          },
          { // código fora do range seguro do bigint (≥ 2^53) → não vai pro Omie (fail-closed)
            caso: "unsafe_integer",
            input: { account: "oben", suppliedCodigo: null, mirrorRows: [], omieMatches: [{ codigo_cliente: Number.MAX_SAFE_INTEGER + 1, codigo_vendedor: 1 }] },
            expected: { ok: false, reason: "unsafe_integer" },
          },
        ];
        const casosId = fixturesId.map((c) => {
          const resolved = decideAccountIdentity(c.input);
          return { caso: c.caso, resolved, expected: c.expected, ok: stableId(resolved) === stableId(c.expected) };
        });
        result = {
          success: true,
          probe_no_ar: true, // a action respondeu → a derivação P0-B está no build deployado
          account,
          ok: casosId.every((c) => c.ok), // true = a tabela-verdade deployada bate em TODOS os fixtures
          casos: casosId,
        };
        break;
      }

      case "identidade_snapshot_probe": {
        // CANÁRIA DE DEPLOY da RPC omie_sync_identity_snapshot (PR-1/A1) — read-only, NÃO escreve, NÃO
        // chama o Omie. Prova que a RPC subiu no MESMO build (senão PGRST202) E que a resposta satisfaz o
        // CONTRATO (parseIdentitySnapshot valida shape/UUID/disjunção e LANÇA). NÃO prova o fail-closed
        // comportamental (doc-ambíguo=0 em prod hoje); esse é provado no PG17 semeado
        // (db/test-omie-identidade-snapshot.sh). ⚠️ success/ok refletem o DEPLOY REAL — Codex challenge PR-1:
        // success:true em PGRST202/nulls era falso-verde (typeof null==='object' + `?? {}` mascaravam).
        const { data: snapProbe, error: snapProbeErr } = await supabaseAdmin.rpc('omie_sync_identity_snapshot', { p_account: account });
        let parsedOk = false;
        let parseErro: string | null = null;
        let docsUnicos = 0;
        let ambiguos = 0;
        if (!snapProbeErr) {
          try {
            const p = parseIdentitySnapshot(snapProbe);
            docsUnicos = p.docToUserMap.size;
            ambiguos = p.ambiguousDocs.size;
            parsedOk = true;
          } catch (e) {
            parseErro = (e as Error).message;
          }
        }
        result = {
          success: !snapProbeErr && parsedOk, // falso em PGRST202 (deploy quebrado) OU contrato inválido
          canary: true,
          probe_no_ar: !snapProbeErr,
          account,
          ok: !snapProbeErr && parsedOk,
          docs_unicos: docsUnicos,
          ambiguos,
          erro: snapProbeErr?.message ?? parseErro,
        };
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
            const lista = ((pedidos as { pedido_venda_produto?: OmiePedidoVendaProduto[] } | null)?.pedido_venda_produto) || [];
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
            const totalPages = ((pedidos as { total_de_paginas?: number } | null)?.total_de_paginas) || 1;
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
            // Determinística por (sales_order, produto) → o Omie dedup o re-fire da OP.
            // Últimos 12 chars do UUID (não o inteiro): mantém a chave curta — o limite do
            // cCodIntOP no Omie não é confirmado e a chave precisa caber com folga (~16+N chars).
            cCodIntOP: `OP_${opSalesId.slice(-12)}_${opItem.omie_codigo_produto}`,
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
