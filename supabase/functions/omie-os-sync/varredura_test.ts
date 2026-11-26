// Varredura do ListarOS — quando é íntegra (serve para sumiço) e quando aborta. `--no-remote`: asserts locais.
import { MAX_PAGINAS, varrer, VarreduraAbortada } from "./varredura.ts";

function assertEquals(atual: unknown, esperado: unknown) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}
async function aborta(p: Promise<unknown>, marca: string) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof VarreduraAbortada)) throw new Error(`esperava VarreduraAbortada, veio ${String(e)}`);
    if (!e.message.includes(marca)) throw new Error(`esperava "${marca}", veio "${e.message}"`);
    return;
  }
  throw new Error(`esperava abortar com "${marca}", mas terminou`);
}

const os = (n: number) => ({ Cabecalho: { nCodOS: n, cNumOS: String(n), nCodCli: 7, cEtapa: "20", nValorTotal: 10 },
  InfoCadastro: { cFaturada: "N", cCancelada: "N", dDtInc: "01/11/2026" }, Parcelas: [{ nDias: 30 }] });
const pagina = (cods: number[], tp: unknown = 2, tr: unknown = 3) => ({ total_de_paginas: tp, total_de_registros: tr, osCadastro: cods.map(os) });
const sem = async () => {};
const longe = { deadline: Date.now() + 60_000 };

function fonte(paginas: (Record<string, unknown> | null)[]) {
  return (p: number) => Promise.resolve(p - 1 < paginas.length ? paginas[p - 1] : { osCadastro: [] });
}

Deno.test("íntegra: páginas até a vazia, lidas = distintas = total_de_registros", async () => {
  const gravadas: number[] = [];
  const r = await varrer(fonte([pagina([1, 2]), pagina([3])]), async (l) => { gravadas.push(...l.map((x) => x.n_cod_os)); }, longe);
  assertEquals([r.integra, r.paginas, r.lidas, r.distintas, gravadas], [true, 2, 3, 3, [1, 2, 3]]);
});

Deno.test("íntegra: fim-de-paginação do Omie DEPOIS do piso declarado", async () => {
  const r = await varrer(fonte([pagina([1, 2]), pagina([3]), null]), sem, longe);
  assertEquals(r.integra, true);
});

Deno.test("fim-de-paginação NO MEIO do declarado aborta (não autoriza sumiço do resto)", async () => {
  await aborta(varrer(fonte([pagina([1, 2], 3), null]), sem, longe), "antes do total declarado");
});

Deno.test("página vazia antes do fim declarado aborta", async () => {
  await aborta(varrer(fonte([pagina([1, 2], 3), pagina([])]), sem, longe), "vazia antes do fim declarado");
});

Deno.test("página repetida aborta", async () => {
  await aborta(varrer(fonte([pagina([1, 2], 3, 6), pagina([1, 2], 3, 6)]), sem, longe), "repetid");
});

Deno.test("nCodOS repetido entre páginas sobrepostas aborta (paginação instável)", async () => {
  await aborta(varrer(fonte([pagina([1, 2], 2, 3), pagina([2, 3], 2, 3)]), sem, longe), "repetido na página 2");
});

Deno.test("total_de_registros ausente ou divergente → termina, mas NÃO íntegra", async () => {
  const sem_total = await varrer(fonte([pagina([1, 2], 2, null), pagina([3], 2, null)]), sem, longe);
  assertEquals([sem_total.integra, sem_total.motivo_nao_integra], [false, "total_de_registros não declarado"]);
  const diverge = await varrer(fonte([pagina([1, 2], 2, 4), pagina([3], 2, 4)]), sem, longe);
  assertEquals(diverge.integra, false);
  const vazio = await varrer(fonte([pagina([1, 2], 2, ""), pagina([3], 2, "")]), sem, longe);
  assertEquals(vazio.integra, false);   // "" não vira 0 nem 3
});

Deno.test("OS sem identidade → shape_err, não íntegra, e não é gravada", async () => {
  const gravadas: number[] = [];
  const ruim = { total_de_paginas: 1, total_de_registros: 2, osCadastro: [os(1), { Cabecalho: { nCodOS: "" } }] };
  const r = await varrer(fonte([ruim]), async (l) => { gravadas.push(...l.map((x) => x.n_cod_os)); }, longe);
  assertEquals([r.integra, r.shape_err, gravadas], [false, 1, [1]]);
});

Deno.test("resposta sem osCadastro = malformada ≠ fim", async () => {
  await aborta(varrer(fonte([{ total_de_paginas: 1, total_de_registros: 0 }]), sem, longe), "malformada");
});

Deno.test("teto de páginas sem ver o fim aborta; total_de_paginas lixo aborta", async () => {
  let n = 0;
  await aborta(varrer(() => Promise.resolve({ total_de_registros: 1e6, osCadastro: [os(++n)] }), sem, longe), "sem ver o fim");
  assertEquals(n, MAX_PAGINAS);
  await aborta(varrer(fonte([pagina([1], 100000)]), sem, longe), "teto anti-runaway");
});

Deno.test("relógio esgotado aborta com o parcial", async () => {
  let t = 0;
  await aborta(varrer(fonte([pagina([1, 2]), pagina([3])]), sem, { deadline: 1, agora: () => (t += 1) }), "relógio esgotado");
});

Deno.test("catálogo vazio declarado (0 registros) é íntegro", async () => {
  const r = await varrer(fonte([{ total_de_paginas: 0, total_de_registros: 0, osCadastro: [] }]), sem, longe);
  assertEquals([r.integra, r.distintas], [true, 0]);
});

Deno.test("chave do contrato AUSENTE (forma nova do payload) → termina, mas NÃO íntegra (não sobrescreve o espelho)", async () => {
  const semFlag = { total_de_paginas: 1, total_de_registros: 1,
    osCadastro: [{ Cabecalho: { nCodOS: 1, cNumOS: "1", nCodCli: 7, cEtapa: "20", nValorTotal: 10 }, InfoCadastro: { dDtInc: "01/11/2026" } }] };
  const r = await varrer(fonte([semFlag]), sem, longe);
  assertEquals([r.integra, r.contrato_err], [false, 1]);
  const soId = { total_de_paginas: 1, total_de_registros: 1, osCadastro: [{ Cabecalho: { nCodOS: 1 } }] };
  assertEquals((await varrer(fonte([soId]), sem, longe)).integra, false);
});

Deno.test("registros/pagina declarados têm de bater; total_de_registros não muda no meio do run", async () => {
  await aborta(varrer(fonte([{ pagina: 1, registros: 5, total_de_paginas: 0, total_de_registros: 0, osCadastro: [] }]), sem, longe), "registros=5");
  await aborta(varrer(fonte([{ ...pagina([1, 2]), pagina: 2 }]), sem, longe), "resposta da página 2");
  await aborta(varrer(fonte([pagina([1, 2], 2, 3), pagina([3], 2, 2)]), sem, longe), "mudou no meio do run");
});
