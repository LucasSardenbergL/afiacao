import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Card do aviso de vínculo com devedor — o HOOK roda de verdade; só supabase, a lente e o track são mockados.
 * Money-path: falha/offline ≠ silêncio, CPF/fora da base = "não verificado", o sensor só diz "registrado" com
 * gravação REAL, e sob a lente nada é gravado.
 */
type Resp = { data: unknown; error: { message?: string } | null };
let aviso: () => Promise<Resp> = () => Promise.resolve({ data: null, error: { message: 'sem mock' } });
let registro: () => Promise<Resp> = () => Promise.resolve({ data: { registrado: true }, error: null });
const rpc = vi.fn((fn: string, _args: Record<string, unknown>) => (fn === 'credito_vinculo_aviso' ? aviso() : registro()));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (fn: string, a: Record<string, unknown>) => rpc(fn, a) } }));
let lente = false;
vi.mock('@/lib/impersonation/lens-write-guard', () => ({ isLensActive: () => lente }));
const track = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));

import { AvisoVinculoCredito } from '../AvisoVinculoCredito';

const comVencido = {
  estado: 'avaliado', regra_versao: 1, n_vinculos: 2, n_indeterminados: 1,
  vinculos: [{
    ref: 1, cliente_cnpj: null, cliente_nome: null, cliente_situacao: '08', forca: 'forte', sinais: ['endereco', 'telefone'],
    parcial: true,
    credoras: [{ company: 'colacor_sc', vencido: 80, n_titulos: 1, dias_vencido_max: 30, vencimento_mais_antigo: '2026-10-07',
                 sync_em: null, qualidade: 'sem_sync', n_ambiguos: 0, n_invalidos: 0 }],
  }],
};
const ok = (data: unknown) => () => Promise.resolve({ data, error: null });

function montar(documento: string | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AvisoVinculoCredito documento={documento} superficie="pedido" />
    </QueryClientProvider>,
  );
}
const chamadas = (fn: string) => rpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1]);

beforeEach(() => {
  rpc.mockClear(); track.mockClear(); lente = false; onlineManager.setOnline(true);
  registro = () => Promise.resolve({ data: { registrado: true }, error: null });
});
afterEach(() => { onlineManager.setOnline(true); });

describe('AvisoVinculoCredito', () => {
  it('com vencido: frase do aviso, cliente oculto, conta e valor, parcial; registra "servido" uma vez', async () => {
    aviso = ok(comVencido);
    montar('18.888.888/0001-01');
    const card = await screen.findByTestId('aviso-vinculo-credito');
    expect(card.textContent).toContain('Possível vínculo com cliente que possui títulos vencidos; requer conferência.');
    expect(card.textContent).toContain('um cliente da carteira — confira com a gestão');
    expect(screen.getByTestId('aviso-vinculo-1-colacor_sc').textContent).toContain('Colacor SC');
    expect(screen.getByTestId('aviso-vinculo-1-colacor_sc').textContent).toContain('sem registro de sync');
    expect(card.textContent).toContain('o vencido pode ser maior');
    expect(card.textContent).toContain('1 possível vínculo sem código Omie com prova');
    await waitFor(() => expect(chamadas('credito_vinculo_aviso_registrar')).toHaveLength(1));
    expect(chamadas('credito_vinculo_aviso_registrar')[0]).toEqual({ p_evento: 'servido', p_superficie: 'pedido', p_cnpj: '18888888000101' });
    expect(chamadas('credito_vinculo_aviso')[0]).toEqual({ p_cnpj: '18888888000101' });
  });

  it('conferência: manda ref + veredito e só diz "registrada" com gravação real', async () => {
    aviso = ok(comVencido);
    montar('18888888000101');
    fireEvent.click(await screen.findByText('Não tem relação'));
    await screen.findByTestId('aviso-vinculo-1-registrado');
    expect(chamadas('credito_vinculo_aviso_registrar')).toContainEqual(
      { p_evento: 'conferido', p_superficie: 'pedido', p_cnpj: '18888888000101', p_ref: 1, p_veredito: 'sem_relacao' });
  });

  it('conferência que o servidor recusa → "não consegui registrar", nunca "registrada"', async () => {
    aviso = ok(comVencido);
    montar('18888888000101');
    registro = () => Promise.resolve({ data: null, error: { message: 'não há aviso vigente' } });
    fireEvent.click(await screen.findByText('É o mesmo dono/grupo'));
    await screen.findByTestId('aviso-vinculo-1-erro');
    expect(screen.queryByTestId('aviso-vinculo-1-registrado')).toBeNull();
  });

  it('sob a lente "Ver como": card aparece, botões desabilitados, nada gravado', async () => {
    lente = true;
    aviso = ok(comVencido);
    montar('18888888000101');
    await screen.findByTestId('aviso-vinculo-credito');
    expect((screen.getByText('Não tem relação').closest('button') as HTMLButtonElement).disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(chamadas('credito_vinculo_aviso_registrar')).toHaveLength(0);
  });

  it('falha da RPC → "não foi possível", nunca silêncio', async () => {
    aviso = () => Promise.resolve({ data: null, error: { message: 'boom' } });
    montar('18888888000101');
    const f = await screen.findByTestId('aviso-vinculo-leitura-falhou');
    expect(f.getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByTestId('aviso-vinculo-credito')).toBeNull();
  });

  it('forma inesperada → "não foi possível" (o parser lança)', async () => {
    aviso = ok({ estado: 'avaliado', vinculos: 'x' });
    montar('18888888000101');
    expect((await screen.findByTestId('aviso-vinculo-leitura-falhou')).getAttribute('data-estado')).toBe('erro');
  });

  it('offline sem cache → "sem conexão", nunca silêncio', async () => {
    onlineManager.setOnline(false);
    aviso = ok(comVencido);
    montar('18888888000101');
    expect((await screen.findByTestId('aviso-vinculo-leitura-falhou')).getAttribute('data-estado')).toBe('sem-rede');
  });

  it('fora da base → nota neutra "não verificado"', async () => {
    aviso = ok({ estado: 'fora_da_base', regra_versao: 1 });
    montar('99999999000199');
    expect((await screen.findByTestId('aviso-vinculo-nao-verificado')).getAttribute('data-motivo')).toBe('fora_da_base');
  });

  it('CPF → "não verificado (só CNPJ)" sem chamar a RPC', async () => {
    montar('123.456.789-09');
    expect((await screen.findByTestId('aviso-vinculo-nao-verificado')).getAttribute('data-motivo')).toBe('cpf');
    expect(chamadas('credito_vinculo_aviso')).toHaveLength(0);
  });

  it('avaliação completa sem evidência → nada (e nenhum sensor)', async () => {
    aviso = ok({ estado: 'avaliado', regra_versao: 1, n_vinculos: 1, n_indeterminados: 0, vinculos: [] });
    const { container } = montar('13333333000101');
    await waitFor(() => expect(chamadas('credito_vinculo_aviso')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
    expect(chamadas('credito_vinculo_aviso_registrar')).toHaveLength(0);
  });
});
