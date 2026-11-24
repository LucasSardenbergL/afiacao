import { describe, expect, it } from 'vitest';
import { CLASSES_SAUDE, SAUDE_CLIENTE, tomSaude } from '../saude-cliente';

// Valores DISTINTOS de `farmer_client_scores.health_class` em prod (psql-ro, 2026-11-24):
// atencao 97 · critico 16.641 · estavel 235 · saudavel 18. Se a edge passar a gravar outro valor,
// ele cai em "Não avaliado" (neutro) até entrar no dicionário — nunca herda cor/rótulo alheio.
const PROD: Array<[string, string, string]> = [
  ['saudavel', 'Saudável', 'text-status-success-bold'],
  ['estavel', 'Estável', 'text-status-info-bold'],
  ['atencao', 'Atenção', 'text-status-warning-bold'],
  ['critico', 'Crítico', 'text-status-error-bold'],
];

describe('dicionário único de saúde', () => {
  it.each(PROD)('%s → %s', (classe, label, texto) => {
    const t = tomSaude(classe, 'ativo');
    expect(t.label).toBe(label);
    expect(t.texto).toBe(texto);
    expect(t.chip).toContain(texto);
  });

  it('cobre exatamente o vocabulário de prod', () => {
    expect([...CLASSES_SAUDE].sort()).toEqual(PROD.map((p) => p[0]).sort());
  });

  it('só usa tokens de status (sem cor crua)', () => {
    for (const t of Object.values(SAUDE_CLIENTE)) {
      expect(`${t.texto} ${t.ponto} ${t.chip}`).not.toMatch(/emerald|red-|amber|green-|blue-/);
    }
  });

  it('sem_historico vence a classe gravada (critico sentinela)', () => {
    expect(tomSaude('critico', 'sem_historico').label).toBe('Sem histórico');
  });

  it('classe desconhecida/ausente → Não avaliado neutro', () => {
    expect(tomSaude('risco', 'ativo').label).toBe('Não avaliado');
    expect(tomSaude(null).texto).toBe('text-muted-foreground');
  });
});
