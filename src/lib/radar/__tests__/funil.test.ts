import { describe, it, expect } from 'vitest';
import {
  COLUNAS,
  coberturaDoPeriodo,
  etapasAdocao,
  fmtContagem,
  fmtTaxa,
  inconsistencias,
  lerExperimento,
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
  it('sem o sensor de exibição (pré-M): clique no card acima da 1ª exibição do dia acusa o card', () => {
    const i = inconsistencias(contagens({ card_leads_clicados: 2, card_leads_servidos: 0, card_leads_exibidos: null }));
    expect(i.map((x) => x.etapa)).toEqual(['card']);
  });
  it('NULL não acusa inconsistência (sem dado não é contradição)', () => {
    expect(inconsistencias(contagens({ card_leads_clicados: 2, card_leads_servidos: null, card_leads_exibidos: null }))).toEqual([]);
  });
});

describe('pacote M — universo, reposição, intenção e experimento', () => {
  it('banco anterior ao pacote M: colunas novas AUSENTES viram NULL ("—") e a adoção é null, nunca 0', () => {
    const l = linhaBruta();
    delete l.card_leads_exibidos; delete l.card_leads_clicados_exibidos; delete l.intencoes;
    const p = lerPainelFunil({ ...bruto, linhas: [l] });
    expect(p.linhas[0].card_leads_exibidos).toBeNull();
    expect(p.linhas[0].intencoes).toBeNull();
    expect(p.adocao).toBeNull();
  });
  it('coluna nova PRESENTE segue o parser estrito (texto não vira 0)', () => {
    expect(() => lerPainelFunil({ ...bruto, linhas: [linhaBruta({ intencoes: '2' })] })).toThrow(/linhas\[0\]\.intencoes/);
  });
  it('adoção: as 4 etapas sobre o MESMO denominador (elegíveis agora); quem perdeu o acesso fica à parte', () => {
    const v = (user_id: string, o: Record<string, unknown>) => ({
      user_id, elegivel: true, exposto_em: null, primeira_acao_em: null, ultima_acao_em: null, dias_com_acao: 0, acoes: 0, ...o,
    });
    const p = lerPainelFunil({ ...bruto, adocao: { elegiveis_agora: 4, vendedores: [
      v('a', {}),
      v('b', { exposto_em: '2026-11-03T10:00:00Z' }),
      v('c', { exposto_em: '2026-11-03T10:00:00Z', primeira_acao_em: '2026-11-03T11:00:00Z', dias_com_acao: 1, acoes: 1 }),
      v('d', { exposto_em: '2026-11-03T10:00:00Z', primeira_acao_em: '2026-11-03T11:00:00Z', dias_com_acao: 3, acoes: 5 }),
      v('x', { elegivel: false, exposto_em: '2026-11-03T10:00:00Z', primeira_acao_em: '2026-11-03T11:00:00Z', dias_com_acao: 1, acoes: 1 }),
    ] } });
    expect(p.adocao?.vendedores).toHaveLength(5);
    expect(etapasAdocao(p.adocao!)).toEqual({ elegiveis: 4, expostos: 3, comAcao: 2, voltaram: 1, foraDoUniverso: 1 });
    expect(etapasAdocao(p.adocao!, 'a')).toEqual({ elegiveis: 1, expostos: 0, comAcao: 0, voltaram: 0, foraDoUniverso: 0 });
  });
  it('adoção fora da forma LANÇA (elegivel não booleano)', () => {
    expect(() => lerPainelFunil({ ...bruto, adocao: { elegiveis_agora: 1, vendedores: [{ user_id: 'a', elegivel: 'sim',
      exposto_em: null, primeira_acao_em: null, ultima_acao_em: null, dias_com_acao: 0, acoes: 0 }] } })).toThrow(/elegivel/);
  });
  it('card com exibições: o aviso de 200 % some (clicado ⊂ exibido); sem exibições o aviso explica a reposição', () => {
    // O caso que o painel H culpava o sensor: 3 servidos e 6 cliques.
    const comExib = contagens({ card_leads_servidos: 3, card_leads_clicados: 6, card_leads_exibidos: 6, card_leads_clicados_exibidos: 6 });
    expect(inconsistencias(comExib)).toEqual([]);
    const semExib = contagens({ card_leads_servidos: 3, card_leads_clicados: 6, card_leads_exibidos: null });
    expect(inconsistencias(semExib)[0].detalhe).toMatch(/depois de um Assumir não contava no denominador/);
    expect(inconsistencias(semExib)[0].detalhe).not.toMatch(/se perdeu/);
  });
  it('lerExperimento lê coortes e faixas; resposta fora da forma LANÇA', () => {
    const x = lerExperimento({ gerado_em: '2026-11-09T10:00:00Z',
      coortes: [{ sorteio: 'coorte-2026-10', grupo: 'topo', sorteados: 293, tocados: 0, em_conversa: 0, virou_cliente: 0,
                  cadastros_novos: 0, sorteada_em: '2026-10-29T10:00:00Z', dias_de_acompanhamento: 11 }],
      faixas: [{ faixa: 'topo (>= 70)', leads_tocados: 0, em_conversa: 0, virou_cliente: 0, cadastros_novos: 0 }] });
    expect(x.coortes[0]).toMatchObject({ sorteados: 293, tocados: 0, diasDeAcompanhamento: 11 });
    expect(x.faixas[0].leadsTocados).toBe(0);
    expect(() => lerExperimento({ gerado_em: 'x', coortes: [{ sorteio: 's' }], faixas: [] })).toThrow(/coortes\[0\]/);
  });
});
