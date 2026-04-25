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
  const listaUrl = `${APP_URL}/admin/reposicao/pedidos`;

  const banner = bloqueados.length > 0
    ? `<div style="background:#fee2e2;border-left:4px solid #ef4444;padding:14px 16px;margin:0 0 20px;color:#991b1b;border-radius:6px;">
         <strong style="font-size:14px;">⚠ ${bloqueados.length} pedido(s) bloqueado(s) por guardrail.</strong>
         <div style="font-size:12px;margin-top:4px;opacity:0.9;">Revise antes do disparo das 10:00 BRT.</div>
       </div>`
    : "";

  const cardFor = (p: PedidoResumo): string => {
    const isBloqueado = p.status === "bloqueado_guardrail";
    const isPendente = p.status === "pendente_aprovacao";
    const borderColor = isBloqueado
      ? "#ef4444"
      : isPendente
      ? "#f59e0b"
      : "#e5e7eb";
    const bgColor = isBloqueado
      ? "#fef2f2"
      : "#ffffff";
    const url = `${APP_URL}/admin/reposicao/pedidos?id=${p.id}`;
    const motivoBloqueio = p.mensagem_bloqueio
      ? `<div style="margin-top:10px;padding:8px 10px;background:#fff;border-radius:4px;font-size:11px;color:#991b1b;border:1px solid #fecaca;">
           <strong>Motivo:</strong> ${p.mensagem_bloqueio}
         </div>`
      : "";

    return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 12px;border-collapse:separate;">
  <tr>
    <td>
      <a href="${url}" style="display:block;text-decoration:none;color:inherit;background:${bgColor};border:1px solid ${borderColor};border-left:4px solid ${borderColor};border-radius:8px;padding:14px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
          <tr>
            <td style="vertical-align:top;">
              <div style="font-size:15px;font-weight:600;color:#111827;line-height:1.3;">${p.fornecedor_nome ?? "—"}</div>
              <div style="font-size:11px;color:#6b7280;margin-top:2px;">Grupo: ${p.grupo_codigo ?? "—"}</div>
            </td>
            <td style="text-align:right;vertical-align:top;white-space:nowrap;">
              ${statusBadge(p.status)}
            </td>
          </tr>
          <tr>
            <td colspan="2" style="padding-top:12px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
                <tr>
                  <td style="font-size:12px;color:#6b7280;">
                    <strong style="color:#111827;font-size:14px;">${p.num_skus}</strong> SKUs
                  </td>
                  <td style="text-align:right;font-size:14px;font-weight:700;color:#111827;">
                    ${fmtBRL(p.valor_total)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        ${motivoBloqueio}
        <div style="margin-top:10px;font-size:11px;color:#3b82f6;font-weight:600;">
          Abrir pedido →
        </div>
      </a>
    </td>
  </tr>
</table>`;
  };

  const cards = pedidos.length > 0
    ? pedidos.map(cardFor).join("")
    : `<div style="padding:24px;text-align:center;color:#6b7280;background:#f9fafb;border-radius:8px;">Nenhum pedido gerado neste ciclo.</div>`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pedidos sugeridos ${dataCiclo}</title>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f3f4f6;margin:0;padding:16px;color:#111827;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
    <h1 style="margin:0 0 4px;font-size:20px;color:#111827;">Pedidos sugeridos — ciclo ${dataCiclo}</h1>
    <p style="margin:0 0 20px;color:#6b7280;font-size:13px;">Empresa: <strong>${empresa}</strong> · Janela de override até 09:30 BRT</p>

    ${banner}

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;border-spacing:6px 0;margin-bottom:24px;">
      <tr>
        <td style="padding:12px 8px;background:#f3f4f6;border-radius:8px;text-align:center;width:25%;">
          <div style="font-size:22px;font-weight:700;color:#111827;line-height:1;">${rpc.pedidos_gerados}</div>
          <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">Pedidos</div>
        </td>
        <td style="padding:12px 8px;background:#f3f4f6;border-radius:8px;text-align:center;width:25%;">
          <div style="font-size:22px;font-weight:700;color:#111827;line-height:1;">${rpc.skus_incluidos}</div>
          <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">SKUs</div>
        </td>
        <td style="padding:12px 8px;background:#f3f4f6;border-radius:8px;text-align:center;width:25%;">
          <div style="font-size:14px;font-weight:700;color:#111827;line-height:1;">${fmtBRL(rpc.valor_total_ciclo)}</div>
          <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">Valor total</div>
        </td>
        <td style="padding:12px 8px;background:${rpc.bloqueados > 0 ? "#fee2e2" : "#f3f4f6"};border-radius:8px;text-align:center;width:25%;">
          <div style="font-size:22px;font-weight:700;color:${rpc.bloqueados > 0 ? "#991b1b" : "#111827"};line-height:1;">${rpc.bloqueados}</div>
          <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">Bloqueados</div>
        </td>
      </tr>
    </table>

    <h2 style="font-size:14px;margin:0 0 12px;color:#374151;text-transform:uppercase;letter-spacing:0.5px;">Pedidos do ciclo</h2>
    ${cards}

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:24px 0 0;">
      <tr>
        <td style="text-align:center;">
          <a href="${listaUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;">
            Ver todos os pedidos
          </a>
        </td>
      </tr>
    </table>

    <p style="margin:20px 0 0;font-size:11px;color:#9ca3af;text-align:center;">
      ${pendentes.length} pedido(s) aguardando aprovação · disparo automático às 10:00 BRT
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

    // 1.5. Aplica promoções ativas hoje aos pedidos recém-gerados (best-effort)
    let promoSummary: {
      itens_flat_aplicados: number;
      itens_forward_buying_aplicados: number;
      pedidos_afetados: number;
      economia_total_estimada: number;
      pedidos_bloqueados_por_delta: number;
    } | null = null;
    try {
      const { data: promoRows, error: promoErr } = await db.rpc(
        "aplicar_promocoes_no_ciclo",
        { p_empresa: empresa, p_data_ciclo: dataCiclo },
      );
      if (promoErr) {
        console.error(
          `[gerar-pedidos-diario] aplicar_promocoes_no_ciclo falhou: ${promoErr.message}`,
        );
      } else if (promoRows && promoRows[0]) {
        promoSummary = promoRows[0] as typeof promoSummary;
        console.log(
          `[promocoes] flat=${(promoSummary as any)?.itens_flat_aplicados} forward_buying=${(promoSummary as any)?.itens_forward_buying_aplicados} economia=R$${(promoSummary as any)?.economia_total_estimada} bloqueados_delta=${(promoSummary as any)?.pedidos_bloqueados_por_delta}`,
        );
      }
    } catch (e) {
      console.error(`[gerar-pedidos-diario] promo throw:`, e);
    }

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
        promocoes: promoSummary,
      },
    });

    return new Response(
      JSON.stringify({
        ok: true,
        empresa,
        data_ciclo: dataCiclo,
        ...rpc,
        promocoes: promoSummary,
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
