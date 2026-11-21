// Testa o CÓDIGO REAL de chave-os.ts + os-idempotente.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/omie-sync/os-idempotente_test.ts
// Cada caso casa a MARCA do ramo (texto da mensagem / campos do desfecho), nunca só "lançou".
import { chaveIntegracaoOS, conferirReserva, inclusaoValida, lerConsultaOS, montarAssinaturaOS } from "./chave-os.ts";
import { criarOuReconciliarOS, type DepsOS, type ReservaOS } from "./os-idempotente.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FALHOU: ${msg}`);
}
function assertEq(a: unknown, b: unknown, msg: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`FALHOU: ${msg}\n  veio:     ${ja}\n  esperado: ${jb}`);
}
async function rejeitaCom(p: Promise<unknown>, marca: string, msg: string) {
  try {
    await p;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (!m.includes(marca)) throw new Error(`FALHOU: ${msg} — lançou outra coisa: ${m}`);
    return;
  }
  throw new Error(`FALHOU: ${msg} — não lançou`);
}

const ORDER = "949fbfd9-1234-4abc-8def-0123456789ab";
const CHAVE = "OS_949fbfd912344abc8def01";
const CLI = 300;

/** Banco + Omie falsos: a reserva vive em memória, com a MESMA semântica do SQL (PK, update
 *  condicional). O Omie falso deduplica pela chave, como o Omie real faz com integração. */
function mundo(opts: {
  omieIncluir?: (p: Record<string, unknown>) => unknown;
  omieConsultar?: (chave: string) => unknown;
  reservaInicial?: Partial<ReservaOS>;
} = {}) {
  const reservas = new Map<string, ReservaOS>();
  if (opts.reservaInicial) {
    reservas.set(ORDER, {
      order_id: ORDER, chave_integracao: CHAVE, assinatura: null, omie_codigo_cliente: CLI,
      omie_codigo_os: null, omie_numero_os: null, ...opts.reservaInicial,
    });
  }
  const chamadas = { incluir: 0, consultar: 0, vincular: 0 };
  const deps: DepsOS = {
    reservar(l) {
      if (!reservas.has(l.order_id)) {
        reservas.set(l.order_id, { ...l, omie_codigo_os: null, omie_numero_os: null });
      }
      return Promise.resolve();
    },
    lerReserva(id) {
      const r = reservas.get(id);
      return Promise.resolve(r ? { ...r } : null);
    },
    regravarAssinatura(id, anterior, nova) {
      const r = reservas.get(id);
      if (!r || r.omie_codigo_os !== null || r.assinatura !== anterior) return Promise.resolve(false);
      r.assinatura = nova.assinatura;
      r.omie_codigo_cliente = nova.omie_codigo_cliente;
      return Promise.resolve(true);
    },
    vincular(id, os) {
      chamadas.vincular++;
      const r = reservas.get(id);
      if (!r || r.omie_codigo_os !== null) return Promise.resolve(false);
      r.omie_codigo_os = os.nCodOS;
      r.omie_numero_os = os.cNumOS;
      return Promise.resolve(true);
    },
    incluirOS(p) {
      chamadas.incluir++;
      return Promise.resolve().then(() => (opts.omieIncluir ?? (() => ({ nCodOS: 111, cNumOS: "624", cCodIntOS: CHAVE })))(p));
    },
    consultarOS(chave) {
      chamadas.consultar++;
      return Promise.resolve().then(() => (opts.omieConsultar ?? (() => {
        throw new Error("Erro Omie: Ordem de Serviço não cadastrada para o Código de Integração");
      }))(chave));
    },
    osAusente: (e) => (e instanceof Error ? e.message : "").includes("não cadastrada"),
  };
  return { deps, reservas, chamadas };
}

const args = (assinatura: string | null = "A") => ({
  orderId: ORDER, omieCodigoCliente: CLI, assinatura,
  montarPayload: (chave: string) => ({ Cabecalho: { cCodIntOS: chave } }),
});

