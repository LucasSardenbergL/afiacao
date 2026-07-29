import { describe, it, expect } from 'vitest';
import {
  lerRespostaFormas,
  condicoesConhecidasAusentes,
  condicoesDoClienteIndisponiveis,
  mensagemCondicoesIndisponiveis,
  ESTADO_FORMAS_VAZIO,
} from '../formasDegradacao';

const FORMAS_OMIE = [
  { codigo: '999', descricao: 'A Vista' },
  { codigo: 'A17', descricao: '45/75/105 dias' },
];
const FORMAS_FALLBACK = [
  { codigo: '999', descricao: 'A Vista' },
  { codigo: '002', descricao: '30/60 dias' },
];

describe('lerRespostaFormas — a degradação chega ao consumidor', () => {
  it('resposta boa do Omie → não degradado, formas preservadas', () => {
    const estado = lerRespostaFormas({
      success: true, formas: FORMAS_OMIE, source: 'omie', degraded: false, motivo: null,
    });
    expect(estado.degradado).toBe(false);
    expect(estado.formas).toEqual(FORMAS_OMIE);
    expect(estado.motivo).toBeNull();
  });

  it('fallback declarado → degradado, com motivo propagado', () => {
    const estado = lerRespostaFormas({
      success: true, formas: FORMAS_FALLBACK, source: 'fallback',
      degraded: true, motivo: 'rate limit',
    });
    expect(estado.degradado).toBe(true);
    expect(estado.motivo).toBe('rate limit');
  });

  it('degraded ausente mas source=fallback → degradado (2º sinal do mesmo contrato)', () => {
    expect(lerRespostaFormas({ formas: FORMAS_FALLBACK, source: 'fallback' }).degradado).toBe(true);
  });

  it('degradado sem motivo → motivo null, nunca string vazia', () => {
    const estado = lerRespostaFormas({ formas: FORMAS_FALLBACK, degraded: true, motivo: '' });
    expect(estado.degradado).toBe(true);
    expect(estado.motivo).toBeNull();
  });

  // COMPATIBILIDADE (item 3): edge anterior ao #1597 / ainda não deployada.
  it('edge ANTIGA (sem degraded/source) → NÃO degradado — nada de aviso falso', () => {
    const estado = lerRespostaFormas({ success: true, formas: FORMAS_OMIE });
    expect(estado.degradado).toBe(false);
    expect(estado.formas).toEqual(FORMAS_OMIE);
  });

  it('degraded undefined/null explícitos → NÃO degradado (teste estrito, sem coerção)', () => {
    expect(lerRespostaFormas({ formas: [], degraded: undefined }).degradado).toBe(false);
    expect(lerRespostaFormas({ formas: [], degraded: null }).degradado).toBe(false);
  });

  it('payload ausente/inválido → estado vazio, não degradado', () => {
    expect(lerRespostaFormas(null)).toEqual(ESTADO_FORMAS_VAZIO);
    expect(lerRespostaFormas(undefined)).toEqual(ESTADO_FORMAS_VAZIO);
    expect(lerRespostaFormas('erro')).toEqual(ESTADO_FORMAS_VAZIO);
  });

  it('formas null/não-array → [] (nunca undefined pro .map da UI)', () => {
    expect(lerRespostaFormas({ formas: null, degraded: true }).formas).toEqual([]);
    expect(lerRespostaFormas({ formas: 'x' }).formas).toEqual([]);
  });
});

describe('condicoesConhecidasAusentes — prova positiva de condição sumida', () => {
  it('código do histórico ausente da lista → devolvido', () => {
    expect(condicoesConhecidasAusentes(FORMAS_FALLBACK, ['A17'])).toEqual(['A17']);
  });

  it('todos os códigos presentes → nenhum ausente', () => {
    expect(condicoesConhecidasAusentes(FORMAS_OMIE, ['999', 'A17'])).toEqual([]);
  });

  it('ignora código vazio/nulo — ausência não é prova', () => {
    expect(condicoesConhecidasAusentes(FORMAS_FALLBACK, ['', null as unknown as string])).toEqual([]);
  });

  it('deduplica preservando a ordem de entrada', () => {
    expect(condicoesConhecidasAusentes(FORMAS_FALLBACK, ['A17', 'B20', 'A17'])).toEqual(['A17', 'B20']);
  });

  it('lista vazia → todo código conhecido conta como ausente', () => {
    expect(condicoesConhecidasAusentes([], ['999'])).toEqual(['999']);
  });
});

describe('condicoesDoClienteIndisponiveis — só bloqueia com degradação DECLARADA', () => {
  // O par crítico: mesmo input de códigos, veredito oposto conforme `degradado`.
  it('degradado + código do cliente ausente → prova (bloqueia)', () => {
    const estado = { formas: FORMAS_FALLBACK, degradado: true, motivo: null };
    expect(condicoesDoClienteIndisponiveis(estado, ['A17'])).toEqual(['A17']);
  });

  it('NÃO degradado + mesmo código ausente → vazio (parcela inativada no Omie é legítimo)', () => {
    const estado = { formas: FORMAS_FALLBACK, degradado: false, motivo: null };
    expect(condicoesDoClienteIndisponiveis(estado, ['A17'])).toEqual([]);
  });

  it('degradado mas cliente sem histórico → vazio (só aviso, sem bloqueio)', () => {
    const estado = { formas: FORMAS_FALLBACK, degradado: true, motivo: null };
    expect(condicoesDoClienteIndisponiveis(estado, [])).toEqual([]);
  });

  it('degradado e o fallback cobre a condição do cliente → vazio', () => {
    const estado = { formas: FORMAS_FALLBACK, degradado: true, motivo: null };
    expect(condicoesDoClienteIndisponiveis(estado, ['999'])).toEqual([]);
  });
});

describe('mensagemCondicoesIndisponiveis', () => {
  it('cita os códigos que sumiram', () => {
    const msg = mensagemCondicoesIndisponiveis(['A17', 'B20']);
    expect(msg).toContain('A17, B20');
    expect(msg).toContain('prazo diferente do combinado');
  });
});
