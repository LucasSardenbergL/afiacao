// supabase/functions/melhoria-triagem/index.ts
// Triagem por IA do canal de Melhorias. Anthropic direto (caminho canônico (a) do CLAUDE.md):
// claude-sonnet-4-6 + forced tool-use + prompt caching. Loop agentic com 2 tools de dados
// (RPCs com o JWT do CALLER — só quando caller == autor do item) + tool terminal `triar`.
// A captação NUNCA depende daqui: falha => triagem_status='erro' e o item segue na fila.
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { createClient } from "npm:@supabase/supabase-js@^2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const MAX_MENSAGENS_FUNCIONARIO = 6;
const MAX_TOOL_CALLS_DADOS = 3;

// ===== Espelho VERBATIM de src/lib/melhorias/types.ts + triagem-helpers.ts =====
// (Deno não importa do src/; ao alterar lá, alterar aqui.)

const MELHORIA_TIPOS = ["problema", "sugestao", "pergunta"] as const;
type MelhoriaTipo = (typeof MELHORIA_TIPOS)[number];

const MELHORIA_URGENCIAS = ["baixa", "media", "alta"] as const;
type MelhoriaUrgencia = (typeof MELHORIA_URGENCIAS)[number];

const MELHORIA_MODULOS = [
  "vendas", "estoque", "reposicao", "financeiro", "tintometrico", "afiacao",
  "whatsapp", "rota", "tarefas", "producao", "governanca", "outro",
] as const;
type MelhoriaModulo = (typeof MELHORIA_MODULOS)[number];

interface TriagemValidada {
  tipo: MelhoriaTipo;
  urgencia: MelhoriaUrgencia;
  modulo: MelhoriaModulo;
  titulo: string;
  resposta_ao_funcionario: string;
  avaliacao_founder: string;
}

function normStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Valida/normaliza o output da tool `triar` da IA.
 * Retorna null quando o payload é inaproveitável (a edge marca triagem_status='erro').
 * Módulo desconhecido degrada pra 'outro' (lista evolui sem quebrar).
 */
function validarTriagem(payload: unknown): TriagemValidada | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;

  const tipoRaw = normStr(p.tipo).toLowerCase();
  if (!(MELHORIA_TIPOS as ReadonlyArray<string>).includes(tipoRaw)) return null;
  const tipo = tipoRaw as MelhoriaTipo;

  const urgenciaRaw = normStr(p.urgencia).toLowerCase();
  if (!(MELHORIA_URGENCIAS as ReadonlyArray<string>).includes(urgenciaRaw)) return null;
  const urgencia = urgenciaRaw as MelhoriaUrgencia;

  const moduloRaw = normStr(p.modulo).toLowerCase();
  const modulo: MelhoriaModulo = (MELHORIA_MODULOS as ReadonlyArray<string>).includes(moduloRaw)
    ? (moduloRaw as MelhoriaModulo)
    : "outro";

  const titulo = normStr(p.titulo).slice(0, 120);
  const resposta = normStr(p.resposta_ao_funcionario);
  if (!titulo || !resposta) return null;

  return {
    tipo,
    urgencia,
    modulo,
    titulo,
    resposta_ao_funcionario: resposta,
    avaliacao_founder: normStr(p.avaliacao_founder),
  };
}

// ===== fim do espelho =====

const SYSTEM_PROMPT = `Você é a triagem do canal interno de melhorias do sistema operacional B2B "Colacor" (grupo de 3 empresas: Colacor = indústria de abrasivos; Oben = distribuidora para indústria moveleira; Colacor SC = serviços de afiação). Funcionários (vendedoras, separadores, conferentes, compradores, operadores tintométricos, gestores) mandam mensagens que são PROBLEMAS (algo quebrado/errado no app), SUGESTÕES (melhoria de fluxo/tela) ou PERGUNTAS (dúvida ou pedido de dados).

Módulos do app: vendas (pedidos, clientes, carteira), estoque (picking, recebimento), reposicao (compras, fornecedores, portal Sayerlack), financeiro, tintometrico (tintas e fórmulas), afiacao (ordens de serviço de afiação), whatsapp (inbox), rota (lista de ligação/entregas), tarefas, producao, governanca, outro.

REGRAS INEGOCIÁVEIS:
1. NUNCA invente números, nomes de clientes ou produtos. Números só podem vir de resultado de ferramenta (tool_result). Na prosa, não repita os números linha a linha — a interface mostra a tabela; você pode citar o total retornado.
2. Se a mensagem contém uma PERGUNTA DE DADOS que casa com uma ferramenta disponível, chame a ferramenta. Se nenhuma casa, classifique como "pergunta" e diga honestamente que vai para a fila do Lucas (o founder).
3. SEMPRE termine chamando a tool "triar" — mesmo quando usou ferramentas de dados antes.
4. resposta_ao_funcionario: português brasileiro, cordial, curta (2 a 5 frases), tratando por "você". Confirme o que entendeu. Se consultou dados, resuma em 1-2 frases (a tabela aparece junto da sua mensagem). Se for problema/sugestão, confirme que foi para a fila do founder.
5. avaliacao_founder: nota técnica para o founder (que é dev): hipótese de causa provável, módulo/tela onde mexer, o que validar primeiro. Seja específico e honesto sobre incerteza — nunca afirme causa sem evidência.
6. urgencia: alta = trava operação ou dinheiro hoje; media = atrapalha mas tem contorno; baixa = melhoria/cosmético.
7. Se a thread tem mais de uma mensagem do funcionário (réplica), re-classifique considerando a conversa inteira.`;

