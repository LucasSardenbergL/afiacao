/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReposicaoEmpresaProvider } from '@/contexts/ReposicaoEmpresaContext';
import type { DecisaoRow, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { decisao } from '@/lib/reposicao/raio-x/__tests__/fixtures';

/**
 * Seção "Execução" do Sheet (pacote 2): `raio_x_planejar` com estado completo, piso/canal só no liquidar,
 * número pt-BR inválido não sai do cliente, só aparece para decisão GRAVADA de destino executável.
 */

type Resp = { data: unknown; error: unknown };
const rpc = vi.hoisted(() => vi.fn((_nome: string, _args: Record<string, unknown>): Promise<Resp> => Promise.resolve({ data: {}, error: null })));
// versão viva da decisão no servidor (o salvar combinado relê antes de gravar — RX003 do lado do cliente)
const viva = vi.hoisted(() => ({ v: null as string | null }));
vi.mock('@/integrations/supabase/client', () => {
  const sel = { eq: () => sel, maybeSingle: () => Promise.resolve({ data: viva.v === null ? null : { atualizado_em: viva.v }, error: null }) };
  return {
    supabase: {
      rpc: (nome: string, args: Record<string, unknown>) => rpc(nome, args),
      from: () => ({ select: () => sel }),
    },
  };
});
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const track = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a), captureException: vi.fn() }));
const ledger = vi.hoisted(() => vi.fn());
vi.mock('@/lib/analytics-ledger', () => ({ registrarNoLedger: (...a: unknown[]) => ledger(...a) }));
vi.mock('@/lib/time/sp-day', async (orig) => ({ ...(await orig<typeof import('@/lib/time/sp-day')>()), hojeSP: () => '2026-11-01' }));

import { DecisaoSheet, type FilaSheet } from '../DecisaoSheet';

const itemRX = (p: Partial<ItemRaioX> = {}): ItemRaioX => ({
  sku_codigo_omie: 1, codigo: 'C1', descricao: 'VERNIZ X', familia: null, tipo_produto: '00', ativo: true,
  saldo: 10, cmc: 5, unidade_estoque: 'UN', unidades_venda: ['UN'], no_motor: true, tipo_reposicao: 'normal',
  classe_abc: null, cadastro_em: null, ult_entrada: null, fornecedor: 'SAYERLACK', q12: 0, ncli: 0,
  ult_venda: null, preco_medio_12m: 9, clientes: [], synced_at: null, habilitado_reposicao_automatica: true,
  valor: 6000, cobertura: null, categoria: 'mercadoria', motivo_categoria: '', parado: true,
  destino_sugerido: 'liquidar', motivo_destino: '', alerta_recompra: null, inequivoco: null, motivos_espera: [], qtd_liquidavel: null, ultima_entrada: null, top: true, top_atual: true, entrou_no_top: false, ...p,
});

const EQUIPE = [
  { user_id: 'u-ana', nome: 'Ana' },
  { user_id: 'u-bia', nome: 'Bia' },
];

function abrir(d: DecisaoRow | undefined, item = itemRX(), taxa: number | null = 0.18, extra: { fila?: FilaSheet; onSalvo?: () => void } = {}) {
  viva.v = d?.atualizado_em ?? null;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <ReposicaoEmpresaProvider value={{ empresa: 'OBEN', setEmpresa: () => {} }}>
        <DecisaoSheet empresa="oben" item={item} decisao={d} onClose={onClose} taxa={taxa} equipe={EQUIPE} userId="u-eu" {...extra} />
      </ReposicaoEmpresaProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}
const salvarDec = () => screen.getByRole('button', { name: 'Salvar decisão' }) as HTMLButtonElement;
/** decidir devolve a linha gravada (com a versão nova); planejar devolve {}. */
const VERSAO_NOVA = '2026-11-02T10:00:00Z';
const servidorOk = () => rpc.mockImplementation((nome: string) => Promise.resolve(
  nome === 'raio_x_decidir' ? { data: { atualizado_em: VERSAO_NOVA, tirou_do_motor: false }, error: null } : { data: {}, error: null },
));

