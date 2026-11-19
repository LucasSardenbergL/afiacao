import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PoABaixarCard } from '../PoABaixarCard';
import {
  decisoesDoTipo,
  ehAcessoNegadoFila,
  motivoLegivel,
  normalizarFila,
  ordenarFila,
  passosDaAcao,
  recusaDaDecisao,
  type ItemPoABaixar,
} from '../po-a-baixar';

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
const associavel = {
  ...pendente, chave: '8005', numero_nfe: '000959992', nid_receb: 8005, classe: 'associavel', motivos: [],
  pedidos_sugeridos: ['1330'], fornecedor_nome: 'RENNER SAYERLACK S/A', proposta_versao: 'v-abc',
  pares: [{ seq_nf: 1, numero_pedido: '1330', item_po: 2, codigo_produto: 'PRD02372', descricao: 'BASE BRIL 05',
            quantidade: 2, unidade: 'UN', cobertura: 'parcial' }],
  decisao_vigente: null, decisao_vigente_em: null,
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

describe('Entrega A — pares, motivos e decisão', () => {
  it('normaliza os pares; null (não veio par) ≠ [] e quantidade ilegível vira null, nunca 0', () => {
    const [a] = normalizarFila([associavel]);
    expect(a.pares).toEqual([{ seqNf: 1, numeroPedido: '1330', itemPo: 2, codigoProduto: 'PRD02372', descricao: 'BASE BRIL 05',
                               quantidade: 2, unidade: 'UN', cobertura: 'parcial' }]);
    expect(normalizarFila([{ ...associavel, pares: null }])[0].pares).toBeNull();
    expect(normalizarFila([{ ...associavel, pares: [{ quantidade: 'x', cobertura: 'meio' }] }])[0].pares?.[0])
      .toMatchObject({ quantidade: null, cobertura: null });
    expect(normalizarFila([{ ...associavel, decisao_vigente: 'apaguei' }])[0].decisaoVigente).toBeNull();
  });

  it('traduz os motivos crus que a equipe via', () => {
    for (const m of ['item_sem_contrato', 'sku_com_equivalencia_de_embalagem', 'unidade_divergente', 'contrato_em_varios_pos', 'item_nao_movimenta_estoque']) {
      expect(motivoLegivel(m)).not.toContain('_');
      expect(motivoLegivel(m)).not.toBe(m.replace(/_/g, ' '));
    }
  });

  it('encerrei só para PO, associei só para NF', () => {
    expect(decisoesDoTipo('po_contado_com_nf')).toEqual(['encerrei', 'parcial_aguardo_saldo', 'nao_se_aplica']);
    expect(decisoesDoTipo('nf_pendente')).toEqual(['associei', 'parcial_aguardo_saldo', 'nao_se_aplica']);
  });

  it('recusa de domínio vira frase; o resto é falha (null)', () => {
    expect(recusaDaDecisao({ code: 'PB001' })).toMatch(/saiu da fila/);
    expect(recusaDaDecisao({ code: 'PB002' })).toMatch(/proposta mudou/);
    expect(recusaDaDecisao({ code: '500' })).toBeNull();
    expect(recusaDaDecisao(null)).toBeNull();
  });

  it('card: associável mostra a tabela de pares e o fornecedor; ambígua mostra candidatos', () => {
    render(<PoABaixarCard itens={normalizarFila([associavel, pendente])} />);
    fireEvent.click(screen.getByText(/PO a baixar no Omie/));
    expect(screen.getByText('PRD02372')).toBeInTheDocument();
    expect(screen.getByText('2º')).toBeInTheDocument();
    expect(screen.getByText(/parcial — sobra saldo/)).toBeInTheDocument();
    expect(screen.getByText(/RENNER SAYERLACK S\/A/)).toBeInTheDocument();
    expect(screen.getByText(/Candidatos: PO 1329, 1334/)).toBeInTheDocument();
  });

  it('card: sem onDecidir não há botão; com onDecidir, o clique leva item e decisão', () => {
    const { unmount } = render(<PoABaixarCard itens={normalizarFila([associavel])} />);
    fireEvent.click(screen.getByText(/PO a baixar no Omie/));
    expect(screen.queryByRole('button', { name: 'Associei no Omie' })).toBeNull();
    unmount();
    const onDecidir = vi.fn();
    render(<PoABaixarCard itens={normalizarFila([associavel])} onDecidir={onDecidir} />);
    fireEvent.click(screen.getByText(/PO a baixar no Omie/));
    expect(screen.queryByRole('button', { name: 'Encerrei no Omie' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Associei no Omie' }));
    expect(onDecidir).toHaveBeenCalledWith(expect.objectContaining({ chave: '8005', propostaVersao: 'v-abc' }), 'associei');
  });

  it('card: item sem proposta_versao não oferece botão (o banco recusaria); decisão vigente aparece', () => {
    const onDecidir = vi.fn();
    render(
      <PoABaixarCard
        itens={normalizarFila([{ ...associavel, proposta_versao: null }, { ...pendente, chave: '8001', proposta_versao: 'v1', decisao_vigente: 'nao_se_aplica', decisao_vigente_em: '2026-11-18T12:00:00Z' }])}
        onDecidir={onDecidir}
      />,
    );
    fireEvent.click(screen.getByText(/PO a baixar no Omie/));
    expect(screen.getAllByRole('button', { name: 'Associei no Omie' })).toHaveLength(1);
    expect(screen.getByText(/Marcado:/)).toBeInTheDocument();
  });
});
