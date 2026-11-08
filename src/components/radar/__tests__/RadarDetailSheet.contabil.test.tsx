import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { RadarEmpresa } from '@/queries/useRadarLista';
import { lerContatoContabil, type LeituraContatoContabil } from '@/lib/radar/contato-contabil';

/**
 * Ficha do Radar × contato da contabilidade (migration 20261109140000). O que pegaria a saída errada:
 * - selo no número errado (telefone1 marcado, telefone2 direto);
 * - ligar/WhatsApp do número da contabilidade com o mesmo destaque do direto;
 * - endereço sem destaque quando todo contato é da contabilidade;
 * - correção sem a versão vista (sobrescrita cega) ou no campo errado;
 * - "não calculado" (efetivo NULL) mostrado como selo ou como "contato direto";
 * - a lente "Ver como" conseguindo corrigir.
 */
const { Nada } = vi.hoisted(() => ({ Nada: () => null }));
let leitura: LeituraContatoContabil | undefined;
let lente = false;
const mutate = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: () => Promise.resolve({ data: null, error: null }) } }));
vi.mock('@/lib/impersonation/lens-write-guard', () => ({ isLensActive: () => lente }));
vi.mock('@/hooks/useIsTouchDevice', () => ({ useIsTouchDevice: () => false }));
vi.mock('@/queries/useRadarTelefoneCompartilhado', () => ({ useRadarTelefoneCompartilhado: () => ({ data: undefined }) }));
vi.mock('@/queries/useRadarContatoContabil', () => ({
  useRadarContatoContabil: () => ({ data: leitura, isError: false }),
  useCorrigirContatoContabil: () => ({ mutate, isPending: false }),
}));
vi.mock('@/queries/useRadarContatos', () => ({
  LIMITE_HISTORICO_RADAR: 20,
  useRadarContatos: () => ({ data: [], isPending: false, isError: false, isFetching: false, error: null, status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1 }),
}));
vi.mock('../RadarOutcomeMenu', () => ({ RadarOutcomeMenu: Nada }));
vi.mock('../RadarAcoesLead', () => ({ RadarAcoesLead: Nada }));
vi.mock('../RadarConflitosCadastro', () => ({ RadarConflitosDoLead: Nada }));
vi.mock('../RadarAtendimentoLead', () => ({ RadarAtendimentoLead: Nada }));
vi.mock('../RadarVinculosLead', () => ({ RadarVinculosLead: Nada }));
vi.mock('../RadarSucessaoLead', () => ({ RadarSucessaoLead: Nada }));
vi.mock('@/components/credito-vinculo/AvisoVinculoCredito', () => ({ AvisoVinculoCredito: Nada }));

import { RadarDetailSheet } from '../RadarDetailSheet';

const EMPRESA = {
  cnpj: '20100000000101', razao_social: 'Marcenaria Um', prospeccao_status: 'a_contatar',
  telefone1: '(37) 99111-0001', telefone2: '(37) 3222-0202', email: 'dp@contabilmais.com',
  logradouro: 'Rua A', numero: '10', bairro: 'Centro', municipio_nome: 'DIVINOPOLIS', uf: 'MG', cep: '35500000',
} as unknown as RadarEmpresa;

const contato = (campo: string, over: Record<string, unknown> = {}) => ({
  campo, tipo: campo === 'email' ? 'email' : 'telefone', valor: 'x', automatico: false, motivos: null, grupos: null,
  corroborado: null, correcao_id: null, veredito: null, efetivo: false, visitar: false, calculado_em: '2026-11-08T06:50:00Z', ...over,
});
const TEL1_CONTABIL = { automatico: true, efetivo: true, motivos: ['telefone_compartilhado'], grupos: 12, correcao_id: 41 };

function abrir() { return render(<RadarDetailSheet empresa={EMPRESA} hojeISO="2026-11-08" onClose={() => {}} />); }

