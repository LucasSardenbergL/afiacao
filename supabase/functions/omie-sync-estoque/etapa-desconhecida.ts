// PR(d) da baixa de PO (spec 2026-09-26 §15 item 7; parecer Codex 2026-10-16, decisão A): PO numa etapa que o
// "a caminho" não conhece, com saldo a receber, RECUSA o run — o par (físico, pendente) anterior fica.
//
// Por quê: o pendente só soma a etapa 15. A associação nativa NF↔PO no Omie (o caminho escolhido para o
// "encerrar total/parcial" do founder, 2026-10-17) leva o PO para "Recebido Parcialmente"/"Faturado pelo
// Fornecedor", cujo `cEtapa` ninguém mediu. Hoje esse PO cairia no ramo "não aberto" e o saldo que ainda
// não chegou SUMIRIA do "a caminho" — o motor recompra (double-buy). Contar o saldo (alternativa B) foi
// reprovado: os filtros do PesquisarPedCompra excluem o terminal, mas não provam que a etapa nova é
// compromisso de compra (a 10, "em aprovação", também passa no filtro).
//
// Ausência NÃO prova saldo zero: PO de etapa desconhecida sem lista de itens, com lista vazia ou com item
// de quantidade ilegível também recusa — `[].some(...)` seria `false` e deixaria passar (Codex achado 11).

export type ParseQuantidade = (v: unknown) => number;

/** Mensagem de problema (recusa do run) ou `null` quando o PO pode ser ignorado com segurança. */
export function problemaDeEtapaDesconhecida(
  etapa: string,
  itens: unknown,
  conhecidas: ReadonlySet<string>,
  identificacao: string,
  parse: { parseQtd: ParseQuantidade; parseRecebido: ParseQuantidade },
): string | null {
  if (conhecidas.has(etapa)) return null;
  const rotulo = `PO ${identificacao} com etapa DESCONHECIDA "${etapa}"`;
  if (!Array.isArray(itens) || itens.length === 0) {
    return `${rotulo} e sem itens legíveis — pendente não publicado até a etapa ser classificada`;
  }
  for (const it of itens) {
    const item = (it ?? {}) as { nQtde?: unknown; nQtdeRec?: unknown };
    const qtde = parse.parseQtd(item.nQtde);
    const recebido = parse.parseRecebido(item.nQtdeRec);
    if (!Number.isFinite(qtde) || !Number.isFinite(recebido) || qtde < 0 || recebido < 0) {
      return `${rotulo} e quantidade ilegível (nQtde=${item.nQtde} nQtdeRec=${item.nQtdeRec}) — pendente não publicado`;
    }
    if (qtde - recebido > 0) {
      return `${rotulo} e saldo a receber — pendente não publicado até a etapa ser classificada`;
    }
  }
  return null;
}
