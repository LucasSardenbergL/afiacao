// preparacoes_test.ts — contrato de /preparations e /preparations/plano (giro de corante, PR B).
// Roda no CI via `bun run test:edges` (deno test --no-remote) — SEM import remoto.
//
// O que está em jogo: (1) LGPD — `cliente` nunca chega a staging, log ou resposta; (2) money-path —
// um lote com UMA preparação inválida não grava nada (senão a cobertura alegaria o dia inteiro).
import {
  type AgentCtx,
  chaveEfetiva,
  type DepsPreparacoes,
  instanteNs,
  linhasDeStaging,
  processarPreparacoes,
  QTD_ML_MAX,
  respostaDoPlano,
  type RespostaRota,
  sanearLotePreparacoes,
} from "./preparacoes.ts";

function assertEq(atual: unknown, esperado: unknown, msg: string) {
  if (!Object.is(atual, esperado)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(atual)}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const EXTRACAO = "6f1c2a10-0000-4000-8000-000000000001";
const DESDE = "2026-10-20T03:00:00Z"; // meia-noite SP
const ATE = "2026-10-21T03:00:00Z";

type Corpo = Record<string, unknown> & {
  manifesto: Record<string, unknown>;
  preparacoes: Record<string, unknown>[];
  rejeitadas: Record<string, unknown>[];
};

function prep(id: string, itens: Record<string, unknown>[] = [{ ordem: 1, id_corante_origem: "12", codigo_corante_origem: "WP07", qtd_ml: 12.5, peso_especifico: 1.95 }], data = "2026-10-20T15:00:00Z") {
  return { preparacao_id: id, data_dosagem: data, itens };
}

/** Corpo coerente: o manifesto é recalculado a partir das listas. */
function corpo(preparacoes: Record<string, unknown>[], rejeitadas: Record<string, unknown>[] = [], extra: Record<string, unknown> = {}): Corpo {
  const ids = [...preparacoes, ...rejeitadas].map((p) => p.preparacao_id as string).sort();
  const nItens = preparacoes.reduce((s, p) => s + ((p.itens as unknown[] | undefined)?.length ?? 0), 0);
  return {
    manifesto: {
      extracao_id: EXTRACAO,
      lote: 1,
      total_lotes: 1,
      modo: "incremental",
      janela_desde: DESDE,
      janela_ate: ATE,
      consultado_em: "2026-10-21T03:05:00.123456Z",
      n_preparacoes: preparacoes.length,
      n_rejeitadas: rejeitadas.length,
      n_itens: nItens,
      primeira_preparacao_id: ids[0] ?? null,
      ultima_preparacao_id: ids[ids.length - 1] ?? null,
      ...extra,
    },
    preparacoes,
    rejeitadas,
  };
}

function motivos(r: ReturnType<typeof sanearLotePreparacoes>): string[] {
  return r.ok ? [] : r.erros.map((e) => e.motivo);
}

// ─── Task 5: módulo puro ───

Deno.test("descarta cliente e chaves fora da allowlist em todos os níveis", () => {
  const p = { ...prep("A"), cliente: "Fulano", preco: 99.9, nome_cor: "AZUL" };
  (p.itens[0] as Record<string, unknown>).cliente = "Fulano";
  (p.itens[0] as Record<string, unknown>).preco = 1;
  const c = corpo([p], [{ preparacao_id: "B", data_dosagem: "2026-10-20T16:00:00Z", motivo: "slot_parcial", cliente: "Fulano" }]);
  (c.manifesto as Record<string, unknown>).cliente = "Fulano";
  c.cliente = "Fulano";
  const r = sanearLotePreparacoes(c);
  assert(r.ok, "lote coerente deveria passar");
  const txt = JSON.stringify(r);
  assert(!txt.includes("cliente"), "cliente vazou no lote saneado");
  assert(!txt.includes("Fulano"), "valor de cliente vazou");
  assert(!txt.includes("preco"), "preco vazou");
  assert(!txt.includes("nome_cor"), "nome_cor vazou");
});

Deno.test("preparação inválida reprova o lote inteiro", () => {
  const c = corpo([prep("A"), prep("B"), prep("C"), prep("D", [{ ordem: 1, id_corante_origem: "12", qtd_ml: 0 }])]);
  const r = sanearLotePreparacoes(c);
  assert(!r.ok, "lote com 1 inválida tem de reprovar");
  if (r.ok) return;
  assertEq(r.erros.length, 1, "um erro");
  assertEq(r.erros[0].preparacao_id, "D", "id da inválida");
  assertEq(r.erros[0].motivo, "qtd_ml_fora_da_faixa", "motivo");
});

Deno.test("erro nunca carrega o objeto bruto", () => {
  const ruim = { ...prep("D", [{ ordem: 9, id_corante_origem: "12", qtd_ml: 1 }]), cliente: "Fulano" };
  const r = sanearLotePreparacoes(corpo([ruim]));
  assert(!r.ok, "deveria reprovar");
  assert(!JSON.stringify(r).includes("Fulano"), "erro carregou o objeto bruto");
});

Deno.test("manifesto obrigatório e coerente", () => {
  assertEq(motivos(sanearLotePreparacoes({ preparacoes: [], rejeitadas: [] }))[0], "manifesto_ausente", "ausente");
  assert(motivos(sanearLotePreparacoes(corpo([], [], { lote: 2, total_lotes: 1 }))).includes("manifesto_lote"), "lote > total");
  assert(motivos(sanearLotePreparacoes(corpo([], [], { lote: 0 }))).includes("manifesto_lote"), "lote 0");
  assert(motivos(sanearLotePreparacoes(corpo([], [], { janela_ate: DESDE }))).includes("manifesto_janela"), "desde = ate");
  assert(
    motivos(sanearLotePreparacoes(corpo([], [], { consultado_em: "2026-10-21T02:59:59.999999Z" }))).includes("manifesto_janela"),
    "consultado < ate",
  );
  assert(motivos(sanearLotePreparacoes(corpo([], [], { janela_ate: "2026-10-21T00:00:00" }))).includes("manifesto_janela"), "sem fuso");
  assert(motivos(sanearLotePreparacoes(corpo([prep("A")], [], { n_itens: 2 }))).includes("manifesto_contagem"), "n_itens");
  assert(motivos(sanearLotePreparacoes(corpo([prep("A")], [], { n_preparacoes: 0 }))).includes("manifesto_contagem"), "n_prep");
  assert(motivos(sanearLotePreparacoes(corpo([], [], { n_rejeitadas: 1 }))).includes("manifesto_contagem"), "n_rej");
  assert(motivos(sanearLotePreparacoes(corpo([], [], { modo: "x" }))).includes("manifesto_modo"), "modo");
  assert(motivos(sanearLotePreparacoes(corpo([], [], { extracao_id: "nao-uuid" }))).includes("manifesto_extracao_id"), "uuid");
});

Deno.test("faixa do lote: nula só no lote vazio e contém todo id", () => {
  assert(motivos(sanearLotePreparacoes(corpo([prep("A")], [], { primeira_preparacao_id: null, ultima_preparacao_id: null })))
    .includes("manifesto_faixa"), "faixa nula com preparação");
  assert(motivos(sanearLotePreparacoes(corpo([], [], { primeira_preparacao_id: "A", ultima_preparacao_id: "B" })))
    .includes("manifesto_faixa"), "faixa em lote vazio");
  assert(motivos(sanearLotePreparacoes(corpo([prep("A"), prep("M")], [], { ultima_preparacao_id: "K" })))
    .includes("manifesto_faixa"), "id fora da faixa");
  // Faixa MAIS LARGA que o lote: a promoção exige min/max exatos (Codex PR B, P2).
  assert(motivos(sanearLotePreparacoes(corpo([prep("B")], [], { primeira_preparacao_id: "A", ultima_preparacao_id: "C" })))
    .includes("manifesto_faixa"), "faixa [A,C] com só B");
  // Ordem de BYTES, não de UTF-16: "\u{1F600}" (F0 9F…) > "�" (EF BF BD) em bytes; o JS nativo diz o contrário.
  const r = sanearLotePreparacoes(corpo([prep("�"), prep("\u{1F600}")], [], {
    primeira_preparacao_id: "�",
    ultima_preparacao_id: "\u{1F600}",
  }));
  assert(r.ok, `faixa em ordem de bytes deveria passar: ${JSON.stringify(motivos(r))}`);
});

Deno.test("preparacao_id único no lote", () => {
  assert(motivos(sanearLotePreparacoes(corpo([prep("A"), prep("A")]))).includes("preparacao_duplicada"), "entre válidas");
  assert(
    motivos(sanearLotePreparacoes(corpo([prep("A")], [{ preparacao_id: "A", data_dosagem: "2026-10-20T16:00:00Z", motivo: "unidade" }])))
      .includes("preparacao_duplicada"),
    "entre válida e rejeitada",
  );
});

Deno.test("dosagem dentro da janela", () => {
  assert(motivos(sanearLotePreparacoes(corpo([prep("A", undefined, ATE)]))).includes("dosagem_fora_da_janela"), "= ate");
  assert(motivos(sanearLotePreparacoes(corpo([prep("A", undefined, "2026-10-20T02:59:59.999999Z")]))).includes("dosagem_fora_da_janela"), "< desde");
  // Precisão de µs: 1 µs antes do `ate` entra (Date só teria ms e arredondaria para o `ate`).
  assert(sanearLotePreparacoes(corpo([prep("A", undefined, "2026-10-21T02:59:59.999999Z")])).ok, "ate − 1 µs entra");
  assert(sanearLotePreparacoes(corpo([prep("A", undefined, DESDE)])).ok, "= desde entra");
  // Fuso diferente, mesmo instante: 2026-10-21T00:00:00-03:00 = ATE → fora.
  assert(motivos(sanearLotePreparacoes(corpo([prep("A", undefined, "2026-10-21T00:00:00-03:00")]))).includes("dosagem_fora_da_janela"), "offset");
});

Deno.test("itens apontam o cabeçalho pelo id, não pela posição", () => {
  const r = sanearLotePreparacoes(corpo([
    prep("A", [{ ordem: 2, id_corante_origem: "5", qtd_ml: 3 }, { ordem: 1, id_corante_origem: "12", qtd_ml: 4 }]),
    prep("B", [{ ordem: 1, id_corante_origem: "11", qtd_ml: 7 }]),
  ], [{ preparacao_id: "C", data_dosagem: "2026-10-20T16:00:00Z", motivo: "corante_nao_resolvido" }]));
  assert(r.ok, "coerente");
  if (!r.ok) return;
  let n = 0;
  const l = linhasDeStaging(r.lote, { sync_run_id: "run1", account: "oben", store_code: "M01", novoId: () => `id-${++n}` });
  const idDe = new Map(l.preparacoes.map((p) => [p.preparacao_id as string, p.id as string]));
  // Embaralha os itens: a associação não pode depender da posição.
  const itens = [...l.itens].reverse();
  const deA = itens.filter((i) => i.staging_preparacao_id === idDe.get("A")).map((i) => i.id_corante).sort();
  const deB = itens.filter((i) => i.staging_preparacao_id === idDe.get("B")).map((i) => i.id_corante);
  assertEq(JSON.stringify(deA), JSON.stringify(["12", "5"]), "itens de A");
  assertEq(JSON.stringify(deB), JSON.stringify(["11"]), "itens de B");
  assertEq(new Set(l.preparacoes.map((p) => p.id)).size, 3, "ids distintos");
  const c = l.preparacoes.find((p) => p.preparacao_id === "C")!;
  assertEq(c.rejeicao_motivo, "corante_nao_resolvido", "rejeitada vira cabeçalho com motivo");
  assertEq(itens.filter((i) => i.staging_preparacao_id === c.id).length, 0, "rejeitada sem itens");
  assertEq(l.manifesto.sync_run_id, "run1", "manifesto do run");
  assertEq(l.manifesto.extracao_id, EXTRACAO, "manifesto da extração");
});

Deno.test("ordem 1..6 sem repetição na preparação", () => {
  assert(motivos(sanearLotePreparacoes(corpo([prep("A", [{ ordem: 7, id_corante_origem: "1", qtd_ml: 1 }])]))).includes("ordem_invalida"), "7");
  assert(motivos(sanearLotePreparacoes(corpo([prep("A", [{ ordem: 0, id_corante_origem: "1", qtd_ml: 1 }])]))).includes("ordem_invalida"), "0");
  assert(motivos(sanearLotePreparacoes(corpo([prep("A", [{ ordem: 1.5, id_corante_origem: "1", qtd_ml: 1 }])]))).includes("ordem_invalida"), "1.5");
  assert(
    motivos(sanearLotePreparacoes(corpo([prep("A", [{ ordem: 1, id_corante_origem: "1", qtd_ml: 1 }, { ordem: 1, id_corante_origem: "2", qtd_ml: 1 }])])))
      .includes("ordem_repetida"),
    "repetida",
  );
});

Deno.test("qtd_ml finita, > 0 e <= 18000", () => {
  assertEq(QTD_ML_MAX, 18000, "espelho do CHECK");
  // NaN/Infinity não existem em JSON: chegam como string ou null, e string também é recusada.
  for (const q of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 18000.5, "12", null]) {
    const r = sanearLotePreparacoes(corpo([prep("A", [{ ordem: 1, id_corante_origem: "1", qtd_ml: q }])]));
    assert(motivos(r).includes("qtd_ml_fora_da_faixa"), `qtd ${String(q)} deveria reprovar`);
  }
  assert(sanearLotePreparacoes(corpo([prep("A", [{ ordem: 1, id_corante_origem: "1", qtd_ml: 18000 }])])).ok, "18000 aceito");
  assert(sanearLotePreparacoes(corpo([prep("A", [{ ordem: 1, id_corante_origem: "1", qtd_ml: 0.01 }])])).ok, "0,01 aceito");
});

