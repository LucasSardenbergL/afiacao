// Testa a lógica PURA de _shared/zeramento-estoque.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/zeramento-estoque_test.ts
//
// A regra (docs/historico/estoque-dono-unico.md): a AUSÊNCIA numa listagem completa do
// ListarPosEstoque padrão só DESCOBRE candidatos; quem autoriza o zero é uma CONFIRMAÇÃO explícita
// (cExibeTodos "S" + lista_produtos) que devolve o saldo 0 do próprio produto. A listagem paginada
// não é um retrato: um produto que esgota entre a página 1 e a 2 desloca a página seguinte e um
// POSITIVO some do conjunto sem que guarda alguma de tamanho perceba (contraexemplo do Codex).
import {
  avaliarCompletudeListagem,
  CONFIRMACAO_POR_CHAMADA,
  interpretarConfirmacao,
  espelhosDaMesmaConta,
  limiteAnomalia,
  type LinhaEstoqueLocal,
  type LinhaPosicaoLocal,
  montarPedidosConfirmacao,
  planejarCandidatos,
  planejarEscritaConfirmada,
} from "./zeramento-estoque.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const NOW = "2026-10-05T13:00:00.000Z";
const COMPLETA = { completa: true } as const;

function pos(
  cod: number | string | null,
  saldo: unknown,
  synced_at: string | null,
  cmc: unknown = 10,
  preco_medio: unknown = 12,
  account = "vendas",
): LinhaPosicaoLocal {
  return { account, omie_codigo_produto: cod, saldo, cmc, preco_medio, synced_at };
}

const UPD = "2026-10-05T12:00:00.123456+00:00";
function est(id: string | null, cod: number | string | null, estoque: unknown, updated_at: string | null = UPD): LinhaEstoqueLocal {
  return { id, omie_codigo_produto: cod, estoque, updated_at };
}

// ════════ completude da listagem ════════

Deno.test("completude — páginas cheias e a última curta: completa", () => {
  assertEquals(avaliarCompletudeListagem([100, 100, 37], 100), { completa: true });
});

Deno.test("completude — página INTERMEDIÁRIA curta: incompleta, o motivo nomeia a página", () => {
  const r = avaliarCompletudeListagem([100, 99, 100, 12], 100);
  assertEquals(r.completa, false);
  if (!r.completa) assertEquals(r.motivo.includes("página 2"), true, r.motivo);
});

Deno.test("completude — ÚLTIMA página cheia: incompleta (página cheia é evidência de continuação)", () => {
  assertEquals(avaliarCompletudeListagem([100, 100], 100).completa, false);
});

Deno.test("completude — nenhuma página: incompleta", () => {
  assertEquals(avaliarCompletudeListagem([], 100).completa, false);
});

// ════════ limite de anomalia ════════

Deno.test("anomalia — acima de max(50, ⌈25% dos listados⌉) candidatos a listagem é suspeita", () => {
  assertEquals(limiteAnomalia(0), 50);
  assertEquals(limiteAnomalia(100), 50);
  assertEquals(limiteAnomalia(782), 196);
});

// ════════ candidatos ════════

Deno.test("candidatos — posição local com saldo ≠ 0 FORA da listagem é candidata; dentro, não", () => {
  const r = planejarCandidatos({
    listados: new Set([1, 2]),
    completude: COMPLETA,
    posicoesLocais: [pos(1, 5, "2026-10-05T12:00:00Z"), pos(3, 2.43, "2026-08-27T10:00:00Z"), pos(4, -1, "2026-09-01T00:00:00Z")],
    estoqueLocal: [],
  });
  assertEquals(r, { aConfirmar: [3, 4], candidatos: 2, pulado: null });
});

Deno.test("candidatos — saldo 0, null, ausente ou não-numérico nunca é candidato", () => {
  const r = planejarCandidatos({
    listados: new Set([1]),
    completude: COMPLETA,
    posicoesLocais: [pos(2, 0, null), pos(3, null, null), pos(4, undefined, null), pos(5, "", null), pos(6, "abc", null)],
    estoqueLocal: [],
  });
  assertEquals(r.aConfirmar, []);
  assertEquals(r.candidatos, 0);
});

