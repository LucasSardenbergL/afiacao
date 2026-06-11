import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AutoBadge, StatusComMotivo } from '../badges';
import type { PedidoSugerido } from '../types';

const base = {
  id: 1, empresa: 'OBEN', fornecedor_nome: 'RENNER SAYERLACK S/A', grupo_codigo: 'G1',
  data_ciclo: '2026-06-10', valor_total: 8400, num_skus: 10,
  status: 'aprovado_aguardando_disparo', aprovado_em: '2026-06-10T10:00:00Z',
  aprovado_por: 'auto:sayerlack-v1', cancelado_em: null, mensagem_bloqueio: null,
  resposta_canal: null, status_envio_portal: null, portal_protocolo: null,
  portal_erro: null, split_parent_id: null, split_lote: null, split_total: null,
} as unknown as PedidoSugerido;

describe('AutoBadge', () => {
  it('mostra "auto" quando aprovado_por começa com auto:', () => {
    render(<AutoBadge pedido={base} />);
    expect(screen.getByText('auto')).toBeInTheDocument();
  });

  it('não renderiza pra aprovação humana', () => {
    const humano = { ...base, aprovado_por: 'founder@colacor' } as PedidoSugerido;
    const { container } = render(<AutoBadge pedido={humano} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('não renderiza quando aprovado_por é null', () => {
    const semAprovacao = { ...base, aprovado_por: null } as PedidoSugerido;
    const { container } = render(<AutoBadge pedido={semAprovacao} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('StatusComMotivo inclui o badge auto', () => {
    render(<StatusComMotivo pedido={base} />);
    expect(screen.getByText('auto')).toBeInTheDocument();
  });
});
