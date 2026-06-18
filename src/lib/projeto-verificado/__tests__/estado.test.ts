import { describe, it, expect } from 'vitest';
import { calcularEstado, type FatosProjeto } from '../estado';

const base: FatosProjeto = {
  corDosadaVinculada: false,
  proporcaoAtende: false,
  temComponenteExterno: false,
  evidenciasMinimasRecebidas: false,
  revisaoHumanaConcluida: false,
  divergencia: false,
};

describe('calcularEstado', () => {
  it('divergência é exceção terminal, vence tudo', () => {
    expect(calcularEstado({ ...base, corDosadaVinculada: true, proporcaoAtende: true, divergencia: true }))
      .toBe('divergencia_encontrada');
  });

  it('sem cor vinculada → pendente_incompleto', () => {
    expect(calcularEstado(base)).toBe('pendente_incompleto');
  });

  it('cor vinculada, sem sistema → cor_dosada_verificada', () => {
    expect(calcularEstado({ ...base, corDosadaVinculada: true })).toBe('cor_dosada_verificada');
  });

  it('cor + proporção OK (tudo Colacor) → sistema_documentado', () => {
    expect(calcularEstado({ ...base, corDosadaVinculada: true, proporcaoAtende: true }))
      .toBe('sistema_documentado');
  });

  it('componente externo TETA em componente_externo_declarado, mesmo com proporção e evidência', () => {
    expect(calcularEstado({
      ...base, corDosadaVinculada: true, proporcaoAtende: true,
      temComponenteExterno: true, evidenciasMinimasRecebidas: true,
    })).toBe('componente_externo_declarado');
  });

  it('sistema + evidências → evidencia_recebida', () => {
    expect(calcularEstado({
      ...base, corDosadaVinculada: true, proporcaoAtende: true, evidenciasMinimasRecebidas: true,
    })).toBe('evidencia_recebida');
  });

  it('evidência sem sistema (proporção falha) NÃO eleva: fica cor_dosada_verificada', () => {
    expect(calcularEstado({
      ...base, corDosadaVinculada: true, proporcaoAtende: false, evidenciasMinimasRecebidas: true,
    })).toBe('cor_dosada_verificada');
  });

  it('revisão humana concluída → conformidade_assistida (topo)', () => {
    expect(calcularEstado({
      ...base, corDosadaVinculada: true, proporcaoAtende: true,
      evidenciasMinimasRecebidas: true, revisaoHumanaConcluida: true,
    })).toBe('conformidade_assistida');
  });
});
