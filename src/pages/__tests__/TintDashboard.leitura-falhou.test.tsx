import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard — o dashboard do tintométrico não pode FABRICAR zeros nem sumir calado quando não lê.
 *
 * Duas formas de engolir o erro conviviam neste arquivo:
 *  - `useLastErrors` nem desestruturava `error` (`return data ?? []`) ⇒ o card "Últimos Erros de
 *    Importação" SOME, sobre 2.124 importações com erro (psql-ro, 2026-09-07);
 *  - `useMetrics` não olhava `error` em NENHUMA das 6 leituras e devolvia `count ?? 0` ⇒ 5 KPIs
 *    viravam "0" e o card da última importação AFIRMAVA "Nenhuma importação" sobre 64.175 linhas.
 *    O zero fabricado é o §2 do money-path (ausente ≠ zero) — `tint_formulas` tem 994.882 linhas.
 *
 * Nos dois casos o `error` do react-query nunca populava e o aviso era inalcançável por
 * construção: a correção começa no `queryFn`, não na UI
 * (docs/historico/a-forma-que-some-e-a-forma-que-mente.md, sítio #3 da ordem por dano).
 *
 * A PÁGINA roda de verdade — os dois hooks são os do componente, só o supabase é mockado.
 * `ImpersonationContext` é módulo `plataforma` ⇒ mocká-lo não cria aresta de fronteira; o
 * `RecorrentesHojeCard` (módulo `tarefas`) NÃO é mockado de propósito — ele lê pelo supabase já
 * mockado, não acha tarefa e se auto-oculta, e mocká-lo por caminho custaria uma aresta
 * tintometrico→tarefas por ficção do teste (`vi.mock` conta como import).
 */
type Resposta = { data: unknown; error: { message: string } | null; count: number | null };

const ERRO = { message: 'permission denied' };

/** Qual leitura falha nesta rodada — nomeadas, porque alimentam partes distintas da tela. */
/**
 * `metricas` falha as 6 leituras juntas; `so-contagem` e `contagem-nula` isolam as tabelas de
 * COUNT da `.maybeSingle()` da última importação — sem isso o `throw` do `lastImport.error`
 * cobriria o guard de `contagem()` e a camada passaria verde por REDUNDÂNCIA, não por desenho.
 */
let falha: 'nenhuma' | 'metricas' | 'erros' | 'so-contagem' | 'contagem-nula' | 'erro-com-contagem' = 'nenhuma';
let listaErros: unknown[] = [];
let ultimaImportacao: unknown = null;

const CONTAGENS = {
  formulas: 994882,
  skusTodos: 220,
  skusMapeados: 180,
  corantesTodos: 14,
  corantesMapeados: 10,
};

const importacaoComErro = (over: Record<string, unknown> = {}) => ({
  id: 'e1', tipo: 'formulas', arquivo_nome: 'lote-42.csv', registros_erro: 7,
  erros_detalhe: [{ linha: 3, motivo: 'corante desconhecido' }],
  created_at: '2026-09-07T08:00:00Z', ...over,
});

const importacaoOk = () => ({
  tipo: 'formulas', created_at: '2026-09-07T08:00:00Z',
  registros_importados: 1200, status: 'concluido',
});

/**
 * As 6 leituras de `useMetrics` batem em 4 tabelas — `tint_skus` e `tint_corantes` aparecem DUAS
 * vezes cada, e o discriminador é o `.not('omie_product_id','is',null)` que só a versão "mapeados"
 * aplica. `tint_importacoes` também é lida duas vezes: o `.gt('registros_erro', 0)` é o que separa
 * o card de erros da última importação. Responder só pelo nome da tabela colapsaria os pares.
 */
function resposta(tabela: string, chamados: Set<string>): Resposta {
  const vazio = { data: null, error: null, count: null };
  if (tabela === 'tint_importacoes' && chamados.has('gt')) {
    return falha === 'erros'
      ? { ...vazio, error: ERRO }
      : { ...vazio, data: listaErros };
  }
  if (falha === 'metricas') return { ...vazio, error: ERRO };
  const ehContagem = tabela === 'tint_formulas' || tabela === 'tint_skus' || tabela === 'tint_corantes';
  // só as tabelas de COUNT falham — a `.maybeSingle()` da última importação responde normal
  if (ehContagem && falha === 'so-contagem') return { ...vazio, error: ERRO };
  // e o eixo do OUTRO guard: resposta OK, sem erro, mas sem a contagem pedida
  if (ehContagem && falha === 'contagem-nula') return vazio;
  // erro COM contagem preenchida: o único eixo que o guard `if (r.count == null)` não vê, e por
  // isso o dente próprio do `if (r.error)`. Sem ele os dois guards seriam indistinguíveis no teste.
  if (ehContagem && falha === 'erro-com-contagem') {
    return { data: null, error: ERRO, count: CONTAGENS.formulas };
  }
  if (tabela === 'tint_formulas') return { ...vazio, count: CONTAGENS.formulas };
  if (tabela === 'tint_skus') {
    return { ...vazio, count: chamados.has('not') ? CONTAGENS.skusMapeados : CONTAGENS.skusTodos };
  }
  if (tabela === 'tint_corantes') {
    return { ...vazio, count: chamados.has('not') ? CONTAGENS.corantesMapeados : CONTAGENS.corantesTodos };
  }
  if (tabela === 'tint_importacoes') return { ...vazio, data: ultimaImportacao };
  return vazio;
}

function chain(tabela: string): unknown {
  const chamados = new Set<string>();
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
  ]) {
    c[m] = () => { chamados.add(m); return c; };
  }
  c.then = (resolve: (v: Resposta) => void) => resolve(resposta(tabela, chamados));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false }),
}));
// O `RecorrentesHojeCard` (deixado rodando de verdade) chega em `useAuth` por dentro do
// `useMinhasRecorrentesHoje`, e sem Provider ele LANÇA e derruba a página inteira — o guard
// morreria no host, não na leitura que ele fiscaliza. `AuthContext` é plataforma ⇒ sem aresta.
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isAdmin: true, isStaff: true }),
}));

