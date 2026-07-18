import { describe, it, expect } from 'vitest';
import { acaoSugerida, classificarAcao, ehAcessoNegado, ordenarCandidatos, type PoCandidato } from '../po-sumido';

// O invariante MONEY-PATH deste card: a sugestão NUNCA pode ser "cancelar". "PO sumiu do Omie" não prova
// "a compra não existe" — o portal do fornecedor é acionado ANTES do Omie, e os 2 casos reais de prod
// (281/286, Sayerlack, ~R$3.060) têm protocolo vivo lá fora. Cancelar → o motor re-sugere → compra dupla.

const base: PoCandidato = {
  pedido_id: 1,
  omie_codigo_pedido: '1000',
  data_ciclo: '2026-05-27',
  idade_dias: 50,
  na_janela_7d: false,
  valor_total: 100,
  visto_status: 'sem_registro_last_seen',
  fornecedor_nome: 'F',
  canal_usado: 'portal_sayerlack',
  portal_protocolo: null,
  status_envio_portal: null,
  algum_sinal_de_canal: false,
};
const c = (over: Partial<PoCandidato> = {}): PoCandidato => ({ ...base, ...over });

// A LÓGICA se testa pelo discriminante (binário, robusto a reescrita de copy). Só o invariante
// "nunca instruir cancelamento" se testa no texto — é lá que ele de fato importa.
describe('classificarAcao — a decisão, sem depender da redação', () => {
  it('sinal de canal + protocolo → confirmar pelo protocolo', () => {
    expect(classificarAcao(c({ algum_sinal_de_canal: true, portal_protocolo: '2097501' })))
      .toBe('confirmar_com_protocolo');
  });

  it('sinal de canal sem protocolo → confirmar mesmo assim', () => {
    expect(classificarAcao(c({ algum_sinal_de_canal: true }))).toBe('confirmar_sem_protocolo');
  });

  it('sem sinal algum → conferir no Omie', () => {
    expect(classificarAcao(c({ algum_sinal_de_canal: false }))).toBe('conferir_no_omie');
  });

  it('identidade ilegível VENCE tudo — nem o protocolo muda isso', () => {
    expect(classificarAcao(c({
      visto_status: 'identidade_nao_interpretavel', algum_sinal_de_canal: true, portal_protocolo: '999',
    }))).toBe('identidade_ilegivel');
  });
});

describe('acaoSugerida — NUNCA sugere cancelar (o erro de R$3k)', () => {
  it('com protocolo: cita o protocolo, manda RECRIAR e diz explicitamente para não cancelar', () => {
    const txt = acaoSugerida(c({ algum_sinal_de_canal: true, portal_protocolo: '2097501' }));
    expect(txt).toContain('2097501');
    expect(txt).toMatch(/recrie o PO/i);
    expect(txt).toMatch(/não cancele/i);
  });

  it('identidade ilegível não emite conclusão sobre o PO', () => {
    const txt = acaoSugerida(c({ visto_status: 'identidade_nao_interpretavel' }));
    expect(txt).toMatch(/não é legível/i);
    expect(txt).not.toMatch(/recrie/i);
  });

  it('INVARIANTE: nenhuma combinação de evidência produz sugestão de cancelamento automático', () => {
    for (const sinal of [true, false]) {
      for (const proto of ['2097501', null]) {
        for (const status of ['sem_registro_last_seen', 'visto_em_outro_run', 'identidade_nao_interpretavel']) {
          for (const janela of [true, false]) {
            const txt = acaoSugerida(c({
              algum_sinal_de_canal: sinal, portal_protocolo: proto, visto_status: status, na_janela_7d: janela,
            }));
            // "não cancele" é permitido; "cancele/cancelar" como INSTRUÇÃO não é.
            const instruiCancelar = /(^|[^ã]\s)cancel(e|ar)\b/i.test(txt) && !/não cancele/i.test(txt);
            expect(instruiCancelar, `sugeriu cancelar: "${txt}"`).toBe(false);
          }
        }
      }
    }
  });
});

describe('ehAcessoNegado — separa "não pode ver" de "não consegui apurar"', () => {
  it('42501 (gate da RPC) é acesso negado', () => {
    expect(ehAcessoNegado({ code: '42501', message: 'acesso negado' })).toBe(true);
  });

  it('qualquer OUTRO erro NÃO é acesso negado — tem de virar aviso visível', () => {
    // O ponto do teste: um erro de rede/RPC quebrada não pode se disfarçar de "sem permissão",
    // porque aí o card sumiria em silêncio e o detector pareceria saudável estando cego.
    expect(ehAcessoNegado({ code: 'PGRST301', message: 'JWT expired' })).toBe(false);
    expect(ehAcessoNegado({ code: '42883', message: 'function does not exist' })).toBe(false);
    expect(ehAcessoNegado(new Error('Failed to fetch'))).toBe(false);
    expect(ehAcessoNegado({ message: 'sem code algum' })).toBe(false);
  });

  it('não quebra com entrada estranha', () => {
    expect(ehAcessoNegado(null)).toBe(false);
    expect(ehAcessoNegado(undefined)).toBe(false);
    expect(ehAcessoNegado('42501')).toBe(false); // string não é o shape do PostgrestError
    expect(ehAcessoNegado({ code: 42501 })).toBe(false); // number ≠ '42501' (o driver manda string)
  });
});

describe('ordenarCandidatos — dano ativo primeiro, ausência não é zero', () => {
  it('quem está na janela de 7d vem antes, mesmo valendo menos', () => {
    const r = ordenarCandidatos([
      c({ pedido_id: 1, na_janela_7d: false, valor_total: 9999 }),
      c({ pedido_id: 2, na_janela_7d: true, valor_total: 10 }),
    ]);
    expect(r.map((x) => x.pedido_id)).toEqual([2, 1]);
  });

  it('dentro do mesmo grupo, o mais caro primeiro', () => {
    const r = ordenarCandidatos([
      c({ pedido_id: 1, valor_total: 100 }),
      c({ pedido_id: 2, valor_total: 500 }),
    ]);
    expect(r.map((x) => x.pedido_id)).toEqual([2, 1]);
  });

  it('valor DESCONHECIDO (null) vai por último — e não é o mesmo que valor ZERO', () => {
    // O par null × 0 é o único que separa "ausente" de "zero": se o código tratasse null como 0 os dois
    // empatariam e a ordem cairia no desempate por id ([1, 2]). Um caso com valor > 0 passaria verde
    // nas duas implementações — foi assim que a 1ª versão deste teste nasceu sem dentes.
    const r = ordenarCandidatos([
      c({ pedido_id: 1, valor_total: null }),
      c({ pedido_id: 2, valor_total: 0 }),
    ]);
    expect(r.map((x) => x.pedido_id)).toEqual([2, 1]);
  });

  it('não muta a lista de entrada', () => {
    const entrada = [c({ pedido_id: 1, valor_total: 1 }), c({ pedido_id: 2, valor_total: 2 })];
    ordenarCandidatos(entrada);
    expect(entrada.map((x) => x.pedido_id)).toEqual([1, 2]);
  });
});