Deno.test("rejeitada só com motivo do vocabulário", () => {
  assert(
    motivos(sanearLotePreparacoes(corpo([], [{ preparacao_id: "A", data_dosagem: "2026-10-20T16:00:00Z", motivo: "outro" }])))
      .includes("motivo_rejeicao_invalido"),
    "motivo fora",
  );
});

Deno.test("delta vazio é um lote válido", () => {
  const r = sanearLotePreparacoes(corpo([]));
  assert(r.ok, `lote vazio deveria passar: ${JSON.stringify(motivos(r))}`);
});

Deno.test("linhasDeStaging não tem cliente e grava raw_data saneado", () => {
  const r = sanearLotePreparacoes(corpo([{ ...prep("A"), cliente: "Fulano" }]));
  assert(r.ok, "coerente");
  if (!r.ok) return;
  const l = linhasDeStaging(r.lote, { sync_run_id: "run1", account: "oben", store_code: "M01", novoId: () => "x" });
  const txt = JSON.stringify(l);
  assert(!txt.includes("cliente") && !txt.includes("Fulano"), "cliente nas linhas de staging");
  const raw = l.preparacoes[0].raw_data as Record<string, unknown>;
  assertEq(JSON.stringify(Object.keys(raw)), JSON.stringify(["preparacao_id", "data_dosagem", "itens"]), "raw_data saneado");
  assertEq(l.preparacoes[0].data_preparacao, "2026-10-20T15:00:00Z", "data_preparacao = data_dosagem");
  assertEq(l.itens[0].codigo_corante, "WP07", "código separado do id");
  assertEq(l.itens[0].id_corante, "12", "id bruto");
  assertEq(l.itens[0].peso_especifico, 1.95, "peso específico");
});

