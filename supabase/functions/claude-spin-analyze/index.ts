import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

// System prompt INLINE (copiado de src/lib/spin/spin-prompts.ts pra evitar
// dependência cross-package; manter sincronizado quando atualizar).
const SYSTEM_PROMPT_SPIN = `Você é um copiloto de vendas SPIN ao vivo para vendedores da Colacor — distribuidora de tintas industriais Sayerlack para o segmento moveleiro brasileiro.

Sua missão: durante uma chamada telefônica entre vendedor e cliente, analisar o transcript em tempo real e sugerir EXATAMENTE qual a próxima pergunta SPIN ideal pro vendedor fazer, baseado no estágio da conversa.

## Framework SPIN (Neil Rackham)

Toda venda consultiva passa por 4 tipos de pergunta, nesta ordem ideal:

1. **Situation** — perguntas factuais que mapeiam o contexto do cliente.
   Ex: "Qual o volume mensal de tinta que vocês usam hoje?", "Quantos operadores na cabine?"
   Use no INÍCIO da chamada. Não abuse — clientes se cansam de perguntas factuais.

2. **Problem** — perguntas que revelam dificuldades, insatisfações, gaps.
   Ex: "Vocês têm tido problema de acabamento no PU?", "A entrega da concorrência costuma atrasar?"
   Use quando você já mapeou a situação e quer expor dores.

3. **Implication** — perguntas que amplificam o impacto dos problemas que o cliente admitiu.
   Ex: "Esses atrasos têm gerado retrabalho na sua linha?", "Quanto isso custa por mês em horas perdidas?"
   USE MUITO. É o estágio que constrói a urgência. SPIN ganha aqui.

4. **Need-payoff** — perguntas que fazem o cliente articular o VALOR de resolver o problema.
   Ex: "Se a entrega fosse 100% no prazo, o que isso destravaria pra produção de vocês?"
   Use quando o cliente já admitiu problemas + implicações. Prepara o close.

## Contexto Sayerlack/Colacor

- Produto: tintas PU automotivas + linhas Hydropoxi (água), Wood (madeira), Auto (auto).
- Cliente típico: indústria moveleira, marcenaria de médio porte, oficina automotiva.
- Concorrentes: Renner, Pantone, Brasilac, importados.
- Diferenciais Colacor: distribuição rápida, suporte técnico, fórmulas customizadas.
- Atritos comuns: prazo de entrega, validade de lote, qualidade de acabamento, preço vs importado.

## Sua tarefa

A cada chamada da minha tool \`spin_analysis\`, você recebe o transcript bidirecional (vendedor + cliente) acumulado até agora. Você deve:

1. Identificar o **estágio atual** da conversa (opening / situation / problem / implication / need-payoff / closing).
2. Mapear o que o cliente JÁ REVELOU (fatos, problemas admitidos, implicações, desejos).
3. Sugerir a **próxima ação ideal** pro vendedor — geralmente uma pergunta SPIN com texto EXATO pra falar em PT-BR natural mineiro/brasileiro neutro.
4. Sinalizar riscos detectados (objeção de preço, menção a concorrente, falta de urgência, etc).
5. Identificar hints de cross-sell (cliente mencionou produto adjacente).

## Regras de saída

- **SEMPRE use a tool \`spin_analysis\`** com o JSON estruturado completo.
- **Texto da sugestão deve ser EXATO** — vendedor vai LER literalmente. PT-BR natural, sem jargão de SPIN ("isso é uma pergunta de Implication" — NUNCA fale isso pro vendedor; fale só pra ferramenta).
- **Seja específico ao contexto do cliente** — não use perguntas genéricas, use as palavras que o cliente acabou de usar.
- **Se o cliente ainda não falou nada relevante** (só opening trivial), retorne uma pergunta de Situation pra começar a mapear.
- **NÃO invente fatos** — só liste em \`whatClientRevealed\` o que efetivamente apareceu no transcript.
- **Confiança baixa (<0.6)** se transcript curto/ambíguo; alta (>0.8) se evidência clara.`;

