import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * "Já é cliente?" na ficha do Radar (RPC `radar_possiveis_vinculos`). O HOOK roda de verdade; só o supabase é
 * mockado — o defeito que importa mora na tradução "RPC falhou" → "tela de nenhum vínculo" (erro colapsado em
 * vazio diria ao vendedor que o CNPJ é cliente novo justo quando não conseguimos verificar).
 */
type Resposta = { data: unknown; error: { message: string } | null };
let resposta: Resposta = { data: [], error: null };
const rpc = vi.fn();
const range = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => {
      rpc(...args);
      return { range: (...r: unknown[]) => { range(...r); return Promise.resolve(resposta); } };
    },
  },
}));

import { RadarVinculosLead } from '../RadarVinculosLead';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RadarVinculosLead cnpj="11111111000101" />
    </QueryClientProvider>,
  );
}

describe('RadarVinculosLead', () => {
  beforeEach(() => { rpc.mockClear(); range.mockClear(); resposta = { data: [], error: null }; });

  it('chama a RPC com o CNPJ do lead e o teto de 10 linhas', async () => {
    montar();
    await screen.findByTestId('radar-vinculos-vazio');
    expect(rpc).toHaveBeenCalledWith('radar_possiveis_vinculos', { p_cnpj: '11111111000101' });
    expect(range).toHaveBeenCalledWith(0, 9);
  });

  it('mostra o sucessor com a evidência e o pedido de conferência', async () => {
    resposta = {
      data: [
        { cliente_cnpj: '21111111000101', cliente_nome: 'ANTIGA LTDA', cliente_situacao: '08', forca: 'forte', sinais: ['email', 'telefone'] },
        { cliente_cnpj: '23333333000101', cliente_nome: 'VIZINHA LTDA', cliente_situacao: '02', forca: 'media', sinais: ['endereco'] },
      ],
      error: null,
    };
    montar();
    const lista = await screen.findByTestId('radar-vinculos');
    expect(lista.textContent).toContain('pista forte');
    expect(lista.textContent).toContain('Possível sucessor de ANTIGA LTDA (baixada na Receita)');
    expect(lista.textContent).toContain('mesmo e-mail · mesmo telefone');
    expect(lista.textContent).toContain('pista média');
    expect(lista.textContent).toContain('Possível vínculo com VIZINHA LTDA');
    expect(lista.textContent).toContain('Confira com o cliente');
  });

  it('erro da RPC NÃO vira "nenhum vínculo"', async () => {
    resposta = { data: null, error: { message: 'boom' } };
    montar();
    await waitFor(() => expect(screen.getByText(/se este CNPJ tem vínculo com um cliente/)).toBeTruthy());
    expect(screen.queryByTestId('radar-vinculos-vazio')).toBeNull();
  });

  it('forma inesperada (sinal desconhecido) NÃO vira "nenhum vínculo"', async () => {
    resposta = {
      data: [{ cliente_cnpj: '2', cliente_nome: null, cliente_situacao: null, forca: 'forte', sinais: ['parente'] }],
      error: null,
    };
    montar();
    await waitFor(() => expect(screen.getByText(/se este CNPJ tem vínculo com um cliente/)).toBeTruthy());
    expect(screen.queryByTestId('radar-vinculos-vazio')).toBeNull();
  });
});
