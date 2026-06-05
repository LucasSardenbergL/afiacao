// Edge function: disparar-pedidos-aprovados
// Às 10:00 BRT (cron 0 13 * * *), processa pedidos aprovados do ciclo do dia.
// - DRY-RUN: cria pedido no Omie via IncluirPedidoCompra, NÃO envia ao fornecedor
// - PRODUÇÃO: cria no Omie + dispara notificação ao fornecedor pelo canal configurado
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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
  // PR4: data de entrega confirmada pelo portal Sayerlack (ISO YYYY-MM-DD).
  // Quando presente em pedido Sayerlack/OBEN, vira base do dDtPrevisao do
  // Omie (+ 2 dias úteis). Quando ausente, cai no fallback de lead time.
  portal_data_entrega?: string | null;
  // PR5: split de pedidos grandes em filhos com <= 4 itens cada.
  // Preenchidos só nos filhos (e split_total também no pai). Quando um filho
  // chega no fluxo, é tratado como pedido independente — segue caminho normal.
  split_parent_id?: number | null;
  split_lote?: number | null;
  split_total?: number | null;
}

// PR5: tamanho máximo de cada chunk no split. Calibração:
//   Free (60s sessão):       4 itens  — split agressivo
//   Prototyping (15min):    20 itens  — split só pra pedidos absurdamente grandes
//
// PR9: subimos pra 20 com upgrade pro Prototyping. Pedidos de até ~30 SKUs
// cabem em uma sessão única (login 12s + 30×7.5s + submit 14s ≈ 251s,
// abaixo do HARD_CEILING_MS=280s). Acima de 20, split ainda atua como
// proteção (ex: pedido de 40 SKUs vira 2 filhos de 20).
const SPLIT_CHUNK_SIZE = 20;

interface ItemRow {
  sku_codigo_omie: string;
  sku_descricao: string | null;
  qtde_final: number;
  preco_unitario: number;
}

interface OmieGenericResponse {
  faultstring?: string;
  // IncluirPedCompra
  nCodPed?: number | string;
  codigo_pedido?: number | string;
  cCodIntPed?: string;
  cNumero?: string;
  numero_pedido?: string;
  // ListarClientes
  clientes_cadastro?: OmieClienteCadastro[];
  [key: string]: unknown;
}

interface OmieClienteCadastro {
  codigo_cliente_omie?: number | string;
  razao_social?: string;
  cnpj_cpf?: string;
  [key: string]: unknown;
}

