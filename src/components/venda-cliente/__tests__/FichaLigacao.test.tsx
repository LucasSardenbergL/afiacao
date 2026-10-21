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
    { id: 's1', tipo: 'recompra', empresa: 'oben', omieCodigoProduto: 10, descricao: 'Verniz PU', familia: null, qtdRef: 3, valorRef: 600, precoAlvo: null, cadenciaDias: null },
    { id: 's2', tipo: 'recompra', empresa: 'colacor', omieCodigoProduto: 20, descricao: 'Lixa 220', familia: null, qtdRef: null, valorRef: 300, precoAlvo: null, cadenciaDias: null },
  ],
};
const ondasMock = vi.fn();
const compradorMock = vi.fn();
vi.mock('@/hooks/useMinhasSugestoes', () => ({
  useSugestoesDoComprador: () => compradorMock(),
  useOndasVenda: () => ondasMock(),
}));
const complementoMock = vi.fn();
vi.mock('@/hooks/useComplementoComprador', () => ({
  useComplementoComprador: (...a: unknown[]) => complementoMock(...a),
}));
const precoMock = vi.fn();
vi.mock('@/hooks/usePrecoAlvoComprador', () => ({
  usePrecoAlvoComprador: (...a: unknown[]) => precoMock(...a),
}));
const mutateMock = vi.fn();
vi.mock('@/hooks/useRegistrarContato', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useRegistrarContato')>()),
  useRegistrarContato: () => ({ mutate: mutateMock, isPending: false }),
}));
vi.mock('@/hooks/useContatosDoDia', () => ({ useContatosDoDia: () => ({ data: new Map() }) }));
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
  compradorMock.mockReturnValue(comprador);
  ondasMock.mockReturnValue({ complemento: false, preco: false });
  complementoMock.mockReturnValue({ familias: null, loading: false, erro: false });
  precoMock.mockReturnValue({ alvos: null, loading: false, erro: false });
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

  describe('Ondas 2–3 (Task 9)', () => {
    const comOndas: CompradorSugerido = {
      ...comprador,
      sugestoes: [
        ...comprador.sugestoes,
        { id: 'k1', tipo: 'complemento', empresa: 'oben', omieCodigoProduto: null, descricao: null, familia: 'SELADORES', qtdRef: null, valorRef: null, precoAlvo: null, cadenciaDias: null },
        { id: 'p1', tipo: 'preco', empresa: 'oben', omieCodigoProduto: 10, descricao: 'Verniz PU', familia: null, qtdRef: null, valorRef: null, precoAlvo: 230, cadenciaDias: null },
        { id: 'p2', tipo: 'preco', empresa: 'oben', omieCodigoProduto: 30, descricao: 'Seladora 18L', familia: null, qtdRef: null, valorRef: null, precoAlvo: 500, cadenciaDias: null },
      ],
    };

    it('ondas desligadas no servidor: nem Oferecer também nem Preço, e os hooks não leem', () => {
      compradorMock.mockReturnValue(comOndas);
      renderFicha();
      expect(screen.queryByRole('heading', { name: 'Oferecer também' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Preço' })).toBeNull();
      expect(complementoMock).toHaveBeenCalledWith('c1', false);
      expect(precoMock).toHaveBeenCalledWith('c1', false);
      // e a marcação continua só a da recompra
      expect(rpcMock).toHaveBeenCalledWith('venda_marcar_mostrada', { p_ids: ['s1', 's2'] });
    });

    it('ondas ligadas: seções separadas entre Recomprar e Histórico', () => {
      compradorMock.mockReturnValue(comOndas);
      ondasMock.mockReturnValue({ complemento: true, preco: true });
      complementoMock.mockReturnValue({ familias: [{ familia: 'SELADORES', empresa: 'oben', skus: [] }], loading: false, erro: false });
      precoMock.mockReturnValue({ alvos: [{ empresa: 'oben', omieCodigoProduto: 10, ultimoPreco: 212.5, precoAlvo: 230, faixaMargem: 'verde', validoAte: '2026-12-31' }], loading: false, erro: false });
      renderFicha();
      const titulos = screen.getAllByRole('heading').map((h) => h.textContent);
      const ordem = ['Recomprar', 'Oferecer também', 'Preço'].map((t) => titulos.indexOf(t));
      expect(ordem.every((i) => i >= 0)).toBe(true);
      expect([...ordem].sort((x, y) => x - y)).toEqual(ordem);
      expect(complementoMock).toHaveBeenCalledWith('c1', true);
      expect(precoMock).toHaveBeenCalledWith('c1', true);
    });

    it('marca mostrada: complemento ao abrir; preço SÓ do SKU cujo alvo foi exibido', () => {
      compradorMock.mockReturnValue(comOndas);
      ondasMock.mockReturnValue({ complemento: true, preco: true });
      precoMock.mockReturnValue({ alvos: null, loading: true, erro: false });
      const { rerender } = renderFicha();
      expect(rpcMock).toHaveBeenCalledTimes(1);
      expect(rpcMock).toHaveBeenLastCalledWith('venda_marcar_mostrada', { p_ids: ['s1', 's2', 'k1'] });
      // o alvo do SKU 10 chega; o do 30 não (repasse saiu do ar): só p1 é marcada
      precoMock.mockReturnValue({ alvos: [{ empresa: 'oben', omieCodigoProduto: 10, ultimoPreco: 212.5, precoAlvo: 230, faixaMargem: 'neutro', validoAte: '2026-12-31' }], loading: false, erro: false });
      rerender(<MemoryRouter><FichaLigacao compradorId="c1" onClose={vi.fn()} /></MemoryRouter>);
      rerender(<MemoryRouter><FichaLigacao compradorId="c1" onClose={vi.fn()} /></MemoryRouter>);
      expect(rpcMock).toHaveBeenCalledTimes(2);
      expect(rpcMock).toHaveBeenLastCalledWith('venda_marcar_mostrada', { p_ids: ['p1'] });
    });

    it('na lente "Ver como": não lê complemento/preço e não marca nada', () => {
      compradorMock.mockReturnValue(comOndas);
      ondasMock.mockReturnValue({ complemento: true, preco: true });
      impMock.mockReturnValue({ isImpersonating: true });
      renderFicha();
      expect(complementoMock).toHaveBeenCalledWith('c1', false);
      expect(precoMock).toHaveBeenCalledWith('c1', false);
      expect(rpcMock).not.toHaveBeenCalled();
    });

    it('com a Onda 3 ligada a ficha mostra a faixa de margem, mas nunca custo nem markup', () => {
      compradorMock.mockReturnValue(comOndas);
      ondasMock.mockReturnValue({ complemento: true, preco: true });
      precoMock.mockReturnValue({ alvos: [{ empresa: 'oben', omieCodigoProduto: 10, ultimoPreco: 212.5, precoAlvo: 230, faixaMargem: 'vermelho', validoAte: '2026-12-31' }], loading: false, erro: false });
      renderFicha();
      expect(screen.getByText('Margem crítica')).toBeInTheDocument();
      expect(document.body.textContent ?? '').not.toMatch(/custo|markup|piso/i);
    });
  });
});

