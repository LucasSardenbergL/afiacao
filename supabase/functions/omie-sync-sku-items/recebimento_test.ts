// Testa o CÓDIGO REAL de recebimento.ts no runtime real (Deno), contra um banco FALSO que imita o
// contrato do PostgREST usado pela edge (upsert que só atualiza as colunas do payload; update com
// filtro que devolve as linhas atingidas).
// Roda com: deno test --no-remote supabase/functions/omie-sync-sku-items/recebimento_test.ts
//
// O defeito (P1 do Codex, pré-existente ao #2539; medido em 2026-10-05 — docs/historico/
// sku-items-pendencia-por-item.md): a fila era "tracking SEM NENHUMA linha em sku_leadtime_history".
// Bastava UMA linha gravada para o recebimento sair da fila para sempre — e o que faltava nunca
// voltava. Falha de upsert: 0 casos em 1.287 runs. O que de fato mordeu foi o ITEM SEM nIdProduto no
// momento da consulta (associação pendente na Omie): 2 SKUs em 63 recebimentos medidos, pulados em
// silêncio pelo `if (!skuCodigoOmie) continue;`.
//
// Fatos × reconstrução (achado do Codex no desenho): os VALORES dos fixtures (nIdProduto, quantidades,
// preços, datas, pedidos) são transcritos do payload gravado em prod. A FORMA da resposta no instante
// da 1ª consulta (o item ainda sem nIdProduto) é RECONSTRUÇÃO — compatível com o que se mediu (o run
// gravou menos itens do que o payload posterior tem; o produto PRD03703 só existe na Omie 3 dias
// depois), mas a resposta original não foi preservada.
import {
  classificarItem,
  donoDoRecebimento,
  type DepsGravacao,
  type EstadoControle,
  gravarRecebimento,
  type Irma,
  type LinhaLeadtime,
  type PedidoCasado,
  pendenteNaFila,
} from "./recebimento.ts";
import type { OmieRecebimentoItem } from "./consulta.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg ?? "diferente"}: esperado ${jb}, veio ${ja}`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── O banco falso ────────────────────────────────────────────────────────────────────────────────

interface LinhaControle {
  tentativas: number;
  ultima_tentativa: string;
  motivo: string;
  itens_pendentes: number | null;
}

class BancoFalso implements DepsGravacao {
  controle = new Map<string, LinhaControle>();
  linhas = new Map<string, LinhaLeadtime>();
  pedidos = new Map<string, PedidoCasado>();
  buscas: string[] = [];
  gravacoes: LinhaLeadtime[] = [];
  marcacoes = 0;
  fechamentos = 0;
  falharMarcacao = false;
  falharFechamento = false;
  falhaNaBusca: (numero: string) => string | null = () => null;
  falhaNaGravacao: (linha: LinhaLeadtime) => string | null = () => null;
  /** Gancho para intercalar OUTRO run no meio deste (a corrida do Codex). */
  aoGravar: (() => Promise<void>) | null = null;
  relogio = "2026-10-05T10:00:00.000Z";

  agora(): string {
    return this.relogio;
  }

  buscarPedido(_fornecedor: number | null, numero: string) {
    this.buscas.push(numero);
    const erro = this.falhaNaBusca(numero);
    if (erro) return Promise.resolve({ ok: false as const, erro });
    return Promise.resolve({ ok: true as const, pedido: this.pedidos.get(numero) ?? null });
  }

  async gravarLinha(linha: LinhaLeadtime): Promise<string | null> {
    if (this.aoGravar) {
      const gancho = this.aoGravar;
      this.aoGravar = null;
      await gancho();
    }
    const erro = this.falhaNaGravacao(linha);
    if (erro) return erro;
    this.gravacoes.push(linha);
    this.linhas.set(`${linha.tracking_id}::${linha.sku_codigo_omie}`, linha);
    return null;
  }

  /** Upsert do PostgREST: insere ou atualiza SÓ as colunas presentes no payload. */
  marcarControle(ids: readonly string[], estado: EstadoControle): Promise<boolean> {
    this.marcacoes++;
    if (this.falharMarcacao) return Promise.resolve(false);
    for (const id of ids) {
      const antes = this.controle.get(id);
      this.controle.set(id, {
        tentativas: estado.tentativas,
        ultima_tentativa: estado.ultima_tentativa,
        motivo: estado.motivo,
        itens_pendentes: estado.itens_pendentes !== undefined
          ? estado.itens_pendentes
          : (antes?.itens_pendentes ?? null),
      });
    }
    return Promise.resolve(true);
  }