Deno.test("candidatos — código inválido (0, negativo, fracional, texto, null) nunca é candidato", () => {
  const r = planejarCandidatos({
    listados: new Set([1]),
    completude: COMPLETA,
    posicoesLocais: [pos(0, 5, null), pos(-3, 5, null), pos(1.5, 5, null), pos("abc", 5, null), pos(null, 5, null)],
    estoqueLocal: [est("x", 0, 5), est("y", "abc", 5)],
  });
  assertEquals(r.aConfirmar, []);
});

Deno.test("candidatos — o mais VELHO primeiro (synced_at null antes de todos), desempate pelo código", () => {
  const r = planejarCandidatos({
    listados: new Set([1]),
    completude: COMPLETA,
    posicoesLocais: [
      pos(30, 1, "2026-09-10T00:00:00Z"),
      pos(20, 1, "2026-06-01T00:00:00Z"),
      pos(10, 1, null),
      pos(11, 1, "2026-06-01T00:00:00Z"),
    ],
    estoqueLocal: [],
  });
  assertEquals(r.aConfirmar, [10, 11, 20, 30]);
});

Deno.test("candidatos — estoque do catálogo ≠ 0 fora da lista entra na UNIÃO, sem repetir código", () => {
  const r = planejarCandidatos({
    listados: new Set([1]),
    completude: COMPLETA,
    posicoesLocais: [pos(5, 3, "2026-09-01T00:00:00Z")],
    estoqueLocal: [est("a", 5, 3), est("b", 7, 2), est("c", 1, 9), est("d", 8, 0)],
  });
  assertEquals(r.aConfirmar, [5, 7]);
  assertEquals(r.candidatos, 2);
});

Deno.test("candidatos — código AMBÍGUO no catálogo (2 ids distintos) não é candidato pelo estoque", () => {
  const r = planejarCandidatos({
    listados: new Set([1]),
    completude: COMPLETA,
    posicoesLocais: [],
    estoqueLocal: [est("a", 7, 2), est("b", 7, 2)],
  });
  assertEquals(r.aConfirmar, []);
});

Deno.test("candidatos — snapshot VAZIO não confirma nada (ausência de tudo não é zero de tudo)", () => {
  const r = planejarCandidatos({
    listados: new Set(),
    completude: COMPLETA,
    posicoesLocais: [pos(3, 2, null)],
    estoqueLocal: [],
  });
  assertEquals(r.aConfirmar, []);
  assertEquals(r.candidatos, 1);
  assertEquals(typeof r.pulado, "string");
});

Deno.test("candidatos — listagem INCOMPLETA não confirma nada e o motivo sai em `pulado`", () => {
  const r = planejarCandidatos({
    listados: new Set([1]),
    completude: { completa: false, motivo: "página 2 veio com 99 de 100 antes da última" },
    posicoesLocais: [pos(3, 2, null)],
    estoqueLocal: [],
  });
  assertEquals(r.aConfirmar, []);
  assertEquals(r.candidatos, 1);
  assertEquals(r.pulado !== null && r.pulado.includes("página 2"), true, String(r.pulado));
});

Deno.test("candidatos — no limite de anomalia confirma TODOS; um acima não confirma NADA", () => {
  const listados = new Set([1]); // 1 listado → anomalia 50
  const no = Array.from({ length: 50 }, (_, i) => pos(100 + i, 1, null));
  const r1 = planejarCandidatos({ listados, completude: COMPLETA, posicoesLocais: no, estoqueLocal: [] });
  assertEquals(r1.aConfirmar.length, 50);
  assertEquals(r1.candidatos, 50);
  assertEquals(r1.pulado, null);
  const acima = [...no, pos(999, 1, null)];
  const r2 = planejarCandidatos({ listados, completude: COMPLETA, posicoesLocais: acima, estoqueLocal: [] });
  assertEquals(r2.aConfirmar, []);
  assertEquals(r2.candidatos, 51);
  assertEquals(r2.pulado !== null && r2.pulado.includes("51"), true, String(r2.pulado));
});

