// Gabarito da extração do PDF real da Lider (pedido de compra 213294, VERSAO 2,
// emissão 20/05/2026, 2 páginas, 5 itens com datas de entrega distintas).
// Transcrito A OLHO do PDF (lider-213294.pdf ao lado) — é o resultado que a edge
// pedido-programado-extrair deve produzir; o ensaio ponta a ponta compara contra isto.
// Também serve de entrada real para validarExtracao no teste (golden do contrato).
export const esperado213294 = {
  numero_pedido_compra: '213294',
  data_emissao: '2026-05-20',
  versao: '2',
  itens: [
    {
      codigo_item_cliente: '3FLA0003M01',
      num_ordem_cliente: '50072329',
      descricao_cliente: 'FLANELA MICROFIBRA AUTOMOTIVA 40 X 40CM - COR AZUL/LARANJA - C/ COSTURAS',
      quantidade: 220,
      unidade: 'UN',
      preco_unitario: 16.9,
      data_entrega: '2026-07-20',
      cod_forn: '644',
    },
    {
      codigo_item_cliente: '3LHO0080012S',
      num_ordem_cliente: '50072309',
      descricao_cliente: 'LIXA HOOKIT GOLD 255Z MR2L S/F #80 125MM',
      quantidade: 1700,
      unidade: 'UN',
      preco_unitario: 2.45,
      data_entrega: '2026-07-20',
      cod_forn: 'PRD01931',
    },
    {
      codigo_item_cliente: '3LRO0036000',
      num_ordem_cliente: '50072272',
      descricao_cliente: 'LIXA ROLO GRAO # 36 - MARRON/ GOLDEN- ATX170',
      quantidade: 1,
      unidade: 'MT',
      preco_unitario: 25,
      data_entrega: '2026-06-17',
      cod_forn: '426',
    },
    {
      codigo_item_cliente: '3LSI0050720',
      num_ordem_cliente: '50072299',
      descricao_cliente: 'LIXA SINTA 3M 341DL #50 0120 X 7200',
      quantidade: 20,
      unidade: 'UN',
      preco_unitario: 111.4,
      data_entrega: '2026-06-24',
      cod_forn: '1087',
    },
    {
      codigo_item_cliente: '3SUPHOOKIT',
      num_ordem_cliente: '50072326',
      descricao_cliente: 'SUPORTE HOOKIT EDA 127MM C/ FURO - AA',
      quantidade: 34,
      unidade: 'UN',
      preco_unitario: 103,
      data_entrega: '2026-07-20',
      cod_forn: '609',
    },
  ],
};
