// O 1.001º título do mês tem de chegar ao `calcularDRE`.
//
// O fake imita as duas propriedades do PostgREST que tornavam o select único perigoso:
//   1. `max-rows` = 1.000: CADA resposta é capada em 1.000 linhas, em silêncio, sem erro;
//   2. sem `.order()` a ordem entre requests NÃO é estável — aqui, deliberadamente rotacionada
//      a cada request, para que paginar por offset sem ordem duplique/pule linhas e o teste veja.
import {
  buscarTitulosCaixa,
  carregarBaixaMap,
  buscarTitulosCompetencia,
  type BancoTitulos,
  type QueryTitulos,
  TETO_TITULOS_MES,
  TetoTitulosExcedido,
} from "./titulos-dre.ts";
import { FalhaLeituraCritica } from "../_shared/leitura-critica.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const MAX_ROWS = 1000;
type Linha = Record<string, unknown>;

// `antesDoRequest(n, linhas)` roda antes de responder o request n (1-based) — é onde o teste
// injeta a escrita concorrente do sync (INSERT/re-datação) entre duas páginas.
function bancoFake(
  total: number,
  opts: { infinito?: boolean; antesDoRequest?: (n: number, linhas: Linha[]) => void } = {},
) {
  const linhas: Linha[] = Array.from({ length: total }, (_, i) => ({
    id: `id-${String(i * 10).padStart(7, "0")}`,
    omie_codigo_lancamento: 1_000_000 + i * 10,
    data_baixa_final: "2026-09-15",
    valor_documento: 1,
  }));
  const chamadas: string[][] = [];
  let requests = 0;
  const db: BancoTitulos = {
    from<T>(tabela: string): QueryTitulos<T> {
      const passos: string[] = [`from:${tabela}`];
      let ordenadoPor: string | null = null;
      let cursorCol: string | null = null;
      let cursor: string | number | null = null;
      let limite: number | null = null;
      const q: QueryTitulos<T> = {
        select: (c) => (passos.push(`select:${c}`), q),
        eq: (c, v) => (passos.push(`eq:${c}=${v}`), q),
        neq: (c, v) => (passos.push(`neq:${c}=${v}`), q),
        in: (c, v) => (passos.push(`in:${c}=${v.join("|")}`), q),
        gte: (c, v) => (passos.push(`gte:${c}=${v}`), q),
        lt: (c, v) => (passos.push(`lt:${c}=${v}`), q),
        gt: (c, v) => {
          passos.push(`gt:${c}=${v}`);
          cursorCol = c;
          cursor = v as string | number;
          return q;
        },
        or: (f) => (passos.push(`or:${f}`), q),
        order: (c, o) => {
          passos.push(`order:${c}:${o?.ascending === false ? "desc" : "asc"}`);
          ordenadoPor = o?.ascending !== false ? c : null;
          return q;
        },
        limit: (n) => (passos.push(`limit:${n}`), limite = n, q),
        then(onOk, onErr) {
          requests++;
          chamadas.push(passos);
          if (requests > 100) return Promise.reject(new Error("laço não converge")).then(onOk, onErr);
          if (opts.infinito) {
            const pagina = Array.from({ length: MAX_ROWS }, (_, i) => ({
              id: `inf-${String(requests).padStart(4, "0")}-${String(i).padStart(4, "0")}`,
            }));
            return Promise.resolve({ data: pagina as T[], error: null }).then(onOk, onErr);
          }
          opts.antesDoRequest?.(requests, linhas);
          // Sem `.order()` estável: ordem rotacionada a cada request (o Postgres não promete nada).
          const k = (requests * 7) % Math.max(linhas.length, 1);
          const col = ordenadoPor;
          const base = col
            ? [...linhas].sort((a, b) => (a[col] as string | number) < (b[col] as string | number) ? -1 : 1)
            : [...linhas.slice(k), ...linhas.slice(0, k)];
          const filtradas = cursor === null || cursorCol === null
            ? base
            : base.filter((l) => (l[cursorCol!] as string | number) > cursor!);
          const janela = filtradas.slice(0, Math.min(limite ?? Infinity, MAX_ROWS));
          return Promise.resolve({ data: janela as T[], error: null }).then(onOk, onErr);
        },
      };
      return q;
    },
  };
  return { db, chamadas };
}

const PERIODO = { company: "oben", inicioMes: "2026-09-01", fimMes: "2026-10-01" };