  /** UPDATE … WHERE tracking_id IN ids AND ultima_tentativa = carimbo RETURNING tracking_id. */
  fecharControle(ids: readonly string[], carimbo: string, final: { itens_pendentes: number; motivo: string }) {
    this.fechamentos++;
    if (this.falharFechamento) return Promise.resolve({ ok: false as const, erro: "permission denied" });
    let atualizadas = 0;
    for (const id of ids) {
      const linha = this.controle.get(id);
      if (!linha || linha.ultima_tentativa !== carimbo) continue;
      linha.itens_pendentes = final.itens_pendentes;
      linha.motivo = final.motivo;
      atualizadas++;
    }
    return Promise.resolve({ ok: true as const, atualizadas });
  }

  temLinha(trackingId: string): boolean {
    for (const l of this.linhas.values()) if (l.tracking_id === trackingId) return true;
    return false;
  }
}

// ── Fixtures (valores transcritos de prod, 2026-10-05) ──────────────────────────────────────────

/** NF-e ÓRFÃ da EUROTECHNIKER (recebimento 12156129942), concluída em 2026-08-12. */
const EURO: Irma = {
  id: "2ddf3981-a3c7-44f7-b46e-8dbba9a27ad7",
  t1_data_pedido: "2026-08-10T03:00:00.000Z",
  t2_data_faturamento: "2026-08-10T03:00:00.000Z", // segunda-feira
  t3_data_cte: null,
  t4_data_recebimento: "2026-08-12T15:41:44.000Z", // quarta-feira
  fornecedor_codigo_omie: 8689689587,
  fornecedor_nome: "EUROTECHNIKER INDUSTRIA E COMERCIO LTDA",
};

function item(p: {
  nIdProduto?: number | string;
  codigo: string;
  qtd: number;
  preco: number;
  total: number;
  recebida: number;
  pedido?: string;
  ignorar?: "S" | "N";
  associar?: "S" | "N";
  novo?: "S" | "N";
}): OmieRecebimentoItem {
  return {
    itensCabec: {
      ...(p.nIdProduto !== undefined ? { nIdProduto: p.nIdProduto } : {}),
      cCodigoProduto: p.codigo,
      cIgnorarItem: p.ignorar ?? "N",
      cAssociarExistente: p.associar ?? "S",
      cAdicionarNovo: p.novo ?? "N",
      nQtdeNFe: p.qtd,
      nPrecoUnit: p.preco,
      vTotalItem: p.total,
    },
    itensInfoAdic: p.pedido !== undefined ? { nNumPedCompra: p.pedido } : {},
    itensAjustes: { nQtdeRecebida: p.recebida },
  };
}

const PRD02562 = item({ nIdProduto: 8689956424, codigo: "PRD02562", qtd: 1, preco: 977.07, total: 1008.82, recebida: 1 });
/** RECONSTRUÇÃO: o item do PRD03703 antes da criação do produto (cAdicionarNovo, sem nIdProduto). */
const PRD03703_SEM_ID = item({ codigo: "PRD03703", qtd: 250, preco: 1.08, total: 270, recebida: 250, associar: "N", novo: "S" });
const PRD03703 = item({ nIdProduto: 12163673823, codigo: "PRD03703", qtd: 250, preco: 1.08, total: 270, recebida: 250 });

function contexto(irmas: Irma[], tentativas = 1) {
  return { empresa: "OBEN", irmas, tentativas };
}

// ── Classificação do item ────────────────────────────────────────────────────────────────────────

Deno.test("classificarItem: nIdProduto válido é RESOLVIDO — mesmo marcado para ignorar (não deixa de gravar o que gravava)", () => {
  assertEquals(classificarItem(PRD02562), { tipo: "resolvido", sku: 8689956424, pedido: null });
  assertEquals(
    classificarItem(item({ nIdProduto: "8689733149", codigo: "PRD00041", qtd: 20, preco: 56.7, total: 1170.95, recebida: 20, pedido: "2127874", ignorar: "S" })),
    { tipo: "resolvido", sku: 8689733149, pedido: "2127874" },
  );
});

