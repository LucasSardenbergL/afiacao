// Testa o CÓDIGO REAL de escopo.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/omie-sync-sku-items/escopo_test.ts
//
// O que este módulo fecha (OBEN, medido em 2026-10-05): a fila do leadtime consultava CT-e (modelo
// 57, o conhecimento de frete), que a Omie responde sem `itensRecebimento`. Eram 17 de 17 linhas da
// fila do diário das 07:00 e ~51 das 55 consultas desses runs, girando no backoff para sempre.
//
// As falsificações que importam, em ordem de custo:
//   (a) DENYLIST, não allowlist: modelo desconhecido (65, 67) e chave ilegível CONTINUAM na fila.
//       Um mutante "só o 55 passa" perderia leadtime em silêncio, e este arquivo tem de ficar
//       vermelho com ele;
//   (b) parser ESTRITO: a chave de CT-e com espaço, ponto ou 43/45 dígitos NÃO é CT-e. Um mutante
//       que normaliza (trim/replace) transforma lixo em evidência positiva de exclusão;
//   (c) equivalência: numa fila sem CT-e, a saída é a MESMA fila, mesma ordem e mesmos objetos.
//       O filtro não pode reordenar nem copiar, porque o dedup por `nIdReceb` elege pela ordem.
import { ehCte, MODELO_CTE, modeloDaChave, separarCtes } from "./escopo.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(msg ?? `esperado ${jb}, veio ${ja}`);
}

function assertMesmosObjetos(a: readonly unknown[], b: readonly unknown[], msg: string) {
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
    throw new Error(`${msg}: esperado ${b.length} objetos idênticos na mesma ordem, veio ${a.length}`);
  }
}

/** Chave de acesso no layout SEFAZ (44 dígitos), com o modelo nas posições 21–22. */
function chave(modelo: string, numero = "000123456"): string {
  // cUF(2) + AAMM(4) + CNPJ(14) + modelo(2) + série(3) + nNF(9) + tpEmis(1) + cNF(8) + DV(1)
  const c = `43` + `2609` + `61142865000691` + modelo + `001` + numero + `1` + `12345678` + `9`;
  if (c.length !== 44) throw new Error(`fixture quebrada: chave com ${c.length} dígitos`);
  return c;
}

Deno.test("modeloDaChave lê as posições 21–22 da chave de acesso", () => {
  assertEquals(modeloDaChave(chave("55")), "55");
  assertEquals(modeloDaChave(chave("57")), "57");
  assertEquals(modeloDaChave(chave("65")), "65");
  assertEquals(MODELO_CTE, "57");
});

Deno.test("parser estrito: chave ilegível não tem modelo (null), nunca é normalizada", () => {
  const cte = chave("57");
  const ilegiveis: unknown[] = [
    cte.slice(1), // 43 dígitos
    cte + "0", // 45 dígitos
    ` ${cte}`, // espaço antes
    `${cte} `, // espaço depois
    `${cte.slice(0, 20)}.${cte.slice(20)}`.slice(0, 44), // ponto no meio, 44 caracteres
    cte.replace(/^4/, "A"), // letra
    "",
    null,
    undefined,
    Number(cte.slice(0, 15)), // número, não string
    { chave: cte },
  ];
  for (const x of ilegiveis) {
    assertEquals(modeloDaChave(x), null, `modeloDaChave(${JSON.stringify(x)}) devia ser null`);
    assertEquals(ehCte(x), false, `ehCte(${JSON.stringify(x)}) devia ser false — chave ilegível fica na fila`);
  }
});

Deno.test("ehCte: só o modelo 57; 55, 65 e 67 (CT-e OS, fora do contrato medido) não", () => {
  assertEquals(ehCte(chave("57")), true);
  assertEquals(ehCte(chave("55")), false);
  assertEquals(ehCte(chave("65")), false);
  assertEquals(ehCte(chave("67")), false, "67 entra só com contrato e teste próprios");
});

Deno.test("separarCtes: tira só o 57, preserva ordem e identidade do resto (denylist)", () => {
  const nfeDoisPedidosA = { id: "a", nfe_chave_acesso: chave("55", "000000001"), nIdReceb: "10" };
  const cteSayerlack = { id: "b", nfe_chave_acesso: chave("57", "000000002"), nIdReceb: "20" };
  const nfeDoisPedidosB = { id: "c", nfe_chave_acesso: chave("55", "000000001"), nIdReceb: "10" };
  const modeloDesconhecido = { id: "d", nfe_chave_acesso: chave("65", "000000003"), nIdReceb: "30" };
  const semChave = { id: "e", nfe_chave_acesso: null, nIdReceb: null };
  const cteMalformado = { id: "f", nfe_chave_acesso: ` ${chave("57", "000000004")}`, nIdReceb: "40" };
  const outroCte = { id: "g", nfe_chave_acesso: chave("57", "000000005"), nIdReceb: "50" };
  const fila = [nfeDoisPedidosA, cteSayerlack, nfeDoisPedidosB, modeloDesconhecido, semChave, cteMalformado, outroCte];

  const { consultaveis, ctes } = separarCtes(fila);

  assertMesmosObjetos(
    consultaveis,
    [nfeDoisPedidosA, nfeDoisPedidosB, modeloDesconhecido, semChave, cteMalformado],
    "consultáveis (NF-e irmãs, modelo desconhecido, sem chave e chave ilegível ficam, na ordem)",
  );
  assertMesmosObjetos(ctes, [cteSayerlack, outroCte], "CT-e (só os 57 legíveis saem)");
  // pendentes brutos = fila_pendente + ctes_fora_da_fila
  assertEquals(consultaveis.length + ctes.length, fila.length);
});

Deno.test("equivalência: fila sem CT-e sai IDÊNTICA (mesma ordem, mesmos objetos, nenhuma cópia)", () => {
  const fila = [
    { nfe_chave_acesso: chave("55", "000000009") },
    { nfe_chave_acesso: chave("55", "000000008") },
    { nfe_chave_acesso: null },
    { nfe_chave_acesso: chave("65", "000000007") },
  ];
  const { consultaveis, ctes } = separarCtes(fila);
  assertMesmosObjetos(consultaveis, fila, "fila sem CT-e");
  assertEquals(ctes.length, 0);
  assertEquals(separarCtes([]).consultaveis.length, 0);
});
