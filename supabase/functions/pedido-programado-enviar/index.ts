// Processa envios agendados de pedidos programados: valida 100% resolvido (precisão >
// recall), separa por empresa, cria sales_orders e dispara criar_pedido do omie-vendas-sync
// (idempotência PV_${sales_order_id} + guards de preço/ativo na fronteira comum).
// Chamadas: cron diário (body {}) processa data_envio <= hoje BRT; UI staff (body
// {envio_id}) processa um envio imediatamente ("Enviar agora").
// ESPELHO: helpers de src/lib/pedidosProgramados/helpers.ts (verbatim — Deno não importa de src/).
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

// ── ESPELHO de src/lib/pedidosProgramados/helpers.ts (parte de envio, verbatim) ──
export type AccountPP = 'oben' | 'colacor';

export interface ConfigConta {
  account: AccountPP;
  codigo_cliente_omie: number | null;
  customer_user_id: string | null;
  obs_venda: string | null;
  dados_adicionais_nf: string | null;
  codigo_parcela: string | null;
}

// Item do envio já resolvido via de-para (JOIN cliente_item_mapa → omie_products)
export interface ItemResolvido {
  id: string;
  codigo_item_cliente: string;
  descricao_cliente: string;
  // quantidade/preco_final: number JÁ convertido pelo caller (numeric do PostgREST pode
  // vir como string — quem monta ItemResolvido converte com Number(...); aqui typeof
  // 'number' é a borda: string crua = item inválido, bloqueia por segurança).
  quantidade: number;
  preco_final: number | null;
  account: AccountPP | null;          // null = sem mapeamento
  omie_codigo_produto: number | null; // null = sem mapeamento
  produto_codigo: string | null;
  produto_descricao: string | null;
}

// nº do PC primeiro (exigência da Lider: "FAVOR INFORMAR O NUMERO DO PEDIDO DA LIDER
// NA NOTA FISCAL"), mensagem fixa depois. Sem mensagem → só o nº (nunca fabricar texto).
export function montarDadosAdicionaisNf(mensagemFixa: string | null, numeroPc: string): string {
  if (!numeroPc || !numeroPc.trim()) {
    throw new Error('numeroPc obrigatório para montar os dados adicionais da NF.');
  }
  const cabeca = `PEDIDO DE COMPRA Nº: ${numeroPc.trim()}`;
  const msg = (mensagemFixa ?? '').trim();
  return msg ? `${cabeca}\n\n${msg}` : cabeca;
}

export function agruparItensPorAccount(itens: ItemResolvido[]): Partial<Record<AccountPP, ItemResolvido[]>> {
  const grupos: Partial<Record<AccountPP, ItemResolvido[]>> = {};
  for (const item of itens) {
    if (!item.account) continue; // sem mapeamento — validarEnvioResolvido já barrou antes
    (grupos[item.account] ??= []).push(item);
  }
  return grupos;
}

// Precisão > recall: retorna a lista de PROBLEMAS (vazia = pode enviar).
// Ausente ≠ zero: preco_final NULL bloqueia, nunca vira 0.
export function validarEnvioResolvido(
  numeroPc: string | null,
  itens: ItemResolvido[],
  configs: Record<AccountPP, ConfigConta>,
): string[] {
  const problemas: string[] = [];
  if (!numeroPc || !numeroPc.trim()) {
    problemas.push('Pedido sem número de pedido de compra — re-extraia o PDF antes de enviar.');
  }
  if (itens.length === 0) problemas.push('Envio sem itens.');
  const accountsEnvolvidas = new Set<AccountPP>();
  for (const it of itens) {
    const rotulo = `${it.codigo_item_cliente} (${it.descricao_cliente})`;
    if (!it.account || !it.omie_codigo_produto) {
      problemas.push(`Item ${rotulo} sem mapeamento para produto interno.`);
      continue;
    }
    accountsEnvolvidas.add(it.account);
    if (typeof it.preco_final !== 'number' || !Number.isFinite(it.preco_final) || it.preco_final <= 0) {
      problemas.push(`Item ${rotulo} sem preço final válido (> 0).`);
    }
    if (typeof it.quantidade !== 'number' || !Number.isFinite(it.quantidade) || it.quantidade <= 0) {
      problemas.push(`Item ${rotulo} com quantidade inválida.`);
    }
  }
  for (const acc of accountsEnvolvidas) {
    const cfg = configs[acc];
    if (!cfg || !cfg.codigo_cliente_omie) {
      problemas.push(`Config da ${acc} incompleta: cliente não cadastrado/sem código Omie.`);
    } else {
      if (!cfg.customer_user_id) problemas.push(`Config da ${acc} incompleta: customer_user_id ausente.`);
      if (!(cfg.dados_adicionais_nf ?? '').trim()) problemas.push(`Config da ${acc} incompleta: mensagem de Dados Adicionais da NF vazia.`);
      if (!(cfg.obs_venda ?? '').trim()) problemas.push(`Config da ${acc} incompleta: mensagem de Observações vazia.`);
    }
  }
  return problemas;
}
// ── fim do ESPELHO ──

