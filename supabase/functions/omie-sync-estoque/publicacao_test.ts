// A orquestração da publicação EXECUTADA com escritas falsas que registram cada efeito — a prova que a guarda textual
// não dá (desenho da v1.6, Codex 2026-10-06: "C1/C2 devem impedir upsert, inativação e observação"). Cada teste casa a
// MARCA do ramo e a lista de efeitos, não "lançou algo".
import { criarAcumuladorFisico, type LinhaPosEstoque, MARCA_FISICO } from "./fisico.ts";
import {
  comPrazo,
  concluirRun,
  type EntradaPublicacao,
  FONTE_SEM_POSICAO,
  MARCA_GRAVACAO,
  MARCA_PENDENTE,
  MARKER_FULL,
  MARKER_PENDENTE_PO,
  type OpsPublicacao,
  type ResultadoEscrita,
  type ResultadoPendente,
} from "./publicacao.ts";
import type { LinhaObservada } from "./observacao-po.ts";

function igual<T>(real: T, esperado: T, msg: string): void {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a !== b) throw new Error(`${msg}\n  real:     ${a}\n  esperado: ${b}`);
}

function contem(texto: unknown, trecho: string, msg: string): void {
  if (typeof texto !== "string" || !texto.includes(trecho)) {
    throw new Error(`${msg}\n  texto: ${String(texto)}\n  esperado conter: ${trecho}`);
  }
}

async function rejeitaCom(p: Promise<unknown>, inicio: string, msg: string): Promise<Error> {
  try {
    await p;
  } catch (err) {
    const m = (err as Error).message;
    if (!m.startsWith(inicio)) throw new Error(`${msg}\n  mensagem: ${m}\n  esperado começar com: ${inicio}`);
    return err as Error;
  }
  throw new Error(`${msg}: resolveu, devia rejeitar`);
}

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const OK: ResultadoEscrita = { erro: null, semConfirmacao: false };

interface Cenario {
  pendente?: ResultadoPendente | Error;
  /** Resposta de cada upsertEstoque, pela ordem das chamadas (o que faltar é OK). */
  estoque?: Array<ResultadoEscrita | ((linhas: Record<string, unknown>[]) => ResultadoEscrita)>;
  /** ms que cada upsertEstoque consome do relógio. */
  custoEstoqueMs?: number;
  lerInativacoes?: string | null;
  upsertStatus?: ResultadoEscrita;
  lerEventos?: string | null;
  inserirEventos?: ResultadoEscrita;
  observacao?: ResultadoEscrita | Error;
  /** Resposta do inserirEstoqueSeAusente; default = o banco devolve TODOS como inseridos (não havia linha). */
  ausente?: (linhas: Record<string, unknown>[]) => ResultadoEscrita & { inseridos: string[] };
  /** sku_estoque_atual em memória (PK sku): persiste entre runs; upsert/insert/update/leitura agem sobre ela. */
  tabela?: Map<string, Record<string, unknown>>;
  /** Erro da leitura das linhas sem posição. */
  lerNossas?: string;
  /** Relógio inicial (runs sucessivos avançam o dia). */
  t0?: number;
}