const consultaOk = (extra: Record<string, unknown> = {}) => () => ({
  Cabecalho: { nCodOS: 111, cNumOS: "624", cCodIntOS: CHAVE, nCodCli: CLI },
  InfoCadastro: { cCancelada: "N" },
  ...extra,
});

// ── chave ──
Deno.test("chave: determinística, 25 chars, mesma para o mesmo orderId", () => {
  assertEq(chaveIntegracaoOS(ORDER), CHAVE, "chave do ORDER");
  assertEq(chaveIntegracaoOS(ORDER).length, 25, "25 caracteres (o comprimento provado em prod)");
  assertEq(chaveIntegracaoOS(ORDER.toUpperCase()), CHAVE, "caixa não muda a chave");
});
Deno.test("chave: orderId que não é UUID → recusa (marca 'precisa ser UUID')", () => {
  for (const ruim of ["", "abc", "949fbfd9", 123, null]) {
    let msg = "";
    try {
      chaveIntegracaoOS(ruim);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes("precisa ser UUID"), `recusa ${JSON.stringify(ruim)}`);
  }
});

// ── assinatura / conferência ──
Deno.test("assinatura: sem a do front → null (nunca 'confere')", () => {
  assertEq(montarAssinaturaOS(undefined, CLI, { items: [] }), null, "undefined");
  assertEq(montarAssinaturaOS("  ", CLI, { items: [] }), null, "vazia");
  assertEq(conferirReserva({ assinatura: null, omie_codigo_cliente: CLI }, { assinatura: "x", omieCodigoCliente: CLI }), "indeterminada", "reserva sem assinatura");
});
Deno.test("assinatura: preço, frete, total, pagamento e cliente mudam a assinatura; ordem dos itens não", () => {
  const base = { items: [{ userToolId: "t1", omie_codigo_servico: 9, quantity: 1, unitPrice: 30 }, { userToolId: "t2", omie_codigo_servico: 9, quantity: 2, unitPrice: 10 }], delivery_fee: 0, total: 50, payment_method: "pix" };
  const a = montarAssinaturaOS("F", CLI, base);
  assertEq(montarAssinaturaOS("F", CLI, { ...base, items: [...base.items].reverse() }), a, "ordem dos itens");
  assert(montarAssinaturaOS("F", CLI, { ...base, items: [{ ...base.items[0], unitPrice: 31 }, base.items[1]] }) !== a, "preço");
  assert(montarAssinaturaOS("F", CLI, { ...base, total: 51 }) !== a, "total");
  assert(montarAssinaturaOS("F", CLI, { ...base, payment_method: "30dd" }) !== a, "pagamento");
  assert(montarAssinaturaOS("F", 301, base) !== a, "cliente");
  assert(montarAssinaturaOS("G", CLI, base) !== a, "assinatura do front (ferramenta/entrega)");
});
Deno.test("conferirReserva: cliente diferente → diverge mesmo sem assinatura", () => {
  assertEq(conferirReserva({ assinatura: null, omie_codigo_cliente: 999 }, { assinatura: null, omieCodigoCliente: CLI }), "diverge", "cliente");
  assertEq(conferirReserva({ assinatura: "A", omie_codigo_cliente: String(CLI) }, { assinatura: "A", omieCodigoCliente: CLI }), "confere", "bigint em string");
});

// ── leitura do Omie ──
Deno.test("lerConsultaOS: só aceita a NOSSA OS (chave, cliente, código positivo)", () => {
  assertEq(lerConsultaOS(consultaOk()(), CHAVE, CLI).tipo, "ok", "ok");
  assertEq(lerConsultaOS({ Cabecalho: { nCodOS: 111, cCodIntOS: "OS_outra", nCodCli: CLI } }, CHAVE, CLI).tipo, "invalida", "outra chave");
  assertEq(lerConsultaOS({ Cabecalho: { nCodOS: 111, cCodIntOS: CHAVE, nCodCli: 1 } }, CHAVE, CLI).tipo, "invalida", "outro cliente");
  assertEq(lerConsultaOS({}, CHAVE, CLI).tipo, "invalida", "vazia");
  assertEq(lerConsultaOS(consultaOk({ InfoCadastro: { cCancelada: "S" } })(), CHAVE, CLI).tipo, "cancelada", "cancelada");
});
Deno.test("inclusaoValida: 200 {} e chave ecoada errada não provam a OS", () => {
  assertEq(inclusaoValida({}, CHAVE), null, "{}");
  assertEq(inclusaoValida({ nCodOS: 0 }, CHAVE), null, "nCodOS 0");
  assertEq(inclusaoValida({ nCodOS: 5, cCodIntOS: "OS_x" }, CHAVE), null, "outra chave");
  assertEq(inclusaoValida({ nCodOS: 5, cNumOS: "7", cCodIntOS: CHAVE }, CHAVE), { nCodOS: 5, cNumOS: "7" }, "válida");
});

