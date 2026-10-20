// Testa o CÓDIGO REAL de `fetchAllParticionadoUuid` e `criarLimitador` (não uma cópia) no Deno.
// Roda com: deno test supabase/functions/_shared/paginate-particionado_test.ts
//
// O banco de memória aplica o contrato do `build` (gte/lt/gt/order/limit) sobre uma coleção de
// uuids que inclui as FRONTEIRAS: o mínimo, o máximo, cada limite exato e o vizinho imediatamente
// abaixo de cada limite. A asserção de completude é a IGUALDADE INTEGRAL com a coleção ordenada —
// não "veio o mesmo número de linhas" —, e cada sabotagem do call-site tem par com o controle verde.
import { criarLimitador, fetchAllParticionadoUuid, LIMITES_UUID_8, type FaixaUuid } from "./paginate-particionado.ts";
import { FalhaLeituraCritica } from "./leitura-critica.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a).slice(0, 300)} !== ${JSON.stringify(b).slice(0, 300)}`);
  }
}

/** Falha em domínio FECHADO, afirmada pelo CÓDIGO (não por "lançou algo"). */
async function assertFalha(fn: () => Promise<unknown>, codigo: string, naoDeveVazar?: string) {
  let capturado: unknown = null;
  let rejeitou = false;
  try {
    await fn();
  } catch (e) {
    rejeitou = true;
    capturado = e;
  }
  if (!rejeitou) throw new Error(`esperava lançar ${codigo}, mas resolveu`);
  if (!(capturado instanceof FalhaLeituraCritica)) {
    throw new Error(`esperava FalhaLeituraCritica, veio ${(capturado as Error)?.name}: ${(capturado as Error)?.message}`);
  }
  assertEquals(capturado.codigo, codigo, `código errado — esperava ${codigo}, veio ${capturado.codigo}`);
  if (naoDeveVazar !== undefined && capturado.message.includes(naoDeveVazar)) {
    throw new Error(`vazou ${JSON.stringify(naoDeveVazar)} na mensagem pública: ${capturado.message}`);
  }
}

