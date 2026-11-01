import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  aguardarRegistrosComTeto, desfechoDosErros, escolhidaCobreSugerida, registrarDecisaoPrazo, sugestaoAindaVale,
  type PrazoDecisaoEstado,
} from './prazoDecisao';
import type { SubmitClient } from './types';

let lente = false;
vi.mock('@/lib/impersonation/lens-write-guard', () => ({ isLensActive: () => lente }));
const mockWarn = vi.fn();
const mockInfo = vi.fn();
vi.mock('@/lib/logger', () => ({ logger: { warn: (...a: unknown[]) => mockWarn(...a), info: (...a: unknown[]) => mockInfo(...a), error: vi.fn(), critical: vi.fn() } }));

const FORMAS = [
  { codigo: '999', descricao: 'A Vista' },
  { codigo: '002', descricao: '30/60 dias' },
  { codigo: '003', descricao: '30/60/90 dias' },
];
const estado: PrazoDecisaoEstado = {
  company: 'oben', codigo: 10, nomeCliente: 'CLI DEZ', parcelaHabitual: '003', sugerida: '002', sugeridaDescricao: '30/60 dias',
  motivoSistema: null, interagiu: false, motivo: null,
};
const base = { estado, salesOrderId: 'so-1', parcelaEscolhida: '002', desfecho: 'enviado' as const, formas: FORMAS };

describe('desfechoDosErros — o desfecho REAL do PV daquela conta', () => {
  it('bloqueio de crédito da conta vence tudo; o da OUTRA conta não é o nosso', () => {
    expect(desfechoDosErros(['bloqueio_credito_oben'], false, 'oben')).toBe('bloqueado_credito');
    expect(desfechoDosErros(['bloqueio_credito_colacor'], false, 'oben')).toBe('enviado');
  });
  it('PV divergente é erro mesmo com alreadySent (o carrinho NÃO está no ERP)', () => {
    expect(desfechoDosErros(['pv_divergente_oben'], true, 'oben')).toBe('erro');
  });
  it('erro do próprio PV (sync/bloqueios da conta) = erro; erro acessório de ordem de produção NÃO rebaixa PV confirmado', () => {
    expect(desfechoDosErros(['sync_colacor_omie'], false, 'colacor')).toBe('erro');
    expect(desfechoDosErros(['bloqueio_desconhecido_colacor'], false, 'colacor')).toBe('erro');
    expect(desfechoDosErros(['bloqueio_tint_oben'], false, 'oben')).toBe('erro');
    expect(desfechoDosErros(['create_production_order'], false, 'colacor')).toBe('enviado');
  });
  it('já enviado antes (retry) e enviado', () => {
    expect(desfechoDosErros([], true, 'oben')).toBe('ja_enviado');
    expect(desfechoDosErros([], false, 'colacor')).toBe('enviado');
  });
});

describe('escolhidaCobreSugerida / sugestaoAindaVale', () => {
  it('igual ou dominante cobre; 30/60/90 não cobre 30/60; ilegível não cobre', () => {
    expect(escolhidaCobreSugerida(FORMAS, '002', '002')).toBe(true);
    expect(escolhidaCobreSugerida(FORMAS, '999', '002')).toBe(true);
    expect(escolhidaCobreSugerida(FORMAS, '003', '002')).toBe(false);
    expect(escolhidaCobreSugerida([...FORMAS, { codigo: 'B', descricao: 'Boleto' }], 'B', '002')).toBe(false);
    expect(escolhidaCobreSugerida(FORMAS, '999', null)).toBe(false);
  });
  it('a sugestão congelada só vale se o código ainda existe com a MESMA descrição', () => {
    expect(sugestaoAindaVale(FORMAS, estado)).toBe(true);
    expect(sugestaoAindaVale(FORMAS.map((f) => (f.codigo === '002' ? { codigo: '002', descricao: '120 dias' } : f)), estado)).toBe(false);
    expect(sugestaoAindaVale(FORMAS.filter((f) => f.codigo !== '002'), estado)).toBe(false);
    expect(sugestaoAindaVale([], { ...estado, sugerida: null, sugeridaDescricao: null })).toBe(true);
  });
});

