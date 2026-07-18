import { describe, it, expect } from 'vitest';
import {
  acaoSugerida,
  classificarAcao,
  contarIlegiveis,
  ehAcessoNegado,
  normalizarCandidatos,
  ordenarCandidatos,
  planoDeAcao,
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

/**
 * O texto INSTRUI desfazer o pedido? Proíbe a instrução sem proibir a menção — "se o PO foi excluído" é
 * observação legítima e precisa passar; "exclua o pedido" e "faça o cancelamento" não.
 * Cobre verbo imperativo/infinitivo E o substantivo em construção de comando, que foi o último furo.
 */
const VERBOS = /\b(cancele|cancelem|cancelar|anule|anulem|anular|exclua|excluam|excluir|remova|removam|remover|delete|deletem|deletar|desfaça|desfaçam|desfazer|apague|apaguem|apagar)\b/i;
const COMANDO_SUBSTANTIVO = /\b(faça|fazer|providencie|providenciar|solicite|solicitar|peça|pedir|marque|marcar|registre|registrar)\b[^.;]{0,40}\b(cancelamento|exclusão|remoção|anulação|cancelad[oa]|excluíd[oa]|removid[oa])\b/i;
export function instruiDesfazer(txt: string): boolean {
  const semAExcecao = txt.replace(/não cancele/gi, '');
  return VERBOS.test(semAExcecao) || COMANDO_SUBSTANTIVO.test(semAExcecao);
}

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

  it('INVARIANTE: nenhuma combinação de evidência manda desfazer o pedido', () => {
    // Três gerações de furo antes desta: (1) regex de âncora deixava passar "Faça o cancelamento";
    // (2) checar só "cancel" deixava passar os SINÔNIMOS (anule/exclua/remova/delete/desfaça);
    // (3) o léxico de verbos deixava passar o SUBSTANTIVO em construção imperativa — e eu tinha
    // anotado esse furo como "aceito", que era racionalização: "faça o cancelamento" manda cancelar.
    for (const sinal of [true, false]) {
      for (const proto of ['2097501', null]) {
        for (const status of ['sem_registro_last_seen', 'visto_em_outro_run', 'identidade_nao_interpretavel']) {
          const txt = acaoSugerida(c({
            algum_sinal_de_canal: sinal, portal_protocolo: proto, visto_status: status,
          }));
          expect(instruiDesfazer(txt), `instruiu desfazer o pedido: "${txt}"`).toBe(false);
        }
      }
    }
  });

  it('o guarda tem dente: uma copy que mandasse desfazer SERIA pega', () => {
    // Falsificação do próprio teste — sem isto, ampliar o léxico seria fé, não prova.
    expect(instruiDesfazer('Exclua o pedido no Omie.')).toBe(true);
    expect(instruiDesfazer('Anule e refaça.')).toBe(true);
    // O substantivo em construção imperativa também é instrução. A 1ª versão deste teste deixava
    // "Faça o cancelamento depois" passar e eu ANOTEI o furo como aceitável — era racionalização:
    // essa frase manda cancelar tanto quanto "cancele".
    expect(instruiDesfazer('Faça o cancelamento depois.')).toBe(true);
    expect(instruiDesfazer('Providencie a exclusão do pedido.')).toBe(true);
    expect(instruiDesfazer('Marque como cancelado.')).toBe(true);
    // e a MENÇÃO legítima continua passando (é o texto real de 'conferir_no_omie'):
    expect(instruiDesfazer('Confira no Omie se o PO foi excluído e decida com o histórico.')).toBe(false);
    expect(instruiDesfazer('Se o pedido existe lá, recrie o PO no Omie — não cancele.')).toBe(false);
  });

  it('a copy REFLETE o plano: se o plano exige reconferir o Omie, o texto diz isso', () => {
    // Amarra texto ↔ plano. Sem isto, o plano poderia exigir a reconferência e a frase omiti-la — que é
    // justamente onde o dano mora (o comprador age pelo texto, não pelo tipo).
    for (const cand of [
      c({ algum_sinal_de_canal: true, portal_protocolo: '2097501' }),
      c({ algum_sinal_de_canal: true }),
    ]) {
      expect(planoDeAcao(cand)).toContain('confirmar_ausencia_atual_no_omie');
      expect(acaoSugerida(cand)).toMatch(/continua ausente no Omie/i);
      expect(acaoSugerida(cand)).toMatch(/só então recrie/i);
    }
  });
});

