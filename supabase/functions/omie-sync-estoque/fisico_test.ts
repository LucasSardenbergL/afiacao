import { criarAcumuladorFisico, exigirFisicoPublicavel, type LinhaPosEstoque, MARCA_FISICO } from "./fisico.ts";

function igual<T>(real: T, esperado: T, msg: string): void {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a !== b) throw new Error(`${msg}\n  real:     ${a}\n  esperado: ${b}`);
}

function contem(texto: string | null, trecho: string, msg: string): void {
  if (texto === null || !texto.includes(trecho)) throw new Error(`${msg}\n  texto: ${texto}\n  esperado conter: ${trecho}`);
}

const HAB = new Set(["101", "102"]);
const linha = (nCodProd: unknown, local: unknown, fisico: unknown = 1, reservado: unknown = 0): LinhaPosEstoque => ({
  nCodProd,
  codigo_local_estoque: local,
  fisico,
  reservado,
});

function varrer(paginas: Array<{ itens: LinhaPosEstoque[]; total: unknown }>, esperados = HAB.size) {
  const acc = criarAcumuladorFisico((sku) => HAB.has(sku), esperados);
  for (const p of paginas) acc.pagina(p.itens, p.total);
  return acc;
}

Deno.test("completo: soma os locais do mesmo SKU e só agrega habilitado", () => {
  const acc = varrer([
    { itens: [linha(101, 1, 3, 1), linha(101, 2, 4, 0)], total: 4 },
    { itens: [linha(102, 1, 5, 2), linha(999, 1, 7)], total: 4 },
  ]);
  const v = acc.veredito();
  igual(v.estado, "completo", "lidos = declarados, sem repetição");
  igual(v.motivo, null, "completo não tem motivo");
  igual([...acc.encontrados.entries()], [
    ["101", { fisico: 7, reservado: 1, locais: 2 }],
    ["102", { fisico: 5, reservado: 2, locais: 1 }],
  ], "soma por SKU; o 999 não é habilitado");
  exigirFisicoPublicavel(v, 1); // controle verde: não lança
});

Deno.test("truncada (lidos < declarados) é inconsistente", () => {
  const v = varrer([{ itens: [linha(101, 1), linha(102, 1)], total: 3 }]).veredito();
  igual(v.estado, "inconsistente", "estado");
  contem(v.motivo, "varredura truncada: lidos 2 de 3", "motivo nomeia lidos e declarados");
});

Deno.test("sobre-leitura (lidos > declarados) é inconsistente", () => {
  const v = varrer([{ itens: [linha(101, 1), linha(102, 1), linha(999, 1)], total: 2 }]).veredito();
  igual(v.estado, "inconsistente", "estado");
  contem(v.motivo, "sobre-leitura: lidos 3 de 2", "motivo");
});

Deno.test("total ausente em todas as páginas é desconhecido (o helper antigo lia como 'não truncada')", () => {
  const v = varrer([{ itens: [linha(101, 1), linha(102, 1)], total: undefined }]).veredito();
  igual(v.estado, "desconhecido", "estado");
  contem(v.motivo, "ausente ou inválido", "motivo");
  igual(v.paginasSemTotal, 1, "sensor de página sem total");
});

Deno.test("total inválido (negativo, fracionário, texto) é desconhecido", () => {
  for (const total of [-3, 2.5, "abc", "", Number.NaN]) {
    const v = varrer([{ itens: [linha(101, 1), linha(102, 1)], total }]).veredito();
    igual(v.estado, "desconhecido", `total ${String(total)}`);
  }
});

Deno.test("total ZERO numa página conta como página sem total; zero em todas é desconhecido", () => {
  const v = varrer([
    { itens: [linha(101, 1)], total: 2 },
    { itens: [linha(102, 1)], total: 0 },
  ]).veredito();
  igual([v.estado, v.paginasSemTotal, v.totalDeclarado], ["completo", 1, 2], "uma API que só declara na 1ª página");
  const so0 = varrer([{ itens: [linha(101, 1), linha(102, 1)], total: 0 }]).veredito();
  igual(so0.estado, "desconhecido", "sem nenhum total positivo não há denominador");
});

Deno.test("total como string de dígitos vale, e página sem total não decide se outra declarou", () => {
  const v = varrer([
    { itens: [linha(101, 1)], total: "2" },
    { itens: [linha(102, 1)], total: undefined },
  ]).veredito();
  igual(v.estado, "completo", "\"2\" + página muda");
  igual(v.paginasSemTotal, 1, "sensor");
});

Deno.test("total declarado que muda entre páginas é inconsistente (o catálogo mudou no meio)", () => {
  const v = varrer([
    { itens: [linha(101, 1)], total: 2 },
    { itens: [linha(102, 1)], total: 3 },
  ]).veredito();
  igual(v.estado, "inconsistente", "estado");
  contem(v.motivo, "total declarado mudou entre páginas", "motivo");
});

Deno.test("par produto|local repetido é inconsistente — inclusive de SKU NÃO habilitado", () => {
  const v = varrer([
    { itens: [linha(101, 1), linha(999, 1)], total: 3 },
    { itens: [linha(999, 1)], total: 3 },
  ]).veredito();
  igual(v.estado, "inconsistente", "a contagem fecha (3/3) e mesmo assim recusa");
  contem(v.motivo, "par produto|local repetido (999|1)", "motivo nomeia a chave");
});

