// Testa o CÓDIGO REAL de reconciliacao.ts no runtime real (Deno), com o banco numa tabela em memória.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-sync-nfes-recebidas/reconciliacao_test.ts
//
// O caso de prod (OBEN/Sayerlack, 2026-10-16): a NF 000936222 chegou em maio, antes da linha do pedido
// 1002 (contrato 2091397) existir no rastreio → virou órfã. A linha do pedido nasceu em 26/06 e ficou
// sem NF para sempre, porque nada revia a órfã. As falsificações que importam:
//   (a) a órfã cujo nNumPedCompra casa com o contrato de um pedido SEM NF vincula esse pedido;
//   (b) pedido que já tem OUTRA NF fica INTOCADO (precisão > recall) e é contado, não some;
//   (c) o fornecedor entra no casamento: o mesmo contrato de outro fornecedor não vincula;
//   (d) a escrita é compare-and-set: perder a corrida conta, não grava;
//   (e) raw_data cuja chave diverge da coluna é pulado (não carimba a NF errada);
//   (f) rodar de novo é no-op (idempotente).
import {
  extrairPedidosDoDetalhe,
  type LinhaPedido,
  type NFeParaVinculo,
  type OrfaParaReconciliar,
  type PortaReconciliacao,
  reconciliarOrfas,
} from "./reconciliacao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg ? `${msg}: ` : ""}esperado ${jb}, veio ${ja}`);
}

const SAYERLACK = 8689681266;
const OUTRO_FORN = 1111;
const CHAVE_A = "4".repeat(44);
const CHAVE_B = "5".repeat(44);

interface LinhaTabela extends LinhaPedido {
  contrato: string;
  fornecedor: number;
  nfe_numero?: string | null;
}

function rawOrfa(chave: string, pedidos: string[]): unknown {
  return {
    cabec: { cChaveNFe: chave, cNumeroNFe: "000936222" },
    itensRecebimento: pedidos.map((p) => ({ itensInfoAdic: { nNumPedCompra: p } })),
  };
}

// O mapeador real (mapNFe) vive no index.ts, que sobe o Deno.serve — aqui um equivalente mínimo.
function mapear(raw: unknown): NFeParaVinculo {
  const cab = (raw as { cabec?: { cChaveNFe?: string; cNumeroNFe?: string } }).cabec ?? {};
  return {
    chave: cab.cChaveNFe ?? null,
    numero: cab.cNumeroNFe ?? null,
    serie: "1",
    data_emissao_iso: "2026-05-12T00:00:00-03:00",
    data_recebimento_iso: null,
    recebida: false,
    status: "FATURADO",
    transp_cnpj: null,
    transp_nome: null,
    fornecedor_nome: null,
    fornecedor_cnpj: null,
  };
}

function bancoEmMemoria(orfas: OrfaParaReconciliar[], linhas: LinhaTabela[], opts: { roubarCas?: boolean } = {}) {
  const escritas: string[] = [];
  const porta: PortaReconciliacao = {
    listarOrfas: () => Promise.resolve(orfas),
    linhasDoPedido: (contrato, fornecedor) =>
      Promise.resolve(linhas.filter((l) => l.contrato === contrato && l.fornecedor === fornecedor).map((l) => ({ ...l }))),
    vincularSeSemNF: (id, patch) => {
      const l = linhas.find((x) => x.id === id)!;
      if (opts.roubarCas) l.nfe_chave_acesso = CHAVE_B; // outro writer vinculou entre a leitura e a escrita
      if (l.nfe_chave_acesso) return Promise.resolve(false);
      Object.assign(l, patch);
      escritas.push(id);
      return Promise.resolve(true);
    },
  };
  return { porta, escritas, linhas };
}

const opcoes = { agoraIso: () => "2026-10-16T12:00:00Z", temTempo: () => true };

