import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Selos de LOTE na linha da fila: "inédito" (entrou no universo neste lote) e "saiu do dump em
 * mai/2026" (a RFB não listou a empresa no lote vigente — só o fato, sem motivo). Os dois vêm
 * dos helpers puros de `lote-vigente.ts`; aqui se prova que a linha os MOSTRA, e que sem lote
 * vigente não fabrica selo nenhum.
 */
// Sem mock do BotaoLigar: os fixtures não têm telefone, então o botão nunca monta — e um
// `vi.mock` por caminho seria uma aresta radar→telefonia nova no gate de fronteiras.

// O chip "em atendimento por X" lê uma query compartilhada (RPC radar_atendimentos_ativos): aqui ela é um Map fixo.
let atendimentos = new Map<string, unknown>();
vi.mock('@/queries/useRadarAtendimentos', () => ({
  useRadarAtendimentosAtivos: () => ({ data: atendimentos, isError: false, isSuccess: true, isLoading: false }),
}));

import { RadarLinha } from '../RadarLinha';
import type { RadarEmpresa } from '@/queries/useRadarLista';

const LOTE = { mes_referencia: '2026-08', status: 'complete', total_recebido: 501380, novos: 27466, iniciado_em: '2026-10-19T16:31:08.593+00:00' };
const empresa = (over: Partial<RadarEmpresa>): RadarEmpresa => ({
  cnpj: '12345678000195', razao_social: 'ACME LTDA', nome_fantasia: null, ja_cliente: false, prospeccao_status: 'a_contatar',
  telefone1: null, telefone2: null, municipio_nome: 'BELO HORIZONTE', uf: 'MG', data_abertura: '2020-01-01', porte: '01',
  cnae_descricao: null, ultimo_lote: '2026-08', primeira_vista_em: '2026-06-12T01:10:00+00:00', ...over,
} as RadarEmpresa);

function renderLinha(e: RadarEmpresa, lote: typeof LOTE | null, mostrarMotivos = false) {
  return render(<RadarLinha empresa={e} hojeISO="2026-10-20" selecionada={false} onSelecionar={() => {}} onAbrir={() => {}} lote={lote} mostrarMotivos={mostrarMotivos} />);
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

describe('RadarLinha — selo "sugerido" e motivos do score (bloco 5)', () => {
  const sugerido = () => empresa({
    prospeccao_status: 'em_conversa', score: 75, score_motivos: ['CNAE tier 1 (+25)', 'capital ≥ 1 mi (+15)'],
    rfb_situacao: null, omie_codigo_cliente: null,
  });

  it('em conversa, não cliente, score ≥ 70 na foto vigente: selo "sugerido"', () => {
    renderLinha(sugerido(), LOTE);
    expect(screen.getByText(/^sugerido/i)).toBeTruthy();
  });

  it('score abaixo do limiar: sem selo', () => {
    renderLinha(empresa({ ...sugerido(), score: 69 }), LOTE);
    expect(screen.queryByText(/^sugerido/i)).toBeNull();
  });

  it('sem lote vigente: sem selo (não sei qual é a foto)', () => {
    renderLinha(sugerido(), null);
    expect(screen.queryByText(/^sugerido/i)).toBeNull();
  });

  it('com `mostrarMotivos`, os motivos do score aparecem como TEXTO (não só no title)', () => {
    renderLinha(sugerido(), LOTE, true);
    expect(screen.getByText(/CNAE tier 1 \(\+25\)/)).toBeTruthy();
  });

  it('sem `mostrarMotivos`, os motivos ficam só no title do badge', () => {
    renderLinha(sugerido(), LOTE, false);
    expect(screen.queryByText(/CNAE tier 1 \(\+25\)/)).toBeNull();
    expect(screen.getByTestId('radar-score').getAttribute('title')).toMatch(/CNAE tier 1/);
  });
});

describe('RadarLinha — selo de filial (mesma raiz de CNPJ)', () => {
  const linha = (irmaos: { irmaos_na_fila: number; irmaos_clientes: number; cliente_nome: string | null } | null) =>
    render(<RadarLinha empresa={empresa({})} hojeISO="2026-10-20" selecionada={false} onSelecionar={() => {}} onAbrir={() => {}} lote={LOTE} irmaos={irmaos} />);

  it('filial de cliente e +N da mesma empresa aparecem com o detalhe no title', () => {
    linha({ irmaos_na_fila: 2, irmaos_clientes: 1, cliente_nome: 'ACME SA' });
    expect(screen.getByTestId('selo-filial-cliente').textContent).toBe('filial de cliente');
    expect(screen.getByTestId('selo-filial-cliente').getAttribute('title')).toBe('Mesma raiz de CNPJ de 1 cliente: ACME SA');
    expect(screen.getByTestId('selo-filial-fila').textContent).toBe('+2 da mesma empresa');
  });

  it('sem irmãos ou sem dado: nenhum selo de filial', () => {
    const { unmount } = linha({ irmaos_na_fila: 0, irmaos_clientes: 0, cliente_nome: null });
    expect(screen.queryByTestId('selo-filial-cliente')).toBeNull();
    expect(screen.queryByTestId('selo-filial-fila')).toBeNull();
    unmount();
    linha(null);
    expect(screen.queryByTestId('selo-filial-cliente')).toBeNull();
  });

  it('o score da linha não muda com o selo', () => {
    render(<RadarLinha empresa={empresa({ score: 72, score_motivos: ['x'] })} hojeISO="2026-10-20" selecionada={false} onSelecionar={() => {}} onAbrir={() => {}} lote={LOTE} irmaos={{ irmaos_na_fila: 3, irmaos_clientes: 1, cliente_nome: null }} />);
    expect(screen.getByTestId('radar-score').textContent).toBe('72');
  });
});

describe('RadarLinha — em atendimento', () => {
  const posse = (ehMeu: boolean) => ({
    cnpj: '12345678000195', donoUserId: 'u1', donoNome: 'Vendedor Um', assumidoEm: '2026-10-29T12:00:00Z',
    expiraEm: '2026-11-05T12:00:00Z', ehMeu,
  });
  it('lead de outro vendedor mostra o dono e o prazo', () => {
    atendimentos = new Map([['12345678000195', posse(false)]]);
    renderLinha(empresa({}), null);
    expect(screen.getByTestId('radar-atendimento').textContent).toBe('em atendimento por Vendedor Um até 05/11');
  });
  it('lead meu mostra "com você"', () => {
    atendimentos = new Map([['12345678000195', posse(true)]]);
    renderLinha(empresa({}), null);
    expect(screen.getByTestId('radar-atendimento').textContent).toBe('com você até 05/11');
  });
  it('lead livre não ganha chip', () => {
    atendimentos = new Map();
    renderLinha(empresa({}), null);
    expect(screen.queryByTestId('radar-atendimento')).toBeNull();
  });
});

describe('RadarLinha — selo da amostra de controle', () => {
  it('sorteado da amostra ganha o selo "amostra" com o sorteio no título', () => {
    render(<RadarLinha empresa={empresa({})} hojeISO="2026-10-20" selecionada={false} onSelecionar={() => {}} onAbrir={() => {}} lote={LOTE} amostra="coorte-2026-10" />);
    expect(screen.getByTestId('selo-amostra').textContent).toBe('amostra');
    expect(screen.getByTestId('selo-amostra').getAttribute('title')).toContain('coorte-2026-10');
  });

  it('lead fora da amostra: sem selo', () => {
    renderLinha(empresa({}), LOTE);
    expect(screen.queryByTestId('selo-amostra')).toBeNull();
  });
});
