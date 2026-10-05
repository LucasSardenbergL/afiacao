// Testa o LAÇO REAL do cron (rodada.ts) no runtime real (Deno), com o Omie e o banco falsos.
// Roda com: deno test supabase/functions/omie-nfe-recebimento-sync/rodada_test.ts
//
// O incidente (2026-10-01): a Oben teve 70 recebimentos no Omie desde 14/08 e a sync importou zero —
// a NF-e já recebida direto no Omie, no topo da listagem, gastava a única consulta de toda rodada.
// Os demais casos são os que a revisão do Codex de 2026-10-05 reproduziu contra o laço: chave
// ausente na listagem, cancelada no detalhe, duplicata só pela chave, HTTP 500 de lista vazia.
import type { CabecalhoRecebimentoRow } from "./cabecalho.ts";
import type { OmieRecebimentoItem } from "./itens.ts";
import type { RegistroListagem } from "./listagem.ts";
import { type DepsRodada, MAX_PAGINAS_POR_RODADA, rodadaDaConta } from "./rodada.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const DT_DE = "05/09/2026";
const WH = "wh-ob";
/** Chave de 44 dígitos que termina no id — uma por NF-e do teste. */
const chave = (id: number) => `3126091234567800019055001000012345${String(id).padStart(10, "0")}`;
const SEM_REGISTROS = { faultstring: "ERROR: Não existem registros para a página [1]!", faultcode: "SOAP-ENV:Client-5113" };
const ITENS = [{}, {}] as unknown as OmieRecebimentoItem[];

function reg(id: number, info?: { cRecebido?: string; cCancelada?: string }, ch: string | null = chave(id)): RegistroListagem {
  return { cabec: { nIdReceb: id, cChaveNFe: ch }, ...(info ? { infoCadastro: info } : {}) };
}
const PENDENTE = { cRecebido: "N", cCancelada: "N" };
const pagina = (recebimentos: RegistroListagem[], nTotalPaginas = 1) => ({ nTotalPaginas, recebimentos });
function detalhe(id: number, info: Record<string, string> = PENDENTE, ch: string | null = chave(id)) {
  return {
    cabec: { cNumeroNFe: String(id), cChaveNFe: ch, cCNPJ_CPF: "12.345.678/0001-90", dEmissaoNFe: "01/10/2026", nValorNFe: 100 },
    infoCadastro: info,
    itensRecebimento: ITENS,
  };
}

interface Cenario {
  paginas?: unknown[];
  listarLanca?: boolean;
  detalhes?: Record<number, unknown>;
  consultarLanca?: boolean;
  ids?: number[];
  chaves?: string[];
  jaLanca?: boolean;
  erroCabecalho?: string;
  erroItens?: string;
}

function falsos(c: Cenario) {
  const chamadas = {
    listar: [] as Record<string, unknown>[],
    consultar: [] as number[],
    ja: 0,
    cabecalhos: [] as CabecalhoRecebimentoRow[],
    itens: [] as string[],
  };
  const deps: DepsRodada = {
    listar: (params) => {
      chamadas.listar.push(params);
      if (c.listarLanca) return Promise.reject(new Error("rede caiu"));
      return Promise.resolve(c.paginas?.[Number(params.nPagina) - 1] ?? SEM_REGISTROS);
    },
    consultar: (id) => {
      chamadas.consultar.push(id);
      if (c.consultarLanca) return Promise.reject(new Error("timeout"));
      return Promise.resolve(c.detalhes?.[id] ?? { faultstring: "Recebimento não encontrado" });
    },
    jaImportados: (ids, chaves) => {
      chamadas.ja++;
      if (c.jaLanca) return Promise.reject(new Error("PostgREST 503"));
      return Promise.resolve({
        ids: new Set((c.ids ?? []).filter((i) => ids.includes(i))),
        chaves: new Set((c.chaves ?? []).filter((k) => chaves.includes(k))),
      });
    },
    inserirCabecalho: (row) => {
      chamadas.cabecalhos.push(row);
      return Promise.resolve(c.erroCabecalho ? { erro: c.erroCabecalho } : { id: `nfe-${row.omie_id_receb}` });
    },
    inserirItens: (_itens, id) => {
      chamadas.itens.push(id);
      return Promise.resolve(c.erroItens ?? null);
    },
  };
  return { deps, chamadas };
}

const rodar = (c: Cenario) => {
  const f = falsos(c);
  return rodadaDaConta(f.deps, "OB", WH, DT_DE).then((r) => ({ ...r, chamadas: f.chamadas }));
};

