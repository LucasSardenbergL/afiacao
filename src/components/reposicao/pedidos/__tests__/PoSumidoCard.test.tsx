import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PoSumidoCard } from '../PoSumidoCard';
import type { PoCandidato } from '../po-sumido';

// Os estados em que a UI pode MENTIR — os quatro achados P1 do review adversarial. Cada teste aqui
// existe porque a versão anterior do card errava exatamente nesse ponto.

const base: PoCandidato = {
  pedido_id: 1,
  omie_codigo_pedido: '1073',
  data_ciclo: '2026-05-27',
  idade_dias: 50,
  na_janela_7d: false,
  valor_total: 100,
  visto_status: 'sem_registro_last_seen',
  fornecedor_nome: 'Sayerlack',
  canal_usado: 'portal_sayerlack',
  portal_protocolo: null,
  status_envio_portal: null,
  algum_sinal_de_canal: false,
};
const c = (over: Partial<PoCandidato> = {}): PoCandidato => ({ ...base, ...over });

describe('PoSumidoCard — os estados em que dá para mentir', () => {
  it('lista vazia APURADA não renderiza nada (aí "não há" é verdade)', () => {
    const { container } = render(<PoSumidoCard candidatos={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('apurando: aparece "apurando", NUNCA silêncio — "ainda não sei" ≠ "não há"', () => {
    render(<PoSumidoCard candidatos={[]} apurando />);
    expect(screen.getByText(/apurando/i)).toBeInTheDocument();
  });

  it('falha de apuração: grita que NÃO sabe, em vez de sumir', () => {
    render(<PoSumidoCard candidatos={[]} falhaApuracao />);
    expect(screen.getByText(/não foi possível apurar/i)).toBeInTheDocument();
    expect(screen.getByText(/significa que não sabemos/i)).toBeInTheDocument();
  });

  it('TODOS sem valor: diz "não apurado" e NUNCA imprime R$ 0,00', () => {
    // O furo mais grave do review: [].reduce(soma, 0) === 0 fazia o card anunciar "Total conhecido
    // R$ 0,00" quando nenhum valor havia sido apurado — fabricar zero é fabricar um fato.
    render(<PoSumidoCard candidatos={[c({ pedido_id: 1, valor_total: null }), c({ pedido_id: 2, valor_total: null })]} />);
    expect(screen.getByText(/não apurado/i)).toBeInTheDocument();
    expect(screen.queryByText(/R\$\s*0,00/)).not.toBeInTheDocument();
  });

  it('misto: apresenta SUBTOTAL declarado, não "total"', () => {
    render(<PoSumidoCard candidatos={[c({ pedido_id: 1, valor_total: 100 }), c({ pedido_id: 2, valor_total: null })]} />);
    expect(screen.getByText(/subtotal de 1 de 2 pedidos/i)).toBeInTheDocument();
  });

  it('título é NEUTRO: não afirma ausência de PO (há linha em que nem deu para comparar)', () => {
    render(<PoSumidoCard candidatos={[c({ visto_status: 'identidade_nao_interpretavel' })]} />);
    expect(screen.getByText(/a reconciliar no Omie/i)).toBeInTheDocument();
    // "Pedidos sem PO" seria uma afirmação que a evidência não sustenta para identidade ilegível.
    expect(screen.queryByText(/pedidos sem PO/i)).not.toBeInTheDocument();
  });

  it('o card recolhido nunca instrui cancelar — avisa para NÃO cancelar sem conferir', () => {
    render(<PoSumidoCard candidatos={[c()]} />);
    expect(screen.getByText(/não cancele sem conferir/i)).toBeInTheDocument();
  });
});
