// Testa o CÓDIGO REAL de omie-vendas-sync/radar-cadastro.ts no runtime real (Deno, sem rede).
// Revisão do Radar 2026-11-11 (itens 5 e 7): elegibilidade do lead validada no SERVIDOR entre o lookup estrito e o
// IncluirCliente, e e-mail/complemento da Receita normalizados antes de irem ao ERP.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg ?? `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}
import {
  complementoParaCadastro, criarClienteComRegraRadar, emailParaCadastro, lerExigenciaRadar, motivoInelegivelRadar,
  verificarElegibilidadeRadar, verificarPosseRadar,
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
type RespostaPosse = { data: unknown; error: { message: string } | null };
function bancoComPosse(posse: RespostaPosse | null, lead: LinhaRadarCadastro | null = LEAD, log: string[] = []) {
  const banco: BancoRadar = {
    lerLead: (doc) => { log.push(`lead:${doc}`); return Promise.resolve({ data: lead, error: null }); },
    lerPosse: posse === null ? null : (doc) => { log.push(`posse:${doc}`); return Promise.resolve(posse); },
  };
  return { banco, log };
}
const linhaPosse = (o: Record<string, unknown> = {}) => ({ cnpj: DOC, dono_user_id: "u-a", dono_nome: "Ana Farmer", eh_meu: false, ...o });

/** O fluxo REAL do `criar_cliente` (criarClienteComRegraRadar) com só a I/O falsa; `log` mostra a ORDEM das chamadas. */
async function criar(exigencia: ExigenciaRadar | null, posse: RespostaPosse | null, lead: LinhaRadarCadastro | null = LEAD) {
  const log: string[] = [];
  const { banco } = bancoComPosse(posse, lead, log);
  const r = await criarClienteComRegraRadar({
    exigencia, banco, documento: DOC,
    preparar: () => { log.push("preparar"); return Promise.resolve({ razao: "X" }); },
    incluir: (p) => { log.push(`incluir:${p.razao}`); return Promise.resolve({ codigo_cliente_omie: 77 }); },
  });
  return { r, log };
}

Deno.test("posse: o lote PULA o lead em atendimento por OUTRO — recusa exata e ZERO IncluirCliente", async () => {
  const { r, log } = await criar(LOTE, { data: [linhaPosse()], error: null });
  assertEquals(r, { recusa: {
    success: false, code: "RADAR_INELEGIVEL", motivo: "posse_de_outro", dono_nome: "Ana Farmer",
    error: "RADAR_INELEGIVEL: posse_de_outro — em atendimento por Ana Farmer; nada foi criado no Omie",
  } });
  // Ordem: lead → preparação (razão fiscal) → posse IMEDIATAMENTE antes da inclusão — que não acontece.
  assertEquals(log, [`lead:${DOC}`, "preparar", `posse:${DOC}`]);
  // Dono sem nome no perfil (null, vazio, só espaço): recusa do mesmo jeito, com o texto genérico.
  for (const dono of [null, "", "   ", 42]) {
    const semNome = await criar(LOTE, { data: [linhaPosse({ dono_nome: dono })], error: null });
    assertEquals(semNome.r, { recusa: {
      success: false, code: "RADAR_INELEGIVEL", motivo: "posse_de_outro", dono_nome: null,
      error: "RADAR_INELEGIVEL: posse_de_outro — em atendimento por outro vendedor; nada foi criado no Omie",
    } }, `dono_nome=${JSON.stringify(dono)}`);
  }
});

Deno.test("posse: lead livre (0 linhas) ou do PRÓPRIO chamador segue para o IncluirCliente", async () => {
  for (const data of [[], [linhaPosse({ eh_meu: true })]]) {
    const { r, log } = await criar(LOTE, { data, error: null });
    assertEquals(r, { criado: { codigo_cliente_omie: 77 }, preparo: { razao: "X" } });
    assertEquals(log, [`lead:${DOC}`, "preparar", `posse:${DOC}`, "incluir:X"]);
  }
});

Deno.test("posse: a ficha (exige conversa) não consulta posse; sem `radar` nada do Radar é lido", async () => {
  const ficha = await criar(FICHA, { data: [linhaPosse()], error: null });
  assertEquals(ficha.log, [`lead:${DOC}`, "preparar", "incluir:X"]);
  const semRadar = await criar(null, { data: [linhaPosse()], error: null });
  assertEquals(semRadar.log, ["preparar", "incluir:X"]);
});

Deno.test("lead inelegível recusa pelo motivo do LEAD antes de qualquer preparação, sem ler posse", async () => {
  const { r, log } = await criar(LOTE, { data: [linhaPosse()], error: null }, { ...LEAD, prospeccao_status: "descartado" });
  assertEquals(r, { recusa: { success: false, code: "RADAR_INELEGIVEL", motivo: "descartado", error: "RADAR_INELEGIVEL: descartado" } });
  assertEquals(log, [`lead:${DOC}`]);
});

Deno.test("posse DESCONHECIDA nunca vira 'livre': LANÇA e o IncluirCliente não é chamado", async () => {
  const casos: Array<[string, RespostaPosse | null]> = [
    ["erro da RPC (ex.: 42501 sem cap)", { data: null, error: { message: "forbidden: radar_prospectar" } }],
    ["sem client do usuário (cron/service role)", null],
    ["data null sem erro", { data: null, error: null }],
    ["data objeto, não lista", { data: linhaPosse(), error: null }],
    ["linha null", { data: [null], error: null }],
    ["linha primitiva", { data: [42], error: null }],
    ["2 linhas para o mesmo CNPJ", { data: [linhaPosse(), linhaPosse({ dono_user_id: "u-b" })], error: null }],
    ["eh_meu não booleano", { data: [linhaPosse({ eh_meu: "false" })], error: null }],
    ["linha de OUTRO CNPJ (filtro não aplicado)", { data: [linhaPosse({ cnpj: "99999999000199" })], error: null }],
  ];
  for (const [nome, posse] of casos) {
    const log: string[] = [];
    const { banco } = bancoComPosse(posse, LEAD, log);
    let lancou = "";
    try {
      await criarClienteComRegraRadar({
        exigencia: LOTE, banco, documento: DOC,
        preparar: () => Promise.resolve(null),
        incluir: () => { log.push("incluir"); return Promise.resolve(null); },
      });
    } catch (e) { lancou = String(e); }
    if (!lancou.includes("RADAR_POSSE_INDETERMINADA")) throw new Error(`${nome}: esperava RADAR_POSSE_INDETERMINADA, veio: ${lancou || "nenhum lançamento"}`);
    if (log.includes("incluir")) throw new Error(`${nome}: chamou o IncluirCliente com a posse desconhecida`);
  }
  // Leitura que REJEITA (rede): propaga, e também não inclui.
  const banco: BancoRadar = { lerLead: () => Promise.resolve({ data: LEAD, error: null }), lerPosse: () => Promise.reject(new Error("rede caiu")) };
  let incluiu = false;
  let erro = "";
  try {
    await criarClienteComRegraRadar({ exigencia: LOTE, banco, documento: DOC, preparar: () => Promise.resolve(null), incluir: () => { incluiu = true; return Promise.resolve(null); } });
  } catch (e) { erro = String(e); }
  if (!erro.includes("rede caiu") || incluiu) throw new Error(`rejeição: erro=${erro} incluiu=${incluiu}`);
});

Deno.test("verificarPosseRadar: livre, meu e de outro (o veredito que o fluxo usa)", async () => {
  assertEquals(await verificarPosseRadar(bancoComPosse({ data: [], error: null }).banco, DOC), { ok: true });
  assertEquals(await verificarPosseRadar(bancoComPosse({ data: [linhaPosse({ eh_meu: true })], error: null }).banco, DOC), { ok: true });
  assertEquals(await verificarPosseRadar(bancoComPosse({ data: [linhaPosse()], error: null }).banco, DOC),
    { ok: false, motivo: "posse_de_outro", donoNome: "Ana Farmer" });
});

// A LIGAÇÃO no index.ts (parecer Codex 2026-11-14, P1): o único IncluirCliente da edge sai do `incluir` do fluxo com a
// regra do Radar — chamá-lo por fora pularia lead e posse sem nenhum teste acima ficar vermelho.
Deno.test("index.ts: o único IncluirCliente mora no `incluir:` do criarClienteComRegraRadar, e a recusa faz break", async () => {
  const src = (await Deno.readTextFile(new URL("./index.ts", import.meta.url)))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const chamadas = src.split('"IncluirCliente"').length - 1;
  assertEquals(chamadas, 1, `esperava 1 chamada a "IncluirCliente" em código, achei ${chamadas}`);
  const ini = src.indexOf("await criarClienteComRegraRadar({");
  const incluir = src.indexOf("incluir: async (clienteParams) => {", ini);
  const fim = src.indexOf('if ("recusa" in fluxo) {', ini);
  const call = src.indexOf('"IncluirCliente"');
  if (!(ini >= 0 && incluir > ini && call > incluir && fim > call)) {
    throw new Error(`IncluirCliente fora do incluir do fluxo (ini=${ini} incluir=${incluir} call=${call} fim=${fim})`);
  }
  const ramo = src.slice(fim, src.indexOf("}", fim + 30) + 1);
  if (!ramo.includes("result = fluxo.recusa;") || !ramo.includes("break;")) throw new Error(`ramo da recusa sem result/break: ${ramo}`);
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
