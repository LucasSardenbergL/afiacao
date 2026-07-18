import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { comRegistro, type DbRegistro } from "../_shared/registro-execucao.ts";
import { fetchAll } from "../_shared/paginate.ts";
import { montarUpsertsDeCusto } from "../_shared/cost-compute.ts";
import { recomporCustoProducao } from "../_shared/recompor-custo-producao.ts";
import { buildProductIdMap, montarCatalogoPorCod } from "../_shared/product-idmap.ts";
import { avaliarPagina, MAX_PAGINAS_POS_ESTOQUE, proximoTotalPaginas } from "../_shared/omie-paginacao.ts";
import { acumularPosicoesDaPagina, type PosicaoEstoque } from "../_shared/pos-estoque.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

type OmieAccount = "vendas" | "servicos" | "colacor_vendas";

// ======== NÃO-VINCULADOS: helpers espelhados de src/lib/clientes-nao-vinculados/snapshot.ts ========
type Empresa = "oben" | "colacor" | "colacor_sc";

interface NaoVinculadoRow {
  empresa: Empresa;
  omie_codigo_cliente: number;
  cnpj_cpf: string;
  razao_social: string | null;
  nome_fantasia: string | null;
  cidade: string | null;
  uf: string | null;
  codigo_vendedor: number | null;
  synced_at: string;
}

function accountToEmpresa(account: OmieAccount): Empresa {
  switch (account) {
    case "vendas":
      return "oben";
    case "colacor_vendas":
      return "colacor";
    case "servicos":
      return "colacor_sc";
    default:
      // fail-closed: account fora do enum (input inválido no boundary JSON) NÃO pode virar
      // .eq("account", undefined) — aborta em vez de resolver product_id contra a empresa errada.
      throw new Error(`accountToEmpresa: OmieAccount inválido: ${String(account)}`);
  }
}

function buildNaoVinculadoRow(
  c: OmieClienteCadastro,
  empresa: Empresa,
  syncedAtIso: string,
): NaoVinculadoRow {
  return {
    empresa,
    omie_codigo_cliente: c.codigo_cliente_omie ?? 0,
    cnpj_cpf: (c.cnpj_cpf ?? "").replace(/\D/g, ""),
    razao_social: c.razao_social?.trim() || null,
    nome_fantasia: c.nome_fantasia?.trim() || null,
    cidade: c.cidade?.trim() || null,
    uf: c.estado?.trim() || null,
    codigo_vendedor: c.codigo_vendedor ?? null,
    synced_at: syncedAtIso,
  };
}

interface OmieClienteCadastro {
  codigo_cliente_omie?: number;
  codigo_cliente_integracao?: string | null;
  codigo_vendedor?: number | null;
  // O vendedor do cliente mora em recomendacoes.codigo_vendedor (o raiz vem vazio no ListarClientes).
  recomendacoes?: { codigo_vendedor?: number | null };
  cnpj_cpf?: string;
  razao_social?: string;
  nome_fantasia?: string;
  cidade?: string;
  estado?: string;
  tags?: Array<{ tag?: string } | string>;
}

interface OmieListarClientesResponse {
  clientes_cadastro?: OmieClienteCadastro[];
  total_de_paginas?: number;
  faultstring?: string;
}

interface OmieImagemProduto {
  url_imagem?: string;
}

interface OmieProdutoCadastro {
  codigo_produto?: number;
  codigo_produto_integracao?: string | null;
  codigo?: string;
  descricao?: string;
  unidade?: string;
  ncm?: string | null;
  valor_unitario?: number;
  quantidade_estoque?: number;
  inativo?: string;
  imagens?: OmieImagemProduto[];
  descricao_familia?: string | null;
  descricao_subfamilia?: string | null;
  marca?: string;
  modelo?: string;
  peso_bruto?: number;
  peso_liq?: number;
  cfop?: string;
}

interface OmieListarProdutosResponse {
  produto_servico_cadastro?: OmieProdutoCadastro[];
  total_de_paginas?: number;
  faultstring?: string;
}

interface OmieEstoqueProduto {
  nCodProd?: number;
  nSaldo?: number;
  nCMC?: number;
  nPrecoMedio?: number;
}

interface OmieListarPosEstoqueResponse {
  produtos?: OmieEstoqueProduto[];
  nTotPaginas?: number;
  faultstring?: string;
}

interface OmieApiResponseBase {
  faultstring?: string;
  faultcode?: string;
}

interface InventoryPositionRow {
  product_id: string | null;
  cmc?: number | null;
  saldo?: number | null;
  synced_at?: string | null;
}

function getCredentials(account: OmieAccount) {
  if (account === "vendas") {
    return {
      key: Deno.env.get("OMIE_OBEN_APP_KEY"),
      secret: Deno.env.get("OMIE_OBEN_APP_SECRET"),
    };
  }
  if (account === "colacor_vendas") {
    return {
      key: Deno.env.get("OMIE_COLACOR_APP_KEY"),
      secret: Deno.env.get("OMIE_COLACOR_APP_SECRET"),
    };
  }
  // servicos = afiação Colacor SC
  return {
    key: Deno.env.get("OMIE_COLACOR_SC_APP_KEY"),
    secret: Deno.env.get("OMIE_COLACOR_SC_APP_SECRET"),
  };
}

async function callOmie(account: OmieAccount, endpoint: string, call: string, params: Record<string, unknown>): Promise<OmieApiResponseBase> {
  const creds = getCredentials(account);
  if (!creds.key || !creds.secret) throw new Error(`Credenciais Omie (${account}) não configuradas`);

  const body = { call, app_key: creds.key, app_secret: creds.secret, param: [params] };

  // Retry com backoff p/ erros TRANSITÓRIOS do Omie/rede (ex.: "SOAP-ERROR: Broken response from
  // Application Server" — flakiness intermitente do servidor do Omie que matava a enumeração de ~105
  // páginas). ListarClientes/ListarProdutos são leitura idempotente → seguro re-tentar. Erro PERMANENTE
  // (credencial/validação) falha rápido (não casa os marcadores transitórios). Backoff: 0.8s, 1.6s, 3.2s.
  const maxAttempts = 4;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${OMIE_API_URL}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await res.json()) as OmieApiResponseBase;
      if (result.faultstring) throw new Error(`Omie (${account}): ${result.faultstring}`);
      return result;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = lastErr.message.toLowerCase();
      const transient = msg.includes("broken response") || msg.includes("soap-error") ||
        msg.includes("timeout") || msg.includes("timed out") || msg.includes("network") ||
        msg.includes("connection") || msg.includes("fetch failed") ||
        msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("500") ||
        msg.includes("429") || msg.includes("too many") || msg.includes("rate limit");
      if (transient && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt - 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error(`Omie (${account}): falha após ${maxAttempts} tentativas`);
}

// ======== SYNC STATE HELPERS ========

async function getSyncState(db: SupabaseClient, entityType: string, account: string) {
  const { data } = await db
    .from("sync_state")
    .select("*")
    .eq("entity_type", entityType)
    .eq("account", account)
    .maybeSingle();
  return data;
}

async function updateSyncState(
  db: SupabaseClient,
  entityType: string,
  account: string,
  updates: Record<string, unknown>
) {
  await db.from("sync_state").upsert(
    { entity_type: entityType, account, ...updates, updated_at: new Date().toISOString() },
    { onConflict: "entity_type,account" }
  );
}

// ======== SYNC CUSTOMERS ========
// Mapas bulk (substituem o N+1 de ~2-3 queries POR cliente que estourava o budget e deixava o
// sync_state preso em 'running'). Mesmo padrão provado do syncNaoVinculados (#383): paginado p/
// furar o cap de 1000 do PostgREST.

