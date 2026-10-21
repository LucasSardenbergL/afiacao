import { describe, expect, it } from 'vitest';
import { paraCandidato, paraComprador } from '../linha-view';

type LinhaComprador = Parameters<typeof paraComprador>[0];
type LinhaCandidato = Parameters<typeof paraCandidato>[0];

const comprador = (over: Partial<LinhaComprador> = {}): LinhaComprador => ({
  documento: '123',
  empresa: 'oben',
  cidade_uf: null,
  ramo: null,
  ticket_faixa: null,
  familias: ['verniz'],
  volume: 10,
  n_pedidos: 2,
  recencia_dias: 5,
  lucro_proxy: null,
  lucro_cobertura: 0,
  ...over,
});

const candidato = (over: Partial<LinhaCandidato> = {}): LinhaCandidato => ({
  documento: '456',
  empresa_alvo: 'colacor_sc',
  cidade_uf: null,
  ramo: null,
  ticket_faixa: null,
  familias: [],
  compra_em_outra_empresa: true,
  ultima_compra_grupo_dias: null,
  nome: null,
  telefone: null,
  cliente_user_id: 'u1',
  ...over,
});

describe('borda das views de caça', () => {
  it('aceita as 3 empresas de EmpresaAlvo (colacor_sc sai depois, na fila)', () => {
    expect(paraComprador(comprador()).empresa).toBe('oben');
    expect(paraCandidato(candidato()).empresa_alvo).toBe('colacor_sc');
  });

  it('lança com empresa desconhecida', () => {
    expect(() => paraComprador(comprador({ empresa: 'afiacao' }))).toThrow(/empresa desconhecida "afiacao"/);
    expect(() => paraCandidato(candidato({ empresa_alvo: 'x' }))).toThrow(/empresa_alvo desconhecida "x"/);
  });

  it('coluna-chave nula LANÇA (não vira 0 nem lista vazia)', () => {
    expect(() => paraComprador(comprador({ volume: null }))).toThrow(/"volume" veio nula/);
    expect(() => paraCandidato(candidato({ familias: null }))).toThrow(/"familias" veio nula/);
  });
});
