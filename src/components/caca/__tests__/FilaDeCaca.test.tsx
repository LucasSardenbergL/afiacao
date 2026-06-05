/**
 * Testes do componente FilaDeCaca.
 *
 * Foco: comportamento de renderização (loading, empty, lista), agrupamento de
 * documento multi-empresa, e casos degenerados (sem nome, sem telefone,
 * cliente não-vinculado).
 *
 * Não testa os helpers de apresentacao.ts (cobertos em apresentacao.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FilaDeCaca } from '../FilaDeCaca';
import type { CacaCandidatoDisplay } from '@/lib/caca/types';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

// ─── Helpers de fixture ────────────────────────────────────────────────────────

function makeDisplay(overrides: {
  documento: string;
  empresaAlvo?: CacaCandidatoDisplay['features']['empresaAlvo'];
  rankFinal?: number;
  sabor?: CacaCandidatoDisplay['sabor'];
  confianca?: number;
  nome?: string | null;
  telefone?: string | null;
  clienteUserId?: string | null;
  porque?: string[];
}): CacaCandidatoDisplay {
  return {
    features: {
      documento: overrides.documento,
      empresaAlvo: overrides.empresaAlvo ?? 'oben',
      cidadeUf: 'DIVINOPOLIS-MG',
      ramo: 'marcenaria',
      ticketFaixa: 500,
      familias: ['abrasivos'],
      compraEmOutraEmpresa: overrides.sabor === 'cross_empresa',
      compraNaEmpresaAlvo: false,
      ultimaCompraGrupoDias: overrides.sabor === 'frio' ? null : 90,
      atrasoRelativo: null,
    },
    sabor: overrides.sabor ?? 'frio',
    score: 0.6,
    confianca: overrides.confianca ?? 0.8,
    dimensoesUsadas: ['regiao'],
    porque: overrides.porque ?? ['mesma região dos seus melhores clientes (DIVINOPOLIS-MG)'],
    rankFinal: overrides.rankFinal ?? 1,
    nome: 'nome' in overrides ? (overrides.nome ?? null) : 'Empresa Teste Ltda',
    telefone: 'telefone' in overrides ? (overrides.telefone ?? null) : '31999998888',
    clienteUserId: 'clienteUserId' in overrides ? (overrides.clienteUserId ?? null) : null,
  };
}

/** Renderiza com MemoryRouter (Link exige contexto de router). */
function renderFila(props: Parameters<typeof FilaDeCaca>[0]) {
  return render(
    <MemoryRouter>
      <FilaDeCaca {...props} />
    </MemoryRouter>,
  );
}

// ─── Testes ────────────────────────────────────────────────────────────────────

