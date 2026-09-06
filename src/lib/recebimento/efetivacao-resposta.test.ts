import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { interpretarRespostaEfetivacao } from './efetivacao-resposta';

/** Forma do `FunctionsHttpError` do supabase-js: `context` é a Response crua (corpo ainda não lido). */
function erroHttp(status: number, corpo: unknown, json = true) {
  return {
    name: 'FunctionsHttpError',
    message: 'Edge Function returned a non-2xx status code',
    context: new Response(json ? JSON.stringify(corpo) : String(corpo), {
      status,
      headers: { 'Content-Type': json ? 'application/json' : 'text/plain' },
    }),
  };
}

describe('interpretarRespostaEfetivacao — só `success === true` vira "efetivada" (money-path: ausência de sinal ≠ aprovação)', () => {
  it('HTTP 200 com success:false (modo falha_efetivacao) é FALHA com o erro da edge — era o bug: toast "efetivada"', async () => {
    const v = await interpretarRespostaEfetivacao({
      data: { success: false, modo: 'falha_efetivacao', erro: 'consultar: faultstring X' },
      error: null,
    });
    expect(v.tipo).toBe('falha');
    expect(v).toMatchObject({ modo: 'falha_efetivacao', mensagem: 'consultar: faultstring X' });
  });

  it('throttle (Omie em trégua de consulta) é falha, não sucesso', async () => {
    const v = await interpretarRespostaEfetivacao({
      data: { success: false, modo: 'throttle', erro: 'Omie em trégua de consulta (~60s)' },
      error: null,
    });
    expect(v.tipo).toBe('falha');
    expect(v).toMatchObject({ modo: 'throttle' });
  });

  it('success:true + modo efetivado → sucesso', async () => {
    const v = await interpretarRespostaEfetivacao({ data: { success: true, modo: 'efetivado' }, error: null });
    expect(v).toEqual({ tipo: 'sucesso', modo: 'efetivado' });
  });

  it('success:true + modo reconciliado (já estava recebida no Omie) → sucesso', async () => {
    const v = await interpretarRespostaEfetivacao({ data: { success: true, modo: 'reconciliado' }, error: null });
    expect(v).toEqual({ tipo: 'sucesso', modo: 'reconciliado' });
  });

  it('modo efetivacao_parcial → parcial (aviso com o erro), nunca sucesso', async () => {
    const v = await interpretarRespostaEfetivacao({
      data: { success: false, modo: 'efetivacao_parcial', erro: 'concluir_recebimento: faultstring Y' },
      error: null,
    });
    expect(v).toEqual({ tipo: 'parcial', modo: 'efetivacao_parcial', mensagem: 'concluir_recebimento: faultstring Y' });
  });

  it('parcial sem `erro` no corpo ainda é parcial, com mensagem de fallback (não string vazia)', async () => {
    const v = await interpretarRespostaEfetivacao({ data: { success: false, modo: 'efetivacao_parcial' }, error: null });
    expect(v.tipo).toBe('parcial');
    expect(v.tipo === 'parcial' && v.mensagem.length > 0).toBe(true);
  });

  it('success que não é o boolean true ("true", 1) NÃO é sucesso', async () => {
    for (const success of ['true', 1, 'ok']) {
      const v = await interpretarRespostaEfetivacao({ data: { success, modo: 'efetivado' }, error: null });
      expect(v.tipo, `success=${JSON.stringify(success)}`).toBe('falha');
    }
  });

  it('success:true com modo fora da allowlist (ex.: diagnostico, lock) não é sucesso', async () => {
    for (const modo of ['diagnostico', 'lock', undefined]) {
      const v = await interpretarRespostaEfetivacao({ data: { success: true, modo }, error: null });
      expect(v.tipo, `modo=${String(modo)}`).toBe('falha');
    }
  });

  it('data null/undefined/string/array → falha "resposta inesperada" (não explode, não aprova)', async () => {
    for (const data of [null, undefined, 'ok', [], 42]) {
      const v = await interpretarRespostaEfetivacao({ data, error: null });
      expect(v.tipo, `data=${JSON.stringify(data)}`).toBe('falha');
      expect(v.tipo === 'falha' && /inesperad/i.test(v.mensagem)).toBe(true);
    }
  });

  it('falha sem `erro` no corpo cita o modo na mensagem (o operador precisa saber o que aconteceu)', async () => {
    const v = await interpretarRespostaEfetivacao({ data: { success: false, modo: 'falha_efetivacao' }, error: null });
    expect(v.tipo).toBe('falha');
    expect(v.tipo === 'falha' && v.mensagem).toContain('falha_efetivacao');
  });

  it('erro HTTP (≠2xx) com corpo JSON → falha com o `erro` do corpo e o modo (não a frase genérica do supabase-js)', async () => {
    const v = await interpretarRespostaEfetivacao({
      data: null,
      error: erroHttp(502, { success: false, modo: 'falha_efetivacao', erro: 'identidade: chave não confere' }),
    });
    expect(v).toEqual({ tipo: 'falha', modo: 'falha_efetivacao', mensagem: 'identidade: chave não confere' });
  });

  it('erro HTTP com corpo modo efetivacao_parcial → parcial (o modo manda, não o status)', async () => {
    const v = await interpretarRespostaEfetivacao({
      data: null,
      error: erroHttp(502, { success: false, modo: 'efetivacao_parcial', erro: 'cte: faultstring Z' }),
    });
    expect(v).toEqual({ tipo: 'parcial', modo: 'efetivacao_parcial', mensagem: 'cte: faultstring Z' });
  });

  it('erro HTTP com corpo `{error}` (formato dos 4xx/5xx genéricos da edge) → falha com essa mensagem', async () => {
    const v = await interpretarRespostaEfetivacao({
      data: null,
      error: erroHttp(409, { error: 'Efetivação já em andamento para esta NF-e', modo: 'lock' }),
    });
    expect(v).toEqual({ tipo: 'falha', modo: 'lock', mensagem: 'Efetivação já em andamento para esta NF-e' });
  });

  it('erro sem context (rede/CORS) → falha com a mensagem do erro', async () => {
    const v = await interpretarRespostaEfetivacao({ data: null, error: new Error('Failed to fetch') });
    expect(v).toEqual({ tipo: 'falha', modo: null, mensagem: 'Failed to fetch' });
  });

  it('erro com context cujo corpo não é JSON → falha com a mensagem do erro (não explode)', async () => {
    const v = await interpretarRespostaEfetivacao({ data: null, error: erroHttp(500, '<html>gateway</html>', false) });
    expect(v.tipo).toBe('falha');
    expect(v.tipo === 'falha' && v.mensagem).toBe('Edge Function returned a non-2xx status code');
  });

  it('erro HTTP cujo corpo diz success:true NÃO vira sucesso (o transporte falhou — precisão > recall)', async () => {
    const v = await interpretarRespostaEfetivacao({ data: null, error: erroHttp(504, { success: true, modo: 'efetivado' }) });
    expect(v.tipo).toBe('falha');
  });

  it('retorno FINAL da edge (reconsulta) traz `divergencias`, não `erro`: o parcial e a falha carregam esse diagnóstico', async () => {
    const parcial = await interpretarRespostaEfetivacao({
      data: { success: false, modo: 'efetivacao_parcial', divergencias: ['item 3: qtde 10 ≠ 8', 'cRecebido=N'] },
      error: null,
    });
    expect(parcial).toEqual({ tipo: 'parcial', modo: 'efetivacao_parcial', mensagem: 'item 3: qtde 10 ≠ 8 | cRecebido=N' });
    const falha = await interpretarRespostaEfetivacao({
      data: null,
      error: erroHttp(502, { success: false, modo: 'falha_efetivacao', divergencias: ['reconsulta: faultstring W'] }),
    });
    expect(falha).toEqual({ tipo: 'falha', modo: 'falha_efetivacao', mensagem: 'reconsulta: faultstring W' });
    // lista vazia/lixo não vira mensagem vazia
    const vazio = await interpretarRespostaEfetivacao({ data: { success: false, modo: 'falha_efetivacao', divergencias: [] }, error: null });
    expect(vazio.tipo === 'falha' && vazio.mensagem).toContain('falha_efetivacao');
  });

  describe('corpo do ≠2xx que nunca chega', () => {
    afterEach(() => vi.useRealTimers());

    it('stream que não fecha: desiste pelo teto e cai na mensagem do transporte — o toast não fica pendurado', async () => {
      vi.useFakeTimers();
      const pendurado = { message: 'Edge Function returned a non-2xx status code', context: { json: () => new Promise(() => {}) } };
      const p = interpretarRespostaEfetivacao({ data: null, error: pendurado });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ tipo: 'falha', modo: null, mensagem: 'Edge Function returned a non-2xx status code' });
    });

    it('`context` malformado (json não é função / getter que lança) não explode', async () => {
      const explosivo = { message: 'x', get context() { throw new Error('getter'); } };
      await expect(interpretarRespostaEfetivacao({ data: null, error: explosivo })).resolves.toMatchObject({ tipo: 'falha', mensagem: 'x' });
      await expect(interpretarRespostaEfetivacao({ data: null, error: { message: 'y', context: { json: 'não-função' } } })).resolves.toMatchObject({ tipo: 'falha', mensagem: 'y' });
    });
  });
});

