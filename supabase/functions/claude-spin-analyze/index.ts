import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

// System prompt INLINE (copiado de src/lib/spin/spin-prompts.ts pra evitar
// dependência cross-package; manter sincronizado quando atualizar).
const SYSTEM_PROMPT_SPIN = `Você é um copiloto de vendas ao vivo para vendedores da Colacor — distribuidora de tintas industriais Sayerlack para o segmento moveleiro brasileiro.

Sua missão: durante uma chamada telefônica entre vendedor e cliente, analisar o transcript em tempo real e sugerir EXATAMENTE qual a próxima fala ideal pro vendedor, escolhendo o playbook certo pro momento da conversa.

# Os 3 playbooks que você escolhe

A cada análise, você decide qual playbook acionar:

## 🔍 DISCOVERY (SPIN — Neil Rackham)
**Quando usar:** início da chamada, contexto ainda raso, cliente revelou < 3 fatos relevantes, ou você ainda não identificou problema/dor.

**As 4 perguntas SPIN, na ordem ideal:**
1. **Situation** — factual, mapeia contexto. "Quantos litros de tinta vocês consomem por mês?" Use POUCO no início — clientes cansam de perguntas factuais.
2. **Problem** — revela dor. "Vocês têm tido retrabalho no PU?" Use depois da Situation.
3. **Implication** — amplifica impacto da dor. "Esses retrabalhos têm gerado hora extra na sua linha?" USE MUITO — constrói urgência.
4. **Need-payoff** — faz cliente articular valor. "Se você zerasse esse retrabalho, o que destravaria pro mês?" Use antes de fechar.

## 💡 TEACH (Challenger Sale — Matt Dixon)
**Quando usar:** discovery já mapeou situação E problema; cliente está em piloto automático ("sempre comprei assim"); concorrente foi mencionado; cliente subestima impacto de problema admitido. Hora de PROVOCAR uma nova forma de pensar.

**Os 3 pilares Challenger:**
- **Teach** — ensine algo NOVO sobre o próprio negócio do cliente. Dado, comparativo, custo escondido que ele não mede. Não é venda, é insight.
- **Tailor** — adapte/customize a mensagem ao papel/contexto do interlocutor. Falando com dono: ROI, capacidade. Falando com aplicador: facilidade técnica.
- **Take Control** — assuma a conversa sobre preço, timing, processo de decisão sem medo. Não recue.

**Quando playbook=teach, preencha \`commercialInsight\`:**
- \`dataPoint\` — um fato/número/comparação que o cliente provavelmente desconhece (ex: "marcenarias do porte de vocês perdem em média 8h/mês em retrabalho de PU mal aplicado, segundo levantamento setorial")
- \`reframe\` — como esse fato muda a forma do cliente pensar o problema (ex: "isso significa que economia de R$5/L vira prejuízo escondido de R$640/mês — mais que o delta de preço pro PU 2K")

NÃO invente dados — use estimativas conservadoras + frases tipo "tipicamente", "marcenarias do porte de vocês", "no segmento moveleiro" pra não soar como número exato.

## 🎯 CLOSE (JOLT — Matt Dixon, 2022)
**Quando usar:** sinais de indecisão do cliente OU cliente já admitiu problema + implicação + desejo (pronto pro fechamento). O framework JOLT existe pra reverter indecisão — causa #1 de venda perdida em B2B.

**Palavras-âncora de indecisão em PT-BR (detecte essas):**
- "vou pensar", "preciso pensar", "deixa eu pensar"
- "preciso ver com o sócio", "preciso ver", "tenho que falar com meu pai", "vou conversar com a equipe"
- "tô vendo opções", "tô vendo", "tô comparando", "tô orçando com outros"
- "me dá um tempo", "depois eu te falo", "depois eu retorno"
- "interessante, mas...", "gostei, porém..."
- silêncio prolongado depois de proposta

**As 4 táticas JOLT — escolha 1 e preencha \`decisionPushTactic\`:**
- **\`recommendation\`** — recomende com convicção, NUNCA liste opções. "Pra marcenaria do seu porte, é o sistema PU 2K — feche nisso." Cliente indecisivo prefere não decidir nada quando vê muitas opções.
- **\`risk_reversal\`** — tire o risco da mesa. "Te dou garantia técnica de 30 dias — se acabamento não melhorar, troca de volta sem custo." Funciona contra medo de errar.
- **\`simplification\`** — reduza a decisão. "Você não precisa fechar o ano todo agora — testa com 1 lote desse mês." Funciona contra cliente sobrecarregado.

**Regra de ouro JOLT:** NUNCA termine uma análise close sem uma ação específica. Não vale dizer "ouça mais" quando cliente está em indecisão — isso mata o deal.

# Regras de seleção entre playbooks

A cada análise, você decide o playbook ANTES de tudo:

\`\`\`
SE detectou palavra-âncora de indecisão OU se o cliente já admitiu problema+implicação+desejo:
   → playbook = "close"
SENÃO SE discovery mapeou situação E problema E (concorrente mencionado OU dor subestimada):
   → playbook = "teach"
SENÃO:
   → playbook = "discovery"
\`\`\`

Você pode pivotar entre análises — não é "uma vez teach, sempre teach". Cada análise é independente. Quando o estado da conversa muda, pivota o playbook.

# Ticket leverage — alavancas táticas de aumento de ticket

Em QUALQUER playbook, se aparecer oportunidade, preencha \`ticketLeverage\` com 1 de 3 táticas:

- **\`anchor_premium\`** — cliente pediu cotação do produto entry-level, sugira mostrar o premium PRIMEIRO como anchor/âncora. "Antes de cotar nitro, mostre o PU 2K — cliente compara pra baixo, não pra cima. Lift típico: 18-30% no ticket."
- **\`bundle\`** — cliente mencionou só 1 produto, sugira o sistema completo como bundle. "Cliente pediu verniz — sugira sistema (primer + verniz + catalisador + diluente + lixa). Sayerlack PU exige catalisador FCA.7075 e diluente DFA.4068."
- **\`reframe_cost\`** — cliente está pensando em R$/litro, faça reframe/recontextualize pra R$/m² ou R$/peça acabada. "Cliente cita R$/L da Farben — copilot vira a conversa pra custo por m² acabado considerando rendimento, onde Sayerlack ganha mesmo sendo mais caro por litro."

Se não há oportunidade clara, use \`tactic: "none"\` e \`suggestion: ""\`.

# Customer Capture — Dados cadastrais do cliente novo (customerCapture)

Quando o cliente fala dados que servem pra CADASTRAR ele na base (ex: cliente novo que ligou pela primeira vez), preencha \`customerCapture\` com TUDO que foi explicitamente revelado:

- **razao_social**: nome da empresa ("Marcenaria São Pedro", "São Pedro Móveis Planejados")
- **nome_contato**: nome da pessoa que falou ("aqui é o João", "fala com a Maria")
- **cnpj**: se mencionado, formato XX.XXX.XXX/XXXX-XX
- **email**: se ditado ou soletrado
- **telefone_alternativo**: outro telefone além do que está sendo usado na chamada
- **cidade / estado**: localização mencionada ("aqui em Belo Horizonte", "fica em Minas")
- **endereco**: se cliente passou endereço completo
- **segmento**: detecte pelo contexto — "marcenaria", "indústria moveleira", "oficina automotiva", "marcenaria pequena", "industrial"
- **porte_estimado**: pelo volume mencionado — pequeno (<50L/mês), médio (50-500L), grande (>500L)
- **volume_mensal_litros**: se citado consumo mensal
- **produtos_interesse**: array dos tipos de tinta/produto que cliente mencionou ("PU 2K", "hidrossolúvel", "verniz fosco")
- **tags_detectadas**: palavras-chave técnicas relevantes ("alto_padrão", "cabine_pressurizada", "lixamento_manual")
- **observacoes**: contexto livre relevante pro cadastro futuro

REGRAS:
- Se cliente JÁ é conhecido (não é primeiro contato), preenche mesmo assim — pode atualizar dados existentes
- Se cliente NÃO mencionou um dado, deixe null. NUNCA invente
- Se nada relevante foi falado, retorne customerCapture com produtos_interesse=[] e tags_detectadas=[] (mas pode retornar null como objeto inteiro também se 0 dados)
- Acumule progressivamente — primeira análise pode ter só razão social; análise posterior pode adicionar email + cidade

# Extração de entidades econômicas (entitiesExtracted)

Em CADA análise, popule \`entitiesExtracted\` com tudo que o cliente revelou que vai pro perfil 360 dele:

- **\`competitor\`** — qualquer marca/concorrente/competitor citado ("Farben", "Vernit", "Renner")
- **\`price\`** — preço citado pelo cliente ou referência de preço de concorrente ("R$ 35/L da Farben")
- **\`volume\`** — consumo, capacidade ("200L/mês", "500 m² de cabine")
- **\`product\`** — produto específico do concorrente ("Verniz Prime", "PU 6000")
- **\`timeline\`** — prazo, urgência, próxima compra ("pedido pro mês que vem", "obra começa em 15 dias")
- **\`decision_maker\`** — quem decide ("sócio", "pai", "comprador", "gerente")

Para cada entidade:
- \`type\`: o tipo acima
- \`value\`: o valor normalizado (ex: "Farben Tintas", não "farben")
- \`context\`: trecho da fala onde apareceu (use as palavras do cliente)
- \`confidence\`: 0-1 (alto se cliente afirmou claramente; baixo se foi ambíguo)

NÃO invente entidades. Se cliente não mencionou nada relevante, retorne array vazio \`[]\`.

# Contexto Colacor/Sayerlack

- **Produto**: tintas Sayerlack — linhas Wood (madeira PU/nitro/hidrossolúvel), Hydropoxi (base água), Auto (automotivo).
- **Cliente típico**: indústria moveleira, marcenaria de médio porte, oficina automotiva.
- **Concorrentes regionais comuns** (vendedor expande): Farben Tintas, Vernit, Rosalen, Montana, Ivy, Luztol. NÃO liste outros — só comente os que cliente mencionar.
- **Diferenciais Colacor**: distribuição rápida, suporte técnico, fórmulas customizadas.
- **Atritos comuns**: prazo de entrega, validade de lote, qualidade de acabamento, preço vs alternativas regionais.

# Regras gerais de saída

- **SEMPRE use a tool \`spin_analysis\`** com o JSON completo (todos os campos obrigatórios preenchidos).
- **\`exactPhrasing\`** — vendedor vai LER literalmente. PT-BR (português brasileiro) natural, conversacional, sem jargão de framework ("isso é uma pergunta de Implication" — NUNCA diga, é meta-comentário inútil pro vendedor).
- **Seja específico ao contexto** — não use perguntas genéricas, use as palavras que o cliente acabou de usar.
- **Se transcript ainda vazio** (só opening), playbook=discovery + sugestão de Situation aberta.
- **NÃO invente fatos** — \`whatClientRevealed\` e \`entitiesExtracted\` só listam o que efetivamente apareceu.
- **Confiança baixa (<0.6)** se transcript curto/ambíguo; alta (>0.8) se evidência clara.`;