const salvarExec = () => screen.getByRole('button', { name: 'Salvar execução' }) as HTMLButtonElement;
const argsDe = (nome: string) => rpc.mock.calls.filter((c) => c[0] === nome).map((c) => c[1]);
const liquidar = decisao(1, { destino: 'liquidar', decidido_por: 'u-ana', decidido_em: '2026-10-30T00:00:00Z' });

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation(() => Promise.resolve({ data: {}, error: null }));
  toast.error.mockReset();
  toast.success.mockReset();
  track.mockReset();
});

describe('DecisaoSheet — execução', () => {
  it('sem decisão gravada: destino com execução mostra a seção ANTES do 1º salvar, com os padrões (quem decide, prazo)', () => {
    abrir(undefined);
    expect(screen.getByRole('region', { name: 'Execução' })).toBeTruthy();
    expect((screen.getByLabelText('Responsável') as HTMLSelectElement).value).toBe('u-eu');
    expect((screen.getByLabelText('Prazo') as HTMLInputElement).value).toBe('2026-11-15');
  });

  it('destino sem execução (estratégico): a seção some', () => {
    abrir(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Estratégico' }));
    expect(screen.queryByRole('region', { name: 'Execução' })).toBeNull();
  });

  it('estratégico não tem execução', () => {
    abrir(decisao(1, { destino: 'estrategico' }));
    expect(screen.queryByRole('button', { name: 'Salvar execução' })).toBeNull();
  });

  it('plano novo: padrões (quem decidiu, hoje + 14) salváveis sem toque; manda o estado completo', async () => {
    const { onClose } = abrir(liquidar);
    expect(salvarExec().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/Preço piso/), { target: { value: '7,5' } });
    fireEvent.change(screen.getByLabelText('Canal'), { target: { value: 'outlet_queima' } });
    fireEvent.click(salvarExec());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_planejar')).toEqual([{
      p_empresa: 'oben', p_sku: 1, p_preco_piso: 7.5, p_canal: 'outlet_queima', p_responsavel: 'u-ana',
      p_prazo: '2026-11-15', p_concluido: false, p_atualizado_em: '2026-10-14T00:00:00Z', p_frete: null, p_troca_contrapartida: null,
    }]);
    expect(argsDe('raio_x_decidir')).toEqual([]);
    expect(track).toHaveBeenCalledWith('raio_x.plano', expect.objectContaining({ empresa: 'oben', tem_piso: true, canal: 'outlet_queima' }));
  });

  it('piso: mostra a unidade de venda e as referências; inválido não envia', () => {
    abrir(liquidar);
    expect(screen.getByLabelText('Preço piso (R$ por UN)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Preço piso/), { target: { value: '7.5' } });
    fireEvent.click(salvarExec());
    expect(screen.getByText(/número inválido/)).toBeTruthy();
    expect(argsDe('raio_x_planejar')).toEqual([]);
  });

  it('venda dirigida: sem piso nem canal; piso gravado de um liquidar antigo nunca é reenviado', async () => {
    const { onClose } = abrir(decisao(1, {
      destino: 'venda_dirigida', preco_piso: 3, canal_liquidacao: 'outro', responsavel: 'u-bia', prazo: '2026-11-20',
    }));
    expect(screen.queryByLabelText(/Preço piso/)).toBeNull();
    expect(salvarExec().disabled).toBe(true); // plano já gravado: exige toque
    fireEvent.click(screen.getByLabelText('executado'));
    fireEvent.click(salvarExec());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_planejar')).toEqual([{
      p_empresa: 'oben', p_sku: 1, p_preco_piso: null, p_canal: null, p_responsavel: 'u-bia',
      p_prazo: '2026-11-20', p_concluido: true, p_atualizado_em: '2026-10-14T00:00:00Z', p_frete: null, p_troca_contrapartida: null,
    }]);
  });

  it('plano existente: responsável/prazo apagados de propósito NÃO voltam ao padrão ao editar o piso', async () => {
    const { onClose } = abrir(decisao(1, { destino: 'liquidar', decidido_por: 'u-ana', preco_piso: 5 }));
    expect((screen.getByLabelText('Responsável') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Prazo') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText(/Preço piso/), { target: { value: '6' } });
    fireEvent.click(salvarExec());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_planejar')[0]).toEqual(expect.objectContaining({ p_preco_piso: 6, p_responsavel: null, p_prazo: null }));
  });

  it('bug 1 — Observação E Canal mexidos: UM salvar grava decisão e depois plano (com a versão que a decisão devolveu)', async () => {
    servidorOk();
    const { onClose } = abrir(liquidar);
    fireEvent.change(screen.getByLabelText('Observação'), { target: { value: 'cliente Fulano' } });
    fireEvent.change(screen.getByLabelText('Canal'), { target: { value: 'outro' } });
    expect(salvarDec().disabled).toBe(false);
    fireEvent.click(salvarDec());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['raio_x_decidir', 'raio_x_planejar']);
    expect(argsDe('raio_x_decidir')[0]).toEqual(expect.objectContaining({ p_destino: 'liquidar', p_observacao: 'cliente Fulano', p_tirar_do_motor: false }));
    expect(argsDe('raio_x_planejar')[0]).toEqual(expect.objectContaining({ p_canal: 'outro', p_atualizado_em: VERSAO_NOVA }));
    expect(toast.success).toHaveBeenCalledWith('Decisão e execução salvas');
  });

  it('bug 1 — reverter o texto não deixa nada travado: o botão continua salvável', () => {
    abrir(liquidar);
    fireEvent.change(screen.getByLabelText('Observação'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Canal'), { target: { value: 'outro' } });
    fireEvent.change(screen.getByLabelText('Observação'), { target: { value: '' } });
    expect(salvarDec().disabled).toBe(false);
  });

  it('UX 5 — liquidar num passo: decisão nova + piso/canal/responsável/prazo no MESMO salvar', async () => {
    servidorOk();
    const { onClose } = abrir(undefined, itemRX({ inequivoco: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Liquidar' }));
    fireEvent.change(screen.getByLabelText(/Preço piso/), { target: { value: '7,5' } });
    fireEvent.change(screen.getByLabelText('Canal'), { target: { value: 'outlet_queima' } });
    fireEvent.click(salvarDec());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_planejar')).toEqual([{
      p_empresa: 'oben', p_sku: 1, p_preco_piso: 7.5, p_canal: 'outlet_queima', p_responsavel: 'u-eu',
      p_prazo: '2026-11-15', p_concluido: false, p_atualizado_em: VERSAO_NOVA, p_frete: null, p_troca_contrapartida: null,
    }]);
  });

  it('sucesso parcial: decisão gravou, plano falhou → aviso que diz isso e o painel segue (a decisão conta)', async () => {
    rpc.mockImplementation((nome: string) => Promise.resolve(
      nome === 'raio_x_decidir'
        ? { data: { atualizado_em: VERSAO_NOVA }, error: null }
        : { data: null, error: { code: '22023', message: 'raio_x: responsavel nao e da equipe' } },
    ));
    const onSalvo = vi.fn();
    abrir(undefined, itemRX({ inequivoco: true }), 0.18, { onSalvo });
    fireEvent.click(screen.getByRole('button', { name: 'Liquidar' }));
    fireEvent.click(salvarDec());
    await waitFor(() => expect(onSalvo).toHaveBeenCalled());
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/^Decisão salva, mas a execução NÃO: raio_x: responsavel nao e da equipe/));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('decisão recusada (RX004): nada de plano, painel aberto', async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { code: 'RX004', message: 'x' } }));
    const onSalvo = vi.fn();
    abrir(undefined, itemRX(), 0.18, { onSalvo });
    fireEvent.click(screen.getByRole('button', { name: 'Liquidar' }));
    fireEvent.click(salvarDec());
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(argsDe('raio_x_planejar')).toEqual([]);
    expect(onSalvo).not.toHaveBeenCalled();
  });

  it('trocar o destino de uma decisão executada não herda o "executado"', async () => {
    servidorOk();
    const { onClose } = abrir(decisao(1, {
      destino: 'venda_dirigida', responsavel: 'u-bia', prazo: '2026-11-20',
      decidido_em: '2026-10-20T00:00:00Z', concluido_em: '2026-10-25T00:00:00Z',
    }));
    expect((screen.getByLabelText('executado') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Trocar' }));
    expect((screen.getByLabelText('executado') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(salvarDec());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_planejar')[0]).toEqual(expect.objectContaining({ p_concluido: false, p_preco_piso: null }));
  });

  it('RX003 (outro operador gravou no meio) vira mensagem própria', async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { code: 'RX003', message: 'raio_x: decisao mudou' } }));
    abrir(liquidar);
    fireEvent.click(salvarExec());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Outra pessoa mudou esta decisão — recarregue antes de salvar a execução'));
  });

  it('executado antes de re-decidir (destino mudou) nasce desmarcado', () => {
    abrir(decisao(1, {
      destino: 'trocar', responsavel: 'u-bia', prazo: '2026-11-20',
      decidido_em: '2026-11-01T00:00:00Z', concluido_em: '2026-10-20T00:00:00Z',
    }));
    expect((screen.getByLabelText('executado') as HTMLInputElement).checked).toBe(false);
  });

  it('RX002 (decisão desfeita) vira mensagem própria', async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { code: 'RX002', message: 'raio_x: sem decisao' } }));
    abrir(liquidar);
    fireEvent.click(salvarExec());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Esta decisão foi desfeita — grave o destino antes do plano'));
  });

  it('custo de esperar no cabeçalho; sem taxa não exibe número (nunca R$ 0)', () => {
    abrir(liquidar);
    expect(screen.getByText(/custa ~R\$\s?90\/mês parado/)).toBeTruthy();
  });

  it('sem taxa: sem custo de esperar', () => {
    abrir(liquidar, itemRX(), null);
    expect(screen.queryByText(/mês parado/)).toBeNull();
  });

  it('fila: cabeçalho "x de 61 · R$ pendente" e Pular; salvar chama onSalvo (o próximo), não fecha', async () => {
    servidorOk();
    const onPular = vi.fn();
    const onSalvo = vi.fn();
    const { onClose } = abrir(undefined, itemRX({ inequivoco: true }), 0.18, { fila: { decididos: 12, total: 61, pendente: 250000, onPular }, onSalvo });
    expect(screen.getByTestId('fila-cabecalho').textContent).toMatch(/12 de 61 decididos · R\$\s?250\.000 pendente/);
    fireEvent.click(screen.getByRole('button', { name: 'Pular' }));
    expect(onPular).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar: Liquidar' }));
    await waitFor(() => expect(onSalvo).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    // sensor: decisão gravada pela fila
    expect(ledger).toHaveBeenCalledWith('reposicao.raio_x_decisao', 'oben:1:fila', { empresa: 'oben', origem: 'fila', destino: 'liquidar' });
  });

  it('UX 2 — "Confirmar: <sugestão>" é 1 toque; a pré-seleção passiva continua não salvando', async () => {
    servidorOk();
    const { onClose } = abrir(undefined, itemRX({ inequivoco: true }));
    expect(salvarDec().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar: Liquidar' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(argsDe('raio_x_decidir')[0]).toEqual(expect.objectContaining({ p_destino: 'liquidar', p_tirar_do_motor: true }));
    expect(argsDe('raio_x_planejar')[0]).toEqual(expect.objectContaining({ p_responsavel: 'u-eu', p_prazo: '2026-11-15', p_preco_piso: null }));
    expect(ledger).toHaveBeenCalledWith('reposicao.raio_x_decisao', 'oben:1:sheet', expect.objectContaining({ origem: 'sheet' }));
  });

  it('mexer só na execução de um destino pré-selecionado NÃO grava a pré-seleção', () => {
    abrir(undefined);
    fireEvent.change(screen.getByLabelText('Canal'), { target: { value: 'outro' } });
    expect(salvarDec().disabled).toBe(true);
  });

  it('escolher outro destino esconde o "Confirmar"', () => {
    abrir(undefined, itemRX({ inequivoco: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Trocar' }));
    expect(screen.queryByRole('button', { name: /^Confirmar/ })).toBeNull();
  });

  it('bug 2 — linha histórica (saiu do estoque): decidível, sem confirmar nem motor', () => {
    abrir(undefined, itemRX({ fora_do_estoque: true, valor_coorte: 4200, valor: null, saldo: 0, destino_sugerido: null }));
    expect(screen.getByText(/Saiu do estoque \(saldo zerado\)/)).toBeTruthy();
    expect(screen.getByText(/foto da coorte/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Confirmar/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Trocar' }));
    expect(screen.queryByLabelText('tirar do motor')).toBeNull();
    expect(salvarDec().disabled).toBe(false);
  });

  it('Codex P1 — outro operador gravou depois da leitura: o salvar combinado recusa ANTES de gravar (nada de plano velho por cima)', async () => {
    servidorOk();
    abrir(liquidar);
    viva.v = '2026-11-02T09:00:00Z'; // B salvou piso/plano depois que A abriu
    fireEvent.change(screen.getByLabelText('Observação'), { target: { value: 'só a observação' } });
    fireEvent.click(salvarDec());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Outra pessoa mudou esta decisão — recarregue antes de salvar a execução'));
    expect(rpc).not.toHaveBeenCalled();
  });

  it('Codex P1 — troca por ENCALHE: crédito só depois da contrapartida; plano falhando, o crédito não conta como liberado', async () => {
    rpc.mockImplementation((nome: string) => Promise.resolve(
      nome === 'raio_x_decidir'
        ? { data: { atualizado_em: VERSAO_NOVA }, error: null }
        : { data: null, error: { code: '08006', message: 'rede caiu' } },
    ));
    const onSalvo = vi.fn();
    abrir(undefined, itemRX({ destino_sugerido: 'trocar' }), 0.18, { onSalvo });
    fireEvent.click(screen.getByRole('button', { name: 'Trocar' }));
    fireEvent.change(screen.getByLabelText('Crédito de troca (R$)'), { target: { value: '60.000' } });
    fireEvent.change(screen.getByLabelText('O que entra no lugar'), { target: { value: 'encalhe' } });
    fireEvent.click(salvarDec());
    await waitFor(() => expect(onSalvo).toHaveBeenCalled());
    // 1ª decidir SEM crédito; planejar falhou; o crédito nunca foi gravado
    expect(argsDe('raio_x_decidir')).toHaveLength(1);
    expect(argsDe('raio_x_decidir')[0]).toEqual(expect.objectContaining({ p_destino: 'trocar', p_credito_troca: null }));
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/^Decisão salva, mas a execução NÃO/));
  });

  it('troca por encalhe com tudo certo: decidir sem crédito → plano → crédito (mesmo destino, motor intocado na 3ª)', async () => {
    servidorOk();
    const { onClose } = abrir(undefined, itemRX({ destino_sugerido: 'trocar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Trocar' }));
    fireEvent.change(screen.getByLabelText('Crédito de troca (R$)'), { target: { value: '1.500' } });
    fireEvent.change(screen.getByLabelText('O que entra no lugar'), { target: { value: 'encalhe' } });
    fireEvent.click(salvarDec());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['raio_x_decidir', 'raio_x_planejar', 'raio_x_decidir']);
    const [d1, d2] = argsDe('raio_x_decidir');
    expect(d1).toEqual(expect.objectContaining({ p_credito_troca: null, p_tirar_do_motor: true }));
    expect(d2).toEqual(expect.objectContaining({ p_destino: 'trocar', p_credito_troca: 1500, p_tirar_do_motor: false, p_restaurar_motor: false }));
    expect(argsDe('raio_x_planejar')[0]).toEqual(expect.objectContaining({ p_troca_contrapartida: 'encalhe', p_atualizado_em: VERSAO_NOVA }));
  });
});