Deno.test("linha sem local fica fora da unicidade (sem falso-vermelho) e vai para o sensor", () => {
  const v = varrer([{ itens: [linha(101, undefined), linha(101, null), linha(102, "")], total: 3 }]).veredito();
  igual(v.estado, "completo", "o mesmo produto sem local em duas linhas não é repetição verificável");
  igual(v.linhasSemLocal, 3, "sensor de cobertura");
});

Deno.test("físico ou reservado não finito em SKU habilitado é inconsistente; em não habilitado, ignorado", () => {
  const ruim = varrer([{ itens: [linha(101, 1, "abc"), linha(102, 1)], total: 2 }]).veredito();
  igual(ruim.estado, "inconsistente", "NaN no habilitado");
  contem(ruim.motivo, "não finito em 1 SKU(s) (ex.: 101)", "motivo");
  const inf = varrer([{ itens: [linha(101, 1, 1, Infinity), linha(102, 1)], total: 2 }]).veredito();
  igual(inf.estado, "inconsistente", "Infinity no reservado");
  const fora = varrer([{ itens: [linha(101, 1), linha(102, 1), linha(999, 1, "abc")], total: 3 }]).veredito();
  igual(fora.estado, "completo", "lixo em SKU fora da reposição não bloqueia");
});

Deno.test("nenhum habilitado encontrado com habilitados esperados é inconsistente (inativaria todos)", () => {
  const v = varrer([{ itens: [linha(998, 1), linha(999, 1)], total: 2 }]).veredito();
  igual(v.estado, "inconsistente", "contagem fecha, mas o vazio é inesperado");
  contem(v.motivo, "nenhum dos 2 SKUs habilitados apareceu", "motivo");
});

Deno.test("exigirFisicoPublicavel lança com a MARCA no início, o estado e o relógio da fase", () => {
  const v = varrer([{ itens: [linha(101, 1)], total: 2 }]).veredito();
  let msg = "";
  try {
    exigirFisicoPublicavel(v, 45210);
  } catch (err) {
    msg = (err as Error).message;
  }
  if (!msg.startsWith(`${MARCA_FISICO} inconsistente (físico 45210ms): `)) {
    throw new Error(`mensagem fora do contrato: ${msg}`);
  }
  contem(msg, "nada foi gravado", "fecho da mensagem");
});

// PR-3 do estoque com dono único (2026-10-07): o membro de grupo de equivalência NÃO habilitado entra num mapa À
// PARTE. O motor soma GREATEST(inv, sea.estoque_fisico) por membro, e a linha dele congelava no último valor de quando
// era habilitado (o galão da WP01: 11,72 L de 31/07 com 0 confirmado no Omie). O `encontrados` não muda.
const MEMBROS = new Set(["999"]);
function varrerComMembros(paginas: Array<{ itens: LinhaPosEstoque[]; total: unknown }>, esperados = HAB.size) {
  const acc = criarAcumuladorFisico((sku) => HAB.has(sku), esperados, (sku) => MEMBROS.has(sku));
  for (const p of paginas) acc.pagina(p.itens, p.total);
  return acc;
}

Deno.test("membro de grupo não habilitado: soma os locais num mapa À PARTE, fora do encontrados", () => {
  const acc = varrerComMembros([
    { itens: [linha(101, 1, 3, 1), linha(999, 1, 4, 1), linha(999, 2, 2, 0), linha(888, 1, 9)], total: 4 },
  ]);
  igual(acc.veredito().estado, "completo", "veredito");
  igual([...acc.encontrados.keys()], ["101"], "encontrados só com habilitado");
  igual(acc.membros.get("999"), { fisico: 6, reservado: 1, locais: 2 }, "membro somado nos 2 locais");
  igual(acc.membros.has("888"), false, "quem não é habilitado nem membro segue ignorado");
});

Deno.test("membro achado NÃO mascara o vazio inesperado: só habilitado conta", () => {
  const v = varrerComMembros([{ itens: [linha(999, 1, 5)], total: 1 }]).veredito();
  igual(v.estado, "inconsistente", "estado");
  contem(v.motivo, "nenhum dos 2 SKUs habilitados apareceu", "motivo");
});

Deno.test("membro com físico ilegível é pulado sem derrubar a varredura, e fica no sensor", () => {
  const acc = varrerComMembros([{ itens: [linha(101, 1, 3), linha(999, 1, Number.NaN)], total: 2 }]);
  igual(acc.veredito().estado, "completo", "o habilitado segue publicável");
  igual(acc.membros.has("999"), false, "membro ilegível não vira linha");
  igual(acc.membrosIlegiveis, ["999"], "sensor");
});

Deno.test("membro com UM local ilegível perde a soma inteira (parcial seria físico fabricado), nas duas ordens", () => {
  for (const itens of [
    [linha(101, 1, 3), linha(999, 1, 4), linha(999, 2, "abc")],
    [linha(101, 1, 3), linha(999, 2, "abc"), linha(999, 1, 4)],
  ]) {
    const acc = varrerComMembros([{ itens, total: 3 }]);
    igual(acc.veredito().estado, "completo", "o habilitado segue publicável");
    igual(acc.membros.has("999"), false, "sem soma parcial");
    igual(acc.membrosIlegiveis, ["999"], "sensor");
  }
});
