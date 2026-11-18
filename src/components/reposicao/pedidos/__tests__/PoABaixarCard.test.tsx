import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PoABaixarCard } from '../PoABaixarCard';
import { ehAcessoNegadoFila, normalizarFila, ordenarFila, passosDaAcao, type ItemPoABaixar } from '../po-a-baixar';

const contado = {
  tipo: 'po_contado_com_nf', empresa: 'OBEN', numero_pedido: '1310', omie_codigo_pedido: 99, fornecedor_nome: 'Sayerlack',
  unidades_contadas: '12', numero_nfe: '000960001', nid_receb: 7001, nf_recebida_em: '2026-11-15T10:00:00Z',
  classe: null, motivos: null, pedidos_sugeridos: null, evidencia_em: '2026-11-18T17:40:00Z',
  evidencia_desatualizada: false, run_iniciado_em: '2026-11-18T17:40:00Z',
};
const pendente = {
  tipo: 'nf_pendente', empresa: 'OBEN', numero_pedido: null, omie_codigo_pedido: null, fornecedor_nome: null,
  unidades_contadas: null, numero_nfe: '000959973', nid_receb: 8001, nf_recebida_em: null, classe: 'ambigua',
  motivos: ['quantidade_menor_que_saldo'], pedidos_sugeridos: ['1329', '1334'], evidencia_em: '2026-11-18T16:15:00Z',
  evidencia_desatualizada: false, run_iniciado_em: null,
};

describe('normalizarFila — fronteira da RPC', () => {
  it('converte numérico em texto e mantém ausente como null (ausente ≠ zero)', () => {
    const [a] = normalizarFila([contado, { ...contado, unidades_contadas: null }]);
    expect(a.unidadesContadas).toBe(12);
    expect(normalizarFila([{ ...contado, unidades_contadas: null }])[0].unidadesContadas).toBeNull();
    expect(normalizarFila([{ ...contado, unidades_contadas: 'abc' }])[0].unidadesContadas).toBeNull();
  });

  it('descarta tipo desconhecido em vez de adivinhar a ação', () => {
    expect(normalizarFila([{ ...contado, tipo: 'encerrar_ja' }, null, 'x'])).toEqual([]);
    expect(normalizarFila(null)).toEqual([]);
  });

  it('sem carimbo de evidência, trata como desatualizada (pede conferência, não afirma estado atual)', () => {
    expect(normalizarFila([{ ...pendente, evidencia_em: null }])[0].evidenciaDesatualizada).toBe(true);
    expect(normalizarFila([{ ...pendente, evidencia_desatualizada: 'true' }])[0].evidenciaDesatualizada).toBe(false);
  });
});

describe('ordenarFila', () => {
  it('money-path primeiro (PO contado com NF), depois NF pendente fresca antes da velha', () => {
    const itens = normalizarFila([
      { ...pendente, numero_nfe: 'velha', evidencia_desatualizada: true, evidencia_em: '2026-10-01T00:00:00Z' },
      pendente,
      { ...contado, numero_pedido: 'B', nf_recebida_em: '2026-11-16T00:00:00Z' },
      { ...contado, numero_pedido: 'A', nf_recebida_em: '2026-11-10T00:00:00Z' },
    ]);
    expect(ordenarFila(itens).map((i) => i.numeroPedido ?? i.numeroNfe)).toEqual(['A', 'B', '000959973', 'velha']);
  });
});

describe('passosDaAcao — encerrar é irreversível', () => {
  it('PO contado nunca manda encerrar sem a ressalva do parcial', () => {
    const [i] = normalizarFila([contado]);
    const t = passosDaAcao(i);
    expect(t).toContain('Se a entrega foi TOTAL, encerre o PO no Omie');
    expect(t).toContain('PARCIAL');
  });
  it('NF pendente aponta os POs sugeridos; órfã não inventa PO', () => {
    expect(passosDaAcao(normalizarFila([pendente])[0])).toContain('1329, 1334');
    expect(passosDaAcao(normalizarFila([{ ...pendente, classe: 'orfa', pedidos_sugeridos: [] }])[0])).toContain('sem PO identificado');
  });
});

describe('ehAcessoNegadoFila — qual gate negou', () => {
  it('só a sentinela DESTA RPC com 42501 conta como negado', () => {
    expect(ehAcessoNegadoFila({ code: '42501', message: 'reposicao_po_a_baixar: acesso negado' })).toBe(true);
    expect(ehAcessoNegadoFila({ code: '42501', message: 'permission denied for function reposicao_po_a_baixar' })).toBe(false);
    expect(ehAcessoNegadoFila({ code: '42501', message: 'reposicao_pos_candidatos: acesso negado' })).toBe(false);
    expect(ehAcessoNegadoFila(null)).toBe(false);
  });
  it('reconhece o negado embrulhado como `cause` pela leitura paginada', () => {
    const negado = { code: '42501', message: 'reposicao_po_a_baixar: acesso negado' };
    expect(ehAcessoNegadoFila(Object.assign(new Error('fetchAllPages: página 0 falhou'), { cause: negado }))).toBe(true);
    expect(ehAcessoNegadoFila(Object.assign(new Error('x'), { cause: { code: '500', message: 'boom' } }))).toBe(false);
  });
});

describe('PoABaixarCard — estados em que dá para mentir', () => {
  const itens: ItemPoABaixar[] = ordenarFila(normalizarFila([contado, pendente]));

  it('lista vazia apurada não renderiza nada', () => {
    const { container } = render(<PoABaixarCard itens={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('apurando: diz que está apurando, nunca silêncio', () => {
    render(<PoABaixarCard itens={[]} apurando />);
    expect(screen.getByText(/apurando/i)).toBeInTheDocument();
  });

  it('falha sem lista: aviso visível de que NÃO sabemos', () => {
    render(<PoABaixarCard itens={[]} falhaApuracao />);
    expect(screen.getByText(/não foi possível apurar/i)).toBeInTheDocument();
  });

  it('falha com lista anterior: mantém a lista e avisa que pode estar desatualizada', () => {
    render(<PoABaixarCard itens={itens} falhaApuracao />);
    expect(screen.getByText(/pode estar desatualizada/i)).toBeInTheDocument();
    expect(screen.getByText(/PO a baixar no Omie \(2\)/)).toBeInTheDocument();
  });

  it('resume e, aberto, mostra evidência e o passo no Omie', () => {
    render(<PoABaixarCard itens={itens} />);
    expect(screen.getByText('1 com NF já recebida')).toBeInTheDocument();
    expect(screen.getByText('1 NF pendente')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/PO a baixar no Omie/));
    expect(screen.getByText(/motor ainda conta 12 un\. a caminho/)).toBeInTheDocument();
    expect(screen.getByText(/Nada aqui é feito no Omie automaticamente/)).toBeInTheDocument();
    expect(screen.getByText(/entrega parcial/)).toBeInTheDocument();
  });
});
