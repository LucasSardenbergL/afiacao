// Testa o CÓDIGO REAL de chave-os.ts + os-idempotente.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/omie-sync/os-idempotente_test.ts
// Cada caso casa a MARCA do ramo (texto da mensagem / campos do desfecho), nunca só "lançou".
import { chaveIntegracaoOS, inclusaoValida, lerConsultaOS, montarAssinaturaOS } from "./chave-os.ts";
import { criarOuReconciliarOS, type DepsOS, OsAcaoNoOmieError, type ReservaOS } from "./os-idempotente.ts";

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
const CLI = 300;
const ANTIGO = new Date(Date.now() - 10 * 60_000).toISOString(); // reservado fora da janela de inclusão em voo
async function rejeitaMotivo(p: Promise<unknown>, motivo: string, msg: string) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof OsAcaoNoOmieError) || e.motivo !== motivo) {
      throw new Error(`FALHOU: ${msg} — esperava motivo ${motivo}, veio ${e instanceof OsAcaoNoOmieError ? e.motivo : (e as Error).message}`);
    }
    return;
  }
  throw new Error(`FALHOU: ${msg} — não lançou`);
}
const K = (assinatura = "A", cli = CLI) => chaveIntegracaoOS(ORDER, cli, assinatura);

/** Banco + Omie falsos: a reserva vive em memória com a MESMA semântica do SQL (PK, UPDATE
 *  condicional em chave + omie_codigo_os IS NULL). O Omie falso guarda OS por chave e deduplica. */
function mundo(opts: { omieIncluir?: (p: Record<string, unknown>, omie: Map<string, number>) => unknown; consultaFalha?: (chave: string) => Error | null } = {}) {
  const reservas = new Map<string, ReservaOS>();
  const omie = new Map<string, number>(); // chave → nCodOS
  let seq = 100;
  const chamadas = { incluir: 0, consultar: 0 };
  const deps: DepsOS = {
    reservar(l) {
      if (!reservas.has(l.order_id)) {
        reservas.set(l.order_id, { ...l, omie_codigo_os: null, omie_numero_os: null, reservado_em: new Date().toISOString() });
      }
      return Promise.resolve();
    },
    lerReserva: (id) => Promise.resolve(reservas.has(id) ? { ...reservas.get(id)! } : null),
    reabrir(id, ant, antesDe, nova) {
      const r = reservas.get(id);
      if (!r || r.chave_integracao !== ant || r.omie_codigo_os !== null || !(r.reservado_em < antesDe)) return Promise.resolve(false);
      Object.assign(r, nova);
      return Promise.resolve(true);
    },
    vincular(id, chave, os) {
      const r = reservas.get(id);
      if (!r || r.chave_integracao !== chave || r.omie_codigo_os !== null) return Promise.resolve(false);
      r.omie_codigo_os = os.nCodOS; r.omie_numero_os = os.cNumOS;
      return Promise.resolve(true);
    },
    incluirOS(p) {
      chamadas.incluir++;
      return Promise.resolve().then(() => {
        if (opts.omieIncluir) return opts.omieIncluir(p, omie);
        const chave = (p.Cabecalho as Record<string, string>).cCodIntOS;
        if (omie.has(chave)) throw new Error("Erro Omie: Código de Integração já cadastrado");
        const n = ++seq; omie.set(chave, n);
        return { nCodOS: n, cNumOS: String(n), cCodIntOS: chave };
      });
    },
    consultarOS(chave) {
      chamadas.consultar++;
      return Promise.resolve().then(() => {
        const f = opts.consultaFalha?.(chave);
        if (f) throw f;
        const n = omie.get(chave);
        if (!n) throw new Error("Erro Omie: Ordem de Serviço não cadastrada para o Código de Integração");
        return { Cabecalho: { nCodOS: n, cNumOS: String(n), cCodIntOS: chave, nCodCli: CLI }, InfoCadastro: { cCancelada: "N" } };
      });
    },
    osAusente: (e) => (e instanceof Error ? e.message : "").includes("não cadastrad"),
  };
  return { deps, reservas, omie, chamadas };
}

const args = (assinatura = "A") => ({
  orderId: ORDER, omieCodigoCliente: CLI, assinatura,
  montarPayload: (chave: string) => ({ Cabecalho: { cCodIntOS: chave } }),
});