// ── orquestração ──
Deno.test("1º envio: inclui com a chave determinística, vincula, primeiro=true", async () => {
  const m = mundo();
  const d = await criarOuReconciliarOS(m.deps, args());
  assertEq([d.nCodOS, d.reconciliada, d.primeiro, d.conferencia], [111, false, true, "confere"], "desfecho");
  assertEq((d.payloadEnviado?.Cabecalho as Record<string, unknown>).cCodIntOS, CHAVE, "payload leva a chave");
  assertEq(m.reservas.get(ORDER)?.omie_codigo_os, 111, "vínculo gravado");
});

Deno.test("BUG do #4042: resposta perdida DEPOIS da edge concluir → reenvio NÃO chama IncluirOS", async () => {
  const m = mundo();
  await criarOuReconciliarOS(m.deps, args());
  const d2 = await criarOuReconciliarOS(m.deps, args());
  assertEq(m.chamadas.incluir, 1, "IncluirOS uma vez só");
  assertEq([d2.nCodOS, d2.reconciliada, d2.primeiro, d2.conferencia], [111, true, false, "confere"], "reenvio reconciliado");
});

Deno.test("BUG do #4042: Omie criou mas a EDGE perdeu a resposta → reenvio consulta pela chave e reconcilia", async () => {
  let criada = false;
  const m = mundo({
    omieIncluir: () => {
      if (criada) throw new Error("Erro Omie: Código de Integração já cadastrado");
      criada = true;
      throw new Error("Erro Omie: timeout em IncluirOS");
    },
    omieConsultar: () => {
      if (!criada) throw new Error("Erro Omie: Ordem de Serviço não cadastrada");
      return consultaOk()();
    },
  });
  // 1ª tentativa: o IncluirOS "falha" (timeout) mas a OS ficou no Omie → a própria consulta já acha.
  const d = await criarOuReconciliarOS(m.deps, args());
  assertEq([d.nCodOS, d.reconciliada, d.primeiro, d.conferencia], [111, true, true, "confere"], "reconciliada na mesma chamada");
  assert(String((d.resposta as Record<string, unknown>).erro_inclusao).includes("timeout"), "erro da inclusão registrado");
  const d2 = await criarOuReconciliarOS(m.deps, args());
  assertEq(m.chamadas.incluir, 1, "reenvio não inclui de novo");
  assertEq(d2.primeiro, false, "reenvio não é o primeiro");
});

Deno.test("IncluirOS falhou e o Omie NÃO tem a OS → relança o erro ORIGINAL, nada vinculado", async () => {
  const m = mundo({ omieIncluir: () => { throw new Error("Erro Omie: serviço inválido XYZ"); } });
  await rejeitaCom(criarOuReconciliarOS(m.deps, args()), "serviço inválido XYZ", "erro original");
  assertEq(m.reservas.get(ORDER)?.omie_codigo_os, null, "sem vínculo");
});

Deno.test("IncluirOS 200 {} → consulta; sem a OS lá → erro 'sem uma OS válida'", async () => {
  const m = mundo({ omieIncluir: () => ({}) });
  await rejeitaCom(criarOuReconciliarOS(m.deps, args()), "sem uma OS válida", "200 vazio não é sucesso");
});