const TOOL_TRIAR = {
  name: "triar",
  description: "Finaliza a triagem do item com classificação e respostas. SEMPRE é a última chamada.",
  input_schema: {
    type: "object",
    properties: {
      tipo: { type: "string", enum: [...MELHORIA_TIPOS] },
      urgencia: { type: "string", enum: [...MELHORIA_URGENCIAS] },
      modulo: { type: "string", enum: [...MELHORIA_MODULOS] },
      titulo: { type: "string", description: "Resumo de 1 linha do item" },
      resposta_ao_funcionario: { type: "string" },
      avaliacao_founder: { type: "string" },
    },
    required: ["tipo", "urgencia", "modulo", "titulo", "resposta_ao_funcionario", "avaliacao_founder"],
  },
} as const;

const TOOL_CLIENTES = {
  name: "clientes_por_produto",
  description: "Lista clientes que compraram um produto nos últimos 12 meses (nº de pedidos, última compra, valor). Use quando a pergunta é sobre QUEM compra/usa um produto. O resultado respeita a visibilidade de carteira de quem perguntou.",
  input_schema: {
    type: "object",
    properties: { p_termo: { type: "string", description: "Nome ou código do produto (mínimo 3 caracteres)" } },
    required: ["p_termo"],
  },
} as const;

