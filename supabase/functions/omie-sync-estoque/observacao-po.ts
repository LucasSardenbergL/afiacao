// Observação do conjunto que o motor contou (spec 2026-09-26-baixa-pedido-compra-nf-concluida §15 item 2).
// PURO: sem I/O. A edge registra no coletor CADA ponto de decisão da varredura do "a caminho" e só publica
// se observacaoBateComPendente(...) — observação que diverge do pendente calculado não é publicada, porque mediria
// outra coisa que não o que o motor contou.

export type MotivoExclusaoPedido = "dedup_app" | "etapa_nao_aberta" | "repetido_na_varredura";
export type MotivoExclusao = MotivoExclusaoPedido | "item_sem_sku" | "sku_nao_habilitado" | "quantidade_invalida";

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
  /** Registra o PO na 1ª aparição; devolve false quando não registrou (já visto, ou nCodPed inválido). */
  registrar(cab: CabecalhoObservado, itens: ItemPedidoOmie[], exclusao: MotivoExclusaoPedido | null): boolean;
}

/**
 * Um PO entra UMA vez por run: a PK do banco é (run_id, omie_codigo_pedido, seq_item), e uma reaparição na
 * varredura (deslocamento de paginação; PO do app ou fora da etapa repetido) colidiria e derrubaria a publicação
 * inteira. A 1ª aparição vence — se o motor contou uma aparição POSTERIOR do mesmo PO (ex.: etapa 10 → 15 entre
 * páginas), a observação não a vê e o invariante recusa publicar, que é o desfecho certo.
 * nCodPed fora de inteiro positivo seguro (o `Number("")` = 0 de um PO sem id, NaN) não tem chave: não é registrado.
 */
export function criarColetorObservacao(
  habilitado: (sku: string) => boolean,
  parse: ParseQuantidades,
): ColetorObservacao {
  const linhas: LinhaObservada[] = [];
  const vistos = new Set<number>();
  return {
    linhas,
    registrar(cab, itens, exclusao) {
      if (!Number.isSafeInteger(cab.nCodPed) || cab.nCodPed <= 0 || vistos.has(cab.nCodPed)) return false;
      vistos.add(cab.nCodPed);
      linhas.push(...observarPedido(cab, itens, exclusao, habilitado, parse));
      return true;
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
  if (skus.size === 0) return false; // observação vazia não prova nada — não publica
  for (const sku of skus) {
    if (Math.abs((soma.get(sku) ?? 0) - (pendente.get(sku) ?? 0)) > EPSILON) return false;
  }
  return true;
}
