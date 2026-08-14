import { describe, it, expect } from 'vitest';
import {
  acaoSugerida,
  classificarAcao,
  contarIlegiveis,
  descreverIdade,
  ehAcessoNegado,
  frescorDoDetector,
  LIMIAR_FRESCOR_HORAS,
  normalizarCandidatos,
  normalizarMarcador,
  ordenarCandidatos,
  OPERACOES,
  passosDaAcao,
  planoDeAcao,
  precondicoesDe,
  temComoBuscar,
  resumirValores,
  type MarcadorPos,
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
  // Marcador de 2h — fresco. Os testes de frescor sobrescrevem o par.
  marcador_finalizado_em: '2026-08-14T10:00:00Z',
  apurado_em: '2026-08-14T12:00:00Z',
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

// ────────────────────────────────────────────────────────────────────────────────────────────
// FRESCOR — "esta lista vazia é boa notícia, ou o detector parou?"
//
// O guard temporal do #1718 esconde todo PO nascido depois do marcador. Se o run completo parar de
// produzir run válido, o marcador congela e esses POs somem INDEFINIDAMENTE — e o card, que sumia
// com lista vazia, passava a afirmar "não há nada a reconciliar" sem que ninguém tivesse olhado.
// É o §2 do money-path (ausente ≠ zero) numa LISTA em vez de num número.
// ────────────────────────────────────────────────────────────────────────────────────────────

const m = (over: Partial<MarcadorPos> = {}): MarcadorPos => ({
  marcador_run_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  marcador_seq: 33,
  marcador_finalizado_em: '2026-08-14T10:00:00Z',
  apurado_em: '2026-08-14T12:00:00Z',
  ...over,
});

/** Um par (finalizado, apurado) separado por exatamente `horas`. */
const idade = (horas: number) => ({
  marcador_finalizado_em: '2026-08-14T00:00:00Z',
  apurado_em: new Date(Date.parse('2026-08-14T00:00:00Z') + horas * 3_600_000).toISOString(),
});

describe('frescorDoDetector', () => {
  it('lista vazia + marcador velho: DIZ que está desatualizado (o P1 desta correção)', () => {
    const f = frescorDoDetector([], m(idade(40)));
    expect(f).toEqual({ estado: 'desatualizado', horas: 40 });
  });

  it('lista vazia + marcador fresco: nada a dizer', () => {
    expect(frescorDoDetector([], m(idade(3)))).toEqual({ estado: 'fresco', horas: 3 });
  });

  // A distinção que dá o nome ao módulo: "nunca houve base" é o pior estado do detector e exige
  // ação; colapsá-lo em "não apurado" o esconderia atrás de um aviso genérico de leitura.
  it('marcador respondido porém VAZIO é sem_marcador, não nao_apurado', () => {
    expect(frescorDoDetector([], m({ marcador_finalizado_em: null, marcador_run_id: null }))).toEqual({
      estado: 'sem_marcador',
    });
  });

  it('marcador não lido é nao_apurado — nunca silêncio', () => {
    expect(frescorDoDetector([], null)).toEqual({ estado: 'nao_apurado' });
  });

  // O ponto do carimbo ACOPLADO: as duas RPCs são leituras independentes e um run pode ser promovido
  // entre elas. Se o frescor viesse da consulta avulsa, o card diria "fresco" sobre uma lista que
  // saiu do marcador VELHO — falso-negativo, o lado errado para errar num alerta.
  it('havendo lista, o carimbo DELA vence o da consulta avulsa', () => {
    const f = frescorDoDetector([c(idade(40))], m(idade(1)));
    expect(f).toEqual({ estado: 'desatualizado', horas: 40 });
  });

  it('sem carimbo na lista (front publicado antes da migration), cai no marcador', () => {
    const semCarimbo = c({ marcador_finalizado_em: null, apurado_em: null });
    expect(frescorDoDetector([semCarimbo], m(idade(40)))).toEqual({ estado: 'desatualizado', horas: 40 });
  });

  it('sem carimbo em lugar nenhum: nao_apurado, não "fresco"', () => {
    const semCarimbo = c({ marcador_finalizado_em: null, apurado_em: null });
    expect(frescorDoDetector([semCarimbo], null)).toEqual({ estado: 'nao_apurado' });
  });

  it('o limiar é exclusivo: exatamente no limiar ainda é fresco', () => {
    expect(frescorDoDetector([], m(idade(LIMIAR_FRESCOR_HORAS)))).toMatchObject({ estado: 'fresco' });
    expect(frescorDoDetector([], m(idade(LIMIAR_FRESCOR_HORAS + 0.5)))).toMatchObject({
      estado: 'desatualizado',
    });
  });

  // A cadência medida em prod é 22,0h (30 gaps, máx = média = p95). Um ciclo normal NÃO pode
  // acender o alerta, senão o aviso vira ruído diário e o operador aprende a ignorá-lo — que é
  // exatamente a perda de sensibilidade que o #1718 existiu para evitar.
  it('a cadência NORMAL de prod (22h) não acende o alerta', () => {
    expect(frescorDoDetector([], m(idade(22)))).toMatchObject({ estado: 'fresco' });
  });

  // Impossível com os dois lados vindos do relógio do banco — e é por isso que, se acontecer, a
  // premissa quebrou. Devolver 0h ("acabou de rodar") afirmaria frescor sem base.
  it('idade negativa vira nao_apurado, nunca "fresco há 0h"', () => {
    expect(frescorDoDetector([], m(idade(-5)))).toEqual({ estado: 'nao_apurado' });
  });

  it('carimbo impossível de interpretar vira nao_apurado', () => {
    expect(frescorDoDetector([], m({ marcador_finalizado_em: 'ontem à tarde' }))).toEqual({
      estado: 'nao_apurado',
    });
  });
});

describe('normalizarMarcador', () => {
  it('null/undefined viram null (a chamada não respondeu)', () => {
    expect(normalizarMarcador(null)).toBeNull();
    expect(normalizarMarcador(undefined)).toBeNull();
  });

  // A janela real de operação: SQL e frontend são dois deploys MANUAIS separados neste projeto.
  it('campos ausentes viram null, não undefined', () => {
    expect(normalizarMarcador({})).toEqual({
      marcador_run_id: null,
      marcador_seq: null,
      marcador_finalizado_em: null,
      apurado_em: null,
    });
  });
});

describe('normalizarCandidatos — carimbos', () => {
  it('carimbo ausente vira null e NÃO vaza como undefined para a conta de idade', () => {
    const cru = { ...base } as Record<string, unknown>;
    delete cru.marcador_finalizado_em;
    delete cru.apurado_em;
    const [r] = normalizarCandidatos([cru as unknown as PoCandidato]);
    expect(r.marcador_finalizado_em).toBeNull();
    expect(r.apurado_em).toBeNull();
    // E o efeito que importa: sem carimbo utilizável não se afirma frescor.
    expect(frescorDoDetector([r], null)).toEqual({ estado: 'nao_apurado' });
  });

  it('preserva o carimbo quando ele existe', () => {
    const [r] = normalizarCandidatos([c(idade(40))]);
    expect(r.marcador_finalizado_em).toBe('2026-08-14T00:00:00Z');
  });
});

describe('descreverIdade', () => {
  it('horas até 48h — a unidade em que o ciclo (22h) é pensado', () => {
    expect(descreverIdade(26)).toBe('26h');
    expect(descreverIdade(47.6)).toBe('48h');
  });

  it('dias acima disso — "73h" vira aritmética mental', () => {
    expect(descreverIdade(48)).toBe('2 dias');
    expect(descreverIdade(73)).toBe('3 dias');
  });
});

describe('ehAcessoNegado — a RPC do marcador', () => {
  it('reconhece o gate da RPC irmã', () => {
    expect(ehAcessoNegado({ code: '42501', message: 'reposicao_pos_marcador: acesso negado' })).toBe(true);
  });

  // A razão de as sentinelas serem por FUNÇÃO: um GRANT quebrado também devolve 42501, e tratá-lo
  // como "negado" faria o card sumir em silêncio para todo mundo — o detector cego parecendo são.
  it('GRANT quebrado na irmã NÃO conta como negado', () => {
    expect(ehAcessoNegado({ code: '42501', message: 'permission denied for function reposicao_pos_marcador' })).toBe(false);
  });
});

describe('frescorDoDetector — a deriva local (o congelamento do CLIENTE)', () => {
  // O achado adversarial: `apurado_em` congela no instante da resposta. O TanStack PAUSA o polling
  // em aba oculta ou offline — a query fica `paused`, NÃO vira `error`, e o dado anterior fica. Sem
  // somar o tempo decorrido no cliente, o card exibiria "22h" para sempre enquanto o detector
  // envelhece de verdade: o mesmo congelamento que este módulo denuncia, um andar acima.
  const H = 3_600_000;

  it('sem deriva, 22h é fresco — com 5h de aba parada, vira desatualizado', () => {
    expect(frescorDoDetector([], m(idade(22)))).toMatchObject({ estado: 'fresco' });
    expect(frescorDoDetector([], m(idade(22)), 5 * H)).toEqual({ estado: 'desatualizado', horas: 27 });
  });

  it('a deriva também alcança o carimbo que veio na lista', () => {
    expect(frescorDoDetector([c(idade(20))], null, 10 * H)).toEqual({
      estado: 'desatualizado',
      horas: 30,
    });
  });

  // É seguro somar o relógio do CLIENTE aqui porque isto é a diferença entre dois instantes do
  // mesmo relógio (chegada → agora). Valor inválido não pode virar NaN e contaminar a comparação.
  it('deriva inválida ou negativa é ignorada, nunca vira NaN', () => {
    for (const ruim of [NaN, -1, Infinity, -Infinity]) {
      expect(frescorDoDetector([], m(idade(3)), ruim)).toEqual({ estado: 'fresco', horas: 3 });
    }
  });

  it('a deriva não ressuscita um marcador que nunca existiu', () => {
    expect(frescorDoDetector([], m({ marcador_finalizado_em: null }), 100 * H)).toEqual({
      estado: 'sem_marcador',
    });
  });
});
