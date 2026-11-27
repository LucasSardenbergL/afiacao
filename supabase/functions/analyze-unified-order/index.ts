import { createClient } from "npm:@supabase/supabase-js@2";
import { criarClienteAnthropic } from "../_shared/anthropic-cliente.ts";
import {
  avisoImagensRejeitadas,
  type BlocoImagem,
  type ImagemRejeitada,
  prepararImagens,
} from "./imagem-helpers.ts";
import {
  canariaSemPreco,
  extrairToolUseUnico,
  montarRespostaAnalise,
  sanitizarListaIA,
} from "./saida-ia.ts";
import { classificarFlag, erroFlagAmbigua } from "../_shared/sonda-versao.ts";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { normalizarDocumento } from "../_shared/cnpj-alfanumerico.ts";
import { razaoSemCpf } from "../_shared/razao-fiscal.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { rotuloEstoqueCurto, rotuloEstoquePrompt } from "../_shared/estoque-desconhecido.ts";
import { escolherContaPorQuantidade } from "./escolha-conta.ts";
import {
  colapsarMesmoCodigo,
  filtrarParaResgate,
  normalizarCodigo,
  type Resolucao,
  resolverCandidatos,
  resolverEmbalagens,
  rotuloItem,
  type SugestaoProduto,
  sugestoesDeAmbiguo,
} from "./variantes.ts";
import {
  type AcumuladorCache,
  acumularUsoCache,
  criarAcumuladorCache,
  MIN_CHARS_BLOCO_ESTAVEL,
  montarBlocoDinamico,
  montarSystemBlocks,
  pagaEscritaSemNuncaLer,
  resumirUsoCache,
} from "./prompt-sistema.ts";
import {
  carregarCatalogoAtivo,
  carregarPerfis,
  interpretarTranscricao,
  MAX_ITENS_TRANSCRITOS,
  NOME_TOOL_TRANSCRICAO,
  PALAVRAS_GENERICAS_CLIENTE,
  type PerfilMinimo,
  type ProdutoCatalogoMinimo,
  rankearClientes,
  rankearProdutos,
  type ResultadoRanking,
  termos,
  TOOL_TRANSCRICAO,
  type Transcricao,
} from "./transcricao.ts";
import type { BancoPostgrest } from "../_shared/paginate.ts";

// Hit rate acumulado POR VARIANTE, vivo enquanto o isolate durar. Um request
// isolado não distingue cold miss legítimo (1ª chamada, TTL de 5min vencido) de
// miss permanente — só a repetição distingue, e é justamente o miss permanente
// que este PR existe para evitar. Escopo honesto: "nesta instância", não global.
const acumuladoresCache = new Map<string, AcumuladorCache>();

