// A orquestração da publicação EXECUTADA com escritas falsas que registram cada efeito — a prova que a guarda textual
// não dá (desenho da v1.6, Codex 2026-10-06: "C1/C2 devem impedir upsert, inativação e observação"). Cada teste casa a
// MARCA do ramo e a lista de efeitos, não "lançou algo".
import { criarAcumuladorFisico, type LinhaPosEstoque, MARCA_FISICO } from "./fisico.ts";
import {
  concluirRun,
  type EntradaPublicacao,
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
}

function criarFake(c: Cenario = {}) {
  const efeitos: string[] = [];
  const linhasEstoque: Record<string, unknown>[][] = [];
  const marcadores: Record<string, unknown>[] = [];
  const observacoes: Record<string, unknown>[] = [];
  let relogio = T0 + 50_000;
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
      relogio += c.custoEstoqueMs ?? 0;
      const r = c.estoque?.[chamadaEstoque++];
      return Promise.resolve(r === undefined ? OK : typeof r === "function" ? r(linhas) : r);
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
  return { ops, efeitos, linhasEstoque, marcadores, observacoes, avancar: (ms: number) => (relogio += ms) };
}

// Habilitados 101, 102, 103 (achados no físico) e 104 (não aparece → inativação).
function entrada(opts: {
  paginas?: Array<{ itens: LinhaPosEstoque[]; total: unknown }>;
  empresa?: "OBEN" | "COLACOR";
  chunk?: number;
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
  const acc = criarAcumuladorFisico((s) => habilitados.has(s), habilitados.size);
  for (const p of paginas) acc.pagina(p.itens, p.total);
  return {
    empresa: opts.empresa ?? "OBEN",
    habilitados,
    fisico: { veredito: acc.veredito(), encontrados: acc.encontrados, paginas: paginas.length, faseMs: 45_000 },
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
