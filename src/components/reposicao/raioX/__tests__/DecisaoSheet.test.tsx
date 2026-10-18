/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReposicaoEmpresaProvider } from '@/contexts/ReposicaoEmpresaContext';
import type { DecisaoRow, Empresa, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { decisao } from '@/lib/reposicao/raio-x/__tests__/fixtures';

/**
 * Sheet de decisão do Raio-X (money-path: `raio_x_decidir` mexe em sku_parametros do motor de compras).
 * Guards: estado COMPLETO em toda chamada (S2), checkbox do motor só quando o SQL aceitaria (S3),
 * empresa do ITEM (não a do seletor), RX001/42501 com mensagem própria, contagem com vírgula pt-BR.
 */

type Resp = { data: unknown; error: unknown };
const rpc = vi.hoisted(() => vi.fn((_nome: string, _args: Record<string, unknown>): Promise<Resp> => Promise.resolve({ data: {}, error: null })));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (nome: string, args: Record<string, unknown>) => rpc(nome, args) },
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const track = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a), captureException: vi.fn() }));

import { DecisaoSheet } from '../DecisaoSheet';
import { RaioXContagem } from '../RaioXContagem';
import { useRaioXMutacoes } from '../useRaioXMutacoes';

const itemRX = (p: Partial<ItemRaioX> = {}): ItemRaioX => ({
  sku_codigo_omie: 1, codigo: 'C1', descricao: 'VERNIZ X', familia: null, tipo_produto: '00', ativo: true,
  saldo: 10, cmc: 5, unidade_estoque: 'UN', unidades_venda: null, no_motor: true, tipo_reposicao: 'normal',
  classe_abc: null, cadastro_em: null, ult_entrada: null, fornecedor: 'SAYERLACK', q12: 0, ncli: 0,
  ult_venda: null, preco_medio_12m: null, clientes: [], synced_at: null, habilitado_reposicao_automatica: true,
  valor: 50, cobertura: null, categoria: 'mercadoria', motivo_categoria: '', parado: true,
  destino_sugerido: 'liquidar', motivo_destino: 'sem venda há 12m', top: true, ...p,
});

const CTX: Record<Empresa, string> = { oben: 'OBEN', colacor: 'COLACOR' };

function abrir(p: { item?: ItemRaioX; decisao?: DecisaoRow; empresa?: Empresa; ctx?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidar = vi.spyOn(qc, 'invalidateQueries');
  const onClose = vi.fn();
  const empresa = p.empresa ?? 'oben';
  const ui = (ctx: string, item: ItemRaioX, d: DecisaoRow | undefined) => (
    <QueryClientProvider client={qc}>
      <ReposicaoEmpresaProvider value={{ empresa: ctx, setEmpresa: () => {} }}>
        <DecisaoSheet empresa={empresa} item={item} decisao={d} onClose={onClose} />
      </ReposicaoEmpresaProvider>
    </QueryClientProvider>
  );
  const ctx0 = p.ctx ?? CTX[empresa];
  const item0 = p.item ?? itemRX();
  const r = render(ui(ctx0, item0, p.decisao));
  return {
    onClose,
    invalidar,
    trocarCtx: (c: string) => r.rerender(ui(c, item0, p.decisao)),
    /** Simula o refetch com o Sheet aberto (outro operador gravou / motor mudou). */
    refetch: (n: { item?: ItemRaioX; decisao?: DecisaoRow }) => r.rerender(ui(ctx0, n.item ?? item0, n.decisao ?? p.decisao)),
  };
}

const salvar = () => screen.getByRole('button', { name: 'Salvar decisão' }) as HTMLButtonElement;
const argsDe = (nome: string) => rpc.mock.calls.filter((c) => c[0] === nome).map((c) => c[1]);

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation(() => Promise.resolve({ data: { tirou_do_motor: false }, error: null }));
  toast.error.mockReset();
  toast.success.mockReset();
  track.mockReset();
});

