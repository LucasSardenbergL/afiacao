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
let falha: 'nenhuma' | 'metricas' | 'erros' | 'origem' | 'so-contagem' | 'contagem-nula' | 'erro-com-contagem' = 'nenhuma';
/** Marcas `personalizada` por cor — o que as 3 leituras de origem (formulas/versões/staging) devolvem. */
let marcasOrigem: Record<string, Array<{ cor_id: string; personalizada: boolean }>> = {};
let listaErros: unknown[] = [];
let ultimoRun: unknown = null;
let ultimaImportacao: unknown = null;

const CONTAGENS = {
  formulas: 994882,
  skusTodos: 220,
  skusMapeados: 180,
  corantesTodos: 14,
  corantesMapeados: 10,
};

/**
 * Linhas de `tint_sync_errors` da janela — a cor `303U - BS` aparece 3 vezes no MESMO run (uma por
 * produto/embalagem) de propósito: o card tem que DEDUPLICAR por cor e contar. O `error_details`
 * tem a forma real de prod (psql-ro 21/10/2026): é dele que sai o QUE está errado na receita.
 */
const MSG_SEM_DOSE =
  'receita corrompida: corante presente sem dose válida (qtd_ml <= 0/nula/não-finita) + linha inválida sob protocolo declarado (1d-E) — fórmula PRETO/0,9L';
const MSG_ORFAO =
  'receita corrompida: dose sem corante identificado (item órfão) + linha inválida sob protocolo declarado (1d-E) — fórmula 303U - BS/3,6L';
const DET_ORFAO = {
  cod_produto: 'FO10.6554', id_base: '15',
  itens: [
    { ordem: 1, id_corante: '2', qtd_ml: 12.7, viola: false },
    { ordem: 4, id_corante: '', qtd_ml: 2.4645, viola: true },
  ],
};
const DET_SLOT_LIVRE = {
  cod_produto: 'FO10.6554', id_base: '15',
  itens: [
    { ordem: 1, id_corante: '3', qtd_ml: 25.1, viola: false },
    ...[2, 3, 4, 5, 6].map((ordem) => ({ ordem, id_corante: '0', qtd_ml: 0, viola: true })),
  ],
};
const erro = (entity_id: string, error_message: string, error_details: unknown) => ({
  sync_run_id: 'run-1', entity_type: 'formula_promote', entity_id, error_message, error_details,
});
const errosDoRun = () => [
  erro('303U - BS', MSG_ORFAO, DET_ORFAO),
  erro('303U - BS', MSG_ORFAO, DET_ORFAO),
  erro('303U - BS', MSG_ORFAO, DET_ORFAO),
  erro('PRETO', MSG_SEM_DOSE, DET_SLOT_LIVRE),
];
const runComErro = (over: Record<string, unknown> = {}) => ({
  id: 'run-1', started_at: '2026-10-16T22:45:14Z', errors: 4, ...over,
});

const importacaoOk = () => ({
  tipo: 'formulas', created_at: '2026-09-07T08:00:00Z',
  registros_importados: 1200, status: 'concluido',
});

/**
 * As 6 leituras de `useMetrics` batem em 4 tabelas — `tint_skus` e `tint_corantes` aparecem DUAS
 * vezes cada, e o discriminador é o `.not('omie_product_id','is',null)` que só a versão "mapeados"
 * aplica. `tint_importacoes` responde só a última importação (`.maybeSingle()`) — o card de
 * rejeições NÃO lê mais dela: o detalhe vive em `tint_sync_errors`, nunca em `erros_detalhe`.
 * a leitura aqui. Responder só pelo nome da tabela colapsaria os pares.
 */
