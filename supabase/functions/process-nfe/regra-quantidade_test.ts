// Testa a regra de quantidade da process-nfe (regra-quantidade.ts) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/process-nfe/regra-quantidade_test.ts
//
// Fixtures com a FORMA do payload real do ConsultarRecebimento (itensCabec + itensAjustes). Os dois
// casos-âncora vêm de prod: NF 000955811 (Oben, Sayerlack, pendente) — seq 5 PRD03454 54 L com o Omie
// pré-preenchendo 3 UN, seq 7 PRD00316 2 L em estoque L — e o recorte real de 14/10 de
// `omie-sync-nfes-recebidas/associacao_test.ts` (1 L → 0,055556 UN).
import { decidirQuantidades, fatorNoItem, type ItemOmieBruto } from "./regra-quantidade.ts";

function igual(a: unknown, b: unknown, msg: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}: esperado ${jb}, veio ${ja}`);
}

function item(seq: number | undefined, qtdNf: unknown, unNf: string | undefined, qtdOmie: unknown, unEst: string | undefined, extra: Record<string, unknown> = {}): ItemOmieBruto {
  return {
    itensCabec: { nSequencia: seq, cCodigoProduto: `P${seq}`, nIdProduto: 100 + (seq ?? 0), nQtdeNFe: qtdNf, cUnidadeNfe: unNf, cIgnorarItem: "N", ...(extra.cab as object ?? {}) },
    itensAjustes: { nQtdeRecebida: qtdOmie, cUnidade: unEst, ...(extra.aj as object ?? {}) },
  };
}

Deno.test("caso real NF 000955811: 54 L → 3 UN do Omie (a regra antiga mandava 54); L→L 2 = 2", () => {
  const d = decidirQuantidades([item(5, 54, "L", 3, "UN"), item(7, 2, "L", 2, "L")]);
  if (!d.ok) throw new Error("recusou o caso real");
  igual(d.itens.map((i) => [i.sequencia, i.regra, i.qtdEnviada]), [[5, "conversao_do_omie", 3], [7, "nf_igual_omie", 2]], "quantidades");
  igual(d.itens.map((i) => i.aviso), [null, null], "sem aviso");
});

Deno.test("recorte real de 14/10 (sem fator): 1 L → 0,055556 UN do Omie passa como ele calculou, com aviso de fração", () => {
  const d = decidirQuantidades([item(1, 1, "L", 0.055556, "UN")]);
  if (!d.ok) throw new Error("recusou");
  igual([d.itens[0].regra, d.itens[0].qtdEnviada, d.itens[0].aviso !== null], ["conversao_do_omie", 0.055556, true], "fração do Omie");
});

Deno.test("unidades diferentes e o Omie com o MESMO número da NF → RECUSA (THINNER DN.4260L5: 20 L entraram 20 UN)", () => {
  const d = decidirQuantidades([item(1, 20, "L", 20, "UN")]);
  if (d.ok) throw new Error("aceitou conversão não aplicada");
  igual(d.recusas[0].motivo, "conversao_nao_aplicada_no_omie", "motivo");
});

Deno.test("fator explícito ≠ 1 no item → RECUSA (sentido não confirmado: 0,055556 dividindo daria 972)", () => {
  for (const extra of [{ cab: { nFatorConversao: 0.055556 } }, { aj: { nFatorConv: 18 } }]) {
    const d = decidirQuantidades([item(1, 54, "L", 3, "UN", extra)]);
    if (d.ok) throw new Error(`aceitou fator ${JSON.stringify(extra)}`);
    igual(d.recusas[0].motivo, "fator_no_item_nao_confirmado", JSON.stringify(extra));
  }
  const um = decidirQuantidades([item(1, 54, "L", 3, "UN", { cab: { nFatorConversao: 1 } })]);
  igual(um.ok, true, "fator 1 não é sinal");
});

Deno.test("sem conversão: fração da NF vai EXATA (o Math.round antigo mandava 2)", () => {
  const d = decidirQuantidades([item(1, 2.43, "L", null, "L")]);
  if (!d.ok) throw new Error("recusou");
  igual([d.itens[0].regra, d.itens[0].qtdEnviada], ["nf_sem_conversao", 2.43], "2,43 L");
  const igualOmie = decidirQuantidades([item(1, 2.43, "L", 2.43, "L")]);
  if (!igualOmie.ok) throw new Error("recusou NF = Omie");
  igual(igualOmie.itens[0].regra, "nf_igual_omie", "NF = Omie");
});

Deno.test("mesma unidade e o Omie com outro número → RECUSA (o Omie sabe algo que a NF não diz)", () => {
  const d = decidirQuantidades([item(1, 10, "UN", 8, "UN")]);
  if (d.ok) throw new Error("sobrescreveu o número do Omie");
  igual(d.recusas[0].motivo, "quantidade_omie_diverge", "motivo");
});

Deno.test("conversão sem a quantidade do Omie → RECUSA a NF inteira, mesmo com outro item bom", () => {
  const d = decidirQuantidades([item(1, 54, "L", null, "UN"), item(2, 2, "L", 2, "L")]);
  if (d.ok) throw new Error("aceitou conversão sem número do Omie");
  igual(d.recusas.map((r) => [r.sequencia, r.motivo]), [[1, "conversao_sem_quantidade_do_omie"]], "motivo");
  const zero = decidirQuantidades([item(1, 54, "L", 0, "UN")]);
  igual(zero.ok, false, "0 pré-preenchido é ausente, não quantidade");
});

Deno.test("unidade ilegível → RECUSA, mesmo com NF = Omie", () => {
  for (const [unNf, unEst] of [[undefined, undefined], ["L", undefined], [undefined, "UN"], ["  ", "UN"]] as const) {
    const d = decidirQuantidades([item(1, 4, unNf, 4, unEst)]);
    if (d.ok) throw new Error(`aceitou ${unNf}→${unEst}`);
    igual(d.recusas[0].motivo, "unidade_ilegivel", `${unNf}→${unEst}`);
  }
});

Deno.test("sequência ausente RECUSA (a versão antiga inventava i+1); quantidade da NF ilegível ou ≤ 0 RECUSA", () => {
  for (const [it, motivo] of [
    [item(undefined, 5, "UN", 5, "UN"), "sequencia_ilegivel"],
    [item(1, "abc", "UN", null, "UN"), "quantidade_nf_ilegivel"],
    [item(1, 0, "UN", null, "UN"), "quantidade_nf_ilegivel"],
    [item(1, Infinity, "UN", null, "UN"), "quantidade_nf_ilegivel"],
  ] as const) {
    const d = decidirQuantidades([it]);
    if (d.ok) throw new Error(`aceitou ${motivo}`);
    igual(d.recusas[0].motivo, motivo, motivo);
  }
});

Deno.test("item ignorado fica fora (conta em `ignorados`); ordem por sequência", () => {
  const ign = item(9, 1, "UN", 1, "UN", { cab: { cIgnorarItem: "S" } });
  const d = decidirQuantidades([item(3, 1, "UN", 1, "UN"), ign, item(1, 2, "UN", 2, "UN")]);
  if (!d.ok) throw new Error("recusou");
  igual([d.ignorados, d.itens.map((i) => i.sequencia)], [1, [1, 3]], "ignorado + ordem");
});

Deno.test("fatorNoItem: ausente → null; só 1 → 1; o ≠ 1 vence; negativo/0/NaN não é fator", () => {
  igual(fatorNoItem({ itensCabec: {} }), null, "ausente");
  igual(fatorNoItem({ itensCabec: { nFatorConversao: 1 } }), 1, "1");
  igual(fatorNoItem({ itensCabec: { nFatorConversao: 1 }, itensAjustes: { nFatorConv: 18 } }), 18, "≠1 vence");
  igual(fatorNoItem({ itensCabec: { nFatorConversao: -3, nFatorConv: 0 }, itensNfe: { nFatorConversao: "x" } }), null, "inválidos");
});