Deno.test("instanteNs: µs no máximo e calendário real (o Postgres arredondaria / Date normalizaria)", () => {
  assertEq(instanteNs("2026-10-21T02:59:59.9999999Z"), null, "7º dígito não-zero");
  assert(instanteNs("2026-10-21T02:59:59.999999000Z") !== null, "zeros além do µs são aceitos");
  assertEq(instanteNs("2026-02-30T03:00:00Z"), null, "30 de fevereiro");
  assertEq(instanteNs("2026-10-21T24:00:00Z"), null, "24h");
  assertEq(instanteNs("2026-10-21T03:00:00+24:00"), null, "offset 24h");
});

Deno.test("instanteNs: precisão de ns e fuso obrigatório", () => {
  assertEq(instanteNs("2026-10-21T03:00:00Z")! - instanteNs("2026-10-21T02:59:59.999999Z")!, 1000n, "1 µs");
  assertEq(instanteNs("2026-10-21T00:00:00-03:00"), instanteNs("2026-10-21T03:00:00Z"), "offset");
  assertEq(instanteNs("2026-10-21T03:00:00"), null, "sem fuso");
  assertEq(instanteNs("2026-13-40T03:00:00Z"), null, "data inválida");
});

Deno.test("chave efetiva muda com o corpo e some sem cabeçalho", async () => {
  const a = sanearLotePreparacoes(corpo([prep("A")]));
  const b = sanearLotePreparacoes(corpo([prep("A", [{ ordem: 1, id_corante_origem: "12", qtd_ml: 13 }])]));
  assert(a.ok && b.ok, "coerentes");
  if (!a.ok || !b.ok) return;
  const ka = await chaveEfetiva(`${EXTRACAO}:1`, a.lote);
  const kb = await chaveEfetiva(`${EXTRACAO}:1`, b.lote);
  assert(ka !== null && ka.startsWith(`${EXTRACAO}:1:`), "prefixo = cabeçalho");
  assert(ka !== kb, "corpo diferente → chave diferente");
  assertEq(await chaveEfetiva(`${EXTRACAO}:1`, a.lote), ka, "determinística");
  assertEq(await chaveEfetiva(null, a.lote), null, "sem cabeçalho");
});