Deno.test("o incidente: recebida, cancelada e incompleta no topo não gastam a consulta — a pendente de trás é importada", async () => {
  const r = await rodar({
    paginas: [pagina([reg(101, { cRecebido: "S" }), reg(102, { cCancelada: "S" }), reg(103, PENDENTE, null), reg(104, PENDENTE)])],
    detalhes: { 104: detalhe(104) },
  });
  assertEquals(r.chamadas.consultar, [104]);
  assertEquals(r.chamadas.cabecalhos.map((c) => [c.omie_id_receb, c.chave_acesso, c.status, c.warehouse_id]), [[104, chave(104), "pendente", WH]]);
  assertEquals(r.chamadas.itens, ["nfe-104"]);
  assertEquals([r.importadas, r.puladas, r.erros], [1, 1, []]);
  const s = r.resumo;
  assertEquals(
    [s.listados, s.recebidos_no_omie, s.cancelados, s.sem_chave_na_listagem, s.aguardando, s.consultados, s.importados],
    [4, 1, 1, 1, 1, 1, 1],
  );
  assertEquals(s.consulta, { nIdReceb: 104, desfecho: "importada" });
  assertEquals([s.janela_de, s.paginas_lidas, s.paginacao], [DT_DE, 1, "completa"]);
});

Deno.test("a listagem pede os detalhes, com a janela da rodada, em toda página", async () => {
  const r = await rodar({ paginas: [pagina([reg(1, PENDENTE)], 2), pagina([reg(2, PENDENTE)], 2)], detalhes: { 1: detalhe(1) } });
  assertEquals(r.chamadas.listar.map((p) => [p.nPagina, p.cExibirDetalhes, p.dtEmissaoDe]), [[1, "S", DT_DE], [2, "S", DT_DE]]);
});

Deno.test("pulos não gastam a consulta: já importadas pelo id e pela chave, e a consulta vai à pendente", async () => {
  const r = await rodar({
    paginas: [pagina([reg(201, PENDENTE), reg(202, PENDENTE), reg(203, PENDENTE), reg(204, PENDENTE)])],
    ids: [201, 202],
    chaves: [chave(203)],
    detalhes: { 204: detalhe(204) },
  });
  assertEquals(r.chamadas.consultar, [204]);
  assertEquals([r.importadas, r.puladas, r.resumo.ja_importados], [1, 3, 3]);
});

Deno.test("a completa vem antes da incompleta; a incompleta sozinha ainda é consultada", async () => {
  const antes = await rodar({ paginas: [pagina([reg(301), reg(302, PENDENTE)])], detalhes: { 302: detalhe(302) } });
  assertEquals(antes.chamadas.consultar, [302]);
  assertEquals([antes.resumo.listagem_magra, antes.resumo.aguardando], [1, 1]);

  const sozinha = await rodar({ paginas: [pagina([reg(401)])], detalhes: { 401: detalhe(401) } });
  assertEquals(sozinha.chamadas.consultar, [401]);
  assertEquals(sozinha.resumo.consulta, { nIdReceb: 401, desfecho: "importada" });
});

Deno.test("chave ausente na listagem com infoCadastro não descarta: o detalhe traz a chave e a NF-e é importada", async () => {
  const r = await rodar({ paginas: [pagina([reg(501, PENDENTE, null)])], detalhes: { 501: detalhe(501) } });
  assertEquals([r.importadas, r.resumo.sem_chave_na_listagem], [1, 1]);
});

Deno.test("incompleta + detalhe cancelado ou recebido (com caixa/espaço): nada é gravado", async () => {
  const cancelada = await rodar({ paginas: [pagina([reg(601)])], detalhes: { 601: detalhe(601, { cCancelada: "S", cRecebido: "N" }) } });
  assertEquals([cancelada.resumo.consulta, cancelada.chamadas.cabecalhos.length, cancelada.importadas], [{ nIdReceb: 601, desfecho: "cancelado" }, 0, 0]);

  const recebida = await rodar({ paginas: [pagina([reg(602)])], detalhes: { 602: detalhe(602, { cRecebido: " s " }) } });
  assertEquals([recebida.resumo.consulta, recebida.chamadas.cabecalhos.length, recebida.puladas], [{ nIdReceb: 602, desfecho: "recebido_no_omie" }, 0, 1]);
});

Deno.test("duplicata só pela chave, descoberta no detalhe: não grava de novo", async () => {
  const r = await rodar({ paginas: [pagina([reg(701, undefined, null)])], detalhes: { 701: detalhe(701) }, chaves: [chave(701)] });
  assertEquals([r.resumo.consulta, r.chamadas.cabecalhos.length, r.puladas], [{ nIdReceb: 701, desfecho: "duplicada_por_chave" }, 0, 1]);
});

