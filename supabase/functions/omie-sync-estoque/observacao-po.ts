// Observação do conjunto que o motor contou (spec 2026-09-26-baixa-pedido-compra-nf-concluida §15 item 2).
// PURO: sem I/O. A edge registra no coletor CADA ponto de decisão da varredura do "a caminho" e só publica
// se observacaoBateComPendente(...) — observação que diverge do pendente calculado não é publicada, porque mediria
// outra coisa que não o que o motor contou.

export type MotivoExclusaoPedido = "dedup_app" | "etapa_nao_aberta" | "repetido_na_varredura";
type MotivoExclusao = MotivoExclusaoPedido | "item_sem_sku" | "sku_nao_habilitado" | "quantidade_invalida";

export interface LinhaObservada {
  omie_codigo_pedido: number;
  seq_item: number;
  numero_pedido: string | null;
  etapa: string | null;
  id_item: number | null;
  sku_codigo_omie: number | null;
  quantidade: number | null;
  quantidade_recebida: number | null;
  contribuicao: number;
  exclusao: MotivoExclusao | null;
}

export interface ItemPedidoOmie {
  nCodItem?: unknown;
  nCodProd?: unknown;
  nQtde?: unknown;
  nQtdeRec?: unknown;
}

export interface CabecalhoObservado {
  nCodPed: number;
  cNumero: string | null;
  cEtapa: string | null;
}

export interface ParseQuantidades {
  parseQtd: (v: unknown) => number;
  parseRecebido: (v: unknown) => number;
}

const EPSILON = 1e-9;

function inteiroOuNull(v: unknown): number | null {
  const texto = String(v ?? "").trim();
  if (texto === "") return null;
  const n = Number(texto);
  return Number.isSafeInteger(n) ? n : null;
}