// ─── Task 6: handler executado com deps falsas ───

const SENTINELA = "CPF 123.456.789-09 Fulano";
const AGENTE: AgentCtx = { settingId: "s1", account: "oben", storeCode: "M01", integrationMode: "automatic_primary" };

type Captura = {
  runs: (string | null)[];
  inserts: { tabela: string; linhas: Record<string, unknown>[] }[];
  logs: unknown[];
  completes: { status: string; resp: unknown; extra?: Record<string, unknown> }[];
  enfileirados: unknown[];
  idem: string[];
};

function depsFalsas(opts: { cached?: RespostaRota; falhaInsert?: string; key?: string | null } = {}): { deps: DepsPreparacoes; cap: Captura } {
  // ⚠️ concluirEEnfileirar daqui SEMPRE enfileira: o modo sem promoção é barrado ANTES (teste próprio).
  const cap: Captura = { runs: [], inserts: [], logs: [], completes: [], enfileirados: [], idem: [] };
  let n = 0;
  const deps: DepsPreparacoes = {
    idempotencyKey: opts.key === undefined ? `${EXTRACAO}:1` : opts.key,
    checkIdempotency: (chave) => {
      cap.idem.push(chave);
      return Promise.resolve(opts.cached ?? null);
    },
    createSyncRun: (chave) => {
      cap.runs.push(chave);
      return Promise.resolve("run-1");
    },
    inserir: (tabela, linhas) => {
      if (opts.falhaInsert === tabela) return Promise.reject(new Error(`falhou com ${SENTINELA}`));
      cap.inserts.push({ tabela, linhas });
      return Promise.resolve();
    },
    logError: (...args) => {
      cap.logs.push(args);
      return Promise.resolve();
    },
    completeSyncRun: (_run, _stats, status, resp, extra) => {
      cap.completes.push({ status, resp, extra });
      return Promise.resolve(true);
    },
    concluirEEnfileirar: (_run, _stats, resp) => {
      cap.enfileirados.push(resp);
      return Promise.resolve({ status: 200, corpo: { ...resp, promocao: "pendente" } });
    },
    novoId: () => `id-${++n}`,
  };
  return { deps, cap };
}

