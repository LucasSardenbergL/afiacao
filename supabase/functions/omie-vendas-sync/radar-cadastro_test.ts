// Testa o CÓDIGO REAL de omie-vendas-sync/radar-cadastro.ts no runtime real (Deno, sem rede).
// Revisão do Radar 2026-11-11 (itens 5 e 7): elegibilidade do lead validada no SERVIDOR entre o lookup estrito e o
// IncluirCliente, e e-mail/complemento da Receita normalizados antes de irem ao ERP.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg ?? `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}
import {
  complementoParaCadastro, emailParaCadastro, lerExigenciaRadar, motivoInelegivelRadar, verificarElegibilidadeRadar,
  type BancoRadar, type LinhaRadarCadastro,
} from "./radar-cadastro.ts";

const LEAD: LinhaRadarCadastro = { ja_cliente: false, omie_codigo_cliente: null, rfb_situacao: "02", prospeccao_status: "em_conversa" };

Deno.test("elegível: ativo na RFB, sem vínculo, em conversa", () => {
  assertEquals(motivoInelegivelRadar(LEAD, { exigirEmConversa: true }), null);
  assertEquals(motivoInelegivelRadar({ ...LEAD, rfb_situacao: null }, { exigirEmConversa: true }), null);
});

Deno.test("recusas, na ordem: inexistente, já cliente, já vinculado, RFB não ativa, descartado, não em conversa", () => {
  assertEquals(motivoInelegivelRadar(null, { exigirEmConversa: false }), "lead_inexistente");
  assertEquals(motivoInelegivelRadar({ ...LEAD, ja_cliente: true }, { exigirEmConversa: false }), "ja_cliente");
  assertEquals(motivoInelegivelRadar({ ...LEAD, omie_codigo_cliente: "77" }, { exigirEmConversa: false }), "ja_vinculado_omie");
  assertEquals(motivoInelegivelRadar({ ...LEAD, omie_codigo_cliente: "" }, { exigirEmConversa: false }), "ja_vinculado_omie");
  assertEquals(motivoInelegivelRadar({ ...LEAD, rfb_situacao: "08" }, { exigirEmConversa: false }), "rfb_nao_ativa");
  assertEquals(motivoInelegivelRadar({ ...LEAD, prospeccao_status: "descartado" }, { exigirEmConversa: false }), "descartado");
  assertEquals(motivoInelegivelRadar({ ...LEAD, prospeccao_status: "a_contatar" }, { exigirEmConversa: true }), "nao_em_conversa");
});

Deno.test("lote do gestor (sem exigir conversa): a_contatar passa; descartado não", () => {
  assertEquals(motivoInelegivelRadar({ ...LEAD, prospeccao_status: "a_contatar" }, { exigirEmConversa: false }), null);
  assertEquals(motivoInelegivelRadar({ ...LEAD, prospeccao_status: "descartado" }, { exigirEmConversa: false }), "descartado");
});

Deno.test("exigência: só objeto 'radar' liga a checagem; exigir_em_conversa só com true", () => {
  assertEquals(lerExigenciaRadar(undefined), null);
  assertEquals(lerExigenciaRadar("sim"), null);
  assertEquals(lerExigenciaRadar({}), { exigirEmConversa: false });
  assertEquals(lerExigenciaRadar({ exigir_em_conversa: true }), { exigirEmConversa: true });
  assertEquals(lerExigenciaRadar({ exigir_em_conversa: "true" }), { exigirEmConversa: false });
});

Deno.test("verificar no banco: lê por documento; leitura que falha LANÇA (indeterminado, nunca 'elegível')", async () => {
  const pedidos: string[] = [];
  const banco = (linha: LinhaRadarCadastro | null, erro: string | null = null): BancoRadar => ({
    lerLead: (doc) => { pedidos.push(doc); return Promise.resolve({ data: linha, error: erro ? { message: erro } : null }); },
  });
  assertEquals(await verificarElegibilidadeRadar(banco(LEAD), "12345678000195", { exigirEmConversa: true }), { ok: true });
  assertEquals(pedidos, ["12345678000195"]);
  assertEquals(await verificarElegibilidadeRadar(banco({ ...LEAD, rfb_situacao: "04" }), "1", { exigirEmConversa: false }),
    { ok: false, motivo: "rfb_nao_ativa" });
  let lancou = "";
  try { await verificarElegibilidadeRadar(banco(null, "timeout"), "1", { exigirEmConversa: false }); } catch (e) { lancou = String(e); }
  if (!lancou.includes("RADAR_ELEGIBILIDADE_INDETERMINADA")) throw new Error(`esperava lançar indeterminado, veio: ${lancou}`);
});

Deno.test("e-mail: aparado, sintaxe mínima, ≤ 500; inválido é OMITIDO (não derruba o cadastro)", () => {
  assertEquals(emailParaCadastro("  compras@moveis.com.br "), "compras@moveis.com.br");
  assertEquals(emailParaCadastro("sem-arroba.com"), null);
  assertEquals(emailParaCadastro("a@b"), null);
  assertEquals(emailParaCadastro("dois @espaço.com"), null);
  assertEquals(emailParaCadastro(`${"x".repeat(495)}@a.com`), null);
  assertEquals(emailParaCadastro(42), null);
  assertEquals(emailParaCadastro(""), null);
});

Deno.test("complemento: aparado, ≤ 60; maior é OMITIDO (nunca truncado no ERP)", () => {
  assertEquals(complementoParaCadastro(" SALA 1203 "), "SALA 1203");
  assertEquals(complementoParaCadastro("x".repeat(60)), "x".repeat(60));
  assertEquals(complementoParaCadastro("x".repeat(61)), null);
  assertEquals(complementoParaCadastro("   "), null);
  assertEquals(complementoParaCadastro(null), null);
});
