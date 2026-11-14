// Helper puro do CP vencido fora da projeção (v2.4): bordas de faixa, centavos e ausente ≠ zero.
// O comportamento pelo handler (identidade das semanas, snapshot, denominador) está em
// cp-vencido-fora_test.ts.
import { igual } from "../_shared/harness-handler_test.ts";
import { somarDias } from "../_shared/hoje-sp.ts";
import { colunasCpVencidoFora, medirCpVencidoForaProjecao } from "./cp-vencido.ts";

const HOJE = "2026-11-14"; // sábado
const SEGUNDA = "2026-11-09";
const aberto = (s: string | null | undefined) => s === "ATRASADO";
const cp = (diasAtraso: number, saldo: number, status = "ATRASADO") => ({
  data_vencimento: somarDias(HOJE, -diasAtraso), saldo, status_titulo: status,
});

Deno.test("faixas: bordas 30/31, 60/61, 180/181 caem na faixa certa", () => {
  const r = medirCpVencidoForaProjecao(
    [cp(30, 1), cp(31, 10), cp(60, 100), cp(61, 1000), cp(180, 10000), cp(181, 100000)],
    SEGUNDA, HOJE, aberto,
  );
  igual(r?.faixas, { ate_30: 1, de_31_a_60: 110, de_61_a_180: 11000, acima_180: 100000 }, "faixas nas bordas");
  igual(r?.qtd, 6, "qtd");
  igual(r?.vencimento_mais_antigo, somarDias(HOJE, -181), "mais antigo");
});

Deno.test("borda da segunda: a véspera conta, a própria segunda não (está na semana 0)", () => {
  const r = medirCpVencidoForaProjecao(
    [
      { data_vencimento: somarDias(SEGUNDA, -1), saldo: 5, status_titulo: "ATRASADO" },
      { data_vencimento: SEGUNDA, saldo: 7, status_titulo: "ATRASADO" },
      { data_vencimento: "2026-11-11", saldo: 9, status_titulo: "ATRASADO" }, // antes de hoje, mas na semana 0
    ],
    SEGUNDA, HOJE, aberto,
  );
  igual([r?.qtd, r?.total], [1, 5], "só a véspera conta");
});

Deno.test("exclui fechado, saldo <= 0 e sem vencimento", () => {
  const r = medirCpVencidoForaProjecao(
    [cp(40, 50, "PAGO"), cp(40, 0), cp(40, -3), { data_vencimento: null, saldo: 80, status_titulo: "ATRASADO" }, cp(40, 2)],
    SEGUNDA, HOJE, aberto,
  );
  igual([r?.qtd, r?.total], [1, 2], "só o aberto com saldo e vencimento");
});

Deno.test("centavos: Σ faixas = total exato, mesmo com saldos que o float não representa", () => {
  const cps = Array.from({ length: 997 }, (_, i) => cp(6 + (i % 400), 0.1 + (i % 7) * 0.07 + i * 0.013));
  const r = medirCpVencidoForaProjecao(cps, SEGUNDA, HOJE, aberto)!;
  const soma = Math.round((r.faixas.ate_30 + r.faixas.de_31_a_60 + r.faixas.de_61_a_180 + r.faixas.acima_180) * 100);
  igual(soma, Math.round(r.total * 100), "Σ faixas ≠ total");
  const esperado = cps.reduce((a, c) => a + Math.round(c.saldo * 100), 0);
  igual(Math.round(r.total * 100), esperado, "total ≠ soma dos saldos em centavos");
});

Deno.test("ausente ≠ zero: carga ausente é null; lista vazia é zero real", () => {
  igual(medirCpVencidoForaProjecao(null, SEGUNDA, HOJE, aberto), null, "null");
  igual(medirCpVencidoForaProjecao(undefined, SEGUNDA, HOJE, aberto), null, "undefined");
  igual(
    medirCpVencidoForaProjecao([], SEGUNDA, HOJE, aberto),
    { qtd: 0, total: 0, vencimento_mais_antigo: null, faixas: { ate_30: 0, de_31_a_60: 0, de_61_a_180: 0, acima_180: 0 } },
    "lista vazia",
  );
  const nulas = colunasCpVencidoFora(null);
  igual(Object.values(nulas).every((v) => v === null), true, "colunas de medida ausente devem ser todas NULL");
  igual(Object.keys(nulas).length, 7, "são 7 colunas");
});

Deno.test("colunas: medida incoerente vira AUSÊNCIA (o CHECK da tabela nunca derruba o snapshot)", () => {
  const ok = medirCpVencidoForaProjecao([cp(40, 12.34)], SEGUNDA, HOJE, aberto)!;
  igual(colunasCpVencidoFora(ok).cp_vencido_fora_total, 12.34, "controle: medida coerente passa");
  const ruins = [
    { ...ok, total: 99 },                                         // Σ faixas ≠ total
    { ...ok, qtd: 0 },                                            // qtd 0 com valor
    { ...ok, vencimento_mais_antigo: null },                      // valor sem data
    { ...ok, total: Number.NaN },                                 // NaN
    { ...ok, faixas: { ...ok.faixas, de_31_a_60: -1, ate_30: 13.34 } }, // faixa negativa
  ];
  for (const [i, m] of ruins.entries()) {
    igual(Object.values(colunasCpVencidoFora(m)).every((v) => v === null), true, `caso ruim ${i} não virou ausência`);
  }
});