function semSentinela(cap: Captura, r: RespostaRota, caso: string) {
  const tudo = JSON.stringify({ cap, r });
  assert(!tudo.includes("Fulano") && !tudo.includes("123.456.789-09"), `${caso}: sentinela vazou em ${tudo.slice(0, 300)}`);
}

Deno.test("handler: lote válido com sentinela grava saneado e enfileira", async () => {
  const c = corpo([{ ...prep("A"), cliente: SENTINELA }], [{ preparacao_id: "B", data_dosagem: "2026-10-20T16:00:00Z", motivo: "unidade", cliente: SENTINELA }]);
  const { deps, cap } = depsFalsas();
  const r = await processarPreparacoes(JSON.stringify(c), AGENTE, deps);
  assertEq(r.status, 200, "200");
  assertEq(r.corpo.ok, true, "ok");
  assertEq(JSON.stringify(cap.inserts.map((i) => i.tabela)), JSON.stringify([
    "tint_staging_preparacoes",
    "tint_staging_preparacao_itens",
    "tint_staging_preparacao_manifestos",
  ]), "3 inserts na ordem");
  assertEq(cap.enfileirados.length, 1, "enfileirou");
  assertEq(cap.idem.length, 1, "consultou a idempotência");
  assert(cap.runs[0] !== null && cap.runs[0]!.startsWith(`${EXTRACAO}:1:`) && cap.runs[0]!.length > `${EXTRACAO}:1:`.length + 60, "run com a chave efetiva (cabeçalho + sha256)");
  semSentinela(cap, r, "válido");
});