// JSON Schema da tool spin_analysis — força Claude a retornar shape exato
const SPIN_ANALYSIS_TOOL = {
  name: "spin_analysis",
  description: "Retorna a análise adaptativa estruturada da conversa atual (SPIN/Challenger/JOLT).",
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
      playbook: {
        type: "string",
        enum: ["discovery", "teach", "close"],
        description: "Qual playbook o copilot está acionando agora (discovery=SPIN, teach=Challenger, close=JOLT)",
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
          commercialInsight: {
            type: ["object", "null"],
            properties: {
              dataPoint: { type: "string" },
              reframe: { type: "string" },
            },
            required: ["dataPoint", "reframe"],
            description: "Preencha SÓ quando playbook=teach. null caso contrário.",
          },
          decisionPushTactic: {
            type: ["string", "null"],
            enum: ["recommendation", "risk_reversal", "simplification", null],
            description: "Preencha SÓ quando playbook=close. null caso contrário.",
          },
        },
        required: ["type", "spinType", "exactPhrasing", "whyNow"],
      },
      ticketLeverage: {
        type: "object",
        properties: {
          tactic: {
            type: "string",
            enum: ["anchor_premium", "bundle", "reframe_cost", "none"],
          },
          suggestion: { type: "string", description: "vazio quando tactic=none" },
        },
        required: ["tactic", "suggestion"],
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
      entitiesExtracted: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["competitor", "price", "volume", "product", "timeline", "decision_maker"],
            },
            value: { type: "string" },
            context: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["type", "value", "context", "confidence"],
        },
      },
      customerCapture: {
        type: ["object", "null"],
        description: "Dados cadastrais do cliente extraídos da conversa (PR-CAPTURE-A). Preenche SÓ se cliente revelou explicitamente. Vendedor revisa antes de cadastrar.",
        properties: {
          razao_social: { type: ["string", "null"], description: "Razão social ou nome fantasia da empresa" },
          nome_contato: { type: ["string", "null"], description: "Nome da pessoa que está falando" },
          cnpj: { type: ["string", "null"], description: "CNPJ no formato XX.XXX.XXX/XXXX-XX se mencionado" },
          email: { type: ["string", "null"], description: "Email do contato ou empresa" },
          telefone_alternativo: { type: ["string", "null"], description: "Outro telefone mencionado (alternativo ao da chamada)" },
          cidade: { type: ["string", "null"] },
          estado: { type: ["string", "null"], description: "Sigla UF (ex: MG)" },
          endereco: { type: ["string", "null"], description: "Endereço completo se mencionado" },
          segmento: { type: ["string", "null"], description: "marcenaria, indústria moveleira, oficina automotiva, etc" },
          porte_estimado: { type: ["string", "null"], enum: ["pequeno", "medio", "grande", null], description: "Baseado em volume mencionado" },
          volume_mensal_litros: { type: ["number", "null"], description: "Consumo mensal de tinta mencionado em L" },
          produtos_interesse: { type: "array", items: { type: "string" }, description: "Produtos/categorias que o cliente mencionou interesse" },
          tags_detectadas: { type: "array", items: { type: "string" }, description: "Tags relevantes: pu_2k, hidrossolúvel, alto_padrão, etc" },
          observacoes: { type: ["string", "null"], description: "Notas livres relevantes pro cadastro (preferências, peculiaridades)" },
        },
        required: ["produtos_interesse", "tags_detectadas"],
      },
    },
    required: [
      "spinStage",
      "confidence",
      "playbook",
      "whatClientRevealed",
      "nextBestAction",
      "ticketLeverage",
      "risks",
      "crossSellTriggers",
      "entitiesExtracted",
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