Deno.test("extrai nNumPedCompra deduplicado, ignora vazio/0 e raw sem itens", () => {
  assertEquals(
    extrairPedidosDoDetalhe({
      itensRecebimento: [
        { itensInfoAdic: { nNumPedCompra: "2091397" } },
        { itensInfoAdic: { nNumPedCompra: 2091397 } },
        { itensInfoAdic: { nNumPedCompra: " 2093505 " } },
        { itensInfoAdic: { nNumPedCompra: "0" } },
        { itensInfoAdic: {} },
        {},
      ],
    }),
    ["2091397", "2093505"],
  );
  assertEquals(extrairPedidosDoDetalhe({ cabec: {} }), []);
  assertEquals(extrairPedidosDoDetalhe(null), []);
});

Deno.test("(a) órfã de maio vincula o pedido que nasceu depois, SEM NF", async () => {
  const db = bancoEmMemoria(
    [{ id: "orfa-1", fornecedor_codigo_omie: SAYERLACK, nfe_chave_acesso: CHAVE_A, raw_data: rawOrfa(CHAVE_A, ["2091397"]) }],
    [{ id: "ped-1002", contrato: "2091397", fornecedor: SAYERLACK, status: "CRIADO", nfe_chave_acesso: null, t2_data_faturamento: null }],
  );
  const r = await reconciliarOrfas(db.porta, mapear, opcoes);
  assertEquals(db.escritas, ["ped-1002"]);
  assertEquals(db.linhas[0].nfe_chave_acesso, CHAVE_A);
  assertEquals(db.linhas[0].nfe_numero, "000936222");
  assertEquals(db.linhas[0].status, "FATURADO");
  assertEquals(db.linhas[0].t2_data_faturamento, "2026-05-12T00:00:00-03:00");
  assertEquals([r.orfas_lidas, r.orfas_com_pedido, r.linhas_vinculadas], [1, 1, 1]);
});

Deno.test("(b) pedido com OUTRA NF fica intocado e é contado em conflito_outra_nf", async () => {
  const db = bancoEmMemoria(
    [{ id: "orfa-1", fornecedor_codigo_omie: SAYERLACK, nfe_chave_acesso: CHAVE_A, raw_data: rawOrfa(CHAVE_A, ["2091397"]) }],
    [{ id: "ped-1002", contrato: "2091397", fornecedor: SAYERLACK, status: "FATURADO", nfe_chave_acesso: CHAVE_B }],
  );
  const r = await reconciliarOrfas(db.porta, mapear, opcoes);
  assertEquals(db.escritas, []);
  assertEquals(db.linhas[0].nfe_chave_acesso, CHAVE_B);
  assertEquals([r.conflito_outra_nf, r.linhas_vinculadas, r.orfas_com_pedido], [1, 0, 1]);
});

Deno.test("(c) mesmo contrato de OUTRO fornecedor não vincula", async () => {
  const db = bancoEmMemoria(
    [{ id: "orfa-1", fornecedor_codigo_omie: SAYERLACK, nfe_chave_acesso: CHAVE_A, raw_data: rawOrfa(CHAVE_A, ["2091397"]) }],
    [{ id: "ped-x", contrato: "2091397", fornecedor: OUTRO_FORN, nfe_chave_acesso: null }],
  );
  const r = await reconciliarOrfas(db.porta, mapear, opcoes);
  assertEquals(db.escritas, []);
  assertEquals([r.orfas_com_pedido, r.linhas_vinculadas], [0, 0]);
});

Deno.test("(c2) órfã sem fornecedor é pulada, não casa só pelo contrato", async () => {
  const db = bancoEmMemoria(
    [{ id: "orfa-1", fornecedor_codigo_omie: null, nfe_chave_acesso: CHAVE_A, raw_data: rawOrfa(CHAVE_A, ["2091397"]) }],
    [{ id: "ped-1002", contrato: "2091397", fornecedor: SAYERLACK, nfe_chave_acesso: null }],
  );
  const r = await reconciliarOrfas(db.porta, mapear, opcoes);
  assertEquals(db.escritas, []);
  assertEquals(r.orfas_puladas, 1);
});