Deno.test("detalhe sem chave: desfecho sem_chave, nada gravado", async () => {
  const r = await rodar({ paginas: [pagina([reg(702)])], detalhes: { 702: detalhe(702, PENDENTE, null) } });
  assertEquals([r.resumo.consulta, r.chamadas.cabecalhos.length], [{ nIdReceb: 702, desfecho: "sem_chave" }, 0]);
});

Deno.test("lista vazia (o HTTP 500 'não existem registros' do CC) não é erro nem gasta nada", async () => {
  const r = await rodar({ paginas: [SEM_REGISTROS] });
  assertEquals([r.erros, r.resumo.listados, r.resumo.paginacao, r.chamadas.ja, r.chamadas.consultar], [[], 0, "completa", 0, []]);
});

Deno.test("falha da listagem (faultstring ou transporte) vai a erros e não gasta a consulta", async () => {
  const fault = await rodar({ paginas: [{ faultstring: "Consumo redundante detectado. Aguarde 30 segundos (REDUNDANT)" }] });
  assertEquals([fault.erros.length, fault.erros[0].startsWith("OB ListarRecebimentos página 1:"), fault.resumo.paginacao, fault.chamadas.consultar], [1, true, "interrompida_por_erro", []]);

  const rede = await rodar({ listarLanca: true });
  assertEquals([rede.erros.length, rede.resumo.paginacao, rede.chamadas.consultar], [1, "interrompida_por_erro", []]);
});

Deno.test("falha da consulta (faultstring no corpo ou transporte) vai a erros e nada é gravado", async () => {
  const fault = await rodar({ paginas: [pagina([reg(801, PENDENTE)])], detalhes: { 801: { faultstring: "Recebimento não encontrado" } } });
  assertEquals([fault.erros, fault.resumo.consulta, fault.chamadas.cabecalhos.length], [["OB ConsultarRecebimento 801: Recebimento não encontrado"], { nIdReceb: 801, desfecho: "falha_omie" }, 0]);

  const rede = await rodar({ paginas: [pagina([reg(802, PENDENTE)])], consultarLanca: true });
  assertEquals([rede.erros.length, rede.resumo.consulta], [1, { nIdReceb: 802, desfecho: "falha_omie" }]);
});

Deno.test("itens que falham: erro em errors[], cabeçalho mantido, NÃO conta como importada", async () => {
  const r = await rodar({ paginas: [pagina([reg(901, PENDENTE)])], detalhes: { 901: detalhe(901) }, erroItens: "value too long for type character varying(8)" });
  assertEquals([r.importadas, r.resumo.importados, r.chamadas.cabecalhos.length, r.resumo.consulta], [0, 0, 1, { nIdReceb: 901, desfecho: "itens_falharam" }]);
  assertEquals(r.erros, ["NF-e 901: cabeçalho gravado SEM itens — value too long for type character varying(8)"]);
});

Deno.test("cabeçalho que falha: erro, sem tentar os itens", async () => {
  const r = await rodar({ paginas: [pagina([reg(902, PENDENTE)])], detalhes: { 902: detalhe(902) }, erroCabecalho: "duplicate key value" });
  assertEquals([r.importadas, r.chamadas.itens, r.erros, r.resumo.consulta], [0, [], ["NF-e 902: duplicate key value"], { nIdReceb: 902, desfecho: "falha_banco" }]);
});

Deno.test("sem conseguir ler o que já está no banco, nenhuma consulta é gasta", async () => {
  const r = await rodar({ paginas: [pagina([reg(1001, PENDENTE)])], jaLanca: true, detalhes: { 1001: detalhe(1001) } });
  assertEquals([r.erros.length, r.chamadas.consultar, r.resumo.consulta], [1, [], null]);
});

Deno.test("teto de leitura: páginas cheias além do teto ficam marcadas como truncadas", async () => {
  const cheia = (p: number) => pagina(Array.from({ length: 50 }, (_, i) => reg(p * 1000 + i, PENDENTE)), 5);
  const r = await rodar({ paginas: [cheia(1), cheia(2), cheia(3), cheia(4)], detalhes: { 1000: detalhe(1000) } });
  assertEquals([r.chamadas.listar.length, r.resumo.paginas_lidas, r.resumo.paginacao, r.resumo.listados], [MAX_PAGINAS_POR_RODADA, 3, "truncada_no_teto", 150]);
  assertEquals([r.resumo.consultados, r.resumo.aguardando], [1, 149]);
});