function finitoOuNull(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

export function observarPedido(
  cab: CabecalhoObservado,
  itens: ItemPedidoOmie[],
  exclusaoDoPedido: MotivoExclusaoPedido | null,
  habilitado: (sku: string) => boolean,
  parse: ParseQuantidades,
): LinhaObservada[] {
  return itens.map((it, seq) => {
    const skuTexto = String(it.nCodProd ?? "").trim();
    const qtde = parse.parseQtd(it.nQtde);
    const recebido = parse.parseRecebido(it.nQtdeRec);
    const base = {
      omie_codigo_pedido: cab.nCodPed,
      seq_item: seq,
      numero_pedido: cab.cNumero,
      etapa: cab.cEtapa,
      id_item: inteiroOuNull(it.nCodItem),
      sku_codigo_omie: inteiroOuNull(it.nCodProd),
      quantidade: finitoOuNull(qtde),
      quantidade_recebida: finitoOuNull(recebido),
    };
    const excluido = (exclusao: MotivoExclusao): LinhaObservada => ({ ...base, contribuicao: 0, exclusao });
    if (exclusaoDoPedido !== null) return excluido(exclusaoDoPedido);
    if (!skuTexto) return excluido("item_sem_sku");
    if (!habilitado(skuTexto)) return excluido("sku_nao_habilitado");
    if (!Number.isFinite(qtde) || !Number.isFinite(recebido) || qtde < 0 || recebido < 0) {
      return excluido("quantidade_invalida");
    }
    return { ...base, contribuicao: Math.max(0, qtde - recebido), exclusao: null };
  });
}

export interface ColetorObservacao {
  /** As linhas na ordem da varredura: é exatamente o que vai para o invariante E para a RPC. */
  readonly linhas: LinhaObservada[];
  /**
   * false quando algum PO lido NÃO pôde ser anotado fielmente (sem nCodPed, itens malformados, contado sem itens,
   * ou o motor contou uma aparição posterior à anotada). A observação então NÃO pode ser publicada: ela afirmaria a
   * ausência de um PO que foi visto, ou atribuiria a contribuição a outro PO com a soma fechando por compensação.
   */
  readonly integra: boolean;
  /** O 1º motivo de perda de integridade (diagnóstico do resumo da edge), ou null. */
  readonly perda: string | null;
  /** Registra o PO na 1ª aparição. NUNCA lança: o que não sabe anotar vira perda de integridade (e devolve false). */
  registrar(cab: CabecalhoObservado, itens: unknown, exclusao: MotivoExclusaoPedido | null): boolean;
}

function linhaDePresenca(cab: CabecalhoObservado, exclusao: MotivoExclusaoPedido): LinhaObservada {
  return {
    omie_codigo_pedido: cab.nCodPed, seq_item: 0, numero_pedido: cab.cNumero, etapa: cab.cEtapa, id_item: null,
    sku_codigo_omie: null, quantidade: null, quantidade_recebida: null, contribuicao: 0, exclusao,
  };
}

/**
 * Um PO entra UMA vez por run: a PK do banco é (run_id, omie_codigo_pedido, seq_item), e uma reaparição na
 * varredura (deslocamento de paginação; PO do app ou fora da etapa repetido) colidiria e derrubaria a publicação
 * inteira. A 1ª aparição vence; reaparição que o motor NÃO conta é ignorada, e a que ele CONTA (ex.: etapa 10 → 15
 * entre páginas) é perda de integridade — a soma por SKU poderia fechar por compensação com outro PO.
 * PO não contado e sem itens entra com 1 linha de presença (seq_item 0, campos do item null): sem ela, um PO visto
 * pareceria ausente. A coleta é acessória ao pendente, então NUNCA lança — falha vira perda de integridade.
 */
export function criarColetorObservacao(
  habilitado: (sku: string) => boolean,
  parse: ParseQuantidades,
): ColetorObservacao {
  const linhas: LinhaObservada[] = [];
  const vistos = new Set<number>();
  let perda: string | null = null;
  const perder = (motivo: string): false => {
    perda ??= motivo;
    return false;
  };
  return {
    linhas,
    get integra() {
      return perda === null;
    },
    get perda() {
      return perda;
    },
    registrar(cab, itens, exclusao) {
      try {
        if (!Number.isSafeInteger(cab.nCodPed) || cab.nCodPed <= 0) return perder("pedido_sem_ncodped");
        if (vistos.has(cab.nCodPed)) {
          return exclusao === null ? perder(`decisao_mudou_na_varredura:${cab.nCodPed}`) : false;
        }
        if (!Array.isArray(itens) || !itens.every((it) => it !== null && typeof it === "object")) {
          return perder(`itens_malformados:${cab.nCodPed}`);
        }
        if (itens.length === 0) {
          if (exclusao === null) return perder(`pedido_contado_sem_itens:${cab.nCodPed}`);
          vistos.add(cab.nCodPed);
          linhas.push(linhaDePresenca(cab, exclusao));
          return true;
        }
        vistos.add(cab.nCodPed);
        linhas.push(...observarPedido(cab, itens as ItemPedidoOmie[], exclusao, habilitado, parse));
        return true;
      } catch {
        return perder("excecao_na_coleta");
      }
    },
  };
}

export function somarContribuicaoPorSku(linhas: LinhaObservada[]): Map<string, number> {
  const soma = new Map<string, number>();
  for (const l of linhas) {
    if (l.exclusao !== null || l.sku_codigo_omie === null || l.contribuicao <= 0) continue;
    const sku = String(l.sku_codigo_omie);
    soma.set(sku, (soma.get(sku) ?? 0) + l.contribuicao);
  }
  return soma;
}

export function observacaoBateComPendente(linhas: LinhaObservada[], pendente: Map<string, number>): boolean {
  const soma = somarContribuicaoPorSku(linhas);
  const skus = new Set<string>([...soma.keys(), ...[...pendente.entries()].filter(([, v]) => v > 0).map(([k]) => k)]);
  // Nada observado não prova nada; PO(s) observado(s) com contribuições todas zero é o pendente zerado legítimo.
  if (skus.size === 0) return linhas.length > 0;
  for (const sku of skus) {
    if (Math.abs((soma.get(sku) ?? 0) - (pendente.get(sku) ?? 0)) > EPSILON) return false;
  }
  return true;
}