// Strip diacritics/accents for fuzzy comparison
function stripAccents(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// MIRROR-START postgrest-or — manter IDÊNTICO ao bloco de src/lib/postgrest.ts (Deno não importa de src/).
// Sanitiza o termo para o `.or()` do PostgREST: tira vírgula, parênteses, barra, aspas e os curingas
// `% _ *` (o `*` é alias de `%` em like/ilike). `isSearchablePostgrestTerm` é o gate do termo DEGENERADO:
// só-metacaracteres (`***` de negrito do WhatsApp, `%%%`) sanitiza para vazio, e `col.ilike.%%` casaria
// TODA linha — o caller não consulta. A paridade deste bloco × src é vigiada pelo CI
// (edge-money-path-invariants): esta cópia ficou sem o `*` quando o #1051 o pôs só na fonte (B1).
function sanitizeForPostgrestOr(input: string): string {
  return input.replace(/[%_,()\\"*]/g, '');
}
function isSearchablePostgrestTerm(term: string): boolean {
  return sanitizeForPostgrestOr(term) !== '';
}
// MIRROR-END postgrest-or

/** Constrói cláusula .or() segura para múltiplas colunas ILIKE. */
function ilikeOr(term: string, ...cols: string[]): string {
  const safe = sanitizeForPostgrestOr(term);
  return cols.map((c) => `${c}.ilike.%${safe}%`).join(",");
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface CustomerCandidate {
  user_id?: string;
  nome?: string;
  nome_fantasia?: string;
  razao_social?: string;
  cnpj_cpf?: string;
  documento?: string;
  cidade?: string;
  estado?: string;
  codigo_cliente?: number | null;
}

interface ProdutoCatalogo {
  id: string;
  codigo: string;
  descricao: string;
  account?: string | null;
  valor_unitario?: number | null;
  estoque?: number | null;
}

interface UserToolRow {
  id: string;
  generated_name?: string | null;
  custom_name?: string | null;
  quantity?: number | null;
  tool_categories?: { name?: string | null } | null;
}

// Sem `unit_price` nos dois tipos abaixo: a IA não precifica (fronteira em
// `montarRespostaAnalise`, saida-ia.ts). Tirar do TIPO faz o compilador recusar quem tentar
// voltar a atribuí-lo aqui dentro.
interface AIProduct {
  product_id?: string;
  codigo?: string;
  descricao?: string;
  quantity?: number;
  /** PR 3.1: a quantidade NÃO foi dita pelo vendedor (marca de `sanitizarItemIA`). */
  quantidade_inferida?: boolean;
  account?: string;
  notes?: string;
}

interface AIService {
  userToolId: string;
  omie_codigo_servico: number;
  servico_descricao: string;
  quantity: number;
  notes?: string;
}

interface AISuggestion {
  type: "product" | "service";
  product_id?: string;
  codigo?: string;
  descricao: string;
  quantity?: number;
  quantidade_inferida?: boolean;
  account?: string;
  reason: string;
  userToolId?: string;
  omie_codigo_servico?: number;
  servico_descricao?: string;
}

/**
 * Corpo da requisição — o CONTRATO que o chamador manda, não uma validação dele.
 *
 * `req.json()` devolve `any`, e enquanto o corpo ficou sem anotação todo o destructuring do fluxo
 * real herdava `any`: o TypeScript ficava CEGO a defeito de tipo neste caminho inteiro. Dois já
 * moraram nessa cegueira — `montarSystemBlocks(searchCustomer)` declarado `boolean` recebendo a
 * string do termo de busca (#1938), e o `push({ type: "text", text })` com `text` possivelmente
 * `undefined`. Anotar não conserta os dois (o primeiro já está consertado, o segundo é inerte);
 * conserta o TERCEIRO, o que ainda não aconteceu.
 *
 * ⚠️ Anotação NÃO é validação: o corpo chega de fora e ninguém garante que os campos venham com
 * estes tipos. Quem protege contra corpo não-objeto é o guard de runtime no `const body` abaixo, e
 * contra corpo vazio é o `if (!text && allImages.length === 0)`. O tipo descreve o que o
 * `useUnifiedAIAssistant` envia; o runtime continua defendendo o resto.
 *
 * `searchCustomer` é `unknown` de PROPÓSITO — o código só o consome por truthiness (`!!`, `if`,
 * ternário), e `unknown` é o único tipo que deixa isso passar E faz o TS RECUSAR a passagem do
 * valor cru para um parâmetro `boolean`. Ou seja: o defeito #1938 vira erro de compilação em vez
 * de mentira silenciosa. Trocar por `boolean` faria o `!!` do call-site parecer sobra e convidaria
 * a removê-lo.
 */
type CorpoRequisicao = {
  text?: string;
  imageBase64?: string;
  imagesBase64?: string[];
  products?: ProdutoCatalogo[];
  userTools?: UserToolRow[];
  customerUserId?: string;
  searchCustomer?: unknown;
};

/** Content block da Anthropic: texto ou imagem base64 com media type real. */
type BlocoConteudo = { type: "text"; text: string } | BlocoImagem;

/** Modelo e teto de saída — ver convenção de LLM em edge no CLAUDE.md. */
const MODELO = "claude-sonnet-4-6";
const MAX_TOKENS = 8000;
/** Passo 1 do modo só-imagem: só transcrição (até MAX_ITENS_TRANSCRITOS linhas curtas). */
const MAX_TOKENS_TRANSCRICAO = 4000;

/**
 * Erro da API da Anthropic → resposta ao vendedor. Compartilhado pelos DOIS passos do modo
 * só-imagem (transcrição e análise): o mesmo status tem o mesmo significado nos dois.
 */
function respostaDeErroAnthropic(e: unknown, passo: string, imagensRejeitadas: ImagemRejeitada[]): Response {
  const status = (e as { status?: number })?.status;
  const detalhe = e instanceof Error ? e.message : String(e);
  console.error(`[analyze-unified-order] erro na API da Anthropic (${passo}):`, status, detalhe);

  // O 402 NÃO desapareceu com o gateway: a Anthropic devolve billing_error.
  // Sem tratá-lo, a mesma falha que motivou esta migração voltaria como 500
  // genérico e ninguém saberia que o problema é saldo.
  const porStatus: Record<number, { http: number; msg: string }> = {
    // 400 = requisição inválida (defeito nosso), não recusa — mandar trocar de foto esconderia
    // o bug (ver _shared/anthropic.ts). A recusa do modelo chega como 200 + stop_reason "refusal".
    400: { http: 500, msg: "Falha na requisição à IA — avise a equipe. Monte o pedido manualmente por enquanto." },
    402: { http: 402, msg: "Créditos da IA esgotados — avise a equipe. Monte o pedido manualmente por enquanto." },
    401: { http: 500, msg: "IA mal configurada — avise a equipe." },
    403: { http: 500, msg: "IA mal configurada — avise a equipe." },
    404: { http: 500, msg: "IA mal configurada — avise a equipe." },
    413: { http: 413, msg: "Envio grande demais. Mande menos fotos por vez." },
    429: { http: 429, msg: "Limite de requisições excedido. Tente novamente." },
    500: { http: 503, msg: "IA sobrecarregada no momento. Tente de novo em instantes." },
    503: { http: 503, msg: "IA sobrecarregada no momento. Tente de novo em instantes." },
    529: { http: 503, msg: "IA sobrecarregada no momento. Tente de novo em instantes." },
  };
  const mapeado = status ? porStatus[status] : undefined;
  if (mapeado) {
    return new Response(JSON.stringify({ error: mapeado.msg, imagens_rejeitadas: imagensRejeitadas }), {
      status: mapeado.http, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  throw new Error("Erro ao processar com IA");
}

interface ToolPropertySchema {
  type: string | string[];
  description?: string;
  items?: unknown;
  properties?: Record<string, unknown>;
  required?: string[];
  enum?: string[];
}

interface OmieClienteCadastroResponse {
  clientes_cadastro?: Array<{
    codigo_cliente_omie?: number;
    nome_fantasia?: string;
    razao_social?: string;
    cnpj_cpf?: string;
    cidade?: string;
    estado?: string;
  }>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ⚠️ SONDA DE VERSÃO — ANTES do gate de `Bearer ` do handler e ANTES do createClient. Ver
  // versao.ts / _shared/sonda-versao.ts. A ordem não é estética: o gate abaixo é JWT de usuário e
  // NÃO conhece `x-cron-secret`, então uma sonda colocada depois dele seria inalcançável pelo
  // caminho documentado (SQL Editor via net.http_post) — exatamente o defeito que o #1882 corrigiu
  // na `recommend`. É também o que separa esta sonda da CANÁRIA de preço logo abaixo: aquela vive
  // depois do gate de staff, então só o app logado a alcança, e o `contrato` dela nomeia o
  // contrato de PREÇO (hoje: a IA não precifica), não a fatia do prompt.
  //
  // O parse subiu para cá porque `req.json()` é one-shot: o corpo lido aqui é reaproveitado como
  // `body` pelo fluxo real. JSON inválido passa a responder 400 em vez de 500 pelo catch geral
  // (erro do cliente contado como falha nossa), e corpo `null` — que estourava TypeError no
  // destructuring — vira `{}` e cai na validação de "texto ou imagem é obrigatório", que é o que
  // ele sempre foi.
  //
  // ANOTADO (`CorpoRequisicao`, no topo do arquivo): sem isto `req.json()` devolvia `any` e o
  // destructuring do fluxo real herdava `any` — o TS ficava cego a defeito de tipo no caminho
  // inteiro. `| null` porque o guard de runtime logo abaixo existe para o corpo `null`, e a
  // anotação não pode apagar da vista do TS o caso que o guard trata.
  //
  // ⚠️ O CONTADOR do `deno check` não é o sensor desta classe: `any` é atribuível a qualquer coisa,
  // então enquanto o corpo foi `any` os defeitos de tipo daqui simplesmente NÃO existiam para o
  // compilador — consertá-los não movia o número, e anotar não o abaixa. O sensor é o TESTE; o
  // número serve só para provar que a anotação não INTRODUZIU erro (baseline 15, medido antes e
  // depois). `Record<string, unknown>` levaria a 24 (medido) porque cada campo viraria `unknown`
  // e estouraria nos consumidores — por isso o tipo nomeia os campos reais.
  let corpoBruto: CorpoRequisicao | null;
  try {
    corpoBruto = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo !== "disparo") {
    const auth = await authorizeCronOrStaff(req);
    if (!auth.ok) return auth.response;
    if (decisaoSonda.tipo === "sonda") {
      return new Response(JSON.stringify(respostaSonda(VERSAO)), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data, error: authError } = await supabaseAuth.auth.getClaims(token);
    if (authError || !data?.claims) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const loggedInUserId = (data.claims as { sub?: string }).sub || "";

    // SECURITY: staff-only — prevents customer PII enumeration via
    // searchCustomer + service_role profile bulk-fetch.
    {
      const supabaseKeyForRoles = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabaseRoles = createClient(supabaseUrl, supabaseKeyForRoles);
      const { data: callerRoles } = await supabaseRoles
        .from("user_roles")
        .select("role")
        .eq("user_id", loggedInUserId);
      const allowed = new Set(["employee", "master"]);
      if (!(callerRoles ?? []).some((r: { role: string }) => allowed.has(r.role))) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Corpo já consumido pela sonda acima (`req.json()` é one-shot). Não-objeto vira {} — cai na
    // validação de "texto ou imagem é obrigatório" logo abaixo, exatamente como antes.
    const body: CorpoRequisicao = (typeof corpoBruto === "object" && corpoBruto !== null ? corpoBruto : {});
    const { text, imageBase64, imagesBase64, products, userTools, customerUserId, searchCustomer } = body;

    // CANÁRIA COMPORTAMENTAL (staff-gated — já passou pelo gate de auth+staff acima). Prova que a
    // edge REALMENTE DEPLOYADA não precifica: roda a MESMA `montarRespostaAnalise` do fluxo real
    // sobre uma fixture cujos itens trazem preço (o `unit_price` que o LLM devolvia e um `preco`
    // alucinado) e exige que nenhum saia — e que o item SAIA (uma fronteira que devolvesse lista
    // vazia teria "zero preços" e seria sempre-verde). Probe HTTP = única evidência de que o deploy
    // do Lovable não reverteu a lógica. Não toca LLM/Omie/DB. Ver edge-money-path-invariants.
    //
    // HISTÓRICO: até `v1.3` esta canária atestava o merge "praticado vence Omie" (contrato
    // `praticado-vence-omie-v1`, #1089). O merge saiu da edge junto com o enriquecimento de preço
    // — o objeto que ela atestava deixou de existir, então o contrato MUDA (não é bump de fatia).
    //
    // CLASSIFICADOR ROBUSTO (não `canary === true` cru): quem invoca é o founder pelo SQL Editor, e
    // `jsonb_build_object('canary', true)` vira a STRING "true" com facilidade. Sob a comparação
    // crua isso caía no FLUXO REAL — uma análise de pedido com LLM, que gasta token E devolve uma
    // resposta INDISTINGUÍVEL de "bundle velho ignorou o parâmetro" (armadilha 1 de
    // docs/agent/deploy.md §Canárias). Valor presente mas não reconhecido é AMBÍGUO → recusa 400,
    // nunca execução por omissão. Chave AUSENTE segue direto para o fluxo real (o chamador normal).
    const decisaoCanaria = classificarFlag(body, "canary");
    if (decisaoCanaria.tipo === "ambiguo") {
      return new Response(
        JSON.stringify({
          error: erroFlagAmbigua(
            "canary",
            decisaoCanaria.valor,
            "esta edge analisa o pedido com LLM (token gasto) e a resposta ficaria indistinguível de bundle velho",
          ),
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (decisaoCanaria.tipo === "sonda") {
      // A MEDIÇÃO (fixture, contagem pelo nome literal, controle do sempre-verde) mora em
      // `canariaSemPreco` (saida-ia.ts), para o teste Deno rodar a MESMA conta que esta edge serve. O
      // `contrato` fica LITERAL aqui: é por ele que o `canaria-contrato-bump-gate` acha esta canária, e
      // quem o exige é o card de Governança (`CONTRATO_ESPERADO`, código do FRONT) — a troca só
      // discrimina com o Publish E o deploy. ⚠️ BUMP a cada fatia que mude o que ela atesta.
      return new Response(
        JSON.stringify({
          canary: true,
          contrato: "ia-nao-precifica-v1",
          ...canariaSemPreco(),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Support single image (imageBase64) or multiple images (imagesBase64)
    const allImages: string[] = [];
    if (imagesBase64 && Array.isArray(imagesBase64)) {
      allImages.push(...imagesBase64.slice(0, 5));
    } else if (imageBase64) {
      allImages.push(imageBase64);
    }

    if (!text && allImages.length === 0) {
      return new Response(JSON.stringify({ error: "Texto ou imagem é obrigatório" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");

    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    const anthropic = criarClienteAnthropic(ANTHROPIC_API_KEY);

    // ─── Modo só-imagem, passo 1: TRANSCREVER a foto (ver transcricao.ts) ───
    // Antes, este modo lia 1.000 perfis e 1.000 produtos (de 5.668 e 3.223) e despejava as listas
    // no prompt. Agora a IA transcreve cliente + itens, e o catálogo e os perfis INTEIROS (keyset,
    // fail-closed) são ranqueados aqui por relevância a cada item/cliente transcrito.
    let transcricao: Transcricao | null = null;
    let catalogoRanqueado: ResultadoRanking<ProdutoCatalogoMinimo> | null = null;
    let perfisRanqueados: PerfilMinimo[] = [];
    if (allImages.length > 0 && !text) {
      const preparadasP1 = prepararImagens(allImages, 0);
      if (preparadasP1.blocos.length === 0) {
        return new Response(JSON.stringify({
          products: [], services: [], suggestions: [], customer: null,
          imagens_rejeitadas: preparadasP1.rejeitadas,
          error: avisoImagensRejeitadas(preparadasP1.rejeitadas),
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      let respostaP1;
      try {
        respostaP1 = await anthropic.messages.create({
          model: MODELO,
          max_tokens: MAX_TOKENS_TRANSCRICAO,
          system:
            "Você transcreve fotos de pedidos (papel, quadro, print de conversa). Copie o que está ESCRITO — " +
            "não corrija, não complete, não invente item nem código. Uma entrada por linha de item, sem omitir nenhuma.",
          tools: [TOOL_TRANSCRICAO],
          tool_choice: { type: "tool", name: NOME_TOOL_TRANSCRICAO, disable_parallel_tool_use: true },
          messages: [{
            role: "user",
            content: [{ type: "text", text: "Transcreva o cliente e todos os itens destas imagens:" }, ...preparadasP1.blocos],
          }],
        });
      } catch (e: unknown) {
        return respostaDeErroAnthropic(e, "transcrição", preparadasP1.rejeitadas);
      }
      // Transcrição cortada = lista de itens incompleta com cara de completa (§8 money-path).
      if (respostaP1.stop_reason === "max_tokens") {
        console.error(`[analyze-unified-order] transcrição truncada em ${MAX_TOKENS_TRANSCRICAO} tokens`);
        return new Response(JSON.stringify({
          products: [], services: [], suggestions: [], customer: null,
          error: "Pedido grande demais para ler de uma vez. Divida em duas partes e envie de novo.",
        }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const extraidoP1 = extrairToolUseUnico(respostaP1.content);
      transcricao = extraidoP1.ok ? interpretarTranscricao(extraidoP1.input) : null;
      if (transcricao === null) {
        console.error("[analyze-unified-order] transcrição ausente ou malformada", extraidoP1.ok ? "" : extraidoP1.motivo);
        return new Response(JSON.stringify({
          products: [], services: [], suggestions: [], customer: null,
          error: "A IA não conseguiu ler o pedido nas imagens. Tente de novo ou digite o pedido.",
        }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      // Acima do teto RECUSA — seguir com os primeiros N seria pedido parcial com cara de completo.
      if (transcricao.itens.length > MAX_ITENS_TRANSCRITOS) {
        return new Response(JSON.stringify({
          products: [], services: [], suggestions: [], customer: null,
          error: `O pedido tem ${transcricao.itens.length} itens (máximo ${MAX_ITENS_TRANSCRITOS} por vez). Divida em partes e envie de novo.`,
        }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      // Cast estrutural: o módulo testável não importa supabase-js (a suíte roda --no-remote).
      const db = supabase as unknown as BancoPostgrest;
      const [catalogo, perfis] = await Promise.all([
        carregarCatalogoAtivo(db),
        searchCustomer ? carregarPerfis(db) : Promise.resolve([] as PerfilMinimo[]),
      ]);
      catalogoRanqueado = rankearProdutos(transcricao.itens, catalogo);
      perfisRanqueados = rankearClientes(transcricao.cliente, perfis, loggedInUserId);
      console.log(
        `[analyze-unified-order] só-imagem: ${transcricao.itens.length} item(ns) transcrito(s), ` +
          `cliente=${transcricao.cliente ? "sim" : "não"} | catálogo ${catalogo.length} → ` +
          `${catalogoRanqueado.candidatos.length} candidato(s), ${catalogoRanqueado.semCandidato} item(ns) sem candidato | ` +
          `perfis ${perfis.length} → ${perfisRanqueados.length} candidato(s)`,
      );
    }

    // ─── Customer search ───
    let customerSection = "";
    const customerCandidates: CustomerCandidate[] = [];

    if (searchCustomer && (text || allImages.length > 0)) {
      // Extract potential customer names/cities from text
      const searchText = text || "";
      
      // Search profiles by name fragments (at least 3 chars)
      // Só-imagem: o nome TRANSCRITO (sem os genéricos "ltda", "comércio"…) alimenta a busca no Omie.
      const nameTerms = transcricao !== null
        ? termos(transcricao.cliente ?? "", PALAVRAS_GENERICAS_CLIENTE)
        : searchText
          .split(/[\s,;]+/)
          .map((t: string) => t.trim())
          .filter((t: string) => t.length >= 3);

      const candidateIds = new Set<string>();

      // Modo só-imagem: os candidatos vêm do ranking do nome TRANSCRITO contra os perfis inteiros
      // (passo 1, acima). Sem nome na foto → nenhum candidato, e o passo 2 devolve cliente null.
      if (transcricao !== null) {
        for (const p of perfisRanqueados) {
          candidateIds.add(p.user_id);
          customerCandidates.push({
            user_id: p.user_id,
            nome: p.name ?? "",
            nome_fantasia: p.name ?? "",
            documento: p.document,
            // P0-B (item 3): NÃO emitir código cross-conta — o espelho é PARCIAL e o código colide entre
            // contas. A identidade por-conta é derivada na fronteira (edge); handleAICustomerSelect
            // re-resolve por documento/conta. O código aqui era só display e induzia colacor→oben.
            codigo_cliente: null,
          });
        }
      } else {
        // Search in profiles for name matches (text mode). Termo DEGENERADO fica fora ANTES do corte
        // de 5: `***` vira `name.ilike.%%` = 20 perfis arbitrários como "cliente sugerido" (B1).
        for (const term of nameTerms.filter(isSearchablePostgrestTerm).slice(0, 5)) {
          try {
            const { data: profiles } = await supabase
              .from("profiles")
              .select("user_id, name, document")
              .or(ilikeOr(term, "name"))
              .limit(20);
            if (profiles) {
              for (const p of profiles) {
                if (p.user_id === loggedInUserId) continue; // exclude seller
                if (!candidateIds.has(p.user_id)) {
                  candidateIds.add(p.user_id);
                  customerCandidates.push({
                    user_id: p.user_id,
                    nome: p.name,
                    documento: p.document,
                    // P0-B (item 3): NÃO emitir código cross-conta (espelho parcial + colisão). Edge deriva.
                    codigo_cliente: null,
                  });
                }
              }
            }
          } catch (e) {
            console.error(`Error searching profiles for "${term}":`, e);
          }
        }
      }

      // Also try Omie API search for broader matching (nome_fantasia/razao_social)
      // We search Omie directly for terms >= 3 chars
      const omieSearchTerms = nameTerms.filter((t: string) => t.length >= 3).slice(0, 3);
      for (const term of omieSearchTerms) {
        try {
          const OMIE_APP_KEY = Deno.env.get("OMIE_OBEN_APP_KEY");
          const OMIE_APP_SECRET = Deno.env.get("OMIE_OBEN_APP_SECRET");
          if (OMIE_APP_KEY && OMIE_APP_SECRET) {
            const omieRes = await fetch("https://app.omie.com.br/api/v1/geral/clientes/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                call: "ListarClientes",
                app_key: OMIE_APP_KEY,
                app_secret: OMIE_APP_SECRET,
                param: [{ pagina: 1, registros_por_pagina: 10, clientesFiltro: { nome_fantasia: term } }],
              }),
            });
            if (omieRes.ok) {
              const omieData = (await omieRes.json()) as OmieClienteCadastroResponse;
              if (omieData.clientes_cadastro) {
                for (const c of omieData.clientes_cadastro) {
                  const key = `omie_${c.codigo_cliente_omie}`;
                  if (!candidateIds.has(key)) {
                    candidateIds.add(key);
                    // O candidato vai ao prompt do LLM, aos logs e à resposta ao navegador: o CPF do titular de MEI na
                    // razão (e no fantasia, que costuma repeti-la) sai mascarado já aqui (_shared/razao-fiscal.ts, M1).
                    customerCandidates.push({
                      nome_fantasia: razaoSemCpf(c.nome_fantasia || ""),
                      razao_social: razaoSemCpf(c.razao_social || ""),
                      cnpj_cpf: c.cnpj_cpf || "",
                      cidade: c.cidade || "",
                      estado: c.estado || "",
                      codigo_cliente: c.codigo_cliente_omie,
                    });
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error(`Omie customer search error for "${term}":`, e);
        }
      }

      // Onda D 4b-3: o documento dos candidatos NÃO vai ao LLM (de nenhum candidato — o da carteira também
      // não faz falta): a IA devolve o documento que ESTÁ no pedido, e o casamento com o candidato
      // (`matchedCandidate`, abaixo) roda aqui no servidor. Antes ia o CPF/CNPJ de qualquer cliente Omie
      // com nome parecido, fora da carteira de quem pediu.
      if (customerCandidates.length > 0) {
        customerSection = "\n\nCLIENTES ENCONTRADOS NA BASE (para identificação):\n" +
          customerCandidates.map((c, i) => {
            if (c.nome_fantasia !== undefined) {
              return `- [${i}] NomeFantasia:${c.nome_fantasia} | RazãoSocial:${c.razao_social} | Cidade:${c.cidade || 'N/A'} | Estado:${c.estado || 'N/A'} | CódigoCliente:${c.codigo_cliente}`;
            }
            return `- [${i}] Nome:${c.nome} | CódigoCliente:${c.codigo_cliente || 'N/A'}`;
          }).join("\n");
      }
    }

    // ─── Products & Services ───
    // Fetch services
    const { data: servicos } = await supabase
      .from("omie_servicos")
      .select("omie_codigo_servico, descricao")
      .eq("inativo", false);

    const servicosLista = (servicos || []).map(s => `- CódigoServiço:${s.omie_codigo_servico} | ${s.descricao}`).join("\n");

    // Build product list
    let prodList: ProdutoCatalogo[] = [];
    const prodIds = new Set<string>();

    if (catalogoRanqueado !== null) {
      // Só-imagem: top-K de relevância por item transcrito, sobre o catálogo ativo INTEIRO.
      prodList = catalogoRanqueado.candidatos;
      for (const p of prodList) prodIds.add(p.id);
    } else {
      prodList = (products || []).slice(0, 150);
      for (const p of prodList) prodIds.add(p.id);
    }

    // Extract search terms from text input
    const searchText = text || "";
    const searchTerms = searchText
      .split(/[\s,;]+/)
      .map((t: string) => t.trim())
      .filter((t: string) => t.length >= 3);

    if (searchTerms.length > 0) {
      // Termo DEGENERADO fica fora antes do corte de 5 (senão `descricao.ilike.%%` = 20 produtos
      // arbitrários). Só-metacaractere não tem dígito nem letra: nenhuma busca abaixo o aproveitaria.
      for (const term of searchTerms.filter(isSearchablePostgrestTerm).slice(0, 5)) {
        try {
          const { data: dbProducts } = await supabase
            .from("omie_products")
            .select("id, codigo, descricao, account, valor_unitario, estoque")
            .eq("ativo", true)
            .or(ilikeOr(term, "descricao", "codigo"))
            .limit(20);
          if (dbProducts) {
            for (const p of dbProducts) {
              if (!prodIds.has(p.id)) {
                prodList.push(p);
                prodIds.add(p.id);
              }
            }
          }
        } catch (e) {
          console.error(`Error searching products for term "${term}":`, e);
        }

        // Fuzzy product code search - strip dots/dashes and search by numeric part
        // Handles cases like "FO56717" matching "FO05.6717"
        try {
          const numericPart = term.replace(/[^0-9]/g, '');
          if (numericPart.length >= 3) {
            // Search BOTH codigo AND descricao for numeric part
            const { data: fuzzyProducts } = await supabase
              .from("omie_products")
              .select("id, codigo, descricao, account, valor_unitario, estoque")
              .eq("ativo", true)
              .or(ilikeOr(numericPart, "codigo", "descricao"))
              .limit(30);
            if (fuzzyProducts) {
              for (const p of fuzzyProducts) {
                if (!prodIds.has(p.id)) {
                  prodList.push(p);
                  prodIds.add(p.id);
                }
              }
            }
            // Also try with just the last 4 digits if numericPart is longer (e.g., "56717" → "6717")
            if (numericPart.length >= 5) {
              const shortNumeric = numericPart.slice(-4);
              const { data: shortProducts } = await supabase
                .from("omie_products")
                .select("id, codigo, descricao, account, valor_unitario, estoque")
                .eq("ativo", true)
                .or(ilikeOr(shortNumeric, "descricao", "codigo"))
                .limit(30);
              if (shortProducts) {
                for (const p of shortProducts) {
                  if (!prodIds.has(p.id)) {
                    prodList.push(p);
                    prodIds.add(p.id);
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error(`Error fuzzy code search:`, e);
        }

        // Also try alphanumeric-stripped version (e.g., "FO56717" → search without dots)
        try {
          const stripped = term.replace(/[.\-\s]/g, '');
          // Gate PRÓPRIO: o termo passou no filtro acima, mas `..**..**` vira `****` aqui — degenerado.
          if (stripped.length >= 4 && isSearchablePostgrestTerm(stripped)) {
            const { data: strippedProducts } = await supabase
              .from("omie_products")
              .select("id, codigo, descricao, account, valor_unitario, estoque")
              .eq("ativo", true)
              .or(ilikeOr(stripped, "descricao", "codigo"))
              .limit(20);
            if (strippedProducts) {
              for (const p of strippedProducts) {
                if (!prodIds.has(p.id)) {
                  prodList.push(p);
                  prodIds.add(p.id);
                }
              }
            }
          }

          // Extract alpha prefix + numeric suffix for product code patterns like "FO56717" → search "FO" + "6717"
          const alphaMatch = term.match(/^([A-Za-z]{1,4})(\d{3,})/);
          if (alphaMatch) {
            const prefix = alphaMatch[1];
            const digits = alphaMatch[2];
            // Search descricao for prefix + digits (with any separator in between)
            const { data: prefixProducts } = await supabase
              .from("omie_products")
              .select("id, codigo, descricao, account, valor_unitario, estoque")
              .eq("ativo", true)
              .ilike("descricao", `%${prefix}%${digits.slice(-4)}%`)
              .limit(20);
            if (prefixProducts) {
              for (const p of prefixProducts) {
                if (!prodIds.has(p.id)) {
                  prodList.push(p);
                  prodIds.add(p.id);
                }
              }
            }
          }
        } catch (_e) { /* erro ignorado de propósito */ }
      }
    }

    // Broad search for common product categories
    const broadTerms = ["thinner", "thiner", "cola", "lixa", "disco", "serra", "broca", "fresa", "lamina"];
    const inputLower = searchText.toLowerCase();
    for (const bt of broadTerms) {
      if (inputLower.includes(bt) || searchTerms.some((t: string) => t.toLowerCase().includes(bt))) {
        try {
          const { data: dbProducts } = await supabase
            .from("omie_products")
            .select("id, codigo, descricao, account, valor_unitario, estoque")
            .eq("ativo", true)
            .ilike("descricao", `%${bt}%`)
            .limit(20);
          if (dbProducts) {
            for (const p of dbProducts) {
              if (!prodIds.has(p.id)) {
                prodList.push(p);
                prodIds.add(p.id);
              }
            }
          }
        } catch (e) {
          console.error(`Error searching broad term "${bt}":`, e);
        }
      }
    }

    console.log(`[analyze-unified-order] Total products: ${prodList.length}, customer candidates: ${customerCandidates.length}, searchCustomer: ${searchCustomer}`);

    const produtosLista = prodList.map((p) =>
      // Sem `Preço:` — a IA não precifica. Era a ÚNICA fonte de preço do modelo (a TABELA), e ele
      // a ecoava no `unit_price` do item e na prosa da `message` como se fosse o preço do cliente.
      `- ID:${p.id} | Código:${p.codigo} | ${p.descricao} | Conta:${p.account || 'oben'} | ${rotuloEstoquePrompt(p.estoque)}`
    ).join("\n");

    // Format user tools
    const tools: UserToolRow[] = (userTools || []);
    const ferramentasLista = tools.length > 0
      ? tools.map((t) => {
          const nome = t.generated_name || t.custom_name || t.tool_categories?.name || "Ferramenta";
          return `- ToolID:${t.id} | Nome:${nome} | Categoria:${t.tool_categories?.name || ''} | Qtd:${t.quantity || 1}`;
        }).join("\n")
      : "Nenhuma ferramenta cadastrada";

    // Fetch customer purchase history
    let historicoCompras = "";
    if (customerUserId) {
      try {
        const { data: recentItems } = await supabase
          .from("order_items")
          .select("product_id, quantity, omie_products(descricao, codigo, account)")
          .eq("customer_user_id", customerUserId)
          .order("created_at", { ascending: false })
          .limit(50);

        const { data: recentOrders } = await supabase
          .from("orders")
          .select("items, service_type, created_at")
          .eq("user_id", customerUserId)
          .order("created_at", { ascending: false })
          .limit(20);

        if (recentItems && recentItems.length > 0) {
          const productCounts: Record<string, { descricao: string; codigo: string; account: string; totalQty: number; count: number }> = {};
          for (const item of recentItems) {
            const prod = item.omie_products as { descricao?: string; codigo?: string; account?: string } | null;
            if (!prod) continue;
            const key = item.product_id || prod.codigo || '';
            if (!productCounts[key]) {
              productCounts[key] = { descricao: prod.descricao ?? '', codigo: prod.codigo ?? '', account: prod.account || 'oben', totalQty: 0, count: 0 };
            }
            productCounts[key].totalQty += item.quantity;
            productCounts[key].count += 1;
          }
          const sorted = Object.values(productCounts).sort((a, b) => b.count - a.count).slice(0, 15);
          historicoCompras = "\n\nHISTÓRICO DE COMPRAS DO CLIENTE (produtos mais comprados):\n" +
            sorted.map(p => `- ${p.descricao} (${p.codigo}, ${p.account}) — pedido ${p.count}x, total ${p.totalQty} un`).join("\n");
        }

        if (recentOrders && recentOrders.length > 0) {
          const serviceTypes = new Set<string>();
          for (const order of recentOrders) {
            if (order.service_type) serviceTypes.add(order.service_type);
            if (order.items && Array.isArray(order.items)) {
              for (const item of order.items as Array<{ category?: string }>) {
                if (item.category) serviceTypes.add(item.category);
              }
            }
          }
          if (serviceTypes.size > 0) {
            historicoCompras += "\nServiços já utilizados: " + [...serviceTypes].join(", ");
          }
        }
      } catch (e) {
        console.error("Error fetching purchase history:", e);
      }
    }

    // ─── Prompt: system = regras estáveis; dados = 1º texto da MENSAGEM do usuário ───
    // As REGRAS vêm primeiro (prefixo cacheável) e os DADOS depois — desde a v1.11 fora do
    // system, dentro de <dados_desta_consulta> (scanner Lovable, lote 7). O porquê, as duas
    // variantes de cache e as referências posicionais reescritas estão em prompt-sistema.ts.
    // `!!` porque `searchCustomer` chega do corpo da requisição como a STRING do
    // termo de busca, não como boolean — o prompt sempre a consumiu por truthiness
    // (`searchCustomer ? A : B`), então normalizar aqui é o que o runtime JÁ fazia
    // e os bytes do prefixo cacheado não mudam (pinado em prompt-sistema_test.ts).
    // Sem ele o parâmetro declarado `boolean` mente, e a mentira fica invisível
    // enquanto o corpo for `any`.
    const blocosSistema = montarSystemBlocks(!!searchCustomer);
    const blocoEstavel = blocosSistema[0];
    const textoDosDados = montarBlocoDinamico(!!searchCustomer, {
      produtosLista,
      ferramentasLista,
      servicosLista,
      historicoCompras,
      customerSection,
    });

    // Piso de erosão: enxugar as regras abaixo do mínimo do modelo faz a API
    // parar de cachear em SILÊNCIO (sem erro, `cache_creation_input_tokens: 0`).
    // Isto é o AVISO; a PROVA é o número medido logo depois da chamada.
    if (blocoEstavel.text.length < MIN_CHARS_BLOCO_ESTAVEL) {
      console.warn(
        `[analyze-unified-order] bloco estável com ${blocoEstavel.text.length} chars (< ${MIN_CHARS_BLOCO_ESTAVEL}) — provavelmente abaixo do mínimo de cache do ${MODELO}`,
      );
    }

    // Concatenação usada SÓ para orçar as imagens: o system e o texto dos dados viajam no
    // MESMO corpo de request, então ambos descontam do orçamento.
    const textoOrcado = [...blocosSistema.map((b) => b.text), textoDosDados].join("\n");

    // O 1º bloco da mensagem é SEMPRE o dos dados; o pedido do vendedor (texto e fotos) vem depois.
    const conteudoUsuario: BlocoConteudo[] = [{ type: "text", text: textoDosDados }];
    let imagensRejeitadas: ImagemRejeitada[] = [];

    if (allImages.length > 0) {
      // Media type vem dos MAGIC BYTES. O gateway antigo sniffava o conteúdo e
      // engolia o rótulo fixo `image/jpeg`; a Anthropic valida o declarado.
      // O system e o bloco de dados (catálogo + candidatos) entram no MESMO corpo de
      // request, então descontam do orçamento antes de acomodar as fotos.
      const bytesTexto = new TextEncoder().encode(textoOrcado).byteLength;
      const preparadas = prepararImagens(allImages, bytesTexto);
      imagensRejeitadas = preparadas.rejeitadas;

      // Nenhuma foto legível e nenhum texto: não há o que analisar. Responder
      // "não identifiquei itens" aqui esconderia o motivo real do vendedor.
      if (preparadas.blocos.length === 0 && !text) {
        return new Response(JSON.stringify({
          products: [], services: [], suggestions: [], customer: null,
          imagens_rejeitadas: imagensRejeitadas,
          error: avisoImagensRejeitadas(imagensRejeitadas),
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      conteudoUsuario.push({
        type: "text",
        text: text || "Identifique os produtos, ferramentas e cliente nestas imagens e sugira os itens para o pedido:",
      });
      conteudoUsuario.push(...preparadas.blocos);
    } else if (text) {
      conteudoUsuario.push({ type: "text", text });
    } else {
      // INALCANÇÁVEL, e o ramo existe para o TS ENXERGAR isso — não para tratar um caso real.
      // `allImages` vazio só chega aqui se o guard "texto ou imagem é obrigatório" (~linha 361)
      // tiver visto `text` truthy, e `allImages` não é mutado depois dele (os dois `push` ficam nas
      // linhas ~356/358, ANTES). Sem o `else if`, `text` é `string | undefined` no push e o bloco
      // mente no tipo — inerte hoje, mas é a mentira que esconde a próxima.
      //
      // Por que `throw` e não um texto padrão: não há valor honesto a inventar aqui. Fabricar um
      // prompt faria o modelo devolver itens que ninguém pediu, e eles viram sugestão de PEDIDO na
      // tela do vendedor (money-path §3: a IA nunca fabrica o número firme). Cair sem push também
      // não serve — `conteudoUsuario` vazio manda um request sem conteúdo ao modelo e o erro chega
      // disfarçado de falha da Anthropic. O 500 do catch geral, com esta mensagem no log, é o
      // desfecho honesto de um invariante quebrado.
      throw new Error(
        "invariante quebrado: sem imagem e sem texto depois do guard de 'texto ou imagem é obrigatório'",
      );
    }

    // Build tool schema
    const toolProperties: Record<string, ToolPropertySchema> = {
      products: {
        type: "array",
        description: "Produtos do catálogo identificados com certeza",
        items: {
          type: "object",
          properties: {
            product_id: { type: "string", description: "ID UUID do produto" },
            codigo: { type: "string", description: "Código do produto" },
            descricao: { type: "string", description: "Descrição do produto" },
            quantity: { type: "number", description: "Quantidade (padrão 1)" },
            quantidade_explicita: { type: "boolean", description: "true SÓ se o vendedor disse ou escreveu a quantidade deste item; false se você assumiu (ex.: não havia número e você usou 1)" },
            account: { type: "string", description: "Conta: oben ou colacor" },
            notes: { type: "string", description: "Observações" },
          },
          required: ["product_id", "quantity", "quantidade_explicita", "account"],
        },
      },
      services: {
        type: "array",
        description: "Serviços de afiação identificados",
        items: {
          type: "object",
          properties: {
            userToolId: { type: "string", description: "ID da ferramenta cadastrada" },
            omie_codigo_servico: { type: "number", description: "Código do serviço Omie" },
            servico_descricao: { type: "string", description: "Descrição do serviço" },
            quantity: { type: "number", description: "Quantidade" },
            quantidade_explicita: { type: "boolean", description: "true SÓ se o vendedor disse ou escreveu a quantidade deste item; false se você assumiu (ex.: não havia número e você usou 1)" },
            notes: { type: "string", description: "Observações (danos, urgência, etc)" },
          },
          required: ["userToolId", "omie_codigo_servico", "servico_descricao", "quantity", "quantidade_explicita"],
        },
      },
      suggestions: {
        type: "array",
        description: "Sugestões de produtos/serviços quando não há correspondência exata ou baseado no histórico",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["product", "service"], description: "Tipo da sugestão" },
            product_id: { type: "string", description: "ID UUID do produto sugerido (se type=product)" },
            codigo: { type: "string", description: "Código do produto sugerido" },
            descricao: { type: "string", description: "Descrição do item sugerido" },
            quantity: { type: "number", description: "Quantidade sugerida" },
            quantidade_explicita: { type: "boolean", description: "true SÓ se o vendedor disse ou escreveu a quantidade deste item; false se você assumiu (ex.: não havia número e você usou 1)" },
            account: { type: "string", description: "Conta: oben ou colacor" },
            reason: { type: "string", description: "Motivo da sugestão" },
            userToolId: { type: "string", description: "ID da ferramenta (se type=service)" },
            omie_codigo_servico: { type: "number", description: "Código do serviço (se type=service)" },
            servico_descricao: { type: "string", description: "Descrição do serviço (se type=service)" },
          },
          required: ["type", "descricao", "reason"],
        },
      },
      message: { type: "string", description: "Mensagem amigável explicando o que foi identificado" },
    };

    const requiredFields = ["products", "services", "suggestions", "message"];

    if (searchCustomer) {
      toolProperties.customer = {
        type: ["object", "null"],
        description: "Cliente identificado no pedido. null se nenhum cliente foi mencionado.",
        properties: {
          nome_fantasia: { type: "string", description: "Nome fantasia do cliente" },
          razao_social: { type: "string", description: "Razão social do cliente" },
          cnpj_cpf: { type: "string", description: "CNPJ ou CPF do cliente" },
          cidade: { type: "string", description: "Cidade do cliente" },
          codigo_cliente: { type: "number", description: "Código do cliente no Omie (use 0 se não disponível)" },
          user_id: { type: "string", description: "user_id do cliente no sistema (se disponível na lista de candidatos)" },
          confidence: { type: "string", enum: ["high", "medium", "low"], description: "Nível de confiança na identificação" },
        },
        required: ["nome_fantasia", "confidence"],
      };
      requiredFields.push("customer");
    }

    let resposta;
    try {
      resposta = await anthropic.messages.create({
        model: MODELO,
        max_tokens: MAX_TOKENS,
        // Prompt caching por PREFIXO: o único bloco do system (regras estáveis) leva o
        // `cache_control: ephemeral`; os dados (catálogo, serviços, histórico, candidatos)
        // vão na mensagem, depois do prefixo, porque mudam a cada request. Como a ordem de
        // renderização é `tools` → `system` → `messages`, o `input_schema` da
        // tool entra no MESMO prefixo cacheado, de graça.
        system: blocosSistema,
        tools: [
          {
            name: "identify_order_items",
            description: "Retorna produtos, serviços e cliente identificados no pedido",
            input_schema: {
              type: "object" as const,
              properties: toolProperties,
              required: requiredFields,
            },
          },
        ],
        // `type:"tool"` sozinho NÃO desliga chamada paralela: o modelo poderia
        // emitir um bloco por grupo de itens e o consumo pegaria só o primeiro,
        // entregando pedido PARCIAL com cara de completo.
        tool_choice: {
          type: "tool",
          name: "identify_order_items",
          disable_parallel_tool_use: true,
        },
        messages: [{ role: "user", content: conteudoUsuario }],
      });
    } catch (e: unknown) {
      return respostaDeErroAnthropic(e, "análise", imagensRejeitadas);
    }

    // PROVA do cache, não suposição (foi a crítica do Codex no #1608): sem estes
    // contadores não dá para saber se o `cache_control` pegou — hit rate se mede,
    // não se acredita. Campo que a API não mandou sai como "—" e NÃO conta como
    // zero (ausente ≠ zero).
    const variante = searchCustomer ? "com-cliente" : "sem-cliente";
    const usoCache = resumirUsoCache(resposta.usage);
    const acc = acumularUsoCache(
      acumuladoresCache.get(variante) ?? criarAcumuladorCache(),
      usoCache,
    );
    acumuladoresCache.set(variante, acc);

    const numero = (n: number | null) => (n === null ? "—" : String(n));
    console.log(
      `[analyze-unified-order] cache variante=${variante} estado=${usoCache.estado} ` +
        `escrita=${numero(usoCache.escrita)} leitura=${numero(usoCache.leitura)} ` +
        `entrada=${numero(usoCache.entrada)} estavel_chars=${blocoEstavel.text.length} | ` +
        `nesta instância: ${acc.chamadas} chamada(s) · ${acc.leitura} leitura · ` +
        `${acc.escrita} escrita · ${acc.inativo} inativo · ${acc.desconhecido} desconhecido`,
    );

    // Dois alertas DIFERENTES, porque são falhas diferentes.
    if (usoCache.estado === "inativo") {
      console.warn(
        `[analyze-unified-order] cache INATIVO: escrita=0 E leitura=0 com cache_control ativo — ` +
          `prefixo abaixo do mínimo de 1024 tokens do ${MODELO}`,
      );
    }
    // Este é o desastre do #1608 de volta: paga 1,25× de escrita toda chamada e
    // nunca colhe o 0,1× de leitura. Só a REPETIÇÃO distingue isto de cold miss.
    if (pagaEscritaSemNuncaLer(acc)) {
      console.warn(
        `[analyze-unified-order] cache NUNCA LIDO: ${acc.escrita} escrita(s) e 0 leitura na variante ` +
          `${variante} desta instância — o prefixo está mudando entre requests (algo variável ` +
          `vazou para o bloco estável ou para \`tools\`)`,
      );
    }

    // §8 money-path: teto que trunca fabrica completude. Uma lista cortada no
    // meio chega ao vendedor com cara de lista inteira e vira pedido incompleto.
    if (resposta.stop_reason === "max_tokens") {
      console.error(`[analyze-unified-order] resposta truncada em ${MAX_TOKENS} tokens`);
      return new Response(JSON.stringify({
        products: [], services: [], suggestions: [], customer: null,
        error: "Pedido grande demais para analisar de uma vez — a resposta foi cortada. Divida em duas partes e envie de novo.",
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const extraido = extrairToolUseUnico(resposta.content);

    if (!extraido.ok) {
      if (extraido.motivo === "multiplo") {
        // Análise partida em vários blocos: não dá para provar que veio inteira,
        // e consumir só o primeiro entregaria pedido parcial como se completo.
        console.error(
          `[analyze-unified-order] ${extraido.quantidade} blocos tool_use (esperado 1)`,
        );
        return new Response(JSON.stringify({
          products: [], services: [], suggestions: [], customer: null,
          imagens_rejeitadas: imagensRejeitadas,
          error:
            "A IA devolveu a análise em partes e não dá para garantir que veio inteira. Tente de novo ou divida o pedido.",
        }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const avisoSemTool = avisoImagensRejeitadas(imagensRejeitadas);
      const baseSemTool =
        "Não consegui identificar itens. Seja mais específico ou selecione manualmente.";
      return new Response(JSON.stringify({
        products: [], services: [], suggestions: [], customer: null,
        imagens_rejeitadas: imagensRejeitadas,
        message: avisoSemTool ? `${baseSemTool} ⚠️ ${avisoSemTool}` : baseSemTool,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Forced tool-use garante que a ferramenta foi USADA — não que os tipos do
    // input_schema foram respeitados (isso só com `strict:true`). Esta é a
    // fronteira onde preço-string e quantidade-string param, antes de chegarem
    // ao carrinho: `"12.50" > 0` é true por coerção e explodiria no checkout;
    // `1 + "2"` viraria a quantidade "12".
    const bruto = extraido.input;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- saída de LLM consumida de forma dinâmica em ~20 pontos a jusante (resgate por fuzzy match, casamento de cliente); os campos money-path já foram travados por sanitizarListaIA acima
    const result: any = bruto && typeof bruto === "object" && !Array.isArray(bruto)
      ? { ...bruto }
      : {};
    result.products = sanitizarListaIA(result.products);
    result.services = sanitizarListaIA(result.services);
    result.suggestions = sanitizarListaIA(result.suggestions);

    // ─── Resgate de product_id inválido (PR 3.1: ambíguo fica para o vendedor) ───
    // Até a v1.15 cada etapa usava `.find`: o PRIMEIRO candidato que casava pelo prefixo virava o
    // produto, sem conferir a embalagem pedida, e o resgate do banco ficava com `dbRescue[0]` entre
    // até 5. Agora toda etapa passa por `resolverCandidatos` (variantes.ts): um código distinto
    // resgata; mais de um vira sugestão, e o vendedor escolhe. A embalagem pedida é filtro DURO.
    const validProductIds = new Set(prodList.map((p) => p.id));
    // Catálogo que as etapas seguintes consultam: o da consulta + o que o resgate trouxe do banco.
    const catalogoConhecido = new Map<string, ProdutoCatalogo>(prodList.map((p) => [p.id, p]));
    const aiProducts: AIProduct[] = result.products || [];
    let validProducts: AIProduct[] = [];
    const sugestoesHonestas: SugestaoProduto[] = [];
    let itensAmbiguos = 0;
    result.suggestions = result.suggestions || [];

    for (const ap of aiProducts) {
      if (validProductIds.has(ap.product_id ?? '')) {
        validProducts.push(ap);
        continue;
      }
      console.log(`[analyze-unified-order] Product ID not valid: ${ap.product_id}, trying rescue by codigo="${ap.codigo}" descricao="${ap.descricao}"`);

      const apCodigo = normalizarCodigo(ap.codigo);

      // Todas as sequências numéricas (3+ dígitos) de codigo e descricao; das longas, também os 4
      // últimos ("56717" → "6717").
      const allNumericCodes = new Set<string>();
      for (const src of [ap.codigo || '', ap.descricao || '']) {
        const nums = src.match(/\d{3,}/g) ?? [];
        for (const n of nums) {
          allNumericCodes.add(n);
          if (n.length >= 5) allNumericCodes.add(n.slice(-4));
        }
      }

      // Prefixo da linha ("FO" de "FO5.6717BH") e sufixo de embalagem (BH, LT, QT, GL, L5, BD).
      const prefixFromCodigo = (ap.codigo || '').match(/^([A-Za-z]{2,3})/);
      const alphaPrefix = prefixFromCodigo ? prefixFromCodigo[1].toUpperCase() : null;
      // Corrige a precedência do `||` da v1.15 (`ap.codigo || '' + ' ' + ap.descricao`), que nunca
      // lia a descrição quando havia código.
      const suffixMatch = `${ap.codigo || ''} ${ap.descricao || ''}`.match(/(BH|LT|QT|GL|L5|BD)\b/i);
      const packSuffix = suffixMatch ? suffixMatch[1].toUpperCase() : null;

      let desfecho: Resolucao<ProdutoCatalogo> = { tipo: "nenhum" };

      // 1. Código exato (sem pontuação), no código ou na descrição do catálogo.
      if (apCodigo) {
        desfecho = resolverCandidatos(
          prodList.filter((p) => normalizarCodigo(p.codigo) === apCodigo || normalizarCodigo(p.descricao).includes(apCodigo)),
          ap.quantity,
        );
      }

      // 2. Número do código + embalagem (dura) + prefixo (brando). Para no 1º número que decide.
      if (desfecho.tipo === "nenhum") {
        for (const nc of allNumericCodes) {
          const candidates = prodList.filter((p) => p.descricao.includes(nc));
          if (candidates.length === 0) continue;
          desfecho = resolverCandidatos(filtrarParaResgate(candidates, alphaPrefix, packSuffix), ap.quantity);
          if (desfecho.tipo !== "nenhum") break;
        }
      }

      // 3. Último recurso: o banco, para números fora do catálogo da consulta — sob a MESMA regra.
      if (desfecho.tipo === "nenhum" && allNumericCodes.size > 0) {
        for (const nc of allNumericCodes) {
          try {
            let query = supabase
              .from("omie_products")
              .select("id, codigo, descricao, account, valor_unitario, estoque")
              .eq("ativo", true)
              .ilike("descricao", `%${nc}%`);
            if (packSuffix) query = query.ilike("descricao", `%${packSuffix}%`);
            if (alphaPrefix) query = query.ilike("descricao", `%${alphaPrefix}%`);
            const { data: dbRescue } = await query.limit(5);
            const doBanco = (dbRescue ?? []) as ProdutoCatalogo[];
            if (doBanco.length === 0) continue;
            for (const p of doBanco) catalogoConhecido.set(p.id, p);
            desfecho = resolverCandidatos(doBanco, ap.quantity);
            if (desfecho.tipo !== "nenhum") break;
          } catch (e) {
            console.error(`DB rescue error for ${nc}:`, e);
          }
        }
      }

      if (desfecho.tipo === "unico") {
        const match = desfecho.produto;
        console.log(`[analyze-unified-order] Rescued: ${ap.codigo}/${ap.descricao} → ${match.descricao} (${match.id})`);
        validProducts.push({ ...ap, product_id: match.id, codigo: match.codigo, descricao: match.descricao, account: match.account ?? undefined });
      } else if (desfecho.tipo === "ambiguo") {
        itensAmbiguos += 1;
        console.log(`[analyze-unified-order] Ambiguous rescue for ${ap.codigo}/${ap.descricao}: ${desfecho.candidatos.length} códigos — fica para o vendedor`);
        sugestoesHonestas.push(...sugestoesDeAmbiguo(
          ap,
          desfecho.candidatos,
          `"${rotuloItem(ap)}" casa com ${desfecho.candidatos.length} produtos${packSuffix ? "" : " e o pedido não diz a embalagem"} — escolha o certo`,
        ));
      } else {
        // 4. Sem candidato: vira sugestão sem product_id, com o motivo.
        console.log(`[analyze-unified-order] Could not rescue product, moving to suggestions: ${ap.descricao}`);
        result.suggestions.push({
          type: 'product',
          product_id: '',
          codigo: ap.codigo || '',
          descricao: ap.descricao || 'Produto não identificado',
          quantity: ap.quantity || 1,
          quantidade_inferida: ap.quantidade_inferida !== false,
          account: ap.account || 'oben',
          reason: `Produto "${ap.descricao || ap.codigo}" mencionado mas não encontrado no catálogo`,
        });
      }
    }

    // ─── Uma variante por item (PR 3.1) ───
    // O mesmo código nas duas empresas vira UM item, na conta de `escolherContaPorQuantidade`;
    // repetido com quantidades diferentes vira sugestão. Até a v1.15 o prompt pedia as duas
    // variantes e a deduplicação era por `codigo + quantidade`: quantidade diferente duplicava.
    const colapso = colapsarMesmoCodigo(validProducts, catalogoConhecido);
    validProducts = colapso.unicos;
    sugestoesHonestas.push(...colapso.sugestoes);
    itensAmbiguos += new Set(colapso.sugestoes.map((s) => normalizarCodigo(s.codigo))).size;

    // ─── Embalagens do mesmo produto base (PR 3.1: nada some em silêncio) ───
    // Fica com UMA só quando o texto do VENDEDOR pede exatamente a embalagem dela; senão todas viram
    // sugestão. Até a v1.15 as outras eram removidas sem aviso, a 1ª do grupo vencia o empate, e a
    // `message` da própria IA contava como pista.
    const embalagens = resolverEmbalagens(validProducts, catalogoConhecido, text || '');
    itensAmbiguos += embalagens.ambiguos;
    validProducts = embalagens.mantidos;
    sugestoesHonestas.push(...embalagens.sugestoes);

    // ─── Conta (oben × colacor) por estoque E quantidade pedida ───
    // Regra em `escolherContaPorQuantidade` (escolha-conta.ts): cobre o pedido (menor saldo) > cobre
    // em parte (maior saldo) > desconhecido > zero real. Estoque desconhecido não é zero.
    const optimizedProducts: AIProduct[] = [];
    for (const vp of validProducts) {
      const prod = catalogoConhecido.get(vp.product_id ?? '');
      if (!prod) { optimizedProducts.push(vp); continue; }

      const baseCode = prod.codigo;
      const otherAccount = prod.account === 'oben' ? 'colacor' : 'oben';
      const equivalent = prodList.find((p) =>
        p.codigo === baseCode && p.account === otherAccount
      );

      if (equivalent && escolherContaPorQuantidade(prod.estoque, equivalent.estoque, vp.quantity) === "outra") {
        const currentStock = rotuloEstoqueCurto(prod.estoque);
        const otherStock = rotuloEstoqueCurto(equivalent.estoque);
        console.log(`[analyze-unified-order] Switching ${baseCode} from ${prod.account}(est:${currentStock}) to ${otherAccount}(est:${otherStock})`);
        optimizedProducts.push({
          ...vp,
          product_id: equivalent.id,
          account: otherAccount,
          notes: (vp.notes || '') + ` (Origem otimizada: ${otherAccount}, est: ${otherStock})`,
        });
      } else {
        optimizedProducts.push({ ...vp, account: prod.account ?? vp.account });
      }
    }
    validProducts = optimizedProducts;
    result.suggestions.push(...sugestoesHonestas);

    // Validate tool IDs
    const validToolIds = new Set(tools.map((t) => t.id));
    // PR 3.1: o que sai das listas sai com o MOTIVO (`descartados`), não some em silêncio.
    const descartados: Array<{ descricao: string; motivo: string }> = [];
    const validServices = ((result.services || []) as AIService[]).filter((s) => {
      if (validToolIds.has(s.userToolId)) return true;
      descartados.push({
        descricao: s.servico_descricao || 'Serviço de afiação',
        motivo: 'a ferramenta não está no cadastro deste cliente',
      });
      return false;
    });

    // Validate suggestions — also DEDUP: remove suggestions that are already in validProducts
    const validProductIdSet = new Set(validProducts.map((vp) => vp.product_id));
    const validSuggestions = ((result.suggestions || []) as AISuggestion[]).filter((s) => {
      if (s.type === 'product') {
        // Já está nos produtos confirmados: é repetição, não descarte.
        if (s.product_id && s.product_id !== '' && validProductIdSet.has(s.product_id)) return false;
        if (s.product_id && s.product_id !== '') {
          if (catalogoConhecido.has(s.product_id)) return true;
          descartados.push({ descricao: s.descricao || s.codigo || 'Sugestão', motivo: 'a IA citou um produto que não existe no catálogo' });
          return false;
        }
        return true;
      }
      if (s.type === 'service') {
        if (!s.userToolId || validToolIds.has(s.userToolId)) return true;
        descartados.push({ descricao: s.servico_descricao || s.descricao || 'Serviço', motivo: 'a ferramenta não está no cadastro deste cliente' });
        return false;
      }
      return true;
    });

    // Validate customer - MUST exist in our candidate list
    let validCustomer = null;
    if (searchCustomer && result.customer) {
      console.log(`[analyze-unified-order] AI returned customer: "${result.customer.nome_fantasia}", candidates: ${customerCandidates.length}`);
      
      // Helper: check if two names share significant words
      // IMPORTANT: ignore common business suffixes that would cause false positives
      const STOP_WORDS = new Set(['ltda', 'eireli', 'epp', 'mei', 'sa', 'ss', 'me', 'comercio', 'industria', 'servicos', 'com', 'ind', 'serv', 'dos', 'das', 'para', 'que', 'the', 'and']);
      const shareWords = (name1: string, name2: string): boolean => {
        const w1 = stripAccents(name1.toLowerCase()).split(/\s+/).filter((w: string) => w.length >= 3 && !STOP_WORDS.has(w));
        const w2 = stripAccents(name2.toLowerCase()).split(/\s+/).filter((w: string) => w.length >= 3 && !STOP_WORDS.has(w));
        if (w1.length === 0 || w2.length === 0) return false;
        // Check direct word inclusion — require at least one SIGNIFICANT word match
        let significantMatches = 0;
        for (const w of w1) {
          if (w.length >= 4 && w2.some((w2w: string) => w2w.includes(w) || w.includes(w2w))) significantMatches++;
        }
        if (significantMatches >= 1) return true;
        // Edit distance for typos (Lorham→Lohan) — only for significant words (length >= 4)
        for (const a of w1) {
          if (a.length < 4) continue;
          for (const b of w2) {
            if (b.length < 4) continue;
            if (Math.abs(a.length - b.length) > 2) continue;
            let diffs = 0;
            const maxLen = Math.max(a.length, b.length);
            for (let i = 0; i < maxLen; i++) {
              if ((a[i] || '') !== (b[i] || '')) diffs++;
            }
            if (diffs <= 2) return true;
          }
        }
        return false;
      };

      // Check if this customer actually exists in our candidates
      // IMPORTANT: Do NOT trust AI's user_id — only match by name, document, or codigo_cliente
      const matchedCandidate = customerCandidates.find((c) => {
        // Match by codigo_cliente
        if (c.codigo_cliente && result.customer.codigo_cliente && c.codigo_cliente === result.customer.codigo_cliente) return true;
        // Match by document
        if (c.documento && result.customer.cnpj_cpf) {
          const cDoc = normalizarDocumento(c.documento);
          const rDoc = normalizarDocumento(result.customer.cnpj_cpf);
          if (cDoc && rDoc && cDoc === rDoc) return true;
        }
        // DO NOT match by user_id — AI often returns wrong user_id from the candidate list index
        // Match by name (fuzzy)
        const cName = stripAccents((c.nome_fantasia || c.nome || '').toLowerCase().trim());
        const rName = stripAccents((result.customer.nome_fantasia || '').toLowerCase().trim());
        if (cName && rName && cName.length > 2 && rName.length > 2) {
          if (cName.includes(rName) || rName.includes(cName)) return true;
          if (shareWords(cName, rName)) return true;
        }
        return false;
      });

      if (matchedCandidate) {
        console.log(`[analyze-unified-order] Customer matched: "${matchedCandidate.nome_fantasia || matchedCandidate.nome}" (user_id: ${matchedCandidate.user_id})`);
        validCustomer = {
          nome_fantasia: matchedCandidate.nome_fantasia || matchedCandidate.nome || result.customer.nome_fantasia || "",
          razao_social: matchedCandidate.razao_social || matchedCandidate.nome || "",
          cnpj_cpf: matchedCandidate.cnpj_cpf || matchedCandidate.documento || result.customer.cnpj_cpf || "",
          cidade: result.customer.cidade || matchedCandidate.cidade || "",
          codigo_cliente: matchedCandidate.codigo_cliente || result.customer.codigo_cliente || 0,
          confidence: result.customer.confidence || "medium",
          user_id: matchedCandidate.user_id || null,
        };
      } else if (result.customer.nome_fantasia) {
        console.log(`[analyze-unified-order] No direct match, trying broader search for: "${result.customer.nome_fantasia}"`);
        // Log all candidates for debugging
        for (const c of customerCandidates.slice(0, 10)) {
          const cn = c.nome_fantasia || c.nome || 'N/A';
          console.log(`[analyze-unified-order] Candidate: "${cn}"`);
        }
        
        const bestMatch = customerCandidates.find((c) => {
          const name = stripAccents((c.nome_fantasia || c.nome || '').toLowerCase());
          const aiName = stripAccents((result.customer.nome_fantasia || '').toLowerCase());
          if (!name || !aiName) return false;
          return shareWords(name, aiName);
        });
        
        if (bestMatch) {
          console.log(`[analyze-unified-order] Broader match found: "${bestMatch.nome_fantasia || bestMatch.nome}"`);
          validCustomer = {
            nome_fantasia: bestMatch.nome_fantasia || bestMatch.nome || "",
            razao_social: bestMatch.razao_social || bestMatch.nome || "",
            cnpj_cpf: bestMatch.cnpj_cpf || bestMatch.documento || "",
            cidade: bestMatch.cidade || "",
            codigo_cliente: bestMatch.codigo_cliente || 0,
            confidence: "low",
            user_id: bestMatch.user_id || null,
          };
        } else {
          console.log(`[analyze-unified-order] No customer match found at all`);
        }
      }
    }

    // SEM enriquecimento de preço. Até a v1.3 este ponto lia `order_items` cru (service_role, sem
    // JOIN em sales_orders, LIMIT 200 por created_at) + `ListarPedidos` do Omie e aplicava o
    // "último praticado" em products/suggestions — um 2º decisor de preço, divergente do único que
    // o carrinho reconhece (`precoPartida`, que lê a RPC `get_ultimos_precos_cliente` para o cliente
    // SELECIONADO). Medido em prod (2026-09-30): além de só existir quando a IA identificava o
    // cliente, a leitura crua divergia da RPC em 11 pares (pedido cancelado), 4.315 (teto de 200
    // itens, 77 clientes) e 162 (empate de created_at, escolha não-determinística). A edge agora
    // só IDENTIFICA; o preço nasce no front. Ver `montarRespostaAnalise` (saida-ia.ts).

    // SECURITY: strip PII (cnpj_cpf/email/phone/document) from response payload.
    const safeCustomer = validCustomer
      ? {
          nome_fantasia: razaoSemCpf(validCustomer.nome_fantasia || ""),
          razao_social: razaoSemCpf(validCustomer.razao_social || ""),
          cidade: validCustomer.cidade || "",
          codigo_cliente: validCustomer.codigo_cliente || 0,
          confidence: validCustomer.confidence || "medium",
          user_id: validCustomer.user_id || null,
        }
      : null;

    // Foto que ficou de fora entra na MENSAGEM, não só num campo: análise de 3
    // de 5 fotos não pode chegar com cara de análise completa.
    const avisoFotos = avisoImagensRejeitadas(imagensRejeitadas);
    // A `message` é da IA e foi escrita ANTES das travas acima: se alguma coisa foi para as
    // sugestões ou saiu, a mensagem diz (PR 3.1 — o "identifiquei 3" não pode esconder a 4ª).
    const avisosHonestos = [
      itensAmbiguos > 0
        ? `${itensAmbiguos} item(ns) ambíguo(s) ficaram nas sugestões para você escolher.`
        : null,
      descartados.length > 0 ? `${descartados.length} item(ns) não puderam ser usados.` : null,
    ].filter(Boolean).join(' ');
    const mensagemIA = result.message ||
      `Identificado ${validProducts.length} produto(s) e ${validServices.length} serviço(s).`;
    const mensagemBase = avisosHonestos ? `${mensagemIA} ${avisosHonestos}` : mensagemIA;

    // FRONTEIRA DE SAÍDA (money-path): todo item sai pela lista fechada de `montarRespostaAnalise`
    // — nenhum `unit_price`/preço atravessa, venha do LLM ou de quem for. O vitest
    // (edge-money-path-invariants) exige que o `JSON.stringify` do fluxo real consuma ESTA chamada.
    // `corpoResposta`, não `resposta`: o handler já tem `let resposta` (a resposta da Anthropic, l.~880) no
    // MESMO escopo — redeclarar é early error do V8 e a edge não BOOTA (incidente 2026-10-01, BOOT_ERROR 503).
    const corpoResposta = montarRespostaAnalise({
      products: validProducts,
      services: validServices,
      suggestions: validSuggestions,
      descartados,
      customer: safeCustomer,
      imagens_rejeitadas: imagensRejeitadas,
      message: avisoFotos ? `${mensagemBase} ⚠️ ${avisoFotos}` : mensagemBase,
    });
    return new Response(JSON.stringify(corpoResposta), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("analyze-unified-order error:", error);
    return new Response(JSON.stringify({ error: "Erro ao processar solicitação" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