// Sem teto por rodada (2026-10-05): com o zero CONFIRMADO, o teto não protege de zero falso (um
// positivo zerado por engano volta na listagem principal da rodada seguinte) e um teto "N mais
// velhos" deixaria os eternamente-desconhecidos (produto inativo/excluído: 57 entre as congeladas
// medidas) ocupando as vagas toda rodada — os candidatos novos nunca seriam confirmados.
Deno.test("candidatos — abaixo do limite de anomalia TODOS são confirmados: o congelado drena numa rodada", () => {
  const listados = new Set(Array.from({ length: 782 }, (_, i) => 10_000 + i)); // anomalia 196
  const congeladas = Array.from({ length: 84 }, (_, i) => pos(500 + i, 1, `2026-0${(i % 9) + 1}-01T00:00:00Z`));
  const r = planejarCandidatos({ listados, completude: COMPLETA, posicoesLocais: congeladas, estoqueLocal: [] });
  assertEquals(r.aConfirmar.length, 84);
  assertEquals(r.candidatos, 84);
  assertEquals(r.pulado, null);
});

// ════════ pedidos de confirmação ════════

Deno.test("pedidos — lotes de 50, modo S, lista_produtos e a MESMA data da listagem", () => {
  const cods = Array.from({ length: 120 }, (_, i) => 1 + i);
  const pedidos = montarPedidosConfirmacao(cods, "05/10/2026");
  assertEquals(pedidos.length, 3);
  assertEquals(CONFIRMACAO_POR_CHAMADA, 50);
  assertEquals(pedidos[0], {
    nPagina: 1,
    nRegPorPagina: 100,
    dDataPosicao: "05/10/2026",
    cExibeTodos: "S",
    lista_produtos: cods.slice(0, 50).map((c) => ({ nCodProd: c })),
  });
  assertEquals((pedidos[2].lista_produtos as unknown[]).length, 20);
});

Deno.test("pedidos — sem códigos, nenhuma chamada", () => {
  assertEquals(montarPedidosConfirmacao([], "05/10/2026"), []);
});

// ════════ interpretação da confirmação ════════

Deno.test("confirmação — saldo 0 EXPLÍCITO vira zero, com cmc e preço médio quando utilizáveis", () => {
  const { porCodigo } = interpretarConfirmacao([7], [{ nCodProd: 7, nSaldo: 0, nCMC: 796.21, nPrecoMedio: 800 }]);
  assertEquals(porCodigo.get(7), { tipo: "zero", cmc: 796.21, precoMedio: 800 });
});

Deno.test("confirmação — saldo positivo ou negativo é não-zero (nunca zera)", () => {
  const { porCodigo } = interpretarConfirmacao([1, 2], [{ nCodProd: 1, nSaldo: 3 }, { nCodProd: 2, nSaldo: -1 }]);
  assertEquals(porCodigo.get(1), { tipo: "nao_zero" });
  assertEquals(porCodigo.get(2), { tipo: "nao_zero" });
});

Deno.test("confirmação — código pedido AUSENTE da resposta é desconhecido", () => {
  const { porCodigo } = interpretarConfirmacao([1, 2], [{ nCodProd: 1, nSaldo: 0, nCMC: 5 }]);
  assertEquals(porCodigo.get(2)?.tipo, "desconhecido");
});

Deno.test("confirmação — saldo ausente, null ou vazio é desconhecido, nunca zero", () => {
  const { porCodigo } = interpretarConfirmacao([1, 2, 3], [
    { nCodProd: 1 },
    { nCodProd: 2, nSaldo: null },
    { nCodProd: 3, nSaldo: "" },
  ]);
  for (const c of [1, 2, 3]) assertEquals(porCodigo.get(c)?.tipo, "desconhecido", `código ${c}`);
});

