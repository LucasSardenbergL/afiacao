// Edge function: disparar-pedidos-aprovados
// Às 10:00 BRT (cron 0 13 * * *), processa pedidos aprovados do ciclo do dia.
// - DRY-RUN: cria pedido no Omie via IncluirPedidoCompra, NÃO envia ao fornecedor
// - PRODUÇÃO: cria no Omie + dispara notificação ao fornecedor pelo canal configurado
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const RESEND_URL = "https://api.resend.com/emails";
const FROM_EMAIL = "Reposicao OBEN <onboarding@resend.dev>";
const APP_URL = Deno.env.get("APP_URL") ?? "https://steu.lovable.app";
const OMIE_PEDIDO_COMPRA_URL =
  "https://app.omie.com.br/api/v1/produtos/pedidocompra/";
const OMIE_CLIENTES_URL = "https://app.omie.com.br/api/v1/geral/clientes/";

interface PedidoRow {
  id: number;
  empresa: string;
  fornecedor_nome: string;
  grupo_codigo: string | null;
  data_ciclo: string;
  valor_total: number;
  num_skus: number;
  status: string;
  condicao_pagamento_codigo?: string | null;
  condicao_pagamento_descricao?: string | null;
  num_parcelas?: number | null;
  canal_pedido?: string | null;
  email_pedido?: string | null;
  whatsapp_pedido?: string | null;
  observacoes_pedido?: string | null;
  nome_contato?: string | null;
}

interface ItemRow {
  sku_codigo_omie: string;
  sku_descricao: string | null;
  qtde_final: number;
  preco_unitario: number;
}

function fmtBRL(v: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(v ?? 0);
}

function getOmieCreds(empresa: string): { app_key: string; app_secret: string } {
  const up = empresa.toUpperCase();
  const app_key = Deno.env.get(`OMIE_${up}_APP_KEY`);
  const app_secret = Deno.env.get(`OMIE_${up}_APP_SECRET`);
  if (!app_key || !app_secret) {
    throw new Error(`Credenciais Omie ausentes para empresa ${empresa}`);
  }
  return { app_key, app_secret };
}

function diasUteisFromHoje(diasUteis: number): string {
  // soma dias úteis (seg-sex) ao dia de hoje, retorna DD/MM/YYYY
  const d = new Date();
  let added = 0;
  while (added < diasUteis) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return `${String(d.getDate()).padStart(2, "0")}/${
    String(d.getMonth() + 1).padStart(2, "0")
  }/${d.getFullYear()}`;
}

