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
//  1. quantidade do Omie IGUAL à da NF → manda a da NF (não há o que decidir);
//  2. sinal de conversão (unidade da NF ≠ unidade de estoque, ou fator ≠ 1 no item) → manda a
//     quantidade que o OMIE converteu; se ele não a informou, RECUSA a NF;
//  3. sem conversão, unidades legíveis e iguais → manda a quantidade da NF, EXATA (sem arredondar);
//  4. unidade ilegível e as duas quantidades divergem → RECUSA (não dá para saber qual vale).
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

export type RegraAplicada = "nf_igual_omie" | "conversao_do_omie" | "nf_sem_conversao";

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

export type MotivoRecusa =
  | "sequencia_ilegivel"
  | "quantidade_nf_ilegivel"
  | "conversao_sem_quantidade_do_omie"
  | "unidade_ilegivel";

export interface ItemRecusado {
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
    const qtdOmieBruta = numeroOuNulo(aj.nQtdeRecebida);
    const qtdOmie = qtdOmieBruta !== null && qtdOmieBruta > 0 ? qtdOmieBruta : null;
    const fator = fatorNoItem(item);
    const unidadesDiferem = unidadeNf !== null && unidadeEstoque !== null && unidadeNf !== unidadeEstoque;
    const sinalConversao = unidadesDiferem || (fator !== null && Math.abs(fator - 1) > 1e-9);
    const base = { sequencia: seq, codigo, idProduto: numeroOuNulo(cab.nIdProduto), unidadeNf, unidadeEstoque, qtdNf, qtdOmie, fatorNoItem: fator };
    const par = `${unidadeNf ?? "?"}→${unidadeEstoque ?? "?"}`;

    if (qtdOmie !== null && iguais(qtdOmie, qtdNf)) {
      decididos.push({
        ...base, regra: "nf_igual_omie", qtdEnviada: qtdNf,
        aviso: sinalConversao ? `unidades ${par} e o Omie não converteu (${qtdNf}) — confira o cadastro de conversão do produto` : null,
      });
      return;
    }
    if (sinalConversao) {
      if (qtdOmie === null) {
        recusas.push({
          posicao, sequencia: seq, codigo, motivo: "conversao_sem_quantidade_do_omie",
          detalhe: `conversão ${par} e o Omie não informou a quantidade convertida — confira o cadastro do produto no Omie`,
        });
        return;
      }
      decididos.push({
        ...base, regra: "conversao_do_omie", qtdEnviada: qtdOmie,
        aviso: Number.isInteger(qtdOmie) ? null : `quantidade convertida fracionária (${qtdOmie} ${unidadeEstoque ?? "?"}) — confira o fator no cadastro do Omie`,
      });
      return;
    }
    if (unidadeNf !== null && unidadeEstoque !== null) {
      decididos.push({
        ...base, regra: "nf_sem_conversao", qtdEnviada: qtdNf,
        aviso: qtdOmie !== null ? `o Omie tinha ${qtdOmie} pré-preenchido; vale a quantidade da NF (${qtdNf})` : null,
      });
      return;
    }
    recusas.push({
      posicao, sequencia: seq, codigo, motivo: "unidade_ilegivel",
      detalhe: `unidade ilegível (${par}) e as quantidades divergem (NF ${qtdNf}, Omie ${qtdOmie ?? "—"})`,
    });
  });

  decididos.sort((a, b) => a.sequencia - b.sequencia);
  return recusas.length > 0 ? { ok: false, recusas, itens: decididos, ignorados } : { ok: true, itens: decididos, ignorados };
}
