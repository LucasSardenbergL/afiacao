import { describe, it, expect } from 'vitest';
import { contasConfirmadasDoEnvio, todasConfirmadas } from '../contasConfirmadas';

const erros = (...steps: string[]) => steps.map((step) => ({ step, message: 'x' }));

describe('contasConfirmadasDoEnvio (L2-b)', () => {
  it('sem erro: as três contas confirmadas', () => {
    expect(contasConfirmadasDoEnvio([])).toEqual({ oben: true, colacor: true, afiacao: true });
  });

  it('cada passo de falha desconfirma SÓ a sua conta', () => {
    const casos: Array<[string, 'oben' | 'colacor' | 'afiacao']> = [
      ['sync_oben_omie', 'oben'], ['bloqueio_credito_oben', 'oben'], ['bloqueio_tint_oben', 'oben'],
      ['bloqueio_atp_oben', 'oben'], ['bloqueio_desconhecido_oben', 'oben'], ['pv_divergente_oben', 'oben'],
      ['sync_colacor_omie', 'colacor'], ['bloqueio_credito_colacor', 'colacor'],
      ['bloqueio_desconhecido_colacor', 'colacor'], ['pv_divergente_colacor', 'colacor'],
      ['sync_os_omie', 'afiacao'], ['afiacao_divergente', 'afiacao'], ['afiacao_inconferivel', 'afiacao'],
      ['aguardar_os_afiacao', 'afiacao'],
    ];
    for (const [step, conta] of casos) {
      const c = contasConfirmadasDoEnvio(erros(step));
      expect(c[conta], step).toBe(false);
      expect(Object.values(c).filter((v) => !v).length, `${step} desconfirmou outra conta`).toBe(1);
      expect(todasConfirmadas(c), step).toBe(false);
    }
  });

  it('aviso e passo de outra natureza não desconfirmam (o allConfirmed também não os contava)', () => {
    const c = contasConfirmadasDoEnvio(erros('create_production_order', 'aviso_os_afiacao_desatualizada', 'validate_price'));
    expect(c).toEqual({ oben: true, colacor: true, afiacao: true });
    expect(todasConfirmadas(c)).toBe(true);
  });
});