describe('DecisaoSheet', () => {
  it('(a) destino sugerido pré-selecionado, mas "Salvar" só habilita após um toque; manda o estado completo', async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: { tirou_do_motor: true }, error: null }));
    const { onClose, invalidar } = abrir();
    expect(screen.getByRole('button', { name: 'Liquidar' }).getAttribute('aria-pressed')).toBe('true');
    expect(salvar().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Liquidar' }));
    expect(salvar().disabled).toBe(false);
    fireEvent.click(salvar());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_decidir')).toEqual([{
      p_empresa: 'oben', p_sku: 1, p_destino: 'liquidar', p_categoria: 'mercadoria', p_observacao: null,
      p_fornecedor: null, p_credito_troca: null, p_tirar_do_motor: true, p_restaurar_motor: false,
    }]);
    expect(invalidar).toHaveBeenCalledWith({ queryKey: ['raio-x', 'oben'] });
    expect(toast.success).toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith('raio_x.decisao', expect.objectContaining({ empresa: 'oben', destino: 'liquidar', tirou_do_motor: true }));
  });

  it('(a) uso e consumo: sugestão não pré-seleciona (P10)', () => {
    abrir({ item: itemRX({ categoria: 'uso_consumo' }) });
    expect(screen.getByRole('button', { name: 'Liquidar' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('(S2) decisão já gravada: observação e fornecedor informados voltam na chamada', async () => {
    const { onClose } = abrir({
      item: itemRX({ fornecedor: null }),
      decisao: decisao(1, { destino: 'trocar', observacao: 'ligar p/ rep', fornecedor_informado: 'ACRE', credito_troca: 30 }),
    });
    fireEvent.change(screen.getByLabelText('Observação'), { target: { value: 'ligar p/ rep amanhã' } });
    fireEvent.click(salvar());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_decidir')[0]).toMatchObject({
      p_destino: 'trocar', p_observacao: 'ligar p/ rep amanhã', p_fornecedor: 'ACRE', p_credito_troca: 30,
    });
  });

  it('(b) checkbox "tirar do motor" marcado em liquidar, ausente em venda_dirigida', () => {
    abrir();
    const cb = screen.getByRole('checkbox', { name: /tirar do motor/i }) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Venda dirigida' }));
    expect(screen.queryByRole('checkbox', { name: /tirar do motor/i })).toBeNull();
  });

  it('(b) desmarcar o checkbox (já é um toque) manda p_tirar_do_motor=false', async () => {
    const { onClose } = abrir();
    fireEvent.click(screen.getByRole('checkbox', { name: /tirar do motor/i }));
    fireEvent.click(salvar());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_decidir')[0]).toMatchObject({ p_tirar_do_motor: false });
  });

  it('(c) Colacor → "sem motor de reposição — nada a desligar", sem checkbox', () => {
    abrir({ empresa: 'colacor' });
    expect(screen.getByText('sem motor de reposição — nada a desligar')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /tirar do motor/i })).toBeNull();
  });

  it('(S3) Oben já no alvo → "já fora do motor"; sem sku_parametros → "sem parâmetro de reposição"', () => {
    abrir({ item: itemRX({ habilitado_reposicao_automatica: false, tipo_reposicao: 'descontinuado' }) });
    expect(screen.getByText('já fora do motor')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /tirar do motor/i })).toBeNull();
  });

  it('(S3) Oben sem sku_parametros → "sem parâmetro de reposição — nada a desligar"', () => {
    abrir({ item: itemRX({ no_motor: false }) });
    expect(screen.getByText('sem parâmetro de reposição — nada a desligar')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /tirar do motor/i })).toBeNull();
  });

  it('(d) motor_antes presente → "Restaurar motor ao estado anterior" com aviso, estado completo e restaurar=true', async () => {
    const { onClose } = abrir({
      decisao: decisao(1, { destino: 'liquidar', observacao: 'x', tirou_do_motor: true, motor_antes: { tipo_reposicao: 'normal', habilitado: true } }),
    });
    expect(screen.getByText(/repõe exatamente o estado anterior; ajustes manuais feitos depois serão desfeitos/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar motor ao estado anterior' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_decidir')).toEqual([{
      p_empresa: 'oben', p_sku: 1, p_destino: 'liquidar', p_categoria: 'mercadoria', p_observacao: 'x',
      p_fornecedor: null, p_credito_troca: null, p_tirar_do_motor: false, p_restaurar_motor: true,
    }]);
  });

  it('(d) sem motor_antes → sem botão de restaurar', () => {
    abrir({ decisao: decisao(1, { destino: 'liquidar' }) });
    expect(screen.queryByRole('button', { name: 'Restaurar motor ao estado anterior' })).toBeNull();
  });

  it('(e) a chamada usa a empresa do item, e trocar a empresa no contexto fecha o Sheet', async () => {
    const { onClose, trocarCtx } = abrir({ empresa: 'colacor' });
    fireEvent.click(screen.getByRole('button', { name: 'Liquidar' }));
    fireEvent.click(salvar());
    await waitFor(() => expect(argsDe('raio_x_decidir')).toHaveLength(1));
    expect(argsDe('raio_x_decidir')[0]).toMatchObject({ p_empresa: 'colacor', p_tirar_do_motor: false });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    onClose.mockClear();
    trocarCtx('OBEN');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('(e) sem troca de empresa o Sheet não se fecha sozinho', () => {
    const { onClose } = abrir();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('(f) erro RX001 → toast com a mensagem de desmarcar "tirar do motor"; Sheet continua aberto', async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { code: 'RX001', message: 'raio_x: sku sem sku_parametros (oben/1)' } }));
    const { onClose } = abrir();
    fireEvent.click(screen.getByRole('button', { name: 'Liquidar' }));
    fireEvent.click(salvar());
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith('Este SKU não tem parâmetro de reposição — desmarque "tirar do motor"');
    expect(onClose).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('(M-b) RX001 no Restaurar → mensagem própria (não "desmarque tirar do motor")', async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { code: 'RX001', message: 'raio_x: sku sem sku_parametros (oben/1)' } }));
    abrir({ decisao: decisao(1, { destino: 'liquidar', tirou_do_motor: true, motor_antes: { tipo_reposicao: 'normal', habilitado: true } }) });
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar motor ao estado anterior' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith('Este SKU não tem mais parâmetro de reposição — não há motor para restaurar');
  });

  it('(f) 42501 → sem permissão; outro erro → mensagem do servidor (nunca [object Object])', async () => {
    rpc.mockImplementationOnce(() => Promise.resolve({ data: null, error: { code: '42501', message: 'RAIO_X_SO_CUSTO' } }));
    abrir();
    fireEvent.click(screen.getByRole('button', { name: 'Liquidar' }));
    fireEvent.click(salvar());
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error.mock.calls[0][0]).toMatch(/sem permissão/i);
    rpc.mockImplementationOnce(() => Promise.resolve({ data: null, error: { code: '22023', message: 'raio_x: destino invalido' } }));
    fireEvent.click(salvar());
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
    expect(toast.error.mock.calls[1][0]).toMatch(/raio_x: destino invalido/);
    expect(String(toast.error.mock.calls[1][0])).not.toMatch(/object Object/);
  });

  it('(g) liquidar da fase A com motor intocado → selo + "tirar do motor agora" (estado completo, tirar=true)', async () => {
    const { onClose } = abrir({
      decisao: decisao(1, { destino: 'liquidar', origem: 'artifact_fase_a', tirou_do_motor: false, observacao: 'fase A' }),
    });
    expect(screen.getByText('decidido na fase A — motor não foi tocado')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'tirar do motor agora' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_decidir')).toEqual([{
      p_empresa: 'oben', p_sku: 1, p_destino: 'liquidar', p_categoria: 'mercadoria', p_observacao: 'fase A',
      p_fornecedor: null, p_credito_troca: null, p_tirar_do_motor: true, p_restaurar_motor: false,
    }]);
  });

  it('(g) fase A mas já fora do motor (ou Colacor) → selo sem a ação', () => {
    abrir({
      item: itemRX({ habilitado_reposicao_automatica: false, tipo_reposicao: 'descontinuado' }),
      decisao: decisao(1, { destino: 'liquidar', origem: 'artifact_fase_a' }),
    });
    expect(screen.getByText('decidido na fase A — motor não foi tocado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'tirar do motor agora' })).toBeNull();
  });

  it('(S8-i) decisão gravada liquidar com tirou=false: editar só a observação e salvar NÃO desliga o motor', async () => {
    const { onClose } = abrir({ decisao: decisao(1, { destino: 'liquidar', tirou_do_motor: false, observacao: 'a' }) });
    expect((screen.getByRole('checkbox', { name: /tirar do motor/i }) as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText('Observação'), { target: { value: 'b' } });
    fireEvent.click(salvar());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_decidir')[0]).toMatchObject({ p_destino: 'liquidar', p_observacao: 'b', p_tirar_do_motor: false });
  });

  it('(S8) com decisão gravada: destino-alvo DIFERENTE do gravado pré-marca; voltar ao gravado desmarca', () => {
    abrir({ decisao: decisao(1, { destino: 'liquidar' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Trocar' }));
    expect((screen.getByRole('checkbox', { name: /tirar do motor/i }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Liquidar' }));
    expect((screen.getByRole('checkbox', { name: /tirar do motor/i }) as HTMLInputElement).checked).toBe(false);
  });

  it('(S8-ii) sem decisão gravada, clicar liquidar → checkbox marcado', () => {
    abrir({ item: itemRX({ categoria: 'uso_consumo' }) }); // sem pré-seleção
    expect(screen.queryByRole('checkbox', { name: /tirar do motor/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Liquidar' }));
    expect((screen.getByRole('checkbox', { name: /tirar do motor/i }) as HTMLInputElement).checked).toBe(true);
  });

  it('(S9-iii) decisão muda com o painel aberto → Salvar bloqueado + aviso; Recarregar traz os valores novos e exige toque', () => {
    const d0 = decisao(1, { destino: 'liquidar', observacao: 'velha', atualizado_em: '2026-10-18T10:00:00Z' });
    const { refetch } = abrir({ decisao: d0 });
    fireEvent.change(screen.getByLabelText('Observação'), { target: { value: 'rascunho' } });
    expect(salvar().disabled).toBe(false);
    refetch({ decisao: { ...d0, observacao: 'do outro operador', atualizado_em: '2026-10-18T10:05:00Z' } });
    expect(screen.getByText('Esta decisão mudou enquanto o painel estava aberto — recarregue')).toBeTruthy();
    expect(salvar().disabled).toBe(true);
    fireEvent.click(salvar());
    expect(rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar' }));
    expect(screen.queryByText('Esta decisão mudou enquanto o painel estava aberto — recarregue')).toBeNull();
    expect((screen.getByLabelText('Observação') as HTMLTextAreaElement).value).toBe('do outro operador');
    expect(salvar().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Liquidar' }));
    expect(salvar().disabled).toBe(false);
  });

  it('(S9) motor restaurado por outro operador com o painel aberto → Restaurar e Tirar-agora bloqueados', () => {
    const d0 = decisao(1, { destino: 'liquidar', origem: 'artifact_fase_a', motor_antes: { tipo_reposicao: 'normal', habilitado: true } });
    const { refetch } = abrir({ decisao: d0 });
    refetch({ item: itemRX({ habilitado_reposicao_automatica: false }) });
    expect(screen.getByText('Esta decisão mudou enquanto o painel estava aberto — recarregue')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Restaurar motor ao estado anterior' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'tirar do motor agora' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('crédito de troca inválido → erro no campo, nada enviado; válido → vai com vírgula pt-BR', async () => {
    const { onClose } = abrir();
    fireEvent.click(screen.getByRole('button', { name: 'Trocar' }));
    fireEvent.change(screen.getByLabelText('Crédito de troca (R$)'), { target: { value: 'abc' } });
    fireEvent.click(salvar());
    expect(screen.getByText('número inválido — use vírgula para decimais (ex.: 12,5)')).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Crédito de troca (R$)'), { target: { value: '1.234,50' } });
    fireEvent.click(salvar());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_decidir')[0]).toMatchObject({ p_destino: 'trocar', p_credito_troca: 1234.5 });
  });

  it('reclassificar exige motivo e chama raio_x_classificar com a empresa do item', async () => {
    const { onClose } = abrir({ empresa: 'colacor' });
    fireEvent.click(screen.getByRole('button', { name: 'reclassificar' }));
    fireEvent.change(screen.getByLabelText('Nova categoria'), { target: { value: 'uso_consumo' } });
    const botao = screen.getByRole('button', { name: 'Salvar classificação' }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: '   ' } });
    expect(botao.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'consumido na fábrica' } });
    fireEvent.click(botao);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_classificar')).toEqual([{ p_empresa: 'colacor', p_sku: 1, p_categoria: 'uso_consumo', p_motivo: 'consumido na fábrica' }]);
    expect(track).toHaveBeenCalledWith('raio_x.reclassificacao', { empresa: 'colacor', categoria: 'uso_consumo' });
  });
});

describe('RaioXContagem — campo de contagem', () => {
  function abrirContagem(empresa: Empresa = 'oben') {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidar = vi.spyOn(qc, 'invalidateQueries');
    render(
      <QueryClientProvider client={qc}>
        <RaioXContagem empresa={empresa} categoria="uso_consumo" itens={[itemRX({ categoria: 'uso_consumo', parado: false })]} decisoes={new Map()} onDecidir={() => {}} />
      </QueryClientProvider>,
    );
    return { invalidar };
  }

  it('(h) "12,5" → contar com 12.5', async () => {
    const { invalidar } = abrirContagem();
    fireEvent.change(screen.getByLabelText('Qtd contada C1'), { target: { value: '12,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar contagem C1' }));
    await waitFor(() => expect(argsDe('raio_x_contar')).toHaveLength(1));
    expect(argsDe('raio_x_contar')[0]).toEqual({ p_empresa: 'oben', p_sku: 1, p_qtd: 12.5 });
    await waitFor(() => expect(invalidar).toHaveBeenCalledWith({ queryKey: ['raio-x', 'oben'] }));
  });

  it('(M-a) diferença em unidades sai pt-BR com até 3 casas: 12,5 − 10,3 → "+2,2"', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <RaioXContagem empresa="oben" categoria="uso_consumo" itens={[itemRX({ categoria: 'uso_consumo', parado: false, saldo: 10.3 })]}
          decisoes={new Map([[1, decisao(1, { qtd_contada: 12.5 })]])} onDecidir={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('dif-un-1').textContent).toBe('+2,2');
  });

  it('(h) "abc" → erro no campo, nada enviado', () => {
    abrirContagem();
    fireEvent.change(screen.getByLabelText('Qtd contada C1'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar contagem C1' }));
    expect(screen.getByText('número inválido — use vírgula para decimais (ex.: 12,5)')).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('(h) campo vazio → contar com null (limpa a contagem)', async () => {
    abrirContagem('colacor');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar contagem C1' }));
    await waitFor(() => expect(argsDe('raio_x_contar')).toHaveLength(1));
    expect(argsDe('raio_x_contar')[0]).toEqual({ p_empresa: 'colacor', p_sku: 1, p_qtd: null });
  });
});

describe('useRaioXMutacoes — empresa da mutação (S10)', () => {
  it('(iv) contagem iniciada em oben e hook re-renderizado com colacor → invalida ["raio-x","oben"]', async () => {
    let soltar: (r: Resp) => void = () => {};
    rpc.mockImplementation(() => new Promise<Resp>((res) => { soltar = res; }));
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidar = vi.spyOn(qc, 'invalidateQueries');
    const { result, rerender } = renderHook(({ e }: { e: Empresa }) => useRaioXMutacoes(e), {
      initialProps: { e: 'oben' as Empresa },
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    let p: Promise<boolean> = Promise.resolve(false);
    act(() => { p = result.current.contar(1, 5); });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(argsDe('raio_x_contar')[0]).toMatchObject({ p_empresa: 'oben' });
    rerender({ e: 'colacor' });
    await act(async () => { soltar({ data: {}, error: null }); await p; });
    expect(invalidar).toHaveBeenCalledWith({ queryKey: ['raio-x', 'oben'] });
    expect(invalidar).not.toHaveBeenCalledWith({ queryKey: ['raio-x', 'colacor'] });
  });

  it('(M2) tirar e restaurar juntos → toast de erro, nada enviado', async () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useRaioXMutacoes('oben'), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    let ok = true;
    await act(async () => {
      ok = await result.current.decidir({
        sku: 1, destino: 'liquidar', categoria: 'mercadoria', observacao: null, fornecedor: null,
        creditoTroca: null, tirarDoMotor: true, restaurarMotor: true,
      });
    });
    expect(ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Não é possível tirar e restaurar o motor na mesma gravação.');
  });
});
