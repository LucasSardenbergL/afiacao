// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { RadarEmpresa } from '@/queries/useRadarLista';
import type { RegistroInfo } from '../RadarOutcomeMenu';

/**
 * Pacote G4: a nota do vendedor nunca se perde. O bug: registro descartado como duplicado → a ficha avançava de
 * lead → o efeito de troca de CNPJ zerava o campo. O menu vira um dublê que devolve o `RegistroInfo` escolhido pelo
 * teste: o defeito que importa mora na ficha (avançar, apagar, guardar o rascunho).
 */
const { Nada, desfecho } = vi.hoisted(() => ({
  Nada: () => null,
  desfecho: { info: null as RegistroInfo | null },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-nota' } }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: () => Promise.resolve({ data: null, error: null }) } }));
vi.mock('@/lib/impersonation/lens-write-guard', () => ({ isLensActive: () => false }));
vi.mock('@/queries/useRadarTelefoneCompartilhado', () => ({ useRadarTelefoneCompartilhado: () => ({ data: undefined }) }));
vi.mock('@/queries/useRadarContatoContabil', () => ({
  useRadarContatoContabil: () => ({ data: undefined, isError: false }),
  useCorrigirContatoContabil: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock('@/queries/useRadarContatos', () => ({
  LIMITE_HISTORICO_RADAR: 20,
  useRadarContatos: () => ({ data: [], isPending: false, isError: false, isFetching: false, error: null, status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1, refetch: vi.fn() }),
}));
vi.mock('../RadarOutcomeMenu', () => ({
  RadarOutcomeMenu: ({ onRegistrado }: { onRegistrado?: (a: 'contatado_sem_resposta', i: RegistroInfo) => void }) => (
    <button type="button" onClick={() => desfecho.info && onRegistrado?.('contatado_sem_resposta', desfecho.info)}>registrar</button>
  ),
}));
vi.mock('../RadarAcoesLead', () => ({ RadarAcoesLead: Nada }));
vi.mock('../RadarConflitosCadastro', () => ({ RadarConflitosDoLead: Nada }));
vi.mock('../RadarAtendimentoLead', () => ({ RadarAtendimentoLead: Nada }));
vi.mock('../RadarModoDiscagem', () => ({ RadarModoDiscagem: Nada }));
vi.mock('../RadarSucessaoLead', () => ({ RadarSucessaoLead: Nada }));
vi.mock('@/components/credito-vinculo/AvisoVinculoCredito', () => ({ AvisoVinculoCredito: Nada }));

import { RadarDetailSheet } from '../RadarDetailSheet';
import { limparRascunhoNota } from '@/lib/radar/rascunho-nota';

function lead(cnpj: string): RadarEmpresa {
  return { cnpj, razao_social: `Lead ${cnpj}`, prospeccao_status: 'a_contatar' } as unknown as RadarEmpresa;
}
const A = '11222333000181';
const B = '44555666000172';
function ficha(empresa: RadarEmpresa, onProximo = vi.fn()) {
  return <RadarDetailSheet empresa={empresa} hojeISO="2026-11-08" onClose={() => {}} onProximo={onProximo} />;
}
const campo = () => screen.getByLabelText('Nota da conversa') as HTMLTextAreaElement;

beforeEach(() => {
  limparRascunhoNota(`u-nota:${A}`);
  limparRascunhoNota(`u-nota:${B}`);
  desfecho.info = null;
});

describe('RadarDetailSheet — a nota não se perde (pacote G4)', () => {
  it('nota NÃO gravada (dedupe no banco anterior): não avança e o texto fica no campo', () => {
    const onProximo = vi.fn();
    render(ficha(lead(A), onProximo));
    fireEvent.change(campo(), { target: { value: 'quer orçamento de verniz' } });
    desfecho.info = { deduped: true, notaGravada: false, notaEnviada: 'quer orçamento de verniz' };
    fireEvent.click(screen.getByText('registrar'));
    expect(onProximo).not.toHaveBeenCalled();
    expect(campo().value).toBe('quer orçamento de verniz');
  });

  it('nota gravada: apaga o campo e avança', () => {
    const onProximo = vi.fn();
    render(ficha(lead(A), onProximo));
    fireEvent.change(campo(), { target: { value: 'falei com o João' } });
    desfecho.info = { deduped: false, notaGravada: true, notaEnviada: 'falei com o João' };
    fireEvent.click(screen.getByText('registrar'));
    expect(onProximo).toHaveBeenCalledTimes(1);
    expect(campo().value).toBe('');
  });

  it('o vendedor continuou digitando durante a resposta: o texto NOVO fica (só apaga o que foi enviado)', () => {
    render(ficha(lead(A)));
    fireEvent.change(campo(), { target: { value: 'falei com o João e ele pediu amostra' } });
    desfecho.info = { deduped: false, notaGravada: true, notaEnviada: 'falei com o João' };
    fireEvent.click(screen.getByText('registrar'));
    expect(campo().value).toBe('falei com o João e ele pediu amostra');
  });

  it('trocar de lead com nota digitada GUARDA o rascunho; voltar o restaura', () => {
    const { rerender } = render(ficha(lead(A)));
    fireEvent.change(campo(), { target: { value: 'ligar depois das 14h' } });
    rerender(ficha(lead(B)));
    expect(campo().value).toBe('');
    rerender(ficha(lead(A)));
    expect(campo().value).toBe('ligar depois das 14h');
  });
});
