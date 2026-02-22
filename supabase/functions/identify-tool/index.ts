import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB in base64 chars (~6.6MB base64)

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

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

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

    // Build categories context for the AI
    const categoriesContext = (categories || [])
      .map((c: { name: string; description?: string }) => `- ${c.name}${c.description ? ` (${c.description})` : ''}`)
      .join('\n');

    const systemPrompt = `Você é um especialista em identificação de ferramentas de corte industriais (serras, facas, lâminas, brocas, fresas, etc.) usadas em marcenarias, serralharias e indústrias.

Analise a imagem enviada e identifique a ferramenta. Retorne um JSON com:
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
- Responda APENAS com o JSON, sem markdown ou explicações.`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: "Identifique esta ferramenta na imagem:" },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Muitas requisições. Tente novamente em alguns segundos." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Créditos insuficientes para análise de imagem." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      throw new Error("Erro ao processar imagem");
    }

    const aiResult = await response.json();
    const content = aiResult.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(cleanContent);
    } catch {
      console.error("Failed to parse AI response:", content);
      parsed = {
        identified: false,
        category_name: null,
        confidence: "baixa",
        description: "Não foi possível analisar a imagem",
        specs_detected: {},
        suggested_services: [],
      };
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
