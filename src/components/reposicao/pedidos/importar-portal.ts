// Importar pedido digitado direto no portal Sayerlack pelo número (edge `sayerlack-importar-pedido-portal`).
// Interpretação PURA da resposta da edge para a tela — o que vira sucesso, aviso ou erro.

export const PROTOCOLO_PORTAL_RE = /^\d{3,12}$/;

interface ItemImportado {
  sku_portal: string;
  descricao: string;
  qtde_portal: number;
  valor_mercadoria: number;
}

interface RespostaImportacao {
  ok?: boolean;
  etapa?: 'leitura' | 'importacao' | 'omie' | 'concluido';
  mensagem?: string;
  pedido_id?: number;
  protocolo?: string;
  omie_numero?: string | null;
  valor_total?: number | null;
  valor_total_portal?: number | null;
  situacao_portal?: string | null;
  ja_existia?: boolean;
  itens?: ItemImportado[];
}

type TomResultado = 'sucesso' | 'aviso' | 'erro';

export interface ResultadoTela {
  tom: TomResultado;
  titulo: string;
  mensagem: string;
  pedidoId: number | null;
  omieNumero: string | null;
  itens: ItemImportado[];
  situacaoPortal: string | null;
  valorTotal: number | null;
}

/**
 * Sucesso SÓ com PO no Omie confirmado pelo banco (`ok` + `etapa='concluido'`). Pedido gravado sem PO é AVISO
 * (dá para importar de novo e re-disparar); qualquer outra coisa é erro — inclusive resposta sem `ok`
 * (ausente ≠ sucesso).
 */
export function interpretarRespostaImportacao(data: unknown, protocolo: string): ResultadoTela {
  const r = (data && typeof data === 'object' ? data : {}) as RespostaImportacao;
  const base = {
    pedidoId: Number.isInteger(r.pedido_id) ? (r.pedido_id as number) : null,
    omieNumero: r.omie_numero ?? null,
    itens: Array.isArray(r.itens) ? r.itens : [],
    situacaoPortal: r.situacao_portal ?? null,
    valorTotal: typeof r.valor_total === 'number' ? r.valor_total : (typeof r.valor_total_portal === 'number' ? r.valor_total_portal : null),
  };
  if (r.ok === true && r.etapa === 'concluido') {
    return {
      ...base,
      tom: 'sucesso',
      titulo: r.ja_existia ? `Pedido ${protocolo} já estava importado` : `Pedido ${protocolo} importado`,
      mensagem: r.mensagem ?? `Pedido de compra ${base.omieNumero ?? ''} no Omie.`,
    };
  }
  if (r.etapa === 'omie' && base.pedidoId != null) {
    return {
      ...base,
      tom: 'aviso',
      titulo: `Pedido ${protocolo} gravado — falta o Omie`,
      mensagem: r.mensagem ?? 'O pedido de compra no Omie ainda não saiu. Importe de novo para re-disparar.',
    };
  }
  const titulo = r.etapa === 'leitura'
    ? `Não consegui ler o pedido ${protocolo} no portal`
    : `Pedido ${protocolo} não foi importado`;
  return { ...base, tom: 'erro', titulo, mensagem: r.mensagem ?? 'Resposta inesperada da importação.' };
}
