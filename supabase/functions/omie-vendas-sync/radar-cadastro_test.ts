// Testa o CÓDIGO REAL de omie-vendas-sync/radar-cadastro.ts no runtime real (Deno, sem rede).
// Revisão do Radar 2026-11-11 (itens 5 e 7): elegibilidade do lead validada no SERVIDOR entre o lookup estrito e o
// IncluirCliente, e e-mail/complemento da Receita normalizados antes de irem ao ERP.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg ?? `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}
import {
  complementoParaCadastro, emailParaCadastro, lerExigenciaRadar, motivoInelegivelRadar, verificarElegibilidadeRadar,
  type BancoRadar, type ExigenciaRadar, type LinhaRadarCadastro,
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
  // Sem exigir conversa = o cadastro ANTECIPADO do lote do gestor: é ele que respeita a posse de outro vendedor.
  assertEquals(lerExigenciaRadar({}), { exigirEmConversa: false, respeitarPosse: true });
  assertEquals(lerExigenciaRadar({ exigir_em_conversa: true }), { exigirEmConversa: true, respeitarPosse: false });
  assertEquals(lerExigenciaRadar({ exigir_em_conversa: "true" }), { exigirEmConversa: false, respeitarPosse: true });
});

Deno.test("verificar no banco: lê por documento; leitura que falha LANÇA (indeterminado, nunca 'elegível')", async () => {
  const pedidos: string[] = [];
  const banco = (linha: LinhaRadarCadastro | null, erro: string | null = null): BancoRadar => ({
    lerLead: (doc) => { pedidos.push(doc); return Promise.resolve({ data: linha, error: erro ? { message: erro } : null }); },
    lerPosse: null,
  });
  assertEquals(await verificarElegibilidadeRadar(banco(LEAD), "12345678000195", { exigirEmConversa: true, respeitarPosse: false }), { ok: true });
  assertEquals(pedidos, ["12345678000195"]);
  assertEquals(await verificarElegibilidadeRadar(banco({ ...LEAD, rfb_situacao: "04" }), "1", { exigirEmConversa: false, respeitarPosse: true }),
    { ok: false, motivo: "rfb_nao_ativa" });
  let lancou = "";
  try { await verificarElegibilidadeRadar(banco(null, "timeout"), "1", { exigirEmConversa: false, respeitarPosse: true }); } catch (e) { lancou = String(e); }
  if (!lancou.includes("RADAR_ELEGIBILIDADE_INDETERMINADA")) throw new Error(`esperava lançar indeterminado, veio: ${lancou}`);
});

// Decisão do founder (2026-11-14): o lote do gestor PULA o lead em posse ativa ("em atendimento") de OUTRO vendedor.
// A posse vem da RPC canônica `radar_atendimentos_ativos` com a identidade do CHAMADOR (eh_meu calculado no banco).
const LOTE: ExigenciaRadar = { exigirEmConversa: false, respeitarPosse: true };
const FICHA: ExigenciaRadar = { exigirEmConversa: true, respeitarPosse: false };
const DOC = "12345678000195";
function bancoComPosse(posse: { data: unknown; error: { message: string } | null } | null, lead: LinhaRadarCadastro | null = LEAD) {
  const chamadas: string[] = [];
  const banco: BancoRadar = {
    lerLead: () => Promise.resolve({ data: lead, error: null }),
    lerPosse: posse === null ? null : (doc) => { chamadas.push(doc); return Promise.resolve(posse); },
  };
  return { banco, chamadas };
}
const linhaPosse = (o: Record<string, unknown> = {}) => ({ cnpj: DOC, dono_user_id: "u-a", dono_nome: "Ana Farmer", eh_meu: false, ...o });

Deno.test("posse: o lote PULA o lead em atendimento por OUTRO, com o nome do dono", async () => {
  const { banco, chamadas } = bancoComPosse({ data: [linhaPosse()], error: null });
  assertEquals(await verificarElegibilidadeRadar(banco, DOC, LOTE), { ok: false, motivo: "posse_de_outro", donoNome: "Ana Farmer" });
  assertEquals(chamadas, [DOC]);
  // Dono sem nome no perfil: recusa do mesmo jeito, sem nome (o front diz "outro vendedor").
  const semNome = bancoComPosse({ data: [linhaPosse({ dono_nome: null })], error: null });
  assertEquals(await verificarElegibilidadeRadar(semNome.banco, DOC, LOTE), { ok: false, motivo: "posse_de_outro", donoNome: null });
  const nomeVazio = bancoComPosse({ data: [linhaPosse({ dono_nome: "   " })], error: null });
  assertEquals(await verificarElegibilidadeRadar(nomeVazio.banco, DOC, LOTE), { ok: false, motivo: "posse_de_outro", donoNome: null });
});

Deno.test("posse: lead livre (0 linhas) ou do PRÓPRIO chamador segue para o cadastro", async () => {
  assertEquals(await verificarElegibilidadeRadar(bancoComPosse({ data: [], error: null }).banco, DOC, LOTE), { ok: true });
  assertEquals(await verificarElegibilidadeRadar(bancoComPosse({ data: [linhaPosse({ eh_meu: true })], error: null }).banco, DOC, LOTE), { ok: true });
});

Deno.test("posse: a ficha (exige conversa) não consulta posse; lead inelegível recusa pelo motivo do LEAD, sem ler posse", async () => {
  const ficha = bancoComPosse({ data: [linhaPosse()], error: null });
  assertEquals(await verificarElegibilidadeRadar(ficha.banco, DOC, FICHA), { ok: true });
  assertEquals(ficha.chamadas, []);
  const descartado = bancoComPosse({ data: [linhaPosse()], error: null }, { ...LEAD, prospeccao_status: "descartado" });
  assertEquals(await verificarElegibilidadeRadar(descartado.banco, DOC, LOTE), { ok: false, motivo: "descartado" });
  assertEquals(descartado.chamadas, []);
});

Deno.test("posse DESCONHECIDA nunca vira 'livre': erro, sem client do usuário, forma estranha, 2 linhas, outro CNPJ LANÇAM", async () => {
  const casos: Array<[string, { data: unknown; error: { message: string } | null } | null]> = [
    ["erro da RPC (ex.: 42501 sem cap)", { data: null, error: { message: "forbidden: radar_prospectar" } }],
    ["sem client do usuário (cron/service role)", null],
    ["data null sem erro", { data: null, error: null }],
    ["data objeto, não lista", { data: linhaPosse(), error: null }],
    ["2 linhas para o mesmo CNPJ", { data: [linhaPosse(), linhaPosse({ dono_user_id: "u-b" })], error: null }],
    ["eh_meu não booleano", { data: [linhaPosse({ eh_meu: "false" })], error: null }],
    ["linha de OUTRO CNPJ (filtro não aplicado)", { data: [linhaPosse({ cnpj: "99999999000199" })], error: null }],
  ];
  for (const [nome, posse] of casos) {
    let lancou = "";
    try { await verificarElegibilidadeRadar(bancoComPosse(posse).banco, DOC, LOTE); } catch (e) { lancou = String(e); }
    if (!lancou.includes("RADAR_POSSE_INDETERMINADA")) throw new Error(`${nome}: esperava RADAR_POSSE_INDETERMINADA, veio: ${lancou || "nenhum lançamento"}`);
  }
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
