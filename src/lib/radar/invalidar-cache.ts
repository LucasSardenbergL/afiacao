import type { QueryClient } from '@tanstack/react-query';

/**
 * Invalidação ÚNICA do cache do Radar depois de uma mutação (registro de contato, desfazer, cadastro no Omie,
 * descarte em lote, fim do lote de cadastro). Antes cada mutação listava as próprias chaves e o descarte em lote
 * esquecia `['radar','amostra']`: o lead de controle descartado seguia intercalado na fila (achado Codex, pacote A2).
 * Agora TUDO sob `['radar']` invalida — a amostra, os KPIs, os sugeridos, o mapa, os contatos e os conflitos
 * entram juntos, inclusive as chaves que nascerem depois.
 *
 * `reiniciarLista`: ação em lote. A fila pagina por offset e os leads tratados saem dela — refazer as páginas
 * carregadas pularia empresas, então a lista RECOMEÇA do topo (reset, aguardado) e o resto só invalida.
 * A invalidação não é aguardada: quem chama não fica preso ao refetch de cada leitura do Radar.
 */
export async function invalidarRadar(qc: QueryClient, opcoes: { reiniciarLista?: boolean } = {}): Promise<void> {
  if (opcoes.reiniciarLista) {
    await qc.resetQueries({ queryKey: ['radar', 'lista'] });
    void qc.invalidateQueries({ queryKey: ['radar'], predicate: (q) => q.queryKey[1] !== 'lista' });
    return;
  }
  void qc.invalidateQueries({ queryKey: ['radar'] });
}
