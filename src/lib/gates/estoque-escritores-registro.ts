// Registro FECHADO dos escritores dos espelhos de estoque do Omie (inventory_position.saldo e
// omie_products.estoque) nas edges — o gate é src/__tests__/estoque-escritores-gate.test.ts e o
// diário, docs/historico/estoque-dono-unico.md.
//
// A classe: um espelho cujo writer só grava quem a listagem TRAZ e ninguém zera quem SAI dela
// (o ListarPosEstoque padrão só lista saldo ≠ 0) — posições congeladas por meses, lidas como
// estoque atual pelo motor de compra (a WP07 ficou sem sugestão de compra desde 27/08 com estoque
// 0 no Omie, medido em 2026-10-05). Writer novo de espelho entra AQUI com papel e motivo, ou o
// gate fica vermelho; entrada que deixou de escrever sai (o registro só encolhe).

export type PapelEscritorEstoque =
  /** Lista as posições e chama `zerarConfirmadosForaDaLista` (zero só com confirmação explícita). */
  | 'dono-zero-confirmado'
  /** O próprio UPDATE com CAS do zero confirmado (_shared). */
  | 'zero-compartilhado'
  /** Grava só os positivos que a listagem trouxe e não pode provar completude: nunca zera. */
  | 'positivos-parcial';

export const REGISTRO_ESCRITORES_ESTOQUE: Readonly<Record<string, { papel: PapelEscritorEstoque; motivo: string }>> = {
  'supabase/functions/_shared/zeramento-estoque-io.ts': {
    papel: 'zero-compartilhado',
    motivo: 'o UPDATE com CAS no valor lido dos zeros confirmados (inventory_position e omie_products)',
  },
  'supabase/functions/omie-analytics-sync/index.ts': {
    papel: 'dono-zero-confirmado',
    motivo:
      'syncInventory (vendas, colacor_vendas, servicos) — dono do zero; syncInventoryFull é modo S (zero explícito); ' +
      'o syncProducts (catálogo) não grava estoque',
  },
  'supabase/functions/sync-reprocess/index.ts': {
    papel: 'dono-zero-confirmado',
    motivo: 'reprocessInventory (oben) — dono do zero da posição e do estoque da empresa oben',
  },
  'supabase/functions/omie-vendas-sync/index.ts': {
    papel: 'positivos-parcial',
    motivo:
      'sync_estoque: cursor de 3 páginas por invocação, disparado pelo catálogo do pedido unificado — nenhuma ' +
      'invocação vê a listagem inteira, logo não prova ausência; o sync_products (catálogo) não grava estoque',
  },
};
