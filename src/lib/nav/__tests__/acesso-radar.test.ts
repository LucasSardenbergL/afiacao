import { describe, expect, it } from 'vitest';
import { podeGerirRadar, podeProspectarRadar } from '@/lib/nav/acesso-radar';

// O espelho de UI tem de bater com private.cap_radar_prospectar e pode_ver_carteira_completa (prova SQL em
// db/test-radar-acesso-vendedor.sh, grupo A). Divergir abre botão que o servidor recusa, ou esconde o que ele aceita.
describe('acesso ao Radar', () => {
  const casos: Array<[string, string | null, string | null, boolean, boolean]> = [
    // descrição, role, commercialRole, prospecta, gere
    ['master', 'master', 'master', true, true],
    ['master sem cargo', 'master', null, true, true],
    ['gerencial', 'employee', 'gerencial', true, true],
    ['estrategico', 'employee', 'estrategico', true, true],
    ['super_admin', 'employee', 'super_admin', true, true],
    ['farmer', 'employee', 'farmer', true, false],
    ['hunter', 'employee', 'hunter', true, false],
    ['closer', 'employee', 'closer', true, false],
    ['operacional', 'employee', 'operacional', false, false],
    ['employee sem cargo', 'employee', null, false, false],
    ['customer com cargo residual', 'customer', 'farmer', false, false],
    ['customer gerencial residual', 'customer', 'gerencial', false, false],
    ['sem papel', null, null, false, false],
    ['cargo desconhecido', 'employee', 'estagiario', false, false],
  ];
  it.each(casos)('%s', (_d, role, commercialRole, prospecta, gere) => {
    expect(podeProspectarRadar({ role, commercialRole })).toBe(prospecta);
    expect(podeGerirRadar({ role, commercialRole })).toBe(gere);
  });
});