async function omieCall(
  url: string,
  call: string,
  param: unknown,
  creds: { app_key: string; app_secret: string },
): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      call,
      app_key: creds.app_key,
      app_secret: creds.app_secret,
      param: [param],
    }),
  });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Omie ${call} resposta não-JSON: ${text.slice(0, 300)}`);
  }
  if (!r.ok || json?.faultstring) {
    throw new Error(
      `Omie ${call} erro [${r.status}]: ${
        json?.faultstring ?? text.slice(0, 300)
      }`,
    );
  }
  return json;
}

async function resolveCodigoFornecedor(
  db: any,
  empresa: string,
  fornecedorNome: string,
  creds: { app_key: string; app_secret: string },
): Promise<{ codigo: number; razao_social?: string; cnpj?: string }> {
  // 1. Cache
  const { data: cached } = await db
    .from("fornecedor_omie_cache")
    .select("omie_codigo_cliente_fornecedor, razao_social_omie, cnpj")
    .eq("empresa", empresa)
    .eq("fornecedor_nome", fornecedorNome)
    .maybeSingle();
  if (cached?.omie_codigo_cliente_fornecedor) {
    return {
      codigo: Number(cached.omie_codigo_cliente_fornecedor),
      razao_social: cached.razao_social_omie ?? undefined,
      cnpj: cached.cnpj ?? undefined,
    };
  }

  // 2. Busca no Omie por razão social parcial
  const resp = await omieCall(
    OMIE_CLIENTES_URL,
    "ListarClientes",
    {
      pagina: 1,
      registros_por_pagina: 50,
      apenas_importado_api: "N",
      clientesFiltro: { razao_social: fornecedorNome },
    },
    creds,
  );
  const lista: any[] = resp?.clientes_cadastro ?? [];
  if (lista.length === 0) {
    throw new Error(
      `Fornecedor não encontrado no Omie pelo nome: "${fornecedorNome}"`,
    );
  }
  // Match exato preferido, senão primeiro resultado
  const exato = lista.find(
    (c) =>
      (c.razao_social ?? "").trim().toLowerCase() ===
        fornecedorNome.trim().toLowerCase(),
  );
  const escolhido = exato ?? lista[0];
  const codigo = Number(escolhido.codigo_cliente_omie);
  if (!codigo) {
    throw new Error(`Omie retornou cliente sem codigo: ${JSON.stringify(escolhido).slice(0, 200)}`);
  }

  // 3. Persiste cache
  await db
    .from("fornecedor_omie_cache")
    .upsert({
      empresa,
      fornecedor_nome: fornecedorNome,
      omie_codigo_cliente_fornecedor: codigo,
      razao_social_omie: escolhido.razao_social ?? null,
      cnpj: escolhido.cnpj_cpf ?? null,
      cached_at: new Date().toISOString(),
    });

  return {
    codigo,
    razao_social: escolhido.razao_social,
    cnpj: escolhido.cnpj_cpf,
  };
}

interface ProcessResult {
  pedido_id: number;
  fornecedor: string;
  status_final: string;
  omie_id?: string;
  omie_numero?: string;
  valor: number;
  canal: string;
  erro?: string;
}

async function processarPedido(
  db: any,
  pedido: PedidoRow,
  modo: "dry_run" | "producao",
  creds: { app_key: string; app_secret: string },
): Promise<ProcessResult> {
  const result: ProcessResult = {
    pedido_id: pedido.id,
    fornecedor: pedido.fornecedor_nome,
    status_final: "",
    valor: pedido.valor_total,
    canal: modo === "dry_run"
      ? "DRY_RUN_OMIE_APENAS"
      : (pedido.canal_pedido ?? "—"),
  };

  try {
    // a. Items
    const { data: items, error: itErr } = await db
      .from("pedido_compra_item")
      .select("sku_codigo_omie, sku_descricao, qtde_final, preco_unitario")
      .eq("pedido_id", pedido.id);
    if (itErr) throw new Error(`Items: ${itErr.message}`);
    if (!items || items.length === 0) {
      throw new Error("Pedido sem itens");
    }

    // b. Resolver código do fornecedor
    const fornecedor = await resolveCodigoFornecedor(
      db,
      pedido.empresa,
      pedido.fornecedor_nome,
      creds,
    );

    // c. Lead time logístico (do fornecedor habilitado)
    const { data: fhRow } = await db
      .from("fornecedor_habilitado_reposicao")
      .select("lt_logistica_dias")
      .eq("empresa", pedido.empresa)
      .eq("fornecedor_nome", pedido.fornecedor_nome)
      .maybeSingle();
    const ltDias = Number(fhRow?.lt_logistica_dias ?? 7);

    // d. Numero pedido (max 15 chars Omie)
    const ts = new Date()
      .toISOString()
      .slice(2, 10)
      .replace(/-/g, "");
    const numeroPedido = `AFI${ts}${String(pedido.id).slice(-4)}`.slice(0, 15);

    const produtos_incluir = (items as ItemRow[]).map((it, idx) => ({
      cCodIntItem: `ITEM${String(idx + 1).padStart(3, "0")}`,
      nCodProd: Number(it.sku_codigo_omie),
      nQtde: Number(it.qtde_final),
      nValUnit: Number(it.preco_unitario),
    }));

    // Condição de pagamento (do pedido sugerido)
    // OBS: código "000" no Omie significa "À Vista" (válido). Não confundir com null/vazio.
    const condRaw = pedido.condicao_pagamento_codigo;
    if (condRaw === null || condRaw === undefined || String(condRaw).trim() === "") {
      throw new Error(
        `Pedido sem condição de pagamento. Selecione uma condição antes de disparar.`,
      );
    }
    const condCodigo = Number(condRaw);
    if (Number.isNaN(condCodigo)) {
      throw new Error(
        `Condição de pagamento inválida: "${condRaw}". Deve ser numérica.`,
      );
    }

    const cabecalho_incluir: Record<string, unknown> = {
      cCodIntPed: `AFI-${pedido.id}`,
      dDtPrevisao: diasUteisFromHoje(ltDias),
      nCodFor: Number(fornecedor.codigo),
      cNumPedido: numeroPedido,
      nCodCondPagto: condCodigo,
      cObs:
        `Pedido gerado automaticamente pelo Afiação em ${new Date().toISOString()}${
          modo === "dry_run" ? " [DRY-RUN]" : ""
        }`,
      cObsInt: modo === "dry_run" ? "DRY-RUN Afiação" : "Disparo Afiação",
    };

    const param = { cabecalho_incluir, produtos_incluir };

    // e. Chama Omie (método correto conforme doc: IncluirPedCompra)
    const resp = await omieCall(
      OMIE_PEDIDO_COMPRA_URL,
      "IncluirPedCompra",
      param,
      creds,
    );

    const omieId = String(
      resp?.nCodPed ?? resp?.codigo_pedido ?? resp?.cCodIntPed ?? "",
    );
    const omieNumero = String(resp?.cNumero ?? resp?.numero_pedido ?? numeroPedido);

    // f. Update pedido
    const novoStatus = modo === "dry_run" ? "disparado_simulado" : "disparado";
    await db
      .from("pedido_compra_sugerido")
      .update({
        omie_pedido_compra_id: omieId,
        omie_pedido_compra_numero: omieNumero,
        omie_registrado_em: new Date().toISOString(),
        horario_disparo_real: new Date().toISOString(),
        canal_usado: result.canal,
        resposta_canal: {
          modo,
          omie_resposta: resp,
          fornecedor_notificado: modo === "producao",
          fornecedor_omie: fornecedor,
        },
        status: novoStatus,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", pedido.id);

    result.status_final = novoStatus;
    result.omie_id = omieId;
    result.omie_numero = omieNumero;
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[disparar-pedidos] Falha pedido ${pedido.id}:`, msg);
    await db
      .from("pedido_compra_sugerido")
      .update({
        status: "falha_envio",
        resposta_canal: { erro: msg, modo, ts: new Date().toISOString() },
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", pedido.id);
    result.status_final = "falha_envio";
    result.erro = msg;
    return result;
  }
}