function criarFake(c: Cenario = {}) {
  const efeitos: string[] = [];
  const linhasEstoque: Record<string, unknown>[][] = [];
  const linhasAusentes: Record<string, unknown>[][] = [];
  const linhasAtualizadas: Record<string, unknown>[] = [];
  const marcadores: Record<string, unknown>[] = [];
  const observacoes: Record<string, unknown>[] = [];
  let relogio = (c.t0 ?? T0) + 50_000;
  const tabela = c.tabela;
  let chamadaEstoque = 0;
  const ops: OpsPublicacao = {
    agora: () => relogio,
    lerPendente: () => {
      efeitos.push("lerPendente");
      const p = c.pendente ?? { pendente: new Map([["101", 5]]), confiavel: true, problemas: [], observacao: null };
      return p instanceof Error ? Promise.reject(p) : Promise.resolve(p);
    },
    upsertEstoque: (linhas) => {
      efeitos.push(`upsertEstoque:${linhas.map((l) => l.sku_codigo_omie).join(",")}`);
      linhasEstoque.push(linhas);
      for (const l of linhas) tabela?.set(String(l.sku_codigo_omie), { ...l });
      relogio += c.custoEstoqueMs ?? 0;
      const r = c.estoque?.[chamadaEstoque++];
      return Promise.resolve(r === undefined ? OK : typeof r === "function" ? r(linhas) : r);
    },
    inserirEstoqueSeAusente: (linhas) => {
      efeitos.push(`inserirAusente:${linhas.map((l) => l.sku_codigo_omie).join(",")}`);
      linhasAusentes.push(linhas);
      if (c.ausente) return Promise.resolve(c.ausente(linhas));
      const novos = linhas.filter((l) => !tabela?.has(String(l.sku_codigo_omie)));
      for (const l of novos) tabela?.set(String(l.sku_codigo_omie), { ...l });
      return Promise.resolve({ ...OK, inseridos: novos.map((l) => String(l.sku_codigo_omie)) });
    },
    lerLinhasSemPosicao: () => {
      efeitos.push("lerNossas");
      if (c.lerNossas) return Promise.resolve({ erro: c.lerNossas, dados: new Set<string>() });
      const nossas = [...(tabela ?? new Map()).values()].filter((l) => l.fonte_sync === FONTE_SEM_POSICAO);
      return Promise.resolve({ erro: null, dados: new Set(nossas.map((l) => String(l.sku_codigo_omie))) });
    },
    atualizarLinhaSemPosicao: (linha) => {
      const sku = String(linha.sku_codigo_omie);
      efeitos.push(`atualizarNossa:${sku}`);
      linhasAtualizadas.push(linha);
      const atual = tabela?.get(sku);
      if (atual?.fonte_sync !== FONTE_SEM_POSICAO) return Promise.resolve({ ...OK, atualizado: false });
      tabela!.set(sku, { ...linha });
      return Promise.resolve({ ...OK, atualizado: true });
    },
    lerInativacoes: (codigos) => {
      efeitos.push(`lerInativacoes:${codigos.join(",")}`);
      return Promise.resolve({ erro: c.lerInativacoes ?? null, dados: new Map([["104", "2026-09-01T00:00:00.000Z"]]) });
    },
    upsertStatus: (linhas) => {
      efeitos.push(`upsertStatus:${linhas.map((l) => `${l.sku_codigo_omie}@${l.data_inativacao}`).join(",")}`);
      return Promise.resolve(c.upsertStatus ?? OK);
    },
    lerEventosPendentes: (codigos) => {
      efeitos.push(`lerEventos:${codigos.join(",")}`);
      return Promise.resolve({ erro: c.lerEventos ?? null, dados: new Set<string>() });
    },
    inserirEventos: (linhas) => {
      efeitos.push(`inserirEventos:${linhas.map((l) => l.sku_codigo_omie).join(",")}`);
      return Promise.resolve(c.inserirEventos ?? OK);
    },
    publicarObservacao: (run) => {
      efeitos.push("observacao");
      observacoes.push(run);
      const r = c.observacao ?? OK;
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
    gravarMarcador: (linha) => {
      efeitos.push(`marcador:${linha.entity_type}:${linha.status}`);
      marcadores.push(linha);
      return Promise.resolve(OK);
    },
    log: () => {},
  };
  return { ops, efeitos, linhasEstoque, linhasAusentes, linhasAtualizadas, marcadores, observacoes, avancar: (ms: number) => (relogio += ms) };
}

// Habilitados 101, 102, 103 (achados no físico) e 104 (não aparece → inativação).
function entrada(opts: {
  paginas?: Array<{ itens: LinhaPosEstoque[]; total: unknown }>;
  empresa?: "OBEN" | "COLACOR";
  chunk?: number;
  membros?: string[];
} = {}): EntradaPublicacao {
  const habilitados = new Map<string, string | null>([["101", "A"], ["102", "B"], ["103", "C"], ["104", "D"]]);
  const paginas = opts.paginas ?? [{
    itens: [
      { nCodProd: 101, codigo_local_estoque: 1, fisico: 10, reservado: 2 },
      { nCodProd: 102, codigo_local_estoque: 1, fisico: 0, reservado: 0 },
      { nCodProd: 103, codigo_local_estoque: 1, fisico: 7, reservado: 0 },
      { nCodProd: 999, codigo_local_estoque: 1, fisico: 1, reservado: 0 },
    ],
    total: 4,
  }];
  const membros = new Set(opts.membros ?? []);
  const acc = criarAcumuladorFisico((s) => habilitados.has(s), habilitados.size, (s) => membros.has(s));
  for (const p of paginas) acc.pagina(p.itens, p.total);
  return {
    empresa: opts.empresa ?? "OBEN",
    habilitados,
    fisico: {
      veredito: acc.veredito(),
      encontrados: acc.encontrados,
      membros: acc.membros,
      membrosIlegiveis: acc.membrosIlegiveis,
      membrosGrupo: membros,
      paginas: paginas.length,
      faseMs: 45_000,
    },
    iniciadoEm: T0,
    limiteCauda: T0 + 85_000,
    prazos: { tetoEscritaMs: 8_000, minimoEscritaMs: 500, tetoObservacaoMs: 8_000, marcadorMs: 1_000 },
    chunk: opts.chunk ?? 2,
    versao: "vTESTE",
    filtrosPendente: {},
  };
}

const observado = (sku: number, contribuicao: number): LinhaObservada => ({
  omie_codigo_pedido: 1,
  seq_item: 1,
  numero_pedido: "1",
  etapa: "15",
  id_item: 1,
  sku_codigo_omie: sku,
  quantidade: contribuicao,
  quantidade_recebida: 0,
  contribuicao,
  exclusao: null,
});

const pendenteComObservacao = (bate: boolean): ResultadoPendente => ({
  pendente: new Map([["101", 5]]),
  confiavel: true,
  problemas: [],
  observacao: {
    observados: [observado(101, bate ? 5 : 4)],
    janelaDe: "2025-10-06",
    janelaAte: "2027-02-03",
    varreduraCompleta: true,
    coletaIntegra: true,
    perdaColeta: null,
  },
});

const SEM_MARCADOR = (efeitos: string[]) => efeitos.filter((e) => e.startsWith("marcador:"));

Deno.test("completo: PO depois do gate, par gravado junto, inativação, marcadores complete limpos, ok:true", async () => {
  const f = criarFake();
  const r = await concluirRun(f.ops, entrada());
  igual(f.efeitos, [
    "lerPendente",
    "upsertEstoque:101,102",
    "upsertEstoque:103",
    "lerInativacoes:104",
    "upsertStatus:104@2026-09-01T00:00:00.000Z",
    "lerEventos:104",
    "inserirEventos:104",
    `marcador:${MARKER_FULL}:complete`,
    `marcador:${MARKER_PENDENTE_PO}:complete`,
  ], "ordem dos efeitos");
  igual(f.linhasEstoque[0].map((l) => [l.sku_codigo_omie, l.estoque_fisico, l.estoque_disponivel, l.estoque_pendente_entrada]), [
    ["101", 10, 8, 5],
    ["102", 0, 0, 0],
  ], "cada linha leva físico E pendente (par atômico por SKU)");
  igual([r.ok, r.desfecho, r.sincronizados, r.nao_encontrados, r.alertas_novos], [true, "completo", 3, 1, 1], "resumo");
  for (const m of f.marcadores) {
    igual([m.error_message, typeof m.last_sync_at], [null, "string"], `marcador ${m.entity_type} limpa a mensagem`);
  }
});

Deno.test("C2 físico truncado: recusa com a marca e NENHUM efeito — nem a fase do PO", async () => {
  const f = criarFake();
  const e = entrada({ paginas: [{ itens: [{ nCodProd: 101, codigo_local_estoque: 1, fisico: 1 }], total: 4 }] });
  await rejeitaCom(concluirRun(f.ops, e), `${MARCA_FISICO} inconsistente`, "truncada");
  igual(f.efeitos, [], "sem PO, sem upsert, sem inativação, sem observação, sem marcador");
});

Deno.test("C2 total ausente: desconhecido também recusa sem efeito", async () => {
  const f = criarFake();
  const e = entrada({ paginas: [{ itens: [{ nCodProd: 101, codigo_local_estoque: 1, fisico: 1 }], total: undefined }] });
  await rejeitaCom(concluirRun(f.ops, e), `${MARCA_FISICO} desconhecido`, "total ausente");
  igual(f.efeitos, [], "nenhum efeito");
});

Deno.test("C2 vazio inesperado: nenhum habilitado no retrato completo NÃO inativa os habilitados", async () => {
  const f = criarFake();
  const e = entrada({ paginas: [{ itens: [{ nCodProd: 998, codigo_local_estoque: 1 }, { nCodProd: 999, codigo_local_estoque: 1 }], total: 2 }] });
  await rejeitaCom(concluirRun(f.ops, e), `${MARCA_FISICO} inconsistente`, "vazio");
  igual(f.efeitos, [], "nenhuma inativação em massa");
});

Deno.test("C1 pendente não confiável: lê o PO e recusa ANTES de qualquer escrita", async () => {
  const f = criarFake({
    pendente: { pendente: new Map(), confiavel: false, problemas: ["PO aprovada sem item com SKU (po=7)"], observacao: null },
  });
  const err = await rejeitaCom(concluirRun(f.ops, entrada()), `${MARCA_PENDENTE} (PO `, "dado torto");
  contem(err.message, "1 problema(s): PO aprovada sem item com SKU (po=7)", "o problema vai na mensagem");
  contem(err.message, "par (físico, pendente) preservado", "diz o que ficou");
  igual(f.efeitos, ["lerPendente"], "nenhum upsert, inativação, observação ou marcador");
});

Deno.test("C1 varredura do PO vazia: motivo explícito mesmo sem problema listado", async () => {
  const f = criarFake({ pendente: { pendente: new Map(), confiavel: false, problemas: [], observacao: null } });
  const err = await rejeitaCom(concluirRun(f.ops, entrada()), `${MARCA_PENDENTE} (PO `, "PO vazio");
  contem(err.message, "varredura do PO sem nenhum pedido aberto", "motivo");
  igual(f.efeitos, ["lerPendente"], "nenhuma escrita");
});

Deno.test("erro de varredura do PO segue FATAL: o MESMO erro sobe, sem escrita", async () => {
  const original = new Error("PesquisarPedCompra fault: SOAP-ENV:Client");
  const f = criarFake({ pendente: original });
  let pego: unknown = null;
  try {
    await concluirRun(f.ops, entrada());
  } catch (err) {
    pego = err;
  }
  if (pego !== original) throw new Error(`o erro do PO foi trocado ou engolido: ${String(pego)}`);
  igual(f.efeitos, ["lerPendente"], "nenhuma escrita");
});

Deno.test("C3 gravação parcial: o que gravou fica, marcadores partial com motivo, ok:false, inativação roda", async () => {
  const f = criarFake({
    estoque: [
      { erro: "lote falhou", semConfirmacao: false },
      OK,
      { erro: "violates check constraint", semConfirmacao: false },
    ],
  });
  const r = await concluirRun(f.ops, entrada());
  igual(f.efeitos.slice(0, 4), [
    "lerPendente",
    "upsertEstoque:101,102",
    "upsertEstoque:101",
    "upsertEstoque:102",
  ], "lote que falha cai no individual");
  igual([r.ok, r.desfecho, r.sincronizados, r.erros_upsert], [false, "parcial", 2, 1], "resumo");
  igual(f.efeitos.includes("upsertStatus:104@2026-09-01T00:00:00.000Z"), true, "a inativação roda (o físico estava completo)");
  igual(SEM_MARCADOR(f.efeitos), [`marcador:${MARKER_FULL}:partial`, `marcador:${MARKER_PENDENTE_PO}:partial`], "marcadores");
  const full = f.marcadores[0];
  contem(full.error_message, "gravação parcial: 1 de 3 SKUs sem confirmação (falha 1, prazo 0, não tentado 0)", "motivo");
  contem(full.error_message, "102: violates check constraint", "exemplo do SKU");
  igual(typeof full.last_sync_at, "string", "partial avança last_sync_at (houve gravação)");
});

Deno.test("C3 request abortado pelo prazo é 'sem confirmação', não sucesso", async () => {
  const f = criarFake({
    estoque: [{ erro: "AbortError", semConfirmacao: true }, { erro: "AbortError", semConfirmacao: true }, OK, OK],
  });
  const r = await concluirRun(f.ops, entrada());
  igual([r.ok, r.desfecho, r.sincronizados, r.upsert_sem_confirmacao], [false, "parcial", 2, 1], "101 sem confirmação");
});

Deno.test("C3 prazo da cauda: o que não cabe é 'não tentado' e o run AINDA chega aos marcadores", async () => {
  // limite da cauda em T0+85s, relógio em T0+50s; cada upsert consome 34,8s → depois do 1º lote sobram 0,2s (< mínimo)
  const f = criarFake({ custoEstoqueMs: 34_800 });
  const r = await concluirRun(f.ops, entrada());
  igual([r.ok, r.desfecho, r.sincronizados, r.upsert_nao_tentados], [false, "parcial", 2, 1], "103 não tentado");
  igual(f.efeitos.includes("lerInativacoes:104"), false, "sem tempo, a inativação não começa");
  igual(r.inativacao_falhou, true, "e isso degrada o desfecho");
  igual(SEM_MARCADOR(f.efeitos), [`marcador:${MARKER_FULL}:partial`, `marcador:${MARKER_PENDENTE_PO}:partial`], "marcadores gravados");
});

Deno.test("nenhuma gravação confirmada: recusa com a marca, sem inativação, observação nem marcador", async () => {
  const falha: ResultadoEscrita = { erro: "connection refused", semConfirmacao: false };
  const f = criarFake({ estoque: [falha, falha, falha, falha] });
  await rejeitaCom(concluirRun(f.ops, entrada({ chunk: 3 })), `${MARCA_GRAVACAO}: nenhuma das 3 linhas`, "nada confirmado");
  igual(f.efeitos.some((e) => /^(lerInativacoes|upsertStatus|observacao|marcador)/.test(e)), false, "parou na gravação");
});

Deno.test("inativação que falha degrada: full partial, pendente_po complete (o par gravou inteiro)", async () => {
  const f = criarFake({ upsertStatus: { erro: "permission denied", semConfirmacao: false } });
  const r = await concluirRun(f.ops, entrada());
  igual([r.ok, r.desfecho, r.inativacao_falhou, r.alertas_novos], [false, "parcial", true, 0], "resumo");
  igual(f.efeitos.some((e) => e.startsWith("inserirEventos")), false, "sem evento de SKU que não foi inativado");
  igual(SEM_MARCADOR(f.efeitos), [`marcador:${MARKER_FULL}:partial`, `marcador:${MARKER_PENDENTE_PO}:complete`], "marcadores");
  contem(f.marcadores[0].error_message, "inativação incompleta: upsert sku_status_omie: permission denied", "motivo");
});

Deno.test("leitura das datas de inativação que falha NÃO regrava a data original", async () => {
  const f = criarFake({ lerInativacoes: "timeout" });
  const r = await concluirRun(f.ops, entrada());
  igual(f.efeitos.some((e) => e.startsWith("upsertStatus")), false, "sem upsert de status com data falsa");
  igual([r.ok, r.inativacao_falhou], [false, true], "degrada");
});

Deno.test("leitura dos eventos pendentes que falha NÃO duplica o alerta", async () => {
  const f = criarFake({ lerEventos: "timeout" });
  const r = await concluirRun(f.ops, entrada());
  igual(f.efeitos.some((e) => e.startsWith("inserirEventos")), false, "sem insert às cegas");
  igual([r.ok, r.inativacao_falhou], [false, true], "degrada");
});

Deno.test("observação publica quando bate, com pendente_aplicado = gravação completa", async () => {
  const f = criarFake({ pendente: pendenteComObservacao(true) });
  const r = await concluirRun(f.ops, entrada());
  igual([r.ok, r.observacao_publicada], [true, true], "publicada");
  igual(f.observacoes[0].pendente_aplicado, true, "afirmação da edge");
  igual(f.efeitos.indexOf("observacao") > f.efeitos.indexOf("inserirEventos:104"), true, "depois da inativação");
});

Deno.test("observação é acessória: falha da RPC, exceção ou divergência não mudam o desfecho", async () => {
  const rpc = criarFake({ pendente: pendenteComObservacao(true), observacao: { erro: "rpc caiu", semConfirmacao: false } });
  const r1 = await concluirRun(rpc.ops, entrada());
  igual([r1.ok, r1.observacao_publicada, r1.observacao_motivo], [true, false, "rpc: rpc caiu"], "rpc");
  const exc = criarFake({ pendente: pendenteComObservacao(true), observacao: new Error("boom") });
  const r2 = await concluirRun(exc.ops, entrada());
  igual([r2.ok, r2.observacao_motivo], [true, "boom"], "exceção");
  const div = criarFake({ pendente: pendenteComObservacao(false) });
  const r3 = await concluirRun(div.ops, entrada());
  igual([r3.ok, r3.observacao_motivo, div.efeitos.includes("observacao")], [true, "observacao_diverge_do_pendente", false], "diverge");
});

Deno.test("COLACOR: sem marcador do pendente (o check é OBEN-only)", async () => {
  const f = criarFake();
  await concluirRun(f.ops, entrada({ empresa: "COLACOR" }));
  igual(SEM_MARCADOR(f.efeitos), [`marcador:${MARKER_FULL}:complete`], "só o full");
});

// comPrazo é o adaptador de TODA escrita da cauda no handler: se ele devolvesse sucesso onde houve erro, a degradação
// inteira ficaria invisível — por isso mora aqui, executável.
Deno.test("comPrazo: sucesso, erro do banco e exceção são distintos — e só o abort pelo prazo é 'sem confirmação'", async () => {
  igual(await comPrazo(() => Promise.resolve({ error: null }), 1_000), { erro: null, semConfirmacao: false }, "sucesso");
  igual(
    await comPrazo(() => Promise.resolve({ error: { message: "violates check constraint" } }), 1_000),
    { erro: "violates check constraint", semConfirmacao: false },
    "erro do banco antes do prazo: falha, não 'sem confirmação'",
  );
  igual(
    await comPrazo(() => Promise.reject(new Error("fetch failed")), 1_000),
    { erro: "fetch failed", semConfirmacao: false },
    "exceção vira erro",
  );
  igual(
    await comPrazo(() => Promise.resolve({ error: {} }), 1_000),
    { erro: "erro sem mensagem", semConfirmacao: false },
    "erro sem mensagem nunca vira sucesso",
  );
  const abortado = await comPrazo(
    (sinal) =>
      new Promise((resolve) => {
        sinal.addEventListener("abort", () => resolve({ error: { message: "AbortError: signal timed out" } }));
      }),
    20,
  );
  igual(abortado, { erro: "AbortError: signal timed out", semConfirmacao: true }, "o prazo abortou: o banco pode ter gravado");
});

// PR-3 do estoque com dono único (2026-10-07): o membro de grupo NÃO habilitado (999) ganha linha própria com o PAR
// (físico + pendente da MESMA varredura de PO), num lote à parte. O motor SOMA o físico e o pendente de todos os membros
// do grupo: físico fresco com pendente velho conta a NF recebida duas vezes (o par misto que o C1 recusa).
const pendenteComMembros = (membros: Map<string, number>, ilegiveis: string[] = []): ResultadoPendente => ({
  pendente: new Map([["101", 5]]),
  confiavel: true,
  problemas: [],
  observacao: null,
  pendenteMembros: membros,
  membrosPendenteIlegiveis: ilegiveis,
});

Deno.test("membro de grupo: o PAR (físico + pendente da mesma varredura) num lote à parte, depois dos habilitados", async () => {
  const f = criarFake({ pendente: pendenteComMembros(new Map([["999", 3]])) });
  const r = await concluirRun(f.ops, entrada({ membros: ["999"] }));
  const doMembro = f.linhasEstoque.filter((lote) => lote.some((l) => l.sku_codigo_omie === "999"));
  igual(doMembro.length, 1, "um lote com o membro");
  igual(doMembro[0].map((l) => l.sku_codigo_omie), ["999"], "o lote do membro não mistura habilitado");
  const l = doMembro[0][0];
  igual([l.estoque_fisico, l.estoque_disponivel, l.estoque_pendente_entrada], [1, 1, 3], "físico, disponível e pendente");
  igual(f.efeitos.indexOf("upsertEstoque:999") > f.efeitos.indexOf("upsertEstoque:103"), true, "depois dos habilitados");
  igual([r.membros_grupo_encontrados, r.membros_grupo_gravados, r.membros_grupo_falhas], [1, 1, 0], "resumo");
  igual(r.desfecho, "completo", "desfecho dos habilitados");
});

Deno.test("membro de grupo sem PO aberto: pendente 0 legítimo (a varredura passou pelo C1)", async () => {
  const f = criarFake({ pendente: pendenteComMembros(new Map()) });
  await concluirRun(f.ops, entrada({ membros: ["999"] }));
  const l = f.linhasEstoque.flat().find((x) => x.sku_codigo_omie === "999");
  igual(l?.estoque_pendente_entrada, 0, "0 sob o gate de confiança");
});

Deno.test("membro de grupo com item de PO ilegível: sem linha (par incompleto), e os habilitados seguem", async () => {
  const f = criarFake({ pendente: pendenteComMembros(new Map(), ["999"]) });
  const r = await concluirRun(f.ops, entrada({ membros: ["999"] }));
  igual(f.linhasEstoque.some((lote) => lote.some((x) => x.sku_codigo_omie === "999")), false, "nada do 999");
  igual([r.desfecho, r.membros_grupo_ilegiveis, r.membros_grupo_gravados], ["completo", 1, 0], "resumo");
});

Deno.test("varredura do PO sem o recorte dos membros: nenhum membro gravado — nunca o físico sozinho", async () => {
  const f = criarFake();
  const r = await concluirRun(f.ops, entrada({ membros: ["999"] }));
  igual(f.linhasEstoque.some((lote) => lote.some((x) => x.sku_codigo_omie === "999")), false, "nada do 999");
  igual([r.desfecho, r.membros_grupo_sem_pendente, r.membros_grupo_gravados], ["completo", true, 0], "resumo");
});

Deno.test("membro de grupo: falha ao gravar NÃO muda o desfecho dos habilitados e fica no resumo", async () => {
  const ERRO: ResultadoEscrita = { erro: "boom", semConfirmacao: false };
  const f = criarFake({ pendente: pendenteComMembros(new Map([["999", 3]])), estoque: [OK, OK, ERRO, ERRO] });
  const r = await concluirRun(f.ops, entrada({ membros: ["999"] }));
  igual(r.desfecho, "completo", "desfecho");
  igual([r.membros_grupo_gravados, r.membros_grupo_falhas], [0, 1], "a falha aparece no resumo");
});

// Membro com PO aberto AUSENTE do retrato (ListarPosEstoque com cExibeTodos=S, varredura COMPLETA — o C2 já passou):
// sem linha em sku_estoque_atual o motor perde o pendente dele, e o pedido do app só conta até D−7 — o PO é contado 0× e
// o grupo recompra (furo do #3969, achado do Codex). A edge INSERE o par (físico 0, pendente) só onde NÃO há linha: o
// motor já lia COALESCE(físico, 0) = 0 para o membro sem linha, então o 0 não muda o físico do grupo — só passa a existir
// o pendente e o retrato do dia. Linha existente nunca é sobrescrita (ON CONFLICT DO NOTHING).
const doSku = (lotes: Record<string, unknown>[][], sku: string) => lotes.flat().filter((l) => l.sku_codigo_omie === sku);

Deno.test("membro com PO aberto ausente do retrato: INSERE o par (físico 0, pendente) sem sobrescrever", async () => {
  const f = criarFake({ pendente: pendenteComMembros(new Map([["555", 2]])) });
  const r = await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual(doSku(f.linhasEstoque, "555").length, 0, "nunca pelo upsert (sobrescreveria linha existente)");
  const l = doSku(f.linhasAusentes, "555");
  igual(l.length, 1, "uma linha do 555 no insert-se-ausente");
  igual(
    [l[0].estoque_fisico, l[0].estoque_disponivel, l[0].estoque_pendente_entrada, l[0].empresa],
    [0, 0, 2, "OBEN"],
    "físico 0, disponível 0, pendente da MESMA varredura",
  );
  igual(typeof l[0].ultima_sincronizacao, "string", "retrato do dia no mesmo insert");
  igual(l[0].fonte_sync, "PO_sem_posicao_ListarPosEstoque", "fonte distinta do físico lido");
  igual(f.efeitos.indexOf("inserirAusente:555") > f.efeitos.indexOf("upsertEstoque:103"), true, "depois dos habilitados");
  igual(
    [r.membros_grupo_encontrados, r.membros_grupo_gravados, r.membros_grupo_ausentes_com_po, r.membros_grupo_ausentes_inseridos],
    [0, 0, 1, 1],
    "resumo",
  );
  igual(r.desfecho, "completo", "desfecho dos habilitados");
});

Deno.test("controle: membro ausente do retrato SEM PO aberto não ganha linha (nada a proteger)", async () => {
  const f = criarFake({ pendente: pendenteComMembros(new Map([["555", 0]])) });
  const r = await concluirRun(f.ops, entrada({ membros: ["555", "556"] }));
  igual(f.linhasAusentes.flat().length, 0, "nenhum insert");
  igual(r.membros_grupo_ausentes_com_po, 0, "resumo");
});

Deno.test("membro ausente com item de PO ilegível: sem par, sem linha", async () => {
  const f = criarFake({ pendente: pendenteComMembros(new Map([["555", 2]]), ["555"]) });
  await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual(doSku(f.linhasAusentes, "555").length, 0, "nada do 555");
});

Deno.test("membro com físico ILEGÍVEL não é 'ausente': ele veio na listagem — nunca vira físico 0", async () => {
  const f = criarFake({ pendente: pendenteComMembros(new Map([["555", 2]])) });
  const en = entrada({ membros: ["555"] });
  await concluirRun(f.ops, { ...en, fisico: { ...en.fisico, membrosIlegiveis: ["555"] } });
  igual(doSku(f.linhasAusentes, "555").length, 0, "nada do 555");
});

Deno.test("membro ausente sem o recorte dos membros na varredura do PO: nada é inserido", async () => {
  const f = criarFake();
  await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual(f.linhasAusentes.flat().length, 0, "nenhum insert");
});

Deno.test("membro ausente que JÁ tem linha: o banco não insere; não entra no pendente gravado da observação", async () => {
  const pend: ResultadoPendente = {
    ...pendenteComMembros(new Map([["555", 2]])),
    observacao: {
      observados: [observado(101, 5), observado(555, 2)],
      janelaDe: "2025-10-06",
      janelaAte: "2027-02-03",
      varreduraCompleta: true,
      coletaIntegra: true,
      perdaColeta: null,
    },
  };
  const f = criarFake({ pendente: pend, ausente: () => ({ ...OK, inseridos: [] }) });
  const r = await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual([r.membros_grupo_ausentes_com_po, r.membros_grupo_ausentes_inseridos, r.membros_grupo_ausentes_ja_com_linha], [1, 0, 1], "resumo");
  igual([r.observacao_publicada, r.observacao_motivo], [false, "observacao_diverge_do_pendente"], "fail-closed");
});

Deno.test("membro ausente INSERIDO entra no pendente gravado: a observação publica e vale como aplicada", async () => {
  const pend: ResultadoPendente = {
    ...pendenteComMembros(new Map([["555", 2]])),
    observacao: {
      observados: [observado(101, 5), observado(555, 2)],
      janelaDe: "2025-10-06",
      janelaAte: "2027-02-03",
      varreduraCompleta: true,
      coletaIntegra: true,
      perdaColeta: null,
    },
  };
  const f = criarFake({ pendente: pend });
  const r = await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual([r.observacao_publicada, f.observacoes[0]?.pendente_aplicado], [true, true], "publicada e aplicada");
});

Deno.test("membro ausente: falha do insert não muda o desfecho, fica no resumo e tira o 'aplicado'", async () => {
  const pend: ResultadoPendente = {
    ...pendenteComMembros(new Map([["555", 2]])),
    observacao: {
      observados: [observado(101, 5)],
      janelaDe: "2025-10-06",
      janelaAte: "2027-02-03",
      varreduraCompleta: true,
      coletaIntegra: true,
      perdaColeta: null,
    },
  };
  const f = criarFake({ pendente: pend, ausente: () => ({ erro: "boom", semConfirmacao: false, inseridos: [] }) });
  const r = await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual(r.desfecho, "completo", "desfecho");
  igual([r.membros_grupo_ausentes_inseridos, r.membros_grupo_ausentes_falhas], [0, 1], "a falha aparece no resumo");
  igual(f.observacoes[0]?.pendente_aplicado, false, "o lote dos ausentes não confirmou");
});

// Codex P1 (2026-11-18): o INSERT … DO NOTHING sozinho congelava a linha que a própria edge criou — a varredura trazia
// 10 → 10 → 4 → 0 e a linha ficava em 10 (2× a entrega recebida; 0× um PO novo). A linha NOSSA é reconciliada a cada run.
const DIA = 1_000; // "dia" curto: o limite da cauda da entrada() é fixo; basta o retrato avançar
const pendDe = (q: number) => pendenteComMembros(q > 0 ? new Map([["555", q]]) : new Map());

Deno.test("Codex P1: runs sucessivos reconciliam a linha nossa — 10 → 10 → 4 → 0, com o retrato avançando", async () => {
  const tabela = new Map<string, Record<string, unknown>>();
  const vistos: Array<[unknown, unknown]> = [];
  for (const [dia, q] of [[0, 10], [1, 10], [2, 4], [3, 0]] as const) {
    const f = criarFake({ pendente: pendDe(q), tabela, t0: T0 + dia * DIA });
    await concluirRun(f.ops, entrada({ membros: ["555"] }));
    const l = tabela.get("555");
    vistos.push([l?.estoque_pendente_entrada, l?.ultima_sincronizacao]);
  }
  igual(vistos.map((v) => v[0]), [10, 10, 4, 0], "o pendente acompanha a varredura, inclusive a baixa para 0");
  igual(new Set(vistos.map((v) => v[1])).size, 4, "o retrato avança a cada run");
  igual(tabela.get("555")?.fonte_sync, FONTE_SEM_POSICAO, "continua nossa");
});

Deno.test("Codex P1: PO novo somado ao velho entra (16), nunca fica no valor do 1º insert", async () => {
  const tabela = new Map<string, Record<string, unknown>>();
  await concluirRun(criarFake({ pendente: pendDe(10), tabela }).ops, entrada({ membros: ["555"] }));
  const f = criarFake({ pendente: pendDe(16), tabela, t0: T0 + DIA });
  const r = await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual(tabela.get("555")?.estoque_pendente_entrada, 16, "16");
  igual(
    [r.membros_grupo_ausentes_reconciliados, r.membros_grupo_ausentes_inseridos, r.membros_grupo_ausentes_ja_com_linha],
    [1, 0, 0],
    "pelo update, sem insert redundante",
  );
});

Deno.test("linha de OUTRA origem (físico lido antes) nunca é tocada pelo membro ausente", async () => {
  const tabela = new Map<string, Record<string, unknown>>([
    ["555", { sku_codigo_omie: "555", estoque_fisico: 7, estoque_pendente_entrada: 1, fonte_sync: "ListarPosEstoque" }],
  ]);
  const f = criarFake({ pendente: pendDe(3), tabela });
  const r = await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual([tabela.get("555")?.estoque_fisico, tabela.get("555")?.estoque_pendente_entrada], [7, 1], "intacta");
  igual(f.linhasAtualizadas.length, 0, "nenhum update");
  igual(r.membros_grupo_ausentes_ja_com_linha, 1, "o conflito aparece no resumo");
});

Deno.test("corrida: a linha nossa foi regravada com a posição real entre a leitura e o update — o update não a toca", async () => {
  const tabela = new Map<string, Record<string, unknown>>([
    ["555", { sku_codigo_omie: "555", estoque_fisico: 0, estoque_pendente_entrada: 10, fonte_sync: FONTE_SEM_POSICAO }],
  ]);
  const pend: ResultadoPendente = {
    ...pendDe(4),
    observacao: {
      observados: [observado(101, 5), observado(555, 4)],
      janelaDe: "2025-10-06",
      janelaAte: "2027-02-03",
      varreduraCompleta: true,
      coletaIntegra: true,
      perdaColeta: null,
    },
  };
  const f = criarFake({ pendente: pend, tabela });
  const ler = f.ops.lerLinhasSemPosicao;
  f.ops.lerLinhasSemPosicao = async (p) => {
    const r = await ler(p);
    tabela.set("555", { sku_codigo_omie: "555", estoque_fisico: 9, estoque_pendente_entrada: 4, fonte_sync: "ListarPosEstoque" });
    return r;
  };
  const r = await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual(tabela.get("555")?.estoque_fisico, 9, "a posição real fica");
  igual([r.membros_grupo_ausentes_reconciliados, r.membros_grupo_ausentes_ja_com_linha], [0, 1], "resumo");
  igual(r.observacao_publicada, false, "o update não provou o par: fora do pendente gravado (fail-closed)");
});

Deno.test("leitura das linhas nossas falha: nada é atualizado, o erro vai ao resumo e o run não vale como aplicado", async () => {
  const tabela = new Map<string, Record<string, unknown>>([
    ["555", { sku_codigo_omie: "555", estoque_fisico: 0, estoque_pendente_entrada: 10, fonte_sync: FONTE_SEM_POSICAO }],
  ]);
  const pend: ResultadoPendente = {
    ...pendDe(4),
    observacao: {
      observados: [observado(101, 5)],
      janelaDe: "2025-10-06",
      janelaAte: "2027-02-03",
      varreduraCompleta: true,
      coletaIntegra: true,
      perdaColeta: null,
    },
  };
  const f = criarFake({ pendente: pend, tabela, lerNossas: "boom" });
  const r = await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual(f.linhasAtualizadas.length, 0, "nenhum update às cegas");
  igual(tabela.get("555")?.estoque_pendente_entrada, 10, "o insert não sobrescreve");
  igual([r.membros_grupo_ausentes_erro, r.desfecho], ["boom", "completo"], "resumo");
  igual(f.observacoes[0]?.pendente_aplicado, false, "não aplicado");
});

Deno.test("leitura das linhas nossas falha SEM nenhum conflito: só ela já tira o 'aplicado'", async () => {
  const tabela = new Map<string, Record<string, unknown>>([
    ["555", { sku_codigo_omie: "555", estoque_fisico: 0, estoque_pendente_entrada: 10, fonte_sync: FONTE_SEM_POSICAO }],
  ]);
  const pend: ResultadoPendente = {
    ...pendenteComMembros(new Map()),
    observacao: {
      observados: [observado(101, 5)],
      janelaDe: "2025-10-06",
      janelaAte: "2027-02-03",
      varreduraCompleta: true,
      coletaIntegra: true,
      perdaColeta: null,
    },
  };
  const f = criarFake({ pendente: pend, tabela, lerNossas: "boom" });
  const r = await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual([r.membros_grupo_ausentes_ja_com_linha, r.membros_grupo_ausentes_falhas], [0, 0], "sem conflito nem falha");
  igual(f.observacoes[0]?.pendente_aplicado, false, "a linha nossa não foi reconciliada: não aplicado");
});

Deno.test("linha nossa de membro que VOLTOU à listagem: vale o par lido (upsert), sem update de ausente", async () => {
  const tabela = new Map<string, Record<string, unknown>>([
    ["999", { sku_codigo_omie: "999", estoque_fisico: 0, estoque_pendente_entrada: 10, fonte_sync: FONTE_SEM_POSICAO }],
  ]);
  const f = criarFake({ pendente: pendenteComMembros(new Map([["999", 3]])), tabela });
  await concluirRun(f.ops, entrada({ membros: ["999"] }));
  igual(f.linhasAtualizadas.length, 0, "nenhum update de ausente");
  igual([tabela.get("999")?.estoque_fisico, tabela.get("999")?.estoque_pendente_entrada, tabela.get("999")?.fonte_sync], [1, 3, "ListarPosEstoque"], "o par lido");
});

Deno.test("linha nossa de SKU que virou habilitado: nunca reconciliada como membro", async () => {
  const tabela = new Map<string, Record<string, unknown>>([
    ["104", { sku_codigo_omie: "104", estoque_fisico: 0, estoque_pendente_entrada: 10, fonte_sync: FONTE_SEM_POSICAO }],
  ]);
  const f = criarFake({ pendente: pendenteComMembros(new Map()), tabela });
  await concluirRun(f.ops, entrada());
  igual(f.linhasAtualizadas.length, 0, "nenhum update");
});

// Codex, 2ª rodada (2026-11-18): o PO do APP é deduplicado do pendente (o em_transito o conta) — o membro ausente sem
// linha ficava sem retrato, e o motor cortava o em_transito em D−7: com o sync atrasado, o PO ficava 0×.
const comPoApp = (skus: string[], pendMembros = new Map<string, number>()): ResultadoPendente => ({
  ...pendenteComMembros(pendMembros),
  membrosComPoApp: skus,
});

Deno.test("Codex P1 (2ª): membro ausente só com PO do APP deduplicado ganha o retrato (0, 0, hoje)", async () => {
  const tabela = new Map<string, Record<string, unknown>>();
  const f = criarFake({ pendente: comPoApp(["555"]), tabela });
  const r = await concluirRun(f.ops, entrada({ membros: ["555"] }));
  const l = tabela.get("555");
  igual([l?.estoque_fisico, l?.estoque_pendente_entrada, l?.fonte_sync], [0, 0, FONTE_SEM_POSICAO], "o par do retrato");
  igual(typeof l?.ultima_sincronizacao, "string", "com o retrato do dia");
  igual(r.membros_grupo_ausentes_inseridos, 1, "resumo");
});

Deno.test("PO do APP de SKU fora do grupo (ou habilitado) não cria linha", async () => {
  const f = criarFake({ pendente: comPoApp(["777", "101"]) });
  await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual(f.linhasAusentes.flat().length, 0, "nenhum insert");
});

Deno.test("leitura da equivalência falhou: nenhuma linha de ausente é lida, inserida ou zerada", async () => {
  const tabela = new Map<string, Record<string, unknown>>([
    ["555", { sku_codigo_omie: "555", estoque_fisico: 0, estoque_pendente_entrada: 10, fonte_sync: FONTE_SEM_POSICAO }],
  ]);
  const f = criarFake({ pendente: comPoApp(["556"]), tabela });
  const en = entrada({ membros: ["555", "556"] });
  await concluirRun(f.ops, { ...en, fisico: { ...en.fisico, membrosErro: "boom" } });
  igual([f.linhasAtualizadas.length, f.linhasAusentes.flat().length], [0, 0], "nada escrito");
  igual(f.efeitos.includes("lerNossas"), false, "nem lido");
  igual(tabela.get("555")?.estoque_pendente_entrada, 10, "a linha nossa não é zerada às cegas");
});

Deno.test("ex-membro (fora da equivalência atual): a linha nossa não ganha retrato fresco", async () => {
  const tabela = new Map<string, Record<string, unknown>>([
    ["777", { sku_codigo_omie: "777", estoque_fisico: 0, estoque_pendente_entrada: 10, fonte_sync: FONTE_SEM_POSICAO }],
  ]);
  const f = criarFake({ pendente: pendenteComMembros(new Map()), tabela });
  await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual(f.linhasAtualizadas.length, 0, "nenhum update");
});

Deno.test("Codex P2 (2ª): update para 0 que perde a corrida tira o 'aplicado'", async () => {
  const tabela = new Map<string, Record<string, unknown>>([
    ["555", { sku_codigo_omie: "555", estoque_fisico: 0, estoque_pendente_entrada: 4, fonte_sync: FONTE_SEM_POSICAO }],
  ]);
  const pend: ResultadoPendente = {
    ...pendenteComMembros(new Map()),
    observacao: {
      observados: [observado(101, 5)],
      janelaDe: "2025-10-06",
      janelaAte: "2027-02-03",
      varreduraCompleta: true,
      coletaIntegra: true,
      perdaColeta: null,
    },
  };
  const f = criarFake({ pendente: pend, tabela });
  const ler = f.ops.lerLinhasSemPosicao;
  f.ops.lerLinhasSemPosicao = async (p) => {
    const r = await ler(p);
    tabela.set("555", { sku_codigo_omie: "555", estoque_fisico: 0, estoque_pendente_entrada: 4, fonte_sync: "ListarPosEstoque" });
    return r;
  };
  await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual(f.observacoes[0]?.pendente_aplicado, false, "o 0 não foi gravado: não aplicado");
});

Deno.test("membro AUSENTE com item de PO ilegível entra na contagem de ilegíveis", async () => {
  const f = criarFake({ pendente: pendenteComMembros(new Map(), ["555"]) });
  const r = await concluirRun(f.ops, entrada({ membros: ["555"] }));
  igual(r.membros_grupo_ilegiveis, 1, "o resumo não diz 0");
});

Deno.test("membros de grupo não lidos: o resumo diz o erro e null, nunca '0 membros'", async () => {
  const f = criarFake();
  const en = entrada();
  const r = await concluirRun(f.ops, { ...en, fisico: { ...en.fisico, membrosErro: "boom" } });
  igual([r.membros_grupo_encontrados, r.membros_grupo_erro], [null, "boom"], "resumo");
  igual(r.desfecho, "completo", "os habilitados seguem");
});

// A observação (PR0 da baixa de PO) é "o conjunto aberto que o motor contou": com o par dos membros gravado, o motor
// conta o pendente deles — a conferência é contra o pendente GRAVADO (habilitados ∪ membros com par).
const observacaoComMembro = (pendMembros: Map<string, number>, ilegiveis: string[] = []): ResultadoPendente => ({
  ...pendenteComMembros(pendMembros, ilegiveis),
  observacao: {
    observados: [observado(101, 5), observado(999, 3)],
    janelaDe: "2025-10-06",
    janelaAte: "2027-02-03",
    varreduraCompleta: true,
    coletaIntegra: true,
    perdaColeta: null,
  },
});

Deno.test("observação com membro de grupo: publica quando bate com habilitados ∪ membros com par", async () => {
  const f = criarFake({ pendente: observacaoComMembro(new Map([["999", 3]])) });
  const r = await concluirRun(f.ops, entrada({ membros: ["999"] }));
  igual([r.observacao_publicada, f.observacoes[0]?.pendente_aplicado], [true, true], "publicada e aplicada");
});

Deno.test("observação com membro SEM par (item de PO inválido): diverge e não publica — fail-closed", async () => {
  const f = criarFake({ pendente: observacaoComMembro(new Map(), ["999"]) });
  const r = await concluirRun(f.ops, entrada({ membros: ["999"] }));
  igual([r.observacao_publicada, r.observacao_motivo], [false, "observacao_diverge_do_pendente"], "não publica");
  igual(r.desfecho, "completo", "acessória: o desfecho não muda");
});

Deno.test("observação: pendente_aplicado só com os DOIS lotes inteiros (habilitados e membros)", async () => {
  const ERRO: ResultadoEscrita = { erro: "boom", semConfirmacao: false };
  const f = criarFake({ pendente: observacaoComMembro(new Map([["999", 3]])), estoque: [OK, OK, ERRO, ERRO] });
  await concluirRun(f.ops, entrada({ membros: ["999"] }));
  igual(f.observacoes[0]?.pendente_aplicado, false, "o lote do membro falhou");
});
