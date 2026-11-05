// deno test supabase/functions/fin-next-best-action/fila_test.ts
// Plano v6 C1 (A4-DADO): a A4 fabricava caixa disponível. Cobertura null ("sem base de saída") com
// saldo 10.000 virava "R$0 disponível, confiança alta" (`?? 0` no transporte + `?? 0` na fila).
// Estes casos rodam o helper REAL da edge (./fila.ts), não a cópia de src/.
import { type AcaoCandidata, caixaDaA1, classificarStatus, montarFilaAcoes, type RespostaA1Caixa } from "./fila.ts";
import { montarRespostaA4 } from "./orquestracao.ts";

const RESERVA = 21;

function assertEq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`);
  }
}
function assertContem(hay: string, marca: string, msg: string) {
  if (!hay.includes(marca)) throw new Error(`${msg}: "${marca}" ausente em ${JSON.stringify(hay)}`);
}

const a1 = (saldo: number | null | undefined, dias: number | null | undefined, cd: RespostaA1Caixa["confianca_dados"] = { motivos: [], saldo_inicial: null }): RespostaA1Caixa => ({
  indicadores: { saldo_tesouraria: saldo, dias_cobertura: dias },
  confianca_dados: cd,
});

const crescer = (empresa: string, custo: number): AcaoCandidata => ({
  empresa, descricao: `${empresa} — crescer`, tipo: "crescer", impacto_eva: 1000, caixa_consumido: custo,
  payback_meses: 6, spread_positivo: true, confianca: "alta",
});

Deno.test("cobertura null + saldo 10.000 (reprodução do Codex): disponível DESCONHECIDO, não R$0 com confiança alta", () => {
  const cx = caixaDaA1(a1(10_000, null), RESERVA);
  assertEq(cx.disponivel, null, "disponível");
  assertEq(cx.confianca, "baixa", "confiança");
  assertEq(cx.saldo_tesouraria, 10_000, "saldo conhecido é preservado");
  assertEq(cx.dias_cobertura, null, "cobertura");
  assertEq(cx.motivos.length, 1, "um motivo");
  assertContem(cx.motivos[0], "sem base de saída", "motivo distingue cobertura desconhecida");

  // Na fila: crescer dimensionado não vira "financiar_condicional" contra um R$0 fabricado.
  const r = montarFilaAcoes({ candidatos: [crescer("oben", 5_000)], caixaPorEmpresa: { oben: cx }, hurdlePorEmpresa: { oben: 0.15 } });
  const acao = r.fila.find((a) => a.tipo === "crescer");
  assertEq(acao?.status, "falta_dado", "crescer sem caixa conhecido");
  assertEq(r.confianca.nivel, "baixa", "nível da fila");
  assertEq(r.caixa_por_empresa.oben.disponivel, null, "resposta carrega null, não 0");
  assertContem(r.confianca.motivos.join(" | "), "Caixa (oben): Cobertura de caixa desconhecida", "motivo da A1 chega à fila");
});

Deno.test("saldo datado: calcula com haircut, rebaixa para baixa e propaga o motivo da A1", () => {
  const cx = caixaDaA1(a1(100_000, 60, { motivos: ["Saldo de 2 conta(s) datado."], saldo_inicial: "Saldo de 2 conta(s) datado." }), RESERVA);
  // 100.000 × (1 − 21/60) × 0,5 = 32.500
  assertEq(cx.disponivel, 32_500, "disponível com haircut");
  assertEq(cx.confianca, "baixa", "confiança");
  assertEq(cx.motivos, ["Saldo inicial datado: Saldo de 2 conta(s) datado."], "motivo");
  // Contraexemplo do Codex (desenho): a ESTIMATA de R$32,5k não pode aprovar uma ação de R$30k.
  const r = montarFilaAcoes({ candidatos: [crescer("oben", 30_000)], caixaPorEmpresa: { oben: cx }, hurdlePorEmpresa: { oben: 0.15 } });
  assertEq(r.fila.find((a) => a.tipo === "crescer")?.status, "falta_dado", "estimata de saldo datado não decide financiar");
  assertEq(r.caixa_por_empresa.oben.disponivel, 32_500, "a estimata segue no card, rotulada");
});

Deno.test("saudável: disponível calculado, confiança alta, sem motivo; status por comparação com o caixa", () => {
  const cx = caixaDaA1(a1(100_000, 60), RESERVA);
  assertEq(cx.disponivel, 65_000, "100.000 × (1 − 21/60)");
  assertEq(cx.confianca, "alta", "confiança");
  assertEq(cx.motivos, [], "sem motivo");
  const r = montarFilaAcoes({ candidatos: [crescer("oben", 50_000), crescer("oben", 70_000)], caixaPorEmpresa: { oben: cx }, hurdlePorEmpresa: { oben: 0.15 } });
  assertEq(r.fila.filter((a) => a.tipo === "crescer").map((a) => [a.caixa_consumido, a.status]),
    [[50_000, "financiar_ja"], [70_000, "financiar_condicional"]], "status contra o caixa conhecido");
  assertEq(r.confianca.nivel, "alta", "nível da fila");
});

Deno.test("degradação de PMR/PMP/CCC da A1 NÃO anula nem rebaixa o caixa", () => {
  const cx = caixaDaA1(a1(100_000, 60, { motivos: ["fin_capital_giro_prazos_empresa falhou (500). PMR/PMP/CCC ficam indisponíveis."], saldo_inicial: null }), RESERVA);
  assertEq(cx.disponivel, 65_000, "disponível intacto");
  assertEq(cx.confianca, "alta", "confiança intacta");
  assertEq(cx.motivos, [], "motivo de PMR não é motivo de caixa");
});

Deno.test("A1 indisponível (null): disponível desconhecido, baixa — antes virava 0", () => {
  const cx = caixaDaA1(null, RESERVA);
  assertEq([cx.disponivel, cx.confianca, cx.saldo_tesouraria], [null, "baixa", null], "caixa");
  assertContem(cx.motivos[0], "indisponível", "motivo");
});

Deno.test("saldo ausente na resposta da A1: disponível desconhecido", () => {
  const cx = caixaDaA1(a1(undefined, 60), RESERVA);
  assertEq([cx.disponivel, cx.confianca], [null, "baixa"], "caixa");
  assertContem(cx.motivos[0], "sem saldo de tesouraria", "motivo");
});

Deno.test("cobertura ausente (campo faltando, não null explícito): motivo próprio, disponível desconhecido", () => {
  const cx = caixaDaA1(a1(10_000, undefined), RESERVA);
  assertEq([cx.disponivel, cx.confianca, cx.saldo_tesouraria], [null, "baixa", 10_000], "caixa");
  assertContem(cx.motivos[0], "sem dias de cobertura", "motivo");
});

Deno.test("cobertura 0 (saldo ≤ 0) é zero CONHECIDO: disponível 0, confiança alta", () => {
  const cx = caixaDaA1(a1(-5_000, 0), RESERVA);
  assertEq([cx.disponivel, cx.confianca, cx.motivos], [0, "alta", []], "caixa");
  // e o zero conhecido decide: crescer dimensionado vira condicional, não falta_dado
  assertEq(classificarStatus({ tipo: "crescer", impacto_eva: 1, spread_positivo: true, caixa_consumido: 1, caixa_disponivel: 0, hurdle: 0.1, tem_dado: true }), "financiar_condicional", "status");
});

Deno.test("A1 sem confianca_dados (versão antiga): calcula, mas confiança média com motivo", () => {
  const cx = caixaDaA1({ indicadores: { saldo_tesouraria: 100_000, dias_cobertura: 60 } }, RESERVA);
  assertEq([cx.disponivel, cx.confianca], [65_000, "media"], "caixa");
  assertContem(cx.motivos[0], "frescor do saldo não atestado", "motivo");
});

Deno.test("empresa fora do mapa de caixa: crescer dimensionado cai em falta_dado (não compara com R$0)", () => {
  const r = montarFilaAcoes({ candidatos: [crescer("colacor", 5_000)], caixaPorEmpresa: {}, hurdlePorEmpresa: { colacor: 0.15 } });
  assertEq(r.fila.find((a) => a.tipo === "crescer")?.status, "falta_dado", "status");
});

// ── Ponta a ponta: resposta CRUA da A1 → orquestração real da edge → JSON que a tela/fin-funding leem ──
// (Codex, desenho: o `?? 0` reintroduzido no CALLER não é pego por teste só do helper.)
const EMPRESAS = ["oben", "colacor", "colacor_sc"];
const valorOk = { reportado: { wacc: 0.15, spread: 0.02 } };
function respostaA4(cash: Array<RespostaA1Caixa | null>) {
  // JSON.parse(JSON.stringify(...)): o que de fato sai no corpo da resposta (undefined some, null fica).
  return JSON.parse(JSON.stringify(montarRespostaA4({ empresas: EMPRESAS, reservaDiasMin: RESERVA, cashResults: cash, valorResults: [valorOk, valorOk, valorOk], cockpit: { recomendacoesCliente: [] } })));
}

Deno.test("A1→A4: cobertura null + saldo 10.000 sai como disponivel:null com o motivo, não 0/alta", () => {
  const j = respostaA4([a1(10_000, null), a1(100_000, 60), a1(100_000, 60)]);
  assertEq(j.caixa_por_empresa.oben.disponivel, null, "oben disponível no JSON");
  assertEq(j.caixa_por_empresa.oben.saldo_tesouraria, 10_000, "saldo conhecido no JSON");
  assertEq(j.caixa_por_empresa.oben.confianca, "baixa", "confiança oben");
  assertContem(j.caixa_por_empresa.oben.motivos.join(" "), "sem base de saída", "motivo no JSON");
  assertEq(j.caixa_por_empresa.colacor.disponivel, 65_000, "empresa saudável intacta");
  assertEq(j.confianca.nivel, "baixa", "nível da fila");
  assertContem(j.confianca.motivos.join(" | "), "Caixa (oben)", "motivo na confiança da fila");
});

Deno.test("A1→A4: A1 falhou (null) → disponivel:null + 'Insumos indisponíveis' (antes: 0 com haircut)", () => {
  const j = respostaA4([null, a1(100_000, 60), a1(100_000, 60)]);
  assertEq(j.caixa_por_empresa.oben.disponivel, null, "oben");
  assertContem(j.confianca.motivos.join(" | "), "Insumos indisponíveis (function falhou): caixa (oben)", "falha listada");
});

Deno.test("A1→A4: saudável nas 3 → disponível calculado, nenhum motivo de caixa", () => {
  const j = respostaA4([a1(100_000, 60), a1(42_000, 42), a1(-1, 0)]);
  assertEq([j.caixa_por_empresa.oben.disponivel, j.caixa_por_empresa.colacor.disponivel, j.caixa_por_empresa.colacor_sc.disponivel], [65_000, 21_000, 0], "disponíveis");
  assertEq((j.confianca.motivos as string[]).filter((m) => m.startsWith("Caixa (")), [], "sem motivo de caixa");
});

Deno.test("A1→A4: formato LEGADO da A1 ({ motivos } sem saldo_inicial) não atesta frescor → média, não decide financiar", () => {
  const legado: RespostaA1Caixa = { indicadores: { saldo_tesouraria: 100_000, dias_cobertura: 60 }, confianca_dados: { motivos: [] } };
  const cx = caixaDaA1(legado, RESERVA);
  assertEq([cx.disponivel, cx.confianca], [65_000, "media"], "caixa legado");
  assertContem(cx.motivos[0], "frescor do saldo não atestado", "motivo");
  const r = montarFilaAcoes({ candidatos: [crescer("oben", 50_000)], caixaPorEmpresa: { oben: cx }, hurdlePorEmpresa: { oben: 0.15 } });
  assertEq(r.fila.find((a) => a.tipo === "crescer")?.status, "falta_dado", "caixa não atestado não decide financiar_ja");
  const j = respostaA4([legado, legado, legado]);
  assertEq(j.caixa_por_empresa.oben.confianca, "media", "confiança no JSON");
  assertContem(j.confianca.motivos.join(" | "), "Caixa (oben): A1 sem confianca_dados.saldo_inicial", "motivo na fila");
});