function hojeBrt(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()); // YYYY-MM-DD
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface LinhaItem {
  id: string;
  codigo_item_cliente: string;
  descricao_cliente: string;
  quantidade: number | string;
  preco_final: number | string | null;
  mapa: {
    omie_products: { omie_codigo_produto: number | string; codigo: string; descricao: string; unidade: string | null; account: string } | null;
  } | null;
}

interface EnvioRow {
  id: string;
  pedido_programado_id: string;
  sales_orders_map: Record<string, string> | null;
  status: string;
  data_envio: string;
}

async function processarEnvio(
  supabase: SupabaseClient,
  envio: EnvioRow,
): Promise<{ ok: boolean; motivo?: string }> {
  const { data: pedido, error: pErr } = await supabase
    .from("pedidos_programados").select("*").eq("id", envio.pedido_programado_id).single();
  if (pErr || !pedido) return { ok: false, motivo: `Header não encontrado: ${pErr?.message}` };

  const { data: itensRaw, error: iErr } = await supabase
    .from("pedidos_programados_itens")
    .select("id, codigo_item_cliente, descricao_cliente, quantidade, preco_final, mapa:cliente_item_mapa(omie_products(omie_codigo_produto, codigo, descricao, unidade, account))")
    .eq("envio_id", envio.id);
  if (iErr) return { ok: false, motivo: `Itens não carregaram: ${iErr.message}` };

  const { data: cfgRows, error: cErr } = await supabase.from("pedidos_programados_config").select("*");
  if (cErr) return { ok: false, motivo: `Config não carregou: ${cErr.message}` };
  const configs = Object.fromEntries((cfgRows ?? []).map((c) => [c.account, c])) as Record<AccountPP, ConfigConta>;

  const itens: ItemResolvido[] = ((itensRaw ?? []) as unknown as LinhaItem[]).map((r) => {
    const prod = r.mapa?.omie_products ?? null;
    return {
      id: r.id,
      codigo_item_cliente: r.codigo_item_cliente,
      descricao_cliente: r.descricao_cliente,
      quantidade: Number(r.quantidade),
      preco_final: r.preco_final === null ? null : Number(r.preco_final),
      account: (prod?.account === "oben" || prod?.account === "colacor") ? prod.account as AccountPP : null,
      omie_codigo_produto: prod ? Number(prod.omie_codigo_produto) : null,
      produto_codigo: prod?.codigo ?? null,
      produto_descricao: prod?.descricao ?? null,
    };
  });

  // Precisão > recall: qualquer pendência segura o envio inteiro, com motivo visível.
  // numeroPc validado no gate (header é nullable — nunca deixar "null" virar texto de NF).
  const numeroPc = typeof pedido.numero_pedido_compra === "string" ? pedido.numero_pedido_compra.trim() : "";
  const problemas = validarEnvioResolvido(numeroPc || null, itens, configs);
  if (problemas.length > 0) return { ok: false, motivo: problemas.join(" | ") };

  const grupos = agruparItensPorAccount(itens);
  const salesOrdersMap: Record<string, string> = { ...(envio.sales_orders_map ?? {}) };
  const erros: string[] = [];

  for (const [account, itensGrupo] of Object.entries(grupos) as Array<[AccountPP, ItemResolvido[]]>) {
    const cfg = configs[account];
    const orderItems = itensGrupo.map((it) => ({
      omie_codigo_produto: it.omie_codigo_produto as number,
      codigo: it.produto_codigo ?? undefined,
      descricao: it.produto_descricao ?? it.descricao_cliente,
      quantidade: it.quantidade,
      valor_unitario: it.preco_final as number,
      valor_total: Number((it.quantidade * (it.preco_final as number)).toFixed(2)),
    }));
    const total = Number(orderItems.reduce((s, i) => s + i.valor_total, 0).toFixed(2));

    try {
      // 1. sales_order idempotente por (envio, account): persistir o id ANTES do Omie —
      //    retry reusa o MESMO sales_order → mesma chave PV_ no Omie (nunca duplica).
      let salesOrderId = salesOrdersMap[account];
      if (!salesOrderId) {
        const { data: so, error: soErr } = await supabase.from("sales_orders").insert({
          customer_user_id: cfg.customer_user_id,
          created_by: pedido.created_by,
          items: orderItems,
          subtotal: total,
          discount: 0,
          total,
          status: "rascunho",
          notes: `Pedido programado Lider — PC ${numeroPc} (envio ${envio.id})`,
          account,
        }).select("id").single();
        if (soErr || !so) throw new Error(`sales_order não criado (${account}): ${soErr?.message}`);
        salesOrderId = (so as { id: string }).id;
        salesOrdersMap[account] = salesOrderId;
        const { error: mapErr } = await supabase.from("pedidos_programados_envios")
          .update({ sales_orders_map: salesOrdersMap }).eq("id", envio.id);
        if (mapErr) throw new Error(`Persistência do sales_orders_map falhou: ${mapErr.message}`);
      } else {
        // Retry: se este sales_order já foi ao Omie, pular (não re-enviar esta empresa).
        const { data: soExist } = await supabase.from("sales_orders")
          .select("status, omie_pedido_id").eq("id", salesOrderId).single();
        if (soExist?.omie_pedido_id) continue;
      }

      // 2. criar_pedido via omie-vendas-sync (service role) — guards de preço/ativo lá.
      const resp = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/omie-vendas-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({
          action: "criar_pedido",
          account,
          sales_order_id: salesOrderId,
          codigo_cliente: cfg.codigo_cliente_omie,
          codigo_vendedor: null,
          items: orderItems,
          observacao: cfg.obs_venda,
          ...(cfg.codigo_parcela ? { codigo_parcela: cfg.codigo_parcela } : {}),
          ordem_compra: numeroPc,
          dados_adicionais_nf: montarDadosAdicionaisNf(cfg.dados_adicionais_nf, numeroPc),
          numero_pedido_cliente: numeroPc,
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok || body?.error) throw new Error(`criar_pedido ${account} falhou: ${body?.error ?? resp.status}`);
    } catch (e) {
      erros.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (erros.length > 0) return { ok: false, motivo: erros.join(" | ") };
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { envio_id } = await req.json().catch(() => ({}));

  let query = supabase.from("pedidos_programados_envios")
    .select("id, pedido_programado_id, sales_orders_map, status, data_envio");
  if (envio_id) {
    // "Enviar agora" da UI: também reprocessa envio em 'erro' (retry idempotente).
    query = query.eq("id", envio_id).in("status", ["agendado", "erro"]);
  } else {
    // Cron: só os agendados vencidos; envio em 'erro' fica visível p/ decisão humana.
    query = query.eq("status", "agendado").lte("data_envio", hojeBrt());
  }
  const { data: envios, error } = await query;
  if (error) return json(500, { error: error.message });

  const resultados: Array<{ envio_id: string; ok: boolean; motivo?: string }> = [];
  for (const envio of (envios ?? []) as unknown as EnvioRow[]) {
    const r = await processarEnvio(supabase, envio);
    if (r.ok) {
      await supabase.from("pedidos_programados_envios")
        .update({ status: "enviado", erro_motivo: null }).eq("id", envio.id);
      // Pai concluído quando TODOS os itens estão em envios 'enviado'
      const { data: itensPai } = await supabase
        .from("pedidos_programados_itens")
        .select("id, envio:pedidos_programados_envios(status)")
        .eq("pedido_programado_id", envio.pedido_programado_id);
      const aberto = (itensPai ?? []).some((p) => {
        const st = (p as unknown as { envio: { status: string } | null }).envio?.status;
        return st !== "enviado";
      });
      if (!aberto) {
        await supabase.from("pedidos_programados")
          .update({ status: "concluido" }).eq("id", envio.pedido_programado_id);
      }
    } else {
      await supabase.from("pedidos_programados_envios")
        .update({ status: "erro", erro_motivo: r.motivo ?? "erro desconhecido" }).eq("id", envio.id);
    }
    resultados.push({ envio_id: envio.id, ...r });
  }
  return json(200, { success: true, processados: resultados.length, resultados });
});
