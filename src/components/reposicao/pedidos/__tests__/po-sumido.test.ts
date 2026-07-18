import { describe, it, expect } from 'vitest';
import {
  acaoSugerida,
  classificarAcao,
  contarIlegiveis,
  ehAcessoNegado,
  normalizarCandidatos,
  ordenarCandidatos,
  OPERACOES,
  passosDaAcao,
  planoDeAcao,
  precondicoesDe,
  temComoBuscar,
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

/**
 * O gatilho de cada trava, colado à consequência. Não é golden test de copy: o que se fixa aqui é a
 * RELAÇÃO condição→PARE, que é onde mora o dano. Uma reescrita que preserve a relação passa; uma que
 * inverta a condição (o caso perigoso, porque *parece* certo) falha.
 */
const GATILHO_FORNECEDOR = /não existe, foi cancelado ou já foi atendido,\s*PARE/i;
const GATILHO_RECONFERENCIA = /(?<!não )achou algum\?\s*PARE/i;

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
    expect(txt).toMatch(/não cancele o pedido/i);
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

  it('a copy é MONTADA do plano: todo passo aparece no texto, nenhum a mais', () => {
    // Antes, plano e frase eram switches paralelos: o plano podia exigir uma confirmação que a frase
    // não mencionava — plano vira enfeite e o comprador age pela frase. Agora o texto é derivado.
    const MARCA: Record<string, RegExp> = {
      corrigir_cadastro: /corrija o cadastro/i,
      confirmar_fornecedor: /confirme com o fornecedor/i,
      confirmar_ausencia_de_qualquer_po: /não existe nenhum outro pedido de compra ativo/i,
      recriar_po: /recrie o PO/i,
      conferir_no_omie: /confira no Omie se o PO foi excluído/i,
    };
    for (const cand of [
      c({ algum_sinal_de_canal: true, portal_protocolo: '2097501' }),
      c({ algum_sinal_de_canal: true }),
      c({ algum_sinal_de_canal: false }),
      c({ visto_status: 'identidade_nao_interpretavel' }),
    ]) {
      const plano = planoDeAcao(cand);
      const txt = acaoSugerida(cand);
      for (const op of plano) expect(txt, `passo ${op} sumiu de "${txt}"`).toMatch(MARCA[op]);
      // e nenhuma operação FORA do plano aparece no texto
      for (const [op, re] of Object.entries(MARCA)) {
        if (!plano.includes(op as never)) expect(txt, `passo ${op} sobrou em "${txt}"`).not.toMatch(re);
      }
    }
  });

  it('a reconferência usa as chaves que a linha REALMENTE tem, e avisa contra o número antigo', () => {
    const comProto = acaoSugerida(c({ algum_sinal_de_canal: true, portal_protocolo: '2097501', fornecedor_nome: 'Sayerlack' }));
    expect(comProto).toMatch(/protocolo 2097501/);
    expect(comProto).toMatch(/fornecedor Sayerlack/);
    expect(comProto).toMatch(/não pelo número antigo/i);
    // sem protocolo, NÃO pode mandar buscar por protocolo — era instrução inexequível
    const semProto = acaoSugerida(c({ algum_sinal_de_canal: true, portal_protocolo: null, fornecedor_nome: 'Sayerlack' }));
    expect(semProto).toMatch(/fornecedor Sayerlack/);
    expect(semProto).not.toMatch(/protocolo/i);
  });

  it('CADA trava carrega SUA condição de parada — não basta ter um PARE em algum lugar', () => {
    // A 1ª versão procurava /PARE/ no texto inteiro: apagar a parada do passo do FORNECEDOR passava
    // verde, porque o "Achou algum? PARE" da reconferência continuava lá. Agora cada passo é
    // verificado no próprio passo.
    for (const cand of [
      c({ algum_sinal_de_canal: true, portal_protocolo: '2097501' }),
      c({ algum_sinal_de_canal: true, portal_protocolo: null, fornecedor_nome: 'Sayerlack' }),
    ]) {
      const passos = passosDaAcao(cand);
      const doFornecedor = passos.find((p) => /confirme com o fornecedor/i.test(p));
      expect(doFornecedor, `passo do fornecedor sumiu: ${JSON.stringify(passos)}`).toBeDefined();
      expect(doFornecedor).toMatch(GATILHO_FORNECEDOR);

      const daReconferencia = passos.find((p) => /nenhum outro pedido de compra ativo/i.test(p));
      expect(daReconferencia).toBeDefined();
      expect(daReconferencia).toMatch(GATILHO_RECONFERENCIA);
    }
  });

  it('o claim vem ANTES do ato irreversível — avisar depois não reduz corrida nenhuma', () => {
    // A corrida entre dois compradores não se fecha aqui (sem backend não há exclusão mútua), mas a
    // ORDEM muda o efeito: "recrie — e avise depois" não encurta janela alguma, porque o PO já existe.
    // O claim social precisa preceder o salvamento.
    const passo = passosDaAcao(c({ algum_sinal_de_canal: true, portal_protocolo: '2097501' }))
      .find((p) => /recrie o PO/i.test(p));
    expect(passo, 'passo de recriar sumiu').toBeDefined();
    const posAviso = passo!.search(/avise a equipe/i);
    const posRecriar = passo!.search(/recrie o PO/i);
    expect(posAviso, 'o passo de recriar precisa conter o aviso').toBeGreaterThanOrEqual(0);
    expect(posAviso, 'o aviso tem de vir ANTES de recriar, não depois').toBeLessThan(posRecriar);
    expect(passo).toMatch(/antes de salvar/i);
  });

  it('o PARE está colado ao gatilho CERTO — uma condição invertida seria pega', () => {
    // Verificar /continua ativo/ e /PARE/ soltos NÃO basta: "Se ele disser que CONTINUA ativo, PARE"
    // tem as duas palavras e manda parar exatamente quando deveria recriar. O que importa é a
    // ADJACÊNCIA gatilho→consequência, e é isso que as regexes acima exigem.
    expect('Se ele disser que CONTINUA ativo, PARE — não recrie.').not.toMatch(GATILHO_FORNECEDOR);
    expect('Não achou nenhum PO? PARE.').not.toMatch(GATILHO_RECONFERENCIA);
    // e a forma correta casa:
    expect('...que o pedido CONTINUA ativo. Se ele disser que não existe, foi cancelado ou já foi atendido, PARE — não recrie.')
      .toMatch(GATILHO_FORNECEDOR);
    expect('...busque por protocolo 1 — não pelo número antigo. Achou algum? PARE')
      .toMatch(GATILHO_RECONFERENCIA);
  });

  it('SEM identificador para buscar, o plano NÃO chega a recriar', () => {
    // fornecedor e protocolo nulos: a trava "confirme que não há outro PO" é inexequível, e mandar
    // recriar sem poder executá-la é pior que não sugerir — o comprador pula a trava.
    const cego = c({ algum_sinal_de_canal: true, portal_protocolo: null, fornecedor_nome: null });
    expect(temComoBuscar(cego)).toBe(false);
    expect(planoDeAcao(cego)).not.toContain('recriar_po');
    expect(planoDeAcao(cego)).toEqual(['conferir_no_omie']);
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

  it('TODA precondição vem ANTES da operação que a exige — não só uma delas', () => {
    // A 1ª versão deste teste só comparava a ordem de UMA precondição, então o plano
    // ['confirmar_ausencia...', 'recriar_po', 'confirmar_fornecedor'] passaria: manda recriar e só
    // depois confirmar com o fornecedor. Agora varre a tabela de precondições inteira.
    for (const cand of TODOS) {
      const plano = planoDeAcao(cand);
      plano.forEach((op, i) => {
        for (const pre of precondicoesDe(op)) {
          const posPre = plano.indexOf(pre);
          expect(posPre, `${op} sem a precondição ${pre} em ${JSON.stringify(plano)}`).toBeGreaterThanOrEqual(0);
          expect(posPre, `${pre} depois de ${op} em ${JSON.stringify(plano)}`).toBeLessThan(i);
        }
      });
    }
  });

  it('recriar_po exige confirmar fornecedor E ausência de QUALQUER PO ativo', () => {
    // "o PO continua ausente" não bastava: a linha mostra o número ANTIGO, e se alguém já recriou a
    // compra ela existe sob outro número — conferir o antigo confirma a ausência e leva ao 2º PO.
    expect(precondicoesDe('recriar_po')).toEqual(
      expect.arrayContaining(['confirmar_fornecedor', 'confirmar_ausencia_de_qualquer_po']),
    );
  });

  it('nenhum plano contém operação destrutiva — e o universo NÃO tem uma sequer', () => {
    // `OPERACOES` vem do Record<Operacao,…>, que o TS obriga a ser completo: uma lista escrita à mão
    // aqui envelheceria em silêncio (foi o que aconteceu ao renomear uma operação).
    const universo = new Set<string>(OPERACOES);
    for (const op of OPERACOES) {
      expect(op, `o universo admite operação destrutiva: ${op}`)
        .not.toMatch(/cancel|exclu|remov|anul|delet|apag|desfaz/i);
    }
    for (const cand of TODOS) {
      for (const op of planoDeAcao(cand)) {
        expect(universo.has(op), `operação fora do universo fechado: ${op}`).toBe(true);
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
