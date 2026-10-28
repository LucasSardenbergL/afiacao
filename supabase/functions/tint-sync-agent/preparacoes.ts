// preparacoes.ts — /preparations e /preparations/plano do giro de corante (Fase 1, PR B).
// Contrato: docs/superpowers/plans/2026-10-27-giro-corante-fase1.md §"Contrato do payload /preparations".
//
// O que está em jogo (money-path + LGPD):
// - O lote é UMA fatia de uma extração com manifesto. A cobertura do giro é derivada das
//   extrações completas; se a edge gravasse a metade válida de um lote, o banco alegaria um dia
//   coberto com dosagens faltando (Foco de revisão #2). Então: um erro de protocolo reprova o
//   lote INTEIRO — nada é gravado, o run fecha em `error` e nada é enfileirado.
// - `cliente` (e qualquer chave fora da allowlist, em qualquer nível) é descartado ANTES de
//   validar, gravar ou logar. Os erros carregam só `{preparacao_id, motivo}`, nunca o objeto bruto.
//
// Testável com `deno test --no-remote` (preparacoes_test.ts) — o index.ts só monta as deps.

/** Espelho do CHECK `qtd_ml > 0 AND qtd_ml <= 18000` de `tint_consumo_corante`
 *  (migration 20261028100000) e do `qtdMlMax` do conector — teste de paridade no Go. */
export const QTD_ML_MAX = 18000;

/** Teto de preparações (válidas + rejeitadas) por lote — o mesmo `MAX_BATCH_ITEMS` das outras rotas. */
const MAX_LOTE = 1000;

const MODOS = ["backfill", "incremental", "rescan", "cura"] as const;
type ModoExtracao = typeof MODOS[number];

const MOTIVOS_REJEICAO = [
  "slot_parcial",
  "corante_nao_resolvido",
  "unidade",
  "peso_especifico_ausente",
  "qtd_fora_da_faixa",
] as const;

type ManifestoExtracao = {
  extracao_id: string;
  lote: number;
  total_lotes: number;
  modo: ModoExtracao;
  janela_desde: string;
  janela_ate: string;
  consultado_em: string;
  n_preparacoes: number;
  n_rejeitadas: number;
  n_itens: number;
  primeira_preparacao_id: string | null;
  ultima_preparacao_id: string | null;
};
type ItemPreparacao = {
  ordem: number;
  id_corante_origem: string;
  codigo_corante_origem: string | null;
  qtd_ml: number;
  peso_especifico: number | null;
};
type PreparacaoSaneada = { preparacao_id: string; data_dosagem: string; itens: ItemPreparacao[] };
type RejeitadaSaneada = { preparacao_id: string; data_dosagem: string; motivo: string };
export type LotePreparacoes = {
  manifesto: ManifestoExtracao;
  preparacoes: PreparacaoSaneada[];
  rejeitadas: RejeitadaSaneada[];
};
/** NUNCA carrega o objeto bruto: só o id e um motivo do vocabulário fixo. */
export type ErroLote = { preparacao_id: string | null; motivo: string };

export type AgentCtx = { settingId: string; account: string; storeCode: string; integrationMode: string };

// ─── helpers de forma ───

type Obj = Record<string, unknown>;

