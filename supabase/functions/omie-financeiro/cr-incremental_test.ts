// Testa o CÓDIGO REAL de cr-incremental.ts no runtime real (Deno).
// Roda com: deno test supabase/functions/omie-financeiro/cr-incremental_test.ts
import {
  avaliarProvaCliente,
  type DepsIncrementalCR,
  decidirModoCR,
  executarIncrementalCR,
  FULL_MAX_DIAS,
  janelaAlteracao,
  janelaEmissao,
  PAGINA_PROVA,
} from "./cr-incremental.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// Domingo 01/11/2026 22:30 BRT = 02/11 01:30 UTC — o dia de negócio é 01/11, não 02/11.
const AGORA = new Date("2026-11-02T01:30:00Z");
const h = (iso: string) => new Date(iso);

Deno.test("cursor pendente continua o full, mesmo com estado novo", () => {
  assertEquals(
    decidirModoCR({ cursorPendente: true, estado: { fullOkEm: h("2026-11-01T10:00:00Z"), incrementalOkEm: null }, agora: AGORA }),
    { modo: "continuar_full" },
  );
});

Deno.test("estado ilegível cai no full (comportamento de antes do lote), nunca no incremental", () => {
  assertEquals(decidirModoCR({ cursorPendente: false, estado: null, agora: AGORA }), { modo: "full", motivo: "estado_ilegivel" });
});

Deno.test("sem full completo ainda: full (bootstrap), mesmo com incremental registrado", () => {
  assertEquals(
    decidirModoCR({ cursorPendente: false, estado: { fullOkEm: null, incrementalOkEm: h("2026-11-01T10:00:00Z") }, agora: AGORA }),
    { modo: "full", motivo: "sem_full" },
  );
});

Deno.test("full com mais de 7 dias vence, por mais recente que seja o incremental", () => {
  const fullOk = new Date(AGORA.getTime() - (FULL_MAX_DIAS * 86_400_000 + 60_000));
  assertEquals(
    decidirModoCR({ cursorPendente: false, estado: { fullOkEm: fullOk, incrementalOkEm: h("2026-11-01T17:20:00Z") }, agora: AGORA }),
    { modo: "full", motivo: "full_vencido" },
  );
  // 1 min ANTES do limite segue incremental (o par: separa "vence" de "sempre full").
  const fullOkDentro = new Date(AGORA.getTime() - (FULL_MAX_DIAS * 86_400_000 - 60_000));
  assertEquals(
    decidirModoCR({ cursorPendente: false, estado: { fullOkEm: fullOkDentro, incrementalOkEm: null }, agora: AGORA }).modo,
    "incremental",
  );
});

Deno.test("marca = o mais recente entre full e incremental; janela volta 1 dia e vai até HOJE em SP", () => {
  // incremental às 14:20 BRT de 01/11 → marca 01/11 → de 31/10 até 01/11 (não 02/11: ainda é domingo em SP)
  assertEquals(
    decidirModoCR({
      cursorPendente: false,
      estado: { fullOkEm: h("2026-10-29T08:20:00Z"), incrementalOkEm: h("2026-11-01T17:20:00Z") },
      agora: AGORA,
    }),
    { modo: "incremental", de: "31/10/2026", ate: "01/11/2026", marca: "2026-11-01" },
  );
  // incremental mais VELHO que o full: a marca é o início do full
  assertEquals(
    decidirModoCR({
      cursorPendente: false,
      estado: { fullOkEm: h("2026-10-30T11:00:00Z"), incrementalOkEm: h("2026-10-29T11:20:00Z") },
      agora: AGORA,
    }),
    { modo: "incremental", de: "29/10/2026", ate: "01/11/2026", marca: "2026-10-30" },
  );
});

Deno.test("marca pelo dia de SP, não UTC: run às 22:30 BRT marca o próprio dia", () => {
  // t0 = 01/11 22:30 BRT (02/11 01:30 UTC); o próximo run, 02/11 05:20 BRT, lista de 31/10 (não de 01/11)
  assertEquals(
    janelaAlteracao(h("2026-11-02T01:30:00Z"), h("2026-11-02T08:20:00Z")),
    { de: "31/10/2026", ate: "02/11/2026", marca: "2026-11-01" },
  );
});

