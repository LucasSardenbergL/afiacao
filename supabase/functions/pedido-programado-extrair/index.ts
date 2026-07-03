// Extrai o pedido de compra da Lider (PDF no bucket pedidos-programados) via Anthropic
// forced tool-use e materializa itens em pedidos_programados_itens, aplicando o de-para
// memorizado (cliente_item_mapa) + memória de preço. Reprocessável: re-extrair apaga e
// recria os itens AINDA sem envio (não toca item já vinculado a envio).
// Auth: staff (UI) ou service_role/cron.
// ESPELHO: validarExtracao e tipos vêm de src/lib/pedidosProgramados/helpers.ts (verbatim).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SYSTEM_PROMPT = `Você extrai dados de um PDF de PEDIDO DE COMPRA da LIDER INDUSTRIA E COMERCIO DE ESTOFADOS (layout tabular monoespaçado, "PEDIDO No..:" no topo, itens com QUANTIDADE|UN|COD.ITEM/NUM.ORDEM|DESCRICAO|PRECO UNITARIO, COD.FORN e DATA ENTREGA por item, possível "ANEXO AO PEDIDO" na última página).
Regras:
- Copie códigos EXATAMENTE como impressos (ex.: 3FLA0003M01, 50072329, PRD01931).
- Datas: converta DD/MM/YYYY → YYYY-MM-DD.
- Números: vírgula decimal brasileira → ponto (16,900000 → 16.9; 1700,000 → 1700).
- Campo ilegível/ausente → null. NUNCA invente valor.
- descricao_cliente: junte as linhas de continuação da descrição do item (sem o COD.FORN e sem a DATA ENTREGA).`;

const TOOL = {
  name: "registrar_pedido_compra",
  description: "Registra os dados extraídos do PDF do pedido de compra.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      numero_pedido_compra: { type: ["string", "null"], description: "PEDIDO No.. do topo, ex.: 213294" },
      data_emissao: { type: ["string", "null"], description: "DATA EMISSAO em YYYY-MM-DD" },
      versao: { type: ["string", "null"], description: "VERSAO., ex.: 2" },
      itens: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            codigo_item_cliente: { type: ["string", "null"], description: "COD.ITEM, ex.: 3FLA0003M01" },
            num_ordem_cliente: { type: ["string", "null"], description: "NUM.ORDEM, ex.: 50072329" },
            descricao_cliente: { type: ["string", "null"] },
            quantidade: { type: ["number", "null"] },
            unidade: { type: ["string", "null"], description: "UN, MT, ..." },
            preco_unitario: { type: ["number", "null"], description: "PRECO UNITARIO do PDF" },
            data_entrega: { type: ["string", "null"], description: "DATA ENTREGA em YYYY-MM-DD" },
            cod_forn: { type: ["string", "null"], description: "COD.FORN (código do fornecedor = nosso)" },
          },
          required: ["codigo_item_cliente","num_ordem_cliente","descricao_cliente","quantidade","unidade","preco_unitario","data_entrega","cod_forn"],
        },
      },
    },
    required: ["numero_pedido_compra", "data_emissao", "versao", "itens"],
  },
} as const;

// ── ESPELHO de src/lib/pedidosProgramados/helpers.ts (parte de extração, verbatim) ──
// ── Validação da extração do LLM (espelhada na edge pedido-programado-extrair) ──
export interface ItemExtraido {
  codigo_item_cliente: string;
  num_ordem_cliente: string | null;
  descricao_cliente: string;
  quantidade: number;
  unidade: string | null;
  preco_unitario: number | null;  // referência; sempre "vem errado" (founder ajusta)
  data_entrega: string | null;    // YYYY-MM-DD
  cod_forn: string | null;        // NOSSO código impresso no PDF (semente de sugestão)
}
export interface ExtracaoValidada {
  numero_pedido_compra: string;
  data_emissao: string | null;    // YYYY-MM-DD
  versao: string | null;
  itens: ItemExtraido[];
}
export type ResultadoValidacao = { ok: true; dados: ExtracaoValidada } | { ok: false; erro: string };

const RE_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isoOuNull(v: unknown): string | null {
  return typeof v === 'string' && RE_ISO_DATE.test(v) ? v : null;
}
function numeroPositivoOuNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}
function textoOuNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function validarExtracao(bruto: unknown): ResultadoValidacao {
  const b = bruto as Record<string, unknown> | null;
  const numeroPc = textoOuNull(b?.numero_pedido_compra);
  if (!numeroPc) return { ok: false, erro: 'Extração sem numero_pedido_compra — PDF ilegível ou fora do layout.' };
  const itensBrutos = Array.isArray(b?.itens) ? (b.itens as Array<Record<string, unknown>>) : [];
  if (itensBrutos.length === 0) return { ok: false, erro: 'Extração sem itens.' };
  const itens: ItemExtraido[] = [];
  for (const [i, it] of itensBrutos.entries()) {
    const codigo = textoOuNull(it?.codigo_item_cliente);
    const descricao = textoOuNull(it?.descricao_cliente);
    const quantidade = numeroPositivoOuNull(it?.quantidade);
    if (!codigo || !descricao || quantidade === null) {
      return { ok: false, erro: `Item ${i + 1} sem código/descrição/quantidade válidos — revisar PDF.` };
    }
    itens.push({
      codigo_item_cliente: codigo,
      num_ordem_cliente: textoOuNull(it?.num_ordem_cliente),
      descricao_cliente: descricao,
      quantidade,
      unidade: textoOuNull(it?.unidade),
      preco_unitario: numeroPositivoOuNull(it?.preco_unitario),
      data_entrega: isoOuNull(it?.data_entrega),
      cod_forn: textoOuNull(it?.cod_forn),
    });
  }
  return {
    ok: true,
    dados: {
      numero_pedido_compra: numeroPc,
      data_emissao: isoOuNull(b?.data_emissao),
      versao: textoOuNull(b?.versao),
      itens,
    },
  };
}
// ── fim do ESPELHO ──

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { pedido_programado_id } = await req.json().catch(() => ({}));
  if (!pedido_programado_id) return json(400, { error: "pedido_programado_id é obrigatório" });

  const { data: pedido, error: pedErr } = await supabase
    .from("pedidos_programados").select("*").eq("id", pedido_programado_id).single();
  if (pedErr || !pedido) return json(404, { error: `Pedido programado não encontrado: ${pedErr?.message}` });

  try {
    // 0. Guard de env DENTRO do try: falha marca o header como erro_extracao com motivo
    //    visível, em vez de deixá-lo preso em 'extraindo' para sempre.
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY não configurada nos secrets do projeto.");

    // 1. Baixar o PDF do Storage
    const { data: blob, error: dlErr } = await supabase.storage
      .from("pedidos-programados").download(pedido.arquivo_path);
    if (dlErr || !blob) throw new Error(`Download do PDF falhou: ${dlErr?.message}`);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    const pdfBase64 = btoa(bin);

    // 2. Anthropic forced tool-use com o PDF como documento
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "registrar_pedido_compra" },
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
          { type: "text", text: "Extraia este pedido de compra e registre via tool." },
        ],
      }],
    });
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (toolUse?.type !== "tool_use") throw new Error("LLM não retornou tool_use.");

    // 3. Validar (nunca aceitar dado inventado/malformado)
    const validacao = validarExtracao(toolUse.input);
    if (!validacao.ok) throw new Error(validacao.erro);
    const dados = validacao.dados;

    // 4. Guard de duplicata/revisão: outro pedido ativo com o mesmo nº de PC?
    const { data: dup } = await supabase
      .from("pedidos_programados").select("id")
      .eq("numero_pedido_compra", dados.numero_pedido_compra)
      .in("status", ["ativo", "extraindo"])
      .neq("id", pedido_programado_id).limit(1);
    const duplicado_de = dup && dup.length > 0 ? dup[0].id : null;

    // 5. Recriar itens ainda não vinculados a envio (reprocesso seguro)
    const { error: delErr } = await supabase
      .from("pedidos_programados_itens").delete()
      .eq("pedido_programado_id", pedido_programado_id).is("envio_id", null);
    if (delErr) throw new Error(`Limpeza de itens falhou: ${delErr.message}`);

    // 6. Aplicar de-para memorizado + memória de preço
    const codigos = dados.itens.map((i) => i.codigo_item_cliente);
    const { data: mapas, error: mapaErr } = await supabase
      .from("cliente_item_mapa").select("id, codigo_item_cliente, ultimo_preco")
      .eq("cliente_ref", pedido.cliente_ref).in("codigo_item_cliente", codigos);
    if (mapaErr) throw new Error(`Consulta do de-para falhou: ${mapaErr.message}`);
    const mapaPorCodigo = new Map((mapas ?? []).map((m) => [m.codigo_item_cliente, m]));

    const linhas = dados.itens.map((it) => {
      const m = mapaPorCodigo.get(it.codigo_item_cliente);
      return {
        pedido_programado_id,
        codigo_item_cliente: it.codigo_item_cliente,
        num_ordem_cliente: it.num_ordem_cliente,
        descricao_cliente: it.descricao_cliente,
        quantidade: it.quantidade,
        unidade: it.unidade,
        data_entrega_cliente: it.data_entrega,
        cod_forn: it.cod_forn,
        preco_pdf: it.preco_unitario,
        preco_final: m?.ultimo_preco ?? null, // memória de preço; NULL se nunca ajustado
        mapa_id: m?.id ?? null,
      };
    });
    const { error: insErr } = await supabase.from("pedidos_programados_itens").insert(linhas);
    if (insErr) throw new Error(`Insert de itens falhou: ${insErr.message}`);

    // 7. Atualizar header
    const { error: updErr } = await supabase.from("pedidos_programados").update({
      numero_pedido_compra: dados.numero_pedido_compra,
      versao: dados.versao,
      data_emissao_cliente: dados.data_emissao,
      status: "ativo",
      erro_motivo: null,
      extracao_bruta: toolUse.input,
    }).eq("id", pedido_programado_id);
    if (updErr) throw new Error(`Update do header falhou: ${updErr.message}`);

    return json(200, { success: true, itens: linhas.length, numero_pedido_compra: dados.numero_pedido_compra, duplicado_de });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from("pedidos_programados")
      .update({ status: "erro_extracao", erro_motivo: msg })
      .eq("id", pedido_programado_id);
    return json(500, { error: msg });
  }
});
