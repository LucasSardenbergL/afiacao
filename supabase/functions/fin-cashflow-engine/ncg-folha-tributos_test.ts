// classificarPcoNcg (engine v2.7): fronteiras da janela de folha, um balde por título, fonte por empresa.
// Valores sintéticos. Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/fin-cashflow-engine/
import { igual } from "../_shared/harness-handler_test.ts";
import { somarDias } from "../_shared/hoje-sp.ts";
import { classificarPcoNcg, type TituloCp } from "./ncg-folha-tributos.ts";

const HOJE = "2026-11-26";
const aberto = (s: string) => s === "A VENCER" || s === "ATRASADO";
const t = (venc: string | null, saldo: number, cat: string | null, status = "A VENCER"): TituloCp => ({
  saldo, status_titulo: status, categoria_codigo: cat, data_vencimento: venc,
});
const MAPA = [
  { omie_codigo: "2.03.01", fluxo_linha: "op_pessoal" },
  { omie_codigo: "2.06.01", fluxo_linha: "op_impostos" },
  { omie_codigo: "2.06.05", fluxo_linha: "op_impostos_lucro" },
  { omie_codigo: "2.06.50", fluxo_linha: "op_impostos_parcelamento" },
  { omie_codigo: "2.05.01", fluxo_linha: "op_fornecedores" },
];
const rodar = (cps: TituloCp[], extra: Partial<Parameters<typeof classificarPcoNcg>[0]> = {}) =>
  classificarPcoNcg({ company: "colacor_sc", hoje: HOJE, cps, mapa: MAPA, adiantamentoCodigos: ["2.01.98"], recorrentes: [], aberto, ...extra });

Deno.test("controle: título de fornecedor sem mapa fica em cp_fornecedor", () => {
  const r = rodar([t(somarDias(HOJE, 3), 10, "2.05.01")]);
  igual([r.cp_fornecedor, r.folha_30d, r.tributos_a_pagar], [10, 0, 0], "baldes");
});

Deno.test("folha: fronteiras da janela [hoje−30, hoje+30] são inclusivas, um dia fora já não entra", () => {
  const casos: Array<[number, boolean]> = [[-31, false], [-30, true], [0, true], [30, true], [31, false]];
  for (const [d, dentro] of casos) {
    const r = rodar([t(somarDias(HOJE, d), 100, "2.03.01", d < 0 ? "ATRASADO" : "A VENCER")]);
    igual([r.folha_30d, r.cp_fornecedor], dentro ? [100, 0] : [0, 100], `vencimento hoje${d >= 0 ? "+" : ""}${d}`);
  }
});

Deno.test("folha fora da janela: contada por motivo (vencida além do limite, depois, sem vencimento)", () => {
  const r = rodar([
    t(somarDias(HOJE, -90), 1, "2.03.01", "ATRASADO"),
    t(somarDias(HOJE, -31), 1, "2.03.01", "ATRASADO"),
    t(somarDias(HOJE, 60), 1, "2.03.01"),
    t(null, 1, "2.03.01"),
    t(somarDias(HOJE, 2), 5, "2.03.01"),
  ]);
  igual(r.folha_fora_da_janela, { vencidos_alem_do_limite: 2, a_vencer_depois: 1, sem_vencimento: 1 }, "contagens");
  igual([r.folha_30d, r.cp_fornecedor], [5, 4], "baldes");
  igual(r.motivos.filter((m) => m.startsWith("2 título(s) de folha vencido(s) há mais de 30 dias")).length, 1, "motivo");
});

Deno.test("tributos: op_impostos + op_impostos_lucro sem janela; parcelamento fica em cp_fornecedor", () => {
  const r = rodar([
    t(somarDias(HOJE, -200), 7, "2.06.01", "ATRASADO"),
    t(somarDias(HOJE, 90), 3, "2.06.05"),
    t(somarDias(HOJE, 5), 50, "2.06.50"),
  ]);
  igual([r.tributos_a_pagar, r.cp_fornecedor], [10, 50], "baldes");
  igual(r.fontes.tributos, true, "fonte de tributos");
});

Deno.test("um balde por título: adiantamento nunca entra no PCO, mesmo com código no mapa", () => {
  const r = rodar([t(somarDias(HOJE, 3), 9, "2.03.01")], { adiantamentoCodigos: ["2.03.01"] });
  igual([r.cp_fornecedor, r.folha_30d, r.tributos_a_pagar], [0, 0, 0], "baldes");
});

