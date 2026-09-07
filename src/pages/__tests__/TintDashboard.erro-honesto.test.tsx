import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard da classe "erro colapsado em vazio" — o card de ERROS que some calado.
 *
 * `useLastErrors` fazia `const { data } = await supabase…; return data ?? []` — sem ler
 * `error`. A query resolvia `success` com `[]`, e o `{errors && errors.length > 0 && …}`
 * apagava o card "Últimos Erros de Importação". Sobre uma fonte com 1.656 importações com
 * `registros_erro > 0` em prod (medido 2026-09-06,
 * docs/historico/a-forma-que-some-e-a-forma-que-mente.md).
 *
 * Sumir aqui não é neutro: um card cujo ASSUNTO é a existência de erro, ausente, afirma
 * "nenhum erro de importação". É ausência afirmando segurança — a falha mais cara que um
 * alarme pode ter, e a razão de a classe existir.
 *
 * O defeito é de CAMADA: enquanto o `queryFn` engolir o erro, `error` do react-query nunca
 * popula e <AvisoLeituraFalhou> é INALCANÇÁVEL por construção. Por isso o hook roda de
 * verdade aqui e só o supabase é mockado.
 */

type Resposta = { data: unknown; count?: number; error: { message: string; code?: string } | null };

const ERRO_PG = { message: 'canceling statement due to statement timeout', code: '57014' };

const IMPORT_COM_ERRO = {
  id: 'i1', tipo: 'formulas', arquivo_nome: 'lote-42.csv', registros_erro: 7,
  erros_detalhe: [{ linha: 3, motivo: 'corante inexistente' }],
  created_at: '2026-09-01T10:00:00Z',
};

const ULTIMA_IMPORTACAO = {
  tipo: 'formulas', created_at: '2026-09-02T10:00:00Z',
  registros_importados: 120, status: 'concluido',
};

let respostaErros: Resposta = { data: [], error: null };

/**
 * As DUAS leituras da tela batem na mesma tabela (`tint_importacoes`): a de métricas usa
 * `.maybeSingle()`, a de erros usa `.gt('registros_erro', 0)`. Discriminar por nome de tabela
 * confundiria as duas — o mock registra os MÉTODOS da cadeia, como o guard vizinho de
 * `tabs-erro-honesto`.
 */
function chain(table: string): unknown {
  const metodos: string[] = [];
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'gt', 'not', 'is', 'in', 'range', 'filter', 'maybeSingle', 'single']) {
    c[m] = () => { metodos.push(m); return c; };
  }
  c.then = (resolve: (v: unknown) => void) => {
    if (table === 'tint_importacoes' && metodos.includes('gt')) return resolve(respostaErros);
    if (table === 'tint_importacoes') return resolve({ data: ULTIMA_IMPORTACAO, count: 0, error: null });
    return resolve({ data: [], count: 0, error: null });
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
  },
}));
vi.mock('@/components/tarefas/RecorrentesHojeCard', () => ({ RecorrentesHojeCard: () => null }));

import TintDashboard from '../TintDashboard';

/** A frase do aviso — o que separa "não consegui" de "não há". */
const AVISO = /não quer dizer que está tudo certo/i;
/** O card cujo desaparecimento afirma "nenhum erro de importação". */
const CARD_ERROS = /Últimos Erros de Importação/i;

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <TintDashboard />
    </QueryClientProvider>,
  );
}

beforeEach(() => { onlineManager.setOnline(true); respostaErros = { data: [], error: null }; });
afterEach(() => { onlineManager.setOnline(true); });

describe('TintDashboard — o card de erros não pode SUMIR quando não conseguiu ler', () => {
  it('leitura OK com erros: o card aparece com a importação', async () => {
    respostaErros = { data: [IMPORT_COM_ERRO], error: null };
    renderDashboard();
    expect(await screen.findByText(CARD_ERROS)).toBeTruthy();
    expect(screen.getByText(/lote-42\.csv/)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('fonte VAZIA de verdade: o card some — o único silêncio legítimo', async () => {
    respostaErros = { data: [], error: null };
    renderDashboard();
    await screen.findByText(/Tintométrico — Dashboard/);
    await waitFor(() => expect(screen.queryByText(CARD_ERROS)).toBeNull());
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('ERRO de leitura: avisa em vez de sumir — o defeito da classe', async () => {
    respostaErros = { data: null, error: ERRO_PG };
    renderDashboard();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('OFFLINE (pending+paused): também avisa — isLoading é FALSE e data undefined', async () => {
    onlineManager.setOnline(false);
    respostaErros = { data: [IMPORT_COM_ERRO], error: null };
    renderDashboard();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('erro e fonte-vazia NÃO produzem a mesma tela (o colapso, medido)', async () => {
    respostaErros = { data: [], error: null };
    const vazio = renderDashboard();
    await screen.findByText(/Tintométrico — Dashboard/);
    await waitFor(() => expect(screen.queryByText(CARD_ERROS)).toBeNull());
    const telaVazia = vazio.container.textContent;
    vazio.unmount();

    respostaErros = { data: null, error: ERRO_PG };
    const erro = renderDashboard();
    await screen.findByText(AVISO);
    expect(erro.container.textContent).not.toBe(telaVazia);
  });

  it('o aviso é ANCORADO por testid, não pela copy (guard não casa desenho)', async () => {
    respostaErros = { data: null, error: ERRO_PG };
    renderDashboard();
    const aviso = await screen.findByTestId('aviso-importacoes-com-erro');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
  });
});
