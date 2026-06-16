import { describe, it, expect } from 'vitest';
import { decidirAcaoPortal } from '../shared';

describe('decidirAcaoPortal (Fase 3 · 3b)', () => {
  it('aceito_portal_sem_protocolo → conciliar SEM aviso (PO quase-certamente já existe)', () => {
    const a = decidirAcaoPortal('aceito_portal_sem_protocolo');
    expect(a.kind).toBe('conciliar');
    expect(a).toEqual({ kind: 'conciliar', warn: false });
  });

  it('indeterminado_requer_conciliacao → conciliar COM aviso (risco de duplicar)', () => {
    const a = decidirAcaoPortal('indeterminado_requer_conciliacao');
    expect(a.kind).toBe('conciliar');
    expect(a).toEqual({ kind: 'conciliar', warn: true });
  });

  it('erros genuínos (sem PO) → reenviar é seguro', () => {
    expect(decidirAcaoPortal('erro_retentavel').kind).toBe('reenviar');
    expect(decidirAcaoPortal('falha_envio_portal').kind).toBe('reenviar');
    expect(decidirAcaoPortal('erro_nao_retentavel').kind).toBe('reenviar');
  });

  it('sucesso / em-trânsito / nao_aplicavel → nenhuma ação destrutiva (não oferecer reset = anti-duplicação)', () => {
    expect(decidirAcaoPortal('sucesso_portal').kind).toBe('nenhuma');
    expect(decidirAcaoPortal('enviado_portal').kind).toBe('nenhuma');
    expect(decidirAcaoPortal('enviando_portal').kind).toBe('nenhuma');
    expect(decidirAcaoPortal('pendente_envio_portal').kind).toBe('nenhuma');
    expect(decidirAcaoPortal('nao_aplicavel').kind).toBe('nenhuma');
  });

  it('null/undefined → trata como nao_aplicavel (nenhuma ação)', () => {
    expect(decidirAcaoPortal(null).kind).toBe('nenhuma');
    expect(decidirAcaoPortal(undefined).kind).toBe('nenhuma');
  });

  it('um estado conciliável NUNCA cai em reenviar (não pode resetar conciliação = risco PO duplo)', () => {
    expect(decidirAcaoPortal('aceito_portal_sem_protocolo').kind).not.toBe('reenviar');
    expect(decidirAcaoPortal('indeterminado_requer_conciliacao').kind).not.toBe('reenviar');
  });
});