Deno.test("handler: lote inválido com sentinela → nada gravado, run error, sem fila", async () => {
  const c = corpo([{ ...prep("A"), cliente: SENTINELA }, { ...prep("B", [{ ordem: 1, id_corante_origem: "1", qtd_ml: 0, cliente: SENTINELA }]), cliente: SENTINELA }]);
  const { deps, cap } = depsFalsas();
  const r = await processarPreparacoes(JSON.stringify(c), AGENTE, deps);
  assertEq(r.corpo.ok, false, "ok:false");
  assertEq(r.status, 422, "422");
  assertEq(cap.inserts.length, 0, "nenhuma linha de staging");
  assertEq(cap.enfileirados.length, 0, "nada enfileirado");
  assertEq(cap.completes.length, 1, "run fechado");
  assertEq(cap.completes[0].status, "error", "run em error");
  assertEq(cap.idem.length, 0, "lote inválido não consulta idempotência");
  assertEq(cap.runs[0], null, "run de lote inválido sem chave");
  const erros = r.corpo.errors as { preparacao_id: string; motivo: string }[];
  assertEq(erros[0].preparacao_id, "B", "diagnóstico com o id");
  assertEq(erros[0].motivo, "qtd_ml_fora_da_faixa", "diagnóstico com o motivo");
  semSentinela(cap, r, "inválido");
});

Deno.test("handler: JSON quebrado → corpo_invalido, 0 runs, sem eco do corpo", async () => {
  const { deps, cap } = depsFalsas();
  const r = await processarPreparacoes(`{"cliente":"${SENTINELA}", "manifesto": {`, AGENTE, deps);
  assertEq(r.status, 400, "400");
  assertEq(r.corpo.error, "corpo_invalido", "corpo_invalido");
  assertEq(cap.runs.length, 0, "0 createSyncRun");
  semSentinela(cap, r, "json quebrado");
});

Deno.test("handler: falha de escrita → 500 erro_interno, run error, sem fila e sem a mensagem da exceção", async () => {
  const c = corpo([{ ...prep("A"), cliente: SENTINELA }]);
  const { deps, cap } = depsFalsas({ falhaInsert: "tint_staging_preparacao_itens" });
  const r = await processarPreparacoes(JSON.stringify(c), AGENTE, deps);
  assertEq(r.status, 500, "500");
  assertEq(r.corpo.error, "erro_interno", "erro_interno");
  assertEq(cap.enfileirados.length, 0, "não enfileira");
  assertEq(cap.completes[0]?.status, "error", "run error");
  assertEq(cap.completes[0]?.extra?.idempotency_key, null, "chave liberada: o reenvio do mesmo lote não cai em 409");
  semSentinela(cap, r, "falha de escrita");
});