function resposta(tabela: string, chamados: Set<string>): Resposta {
  const vazio = { data: null, error: null, count: null };
  // O card de rejeições lê DUAS tabelas: os runs de fórmulas da janela e as linhas de erro deles.
  // `falha === 'erros'` derruba a segunda — é a leitura que alimenta a lista.
  // `.maybeSingle()` é o último run (âncora da janela); sem ele é a lista de runs da janela.
  if (tabela === 'tint_sync_runs') {
    if (chamados.has('maybeSingle')) return { ...vazio, data: ultimoRun };
    return { ...vazio, data: ultimoRun ? [ultimoRun] : [] };
  }
  if (tabela === 'tint_sync_errors') {
    return falha === 'erros'
      ? { ...vazio, error: ERRO }
      : { ...vazio, data: listaErros };
  }
  // A separação personalizada × fábrica lê `cor_id, personalizada` por `.in('cor_id', …)` — o
  // `in` é o que a distingue das contagens de `tint_formulas`.
  if (chamados.has('in')) {
    if (falha === 'origem') return { ...vazio, error: ERRO };
    return { ...vazio, data: chamados.has('range') && marcasOrigem[tabela] ? marcasOrigem[tabela] : [] };
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
const TITULO_ERROS = /Fórmulas rejeitadas pela fonte/i;

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
  listaErros = errosDoRun();
  ultimoRun = runComErro();
  ultimaImportacao = importacaoOk();
  // 303U - BS é de fábrica (só na formulas atual); PRETO é personalizada e só a staging a conhece.
  marcasOrigem = {
    tint_formulas: [{ cor_id: '303U - BS', personalizada: false }],
    tint_receita_versoes: [],
    tint_staging_formulas: [{ cor_id: 'PRETO', personalizada: true }],
  };
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
    ultimoRun = runComErro({ errors: 0 });
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

  it('CONTROLE do vazio REAL: leu e a janela não rejeitou nada → o card some, e isso é HONESTO', async () => {
    listaErros = [];
    ultimoRun = runComErro({ errors: 0 });
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

  it('sem NENHUM run de fórmulas: o card some sem avisar — não há o que listar', async () => {
    ultimoRun = null;
    listaErros = [];
    renderPagina();
    await waitFor(() => expect(screen.queryByText(TITULO_ERROS)).toBeNull());
    expect(screen.queryByTestId('aviso-leitura-erros')).toBeNull();
  });

  it('DEDUPLICA por cor e CONTA as fórmulas: 3 linhas de 303U - BS viram UMA entrada com "3 fórmulas"', async () => {
    renderPagina();
    expect(await screen.findByText(TITULO_ERROS)).toBeTruthy();
    expect(screen.getAllByText('303U - BS')).toHaveLength(1);
    expect(screen.getByText('3 fórmulas')).toBeTruthy();
    expect(screen.getByText('1 fórmula')).toBeTruthy();
    // 2 cores na janela — a contagem do cabeçalho é de CORES, não de linhas
    expect(screen.getByText(/2 cores/)).toBeTruthy();
  });

  it('diz O QUE está errado: agrupa por tipo e mostra slot e dose — não só a classe do guard', async () => {
    renderPagina();
    expect(await screen.findByText(TITULO_ERROS)).toBeTruthy();
    const orfao = screen.getByTestId('rejeicao-grupo-dose_sem_corante');
    expect(orfao.textContent).toContain('303U - BS');
    expect(orfao.textContent).toContain('slot 4: 2,46 ml sem corante');
    const livre = screen.getByTestId('rejeicao-grupo-slot_livre');
    expect(livre.textContent).toContain('PRETO');
    expect(livre.textContent).toContain('slots 2, 3, 4, 5 e 6 vazios');
    expect(screen.queryByTestId('rejeicao-grupo-outro')).toBeNull();
    expect(screen.queryByText(/qtd_ml/)).toBeNull();
  });

  it('detalhe ilegível: cai em "outros" com o motivo CURTO do guard — nunca inventa o tipo', async () => {
    listaErros = [erro('PRETO', MSG_SEM_DOSE, null)];
    renderPagina();
    const outro = await screen.findByTestId('rejeicao-grupo-outro');
    expect(outro.textContent).toContain('receita corrompida: corante presente sem dose válida');
    expect(outro.textContent).not.toContain('1d-E');
  });

  it('o card diz DE QUANDO é o run — a lista é um retrato do último sync, não um histórico', async () => {
    renderPagina();
    expect(await screen.findByText(/16\/10\/2026/)).toBeTruthy();
  });

  it('runs com errors>0 mas SEM linhas de detalhe: mostra a contagem dos runs e diz que o detalhe faltou — nunca "tudo certo"', async () => {
    listaErros = [];
    ultimoRun = runComErro({ errors: 4 });
    renderPagina();
    expect(await screen.findByText(TITULO_ERROS)).toBeTruthy();
    expect(screen.getByText(/4 rejeições sem detalhe/)).toBeTruthy();
  });

  it('SEPARA o que é da loja do que é da fábrica — cada cor no lado de quem corrige', async () => {
    renderPagina();
    const personalizadas = await screen.findByTestId('rejeicao-origem-personalizada');
    const fabrica = screen.getByTestId('rejeicao-origem-fabrica');
    expect(personalizadas.textContent).toContain('PRETO');
    expect(personalizadas.textContent).not.toContain('303U - BS');
    expect(fabrica.textContent).toContain('303U - BS');
    expect(fabrica.textContent).not.toContain('PRETO');
    expect(screen.queryByTestId('rejeicao-origem-nao_sei')).toBeNull();
    expect(screen.queryByTestId('origem-nao-lida')).toBeNull();
  });

  it('lado sem cor diz "nenhuma" (leu e não há); cor sem marca ou com as DUAS vai para "não identificada"', async () => {
    marcasOrigem = {
      tint_formulas: [{ cor_id: '303U - BS', personalizada: true }, { cor_id: '303U - BS', personalizada: false }],
      tint_receita_versoes: [],
      tint_staging_formulas: [{ cor_id: 'PRETO', personalizada: true }],
    };
    renderPagina();
    const naoSei = await screen.findByTestId('rejeicao-origem-nao_sei');
    expect(naoSei.textContent).toContain('303U - BS');
    expect(screen.getByTestId('rejeicao-origem-fabrica').textContent).toMatch(/Nenhuma nas últimas 24h/);
  });

  it('origem ILEGÍVEL: a lista fica de pé, sem separação, e AVISA — nunca joga tudo num lado', async () => {
    falha = 'origem';
    renderPagina();
    expect(await screen.findByTestId('origem-nao-lida')).toBeTruthy();
    expect(screen.getByText('303U - BS')).toBeTruthy();
    expect(screen.getByText('PRETO')).toBeTruthy();
    expect(screen.queryByTestId('rejeicao-origem-personalizada')).toBeNull();
    expect(screen.queryByTestId('rejeicao-origem-fabrica')).toBeNull();
  });
});