async function notificarFornecedor(
  pedido: PedidoRow,
  items: ItemRow[],
  omieNumero: string,
  resendKey: string,
  staffEmail: string,
): Promise<{ enviado: boolean; detalhe: string }> {
  const canal = (pedido.canal_pedido ?? "").toLowerCase();
  const linhas = items
    .map(
      (it) =>
        `${it.sku_codigo_omie} — ${it.sku_descricao ?? ""} — Qtde: ${it.qtde_final} — ${
          fmtBRL(it.preco_unitario)
        }/un`,
    )
    .join("\n");
  const subject =
    `[Pedido ${omieNumero}] ${pedido.fornecedor_nome} — ${fmtBRL(pedido.valor_total)}`;

  if (canal === "email" && pedido.email_pedido) {
    const r = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [pedido.email_pedido],
        reply_to: staffEmail,
        subject,
        text: `Olá ${pedido.nome_contato ?? ""},\n\nSegue pedido de compra ${omieNumero}:\n\n${linhas}\n\nTotal: ${
          fmtBRL(pedido.valor_total)
        }\n\n${pedido.observacoes_pedido ?? ""}\n\nResponda este email para qualquer dúvida.`,
      }),
    });
    const txt = await r.text();
    return { enviado: r.ok, detalhe: `email→${pedido.email_pedido}: [${r.status}] ${txt.slice(0,150)}` };
  }

  if (canal === "whatsapp" && pedido.whatsapp_pedido) {
    const phone = pedido.whatsapp_pedido.replace(/\D/g, "");
    const msg = encodeURIComponent(
      `Olá ${pedido.nome_contato ?? ""}, segue pedido ${omieNumero}:\n\n${linhas}\n\nTotal: ${
        fmtBRL(pedido.valor_total)
      }`,
    );
    const link = `https://wa.me/${phone}?text=${msg}`;
    const r = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [staffEmail],
        subject: `[Disparar WhatsApp] ${pedido.fornecedor_nome} — ${omieNumero}`,
        html:
          `<p>Pedido <strong>${omieNumero}</strong> pronto para envio via WhatsApp.</p>
           <p><a href="${link}" style="background:#25d366;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Abrir WhatsApp</a></p>
           <pre style="background:#f3f4f6;padding:12px;border-radius:6px;font-size:12px;white-space:pre-wrap;">${linhas}\n\nTotal: ${
            fmtBRL(pedido.valor_total)
          }</pre>`,
      }),
    });
    const txt = await r.text();
    return {
      enviado: r.ok,
      detalhe: `whatsapp link→staff (${staffEmail}): [${r.status}] ${txt.slice(0,150)}`,
    };
  }

  if (canal === "portal_b2b") {
    const r = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [staffEmail],
        subject: `[Portal B2B] ${pedido.fornecedor_nome} — ${omieNumero}`,
        html:
          `<p>Pedido <strong>${omieNumero}</strong> pronto para colar no portal B2B do fornecedor <strong>${pedido.fornecedor_nome}</strong>.</p>
           <p>Contato: ${pedido.nome_contato ?? "—"}</p>
           <p>Observações: ${pedido.observacoes_pedido ?? "—"}</p>
           <pre style="background:#f3f4f6;padding:12px;border-radius:6px;font-size:12px;white-space:pre-wrap;">${linhas}\n\nTotal: ${
            fmtBRL(pedido.valor_total)
          }</pre>`,
      }),
    });
    const txt = await r.text();
    return { enviado: r.ok, detalhe: `portal_b2b→staff: [${r.status}] ${txt.slice(0,150)}` };
  }

  return { enviado: false, detalhe: `canal '${canal}' não suportado ou contato ausente` };
}