import TintDashboard from '../TintDashboard';

/** A frase do aviso — o que separa "não consegui ler" de "não há". */
const AVISO = /não quer dizer que está tudo certo/i;
const FRASE_SEM_IMPORTACAO = /Nenhuma importação/i;
const TITULO_ERROS = /Últimos Erros de Importação/i;

function novoQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function renderPagina(qc = novoQc()) {
  return render(
    <QueryClientProvider client={qc}>
      <TintDashboard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  onlineManager.setOnline(true);
  falha = 'nenhuma';
  listaErros = [importacaoComErro()];
  ultimaImportacao = importacaoOk();
});
afterEach(() => { onlineManager.setOnline(true); });

describe('TintDashboard — métricas ilegíveis NÃO podem virar zeros', () => {
  it('CONTROLE: leitura boa → os números reais aparecem e NÃO há aviso', async () => {
    renderPagina();
    expect(await screen.findByText('994.882')).toBeTruthy();
    // os dois KPIs de mapeamento vivem num nó de texto SÓ ("180 / 220") — casar '180' sozinho
    // não acharia nada, porque `getNodeText` concatena os filhos de texto diretos do elemento.
    expect(screen.getByText('180 / 220')).toBeTruthy();
    expect(screen.getByText('10 / 14')).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
    expect(screen.queryByText(FRASE_SEM_IMPORTACAO)).toBeNull();
  });

  it('ERRO nas métricas: avisa, e os KPIs mostram travessão em vez de ZERO fabricado', async () => {
    falha = 'metricas';
    renderPagina();

    const aviso = await screen.findByTestId('aviso-leitura-metricas');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    // o defeito da classe: `count ?? 0` afirmava 0 fórmulas sobre 994.882 linhas
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByText('994.882')).toBeNull();
    // e o card da última importação parava de afirmar o vazio
    expect(screen.queryByText(FRASE_SEM_IMPORTACAO)).toBeNull();
  });

  it('ERRO só nas CONTAGENS: avisa — o throw da última importação não cobre este eixo', async () => {
    falha = 'so-contagem';
    renderPagina();

    const aviso = await screen.findByTestId('aviso-leitura-metricas');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByText('994.882')).toBeNull();
  });

  it('contagem AUSENTE sem erro: também avisa — `count ?? 0` fabricaria zero por outra porta', async () => {
    falha = 'contagem-nula';
    renderPagina();

    const aviso = await screen.findByTestId('aviso-leitura-metricas');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    // o zero que o `?? 0` inventaria sobre 994.882 linhas não chega à tela
    expect(screen.queryByText('0')).toBeNull();
  });

  it('erro COM contagem preenchida: avisa — este eixo só o guard de `error` enxerga', async () => {
    falha = 'erro-com-contagem';
    renderPagina();

    const aviso = await screen.findByTestId('aviso-leitura-metricas');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    // a contagem VEIO, mas veio junto de um erro: exibi-la seria confiar num número não autorizado
    expect(screen.queryByText('994.882')).toBeNull();
  });

  it('CONTROLE do vazio REAL: leu e não há importação → a frase é dita, e é VERDADE', async () => {
    ultimaImportacao = null;
    renderPagina();
    expect(await screen.findByText(FRASE_SEM_IMPORTACAO)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('OFFLINE (pending+paused): avisa — isLoading é FALSE e data undefined', async () => {
    onlineManager.setOnline(false);
    renderPagina();

    const aviso = await screen.findByTestId('aviso-leitura-metricas');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
    expect(screen.queryByText(FRASE_SEM_IMPORTACAO)).toBeNull();
  });

  it('DADO EM CACHE + refetch que FALHA: avisa SEM apagar os números (o composto)', async () => {
    // Este é o ramo `status:'error'` de `desatualizado()` — determinístico, sem depender do
    // instante em que o `onlineManager` pausa um refetch. O ramo `paused` do MESMO helper está
    // coberto pelo composto do card de erros, logo abaixo: juntos cobrem os dois.
    const qc = novoQc();
    renderPagina(qc);
    expect(await screen.findByText('994.882')).toBeTruthy();
    expect(screen.queryByTestId('aviso-leitura-metricas')).toBeNull();

    falha = 'metricas';
    void qc.refetchQueries({ queryKey: ['tint-dashboard-metrics'] });

    const aviso = await screen.findByTestId('aviso-leitura-metricas');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    // e os números CONTINUAM na tela, com o aviso ao lado — apagar 994.882 fórmulas já lidas
    // porque um refetch falhou seria trocar um defeito por outro.
    expect(screen.getByText('994.882')).toBeTruthy();
  });

  it('erro e vazio real NÃO produzem a mesma tela (o colapso, medido)', async () => {
    ultimaImportacao = null;
    listaErros = [];
    const vazia = renderPagina();
    await screen.findByText(FRASE_SEM_IMPORTACAO);
    const telaVazia = vazia.container.textContent;
    vazia.unmount();

    falha = 'metricas';
    const erro = renderPagina();
    await screen.findByTestId('aviso-leitura-metricas');
    expect(erro.container.textContent).not.toBe(telaVazia);
  });
});

describe('TintDashboard — o card de erros de importação NÃO pode sumir calado', () => {
  it('CONTROLE: há erros → o card aparece e NÃO há aviso', async () => {
    renderPagina();
    expect(await screen.findByText(TITULO_ERROS)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('CONTROLE do vazio REAL: leu e não há erro → o card some, e isso é HONESTO', async () => {
    listaErros = [];
    renderPagina();
    await waitFor(() => expect(screen.queryByText(TITULO_ERROS)).toBeNull());
    expect(screen.queryByTestId('aviso-leitura-erros')).toBeNull();
  });

  it('ERRO de leitura: avisa em vez de sumir — a ausência afirmava "nenhum erro"', async () => {
    falha = 'erros';
    renderPagina();

    const aviso = await screen.findByTestId('aviso-leitura-erros');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    // âncora PRÓPRIA: o guard desta leitura não pode passar verde pelo aviso das métricas
    expect(screen.queryByTestId('aviso-leitura-metricas')).toBeNull();
  });

  it('OFFLINE: o card de erros também avisa', async () => {
    onlineManager.setOnline(false);
    renderPagina();

    const aviso = await screen.findByTestId('aviso-leitura-erros');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
  });

  it('DADO EM CACHE + offline no refetch: avisa SEM apagar os erros já lidos (o composto)', async () => {
    const qc = novoQc();
    renderPagina(qc);
    expect(await screen.findByText(TITULO_ERROS)).toBeTruthy();
    expect(screen.queryByTestId('aviso-leitura-erros')).toBeNull();

    onlineManager.setOnline(false);
    void qc.invalidateQueries();

    const aviso = await screen.findByTestId('aviso-leitura-erros');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
    // apagar erros de importação REAIS porque um refetch falhou seria trocar um defeito por outro
    expect(screen.getByText(TITULO_ERROS)).toBeTruthy();
  });
});