// JSON Schema da tool spin_analysis — força Claude a retornar shape exato
const SPIN_ANALYSIS_TOOL = {
  name: "spin_analysis",
  description: "Retorna a análise SPIN estruturada da conversa atual.",
  input_schema: {
    type: "object",
    properties: {
      spinStage: {
        type: "string",
        enum: ["opening", "situation", "problem", "implication", "need_payoff", "closing"],
        description: "Estágio atual da conversa segundo SPIN",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Confiança da análise (0-1)",
      },
      whatClientRevealed: {
        type: "object",
        properties: {
          situationFacts: { type: "array", items: { type: "string" } },
          problemsAdmitted: { type: "array", items: { type: "string" } },
          implications: { type: "array", items: { type: "string" } },
          desiredOutcomes: { type: "array", items: { type: "string" } },
        },
        required: ["situationFacts", "problemsAdmitted", "implications", "desiredOutcomes"],
      },
      nextBestAction: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["question", "response", "transition", "close", "listen"],
          },
          spinType: {
            type: ["string", "null"],
            enum: ["opening", "situation", "problem", "implication", "need_payoff", "closing", null],
          },
          exactPhrasing: { type: "string", description: "Texto EXATO pro vendedor falar (PT-BR)" },
          whyNow: { type: "string", description: "Rationale curto (max 1 frase)" },
        },
        required: ["type", "spinType", "exactPhrasing", "whyNow"],
      },
      risks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "price_objection",
                "competitor_mentioned",
                "lack_of_urgency",
                "wrong_decision_maker",
                "technical_doubt",
                "other",
              ],
            },
            severity: { type: "string", enum: ["low", "medium", "high"] },
            note: { type: "string" },
          },
          required: ["type", "severity", "note"],
        },
      },
      crossSellTriggers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            productHint: { type: "string" },
            triggerPhrase: { type: "string" },
          },
          required: ["productHint", "triggerPhrase"],
        },
      },
    },
    required: [
      "spinStage",
      "confidence",
      "whatClientRevealed",
      "nextBestAction",
      "risks",
      "crossSellTriggers",
    ],
  },
};

interface TurnPayload {
  speaker: "vendedor" | "cliente";
  text: string;
  isFinal: boolean;
  startedAt: number;
}

function buildUserMessage(turns: TurnPayload[]): string {
  if (turns.length === 0) {
    return "Transcript ainda vazio — aguardando conversa começar. Sem turnos para analisar.\n\nAinda assim, retorne uma análise inicial via spin_analysis com sugestão de pergunta de abertura típica de Situation.";
  }
  const formatted = turns
    .map((t) => {
      const speaker = t.speaker === "vendedor" ? "[VENDEDOR]" : "[CLIENTE]";
      const interim = t.isFinal ? "" : " [interim]";
      return `${speaker}${interim}: ${t.text}`;
    })
    .join("\n");
  return `Transcript acumulado da chamada até agora:\n\n${formatted}\n\nAnalise e chame a tool spin_analysis com o JSON estruturado completo.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const turns: TurnPayload[] = Array.isArray(body?.turns) ? body.turns : [];

    const client = new Anthropic({ apiKey });

    // Estratégia de cache: system prompt fica num único breakpoint cacheado (ephemeral, TTL 5min).
    // Próximas chamadas com mesmo system pegam cache hit ~90% e custo cai pra ~$0.005/call.
    const response = await client.messages.create({
      model: "claude-sonnet-4-6", // alias canônico (sem sufixo de data) — Sonnet 4.6 most recent
      max_tokens: 1500,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT_SPIN,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [SPIN_ANALYSIS_TOOL],
      tool_choice: { type: "tool", name: "spin_analysis" },
      messages: [
        {
          role: "user",
          content: buildUserMessage(turns),
        },
      ],
    });

    // Extrai o tool_use block
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      console.error("No tool_use in response:", JSON.stringify(response));
      return new Response(
        JSON.stringify({ error: "Claude não retornou tool_use válido", raw: response }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        analysis: toolUse.input,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("claude-spin-analyze error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
