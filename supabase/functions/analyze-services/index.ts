import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import {
  extrairToolUseUnico,
  MODELO_PADRAO,
  objetoDaTool,
  statusDoErro,
  traduzirErroAnthropic,
} from "../_shared/anthropic.ts";
import { consumirCota, headersDeCota } from "../_shared/ia-cota.ts";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { normalizarItens, TOOL_SERVICOS } from "./servico-tools.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { montarMensagemServicos, SYSTEM_PROMPT_SERVICOS } from "./servico-prompt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface UserTool {
  id: string;
  generated_name: string | null;
  custom_name: string | null;
  quantity: number | null;
  tool_categories: {
    name: string;
  } | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ⚠️ SONDA DE VERSÃO ({"probe":true}) — ANTES do gate `Bearer ` e do createClient, como na
  // `analyze-unified-order`. Quem sonda precisa do `x-cron-secret`/staff do
  // `authorizeCronOrStaff`: o gate PRÓPRIO existe porque atrás do JWT de usuário desta edge a
  // sonda seria inalcançável para o cron. ⚠️ Esta edge é `verify_jwt = true` (ausente do
  // `config.toml`), então o relé precisa mandar TAMBÉM um `Authorization: Bearer <jwt>` — sem
  // ele o 401 vem do GATEWAY e não prova nada. Daqui pra frente a edge queima cota de IA e
  // chama a Anthropic. Ver versao.ts / _shared/sonda-versao.ts.
  //
  // ⚠️ O corpo só se lê UMA vez. O erro de JSON inválido é GUARDADO e relançado no ponto antigo
  // (abaixo), para que a resposta continue sendo o 500 do catch geral: engoli-lo faria um corpo
  // quebrado virar `text: undefined` e cair no 400 de validação, mandando o chamador consertar
  // a coisa errada.
  let corpoBruto;
  let erroParseCorpo: unknown = null;
  try {
    corpoBruto = await req.json();
  } catch (e) {
    corpoBruto = {};
    erroParseCorpo = e;
  }

  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo !== "disparo") {
    const authSonda = await authorizeCronOrStaff(req);
    if (!authSonda.ok) return authSonda.response;
    if (decisaoSonda.tipo === "sonda") {
      return new Response(JSON.stringify(respostaSonda(VERSAO)), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO), versao: VERSAO }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    // Authentication
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

    // Staff OU customer APROVADO (scanner Lovable, lote 7) — o mesmo gate da `identify-tool` (lote 1).
    // O cadastro em /auth é público: "JWT válido" incluía o customer recém-cadastrado, que a UI
    // barra (`ProtectedRoute` exige `isApproved`; a tela é a /new-order e a /sales/new) e que ainda
    // assim gastava IA paga aqui. Fail-closed: erro de leitura = recusa (mesma regra do AuthContext).
    const supabaseGate = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const [rolesRes, perfilRes] = await Promise.all([
      supabaseGate.from("user_roles").select("role").eq("user_id", user.id).in("role", ["employee", "master"]).limit(1),
      supabaseGate.from("profiles").select("is_approved").eq("user_id", user.id).maybeSingle(),
    ]);
    if (rolesRes.error || perfilRes.error) {
      return new Response(
        JSON.stringify({ error: "Não autorizado" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const ehStaff = Array.isArray(rolesRes.data) && rolesRes.data.length > 0;
    if (!ehStaff && perfilRes.data?.is_approved !== true) {
      return new Response(
        JSON.stringify({ error: "Cadastro aguardando aprovação" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Já parseado acima (para a sonda); o throw do corpo inválido é relançado no ponto antigo.
    if (erroParseCorpo !== null) throw erroParseCorpo;
    const { text, userTools } = corpoBruto;

    // Input validation
    if (!text || typeof text !== "string") {
      return new Response(
        JSON.stringify({ error: "Texto é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (text.length > 5000) {
      return new Response(
        JSON.stringify({ error: "Texto muito longo (máximo 5000 caracteres)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (userTools && (!Array.isArray(userTools) || userTools.length > 100)) {
      return new Response(
        JSON.stringify({ error: "Lista de ferramentas inválida (máximo 100)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }

    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // COTA — depois da validação (requisição malformada não queima cota) e antes
    // da Anthropic. Também poupa a consulta de serviços quando a cota já estourou.
    // O gate acima deixa passar todo cliente aprovado: sem isto, um cliente repetindo
    // pedidos com 100 ferramentas esgota o orçamento da ORGANIZAÇÃO — os limites da
    // Anthropic não são por usuário da aplicação.
    const cota = await consumirCota(supabase, user.id, "analyze-services", "análises de pedido");
    if (!cota.permitido) {
      return new Response(
        JSON.stringify({ error: cota.mensagem }),
        {
          status: cota.http,
          headers: { ...corsHeaders, ...headersDeCota(cota), "Content-Type": "application/json" },
        },
      );
    }

    // Buscar serviços disponíveis do banco
    const { data: servicos, error: dbError } = await supabase
      .from("omie_servicos")
      .select("omie_codigo_servico, descricao")
      .eq("inativo", false);

    if (dbError) {
      console.error("Erro ao buscar serviços:", dbError);
      throw new Error("Erro ao buscar serviços disponíveis");
    }

    // Ferramentas do body, serviços do banco e o texto do pedido vão na MENSAGEM, em blocos de dado;
    // o system é a constante SYSTEM_PROMPT_SERVICOS (scanner Lovable, lote 7 — servico-prompt.ts).
    const tools = userTools as UserTool[] || [];
    const mensagemDoPedido = montarMensagemServicos({ ferramentas: tools, servicos, texto: text });

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    let resposta;
    try {
      resposta = await anthropic.messages.create({
        model: MODELO_PADRAO,
        max_tokens: 2000,
        system: SYSTEM_PROMPT_SERVICOS,
        tools: [TOOL_SERVICOS],
        // `type:'tool'` sozinho não desliga chamada paralela: o modelo poderia
        // devolver um bloco por ferramenta e o consumo pegaria só o primeiro,
        // montando um pedido PARCIAL com cara de completo.
        tool_choice: { type: "tool", name: TOOL_SERVICOS.name, disable_parallel_tool_use: true },
        messages: [{ role: "user", content: mensagemDoPedido }],
      });
    } catch (e: unknown) {
      const status = statusDoErro(e);
      console.error("[analyze-services] erro na API da Anthropic:", status, e instanceof Error ? e.message : e);
      const mapeado = traduzirErroAnthropic(status);
      return new Response(
        JSON.stringify({ error: mapeado?.mensagem ?? "Erro ao processar com IA" }),
        { status: mapeado?.http ?? 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Truncou = lista de itens cortada no meio. O cliente confirmaria um pedido
    // com 2 de 5 ferramentas achando que pediu todas.
    if (resposta.stop_reason === "max_tokens") {
      console.error("[analyze-services] resposta truncada");
      return new Response(
        JSON.stringify({ error: "Pedido longo demais para analisar de uma vez. Divida em duas partes." }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const extraido = extrairToolUseUnico(resposta.content);
    const result = extraido.ok ? objetoDaTool(extraido.input) : null;

    if (result === null) {
      return new Response(
        JSON.stringify({
          items: [],
          message: "Não consegui identificar ferramentas ou serviços. Por favor, seja mais específico ou selecione manualmente.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // O filtro por ferramenta REAL do cliente já existia; o que faltava era a
    // disciplina de TIPO — `quantity` multiplica o preço do serviço, e string ou
    // zero ali vira valor errado na nota.
    const idsValidos = new Set(tools.map((t) => t.id));
    const { itens, descartados } = normalizarItens(result.items, idsValidos);
    if (descartados > 0) {
      console.warn(`[analyze-services] ${descartados} item(ns) descartado(s) por dado inválido`);
    }

    const mensagem = typeof result.message === "string" && result.message.trim()
      ? result.message.trim()
      : `Identificado ${itens.length} item(s) para o pedido.`;

    return new Response(
      JSON.stringify({
        items: itens,
        message: descartados > 0
          ? `${mensagem} (${descartados} item(ns) não reconhecido(s) foram deixados de fora — confira antes de enviar.)`
          : mensagem,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Erro na função analyze-services:", error);
    return new Response(
      JSON.stringify({ error: "Erro ao processar solicitação" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