function idsDistintos(rows: Linha[]) {
  return new Set(rows.map((r) => r.id)).size;
}

Deno.test("competência: mês com 1.001 títulos devolve os 1.001 (nenhum capado em 1.000)", async () => {
  const { db, chamadas } = bancoFake(1001);
  const rows = await buscarTitulosCompetencia(db, { ...PERIODO, tabela: "fin_contas_receber", select: "valor_documento" });
  assertEquals(rows.length, 1001, `competência devolveu ${rows.length} linhas, esperado 1001`);
  assertEquals(idsDistintos(rows), 1001, "competência devolveu linha duplicada/pulada entre páginas");
  // Filtros de negócio preservados na query real (não só a paginação).
  const q = chamadas[0];
  for (const passo of ["eq:company=oben", "neq:status_titulo=CANCELADO", "gte:data_emissao=2026-09-01", "lt:data_emissao=2026-10-01"]) {
    if (!q.includes(passo)) throw new Error(`competência perdeu o filtro ${passo}: ${q.join(" · ")}`);
  }
});

Deno.test("caixa: mês com 1.001 títulos devolve os 1.001, com o .or() de baixa/vencimento intacto", async () => {
  const { db, chamadas } = bancoFake(1001);
  const rows = await buscarTitulosCaixa(db, {
    ...PERIODO,
    tabela: "fin_contas_pagar",
    select: "valor_documento",
    statuses: ["PAGO", "PARCIAL", "LIQUIDADO"],
    colunaBaixa: "data_pagamento",
  });
  assertEquals(rows.length, 1001, `caixa devolveu ${rows.length} linhas, esperado 1001`);
  assertEquals(idsDistintos(rows), 1001, "caixa devolveu linha duplicada/pulada entre páginas");
  const q = chamadas[0];
  const or = "or:and(data_pagamento.gte.2026-09-01,data_pagamento.lt.2026-10-01),and(data_pagamento.is.null,data_vencimento.gte.2026-09-01,data_vencimento.lt.2026-10-01)";
  for (const passo of ["eq:company=oben", "in:status_titulo=PAGO|PARCIAL|LIQUIDADO", or]) {
    if (!q.includes(passo)) throw new Error(`caixa perdeu o filtro ${passo}: ${q.join(" · ")}`);
  }
});

Deno.test("mês pequeno (abaixo do cap) devolve exatamente o mesmo conjunto — não-regressão", async () => {
  const { db } = bancoFake(655); // pior mês medido em prod (2026-10-20)
  const rows = await buscarTitulosCompetencia(db, { ...PERIODO, tabela: "fin_contas_receber", select: "valor_documento" });
  assertEquals(rows.length, 655);
  assertEquals(idsDistintos(rows), 655);
});

Deno.test("teto: servidor que nunca esvazia LANÇA TetoTitulosExcedido em vez de devolver parcial", async () => {
  const { db, chamadas } = bancoFake(0, { infinito: true });
  let pego: unknown = null;
  try {
    await buscarTitulosCompetencia(db, { ...PERIODO, tabela: "fin_contas_receber", select: "valor_documento" });
  } catch (e) {
    pego = e;
  }
  // A marca é a CLASSE (não "lançou algo"): REJEITADA/MALFORMADA aqui seria outro ramo.
  if (!(pego instanceof TetoTitulosExcedido)) throw new Error(`esperava TetoTitulosExcedido, veio ${String(pego)}`);
  assertEquals(chamadas.length, TETO_TITULOS_MES / MAX_ROWS, `requests até o teto: ${chamadas.length}`);
});

// Challenge Codex: com offset, o EOF por página VAZIA faz uma 2ª requisição mesmo num mês de 655
// títulos, e um INSERT do sync ANTES do offset entre as duas devolvia o último título de novo.
Deno.test("INSERT concorrente entre páginas não duplica nem pula título pré-existente", async () => {
  const { db } = bancoFake(655, {
    antesDoRequest: (n, linhas) => {
      // Entre a 1ª e a 2ª página: um título novo cuja chave cai ANTES de tudo o que já foi lido.
      if (n === 2) linhas.push({ id: "id-0000005", valor_documento: 1 });
    },
  });
  const rows = await buscarTitulosCompetencia(db, { ...PERIODO, tabela: "fin_contas_receber", select: "valor_documento" });
  assertEquals(idsDistintos(rows), rows.length, `duplicata: ${rows.length} linhas, ${idsDistintos(rows)} distintas`);
  assertEquals(rows.length, 655, `esperava os 655 pré-existentes (o novo entrou atrás do cursor), veio ${rows.length}`);
});