// ── chave ──
Deno.test("chave: determinística, 25 chars; carrinho ou cliente diferente → outra chave", async () => {
  const a = await K("A");
  assertEq(a, await K("A"), "mesma entrada, mesma chave");
  assertEq(a.length, 25, "25 caracteres (o comprimento provado em prod)");
  assert(/^OS_[0-9a-f]{22}$/.test(a), "formato");
  assert(a !== await K("B"), "assinatura muda a chave");
  assert(a !== await K("A", 301), "cliente muda a chave");
  assertEq(await chaveIntegracaoOS(ORDER.toUpperCase(), CLI, "A"), a, "caixa do UUID não muda a chave");
});
Deno.test("chave: orderId que não é UUID → recusa (marca 'precisa ser UUID')", async () => {
  for (const ruim of ["", "abc", "949fbfd9", 123, null]) {
    await rejeitaCom(chaveIntegracaoOS(ruim, CLI, "A"), "precisa ser UUID", `recusa ${JSON.stringify(ruim)}`);
  }
});

// ── assinatura ──
Deno.test("Codex P1-3: sem a assinatura do front (app antigo) → 'legado', mas o PAYLOAD ainda separa os carrinhos", () => {
  const base = { items: [{ userToolId: "t1", omie_codigo_servico: 9, quantity: 1, unitPrice: 10 }], total: 10 };
  const a = montarAssinaturaOS(undefined, CLI, base);
  assert(a.startsWith("legado#"), "cai em legado");
  assert(a !== montarAssinaturaOS(undefined, CLI, { ...base, items: [{ ...base.items[0], unitPrice: 90 }], total: 90 }), "R$10 ≠ R$90");
});

Deno.test("assinatura: preço, frete, total, pagamento e cliente mudam; ordem dos itens não", () => {
  const base = { items: [{ userToolId: "t1", omie_codigo_servico: 9, quantity: 1, unitPrice: 30 }, { userToolId: "t2", omie_codigo_servico: 9, quantity: 2, unitPrice: 10 }], delivery_fee: 0, total: 50, payment_method: "pix" };
  const a = montarAssinaturaOS("F", CLI, base);
  assertEq(montarAssinaturaOS("F", CLI, { ...base, items: [...base.items].reverse() }), a, "ordem dos itens");
  assert(montarAssinaturaOS("F", CLI, { ...base, items: [{ ...base.items[0], unitPrice: 31 }, base.items[1]] }) !== a, "preço");
  assert(montarAssinaturaOS("F", CLI, { ...base, total: 51 }) !== a, "total");
  assert(montarAssinaturaOS("F", CLI, { ...base, payment_method: "30dd" }) !== a, "pagamento");
  assert(montarAssinaturaOS("F", 301, base) !== a, "cliente");
  assert(montarAssinaturaOS("G", CLI, base) !== a, "assinatura do front (ferramenta/entrega)");
});

// ── leitura do Omie ──
Deno.test("lerConsultaOS: só aceita a NOSSA OS, ativa por 'N' explícito", async () => {
  const c = await K();
  const ok = { Cabecalho: { nCodOS: 111, cNumOS: "624", cCodIntOS: c, nCodCli: CLI }, InfoCadastro: { cCancelada: "N" } };
  assertEq(lerConsultaOS(ok, c, CLI).tipo, "ok", "ok");
  assertEq(lerConsultaOS({ ...ok, Cabecalho: { ...ok.Cabecalho, cCodIntOS: "OS_outra" } }, c, CLI).tipo, "invalida", "outra chave");
  assertEq(lerConsultaOS({ ...ok, Cabecalho: { ...ok.Cabecalho, nCodCli: 1 } }, c, CLI).tipo, "invalida", "outro cliente");
  assertEq(lerConsultaOS({ ...ok, Cabecalho: { ...ok.Cabecalho, nCodOS: 1.5 } }, c, CLI).tipo, "invalida", "nCodOS não inteiro");
  assertEq(lerConsultaOS({ ...ok, Cabecalho: { ...ok.Cabecalho, nCodOS: "111" } }, c, CLI).tipo, "invalida", "nCodOS string");
  assertEq(lerConsultaOS({ Cabecalho: ok.Cabecalho }, c, CLI).tipo, "invalida", "sem InfoCadastro");
  assertEq(lerConsultaOS({}, c, CLI).tipo, "invalida", "vazia");
  assertEq(lerConsultaOS({ ...ok, InfoCadastro: { cCancelada: "S" } }, c, CLI).tipo, "cancelada", "cancelada");
});
Deno.test("inclusaoValida: 200 {}, sem eco e eco errado não provam a OS", async () => {
  const c = await K();
  assertEq(inclusaoValida({}, c), null, "{}");
  assertEq(inclusaoValida({ nCodOS: 5 }, c), null, "sem eco da chave");
  assertEq(inclusaoValida({ nCodOS: true, cCodIntOS: c }, c), null, "nCodOS booleano (Codex P3)");
  assertEq(inclusaoValida({ nCodOS: 5, cCodIntOS: "OS_x" }, c), null, "outra chave");
  assertEq(inclusaoValida({ nCodOS: 5, cNumOS: "7", cCodIntOS: c }, c), { nCodOS: 5, cNumOS: "7" }, "válida");
});