Deno.test("consulta acha OS de OUTRO cliente → não confirma, relança o erro original", async () => {
  const m = mundo({
    omieIncluir: () => { throw new Error("Erro Omie: já cadastrado"); },
    omieConsultar: () => ({ Cabecalho: { nCodOS: 5, cCodIntOS: CHAVE, nCodCli: 1 } }),
  });
  await rejeitaCom(criarOuReconciliarOS(m.deps, args()), "já cadastrado", "erro original preservado");
});

Deno.test("OS cancelada no Omie → mensagem 'CANCELADA' (pedido novo)", async () => {
  const m = mundo({
    omieIncluir: () => { throw new Error("Erro Omie: já cadastrado"); },
    omieConsultar: consultaOk({ InfoCadastro: { cCancelada: "S" } }),
  });
  await rejeitaCom(criarOuReconciliarOS(m.deps, args()), "CANCELADA", "cancelada");
});

Deno.test("Codex P1-1: carrinho B após a OS de A → diverge, e continua diverge no 2º reenvio", async () => {
  const m = mundo();
  await criarOuReconciliarOS(m.deps, args("A"));
  const d = await criarOuReconciliarOS(m.deps, args("B"));
  assertEq([d.conferencia, d.primeiro], ["diverge", false], "1º reenvio com B");
  const d2 = await criarOuReconciliarOS(m.deps, args("B"));
  assertEq(d2.conferencia, "diverge", "2º reenvio com B NÃO vira confere");
  assertEq(m.reservas.get(ORDER)?.assinatura, "A", "assinatura da criação imutável");
  assertEq(m.chamadas.incluir, 1, "nenhuma 2ª OS");
});

Deno.test("carrinho mudou, sem vínculo, mas a OS de A EXISTE no Omie (resposta perdida) → diverge, sem incluir", async () => {
  const m = mundo({
    reservaInicial: { assinatura: "A" },
    omieConsultar: consultaOk(),
  });
  const d = await criarOuReconciliarOS(m.deps, args("B"));
  assertEq([d.conferencia, d.reconciliada, d.primeiro], ["diverge", true, true], "diverge reconciliada");
  assertEq(m.chamadas.incluir, 0, "não inclui");
});

Deno.test("carrinho mudou e o Omie PROVA que a OS não existe (1ª tentativa rejeitada) → reabre e inclui B", async () => {
  const m = mundo({ reservaInicial: { assinatura: "A" } });
  const d = await criarOuReconciliarOS(m.deps, args("B"));
  assertEq([d.conferencia, d.primeiro, d.reconciliada], ["confere", true, false], "inclui o carrinho novo");
  assertEq(m.reservas.get(ORDER)?.assinatura, "B", "reserva reaberta com B");
});

Deno.test("carrinho mudou e a consulta é INDETERMINADA → 'Não deu para conferir', nada criado", async () => {
  const m = mundo({
    reservaInicial: { assinatura: "A" },
    omieConsultar: () => { throw new Error("Erro Omie: HTTP 503 em ConsultarOS"); },
  });
  await rejeitaCom(criarOuReconciliarOS(m.deps, args("B")), "Não deu para conferir", "indeterminado");
  assertEq(m.chamadas.incluir, 0, "não inclui");
});

Deno.test("corrida: outro envio vinculou antes → devolve a OS vinculada, primeiro=false", async () => {
  const m = mundo();
  const vincularOrig = m.deps.vincular;
  m.deps.vincular = async (id, os) => {
    // o concorrente vence a corrida no meio
    const r = m.reservas.get(id)!;
    r.omie_codigo_os = os.nCodOS; r.omie_numero_os = os.cNumOS;
    return await vincularOrig(id, os);
  };
  const d = await criarOuReconciliarOS(m.deps, args());
  assertEq([d.primeiro, d.reconciliada, d.nCodOS], [false, true, 111], "perdedor não grava espelho");
});

Deno.test("reserva some após gravar → aborta antes do Omie", async () => {
  const m = mundo();
  m.deps.lerReserva = () => Promise.resolve(null);
  await rejeitaCom(criarOuReconciliarOS(m.deps, args()), "não encontrada após gravar", "sem reserva");
  assertEq(m.chamadas.incluir, 0, "não inclui");
});