Deno.test("(d) compare-and-set: corrida perdida não grava e é contada", async () => {
  const db = bancoEmMemoria(
    [{ id: "orfa-1", fornecedor_codigo_omie: SAYERLACK, nfe_chave_acesso: CHAVE_A, raw_data: rawOrfa(CHAVE_A, ["2091397"]) }],
    [{ id: "ped-1002", contrato: "2091397", fornecedor: SAYERLACK, nfe_chave_acesso: null }],
    { roubarCas: true },
  );
  const r = await reconciliarOrfas(db.porta, mapear, opcoes);
  assertEquals(db.escritas, []);
  assertEquals(db.linhas[0].nfe_chave_acesso, CHAVE_B);
  assertEquals([r.corrida_perdida, r.linhas_vinculadas], [1, 0]);
});

Deno.test("(e) raw_data com chave ≠ coluna é pulado: não carimba a NF errada", async () => {
  const db = bancoEmMemoria(
    [{ id: "orfa-1", fornecedor_codigo_omie: SAYERLACK, nfe_chave_acesso: CHAVE_A, raw_data: rawOrfa(CHAVE_B, ["2091397"]) }],
    [{ id: "ped-1002", contrato: "2091397", fornecedor: SAYERLACK, nfe_chave_acesso: null }],
  );
  const r = await reconciliarOrfas(db.porta, mapear, opcoes);
  assertEquals(db.escritas, []);
  assertEquals(r.orfas_puladas, 1);
});

Deno.test("(f) segunda passada é no-op: a linha já tem ESTA NF", async () => {
  const db = bancoEmMemoria(
    [{ id: "orfa-1", fornecedor_codigo_omie: SAYERLACK, nfe_chave_acesso: CHAVE_A, raw_data: rawOrfa(CHAVE_A, ["2091397", "2092370"]) }],
    [
      { id: "ped-1002", contrato: "2091397", fornecedor: SAYERLACK, nfe_chave_acesso: null },
      { id: "ped-1007", contrato: "2092370", fornecedor: SAYERLACK, nfe_chave_acesso: null },
    ],
  );
  const r1 = await reconciliarOrfas(db.porta, mapear, opcoes);
  assertEquals([r1.linhas_vinculadas, r1.orfas_com_pedido], [2, 1]);
  const r2 = await reconciliarOrfas(db.porta, mapear, opcoes);
  assertEquals([r2.linhas_vinculadas, r2.ja_vinculadas], [0, 2]);
  assertEquals(db.escritas, ["ped-1002", "ped-1007"]);
});

Deno.test("sem tempo: para antes da 1ª órfã e marca interrompido (não um 0 que afirma 'medi')", async () => {
  const db = bancoEmMemoria(
    [{ id: "orfa-1", fornecedor_codigo_omie: SAYERLACK, nfe_chave_acesso: CHAVE_A, raw_data: rawOrfa(CHAVE_A, ["2091397"]) }],
    [{ id: "ped-1002", contrato: "2091397", fornecedor: SAYERLACK, nfe_chave_acesso: null }],
  );
  const r = await reconciliarOrfas(db.porta, mapear, { ...opcoes, temTempo: () => false });
  assertEquals(db.escritas, []);
  assertEquals([r.interrompido_por_timeout, r.orfas_lidas], [true, 0]);
});

Deno.test("duas órfãs no MESMO pedido: a 1ª da porta vence, a 2ª é conflito (nunca sobrescreve)", async () => {
  const db = bancoEmMemoria(
    [
      { id: "orfa-velha", fornecedor_codigo_omie: SAYERLACK, nfe_chave_acesso: CHAVE_A, raw_data: rawOrfa(CHAVE_A, ["2091397"]) },
      { id: "orfa-nova", fornecedor_codigo_omie: SAYERLACK, nfe_chave_acesso: CHAVE_B, raw_data: rawOrfa(CHAVE_B, ["2091397"]) },
    ],
    [{ id: "ped-1002", contrato: "2091397", fornecedor: SAYERLACK, nfe_chave_acesso: null }],
  );
  const r = await reconciliarOrfas(db.porta, mapear, opcoes);
  assertEquals(db.linhas[0].nfe_chave_acesso, CHAVE_A);
  assertEquals([r.linhas_vinculadas, r.conflito_outra_nf, r.orfas_com_pedido], [1, 1, 2]);
});
