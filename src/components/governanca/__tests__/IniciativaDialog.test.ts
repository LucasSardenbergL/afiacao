// Testa o schema do form — o espelho client-side do CHECK
// gov_iniciativas_recorrente_exige_evidencia da migration.
import { describe, expect, it } from 'vitest';
import { iniciativaSchema, type IniciativaFormValues } from '../IniciativaDialog';

const valido: IniciativaFormValues = {
  titulo: 'Renegociar frete',
  empresa: 'oben',
  alavanca: 'custo',
  status: 'em_execucao',
  dono_id: '__sem_dono__',
  ganho_esperado_mensal: '1200,50',
  ganho_recorrente_mensal: '',
  inicio_em: '',
  recorrente_desde: '',
  descricao: '',
  evidencia: '',
};

describe('iniciativaSchema (espelho do CHECK do banco)', () => {
  it('aceita iniciativa de pipeline sem evidência', () => {
    expect(iniciativaSchema.safeParse(valido).success).toBe(true);
  });

  it('REJEITA status recorrente sem evidência (como o banco rejeitaria)', () => {
    const r = iniciativaSchema.safeParse({ ...valido, status: 'recorrente', evidencia: '   ' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('evidencia'))).toBe(true);
    }
  });

  it('aceita recorrente com evidência registrada', () => {
    const r = iniciativaSchema.safeParse({
      ...valido,
      status: 'recorrente',
      evidencia: 'DRE de junho mostra a economia',
    });
    expect(r.success).toBe(true);
  });

  it('rejeita valor monetário malformado e aceita vírgula decimal', () => {
    expect(
      iniciativaSchema.safeParse({ ...valido, ganho_esperado_mensal: 'abc' }).success,
    ).toBe(false);
    expect(
      iniciativaSchema.safeParse({ ...valido, ganho_esperado_mensal: '1234.56' }).success,
    ).toBe(true);
    expect(iniciativaSchema.safeParse({ ...valido, ganho_esperado_mensal: '' }).success).toBe(
      true,
    );
  });
});