Deno.test("confirmação — vários locais: todos 0 é zero; um ≠ 0 é não-zero; um sem saldo é desconhecido", () => {
  const { porCodigo } = interpretarConfirmacao([1, 2, 3], [
    { nCodProd: 1, nSaldo: 0, nCMC: 5 }, { nCodProd: 1, nSaldo: 0, nCMC: 5 },
    { nCodProd: 2, nSaldo: 0, nCMC: 5 }, { nCodProd: 2, nSaldo: 4, nCMC: 5 },
    { nCodProd: 3, nSaldo: 0, nCMC: 5 }, { nCodProd: 3, nCMC: 5 },
  ]);
  assertEquals(porCodigo.get(1)?.tipo, "zero");
  assertEquals(porCodigo.get(2)?.tipo, "nao_zero");
  assertEquals(porCodigo.get(3)?.tipo, "desconhecido");
});

Deno.test("confirmação — cmc 0, ausente, negativo ou divergente entre locais: zero com cmc null", () => {
  const { porCodigo } = interpretarConfirmacao([1, 2, 3, 4], [
    { nCodProd: 1, nSaldo: 0, nCMC: 0 },
    { nCodProd: 2, nSaldo: 0 },
    { nCodProd: 3, nSaldo: 0, nCMC: -4 },
    { nCodProd: 4, nSaldo: 0, nCMC: 5 }, { nCodProd: 4, nSaldo: 0, nCMC: 6 },
  ]);
  for (const c of [1, 2, 3, 4]) {
    const conf = porCodigo.get(c);
    assertEquals(conf?.tipo, "zero", `código ${c}`);
    if (conf?.tipo === "zero") assertEquals(conf.cmc, null, `cmc do código ${c}`);
  }
});

Deno.test("confirmação — item com código ILEGÍVEL na resposta: nenhum zero vale (pode ser o 2º local de um pedido)", () => {
  const { porCodigo } = interpretarConfirmacao([1, 2], [
    { nCodProd: 1, nSaldo: 0, nCMC: 5 },
    { nCodProd: "lixo", nSaldo: 9 },
    { nCodProd: 2, nSaldo: 3 },
  ]);
  assertEquals(porCodigo.get(1)?.tipo, "desconhecido");
  assertEquals(porCodigo.get(2)?.tipo, "nao_zero");
});

Deno.test("confirmação — código não pedido é contado como estranho e ignorado (filtro não honrado)", () => {
  const { porCodigo, estranhos } = interpretarConfirmacao([1], [
    { nCodProd: 1, nSaldo: 0, nCMC: 5 },
    { nCodProd: 99, nSaldo: 0, nCMC: 5 },
    { nCodProd: 98, nSaldo: 7 },
  ]);
  assertEquals(porCodigo.get(1)?.tipo, "zero");
  assertEquals(porCodigo.has(99), false);
  assertEquals(estranhos, 2);
});

// ════════ escrita das confirmações ════════

Deno.test("escrita — zero confirmado com cmc IGUAL ao local: saldo 0 e synced_at novo, cmc fora do SET", () => {
  const plano = planejarEscritaConfirmada({
    posicoesLocais: [pos(7, 2.43, "2026-08-27T11:15:33.796+00:00", 796.21, 800)],
    estoqueLocal: [],
    confirmacoes: new Map([[7, { tipo: "zero", cmc: 796.21, precoMedio: 800 } as const]]),
    nowIso: NOW,
  });
  assertEquals(plano.posicoes, [{
    account: "vendas",
    omie_codigo_produto: 7,
    casSyncedAt: "2026-08-27T11:15:33.796+00:00",
    set: { saldo: 0, synced_at: NOW },
  }]);
});

Deno.test("escrita — cmc confirmado DIFERENTE do local entra no SET (com o preço médio que mudou)", () => {
  const plano = planejarEscritaConfirmada({
    posicoesLocais: [pos(7, 2, "2026-08-01T00:00:00Z", 700, 800)],
    estoqueLocal: [],
    confirmacoes: new Map([[7, { tipo: "zero", cmc: 710, precoMedio: 805 } as const]]),
    nowIso: NOW,
  });
  assertEquals(plano.posicoes[0].set, { saldo: 0, cmc: 710, preco_medio: 805, synced_at: NOW });
});

