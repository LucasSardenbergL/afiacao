import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { aplicarLeadNasPaginas, type RadarEmpresa, type RadarFiltros } from '@/queries/useRadarLista';
import { buscarEmpresaRadarFresca } from '@/queries/useRadarEmpresa';

/**
 * Invalidação ÚNICA do cache do Radar depois de uma mutação (registro de contato, desfazer, cadastro no Omie,
 * descarte em lote, fim do lote de cadastro). Antes cada mutação listava as próprias chaves e o descarte em lote
 * esquecia `['radar','amostra']`: o lead de controle descartado seguia intercalado na fila (achado Codex, pacote A2).
 * Agora TUDO sob `['radar']` invalida — a amostra, os KPIs, os sugeridos, o mapa, os contatos e os conflitos
 * entram juntos, inclusive as chaves que nascerem depois.
 *
 * `reiniciarLista`: ação em lote. A fila pagina por offset e os leads tratados saem dela — refazer as páginas
 * carregadas pularia empresas, então a lista RECOMEÇA do topo (reset, aguardado) e o resto só invalida.
 *
 * `cnpj`: ação sobre UM lead (pacote N). Reler a fila inteira custava uma `radar_lista` por página carregada
 * (10 páginas = 10 leituras a cada contato) e a lista piscava e reordenava sob o dedo. Agora:
 *   - a FILA troca só a linha do lead pela leitura fresca dele (ou a tira, se ele saiu do recorte) — ver
 *     `aplicarLeadNasPaginas`; quando não dá para decidir daqui, relê como antes;
 *   - o MAPA e o RANKING (agregados por município, lidos de tabela pré-calculada) só ficam velhos: um contato
 *     não move a contagem de agora, e a próxima abertura relê;
 *   - todo o resto sob `['radar']` (ficha, KPIs, atendimentos, sugeridos, amostra…) relê como antes.
 * A invalidação não é aguardada por quem chama: o retorno só assenta depois da troca na fila (os testes esperam).
 */
const AGREGADOS_GEO = new Set<unknown>(['contagem-municipios', 'penetracao-municipios']);

export async function invalidarRadar(
  qc: QueryClient,
  opcoes: { reiniciarLista?: boolean; cnpj?: string | null } = {},
): Promise<void> {
  if (opcoes.reiniciarLista) {
    await qc.resetQueries({ queryKey: ['radar', 'lista'] });
    void qc.invalidateQueries({ queryKey: ['radar'], predicate: (q) => q.queryKey[1] !== 'lista' });
    return;
  }
  const cnpj = opcoes.cnpj;
  if (!cnpj) {
    void qc.invalidateQueries({ queryKey: ['radar'] });
    return;
  }
  void qc.invalidateQueries({
    queryKey: ['radar'],
    predicate: (q) => q.queryKey[1] !== 'lista' && !AGREGADOS_GEO.has(q.queryKey[1]),
  });
  void qc.invalidateQueries({
    queryKey: ['radar'],
    predicate: (q) => AGREGADOS_GEO.has(q.queryKey[1]),
    refetchType: 'none',
  });
  await atualizarLeadNaFila(qc, cnpj);
}

type PaginasFila = InfiniteData<RadarEmpresa[], unknown>;

async function atualizarLeadNaFila(qc: QueryClient, cnpj: string): Promise<void> {
  const filas = qc.getQueryCache().findAll({ queryKey: ['radar', 'lista'] });
  // Fila sem ninguém olhando: só fica velha (relê ao voltar à tela), como fazia o invalidate de antes.
  void qc.invalidateQueries({ queryKey: ['radar', 'lista'], predicate: (q) => !q.isActive(), refetchType: 'none' });
  const ativas = filas.filter((q) => q.isActive());
  if (ativas.length === 0) return;
  const reler = (chave: readonly unknown[]) => qc.invalidateQueries({ queryKey: chave, exact: true });
  let lead: RadarEmpresa | null;
  try {
    lead = await buscarEmpresaRadarFresca(qc, cnpj);
  } catch {
    // Sem a leitura do lead não dá para trocar a linha: relê a fila (o comportamento de antes), nunca a deixa velha.
    await Promise.all(ativas.map((q) => reler(q.queryKey)));
    return;
  }
  await Promise.all(ativas.map(async (q) => {
    const [, , filtros, , , , visao] = q.queryKey as [string, string, RadarFiltros, unknown, unknown, unknown, string];
    // Página em voo: o fetch monta sobre o dado de quando começou e apagaria a troca — relê inteiro.
    if (q.state.fetchStatus === 'fetching') return reler(q.queryKey);
    const r = aplicarLeadNasPaginas(q.state.data as PaginasFila | undefined, filtros, visao, cnpj, lead);
    if (r.tipo === 'reler') return reler(q.queryKey);
    if (r.tipo === 'trocar') qc.setQueryData<PaginasFila>(q.queryKey, r.data);
  }));
}