describe('FilaDeCaca', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('estado de loading', () => {
    it('exibe skeletons quando isLoading=true', () => {
      renderFila({ candidatos: [], isLoading: true });
      // Skeleton do projeto usa animate-shimmer (não animate-pulse — customizado)
      const skeletons = document.querySelectorAll('[class*="animate-shimmer"]');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it('não exibe o header enquanto carrega', () => {
      renderFila({ candidatos: [], isLoading: true });
      expect(screen.queryByText('Clientes a caçar')).not.toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('exibe mensagem de vazio quando candidatos=[]', () => {
      renderFila({ candidatos: [], isLoading: false });
      expect(screen.getByText('Nada pra caçar agora.')).toBeInTheDocument();
    });

    it('exibe texto explicativo no empty state', () => {
      renderFila({ candidatos: [], isLoading: false });
      expect(
        screen.getByText(/candidatos forem identificados/i),
      ).toBeInTheDocument();
    });

    it('não exibe o header "Clientes a caçar" no empty state', () => {
      renderFila({ candidatos: [], isLoading: false });
      expect(screen.queryByText('Clientes a caçar')).not.toBeInTheDocument();
    });
  });

  describe('renderização da lista', () => {
    it('exibe o header quando há candidatos', () => {
      const candidatos = [makeDisplay({ documento: '11222333000144', rankFinal: 1 })];
      renderFila({ candidatos });
      expect(screen.getByText('Clientes a caçar')).toBeInTheDocument();
    });

    it('exibe o nome do cliente', () => {
      const candidatos = [
        makeDisplay({ documento: '11222333000144', nome: 'Empresa ABC Ltda', rankFinal: 1 }),
      ];
      renderFila({ candidatos });
      expect(screen.getByText('Empresa ABC Ltda')).toBeInTheDocument();
    });

    it('exibe o subtítulo com a contagem correta (singular)', () => {
      const candidatos = [makeDisplay({ documento: 'doc1', rankFinal: 1 })];
      renderFila({ candidatos });
      // singular
      expect(screen.getByText(/1 cliente parecido/)).toBeInTheDocument();
    });

    it('exibe o subtítulo com a contagem correta (plural)', () => {
      const candidatos = [
        makeDisplay({ documento: 'doc1', rankFinal: 1 }),
        makeDisplay({ documento: 'doc2', rankFinal: 2 }),
      ];
      renderFila({ candidatos });
      expect(screen.getByText(/2 clientes parecidos/)).toBeInTheDocument();
    });

    it('exibe o badge do sabor', () => {
      const candidatos = [
        makeDisplay({ documento: 'doc1', sabor: 'cross_empresa', rankFinal: 1 }),
      ];
      renderFila({ candidatos });
      expect(screen.getByText('Compra em outra empresa do grupo')).toBeInTheDocument();
    });

    it('exibe badge de confiança alta', () => {
      const candidatos = [
        makeDisplay({ documento: 'doc1', confianca: 0.9, rankFinal: 1 }),
      ];
      renderFila({ candidatos });
      expect(screen.getByText('Confiança alta')).toBeInTheDocument();
    });

    it('exibe as razões (porque[])', () => {
      const candidatos = [
        makeDisplay({
          documento: 'doc1',
          porque: ['razão de teste aqui', 'segunda razão'],
          rankFinal: 1,
        }),
      ];
      renderFila({ candidatos });
      expect(screen.getByText('razão de teste aqui')).toBeInTheDocument();
      expect(screen.getByText('segunda razão')).toBeInTheDocument();
    });

    it('exibe botão Ligar quando há telefone', () => {
      const candidatos = [
        makeDisplay({ documento: 'doc1', telefone: '31999998888', rankFinal: 1 }),
      ];
      renderFila({ candidatos });
      expect(screen.getByText('Ligar')).toBeInTheDocument();
    });

    it('não exibe botão Ligar quando telefone=null', () => {
      const candidatos = [
        makeDisplay({ documento: 'doc1', telefone: null, rankFinal: 1 }),
      ];
      renderFila({ candidatos });
      expect(screen.queryByText('Ligar')).not.toBeInTheDocument();
    });

    it('exibe link "Ver ficha" quando clienteUserId está presente', () => {
      const candidatos = [
        makeDisplay({ documento: 'doc1', clienteUserId: 'user-uuid-123', rankFinal: 1 }),
      ];
      renderFila({ candidatos });
      expect(screen.getAllByText('Ver ficha').length).toBeGreaterThan(0);
    });

    it('não exibe "Ver ficha" quando clienteUserId=null', () => {
      const candidatos = [
        makeDisplay({ documento: 'doc1', clienteUserId: null, rankFinal: 1 }),
      ];
      renderFila({ candidatos });
      expect(screen.queryByText('Ver ficha')).not.toBeInTheDocument();
    });
  });

  describe('candidato sem nome e sem telefone (não-vinculado)', () => {
    it('exibe "Sem nome — doc {documento}" quando nome=null', () => {
      const candidatos = [
        makeDisplay({
          documento: '99888777000166',
          nome: null,
          telefone: null,
          clienteUserId: null,
          rankFinal: 1,
        }),
      ];
      renderFila({ candidatos });
      expect(screen.getByText('Sem nome — doc 99888777000166')).toBeInTheDocument();
    });

    it('não exibe botão Ligar para candidato sem telefone', () => {
      const candidatos = [
        makeDisplay({ documento: 'sem-tel', telefone: null, rankFinal: 1 }),
      ];
      renderFila({ candidatos });
      expect(screen.queryByText('Ligar')).not.toBeInTheDocument();
    });
  });

  describe('agrupamento de documento multi-empresa', () => {
    it('mesmo documento com 2 empresas → 1 card com texto "caçar pra"', () => {
      const candidatos = [
        makeDisplay({
          documento: 'multi-doc',
          empresaAlvo: 'oben',
          rankFinal: 1,
          nome: 'Empresa Multi',
        }),
        makeDisplay({
          documento: 'multi-doc',
          empresaAlvo: 'colacor',
          rankFinal: 2,
          nome: 'Empresa Multi',
        }),
      ];
      renderFila({ candidatos });
      // Deve aparecer só 1 card (1 nome)
      expect(screen.getAllByText('Empresa Multi')).toHaveLength(1);
      // Deve mostrar as empresas agrupadas
      expect(screen.getByText(/caçar pra:/i)).toBeInTheDocument();
    });

    it('documentos distintos → 2 cards separados', () => {
      const candidatos = [
        makeDisplay({ documento: 'doc-a', nome: 'Empresa A', rankFinal: 1 }),
        makeDisplay({ documento: 'doc-b', nome: 'Empresa B', rankFinal: 2 }),
      ];
      renderFila({ candidatos });
      expect(screen.getByText('Empresa A')).toBeInTheDocument();
      expect(screen.getByText('Empresa B')).toBeInTheDocument();
    });
  });

  describe('todos os sabores renderizam corretamente', () => {
    it('cross_empresa exibe rótulo correto', () => {
      renderFila({
        candidatos: [makeDisplay({ documento: 'd1', sabor: 'cross_empresa', rankFinal: 1 })],
      });
      expect(screen.getByText('Compra em outra empresa do grupo')).toBeInTheDocument();
    });

    it('dormente exibe rótulo correto', () => {
      renderFila({
        candidatos: [makeDisplay({ documento: 'd2', sabor: 'dormente', rankFinal: 1 })],
      });
      expect(screen.getByText('Parou de comprar')).toBeInTheDocument();
    });

    it('frio exibe rótulo correto', () => {
      renderFila({
        candidatos: [makeDisplay({ documento: 'd3', sabor: 'frio', rankFinal: 1 })],
      });
      expect(screen.getByText('Nunca comprou')).toBeInTheDocument();
    });
  });
});
