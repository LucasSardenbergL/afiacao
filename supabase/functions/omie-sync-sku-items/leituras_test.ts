// As leituras da montagem da fila contra um banco de memória que CORTA em 1.000 linhas por resposta,
// como o PostgREST. O cenário é o medido em 2026-10-08 (OBEN, janela de 215 dias): 334 trackings e
// 2.962 linhas de histórico — o `.in()` cru devolvia 1.000 e os trackings da cauda viravam pendentes.
import type { BancoPostgrest, QueryPostgrest, RespostaPostgrest } from "../_shared/paginate.ts";
import {
  carregarControleDaFila,
  carregarIrmas,
  carregarNfesDaJanela,
  carregarTrackingsComLinha,
  emLotes,
} from "./leituras.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const CAP = 1000;

type Linha = Record<string, unknown>;

/** Banco de memória: os filtros que `leituras.ts` usa, e o corte silencioso em `CAP`. */
function bancoDeMemoria(tabelas: Record<string, Linha[]>) {
  const log = { requisicoes: 0, maiorIn: 0 };
  function query(tabela: string): QueryPostgrest<Linha> {
    const preds: Array<(l: Linha) => boolean> = [];
    let ordem: string | null = null;
    let lim: number | null = null;
    let faixa: [number, number] | null = null;
    const q: QueryPostgrest<Linha> = {
      select: () => q,
      eq: (c, v) => (preds.push((l) => l[c] === v), q),
      in: (c, vs) => {
        log.maiorIn = Math.max(log.maiorIn, vs.length);
        const set = new Set(vs.map(String));
        preds.push((l) => l[c] !== null && l[c] !== undefined && set.has(String(l[c])));
        return q;
      },
      gte: (c, v) => (preds.push((l) => String(l[c]) >= String(v)), q),
      gt: (c, v) => (preds.push((l) => String(l[c]) > String(v)), q),
      lt: (c, v) => (preds.push((l) => String(l[c]) < String(v)), q),
      not: (c, op, v) => {
        if (op !== "is" || v !== null) throw new Error(`not(${op}) não suportado no fake`);
        preds.push((l) => l[c] !== null && l[c] !== undefined);
        return q;
      },
      is: (c, v) => (preds.push((l) => l[c] === v), q),
      order: (c, o) => {
        if (o?.ascending === false) throw new Error("fake: só ordem ascendente");
        ordem = c;
        return q;
      },
      range: (de, ate) => ((faixa = [de, ate]), q),
      limit: (n) => ((lim = n), q),
      maybeSingle: () => {
        throw new Error("não usado");
      },
      then: (ok, falha) => {
        log.requisicoes++;
        let rows = (tabelas[tabela] ?? []).filter((l) => preds.every((p) => p(l)));
        if (ordem) {
          const c = ordem;
          rows = [...rows].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0));
        }
        if (faixa) rows = rows.slice(faixa[0], faixa[1] + 1);
        if (lim !== null) rows = rows.slice(0, lim);
        rows = rows.slice(0, CAP); // o corte SILENCIOSO do PostgREST
        const r: RespostaPostgrest<Linha> = { data: rows, error: null };
        return Promise.resolve(r).then(ok, falha);
      },
    };
    return q;
  }
  const db = { from: (t: string) => query(t), rpc: () => Promise.reject(new Error("não usado")) };
  return { db: db as unknown as BancoPostgrest, log };
}

// UUID-like ordenável e determinístico.
const uuid = (pref: string, i: number) => `${pref}${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`;

function cenario215Dias() {
  const trackings = Array.from({ length: 334 }, (_, i) => uuid("a", i));
  // 2.962 linhas de histórico: 10 SKUs por tracking → os 297 primeiros têm linha (o último, 2); os 37 últimos, nenhuma.
  const historico: Linha[] = [];
  let n = 0;
  for (let t = 0; t < 300 && n < 2962; t++) {
    for (let s = 0; s < 10 && n < 2962; s++) {
      historico.push({ id: uuid("h", (n * 7919) % 1_000_003), tracking_id: trackings[t], sku_codigo_omie: s });
      n++;
    }
  }
  return { trackings, historico };
}

Deno.test("trackings com linha: 2.962 linhas de histórico, TODOS os 297 trackings com linha voltam", async () => {
  const { trackings, historico } = cenario215Dias();
  assertEquals(historico.length, 2962, "pré-condição do cenário");
  assertEquals(new Set(historico.map((h) => h.tracking_id)).size, 297, "pré-condição do cenário");
  const { db, log } = bancoDeMemoria({ sku_leadtime_history: historico });
  const comLinha = await carregarTrackingsComLinha(db, trackings);
  assertEquals(comLinha.size, 297, "trackings com linha (os 37 sem histórico ficam de fora)");
  for (let t = 0; t < 297; t++) {
    if (!comLinha.has(trackings[t])) throw new Error(`tracking ${t} tem linha e saiu como "sem linha"`);
  }
  for (let t = 297; t < 334; t++) {
    if (comLinha.has(trackings[t])) throw new Error(`tracking ${t} sem linha apareceu como com linha`);
  }
  // Teto FIXO aqui, não `LOTE_IN`: comparar com a própria constante aprovaria um LOTE_IN de 100.000
  // (falsificado). 200 UUIDs ≈ 7,4 KB de querystring; 334 de uma vez (o v1.4) reprova.
  if (log.maiorIn > 200) throw new Error(`.in() com ${log.maiorIn} valores numa requisição (teto 200)`);
});