function buildResumoEmail(
  empresa: string,
  modo: "dry_run" | "producao",
  resultados: ProcessResult[],
  expirados: number,
): { subject: string; html: string } {
  const sucesso = resultados.filter((r) => r.status_final !== "falha_envio");
  const falhas = resultados.filter((r) => r.status_final === "falha_envio");
  const valorTotal = sucesso.reduce((s, r) => s + (r.valor || 0), 0);
  const ehDry = modo === "dry_run";

  const subject = ehDry
    ? `[DRY-RUN] ${sucesso.length} pedidos criados no Omie às 10:00`
    : `Pedidos disparados: ${sucesso.length} pedidos, ${fmtBRL(valorTotal)}`;

  const linhas = resultados
    .map((r) => {
      const url = `${APP_URL}/admin/reposicao/pedidos?id=${r.pedido_id}`;
      const omieLink = r.omie_id
        ? `<a href="https://app.omie.com.br/" target="_blank" style="color:#3b82f6;">${r.omie_numero ?? r.omie_id}</a>`
        : "—";
      const statusColor = r.status_final === "falha_envio"
        ? "#ef4444"
        : ehDry
        ? "#8b5cf6"
        : "#10b981";
      return `
<tr>
  <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;font-size:13px;">
    <a href="${url}" style="color:#111827;text-decoration:none;font-weight:600;">${r.fornecedor}</a>
  </td>
  <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;font-size:12px;">${omieLink}</td>
  <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:right;font-weight:600;">${fmtBRL(r.valor)}</td>
  <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#6b7280;">${r.canal}</td>
  <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;font-size:11px;">
    <span style="background:${statusColor};color:#fff;padding:2px 8px;border-radius:4px;">${r.status_final}</span>
    ${r.erro ? `<div style="color:#991b1b;font-size:10px;margin-top:4px;">${r.erro}</div>` : ""}
  </td>
</tr>`;
    })
    .join("");

  const html = `
<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f3f4f6;margin:0;padding:16px;color:#111827;">
<div style="max-width:720px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;">
  ${ehDry ? '<div style="background:#ede9fe;color:#5b21b6;padding:8px 12px;border-radius:6px;font-size:12px;font-weight:600;margin-bottom:16px;">MODO DRY-RUN — pedidos criados no Omie mas fornecedores NÃO notificados</div>' : ''}
  <h1 style="margin:0 0 4px;font-size:20px;">${ehDry ? "Disparo simulado" : "Disparo de pedidos"} — ${empresa}</h1>
  <p style="margin:0 0 20px;color:#6b7280;font-size:13px;">${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</p>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:20px;border-spacing:6px 0;">
    <tr>
      <td style="background:#f3f4f6;padding:12px;border-radius:8px;text-align:center;">
        <div style="font-size:22px;font-weight:700;">${sucesso.length}</div>
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;">Disparados</div>
      </td>
      <td style="background:${falhas.length > 0 ? '#fee2e2' : '#f3f4f6'};padding:12px;border-radius:8px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:${falhas.length > 0 ? '#991b1b' : '#111827'};">${falhas.length}</div>
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;">Falhas</div>
      </td>
      <td style="background:#f3f4f6;padding:12px;border-radius:8px;text-align:center;">
        <div style="font-size:22px;font-weight:700;">${expirados}</div>
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;">Expirados</div>
      </td>
      <td style="background:#f3f4f6;padding:12px;border-radius:8px;text-align:center;">
        <div style="font-size:14px;font-weight:700;">${fmtBRL(valorTotal)}</div>
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;">Valor total</div>
      </td>
    </tr>
  </table>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
    <thead>
      <tr style="background:#f9fafb;">
        <th style="padding:8px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Fornecedor</th>
        <th style="padding:8px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Omie</th>
        <th style="padding:8px;text-align:right;font-size:11px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Valor</th>
        <th style="padding:8px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Canal</th>
        <th style="padding:8px;text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Status</th>
      </tr>
    </thead>
    <tbody>${linhas || '<tr><td colspan="5" style="padding:24px;text-align:center;color:#6b7280;">Nenhum pedido aprovado neste ciclo.</td></tr>'}</tbody>
  </table>

  <div style="margin-top:24px;text-align:center;">
    <a href="${APP_URL}/admin/reposicao/pedidos" style="display:inline-block;background:#111827;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">Ver todos no app</a>
  </div>

  ${expirados > 0 ? `<p style="margin-top:20px;font-size:11px;color:#9ca3af;text-align:center;">${expirados} pedido(s) não aprovado(s) até as 10:00 foram marcados como expirado_sem_aprovacao.</p>` : ""}
</div>
</body></html>`;

  return { subject, html };
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
  const dataCiclo = new Date().toISOString().slice(0, 10);

  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body.empresa) empresa = body.empresa;
    }

    console.log(`[disparar-pedidos] Início ${empresa} ${dataCiclo}`);

    // 1. Config (modo + email)
    const { data: cfg, error: cfgErr } = await db
      .from("empresa_configuracao_custos")
      .select("modo_disparo_pedidos, email_notificacoes")
      .eq("empresa", empresa)
      .maybeSingle();
    if (cfgErr) throw new Error(`Config: ${cfgErr.message}`);
    const modo: "dry_run" | "producao" =
      (cfg?.modo_disparo_pedidos === "producao") ? "producao" : "dry_run";
    const staffEmail = cfg?.email_notificacoes ?? "";
    console.log(`[disparar-pedidos] modo=${modo} staffEmail=${staffEmail}`);

    // 2. Pedidos aprovados (com dados do fornecedor)
    const { data: aprovadosRaw, error: aprErr } = await db
      .from("pedido_compra_sugerido")
      .select("id, empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, condicao_pagamento_codigo, condicao_pagamento_descricao, num_parcelas")
      .eq("empresa", empresa)
      .eq("data_ciclo", dataCiclo)
      .eq("status", "aprovado_aguardando_disparo");
    if (aprErr) throw new Error(`Aprovados: ${aprErr.message}`);
    const aprovados = (aprovadosRaw ?? []) as PedidoRow[];

    // Enrich com dados do fornecedor
    for (const p of aprovados) {
      const { data: fh } = await db
        .from("fornecedor_habilitado_reposicao")
        .select("canal_pedido, email_pedido, whatsapp_pedido, observacoes_pedido, nome_contato")
        .eq("empresa", p.empresa)
        .eq("fornecedor_nome", p.fornecedor_nome)
        .maybeSingle();
      if (fh) Object.assign(p, fh);
    }

    // 3. Expirar não aprovados
    const { data: expRows, error: expErr } = await db
      .from("pedido_compra_sugerido")
      .update({
        status: "expirado_sem_aprovacao",
        atualizado_em: new Date().toISOString(),
      })
      .eq("empresa", empresa)
      .eq("data_ciclo", dataCiclo)
      .eq("status", "pendente_aprovacao")
      .select("id");
    if (expErr) console.error("[disparar-pedidos] expirar erro:", expErr.message);
    const expirados = expRows?.length ?? 0;
    console.log(`[disparar-pedidos] ${expirados} pedidos expirados`);

    // 4. Processar cada aprovado
    const creds = getOmieCreds(empresa);
    const resultados: ProcessResult[] = [];
    for (const p of aprovados) {
      const r = await processarPedido(db, p, modo, creds);

      // 5. Se produção e Omie OK: notificar fornecedor
      if (
        modo === "producao" &&
        r.status_final === "disparado" &&
        resendKey &&
        staffEmail
      ) {
        const { data: items } = await db
          .from("pedido_compra_item")
          .select("sku_codigo_omie, sku_descricao, qtde_final, preco_unitario")
          .eq("pedido_id", p.id);
        const notif = await notificarFornecedor(
          p,
          (items ?? []) as ItemRow[],
          r.omie_numero ?? "",
          resendKey,
          staffEmail,
        );
        await db
          .from("pedido_compra_sugerido")
          .update({
            resposta_canal: {
              modo,
              omie_numero: r.omie_numero,
              fornecedor_notificado: notif.enviado,
              notificacao_detalhe: notif.detalhe,
            },
          })
          .eq("id", p.id);
      }

      resultados.push(r);
    }

    // 6. Email resumo p/ Lucas
    let emailStatus: "sent" | "skipped" | "failed" = "skipped";
    let emailDetail: string | null = null;
    if (resendKey && staffEmail) {
      const { subject, html } = buildResumoEmail(empresa, modo, resultados, expirados);
      const r = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resendKey}`,
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [staffEmail],
          subject,
          html,
        }),
      });
      const txt = await r.text();
      emailStatus = r.ok ? "sent" : "failed";
      emailDetail = `[${r.status}] ${txt.slice(0, 200)}`;
    } else {
      emailDetail = !staffEmail
        ? "Sem email_notificacoes"
        : "RESEND_API_KEY ausente";
    }

    const falhas = resultados.filter((r) => r.status_final === "falha_envio").length;
    const duration = Date.now() - startedAt;

    await db.from("sync_reprocess_log").insert({
      entity_type: "pedidos_compra_disparo",
      account: empresa,
      reprocess_type: "disparo_diario",
      window_start: windowStart,
      window_end: new Date().toISOString(),
      status: falhas > 0 ? "partial" : "ok",
      upserts_count: resultados.length - falhas,
      divergences_found: falhas,
      duration_ms: duration,
      metadata: {
        data_ciclo: dataCiclo,
        modo,
        aprovados: aprovados.length,
        expirados,
        falhas,
        email_status: emailStatus,
        email_detail: emailDetail,
        resultados,
      },
    });

    return new Response(
      JSON.stringify({
        ok: true,
        empresa,
        modo,
        data_ciclo: dataCiclo,
        aprovados: aprovados.length,
        disparados: resultados.length - falhas,
        falhas,
        expirados,
        email_status: emailStatus,
        duration_ms: duration,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[disparar-pedidos] ERRO FATAL:`, msg);
    await db.from("sync_reprocess_log").insert({
      entity_type: "pedidos_compra_disparo",
      account: empresa,
      reprocess_type: "disparo_diario",
      window_start: windowStart,
      window_end: new Date().toISOString(),
      status: "error",
      duration_ms: Date.now() - startedAt,
      error_message: msg,
      metadata: { data_ciclo: dataCiclo },
    });
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
