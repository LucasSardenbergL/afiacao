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

function bancoFake(total: number, opts: { infinito?: boolean } = {}) {
  const linhas: Linha[] = Array.from({ length: total }, (_, i) => ({
    id: `id-${String(i).padStart(6, "0")}`,
    valor_documento: 1,
  }));
  const chamadas: string[][] = [];
  let requests = 0;
  const db: BancoTitulos = {
    from<T>(tabela: string): QueryTitulos<T> {
      const passos: string[] = [`from:${tabela}`];
      let ordenado = false;
      let faixa: [number, number] | null = null;
      const q: QueryTitulos<T> = {
        select: (c) => (passos.push(`select:${c}`), q),
        eq: (c, v) => (passos.push(`eq:${c}=${v}`), q),
        neq: (c, v) => (passos.push(`neq:${c}=${v}`), q),
        in: (c, v) => (passos.push(`in:${c}=${v.join("|")}`), q),
        gte: (c, v) => (passos.push(`gte:${c}=${v}`), q),
        lt: (c, v) => (passos.push(`lt:${c}=${v}`), q),
        or: (f) => (passos.push(`or:${f}`), q),
        order: (c, o) => {
          passos.push(`order:${c}:${o?.ascending === false ? "desc" : "asc"}`);
          ordenado = c === "id" && o?.ascending !== false;
          return q;
        },
        range: (de, ate) => (passos.push(`range:${de}-${ate}`), faixa = [de, ate], q),
        then(onOk, onErr) {
          requests++;
          chamadas.push(passos);
          if (requests > 100) return Promise.reject(new Error("laço não converge")).then(onOk, onErr);
          if (opts.infinito) {
            const pagina = Array.from({ length: MAX_ROWS }, (_, i) => ({ id: `inf-${requests}-${i}` }));
            return Promise.resolve({ data: pagina as T[], error: null }).then(onOk, onErr);
          }
          // Sem `.order()` estável: ordem rotacionada a cada request (o Postgres não promete nada).
          const base = ordenado ? linhas : [...linhas.slice(requests * 7 % total), ...linhas.slice(0, requests * 7 % total)];
          const janela = faixa ? base.slice(faixa[0], faixa[1] + 1) : base;
          return Promise.resolve({ data: janela.slice(0, MAX_ROWS) as T[], error: null }).then(onOk, onErr);
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