Deno.test("marca no futuro lança (relógio/estado corrompido não vira janela vazia)", () => {
  let msg = "";
  try {
    janelaAlteracao(h("2026-11-03T12:00:00Z"), AGORA);
  } catch (e) {
    msg = String(e);
  }
  if (!msg.includes("marca no futuro")) throw new Error(`esperava 'marca no futuro', veio [${msg}]`);
});

// ── prova por cliente ──

const J = janelaEmissao("2026-07-23");
const base = { codigo: 12108140458, cliente: 8689697854, janela: J };

Deno.test("janela de emissão é ±1 dia no formato do Omie", () => {
  assertEquals(J, { de: "22/07/2026", ate: "24/07/2026" });
});

Deno.test("resposta vazia AFIRMATIVA (total 0) prova a ausência — forma medida na oben", () => {
  const v = avaliarProvaCliente({ ...base, totalDePaginas: 0, totalDeRegistros: 0, titulos: [] });
  assertEquals(v.tipo, "ausente_provado");
});

Deno.test("outros títulos do cliente sem o candidato provam a ausência e viram evidência", () => {
  const titulos = [12184124834, 12184137539, 12184137540].map((c) => ({ codigo_lancamento_omie: c, codigo_cliente_fornecedor: base.cliente }));
  const v = avaliarProvaCliente({ ...base, totalDePaginas: 1, totalDeRegistros: 3, titulos });
  assertEquals(v, {
    tipo: "ausente_provado",
    evidencia: { cliente: base.cliente, emissao_de: "22/07/2026", emissao_ate: "24/07/2026", total_de_registros: 3, codigos_vistos: [12184124834, 12184137539, 12184137540] },
  });
});

Deno.test("candidato presente na listagem → presente (nunca apaga)", () => {
  const titulos = [{ codigo_lancamento_omie: base.codigo, codigo_cliente_fornecedor: base.cliente }];
  assertEquals(avaliarProvaCliente({ ...base, totalDePaginas: 1, totalDeRegistros: 1, titulos }).tipo, "presente");
});

Deno.test("sem contagem declarada, multipágina, contagem divergente ou página cheia → inconclusivo", () => {
  const um = [{ codigo_lancamento_omie: 1, codigo_cliente_fornecedor: base.cliente }];
  assertEquals(avaliarProvaCliente({ ...base, totalDePaginas: 1, totalDeRegistros: undefined, titulos: um }).tipo, "inconclusivo");
  assertEquals(avaliarProvaCliente({ ...base, totalDePaginas: 1, totalDeRegistros: null, titulos: [] }).tipo, "inconclusivo");
  assertEquals(avaliarProvaCliente({ ...base, totalDePaginas: 2, totalDeRegistros: 1, titulos: um }).tipo, "inconclusivo");
  assertEquals(avaliarProvaCliente({ ...base, totalDePaginas: 1, totalDeRegistros: 2, titulos: um }).tipo, "inconclusivo");
  const cheia = Array.from({ length: PAGINA_PROVA }, (_, i) => ({ codigo_lancamento_omie: i + 1, codigo_cliente_fornecedor: base.cliente }));
  assertEquals(avaliarProvaCliente({ ...base, totalDePaginas: 1, totalDeRegistros: PAGINA_PROVA, titulos: cheia }).tipo, "inconclusivo");
});

Deno.test("item sem código ou de outro cliente (filtro ignorado) → inconclusivo, nunca prova", () => {
  const semCodigo = [{ codigo_lancamento_omie: undefined, codigo_cliente_fornecedor: base.cliente }];
  assertEquals(avaliarProvaCliente({ ...base, totalDePaginas: 1, totalDeRegistros: 1, titulos: semCodigo }), { tipo: "inconclusivo", motivo: "titulo_sem_codigo" });
  const outro = [{ codigo_lancamento_omie: 5, codigo_cliente_fornecedor: 999 }];
  assertEquals(avaliarProvaCliente({ ...base, totalDePaginas: 1, totalDeRegistros: 1, titulos: outro }), { tipo: "inconclusivo", motivo: "filtro_cliente_ignorado" });
});

// ── fluxo do run incremental (dependências falsas) ──
// O invariante money-path: qualquer falha em A/B/C LANÇA e a marca d'água NÃO é gravada; o DELETE só
// recebe código com prova; sem a migration, A+B valem e não há reconciliação.

const JANELA = { de: "31/10/2026", ate: "01/11/2026", marca: "2026-11-01" };
type Cand = { codigo: number; cliente: number | null; emissao: string | null };