/** Uuid canônico a partir de 32 dígitos hex. */
function uuid(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

/** Gerador determinístico (LCG) — a suíte não pode depender de sorte. */
function gerador(semente: number) {
  let x = semente >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
}

function uuidsAleatorios(n: number, semente = 42): string[] {
  const r = gerador(semente);
  const out = new Set<string>();
  while (out.size < n) {
    let hex = "";
    for (let i = 0; i < 4; i++) hex += r().toString(16).padStart(8, "0");
    out.add(uuid(hex));
  }
  return [...out];
}

/** Fronteiras: mínimo, máximo, cada limite e o vizinho logo abaixo dele. */
function uuidsDeFronteira(): string[] {
  const out = [uuid("0".repeat(32)), uuid("f".repeat(32))];
  for (const lim of LIMITES_UUID_8) {
    out.push(lim);
    const h = lim[0];
    const anterior = (parseInt(h, 16) - 1).toString(16);
    out.push(uuid(anterior + "f".repeat(31)));
  }
  return out;
}

type Linha = { id: string; valor: number };

function colecao(n: number): Linha[] {
  const ids = [...new Set([...uuidsAleatorios(n), ...uuidsDeFronteira()])];
  return ids.map((id, i) => ({ id, valor: i }));
}

function ordenada(linhas: Linha[]): Linha[] {
  return [...linhas].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

interface Sabotagem {
  semDe?: boolean;          // esquece o .gte(de)
  semAte?: boolean;         // esquece o .lt(ate)
  deExclusivo?: boolean;    // .gt(de) no lugar de .gte(de) — perde a linha da fronteira
  capServidor?: number;     // max-rows do servidor menor que o limite pedido
}

/** Banco de memória que aplica o contrato do build sobre o estado ATUAL de `estado()`. */
function fakeBanco(estado: () => Linha[], sab: Sabotagem = {}) {
  const chamadas: Array<{ faixa: FaixaUuid; cursor: string | null }> = [];
  const build = (faixa: FaixaUuid, cursor: string | null, limite: number) => {
    chamadas.push({ faixa, cursor });
    const janela = ordenada(estado()).filter((l) =>
      (sab.semDe || faixa.de === null || (sab.deExclusivo ? l.id > faixa.de : l.id >= faixa.de)) &&
      (sab.semAte || faixa.ate === null || l.id < faixa.ate) &&
      (cursor === null || l.id > cursor)
    ).slice(0, Math.min(limite, sab.capServidor ?? Infinity));
    return Promise.resolve({ data: janela, error: null });
  };
  return { build, chamadas };
}

Deno.test("completude: igualdade INTEGRAL com a coleção ordenada, fronteiras incluídas (5.000 + 16 de borda)", async () => {
  const dados = colecao(5000);
  const { build } = fakeBanco(() => dados);
  const lido = await fetchAllParticionadoUuid(build, (l) => l.id, "t");
  assertEquals(lido, ordenada(dados));
  // As 16 de borda estão lá — a igualdade já cobre, mas o motivo do teste fica explícito.
  for (const f of uuidsDeFronteira()) {
    if (!lido.some((l) => l.id === f)) throw new Error(`fronteira ${f} sumiu`);
  }
});

Deno.test("tabela vazia: [] e uma requisição por faixa", async () => {
  const { build, chamadas } = fakeBanco(() => []);
  assertEquals(await fetchAllParticionadoUuid(build, (l) => l.id, "t"), []);
  assertEquals(chamadas.length, LIMITES_UUID_8.length + 1);
});

Deno.test("max-rows do servidor menor que o pedido (300 < 1000): continua completo", async () => {
  const dados = colecao(4000);
  const { build } = fakeBanco(() => dados, { capServidor: 300 });
  assertEquals(await fetchAllParticionadoUuid(build, (l) => l.id, "t"), ordenada(dados));
});

Deno.test("SABOTAGEM .gt(de) no lugar de .gte(de): a comparação integral DETECTA a perda (controle do teste)", async () => {
  // Não há linha fora da faixa aqui — a guarda de pertencimento não vê nada. Quem pega é a
  // igualdade integral: este teste prova que ela discrimina, para que o verde do 1º teste valha.
  const dados = colecao(2000);
  const { build } = fakeBanco(() => dados, { deExclusivo: true });
  const lido = await fetchAllParticionadoUuid(build, (l) => l.id, "t");
  const perdidas = ordenada(dados).filter((l) => !lido.some((x) => x.id === l.id)).map((l) => l.id);
  assertEquals(perdidas, [...LIMITES_UUID_8], "a sabotagem deveria perder exatamente as linhas-limite");
});

Deno.test("SABOTAGEM sem .lt(ate): KEYSET_PAGINA_SOBREPOSTA, sem o uuid na mensagem pública", async () => {
  const dados = colecao(500);
  const { build } = fakeBanco(() => dados, { semAte: true });
  await assertFalha(() => fetchAllParticionadoUuid(build, (l) => l.id, "fin_contas_receber"), "KEYSET_PAGINA_SOBREPOSTA", dados[0].id.slice(0, 8));
});

Deno.test("SABOTAGEM sem .gte(de): KEYSET_PAGINA_SOBREPOSTA", async () => {
  const dados = colecao(500);
  const { build } = fakeBanco(() => dados, { semDe: true });
  await assertFalha(() => fetchAllParticionadoUuid(build, (l) => l.id, "t"), "KEYSET_PAGINA_SOBREPOSTA");
});

Deno.test("guarda ISOLADA: página ordenada e única, mas com id === ate numa página POSTERIOR → lança", async () => {
  // Página 1 legítima; página 2 traz exatamente o limite superior da faixa 0 (fronteira exclusiva).
  const faixa0 = ordenada(colecao(3000)).filter((l) => l.id < LIMITES_UUID_8[0]);
  const build = (faixa: FaixaUuid, cursor: string | null, limite: number) => {
    if (faixa.de !== null) return Promise.resolve({ data: [] as Linha[], error: null });
    const resto = faixa0.filter((l) => cursor === null || l.id > cursor).slice(0, Math.min(limite, 100));
    if (cursor !== null && resto.length === 0) {
      return Promise.resolve({ data: [{ id: LIMITES_UUID_8[0], valor: -1 }], error: null });
    }
    return Promise.resolve({ data: resto, error: null });
  };
  await assertFalha(() => fetchAllParticionadoUuid(build, (l) => l.id, "t"), "KEYSET_PAGINA_SOBREPOSTA");
});

Deno.test("chave não canônica (MAIÚSCULA): KEYSET_FORA_DE_ORDEM", async () => {
  const dados = colecao(50).map((l) => ({ ...l, id: l.id.toUpperCase() }));
  const build = (_f: FaixaUuid, cursor: string | null) =>
    Promise.resolve({ data: cursor === null ? dados.slice(0, 1) : [], error: null });
  await assertFalha(() => fetchAllParticionadoUuid(build, (l) => l.id, "t"), "KEYSET_FORA_DE_ORDEM");
});

Deno.test("chave ausente: cai na guarda do keyset (KEYSET_CHAVE_AUSENTE), não passa", async () => {
  const build = (_f: FaixaUuid, cursor: string | null) =>
    Promise.resolve({ data: cursor === null ? [{ valor: 1 } as unknown as Linha] : [], error: null });
  await assertFalha(() => fetchAllParticionadoUuid(build, (l) => l.id, "t"), "KEYSET_CHAVE_AUSENTE");
});

for (const [nome, falha, codigo] of [
  ["{error} do PostgREST", () => Promise.resolve({ data: null, error: { message: "CPF 529.982.247-25 boom", code: "57014" } }), "57014"],
  ["data:null sem error", () => Promise.resolve({ data: null, error: null }), "MALFORMADA"],
  ["build que REJEITA", () => Promise.reject(new Error("CPF 529.982.247-25 fetch caiu")), "REJEITADA"],
] as const) {
  Deno.test(`fail-closed: ${nome} na 2ª página de UMA faixa → a leitura INTEIRA rejeita (${codigo}), sem parcial`, async () => {
    const dados = colecao(6000);
    const base = fakeBanco(() => dados, { capServidor: 200 });
    let paginasFaixa3 = 0;
    const build = (faixa: FaixaUuid, cursor: string | null, limite: number) => {
      if (faixa.de === LIMITES_UUID_8[2] && ++paginasFaixa3 === 2) {
        return falha() as unknown as Promise<{ data: Linha[] | null; error: null }>;
      }
      return base.build(faixa, cursor, limite);
    };
    await assertFalha(() => fetchAllParticionadoUuid(build, (l) => l.id, "t"), codigo, "529.982");
  });
}

Deno.test("falha numa faixa INTERROMPE as irmãs: nenhuma página nova é pedida depois da falha", async () => {
  const dados = colecao(8000);
  const base = fakeBanco(() => dados, { capServidor: 100 });
  let falhouEm = -1;
  let chamadas = 0;
  const depoisDaFalha: number[] = [];
  const build = async (faixa: FaixaUuid, cursor: string | null, limite: number) => {
    const n = ++chamadas;
    if (falhouEm >= 0) depoisDaFalha.push(n);
    await new Promise((r) => setTimeout(r, 1));
    if (faixa.de === LIMITES_UUID_8[0] && cursor !== null && falhouEm < 0) {
      falhouEm = n;
      return { data: null, error: { message: "x", code: "57014" } };
    }
    return base.build(faixa, cursor, limite);
  };
  // Teto 2: a fila fica cheia de páginas esperando — exatamente as que a interrupção tem de barrar.
  await assertFalha(
    () => fetchAllParticionadoUuid(build, (l) => l.id, "t", { limitador: criarLimitador(2) }),
    "57014",
  );
  // Espera as faixas irmãs drenarem — a falha delas é engolida pelo Promise.all já rejeitado.
  await new Promise((r) => setTimeout(r, 50));
  // Com 8.000 linhas a 100 por página seriam ~89 requisições; só podem sobrar as que já estavam em voo.
  if (depoisDaFalha.length > 2) {
    throw new Error(`as faixas irmãs seguiram paginando após a falha: ${depoisDaFalha.length} requisições`);
  }
});

Deno.test("limitador COMPARTILHADO entre duas leituras: nunca passa do teto, e as duas completam", async () => {
  const a = colecao(3000);
  const b = colecao(2000).map((l) => ({ ...l, valor: -l.valor }));
  let emVoo = 0;
  let pico = 0;
  const lento = (dados: Linha[]) => {
    const base = fakeBanco(() => dados, { capServidor: 250 });
    return async (faixa: FaixaUuid, cursor: string | null, limite: number) => {
      emVoo++;
      pico = Math.max(pico, emVoo);
      await new Promise((r) => setTimeout(r, 2));
      emVoo--;
      return base.build(faixa, cursor, limite);
    };
  };
  const limitador = criarLimitador(3);
  const [ra, rb] = await Promise.all([
    fetchAllParticionadoUuid(lento(a), (l) => l.id, "a", { limitador }),
    fetchAllParticionadoUuid(lento(b), (l) => l.id, "b", { limitador }),
  ]);
  assertEquals(ra, ordenada(a));
  assertEquals(rb, ordenada(b));
  if (pico > 3) throw new Error(`pico de ${pico} requisições em voo, teto era 3`);
  if (pico < 3) throw new Error(`pico de ${pico}: o limitador serializou demais (controle de que houve concorrência)`);
});

Deno.test("faixas concluindo FORA de ordem: a saída segue a ordem das faixas, não a de chegada", async () => {
  const dados = colecao(3000);
  const base = fakeBanco(() => dados);
  // A faixa 0 é a mais LENTA: se a saída fosse por ordem de conclusão, ela viria por último.
  const build = async (faixa: FaixaUuid, cursor: string | null, limite: number) => {
    await new Promise((r) => setTimeout(r, faixa.de === null ? 20 : 1));
    return base.build(faixa, cursor, limite);
  };
  assertEquals(await fetchAllParticionadoUuid(build, (l) => l.id, "t"), ordenada(dados));
});

Deno.test("INSERT concorrente ATRÁS do cursor entre páginas: nada duplica, nada do original some", async () => {
  // O offset paginado (fetchAll) duplicaria aqui: cada INSERT antes do offset empurra a página.
  const original = colecao(3000);
  const estado = [...original];
  const novos = uuidsAleatorios(400, 7).filter((id) => !estado.some((l) => l.id === id));
  let i = 0;
  const base = fakeBanco(() => estado, { capServidor: 100 });
  const build = (faixa: FaixaUuid, cursor: string | null, limite: number) => {
    if (i < novos.length) estado.push({ id: novos[i++], valor: -1 });
    return base.build(faixa, cursor, limite);
  };
  const lido = await fetchAllParticionadoUuid(build, (l) => l.id, "t");
  const ids = lido.map((l) => l.id);
  if (new Set(ids).size !== ids.length) throw new Error("linha duplicada sob INSERT concorrente");
  for (const l of original) if (!ids.includes(l.id)) throw new Error(`linha original ${l.id} sumiu`);
});

Deno.test("limites inválidos (fora de ordem) → lança antes de ler", async () => {
  const { build, chamadas } = fakeBanco(() => []);
  let lancou = false;
  try {
    await fetchAllParticionadoUuid(build, (l) => l.id, "t", { limites: [LIMITES_UUID_8[3], LIMITES_UUID_8[1]] });
  } catch (e) {
    lancou = (e as Error).message.includes("limites de partição inválidos");
  }
  if (!lancou) throw new Error("aceitou limites fora de ordem");
  assertEquals(chamadas.length, 0);
});
