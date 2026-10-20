// deno test supabase/functions/fin-cashflow-engine/prazos-empresa_test.ts
import { FONTE_PRAZOS, lerPrazosEmpresa } from "./prazos-empresa.ts";
import { FalhaLeituraCritica } from "../_shared/leitura-critica.ts";

function assertEq(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEq"}: esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`);
  }
}
/** Casa a MARCA do ramo (classe + fonte + código), não "lançou algo". */
function assertFalha(f: () => unknown, codigo: string) {
  try {
    f();
  } catch (e) {
    if (!(e instanceof FalhaLeituraCritica)) throw new Error(`esperava FalhaLeituraCritica, veio ${e}`);
    if (e.codigo !== codigo) throw new Error(`esperava codigo ${codigo}, veio ${e.codigo}`);
    if (e.fonte !== FONTE_PRAZOS) throw new Error(`fonte errada: ${e.fonte}`);
    return;
  }
  throw new Error(`não lançou (esperava ${codigo})`);
}
const MALFORMADA = { dados: null, motivo: `Leitura de ${FONTE_PRAZOS} falhou (código MALFORMADA) — indisponível, não zero.` };
const ok = (data: unknown) => lerPrazosEmpresa({ data, error: null });

Deno.test("lerPrazosEmpresa: existe=true devolve os 4 campos como vieram (0 e null distintos)", () => {
  assertEq(ok({ existe: true, pmr: 26, pmp: 32, pmr_cobertura: 0.999, pmp_cobertura: 1 }),
    { dados: { pmr: 26, pmp: 32, pmr_cobertura: 0.999, pmp_cobertura: 1 }, motivo: null });
  // título liquidado sem baixa: PMR null, cobertura 0 — o 0 NÃO vira null nem o null vira 0.
  assertEq(ok({ existe: true, pmr: null, pmp: -3, pmr_cobertura: 0, pmp_cobertura: null }),
    { dados: { pmr: null, pmp: -3, pmr_cobertura: 0, pmp_cobertura: null }, motivo: null });
});

Deno.test("lerPrazosEmpresa: existe=false é 'sem linha' legítimo (null sem motivo)", () => {
  assertEq(ok({ existe: false, pmr: null, pmp: null, pmr_cobertura: null, pmp_cobertura: null }),
    { dados: null, motivo: null });
});

Deno.test("lerPrazosEmpresa: envelope fora de forma vira motivo MALFORMADA, nunca número nem 'sem linha'", () => {
  const casos: unknown[] = [
    null,
    [],
    [{}],
    {},
    { existe: true, pmr: 1, pmp: 2, pmr_cobertura: 0.5 },                                // campo omitido
    { existe: true, pmr: 1, pmp: 2, pmr_cobertura: 0.5, pmp_cobertura: 1, extra: 1 },     // campo a mais
    { existe: true, pmr: "26", pmp: 2, pmr_cobertura: 0.5, pmp_cobertura: 1 },           // string numérica
    { existe: true, pmr: true, pmp: 2, pmr_cobertura: 0.5, pmp_cobertura: 1 },           // booleano
    { existe: "true", pmr: 1, pmp: 2, pmr_cobertura: 0.5, pmp_cobertura: 1 },            // existe não-booleano
    { existe: false, pmr: 0, pmp: null, pmr_cobertura: null, pmp_cobertura: null },      // contraditório
  ];
  for (const c of casos) assertEq(ok(c), MALFORMADA, JSON.stringify(c));
});

Deno.test("lerPrazosEmpresa: erro de transporte degrada com o código real (timeout, 42501, RPC ausente)", () => {
  for (const code of ["57014", "42501", "PGRST202"]) {
    assertEq(lerPrazosEmpresa({ data: null, error: { code, message: "x" } }),
      { dados: null, motivo: `Leitura de ${FONTE_PRAZOS} falhou (código ${code}) — indisponível, não zero.` });
  }
});

Deno.test("lerPrazosEmpresa: deriva da cópia (P0001) e argumento nulo (22004) LANÇAM — defeito de deploy, alto", () => {
  assertFalha(() => lerPrazosEmpresa({ data: null, error: { code: "P0001", message: "mudou" } }), "P0001");
  assertFalha(() => lerPrazosEmpresa({ data: null, error: { code: "22004", message: "nulo" } }), "22004");
});