function falsas(opts: {
  a?: number[];
  b?: number[];
  falhaB?: boolean;
  marcar?: { data?: unknown; error?: { code?: string; message?: string } };
  candidatos?: Cand[];
  prova?: (cliente: number) => { totalDePaginas: unknown; totalDeRegistros: unknown; titulos: Array<{ codigo_lancamento_omie: number; codigo_cliente_fornecedor: number }> };
  falhaProva?: boolean;
  excluir?: { data?: unknown; error?: { code?: string; message?: string } };
}) {
  const log: string[] = [];
  let chamadaLista = 0;
  const deps: DepsIncrementalCR = {
    listarEstrito: (filtros, codigos) => {
      chamadaLista++;
      log.push(chamadaLista === 1 ? "A" : "B");
      if (chamadaLista === 1) {
        if (filtros.filtrar_apenas_titulos_em_aberto !== "S") throw new Error("A sem filtro de aberto");
        for (const c of opts.a ?? [1, 2]) codigos.add(c);
      } else {
        if (filtros.filtrar_por_data_de !== JANELA.de || filtros.filtrar_apenas_alteracao !== "S") throw new Error("B sem janela");
        if (opts.falhaB) return Promise.reject(new Error("B: página vazia antes do piso"));
        for (const c of opts.b ?? [3]) codigos.add(c);
      }
      return Promise.resolve({ paginas: 1, totalSynced: codigos.size });
    },
    marcarAusentes: (vistos) => {
      log.push(`C1:${vistos.join(",")}`);
      return Promise.resolve({
        data: opts.marcar?.data ?? { marcados: 0, limpos: 0, candidatos: opts.candidatos ?? [] },
        error: opts.marcar?.error ?? null,
      });
    },
    listarProva: (cliente) => {
      log.push(`C2:${cliente}`);
      if (opts.falhaProva) return Promise.reject(new Error("Omie fora"));
      return Promise.resolve(opts.prova ? opts.prova(cliente) : { totalDePaginas: 0, totalDeRegistros: 0, titulos: [] });
    },
    excluirConfirmados: (confirmados) => {
      log.push(`C3:${confirmados.map((c) => c.codigo).join(",")}`);
      return Promise.resolve({ data: opts.excluir?.data ?? { excluidos: confirmados.length }, error: opts.excluir?.error ?? null });
    },
    gravarMarca: () => {
      log.push("MARCA");
      return Promise.resolve();
    },
    orcamentoEsgotado: () => false,
    agoraIso: () => "2026-11-02T08:21:00.000Z",
  };
  return { deps, log };
}

// Exige o ramo reconciliado (e estreita o tipo): um "indisponivel" aqui é falha do teste.
function reconciliado<T extends { reconciliacao: string }>(r: T): Extract<T, { reconciliacao: "ok" }> {
  if (r.reconciliacao !== "ok") throw new Error(`esperava reconciliacao ok, veio ${r.reconciliacao}`);
  return r as Extract<T, { reconciliacao: "ok" }>;
}

async function lancaCom(p: Promise<unknown>, trecho: string) {
  let msg = "";
  try {
    await p;
  } catch (e) {
    msg = String(e);
  }
  if (!msg.includes(trecho)) throw new Error(`esperava erro com [${trecho}], veio [${msg}]`);
}

Deno.test("fluxo feliz: A → B → C1 com A∪B → prova → C3 só com o provado → marca POR ÚLTIMO", async () => {
  const { deps, log } = falsas({ candidatos: [{ codigo: 9, cliente: 5, emissao: "2026-10-01" }] });
  const r = reconciliado(await executarIncrementalCR(JANELA, deps));
  assertEquals(log, ["A", "B", "C1:1,2,3", "C2:5", "C3:9", "MARCA"]);
  assertEquals([r.reconciliacao, r.abertos, r.vistos, r.excluidos], ["ok", 2, 3, 1]);
});

Deno.test("baixa (sai do aberto, chega em B) e estorno (volta em A) entram em vistos — nunca candidatos", async () => {
  const { deps, log } = falsas({ a: [1, 2, 11], b: [3, 2] });
  await executarIncrementalCR(JANELA, deps);
  assertEquals(log[2], "C1:1,2,11,3");
});

