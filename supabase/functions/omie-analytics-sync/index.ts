import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { comRegistro, type DbRegistro } from "../_shared/registro-execucao.ts";
import { fetchAll } from "../_shared/paginate.ts";
import { STATUS_NAO_VENDA_POSTGREST } from "../_shared/universo-pedidos.ts";
import { agruparCestasPorSegmento, calcularRegrasDoSegmento, type RegraAssoc } from "../_shared/apriori.ts";
import { montarUpsertsDeCusto } from "../_shared/cost-compute.ts";
import { recomporCustoProducao } from "../_shared/recompor-custo-producao.ts";
import { buildProductIdMap, montarCatalogoPorCod } from "../_shared/product-idmap.ts";
import { avaliarPagina, MAX_PAGINAS_LISTAGEM, MAX_PAGINAS_POS_ESTOQUE, proximoTotalPaginas } from "../_shared/omie-paginacao.ts";
import { acumularPosicoesDaPagina, type PosicaoEstoque } from "../_shared/pos-estoque.ts";
import {
  decidirRetentativaOmie,
  MAX_TENTATIVAS_OMIE,
  mensagemCorpoNaoJson,
  mensagemFalhaOmie,
} from "./politica-retry.ts";

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
  // (credencial/validação) falha rápido. Backoff: 0.8s, 1.6s, 3.2s (`atrasoRetentativaMs`).
  //
  // ⚠️ A classificação é do helper canônico `_shared/omie-falha.ts`, NÃO ad-hoc aqui. A versão
  // anterior casava os códigos HTTP CRUS (`msg.includes("503")`) e tinha os dois defeitos que o
  // helper já fechou: (a) o dígito casa DENTRO do identificador que a própria mensagem ecoa — a
  // app_key de `"Chave de acesso não cadastrada para o aplicativo [1503123456]"` e o idProduto do
  // `ConsultarEstrutura` contêm 503, então o erro PERMANENTE mais comum comprava as 4 tentativas
  // (money-path §"O MARCADOR mente", #1614); (b) a enumeração à mão de 5xx deixava 501/505/520 —
  // gateway/CDN — abortar sem backoff nenhum (#1623).
  //
  // ⚠️ A POLÍTICA (o que retenta, quanto dorme, o que é redigido) vive em `./politica-retry.ts`,
  // que é puro e importável pelo teste — este arquivo não é (traz `deno.land` e `npm:`, e a suíte
  // roda com `--no-remote`). A 1ª versão desta entrega deixava a política aqui e a "provava" com
  // gates que liam o fonte atrás de tokens; o challenge do Codex passou pelos três com mutações
  // triviais. Decisão de money-path não se prova por token: mora onde o teste a EXECUTA.
  const maxAttempts = MAX_TENTATIVAS_OMIE;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${OMIE_API_URL}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // ⚠️ O parse vem ANTES do guard de status (a faultstring é mais acionável que o código), e
      // é por isso que ele precisa do próprio catch: um 5xx de gateway com corpo de TEXTO estoura
      // aqui e nunca chega ao `!res.ok`. A mensagem do parser ecoa o corpo ("Unexpected token
      // 'E', \"ERROR 503\" is not valid JSON") — o classificador antigo via o `503` solto ali e
      // retentava; sem este ramo, a forma ancorada não veria nada e o 503 de gateway falharia na
      // 1ª tentativa. Regressão de transporte achada pelo challenge do Codex.
      let result: OmieApiResponseBase;
      try {
        result = (await res.json()) as OmieApiResponseBase;
      } catch (erroJson) {
        throw new Error(mensagemCorpoNaoJson(account, res.status, erroJson));
      }
      // `faultstring` ANTES do status. ⚠️ Aqui a ordem NÃO preserva EOF nenhum — este wrapper
      // lança em TODA faultstring, inclusive na de fim de página, e isso é comportamento
      // preexistente que este PR não muda (achado Codex xhigh, contra a 1ª redação deste
      // comentário, que prometia preservar o fim real). O que a ordem preserva é a MENSAGEM: é
      // ela que o catch abaixo classifica para decidir entre retentar e falhar, e um `HTTP 503`
      // genérico apagaria a faultstring específica que torna o motivo acionável.
      // `mensagemFalhaOmie` REDIGE o texto do Omie: esta faultstring ECOA a credencial, e daqui
      // ela ia crua para três sinks (o `sync_state.error_message` persistido, o console e o corpo
      // da resposta 500). O porquê e o que se preserva estão em `politica-retry.ts`.
      if (result.faultstring) throw new Error(mensagemFalhaOmie(account, String(result.faultstring)));
      // Sem faultstring, só um 2xx é resposta. `fetch` NÃO lança em HTTP não-2xx: um 429/5xx cujo
      // corpo parseia sem fault (o `{}` de proxy/gateway) voltava como resposta boa e chegava aos
      // laços de enumeração sem `total_de_paginas` e sem lista — o piso degrada para 1 e a página
      // vazia vira fim da fonte, com todos os guards de paginação corretos e nenhum consultado.
      // Emitido como `HTTP <n>` — a forma ANCORADA que `classificarFaultstring` reconhece, para
      // reusar o backoff do catch em vez de virar falha diária. Todo 5xx (não só 500/502/503/504)
      // e o 429 casam o padrão; a âncora é o que impede o dígito de casar dentro de um id ecoado.
      if (!res.ok) throw new Error(mensagemFalhaOmie(account, `HTTP ${res.status}`, "runtime"));
      // `faultcode` sem `faultstring` fecha a ordem canônica: um `200 {"faultcode":"5113"}` chegava
      // aos laços como página boa e vazia, e o sync publicava `status:"complete"` sobre um retrato
      // parcial — a fabricação de completude que o G6 existe para barrar, uma casa adiante.
      if (result.faultcode) throw new Error(mensagemFalhaOmie(account, `faultcode ${result.faultcode}`));
      return result;
    } catch (e) {
      const erro = e instanceof Error ? e : new Error(String(e));
      lastErr = erro;
      const decisao = decidirRetentativaOmie(erro.message, attempt, maxAttempts);
      if (decisao.retentar) {
        await new Promise((r) => setTimeout(r, decisao.atrasoMs));
        continue;
      }
      throw erro;
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

// Map<omie_codigo_cliente, user_id> — quem JÁ está vinculado, resolvido por CÓDIGO, DENTRO da conta.
//
// [P0-B-bis Fatia 5] Esta era a ÚLTIMA leitura de `omie_clientes` em edge alguma, e o `DROP TABLE`
// a quebraria.
//
// ⚠️ PARA QUE ESTE MAPA SERVE, depois do hotfix Codex-C (#1444): **só para chavear as TAGS** do
// cadastro Omie (`is_fornecedor` / `excluir_da_carteira`). Ele NÃO alimenta o ledger nem a proof —
// o #1444 passou os dois para a lista DOCUMENT-first (`accountMapByUser`), justamente porque
// resolver por código a partir do espelho sem conta podia escolher o user errado numa admissão nova.
//
// ⚠️ E as tags são `vendas`-ONLY (`tagRows = account === "vendas" ? … : []`), assim como o ledger.
// Em `servicos` e `colacor_vendas` este mapa alimenta só `upsertByUser`, que NINGUÉM lê — ou seja,
// fora de `vendas` ele é INERTE. Foi exatamente por isso que a união com `customer_canonical_alias`
// pôde congelar o sync de `servicos` por 37 dias sem deixar um único número ERRADO no banco: o dano
// foi de AUSÊNCIA (proof e frescor parados), não de valor adulterado. A fonte alias saiu em
// 2026-08-25; a medição que prova o no-op está no bloco dentro da função.
//
// ⚠️ O MAPA É POR CONTA, não global — corrigido após `/codex challenge` xhigh, que refutou a 1ª
// versão (Map global) e a refutação foi VERIFICADA por medição. `omie_codigo_cliente` é único
// DENTRO de uma conta; a constraint `UNIQUE(codigo, account)` NÃO o torna globalmente único. Num Map
// global, o último `map.set` vence em silêncio e um código do run oben podia resolver o user de
// colacor — que então receberia as tags Omie de OUTRO cliente, inclusive `excluir_da_carteira`.
// Colisão hoje é zero, mas isso é coincidência de DADO, não invariante de schema.
async function fetchCodigoUserMap(
  db: SupabaseClient,
  account: OmieAccount,
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const empresa = accountToEmpresa(account); // vendas->oben · servicos->colacor_sc · colacor_vendas->colacor

  // Guard de colisão: dentro de UMA conta o código é único, então dois users para o mesmo código é
  // corrupção de dado — e resolver "o último que chegou" anexaria cliente ao vendedor errado.
  // Fail-closed (precisão > recall): aborta o run em vez de gravar identidade adivinhada.
  const setOuFalha = (fonte: string, cod: number, uid: string) => {
    const anterior = map.get(cod);
    if (anterior && anterior !== uid) {
      throw new Error(
        `colisão de código na conta ${empresa}: omie_codigo_cliente=${cod} aponta para ` +
          `${anterior} e ${uid} (fonte: ${fonte}). Duas identidades para o mesmo código dentro da ` +
          `MESMA conta é corrupção — abortando antes de admitir o user errado no ledger.`,
      );
    }
    map.set(cod, uid);
  };

  // As duas leituras delegam a `fetchAll` (_shared/paginate.ts): o laço à mão daqui tinha o furo
  // da classe (money-path §9) — `data ?? []` convertia resposta malformada (data:null SEM error)
  // em página vazia → EOF falso → o mapa saía PARCIAL, isto é, membro a menos no ledger. O select
  // fica LITERAL no callback (o supabase-js infere o tipo da linha a partir dele; string dinâmica
  // vira `ParserError` no deno check).
  //
  // `.order` estável é obrigatório com `.range()` (§CLAUDE.md): sem ele a paginação corre sobre
  // ordem indefinida e uma linha pode repetir ou SUMIR entre páginas. Desempate por user: ordenar
  // só pelo código deixa a paginação INSTÁVEL se o código repetir.

  // FONTE ÚNICA: a proof account-correta DA CONTA DO RUN.
  //
  // Até 2026-08-25 este mapa lia TAMBÉM `customer_canonical_alias` (os aliases fiscais / clones
  // `@placeholder.local`, sem `profiles`) — e a UNIÃO das duas fontes congelou o sync de `servicos`
  // por 37 dias. As duas guardam, POR DESENHO, duas identidades da MESMA entidade comercial (o clone
  // e o canônico), então `setOuFalha` via 1633 "colisões" e abortava o run todo dia
  // (`sync_state.status='error'`, 2026-07-19 → 2026-08-24). Em 1633/1633 o user da proof era
  // exatamente o `canonical_user_id` do alias: falso-positivo de 100%.
  //
  // Ler só a proof é NO-OP DE COMPORTAMENTO, não escolha de preferência — cada passo medido:
  //   • o alias só acrescentava CONFLITO: os 1633 códigos de alias JÁ estavam todos na proof
  //     (0 códigos exclusivos do alias) ⇒ o mapa resultante é idêntico;
  //   • aliases ativos existem SÓ com `alias_conta='servicos'` (0 em vendas / colacor_vendas) — e é
  //     justamente em `servicos` que este mapa não tem consumidor: tags são `vendas`-only
  //     (`tagRows = account === "vendas" ? … : []`) e o ledger também. `upsertByUser`, o único outro
  //     destino, não é lido por ninguém;
  //   • a proof (`accountMapByUser`) é montada por DOCUMENTO, não por este mapa, e o `continue` logo
  //     após a resolução não a altera: sem match por documento não nasce linha de proof de todo jeito.
  // ⇒ o argumento antigo — "sem o alias os clones ficariam SEM tag no run servicos" — era FALSO: o run
  // `servicos` não grava tag nenhuma. Não o ressuscite.
  //
  // A validação alias×proof continua desejável, mas como DATA-HEALTH separado: ela não pode derrubar
  // um sync cujo resultado não depende de alias (parecer Codex gpt-5.6-sol xhigh, 2026-08-25).
  //
  // `setOuFalha` PERMANECE: hoje `UNIQUE(omie_codigo_cliente, account)` torna a colisão impossível
  // dentro de uma conta, mas isso é invariante de SCHEMA da proof — se a fonte mudar, o guard é a
  // única coisa entre um código ambíguo e o user errado no ledger.
  const proofRows = await fetchAll<{ omie_codigo_cliente: number | null; user_id: string | null }>(
    (from, to) =>
      db
        .from("omie_customer_account_map")
        .select("omie_codigo_cliente, user_id")
        .eq("account", empresa)
        .not("omie_codigo_cliente", "is", null)
        .order("omie_codigo_cliente")
        .order("user_id")
        .range(from, to),
    `fetch omie_customer_account_map map (${empresa})`,
  );
  for (const r of proofRows) {
    if (r.omie_codigo_cliente != null && r.user_id) {
      setOuFalha("proof", Number(r.omie_codigo_cliente), r.user_id);
    }
  }

  console.log(
    `[Sync ${account}] mapa código→user (conta ${empresa}): ${map.size} códigos (fonte: proof)`,
  );
  return map;
}

// MIRROR-START omie identity-snapshot-parse — espelhado verbatim nos edges omie-vendas-sync e omie-analytics-sync
// Valida o CONTRATO JSON da RPC omie_sync_identity_snapshot e constrói os mapas. FAIL-CLOSED (Codex
// challenge PR-1): supabase-js .rpc() resolve {error} — error=null só prova HTTP/SQL bem-sucedido, NÃO o
// contrato. Uma RPC revertida/malformada pode devolver HTTP 200 com {doc_to_user:null,...}; o `?? {}` a
// degradaria para Map(0) SILENCIOSO (vendas pula pedidos, analytics não vincula) sem SQLSTATE. Aqui shape
// inválido (null/array/tipo errado/valor não-UUID/doc ambíguo vazado em doc_to_user) LANÇA — precisão>recall.
const OMIE_SNAPSHOT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PR-2/A2: código Omie decimal puro. NÃO usar só `Number()`: ele aceita '0x10' (16), '1e3' (1000),
// ' 12 ' e '' (0) — cada um vira um código de cliente FABRICADO no cache do sync, que é a família
// `Number(null)===0` aplicada a uma CHAVE de identidade. Só dígitos, sem zero à esquerda.
const OMIE_SNAPSHOT_CODIGO_RE = /^[1-9][0-9]*$/;

function parseIdentitySnapshot(
  snap: unknown,
): {
  docToUserMap: Map<string, string>;
  ambiguousDocs: Set<string>;
  clientToUser: Map<number, string>;
  revokedClientCodes: Set<number>;
} {
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
  // PR-2/A2 — PROVA POSITIVA código Omie → user, por conta. Vazio é o estado ESPERADO enquanto o
  // omie-analytics-sync não repovoar `evidence_document_normalized` (o backfill é NULL, fail-closed):
  // o leitor degrada para o comportamento de hoje. Ausente/não-objeto, porém, é contrato QUEBRADO —
  // uma RPC anterior ao PR-1 não tem a chave, e aí `{}` silencioso seria indistinguível de "sem prova".
  const c2u = s.client_to_user;
  if (!c2u || typeof c2u !== "object" || Array.isArray(c2u)) {
    throw new Error("identity snapshot: client_to_user ausente ou não-objeto (fail-closed)");
  }
  // A prova v1 é só `source='document'`, e ela exige um doc ÚNICO apontando para o MESMO user do
  // vínculo — logo TODO user provado está, por construção, no contradomínio de doc_to_user. Um user
  // fora dele significa que a RPC no ar não é a deste contrato (revertida, ou já com manual/code):
  // fail-closed em vez de confiar num vínculo cuja regra não conhecemos.
  const usuariosComDocUnico = new Set(docToUserMap.values());
  const clientToUser = new Map<number, string>();
  for (const [codigo, user] of Object.entries(c2u)) {
    if (typeof user !== "string" || !OMIE_SNAPSHOT_UUID_RE.test(user)) {
      throw new Error("identity snapshot: user_id não-UUID em client_to_user (fail-closed)");
    }
    if (!OMIE_SNAPSHOT_CODIGO_RE.test(codigo) || !Number.isSafeInteger(Number(codigo))) {
      throw new Error("identity snapshot: código de cliente inválido em client_to_user (fail-closed)");
    }
    if (!usuariosComDocUnico.has(user)) {
      throw new Error("identity snapshot: user de client_to_user fora de doc_to_user — RPC divergente do contrato v1 (fail-closed)");
    }
    clientToUser.set(Number(codigo), user);
  }
  // PR-2/A2 — REVOGAÇÃO. Sem ela a prova só OMITE, e omitir não corrige nada: o código obsoleto
  // continua no cache do leitor. Aqui vêm os códigos cuja evidência EXISTE mas deixou de sustentar o
  // vínculo (doc migrou de dono, virou ambíguo, ou o profile sumiu) — o leitor os REMOVE do cache e
  // refaz pela API. Ausente/não-array é contrato QUEBRADO: `[]` silencioso reabriria o fail-open.
  const rev = s.revoked_client_codes;
  if (!Array.isArray(rev)) {
    throw new Error("identity snapshot: revoked_client_codes ausente ou não-array (fail-closed)");
  }
  const revokedClientCodes = new Set<number>();
  for (const codigo of rev) {
    if (typeof codigo !== "string" || !OMIE_SNAPSHOT_CODIGO_RE.test(codigo) || !Number.isSafeInteger(Number(codigo))) {
      throw new Error("identity snapshot: código de cliente inválido em revoked_client_codes (fail-closed)");
    }
    const cod = Number(codigo);
    // disjunção: um código não pode ser provado E revogado (seria fail-open da RPC). A UNIQUE
    // (omie_codigo_cliente, account) garante 1 linha por código/conta, então os dois conjuntos nascem
    // disjuntos; ver os dois juntos significa que a RPC no ar não é a deste contrato.
    if (clientToUser.has(cod)) {
      throw new Error("identity snapshot: código em client_to_user E revoked_client_codes — fail-open da RPC (fail-closed)");
    }
    revokedClientCodes.add(cod);
  }
  return { docToUserMap, ambiguousDocs, clientToUser, revokedClientCodes };
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

// MIRROR-START omie transferencia-codigo — espelhado verbatim de src/lib/omie/omie-transferencia-codigo.ts
// P1-c (fail-closed money-path): o writer document-first grava a proof com `onConflict(user_id,account)`,
// que NÃO enxerga a segunda unicidade da tabela — `uq_ocam_codigo_account UNIQUE(omie_codigo_cliente,
// account)`. Quando um código migra de dono (user1 → user2 na MESMA conta), a linha antiga ainda segura o
// código: o INSERT viola a UNIQUE com 23505, que o ON CONFLICT declarado não trata, e o `throw` derruba o
// chunk de 500 e o run inteiro. Um único código migrando matava o sync do dia.
//
// A correção NÃO é aplicar a transferência. Parecer Codex (gpt-5.6-sol xhigh, 2026-08-24): o documento
// prova o PAREAMENTO ATUAL, não a AUTORIZAÇÃO da transferência. Migração legítima e captura de vínculo por
// edição do CNPJ no Omie produzem input IDÊNTICO — "código X agora tem o documento D2, que é do user2".
// Deletar a linha antiga automaticamente promoveria qualquer editor do Omie a autoridade sobre dono de
// pedido e comissão. Então: documento autoriza CRIAÇÃO e REFRESH; transferência vira CONFLITO.
//
// Trocar o onConflict para (codigo,account) — a outra "correção óbvia" — é PIOR: resolve a troca de dono e
// quebra a troca de código (INSERT de um código novo para um user que já tem linha viola
// uq_ocam_user_account), que é o caso COMUM do recadastro. E implementa exatamente a transferência que o
// caso A8 de db/test-register-carteira-member.sh existe para barrar.
//
// A UNIQUE permanece intocada no schema: ela segue sendo a barreira do writer SEM evidência (a RPC pontual
// `register_carteira_member`, cujo 23505 é fail-closed correto e tem teste com dente). O que muda é só que
// o writer COM evidência para de bater nela por acidente.
// Espelhado no edge (Deno não importa de src/); paridade textual no CI em
// src/__tests__/edge-money-path-invariants.test.ts.

type DecisaoProof =
  | "aplicar" // código livre, ou já é deste user: criação/refresh — o caso normal
  | "transferencia" // o código pertence a OUTRO user na mesma conta: NÃO aplica, vira conflito
  | "manual_protegido"; // a linha do próprio user é override HUMANO: automação não rebaixa

interface EntradaProof {
  readonly user_id: string;
  readonly omie_codigo_cliente: number;
}

/** Linha JÁ existente na proof-table, da MESMA conta. */
interface LinhaIncumbente {
  readonly user_id: string;
  readonly omie_codigo_cliente: number;
  readonly source: string;
}

interface ClassificacaoProof {
  readonly decisao: DecisaoProof;
  /** Só em `transferencia`: o dono ATUAL do código, que perde o vínculo se a transferência for aprovada. */
  readonly incumbente?: string;
}

/**
 * Decide, para UMA entrada do lote document-first, se ela pode ser gravada na proof-table.
 *
 * Duas linhas incumbentes importam, e o Codex nomeou as duas — proteger só uma deixa o furo aberto:
 *   · a que detém o CÓDIGO  (`porCodigo`) → transferência de dono;
 *   · a que pertence ao USER (`porUser`)  → o upsert manda `source:'document'` e rebaixaria um
 *     override humano do próprio user, apesar de o delete de ambíguos preservá-lo explicitamente.
 *     Hoje há ZERO linhas `manual` em produção (medido: 16097 `document` + 21 `rpc`), então o furo é
 *     LATENTE — a promessa de imunidade existe no código e nunca foi exercitada pelo dado.
 */
function classificarEntradaProof(
  entrada: EntradaProof,
  porCodigo: ReadonlyMap<number, LinhaIncumbente>,
  porUser: ReadonlyMap<string, LinhaIncumbente>,
): ClassificacaoProof {
  // 1) Override humano do PRÓPRIO user vence a automação, mesmo que o código não mude. Vem antes da
  //    checagem de transferência: se a linha do user é manual, nada da automação a toca — nem para
  //    reescrever o mesmo código, porque o upsert rebaixaria `source` para 'document'.
  const doUser = porUser.get(entrada.user_id);
  if (doUser && doUser.source === "manual") return { decisao: "manual_protegido" };

  // 2) O código já tem dono? Se for OUTRO user, é transferência — fail-closed, não aplica.
  const doCodigo = porCodigo.get(entrada.omie_codigo_cliente);
  if (doCodigo && doCodigo.user_id !== entrada.user_id) {
    return { decisao: "transferencia", incumbente: doCodigo.user_id };
  }

  // 3) Código livre, ou já é deste user: criação/refresh. É o caminho de ~100% do volume.
  return { decisao: "aplicar" };
}

/**
 * Classifica o LOTE inteiro. Existe além do caso-a-caso por um motivo que a checagem contra o banco NÃO
 * cobre: a colisão pode nascer DENTRO do próprio lote.
 *
 * O `docsComCodigoAmbiguoNoOmie` (P1b) detecta um DOC com 2+ códigos. O inverso — um CÓDIGO que aparece com
 * 2+ documentos na mesma paginação, casando com users diferentes — não era detectado por ninguém, e produz
 * exatamente a mesma 23505: duas entradas do lote disputando `uq_ocam_codigo_account`, sem nenhuma linha
 * pré-existente envolvida. Fail-closed simétrico ao P1b: se 2+ users disputam um código, NENHUM o leva —
 * não há como saber qual documento é o correto, e escolher o último seria o last-write-wins que este épico
 * inteiro existe para matar.
 *
 * Retorna um Map por user_id (a mesma chave de `accountMapByUser`, para o chamador filtrar direto).
 */
function classificarLoteProof(
  entradas: ReadonlyArray<EntradaProof>,
  porCodigo: ReadonlyMap<number, LinhaIncumbente>,
  porUser: ReadonlyMap<string, LinhaIncumbente>,
): Map<string, ClassificacaoProof> {
  // Quantos users DISTINTOS disputam cada código dentro do lote. `Set` e não contador: o mesmo user
  // repetido (duplicata pura da paginação do Omie) não é disputa e não pode zerar o vínculo.
  const usersPorCodigo = new Map<number, Set<string>>();
  for (const e of entradas) {
    const s = usersPorCodigo.get(e.omie_codigo_cliente) ?? new Set<string>();
    s.add(e.user_id);
    usersPorCodigo.set(e.omie_codigo_cliente, s);
  }

  const out = new Map<string, ClassificacaoProof>();
  for (const e of entradas) {
    const disputantes = usersPorCodigo.get(e.omie_codigo_cliente);
    if (disputantes && disputantes.size > 1) {
      // Disputa intra-lote. `incumbente` fica ausente de propósito: não há dono anterior a preservar —
      // o conflito é entre candidatos, não com o estado gravado.
      out.set(e.user_id, { decisao: "transferencia" });
      continue;
    }
    out.set(e.user_id, classificarEntradaProof(e, porCodigo, porUser));
  }
  return out;
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
    // `userByCodigo` deixou de vir do espelho `omie_clientes` na Fatia 5 — a fonte agora é
    // `customer_canonical_alias ∪ omie_customer_account_map`, FILTRADA pela conta do run (ver a
    // função: o código só é único dentro de uma conta, e o run só enumera códigos da sua).
    const userByCodigo = await fetchCodigoUserMap(db, account);
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
      evidence_document_normalized: string;
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

      // Piso MONOTÔNICO + teto fail-fast + anomalia (mesma tríade do syncInventory abaixo;
      // money-path §9). Era `|| 1` POR RESPOSTA: uma intermediária SEM o campo encolhia o teto
      // e o run fechava sync_state 'complete' com o retrato PARCIAL da carteira.
      totalPaginas = proximoTotalPaginas(totalPaginas, result.total_de_paginas, MAX_PAGINAS_LISTAGEM);
      const clientes = result.clientes_cadastro || [];
      const veredicto = avaliarPagina(clientes.length, pagina, totalPaginas);
      if (veredicto === "anomalia") {
        // Página vazia ANTES do fim declarado = fault transiente disfarçado → aborta fail-closed
        // (status error; o próximo ciclo re-tenta). Nada foi escrito ainda: a enumeração antecede
        // ledger/proof/tags.
        throw new Error(`página ${pagina}/${totalPaginas} do ListarClientes veio vazia antes do fim declarado — abortando (retrato parcial)`);
      }
      if (veredicto === "fim") break;
      for (const c of clientes) {
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
            // PR-2/A2: PROVENANCE da prova. Sem esta coluna, a proof-table registrava QUE havia vínculo
            // mas não QUAL documento o provou — e aí o leitor (omie-vendas-sync) só podia concluir por
            // AUSÊNCIA DE CONTRAINDICAÇÃO, que é fail-open: um C→u1 casado com o doc X sobrevivia a u1
            // migrar para Y e u2 receber X. `doc` é exatamente o documento que casou logo acima
            // (userByDoc.get(doc)), já normalizado a dígitos; userByDoc vem de doc_to_user, que só
            // admite doc com length>=11 — o CHECK da coluna trava a regressão em que isto passasse a
            // gravar o doc FORMATADO e o JOIN da RPC deixasse de casar em silêncio.
            evidence_document_normalized: doc,
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
    // fontes AUTOMATIZADAS (preserva override humano source='manual' — challenge Codex item 3). Não é
    // delete-em-massa: run parcial vê menos ocorrências → detecta menos → deleta menos (fail-safe).
    // [HOTFIX Codex-A] 'rpc' entrou no filtro: a `register_carteira_member` é writer AUTOMATIZADO e suas
    // linhas TÊM de continuar alcançáveis por este fail-closed. Enquanto ela gravava 'manual', todo
    // vínculo que criava ficava imune à detecção de ambiguidade — vendedor possivelmente errado
    // sobrevivendo à detecção, com comissão em cima. Só override HUMANO merece imunidade.
    if (usersAmbiguosOmie.size > 0) {
      const ambiguosList = Array.from(usersAmbiguosOmie);
      for (let i = 0; i < ambiguosList.length; i += 200) {
        const { error: delErr } = await db
          .from("omie_customer_account_map")
          .delete()
          .eq("account", empresaMap)
          .in("source", ["document", "rpc"])
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
    // [HOTFIX Codex-C] A lista é a DOCUMENT-FIRST (`accountMapByUser`), não a code-first. O raciocínio
    // original — "a code-first cobre os ~1633 aliases fiscais que a proof nunca vê" — confundiu duas
    // coisas: cobertura de ESTOQUE e correção de FLUXO.
    //   · ESTOQUE: os 1633 aliases JÁ estão no ledger, copiados pelo backfill da Fatia 0. Como o ledger
    //     é acumulador e NUNCA encolhe, deixar de reinseri-los diariamente não os remove. Não havia o que
    //     "cobrir".
    //   · FLUXO: para uma admissão NOVA, o que importa é acertar QUEM é o user. A code-first resolve por
    //     `userByCodigo`, que vem do espelho legado SEM conta — a mesma fonte poluída que este épico
    //     inteiro existe para aposentar — e ela VENCE o documento (`userByCodigo ?? userByDoc`, :402).
    //     Caminho concreto do erro: código Omie reaproveitado/corrigido, legado diz "K → user X", o
    //     documento atual prova "K → user Y"; a code-first escolhe X, que já está no ledger (upsert vira
    //     no-op) e Y — o cliente novo e CORRETO — nunca entra na membership.
    // A document-first é account-safe e não perde ninguém aqui: tanto este bulk quanto o `sync_all_clients`
    // já descartam registro sem documento antes deste ponto.
    //
    // ON CONFLICT DO NOTHING (ignoreDuplicates) é o invariante do acumulador: preserva `first_seen_at`
    // (a data REAL do vínculo, consumida em :1761) e NUNCA rebaixa `identity_state` — um membro
    // quarantinado pela Fatia 2 (`ambiguous`) não volta a `verified` no run seguinte, o que devolveria
    // vendedor e comissão a um cliente cuja identidade não sabemos.
    //
    // Só o run oben escreve, mesma regra do espelho e do `identity_state` acima (:484): a carteira lê a
    // proof `account='oben'` — é a conta que decide quem é membro.
    let totalSynced = 0;
    if (account === "vendas") {
      const nowIsoLedger = new Date().toISOString();
      const ledgerRows = Array.from(accountMapByUser.values()).map((r) => ({
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
    // consumidores de leitura. onConflict composto = uq_ocam_user_account; document-first → dedup por
    // user_id basta (account é fixo).
    //
    // ── P1-c: o onConflict acima NÃO enxerga a 2ª unicidade (`uq_ocam_codigo_account`). Quando um código
    // migra de dono, a linha antiga ainda o segura e o INSERT levanta 23505 — que o ON CONFLICT declarado
    // não trata e o `throw` abaixo transforma em queda do run inteiro. Por isso o lote passa antes pelo
    // classificador: ele separa CRIAÇÃO/REFRESH (aplica) de TRANSFERÊNCIA (não aplica, vira conflito).
    // A UNIQUE segue no schema, intocada — ela é a barreira do writer SEM evidência (a RPC pontual, cujo
    // 23505 é fail-closed correto). O que muda é só o writer COM evidência parar de bater nela.
    // Leitura PRÓPRIA da proof, e não o `userByCodigo` de :700 (`fetchCodigoUserMap`), por duas razões:
    // aquele Map mistura a fonte `alias` com a proof (aqui só a proof decide quem é o incumbente) e não
    // traz `source` — sem ele não dá para distinguir override HUMANO de linha automatizada. Custo: mais
    // um `fetchAll` paginado por conta (~5,6k linhas), num run que já pagina milhares de registros do Omie.
    const proofAtual = await fetchAll<{ omie_codigo_cliente: number | null; user_id: string | null; source: string | null }>(
      (from, to) =>
        db
          .from("omie_customer_account_map")
          .select("omie_codigo_cliente, user_id, source")
          .eq("account", empresaMap)
          .order("omie_codigo_cliente", { ascending: true })
          .order("user_id", { ascending: true })
          .range(from, to),
      `fetch proof p/ classificar transferências (${empresaMap})`,
    );
    const incumbentePorCodigo = new Map<number, { user_id: string; omie_codigo_cliente: number; source: string }>();
    const incumbentePorUser = new Map<string, { user_id: string; omie_codigo_cliente: number; source: string }>();
    for (const r of proofAtual) {
      if (r.omie_codigo_cliente == null || !r.user_id) continue;
      const l = { user_id: r.user_id, omie_codigo_cliente: Number(r.omie_codigo_cliente), source: r.source ?? "document" };
      incumbentePorCodigo.set(l.omie_codigo_cliente, l);
      incumbentePorUser.set(l.user_id, l);
    }

    const candidatos = Array.from(accountMapByUser.values());
    const decisoes = classificarLoteProof(
      candidatos.map((c) => ({ user_id: c.user_id, omie_codigo_cliente: c.omie_codigo_cliente })),
      incumbentePorCodigo,
      incumbentePorUser,
    );
    const mapRows = candidatos.filter((c) => decisoes.get(c.user_id)?.decisao === "aplicar");
    const transferencias = candidatos.filter((c) => decisoes.get(c.user_id)?.decisao === "transferencia");
    const manualProtegidos = candidatos.filter((c) => decisoes.get(c.user_id)?.decisao === "manual_protegido");

    for (let i = 0; i < mapRows.length; i += 500) {
      const chunk = mapRows.slice(i, i + 500);
      const { error: mapErr } = await db
        .from("omie_customer_account_map")
        .upsert(chunk, { onConflict: "user_id,account" });
      if (mapErr) throw new Error(`upsert omie_customer_account_map: ${mapErr.message}`);
    }
    // DENOMINADOR explícito: sem ele, um lote que encolheu por retenção seria indistinguível de um run
    // parcial do Omie — "5598 vínculos" não diz se 2 foram retidos ou se 2 clientes sumiram da fonte.
    console.log(
      `[Sync ${account}] proof-table omie_customer_account_map: ${mapRows.length}/${candidatos.length} vínculos por documento ` +
        `(retidos: ${transferencias.length} conflito de dono, ${manualProtegidos.length} override humano)`,
    );

    // ── P1-c observabilidade: transferência de dono é, provavelmente, o evento de identidade mais caro do
    // sistema (cliente → dono do pedido → comissão) e NÃO pode ser resolvida em silêncio. Sem PII: só a
    // contagem e os CÓDIGOS (que não são dado pessoal); documento e user_id ficam fora do texto.
    if (transferencias.length > 0) {
      const amostraCods = transferencias.slice(0, 5).map((t) => t.omie_codigo_cliente).join(", ");
      console.warn(
        `[Sync ${account}] P1-c CONFLITO DE DONO: ${transferencias.length} código(s) mudaram de user no Omie — ` +
          `NÃO aplicados (documento prova pareamento, não autoriza transferência). Códigos: ${amostraCods}`,
      );
    }
    // ⚠️ CONSEQUÊNCIA DELIBERADA, não esquecimento: a linha `manual` deixa de ser tocada, logo o
    // `updated_at` dela NÃO é renovado e ela sai da view `omie_customer_account_map_fresco` (TTL de 7d)
    // se ninguém mais a escrever. O comportamento ANTERIOR mantinha a linha fresca — mas só ao custo de
    // rebaixá-la para `source:'document'`, isto é, destruindo o override que ela representa. Trocamos
    // "override destruído, porém fresco" por "override preservado, porém envelhece".
    // Não renovamos o `updated_at` de propósito: o §11 do design nomeia exatamente esse anti-padrão na
    // `register_carteira_member` — renovar frescor SEM evidência nova deixa o vínculo fresco na view e
    // fora tanto de `client_prova` quanto de `client_revogado`, reiniciando o relógio dos 7d sem que nem
    // a prova nem a revogação tenham o que dizer. O TTL de uma linha `manual` é questão do desenho de
    // `manual` (hoje: ZERO linhas em prod), não deste writer.
    if (manualProtegidos.length > 0) {
      console.warn(
        `[Sync ${account}] P1-c: ${manualProtegidos.length} vínculo(s) com override HUMANO ('manual') preservados — a automação não os rebaixa`,
      );
    }

    // Quarentena do INCUMBENTE: ele mantém a linha (a transferência não foi aplicada), mas o Omie já diz
    // que o código é de outro documento — então o vínculo dele virou DUVIDOSO. `identity_state='conflict'`
    // já existe no CHECK do ledger desde a Fatia 0 e o carteira-rebuild já o quarantina, porque filtra por
    // NEGAÇÃO (`identity_state !== 'verified'`, carteira-rebuild:177): zero mudança no consumidor.
    // Fail-closed dos DOIS lados — o candidato não ganha o vínculo e o incumbente para de gerar comissão
    // sobre um cliente cuja identidade está em disputa, até revisão humana.
    // SÓ o run oben escreve, mesma regra D5 do `ambiguous` (:744): identity_state é coluna GLOBAL (1 row
    // por user) e o conflito é detectado POR CONTA — os 3 runs escrevendo se sobrescreveriam.
    if (account === "vendas" && transferencias.length > 0) {
      const incumbentes = Array.from(
        new Set(
          transferencias
            .map((t) => decisoes.get(t.user_id)?.incumbente)
            .filter((u): u is string => typeof u === "string"),
        ),
      );
      const nowIso = new Date().toISOString();
      for (let i = 0; i < incumbentes.length; i += 200) {
        const { error: cfErr } = await db
          .from("carteira_membership_ledger")
          .update({ identity_state: "conflict", updated_at: nowIso })
          .eq("identity_state", "verified") // não rebaixa nem promove outro estado (ambiguous continua ambiguous)
          .in("user_id", incumbentes.slice(i, i + 200));
        if (cfErr) throw new Error(`marca conflict carteira_membership_ledger: ${cfErr.message}`);
      }
      if (incumbentes.length > 0) {
        console.warn(
          `[Sync ${account}] P1-c: ${incumbentes.length} incumbente(s) → identity_state='conflict'; QUARANTINADOS no próximo carteira-rebuild (eligible=false, zero comissão) até revisão humana`,
        );
      }
    }

    // ── P0-B-bis Fatia 2: reversão `ambiguous` → `verified`, SIMÉTRICA ao delete/marcação acima. Quem ESTE run
    // PROVOU limpo volta a valer: `accountMapByUser` é exatamente o conjunto casado por DOCUMENTO, e os
    // ambíguos já foram retirados dele (:447) → os dois conjuntos são disjuntos de graça.
    // Sem isto o quarantine seria CATRACA DE MÃO ÚNICA: doc corrigido no Omie deixaria o cliente invisível e
    // sem comissão PARA SEMPRE, dependendo de um UPDATE manual que ninguém saberia que precisa fazer.
    // Barato no caso normal: 1 SELECT indexado (idx_cml_identity_state) que hoje volta VAZIO → nada a fazer.
    // Paginado (a capa de 1000 do PostgREST é silenciosa). Run parcial reverte só o que viu (fail-safe).
    if (account === "vendas") {
      // Delegado a fetchAll (money-path §9): o laço à mão convertia data:null SEM error em página
      // vazia (EOF falso) — a reversão via menos membros e o quarantine ficava preso sem razão
      // visível. fetchAll lança tanto na página com erro quanto na malformada.
      const ambRows = await fetchAll<{ user_id: string }>(
        (from, to) =>
          db
            .from("carteira_membership_ledger")
            .select("user_id")
            .eq("identity_state", "ambiguous")
            .order("user_id", { ascending: true })
            .range(from, to),
        "lê ambiguous do carteira_membership_ledger",
      );
      const ambNoLedger = ambRows.map((r) => r.user_id);
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

      // ── P1-c: reversão `conflict` → `verified`, SIMÉTRICA à marcação acima. Sem ela o conflito seria
      // CATRACA DE MÃO ÚNICA — o §11 do design nomeia exatamente esse defeito no quarantine de
      // ambiguidade: doc corrigido no Omie deixaria o incumbente sem comissão PARA SEMPRE, dependendo de
      // um UPDATE manual que ninguém saberia que precisa fazer.
      // O critério é mais estrito que o do `ambiguous`: não basta o user estar no lote (`accountMapByUser`
      // inclui quem virou transferência) — ele tem de ter sido APLICADO, isto é, o código voltou a casar
      // com ele e não há mais disputa. Por isso lê `mapRows`, não `accountMapByUser`.
      const aplicados = new Set(mapRows.map((r) => r.user_id));
      const cfRows = await fetchAll<{ user_id: string }>(
        (from, to) =>
          db
            .from("carteira_membership_ledger")
            .select("user_id")
            .eq("identity_state", "conflict")
            .order("user_id", { ascending: true })
            .range(from, to),
        "lê conflict do carteira_membership_ledger",
      );
      const reverterCf = cfRows.map((r) => r.user_id).filter((uid) => aplicados.has(uid));
      if (reverterCf.length > 0) {
        const nowIsoCf = new Date().toISOString();
        for (let i = 0; i < reverterCf.length; i += 200) {
          const { error: revCfErr } = await db
            .from("carteira_membership_ledger")
            .update({ identity_state: "verified", updated_at: nowIsoCf })
            .eq("identity_state", "conflict") // restringe ao que o P1-c populou (não toca ambiguous/inactive)
            .in("user_id", reverterCf.slice(i, i + 200));
          if (revCfErr) throw new Error(`reverte conflict carteira_membership_ledger: ${revCfErr.message}`);
        }
        console.log(
          `[Sync ${account}] P1-c: ${reverterCf.length} membro(s) conflict→verified (o código voltou a casar com o incumbente) — saem do quarantine no próximo carteira-rebuild`,
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
  // Delegado a fetchAll (money-path §9): o laço à mão convertia data:null SEM error em página
  // vazia (EOF falso) → Set parcial → cliente VINCULADO classificado "unlinked" no relatório.
  const rows = await fetchAll<{ omie_codigo_cliente: number | null }>(
    (from, to) =>
      db
        .from("omie_customer_account_map_fresco")
        .select("omie_codigo_cliente")
        .eq("account", empresa)
        // .order estável: sem ele o .range pagina sobre ordem indefinida (armadilha PostgREST) e
        // uma linha pode repetir ou sumir entre páginas — num Set de dedup, sumir vira falso "unlinked".
        .order("omie_codigo_cliente")
        .range(from, to),
    `fetch codigos vinculados (${empresa})`,
  );
  const set = new Set<number>();
  for (const r of rows) if (r.omie_codigo_cliente != null) set.add(Number(r.omie_codigo_cliente));
  return set;
}

// Lê TODOS os documentos de profiles (normalizados em memória — defensivo contra formatados).
async function fetchAllProfileDocs(db: SupabaseClient): Promise<Set<string>> {
  // Este laço tinha as DUAS metades da classe, e cada PR fechou uma:
  //   · o #1589 pôs o `.order("id")` que faltava (metade §7 — sem ordem estável o `.range()`
  //     pagina sobre sequência indefinida e um documento some entre páginas);
  //   · aqui a leitura passa a DELEGAR a `fetchAll`, que fecha a metade §9 — o `data ?? []`
  //     convertia resposta malformada (data:null SEM error) em página vazia → EOF falso → Set
  //     PARCIAL.
  // As duas importam pelo mesmo caminho: documento ausente do Set faz o dedup a jusante criar
  // usuário Auth NOVO para cliente que JÁ existe — a fábrica de clones do #1425.
  //
  // `id` (e não `user_id`) mantém a coluna que o #1589 conferiu em prod: é a PRIMARY KEY
  // (`profiles_pkey`). `user_id` também seria estável (UNIQUE NOT NULL, 5.668/5.668 distintos
  // — conferido via psql-ro), mas divergir da coluna já auditada não compra nada.
  const rows = await fetchAll<{ document: string | null }>(
    (from, to) =>
      db
        .from("profiles")
        .select("document")
        .not("document", "is", null)
        .order("id", { ascending: true })
        .range(from, to),
    "fetch profiles docs",
  );
  const set = new Set<string>();
  for (const r of rows) {
    const d = (r.document ?? "").replace(/\D/g, "");
    if (d) set.add(d);
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

      // Piso MONOTÔNICO + teto fail-fast + anomalia (tríade de _shared/omie-paginacao.ts;
      // money-path §9): era `|| 1` POR RESPOSTA — o snapshot fecharia 'complete' PARCIAL.
      totalPaginas = proximoTotalPaginas(totalPaginas, result.total_de_paginas, MAX_PAGINAS_LISTAGEM);
      const clientes = result.clientes_cadastro || [];
      const veredicto = avaliarPagina(clientes.length, pagina, totalPaginas);
      if (veredicto === "anomalia") {
        // Vazia ANTES do fim declarado = fault disfarçado → aborta (status error; o finalize
        // atômico nunca roda com enumeração parcial — o run morto fica invisível na UI).
        throw new Error(`página ${pagina}/${totalPaginas} do ListarClientes (não-vinculados) veio vazia antes do fim declarado — abortando (retrato parcial)`);
      }
      if (veredicto === "fim") break;
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

// Teto ANTI-RUNAWAY, não orçamento de lote (espelha MAX_PAGINAS_PRODUTOS de
// omie-sync-metadados e de sync-reprocess/products-lote.ts): 500 × 100 = 50k >> catálogo
// real (~4,3k colacor / ~3,7k oben). O laço termina no EOF de verdade (`pagina > totalPaginas`),
// então o teto nunca é o que corta — é só rede contra `total_de_paginas` mentiroso da Omie.
//
// ⚠️ ERA 10, e isso truncava em SILÊNCIO: 10 páginas contra 37 = 27% do catálogo, todo dia,
// sempre as MESMAS páginas 1–10 (o `nextPage` que esta função retorna nunca teve quem o
// consumisse — não há retomada). O marcador `sync_state` products/vendas dizia 'partial' desde
// sempre e ninguém lia, enquanto `acoes_execucoes` carimbava 'sucesso' (35 runs, 32 ok desde
// 21/07). Quem chamava sem argumento herdava a truncagem: o `sync_all` e o botão do painel
// admin (`useAnalyticsSync.ts` invoca com `{action, account}`, sem `max_pages`).
const MAX_PAGINAS_PRODUTOS = 500;

async function syncProducts(db: SupabaseClient, account: OmieAccount, startPage = 1, maxPages = MAX_PAGINAS_PRODUTOS) {
  await updateSyncState(db, "products", account, { status: "running", error_message: null });
  let pagina = startPage;
  // Piso da run: começa na página pedida (garante a entrada no laço) e daí só cresce.
  let totalPaginas = startPage;
  // Fim REAL declarado por avaliarPagina (vazia NA última página) — distingue "catálogo
  // esgotado" de "lote esgotado" no `complete` abaixo.
  let fimReal = false;
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

      // Piso MONOTÔNICO + teto fail-fast + anomalia (money-path §9): era `|| 1` POR RESPOSTA —
      // uma intermediária sem o campo encolhia o teto e o cursor fechava 'complete' prematuro.
      totalPaginas = proximoTotalPaginas(totalPaginas, result.total_de_paginas, MAX_PAGINAS_LISTAGEM);
      const produtos = result.produto_servico_cadastro || [];
      const veredicto = avaliarPagina(produtos.length, pagina, totalPaginas);
      if (veredicto === "anomalia") {
        // Vazia ANTES do fim declarado = fault disfarçado → aborta (status error); o caller
        // re-invoca do startPage e o upsert é idempotente.
        throw new Error(`página ${pagina}/${totalPaginas} do ListarProdutos veio vazia antes do fim declarado — abortando (retrato parcial)`);
      }
      if (veredicto === "fim") {
        fimReal = true;
        break;
      }

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

    // [2026-08-25] Havia AQUI um segundo upsert, ANTES deste, que carimbava 'complete'
    // INCONDICIONALMENTE (com last_page=totalPaginas) e era sobrescrito na linha seguinte.
    // Era write morto E uma janela de mentira: um leitor que caísse entre os dois upserts via
    // 'complete' com o total de páginas do catálogo — exatamente o oposto do que um run truncado
    // fez. Quem decide o status é o `complete` abaixo; só ele grava.
    const complete = fimReal || pagina > totalPaginas;
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
      // Precisão > recall; o cron re-tenta no próximo ciclo. data:null SEM error = resposta
      // malformada com o MESMO efeito (chunk perdido em silêncio) → mesmo throw (money-path §9).
      if (error) throw new Error(`resolve omie_products: ${error.message}`);
      if (data == null) throw new Error("resolve omie_products: data null sem error — resposta malformada");
      prodRows.push(...data);
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
        if (error || data == null) {
          // SELECT falho OU data:null sem error (malformada — money-path §9) degrada (≠ resolve
          // de omie_products, que aborta): os candidatos do chunk caem no "inserir" e o
          // ignoreDuplicates abaixo pula os que já existem — custo stale por 1 ciclo, nunca
          // corrupção/clobber de proveniência. A malformada contava como sucesso SILENCIOSO;
          // agora conta em falhasChunk e aparece no error_message do sync_state.
          falhasChunk++;
          console.error(`[Sync ${account}] resolve product_costs:`, error ?? "data null sem error");
          continue;
        }
        for (const r of data) jaTemCusto.add(r.product_id as string);
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
    // Delegado a fetchAll (money-path §9): o laço à mão convertia data:null SEM error em página
    // vazia (EOF falso) → idMap parcial → CMC gravado com product_id null para a cauda perdida.
    const allProdRows = await fetchAll<{ id: string | null; omie_codigo_produto: number | string | null }>(
      (from, to) =>
        db
          .from("omie_products")
          .select("id, omie_codigo_produto")
          .eq("account", empresa)
          .order("id", { ascending: true })
          .range(from, to),
      `omie_products(inventory_full ${empresa})`,
    );
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
  // A CONFIG também falhava ABERTO (achado do challenge Codex xhigh nesta entrega). Era
  // `const { data: configs } = await …` — o MESMO defeito da leitura de cestas, doze linhas
  // acima dela: `error` descartado ⇒ "não consegui LER a configuração" virava "configuração
  // AUSENTE", e os `??` abaixo publicavam o modelo com os DEFAULTS como se fossem os pisos
  // escolhidos. Numa tabela cujo consumidor confia no `support` publicado, isso é fabricar o
  // próprio CRITÉRIO. Fechar a leitura grande e deixar esta seria trancar a porta e esquecer
  // a janela. Quem chama é `comRegistro`, que registra a falha — então lançar aqui é visível.
  const { data: configs, error: erroConfig } = await db
    .from("recommendation_config")
    .select("key, value");
  if (erroConfig) throw new Error(`recommendation_config: ${erroConfig.message}`);
  const cfg: Record<string, number> = {};
  for (const c of configs ?? []) cfg[c.key] = c.value;

  const minSupport = cfg.s_min ?? 0.01;
  const minLift = cfg.l_min ?? 1.2;
  const maxRules = cfg.max_association_rules ?? 500;

  // O UNIVERSO DE CESTAS — paginado, ordenado e filtrado. Aqui havia UMA leitura só:
  //   const { data: items } = await db.from("order_items")
  //     .select("sales_order_id, product_id").not("product_id","is",null);
  // Quatro defeitos empilhados, todos MEDIDOS em prod via psql-ro (2026-08-20/21):
  //
  //  1. SEM PAGINAÇÃO → o cap silencioso de 1.000 linhas do PostgREST. `order_items` tem 68.350
  //     linhas com `product_id` e 30.259 pedidos distintos; as 1.000 primeiras dão exatamente
  //     479 pedidos. E o `sample_size` das 24 regras que estavam vigentes era 479 em TODAS —
  //     ou seja, o universo de PRODUÇÃO era a fatia, e a prova não é inferência: uma réplica
  //     SQL do algoritmo abaixo rodada sobre `LIMIT 1000` reproduz as 24 regras EXATAMENTE
  //     (mesmos pares, mesmo lift até 6 casas).
  //  2. SEM `.order()` → a fatia não é nem estável nem aleatória entre execuções (§7/§9 do
  //     money-path). O gate `_shared/paginacao-delegada_test.ts` exige `.order(` junto de todo
  //     `.range(` nesta edge exatamente por isto.
  //  3. SEM FILTRO DE STATUS → pedido cancelado/soft-deletado entrava na cesta. O motor irmão
  //     (`useBundleEngine`) já usa a DENYLIST da autoridade + `deleted_at IS NULL`; a paridade
  //     de universo entre os dois motores é o desenho, não coincidência. Efeito isolado hoje:
  //     20 cestas de 30.259 — pequeno, mas é o predicado que impede um cancelamento em massa
  //     amanhã de virar "padrão de compra".
  //  4. `const { data: items }` DESCARTAVA o `error` → página com timeout/RLS/500 virava `[]`,
  //     e o retorno dizia "0 regras, regras vigentes preservadas" com cara de sucesso (§6/§11).
  //     `fetchAll` LANÇA na página com erro E na malformada (`data:null` sem `error`), então
  //     "não consegui ler" para de ser indistinguível de "não há padrão".
  //
  // ⚠️ O `!inner` é o que aplica o filtro do PAI sem uma segunda leitura paginada — duas
  // leituras seriam 2×K instantes (§14: paginar não faz snapshot), e o Set intermediário de
  // 30 mil ids seria mais uma superfície onde a página perdida troca o ESCOPO em silêncio.
  // ⚠️ STATUS NULO: o `not.in` do PostgREST é NULL-BLIND — pedido com `status IS NULL` não
  // passa no filtro e some do universo. Espelhar a autoridade (que é NULL-blind pelo mesmo
  // motivo em SQL) mantém a PARIDADE, mas espelhar em SILÊNCIO seria trocar o defeito de
  // lugar: amanhã um nulo encolheria o denominador e o `sample_size` publicado teria cara de
  // universo completo — o §2 (ausente ≠ zero) na forma de RÓTULO. Precisão > recall diz para
  // NÃO publicar sob ambiguidade, não para publicar um número menor sem avisar. Medido em
  // prod (2026-08-20): 0 linhas. Se deixar de ser 0, a publicação PARA e diz quantas são.
  // (Achado do challenge Codex xhigh: "excluir desconhecido é compatível com precisão>recall;
  // fazê-lo silenciosamente não é".)
  const { count: pedidosSemStatus, error: erroNulo } = await db
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .is("status", null)
    .is("deleted_at", null);
  if (erroNulo) throw new Error(`sales_orders/status-nulo: ${erroNulo.message}`);
  if ((pedidosSemStatus ?? 0) > 0) {
    throw new Error(
      `${pedidosSemStatus} pedido(s) com status NULL: o universo do Apriori seria menor que o real ` +
        `e o sample_size publicado mentiria sobre a base. Classifique o status antes de recalcular.`,
    );
  }

  // CONTA NULA: o mesmo tratamento que o status nulo acima, e pelo mesmo motivo. `account` é o
  // eixo do denominador desta fatia — um pedido sem conta não pode ser atribuído a nenhum
  // segmento nem ser jogado no maior "porque é mais provável". `agruparCestasPorSegmento`
  // DESCARTA a linha sem conta e a CONTA; o guard aqui é a defesa em profundidade que impede o
  // descarte de virar um denominador menor publicado com cara de universo completo (§2 —
  // ausente ≠ zero, na forma de RÓTULO). Medido em prod (2026-08-21): 0 linhas.
  const { count: pedidosSemConta, error: erroConta } = await db
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .is("account", null)
    .is("deleted_at", null);
  if (erroConta) throw new Error(`sales_orders/conta-nula: ${erroConta.message}`);
  if ((pedidosSemConta ?? 0) > 0) {
    throw new Error(
      `${pedidosSemConta} pedido(s) sem account: as cestas seriam segmentadas por um eixo com ` +
        `buraco, e o sample_size de cada conta mentiria sobre a base. Classifique a conta antes de recalcular.`,
    );
  }

  // CÓDIGO DE PRODUTO REPETIDO ENTRE CONTAS — o guard que impede a segmentação de virar
  // promessa vazia num consumidor (achado do challenge Codex xhigh, medido em prod depois).
  // O isolamento entre as contas NÃO é garantido por chave: a UNIQUE de `omie_products` é
  // `(omie_codigo_produto, account)`, então o MESMO código pode legitimamente existir nas duas.
  // E `_carteira_mixgap_for_owner` casa o histórico do cliente por
  //   `oi.product_id = op.id OR (oi.product_id IS NULL AND oi.omie_codigo_produto = op.omie_codigo_produto)`
  // — o segundo ramo SEM qualificar pela conta, sobre 1.839 linhas de `order_items` que têm
  // `product_id` nulo e código preenchido. Se um código passar a existir nas duas contas, um
  // item de colacor materializa também o id de oben e uma regra de oben casa com o cliente
  // errado: precisão > recall diz para NÃO publicar sob essa ambiguidade.
  // Medido em prod (2026-08-21): 0 códigos em mais de uma conta — o isolamento é fato do DADO
  // de hoje, não do desenho. Por isso ele é MEDIDO a cada execução, e não assumido. É a mesma
  // forma dos dois guards acima, e o motivo é o de sempre: 0 hoje não é 0 amanhã.
  const { data: codigosAmbiguos, error: erroAmbiguo } = await db
    .rpc("omie_products_codigos_multi_conta")
    .returns<{ omie_codigo_produto: string; contas: number }[]>();
  if (erroAmbiguo) throw new Error(`omie_products/codigo-multi-conta: ${erroAmbiguo.message}`);
  if ((codigosAmbiguos ?? []).length > 0) {
    const amostra = (codigosAmbiguos ?? []).slice(0, 5).map((c) => c.omie_codigo_produto).join(", ");
    throw new Error(
      `${codigosAmbiguos!.length} código(s) de produto existem em mais de uma conta (ex.: ${amostra}). ` +
        `O MixGap casa o histórico por código quando product_id é nulo, SEM qualificar a conta — ` +
        `publicar regras segmentadas agora faria regra de uma conta alcançar cliente da outra.`,
    );
  }

  // O tipo declara a forma REAL da linha, INCLUSIVE o objeto embedado. Declarar só as duas
  // colunas era uma mentira de tipo — a resposta traz o `sales_orders` em cada uma das ~68 mil
  // linhas, e um tipo que esconde isso esconde também o custo de memória de quem for revisar.
  const items = await fetchAll<{
    sales_order_id: string | null;
    product_id: string | null;
    sales_orders: { status: string | null; deleted_at: string | null; account: string | null } | null;
  }>(
    (from, to) =>
      db
        .from("order_items")
        // `id` NÃO entra no select: o `.order()` não exige a coluna projetada (mesma
        // convenção de `useBundleEngine`), e são ~68 mil linhas — o uuid a mais seria
        // payload puro numa edge que já segura o universo inteiro em memória.
        // `account` entra no MESMO embed: segmentar com uma segunda leitura paginada seria
        // 2×K instantes (§14 — paginar não faz snapshot), e a conta que classifica a cesta
        // tem de vir do MESMO instante em que a cesta foi lida.
        .select("sales_order_id, product_id, sales_orders!inner(status, deleted_at, account)")
        .not("product_id", "is", null)
        .not("sales_orders.status", "in", STATUS_NAO_VENDA_POSTGREST)
        .is("sales_orders.deleted_at", null)
        .order("id", { ascending: true })
        .range(from, to),
    "order_items/assoc-rules",
  );

  // `items.length === 0` agora só pode ser "li a tabela inteira e não há item" — falha de
  // leitura virou exceção acima. Antes os dois estados chegavam aqui iguais.
  if (!items.length) return { rules_generated: 0, itens_lidos: 0 };

  // ── SEGMENTAÇÃO POR CONTA ────────────────────────────────────────────────────────────────
  // O Apriori roda uma vez POR SEGMENTO, com o MESMO `s_min`. O porquê (e os números medidos
  // em prod) está no cabeçalho de `_shared/apriori.ts`; o resumo é que `support` é razão, e
  // misturar as duas contas num denominador só afoga o sinal da menor: com o universo
  // corrigido pela Fatia 1, o global dá 2 regras e o segmentado dá 14 — sem tocar no piso.
  //
  // A leitura acima continua sendo UMA só: a partição é em MEMÓRIA, sobre as linhas que já
  // vieram. Ler duas vezes (uma por conta) seria trocar um instante por dois (§14).
  const { porSegmento, descartadas } = agruparCestasPorSegmento(
    items.map((item) => ({
      sales_order_id: item.sales_order_id,
      product_id: item.product_id,
      account: item.sales_orders?.account ?? null,
    })),
  );

  // ALLOWLIST. O helper é genérico de propósito (ele não conhece o negócio), mas o
  // ORQUESTRADOR tem de conhecer: uma conta que não é uma das empresas do grupo significa dado
  // sujo a montante, e publicar um segmento inventado é publicar um denominador que ninguém
  // sabe interpretar. `NULL` não é o único estado inválido — achado do challenge Codex xhigh.
  const CONTAS_CONHECIDAS: readonly Empresa[] = ["oben", "colacor", "colacor_sc"];
  const desconhecidos = Array.from(porSegmento.keys()).filter(
    (s) => !CONTAS_CONHECIDAS.includes(s as Empresa),
  );
  if (desconhecidos.length > 0) {
    throw new Error(
      `conta(s) não reconhecida(s) em sales_orders.account: ${desconhecidos.join(", ")}. ` +
        `As contas conhecidas são ${CONTAS_CONHECIDAS.join(", ")} — publicar um segmento ` +
        `inventado publicaria um denominador que nenhum consumidor sabe interpretar.`,
    );
  }

  const topRules: RegraAssoc[] = [];
  const porSegmentoRelato: Record<string, { cestas: number; regras: number; itens_frequentes: number; truncadas: number }> = {};
  let totalTx = 0;
  let itensFrequentes = 0;

  for (const [segmento, cestas] of porSegmento) {
    const r = calcularRegrasDoSegmento(segmento, cestas, {
      sMin: minSupport,
      lMin: minLift,
      // Teto POR SEGMENTO — ver `apriori.ts`. Um teto global deixaria a conta maior
      // dominar o corte, que é o mesmo defeito num eixo diferente.
      maxRegras: maxRules,
    });
    topRules.push(...r.regras);
    totalTx += r.totalCestas;
    itensFrequentes += r.itensFrequentes;
    porSegmentoRelato[segmento] = {
      cestas: r.totalCestas,
      regras: r.regras.length,
      itens_frequentes: r.itensFrequentes,
      truncadas: r.truncadas,
    };
  }

  // ⚠️ PERDA PARCIAL DE SEGMENTO — o buraco que o lote único abre, e que o TR001 NÃO cobre
  // (achado do challenge Codex xhigh). Um lote com 12 regras de oben e ZERO de colacor não está
  // vazio: ele passa em todas as validações e APAGA colacor da tabela. O sintoma seria "as
  // regras de uma das contas sumiram", sem erro nenhum e sem nada dizendo que houve perda.
  // Um segmento que rodou e não produziu regra é indistinguível, num array de regras, de um
  // segmento esquecido por bug — então a checagem tem de ser sobre os segmentos PROCESSADOS,
  // que só o produtor conhece. (A RPC guarda a outra metade: TR007 recusa o lote que perde um
  // segmento já publicado. As duas defesas cobrem lados diferentes e nenhuma cobre a outra.)
  const semRegras = Object.entries(porSegmentoRelato)
    .filter(([, s]) => s.regras === 0)
    .map(([seg, s]) => `${seg} (${s.cestas} cestas, ${s.itens_frequentes} itens frequentes)`);
  if (semRegras.length > 0 && topRules.length > 0) {
    throw new Error(
      `segmento(s) sem nenhuma regra: ${semRegras.join("; ")}. Publicar o lote apagaria as regras ` +
        `vigentes dessa(s) conta(s) e o consumidor não teria como saber que houve perda. ` +
        `Investigue o universo do segmento antes de recalcular.`,
    );
  }

  // O teto da RPC (TR003) é de 1.000 no LOTE INTEIRO, enquanto o `maxRules` é por segmento —
  // com 2 contas e o default de 500 o limite é justo, e com uma terceira conta o lote estouraria.
  // Falhar aqui, dizendo o número, é o oposto de truncar em silêncio: truncar faria o lote
  // publicado parecer completo, e seria a conta que ordena por último a perder as regras (§8).
  // ⚠️ A saída NÃO é "baixe o max": isso truncaria EVIDÊNCIA para caber na infraestrutura, e o
  // corte cairia sobre a conta menor (achado Codex xhigh). Quem precisa subir é o teto da RPC.
  if (topRules.length > 1000) {
    throw new Error(
      `lote de ${topRules.length} regras (${porSegmento.size} segmentos × max ${maxRules}/segmento) ` +
        `excede o teto de 1000 da RPC (TR003). Suba o teto da RPC por migration — baixar ` +
        `max_association_rules truncaria evidência real para caber na infraestrutura, e o corte ` +
        `cairia sobre o segmento que ordenar por último.`,
    );
  }

  // Troca ATÔMICA do lote. Antes: `delete()` de tudo seguido de um INSERT POR REGRA —
  // qualquer falha no meio deixava a tabela vazia ou PELA METADE, e o `error` só decrementava
  // um contador que ninguém lia (o retorno dizia "N regras geradas" e seguia em frente).
  // A tabela é global e alimenta MixGap, canal Melhorias, a edge `recommend` e o cross-sell.
  // A RPC faz DELETE+INSERT numa transação: falhou, as regras antigas continuam de pé.
  if (topRules.length === 0) {
    // Zero regra é sintoma de dado faltando a montante, não motivo pra apagar o que vale.
    // (A RPC recusaria com TR001; não chamamos só pra tomar o erro.)
    console.warn(`[AssocRules] 0 regras de ${totalTx} transações — regras vigentes preservadas`);
    return {
      rules_generated: 0,
      total_transactions: totalTx,
      frequent_items: itensFrequentes,
      preservadas: true,
      por_segmento: porSegmentoRelato,
    };
  }

  // LOTE ÚNICO com os dois segmentos, e a RPC segue trocando a tabela INTEIRA numa transação.
  // A alternativa (uma chamada por segmento, com `DELETE WHERE cluster_segment = …`) foi
  // descartada de propósito: ela quebraria a atomicidade que o #1840 construiu e criaria o
  // estado misto "colacor novo + oben velho" quando a segunda chamada falhasse — sem nada na
  // tabela dizendo que houve mistura de instantes. Com lote único os estados possíveis
  // continuam sendo dois: tudo velho, ou tudo novo.
  // `sample_size` e `cluster_segment` saem de CADA regra, não da soma: o denominador é o do
  // segmento que a gerou (§ "por que" em `apriori.ts`). Publicar `totalTx` aqui seria repor,
  // pela porta dos fundos, o denominador global que esta fatia existe para tirar.
  const { data: inserted, error: erroSubstituir } = await db.rpc("farmer_association_rules_substituir", {
    p_regras: topRules.map((rule) => ({
      antecedent_product_ids: rule.antecedent_product_ids,
      consequent_product_ids: rule.consequent_product_ids,
      support: rule.support,
      confidence: rule.confidence,
      lift: rule.lift,
      rule_type: rule.rule_type,
      sample_size: rule.sample_size,
      cluster_segment: rule.cluster_segment,
    })),
  });

  // `throw`, não log: quem chama (`compute_association_rules` / `sync_all`) precisa ver o
  // erro. Engolir aqui era o que fazia a falha virar "sucesso com 0 regras".
  if (erroSubstituir) {
    console.error(`[AssocRules] falha ao substituir as regras:`, erroSubstituir);
    throw new Error(`farmer_association_rules_substituir: ${erroSubstituir.message}`);
  }

  // PROVENIÊNCIA no payload, não só a contagem. O lote não tem coluna de origem/parâmetros
  // (isso é fatia própria), mas o retorno cai no registro de execução — e sem estes campos
  // "24 regras" e "2 regras" são indistinguíveis na auditoria, que foi exatamente como o cap
  // de 1.000 sobreviveu: o número publicado nunca vinha acompanhado do universo que o gerou.
  // A PROVENIÊNCIA agora é POR SEGMENTO — e é isso que torna o `support` publicado auditável.
  // Um total agregado ("14 regras de 30.257 cestas") esconderia justamente o que a fatia
  // corrige: qual denominador gerou qual regra. `por_segmento` cai no registro de execução, ao
  // lado do `cluster_segment` que vai para a tabela; os dois lados têm de bater.
  const detalhe = Object.entries(porSegmentoRelato)
    .map(([seg, s]) => `${seg}=${s.regras}r/${s.cestas}c${s.truncadas ? ` (${s.truncadas} truncadas)` : ""}`)
    .join(" ");
  console.log(
    `[AssocRules] ${inserted} regras de ${totalTx} cestas em ${porSegmento.size} segmento(s) ` +
      `[${detalhe}] (${items.length} itens lidos, ${descartadas} descartados) ` +
      `— s_min=${minSupport} l_min=${minLift} max=${maxRules}/segmento`,
  );
  return {
    rules_generated: inserted,
    total_transactions: totalTx,
    frequent_items: itensFrequentes,
    itens_lidos: items.length,
    itens_descartados: descartadas,
    segmentos: porSegmento.size,
    por_segmento: porSegmentoRelato,
    params: { s_min: minSupport, l_min: minLift, max_rules_por_segmento: maxRules },
  };
}

// ======== MAIN HANDLER ========

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // ⚠️ SONDA DE VERSÃO — logo após o gate (que já aceita x-cron-secret) e ANTES do createClient,
  // porque o valor da sonda é ser o único caminho sem custo. Ver versao.ts / _shared/sonda-versao.ts.
  //
  // O parse subiu para cá: `req.json()` é one-shot, então o corpo lido aqui é reaproveitado como
  // `action`/`account`/... abaixo, em vez de lido duas vezes. Dois desfechos mudam de forma, e os
  // dois para MELHOR: corpo com JSON inválido devolvia 500 pelo catch geral (erro do cliente
  // contado como falha nossa) e agora devolve 400; e corpo `null` estourava TypeError no
  // destructuring — agora vira `{}` e cai no "Ação desconhecida", que é o que ele sempre foi.
  let corpoBruto: unknown;
  try {
    corpoBruto = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") {
    return new Response(JSON.stringify(respostaSonda(VERSAO)), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (decisaoSonda.tipo === "ambiguo") {
    return new Response(JSON.stringify({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Corpo já consumido pela sonda acima. Não-objeto vira {} — cai no "Ação desconhecida" do
    // `default`, como antes.
    const { action, account = "vendas", start_page, max_pages } =
      (typeof corpoBruto === "object" && corpoBruto !== null ? corpoBruto : {}) as {
        action?: string;
        account?: string;
        start_page?: number;
        max_pages?: number;
      };
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
        result = await syncProducts(supabaseAdmin, account, start_page || 1, max_pages || MAX_PAGINAS_PRODUTOS);
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
          // O mapper guardava SÓ `rules_generated` e `total_transactions`. Com isso, os campos
          // de proveniência que a função passou a devolver (`itens_lidos`, `params`) eram
          // DESCARTADOS aqui — e o comentário que os introduziu prometia auditoria durável.
          // Promessa que o mapper desfaz é a mesma classe de "rótulo que não é fato": a
          // auditoria pareceria existir. Achado do challenge Codex xhigh, conferido na linha.
          // Sem estes campos, "24 regras" e "2 regras" são indistinguíveis no registro — que
          // é exatamente como o cap de 1.000 sobreviveu por tanto tempo.
          // ⚠️ Reincidiu na fatia do SEGMENTO (2026-08-21, mesmo challenge): a função passou a
          // devolver `por_segmento`/`segmentos`/`itens_descartados` — a proveniência do
          // DENOMINADOR de cada regra — e sem estes campos aqui a promessa de auditoria morria
          // de novo no mesmo lugar. É o par do `cluster_segment` que vai para a tabela: os dois
          // lados têm de bater, senão a coluna vira evidência inerte (nada com que confrontá-la).
          (r) => {
            const a = r as {
              rules_generated?: number;
              total_transactions?: number;
              itens_lidos?: number;
              itens_descartados?: number;
              segmentos?: number;
              por_segmento?: Record<string, unknown>;
              params?: Record<string, number>;
            };
            return {
              rules_generated: a.rules_generated ?? null,
              total_transactions: a.total_transactions ?? null,
              itens_lidos: a.itens_lidos ?? null,
              itens_descartados: a.itens_descartados ?? null,
              segmentos: a.segmentos ?? null,
              por_segmento: a.por_segmento ?? null,
              params: a.params ?? null,
            };
          },
        );
        break;
      case "sync_all": {
        // customers SAIU do sync_all: agora tem cron dedicado (sync-customers-vendas-daily) que chama
        // a action sync_customers em BACKGROUND. Rodar customers síncrono aqui dava WORKER_RESOURCE_LIMIT
        // e RE-prendia sync_state.customers em 'running' a cada passada — clobberava o estado curado.
        const acct = account as OmieAccount;
        result = await comRegistro(dbRegistro, "analytics_sync.sync_completo", auth, async () => {
          // orders REMOVIDO do sync_all (2026-06-24): syncOrdersIncremental foi aposentado (no-op que
          // poluía sales_price_history). A fonte de pedidos é a RPC criar_pedidos_com_itens (omie-vendas-sync).
          //
          // products REMOVIDO do sync_all (2026-08-25): era REDUNDANTE e TRUNCADO. Redundante porque
          // `omie-sync-metadados` (cron 30 8, accounts vendas+colacor_vendas) reescreve o catálogo
          // INTEIRO na MESMA tabela `omie_products`, com os MESMOS params da Omie (registros_por_pagina
          // 100, apenas_importado_api N, filtrar_apenas_omiepdv N) e um SUPERSET estrito de colunas
          // (as mesmas 15 + tipo_produto) — 2,5h DEPOIS, logo ela é a última escritora e vence.
          // Truncado porque este caminho herdava `maxPages` default e só varria as páginas 1–10.
          // Medido em 2026-08-25: omie_products oben 3.694/3.695 linhas frescas em 24h — se a
          // truncagem custasse frescor, ~2.700 estariam velhas. Custava só chamada de API à toa.
          // Dois escritores no mesmo espelho também violava "1 escritor por slug" (CLAUDE.md).
          // ⚠️ `colacor_vendas` NÃO foi mexido de propósito: o cron dedicado dele passa
          // `max_pages: 50` explícito e varre o catálogo COMPLETO — é redundância que serve de
          // failover, não truncagem. Aqui a redundância era cega.
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
          return { inventory, costs, assocRules };
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
        // `contrato` é o VERSION MARKER exigido por docs/agent/deploy.md §Canárias. Esta canária é o
        // caso NOMEADO em docs/historico/deploy-no-op-por-desenho.md: ela TINHA canária e mesmo
        // assim precisou de sonda de versão, porque respondia igual num bundle de hoje e num de três
        // fatias atrás — "ter canária não dispensa marcador". O nome NOMEIA a fatia que ela verifica:
        // o fail-closed do P1b (doc com >1 código no Omie não vira vínculo).
        // ⚠️ BUMP obrigatório a cada fatia que mude essa tabela-verdade.
        // `canary: true` acompanha o `probe_no_ar` histórico para a receita SQL do guia — que aqui
        // precisa descer no envelope `data` (esta edge responde `{success,data}`, não no topo).
        result = {
          success: true,
          canary: true,
          contrato: "doc-ambiguo-fail-closed-v1",
          probe_no_ar: true, // a action respondeu → o helper P1b está no build deployado
          ok: casosDoc.every((c) => c.ok), // true = a tabela-verdade deployada bate em TODOS os fixtures
          casos: casosDoc,
        };
        break;
      }
      case "transferencia_probe": {
        // CANÁRIA COMPORTAMENTAL do P1-c — NÃO escreve, NÃO chama o Omie, NÃO toca o DB. Roda o
        // `classificarLoteProof` DEPLOYADO (o bloco MIRROR deste arquivo, não o de src/) sobre fixtures
        // fixos. Mesma razão de existir da `doc_ambiguo_probe`: o Lovable JÁ reverteu um helper espelhado
        // num deploy (#1272/#1273), e a ausência DESTE é indetectável por sonda de dados — a relação
        // código↔user é 1:1 perfeita em prod (medido 2026-08-24), então no run normal o classificador
        // nunca é exercitado e sumiria sem deixar rastro. Só executá-lo sobre fixture sintético prova
        // que ele está no bundle.
        // Enumeração COMPLETA do oráculo (espelha src/lib/omie/omie-transferencia-codigo.test.ts): os
        // casos se falsificam MUTUAMENTE — um classificador sempre-"aplicar" reprova o caso de
        // transferência; um sempre-"transferencia" reprova os de criação/refresh.
        const U_A = "aaaaaaaa-0000-0000-0000-000000000001";
        const U_B = "bbbbbbbb-0000-0000-0000-000000000002";
        const inc = (u: string, c: number, src = "document") => ({ user_id: u, omie_codigo_cliente: c, source: src });
        const fixturesTc: Array<{
          caso: string;
          entradas: Array<{ user_id: string; omie_codigo_cliente: number }>;
          porCodigo: Array<{ user_id: string; omie_codigo_cliente: number; source: string }>;
          porUser: Array<{ user_id: string; omie_codigo_cliente: number; source: string }>;
          expected: Record<string, string>;
        }> = [
          // código livre → aplicar (o caminho de ~100% do volume)
          { caso: "codigo_livre", entradas: [{ user_id: U_A, omie_codigo_cliente: 100 }], porCodigo: [], porUser: [], expected: { [U_A]: "aplicar" } },
          // código já é DESTE user → aplicar (refresh diário, não é transferência)
          { caso: "refresh_mesmo_user", entradas: [{ user_id: U_A, omie_codigo_cliente: 100 }], porCodigo: [inc(U_A, 100)], porUser: [inc(U_A, 100)], expected: { [U_A]: "aplicar" } },
          // código de OUTRO user → transferencia (o coração do P1-c: NÃO aplica, vira conflito)
          { caso: "transferencia_de_dono", entradas: [{ user_id: U_B, omie_codigo_cliente: 100 }], porCodigo: [inc(U_A, 100)], porUser: [], expected: { [U_B]: "transferencia" } },
          // override HUMANO do próprio user → automação não rebaixa
          { caso: "manual_protegido", entradas: [{ user_id: U_A, omie_codigo_cliente: 100 }], porCodigo: [], porUser: [inc(U_A, 100, "manual")], expected: { [U_A]: "manual_protegido" } },
          // 2 users disputando o mesmo código DENTRO do lote → nenhum leva
          { caso: "disputa_intra_lote", entradas: [{ user_id: U_A, omie_codigo_cliente: 100 }, { user_id: U_B, omie_codigo_cliente: 100 }], porCodigo: [], porUser: [], expected: { [U_A]: "transferencia", [U_B]: "transferencia" } },
          // mesmo user repetido (duplicata da paginação do Omie) NÃO é disputa — senão zeraria vínculo bom
          { caso: "duplicata_paginacao", entradas: [{ user_id: U_A, omie_codigo_cliente: 100 }, { user_id: U_A, omie_codigo_cliente: 100 }], porCodigo: [], porUser: [], expected: { [U_A]: "aplicar" } },
        ];
        const casosTc = fixturesTc.map((f) => {
          const decid = classificarLoteProof(
            f.entradas,
            new Map(f.porCodigo.map((l) => [l.omie_codigo_cliente, l])),
            new Map(f.porUser.map((l) => [l.user_id, l])),
          );
          const resolved: Record<string, string> = {};
          for (const [u, d] of decid) resolved[u] = d.decisao;
          const chaves = Object.keys(f.expected).sort();
          const ok = chaves.length === Object.keys(resolved).length &&
            chaves.every((k) => resolved[k] === f.expected[k]);
          return { caso: f.caso, resolved, expected: f.expected, ok };
        });
        result = {
          canary: true,
          // VERSION MARKER (docs/agent/deploy.md §Canárias): responder já prova que o bundle no ar é o
          // desta árvore (senão viria "Ação desconhecida" = binário velho). ⚠️ BUMP obrigatório a cada
          // fatia que mude esta tabela-verdade.
          contrato: "transferencia-codigo-fail-closed-v1",
          ok: casosTc.every((c) => c.ok), // true = o classificador deployado bate em TODOS os fixtures
          casos: casosTc,
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