Deno.test("classificarItem: sem nIdProduto — cIgnorarItem='S' é IGNORADO (terminal); senão AGUARDA associação", () => {
  assertEquals(classificarItem(PRD03703_SEM_ID), { tipo: "aguardando_associacao" });
  assertEquals(classificarItem(item({ codigo: "X", qtd: 1, preco: 1, total: 1, recebida: 1, ignorar: "S", associar: "N" })), { tipo: "ignorado" });
  // nIdProduto 0 / vazio = ausente (a mesma regra de hoje: `toNum` falso não é produto)
  assertEquals(classificarItem(item({ nIdProduto: 0, codigo: "X", qtd: 1, preco: 1, total: 1, recebida: 1 })), { tipo: "aguardando_associacao" });
  assertEquals(classificarItem(item({ nIdProduto: "", codigo: "X", qtd: 1, preco: 1, total: 1, recebida: 1 })), { tipo: "aguardando_associacao" });
  assertEquals(classificarItem({}), { tipo: "aguardando_associacao" });
});

Deno.test("classificarItem: nNumPedCompra '0' ou vazio não é pedido", () => {
  assertEquals(classificarItem(item({ nIdProduto: 5, codigo: "X", qtd: 1, preco: 1, total: 1, recebida: 1, pedido: "0" })), { tipo: "resolvido", sku: 5, pedido: null });
  assertEquals(classificarItem(item({ nIdProduto: 5, codigo: "X", qtd: 1, preco: 1, total: 1, recebida: 1, pedido: "" })), { tipo: "resolvido", sku: 5, pedido: null });
});

// ── A fila ───────────────────────────────────────────────────────────────────────────────────────

Deno.test("pendenteNaFila: legado (k nulo/sem controle) segue a regra antiga; medido decide SÓ por k", () => {
  // legado: nunca medido pela edge nova — sem linha ⇒ pendente; com linha ⇒ fora (sem rajada de reconsulta)
  assertEquals(pendenteNaFila(undefined, false), true);
  assertEquals(pendenteNaFila(undefined, true), false);
  assertEquals(pendenteNaFila({ tentativas: 2, ultima_tentativa: "2026-09-01T00:00:00Z", itens_pendentes: null }, true), false);
  // medido com pendência: volta à fila MESMO com linha gravada (o defeito)
  assertEquals(pendenteNaFila({ tentativas: 1, ultima_tentativa: "2026-09-01T00:00:00Z", itens_pendentes: 1 }, true), true);
  // medido completo: fora da fila MESMO sem linha (irmã a quem nenhum item foi roteado; todos ignorados)
  assertEquals(pendenteNaFila({ tentativas: 1, ultima_tentativa: "2026-09-01T00:00:00Z", itens_pendentes: 0 }, false), false);
});

Deno.test("donoDoRecebimento: menor t2, desempate por id, t2 nulo por último — independe da ordem de entrada", () => {
  const a: Irma = { ...EURO, id: "bbbb", t2_data_faturamento: "2026-09-04T03:00:00.000Z" };
  const b: Irma = { ...EURO, id: "aaaa", t2_data_faturamento: "2026-09-17T03:00:00.000Z" };
  const c: Irma = { ...EURO, id: "0000", t2_data_faturamento: null };
  const d: Irma = { ...EURO, id: "aaab", t2_data_faturamento: "2026-09-04T03:00:00.000Z" };
  assertEquals(donoDoRecebimento([a, b, c, d]).id, "aaab");
  assertEquals(donoDoRecebimento([c, d, b, a]).id, "aaab");
  assertEquals(donoDoRecebimento([c]).id, "0000");
});

// ── O resíduo medido ─────────────────────────────────────────────────────────────────────────────

Deno.test("RESÍDUO EUROTECHNIKER: item sem nIdProduto deixa o recebimento PENDENTE — e a reconsulta, já associado, o completa", async () => {
  const banco = new BancoFalso();
  // 1ª consulta (08-10, RECONSTRUÍDA): o PRD03703 ainda sem produto.
  const d1 = await gravarRecebimento(banco, contexto([EURO]), { itensRecebimento: [PRD03703_SEM_ID, PRD02562] });
  assertEquals([...banco.linhas.keys()], [`${EURO.id}::8689956424`], "grava o que já está resolvido");
  assertEquals(d1.itensPendentes, 1, "o item aguardando associação é pendência");
  assertEquals(banco.controle.get(EURO.id)?.itens_pendentes, 1, "a pendência é persistida no controle");
  assert(banco.controle.get(EURO.id)?.motivo.startsWith("pendente:"), "o motivo diz que falta item");
  // O DEFEITO: com uma linha gravada, a regra antiga tirava o tracking da fila para sempre.
  assertEquals(pendenteNaFila(banco.controle.get(EURO.id), banco.temLinha(EURO.id)), true, "segue na fila");

  // 2ª consulta (depois da conclusão): o produto existe.
  banco.relogio = "2026-10-05T16:00:00.000Z";
  const d2 = await gravarRecebimento(banco, contexto([EURO], 2), { itensRecebimento: [PRD03703, PRD02562] });
  assertEquals([...banco.linhas.keys()].sort(), [`${EURO.id}::12163673823`, `${EURO.id}::8689956424`]);
  assertEquals(d2.itensPendentes, 0);
  assertEquals(banco.controle.get(EURO.id)?.itens_pendentes, 0);
  assertEquals(banco.controle.get(EURO.id)?.motivo, "ok_com_itens");
  assertEquals(pendenteNaFila(banco.controle.get(EURO.id), banco.temLinha(EURO.id)), false, "completo sai da fila");
});

