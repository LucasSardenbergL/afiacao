import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LinhaPainel, PainelVenda, CandidatoRepasse } from '@/lib/venda-cliente/painel';

/**
 * Estados que o founder não pode ler errado: "não consegui medir" no lugar de 0%, o aviso de que
 * antes × depois não é prova causal, e o botão Aprovar que não promete o que a RPC recusa.
 */
const registrarNoLedger = vi.fn();
vi.mock('@/lib/analytics-ledger', () => ({ registrarNoLedger: (...a: unknown[]) => registrarNoLedger(...a) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'master-1' }, isMaster: true }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

let painelResposta: { data?: PainelVenda; isLoading: boolean; isError: boolean; error: unknown };
let candidatosResposta: CandidatoRepasse[] = [];
vi.mock('@/hooks/useVendaPainel', async (orig) => {
  const real = await orig<typeof import('@/hooks/useVendaPainel')>();
  return {
    ...real,
    useVendaPainel: () => ({ ...painelResposta, refetch: vi.fn() }),
    useAprovarRepasse: () => ({ mutate: vi.fn(), isPending: false }),
    useRepasseCandidatos: () => ({ data: candidatosResposta, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
    useNomesCompradores: () => ({ data: new Map([['c1', 'Lohan Móveis'], ['c2', 'Marcenaria X']]) }),
    useRevogarRepasse: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import VendaClientePainel from '@/pages/VendaClientePainel';
import { TabelaAdocao } from '../TabelaAdocao';
import { DialogAprovarRepasse } from '../DialogAprovarRepasse';
import { AbaRepasses } from '../AbaRepasses';

const vazio = { virou: 0, nao_virou: 0, nao_medivel: 0, pendentes: 0 };
function linha(over: Partial<LinhaPainel> = {}): LinhaPainel {
  return {
    farmer_user_id: 'f1', farmer_nome: 'Regina', semana: '2026-10-05',
    na_lista: 10, mostradas: 8, contatados: 9, compraram: 2,
    virou: 2, nao_virou: 6, nao_medivel: 0, pendentes: 0,
    receita_realizada: 1500, receita_incompleta: false, taxa_ativa: 0.25,
    na_lista_sombra: 0, base_historico: { ...vazio, virou: 1, nao_virou: 9 },
    taxa_base_historico_mesma_semana: 0.1, base_sombra: vazio, taxa_base_sombra: null,
    base_confiavel: true, ...over,
  };
}

function painel(over: Partial<PainelVenda> = {}): PainelVenda {
  return {
    hoje: '2026-10-20', periodo: { de: '2026-07-28', ate: '2026-10-25' }, base_confiavel: true,
    repasse_disponivel: false, linhas: [linha()],
    ondas: {
      onda_recompra: { ligada: false, ligada_em: null, condicao_ao_ligar: null, prerequisitos: {
        historico_dias: 100, historico_meta: 365, avaliada_hoje: false,
        sombra_ao_vivo: [{ dia: '2026-10-19', ao_vivo: false }, { dia: '2026-10-18', ao_vivo: false }, { dia: '2026-10-17', ao_vivo: false }] } },
      onda_complemento: { ligada: false, ligada_em: null, condicao_ao_ligar: null, prerequisitos: {
        onda_recompra_ligada: false, semanas: [] } },
      onda_preco: { ligada: false, ligada_em: null, condicao_ao_ligar: null, prerequisitos: {
        onda_complemento_ligada: false, repasse_vigente: null } },
    },
    ...over,
  };
}

function renderPagina() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/venda-cliente']}>
        <VendaClientePainel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  registrarNoLedger.mockReset();
  painelResposta = { data: painel(), isLoading: false, isError: false, error: null };
});

describe('TabelaAdocao', () => {
  it("renderiza 'não consegui medir' quando nao_medivel > 20%", () => {
    // 2 virou, 2 não virou, 2 não medível → 33% sem medição
    render(<TabelaAdocao linhas={[linha({ virou: 2, nao_virou: 2, nao_medivel: 2, taxa_ativa: 0.5 })]} baseConfiavel />);
    const corpo = screen.getAllByRole('row')[1];
    expect(within(corpo).getByText('não consegui medir')).toBeInTheDocument();
    expect(within(corpo).queryByText('50%')).not.toBeInTheDocument();
    expect(within(corpo).queryByText('0%')).not.toBeInTheDocument();
  });

  it('com medição completa mostra a taxa ativa e a base do ano anterior', () => {
    render(<TabelaAdocao linhas={[linha()]} baseConfiavel />);
    const corpo = screen.getAllByRole('row')[1];
    expect(within(corpo).getByText('25%')).toBeInTheDocument();
    expect(within(corpo).getByText('10%')).toBeInTheDocument();
  });

  it('base não confiável: a coluna da linha de base diz não consegui medir, nunca o número', () => {
    render(<TabelaAdocao linhas={[linha({ base_confiavel: false })]} baseConfiavel={false} />);
    const corpo = screen.getAllByRole('row')[1];
    expect(within(corpo).getByText('não consegui medir')).toBeInTheDocument();
    expect(within(corpo).queryByText('10%')).not.toBeInTheDocument();
  });

  it('sem venda casada a receita é —, nunca R$ 0', () => {
    render(<TabelaAdocao linhas={[linha({ receita_realizada: null, virou: 0, compraram: 0, taxa_ativa: 0 })]} baseConfiavel />);
    const corpo = screen.getAllByRole('row')[1];
    expect(within(corpo).queryByText(/R\$\s*0/)).not.toBeInTheDocument();
  });
});

describe('VendaClientePainel', () => {
  it('renderiza aviso não causal', () => {
    renderPagina();
    expect(screen.getByRole('note', { name: /antes × depois, não é prova causal/i })).toBeInTheDocument();
  });

  it('o aviso não causal fica mesmo quando a leitura falha', () => {
    painelResposta = { data: undefined, isLoading: false, isError: true, error: { message: 'boom' } };
    renderPagina();
    expect(screen.getByRole('note', { name: /não é prova causal/i })).toBeInTheDocument();
    expect(screen.getByText(/Não consegui carregar o painel/)).toBeInTheDocument();
  });

  it('registra venda.painel_aberto no ledger uma vez quando o dado chega', () => {
    renderPagina();
    expect(registrarNoLedger).toHaveBeenCalledTimes(1);
    expect(registrarNoLedger).toHaveBeenCalledWith('venda.painel_aberto', 'painel', expect.objectContaining({ farmers: 1 }));
  });
});

describe('DialogAprovarRepasse', () => {
  const candidato: CandidatoRepasse = {
    comprador_id: 'c1', empresa: 'oben', omie_codigo_produto: 123, descricao: 'Seladora PU 3,6L',
    status_defasagem: 'defasado', motivo: null, abaixo_piso: false, ultimo_preco: 100,
    data_ultima_compra: '2026-09-01', preco_sugerido: 95, alta_custo_perc: 8, valor_anual_recuperavel: null,
    n_pedidos: 5, cadencia_dias: 30, qtd_sugerida: 4, situacao_compra: 'comprando', dias_sem_comprar: 50,
    substituto: null, repasse_atual: null,
  };

  it('aprovar com preço abaixo do último bloqueia o botão', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <DialogAprovarRepasse candidato={candidato} nomeComprador="Marcenaria X" hoje="2026-10-20" aberto onAbertoChange={() => {}} />
      </QueryClientProvider>,
    );
    // pré-preenchido com o sugerido (95) < último (100)
    expect(screen.getByRole('button', { name: 'Aprovar' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/acima do último preço/);
  });
});

describe('AbaRepasses — situação de compra (20261031233000)', () => {
  const base: CandidatoRepasse = {
    comprador_id: 'c2', empresa: 'oben', omie_codigo_produto: 1, descricao: 'DILUENTE PU DF.4068LT',
    status_defasagem: 'defasado', motivo: null, abaixo_piso: false, ultimo_preco: 100,
    data_ultima_compra: '2026-10-20', preco_sugerido: 110, alta_custo_perc: 8, valor_anual_recuperavel: 500,
    n_pedidos: 5, cadencia_dias: 14, qtd_sugerida: 4, situacao_compra: 'comprando', dias_sem_comprar: 11,
    substituto: null, repasse_atual: null,
  };
  const substituido: CandidatoRepasse = {
    ...base, comprador_id: 'c1', omie_codigo_produto: 2, descricao: 'DILUENTE PU DFA.4128LT',
    preco_sugerido: null, valor_anual_recuperavel: null, situacao_compra: 'substituido', dias_sem_comprar: 144,
    substituto: {
      omie_codigo_produto: 3, codigo: 'PRD03666', descricao: 'DILUENTE PU DFA.4080LT',
      primeira_compra: '2026-06-24', ultima_compra: '2026-10-27', dias_com_compra: 7,
    },
  };

  function grupo(titulo: RegExp) {
    return screen.getByRole('heading', { name: titulo }).closest('section') as HTMLElement;
  }

  it('quem segue comprando oferece Aprovar; o substituído mostra o substituto e NÃO oferece Aprovar', () => {
    candidatosResposta = [base, substituido];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AbaRepasses disponivel hoje="2026-10-31" />
      </QueryClientProvider>,
    );
    // detector: no grupo de quem compra o botão existe (o assert de ausência abaixo enxerga o botão)
    expect(within(grupo(/Segue comprando/)).getByRole('button', { name: 'Aprovar' })).toBeTruthy();
    const sub = grupo(/Substituído — não é repasse/);
    expect(within(sub).queryByRole('button', { name: 'Aprovar' })).toBeNull();
    expect(within(sub).getByText(/DFA\.4080LT desde 24\/06\/26 \(7 compras\)/)).toBeTruthy();
    expect(within(sub).getByText('sem comprar há 144 d')).toBeTruthy();
  });

  it('sem cadência vai para o grupo próprio, não para "Segue comprando"', () => {
    candidatosResposta = [base, { ...base, comprador_id: 'c1', omie_codigo_produto: 9, situacao_compra: null, dias_sem_comprar: 100 }];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AbaRepasses disponivel hoje="2026-10-31" />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { name: /Segue comprando \(1\)/ })).toBeTruthy();
    expect(within(grupo(/Sem cadência/)).getByText('sem comprar há 100 d')).toBeTruthy();
  });

  it('substituído com repasse VIGENTE segue revogável', () => {
    candidatosResposta = [{
      ...substituido,
      repasse_atual: { id: 'r1', preco_alvo: 120, valido_ate: '2026-12-31', revogado: false, vigente: true },
    }];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AbaRepasses disponivel hoje="2026-10-31" />
      </QueryClientProvider>,
    );
    const sub = grupo(/Substituído — não é repasse/);
    expect(within(sub).getByRole('button', { name: 'Revogar' })).toBeTruthy();
    expect(within(sub).queryByRole('button', { name: 'Alterar' })).toBeNull();
  });
});
