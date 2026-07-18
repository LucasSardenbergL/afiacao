import { describe, it, expect } from 'vitest';
import {
  acaoSugerida,
  classificarAcao,
  ehAcessoNegado,
  ordenarCandidatos,
  resumirValores,
  type PoCandidato,
} from '../po-sumido';

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

  it('identidade ilegível diz que NÃO foi possível comparar, sem concluir nada sobre o PO', () => {
    const txt = acaoSugerida(c({ visto_status: 'identidade_nao_interpretavel' }));
    expect(txt).toMatch(/não foi possível comparar/i);
    expect(txt).not.toMatch(/recrie/i);
  });

  it('INVARIANTE: nenhuma combinação de evidência produz sugestão de cancelamento automático', () => {
    // Sem regex de âncora/pontuação (a 1ª versão tinha furo em "cancelamento", "cancela isso" e no
    // "não cancele agora; cancele depois"): remove-se a ÚNICA forma permitida e exige-se que não sobre
    // nenhum "cancel" no texto. Pega qualquer flexão, em qualquer posição, com qualquer pontuação.
    for (const sinal of [true, false]) {
      for (const proto of ['2097501', null]) {
        for (const status of ['sem_registro_last_seen', 'visto_em_outro_run', 'identidade_nao_interpretavel']) {
          const txt = acaoSugerida(c({
            algum_sinal_de_canal: sinal, portal_protocolo: proto, visto_status: status,
          }));
          const semAExcecao = txt.replace(/não cancele/gi, '');
          expect(/cancel/i.test(semAExcecao), `instruiu cancelamento: "${txt}"`).toBe(false);
        }
      }
    }
  });
});

describe('resumirValores — R$ 0,00 nunca pode nascer de "não sei"', () => {
  it('NENHUM valor apurado → não_apurado (e NÃO zero)', () => {
    // [].reduce(soma, 0) devolve 0, e 0 afirma "não há dinheiro em jogo" — fabricação. Este é o furo
    // que passou pelos 5 primeiros mutantes: nenhum deles testava a lista inteira sem valor.
    const r = resumirValores([c({ pedido_id: 1, valor_total: null }), c({ pedido_id: 2, valor_total: null })]);
    expect(r.tipo).toBe('nao_apurado');
    expect(r).not.toHaveProperty('total');
  });

  it('todos com valor → completo, com a soma', () => {
    const r = resumirValores([c({ pedido_id: 1, valor_total: 100 }), c({ pedido_id: 2, valor_total: 50 })]);
    expect(r).toEqual({ tipo: 'completo', total: 150 });
  });

  it('misto → parcial, declarando quantos ficaram de fora (nunca "total")', () => {
    const r = resumirValores([
      c({ pedido_id: 1, valor_total: 100 }),
      c({ pedido_id: 2, valor_total: null }),
      c({ pedido_id: 3, valor_total: 20 }),
    ]);
    expect(r).toEqual({ tipo: 'parcial', total: 120, comValor: 2, semValor: 1 });
  });

  it('zero LEGÍTIMO (pedido que de fato vale 0) não vira "não apurado"', () => {
    const r = resumirValores([c({ pedido_id: 1, valor_total: 0 })]);
    expect(r).toEqual({ tipo: 'completo', total: 0 });
  });
});

describe('ehAcessoNegado — separa "não pode ver" de "não consegui apurar"', () => {
  const negado = { code: '42501', message: 'reposicao_pos_candidatos: acesso negado' };

  it('o 42501 da NOSSA função (com a sentinela) é acesso negado', () => {
    expect(ehAcessoNegado(negado)).toBe(true);
  });

  it('42501 de GRANT quebrado NÃO é o gate — tem de virar aviso visível', () => {
    // Sem a sentinela, um GRANT EXECUTE quebrado faria o card sumir para TODO MUNDO em silêncio: o
    // detector cego parecendo saudável, que é exatamente o bug que este PR existe para expor.
    expect(ehAcessoNegado({
      code: '42501', message: 'permission denied for function reposicao_pos_candidatos',
    })).toBe(false);
  });

  it('qualquer OUTRO erro NÃO é acesso negado', () => {
    expect(ehAcessoNegado({ code: 'PGRST301', message: 'JWT expired' })).toBe(false);
    expect(ehAcessoNegado({ code: '42883', message: 'function does not exist' })).toBe(false);
    expect(ehAcessoNegado(new Error('Failed to fetch'))).toBe(false);
    expect(ehAcessoNegado({ message: 'sem code algum' })).toBe(false);
    expect(ehAcessoNegado({ code: '42501' })).toBe(false); // code certo, sem mensagem → não é o gate
  });

  it('não quebra com entrada estranha', () => {
    expect(ehAcessoNegado(null)).toBe(false);
    expect(ehAcessoNegado(undefined)).toBe(false);
    expect(ehAcessoNegado('42501')).toBe(false);
    expect(ehAcessoNegado({ code: 42501, message: 'reposicao_pos_candidatos: acesso negado' })).toBe(false);
  });
});

describe('ordenarCandidatos — dano ativo primeiro, incerteza no topo', () => {
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

  it('valor DESCONHECIDO encabeça o grupo — não afunda como se valesse pouco', () => {
    // valor_total é NULL quando algum item não tem preço: esse pedido pode ser o MAIOR da lista e ainda
    // carrega um problema de cadastro. Mandá-lo para o fim trataria "não sei" como "vale pouco" — o
    // mesmo erro de tratar null como zero, só que na ordenação.
    const r = ordenarCandidatos([
      c({ pedido_id: 1, valor_total: 100 }),
      c({ pedido_id: 2, valor_total: null }),
    ]);
    expect(r.map((x) => x.pedido_id)).toEqual([2, 1]);
  });

  it('a janela ainda vence a incerteza: desconhecido FORA da janela não passa na frente', () => {
    const r = ordenarCandidatos([
      c({ pedido_id: 1, na_janela_7d: false, valor_total: null }),
      c({ pedido_id: 2, na_janela_7d: true, valor_total: 10 }),
    ]);
    expect(r.map((x) => x.pedido_id)).toEqual([2, 1]);
  });

  it('dois desconhecidos não viram NaN — desempata por id', () => {
    const r = ordenarCandidatos([
      c({ pedido_id: 7, valor_total: null }),
      c({ pedido_id: 3, valor_total: null }),
    ]);
    expect(r.map((x) => x.pedido_id)).toEqual([3, 7]);
  });

  it('não muta a lista de entrada', () => {
    const entrada = [c({ pedido_id: 1, valor_total: 1 }), c({ pedido_id: 2, valor_total: 2 })];
    ordenarCandidatos(entrada);
    expect(entrada.map((x) => x.pedido_id)).toEqual([1, 2]);
  });
});
