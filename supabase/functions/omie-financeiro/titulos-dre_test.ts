// O 1.001º título do mês tem de chegar ao `calcularDRE`.
//
// O fake imita as duas propriedades do PostgREST que tornavam o select único perigoso:
//   1. `max-rows` = 1.000: CADA resposta é capada em 1.000 linhas, em silêncio, sem erro;
//   2. sem `.order()` a ordem entre requests NÃO é estável — aqui, deliberadamente rotacionada
//      a cada request, para que paginar por offset sem ordem duplique/pule linhas e o teste veja.
import {
  buscarTitulosCaixa,
  buscarTitulosCompetencia,
  type BancoTitulos,
  type QueryTitulos,
  TETO_TITULOS_MES,
  TetoTitulosExcedido,
} from "./titulos-dre.ts";

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
    valor_documento: 1,
  }));
  const chamadas: string[][] = [];
  let requests = 0;
  const db: BancoTitulos = {
    from<T>(tabela: string): QueryTitulos<T> {
      const passos: string[] = [`from:${tabela}`];
      let ordenado = false;
      let cursor: string | null = null;
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
          if (c === "id") cursor = String(v);
          return q;
        },
        or: (f) => (passos.push(`or:${f}`), q),
        order: (c, o) => {
          passos.push(`order:${c}:${o?.ascending === false ? "desc" : "asc"}`);
          ordenado = c === "id" && o?.ascending !== false;
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
          const base = ordenado
            ? [...linhas].sort((a, b) => String(a.id) < String(b.id) ? -1 : 1)
            : [...linhas.slice(k), ...linhas.slice(0, k)];
          const filtradas = cursor === null ? base : base.filter((l) => String(l.id) > cursor!);
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