// ── Write-ahead e fechamento ─────────────────────────────────────────────────────────────────────

Deno.test("write-ahead: se a pendência não persiste ANTES dos upserts, nenhuma linha é gravada", async () => {
  const banco = new BancoFalso();
  banco.falharMarcacao = true;
  const d = await gravarRecebimento(banco, contexto([EURO]), { itensRecebimento: [PRD03703, PRD02562] });
  assertEquals(banco.gravacoes.length, 0, "sem controle não se grava dado (a pendência não teria onde morar)");
  assertEquals(d.controle, "falhou");
});

Deno.test("fechamento falho DEPOIS de gravar: a pendência conservadora fica e o recebimento volta à fila", async () => {
  const banco = new BancoFalso();
  banco.falharFechamento = true;
  const d = await gravarRecebimento(banco, contexto([EURO]), { itensRecebimento: [PRD03703, PRD02562] });
  assertEquals(banco.gravacoes.length, 2, "os dados foram gravados");
  assertEquals(d.fechamento, "falhou");
  // Sem o write-ahead o controle ficaria sem medida (legado) e a linha gravada tiraria o tracking da fila.
  assertEquals(banco.controle.get(EURO.id)?.itens_pendentes, 2, "k conservador = todos os itens a gravar");
  assertEquals(pendenteNaFila(banco.controle.get(EURO.id), banco.temLinha(EURO.id)), true);
});

Deno.test("CAS: resposta ANTIGA que termina por último não sobrescreve o estado de uma consulta mais nova", async () => {
  const banco = new BancoFalso();
  // Enquanto o run A grava, o run B consulta o mesmo recebimento, vê um item pendente e marca o controle.
  banco.aoGravar = async () => {
    await banco.marcarControle([EURO.id], {
      tentativas: 2,
      ultima_tentativa: "2026-10-05T10:00:30.000Z",
      motivo: "pendente: run B",
      itens_pendentes: 1,
    });
  };
  const d = await gravarRecebimento(banco, contexto([EURO]), { itensRecebimento: [PRD03703, PRD02562] });
  assertEquals(d.fechamento, "preterido", "o fechamento de A não achou o próprio carimbo");
  assertEquals(banco.controle.get(EURO.id)?.itens_pendentes, 1, "vale o estado de B");
  assertEquals(banco.controle.get(EURO.id)?.motivo, "pendente: run B");
});

// ── Rota do pedido ───────────────────────────────────────────────────────────────────────────────

const PEDIDO_P: PedidoCasado = {
  id: "pedido-p",
  t1_data_pedido: "2026-08-03T03:00:00.000Z", // segunda-feira
  grupo_leadtime: "TINTAS",
  fornecedor_nome: "EUROTECHNIKER INDUSTRIA E COMERCIO LTDA",
};

