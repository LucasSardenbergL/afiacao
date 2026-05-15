export type PedidoItem = {
  id: number;
  fornecedor_nome: string | null;
  grupo_codigo: string | null;
  num_skus: number | null;
  valor_total: number | null;
  pedido_anterior_valor: number | null;
  status: string | null;
  aprovado_em: string | null;
  cancelado_em: string | null;
  horario_disparo_real: string | null;
};

export type ColKey =
  | "fornecedor"
  | "grupo"
  | "skus"
  | "valor"
  | "status"
  | "qtdAprovada"
  | "preco"
  | "confianca";
