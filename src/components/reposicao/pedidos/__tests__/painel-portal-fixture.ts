// Resposta v2 da RPC `sayerlack_painel_portal` (migrations 20261109100000 + 20261112090000 — 6.11) para os testes: "tudo em ordem" por padrão.
export function painelV2(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    versao: 2,
    consultado_em: '2026-11-09T16:00:00Z',
    rodada: {
      em_dia: true,
      exigida_desde: '2026-11-09T03:00:00Z',
      ultima_efetiva: {
        id: 'a', em: '2026-11-09T15:33:00Z', status: 'sucesso', lidos: 7, importados: 0, falhas: 0,
        adiados: 0, indeterminados: 0, carencia: 0, carencia_presa: 0,
      },
      ultima: { id: 'a', em: '2026-11-09T15:33:00Z', status: 'sucesso', pulado: null, erro: null, causa: null },
    },
    pendencias: [], total_pendencias: 0,
    sem_po: [], total_sem_po: 0,
    aguardando_disparo: { total: 0, mais_antigo_em: null },
    cancelado_sem_po: [], total_cancelado_sem_po: 0,
    cancelado_com_po: [], total_cancelado_com_po: 0,
    alterado_portal: [], total_alterado_portal: 0,
    pendentes_unicos: 0,
    importados: [], total_importados: 0,
    sem_aliquota: { skus: 0, ncms: [] },
    ...over,
  };
}
