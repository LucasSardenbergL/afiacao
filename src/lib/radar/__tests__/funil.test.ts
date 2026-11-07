import { describe, it, expect } from 'vitest';
import {
  COLUNAS,
  coberturaDoPeriodo,
  fmtContagem,
  fmtTaxa,
  inconsistencias,
  lerPainelFunil,
  somar,
  taxa,
  totalizar,
  type Contagens,
} from '../funil';

function contagens(over: Partial<Contagens> = {}): Contagens {
  const c = {} as Contagens;
  for (const col of COLUNAS) c[col] = 0;
  return { ...c, ...over };
}
function linhaBruta(over: Record<string, unknown> = {}) {
  const l: Record<string, unknown> = { semana: '2026-11-02', vendedor_user_id: 'v1' };
  for (const col of COLUNAS) l[col] = 0;
  return { ...l, ...over };
}
const sensorBruto = {
  sensor: 'abertura_email', rotulo: 'Clique', fonte: 'front', instalado_em: '2026-11-07T03:00:00+00:00',
  cobertura_desde: '2026-11-07T03:00:00+00:00', ultimo_registro_em: null, registros_periodo: 0, falhas_periodo: 0,
  falhas: [], estado: 'parcial',
};
const bruto = {
  gerado_em: '2026-11-07T20:00:00+00:00', semanas_pedidas: 2, inicio: '2026-10-26', fim: '2026-11-08',
  semanas: [
    { semana: '2026-11-02', corrente: true, cobertura: { abertura_email: 'parcial', contato: 'completa' } },
    { semana: '2026-10-26', corrente: false, cobertura: { abertura_email: 'ausente', contato: 'completa' } },
  ],
  sensores: [sensorBruto],
  vendedores: [{ user_id: 'v1', nome: 'Regina' }, { user_id: 'v2', nome: null }],
  linhas: [linhaBruta(), linhaBruta({ semana: '2026-10-26', email_leads_clicados: null })],
};

describe('lerPainelFunil', () => {
  it('lê a forma da RPC e preserva NULL como ausente', () => {
    const p = lerPainelFunil(bruto);
    expect(p.linhas).toHaveLength(2);
    expect(p.linhas[1].email_leads_clicados).toBeNull();
    expect(p.linhas[0].email_leads_clicados).toBe(0);
    expect(p.vendedores[1]).toEqual({ userId: 'v2', nome: null });
    expect(p.sensores[0].estado).toBe('parcial');
  });
  it('contagem ausente (undefined) ou não numérica é ERRO, nunca vira 0', () => {
    const semCol = linhaBruta();
    delete (semCol as Record<string, unknown>).contatos;
    expect(() => lerPainelFunil({ ...bruto, linhas: [semCol] })).toThrow(/linhas\[0\]\.contatos/);
    expect(() => lerPainelFunil({ ...bruto, linhas: [linhaBruta({ contatos: '3' })] })).toThrow(/linhas\[0\]\.contatos/);
    expect(() => lerPainelFunil({ ...bruto, linhas: [linhaBruta({ contatos: -1 })] })).toThrow(/linhas\[0\]\.contatos/);
  });
  it('estado de sensor ou cobertura fora do vocabulário é erro', () => {
    expect(() => lerPainelFunil({ ...bruto, sensores: [{ ...sensorBruto, estado: 'talvez' }] })).toThrow(/sensores\[0\]\.estado/);
    const s = [{ semana: '2026-11-02', corrente: true, cobertura: { contato: 'meio' } }];
    expect(() => lerPainelFunil({ ...bruto, semanas: s })).toThrow(/cobertura\.contato/);
  });
  it('raiz fora da forma é erro', () => {
    expect(() => lerPainelFunil(null)).toThrow(/raiz/);
    expect(() => lerPainelFunil([])).toThrow(/raiz/);
  });
});

describe('somar / totalizar / taxa (ausente ≠ zero)', () => {
  it('tudo NULL soma NULL; NULL + número soma só o medido', () => {
    expect(somar([null, null])).toBeNull();
    expect(somar([])).toBeNull();
    expect(somar([null, 2, 0])).toBe(2);
    expect(somar([0, 0])).toBe(0);
  });
  it('totaliza por coluna', () => {
    const t = totalizar([contagens({ contatos: 2, card_fichas: null }), contagens({ contatos: 1, card_fichas: null })]);
    expect(t.contatos).toBe(3);
    expect(t.card_fichas).toBeNull();
  });
  it('com cobertura: coberto e sem linha nenhuma = 0 (ninguém no funil), ausente = NULL mesmo com número', () => {
    const vazio = totalizar([], (col) => (col === 'card_fichas' ? 'ausente' : 'completa'));
    expect(vazio.contatos).toBe(0);
    expect(vazio.email_enviados).toBe(0);
    expect(vazio.card_fichas).toBeNull();
    const t = totalizar([contagens({ card_fichas: 3, contatos: null })], (col) => (col === 'card_fichas' ? 'ausente' : 'parcial'));
    expect(t.card_fichas).toBeNull();
    expect(t.contatos).toBe(0);
  });
  it('taxa sem denominador é NULL, não 0 % nem Infinity', () => {
    expect(taxa(0, 0)).toBeNull();
    expect(taxa(3, null)).toBeNull();
    expect(taxa(null, 4)).toBeNull();
    expect(taxa(1, 4)).toBe(0.25);
    expect(taxa(0, 4)).toBe(0);
  });
  it('formatação: NULL vira "—"; 0 vira "0"', () => {
    expect(fmtContagem(null)).toBe('—');
    expect(fmtContagem(0)).toBe('0');
    expect(fmtTaxa(null)).toBe('—');
    expect(fmtTaxa(0.5)).toMatch(/^50\s?%$/);
  });
});

describe('coberturaDoPeriodo', () => {
  it('uma semana ausente torna o período parcial; todas ausentes = ausente', () => {
    const p = lerPainelFunil(bruto);
    expect(coberturaDoPeriodo(p, 'email_leads_clicados')).toBe('parcial');
    expect(coberturaDoPeriodo(p, 'contatos')).toBe('completa');
    expect(coberturaDoPeriodo(p, 'card_fichas')).toBe('ausente');
  });
});

describe('inconsistencias', () => {
  it('clique no card sem card servido = o sensor do card servido perdeu evento', () => {
    const i = inconsistencias(contagens({ card_leads_clicados: 2, card_leads_servidos: 0 }));
    expect(i.map((x) => x.etapa)).toEqual(['card']);
  });
  it('NULL não acusa inconsistência (sem dado não é contradição)', () => {
    expect(inconsistencias(contagens({ card_leads_clicados: 2, card_leads_servidos: null }))).toEqual([]);
  });
});