// ── orquestração ──
Deno.test("1º envio: inclui com a chave do conteúdo, vincula, primeiro=true", async () => {
  const m = mundo();
  const d = await criarOuReconciliarOS(m.deps, args());
  assertEq([d.reconciliada, d.primeiro, d.conferencia], [false, true, "confere"], "desfecho");
  assertEq((d.payloadEnviado?.Cabecalho as Record<string, unknown>).cCodIntOS, await K(), "payload leva a chave");
  assertEq(m.reservas.get(ORDER)?.omie_codigo_os, d.nCodOS, "vínculo gravado");
});

Deno.test("BUG do #4042: resposta perdida DEPOIS da edge concluir → reenvio NÃO chama IncluirOS", async () => {
  const m = mundo();
  const d1 = await criarOuReconciliarOS(m.deps, args());
  const d2 = await criarOuReconciliarOS(m.deps, args());
  assertEq(m.chamadas.incluir, 1, "IncluirOS uma vez só");
  assertEq([d2.nCodOS, d2.reconciliada, d2.primeiro, d2.conferencia], [d1.nCodOS, true, false, "confere"], "reenvio reconciliado");
});

Deno.test("BUG do #4042: Omie criou mas a resposta à EDGE se perdeu → a consulta pela chave reconcilia", async () => {
  const m = mundo({
    omieIncluir: (p, omie) => {
      omie.set((p.Cabecalho as Record<string, string>).cCodIntOS, 777);
      throw new Error("Erro Omie: timeout em IncluirOS");
    },
  });
  const d = await criarOuReconciliarOS(m.deps, args());
  assertEq([d.nCodOS, d.reconciliada, d.primeiro, d.conferencia], [777, true, true, "confere"], "reconciliada");
  assert(String((d.resposta as Record<string, unknown>).erro_inclusao).includes("timeout"), "erro da inclusão registrado");
  assertEq(m.omie.size, 1, "uma OS só no Omie");
});

Deno.test("Codex P1-2: o vínculo falhou depois de criar → reenvio do MESMO carrinho conclui (confere)", async () => {
  const m = mundo();
  const vincOrig = m.deps.vincular;
  let caiu = false;
  m.deps.vincular = (id, chave, os) => {
    if (!caiu) { caiu = true; return Promise.reject(new Error("queda do banco")); }
    return vincOrig(id, chave, os);
  };
  await rejeitaCom(criarOuReconciliarOS(m.deps, args()), "queda do banco", "1ª chamada cai no vínculo");
  const d = await criarOuReconciliarOS(m.deps, args());
  assertEq([d.reconciliada, d.primeiro, d.conferencia], [true, true, "confere"], "reenvio reconcilia e vincula");
  assertEq(m.omie.size, 1, "sem 2ª OS");
});

Deno.test("IncluirOS falhou e o Omie NÃO tem a OS → relança o erro ORIGINAL, nada vinculado", async () => {
  const m = mundo({ omieIncluir: () => { throw new Error("Erro Omie: serviço inválido XYZ"); } });
  await rejeitaCom(criarOuReconciliarOS(m.deps, args()), "serviço inválido XYZ", "erro original");
  assertEq(m.reservas.get(ORDER)?.omie_codigo_os, null, "sem vínculo");
});