const TOOL_RELACIONADOS = {
  name: "produtos_relacionados",
  description: "Lista produtos substitutos/relacionados: mesma família no catálogo + produtos comprados juntos (regras de associação com confiança e lift). Use para perguntas de substituição/alternativa/cross-sell de um produto.",
  input_schema: {
    type: "object",
    properties: { p_termo: { type: "string", description: "Nome ou código do produto (mínimo 3 caracteres)" } },
    required: ["p_termo"],
  },
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Fix 1 (P2-1): mapa explícito tool→RPC — nome inesperado nunca executa RPC.
const RPC_POR_TOOL: Record<string, string> = {
  clientes_por_produto: "melhoria_clientes_por_produto",
  produtos_relacionados: "melhoria_produtos_relacionados",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;
  // Triagem é sempre disparada por um usuário; cron/service_role não se aplicam aqui.
  if (auth.via !== "staff" || !auth.userId) return jsonResponse({ error: "Apenas staff" }, 403);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  let itemId = "";
  try {
    const body = await req.json();
    itemId = String(body?.item_id ?? "").trim();
  } catch { /* body inválido cai no guard abaixo */ }
  if (!itemId) return jsonResponse({ error: "item_id obrigatório" }, 400);

  // Fix 4 (P3-1): item_id não-UUID vira 400, não 500 (evita query desnecessária com input malformado).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(itemId)) return jsonResponse({ error: "item_id inválido" }, 400);

  // Anti-spoof: conteúdo vem do banco, nunca do payload.
  const { data: item, error: itemErr } = await admin
    .from("melhoria_itens").select("*").eq("id", itemId).maybeSingle();
  if (itemErr) return jsonResponse({ error: `Falha ao ler item: ${itemErr.message}` }, 500);
  if (!item) return jsonResponse({ error: "Item não encontrado" }, 404);

  // Fix 3 (P3-3): item finalizado não re-tria (espelha a regra de réplica da RLS;
  // evita poluir item fechado com triagem desnecessária).
  if (item.status !== "aberto" && item.status !== "em_andamento") {
    return jsonResponse({ error: "Item já finalizado — reabra ou crie um novo" }, 422);
  }

  // Autorização: autor do item OU master.
  const callerIsAutor = auth.userId === item.autor_user_id;
  if (!callerIsAutor) {
    const { data: isMaster, error: roleErr } = await admin.rpc("has_role", { _user_id: auth.userId, _role: "master" });
    if (roleErr || isMaster !== true) return jsonResponse({ error: "Forbidden" }, 403);
  }

  const { data: mensagens, error: msgErr } = await admin
    .from("melhoria_mensagens").select("*").eq("item_id", itemId).order("created_at", { ascending: true });
  if (msgErr) return jsonResponse({ error: `Falha ao ler thread: ${msgErr.message}` }, 500);
  if (!mensagens || mensagens.length === 0) return jsonResponse({ error: "Item sem mensagens" }, 422);

  // Cap de réplicas (re-validação server-side do app-level cap).
  const doFuncionario = mensagens.filter((m: { papel: string }) => m.papel === "funcionario").length;
  if (doFuncionario > MAX_MENSAGENS_FUNCIONARIO) {
    return jsonResponse({ error: "Limite de réplicas do item atingido" }, 422);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const marcarErro = async () => {
    await admin.from("melhoria_itens").update({ triagem_status: "erro" }).eq("id", itemId);
  };
  if (!apiKey) {
    await marcarErro();
    return jsonResponse({ ok: false, fallback: true });
  }

  // ⚠️ Anti-vazamento de carteira (P1 da spec §5): tools de dados SÓ quando o caller
  // é o autor (o JWT do caller define o escopo). Re-triagem por master de item alheio
  // roda SEM tools de dados — só classificação.
  const toolsDadosHabilitadas = callerIsAutor;
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });

  try {
    const client = new Anthropic({ apiKey });
    // Fix 5 (P3-2): cap de 8000 chars por mensagem evita prompt inflado por relato longo.
    const thread = (mensagens as Array<{ papel: string; conteudo: string }>)
      .map((m) => `[${m.papel}] ${String(m.conteudo).slice(0, 8000)}`)
      .join("\n");
    const userMsg = `Contexto do item:
- Empresa ativa no envio: ${item.empresa}
- Tela de origem: ${item.rota_origem ?? "não informada"}
- Ferramentas de dados ${toolsDadosHabilitadas ? "DISPONÍVEIS" : "INDISPONÍVEIS nesta execução (apenas classifique)"}

Thread do funcionário:
"""
${thread}
"""

Avalie e finalize chamando a tool "triar".`;

    const tools = toolsDadosHabilitadas ? [TOOL_CLIENTES, TOOL_RELACIONADOS, TOOL_TRIAR] : [TOOL_TRIAR];
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMsg }];
    const dadosExecutados: Array<{ tool: string; input: Record<string, unknown>; resultado: unknown }> = [];
    let triagem: TriagemValidada | null = null;

    for (let i = 0; i < MAX_TOOL_CALLS_DADOS + 2; i++) {
      const forcarTriar = !toolsDadosHabilitadas || dadosExecutados.length >= MAX_TOOL_CALLS_DADOS || i === MAX_TOOL_CALLS_DADOS + 1;
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2500,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools,
        // Fix 2 (P2-2): disable_parallel_tool_use evita que o caso "quem compra X + sugerir"
        // dispare 2 tool_use no mesmo turn (→ 400 da API → fallback intermitente).
        tool_choice: forcarTriar
          ? { type: "tool", name: "triar" }
          : { type: "auto", disable_parallel_tool_use: true },
        messages,
      });

      const toolUse = response.content.find((b) => b.type === "tool_use");
      if (!toolUse || toolUse.type !== "tool_use") break;

      if (toolUse.name === "triar") {
        triagem = validarTriagem(toolUse.input);
        break;
      }

      // Tool de dados: executa a RPC com o JWT do caller (escopo de carteira correto).
      // Mapa explícito + guard: nome inesperado OU tools desabilitadas NUNCA executam RPC
      // (defesa em profundidade do anti-vazamento — spec §5).
      const rpcName = toolsDadosHabilitadas ? RPC_POR_TOOL[toolUse.name] : undefined;
      if (!rpcName) break; // triagem fica null → marcarErro (degradação honesta)

      const input = toolUse.input as { p_termo?: string };
      const { data: rpcData, error: rpcErr } = await userClient.rpc(rpcName, { p_termo: String(input?.p_termo ?? "") });
      const resultado = rpcErr ? { erro: rpcErr.message } : rpcData;
      if (!rpcErr) dadosExecutados.push({ tool: toolUse.name, input: { p_termo: input?.p_termo }, resultado });

      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(resultado) }],
      });
    }

    if (!triagem) {
      await marcarErro();
      return jsonResponse({ ok: false, fallback: true });
    }

    // Persistência (service_role): item + mensagem da IA.
    const { error: upErr } = await admin.from("melhoria_itens").update({
      tipo: triagem.tipo,
      urgencia: triagem.urgencia,
      modulo: triagem.modulo,
      titulo: triagem.titulo,
      avaliacao_founder: triagem.avaliacao_founder || null,
      triagem_status: "ok",
    }).eq("id", itemId);
    if (upErr) throw new Error(`Falha ao gravar triagem: ${upErr.message}`);

    const { error: insErr } = await admin.from("melhoria_mensagens").insert({
      item_id: itemId,
      autor_user_id: null,
      papel: "ia",
      conteudo: triagem.resposta_ao_funcionario,
      dados: dadosExecutados.length > 0 ? { tools: dadosExecutados } : null,
    });
    if (insErr) throw new Error(`Falha ao gravar mensagem da IA: ${insErr.message}`);

    return jsonResponse({ ok: true, resposta: triagem.resposta_ao_funcionario, tipo: triagem.tipo, teve_dados: dadosExecutados.length > 0 });
  } catch (e) {
    console.error("[melhoria-triagem]", e);
    await marcarErro();
    return jsonResponse({ ok: false, fallback: true });
  }
});
