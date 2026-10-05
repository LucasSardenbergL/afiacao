import { describe, expect, it } from 'vitest';
import { ENDPOINT_TYPESAFE, MODELO_PINADO, montarCorpo, perguntarChoice, type PerguntaChoice } from './typesafe';

const CHAVE = 'tsk_teste_nao_e_segredo_123';

const PERGUNTA: PerguntaChoice = {
  instructions: 'Qual linha da DRE?',
  // chaves "inteiras" de propósito: um objeto JS as REORDENARIA ("2" antes de "10")
  criteria: [
    ['10', 'dez'],
    ['2', 'dois'],
    ['nenhuma', null],
  ],
};

type Chamada = { url: string; init: RequestInit };

function fetchFalso(respostas: Array<() => Response | Promise<Response>>) {
  const chamadas: Chamada[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    const r = respostas[Math.min(i, respostas.length - 1)];
    i++;
    return r();
  }) as typeof fetch;
  return { impl, chamadas };
}

const ok = (corpo: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const status = (s: number, corpo = '{"detail":"x"}', headers: Record<string, string> = {}) => () =>
  new Response(corpo, { status: s, headers });

const RESPOSTA_BOA = {
  model: 'jev-1.13.0',
  answers: { q: { type: 'choice', choice: '2', probabilities: { '10': 0.1, '2': 0.85, nenhuma: 0.05 }, confidence: 0.77 } },
  usage: { input_tokens: 321, output_tokens: 20 },
};

const semEspera = async () => {};

describe('montarCorpo — o contrato da doc oficial (docs.typesafe.ai/api)', () => {
  it('endpoint e modelo pinado', () => {
    expect(ENDPOINT_TYPESAFE).toBe('https://api.typesafe.ai/v1/systemone');
    expect(MODELO_PINADO).toBe('jev-1.13.0');
  });

  it('a ORDEM das opções sobrevive à serialização, mesmo com chave numérica', () => {
    const corpo = montarCorpo({ texto: 'x' }, PERGUNTA, MODELO_PINADO);
    const i10 = corpo.indexOf('"10":');
    const i2 = corpo.indexOf('"2":');
    const iN = corpo.indexOf('"nenhuma":');
    expect(i10).toBeGreaterThan(-1);
    // Sabotagem que pega: montar criteria com Object.fromEntries (o JS põe "2" antes de "10").
    expect(i10).toBeLessThan(i2);
    expect(i2).toBeLessThan(iN);
  });

  it('é JSON válido com state, model e a pergunta tipada', () => {
    const parsed = JSON.parse(montarCorpo({ texto: 'x' }, PERGUNTA, MODELO_PINADO));
    expect(parsed.model).toBe('jev-1.13.0');
    expect(parsed.state).toEqual({ texto: 'x' });
    expect(parsed.questions.q.type).toBe('choice');
    expect(parsed.questions.q.instructions).toBe('Qual linha da DRE?');
    expect(parsed.questions.q.criteria).toEqual({ '10': 'dez', '2': 'dois', nenhuma: null });
  });

  it('opção duplicada LANÇA (o mapa da API colapsaria as duas em silêncio)', () => {
    expect(() => montarCorpo('x', { instructions: 'q', criteria: [['a', null], ['a', 'b']] }, MODELO_PINADO)).toThrow(
      /duplicada/,
    );
  });
});

describe('perguntarChoice — transporte', () => {
  it('POST com Bearer e JSON; devolve escolha, prob da escolha, confidence, tokens e modelo', async () => {
    const { impl, chamadas } = fetchFalso([ok(RESPOSTA_BOA)]);
    const r = await perguntarChoice({ chave: CHAVE, state: 'x', pergunta: PERGUNTA, fetchImpl: impl, dormir: semEspera });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(chamadas[0].init.method).toBe('POST');
    const h = new Headers(chamadas[0].init.headers);
    expect(h.get('authorization')).toBe(`Bearer ${CHAVE}`);
    expect(h.get('content-type')).toBe('application/json');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.escolha).toBe('2');
    expect(r.prob).toBeCloseTo(0.85, 10);
    expect(r.confidence).toBeCloseTo(0.77, 10);
    expect(r.tokensEntrada).toBe(321);
    expect(r.modelo).toBe('jev-1.13.0');
    expect(r.tentativas).toBe(1);
  });

  it('429 com retry-after ⇒ espera o que o servidor pediu e tenta de novo', async () => {
    const esperas: number[] = [];
    const { impl, chamadas } = fetchFalso([status(429, '{}', { 'retry-after': '3' }), ok(RESPOSTA_BOA)]);
    const r = await perguntarChoice({
      chave: CHAVE, state: 'x', pergunta: PERGUNTA, fetchImpl: impl,
      dormir: async (ms) => { esperas.push(ms); },
    });
    expect(r.ok).toBe(true);
    expect(chamadas).toHaveLength(2);
    expect(esperas).toEqual([3000]);
  });

  it('529 até esgotar ⇒ falha declarada com o número de tentativas (nunca "resposta vazia")', async () => {
    const { impl, chamadas } = fetchFalso([status(529)]);
    const r = await perguntarChoice({ chave: CHAVE, state: 'x', pergunta: PERGUNTA, fetchImpl: impl, dormir: semEspera, maxTentativas: 3 });
    expect(r.ok).toBe(false);
    expect(chamadas).toHaveLength(3);
    if (r.ok) return;
    expect(r.status).toBe(529);
    expect(r.tentativas).toBe(3);
  });

  it('erro de rede é transitório: re-tenta', async () => {
    const { impl, chamadas } = fetchFalso([
      () => { throw new TypeError('fetch failed'); },
      ok(RESPOSTA_BOA),
    ]);
    const r = await perguntarChoice({ chave: CHAVE, state: 'x', pergunta: PERGUNTA, fetchImpl: impl, dormir: semEspera });
    expect(r.ok).toBe(true);
    expect(chamadas).toHaveLength(2);
  });

  it('401 NÃO re-tenta e a mensagem NÃO carrega a chave', async () => {
    const { impl, chamadas } = fetchFalso([status(401, `{"detail":"bad key"}`)]);
    const r = await perguntarChoice({ chave: CHAVE, state: 'x', pergunta: PERGUNTA, fetchImpl: impl, dormir: semEspera });
    expect(r.ok).toBe(false);
    expect(chamadas).toHaveLength(1);
    if (r.ok) return;
    expect(r.status).toBe(401);
    expect(r.tentativas).toBe(1);
    expect(r.erro).not.toContain(CHAVE);
  });

  it('422 NÃO re-tenta e expõe o detalhe (é erro de CONTRATO, não de carga)', async () => {
    const { impl, chamadas } = fetchFalso([status(422, '{"detail":"criteria: max 255"}')]);
    const r = await perguntarChoice({ chave: CHAVE, state: 'x', pergunta: PERGUNTA, fetchImpl: impl, dormir: semEspera });
    expect(chamadas).toHaveLength(1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erro).toContain('max 255');
  });
});

