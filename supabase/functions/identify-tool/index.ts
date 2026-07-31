import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import {
  extrairToolUseUnico,
  MODELO_PADRAO,
  statusDoErro,
  traduzirErroAnthropic,
} from "../_shared/anthropic.ts";
import { montarBlocoImagem } from "../_shared/imagem.ts";
import { consumirCota, headersDeCota } from "../_shared/ia-cota.ts";
import { naoIdentificada, normalizarFerramenta, TOOL_FERRAMENTA } from "./ferramenta-tools.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// O limite é sobre a string BASE64, que é ~4/3 do binário. Com 5 MiB aqui, a
// foto de 4 MiB que a tela aceita (limite de 5 MiB no ARQUIVO) virava 5.592.408
// caracteres e era recusada — o usuário via "imagem muito grande" para um
// arquivo dentro do limite anunciado. 8 MiB de base64 ≈ 6 MiB de arquivo, com
// folga sob o teto de 10 MB da API.
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");

    const { imageBase64, categories } = await req.json();

    // Input validation
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return new Response(JSON.stringify({ error: "Imagem não fornecida" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (imageBase64.length > MAX_IMAGE_SIZE) {
      return new Response(JSON.stringify({ error: "Imagem muito grande (máximo 5MB)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (categories && (!Array.isArray(categories) || categories.length > 50)) {
      return new Response(JSON.stringify({ error: "Lista de categorias inválida" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // COTA — depois da validação (requisição malformada não queima cota do
    // usuário) e antes da Anthropic. O gate acima só exige JWT válido: sem isto,
    // um cliente repetindo fotos de até 8 MB esgota o orçamento da ORGANIZAÇÃO e
    // derruba a IA de todo mundo, em todas as edges.
    const supabaseCota = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const cota = await consumirCota(
      supabaseCota,
      user.id,
      "identify-tool",
      "identificações por foto",
    );
    if (!cota.permitido) {
      return new Response(JSON.stringify({ error: cota.mensagem }), {
        status: cota.http,
        headers: { ...corsHeaders, ...headersDeCota(cota), "Content-Type": "application/json" },
      });
    }

    // Build categories context for the AI
    const categoriesContext = (categories || [])
      .map((c: { name: string; description?: string }) => `- ${c.name}${c.description ? ` (${c.description})` : ''}`)
      .join('\n');

    const systemPrompt = `Você é um especialista em identificação de ferramentas de corte industriais (serras, facas, lâminas, brocas, fresas, etc.) usadas em marcenarias, serralharias e indústrias.

Analise a imagem enviada e identifique a ferramenta, preenchendo:
- "identified": true/false (se conseguiu identificar)
- "category_name": nome da categoria mais provável (deve corresponder a uma das categorias cadastradas abaixo)
- "confidence": "alta", "media" ou "baixa"
- "description": descrição breve do que foi identificado
- "specs_detected": objeto com especificações que você consegue identificar visualmente (como diâmetro aproximado, número de dentes, tipo de material, geometria do dente, etc.)
- "suggested_services": array de strings com serviços sugeridos (ex: "Afiação", "Retífica", "Troca de dentes")

Categorias cadastradas no sistema:
${categoriesContext || 'Nenhuma categoria fornecida'}

IMPORTANTE: 
- Seja preciso na identificação.
- Se não conseguir identificar com certeza, indique confidence "baixa".
- O category_name DEVE corresponder exatamente a uma das categorias listadas acima quando possível.
- Responda SEMPRE usando a função identificar_ferramenta.`;

    // Media type vem dos MAGIC BYTES. O gateway antigo sniffava o conteúdo e
    // engolia o rótulo fixo `image/jpeg`; a Anthropic valida o declarado — e a
    // foto aqui sai da câmera do celular do balcão, onde HEIC é comum.
    const anexo = montarBlocoImagem(imageBase64);
    if (!anexo.ok) {
      return new Response(JSON.stringify(naoIdentificada(anexo.erro)), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    let resposta;
    try {
      resposta = await anthropic.messages.create({
        model: MODELO_PADRAO,
        max_tokens: 1500,
        system: systemPrompt,
        tools: [TOOL_FERRAMENTA],
        tool_choice: { type: "tool", name: TOOL_FERRAMENTA.name, disable_parallel_tool_use: true },
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Identifique esta ferramenta na imagem:" },
            anexo.bloco,
          ],
        }],
      });
    } catch (e: unknown) {
      const status = statusDoErro(e);
      console.error("[identify-tool] erro na API da Anthropic:", status, e instanceof Error ? e.message : e);
      const mapeado = traduzirErroAnthropic(status);
      return new Response(JSON.stringify({ error: mapeado?.mensagem ?? "Erro ao processar imagem" }), {
        status: mapeado?.http ?? 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Truncou = leitura incompleta da ferramenta. Devolver "não identifiquei" é
    // honesto; devolver metade das specs seria uma ficha técnica pela metade
    // com cara de completa.
    if (resposta.stop_reason === "max_tokens") {
      console.error("[identify-tool] resposta truncada");
      return new Response(
        JSON.stringify(naoIdentificada("A leitura da foto ficou incompleta. Tente de novo.")),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const extraido = extrairToolUseUnico(resposta.content);
    const nomesCategorias = (categories || []).map((c: { name: string }) => c.name).filter(Boolean);
    const parsed = extraido.ok ? normalizarFerramenta(extraido.input, nomesCategorias) : null;

    if (parsed === null) {
      console.error(
        `[identify-tool] sem leitura utilizável (motivo: ${extraido.ok ? "campos inválidos" : extraido.motivo})`,
      );
      return new Response(
        JSON.stringify(naoIdentificada("Não foi possível analisar a imagem")),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("identify-tool error:", error);
    return new Response(
      JSON.stringify({ error: "Erro ao processar solicitação" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
