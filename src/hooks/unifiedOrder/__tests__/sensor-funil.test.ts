import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/analytics-ledger', () => ({ registrarNoLedger: vi.fn() }));

import { classificarDesfechoEnvio } from '../sensor-funil';

const ambas = { oben: true, colacor: true, afiacao: false };

describe('classificarDesfechoEnvio — confirmado por conta, sem sucesso fabricado', () => {
  it('sem erro: as duas contas com itens confirmam', () => {
    expect(classificarDesfechoEnvio({ success: true, errors: [] }, ambas))
      .toEqual({ confirmadas: ['oben', 'colacor'], falhas: [] });
  });

  it('parcial: Colacor pendente no ERP confirma só a Oben e diz a classe', () => {
    const r = classificarDesfechoEnvio(
      { success: true, errors: [{ step: 'sync_colacor_omie', message: 'timeout' }] }, ambas,
    );
    expect(r).toEqual({ confirmadas: ['oben'], falhas: ['erp_pendente'] });
  });

  it('bloqueio de crédito e ATP na Oben: Oben NÃO confirma, as duas classes aparecem', () => {
    const r = classificarDesfechoEnvio({
      success: true,
      errors: [
        { step: 'bloqueio_credito_oben', message: 'x' },
        { step: 'bloqueio_atp_oben', message: 'y' },
      ],
    }, ambas);
    expect(r.confirmadas).toEqual(['colacor']);
    expect(r.falhas.sort()).toEqual(['credito', 'estoque']);
  });

  it('PV divergente não é confirmado (existe no Omie, mas com outros itens)', () => {
    const r = classificarDesfechoEnvio(
      { success: true, errors: [{ step: 'pv_divergente_oben', message: 'x' }] }, { oben: true, colacor: false, afiacao: false },
    );
    expect(r).toEqual({ confirmadas: [], falhas: ['pv_divergente'] });
  });

  it('aviso que não bloqueia (ordem de produção) não vira falha nem tira a confirmação', () => {
    const r = classificarDesfechoEnvio(
      { success: true, errors: [{ step: 'create_production_order', message: 'x' }] }, { oben: true, colacor: false, afiacao: false },
    );
    expect(r).toEqual({ confirmadas: ['oben'], falhas: [] });
  });

  it('OS de Afiação aguardando: a afiação não confirma, a Oben sim', () => {
    const r = classificarDesfechoEnvio(
      { success: true, errors: [{ step: 'aguardar_os_afiacao', message: 'x' }] }, { oben: true, colacor: false, afiacao: true },
    );
    expect(r).toEqual({ confirmadas: ['oben'], falhas: ['afiacao'] });
  });

  it('conta sem itens nunca é "confirmada"', () => {
    expect(classificarDesfechoEnvio({ success: true, errors: [] }, { oben: false, colacor: true, afiacao: false }).confirmadas)
      .toEqual(['colacor']);
  });

  it('success:false não confirma NADA — classe do erro; sem erro conhecido = desconhecida', () => {
    expect(classificarDesfechoEnvio({ success: false, errors: [{ step: 'validate_price', message: 'x' }] }, ambas))
      .toEqual({ confirmadas: [], falhas: ['validacao'] });
    expect(classificarDesfechoEnvio({ success: false, errors: [{ step: 'insert_oben', message: 'x' }] }, ambas))
      .toEqual({ confirmadas: [], falhas: ['gravacao'] });
    expect(classificarDesfechoEnvio({ success: false, errors: [] }, ambas))
      .toEqual({ confirmadas: [], falhas: ['desconhecida'] });
  });
});