Deno.test("mês de 2.500 títulos com INSERT no meio da leitura: todos os pré-existentes, sem duplicata", async () => {
  const { db } = bancoFake(2500, {
    antesDoRequest: (n, linhas) => {
      if (n === 2) linhas.push({ id: "id-0000001", valor_documento: 1 });
    },
  });
  const rows = await buscarTitulosCaixa(db, {
    ...PERIODO,
    tabela: "fin_contas_receber",
    select: "valor_documento",
    statuses: ["RECEBIDO"],
    colunaBaixa: "data_recebimento",
  });
  assertEquals(idsDistintos(rows), rows.length, "duplicata entre páginas");
  assertEquals(rows.length, 2500);
});

// Ressalva do Codex no #3234: o mapa de baixas era OFFSET sobre a view inteira (~29 páginas na
// colacor CR). Um movimento novo do sync entre páginas deslocava o offset e PULAVA uma baixa.
Deno.test("baixaMap: 2.500 baixas com INSERT entre páginas — nenhuma pré-existente some", async () => {
  const { db, chamadas } = bancoFake(2500, {
    antesDoRequest: (n, linhas) => {
      if (n === 2) linhas.push({ id: "id-novo", omie_codigo_lancamento: 5, data_baixa_final: "2026-09-01" });
    },
  });
  const mapa = await carregarBaixaMap(db, "colacor", "CR");
  for (let i = 0; i < 2500; i++) {
    if (!mapa.has(1_000_000 + i * 10)) throw new Error(`baixa pré-existente ${1_000_000 + i * 10} sumiu do mapa (${mapa.size} no mapa)`);
  }
  const q = chamadas[0];
  for (const passo of ["from:v_titulo_baixas", "eq:company=colacor", "eq:tipo=CR", "order:omie_codigo_lancamento:asc"]) {
    if (!q.includes(passo)) throw new Error(`baixaMap perdeu ${passo}: ${q.join(" · ")}`);
  }
});

Deno.test("baixaMap: chave numérica ordena como NÚMERO (9 < 10), não como texto", async () => {
  const { db } = bancoFake(0, {
    antesDoRequest: (n, linhas) => {
      if (n === 1) for (const c of [9, 10, 100, 1000]) linhas.push({ id: `x${c}`, omie_codigo_lancamento: c, data_baixa_final: "2026-09-01" });
    },
  });
  const mapa = await carregarBaixaMap(db, "oben", "CP");
  assertEquals([...mapa.keys()], [9, 10, 100, 1000]);
});

// Codex (P2): o INSERT acima não separa OFFSET de keyset — a duplicata do offset some no Map.
// O que separa é uma baixa que SAI do recorte atrás do cursor: o offset pula uma sobrevivente.
Deno.test("baixaMap: baixa que sai do recorte entre páginas não faz nenhuma sobrevivente sumir", async () => {
  const { db } = bancoFake(2500, {
    antesDoRequest: (n, linhas) => {
      if (n === 2) linhas.splice(0, 1); // a de menor código (já lida) sai antes da 2ª página
    },
  });
  const mapa = await carregarBaixaMap(db, "colacor", "CR");
  for (let i = 1; i < 2500; i++) {
    if (!mapa.has(1_000_000 + i * 10)) throw new Error(`baixa sobrevivente ${1_000_000 + i * 10} sumiu do mapa (${mapa.size} no mapa)`);
  }
});

Deno.test("baixaMap: código acima de 2^53 LANÇA em vez de arredondar e pular o vizinho", async () => {
  const { db } = bancoFake(0, {
    antesDoRequest: (n, linhas) => {
      if (n === 1) linhas.push({ id: "x", omie_codigo_lancamento: 9007199254740996, data_baixa_final: "2026-09-01" });
    },
  });
  let pego: unknown = null;
  try {
    await carregarBaixaMap(db, "oben", "CR");
  } catch (e) {
    pego = e;
  }
  if (!(pego instanceof FalhaLeituraCritica) || pego.codigo !== "MALFORMADA") {
    throw new Error(`esperava FalhaLeituraCritica MALFORMADA, veio ${String(pego)}`);
  }
});
