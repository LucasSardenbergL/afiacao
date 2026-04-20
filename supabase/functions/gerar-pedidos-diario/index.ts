// Edge function: gerar-pedidos-diario
// Orquestra a geração diária de pedidos de compra sugeridos:
// 1. Chama RPC gerar_pedidos_sugeridos_ciclo(empresa, data_ciclo)
// 2. Busca detalhes do ciclo gerado (por fornecedor)
// 3. Envia email digest via Resend para empresa_configuracao_custos.email_notificacoes
// 4. Grava log em sync_reprocess_log
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const RESEND_URL = "https://api.resend.com/emails";
const FROM_EMAIL = "Reposicao OBEN <onboarding@resend.dev>";
const APP_URL = Deno.env.get("APP_URL") ?? "https://steu.lovable.app";

interface RpcResult {
  pedidos_gerados: number;
  skus_incluidos: number;
  valor_total_ciclo: number;
  bloqueados: number;
}

interface PedidoResumo {
  id: string;
  fornecedor_nome: string;
  grupo_codigo: string | null;
  status: string;
  num_skus: number;
  valor_total: number;
  mensagem_bloqueio: string | null;
  horario_corte_planejado: string | null;
}

function fmtBRL(v: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(v ?? 0);
}

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    pendente_aprovacao: "#f59e0b",
    bloqueado_guardrail: "#ef4444",
    aprovado_aguardando_disparo: "#3b82f6",
    disparado: "#10b981",
    cancelado: "#6b7280",
  };
  const bg = colors[status] ?? "#6b7280";
  return `<span style="background:${bg};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase;">${status}</span>`;
}