Deno.test("escrita — sem cmc utilizável só o saldo muda: o synced_at (frescor do custo) é preservado", () => {
  const plano = planejarEscritaConfirmada({
    posicoesLocais: [pos(7, 2, "2026-08-01T00:00:00Z", 700, 800)],
    estoqueLocal: [],
    confirmacoes: new Map([[7, { tipo: "zero", cmc: null, precoMedio: 805 } as const]]),
    nowIso: NOW,
  });
  assertEquals(plano.posicoes[0].set, { saldo: 0 });
});

// O CAS é a VERSÃO da linha (synced_at), não o saldo: igualdade numérica via número JS recusaria para
// sempre um numeric com mais casas do que um double preserva (Codex P2 no adversarial).
Deno.test("escrita — o CAS é o synced_at LIDO (inclusive null) e o rótulo da conta; o saldo não entra", () => {
  const plano = planejarEscritaConfirmada({
    posicoesLocais: [pos(7, "11.720000000000000001", null)],
    estoqueLocal: [],
    confirmacoes: new Map([[7, { tipo: "zero", cmc: null, precoMedio: null } as const]]),
    nowIso: NOW,
  });
  assertEquals(plano.posicoes, [{ account: "vendas", omie_codigo_produto: 7, casSyncedAt: null, set: { saldo: 0 } }]);
});

Deno.test("escrita — não-zero, desconhecido ou sem confirmação: nenhuma escrita", () => {
  const plano = planejarEscritaConfirmada({
    posicoesLocais: [pos(1, 2, null), pos(2, 2, null), pos(3, 2, null)],
    estoqueLocal: [est("a", 1, 2), est("b", 2, 2), est("c", 3, 2)],
    confirmacoes: new Map([
      [1, { tipo: "nao_zero" } as const],
      [2, { tipo: "desconhecido", motivo: "ausente da resposta" } as const],
    ]),
    nowIso: NOW,
  });
  assertEquals(plano, { posicoes: [], estoque: [] });
});

Deno.test("escrita — catálogo: só linha resolvida sem ambiguidade e estoque lido ≠ 0, com CAS no valor lido", () => {
  const plano = planejarEscritaConfirmada({
    posicoesLocais: [],
    estoqueLocal: [est("a", 7, "2.43"), est("b", 8, 2), est("c", 8, 2), est("d", 9, 0)],
    confirmacoes: new Map([
      [7, { tipo: "zero", cmc: 5, precoMedio: 5 } as const],
      [8, { tipo: "zero", cmc: 5, precoMedio: 5 } as const],
      [9, { tipo: "zero", cmc: 5, precoMedio: 5 } as const],
    ]),
    nowIso: NOW,
  });
  assertEquals(plano.estoque, [{ id: "a", omie_codigo_produto: 7, casUpdatedAt: UPD, set: { estoque: 0 } }]);
});

// ════════ o contraexemplo do Codex, ponta a ponta na lógica pura ════════

Deno.test("paginação que DESLIZA: o positivo que sumiu vira candidato, a confirmação diz não-zero, nada é escrito", () => {
  // Produtos 1–180; a página 1 trouxe 1–100; o produto 1 esgotou e o 181 entrou antes da página 2,
  // que veio 102–181: o 101, POSITIVO, sumiu do retrato. Páginas [100, 80], nenhuma guarda dispara.
  const listados = new Set<number>([...Array.from({ length: 100 }, (_, i) => 1 + i), ...Array.from({ length: 80 }, (_, i) => 102 + i)]);
  const completude = avaliarCompletudeListagem([100, 80], 100);
  assertEquals(completude.completa, true);
  const posicoesLocais = [pos(101, 4, "2026-10-05T12:30:00Z")];
  const cand = planejarCandidatos({ listados, completude, posicoesLocais, estoqueLocal: [] });
  assertEquals(cand.aConfirmar, [101]);
  const { porCodigo } = interpretarConfirmacao(cand.aConfirmar, [{ nCodProd: 101, nSaldo: 4, nCMC: 9 }]);
  const plano = planejarEscritaConfirmada({ posicoesLocais, estoqueLocal: [], confirmacoes: porCodigo, nowIso: NOW });
  assertEquals(plano, { posicoes: [], estoque: [] });
});