Deno.test("título não aberto ou sem saldo não entra em balde nenhum", () => {
  const r = rodar([t(somarDias(HOJE, 3), 9, "2.06.01", "PAGO"), t(somarDias(HOJE, 3), 0, "2.06.01")]);
  igual([r.cp_fornecedor, r.tributos_a_pagar, r.fontes.tributos], [0, 0, false], "baldes e fonte");
});

Deno.test("recorrente de folha: só com OCORRÊNCIA em [hoje, hoje+30]; o CP da janela vence (max)", () => {
  const rec = (fim: string | null, inicio = "2025-01-01", dia = 5) =>
    ({ valor: 40, tipo: "saida", is_folha: true, dia_do_mes: dia, inicio, fim });
  igual(rodar([], { recorrentes: [rec(null)] }).folha_30d, 40, "vigente sem fim (ocorre 05/12)");
  igual(rodar([], { recorrentes: [rec("2026-12-05")] }).folha_30d, 40, "termina no dia da ocorrência");
  // Achado Codex v2.7: vigente HOJE, mas a última ocorrência foi 05/11 e a de 05/12 já está fora da vigência.
  igual(rodar([], { recorrentes: [rec(HOJE)] }).folha_30d, 0, "termina hoje, sem ocorrência na janela");
  igual(rodar([], { recorrentes: [rec(somarDias(HOJE, -1))] }).folha_30d, 0, "encerrado ontem");
  igual(rodar([], { recorrentes: [rec(null, somarDias(HOJE, 31))] }).folha_30d, 0, "começa depois da janela");
  igual(rodar([], { recorrentes: [rec(null, "2025-01-01", 26)] }).folha_30d, 40, "ocorre hoje");
  igual(rodar([t(somarDias(HOJE, 1), 100, "2.03.01")], { recorrentes: [rec(null)] }).folha_30d, 100, "CP > recorrente");
});

Deno.test("fonte da folha: colacor_sc exige título na janela ou recorrente; as outras medem zero com pessoal no mapa", () => {
  igual(rodar([]).fontes.folha, false, "colacor_sc vazia");
  igual(rodar([], { company: "oben" }).fontes.folha, true, "oben vazia, mapa com pessoal");
  igual(rodar([], { company: "colacor" }).fontes.folha, true, "colacor vazia, mapa com pessoal");
  igual(rodar([], { company: "oben", mapa: MAPA.filter((m) => m.fluxo_linha !== "op_pessoal") }).fontes.folha, false, "oben sem pessoal no mapa");
  igual(rodar([t(somarDias(HOJE, 60), 1, "2.03.01")]).fontes.folha, false, "colacor_sc só com folha fora da janela");
});

Deno.test("mapa incompleto: código das famílias de folha/impostos fora do mapa → parcela não atestada", () => {
  const folha = rodar([t(somarDias(HOJE, 3), 40, "2.03.89"), t(somarDias(HOJE, 3), 5, "2.06.01")], { company: "oben" });
  igual([folha.fontes.folha, folha.fontes.tributos, folha.fora_do_mapa.folha], [false, true, 1], "pessoal fora do mapa");
  igual(folha.cp_fornecedor, 40, "o título fora do mapa segue no PCO (cp_fornecedor)");
  const trib = rodar([t(somarDias(HOJE, 3), 2, "2.06.07"), t(somarDias(HOJE, 3), 5, "2.06.01")], { company: "oben" });
  igual([trib.fontes.folha, trib.fontes.tributos, trib.fora_do_mapa.tributos], [true, false, 1], "imposto fora do mapa");
  const iss = rodar([t(somarDias(HOJE, 3), 2, "2.04.13"), t(somarDias(HOJE, 3), 5, "2.06.01")], { company: "oben" });
  igual(iss.fontes.tributos, false, "2.04 (ISS/IPTU/IPVA) fora do mapa também acusa");
  // Código fora do mapa FORA das famílias (ex.: despesa nova) não acusa nada: é fornecedor.
  const outro = rodar([t(somarDias(HOJE, 3), 2, "2.07.33"), t(somarDias(HOJE, 3), 5, "2.06.01")], { company: "oben" });
  igual([outro.fontes.folha, outro.fontes.tributos, outro.cp_fornecedor], [true, true, 2], "outra família");
});

Deno.test("folha sem vencimento: posição na janela desconhecida → não medida (também na empresa centralizada)", () => {
  const r = rodar([t(null, 9, "2.03.01"), t(somarDias(HOJE, 3), 5, "2.06.01")], { company: "oben" });
  igual([r.fontes.folha, r.folha_30d, r.cp_fornecedor], [false, 0, 9], "fonte e baldes");
  igual(r.motivos.some((m) => m.startsWith("1 título(s) de folha sem vencimento")), true, "motivo");
});