describe('perguntarChoice — validação da resposta é FAIL-CLOSED', () => {
  const comAnswer = (a: Record<string, unknown>) => ({ ...RESPOSTA_BOA, answers: { q: { ...RESPOSTA_BOA.answers.q, ...a } } });

  it('escolha fora das opções pedidas ⇒ inválida', async () => {
    const { impl } = fetchFalso([ok(comAnswer({ choice: 'inventada' }))]);
    const r = await perguntarChoice({ chave: CHAVE, state: 'x', pergunta: PERGUNTA, fetchImpl: impl, dormir: semEspera });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toMatch(/resposta inválida/);
  });

  it('probabilidades que não somam 1 ⇒ inválida (nunca renormaliza em silêncio)', async () => {
    const { impl } = fetchFalso([ok(comAnswer({ probabilities: { '10': 0.1, '2': 0.3, nenhuma: 0.1 } }))]);
    const r = await perguntarChoice({ chave: CHAVE, state: 'x', pergunta: PERGUNTA, fetchImpl: impl, dormir: semEspera });
    expect(r.ok).toBe(false);
  });

  it('opção sem probabilidade ⇒ inválida (ausente ≠ zero)', async () => {
    const { impl } = fetchFalso([ok(comAnswer({ probabilities: { '10': 0.15, '2': 0.85 } }))]);
    const r = await perguntarChoice({ chave: CHAVE, state: 'x', pergunta: PERGUNTA, fetchImpl: impl, dormir: semEspera });
    expect(r.ok).toBe(false);
  });

  it('sem usage.input_tokens ⇒ inválida (custo ausente não vira custo zero)', async () => {
    const { impl } = fetchFalso([ok({ ...RESPOSTA_BOA, usage: {} })]);
    const r = await perguntarChoice({ chave: CHAVE, state: 'x', pergunta: PERGUNTA, fetchImpl: impl, dormir: semEspera });
    expect(r.ok).toBe(false);
  });
});