// Map<omie_codigo_cliente, user_id> de omie_clientes (quem JÁ está vinculado).
async function fetchOmieClienteUserMap(db: SupabaseClient): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from("omie_clientes")
      .select("omie_codigo_cliente, user_id")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetch omie_clientes map: ${error.message}`);
    const rows = (data ?? []) as { omie_codigo_cliente: number | null; user_id: string | null }[];
    for (const r of rows) {
      if (r.omie_codigo_cliente != null && r.user_id) map.set(Number(r.omie_codigo_cliente), r.user_id);
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return map;
}

// MIRROR-START omie identity-snapshot-parse — espelhado verbatim nos edges omie-vendas-sync e omie-analytics-sync
// Valida o CONTRATO JSON da RPC omie_sync_identity_snapshot e constrói os mapas. FAIL-CLOSED (Codex
// challenge PR-1): supabase-js .rpc() resolve {error} — error=null só prova HTTP/SQL bem-sucedido, NÃO o
// contrato. Uma RPC revertida/malformada pode devolver HTTP 200 com {doc_to_user:null,...}; o `?? {}` a
// degradaria para Map(0) SILENCIOSO (vendas pula pedidos, analytics não vincula) sem SQLSTATE. Aqui shape
// inválido (null/array/tipo errado/valor não-UUID/doc ambíguo vazado em doc_to_user) LANÇA — precisão>recall.
const OMIE_SNAPSHOT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseIdentitySnapshot(
  snap: unknown,
): { docToUserMap: Map<string, string>; ambiguousDocs: Set<string> } {
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
    throw new Error("identity snapshot: resposta não é objeto (fail-closed)");
  }
  const s = snap as Record<string, unknown>;
  const d2u = s.doc_to_user;
  const amb = s.ambiguous_docs;
  if (!d2u || typeof d2u !== "object" || Array.isArray(d2u)) {
    throw new Error("identity snapshot: doc_to_user ausente ou não-objeto (fail-closed)");
  }
  if (!Array.isArray(amb)) {
    throw new Error("identity snapshot: ambiguous_docs ausente ou não-array (fail-closed)");
  }
  const ambiguousDocs = new Set<string>();
  for (const doc of amb) {
    if (typeof doc !== "string") throw new Error("identity snapshot: ambiguous_docs com item não-string (fail-closed)");
    ambiguousDocs.add(doc);
  }
  const docToUserMap = new Map<string, string>();
  for (const [doc, user] of Object.entries(d2u)) {
    if (typeof user !== "string" || !OMIE_SNAPSHOT_UUID_RE.test(user)) {
      throw new Error("identity snapshot: user_id não-UUID em doc_to_user (fail-closed)");
    }
    // disjunção: um doc não pode estar em doc_to_user E em ambiguous_docs (seria fail-open da RPC)
    if (ambiguousDocs.has(doc)) {
      throw new Error("identity snapshot: doc presente em doc_to_user E ambiguous_docs — fail-open da RPC (fail-closed)");
    }
    docToUserMap.set(doc, user);
  }
  return { docToUserMap, ambiguousDocs };
}
// MIRROR-END

// Map<documento_normalizado, user_id> NÃO-ambíguo de profiles, via snapshot atômico server-side (RPC).
// Antes: paginação OFFSET (não-atômica — Codex xhigh: um profile nascendo/mudando entre páginas escapava
// da detecção de doc-ambíguo). Agora a RPC omie_sync_identity_snapshot resolve a unicidade num ÚNICO
// snapshot MVCC (doc com 2+ users DISTINTOS já vem FORA de doc_to_user, fail-closed no SQL). doc_to_user
// é global (profiles não tem conta); passamos a conta em curso só p/ satisfazer a assinatura da RPC.
// .rpc() NÃO lança em erro → checar {error} E validar o contrato (parseIdentitySnapshot LANÇA em shape inválido).
async function fetchProfileDocUserMap(db: SupabaseClient, account: string): Promise<Map<string, string>> {
  const { data: snap, error } = await db.rpc('omie_sync_identity_snapshot', { p_account: account });
  if (error) throw new Error(`identity snapshot (${account}): ${error.message}`);
  return parseIdentitySnapshot(snap).docToUserMap;
}

// MIRROR-START omie doc-ambiguo — espelhado verbatim de src/lib/omie/omie-doc-ambiguo.ts
// P1b (fail-closed money-path): documentos que aparecem em 2+ registros Omie com códigos de cliente
// DISTINTOS na MESMA conta são AMBÍGUOS — não provam identidade. Espelha o fail-closed do lado profile
// (fetchProfileDocUserMap: 2 users no mesmo doc → não mapeia). Sem isto, o último da paginação vencia por
// last-write-wins e gravava um código arbitrário na proof-table. Espelhado no edge (Deno não importa de
// src/); paridade textual no CI em src/__tests__/edge-money-path-invariants.test.ts.
function docsComCodigoAmbiguoNoOmie(
  registros: ReadonlyArray<{ doc: string; codigo: number }>,
): Set<string> {
  const codigosPorDoc = new Map<string, Set<number>>();
  for (const r of registros) {
    if (!r.doc) continue; // doc vazio não vira chave (o boundary já filtra sem-doc)
    const s = codigosPorDoc.get(r.doc) ?? new Set<number>();
    s.add(r.codigo);
    codigosPorDoc.set(r.doc, s);
  }
  const ambiguos = new Set<string>();
  for (const [doc, cods] of codigosPorDoc) if (cods.size > 1) ambiguos.add(doc);
  return ambiguos;
}
// MIRROR-END

// MIRROR-START omie-codigo-vendedor — espelhado verbatim de src/lib/omie/codigo-vendedor.ts
// Extrai o vendedor do cadastro Omie (ListarClientes) — money-path P0-B-bis (vendedor → carteira → comissão).
// O vendedor mora em recomendacoes.codigo_vendedor (o codigo_vendedor RAIZ vem vazio no ListarClientes);
// recomendacoes é a fonte PRIMÁRIA (padrão de omie-cliente/omie-sync), o raiz é fallback. Só inteiro
// POSITIVO conta como vendedor — 0/negativo/não-inteiro = não-atribuído (resolve o ??/|| ambíguo, Codex P2).
// PURA: sem I/O. Espelhado no edge (Deno não importa de src/); paridade textual no CI.
function extrairCodigoVendedor(c: {
  codigo_vendedor?: number | null;
  recomendacoes?: { codigo_vendedor?: number | null } | null;
}): number | null {
  // bigint-safe (Codex P3): código > 2^53 perderia precisão e casaria com outro vendedor.
  const positivo = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
  // recomendacoes é a fonte AUTORITATIVA: se PRESENTE (mesmo 0/inválido) ela decide — 0 = "sem vendedor"
  // explícito, não cai no raiz (Codex P2: fallback só quando o primário está AUSENTE, não presente-inválido).
  const nested = c.recomendacoes?.codigo_vendedor;
  return nested != null ? positivo(nested) : positivo(c.codigo_vendedor);
}
// MIRROR-END

async function syncCustomers(db: SupabaseClient, account: OmieAccount) {
  await updateSyncState(db, "customers", account, { status: "running", error_message: null });

  try {
    // 2 leituras em massa ANTES do laço (substitui o N+1: ~2-3 round-trips POR cliente × ~10k).
    const userByCodigo = await fetchOmieClienteUserMap(db);
    const userByDoc = await fetchProfileDocUserMap(db, account);

    // Enumera o Omie e resolve o user_id em MEMÓRIA. Dedup por user_id (last-wins) — a constraint
    // unique_user_omie é UNIQUE(user_id), então 2 linhas com o mesmo user_id no mesmo upsert dariam
    // "ON CONFLICT cannot affect row a second time".
    const upsertByUser = new Map<string, {
      user_id: string;
      omie_codigo_cliente: number;
      omie_codigo_cliente_integracao: string | null;
      omie_codigo_vendedor: number | null;
      updated_at: string;
    }>();
    const tagsByUser = new Map<string, string[]>();
    // Fatia 3 (proof-table aditiva omie_customer_account_map): mapa DOCUMENT-FIRST (user_id -> código
    // Omie NESTA conta). Só vínculo por DOCUMENTO entra — casar por código é cross-account no espelho
    // poluído e traria o user errado (Codex). account é FIXO neste run (=empresaMap).
    const empresaMap = accountToEmpresa(account); // vendas->oben, colacor_vendas->colacor, servicos->colacor_sc
    const accountMapByUser = new Map<string, {
      user_id: string;
      account: string;
      omie_codigo_cliente: number;
      omie_codigo_vendedor: number | null;
      source: string;
      updated_at: string;
    }>();
    // P1b: acumula (doc, código) de TODO registro Omie com doc — inclusive os SEM profile casado — p/
    // detectar doc ambíguo no lado Omie (2+ códigos DISTINTOS na mesma conta) e fail-closar depois.
    const registrosOmieDoc: { doc: string; codigo: number }[] = [];
    let pagina = 1;
    let totalPaginas = 1;

    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "geral/clientes/", "ListarClientes", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
      })) as unknown as OmieListarClientesResponse;

      totalPaginas = result.total_de_paginas || 1;
      for (const c of result.clientes_cadastro || []) {
        const doc = (c.cnpj_cpf || "").replace(/\D/g, "");
        if (!doc || c.codigo_cliente_omie == null) continue;
        registrosOmieDoc.push({ doc, codigo: c.codigo_cliente_omie });
        // mapeado por código (atualiza vendedor) OU vinculável por documento (cria vínculo).
        // Não-vinculado (sem código nem profile) é fora de escopo — é o syncNaoVinculados.
        const userId = userByCodigo.get(Number(c.codigo_cliente_omie)) ?? userByDoc.get(doc);
        if (!userId) continue;
        upsertByUser.set(userId, {
          user_id: userId,
          omie_codigo_cliente: c.codigo_cliente_omie,
          omie_codigo_cliente_integracao: c.codigo_cliente_integracao || null,
          omie_codigo_vendedor: c.codigo_vendedor || null,
          updated_at: new Date().toISOString(),
        });
        // Captura tags do cadastro Omie para derivar is_fornecedor / excluir_da_carteira depois.
        const tags = (c.tags || [])
          .map((t) => (typeof t === "string" ? t : (t.tag ?? "")))
          .filter((t) => t.length > 0);
        tagsByUser.set(userId, tags);

        // Fatia 3 (proof-table): DOCUMENT-FIRST — só quem casa por DOCUMENTO entra no mapa por conta
        // (código seria cross-account no espelho poluído → user errado, Codex). account fixo = empresaMap.
        const userIdByDoc = userByDoc.get(doc);
        if (userIdByDoc) {
          accountMapByUser.set(userIdByDoc, {
            user_id: userIdByDoc,
            account: empresaMap,
            omie_codigo_cliente: c.codigo_cliente_omie,
            // P0-B-bis: vendedor da PROOF (document-first, account-safe) via helper — recomendacoes vence.
            // O mirror upsertByUser (code-first) NÃO recebe vendedor (Codex: resolução insegura); a carteira
            // migra p/ ler a proof (carteira-rebuild). Só a proof alimenta a carteira daqui pra frente.
            omie_codigo_vendedor: extrairCodigoVendedor(c),
            source: "document",
            updated_at: new Date().toISOString(),
          });
        }
      }

      console.log(`[Sync ${account}] Clientes página ${pagina}/${totalPaginas}`);
      pagina++;
    }

    // P1b (fail-closed): doc que aparece em 2+ registros Omie com códigos DISTINTOS na MESMA conta é
    // AMBÍGUO — não dá p/ saber qual código é o do profile. Espelha o lado profile. Remove o user do mapa
    // (não grava código errado) e coleta p/ o DELETE cirúrgico do vínculo pré-existente (o upsert-only
    // deixaria a linha antiga viva até o TTL — furo P1 do Codex). Escopado a users PROVADOS ambíguos NESTA
    // conta (≠ delete-em-massa: run parcial vê menos ocorrências → detecta menos → deleta menos, fail-safe).
    const docsAmbiguosOmie = docsComCodigoAmbiguoNoOmie(registrosOmieDoc);
    const usersAmbiguosOmie = new Set<string>();
    for (const docAmb of docsAmbiguosOmie) {
      const uid = userByDoc.get(docAmb);
      if (uid) {
        accountMapByUser.delete(uid);
        usersAmbiguosOmie.add(uid);
      }
    }
    if (docsAmbiguosOmie.size > 0) {
      // amostra SANITIZADA (só os 4 últimos dígitos) — observabilidade da perda de recall sem PII em texto.
      const amostra = Array.from(docsAmbiguosOmie).slice(0, 5).map((d) => `***${d.slice(-4)}`);
      console.warn(
        `[Sync ${account}] P1b fail-closed: ${docsAmbiguosOmie.size} doc(s) ambíguo(s) no Omie (2+ códigos/conta) → ${usersAmbiguosOmie.size} user(s) NÃO-mapeado(s). Amostra: ${amostra.join(", ")}`,
      );
    }

    // P1b: DELETE cirúrgico do vínculo PRÉ-EXISTENTE dos users ambíguos NESTA conta, ANTES do upsert
    // (delete-first fail-closed: remove o código errado antes de gravar o bom — se o upsert falhar depois,
    // o errado já saiu; challenge Codex item 1/7). Escopado por (account, user_id) PROVADOS ambíguos, e SÓ
    // source='document' (preserva override humano source='manual' — challenge Codex item 3). Não é
    // delete-em-massa: run parcial vê menos ocorrências → detecta menos → deleta menos (fail-safe).
    if (usersAmbiguosOmie.size > 0) {
      const ambiguosList = Array.from(usersAmbiguosOmie);
      for (let i = 0; i < ambiguosList.length; i += 200) {
        const { error: delErr } = await db
          .from("omie_customer_account_map")
          .delete()
          .eq("account", empresaMap)
          .eq("source", "document")
          .in("user_id", ambiguosList.slice(i, i + 200));
        if (delErr) throw new Error(`delete ambíguos omie_customer_account_map: ${delErr.message}`);
      }
      console.log(`[Sync ${account}] P1b: ${ambiguosList.length} user(s) ambíguo(s) — vínculo document removido da proof-table`);
    }

    // ── P0-B-bis Fatia 2: marca `ambiguous` no carteira_membership_ledger. O par do DELETE acima: o vínculo
    // sai da proof, mas o MEMBRO permanece no ledger (acumulador) e o carteira-rebuild o QUARANTINA
    // (eligible=false, zero comissão, row preservada). Sem isto, o ambíguo perde o vendedor, vira órfão e cai
    // no Hunter com eligible=TRUE — comissão sobre um cliente cuja identidade não sabemos.
    // SÓ o run oben escreve (D5): identity_state é coluna GLOBAL (1 row/user) e a ambiguidade é detectada POR
    // CONTA → os 3 runs escrevendo se sobrescreveriam (flapping: um marca, o outro desmarca). A carteira lê a
    // proof account='oben' — é a conta que decide. Mesma regra do espelho (:488) e das tags.
    // FAIL-CLOSED: marca ANTES da reversão (abaixo). UPDATE .in() nunca INSERE — quem popula o ledger é o
    // trigger da Fatia 0; membro fora do ledger simplesmente não é tocado.
    if (account === "vendas" && usersAmbiguosOmie.size > 0) {
      const ambiguosList = Array.from(usersAmbiguosOmie);
      const nowIso = new Date().toISOString();
      for (let i = 0; i < ambiguosList.length; i += 200) {
        const { error: ledErr } = await db
          .from("carteira_membership_ledger")
          .update({ identity_state: "ambiguous", updated_at: nowIso })
          .in("user_id", ambiguosList.slice(i, i + 200));
        if (ledErr) throw new Error(`marca ambiguous carteira_membership_ledger: ${ledErr.message}`);
      }
      console.warn(
        `[Sync ${account}] Fatia 2: ${ambiguosList.length} membro(s) → identity_state='ambiguous' no ledger; serão QUARANTINADOS no próximo carteira-rebuild (preservados, eligible=false, zero comissão)`,
      );
    }

    // [P0-B-bis Fatia 4] O espelho legado `omie_clientes` NÃO é mais escrito aqui — este era o ÚLTIMO
    // writer vivo (5239 linhas/dia; os 6 writers pontuais somaram 2 INSERTs em 4 meses). No lugar, a
    // MEMBERSHIP vai direto ao ledger.
    //
    // Por que direto, e não pela RPC `register_carteira_member`: são 5239 membros por run — chamar a RPC
    // por linha seria o N+1 que o CLAUDE.md proíbe em enumeração pesada. A RPC serve os writers PONTUAIS;
    // o bulk escreve em massa, como já faz com a proof logo abaixo.
    //
    // Por que a lista code-first (`upsertByUser`) e não a document-first (`accountMapByUser`): a
    // code-first é MAIS ABRANGENTE — cobre os ~1633 aliases fiscais (users Omie sem `profiles.document`)
    // que nunca entram na proof. Era exatamente esse conjunto que o espelho levava ao ledger pelo trigger
    // `AFTER INSERT` da Fatia 0. Trocar pela document-first ENCOLHERIA a membership, e membership que
    // encolhe é a falha que a opção D existe para impedir.
    //
    // ON CONFLICT DO NOTHING (ignoreDuplicates) é o invariante do acumulador: preserva `first_seen_at`
    // (a data REAL do vínculo, consumida em :1761) e NUNCA rebaixa `identity_state` — um membro
    // quarantinado pela Fatia 2 (`ambiguous`) não volta a `verified` no run seguinte, o que devolveria
    // vendedor e comissão a um cliente cuja identidade não sabemos.
    //
    // Só o run oben escreve, mesma regra do espelho e do `identity_state` acima (:484): a carteira lê a
    // proof `account='oben'` — é a conta que decide quem é membro.
    const rows = Array.from(upsertByUser.values());
    let totalSynced = 0;
    if (account === "vendas") {
      const nowIsoLedger = new Date().toISOString();
      const ledgerRows = rows.map((r) => ({
        user_id: r.user_id,
        identity_state: "verified",
        first_seen_at: nowIsoLedger,
        source: "sync",
        updated_at: nowIsoLedger,
      }));
      for (let i = 0; i < ledgerRows.length; i += 500) {
        const chunk = ledgerRows.slice(i, i + 500);
        const { error: upErr } = await db
          .from("carteira_membership_ledger")
          .upsert(chunk, { onConflict: "user_id", ignoreDuplicates: true });
        if (upErr) throw new Error(`upsert carteira_membership_ledger: ${upErr.message}`);
        totalSynced += chunk.length;
      }
    }

    // Fatia 3 (proof-table ADITIVA): upsert em omie_customer_account_map por (user_id, account). NÃO
    // toca omie_clientes (o espelho poluído fica intocado) — esta tabela é a fonte account-correta dos
    // consumidores de leitura. onConflict composto = uq_ocam_user_account; UNIQUE(código,account) barra
    // colisão cross-account no casamento. document-first → dedup por user_id basta (account é fixo).
    const mapRows = Array.from(accountMapByUser.values());
    for (let i = 0; i < mapRows.length; i += 500) {
      const chunk = mapRows.slice(i, i + 500);
      const { error: mapErr } = await db
        .from("omie_customer_account_map")
        .upsert(chunk, { onConflict: "user_id,account" });
      if (mapErr) throw new Error(`upsert omie_customer_account_map: ${mapErr.message}`);
    }
    console.log(`[Sync ${account}] proof-table omie_customer_account_map: ${mapRows.length} vínculos por documento`);

    // ── P0-B-bis Fatia 2: reversão `ambiguous` → `verified`, SIMÉTRICA ao delete/marcação acima. Quem ESTE run
    // PROVOU limpo volta a valer: `accountMapByUser` é exatamente o conjunto casado por DOCUMENTO, e os
    // ambíguos já foram retirados dele (:447) → os dois conjuntos são disjuntos de graça.
    // Sem isto o quarantine seria CATRACA DE MÃO ÚNICA: doc corrigido no Omie deixaria o cliente invisível e
    // sem comissão PARA SEMPRE, dependendo de um UPDATE manual que ninguém saberia que precisa fazer.
    // Barato no caso normal: 1 SELECT indexado (idx_cml_identity_state) que hoje volta VAZIO → nada a fazer.
    // Paginado (a capa de 1000 do PostgREST é silenciosa). Run parcial reverte só o que viu (fail-safe).
    if (account === "vendas") {
      const ambNoLedger: string[] = [];
      for (let from = 0; ;) {
        const { data, error: ambErr } = await db
          .from("carteira_membership_ledger")
          .select("user_id")
          .eq("identity_state", "ambiguous")
          .order("user_id", { ascending: true })
          .range(from, from + 999);
        if (ambErr) throw new Error(`lê ambiguous do carteira_membership_ledger: ${ambErr.message}`);
        const page = (data ?? []) as Array<{ user_id: string }>;
        for (const r of page) ambNoLedger.push(r.user_id);
        if (page.length === 0) break;
        from += page.length;
        if (from > 500_000) throw new Error("paginacao ambiguous do ledger excedeu limite");
      }
      // só os que ESTE run provou limpos (casados por documento, não-ambíguos)
      const reverter = ambNoLedger.filter((uid) => accountMapByUser.has(uid));
      if (reverter.length > 0) {
        const nowIso = new Date().toISOString();
        for (let i = 0; i < reverter.length; i += 200) {
          const { error: revErr } = await db
            .from("carteira_membership_ledger")
            .update({ identity_state: "verified", updated_at: nowIso })
            .eq("identity_state", "ambiguous") // restringe ao que a Fatia 2 populou (não toca outros estados)
            .in("user_id", reverter.slice(i, i + 200));
          if (revErr) throw new Error(`reverte verified carteira_membership_ledger: ${revErr.message}`);
        }
        console.log(
          `[Sync ${account}] Fatia 2: ${reverter.length} membro(s) ambiguous→verified (documento voltou a ser inequívoco) — saem do quarantine no próximo carteira-rebuild`,
        );
      }
    }

    // Fatia 4: para contas não-oben o espelho não é tocado; o "sincronizado" reportado é a proof-table.
    if (account !== "vendas") totalSynced = mapRows.length;

    // Upsert das tags em cliente_classificacao (prova se o ListarClientes em lote retorna tags).
    // Grava user_id + tags_omie + tags_synced_at; as colunas derivadas (is_fornecedor,
    // excluir_da_carteira) ficam com o default da tabela e serão calculadas em outra tarefa.
    // Fatia 4 (Codex): tags também são chaveadas pelo userId CODE-FIRST (mesmo userByCodigo poluído)
    // → só 'vendas'(oben) grava, pelas mesmas razões do espelho acima. Não-oben: só a proof-table.
    const tagsNowIso = new Date().toISOString();
    const tagRows = account === "vendas"
      ? Array.from(tagsByUser.entries()).map(([user_id, tags_omie]) => ({
          user_id,
          tags_omie,
          tags_synced_at: tagsNowIso,
        }))
      : [];
    for (let i = 0; i < tagRows.length; i += 500) {
      const { error: tagErr } = await db
        .from("cliente_classificacao")
        .upsert(tagRows.slice(i, i + 500), { onConflict: "user_id" });
      if (tagErr) throw new Error(`upsert cliente_classificacao: ${tagErr.message}`);
    }
    console.log(`[Sync ${account}] tags gravadas em cliente_classificacao: ${tagRows.length} clientes`);

    await updateSyncState(db, "customers", account, {
      status: "complete",
      total_synced: totalSynced,
      last_sync_at: new Date().toISOString(),
      last_page: totalPaginas,
    });
    return { totalSynced };
  } catch (error) {
    await updateSyncState(db, "customers", account, { status: "error", error_message: String(error) });
    throw error;
  }
}

// ======== CLIENTES NÃO-VINCULADOS (rotina dedicada e eficiente) ========
// Desacoplada do linking: NÃO toca em omie_clientes. Faz 2 leituras em massa
// (conjuntos) + enumera o Omie + classifica em memória. Sem N+1.

// Espelhado VERBATIM de src/lib/clientes-nao-vinculados/snapshot.ts
type SnapshotClassification = "skip" | "linked" | "has_profile" | "unlinked";
function classifyClienteForSnapshot(
  c: OmieClienteCadastro,
  codigosVinculados: Set<number>,
  docsComProfile: Set<string>,
): SnapshotClassification {
  const doc = (c.cnpj_cpf ?? "").replace(/\D/g, "");
  if (!doc || c.codigo_cliente_omie == null) return "skip";
  if (codigosVinculados.has(Number(c.codigo_cliente_omie))) return "linked";
  if (docsComProfile.has(doc)) return "has_profile";
  return "unlinked";
}

// Lê TODOS os omie_codigo_cliente de omie_clientes (paginado p/ furar o cap de 1000 do PostgREST).
// Códigos JÁ vinculados NA CONTA do run, pela proof fresca account-correta. Alimenta o
// classifyClienteForSnapshot: um código presente aqui é "linked" e NÃO entra no relatório de
// não-vinculados. Antes vinha do espelho omie_clientes SEM filtro de conta — e o espelho é
// UNIQUE(user_id) (1 linha/user, sobrescrita pelo writer da vez, hoje dominado por oben), então
// ele NÃO contém os códigos das outras contas: medido em prod, dos códigos da proof faltavam no
// espelho 5.148/5.148 (colacor, 100%) e 3.604/5.275 (colacor_sc, 68%) contra 0/5.238 (oben).
// Consequência: rodar o snapshot de colacor/colacor_sc classificaria clientes VINCULADOS como
// não-vinculados em massa (o relatório de oben, o único que roda hoje, mascarava o furo).
// A fresca é UNIQUE(omie_codigo_cliente, account) → o Set é exatamente a conta do run.
async function fetchAllOmieClienteCodigos(db: SupabaseClient, empresa: Empresa): Promise<Set<number>> {
  const set = new Set<number>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from("omie_customer_account_map_fresco")
      .select("omie_codigo_cliente")
      .eq("account", empresa)
      // .order estável: sem ele o .range pagina sobre ordem indefinida (armadilha PostgREST) e
      // uma linha pode repetir ou sumir entre páginas — num Set de dedup, sumir vira falso "unlinked".
      .order("omie_codigo_cliente")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetch codigos vinculados (${empresa}): ${error.message}`);
    const rows = (data ?? []) as { omie_codigo_cliente: number | null }[];
    for (const r of rows) if (r.omie_codigo_cliente != null) set.add(Number(r.omie_codigo_cliente));
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return set;
}