describe('fronteira: quem chama a edge decide pelo VEREDITO, não pelo transporte', () => {
  const ler = (p: string) => readFileSync(p, 'utf8');

  function blocoEntre(src: string, inicio: string, fim: string): string {
    const a = src.indexOf(inicio);
    const b = src.indexOf(fim, a + 1);
    expect(a, `âncora "${inicio}" não encontrada`).toBeGreaterThan(-1);
    expect(b, `âncora "${fim}" não encontrada após "${inicio}"`).toBeGreaterThan(a);
    return src.slice(a, b);
  }

  function exigeVeredito(bloco: string, nome: string) {
    const posHelper = bloco.indexOf('interpretarRespostaEfetivacao(');
    expect(posHelper, `${nome} não interpreta a resposta da edge pelo helper`).toBeGreaterThan(-1);
    // O padrão cego: aprovar por "não houve erro de transporte".
    expect(bloco, `${nome} ainda aprova por res.error`).not.toContain('if (res.error) throw res.error');
    const posToast = bloco.indexOf('toast.success(');
    expect(posToast, `${nome} comemora antes do veredito`).toBeGreaterThan(posHelper);
    expect(bloco, `${nome} não trata o ramo de falha`).toContain("tipo === 'falha'");
  }

  it('RecebimentoConferencia.handleFinalize', () => {
    exigeVeredito(blocoEntre(ler('src/pages/RecebimentoConferencia.tsx'), 'const handleFinalize', 'const toggleExpand'), 'handleFinalize');
  });

  it('Recebimento (lista): efetivar/reprocessar', () => {
    exigeVeredito(blocoEntre(ler('src/pages/Recebimento.tsx'), 'const handleEfetivar', 'const handleDiagnosticar'), 'Recebimento.handleEfetivar');
  });

  it('edge omie-nfe-recebimento: TODO retorno do fluxo real decide o status por statusHttpEfetivacao(body) — nunca número fixo', () => {
    const src = ler('supabase/functions/omie-nfe-recebimento/index.ts');
    // Cada `success: false|statusFinal…` do fluxo real é seguido do SEU `return jsonRes(...)`; o
    // argumento inteiro tem de ser `body, statusHttpEfetivacao(body)` — `jsonRes(body, 200)` ou um
    // literal com `}, 200)` reprovam igual (Codex P2: o pino antigo aceitava a forma equivalente).
    const retornos = [...src.matchAll(/success:\s*(?:false|statusFinal)[\s\S]{0,600}?return jsonRes\(([^;]*)\);/g)];
    expect(retornos.length, 'esperava os 4 retornos do fluxo real (falhaOp, throttle, pararParcial, final)').toBe(4);
    for (const m of retornos) expect(m[1].trim(), m[0].slice(0, 80)).toBe('body, statusHttpEfetivacao(body)');
  });
});