describe('RadarDetailSheet — contato provável da contabilidade', () => {
  beforeEach(() => { mutate.mockClear(); lente = false; leitura = undefined; });

  it('telefone1 da contabilidade: selo + motivo SÓ nele; o copiar perde o destaque; o telefone2 direto, não', () => {
    leitura = lerContatoContabil([contato('telefone1', TEL1_CONTABIL), contato('telefone2'), contato('email')]);
    abrir();
    const bloco1 = screen.getByTestId('radar-contabil-telefone1');
    expect(within(bloco1).getByTestId('radar-selo-contabil').textContent).toContain('Contato provável da contabilidade — prefira visita');
    expect(within(bloco1).getByTestId('radar-contabil-motivo').textContent).toBe('Este telefone aparece em 12 empresas sem vínculo entre si.');
    expect(within(screen.getByTestId('radar-contabil-telefone2')).queryByTestId('radar-selo-contabil')).toBeNull();
    expect(screen.getByLabelText('Copiar telefone (37) 99111-0001').className).toContain('text-muted-foreground');
    expect(screen.getByLabelText('Copiar telefone (37) 3222-0202').className).not.toContain('text-muted-foreground');
    // Um telefone da contabilidade, mas há outro direto: o endereço ganha destaque sem afirmar "todos".
    expect(screen.getByTestId('radar-prefira-visita').textContent).toContain('Um dos telefones parece ser da contabilidade');
  });

  it('todo contato da contabilidade (visitar): o endereço vem em destaque, com o mapa', () => {
    leitura = lerContatoContabil([
      contato('telefone1', { ...TEL1_CONTABIL, visitar: true }),
      contato('telefone2', { efetivo: true, veredito: true, correcao_id: 7, visitar: true }),
      contato('email', { automatico: true, efetivo: true, motivos: ['email_palavra'], visitar: true }),
    ]);
    abrir();
    const bloco = screen.getByTestId('radar-prefira-visita');
    expect(bloco.textContent).toContain('O telefone e o e-mail que a Receita tem parecem ser da contabilidade');
    expect(bloco.textContent).toContain('Rua A, 10, Centro, DIVINOPOLIS, MG, 35500000');
    expect(within(bloco).getByRole('link', { name: /Abrir no mapa/ }).getAttribute('href')).toContain('google.com/maps');
  });

  it('"Não é da contabilidade" manda o campo, o veredito e a versão vista (sem sobrescrita cega)', () => {
    leitura = lerContatoContabil([contato('telefone1', TEL1_CONTABIL)]);
    abrir();
    fireEvent.click(within(screen.getByTestId('radar-contabil-telefone1')).getByTestId('radar-contabil-nao-e'));
    expect(mutate).toHaveBeenCalledWith({
      cnpj: '20100000000101', campo: 'telefone1', veredito: false, correcaoVista: 41, automatico: true,
    });
  });

  it('contato direto oferece "É da contabilidade?" (veredito true) no campo certo', () => {
    leitura = lerContatoContabil([contato('telefone1'), contato('email')]);
    abrir();
    fireEvent.click(within(screen.getByTestId('radar-contabil-email')).getByTestId('radar-contabil-e'));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ campo: 'email', veredito: true, correcaoVista: null }));
    expect(screen.queryByTestId('radar-prefira-visita')).toBeNull();
  });

  it('nunca calculado (efetivo NULL): nem selo nem botão — não sei não vira "direto" nem "contabilidade"', () => {
    leitura = lerContatoContabil([contato('telefone1', { automatico: null, efetivo: null, calculado_em: null })]);
    abrir();
    expect(screen.queryByTestId('radar-contabil-telefone1')).toBeNull();
    expect(screen.queryByTestId('radar-prefira-visita')).toBeNull();
  });

  it('sob a lente "Ver como" a correção fica desligada', () => {
    lente = true;
    leitura = lerContatoContabil([contato('telefone1', TEL1_CONTABIL)]);
    abrir();
    expect((within(screen.getByTestId('radar-contabil-telefone1')).getByTestId('radar-contabil-nao-e') as HTMLButtonElement).disabled).toBe(true);
  });
});
