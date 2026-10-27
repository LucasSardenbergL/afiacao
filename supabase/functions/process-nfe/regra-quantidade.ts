// Regra da QUANTIDADE RECEBIDA que a `process-nfe` manda ao Omie no `AlterarRecebimento` — pura,
// sem I/O. Testes em regra-quantidade_test.ts (Deno, `--no-remote`).
//
// ── Por que a regra mudou (plano de melhoria v3, item 1) ─────────────────────────────────────
// A versão anterior fazia `Math.round(nQtdeNFe / fator)`, com o fator caçado em 6 lugares do item e
// caindo para `|| 1` quando nenhum existia. Medido em prod (psql-ro, 2026-10-21):
//  - 3.765 de 4.118 recebimentos concluídos no Omie (91%) têm a quantidade recebida ≠ quantidade da
//    NF: a Sayerlack fatura em LITRO e o estoque é em UNIDADE (lata/galão/balde) — 3.676 pares L→UN;
//  - numa NF PENDENTE real (Oben, NF 000955811, seq 5, PRD03454), o próprio Omie já pré-preenche
//    `itensAjustes.nQtdeRecebida = 3` (UN) para `itensCabec.nQtdeNFe = 54` (L): balde de 18 L. É a
//    conversão do CADASTRO do produto no Omie, na unidade de estoque `itensAjustes.cUnidade`;
//  - a spec do recebimento (2026-06-04) registrou o `nFatorConversao` como OPCIONAL no payload real,
//    e o recorte real de 14/10 (`omie-sync-nfes-recebidas/associacao_test.ts`) não o traz.
// Sem o campo, a regra antiga mandava 54 UN onde o Omie tinha 3 (18×). Com o campo no sentido
// multiplicativo do Omie (0,055556 = 1/18), dividiria: 972 UN. Nos dois casos ela SOBRESCREVIA o
// número certo que o Omie já tinha calculado. E o `Math.round` arredondava fração da NF sem
// conversão (2,43 L → 2 L).
//
// ── A regra explícita ───────────────────────────────────────────────────────────────────────
// Esta edge NÃO calcula conversão — não há, do lado de cá, fonte confiável do fator. Por item:
//  1. unidade da NF ≠ unidade de estoque → manda a quantidade que o OMIE converteu; RECUSA se ele
//     não a informou ou se ela é igual à da NF (conversão não aplicada, ou resíduo de escrita antiga);
//  2. mesma unidade → manda a quantidade da NF, EXATA (sem arredondar), se o Omie não tem outra;
//     RECUSA se o Omie tem outro número;
//  3. unidade ilegível ou fator explícito ≠ 1 no item → RECUSA.
// Qualquer recusa barra a NF INTEIRA antes de qualquer escrita (precisão > recall,
// docs/agent/money-path.md §1). O número enviado é sempre um que já existia no Omie ou na NF —
// nunca fabricado aqui. Fração da conversão do Omie (ex.: 14,0001 por fator de 6 casas) passa como
// ele a calculou, com aviso: é o mesmo número que a conclusão direto no Omie gravaria.
//
// Não confundir com o `smartRound` da reposição (embalagem de COMPRA, outra grandeza).

export interface ItemOmieBruto {
  itensCabec?: unknown;
  itensAjustes?: unknown;
  itensConversao?: unknown;
  itensNfe?: unknown;
  [chave: string]: unknown;
}

type RegraAplicada = "nf_igual_omie" | "conversao_do_omie" | "nf_sem_conversao";

export interface ItemDecidido {
  sequencia: number;
  codigo: string | null;
  idProduto: number | null;
  unidadeNf: string | null;
  unidadeEstoque: string | null;
  qtdNf: number;
  qtdOmie: number | null;
  fatorNoItem: number | null;
  regra: RegraAplicada;
  qtdEnviada: number;
  aviso: string | null;
}

type MotivoRecusa =
  | "sequencia_ilegivel"
  | "quantidade_nf_ilegivel"
  | "conversao_sem_quantidade_do_omie"
  | "conversao_nao_aplicada_no_omie"
  | "quantidade_omie_diverge"
  | "fator_no_item_nao_confirmado"
  | "unidade_ilegivel";

interface ItemRecusado {
  posicao: number;
  sequencia: number | null;
  codigo: string | null;
  motivo: MotivoRecusa;
  detalhe: string;
}

export type DecisaoQuantidades =
  | { ok: true; itens: ItemDecidido[]; ignorados: number }
  | { ok: false; recusas: ItemRecusado[]; itens: ItemDecidido[]; ignorados: number };

