import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BotoesDesfechoRecomendacao } from '../BotoesDesfechoRecomendacao';
import { useFarmerDesfecho, mensagemDoErro, MOTIVOS_RECUSA } from '@/hooks/useFarmerDesfecho';

const impMock = vi.fn(() => ({ isImpersonating: false }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
const toastMock = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
vi.mock('sonner', () => ({ toast: toastMock }));
/**
 * O retorno é tipado à mão porque `vi.fn(async () => ({data:null,error:null}))` INFERE
 * `error: null` como o tipo, e todo `mockResolvedValue` com erro vira TS2322. Os
 * argumentos idem: sem `..._a`, `mock.calls[0]` é `[]` e o cast para ler o payload
 * vira TS2352. (Pego pelo `Type check (strict)` do CI, que checa os testes também.)
 */
type RpcRet = { data: unknown; error: { code?: string; message: string } | null };
type RpcArgs = [string, Record<string, unknown>];
const rpcMock = vi.fn(async (..._a: unknown[]): Promise<RpcRet> => ({ data: null, error: null }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));

import { track } from '@/lib/analytics';
const eventos = () => (track as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, unknown>][];

const ALVO = { customerId: 'cli-1', productId: 'prod-1', type: 'cross_sell' as const };

beforeEach(() => {
  impMock.mockReturnValue({ isImpersonating: false });
  rpcMock.mockResolvedValue({ data: null, error: null });
  vi.clearAllMocks();
});

/** Monta o componente com o hook REAL — o writer é o que está sob teste. */
const Host = ({ alvo = ALVO }: { alvo?: typeof ALVO }) => {
  const registro = useFarmerDesfecho();
  return <BotoesDesfechoRecomendacao alvo={alvo} registro={registro} />;
};

describe('CONTROLE POSITIVO — a superfície existe antes de afirmar que ela mede algo', () => {
  // Sem este teste, todos os outros poderiam passar num componente que não renderiza
  // nada. Ele é o denominador: prova que a fixture PRODUZ os dois alvos de registro.
  it('[SENSOR] os dois botões de desfecho estão na face do card', () => {
    render(<Host />);
    expect(screen.getByRole('button', { name: 'Cliente comprou' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cliente recusou' })).toBeInTheDocument();
  });
});

describe('o aceite grava UM fato', () => {
  it('[SENSOR] "Comprou" chama a RPC com desfecho aceito e motivo null', async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    const [nome, args] = rpcMock.mock.calls[0] as unknown as RpcArgs;
    expect(nome).toBe('farmer_recomendacao_registrar_desfecho');
    expect(args.p_desfecho).toBe('aceito');
    expect(args.p_customer_user_id).toBe('cli-1');
    expect(args.p_product_id).toBe('prod-1');
    expect(args.p_recommendation_type).toBe('cross_sell');
    // [money-path: ausente ≠ zero] `null` EXPLÍCITO, nunca undefined nem string vazia:
    // undefined sumiria do JSON e deixaria o default do Postgres decidir por nós.
    expect(args.p_motivo).toBeNull();
  });

  it('[SENSOR] o card passa a exibir o fato e some com os botões', async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));
    await waitFor(() => expect(screen.getByText('Venda registrada')).toBeInTheDocument());
    // Reabrir a decisão ofereceria uma ação que a trigger trg_frec_desfecho_imutavel
    // recusa — o toast de erro puniria quem só se enganou no toque.
    expect(screen.queryByRole('button', { name: 'Cliente comprou' })).toBeNull();
  });
});

describe('a recusa exige o PORQUÊ — é o motivo que calibra, não o placar', () => {
  it('[SENSOR] "Recusou" NÃO grava direto: abre o motivo', async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente recusou' }));
    await waitFor(() => expect(screen.getByText('Por que o cliente recusou?')).toBeInTheDocument());
    // O ponto: nenhuma escrita aconteceu ainda.
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('[SENSOR] escolher o motivo grava rejeitado COM o motivo', async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente recusou' }));
    await waitFor(() => screen.getByText('Por que o cliente recusou?'));
    fireEvent.click(screen.getByRole('button', { name: 'Preço' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    const args = (rpcMock.mock.calls[0] as unknown as RpcArgs)[1];
    expect(args.p_desfecho).toBe('rejeitado');
    expect(args.p_motivo).toBe('preco');
  });

  it('[SENSOR] o vocabulário do dialog é EXATAMENTE o do CHECK da tabela', () => {
    // Um rótulo a mais aqui é um clique que o banco recusa com 23514. A migration
    // farmer_recommendations_motivo_coerente lista estes seis e só estes.
    expect(MOTIVOS_RECUSA.map((m) => m.valor)).toEqual([
      'preco', 'sem_necessidade', 'ja_compra_concorrente', 'sem_estoque', 'prazo_entrega', 'outro',
    ]);
  });

  it('[SENSOR] o dialog NÃO fecha quando o banco recusa', async () => {
    // Fechar esconderia o toast de erro atrás do card e ela acharia que registrou —
    // um desfecho fantasma na cabeça da vendedora e zero linha no banco.
    rpcMock.mockResolvedValue({ data: null, error: { code: 'FD004', message: 'x' } });
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente recusou' }));
    await waitFor(() => screen.getByText('Por que o cliente recusou?'));
    fireEvent.click(screen.getByRole('button', { name: 'Preço' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(screen.getByText('Por que o cliente recusou?')).toBeInTheDocument();
  });
});

describe('a lente "Ver como" não registra na carteira alheia', () => {
  it('[LENTE] os botões ficam desabilitados e nada é gravado', () => {
    impMock.mockReturnValue({ isImpersonating: true });
    render(<Host />);
    const comprou = screen.getByRole('button', { name: 'Cliente comprou' });
    expect(comprou).toBeDisabled();
    fireEvent.click(comprou);
    expect(rpcMock).not.toHaveBeenCalled();
    // Defesa em profundidade: mesmo se o clique passasse, a RPC busca por
    // auth.uid() (o master REAL) e recusaria com FD004 — provado no
    // db/test-farmer-desfecho.sh, asserts 10 e 10b.
  });
});

describe('erro do banco vira instrução, não "erro ao salvar"', () => {
  it('[ERRO] cada SQLSTATE tem a ação certa, e FD004 NUNCA sugere tentar de novo', () => {
    expect(mensagemDoErro('FD001', 'fb')).toMatch(/sessão/i);
    expect(mensagemDoErro('FD003', 'fb')).toMatch(/motivo/i);
    expect(mensagemDoErro('FD006', 'fb')).toMatch(/duplicad/i);
    // ⚠️ Achado do /codex: retry depois de um recompute acertaria uma recomendação
    // NOVA e colaria o desfecho a um cálculo que ela nunca viu.
    const fd004 = mensagemDoErro('FD004', 'fb');
    expect(fd004).toMatch(/Recarregue/);
    expect(fd004).not.toMatch(/tente de novo|tentar novamente/i);
    // Código desconhecido cai no fallback — nunca numa mensagem inventada.
    expect(mensagemDoErro(undefined, 'fb')).toBe('fb');
  });

  it('[ERRO] erro de banco NÃO marca o card como registrado', async () => {
    // O supabase-js resolve com `error` preenchido em vez de lançar: um `await`
    // solto devolveria "sucesso" e o card mostraria desfecho que não existe.
    rpcMock.mockResolvedValue({ data: null, error: { code: 'FD004', message: 'x' } });
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(screen.queryByText('Venda registrada')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cliente comprou' })).toBeInTheDocument();
  });
});

describe('o sensor mede a TENTATIVA, não só o sucesso', () => {
  it('[TRACK] o evento sai antes do await e carrega desfecho e tipo', async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    const ev = eventos().find(([n]) => n === 'recomendacao.desfecho_clicado');
    expect(ev).toBeTruthy();
    expect(ev![1]).toMatchObject({ desfecho: 'aceito', tipo: 'cross_sell', motivo: null });
  });

  it('[TRACK] toque barrado pela lente NÃO conta como tentativa', () => {
    // Contá-lo inflaria o numerador com cliques que nunca chegaram à RPC — e a
    // pergunta "eles não registram ou o sistema recusa?" ficaria sem resposta.
    impMock.mockReturnValue({ isImpersonating: true });
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));
    expect(eventos().filter(([n]) => n === 'recomendacao.desfecho_clicado')).toHaveLength(0);
  });
});

describe('a trava de concorrência é síncrona', () => {
  it('[TRAVA] dois cliques no MESMO tick geram UMA chamada', async () => {
    // `registrando` é o valor do RENDER — dois cliques antes do re-render leriam
    // ambos `null` e passariam. A trava real é uma ref, checada de forma síncrona.
    let resolver: (v: RpcRet) => void = () => {};
    rpcMock.mockImplementation(() => new Promise<RpcRet>((r) => { resolver = r; }));
    render(<Host />);
    const b = screen.getByRole('button', { name: 'Cliente comprou' });
    fireEvent.click(b);
    fireEvent.click(b);
    fireEvent.click(b);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    resolver({ data: null, error: null });
    await waitFor(() => expect(screen.getByText('Venda registrada')).toBeInTheDocument());
  });

  it('[TRAVA] a trava é SOLTA após um erro — o card não congela', async () => {
    // Sem soltar a ref no finally, uma falha travaria o hook inteiro em silêncio:
    // os botões voltariam a parecer clicáveis e nenhum clique faria nada.
    rpcMock.mockResolvedValue({ data: null, error: { code: 'FD004', message: 'x' } });
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    rpcMock.mockResolvedValue({ data: null, error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Cliente comprou' }));
    await waitFor(() => expect(screen.getByText('Venda registrada')).toBeInTheDocument());
  });
});
