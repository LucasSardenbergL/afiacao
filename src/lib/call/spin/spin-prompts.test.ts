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

describe('SYSTEM_PROMPT_SPIN — Challenger + JOLT extensions', () => {
  it('explica framework Challenger (Teach/Tailor/Take Control)', () => {
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toContain('challenger');
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toMatch(/teach|ensinar/);
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toMatch(/tailor|customizar/);
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toMatch(/take control|assumir/);
  });

  it('explica framework JOLT pra indecisão', () => {
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toContain('jolt');
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toMatch(/indecis[ãa]o|inde?cisivo/);
  });

  it('define regras de seleção entre os 3 playbooks (discovery/teach/close)', () => {
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toContain('discovery');
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toContain('teach');
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toContain('close');
    // Deve ter alguma regra explícita de quando trocar
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toMatch(/quando|se o cliente|pivota/);
  });

  it('explica as 3 táticas de ticket leverage', () => {
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toContain('anchor');
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toContain('bundle');
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toMatch(/reframe|recontextu/);
  });

  it('instrui extração de entidades (concorrente/preço/volume/produto)', () => {
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toContain('entitiesextracted');
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toMatch(/concorrente|competitor/);
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toContain('preço');
  });

  it('lista palavras-âncora de indecisão em PT-BR', () => {
    // Pelo menos 3 das clássicas devem estar listadas
    const indecisionWords = ['vou pensar', 'preciso ver', 'tô vendo', 'me dá um tempo', 'depois eu te falo'];
    const matches = indecisionWords.filter(w => SYSTEM_PROMPT_SPIN.toLowerCase().includes(w));
    expect(matches.length).toBeGreaterThanOrEqual(3);
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