// A trava ESTRUTURAL do invariante: não depende de nenhuma palavra. O universo de operações é fechado
// e não contém "cancelar"; e `recriar_po` carrega precondições que impedem agir sobre evidência velha.
describe('planoDeAcao — o invariante que não se contorna com sinônimo', () => {
  const TODOS = [
    c({ visto_status: 'identidade_nao_interpretavel' }),
    c({ algum_sinal_de_canal: true, portal_protocolo: '2097501' }),
    c({ algum_sinal_de_canal: true }),
    c({ algum_sinal_de_canal: false }),
    c({ visto_status: 'visto_em_outro_run', algum_sinal_de_canal: true, portal_protocolo: '1' }),
  ];

  it('recriar_po NUNCA aparece sem confirmar fornecedor E reconferir o Omie agora', () => {
    // A precondição que fecha o PO duplicado: a evidência tem até ~1min de idade (staleTime 30s +
    // poll 60s), e outro comprador pode ter recriado o PO nesse intervalo.
    for (const cand of TODOS) {
      const plano = planoDeAcao(cand);
      if (plano.includes('recriar_po')) {
        expect(plano, JSON.stringify(cand)).toContain('confirmar_fornecedor');
        expect(plano, JSON.stringify(cand)).toContain('confirmar_ausencia_atual_no_omie');
        // e a reconferência vem ANTES de recriar
        expect(plano.indexOf('confirmar_ausencia_atual_no_omie')).toBeLessThan(plano.indexOf('recriar_po'));
      }
    }
  });

  it('nenhum plano contém operação destrutiva — o tipo não a admite', () => {
    const PERMITIDAS = new Set([
      'corrigir_cadastro', 'confirmar_fornecedor', 'confirmar_ausencia_atual_no_omie',
      'recriar_po', 'conferir_no_omie',
    ]);
    for (const cand of TODOS) {
      for (const op of planoDeAcao(cand)) {
        expect(PERMITIDAS.has(op), `operação fora do universo fechado: ${op}`).toBe(true);
        expect(op).not.toMatch(/cancel|exclu|remov|anul|delet|apag|desfaz/i);
      }
    }
  });

  it('todo candidato produz plano não-vazio (nenhum cai em "nada a fazer" silencioso)', () => {
    for (const cand of TODOS) expect(planoDeAcao(cand).length).toBeGreaterThan(0);
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

  it('lista VAZIA é "vazio", distinto de "nenhum precificado" — a função é exportada', () => {
    // Colapsar os dois deixaria o próximo consumidor sem distinguir "não há pedido" de "há pedidos e
    // nenhum tem preço". O card hoje nem chama com [], mas o contrato exportado não exige lista cheia.
    expect(resumirValores([])).toEqual({ tipo: 'vazio' });
  });

  it('zero LEGÍTIMO (pedido que de fato vale 0) não vira "não apurado"', () => {
    const r = resumirValores([c({ pedido_id: 1, valor_total: 0 })]);
    expect(r).toEqual({ tipo: 'completo', total: 0 });
  });
});

describe('normalizarCandidatos — NaN não pode entrar (a resposta chega por cast)', () => {
  it('valor não-finito vira null: é "não apurado", não um número', () => {
    // NaN != null é TRUE, então sem isto ele entraria na soma como valor apurado (total NaN) e no
    // comparador NaN !== NaN devolveria NaN, que o sort lê como EMPATE — lista fora de ordem, sem erro.
    const r = normalizarCandidatos([
      c({ pedido_id: 1, valor_total: NaN }),
      c({ pedido_id: 2, valor_total: Infinity }),
      c({ pedido_id: 3, valor_total: 100 }),
    ]);
    expect(r.map((x) => x.valor_total)).toEqual([null, null, 100]);
  });

  it('null continua null e zero legítimo sobrevive', () => {
    const r = normalizarCandidatos([c({ pedido_id: 1, valor_total: null }), c({ pedido_id: 2, valor_total: 0 })]);
    expect(r.map((x) => x.valor_total)).toEqual([null, 0]);
  });

  it('NaN normalizado NÃO contamina o total nem a ordem', () => {
    const norm = normalizarCandidatos([c({ pedido_id: 1, valor_total: NaN }), c({ pedido_id: 2, valor_total: 500 })]);
    expect(resumirValores(norm)).toEqual({ tipo: 'parcial', total: 500, comValor: 1, semValor: 1 });
    expect(ordenarCandidatos(norm).map((x) => x.pedido_id)).toEqual([1, 2]); // desconhecido encabeça
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

describe('contarIlegiveis — quantas linhas a RPC nem conseguiu comparar', () => {
  it('conta só identidade_nao_interpretavel', () => {
    expect(contarIlegiveis([
      c({ pedido_id: 1, visto_status: 'identidade_nao_interpretavel' }),
      c({ pedido_id: 2, visto_status: 'sem_registro_last_seen' }),
      c({ pedido_id: 3, visto_status: 'identidade_nao_interpretavel' }),
    ])).toBe(2);
  });

  it('zero quando todas são comparáveis', () => {
    expect(contarIlegiveis([c({ visto_status: 'visto_em_outro_run' })])).toBe(0);
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