function registro(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** Número finito vindo de number ou string numérica; o resto é AUSENTE (`null`), nunca 0. */
export function numeroOuNulo(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function textoOuNulo(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function unidade(v: unknown): string | null {
  const t = textoOuNulo(v);
  return t ? t.toUpperCase() : null;
}

/** Fator do item como SINAL de conversão: o primeiro candidato positivo ≠ 1, senão 1, senão ausente. */
export function fatorNoItem(item: ItemOmieBruto): number | null {
  const cab = registro(item.itensCabec);
  const aj = registro(item.itensAjustes);
  const nums = [
    cab.nFatorConversao, cab.nFatorConv, aj.nFatorConversao, aj.nFatorConv,
    registro(item.itensConversao).nFatorConversao, registro(item.itensNfe).nFatorConversao,
  ].map(numeroOuNulo).filter((n): n is number => n !== null && n > 0);
  if (nums.length === 0) return null;
  return nums.find((n) => Math.abs(n - 1) > 1e-9) ?? 1;
}

/** Iguais na resolução do Omie (até 4 casas na quantidade; a conversão às vezes traz 6). */
function iguais(a: number, b: number): boolean {
  return Math.abs(a - b) < 5e-5;
}

export function ehItemIgnorado(item: ItemOmieBruto): boolean {
  return textoOuNulo(registro(item.itensCabec).cIgnorarItem)?.toUpperCase() === "S";
}

export function decidirQuantidades(itens: readonly ItemOmieBruto[]): DecisaoQuantidades {
  const decididos: ItemDecidido[] = [];
  const recusas: ItemRecusado[] = [];
  let ignorados = 0;

  itens.forEach((item, i) => {
    if (ehItemIgnorado(item)) {
      ignorados++;
      return;
    }
    const cab = registro(item.itensCabec);
    const aj = registro(item.itensAjustes);
    const codigo = textoOuNulo(cab.cCodigoProduto);
    const seq = numeroOuNulo(cab.nSequencia);
    const posicao = i + 1;

    // Sem sequência não há como dizer ao Omie QUAL item editar — a versão antiga inventava `i + 1`.
    if (seq === null || !Number.isInteger(seq) || seq <= 0) {
      recusas.push({ posicao, sequencia: null, codigo, motivo: "sequencia_ilegivel", detalhe: "item sem nSequencia legível no Omie" });
      return;
    }
    const qtdNf = numeroOuNulo(cab.nQtdeNFe);
    if (qtdNf === null || qtdNf <= 0) {
      recusas.push({ posicao, sequencia: seq, codigo, motivo: "quantidade_nf_ilegivel", detalhe: "quantidade da NF ausente, ilegível ou ≤ 0" });
      return;
    }

    const unidadeNf = unidade(cab.cUnidadeNfe);
    const unidadeEstoque = unidade(aj.cUnidade);
    // Zero EXPLÍCITO é um número do Omie (falta total registrada, conferência anterior), não ausência:
    // só o campo ausente/ilegível é `null` (Codex retroativo do #3334, P1-1).
    const qtdOmie = numeroOuNulo(aj.nQtdeRecebida);
    const fator = fatorNoItem(item);
    const base = { sequencia: seq, codigo, idProduto: numeroOuNulo(cab.nIdProduto), unidadeNf, unidadeEstoque, qtdNf, qtdOmie, fatorNoItem: fator };
    const par = `${unidadeNf ?? "?"}→${unidadeEstoque ?? "?"}`;
    const recusar = (motivo: MotivoRecusa, detalhe: string) => recusas.push({ posicao, sequencia: seq, codigo, motivo, detalhe });

    // Fator explícito no item: o sentido (multiplica ou divide) não foi confirmado em payload real, e
    // um fator lido ao contrário erra por fator² (0,055556 dividindo = 972 em vez de 3).
    if (fator !== null && Math.abs(fator - 1) > 1e-9) {
      recusar("fator_no_item_nao_confirmado", `fator de conversão ${fator} no item (${par}) — sentido não confirmado, não envio quantidade`);
      return;
    }
    if (unidadeNf === null || unidadeEstoque === null) {
      recusar("unidade_ilegivel", `unidade ilegível (${par}) — não dá para saber se há conversão`);
      return;
    }
    if (unidadeNf !== unidadeEstoque) {
      if (qtdOmie === null || qtdOmie <= 0) {
        recusar("conversao_sem_quantidade_do_omie", `conversão ${par} e o Omie não informou a quantidade convertida — confira o cadastro do produto no Omie`);
        return;
      }
      // Unidades diferentes e o MESMO número: o Omie não converteu (cadastro sem fator) ou o número é
      // resíduo de uma escrita anterior (a v1 desta edge gravava a quantidade da NF). Medido em prod:
      // "THINNER NITRO DN.4260L5" (lata de 5 L) entrou 20 L → 20 UN; "SELADORA …00LT" 90 L → 90 UN.
      if (iguais(qtdOmie, qtdNf)) {
        recusar("conversao_nao_aplicada_no_omie", `unidades ${par} e o Omie está com a quantidade da NF (${qtdNf}) — conversão não aplicada; confira o cadastro do produto no Omie`);
        return;
      }
      decididos.push({
        ...base, regra: "conversao_do_omie", qtdEnviada: qtdOmie,
        aviso: Number.isInteger(qtdOmie) ? null : `quantidade convertida fracionária (${qtdOmie} ${unidadeEstoque}) — confira o fator no cadastro do Omie`,
      });
      return;
    }
    if (qtdOmie === null) {
      decididos.push({ ...base, regra: "nf_sem_conversao", qtdEnviada: qtdNf, aviso: null });
      return;
    }
    if (iguais(qtdOmie, qtdNf)) {
      decididos.push({ ...base, regra: "nf_igual_omie", qtdEnviada: qtdNf, aviso: null });
      return;
    }
    // Mesma unidade e números diferentes: o Omie sabe algo que a NF não diz (falta registrada,
    // conferência anterior, conversão com rótulo igual). Sobrescrever seria apagar isso.
    recusar("quantidade_omie_diverge", `mesma unidade (${unidadeNf}) e o Omie tem ${qtdOmie} contra ${qtdNf} da NF — confira no Omie qual vale`);
  });

  decididos.sort((a, b) => a.sequencia - b.sequencia);
  return recusas.length > 0 ? { ok: false, recusas, itens: decididos, ignorados } : { ok: true, itens: decididos, ignorados };
}