Deno.test("trackings com linha: o `.in()` cru do v1.4 perderia trackings (controle do cenário)", async () => {
  // Controle VERDE do teste acima: prova que o cenário EXERCITA o teto — sem isto, um cenário pequeno
  // demais deixaria o teste de cima verde até contra a leitura de uma página só.
  const { trackings, historico } = cenario215Dias();
  const { db } = bancoDeMemoria({ sku_leadtime_history: historico });
  const { data } = await db.from<Linha>("sku_leadtime_history").select("tracking_id").in("tracking_id", trackings);
  const set = new Set((data ?? []).map((r) => r.tracking_id));
  if (set.size >= 297) throw new Error(`cenário não exercita o teto: a leitura crua viu ${set.size} de 297`);
});

Deno.test("controle: mais de 1.000 trackings com controle voltam todos", async () => {
  const ids = Array.from({ length: 1700 }, (_, i) => uuid("c", i));
  const controle = ids.map((id, i) => ({
    tracking_id: id,
    tentativas: i % 5,
    ultima_tentativa: null,
    itens_pendentes: i % 3 === 0 ? 0 : null,
  }));
  const { db } = bancoDeMemoria({ sku_items_sync_controle: controle });
  const mapa = await carregarControleDaFila(db, ids);
  assertEquals(mapa.size, 1700);
  assertEquals(mapa.get(ids[3]), { tentativas: 3, ultima_tentativa: null, itens_pendentes: 0 });
  assertEquals(mapa.get(ids[4])?.itens_pendentes, null, "não medido continua null (ausente ≠ zero)");
});

Deno.test("janela de NF-e: mais de 1.000 linhas, filtros respeitados, ordem t2 DESC + id", async () => {
  const linhas: Linha[] = [];
  for (let i = 0; i < 2500; i++) {
    linhas.push({
      id: uuid("n", (i * 104729) % 1_000_003),
      empresa: i % 10 === 0 ? "COLACOR" : "OBEN",
      t2_data_faturamento: `2026-0${1 + (i % 9)}-15T00:00:00Z`,
      nfe_chave_acesso: i % 50 === 0 ? null : `chave${i}`,
      fornecedor_codigo_omie: i % 2 === 0 ? 8689681266 : 1,
    });
  }
  const { db } = bancoDeMemoria({ purchase_orders_tracking: linhas });
  const esperado = linhas.filter((l) =>
    l.empresa === "OBEN" && String(l.t2_data_faturamento) >= "2026-02-01" && l.nfe_chave_acesso !== null
  );
  const todas = await carregarNfesDaJanela<{ id: string; t2_data_faturamento: string }>(db, {
    empresa: "OBEN",
    cutoffIso: "2026-02-01",
    fornecedor: null,
    colunas: "*",
  });
  assertEquals(todas.length, esperado.length, "janela inteira");
  if (esperado.length <= CAP) throw new Error("cenário não exercita o teto");
  for (let i = 1; i < todas.length; i++) {
    const a = todas[i - 1], b = todas[i];
    if (a.t2_data_faturamento < b.t2_data_faturamento || (a.t2_data_faturamento === b.t2_data_faturamento && a.id >= b.id)) {
      throw new Error(`ordem quebrada em ${i}`);
    }
  }
  const doFornecedor = await carregarNfesDaJanela<{ id: string; t2_data_faturamento: string }>(db, {
    empresa: "OBEN",
    cutoffIso: "2026-02-01",
    fornecedor: 8689681266,
    colunas: "*",
  });
  assertEquals(doFornecedor.length, esperado.filter((l) => l.fornecedor_codigo_omie === 8689681266).length);
});

Deno.test("irmãs: recebimento com muitas linhas volta inteiro, só da empresa, sem o teto", async () => {
  const linhas: Linha[] = [];
  for (let i = 0; i < 1800; i++) {
    linhas.push({ id: uuid("i", i), empresa: i % 13 === 0 ? "COLACOR" : "OBEN", nid_receb: 1000 + (i % 4) });
  }
  const { db } = bancoDeMemoria({ purchase_orders_tracking: linhas });
  const irmas = await carregarIrmas<{ id: string; nid_receb: number }>(db, {
    empresa: "OBEN",
    recebimentos: ["1000", "1001", "1002"],
    colunas: "*",
  });
  const esperado = linhas.filter((l) => l.empresa === "OBEN" && Number(l.nid_receb) <= 1002).length;
  if (esperado <= CAP) throw new Error("cenário não exercita o teto");
  assertEquals(irmas.length, esperado);
});

Deno.test("emLotes: deduplica, respeita o tamanho e recusa tamanho inválido", () => {
  assertEquals(emLotes([1, 2, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(emLotes([], 2), []);
  let lancou = "";
  try {
    emLotes([1], 0);
  } catch (e) {
    lancou = (e as Error).message;
  }
  if (!lancou.startsWith("emLotes: tamanho inválido")) throw new Error(`esperava o ramo de tamanho inválido, veio "${lancou}"`);
});