describe('registrarDecisaoPrazo — fail-open, classifica no cliente, servidor relê o vencido', () => {
  beforeEach(() => { lente = false; mockWarn.mockReset(); mockInfo.mockReset(); });

  it('monta o payload da RPC com a decisão classificada (escolhida = sugerida → aceitou); o vencido NÃO viaja', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: 'x', criada: true }, error: null });
    await registrarDecisaoPrazo({ rpc } as unknown as SubmitClient, base);
    expect(rpc).toHaveBeenCalledWith('venda_prazo_decisao_registrar', {
      p: expect.objectContaining({
        sales_order_id: 'so-1', company: 'oben', omie_codigo_cliente: 10, parcela_sugerida: '002',
        parcela_escolhida: '002', decisao: 'aceitou', escolhida_cobre: false, motivo: null, desfecho_envio: 'enviado',
      }),
    });
    expect(Object.keys(rpc.mock.calls[0][1].p)).not.toContain('vencido');
  });

  it('escolheu À VISTA quando se sugeriu 30/60 → aceitou com escolhida_cobre=true', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await registrarDecisaoPrazo({ rpc } as unknown as SubmitClient, { ...base, parcelaEscolhida: '999' });
    expect(rpc.mock.calls[0][1].p).toMatchObject({ decisao: 'aceitou', parcela_escolhida: '999', escolhida_cobre: true });
  });

  it('manteve com motivo → recusou; manteve sem motivo → recusou_sem_motivo; sem clicar → ignorou', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await registrarDecisaoPrazo({ rpc } as unknown as SubmitClient, { ...base, estado: { ...estado, interagiu: true, motivo: 'decisao_gestor' }, parcelaEscolhida: '003' });
    expect(rpc.mock.calls[0][1].p).toMatchObject({ decisao: 'recusou', motivo: 'decisao_gestor' });
    await registrarDecisaoPrazo({ rpc } as unknown as SubmitClient, { ...base, estado: { ...estado, interagiu: true, motivo: null }, parcelaEscolhida: '003', desfecho: 'bloqueado_credito' });
    expect(rpc.mock.calls[1][1].p).toMatchObject({ decisao: 'recusou_sem_motivo', motivo: null, desfecho_envio: 'bloqueado_credito' });
    await registrarDecisaoPrazo({ rpc } as unknown as SubmitClient, { ...base, parcelaEscolhida: '003' });
    expect(rpc.mock.calls[2][1].p).toMatchObject({ decisao: 'ignorou' });
  });

  it('formas recarregadas com o código sugerido mudado → sem_sugestao com motivo_sistema formas_mudaram', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const formas = FORMAS.map((f) => (f.codigo === '002' ? { codigo: '002', descricao: '120 dias' } : f));
    await registrarDecisaoPrazo({ rpc } as unknown as SubmitClient, { ...base, formas });
    expect(rpc.mock.calls[0][1].p).toMatchObject({ decisao: 'sem_sugestao', parcela_sugerida: null, motivo_sistema: 'formas_mudaram' });
  });

  it('ja_enviado (PV de tentativa anterior) NÃO registra: a condição daquela tentativa é desconhecida', async () => {
    const rpc = vi.fn();
    await registrarDecisaoPrazo({ rpc } as unknown as SubmitClient, { ...base, desfecho: 'ja_enviado' });
    expect(rpc).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalled();
  });

  it('erro da RPC não lança e vai ao logger; exceção também', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: '42501' } });
    await expect(registrarDecisaoPrazo({ rpc } as unknown as SubmitClient, base)).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith('Decisão de prazo não registrada', expect.objectContaining({ error: '42501' }));
    const rpcQueLanca = vi.fn().mockRejectedValue(new Error('rede'));
    await expect(registrarDecisaoPrazo({ rpc: rpcQueLanca } as unknown as SubmitClient, base)).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith('Decisão de prazo falhou', expect.anything());
  });

  it('sob a lente "Ver como" não grava; client sem rpc → no-op', async () => {
    lente = true;
    const rpc = vi.fn();
    await registrarDecisaoPrazo({ rpc } as unknown as SubmitClient, base);
    expect(rpc).not.toHaveBeenCalled();
    lente = false;
    await expect(registrarDecisaoPrazo({} as unknown as SubmitClient, base)).resolves.toBeUndefined();
  });
});

describe('aguardarRegistrosComTeto — a venda nunca fica pendurada na auditoria', () => {
  beforeEach(() => { mockWarn.mockReset(); });
  it('resolve quando todos terminam; com um pendente além do teto, libera e avisa', async () => {
    await expect(aguardarRegistrosComTeto([Promise.resolve(), Promise.resolve()], 50)).resolves.toBeUndefined();
    expect(mockWarn).not.toHaveBeenCalled();
    const pendurado = new Promise<void>(() => { /* nunca resolve */ });
    await expect(aguardarRegistrosComTeto([pendurado], 20)).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringMatching(/teto atingido/), expect.anything());
  });
  it('lista vazia → imediato', async () => {
    await expect(aguardarRegistrosComTeto([], 5)).resolves.toBeUndefined();
  });
});