Deno.test("IncluirOS 200 {} e o Omie sem a OS → erro 'sem uma OS válida'", async () => {
  const m = mundo({ omieIncluir: () => ({}) });
  await rejeitaCom(criarOuReconciliarOS(m.deps, args()), "sem uma OS válida", "200 vazio não é sucesso");
});

Deno.test("OS cancelada no Omie → motivo os_cancelada (pedido novo)", async () => {
  const m = mundo({ omieIncluir: () => { throw new Error("Erro Omie: já cadastrado"); } });
  const c = await K();
  m.deps.consultarOS = () => Promise.resolve({ Cabecalho: { nCodOS: 9, cNumOS: "9", cCodIntOS: c, nCodCli: CLI }, InfoCadastro: { cCancelada: "S" } });
  await rejeitaMotivo(criarOuReconciliarOS(m.deps, args()), "os_cancelada", "cancelada");
});

Deno.test("Codex P1-4: OS EXCLUÍDA no Omie depois do vínculo → reenvio não ressuscita o pedido (os_excluida)", async () => {
  const m = mundo();
  await criarOuReconciliarOS(m.deps, args());
  m.omie.clear(); // delete_order → ExcluirOS
  await rejeitaMotivo(criarOuReconciliarOS(m.deps, args()), "os_excluida", "excluída é terminal");
  assertEq(m.chamadas.incluir, 1, "não recria");
});

Deno.test("Codex P1-4: OS CANCELADA depois do vínculo → reenvio acusa os_cancelada", async () => {
  const m = mundo();
  await criarOuReconciliarOS(m.deps, args());
  const c = await K();
  m.deps.consultarOS = () => Promise.resolve({ Cabecalho: { nCodOS: 101, cNumOS: "101", cCodIntOS: c, nCodCli: CLI }, InfoCadastro: { cCancelada: "S" } });
  await rejeitaMotivo(criarOuReconciliarOS(m.deps, args()), "os_cancelada", "cancelada depois");
});

Deno.test("mesmo carrinho, OS vinculada, consulta indeterminada → 'Não deu para conferir' (não confirma às cegas)", async () => {
  const m = mundo();
  await criarOuReconciliarOS(m.deps, args());
  m.deps.consultarOS = () => Promise.reject(new Error("Erro Omie: HTTP 503 em ConsultarOS"));
  await rejeitaCom(criarOuReconciliarOS(m.deps, args()), "Não deu para conferir", "indeterminado");
});

Deno.test("Codex P1-1 (diff): carrinho B depois da OS de A → diverge, e continua diverge no 2º reenvio", async () => {
  const m = mundo();
  await criarOuReconciliarOS(m.deps, args("A"));
  const d = await criarOuReconciliarOS(m.deps, args("B"));
  const d2 = await criarOuReconciliarOS(m.deps, args("B"));
  assertEq([d.conferencia, d2.conferencia], ["diverge", "diverge"], "diverge nas duas");
  assertEq(m.reservas.get(ORDER)?.chave_integracao, await K("A"), "reserva fica na chave da criação");
  assertEq(m.chamadas.incluir, 1, "nenhuma 2ª OS");
});

Deno.test("carrinho mudou, OS de A no Omie sem vínculo (resposta perdida) → diverge, sem incluir B", async () => {
  const m = mundo();
  m.reservas.set(ORDER, { order_id: ORDER, chave_integracao: await K("A"), assinatura: "A", omie_codigo_cliente: CLI, omie_codigo_os: null, omie_numero_os: null, reservado_em: ANTIGO });
  m.omie.set(await K("A"), 555);
  const d = await criarOuReconciliarOS(m.deps, args("B"));
  assertEq([d.conferencia, d.nCodOS], ["diverge", 555], "acusa a OS de A");
  assertEq(m.chamadas.incluir, 0, "não inclui");
  assertEq(m.reservas.get(ORDER)?.omie_codigo_os, 555, "vínculo da OS de A gravado");
});