function ehObjeto(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ehInteiro(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function ehTextoNaoVazio(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// RFC3339 COM fuso obrigatório: um timestamp sem fuso o Postgres leria no fuso da sessão.
const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/** Instante em NANOssegundos desde a época, ou null se não for RFC3339 com fuso.
 *  `Date` só tem milissegundo; o conector manda µs/ns, e a fronteira `< janela_ate` precisa
 *  da precisão inteira (a mesma que o Postgres compara). */
export function instanteNs(s: unknown): bigint | null {
  if (typeof s !== "string") return null;
  const m = RFC3339.exec(s);
  if (!m) return null;
  const ms = Date.parse(m[1] + m[3]);
  if (Number.isNaN(ms)) return null;
  return BigInt(ms) * 1_000_000n + BigInt((m[2] ?? "").padEnd(9, "0"));
}

const codificador = new TextEncoder();

/** Ordem de BYTES (UTF-8) = a do Go e a do `COLLATE "C"`. A comparação nativa do JS é por
 *  unidade UTF-16 e diverge fora do BMP. */
function compararBytes(a: string, b: string): number {
  const x = codificador.encode(a);
  const y = codificador.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

// ─── saneamento + validação ───

/** Allowlist + validação do lote. Qualquer erro reprova o lote inteiro. */
export function sanearLotePreparacoes(
  body: unknown,
): { ok: true; lote: LotePreparacoes } | { ok: false; erros: ErroLote[] } {
  const erros: ErroLote[] = [];
  const erro = (preparacao_id: string | null, motivo: string) => erros.push({ preparacao_id, motivo });

  if (!ehObjeto(body)) return { ok: false, erros: [{ preparacao_id: null, motivo: "corpo_invalido" }] };
  const m = body.manifesto;
  if (!ehObjeto(m)) return { ok: false, erros: [{ preparacao_id: null, motivo: "manifesto_ausente" }] };
  if (!Array.isArray(body.preparacoes) || !Array.isArray(body.rejeitadas)) {
    return { ok: false, erros: [{ preparacao_id: null, motivo: "lote_malformado" }] };
  }

  // Manifesto
  if (typeof m.extracao_id !== "string" || !UUID.test(m.extracao_id)) erro(null, "manifesto_extracao_id");
  if (!ehInteiro(m.lote) || !ehInteiro(m.total_lotes) || m.lote < 1 || m.lote > m.total_lotes) {
    erro(null, "manifesto_lote");
  }
  if (!(MODOS as readonly unknown[]).includes(m.modo)) erro(null, "manifesto_modo");
  const desde = instanteNs(m.janela_desde);
  const ate = instanteNs(m.janela_ate);
  const consultado = instanteNs(m.consultado_em);
  const janelaOk = desde !== null && ate !== null && consultado !== null && desde < ate && ate <= consultado;
  if (!janelaOk) erro(null, "manifesto_janela");
  for (const k of ["n_preparacoes", "n_rejeitadas", "n_itens"] as const) {
    if (!ehInteiro(m[k]) || (m[k] as number) < 0) erro(null, "manifesto_contagem");
  }
  const faixaNula = m.primeira_preparacao_id === null && m.ultima_preparacao_id === null;
  const faixaTexto = ehTextoNaoVazio(m.primeira_preparacao_id) && ehTextoNaoVazio(m.ultima_preparacao_id);
  if (!faixaNula && !faixaTexto) erro(null, "manifesto_faixa");
  if (erros.length > 0) return { ok: false, erros };

  const manifesto: ManifestoExtracao = {
    extracao_id: m.extracao_id as string,
    lote: m.lote as number,
    total_lotes: m.total_lotes as number,
    modo: m.modo as ModoExtracao,
    janela_desde: m.janela_desde as string,
    janela_ate: m.janela_ate as string,
    consultado_em: m.consultado_em as string,
    n_preparacoes: m.n_preparacoes as number,
    n_rejeitadas: m.n_rejeitadas as number,
    n_itens: m.n_itens as number,
    primeira_preparacao_id: faixaTexto ? m.primeira_preparacao_id as string : null,
    ultima_preparacao_id: faixaTexto ? m.ultima_preparacao_id as string : null,
  };

  const vistos = new Set<string>();
  const ids: string[] = [];
  /** Id + data comuns a válidas e rejeitadas. Devolve o id saneado, ou null se já errou. */
  function cabecalho(p: Obj): { id: string; data: string } | null {
    if (!ehTextoNaoVazio(p.preparacao_id)) {
      erro(null, "preparacao_id_invalido");
      return null;
    }
    const id = p.preparacao_id;
    if (vistos.has(id)) {
      erro(id, "preparacao_duplicada");
      return null;
    }
    vistos.add(id);
    ids.push(id);
    const t = instanteNs(p.data_dosagem);
    if (t === null) {
      erro(id, "data_dosagem_invalida");
      return null;
    }
    if (t < desde! || t >= ate!) {
      erro(id, "dosagem_fora_da_janela");
      return null;
    }
    return { id, data: p.data_dosagem as string };
  }

  const preparacoes: PreparacaoSaneada[] = [];
  let nItens = 0;
  for (const bruto of body.preparacoes) {
    if (!ehObjeto(bruto)) {
      erro(null, "preparacao_malformada");
      continue;
    }
    const c = cabecalho(bruto);
    if (!c) continue;
    if (!Array.isArray(bruto.itens)) {
      erro(c.id, "itens_ausentes");
      continue;
    }
    const itens: ItemPreparacao[] = [];
    const ordens = new Set<number>();
    let falhou = false;
    for (const it of bruto.itens) {
      nItens++;
      if (!ehObjeto(it)) {
        erro(c.id, "item_malformado");
        falhou = true;
        continue;
      }
      if (!ehInteiro(it.ordem) || it.ordem < 1 || it.ordem > 6) {
        erro(c.id, "ordem_invalida");
        falhou = true;
        continue;
      }
      if (ordens.has(it.ordem)) {
        erro(c.id, "ordem_repetida");
        falhou = true;
        continue;
      }
      ordens.add(it.ordem);
      if (!ehTextoNaoVazio(it.id_corante_origem)) {
        erro(c.id, "corante_invalido");
        falhou = true;
        continue;
      }
      const codigo = it.codigo_corante_origem ?? null;
      if (codigo !== null && typeof codigo !== "string") {
        erro(c.id, "corante_invalido");
        falhou = true;
        continue;
      }
      const q = it.qtd_ml;
      if (typeof q !== "number" || !Number.isFinite(q) || q <= 0 || q > QTD_ML_MAX) {
        erro(c.id, "qtd_ml_fora_da_faixa");
        falhou = true;
        continue;
      }
      const pe = it.peso_especifico ?? null;
      if (pe !== null && (typeof pe !== "number" || !Number.isFinite(pe) || pe <= 0)) {
        erro(c.id, "peso_especifico_invalido");
        falhou = true;
        continue;
      }
      itens.push({
        ordem: it.ordem,
        id_corante_origem: it.id_corante_origem,
        codigo_corante_origem: codigo,
        qtd_ml: q,
        peso_especifico: pe,
      });
    }
    if (!falhou) preparacoes.push({ preparacao_id: c.id, data_dosagem: c.data, itens });
  }

  const rejeitadas: RejeitadaSaneada[] = [];
  for (const bruto of body.rejeitadas) {
    if (!ehObjeto(bruto)) {
      erro(null, "preparacao_malformada");
      continue;
    }
    const c = cabecalho(bruto);
    if (!c) continue;
    if (!(MOTIVOS_REJEICAO as readonly unknown[]).includes(bruto.motivo)) {
      erro(c.id, "motivo_rejeicao_invalido");
      continue;
    }
    rejeitadas.push({ preparacao_id: c.id, data_dosagem: c.data, motivo: bruto.motivo as string });
  }

  if (
    body.preparacoes.length !== manifesto.n_preparacoes ||
    body.rejeitadas.length !== manifesto.n_rejeitadas ||
    nItens !== manifesto.n_itens
  ) {
    erro(null, "manifesto_contagem");
  }

  // Faixa do lote: nula só no lote vazio; senão contém todo id (ordem de bytes), como o banco confere.
  if (ids.length === 0) {
    if (manifesto.primeira_preparacao_id !== null) erro(null, "manifesto_faixa");
  } else if (manifesto.primeira_preparacao_id === null || manifesto.ultima_preparacao_id === null) {
    erro(null, "manifesto_faixa");
  } else {
    const ini = manifesto.primeira_preparacao_id;
    const fim = manifesto.ultima_preparacao_id;
    if (compararBytes(ini, fim) > 0) erro(null, "manifesto_faixa");
    for (const id of ids) {
      if (compararBytes(id, ini) < 0 || compararBytes(id, fim) > 0) erro(id, "preparacao_fora_da_faixa_do_lote");
    }
  }

  if (erros.length > 0) return { ok: false, erros };
  return { ok: true, lote: { manifesto, preparacoes, rejeitadas } };
}

// ─── staging ───

/** Linhas das 3 tabelas de staging. Os ids dos cabeçalhos são gerados AQUI e cada item já sai
 *  com o `staging_preparacao_id` do seu cabeçalho: nada depende da ordem do `returning`. */
export function linhasDeStaging(
  lote: LotePreparacoes,
  ctx: { sync_run_id: string; account: string; store_code: string; novoId: () => string },
): { preparacoes: Record<string, unknown>[]; itens: Record<string, unknown>[]; manifesto: Record<string, unknown> } {
  const base = { sync_run_id: ctx.sync_run_id, account: ctx.account, store_code: ctx.store_code };
  const preparacoes: Record<string, unknown>[] = [];
  const itens: Record<string, unknown>[] = [];
  for (const p of lote.preparacoes) {
    const id = ctx.novoId();
    preparacoes.push({
      id,
      ...base,
      preparacao_id: p.preparacao_id,
      data_preparacao: p.data_dosagem,
      rejeicao_motivo: null,
      raw_data: p,
      staging_status: "pending",
    });
    for (const it of p.itens) {
      itens.push({
        sync_run_id: ctx.sync_run_id,
        staging_preparacao_id: id,
        id_corante: it.id_corante_origem,
        codigo_corante: it.codigo_corante_origem,
        ordem: it.ordem,
        qtd_ml: it.qtd_ml,
        peso_especifico: it.peso_especifico,
      });
    }
  }
  for (const r of lote.rejeitadas) {
    preparacoes.push({
      id: ctx.novoId(),
      ...base,
      preparacao_id: r.preparacao_id,
      data_preparacao: r.data_dosagem,
      rejeicao_motivo: r.motivo,
      raw_data: r,
      staging_status: "pending",
    });
  }
  return { preparacoes, itens, manifesto: { ...base, ...lote.manifesto } };
}

// ─── handler ───

export type RespostaRota = { status: number; corpo: Record<string, unknown> };

type Stats = Record<string, number>;

/** Dependências do handler: o index.ts as monta sobre o cliente Supabase do request. */
export type DepsPreparacoes = {
  /** Cabeçalho `x-idempotency-key` do request (null = sem idempotência). */
  idempotencyKey: string | null;
  /** Resposta gravada de um run anterior com a mesma chave efetiva, ou null. */
  checkIdempotency: (chave: string) => Promise<RespostaRota | null>;
  createSyncRun: (chave: string | null) => Promise<string | null | undefined>;
  /** LANÇA se o banco recusar (escritaCritica). */
  inserir: (tabela: string, linhas: Record<string, unknown>[]) => Promise<void>;
  logError: (runId: string, tipo: string, id: string | null, msg: string, det: Record<string, unknown>) => Promise<void>;
  completeSyncRun: (runId: string, stats: Stats, status: string, resp: Record<string, unknown>) => Promise<boolean>;
  concluirEEnfileirar: (runId: string, stats: Stats, resp: Record<string, unknown>) => Promise<RespostaRota>;
  novoId: () => string;
};

/** JSON canônico do lote SANEADO: as chaves saem sempre na mesma ordem (montadas acima). */
async function sha256Hex(texto: string): Promise<string> {
  const dig = await crypto.subtle.digest("SHA-256", codificador.encode(texto));
  return Array.from(new Uint8Array(dig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Chave efetiva = `<cabeçalho>:<sha256 do lote saneado>`: um reenvio com corpo diferente não
 *  recebe a resposta antiga (cai em run novo, e a promoção o recusa como `lote_duplicado`). */
export async function chaveEfetiva(cabecalho: string | null, lote: LotePreparacoes): Promise<string | null> {
  if (!cabecalho) return null;
  return `${cabecalho}:${await sha256Hex(JSON.stringify(lote))}`;
}

const MAX_ERROS_RESPOSTA = 50;

export async function processarPreparacoes(
  corpoTexto: string,
  agent: AgentCtx,
  deps: DepsPreparacoes,
): Promise<RespostaRota> {
  const inicio = Date.now();
  let body: unknown;
  try {
    body = JSON.parse(corpoTexto);
  } catch {
    // Sem a mensagem da exceção: ela pode citar um trecho do corpo.
    return { status: 400, corpo: { ok: false, error: "corpo_invalido" } };
  }
  if (ehObjeto(body)) {
    const n = (Array.isArray(body.preparacoes) ? body.preparacoes.length : 0) +
      (Array.isArray(body.rejeitadas) ? body.rejeitadas.length : 0);
    if (n > MAX_LOTE) return { status: 400, corpo: { ok: false, error: "lote_grande", max: MAX_LOTE } };
  }

  // Saneamento ANTES de qualquer log ou escrita.
  const s = sanearLotePreparacoes(body);

  if (!s.ok) {
    const runId = await deps.createSyncRun(null);
    if (!runId) return { status: 500, corpo: { ok: false, error: "falha_ao_criar_run" } };
    const errors = s.erros.slice(0, MAX_ERROS_RESPOSTA);
    const corpo = { ok: false, sync_run_id: runId, error: "lote_invalido", error_count: s.erros.length, errors };
    await deps.logError(runId, "preparacao", s.erros[0].preparacao_id, `lote reprovado: ${s.erros.length} erro(s)`, {
      erros: errors,
    }).catch(() => {});
    await deps.completeSyncRun(runId, { duration_ms: Date.now() - inicio, total: 0, errors: s.erros.length }, "error", corpo)
      .catch(() => false);
    // Nada gravado, nada enfileirado: o plano seguinte repete a janela com extracao_id novo.
    return { status: 422, corpo };
  }

  const lote = s.lote;
  const chave = await chaveEfetiva(deps.idempotencyKey, lote);
  if (chave) {
    const cached = await deps.checkIdempotency(chave);
    if (cached) return cached;
  }

  const runId = await deps.createSyncRun(chave);
  if (!runId) return { status: 500, corpo: { ok: false, error: "falha_ao_criar_run" } };

  const recebidos = lote.preparacoes.length + lote.rejeitadas.length;
  try {
    const linhas = linhasDeStaging(lote, {
      sync_run_id: runId,
      account: agent.account,
      store_code: agent.storeCode,
      novoId: deps.novoId,
    });
    await deps.inserir("tint_staging_preparacoes", linhas.preparacoes);
    await deps.inserir("tint_staging_preparacao_itens", linhas.itens);
    await deps.inserir("tint_staging_preparacao_manifestos", [linhas.manifesto]);
  } catch (e) {
    const nome = e instanceof Error ? e.name : "desconhecido";
    await deps.logError(runId, "preparacao", null, `falha ao gravar o staging (${nome})`, {}).catch(() => {});
    await deps.completeSyncRun(runId, { duration_ms: Date.now() - inicio, total: recebidos, errors: 1 }, "error", {
      ok: false,
      error: "erro_interno",
    }).catch(() => false);
    return { status: 500, corpo: { ok: false, error: "erro_interno", retry: true } };
  }

  const resp = {
    ok: true,
    sync_run_id: runId,
    batch_id: deps.idempotencyKey,
    idempotent_replay: false,
    received_count: recebidos,
    inserted_count: recebidos,
    updated_count: 0,
    ignored_count: 0,
    error_count: 0,
    errors: [],
  };
  return await deps.concluirEEnfileirar(
    runId,
    { duration_ms: Date.now() - inicio, total: recebidos, inserts: recebidos, updates: 0, errors: 0 },
    resp,
  );
}

// ─── plano ───

/** Resposta de `/preparations/plano` a partir do RPC `tint_consumo_plano_extracao`. Erro do RPC,
 *  ou um corpo fora do contrato, é 500 — NUNCA "zero janelas" (o conector leria "nada a fazer"). */
export function respostaDoPlano(data: unknown, error: unknown): RespostaRota {
  if (error) return { status: 500, corpo: { ok: false, error: "plano_indisponivel" } };
  if (!ehObjeto(data) || data.ok !== true || !Array.isArray(data.janelas) || !ehInteiro(data.max_lotes)) {
    return { status: 500, corpo: { ok: false, error: "plano_fora_do_contrato" } };
  }
  for (const j of data.janelas) {
    if (
      !ehObjeto(j) || typeof j.extracao_id !== "string" || !UUID.test(j.extracao_id) ||
      !(MODOS as readonly unknown[]).includes(j.modo) || instanteNs(j.desde) === null || instanteNs(j.ate) === null
    ) {
      return { status: 500, corpo: { ok: false, error: "plano_fora_do_contrato" } };
    }
  }
  return { status: 200, corpo: data };
}