Deno.test("lookup que FALHA num SKU repetido não sobrescreve o total gravado com um subtotal", async () => {
  const banco = new BancoFalso();
  banco.pedidos.set("K1", PEDIDO_P);
  const total: LinhaLeadtime = {
    tracking_id: "pedido-p",
    empresa: "OBEN",
    sku_codigo_omie: 777,
    sku_codigo: "PRD00777",
    sku_descricao: null,
    sku_unidade: null,
    sku_ncm: null,
    fornecedor_codigo_omie: EURO.fornecedor_codigo_omie,
    fornecedor_nome: EURO.fornecedor_nome,
    grupo_leadtime: "TINTAS",
    quantidade_pedida: 10,
    quantidade_recebida: 10,
    valor_unitario: 5,
    valor_total: 50,
    t1_data_pedido: PEDIDO_P.t1_data_pedido,
    t2_data_faturamento: EURO.t2_data_faturamento!,
    t3_data_cte: null,
    t4_data_recebimento: EURO.t4_data_recebimento,
    lt_bruto_dias_uteis: 7,
    lt_faturamento_dias_uteis: 5,
    lt_logistica_dias_uteis: 2,
    updated_at: "2026-09-01T00:00:00.000Z",
  };
  banco.linhas.set("pedido-p::777", total);
  banco.falhaNaBusca = (n) => (n === "K2" ? "canceling statement due to statement timeout" : null);
  const d = await gravarRecebimento(banco, contexto([EURO]), {
    itensRecebimento: [
      item({ nIdProduto: 777, codigo: "PRD00777", qtd: 4, preco: 5, total: 20, recebida: 4, pedido: "K1" }),
      item({ nIdProduto: 777, codigo: "PRD00777", qtd: 6, preco: 5, total: 30, recebida: 6, pedido: "K2" }),
    ],
  });
  assertEquals(banco.gravacoes.filter((l) => l.sku_codigo_omie === 777).length, 0, "nenhum grupo do SKU contaminado é gravado");
  assertEquals(banco.linhas.get("pedido-p::777")?.quantidade_recebida, 10, "o total de antes fica intacto");
  assertEquals(d.itensPendentes, 2, "os dois itens do SKU ficam pendentes");
  assertEquals(d.itensSemRota, 1);
});

Deno.test("lookup: a mesma chave de pedido é buscada UMA vez por recebimento", async () => {
  const banco = new BancoFalso();
  banco.pedidos.set("K1", PEDIDO_P);
  await gravarRecebimento(banco, contexto([EURO]), {
    itensRecebimento: [
      item({ nIdProduto: 1, codigo: "A", qtd: 1, preco: 1, total: 1, recebida: 1, pedido: "K1" }),
      item({ nIdProduto: 2, codigo: "B", qtd: 1, preco: 1, total: 1, recebida: 1, pedido: "K1" }),
    ],
  });
  assertEquals(banco.buscas, ["K1"]);
});

// ── Proveniência do t1 (achado do Codex: a reconsulta republicava o leadtime fabricado) ──────────

Deno.test("proveniência: item no FALLBACK grava lt_bruto/lt_faturamento NULOS; item de pedido grava os três", async () => {
  const banco = new BancoFalso();
  banco.pedidos.set("K1", PEDIDO_P);
  await gravarRecebimento(banco, contexto([EURO]), {
    itensRecebimento: [
      PRD02562, // sem pedido ⇒ cai no dono, com t1 = t2 do dono (fabricado)
      item({ nIdProduto: 3, codigo: "C", qtd: 1, preco: 1, total: 1, recebida: 1, pedido: "K1" }),
    ],
  });
  const fallback = banco.linhas.get(`${EURO.id}::8689956424`);
  assertEquals(
    [fallback?.lt_bruto_dias_uteis, fallback?.lt_faturamento_dias_uteis, fallback?.lt_logistica_dias_uteis],
    [null, null, 2],
    "t1 do fallback não é data de pedido: só a logística (t2→t4, seg→qua) é verdade",
  );
  const doPedido = banco.linhas.get("pedido-p::3");
  assertEquals(
    [doPedido?.lt_bruto_dias_uteis, doPedido?.lt_faturamento_dias_uteis, doPedido?.lt_logistica_dias_uteis],
    [7, 5, 2],
    "pedido 03/08 (seg) → faturamento 10/08 (seg) = 5 d.u.; → recebimento 12/08 (qua) = 7 d.u.",
  );
});

// ── Resposta sem lista ───────────────────────────────────────────────────────────────────────────

Deno.test("sem lista (fault / chave ausente / lista vazia): marca a tentativa SEM tocar a pendência medida", async () => {
  for (const resposta of [{ faultstring: "Recebimento não encontrado" }, {}, { itensRecebimento: [] }]) {
    const banco = new BancoFalso();
    banco.controle.set(EURO.id, { tentativas: 1, ultima_tentativa: "2026-10-04T10:00:00.000Z", motivo: "pendente: x", itens_pendentes: 2 });
    const d = await gravarRecebimento(banco, contexto([EURO], 2), resposta);
    assertEquals(d.itensPendentes, null, `não mediu (${JSON.stringify(resposta)})`);
    assertEquals(banco.controle.get(EURO.id)?.itens_pendentes, 2, "ausência de evidência não resolve pendência");
    assertEquals(banco.controle.get(EURO.id)?.tentativas, 2, "a tentativa foi marcada");
    assertEquals(banco.gravacoes.length, 0);
  }
});