Deno.test("carrinho mudou e o Omie PROVA que a OS de A não existe → reabre e inclui B", async () => {
  const m = mundo();
  m.reservas.set(ORDER, { order_id: ORDER, chave_integracao: await K("A"), assinatura: "A", omie_codigo_cliente: CLI, omie_codigo_os: null, omie_numero_os: null, reservado_em: ANTIGO });
  const d = await criarOuReconciliarOS(m.deps, args("B"));
  assertEq([d.conferencia, d.primeiro, d.reconciliada], ["confere", true, false], "inclui o carrinho novo");
  assertEq(m.reservas.get(ORDER)?.chave_integracao, await K("B"), "reserva reaberta na chave de B");
});

Deno.test("Codex P2: 'Vendedor não cadastrado' NÃO prova a ausência da OS → não reabre", async () => {
  const m = mundo({ consultaFalha: () => new Error("Erro Omie: Vendedor não cadastrado") });
  m.reservas.set(ORDER, { order_id: ORDER, chave_integracao: await K("A"), assinatura: "A", omie_codigo_cliente: CLI, omie_codigo_os: null, omie_numero_os: null, reservado_em: ANTIGO });
  await rejeitaCom(criarOuReconciliarOS(m.deps, args("B")), "Não deu para conferir", "não reabre");
  assertEq(m.chamadas.incluir, 0, "não inclui");
});

Deno.test("carrinho mudou e a consulta é INDETERMINADA → 'Não deu para conferir', nada criado", async () => {
  const m = mundo({ consultaFalha: () => new Error("Erro Omie: HTTP 503 em ConsultarOS") });
  m.reservas.set(ORDER, { order_id: ORDER, chave_integracao: await K("A"), assinatura: "A", omie_codigo_cliente: CLI, omie_codigo_os: null, omie_numero_os: null, reservado_em: ANTIGO });
  await rejeitaCom(criarOuReconciliarOS(m.deps, args("B")), "Não deu para conferir", "indeterminado");
});

Deno.test("Codex P1-1: inclusão de A em voo + B (outro carrinho) → B espera a janela, A conclui confere", async () => {
  let liberarA!: () => void;
  const portaA = new Promise<void>((r) => (liberarA = r));
  const m = mundo();
  const incluirReal = m.deps.incluirOS;
  const chaveA = await K("A");
  m.deps.incluirOS = async (p) => {
    if ((p.Cabecalho as Record<string, string>).cCodIntOS === chaveA) await portaA;
    return await incluirReal(p);
  };
  const pA = criarOuReconciliarOS(m.deps, args("A"));
  await new Promise((r) => setTimeout(r, 0));
  await rejeitaMotivo(criarOuReconciliarOS(m.deps, args("B")), "aguardar", "B não reabre durante a janela");
  liberarA();
  const dA = await pA;
  assertEq([dA.conferencia, dA.primeiro], ["confere", true], "A conclui");
  assertEq(m.omie.size, 1, "uma OS só");
});

Deno.test("relógio adiantado além da janela com A ainda em voo → A NÃO vincula na reserva de B (pedido_mudou)", async () => {
  let liberarA!: () => void;
  const portaA = new Promise<void>((r) => (liberarA = r));
  const m = mundo();
  const incluirReal = m.deps.incluirOS;
  const chaveA = await K("A");
  m.deps.incluirOS = async (p) => {
    if ((p.Cabecalho as Record<string, string>).cCodIntOS === chaveA) await portaA;
    return await incluirReal(p);
  };
  const pA = criarOuReconciliarOS(m.deps, args("A"));
  await new Promise((r) => setTimeout(r, 0));
  const depsB = { ...m.deps, agora: () => Date.now() + 10 * 60_000 };
  const dB = await criarOuReconciliarOS(depsB, args("B"));
  assertEq(dB.conferencia, "confere", "B criou a sua OS");
  liberarA();
  await rejeitaMotivo(pA, "pedido_mudou", "A avisa, nunca confirma");
  assertEq(m.reservas.get(ORDER)?.omie_codigo_os, dB.nCodOS, "a reserva guarda a OS de B");
});

Deno.test("reserva some após gravar → aborta antes do Omie", async () => {
  const m = mundo();
  m.deps.lerReserva = () => Promise.resolve(null);
  await rejeitaCom(criarOuReconciliarOS(m.deps, args()), "não encontrada após gravar", "sem reserva");
  assertEq(m.chamadas.incluir, 0, "não inclui");
});
