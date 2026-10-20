import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Selos de LOTE na linha da fila: "inédito" (entrou no universo neste lote) e "saiu do dump em
 * mai/2026" (a RFB não listou a empresa no lote vigente — só o fato, sem motivo). Os dois vêm
 * dos helpers puros de `lote-vigente.ts`; aqui se prova que a linha os MOSTRA, e que sem lote
 * vigente não fabrica selo nenhum.
 */
// Sem mock do BotaoLigar: os fixtures não têm telefone, então o botão nunca monta — e um
// `vi.mock` por caminho seria uma aresta radar→telefonia nova no gate de fronteiras.

import { RadarLinha } from '../RadarLinha';
import type { RadarEmpresa } from '@/queries/useRadarLista';

const LOTE = { mes_referencia: '2026-08', status: 'complete', total_recebido: 501380, novos: 27466, iniciado_em: '2026-10-19T16:31:08.593+00:00' };
const empresa = (over: Partial<RadarEmpresa>): RadarEmpresa => ({
  cnpj: '12345678000195', razao_social: 'ACME LTDA', nome_fantasia: null, ja_cliente: false, prospeccao_status: 'a_contatar',
  telefone1: null, telefone2: null, municipio_nome: 'BELO HORIZONTE', uf: 'MG', data_abertura: '2020-01-01', porte: '01',
  cnae_descricao: null, ultimo_lote: '2026-08', primeira_vista_em: '2026-06-12T01:10:00+00:00', ...over,
} as RadarEmpresa);

function renderLinha(e: RadarEmpresa, lote: typeof LOTE | null) {
  return render(<RadarLinha empresa={e} hojeISO="2026-10-20" selecionada={false} onSelecionar={() => {}} onAbrir={() => {}} lote={lote} />);
}

describe('RadarLinha — selos de lote', () => {
  it('inédito do lote vigente ganha o selo "inédito"', () => {
    renderLinha(empresa({ primeira_vista_em: '2026-10-19T16:35:00+00:00' }), LOTE);
    expect(screen.getByText(/^inédito$/i)).toBeTruthy();
    expect(screen.queryByText(/saiu do dump/i)).toBeNull();
  });

  it('quem saiu do dump ganha "saiu do dump em mai/2026" — sem dizer motivo', () => {
    renderLinha(empresa({ ultimo_lote: '2026-05' }), LOTE);
    expect(screen.getByText(/saiu do dump em mai\/2026/i)).toBeTruthy();
    expect(screen.queryByText(/baix/i), 'fabricou motivo (baixa é outra entrega)').toBeNull();
    expect(screen.queryByText(/^inédito$/i)).toBeNull();
  });

  it('empresa comum do lote vigente: nenhum selo de lote', () => {
    renderLinha(empresa({}), LOTE);
    expect(screen.queryByText(/^inédito$/i)).toBeNull();
    expect(screen.queryByText(/saiu do dump/i)).toBeNull();
  });

  it('sem lote vigente: não fabrica selo', () => {
    renderLinha(empresa({ ultimo_lote: '2026-05', primeira_vista_em: '2026-10-19T16:35:00+00:00' }), null);
    expect(screen.queryByText(/^inédito$/i)).toBeNull();
    expect(screen.queryByText(/saiu do dump/i)).toBeNull();
  });
});