// ════════ adversarial do Codex (2026-10-05) ════════

Deno.test("catálogo sem updated_at não tem versão para o CAS: fica de fora (nunca UPDATE cego)", () => {
  const plano = planejarEscritaConfirmada({
    posicoesLocais: [],
    estoqueLocal: [est("a", 7, 2, null)],
    confirmacoes: new Map([[7, { tipo: "zero", cmc: 5, precoMedio: 5 } as const]]),
    nowIso: NOW,
  });
  assertEquals(plano.estoque, []);
});

Deno.test("espelhos — vendas↔oben e colacor_vendas↔colacor são a mesma conta Omie; servicos não tem par", () => {
  assertEquals(espelhosDaMesmaConta("vendas"), ["vendas", "oben"]);
  assertEquals(espelhosDaMesmaConta("oben"), ["oben", "vendas"]);
  assertEquals(espelhosDaMesmaConta("colacor_vendas"), ["colacor_vendas", "colacor"]);
  assertEquals(espelhosDaMesmaConta("servicos"), ["servicos"]);
});

Deno.test("espelhos — o mesmo código congelado nos dois espelhos é UM candidato", () => {
  const r = planejarCandidatos({
    listados: new Set([1]),
    completude: COMPLETA,
    posicoesLocais: [pos(7, 2.43, "2026-08-27T00:00:00Z"), pos(7, 2.43, "2026-08-27T01:00:00Z", 10, 12, "oben")],
    estoqueLocal: [],
  });
  assertEquals([r.aConfirmar, r.candidatos], [[7], 1]);
});

// Sem isto o zero de um espelho fica escondido na eleição por synced_at do motor e do ATP enquanto o
// outro espelho, congelado e mais recente, não for corrigido (Codex P1 no adversarial).
Deno.test("espelhos — UMA confirmação zera os dois espelhos, cada um com o próprio CAS", () => {
  const plano = planejarEscritaConfirmada({
    posicoesLocais: [pos(7, 4, "2026-10-01T10:00:00Z"), pos(7, 4, "2026-10-05T12:30:00Z", 10, 12, "oben")],
    estoqueLocal: [],
    confirmacoes: new Map([[7, { tipo: "zero", cmc: null, precoMedio: null } as const]]),
    nowIso: NOW,
  });
  assertEquals(plano.posicoes, [
    { account: "vendas", omie_codigo_produto: 7, casSyncedAt: "2026-10-01T10:00:00Z", set: { saldo: 0 } },
    { account: "oben", omie_codigo_produto: 7, casSyncedAt: "2026-10-05T12:30:00Z", set: { saldo: 0 } },
  ]);
});

Deno.test("confirmação — código não-escalar (array, boolean, objeto) é ILEGÍVEL, não coage para código", () => {
  const a = interpretarConfirmacao([7], [{ nCodProd: 7, nSaldo: 0, nCMC: 5 }, { nCodProd: [999], nSaldo: 4 }]);
  assertEquals([a.porCodigo.get(7)?.tipo, a.estranhos], ["desconhecido", 0]);
  const b = interpretarConfirmacao([1], [{ nCodProd: true, nSaldo: 0 }]);
  assertEquals(b.porCodigo.get(1)?.tipo, "desconhecido");
  const c = interpretarConfirmacao([7], [{ nCodProd: [7], nSaldo: 0 }]);
  assertEquals(c.porCodigo.get(7)?.tipo, "desconhecido");
});

Deno.test("confirmação — código de LOTE incompleto (paginação não terminou) é desconhecido, mesmo com entradas 0", () => {
  const { porCodigo } = interpretarConfirmacao([34, 35], [{ nCodProd: 34, nSaldo: 0, nCMC: 5 }, { nCodProd: 35, nSaldo: 0, nCMC: 5 }], new Set([34]));
  assertEquals(porCodigo.get(34)?.tipo, "desconhecido");
  assertEquals(porCodigo.get(35)?.tipo, "zero");
});