// ── O recebimento é a unidade (achado do Codex: estado por irmã) ─────────────────────────────────

const IRMA_A: Irma = { ...EURO, id: "aaaa-irma-a", t2_data_faturamento: "2026-09-04T03:00:00.000Z" };
const IRMA_B: Irma = { ...EURO, id: "bbbb-irma-b", t2_data_faturamento: "2026-09-17T03:00:00.000Z" };

Deno.test("replicação: o estado do recebimento vai para TODAS as irmãs — a dona que sai da janela não leva a pendência", async () => {
  const banco = new BancoFalso();
  await gravarRecebimento(banco, contexto([IRMA_A, IRMA_B]), { itensRecebimento: [PRD03703_SEM_ID, PRD02562] });
  assertEquals(banco.controle.get(IRMA_A.id)?.itens_pendentes, 1);
  assertEquals(banco.controle.get(IRMA_B.id)?.itens_pendentes, 1);
  assertEquals(banco.controle.get(IRMA_B.id)?.ultima_tentativa, banco.controle.get(IRMA_A.id)?.ultima_tentativa, "mesmo carimbo: mesmo backoff");
  // A (t2 04/09) saiu da janela de 30 dias; B (17/09), sem linha própria, segue carregando a pendência.
  assertEquals(pendenteNaFila(banco.controle.get(IRMA_B.id), banco.temLinha(IRMA_B.id)), true);
});

Deno.test("dono estável: o fallback cai na MESMA irmã qualquer que seja a ordem — a reconsulta não cria chave nova", async () => {
  const banco = new BancoFalso();
  await gravarRecebimento(banco, contexto([IRMA_B, IRMA_A]), { itensRecebimento: [PRD02562] });
  await gravarRecebimento(banco, contexto([IRMA_A, IRMA_B], 2), { itensRecebimento: [PRD02562] });
  assertEquals([...banco.linhas.keys()], [`${IRMA_A.id}::8689956424`], "uma chave só, na irmã de menor t2");
  assertEquals(banco.linhas.get(`${IRMA_A.id}::8689956424`)?.t2_data_faturamento, IRMA_A.t2_data_faturamento, "datas do dono");
});

// ── Unidade e casos de borda ─────────────────────────────────────────────────────────────────────

Deno.test("unidade: grupo com upsert falho conta seus ITENS, não 1", async () => {
  const banco = new BancoFalso();
  banco.falhaNaGravacao = () => "new row violates check constraint";
  const d = await gravarRecebimento(banco, contexto([EURO]), {
    itensRecebimento: [
      item({ nIdProduto: 9, codigo: "R", qtd: 1, preco: 2, total: 2, recebida: 1 }),
      item({ nIdProduto: 9, codigo: "R", qtd: 3, preco: 2, total: 6, recebida: 3 }),
    ],
  });
  assertEquals(d.itensPendentes, 2);
  assertEquals(banco.controle.get(EURO.id)?.itens_pendentes, 2);
});

Deno.test("todos os itens ignorados: recebimento completo SEM linha (k=0) — e sai da fila", async () => {
  const banco = new BancoFalso();
  const d = await gravarRecebimento(banco, contexto([EURO]), {
    itensRecebimento: [item({ codigo: "FRETE", qtd: 1, preco: 1, total: 1, recebida: 1, ignorar: "S", associar: "N" })],
  });
  assertEquals(d.itensPendentes, 0);
  assertEquals(banco.gravacoes.length, 0);
  assertEquals(pendenteNaFila(banco.controle.get(EURO.id), banco.temLinha(EURO.id)), false, "não vira poison eterno");
});

Deno.test("sem grupo a gravar: UMA marcação, sem fechamento", async () => {
  const banco = new BancoFalso();
  const d = await gravarRecebimento(banco, contexto([EURO]), { itensRecebimento: [PRD03703_SEM_ID] });
  assertEquals([banco.marcacoes, banco.fechamentos], [1, 0]);
  assertEquals(d.fechamento, "nao_se_aplica");
  assertEquals(banco.controle.get(EURO.id)?.itens_pendentes, 1);
});