Deno.test("falha em B: lança, sem reconciliação e SEM marca", async () => {
  const { deps, log } = falsas({ falhaB: true });
  await lancaCom(executarIncrementalCR(JANELA, deps), "página vazia antes do piso");
  assertEquals(log, ["A", "B"]);
});

Deno.test("teto/erro do marcar: lança e não grava marca (só a RPC AUSENTE é tolerada)", async () => {
  const { deps, log } = falsas({ marcar: { error: { code: "P0001", message: "fin_cr_marcar_ausentes: TETO" } } });
  await lancaCom(executarIncrementalCR(JANELA, deps), "TETO");
  assertEquals(log.includes("MARCA"), false);
  const perm = falsas({ marcar: { error: { code: "42501", message: "permission denied" } } });
  await lancaCom(executarIncrementalCR(JANELA, perm.deps), "permission denied");
  assertEquals(perm.log.includes("MARCA"), false);
});

Deno.test("migration não aplicada (PGRST202): A+B valem, marca avança, nada é excluído", async () => {
  const { deps, log } = falsas({ marcar: { error: { code: "PGRST202", message: "Could not find the function" } } });
  const r = await executarIncrementalCR(JANELA, deps);
  assertEquals(log, ["A", "B", "C1:1,2,3", "MARCA"]);
  assertEquals(r.reconciliacao, "indisponivel");
});

Deno.test("candidato PRESENTE na prova não vai ao DELETE; inconclusivo e sem cliente também não", async () => {
  const { deps, log } = falsas({
    candidatos: [
      { codigo: 9, cliente: 5, emissao: "2026-10-01" },
      { codigo: 8, cliente: null, emissao: "2026-10-01" },
      { codigo: 7, cliente: 6, emissao: "2026-10-01" },
    ],
    prova: (cliente) => cliente === 5
      ? { totalDePaginas: 1, totalDeRegistros: 1, titulos: [{ codigo_lancamento_omie: 9, codigo_cliente_fornecedor: 5 }] }
      : { totalDePaginas: 2, totalDeRegistros: 150, titulos: [{ codigo_lancamento_omie: 1, codigo_cliente_fornecedor: 6 }] },
  });
  const r = reconciliado(await executarIncrementalCR(JANELA, deps));
  assertEquals(log, ["A", "B", "C1:1,2,3", "C2:5", "C2:6", "MARCA"]);
  assertEquals([r.presentes, r.inconclusivos, r.excluidos], [1, 2, 0]);
});

Deno.test("falha na prova ou no excluir: lança e não grava marca", async () => {
  const prova = falsas({ candidatos: [{ codigo: 9, cliente: 5, emissao: "2026-10-01" }], falhaProva: true });
  await lancaCom(executarIncrementalCR(JANELA, prova.deps), "Omie fora");
  assertEquals(prova.log.includes("MARCA") || prova.log.some((l) => l.startsWith("C3")), false);
  const exc = falsas({ candidatos: [{ codigo: 9, cliente: 5, emissao: "2026-10-01" }], excluir: { error: { message: "violates not-null" } } });
  await lancaCom(executarIncrementalCR(JANELA, exc.deps), "violates not-null");
  assertEquals(exc.log.includes("MARCA"), false);
});

Deno.test("parcelas da mesma NF dividem 1 prova; teto de provas por run adia o resto", async () => {
  const mesma = falsas({ candidatos: [
    { codigo: 9, cliente: 5, emissao: "2026-10-01" },
    { codigo: 10, cliente: 5, emissao: "2026-10-01" },
  ] });
  const r1 = reconciliado(await executarIncrementalCR(JANELA, mesma.deps));
  assertEquals([mesma.log.filter((l) => l.startsWith("C2")).length, r1.excluidos], [1, 2]);
  const muitos = falsas({ candidatos: Array.from({ length: 12 }, (_, i) => ({ codigo: 100 + i, cliente: 500 + i, emissao: "2026-10-01" })) });
  const r2 = reconciliado(await executarIncrementalCR(JANELA, muitos.deps));
  assertEquals([r2.provas, r2.adiados, r2.excluidos], [10, 2, 10]);
});

Deno.test("retorno do marcar sem lista de candidatos: lança (ausente ≠ vazio)", async () => {
  const { deps, log } = falsas({ marcar: { data: { marcados: 0 } } });
  await lancaCom(executarIncrementalCR(JANELA, deps), "sem lista de candidatos");
  assertEquals(log.includes("MARCA"), false);
});
