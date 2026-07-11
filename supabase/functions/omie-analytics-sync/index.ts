import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { fetchAll } from "../_shared/paginate.ts";
import { montarUpsertsDeCusto } from "../_shared/cost-compute.ts";
import { recomporCustoProducao } from "../_shared/recompor-custo-producao.ts";
import { buildProductIdMap } from "./product-idmap.ts";

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

// Map<documento_normalizado, user_id> NÃO-ambíguo de profiles, via snapshot atômico server-side (RPC).
// Antes: paginação OFFSET (não-atômica — Codex xhigh: um profile nascendo/mudando entre páginas escapava
// da detecção de doc-ambíguo). Agora a RPC omie_sync_identity_snapshot resolve a unicidade num ÚNICO
// snapshot MVCC (doc com 2+ users DISTINTOS já vem FORA de doc_to_user, fail-closed no SQL). doc_to_user
// é global (profiles não tem conta); passamos a conta em curso só p/ satisfazer a assinatura da RPC.
// .rpc() NÃO lança em erro (resolve {error}) → checar e FAIL-CLOSED (throw): mapa parcial vincularia errado.
async function fetchProfileDocUserMap(db: SupabaseClient, account: string): Promise<Map<string, string>> {
  const { data: snap, error } = await db.rpc('omie_sync_identity_snapshot', { p_account: account });
  if (error) throw new Error(`identity snapshot (${account}): ${error.message}`);
  return new Map<string, string>(Object.entries((snap?.doc_to_user ?? {}) as Record<string, string>));
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
            omie_codigo_vendedor: c.codigo_vendedor || null,
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

    // Bulk upsert em chunks (onConflict user_id = unique_user_omie). empresa_omie NÃO é setado
    // (preserva o default 'colacor' do comportamento anterior).
    // Fatia 4 (money-path, Codex): SÓ 'vendas'(oben) mantém o espelho legado omie_clientes. Este
    // upsert é CODE-FIRST (userByCodigo do espelho poluído vence o documento) e sem empresa_omie —
    // para contas não-oben ele SOBRESCREVERIA (last-wins, 1 linha/user) a linha de um cliente
    // multi-conta com o código de OUTRA conta, corrompendo o espelho que readers legados ainda leem
    // (sync_pedidos sem filtro de conta, carteira-rebuild/ai-ops-agent via vendedor, hooks de UI). As
    // demais contas alimentam SÓ a proof-table document-first (account-correta) abaixo.
    const rows = Array.from(upsertByUser.values());
    let totalSynced = 0;
    if (account === "vendas") {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error: upErr } = await db.from("omie_clientes").upsert(chunk, { onConflict: "user_id" });
        if (upErr) throw new Error(`upsert omie_clientes: ${upErr.message}`);
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
async function fetchAllOmieClienteCodigos(db: SupabaseClient): Promise<Set<number>> {
  const set = new Set<number>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from("omie_clientes")
      .select("omie_codigo_cliente")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetch omie_clientes codigos: ${error.message}`);
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
    const codigosVinculados = await fetchAllOmieClienteCodigos(db);
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
  const nowIso = new Date().toISOString();

  try {
    // 1) COLETA todas as páginas do Omie em memória (dedupe last-wins por código).
    //    Antes: ~4 writes PostgREST POR produto (N+1) → ~3M statements e saturava o disk IO.
    //    Agora: acumula e escreve em LOTE (upsert chunked), o padrão que o resto deste arquivo já usa.
    const posicoes = new Map<number, { saldo: number; cmc: number; precoMedio: number }>();
    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
        nPagina: pagina,
        nRegPorPagina: 100,
        dDataPosicao: new Date().toLocaleDateString("pt-BR"),
      })) as unknown as OmieListarPosEstoqueResponse;

      totalPaginas = result.nTotPaginas || 1;
      const produtos = result.produtos || [];

      for (const prod of produtos) {
        const codProd = Number(prod.nCodProd); // normaliza: a API Omie pode devolver string; a chave do idMap é number
        if (!Number.isSafeInteger(codProd) || codProd <= 0) continue;
        posicoes.set(codProd, {
          saldo: prod.nSaldo ?? 0,
          cmc: prod.nCMC ?? 0,
          precoMedio: prod.nPrecoMedio ?? 0,
        });
      }

      console.log(`[Sync ${account}] Estoque página ${pagina}/${totalPaginas} (${produtos.length})`);
      pagina++;
    }

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
    const prodRows: Array<{ id: string | null; omie_codigo_produto: number | string | null }> = [];
    for (const chunk of chunked(codProds, 300)) {
      const { data, error } = await db
        .from("omie_products")
        .select("id, omie_codigo_produto")
        .eq("account", empresa)
        .in("omie_codigo_produto", chunk);
      if (error) {
        console.error(`[Sync ${account}] resolve product_id:`, error);
        continue;
      }
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
    for (const chunk of chunked(invRows, 500)) {
      const { error } = await db
        .from("inventory_position")
        .upsert(chunk, { onConflict: "omie_codigo_produto,account" });
      if (error) console.error(`[Sync ${account}] upsert inventory_position:`, error);
    }

    // 4) omie_products.estoque — upsert em LOTE pela PK id (só estoque+updated_at).
    //    Todos os ids vieram de linhas existentes → ON CONFLICT sempre faz UPDATE, nunca INSERT.
    const stockRows = codProds
      .map((cod) => ({ id: idByCod.get(cod), saldo: posicoes.get(cod)!.saldo }))
      .filter((x): x is { id: string; saldo: number } => !!x.id)
      .map((x) => ({ id: x.id, estoque: x.saldo, updated_at: nowIso }));
    for (const chunk of chunked(stockRows, 500)) {
      const { error } = await db.from("omie_products").upsert(chunk, { onConflict: "id" });
      if (error) console.error(`[Sync ${account}] upsert estoque omie_products:`, error);
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
        if (error) console.error(`[Sync ${account}] upsert cmc product_costs:`, error);
      }
      for (const chunk of chunked(aInserir, 500)) {
        const { error } = await db.from("product_costs").insert(chunk);
        if (error) console.error(`[Sync ${account}] insert product_costs:`, error);
      }
    }

    await updateSyncState(db, "inventory", account, {
      status: "complete",
      total_synced: totalSynced,
      last_sync_at: nowIso,
      last_page: totalPaginas,
    });
    return { totalSynced };
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

    // 2) Paginar ListarPosEstoque com cExibeTodos:"S" (callOmie já tem retry/backoff p/ falha transitória)
    let pagina = 1;
    let totalPaginas = 1;
    let totalSynced = 0;
    const invRows: Array<{
      omie_codigo_produto: number;
      product_id: string | null;
      saldo: number;
      cmc: number;
      preco_medio: number;
      account: string;
      synced_at: string;
    }> = [];
    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
        nPagina: pagina,
        nRegPorPagina: 100,
        dDataPosicao: new Date().toLocaleDateString("pt-BR"),
        cExibeTodos: "S",
      })) as unknown as OmieListarPosEstoqueResponse;

      totalPaginas = result.nTotPaginas || 1;
      const now = new Date().toISOString();
      for (const prod of result.produtos || []) {
        const codProd = Number(prod.nCodProd); // normaliza: a API Omie pode devolver string; a chave do idMap é number
        if (!Number.isSafeInteger(codProd) || codProd <= 0) continue;
        invRows.push({
          omie_codigo_produto: codProd,
          product_id: idMap.get(codProd) ?? null,
          saldo: prod.nSaldo ?? 0,
          cmc: prod.nCMC ?? 0,
          preco_medio: prod.nPrecoMedio ?? 0,
          account,
          synced_at: now,
        });
        totalSynced++;
      }
      console.log(`[Sync ${account}] inventory_full página ${pagina}/${totalPaginas} — ${totalSynced} itens acumulados`);
      pagina++;
    }

    // 3) Upsert em lote (chunks de 500) — onConflict igual ao syncInventory
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

// ======== BACKFILL DE CADASTRO — profiles dos clientes-fantasma da carteira ========
// Dá NOME (do Omie) aos clientes vinculados (omie_clientes) que têm auth.users mas não têm profile,
// fazendo /admin/customers mostrar a carteira inteira da vendedora. DESACOPLADO: só escreve profiles
// (não toca omie_clientes/carteira/scores). Insert-only. Spec:
// docs/superpowers/specs/2026-06-12-clientes-cadastro-backfill-design.md
// Os 3 helpers abaixo são ESPELHO VERBATIM de src/lib/clientes-cadastro/backfill-helpers.ts.

function cpfDvValido(cpf: string): boolean {
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += Number(cpf[i]) * (10 - i);
  let resto = soma % 11;
  const dv1 = resto < 2 ? 0 : 11 - resto;
  if (dv1 !== Number(cpf[9])) return false;
  soma = 0;
  for (let i = 0; i < 10; i++) soma += Number(cpf[i]) * (11 - i);
  resto = soma % 11;
  const dv2 = resto < 2 ? 0 : 11 - resto;
  return dv2 === Number(cpf[10]);
}

function cnpjDvValido(cnpj: string): boolean {
  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const p2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let soma = 0;
  for (let i = 0; i < 12; i++) soma += Number(cnpj[i]) * p1[i];
  let resto = soma % 11;
  const dv1 = resto < 2 ? 0 : 11 - resto;
  if (dv1 !== Number(cnpj[12])) return false;
  soma = 0;
  for (let i = 0; i < 13; i++) soma += Number(cnpj[i]) * p2[i];
  resto = soma % 11;
  const dv2 = resto < 2 ? 0 : 11 - resto;
  return dv2 === Number(cnpj[13]);
}

function normalizarDocumento(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  if (d.length !== 11 && d.length !== 14) return null;
  if (/^(\d)\1+$/.test(d)) return null;
  if (d.length === 11 && !cpfDvValido(d)) return null;
  if (d.length === 14 && !cnpjDvValido(d)) return null;
  return d;
}

function montarTelefone(ddd: string | null | undefined, numero: string | null | undefined): string | null {
  const full = ((ddd ?? "") + (numero ?? "")).replace(/\D/g, "");
  return full.length >= 8 ? full : null;
}

interface BackfillCadastro {
  razao_social?: string | null;
  nome_fantasia?: string | null;
  cnpj_cpf?: string | null;
  telefone_ddd?: string | null;
  telefone_numero?: string | null;
}
interface BackfillProfileRow {
  user_id: string; name: string; phone: string | null; document: string | null;
  customer_type: string | null; prospect_source: "omie_import";
  is_employee: false; is_approved: false; created_at: string;
}
type BackfillDecisao =
  | { acao: "inserir"; row: BackfillProfileRow }
  | { acao: "pular"; motivo: "master_cnpj" | "doc_em_outro_profile" | "doc_duplicado_no_lote" };

function decidirLinhaProfile(args: {
  userId: string; authCreatedAt: string; cadastro: BackfillCadastro;
  masterCnpj: string | null; docsExistentes: Set<string>; docsNoLote: Set<string>;
}): BackfillDecisao {
  const { userId, authCreatedAt, cadastro, masterCnpj, docsExistentes, docsNoLote } = args;
  const doc = normalizarDocumento(cadastro.cnpj_cpf);
  if (doc) {
    const masterNorm = (masterCnpj ?? "").replace(/\D/g, "");
    if (masterNorm && doc === masterNorm) return { acao: "pular", motivo: "master_cnpj" };
    if (docsExistentes.has(doc)) return { acao: "pular", motivo: "doc_em_outro_profile" };
    if (docsNoLote.has(doc)) return { acao: "pular", motivo: "doc_duplicado_no_lote" };
  }
  const nome = (cadastro.nome_fantasia?.trim() || cadastro.razao_social?.trim() || "").trim();
  const row: BackfillProfileRow = {
    user_id: userId, name: nome || "Cliente",
    phone: montarTelefone(cadastro.telefone_ddd, cadastro.telefone_numero),
    document: doc, customer_type: null, prospect_source: "omie_import",
    is_employee: false, is_approved: false, created_at: authCreatedAt,
  };
  return { acao: "inserir", row };
}

// Mapa codigo_cliente_omie → [{ userId, createdAt }] dos clientes SEM profile (carteira-fantasma).
// É LISTA, não last-wins: o mesmo código pode apontar p/ >1 user_id (vínculo bagunçado) → ambíguo,
// nunca sobrescreve silenciosamente. createdAt = omie_clientes.created_at (data REAL do vínculo, ~março)
// — preservar evita que o backfill marque os profiles como "criados hoje" e o visit-score os trate como
// prospecção recente.
async function fetchAlvosSemProfile(
  db: SupabaseClient,
): Promise<Map<number, { userId: string; createdAt: string }[]>> {
  const comProfile = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("profiles").select("user_id").range(from, from + 999);
    if (error) throw new Error(`fetch profiles user_id: ${error.message}`);
    const rows = (data ?? []) as { user_id: string }[];
    for (const r of rows) comProfile.add(r.user_id);
    if (rows.length < 1000) break;
  }
  const map = new Map<number, { userId: string; createdAt: string }[]>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("omie_clientes")
      .select("user_id, omie_codigo_cliente, created_at")
      .range(from, from + 999);
    if (error) throw new Error(`fetch omie_clientes: ${error.message}`);
    const rows = (data ?? []) as { user_id: string; omie_codigo_cliente: number | null; created_at: string }[];
    for (const r of rows) {
      if (r.omie_codigo_cliente == null || !r.user_id || comProfile.has(r.user_id)) continue;
      const codigo = Number(r.omie_codigo_cliente);
      const arr = map.get(codigo) ?? [];
      arr.push({ userId: r.user_id, createdAt: r.created_at });
      map.set(codigo, arr);
    }
    if (rows.length < 1000) break;
  }
  return map;
}

// Insere um chunk de profiles. ON CONFLICT(user_id) DO NOTHING cobre o profiles_user_id_key, MAS não o
// idx_profiles_document_unique (UNIQUE parcial em document) — um documento que colidiu entre o fetch e o
// insert (corrida/profile criado no meio) abortaria o chunk inteiro. Em erro, cai p/ linha-a-linha: conta
// inseridos, registra conflito de documento (23505) e segue; só erro inesperado aborta o run.
async function inserirProfilesComFallback(
  db: SupabaseClient,
  chunk: BackfillProfileRow[],
): Promise<{ inseridos: number; conflitosDocumento: number }> {
  const { data, error } = await db
    .from("profiles")
    .upsert(chunk, { onConflict: "user_id", ignoreDuplicates: true })
    .select("user_id");
  if (!error) return { inseridos: data?.length ?? 0, conflitosDocumento: 0 };
  let inseridos = 0, conflitosDocumento = 0;
  for (const row of chunk) {
    const { data: d, error: e } = await db
      .from("profiles")
      .upsert([row], { onConflict: "user_id", ignoreDuplicates: true })
      .select("user_id");
    if (e) {
      if (e.code === "23505") { conflitosDocumento++; continue; } // doc duplicado (índice parcial) — esperado
      throw new Error(`insert profile (linha-a-linha): ${e.message}`);
    }
    inseridos += d?.length ?? 0;
  }
  return { inseridos, conflitosDocumento };
}

// Backfill de cadastro Omie → profiles dos clientes-fantasma da carteira. Enumera as 3 contas Omie numa
// invocação (casa por código em TODAS) p/ NUNCA pegar cadastro da conta errada por last-wins; clientes
// ambíguos (mesmo código em >1 conta, ou >1 user_id no mesmo código) são PULADOS+reportados, nunca
// adivinhados. dryRun só conta. limite (canário) insere no máx N, ordenado por user_id (determinístico).
async function syncBackfillCadastro(db: SupabaseClient, dryRun: boolean, limite: number | null) {
  const startedAt = new Date().toISOString();
  await updateSyncState(db, "backfill_cadastro", "all", {
    status: "running", error_message: null,
    metadata: { dry_run: dryRun, limite, started_at: startedAt },
  });
  try {
    // master_cnpj FAIL-CLOSED: sem ele (erro de leitura OU ausente/inválido) o guard que impede promover
    // a master não funcionaria → abortar em vez de arriscar. Não confiar em null silencioso do maybeSingle.
    const { data: cfg, error: cfgErr } = await db
      .from("company_config").select("value").eq("key", "master_cnpj").maybeSingle();
    if (cfgErr) throw new Error(`master_cnpj read: ${cfgErr.message}`);
    const masterCnpj = ((cfg?.value as string | null) ?? "").replace(/^"|"$/g, "").replace(/\D/g, "");
    if (masterCnpj.length !== 11 && masterCnpj.length !== 14) {
      throw new Error("master_cnpj ausente/inválido em company_config — backfill abortado (fail-closed: evita promover cliente a master)");
    }

    const alvosPorCodigo = await fetchAlvosSemProfile(db);
    const docsExistentes = await fetchAllProfileDocs(db);

    // userId → { codigo, createdAt } (omie_clientes é UNIQUE(user_id) → 1 código por user); e códigos com
    // >1 user_id = ambíguos (não dá p/ saber qual auth.user é qual cliente).
    const alvoPorUser = new Map<string, { codigo: number; createdAt: string }>();
    const codigosAmbiguos = new Set<number>();
    for (const [codigo, lista] of alvosPorCodigo) {
      if (lista.length > 1) codigosAmbiguos.add(codigo);
      for (const a of lista) alvoPorUser.set(a.userId, { codigo, createdAt: a.createdAt });
    }
    const alvosTotal = alvoPorUser.size;

    // Enumera as contas COM credencial → candidatos POR user (1 por conta onde o código existe).
    const candidatosPorUser = new Map<string, { account: OmieAccount; cadastro: BackfillCadastro }[]>();
    const contasProcessadas: OmieAccount[] = [];
    const contasSemCredencial: OmieAccount[] = [];
    let totalOmie = 0;
    for (const account of ["vendas", "colacor_vendas", "servicos"] as OmieAccount[]) {
      const creds = getCredentials(account);
      if (!creds.key || !creds.secret) { contasSemCredencial.push(account); continue; }
      contasProcessadas.push(account);
      let pagina = 1, totalPaginas = 1;
      while (pagina <= totalPaginas) {
        const result = (await callOmie(account, "geral/clientes/", "ListarClientes", {
          pagina, registros_por_pagina: 100, apenas_importado_api: "N",
        })) as unknown as OmieListarClientesResponse;
        totalPaginas = result.total_de_paginas || 1;
        for (const c of result.clientes_cadastro || []) {
          totalOmie++;
          if (c.codigo_cliente_omie == null) continue;
          const alvos = alvosPorCodigo.get(Number(c.codigo_cliente_omie));
          if (!alvos) continue;
          const raw = c as unknown as { telefone1_ddd?: string | null; telefone1_numero?: string | null };
          const cadastro: BackfillCadastro = {
            razao_social: c.razao_social ?? null,
            nome_fantasia: c.nome_fantasia ?? null,
            cnpj_cpf: c.cnpj_cpf ?? null,
            telefone_ddd: raw.telefone1_ddd ?? null,
            telefone_numero: raw.telefone1_numero ?? null,
          };
          for (const a of alvos) {
            const arr = candidatosPorUser.get(a.userId) ?? [];
            arr.push({ account, cadastro });
            candidatosPorUser.set(a.userId, arr);
          }
        }
        pagina++;
      }
      console.log(`[BackfillCadastro] ${account}: ${totalPaginas} páginas`);
    }

    // Decide por user (ordem determinística). Ambíguo = candidatos de >1 conta OU código com >1 user_id.
    const docsNoLote = new Set<string>();
    const rows: BackfillProfileRow[] = [];
    const pulados = { master_cnpj: 0, doc_em_outro_profile: 0, doc_duplicado_no_lote: 0 };
    let semMatch = 0, ambiguos = 0, comMatch = 0;
    for (const userId of [...alvoPorUser.keys()].sort()) {
      const info = alvoPorUser.get(userId)!;
      const cands = candidatosPorUser.get(userId) ?? [];
      if (cands.length === 0) { semMatch++; continue; }
      comMatch++;
      const contasDistintas = new Set(cands.map((c) => c.account));
      if (contasDistintas.size > 1 || codigosAmbiguos.has(info.codigo)) { ambiguos++; continue; }
      const d = decidirLinhaProfile({
        userId, authCreatedAt: info.createdAt, cadastro: cands[0].cadastro,
        masterCnpj, docsExistentes, docsNoLote,
      });
      if (d.acao === "pular") { pulados[d.motivo]++; continue; }
      rows.push(d.row);
      if (d.row.document) docsNoLote.add(d.row.document);
    }

    // Ordena por user_id (determinismo do canário) e aplica o limite.
    rows.sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
    const rowsAlvo = limite && limite > 0 ? rows.slice(0, limite) : rows;

    let inseridos = 0, conflitosDocumento = 0;
    if (!dryRun) {
      for (let i = 0; i < rowsAlvo.length; i += 500) {
        const r = await inserirProfilesComFallback(db, rowsAlvo.slice(i, i + 500));
        inseridos += r.inseridos;
        conflitosDocumento += r.conflitosDocumento;
      }
    }

    // created_at recente (< 35d) sinaliza vínculo novo (relink) — improvável no lote de março; se aparecer
    // é alerta p/ revisar antes de confiar no created_at preservado.
    const limiteRecente = Date.now() - 35 * 24 * 60 * 60 * 1000;
    const createdAtRecente = rows.filter((r) => new Date(r.created_at).getTime() > limiteRecente).length;

    const relatorio = {
      dry_run: dryRun, limite,
      contas_processadas: contasProcessadas, contas_sem_credencial: contasSemCredencial,
      alvos_total: alvosTotal, total_omie: totalOmie, com_match: comMatch, sem_match: semMatch,
      ambiguos, inseriveis: rows.length, seriam_inseridos: rowsAlvo.length, inseridos,
      conflitos_documento: conflitosDocumento, pulados, created_at_recente: createdAtRecente,
      amostra: rowsAlvo.slice(0, 5).map((r) => ({ user_id: r.user_id, document: r.document, name: r.name })),
      finished_at: new Date().toISOString(),
    };
    await updateSyncState(db, "backfill_cadastro", "all", {
      status: "complete", total_synced: inseridos, metadata: relatorio,
    });
    console.log(`[BackfillCadastro] ${JSON.stringify(relatorio)}`);
    return relatorio;
  } catch (error) {
    await updateSyncState(db, "backfill_cadastro", "all", { status: "error", error_message: String(error) });
    throw error;
  }
}

// ======== MAPA DE CONSOLIDAÇÃO — popula customer_canonical_alias (clone → gêmeo) ========
// Fase 1 da consolidação (estratégia "B-lite", spec 2026-06-13). Casa cada clone (omie_clientes SEM
// profile) ao gêmeo (profile com o mesmo CNPJ) e grava o apelido com status='inactive' (INERTE: só o
// carteira-rebuild da Fase 2 lê aliases ATIVOS; até ativar, NÃO afeta carteira/tela). Captura a conta
// Omie de cada código (clone X e gêmeo Y) p/ revelar mesma-conta (duplicata real) vs cross-account
// (mesmo CNPJ em empresas diferentes — NÃO é duplicata). NÃO toca omie_clientes/carteira/scores.

interface AliasRow {
  alias_user_id: string;
  canonical_user_id: string;
  documento: string | null;
  alias_omie_codigo: number | null;
  alias_conta: string | null;
  canonical_omie_codigo: number | null;
  canonical_conta: string | null;
  status: "inactive" | "conflict";
  reason: string | null;
  batch_id: string;
}

// Map<doc_normalizado, {userId, name}> de profiles (resolve o gêmeo por documento; 1º vence).
async function fetchProfileDocNameMap(
  db: SupabaseClient,
): Promise<Map<string, { userId: string; name: string | null }>> {
  const map = new Map<string, { userId: string; name: string | null }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("profiles").select("user_id, name, document").not("document", "is", null).range(from, from + 999);
    if (error) throw new Error(`fetch profiles doc/name: ${error.message}`);
    const rows = (data ?? []) as { user_id: string; name: string | null; document: string | null }[];
    for (const r of rows) {
      const d = (r.document ?? "").replace(/\D/g, "");
      if (d && r.user_id && !map.has(d)) map.set(d, { userId: r.user_id, name: r.name });
    }
    if (rows.length < 1000) break;
  }
  return map;
}

// Map<user_id, omie_codigo_cliente> (p/ achar o código Y do gêmeo).
async function fetchOmieCodigoPorUser(db: SupabaseClient): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("omie_clientes").select("user_id, omie_codigo_cliente").range(from, from + 999);
    if (error) throw new Error(`fetch omie_clientes codigo: ${error.message}`);
    const rows = (data ?? []) as { user_id: string; omie_codigo_cliente: number | null }[];
    for (const r of rows) if (r.user_id && r.omie_codigo_cliente != null) map.set(r.user_id, Number(r.omie_codigo_cliente));
    if (rows.length < 1000) break;
  }
  return map;
}

async function mapaConsolidacao(db: SupabaseClient, dryRun: boolean, batchId: string) {
  const startedAt = new Date().toISOString();
  await updateSyncState(db, "mapa_consolidacao", "all", {
    status: "running", error_message: null, metadata: { dry_run: dryRun, batch_id: batchId, started_at: startedAt },
  });
  try {
    // 1. clones (omie sem profile): user → código (omie_clientes é UNIQUE(user_id) → 1 código/user);
    //    código com >1 user (ambíguo) fica de fora — não dá p/ apelidar com segurança.
    const alvosPorCodigo = await fetchAlvosSemProfile(db);
    const codigoPorCloneUser = new Map<string, number>();
    let ambiguos = 0;
    for (const [codigo, lista] of alvosPorCodigo) {
      if (lista.length > 1) { ambiguos += lista.length; continue; }
      codigoPorCloneUser.set(lista[0].userId, codigo);
    }
    const codigosClone = new Set(codigoPorCloneUser.values());

    // 2. gêmeo por documento + código Y do gêmeo.
    const gemeoPorDoc = await fetchProfileDocNameMap(db);
    const codigoPorUser = await fetchOmieCodigoPorUser(db);

    // 3. enumera as 3 contas: doc por código (só clones) + conta por código (todos, p/ achar a conta de Y).
    const docPorCodigo = new Map<number, string | null>();
    const contaPorCodigo = new Map<number, string>();
    const codigoMultiConta = new Set<number>();
    const contasProcessadas: OmieAccount[] = [];
    const contasSemCredencial: OmieAccount[] = [];
    for (const account of ["vendas", "colacor_vendas", "servicos"] as OmieAccount[]) {
      const creds = getCredentials(account);
      if (!creds.key || !creds.secret) { contasSemCredencial.push(account); continue; }
      contasProcessadas.push(account);
      let pagina = 1, totalPaginas = 1;
      while (pagina <= totalPaginas) {
        const result = (await callOmie(account, "geral/clientes/", "ListarClientes", {
          pagina, registros_por_pagina: 100, apenas_importado_api: "N",
        })) as unknown as OmieListarClientesResponse;
        totalPaginas = result.total_de_paginas || 1;
        for (const c of result.clientes_cadastro || []) {
          if (c.codigo_cliente_omie == null) continue;
          const codigo = Number(c.codigo_cliente_omie);
          const prev = contaPorCodigo.get(codigo);
          if (prev && prev !== account) codigoMultiConta.add(codigo);
          contaPorCodigo.set(codigo, account);
          if (codigosClone.has(codigo)) docPorCodigo.set(codigo, normalizarDocumento(c.cnpj_cpf ?? null));
        }
        pagina++;
      }
      console.log(`[MapaConsolidacao] ${account}: ${totalPaginas} páginas`);
    }

    // 4. monta os apelidos (clone → gêmeo) + classifica mesma-conta vs cross-account.
    const aliases: AliasRow[] = [];
    const stats = { mesma_conta: 0, cross_account: 0, conta_indefinida: 0, sem_gemeo: 0, conta_multipla: 0 };
    for (const [cloneUserId, codigoX] of codigoPorCloneUser) {
      const doc = docPorCodigo.get(codigoX) ?? null;
      const gemeo = doc ? gemeoPorDoc.get(doc) : undefined;
      if (!gemeo) { stats.sem_gemeo++; continue; }
      const codigoY = codigoPorUser.get(gemeo.userId) ?? null;
      const contaX = contaPorCodigo.get(codigoX) ?? null;
      const contaY = codigoY != null ? (contaPorCodigo.get(codigoY) ?? null) : null;
      if (codigoMultiConta.has(codigoX) || (codigoY != null && codigoMultiConta.has(codigoY))) stats.conta_multipla++;
      if (contaY == null) stats.conta_indefinida++;
      else if (contaX === contaY) stats.mesma_conta++;
      else stats.cross_account++;
      aliases.push({
        alias_user_id: cloneUserId, canonical_user_id: gemeo.userId, documento: doc,
        alias_omie_codigo: codigoX, alias_conta: contaX,
        canonical_omie_codigo: codigoY, canonical_conta: contaY,
        status: "inactive", reason: null, batch_id: batchId,
      });
    }

    // 5. persiste com status='inactive' (inerte). Upsert por alias_user_id (idempotente).
    let gravados = 0;
    if (!dryRun) {
      for (let i = 0; i < aliases.length; i += 500) {
        const chunk = aliases.slice(i, i + 500);
        const { error } = await db.from("customer_canonical_alias").upsert(chunk, { onConflict: "alias_user_id" });
        if (error) throw new Error(`upsert customer_canonical_alias: ${error.message}`);
        gravados += chunk.length;
      }
    }

    const relatorio = {
      dry_run: dryRun, batch_id: batchId,
      contas_processadas: contasProcessadas, contas_sem_credencial: contasSemCredencial,
      clones_total: codigoPorCloneUser.size, ambiguos, aliases: aliases.length, gravados,
      mesma_conta: stats.mesma_conta, cross_account: stats.cross_account,
      conta_indefinida: stats.conta_indefinida, conta_multipla: stats.conta_multipla, sem_gemeo: stats.sem_gemeo,
      amostra: aliases.slice(0, 10).map((a) => ({
        alias: a.alias_user_id, canonical: a.canonical_user_id, doc: a.documento,
        contaX: a.alias_conta, contaY: a.canonical_conta,
      })),
      finished_at: new Date().toISOString(),
    };
    await updateSyncState(db, "mapa_consolidacao", "all", { status: "complete", total_synced: gravados, metadata: relatorio });
    console.log(`[MapaConsolidacao] ${JSON.stringify(relatorio)}`);
    return relatorio;
  } catch (error) {
    await updateSyncState(db, "mapa_consolidacao", "all", { status: "error", error_message: String(error) });
    throw error;
  }
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

    const { action, account = "vendas", start_page, max_pages, dry_run, limite, batch_id } = await req.json();
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
        result = await computeCosts(supabaseAdmin);
        break;
      case "compute_association_rules":
        result = await computeAssociationRules(supabaseAdmin);
        break;
      case "sync_all": {
        // customers SAIU do sync_all: agora tem cron dedicado (sync-customers-vendas-daily) que chama
        // a action sync_customers em BACKGROUND. Rodar customers síncrono aqui dava WORKER_RESOURCE_LIMIT
        // e RE-prendia sync_state.customers em 'running' a cada passada — clobberava o estado curado.
        const acct = account as OmieAccount;
        const products = await syncProducts(supabaseAdmin, acct);
        // orders REMOVIDO do sync_all (2026-06-24): syncOrdersIncremental foi aposentado (no-op que
        // poluía sales_price_history). A fonte de pedidos é a RPC criar_pedidos_com_itens (omie-vendas-sync).
        const inventory = await syncInventory(supabaseAdmin, acct);
        const costs = await computeCosts(supabaseAdmin);
        const assocRules = await computeAssociationRules(supabaseAdmin);
        result = { products, inventory, costs, assocRules };
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
      case "start_backfill_cadastro": {
        // Backfill de cadastro Omie → profiles (clientes-fantasma da carteira). Enumera as 3 contas numa
        // invocação (não recebe `account`). dry_run default TRUE: só conta/relata (em sync_state.metadata),
        // nunca escreve sem pedir. `limite` (canário): insere no máximo N, ordenado por user_id.
        const dryRun = dry_run !== false;
        const limiteNum =
          typeof limite === "number" && Number.isFinite(limite) && limite > 0 ? Math.floor(limite) : null;
        // Gate master/gestor server-side (mesmo do start_nao_vinculados; cron/service_role passam).
        if (auth.via === "staff") {
          const { data: pode } = await supabaseAdmin.rpc("pode_ver_carteira_completa", { _uid: auth.userId });
          if (!pode) {
            return new Response(JSON.stringify({ error: "Forbidden: requer master ou gestor comercial" }), {
              status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
        // Guard "já em andamento" (não duplicar trabalho). Estado único (account="all").
        const stBf = await getSyncState(supabaseAdmin, "backfill_cadastro", "all");
        const runningBf = stBf?.status === "running" && stBf?.updated_at &&
          (Date.now() - new Date(stBf.updated_at as string).getTime() < 15 * 60 * 1000);
        if (runningBf) {
          return new Response(JSON.stringify({ accepted: false, already_running: true }), {
            status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const bgTask = syncBackfillCadastro(supabaseAdmin, dryRun, limiteNum).catch((e) => {
          console.error("[backfill_cadastro][bg]", e instanceof Error ? e.message : e);
        });
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - EdgeRuntime existe no runtime do Supabase Edge
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          EdgeRuntime.waitUntil(bgTask);
        }
        return new Response(JSON.stringify({ accepted: true, dry_run: dryRun, limite: limiteNum }), {
          status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      case "mapa_consolidacao": {
        // Fase 1 da consolidação (B-lite). Casa clone→gêmeo, popula customer_canonical_alias com
        // status='inactive' (INERTE até o canário). dry_run=true só conta (não grava). Reporta
        // mesma-conta vs cross-account. Gate master/gestor; background.
        const dryRun = dry_run === true; // padrão: GRAVA (alias inativo é inerte); dry_run=true só conta.
        const batchId = typeof batch_id === "string" && batch_id.trim() ? batch_id.trim() : "mapa-inicial";
        if (auth.via === "staff") {
          const { data: pode } = await supabaseAdmin.rpc("pode_ver_carteira_completa", { _uid: auth.userId });
          if (!pode) {
            return new Response(JSON.stringify({ error: "Forbidden: requer master ou gestor comercial" }), {
              status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
        const stMapa = await getSyncState(supabaseAdmin, "mapa_consolidacao", "all");
        const runningMapa = stMapa?.status === "running" && stMapa?.updated_at &&
          (Date.now() - new Date(stMapa.updated_at as string).getTime() < 15 * 60 * 1000);
        if (runningMapa) {
          return new Response(JSON.stringify({ accepted: false, already_running: true }), {
            status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const bgTask = mapaConsolidacao(supabaseAdmin, dryRun, batchId).catch((e) => {
          console.error("[mapa_consolidacao][bg]", e instanceof Error ? e.message : e);
        });
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - EdgeRuntime existe no runtime do Supabase Edge
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          EdgeRuntime.waitUntil(bgTask);
        }
        return new Response(JSON.stringify({ accepted: true, dry_run: dryRun, batch_id: batchId }), {
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
