import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SugestaoItem } from '@/lib/venda-cliente/sugestoes';
import type { FamiliaComplemento } from '@/lib/venda-cliente/complemento';
import { SecaoComplemento } from '../SecaoComplemento';

function item(id: string, familia: string, empresa = 'oben'): SugestaoItem {
  return {
    id, tipo: 'complemento', empresa, omieCodigoProduto: null, descricao: null, familia,
    qtdRef: null, valorRef: null, precoAlvo: null, cadenciaDias: null,
  };
}

const itens = [item('k1', 'SELADORES'), item('k2', 'ABRASIVOS', 'colacor')];
const familias: FamiliaComplemento[] = [
  { familia: 'SELADORES', empresa: 'oben', skus: [{ omieCodigoProduto: 501, descricao: 'Selador PU 3,6L' }] },
  { familia: 'ABRASIVOS', empresa: 'colacor', skus: [] },
];

describe('SecaoComplemento', () => {
  it('onda_complemento=false → não renderiza (nem com linhas e SKUs prontos)', () => {
    const { container } = render(
      <SecaoComplemento ondaLigada={false} itens={itens} familias={familias} loading={false} erro={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('sem linha de complemento do dia → não renderiza (a ficha não inventa família)', () => {
    const { container } = render(
      <SecaoComplemento ondaLigada itens={[]} familias={familias} loading={false} erro={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('mostra a família, a frase "clientes parecidos compram" e os SKUs de referência', () => {
    render(<SecaoComplemento ondaLigada itens={itens} familias={familias} loading={false} erro={false} />);
    expect(screen.getByRole('heading', { name: 'Oferecer também' })).toBeInTheDocument();
    expect(screen.getByText('clientes parecidos compram')).toBeInTheDocument();
    expect(screen.getByText('SELADORES')).toBeInTheDocument();
    expect(screen.getByText(/Selador PU 3,6L/)).toBeInTheDocument();
    // família sem comprador parecido: diz que não há referência, não fabrica SKU
    expect(screen.getByText('ABRASIVOS')).toBeInTheDocument();
    expect(screen.getByText('Sem produto de referência nesta família.')).toBeInTheDocument();
  });

  it('nunca mostra estoque nem disponibilidade (não há fonte confiável)', () => {
    render(<SecaoComplemento ondaLigada itens={itens} familias={familias} loading={false} erro={false} />);
    expect(document.body.textContent ?? '').not.toMatch(/estoque|dispon[ií]v/i);
  });

  it('falha de leitura dos SKUs: mantém as famílias e avisa, sem afirmar "sem referência"', () => {
    render(<SecaoComplemento ondaLigada itens={itens} familias={null} loading={false} erro />);
    expect(screen.getByText('SELADORES')).toBeInTheDocument();
    expect(screen.getByText(/Não consegui ler os produtos de referência/)).toBeInTheDocument();
    expect(screen.queryByText('Sem produto de referência nesta família.')).toBeNull();
  });
});
