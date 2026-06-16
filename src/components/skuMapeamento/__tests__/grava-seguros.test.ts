import { describe, it, expect } from 'vitest';
import { dividirSegurosParaGravar } from '../grava-seguros';
import type { SugestaoSegura } from '@/lib/reposicao/sayerlack-sku';

const seg = (sku: string): SugestaoSegura => ({ sku_omie: sku, descricao: '', sku_portal: `P-${sku}`, sufixo: 'QT' });

describe('dividirSegurosParaGravar (auto-apply nunca sobrescreve mapa existente)', () => {
  it('separa novos (a inserir) de já-existentes (pulados pra revisão)', () => {
    // skusExistentes = SKUs que JÁ têm linha no banco (ativa OU inativa) no momento do clique.
    const r = dividirSegurosParaGravar([seg('A'), seg('B'), seg('C')], new Set(['B']));
    expect(r.novos.map((s) => s.sku_omie)).toEqual(['A', 'C']);
    expect(r.pulados).toEqual(['B']);
  });

  it('todos já existem → nada a inserir (nenhuma sobrescrita)', () => {
    const r = dividirSegurosParaGravar([seg('A'), seg('B')], new Set(['A', 'B']));
    expect(r.novos).toEqual([]);
    expect(r.pulados).toEqual(['A', 'B']);
  });

  it('nenhum existe → todos novos', () => {
    const r = dividirSegurosParaGravar([seg('A')], new Set<string>());
    expect(r.novos.map((s) => s.sku_omie)).toEqual(['A']);
    expect(r.pulados).toEqual([]);
  });
});
