// supabase/functions/tarefa-extrair-voz/index.ts
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { createClient } from "npm:@supabase/supabase-js@^2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SYSTEM_PROMPT = `Você estrutura COMANDOS DE VOZ de um gestor que está criando tarefas para vendedoras de uma distribuidora B2B.

Sua ÚNICA função é entender e SEPARAR as tarefas ditas, e extrair STRINGS CRUAS. Você NÃO resolve datas (não calcule dia/mês), NÃO escolhe ids, NÃO inventa nada.

Regras:
- Um comando pode conter VÁRIAS tarefas (clientes/vendedoras diferentes). Separe cada ação imperativa numa tarefa. Em "manda a Regina ligar pro Zé amanhã e whatsapp pra Maria sexta" há 2 tarefas.
- Para CADA tarefa, preencha:
  - evidence_text: o TRECHO LITERAL da transcrição de onde essa tarefa veio.
  - descricao: o que a vendedora precisa fazer, em 1 frase clara.
  - categoria_palpite: "ligar" (telefonar), "oferecer" (apresentar/oferecer item), "preco" (passar/orçar preço), "whatsapp" (mandar zap/whatsapp), "outro". null se incerto.
  - cliente_nome_falado: o NOME do cliente exatamente como foi dito (string). null se não foi dito.
  - vendedora_nome_falado: o nome da vendedora dito. As vendedoras conhecidas estão no input ("vendedoras"). Se um nome dito casar com uma delas, é a vendedora; outros nomes de pessoa são CLIENTES, não vendedoras. null se nenhuma vendedora foi dita.
  - raw_date_text: a FRASE de tempo exatamente como dita ("amanhã", "sexta que vem", "dia 15", "semana que vem"). NÃO calcule a data. null se nenhum prazo foi dito.
  - target_texto: para "oferecer"/"preco", o item/produto/preço mencionado. null caso contrário.
- detectei_n: quantas tarefas você detectou.
- texto_nao_coberto: qualquer trecho IMPERATIVO da transcrição que você NÃO transformou em tarefa (ou null). Serve para o gestor não perder nada.
- NUNCA invente cliente, vendedora ou data. Se não foi dito, use null.
- SEMPRE chame a tool extrair_tarefas com o JSON completo.`;

const TOOL = {
  name: "extrair_tarefas",
  description: "Retorna as tarefas extraídas do comando de voz (apenas strings cruas).",
  input_schema: {
    type: "object",
    properties: {
      detectei_n: { type: "number" },
      texto_nao_coberto: { type: ["string", "null"] },
      tarefas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            evidence_text: { type: "string" },
            descricao: { type: "string" },
            categoria_palpite: { type: ["string", "null"], enum: ["ligar", "oferecer", "preco", "whatsapp", "outro", null] },
            cliente_nome_falado: { type: ["string", "null"] },
            vendedora_nome_falado: { type: ["string", "null"] },
            raw_date_text: { type: ["string", "null"] },
            target_texto: { type: ["string", "null"] },
          },
          required: ["evidence_text", "descricao", "categoria_palpite", "cliente_nome_falado", "vendedora_nome_falado", "raw_date_text", "target_texto"],
        },
      },
    },
    required: ["detectei_n", "texto_nao_coberto", "tarefas"],
  },
} as const;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // Gate master/gestor (não basta staff): cron/service_role passam; staff exige carteira completa.
  if (auth.via === "staff") {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: pode, error } = await admin.rpc("pode_ver_carteira_completa", { _uid: auth.userId });
    if (error || pode !== true) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const body = await req.json();
    const transcricao = String(body?.transcricao ?? "").trim();
    const hoje = String(body?.hoje ?? "");
    const vendedoras: Array<{ nome: string }> = Array.isArray(body?.vendedoras) ? body.vendedoras : [];
    if (!transcricao) return new Response(JSON.stringify({ error: "transcricao vazia" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const userMsg = `Hoje é ${hoje} (America/Sao_Paulo). Vendedoras conhecidas: ${vendedoras.map((v) => v.nome).join(", ") || "(nenhuma)"}.\n\nComando de voz transcrito:\n"""${transcricao}"""\n\nExtraia as tarefas e chame a tool extrair_tarefas.`;

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [TOOL],
      tool_choice: { type: "tool", name: "extrair_tarefas" },
      messages: [{ role: "user", content: userMsg }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return new Response(JSON.stringify({ error: "IA não retornou estrutura" }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const out = toolUse.input as { detectei_n?: number; texto_nao_coberto?: string | null; tarefas?: unknown[] };
    if (!Array.isArray(out?.tarefas)) {
      return new Response(JSON.stringify({ error: "saída fora do schema" }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify(out), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "erro" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