interface PortalAsyncResponseBody {
  accepted?: boolean;
  [key: string]: unknown;
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

// Email do aprovador p/ o cEmailAprovador do IncluirPedCompra (auto-aprovação no Omie).
// Por empresa (OMIE_<EMPRESA>_EMAIL_APROVADOR) com fallback global (OMIE_EMAIL_APROVADOR).
// Sem env var setada → null (degradação honesta: o campo não é enviado e o pedido entra pendente,
// como hoje). Espelha o padrão por-empresa de getOmieCreds.
function getEmailAprovador(empresa: string): string | null {
  const up = empresa.toUpperCase();
  const email = Deno.env.get(`OMIE_${up}_EMAIL_APROVADOR`) ??
    Deno.env.get("OMIE_EMAIL_APROVADOR");
  const trimmed = email?.trim();
  return trimmed ? trimmed : null;
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
): Promise<OmieGenericResponse> {
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
  let json: OmieGenericResponse;
  try {
    json = JSON.parse(text) as OmieGenericResponse;
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

// ⚠️ ESPELHADO VERBATIM de src/lib/reposicao/omie-disparo-helpers.ts — mudou lá? Copie aqui.
function isOmiePedidoJaCadastrado(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  if (/j[áa]\s+(foi\s+)?cadastrad/.test(m)) return true;
  if (/c[óo]digo\s+de\s+integra\w*/.test(m) && /cadastrad/.test(m)) return true;
  if (/already\s+(registered|exists)/.test(m)) return true;
  return false;
}
function extrairPedidoOmie(resp: unknown): { id: string; numero: string } | null {
  if (!resp || typeof resp !== "object") return null;
  const r = resp as Record<string, unknown>;
  const cab = (r.pedido_compra_cabecalho ?? r.cabecalho ?? r.cabecalho_consulta ?? r) as Record<string, unknown>;
  const idRaw = cab?.nCodPed ?? r.nCodPed;
  if (idRaw == null) return null;
  const numeroRaw = cab?.cNumero ?? r.cNumero;
  return { id: String(idRaw), numero: numeroRaw != null ? String(numeroRaw) : "" };
}

async function resolveCodigoFornecedor(
  db: SupabaseClient,
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
  const lista: OmieClienteCadastro[] = resp?.clientes_cadastro ?? [];
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
  // Reconciliado = o PV já existia no Omie ("já cadastrado"); marcamos disparado
  // sem re-criar. O caller NÃO deve re-notificar o fornecedor (evita e-mail duplicado).
  reconciliado?: boolean;
}

type PortalDispatchResult =
  | { state: "already_sent"; protocolo: string }
  | { state: "queued"; accepted: boolean }
  | { state: "needs_reconciliation"; status: string };

function isSayerlackOben(pedido: PedidoRow): boolean {
  return (
    (pedido.empresa ?? "").toUpperCase() === "OBEN" &&
    /sayerlack/i.test(pedido.fornecedor_nome ?? "")
  );
}

/**
 * PR8: aguarda um pedido sair do estado `enviando_portal` (background task
 * de enviar-pedido-portal-sayerlack terminou). Usado pra serializar disparos
 * de filhos Sayerlack/OBEN do mesmo split — evita burst de chamadas
 * concorrentes no Browserless, que rejeita por concorrência e devolve
 * "200 sem envelope" → indeterminado_requer_conciliacao indevido.
 *
 * Faz polling no banco. Retorna o status final encontrado ou null se
 * estourou o timeout (caso em que seguimos pro próximo mesmo assim,
 * pra não travar o loop).
 *
 * Estados que consideramos "terminou":
 *   sucesso_portal, enviado_portal (legado), aceito_portal_sem_protocolo,
 *   indeterminado_requer_conciliacao, erro_retentavel, erro_nao_retentavel,
 *   falha_envio_portal (legado).
 * Estado que ainda está rodando: enviando_portal.
 */
async function aguardarPortalTerminar(
  db: SupabaseClient,
  pedidoId: number,
  timeoutMs: number,
): Promise<string | null> {
  const POLL_INTERVAL_MS = 3000;
  const ESTADOS_FINAIS = new Set([
    "sucesso_portal",
    "enviado_portal",
    "aceito_portal_sem_protocolo",
    "indeterminado_requer_conciliacao",
    "erro_retentavel",
    "erro_nao_retentavel",
    "falha_envio_portal",
  ]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await db
      .from("pedido_compra_sugerido")
      .select("status_envio_portal")
      .eq("id", pedidoId)
      .maybeSingle();
    const s = (data?.status_envio_portal ?? null) as string | null;
    if (s && ESTADOS_FINAIS.has(s)) return s;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * PR5: divide pedidos Sayerlack/OBEN com mais de SPLIT_CHUNK_SIZE itens em
 * filhos menores. Cada filho cabe na janela de 60s do Browserless.
 *
 * Só atua em modo "producao" — dry_run não toca o banco. Só atua em pedidos
 * Sayerlack/OBEN, e nunca em pedidos que já são filhos de um split anterior.
 *
 * Retorna a lista expandida: pedidos não-Sayerlack ou pequenos passam direto;
 * pedidos grandes são substituídos pelos seus filhos. Se a RPC falhar, deixa
 * o pedido original na lista (vai bater o teto do Browserless e ser tratado
 * pelo PR2/PR3 — degradação suave).
 */
async function dividirPedidosGrandesSayerlack(
  db: SupabaseClient,
  aprovados: PedidoRow[],
  modo: "dry_run" | "producao",
): Promise<PedidoRow[]> {
  if (modo !== "producao") return aprovados;

  const expandido: PedidoRow[] = [];
  for (const pedido of aprovados) {
    if (pedido.split_parent_id) {
      // Já é filho — não redivide.
      expandido.push(pedido);
      continue;
    }
    if (!isSayerlackOben(pedido)) {
      expandido.push(pedido);
      continue;
    }

    const { count: itensCount, error: countErr } = await db
      .from("pedido_compra_item")
      .select("id", { count: "exact", head: true })
      .eq("pedido_id", pedido.id);

    if (countErr) {
      console.error(`[disparar-pedidos] Falha ao contar itens do pedido ${pedido.id}: ${countErr.message}`);
      expandido.push(pedido);
      continue;
    }
    if (!itensCount || itensCount <= SPLIT_CHUNK_SIZE) {
      expandido.push(pedido);
      continue;
    }

    console.log(`[disparar-pedidos] Pedido ${pedido.id} tem ${itensCount} itens — dividindo em chunks de ${SPLIT_CHUNK_SIZE}`);

    const { data: filhos, error: splitErr } = await db.rpc("pedido_compra_split", {
      p_pedido_id: pedido.id,
      p_chunk_size: SPLIT_CHUNK_SIZE,
    });

    if (splitErr) {
      console.error(`[disparar-pedidos] Falha no RPC pedido_compra_split para ${pedido.id}: ${splitErr.message}`);
      // RPC é atômica: se falhou, o pai está intocado. Cai no fallback.
      expandido.push(pedido);
      continue;
    }

    const filhoIds = ((filhos ?? []) as Array<{ filho_id: number }>).map((f) => Number(f.filho_id));
    if (filhoIds.length === 0) {
      console.warn(`[disparar-pedidos] RPC retornou 0 filhos para ${pedido.id} (count=${itensCount}) — processando original`);
      expandido.push(pedido);
      continue;
    }

    const { data: filhoRows, error: fetchErr } = await db
      .from("pedido_compra_sugerido")
      .select("id, empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, condicao_pagamento_codigo, condicao_pagamento_descricao, num_parcelas, portal_data_entrega, split_parent_id, split_lote, split_total")
      .in("id", filhoIds)
      .order("split_lote", { ascending: true });

    if (fetchErr || !filhoRows) {
      console.error(`[disparar-pedidos] Falha ao carregar filhos do split do pedido ${pedido.id}: ${fetchErr?.message ?? "sem dados"}`);
      // Filhos existem no banco mas não conseguimos carregar agora — vão ser
      // pegos no próximo run normal do cron (ficaram aprovado_aguardando_disparo).
      continue;
    }

    // Replica enrichment de fornecedor que o caller faz nos aprovados originais.
    for (const fr of filhoRows as PedidoRow[]) {
      const { data: fh } = await db
        .from("fornecedor_habilitado_reposicao")
        .select("canal_pedido, email_pedido, whatsapp_pedido, observacoes_pedido, nome_contato")
        .eq("empresa", fr.empresa)
        .eq("fornecedor_nome", fr.fornecedor_nome)
        .maybeSingle();
      if (fh) Object.assign(fr, fh);
    }

    console.log(`[disparar-pedidos] Pedido ${pedido.id} → ${filhoIds.length} filhos: [${filhoIds.join(", ")}]`);
    expandido.push(...(filhoRows as PedidoRow[]));
  }
  return expandido;
}

/**
 * Para pedidos Sayerlack/OBEN: garante que o pedido foi enviado ao portal
 * Sayerlack ANTES de criar o pedido de compra no Omie. Retorna o protocolo
 * para ser usado como cContrato no IncluirPedCompra.
 *
 * Lança erro se o portal falhou (impede criação no Omie sem protocolo).
 */
async function iniciarEnvioPortalSayerlack(
  db: SupabaseClient,
  pedidoId: number,
): Promise<PortalDispatchResult> {
  // Já enviado em execução anterior?
  const { data: pre } = await db
    .from("pedido_compra_sugerido")
    .select("status_envio_portal, portal_protocolo, portal_erro")
    .eq("id", pedidoId)
    .maybeSingle();
  const statusPortalAtual: string = pre?.status_envio_portal ?? "";
  if (
    (statusPortalAtual === "enviado_portal" || statusPortalAtual === "sucesso_portal") &&
    pre?.portal_protocolo
  ) {
    console.log(`[disparar-pedidos] Pedido ${pedidoId}: portal já enviado (protocolo=${pre.portal_protocolo})`);
    return { state: "already_sent", protocolo: String(pre.portal_protocolo) };
  }

  // Blindagem contra duplicidade (PR1): se o portal pode ter recebido o pedido
  // (aceito sem protocolo) ou o resultado é ambíguo, NÃO reenvia — resetar para
  // pendente aqui geraria pedido duplicado no portal. Exige conciliação.
  if (
    statusPortalAtual === "aceito_portal_sem_protocolo" ||
    statusPortalAtual === "indeterminado_requer_conciliacao"
  ) {
    console.warn(`[disparar-pedidos] Pedido ${pedidoId}: status_envio_portal=${statusPortalAtual} — requer conciliacao, NÃO reenviado`);
    return { state: "needs_reconciliation", status: statusPortalAtual };
  }

  // Já em voo no portal? NÃO re-enfileirar — evita 2ª sessão Browserless e o
  // rebaixamento enviando_portal → pendente. O claim atômico do envio (envio_portal_claim_ids)
  // cobre o Browserless; aqui evitamos tocar a coluna de um envio concorrente.
  if (statusPortalAtual === "enviando_portal") {
    console.warn(`[disparar-pedidos] Pedido ${pedidoId}: já enviando_portal — não re-enfileirado`);
    return { state: "queued", accepted: true };
  }

  // Pré-claim do portal via RPC SQL pura — NÃO via PostgREST .update().select():
  // o #592/§7 mostrou que filtrar status_envio_portal num UPDATE pela API REST quebra
  // (42703 "column does not exist"; incidente de 324 pedidos presos). Todos os claims
  // dessa coluna são RPC SQL. A RPC seta 'pendente_envio_portal' SÓ se o pedido não
  // estiver 'enviando_portal' (CONDICIONAL: não rebaixa um envio concorrente em voo),
  // cobre NULL via COALESCE, e grava o relógio de stale ESTÁVEL (+15min) p/ o lote-retry.
  // Retorna false se o claim foi perdido (concorrência) → não re-enfileira.
  const { data: claimed, error: claimErr } = await db.rpc(
    "iniciar_envio_portal_pre_claim",
    { p_pedido_id: pedidoId },
  );
  if (claimErr) {
    throw new Error(`Pré-claim do portal falhou: ${claimErr.message}`);
  }
  if (!claimed) {
    console.warn(`[disparar-pedidos] Pedido ${pedidoId}: pré-claim do portal perdido (concorrência/estado) — não re-enfileirado`);
    return { state: "queued", accepted: true };
  }

  const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
  const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const url = `${SUPA_URL}/functions/v1/enviar-pedido-portal-sayerlack`;

  console.log(`[disparar-pedidos] Pedido ${pedidoId}: enfileirando portal Sayerlack em background...`);
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15_000);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SVC_KEY}`,
      },
        body: JSON.stringify({ pedido_id: pedidoId, async_mode: true }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const body = (await resp.json().catch(() => ({}))) as PortalAsyncResponseBody;
  if (!resp.ok) {
    throw new Error(
      `Portal Sayerlack retornou ${resp.status}: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }

  if (resp.status !== 202 && !body?.accepted) {
    throw new Error(
      `Portal Sayerlack não aceitou processamento assíncrono (${resp.status}): ${JSON.stringify(body).slice(0, 300)}`,
    );
  }

  console.log(`[disparar-pedidos] Pedido ${pedidoId}: portal aceito em background`);
  return { state: "queued", accepted: true };
}

async function processarPedido(
  db: SupabaseClient,
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

    // a.1 Guard de payload (money-path): nunca enviar item inválido (preço ou
    // quantidade <= 0) ao Omie. Roda ANTES do portal Sayerlack — senão o
    // fornecedor recebe o pedido e o Omie falha depois (pedido fica em
    // falha_envio sem registro, e a engine re-sugere os mesmos SKUs no ciclo
    // seguinte). Falha cedo, com motivo claro.
    const itensSemCusto = (items as ItemRow[]).filter(
      (it) => !(Number(it.preco_unitario) > 0),
    );
    if (itensSemCusto.length > 0) {
      const lista = itensSemCusto
        .map((it) => `${it.sku_codigo_omie} (${it.sku_descricao ?? "sem descrição"})`)
        .join("; ");
      throw new Error(
        `SKU(s) sem custo (preço unitário 0): ${lista}. Defina o custo antes de disparar.`,
      );
    }
    // nQtde <= 0 quebra o Omie com "O preenchimento da tag [nQtde] é obrigatório".
    const itensSemQtde = (items as ItemRow[]).filter(
      (it) => !(Number(it.qtde_final) > 0),
    );
    if (itensSemQtde.length > 0) {
      const lista = itensSemQtde
        .map((it) => `${it.sku_codigo_omie} (${it.sku_descricao ?? "sem descrição"})`)
        .join("; ");
      throw new Error(
        `SKU(s) com quantidade 0: ${lista}. Ajuste a quantidade ou remova o item antes de disparar.`,
      );
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

    // d.1 Sayerlack/OBEN: o portal é lento e precisa rodar em background.
    // Se já houver protocolo de execução anterior, cria o Omie normalmente.
    // Caso contrário, apenas enfileira o portal e finaliza sem marcar falha.
    let cContratoFinal = numeroPedido;
    let protocoloPortal: string | null = null;
    if (isSayerlackOben(pedido) && modo === "producao") {
      const portal = await iniciarEnvioPortalSayerlack(db, pedido.id);
      if (portal.state === "queued") {
        await db
          .from("pedido_compra_sugerido")
          .update({
            canal_usado: "portal_sayerlack",
            resposta_canal: {
              modo,
              portal_async: true,
              fornecedor_notificado: false,
              mensagem: "Envio ao portal Sayerlack iniciado em background; Omie será registrado após confirmação manual/reprocessamento com protocolo.",
            },
            atualizado_em: new Date().toISOString(),
          })
          .eq("id", pedido.id);
        result.status_final = "aguardando_portal_sayerlack";
        result.canal = "portal_sayerlack";
        return result;
      }
      if (portal.state === "needs_reconciliation") {
        // Portal pode ter recebido o pedido — NÃO cria o Omie nem reenvia.
        await db
          .from("pedido_compra_sugerido")
          .update({
            canal_usado: "portal_sayerlack",
            resposta_canal: {
              modo,
              portal_async: false,
              fornecedor_notificado: false,
              mensagem: `Envio ao portal Sayerlack em estado '${portal.status}' — requer conciliacao manual antes de registrar no Omie.`,
            },
            atualizado_em: new Date().toISOString(),
          })
          .eq("id", pedido.id);
        result.status_final = "portal_requer_conciliacao";
        result.canal = "portal_sayerlack";
        return result;
      }
      protocoloPortal = portal.protocolo;
      // cContrato Omie aceita até 15 chars; protocolo é só dígitos
      cContratoFinal = String(protocoloPortal).slice(0, 15);
      result.canal = "portal_sayerlack";
    }

    const produtos_incluir = (items as ItemRow[]).map((it, idx) => ({
      cCodIntItem: `ITEM${String(idx + 1).padStart(3, "0")}`,
      nCodProd: Number(it.sku_codigo_omie),
      nQtde: Number(it.qtde_final),
      nValUnit: Number(it.preco_unitario),
    }));

    // Condição de pagamento (do pedido sugerido)
    // OBS: no Omie o campo é cCodParc (string3). Código "000" = "À Vista".
    const condRaw = pedido.condicao_pagamento_codigo;
    if (condRaw === null || condRaw === undefined || String(condRaw).trim() === "") {
      throw new Error(
        `Pedido sem condição de pagamento. Selecione uma condição antes de disparar.`,
      );
    }
    // Normaliza para string de até 3 chars, mantendo zeros à esquerda (ex: "000")
    const cCodParc = String(condRaw).trim().slice(0, 3);
    const nQtdeParc = Math.max(1, Number(pedido.num_parcelas ?? 1) || 1);

    // PR4: para Sayerlack/OBEN, usa a data de entrega confirmada pelo portal
    // + 2 dias ÚTEIS como dDtPrevisao do Omie (pula sábado/domingo). Cai no
    // fallback de lead time logístico se não capturamos a data do portal
    // (ex.: caminho PR1.5 do recorder fallback, ou pedidos antigos antes da
    // coluna existir).
    const dDtPrevisao = (() => {
      const portalDate = pedido.portal_data_entrega;
      if (typeof portalDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(portalDate)) {
        const d = new Date(`${portalDate}T00:00:00Z`);
        let adicionados = 0;
        while (adicionados < 2) {
          d.setUTCDate(d.getUTCDate() + 1);
          const dow = d.getUTCDay(); // 0=domingo, 6=sábado
          if (dow !== 0 && dow !== 6) adicionados++;
        }
        return `${String(d.getUTCDate()).padStart(2, "0")}/${
          String(d.getUTCMonth() + 1).padStart(2, "0")
        }/${d.getUTCFullYear()}`;
      }
      return diasUteisFromHoje(ltDias);
    })();

    const cabecalho_incluir: Record<string, unknown> = {
      cCodIntPed: `AFI-${pedido.id}`,
      dDtPrevisao,
      nCodFor: Number(fornecedor.codigo),
      // cNumPedido (Nº do Pedido do Fornecedor) deixado em branco — preenchido pelo
      // fornecedor quando confirmar. Para Sayerlack, usamos o protocolo do portal
      // como cContrato (Nº do Contrato); para os demais, número interno AFI...
      cContrato: cContratoFinal,
      cCodParc,
      nQtdeParc,
      cObs:
        `Pedido gerado automaticamente pelo Afiação em ${new Date().toISOString()}${
          modo === "dry_run" ? " [DRY-RUN]" : ""
        }`,
      cObsInt: modo === "dry_run" ? "DRY-RUN Afiação" : "Disparo Afiação",
    };

    // Auto-aprovação no Omie: cEmailAprovador faz o PC entrar JÁ na etapa "aprovado" do kanban
    // do Omie (em nome do aprovador), sem o clique manual de "Aprovar Pedido" lá dentro. Doc Omie:
    // preenchido → "o pedido de compra será atribuído a etapa de aprovação com o status de aprovado".
    // Vale p/ qualquer fornecedor. Sem env var → campo omitido, pedido entra pendente (como hoje).
    const emailAprovador = getEmailAprovador(pedido.empresa);
    if (emailAprovador) {
      cabecalho_incluir.cEmailAprovador = emailAprovador;
    }

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
          portal_protocolo: protocoloPortal,
          cContrato_usado: cContratoFinal,
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
    // Idempotência Omie: cCodIntPed=AFI-<id> é estável; o Omie REJEITA duplicado
    // ("já cadastrado"). Isso significa que o PV pode JÁ existir (corrida disparo×cron
    // ou retry pós-crash) → reconciliar, NÃO falhar. Só em produção (dry_run não cria
    // PV persistente que queiramos reconciliar como disparado real).
    if (modo === "producao" && isOmiePedidoJaCadastrado(msg)) {
      let existente: { id: string; numero: string } | null = null;
      let consultaErro: string | null = null;
      try {
        const consulta = await omieCall(
          OMIE_PEDIDO_COMPRA_URL,
          "ConsultarPedCompra",
          { cCodIntPed: `AFI-${pedido.id}` },
          creds,
        );
        existente = extrairPedidoOmie(consulta);
      } catch (e2) {
        consultaErro = e2 instanceof Error ? e2.message : String(e2);
      }
      // SALVAGUARDA: só reconcilia como 'disparado' se ConsultarPedCompra CONFIRMAR
      // que o PV existe. Consulta vazia (false-positive do matcher) ou erro → NÃO
      // marcar disparado; cair em falha_envio re-tentável. Nunca marca um disparo
      // falho como sucesso.
      if (existente) {
        await db
          .from("pedido_compra_sugerido")
          .update({
            omie_pedido_compra_id: existente.id,
            omie_pedido_compra_numero: existente.numero,
            omie_registrado_em: new Date().toISOString(),
            status: "disparado",
            resposta_canal: {
              reconciliado: true,
              motivo: "ja_cadastrado_omie",
              erro_original: msg,
              ts: new Date().toISOString(),
            },
            atualizado_em: new Date().toISOString(),
          })
          .eq("id", pedido.id);
        console.warn(
          `[disparar-pedidos] Pedido ${pedido.id}: confirmado no Omie (cCodIntPed) → reconciliado como disparado (id=${existente.id})`,
        );
        result.status_final = "disparado";
        result.omie_id = existente.id;
        result.omie_numero = existente.numero;
        result.reconciliado = true;
        return result;
      }
      console.warn(
        `[disparar-pedidos] Pedido ${pedido.id}: "já cadastrado" NÃO confirmado (consulta ${consultaErro ? "falhou: " + consultaErro : "vazia"}) → falha_envio re-tentável`,
      );
    }
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

async function authorizeCronOrStaff(req: Request): Promise<boolean> {
  const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
  const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CRON_SEC = Deno.env.get("CRON_SECRET");
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret && CRON_SEC && cronSecret === CRON_SEC) return true;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  if (token === SVC_KEY) return true;
  try {
    const userRes = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: SVC_KEY },
    });
    if (!userRes.ok) return false;
    const user = await userRes.json();
    if (!user?.id) return false;
    const roleRes = await fetch(
      `${SUPA_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`,
      { headers: { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}` } },
    );
    if (!roleRes.ok) return false;
    const roles = (await roleRes.json()) as Array<{ role: string }>;
    const allowed = new Set(["employee", "master"]);
    return roles.some((r) => allowed.has(r.role));
  } catch { return false; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!(await authorizeCronOrStaff(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const db = createClient(supabaseUrl, serviceKey);
  const startedAt = Date.now();
  const windowStart = new Date().toISOString();

  let empresa = "OBEN";
  let dataCiclo = new Date().toISOString().slice(0, 10);
  let pedidoId: number | null = null;

  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body.empresa) empresa = body.empresa;
      if (body.data_ciclo) dataCiclo = body.data_ciclo;
      if (body.pedido_id != null) {
        const parsedPedidoId = Number(body.pedido_id);
        if (Number.isFinite(parsedPedidoId)) pedidoId = parsedPedidoId;
      }
    }

    console.log(`[disparar-pedidos] Início ${empresa} ${dataCiclo}${pedidoId ? ` pedido=${pedidoId}` : ""}`);

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
    let aprovadosQuery = db
      .from("pedido_compra_sugerido")
      .select("id, empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, condicao_pagamento_codigo, condicao_pagamento_descricao, num_parcelas, portal_data_entrega, split_parent_id, split_lote, split_total")
      .eq("empresa", empresa);

    aprovadosQuery = pedidoId
      ? aprovadosQuery.eq("id", pedidoId).in("status", ["aprovado_aguardando_disparo", "falha_envio"])
      : aprovadosQuery.eq("data_ciclo", dataCiclo).eq("status", "aprovado_aguardando_disparo");

    const { data: aprovadosRaw, error: aprErr } = await aprovadosQuery;
    if (aprErr) throw new Error(`Aprovados: ${aprErr.message}`);
    let aprovados = (aprovadosRaw ?? []) as PedidoRow[];
    if (pedidoId && aprovados[0]?.data_ciclo) dataCiclo = aprovados[0].data_ciclo;

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

    // PR5: divide pedidos Sayerlack/OBEN com >4 itens em filhos menores que
    // caibam na janela de 60s do Browserless. Cada filho vira um pedido
    // independente no banco e segue o caminho normal (portal → Omie).
    aprovados = await dividirPedidosGrandesSayerlack(db, aprovados, modo);

    // 3. Expirar não aprovados
    let expirados = 0;
    if (!pedidoId) {
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
      expirados = expRows?.length ?? 0;
    }
    console.log(`[disparar-pedidos] ${expirados} pedidos expirados`);

    // 4. Processar cada aprovado
    const creds = getOmieCreds(empresa);
    const resultados: ProcessResult[] = [];
    for (const p of aprovados) {
      const r = await processarPedido(db, p, modo, creds);

      // PR8 (revisado em PR10): serializa apenas FILHOS de split. Pedidos
      // únicos Sayerlack não precisam esperar — disparam async e seguimos.
      //
      // Por quê: o objetivo original do PR8 era evitar que N filhos de um
      // mesmo split chamassem Browserless em paralelo (free plan só aceitava
      // 1 concorrente). Com upgrade pro Prototyping (10 concorrentes), pedido
      // único não tem competição. E o await de 90s + overhead empurrava o
      // disparar pro limite de 150s do Supabase Edge Function (IDLE_TIMEOUT).
      //
      // Resultado: pedido único Sayerlack passa direto (~1s no loop, fast);
      // split filhos ainda esperam ~90s entre si pra evitar concorrência caso
      // o usuário volte pro free no futuro.
      if (
        r.status_final === "aguardando_portal_sayerlack" &&
        isSayerlackOben(p) &&
        p.split_parent_id
      ) {
        const splitTag = `Lote ${p.split_lote ?? "?"}/${p.split_total ?? "?"} de #${p.split_parent_id}`;
        console.log(`[disparar-pedidos] PR8/PR10: aguardando #${p.id} (${splitTag}) sair de enviando_portal antes do próximo filho...`);
        const tWait = Date.now();
        const finalStatus = await aguardarPortalTerminar(db, p.id, 90_000);
        const waitMs = Date.now() - tWait;
        console.log(`[disparar-pedidos] PR8/PR10: #${p.id} portal terminou em ${waitMs}ms com status_envio_portal=${finalStatus ?? "TIMEOUT"}`);
      }

      // 5. Se produção e Omie OK: notificar fornecedor
      if (
        modo === "producao" &&
        r.status_final === "disparado" &&
        !r.reconciliado &&
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
    const aguardandoPortal = resultados.filter((r) => r.status_final === "aguardando_portal_sayerlack").length;
    const disparadosOk = resultados.filter((r) =>
      r.status_final === "disparado" || r.status_final === "disparado_simulado"
    ).length;
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
        disparados: disparadosOk,
        aguardando_portal_sayerlack: aguardandoPortal,
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
