import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT_SPIN, buildUserMessage } from './spin-prompts';
import type { TranscriptTurnLite } from './types';

describe('SYSTEM_PROMPT_SPIN', () => {
  it('contém menção explícita ao framework SPIN', () => {
    expect(SYSTEM_PROMPT_SPIN).toContain('SPIN');
    expect(SYSTEM_PROMPT_SPIN).toContain('Situation');
    expect(SYSTEM_PROMPT_SPIN).toContain('Problem');
    expect(SYSTEM_PROMPT_SPIN).toContain('Implication');
    expect(SYSTEM_PROMPT_SPIN).toContain('Need-payoff');
  });

  it('menciona contexto Sayerlack/Colacor (PT-BR, indústria de tintas)', () => {
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toContain('sayerlack');
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toContain('tinta');
  });

  it('define que resposta deve ser em PT-BR natural', () => {
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toMatch(/português|pt-br|pt_br/);
  });
});

describe('buildUserMessage', () => {
  it('formata turnos com [VENDEDOR]/[CLIENTE] e timestamps relativos', () => {
    const turns: TranscriptTurnLite[] = [
      { speaker: 'vendedor', text: 'olá, sou Lucas', isFinal: true, startedAt: 1000 },
      { speaker: 'cliente', text: 'oi, tudo bem?', isFinal: true, startedAt: 2500 },
    ];

    const msg = buildUserMessage(turns);

    expect(msg).toContain('[VENDEDOR]');
    expect(msg).toContain('[CLIENTE]');
    expect(msg).toContain('olá, sou Lucas');
    expect(msg).toContain('oi, tudo bem?');
  });

  it('inclui turnos interim com marca [interim] pra Claude saber que pode mudar', () => {
    const turns: TranscriptTurnLite[] = [
      { speaker: 'cliente', text: 'eu preciso de', isFinal: false, startedAt: 5000 },
    ];

    const msg = buildUserMessage(turns);

    expect(msg).toContain('[interim]');
    expect(msg).toContain('eu preciso de');
  });

  it('lista vazia retorna mensagem com placeholder claro', () => {
    const msg = buildUserMessage([]);
    expect(msg).toMatch(/nenhum turno|sem conversa|aguardando|vazio/i);
  });

  it('inclui instrução explícita pra Claude usar a tool spin_analysis', () => {
    const turns: TranscriptTurnLite[] = [
      { speaker: 'cliente', text: 'oi', isFinal: true, startedAt: 0 },
    ];
    const msg = buildUserMessage(turns);
    expect(msg.toLowerCase()).toContain('spin_analysis');
  });
});
