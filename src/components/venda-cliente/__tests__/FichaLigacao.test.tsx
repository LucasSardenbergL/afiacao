import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CompradorSugerido } from '@/lib/venda-cliente/sugestoes';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a) },
}));
const impMock = vi.fn();
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
const ledgerMock = vi.fn();
vi.mock('@/lib/analytics-ledger', () => ({ registrarNoLedger: (...a: unknown[]) => ledgerMock(...a) }));
vi.mock('@/hooks/useMunicaoLigacao', () => ({
  useMunicaoLigacao: () => ({ municao: { diasDesdeUltima: 47, ultimaCompra: null, ticketMedio: 1830 }, loading: false, erro: false }),
}));
vi.mock('@/hooks/useHistoricoCompras', () => ({
  useHistoricoCompras: () => ({
    historico: {
      topProdutos: [],
      produtos: [{ codigo: 10, nome: 'Verniz PU', vezes: 4, ultimoPreco: 212.5, ultimaData: '2026-08-01' }],
      ultimosPedidos: [{ data: '2026-08-01', valor: 2400, nItens: 3 }],
    },
    loading: false,
    erro: false,
  }),
}));
const comprador: CompradorSugerido = {
  compradorId: 'c1', nome: 'Marcenaria Boa Vista', telefone: '(37) 99876-5432',
  motivoEntrada: 'entrega amanhã em Divinopolis', valorRefTotal: 900,
  sugestoes: [
    { id: 's1', tipo: 'recompra', empresa: 'oben', omieCodigoProduto: 10, descricao: 'Verniz PU', familia: null, qtdRef: 3, valorRef: 600, precoAlvo: null },
    { id: 's2', tipo: 'recompra', empresa: 'colacor', omieCodigoProduto: 20, descricao: 'Lixa 220', familia: null, qtdRef: null, valorRef: 300, precoAlvo: null },
  ],
};
vi.mock('@/hooks/useMinhasSugestoes', () => ({ useSugestoesDoComprador: () => comprador }));
const mutateMock = vi.fn();
vi.mock('@/hooks/useRegistrarContato', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useRegistrarContato')>()),
  useRegistrarContato: () => ({ mutate: mutateMock, isPending: false }),
  useContatosDoDia: () => ({ data: new Map() }),
}));
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { FichaLigacao } from '../FichaLigacao';

function renderFicha(compradorId: string | null = 'c1') {
  return render(
    <MemoryRouter>
      <FichaLigacao compradorId={compradorId} onClose={vi.fn()} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  impMock.mockReturnValue({ isImpersonating: false });
  rpcMock.mockResolvedValue({ data: 2, error: null });
});

describe('FichaLigacao', () => {
  it('telefone vira link tel: (só dígitos) e registra venda.tel_clicado', () => {
    renderFicha();
    const link = screen.getByRole('link', { name: /99876-5432/ });
    expect(link).toHaveAttribute('href', 'tel:37998765432');
    fireEvent.click(link);
    expect(ledgerMock).toHaveBeenCalledWith('venda.tel_clicado', 'c1', { origem: 'ficha' });
  });

  it('não renderiza BotaoLigar (M-41: nada de WebRTC) — nem a ficha nem a fila importam a telefonia', () => {
    const dir = resolve(__dirname, '..');
    const fontes = [
      ...readdirSync(dir).filter((f) => f.endsWith('.tsx')).map((f) => resolve(dir, f)),
      resolve(__dirname, '../../fila/FilaDoDia.tsx'),
    ];
    expect(fontes.length).toBeGreaterThanOrEqual(6);
    for (const f of fontes) {
      const src = readFileSync(f, 'utf8');
      // importar a telefonia ou montar o botão — comentário que CITA o nome não conta
      expect(src, f).not.toMatch(/from '@\/components\/call\/|from '@\/contexts\/(WebRTC|webrtc)|<BotaoLigar|<CallButton/);
    }
    renderFicha();
    // e o único jeito de ligar na tela é o discador do aparelho
    expect(document.querySelectorAll('a[href^="tel:"]').length).toBe(1);
  });

  it('mostra Recomprar com qtd, último preço do histórico e "—" quando ausente', () => {
    renderFicha();
    expect(screen.getByText('Verniz PU')).toBeInTheDocument();
    expect(screen.getByText('3 un')).toBeInTheDocument();
    expect(screen.getByText(/212,50/)).toBeInTheDocument();
    // Lixa 220: sem qtd e sem histórico → "—", nunca 0
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/R\$\s*0,00/)).toBeNull();
  });

  it('nunca mostra custo nem markup', () => {
    renderFicha();
    expect(document.body.textContent ?? '').not.toMatch(/custo|markup|margem/i);
  });

  it('marca mostrada uma vez por abertura (e o sensor ficha_aberta uma vez)', () => {
    const { rerender } = renderFicha();
    rerender(<MemoryRouter><FichaLigacao compradorId="c1" onClose={vi.fn()} /></MemoryRouter>);
    rerender(<MemoryRouter><FichaLigacao compradorId="c1" onClose={vi.fn()} /></MemoryRouter>);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('venda_marcar_mostrada', { p_ids: ['s1', 's2'] });
    expect(ledgerMock.mock.calls.filter((c) => c[0] === 'venda.ficha_aberta')).toHaveLength(1);
    // fecha e reabre: nova abertura, nova marcação
    rerender(<MemoryRouter><FichaLigacao compradorId={null} onClose={vi.fn()} /></MemoryRouter>);
    rerender(<MemoryRouter><FichaLigacao compradorId="c1" onClose={vi.fn()} /></MemoryRouter>);
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it('na lente "Ver como" não marca mostrada (o uid seria o do master)', () => {
    impMock.mockReturnValue({ isImpersonating: true });
    renderFicha();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('nao_atendeu registra com 1 clique', () => {
    renderFicha();
    fireEvent.click(screen.getByRole('button', { name: /Não atendeu/ }));
    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock).toHaveBeenCalledWith({ compradorId: 'c1', resultado: 'nao_atendeu', motivo: undefined });
  });

  it('sem interesse pede o motivo e registra com ele', () => {
    renderFicha();
    fireEvent.click(screen.getByRole('button', { name: /Sem interesse/ }));
    expect(mutateMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preço' }));
    expect(mutateMock).toHaveBeenCalledWith({ compradorId: 'c1', resultado: 'sem_interesse', motivo: 'preco' });
  });

  it('na lente os botões de desfecho ficam bloqueados', () => {
    impMock.mockReturnValue({ isImpersonating: true });
    renderFicha();
    expect(screen.getByRole('button', { name: /Não atendeu/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Vendeu/ })).toBeDisabled();
  });
});
