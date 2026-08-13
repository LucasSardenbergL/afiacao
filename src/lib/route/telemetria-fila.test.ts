import { describe, it, expect } from 'vitest';
import { classificarFilaVazia, eventoDaFila, type FilaObservada } from './telemetria-fila';

describe('classificarFilaVazia', () => {
  // A fila tem 4 saídas-vazias OPERACIONALMENTE distintas, hoje indistinguíveis na UI.
  // O motivo é DECLARADO no ponto que sabe (o queryFn), nunca inferido dos totais:
  // "capacidade 0" e "nenhum candidato" produzem exatamente o mesmo `excluidos: []`.
  it('sem cidade na rota do dia → sem_cidade', () => {
    expect(classificarFilaVazia({ nCidades: 0, nCandidatos: 0, nVivos: 0, nFila: 0 })).toBe('sem_cidade');
  });

  it('cidades na rota mas nenhum cliente da carteira nelas → sem_candidato', () => {
    expect(classificarFilaVazia({ nCidades: 3, nCandidatos: 0, nVivos: 0, nFila: 0 })).toBe('sem_candidato');
  });

  it('candidatos existem mas todos caíram num gate → todos_excluidos', () => {
    expect(classificarFilaVazia({ nCidades: 3, nCandidatos: 826, nVivos: 0, nFila: 0 })).toBe('todos_excluidos');
  });

  it('candidatos passaram o gate mas a fila saiu vazia → sem_capacidade', () => {
    // capacidade_ligacoes_dia = 0 zera a fila com 826 candidatos SAUDÁVEIS.
    // Sem este ramo o caso viraria "sem_candidato" — diagnóstico fabricado (money-path §2).
    expect(classificarFilaVazia({ nCidades: 3, nCandidatos: 826, nVivos: 826, nFila: 0 })).toBe('sem_capacidade');
  });

  it('fila com itens → null (não há o que classificar)', () => {
    expect(classificarFilaVazia({ nCidades: 3, nCandidatos: 826, nVivos: 40, nFila: 40 })).toBeNull();
  });

  it('sem_cidade tem precedência — é a causa mais a montante', () => {
    expect(classificarFilaVazia({ nCidades: 0, nCandidatos: 826, nVivos: 826, nFila: 0 })).toBe('sem_cidade');
  });
});

/** Fila observável de teste — só o que a telemetria lê (contagens vêm de .length). */
function fila(over: Partial<FilaObservada> = {}): FilaObservada {
  return {
    callQueue: new Array(40).fill(null),
    resolvidosQueue: new Array(2).fill(null),
    excluidos: new Array(786).fill(null),
    cidades: ['DIVINOPOLIS', 'CARMO DO CAJURU', 'ITAUNA'],
    routeDate: '2026-08-10',
    dailyOnly: false,
    cadenciaIndisponivel: false,
    motivoFilaVazia: null,
    ...over,
  };
}

describe('eventoDaFila', () => {
  it('carregando → não emite (estado transitório, não é desfecho)', () => {
    expect(eventoDaFila({ isLoading: true, isError: false, data: undefined })).toBeNull();
  });

  it('sem erro e sem data → não emite (nada aconteceu ainda)', () => {
    expect(eventoDaFila({ isLoading: false, isError: false, data: undefined })).toBeNull();
  });

  it('fila com itens → rota.fila_carregada com o tamanho e o contexto da rota', () => {
    const ev = eventoDaFila({ isLoading: false, isError: false, data: fila() });
    expect(ev?.evento).toBe('rota.fila_carregada');
    expect(ev?.props.n_fila).toBe(40);
    expect(ev?.props.n_resolvidos).toBe(2);
    expect(ev?.props.n_excluidos).toBe(786);
    expect(ev?.props.n_cidades).toBe(3);
    expect(ev?.props.route_date).toBe('2026-08-10');
    expect(ev?.props.daily_only).toBe(false);
    expect(ev?.props.cadencia_indisponivel).toBe(false);
  });

  it('fila vazia → rota.fila_vazia carregando o motivo declarado', () => {
    const ev = eventoDaFila({
      isLoading: false,
      isError: false,
      data: fila({ callQueue: [], excluidos: [], motivoFilaVazia: 'sem_candidato' }),
    });
    expect(ev?.evento).toBe('rota.fila_vazia');
    expect(ev?.props.motivo).toBe('sem_candidato');
    expect(ev?.props.n_cidades).toBe(3);
  });

  it('fila vazia sem motivo declarado → motivo "desconhecido", nunca um palpite', () => {
    const ev = eventoDaFila({
      isLoading: false,
      isError: false,
      data: fila({ callQueue: [], motivoFilaVazia: null }),
    });
    expect(ev?.evento).toBe('rota.fila_vazia');
    expect(ev?.props.motivo).toBe('desconhecido');
  });

  it('erro → rota.fila_erro com a mensagem', () => {
    const ev = eventoDaFila({ isLoading: false, isError: true, mensagemErro: 'JWT expired', data: undefined });
    expect(ev?.evento).toBe('rota.fila_erro');
    expect(ev?.props.mensagem).toBe('JWT expired');
  });

  it('erro sem mensagem legível ainda emite o evento', () => {
    const ev = eventoDaFila({ isLoading: false, isError: true, mensagemErro: null, data: undefined });
    expect(ev?.evento).toBe('rota.fila_erro');
    expect(ev?.props.mensagem).toBe('(sem mensagem)');
  });

  it('erro vence data de fetch anterior — o React Query preserva `data` em isError', () => {
    // Sem esta precedência, uma query que PASSOU a falhar seguiria reportando
    // fila_carregada com o retrato velho: falha mascarada de sucesso.
    const ev = eventoDaFila({ isLoading: false, isError: true, mensagemErro: 'network', data: fila() });
    expect(ev?.evento).toBe('rota.fila_erro');
  });
});

describe('eventoDaFila — chave de deduplicação', () => {
  it('mesmo desfecho gera a mesma chave (não reemite a cada render)', () => {
    const a = eventoDaFila({ isLoading: false, isError: false, data: fila() });
    const b = eventoDaFila({ isLoading: false, isError: false, data: fila() });
    expect(a?.chave).toBe(b?.chave);
  });

  it('fila que esvazia é desfecho novo → chave diferente', () => {
    const cheia = eventoDaFila({ isLoading: false, isError: false, data: fila() });
    const vazia = eventoDaFila({
      isLoading: false,
      isError: false,
      data: fila({ callQueue: [], motivoFilaVazia: 'todos_excluidos' }),
    });
    expect(cheia?.chave).not.toBe(vazia?.chave);
  });

  it('mesma fila em dia de rota diferente é desfecho novo', () => {
    const hoje = eventoDaFila({ isLoading: false, isError: false, data: fila() });
    const amanha = eventoDaFila({ isLoading: false, isError: false, data: fila({ routeDate: '2026-08-11' }) });
    expect(hoje?.chave).not.toBe(amanha?.chave);
  });
});