Deno.test("handler: loja sem promoção (shadow/csv) é recusada antes de qualquer escrita", async () => {
  for (const modo of ["shadow_mode", "csv_only"]) {
    const { deps, cap } = depsFalsas();
    const r = await processarPreparacoes(JSON.stringify(corpo([prep("A")])), { ...AGENTE, integrationMode: modo }, deps);
    assertEq(r.status, 422, `${modo}: 422`);
    assertEq(r.corpo.error, "modo_sem_promocao", `${modo}: motivo`);
    assertEq(cap.runs.length + cap.inserts.length + cap.enfileirados.length, 0, `${modo}: nada escrito`);
  }
});

Deno.test("handler: replay idempotente devolve a resposta gravada sem novo run", async () => {
  const gravada: RespostaRota = { status: 200, corpo: { ok: true, idempotent_replay: true } };
  const { deps, cap } = depsFalsas({ cached: gravada });
  const r = await processarPreparacoes(JSON.stringify(corpo([prep("A")])), AGENTE, deps);
  assertEq(r, gravada, "resposta gravada");
  assertEq(cap.runs.length, 0, "sem run novo");
});

Deno.test("handler: lote acima de 1000 → 400 sem run", async () => {
  const muitas = Array.from({ length: 1001 }, (_, i) => prep(`P${String(i).padStart(5, "0")}`));
  const { deps, cap } = depsFalsas();
  const r = await processarPreparacoes(JSON.stringify(corpo(muitas)), AGENTE, deps);
  assertEq(r.status, 400, "400");
  assertEq(r.corpo.error, "lote_grande", "lote_grande");
  assertEq(cap.runs.length, 0, "sem run");
});

// ─── plano ───

Deno.test("plano: erro do RPC é 500, nunca zero janelas", () => {
  const r = respostaDoPlano(null, { message: "x" });
  assertEq(r.status, 500, "500");
  assertEq(r.corpo.ok, false, "ok:false");
  assert(!("janelas" in r.corpo), "sem janelas");
});

Deno.test("plano: corpo fora do contrato é 500", () => {
  assertEq(respostaDoPlano({ ok: false, janelas: [] }, null).status, 500, "ok:false");
  assertEq(respostaDoPlano({ ok: true, max_lotes: 20 }, null).status, 500, "sem janelas");
  assertEq(respostaDoPlano({ ok: true, janelas: [], max_lotes: null }, null).status, 500, "sem max_lotes");
  assertEq(respostaDoPlano({ ok: true, janelas: [{ extracao_id: EXTRACAO, modo: "x", desde: DESDE, ate: ATE }], max_lotes: 20, motivo: null }, null).status, 500, "modo");
  assertEq(respostaDoPlano({ ok: true, janelas: [], max_lotes: 0, motivo: "em_andamento" }, null).status, 500, "max_lotes 0");
  assertEq(respostaDoPlano({ ok: true, janelas: [], max_lotes: 20, motivo: "erro" }, null).status, 500, "motivo fora do vocabulário");
  assertEq(respostaDoPlano({ ok: true, janelas: [], max_lotes: 20 }, null).status, 500, "sem a chave motivo");
  const j = { extracao_id: EXTRACAO, modo: "cura", desde: DESDE, ate: ATE };
  assertEq(respostaDoPlano({ ok: true, janelas: [j, j, j], max_lotes: 20, motivo: null }, null).status, 500, "3 janelas");
  assertEq(respostaDoPlano({ ok: true, janelas: [{ ...j, desde: ATE, ate: DESDE }], max_lotes: 20, motivo: null }, null).status, 500, "desde > ate");
});

Deno.test("plano: em_andamento com zero janelas é 200 e repassa o corpo", () => {
  const d = { ok: true, janelas: [], max_lotes: 20, motivo: "em_andamento" };
  const r = respostaDoPlano(d, null);
  assertEq(r.status, 200, "200");
  assertEq(r.corpo, d, "corpo repassado");
  const d2 = { ok: true, janelas: [{ extracao_id: EXTRACAO, modo: "cura", desde: DESDE, ate: ATE }], max_lotes: 20, motivo: null };
  assertEq(respostaDoPlano(d2, null).status, 200, "janela válida");
});