// Lê TODOS os documentos de profiles (normalizados em memória — defensivo contra formatados).
async function fetchAllProfileDocs(db: SupabaseClient): Promise<Set<string>> {
  const set = new Set<string>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from("profiles")
      .select("document")
      .not("document", "is", null)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetch profiles docs: ${error.message}`);
    const rows = (data ?? []) as { document: string | null }[];
    for (const r of rows) {
      const d = (r.document ?? "").replace(/\D/g, "");
      if (d) set.add(d);
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return set;
}

async function syncNaoVinculados(db: SupabaseClient, account: OmieAccount) {
  const empresa = accountToEmpresa(account);
  const runTs = new Date().toISOString();
  await db.from("omie_nao_vinculados_state").upsert(
    { empresa, status: "running", current_run_ts: runTs, started_at: runTs, error_message: null, updated_at: runTs },
    { onConflict: "empresa" },
  );

  try {
    // 2 leituras em massa (sets) — substitui ~2 queries POR cliente do laço de linking.
    // `empresa` (=accountToEmpresa(account)) escopa os códigos à conta DESTE run — ver a nota em
    // fetchAllOmieClienteCodigos: o Set global do espelho classificava errado fora de oben.
    const codigosVinculados = await fetchAllOmieClienteCodigos(db, empresa);
    const docsComProfile = await fetchAllProfileDocs(db);

    const naoVinculados: NaoVinculadoRow[] = [];
    let pagina = 1;
    let totalPaginas = 1;
    let totalOmie = 0;

    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "geral/clientes/", "ListarClientes", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
      })) as unknown as OmieListarClientesResponse;

      totalPaginas = result.total_de_paginas || 1;
      const clientes = result.clientes_cadastro || [];
      for (const c of clientes) {
        totalOmie++;
        if (classifyClienteForSnapshot(c, codigosVinculados, docsComProfile) === "unlinked") {
          naoVinculados.push(buildNaoVinculadoRow(c, empresa, runTs));
        }
      }
      console.log(`[NaoVinc ${account}] página ${pagina}/${totalPaginas}`);
      pagina++;
    }

    // dedup por código, insere em chunks com o run_ts, finaliza atômico.
    const dedup = Array.from(new Map(naoVinculados.map((r) => [r.omie_codigo_cliente, r])).values());
    for (let i = 0; i < dedup.length; i += 1000) {
      const { error: insErr } = await db.from("omie_clientes_nao_vinculados").insert(dedup.slice(i, i + 1000));
      if (insErr) throw new Error(`insert nao_vinculados: ${insErr.message}`);
    }
    // INVARIANTE DE SEGURANÇA: finalize só após inserir o conjunto COMPLETO do runTs.
    // Um throw antes daqui (timeout/erro) pula o finalize → o run morto fica INVISÍVEL
    // na UI (que lê só last_complete_synced_at) em vez de virar relatório enganoso.
    const { error: finErr } = await db.rpc("finalize_nao_vinculados_snapshot", {
      p_empresa: empresa,
      p_run_ts: runTs,
      p_total: dedup.length,
    });
    if (finErr) throw new Error(`finalize nao_vinculados: ${finErr.message}`);
    console.log(`[NaoVinc ${account}] total_omie=${totalOmie} nao_vinculados=${dedup.length}`);
    return { totalOmie, naoVinculados: dedup.length };
  } catch (error) {
    await db.from("omie_nao_vinculados_state").update({
      status: "error",
      error_message: String(error),
      updated_at: new Date().toISOString(),
    }).eq("empresa", empresa);
    throw error;
  }
}

// ======== SYNC PRODUCTS ========

async function syncProducts(db: SupabaseClient, account: OmieAccount, startPage = 1, maxPages = 10) {
  await updateSyncState(db, "products", account, { status: "running", error_message: null });
  let pagina = startPage;
  let totalPaginas = startPage;
  let totalSynced = 0;
  let pagesProcessed = 0;

  try {
    while (pagina <= totalPaginas && pagesProcessed < maxPages) {
      const result = (await callOmie(account, "geral/produtos/", "ListarProdutos", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N",
      })) as unknown as OmieListarProdutosResponse;

      totalPaginas = result.total_de_paginas || 1;
      const produtos = result.produto_servico_cadastro || [];

      if (account === "vendas" || account === "colacor_vendas") {
        // UPSERT — INCLUI inativos para refletir o flag `ativo` corretamente
        const acctValue = account === "colacor_vendas" ? "colacor" : "oben";
        const rows = produtos.map((p) => ({
          omie_codigo_produto: p.codigo_produto,
          omie_codigo_produto_integracao: p.codigo_produto_integracao || null,
          codigo: p.codigo || `PROD-${p.codigo_produto}`,
          descricao: p.descricao || "Sem descrição",
          unidade: p.unidade || "UN",
          ncm: p.ncm || null,
          valor_unitario: p.valor_unitario || 0,
          estoque: p.quantidade_estoque || 0,
          ativo: p.inativo !== "S",
          account: acctValue,
          imagem_url: p.imagens?.[0]?.url_imagem || null,
          familia: p.descricao_familia || null,
          subfamilia: p.descricao_subfamilia || null,
          metadata: {
            marca: p.marca,
            modelo: p.modelo,
            peso_bruto: p.peso_bruto,
            peso_liq: p.peso_liq,
            descricao_familia: p.descricao_familia,
            cfop: p.cfop,
            inativo_omie: p.inativo,
          },
          updated_at: new Date().toISOString(),
        }));

        if (rows.length > 0) {
          const { error } = await db
            .from("omie_products")
            .upsert(rows, { onConflict: "omie_codigo_produto,account" });
          if (error) console.error(`[Sync] Erro upsert produtos p${pagina}:`, error);
          else totalSynced += rows.length;
        }
      }

      console.log(`[Sync ${account}] Produtos página ${pagina}/${totalPaginas}`);
      pagina++;
      pagesProcessed++;
    }

    await updateSyncState(db, "products", account, {
      status: "complete",
      total_synced: totalSynced,
      last_sync_at: new Date().toISOString(),
      last_page: totalPaginas,
    });
    const complete = pagina > totalPaginas;
    await updateSyncState(db, "products", account, {
      status: complete ? "complete" : "partial",
      total_synced: totalSynced,
      last_sync_at: new Date().toISOString(),
      last_page: pagina - 1,
    });
    return { totalSynced, totalPages: totalPaginas, lastPage: pagina - 1, complete, nextPage: complete ? null : pagina };
  } catch (error) {
    await updateSyncState(db, "products", account, { status: "error", error_message: String(error) });
    throw error;
  }
}

// ======== SYNC ORDERS — APOSENTADO (2026-06-24, decisão Claude + Codex) ========
// O syncOrdersIncremental legado era uma 2ª via de gravação de pedidos, hoje REDUNDANTE e nociva:
//   • order_items: upsert com onConflict (sales_order_id, omie_codigo_produto) SEM índice único
//     compatível → 42P10 → no-op silencioso (o erro nunca era capturado);
//   • sales_price_history: upsert(ignoreDuplicates) com id uuid novo a cada vez → INSERE SEMPRE,
//     POLUINDO o histórico de preços (3.995 linhas excedentes, 2.648 só em jun/26, created_at de
//     carga ≠ data do pedido — evidência psql-ro 2026-06-24).
// order_items + sales_price_history já nascem ATÔMICOS na RPC criar_pedidos_com_itens
// (omie-vendas-sync, G6/G10) e são reconciliados pelo sync-reprocess (#955). NÃO adicionar índice
// único por (pedido, SKU): quebraria o SKU repetido legítimo (90% das "duplicatas" têm valores
// distintos). Mantido como no-op (a action sync_orders segue existindo) p/ não quebrar caller
// externo esquecido. Registro: docs/historico/programas-vendas.md.
async function syncOrdersIncremental(_db: SupabaseClient, _account: OmieAccount) {
  return { deprecated: true, totalSynced: 0, reason: 'aposentado — RPC criar_pedidos_com_itens é a fonte de order_items/sph' };
}

// ======== SYNC INVENTORY ========

// Divide um array em lotes de tamanho fixo (para upsert/insert/IN em massa).
function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function syncInventory(db: SupabaseClient, account: OmieAccount) {
  await updateSyncState(db, "inventory", account, { status: "running", error_message: null });
  let pagina = 1;
  let totalPaginas = 1;

  try {
    // 1) COLETA todas as páginas do Omie em memória (dedupe last-wins por código).
    //    Antes: ~4 writes PostgREST POR produto (N+1) → ~3M statements e saturava o disk IO.
    //    Agora: acumula e escreve em LOTE (upsert chunked), o padrão que o resto deste arquivo já usa.
    const posicoes = new Map<number, PosicaoEstoque>();
    let itensRecebidos = 0;
    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
        nPagina: pagina,
        nRegPorPagina: 100,
        dDataPosicao: new Date().toLocaleDateString("pt-BR"),
      })) as unknown as OmieListarPosEstoqueResponse;

      // Piso MONOTÔNICO + teto fail-fast (_shared/omie-paginacao.ts, Codex P1 #1341/#1353):
      // o `nTotPaginas || 1` POR RESPOSTA encolhia o teto quando uma resposta intermediária
      // vinha sem o campo (retrato PARCIAL completava como 'complete'), e um nTotPaginas
      // lixo/gigante giraria a edge por ~90s+ de chamadas antes de qualquer guard de contagem.
      totalPaginas = proximoTotalPaginas(totalPaginas, result.nTotPaginas, MAX_PAGINAS_POS_ESTOQUE);
      const produtos = result.produtos || [];
      const veredicto = avaliarPagina(produtos.length, pagina, totalPaginas);
      if (veredicto === "anomalia") {
        // nTotPaginas é PISO (docs/agent/sync.md): página vazia ANTES do fim declarado =
        // fault transiente disfarçado → aborta fail-closed (status error; o cron re-tenta)
        // em vez de completar retrato parcial. Nada foi escrito ainda (coleta antecede escrita).
        throw new Error(`página ${pagina}/${totalPaginas} do ListarPosEstoque veio vazia antes do fim declarado — abortando (retrato parcial)`);
      }
      if (veredicto === "fim") break;

      // Normalização compartilhada (_shared/pos-estoque.ts): código inválido fora, valor
      // não-finito descarta o ITEM (um único malformado derrubaria o chunk de 500 com 22P02),
      // dedupe last-wins por código (repetido no MESMO statement de upsert daria 21000).
      itensRecebidos += produtos.length;
      acumularPosicoesDaPagina(posicoes, produtos);

      console.log(`[Sync ${account}] Estoque página ${pagina}/${totalPaginas} (${produtos.length})`);
      pagina++;
    }

    // Recebi itens mas descartei TODOS na normalização = drift de contrato TOTAL (Codex P1
    // rodada 2): completar 'complete/0' aqui mentiria com o inventário integralmente stale.
    // ≠ resposta legitimamente vazia do Omie (0 recebidos), que segue complete-0 (servicos).
    if (itensRecebidos > 0 && posicoes.size === 0) {
      throw new Error(
        `ListarPosEstoque devolveu ${itensRecebidos} item(ns) e TODOS foram descartados na normalização — drift de contrato, abortando fail-closed`,
      );
    }

    // Timestamp único da run, capturado APÓS a coleta Omie (Codex P2 #1341): encolhe a janela
    // de regressão de updated_at contra writers concorrentes (sync-reprocess/computeCosts).
    const nowIso = new Date().toISOString();
    let falhasChunk = 0;

    const codProds = [...posicoes.keys()];
    const totalSynced = codProds.length;

    if (totalSynced === 0) {
      await updateSyncState(db, "inventory", account, {
        status: "complete",
        total_synced: 0,
        last_sync_at: nowIso,
        last_page: totalPaginas,
      });
      return { totalSynced: 0 };
    }

    // 2) RESOLVE product_id em LOTE, ESCOPADO À EMPRESA da account (accountToEmpresa).
    //    omie_products é UNIQUE(omie_codigo_produto, account=EMPRESA): sem o filtro, a resolução
    //    account-blind poderia mapear o código para o product_id de OUTRA empresa (mesmo número em
    //    empresas distintas, OU código que só existe na empresa errada) → CMC/saldo no produto
    //    errado. Com .eq("account", empresa), dentro da empresa o código é único.
    //    buildProductIdMap nulifica qualquer ambíguo residual (defense-in-depth: se o filtro/UNIQUE
    //    falhar, degrada p/ null em vez de gravar no errado — esperado 0 com o filtro).
    const empresa = accountToEmpresa(account);
    const prodRows: Array<{
      id: string | null;
      omie_codigo_produto: number | string | null;
      codigo?: string | null;
      descricao?: string | null;
    }> = [];
    for (const chunk of chunked(codProds, 300)) {
      const { data, error } = await db
        .from("omie_products")
        .select("id, omie_codigo_produto, codigo, descricao")
        .eq("account", empresa)
        .in("omie_codigo_produto", chunk);
      // Falha de SELECT → THROW (defeito registrado no #1341: "o canônico segue sem o chunk"):
      // seguir faria o upsert de posição abaixo CLOBBERar product_id existente para null.
      // Precisão > recall; o cron re-tenta no próximo ciclo.
      if (error) throw new Error(`resolve omie_products: ${error.message}`);
      prodRows.push(...(data ?? []));
    }
    const idByCod = buildProductIdMap(prodRows);
    const ambiguos = [...idByCod.values()].filter((v) => v === null).length;
    if (ambiguos > 0) {
      console.warn(`[Sync ${account}] ${ambiguos} código(s) ambíguo(s) em omie_products(${empresa}) — product_id nulificado (esperado 0 com filtro account-aware)`);
    }

    // 3) inventory_position — upsert em LOTE (onConflict (omie_codigo_produto, account)).
    const invRows = codProds.map((cod) => {
      const p = posicoes.get(cod)!;
      return {
        omie_codigo_produto: cod,
        product_id: idByCod.get(cod) ?? null,
        saldo: p.saldo,
        cmc: p.cmc,
        preco_medio: p.precoMedio,
        account,
        synced_at: nowIso,
      };
    });
    let upsertsPosicao = 0;
    for (const chunk of chunked(invRows, 500)) {
      const { error } = await db
        .from("inventory_position")
        .upsert(chunk, { onConflict: "omie_codigo_produto,account" });
      if (error) {
        falhasChunk++;
        console.error(`[Sync ${account}] upsert inventory_position:`, error);
      } else {
        upsertsPosicao += chunk.length;
      }
    }
    // Falha TOTAL da tabela primária ≠ sucesso parcial (Codex P1, espelho do sync-reprocess):
    // se NENHUM chunk escreveu, a infra PostgREST está degradada — abortar antes de
    // estoque/custos (status 'error' honesto via catch) em vez de 'complete' com a fonte do
    // cockpit/EOQ integralmente stale.
    if (invRows.length > 0 && upsertsPosicao === 0) {
      throw new Error(
        `todos os ${chunked(invRows, 500).length} chunk(s) de inventory_position falharam — abortando antes de estoque/custos`,
      );
    }

    // 4) omie_products.estoque — upsert em LOTE por (omie_codigo_produto, account=EMPRESA).
    //    ⚠️ NUNCA pela PK id com payload mínimo: codigo/descricao/omie_codigo_produto são
    //    NOT NULL sem default e a tupla proposta do INSERT..ON CONFLICT é validada contra
    //    NOT NULL ANTES de o conflito ser arbitrado → o payload {id, estoque, updated_at}
    //    tomava 23502 no chunk INTEIRO, silencioso, em TODO ciclo (provado em prod 2026-07-17
    //    via psql-ro: zero cluster de updated_at nas janelas deste sync em 48h; mesmo padrão
    //    do hotfix #1344 no sync-reprocess). O payload carrega codigo/descricao lidos no
    //    próprio resolve (montarCatalogoPorCod); linha sem eles fica fora fail-closed.
    //    Upsert pela PK id com payload completo seria pior: conflito DUPLO PK+uniq → 23505.
    //    `account` aqui é EMPRESA (convenção omie_products, database.md §5) — ≠ o account de
    //    sync usado em inventory_position acima.
    const catalogoPorCod = montarCatalogoPorCod(prodRows, idByCod);
    const stockRows: Array<{
      omie_codigo_produto: number;
      account: string;
      codigo: string;
      descricao: string;
      estoque: number;
      updated_at: string;
    }> = [];
    for (const cod of codProds) {
      const cat = catalogoPorCod.get(cod);
      if (!cat) continue; // não-resolvido/ambíguo/sem codigo-descricao: posição e custos seguem
      stockRows.push({
        omie_codigo_produto: cod,
        account: empresa,
        codigo: cat.codigo,
        descricao: cat.descricao,
        estoque: posicoes.get(cod)!.saldo,
        updated_at: nowIso,
      });
    }
    for (const chunk of chunked(stockRows, 500)) {
      const { error } = await db
        .from("omie_products")
        .upsert(chunk, { onConflict: "omie_codigo_produto,account" });
      if (error) {
        falhasChunk++;
        console.error(`[Sync ${account}] upsert estoque omie_products:`, error);
      }
    }

    // 5) product_costs — só onde há product_id E cmc>0. Preserva a semântica anterior:
    //    já existe → atualiza SÓ cmc+updated_at (não toca cost_price/source/confidence);
    //    novo → insere linha completa (cost_source='CMC', cost_confidence=0.7).
    //    NB: este writer NUNCA promove proveniência para cima. A autoridade do cost_source é
    //    computeCosts — ele recomputa cost_price=cmc/cost_source=CMC quando há CMC. Uma linha
    //    proxy que ganha cmc aqui fica proxy HONESTO até o próximo recompute (sync_all roda o
    //    compute logo após; o cron intra-day cobre os syncs standalone). Nunca mente para cima.
    const costCandidatos = codProds
      .map((cod) => ({ id: idByCod.get(cod), cmc: posicoes.get(cod)!.cmc }))
      .filter((x): x is { id: string; cmc: number } => !!x.id && x.cmc > 0);

    if (costCandidatos.length > 0) {
      const jaTemCusto = new Set<string>();
      for (const chunk of chunked(costCandidatos.map((x) => x.id), 300)) {
        const { data, error } = await db.from("product_costs").select("product_id").in("product_id", chunk);
        if (error) {
          // SELECT falho degrada (≠ resolve de omie_products, que aborta): os candidatos do
          // chunk caem no "inserir" e o ignoreDuplicates abaixo pula os que já existem —
          // custo stale por 1 ciclo, nunca corrupção/clobber de proveniência.
          falhasChunk++;
          console.error(`[Sync ${account}] resolve product_costs:`, error);
          continue;
        }
        for (const r of data || []) jaTemCusto.add(r.product_id as string);
      }

      const aAtualizar = costCandidatos
        .filter((x) => jaTemCusto.has(x.id))
        .map((x) => ({ product_id: x.id, cmc: x.cmc, updated_at: nowIso }));
      const aInserir = costCandidatos
        .filter((x) => !jaTemCusto.has(x.id))
        .map((x) => ({ product_id: x.id, cost_price: x.cmc, cmc: x.cmc, cost_source: "CMC", cost_confidence: 0.7 }));

      for (const chunk of chunked(aAtualizar, 500)) {
        const { error } = await db.from("product_costs").upsert(chunk, { onConflict: "product_id" });
        if (error) {
          falhasChunk++;
          console.error(`[Sync ${account}] upsert cmc product_costs:`, error);
        }
      }
      for (const chunk of chunked(aInserir, 500)) {
        // ignoreDuplicates (ON CONFLICT DO NOTHING) anti-corrida (#1341): um candidato "novo"
        // que outro writer inseriu entre o SELECT e aqui derrubaria o chunk inteiro com 23505.
        const { error } = await db
          .from("product_costs")
          .upsert(chunk, { onConflict: "product_id", ignoreDuplicates: true });
        if (error) {
          falhasChunk++;
          console.error(`[Sync ${account}] insert product_costs:`, error);
        }
      }
    }

    // Falha parcial de chunk NÃO derruba a run (idempotente; o próximo ciclo reconcilia), mas
    // SURFAÇA no error_message (lição #1344: o 23502 deste sync ficou invisível por meses
    // porque o console.error era engolido — 'complete' limpo nunca pode mentir de novo).
    await updateSyncState(db, "inventory", account, {
      status: "complete",
      total_synced: totalSynced,
      last_sync_at: nowIso,
      last_page: totalPaginas,
      error_message: falhasChunk > 0
        ? `${falhasChunk} chunk(s) com erro de escrita (lote parcial — próximo ciclo reconcilia)`
        : null,
    });
    return { totalSynced, falhasChunk };
  } catch (error) {
    await updateSyncState(db, "inventory", account, { status: "error", error_message: String(error) });
    throw error;
  }
}

// ======== SYNC INVENTORY FULL (catálogo inteiro, p/ cobertura de CMC) ========
// Diferente do syncInventory (30 min, só itens COM saldo): usa cExibeTodos:"S" pra trazer
// o catálogo inteiro (inclusive saldo 0) e popular o cmc. Bulk (sem o N+1 do syncInventory)
// + roda em background (waitUntil) por causa do volume (~5x). Foco: inventory_position.cmc
// (fonte de custo do EOQ da Reposição). NÃO toca product_costs/omie_products (não-objetivo v1).
async function syncInventoryFull(db: SupabaseClient, account: OmieAccount) {
  await updateSyncState(db, "inventory_full", account, { status: "running", error_message: null });
  try {
    // 1) Map omie_products: omie_codigo_produto -> id, ESCOPADO À EMPRESA da account
    //    (accountToEmpresa). omie_products é UNIQUE(omie_codigo_produto, account=EMPRESA); sem o
    //    filtro, a resolução account-blind gravaria CMC/saldo no product_id de OUTRA empresa
    //    (mesmo número em empresas distintas, OU código que só existe na empresa errada — caso do
    //    `servicos`, que não tem catálogo colacor_sc em omie_products). Bulk paginado fura o cap de
    //    1000 do PostgREST; .order("id") = paginação estável exigida pelo .range() (mesmo padrão de
    //    computeCosts). buildProductIdMap nulifica ambíguo residual (defense-in-depth).
    const empresa = accountToEmpresa(account);
    const allProdRows: Array<{ id: string | null; omie_codigo_produto: number | string | null }> = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("omie_products")
        .select("id, omie_codigo_produto")
        .eq("account", empresa)
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      const rows = data ?? [];
      allProdRows.push(...rows);
      if (rows.length < 1000) break;
    }
    const idMap = buildProductIdMap(allProdRows);
    const ambiguos = [...idMap.values()].filter((v) => v === null).length;
    if (ambiguos > 0) {
      console.warn(`[Sync ${account}] ${ambiguos} código(s) ambíguo(s) em omie_products(${empresa}) — product_id nulificado (esperado 0 com filtro account-aware)`);
    }

    // 2) Paginar ListarPosEstoque com cExibeTodos:"S" (callOmie já tem retry/backoff p/ falha
    //    transitória). Coleta em Map (_shared/pos-estoque.ts, Codex P2×2): dedupe last-wins
    //    por código (repetido no MESMO chunk de upsert daria 21000 — o array antigo deixava
    //    passar) + valor não-finito descarta o ITEM (um malformado derrubaria o chunk de 500).
    let pagina = 1;
    let totalPaginas = 1;
    const posicoes = new Map<number, PosicaoEstoque>();
    let itensRecebidos = 0;
    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
        nPagina: pagina,
        nRegPorPagina: 100,
        dDataPosicao: new Date().toLocaleDateString("pt-BR"),
        cExibeTodos: "S",
      })) as unknown as OmieListarPosEstoqueResponse;

      // Piso MONOTÔNICO + teto fail-fast (_shared/omie-paginacao.ts): mesmo defeito do
      // syncInventory — `nTotPaginas || 1` por resposta encolhia o teto e completava retrato
      // parcial. Com cExibeTodos:"S" o catálogo inteiro (~43 págs colacor) fica sob o teto 500.
      totalPaginas = proximoTotalPaginas(totalPaginas, result.nTotPaginas, MAX_PAGINAS_POS_ESTOQUE);
      const produtos = result.produtos || [];
      const veredicto = avaliarPagina(produtos.length, pagina, totalPaginas);
      if (veredicto === "anomalia") {
        // Página vazia ANTES do fim declarado = fault disfarçado → aborta fail-closed antes
        // de qualquer escrita (invRows só upserta após a coleta completa).
        throw new Error(`página ${pagina}/${totalPaginas} do ListarPosEstoque (full) veio vazia antes do fim declarado — abortando (retrato parcial)`);
      }
      if (veredicto === "fim") break;
      itensRecebidos += produtos.length;
      acumularPosicoesDaPagina(posicoes, produtos);
      console.log(`[Sync ${account}] inventory_full página ${pagina}/${totalPaginas} — ${posicoes.size} itens acumulados`);
      pagina++;
    }

    // Recebi itens mas descartei TODOS na normalização = drift de contrato TOTAL (Codex P1
    // rodada 2): completar 'complete/0' mentiria com o catálogo de CMC integralmente stale.
    if (itensRecebidos > 0 && posicoes.size === 0) {
      throw new Error(
        `ListarPosEstoque (full) devolveu ${itensRecebidos} item(ns) e TODOS foram descartados na normalização — drift de contrato, abortando fail-closed`,
      );
    }

    // 3) Upsert em lote (chunks de 500) — onConflict igual ao syncInventory. synced_at único
    //    capturado APÓS a coleta (mesma janela curta do syncInventory); total_synced passa a
    //    contar posições ÚNICAS (dedupe), consistente com o syncInventory.
    const now = new Date().toISOString();
    const invRows = [...posicoes.entries()].map(([cod, p]) => ({
      omie_codigo_produto: cod,
      product_id: idMap.get(cod) ?? null,
      saldo: p.saldo,
      cmc: p.cmc,
      preco_medio: p.precoMedio,
      account,
      synced_at: now,
    }));
    const totalSynced = invRows.length;
    const CHUNK = 500;
    for (let i = 0; i < invRows.length; i += CHUNK) {
      const slice = invRows.slice(i, i + CHUNK);
      const { error } = await db
        .from("inventory_position")
        .upsert(slice, { onConflict: "omie_codigo_produto,account" });
      if (error) throw error;
    }

    await updateSyncState(db, "inventory_full", account, {
      status: "complete",
      total_synced: totalSynced,
      last_sync_at: new Date().toISOString(),
      last_page: totalPaginas,
    });
    return { totalSynced };
  } catch (error) {
    await updateSyncState(db, "inventory_full", account, { status: "error", error_message: String(error) });
    throw error;
  }
}

// ======== COMPUTE COSTS (Fallback Engine) ========

async function computeCosts(db: SupabaseClient) {
  // Load config
  const { data: configs } = await db.from("recommendation_config").select("key, value");
  const cfg: Record<string, number> = {};
  for (const c of configs || []) cfg[c.key] = c.value;

  const margemDefault = cfg.margem_default_global ?? 0.35;
  const margemMin = cfg.margem_minima ?? 0.05;
  const margemMax = cfg.margem_maxima ?? 0.85;
  // Guard anti-lixo do CMC (faixa absoluta cmc/price): rejeita só erro de dado (quase-zero/desproporcional).
  // Um CMC fora da banda de margem mas DENTRO desta faixa vira CMC_MARGEM_ATIPICA (custo real preservado,
  // prejuízo/margem-baixa/alta observável) em vez de ser mascarado por proxy. Defaults aqui; ajustáveis via
  // recommendation_config (margem_cmc_ratio_min/max) sem deploy. kMax=5 cobre o gap empírico real 4.97×→14.39×.
  const cmcRatioMin = cfg.margem_cmc_ratio_min ?? 0.01;
  const cmcRatioMax = cfg.margem_cmc_ratio_max ?? 5;

  // Catálogo ATIVO inteiro — PAGINADO: o PostgREST capa o .select() em 1000 linhas em
  // SILÊNCIO (docs/agent/database.md §5). Sem isto, ~2/3 dos ~3k produtos ativos nunca
  // eram recalculados. .order("id") = coluna estável exigida pelo .range() entre páginas.
  const products = await fetchAll<{ id: string; valor_unitario: number; familia: string | null; unidade: string | null; descricao: string | null }>(
    (from, to) =>
      db
        .from("omie_products")
        .select("id, valor_unitario, familia, unidade, descricao")
        .eq("ativo", true)
        .order("id", { ascending: true })
        .range(from, to),
    "omie_products(ativos)",
  );
  if (!products.length) return { updated: 0 };

  // product_costs inteiro — PAGINADO pelo mesmo motivo: um costMap truncado perdia o CMC
  // persistido da cauda e cmcPreferido rebaixava custo real a proxy. Só `cmc` é lido aqui.
  const costsRaw = await fetchAll<{ product_id: string; cmc: number | null }>(
    (from, to) =>
      db
        .from("product_costs")
        .select("product_id, cmc")
        .order("product_id", { ascending: true })
        .range(from, to),
    "product_costs",
  );
  const costMap: Record<string, { cmc?: number | null }> = {};
  for (const c of costsRaw) costMap[c.product_id] = c;

  // inventory_position inteiro — PAGINADO pelos MESMOS motivos das duas leituras acima: o
  // PostgREST capa o .select() em 1000 linhas em SILÊNCIO (docs/agent/database.md §5) e a
  // tabela tem ~3k linhas (4 convenções de account). Sem paginar (#985 paginou omie_products
  // e product_costs mas DEIXOU esta de fora), ~2/3 do catálogo perdia o cmc FRESCO do
  // inventory — syncInventoryFull atualiza inventory_position.cmc do catálogo inteiro mas NÃO
  // product_costs, então computeCosts é a ÚNICA ponte; truncada, cmcPreferido rebaixava p/ o
  // product_costs.cmc STALE E a margem média por família saía de amostra truncada.
  // .order("id") = PK estável exigida pelo .range() (ver _shared/paginate.ts).
  const inventory = await fetchAll<InventoryPositionRow>(
    (from, to) =>
      db
        .from("inventory_position")
        .select("product_id, cmc, saldo, synced_at")
        .order("id", { ascending: true })
        .range(from, to),
    "inventory_position",
  );
  // Colapso por product_id ELEGENDO a melhor linha (não last-wins por id). inventory_position
  // é UNIQUE por (omie_codigo_produto, account) e há 2 convenções de account p/ a MESMA empresa
  // (omie-analytics grava vendas/colacor_vendas/servicos; sync-reprocess grava oben/colacor) →
  // o MESMO product_id aparece em >1 linha. Eleger por `id` (UUID aleatório) deixaria uma linha
  // cmc=0/stale esconder a positiva/fresca e gravar custo stale em product_costs (achado Codex
  // [P1]). Critério money-path = cmc>0 vence ausente/0 e, entre positivas, synced_at mais recente —
  // mesmo padrão de eleição cross-account do get_preco_cockpit/fin-valor-cockpit. (Prova em prod:
  // muda 0 outcomes hoje — é guard de borda contra a fragilidade, não regressão.)
  const invMap: Record<string, InventoryPositionRow> = {};
  for (const i of inventory) {
    if (!i.product_id) continue;
    const prev = invMap[i.product_id];
    if (!prev) {
      invMap[i.product_id] = i;
      continue;
    }
    const iPos = (i.cmc ?? 0) > 0;
    const prevPos = (prev.cmc ?? 0) > 0;
    // cmc positivo vence cmc ausente/0; empate de positividade → synced_at mais recente vence
    // (null synced_at perde por ordenar como string vazia).
    const melhor = iPos !== prevPos ? iPos : (i.synced_at ?? "") > (prev.synced_at ?? "");
    if (melhor) invMap[i.product_id] = i;
  }

  // Montagem PURA dos upserts (testada em src/lib/custo/costCompute.test.ts; espelho
  // verbatim em _shared/cost-compute.ts). Recebe o catálogo COMPLETO (paginado acima) —
  // a cauda > 1000 deixa de virar proxy e o CMC real é preservado (ausente ≠ zero).
  const nowIso = new Date().toISOString();
  const { rows } = montarUpsertsDeCusto(
    products,
    costMap,
    invMap as unknown as Record<string, { cmc?: number | null }>,
    { margemDefault, margemMin, margemMax, cmcRatioMin, cmcRatioMax },
    nowIso,
  );

  // Upsert em LOTE (chunks de 500). Antes: N+1 (1 upsert por produto DENTRO do loop) —
  // com o catálogo destruncado (~3k) isso estouraria o tempo do edge.
  // Money-path (Codex P1): um lote que falha derruba 500 linhas ATOMICAMENTE — não
  // reportar sucesso falso. Conta só o que PERSISTIU e LANÇA se algum lote falhou (o
  // caller vira status=error; o data_health não marca "fresco" sobre gravação parcial).
  const lotes = chunked(rows, 500);
  let updated = 0;
  const errosUpsert: string[] = [];
  for (const chunk of lotes) {
    const { error } = await db.from("product_costs").upsert(chunk, { onConflict: "product_id" });
    if (error) {
      errosUpsert.push(error.message);
      console.error("[computeCosts] upsert product_costs (lote):", error);
    } else {
      updated += chunk.length;
    }
  }
  if (errosUpsert.length) {
    throw new Error(
      `computeCosts: ${errosUpsert.length}/${lotes.length} lotes de upsert falharam ` +
        `(${updated}/${rows.length} persistidos). 1º erro: ${errosUpsert[0]}`,
    );
  }

  return { updated };
}

// ======== CUSTO DE PRODUÇÃO (fabricados via Estrutura/malha do Omie) ========
// Recompõe custo_producao = Σ(quantProdMalha × (1+perda%) × cmc_insumo) + vMOD + vGGF por fabricado
// (tipo_produto '04'), na coluna DEDICADA product_costs.custo_producao. Writer ÚNICO desta coluna —
// NÃO toca cmc/cost_final (sem race com computeCosts/syncInventory). A v_caca_compradores usa
// COALESCE(custo_producao, NULLIF(cmc,0)). Degradação honesta via status (ausente ≠ zero). Lógica
// pura provada em src/lib/custo/recomporCustoProducao.test.ts (espelho _shared, parity test).
// ⚠️ ORDEM (cron): rodar DEPOIS de sync_inventory + compute_costs — cmc dos insumos fresco e linhas
//    de product_costs já criadas (senão margem híbrida / INSERT com cost_final=0 default).
interface OmieEstruturaItem {
  idProdMalha?: number;
  quantProdMalha?: number;
  percPerdaProdMalha?: number;
}
interface OmieConsultarEstruturaResponse {
  itens?: OmieEstruturaItem[];
  custoProducao?: { vMOD?: number; vGGF?: number };
}

async function syncCustoProducao(db: SupabaseClient, account: OmieAccount) {
  await updateSyncState(db, "custo_producao", account, { status: "running", error_message: null });
  try {
    const empresa = accountToEmpresa(account);

    // 1) Catálogo ATIVO da empresa (paginado — fura o cap de 1000 do PostgREST).
    const produtos = await fetchAll<{
      id: string;
      omie_codigo_produto: number;
      valor_unitario: number | null;
      tipo_produto: string | null;
    }>(
      (from, to) =>
        db
          .from("omie_products")
          .select("id, omie_codigo_produto, valor_unitario, tipo_produto")
          .eq("account", empresa)
          // SEM filtro ativo: insumo inativo pode seguir em malha válida; fabricado inativo ainda
          // aparece em pedidos históricos que a Caça rankeia (achado P2 do Codex 2026-06-23).
          .order("id", { ascending: true })
          .range(from, to),
      "omie_products(custo_producao)",
    );

    // 2) cmc por nCodProduto (insumos): product_costs.cmc → product_id → omie_codigo_produto.
    const costsRaw = await fetchAll<{ product_id: string; cmc: number | null }>(
      (from, to) =>
        db
          .from("product_costs")
          .select("product_id, cmc")
          .order("product_id", { ascending: true })
          .range(from, to),
      "product_costs(custo_producao)",
    );
    const cmcPorProductId = new Map<string, number | null>();
    for (const c of costsRaw) cmcPorProductId.set(c.product_id, c.cmc);
    const temLinhaCusto = new Set(costsRaw.map((c) => c.product_id));

    const cmcPorCodigo = new Map<number, number | null | undefined>();
    const precoPorCodigo = new Map<number, number | null>();
    for (const p of produtos) {
      const cod = Number(p.omie_codigo_produto);
      precoPorCodigo.set(cod, p.valor_unitario);
      // cmc de INSUMO só: exclui fabricados (tipo 04) do mapa → um componente que é ele mesmo
      // fabricado NÃO resolve por cmc espúrio; vira missing_component_cost (degrada honesto).
      // Recomposição recursiva de BOM aninhada = fase 2 (achado P2 do Codex 2026-06-23).
      if (p.tipo_produto !== "04") cmcPorCodigo.set(cod, cmcPorProductId.get(p.id) ?? null);
    }

    // 3) Fabricados (tipo_produto '04' = produto acabado). Para cada: ConsultarEstrutura → recompor.
    const fabricados = produtos.filter((p) => p.tipo_produto === "04");
    const nowIso = new Date().toISOString();
    const tally: Record<string, number> = {};
    const bump = (k: string) => {
      tally[k] = (tally[k] ?? 0) + 1;
    };
    let logouAmostra = false;

    // só grava em linha que JÁ existe (computeCosts cria) → evita INSERT com cost_final=0 default.
    const alvos = fabricados.filter((fab) => {
      if (temLinhaCusto.has(fab.id)) return true;
      bump("sem_linha_product_costs");
      return false;
    });

    // Processa em LOTES PARALELOS com FLUSH incremental. A 1ª versão fazia N+1 SEQUENCIAL (~260
    // ConsultarEstrutura) e estourava WORKER_RESOURCE_LIMIT antes do upsert final → preso em 'running',
    // 0 gravado (provado em prod 2026-06-24). Agora: Promise.all em lotes (corta o wall-clock ~LOTE×) +
    // flush a cada FLUSH itens (grava o progresso parcial: se o worker morrer, não perde o já feito) +
    // total_synced parcial no sync_state (monitorável). É o padrão "bulk + waitUntil" do CLAUDE.md.
    const LOTE = 8; // ConsultarEstrutura concorrentes por vez (suave no rate limit do Omie)
    const FLUSH = 80; // tamanho do buffer antes de gravar
    let updated = 0;
    const erros: string[] = [];
    let buffer: Array<Record<string, unknown>> = [];
    const flush = async () => {
      if (buffer.length === 0) return;
      const slice = buffer;
      buffer = [];
      const { error } = await db.from("product_costs").upsert(slice, { onConflict: "product_id" });
      if (error) {
        erros.push(error.message);
        console.error("[custo_producao] upsert lote:", error);
      } else {
        updated += slice.length;
        await updateSyncState(db, "custo_producao", account, { status: "running", total_synced: updated });
      }
    };

    for (let i = 0; i < alvos.length; i += LOTE) {
      const resultados = await Promise.all(
        alvos.slice(i, i + LOTE).map(async (fab) => {
          const cod = Number(fab.omie_codigo_produto);
          try {
            const resp = (await callOmie(account, "geral/malha/", "ConsultarEstrutura", {
              idProduto: cod,
            })) as unknown as OmieConsultarEstruturaResponse;
            return { fab, cod, resp };
          } catch (e) {
            console.error(
              `[custo_producao ${account}] ConsultarEstrutura idProduto=${cod}: ${e instanceof Error ? e.message : e}`,
            );
            return { fab, cod, resp: null as OmieConsultarEstruturaResponse | null };
          }
        }),
      );

      for (const r of resultados) {
        if (!r.resp) {
          // API falhou (após o retry do callOmie) → degrada HONESTO: zera + status='erro_api' (não deixa
          // o custo_producao velho passar por atual na view = stale money-path; achado P1 do Codex).
          bump("erro_api");
          buffer.push({
            product_id: r.fab.id,
            custo_producao: null,
            custo_producao_source: "ESTRUTURA_OMIE",
            custo_producao_status: "erro_api",
            custo_producao_computed_at: nowIso,
          });
          continue;
        }
        // 1ª resposta crua no log → confirma os nomes de campo na 1ª execução real (auto-validação).
        if (!logouAmostra) {
          console.log(
            `[custo_producao ${account}] amostra idProduto=${r.cod}: ${JSON.stringify(r.resp).slice(0, 1000)}`,
          );
          logouAmostra = true;
        }
        const componentes = (r.resp.itens ?? []).map((it) => ({
          codigo: Number(it.idProdMalha),
          quantidade: Number(it.quantProdMalha ?? 0),
          percPerda: Number(it.percPerdaProdMalha ?? 0),
        }));
        const { custo, status, faltantes } = recomporCustoProducao({
          componentes,
          vMOD: Number(r.resp.custoProducao?.vMOD ?? 0),
          vGGF: Number(r.resp.custoProducao?.vGGF ?? 0),
          cmcPorCodigo,
          precoVenda: precoPorCodigo.get(r.cod) ?? null,
        });
        bump(status);
        if (status === "missing_component_cost" && faltantes.length) {
          console.log(`[custo_producao ${account}] cod=${r.cod} sem cmc dos insumos: ${faltantes.join(",")}`);
        }
        buffer.push({
          product_id: r.fab.id,
          custo_producao: custo, // NULL quando degradado (honesto — ausente ≠ zero)
          custo_producao_source: "ESTRUTURA_OMIE",
          custo_producao_status: status,
          custo_producao_computed_at: nowIso,
        });
      }

      if (buffer.length >= FLUSH) await flush();
      if ((i / LOTE) % 5 === 0) {
        console.log(
          `[custo_producao ${account}] progresso ${Math.min(i + LOTE, alvos.length)}/${alvos.length} (gravados ${updated})`,
        );
      }
    }
    await flush(); // resto do buffer

    // Money-path: conta só o que PERSISTIU; lança se algum lote de upsert falhou (caller vira error).
    if (erros.length) {
      throw new Error(`custo_producao: ${erros.length} lotes de upsert falharam (${updated} gravados). 1º: ${erros[0]}`);
    }

    console.log(
      `[custo_producao ${account}] fabricados=${fabricados.length} alvos=${alvos.length} gravados=${updated} tally=${JSON.stringify(tally)}`,
    );
    await updateSyncState(db, "custo_producao", account, {
      status: "complete",
      total_synced: updated,
      last_sync_at: new Date().toISOString(),
    });
    return { fabricados: fabricados.length, gravados: updated, tally };
  } catch (error) {
    await updateSyncState(db, "custo_producao", account, { status: "error", error_message: String(error) });
    throw error;
  }
}

// ======== COMPUTE ASSOCIATION RULES (Apriori-like) ========

async function computeAssociationRules(db: SupabaseClient) {
  // Load config
  const { data: configs } = await db.from("recommendation_config").select("key, value");
  const cfg: Record<string, number> = {};
  for (const c of configs || []) cfg[c.key] = c.value;

  const minSupport = cfg.s_min ?? 0.01;
  const minLift = cfg.l_min ?? 1.2;
  const maxRules = cfg.max_association_rules ?? 500;

  // Load all order_items grouped by sales_order_id
  const { data: items } = await db
    .from("order_items")
    .select("sales_order_id, product_id")
    .not("product_id", "is", null);

  if (!items?.length) return { rules_generated: 0 };

  // Build transactions: Map<order_id, Set<product_id>>
  const transactions = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.product_id || !item.sales_order_id) continue;
    if (!transactions.has(item.sales_order_id)) transactions.set(item.sales_order_id, new Set());
    transactions.get(item.sales_order_id)!.add(item.product_id);
  }

  const totalTx = transactions.size;
  if (totalTx < 5) return { rules_generated: 0, reason: "Insufficient transactions" };

  // Count single item support
  const itemCounts = new Map<string, number>();
  for (const [, basket] of transactions) {
    for (const pid of basket) {
      itemCounts.set(pid, (itemCounts.get(pid) || 0) + 1);
    }
  }

  // Filter frequent items
  const frequentItems = new Map<string, number>();
  for (const [pid, count] of itemCounts) {
    if (count / totalTx >= minSupport) {
      frequentItems.set(pid, count);
    }
  }

  // Count pair co-occurrences
  const pairCounts = new Map<string, number>();
  for (const [, basket] of transactions) {
    const items = Array.from(basket).filter(p => frequentItems.has(p));
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const key = [items[i], items[j]].sort().join("|");
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }

  // Generate rules
  interface Rule {
    antecedent: string[];
    consequent: string[];
    support: number;
    confidence: number;
    lift: number;
  }

  const rules: Rule[] = [];

  for (const [pairKey, pairCount] of pairCounts) {
    const [a, b] = pairKey.split("|");
    const supportAB = pairCount / totalTx;
    if (supportAB < minSupport) continue;

    const supportA = (frequentItems.get(a) || 0) / totalTx;
    const supportB = (frequentItems.get(b) || 0) / totalTx;

    // Rule A→B
    const confAB = supportAB / supportA;
    const liftAB = confAB / supportB;
    if (liftAB >= minLift) {
      rules.push({ antecedent: [a], consequent: [b], support: supportAB, confidence: confAB, lift: liftAB });
    }

    // Rule B→A
    const confBA = supportAB / supportB;
    const liftBA = confBA / supportA;
    if (liftBA >= minLift) {
      rules.push({ antecedent: [b], consequent: [a], support: supportAB, confidence: confBA, lift: liftBA });
    }
  }

  // Sort by lift*confidence descending, take top N
  rules.sort((a, b) => (b.lift * b.confidence) - (a.lift * a.confidence));
  const topRules = rules.slice(0, maxRules);

  // Clear old rules and insert new ones
  await db.from("farmer_association_rules").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  let inserted = 0;
  for (const rule of topRules) {
    const { error } = await db.from("farmer_association_rules").insert({
      antecedent_product_ids: rule.antecedent,
      consequent_product_ids: rule.consequent,
      support: rule.support,
      confidence: rule.confidence,
      lift: rule.lift,
      rule_type: "association",
      sample_size: totalTx,
    });
    if (!error) inserted++;
  }

  console.log(`[AssocRules] Generated ${inserted} rules from ${totalTx} transactions`);
  return { rules_generated: inserted, total_transactions: totalTx, frequent_items: frequentItems.size };
}

// ======== MAIN HANDLER ========

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { action, account = "vendas", start_page, max_pages } = await req.json();
    // Registro de execuções (acoes_execucoes): cast estrutural — o client untyped satisfaz o mínimo.
    const dbRegistro = supabaseAdmin as unknown as DbRegistro;
    let result: unknown;

    switch (action) {
      case "sync_customers": {
        // syncCustomers enumera ~10k clientes do Omie — pesado demais p/ o budget SÍNCRONO do request
        // (dava WORKER_RESOURCE_LIMIT e prendia sync_state.customers em 'running' indefinidamente).
        // Roda em BACKGROUND via EdgeRuntime.waitUntil (mesmo padrão do start_nao_vinculados, que
        // completa o MESMO volume): responde 202 na hora; o sync_state (running→complete) é a fonte
        // de progresso/verdade. O worker dedicado tem budget estendido p/ background.
        const bgTask = syncCustomers(supabaseAdmin, account as OmieAccount).catch((e) => {
          console.error("[sync_customers][bg]", e instanceof Error ? e.message : e);
        });
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - EdgeRuntime existe no runtime do Supabase Edge
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          EdgeRuntime.waitUntil(bgTask);
        }
        return new Response(JSON.stringify({ accepted: true, background: true }), {
          status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      case "sync_products":
        result = await syncProducts(supabaseAdmin, account, start_page || 1, max_pages || 10);
        break;
      case "sync_orders":
        result = await syncOrdersIncremental(supabaseAdmin, account);
        break;
      case "sync_inventory":
        result = await syncInventory(supabaseAdmin, account);
        break;
      case "sync_inventory_full": {
        // Guard de UX "já em andamento" (não duplica o trabalho de catálogo se um run ainda roda).
        const { data: stFull } = await supabaseAdmin
          .from("sync_state")
          .select("status, last_sync_at, updated_at")
          .eq("entity_type", "inventory_full")
          .eq("account", account)
          .maybeSingle();
        const startedAt = stFull?.updated_at ? new Date(stFull.updated_at).getTime() : 0;
        const running = stFull?.status === "running" && (Date.now() - startedAt) < 30 * 60 * 1000;
        if (running) {
          return new Response(JSON.stringify({ accepted: false, reason: "already_running" }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const bgTask = syncInventoryFull(supabaseAdmin, account as OmieAccount).catch((e) => {
          console.error("[sync_inventory_full][bg]", e instanceof Error ? e.message : e);
        });
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - EdgeRuntime existe no runtime do Supabase Edge
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          EdgeRuntime.waitUntil(bgTask);
        }
        return new Response(JSON.stringify({ accepted: true, background: true }), {
          status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      case "sync_custo_producao": {
        // N≈260 ConsultarEstrutura → background (waitUntil) + guard already_running (como inventory_full).
        const { data: stCp } = await supabaseAdmin
          .from("sync_state")
          .select("status, updated_at")
          .eq("entity_type", "custo_producao")
          .eq("account", account)
          .maybeSingle();
        const startedCp = stCp?.updated_at ? new Date(stCp.updated_at).getTime() : 0;
        if (stCp?.status === "running" && (Date.now() - startedCp) < 30 * 60 * 1000) {
          return new Response(JSON.stringify({ accepted: false, reason: "already_running" }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const bgCp = syncCustoProducao(supabaseAdmin, account as OmieAccount).catch((e) => {
          console.error("[sync_custo_producao][bg]", e instanceof Error ? e.message : e);
        });
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - EdgeRuntime existe no runtime do Supabase Edge
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          EdgeRuntime.waitUntil(bgCp);
        }
        return new Response(JSON.stringify({ accepted: true, background: true }), {
          status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      case "compute_costs":
        result = await comRegistro(
          dbRegistro, "analytics_sync.recalcular_custos", auth,
          () => computeCosts(supabaseAdmin),
          (r) => ({ updated: (r as { updated?: number }).updated ?? null }),
        );
        break;
      case "compute_association_rules":
        result = await comRegistro(
          dbRegistro, "analytics_sync.recalcular_regras", auth,
          () => computeAssociationRules(supabaseAdmin),
          (r) => {
            const a = r as { rules_generated?: number; total_transactions?: number };
            return { rules_generated: a.rules_generated ?? null, total_transactions: a.total_transactions ?? null };
          },
        );
        break;
      case "sync_all": {
        // customers SAIU do sync_all: agora tem cron dedicado (sync-customers-vendas-daily) que chama
        // a action sync_customers em BACKGROUND. Rodar customers síncrono aqui dava WORKER_RESOURCE_LIMIT
        // e RE-prendia sync_state.customers em 'running' a cada passada — clobberava o estado curado.
        const acct = account as OmieAccount;
        result = await comRegistro(dbRegistro, "analytics_sync.sync_completo", auth, async () => {
          const products = await syncProducts(supabaseAdmin, acct);
          // orders REMOVIDO do sync_all (2026-06-24): syncOrdersIncremental foi aposentado (no-op que
          // poluía sales_price_history). A fonte de pedidos é a RPC criar_pedidos_com_itens (omie-vendas-sync).
          const inventory = await syncInventory(supabaseAdmin, acct);
          // Motores registrados com os PRÓPRIOS slugs: o sync_all recalcula custos/regras DE VERDADE,
          // e a caption dos cards precisa refletir isso (a verdade é por slug).
          const costs = await comRegistro(
            dbRegistro, "analytics_sync.recalcular_custos", auth,
            () => computeCosts(supabaseAdmin),
            (r) => ({ updated: (r as { updated?: number }).updated ?? null }),
          );
          const assocRules = await comRegistro(
            dbRegistro, "analytics_sync.recalcular_regras", auth,
            () => computeAssociationRules(supabaseAdmin),
          );
          return { products, inventory, costs, assocRules };
        });
        break;
      }
      case "get_sync_state": {
        const { data } = await supabaseAdmin.from("sync_state").select("*").order("entity_type");
        result = data;
        break;
      }
      case "start_nao_vinculados": {
        // v1: só Oben.
        if (account !== "vendas") {
          return new Response(JSON.stringify({ error: "v1 suporta apenas account=vendas (Oben)" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        // Gate master/gestor server-side (authorizeCronOrStaff só garante staff).
        // Cron/service_role são confiáveis e passam direto.
        if (auth.via === "staff") {
          const { data: pode } = await supabaseAdmin.rpc("pode_ver_carteira_completa", { _uid: auth.userId });
          if (!pode) {
            return new Response(JSON.stringify({ error: "Forbidden: requer master ou gestor comercial" }), {
              status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
        // Guard de UX "já em andamento" (correção não depende disso; é só pra não duplicar trabalho).
        const { data: st } = await supabaseAdmin
          .from("omie_nao_vinculados_state")
          .select("status, started_at")
          .eq("empresa", "oben")
          .maybeSingle();
        const running = st?.status === "running" && st?.started_at &&
          (Date.now() - new Date(st.started_at as string).getTime() < 15 * 60 * 1000);
        if (running) {
          return new Response(JSON.stringify({ accepted: false, already_running: true }), {
            status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        // Dispara a rotina dedicada de não-vinculados em background; responde 202 na hora.
        const bgTask = syncNaoVinculados(supabaseAdmin, "vendas").catch((e) => {
          console.error("[nao-vinculados][async]", e instanceof Error ? e.message : e);
        });
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-ignore intencional: EdgeRuntime é global do Deno/Supabase Edge (pode não estar tipado); @ts-expect-error quebraria o deploy se estivesse tipado
        // @ts-ignore - EdgeRuntime existe no runtime do Supabase Edge
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- idem acima
          // @ts-ignore
          EdgeRuntime.waitUntil(bgTask);
        }
        return new Response(JSON.stringify({ accepted: true }), {
          status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      case "doc_ambiguo_probe": {
        // CANÁRIA COMPORTAMENTAL do P1b (doc-ambíguo-Omie) — NÃO escreve, NÃO chama o Omie, NÃO toca o
        // DB. Roda o helper puro `docsComCodigoAmbiguoNoOmie` DEPLOYADO (o bloco MIRROR deste arquivo,
        // não o de src/) sobre fixtures fixos e compara com o esperado.
        // Por que existe: o Lovable JÁ reverteu este helper num deploy (#1272/#1273), e a ausência dele
        // é INDETECTÁVEL por sonda de dados — a proof-table só encolhe quando há duplicata-CNPJ real na
        // conta, e não há (colacor_sc: 5275→5275 no run, verificado via psql-ro em 2026-07-10). Ou seja:
        // no run normal o guard nunca é exercitado, e some sem deixar rastro no dado. Só executar o
        // helper deployado sobre um fixture sintético prova que ele está no bundle.
        // Prova duas coisas que o commit de deploy NÃO prova: (1) esta action RESPONDE → o bundle no ar
        // é o desta árvore (senão viria "Ação desconhecida" = binário velho); (2) a tabela-verdade
        // deployada está certa. É a contraparte-DEPLOY do guard TEXTUAL (edge-money-path-invariants,
        // describe "P1b doc-ambíguo-Omie"), que cobre a FONTE na main. Gated por authorizeCronOrStaff
        // como toda action. Account-agnóstico de propósito: o helper recebe registros JÁ escopados por
        // conta pelo chamador (syncCustomers) — a probe testa a decisão, não o escopo.
        // Igualdade estrutural ESTÁVEL (mesma mecânica do `identidade_probe` em omie-vendas-sync).
        const stableId = (o: unknown): string =>
          JSON.stringify(o, (_k, v) =>
            v && typeof v === "object" && !Array.isArray(v)
              ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
              : v);
        // O helper retorna Set<string> (JSON.stringify de Set daria "{}") → canonizo ambos os lados como
        // array ORDENADO: ordem é semanticamente irrelevante num conjunto, e sem o sort a comparação
        // daria falso-negativo dependendo da ordem de inserção.
        const canon = (xs: Iterable<string>): string[] => [...xs].sort();
        // Enumeração COMPLETA do oráculo (espelha src/lib/omie/omie-doc-ambiguo.test.ts): os casos +/- se
        // falsificam MUTUAMENTE — um helper sempre-∅ reprova o caso ambíguo; um que marca tudo reprova os
        // casos limpos. Cobrir só um lado deixaria um helper deployado quebrado passar como ok:true.
        const fixturesDoc: Array<{ caso: string; registros: Array<{ doc: string; codigo: number }>; expected: string[] }> = [
          // 1 código no doc → não ambíguo (o caminho normal: vira vínculo na proof-table)
          { caso: "doc_1_codigo", registros: [{ doc: "111", codigo: 100 }], expected: [] },
          // 2 códigos DISTINTOS no mesmo doc → AMBÍGUO (o coração do P1b: fecha o last-write-wins)
          { caso: "doc_2_codigos_distintos", registros: [{ doc: "111", codigo: 100 }, { doc: "111", codigo: 200 }], expected: ["111"] },
          // MESMO código repetido (duplicata do Omie na paginação) → NÃO ambíguo (senão zeraria o mapa)
          { caso: "doc_mesmo_codigo_repetido", registros: [{ doc: "111", codigo: 100 }, { doc: "111", codigo: 100 }], expected: [] },
          // 3+ códigos → ambíguo (o >1 não é um off-by-one em 2)
          { caso: "doc_3_codigos", registros: [{ doc: "111", codigo: 100 }, { doc: "111", codigo: 200 }, { doc: "111", codigo: 300 }], expected: ["111"] },
          // doc vazio não vira chave (o boundary já filtra sem-doc) — 2 códigos sob "" não são ambíguos
          { caso: "doc_vazio_ignorado", registros: [{ doc: "", codigo: 100 }, { doc: "", codigo: 200 }], expected: [] },
          // mistura: só os ambíguos entram; os limpos ficam de fora (precisão do escopo do fail-closed)
          { caso: "mistura_so_ambiguos", registros: [{ doc: "A", codigo: 1 }, { doc: "B", codigo: 2 }, { doc: "B", codigo: 3 }, { doc: "C", codigo: 4 }, { doc: "C", codigo: 4 }], expected: ["B"] },
          // lista vazia → ∅ (nenhum doc marcado por acidente)
          { caso: "lista_vazia", registros: [], expected: [] },
        ];
        const casosDoc = fixturesDoc.map((c) => {
          const resolved = canon(docsComCodigoAmbiguoNoOmie(c.registros));
          const expected = canon(c.expected);
          return { caso: c.caso, resolved, expected, ok: stableId(resolved) === stableId(expected) };
        });
        result = {
          success: true,
          probe_no_ar: true, // a action respondeu → o helper P1b está no build deployado
          ok: casosDoc.every((c) => c.ok), // true = a tabela-verdade deployada bate em TODOS os fixtures
          casos: casosDoc,
        };
        break;
      }

      default:
        return new Response(JSON.stringify({ error: "Ação desconhecida" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify({ success: true, data: result }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Analytics Sync] Erro:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