function buildEmailHtml(
  empresa: string,
  dataCiclo: string,
  rpc: RpcResult,
  pedidos: PedidoResumo[],
): string {
  const bloqueados = pedidos.filter((p) => p.status === "bloqueado_guardrail");
  const pendentes = pedidos.filter((p) => p.status === "pendente_aprovacao");

  const banner = bloqueados.length > 0
    ? `<div style="background:#fee;border-left:4px solid #ef4444;padding:12px;margin-bottom:16px;color:#991b1b;">
         <strong>⚠ ${bloqueados.length} pedido(s) bloqueado(s) por guardrail.</strong> Revise antes do disparo.
       </div>`
    : "";

  const linhas = pedidos
    .map(
      (p) => `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${statusBadge(p.status)}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${p.fornecedor_nome ?? "—"}<br><small style="color:#6b7280;">${p.grupo_codigo ?? ""}</small></td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">${p.num_skus}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">${fmtBRL(p.valor_total)}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#991b1b;">${p.mensagem_bloqueio ?? ""}</td>
        </tr>`,
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f9fafb;margin:0;padding:24px;color:#111827;">
  <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
    <h1 style="margin:0 0 4px;font-size:20px;">Pedidos sugeridos — ciclo ${dataCiclo}</h1>
    <p style="margin:0 0 20px;color:#6b7280;font-size:13px;">Empresa: <strong>${empresa}</strong> · Janela de override até 09:30 BRT</p>

    ${banner}

    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr>
        <td style="padding:12px;background:#f3f4f6;border-radius:6px;text-align:center;width:25%;">
          <div style="font-size:24px;font-weight:700;color:#111827;">${rpc.pedidos_gerados}</div>
          <div style="font-size:11px;color:#6b7280;text-transform:uppercase;">Pedidos</div>
        </td>
        <td style="width:8px;"></td>
        <td style="padding:12px;background:#f3f4f6;border-radius:6px;text-align:center;width:25%;">
          <div style="font-size:24px;font-weight:700;color:#111827;">${rpc.skus_incluidos}</div>
          <div style="font-size:11px;color:#6b7280;text-transform:uppercase;">SKUs</div>
        </td>
        <td style="width:8px;"></td>
        <td style="padding:12px;background:#f3f4f6;border-radius:6px;text-align:center;width:25%;">
          <div style="font-size:18px;font-weight:700;color:#111827;">${fmtBRL(rpc.valor_total_ciclo)}</div>
          <div style="font-size:11px;color:#6b7280;text-transform:uppercase;">Valor total</div>
        </td>
        <td style="width:8px;"></td>
        <td style="padding:12px;background:${rpc.bloqueados > 0 ? "#fee2e2" : "#f3f4f6"};border-radius:6px;text-align:center;width:25%;">
          <div style="font-size:24px;font-weight:700;color:${rpc.bloqueados > 0 ? "#991b1b" : "#111827"};">${rpc.bloqueados}</div>
          <div style="font-size:11px;color:#6b7280;text-transform:uppercase;">Bloqueados</div>
        </td>
      </tr>
    </table>

    <h2 style="font-size:15px;margin:24px 0 8px;">Detalhe por pedido</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f9fafb;">
          <th style="padding:8px;text-align:left;font-weight:600;color:#374151;">Status</th>
          <th style="padding:8px;text-align:left;font-weight:600;color:#374151;">Fornecedor / Grupo</th>
          <th style="padding:8px;text-align:right;font-weight:600;color:#374151;">SKUs</th>
          <th style="padding:8px;text-align:right;font-weight:600;color:#374151;">Valor</th>
          <th style="padding:8px;text-align:left;font-weight:600;color:#374151;">Bloqueio</th>
        </tr>
      </thead>
      <tbody>${linhas || `<tr><td colspan="5" style="padding:16px;text-align:center;color:#6b7280;">Nenhum pedido gerado neste ciclo.</td></tr>`}</tbody>
    </table>

    <p style="margin-top:24px;font-size:12px;color:#6b7280;">
      ${pendentes.length} pedido(s) aguardando aprovação. Acesse <strong>/admin/reposicao/pedidos</strong> para revisar antes das 09:30 BRT.
    </p>
  </div>
</body>
</html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendKey = Deno.env.get("RESEND_API_KEY");

  const db = createClient(supabaseUrl, serviceKey);
  const startedAt = Date.now();
  const windowStart = new Date().toISOString();

  let empresa = "OBEN";
  let dataCiclo = new Date().toISOString().slice(0, 10);

  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body.empresa) empresa = body.empresa;
      if (body.data_ciclo) dataCiclo = body.data_ciclo;
    }

    console.log(`[gerar-pedidos-diario] Iniciando ciclo ${empresa} ${dataCiclo}`);

    // 1. RPC de geração
    const { data: rpcRows, error: rpcErr } = await db.rpc(
      "gerar_pedidos_sugeridos_ciclo",
      { p_empresa: empresa, p_data_ciclo: dataCiclo },
    );
    if (rpcErr) throw new Error(`RPC falhou: ${rpcErr.message}`);
    const rpc: RpcResult = (rpcRows?.[0] ?? {
      pedidos_gerados: 0,
      skus_incluidos: 0,
      valor_total_ciclo: 0,
      bloqueados: 0,
    }) as RpcResult;
    console.log(`[gerar-pedidos-diario] RPC OK:`, rpc);

    // 2. Detalhes dos pedidos do ciclo
    const { data: pedidos, error: pedErr } = await db
      .from("pedido_compra_sugerido")
      .select(
        "id, fornecedor_nome, grupo_codigo, status, num_skus, valor_total, mensagem_bloqueio, horario_corte_planejado",
      )
      .eq("empresa", empresa)
      .eq("data_ciclo", dataCiclo)
      .order("status")
      .order("fornecedor_nome");
    if (pedErr) throw new Error(`Falha buscando pedidos: ${pedErr.message}`);
    const pedidosList = (pedidos ?? []) as PedidoResumo[];

    // 3. Email destinatário
    const { data: cfg } = await db
      .from("empresa_configuracao_custos")
      .select("email_notificacoes")
      .eq("empresa", empresa)
      .maybeSingle();
    const recipient = cfg?.email_notificacoes;

    // 4. Envia email via Resend
    let emailStatus: "sent" | "skipped" | "failed" = "skipped";
    let emailDetail: string | null = null;

    if (recipient && resendKey) {
      const html = buildEmailHtml(empresa, dataCiclo, rpc, pedidosList);
      const subject = rpc.bloqueados > 0
        ? `⚠ ${empresa} — ${rpc.pedidos_gerados} pedidos (${rpc.bloqueados} bloqueados) — ${dataCiclo}`
        : `${empresa} — ${rpc.pedidos_gerados} pedidos sugeridos — ${dataCiclo}`;

      const r = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resendKey}`,
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [recipient],
          subject,
          html,
        }),
      });
      const respText = await r.text();
      if (r.ok) {
        emailStatus = "sent";
        emailDetail = respText;
        console.log(`[gerar-pedidos-diario] Email enviado para ${recipient}`);
      } else {
        emailStatus = "failed";
        emailDetail = `[${r.status}] ${respText}`;
        console.error(`[gerar-pedidos-diario] Resend erro:`, emailDetail);
      }
    } else {
      emailDetail = !recipient
        ? "Sem email_notificacoes cadastrado"
        : "RESEND_API_KEY ausente";
      console.warn(`[gerar-pedidos-diario] Email pulado: ${emailDetail}`);
    }

    // 5. Log em sync_reprocess_log
    const duration = Date.now() - startedAt;
    await db.from("sync_reprocess_log").insert({
      entity_type: "pedidos_compra_sugeridos",
      account: empresa,
      reprocess_type: "ciclo_diario",
      window_start: windowStart,
      window_end: new Date().toISOString(),
      status: "ok",
      upserts_count: rpc.pedidos_gerados,
      divergences_found: rpc.bloqueados,
      duration_ms: duration,
      metadata: {
        data_ciclo: dataCiclo,
        skus_incluidos: rpc.skus_incluidos,
        valor_total: rpc.valor_total_ciclo,
        email_status: emailStatus,
        email_recipient: recipient ?? null,
        email_detail: emailDetail,
      },
    });

    return new Response(
      JSON.stringify({
        ok: true,
        empresa,
        data_ciclo: dataCiclo,
        ...rpc,
        email_status: emailStatus,
        email_recipient: recipient,
        duration_ms: duration,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[gerar-pedidos-diario] ERRO:`, msg);
    await db
      .from("sync_reprocess_log")
      .insert({
        entity_type: "pedidos_compra_sugeridos",
        account: empresa,
        reprocess_type: "ciclo_diario",
        window_start: windowStart,
        window_end: new Date().toISOString(),
        status: "error",
        duration_ms: Date.now() - startedAt,
        error_message: msg,
        metadata: { data_ciclo: dataCiclo },
      })
      .then(() => {});
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
