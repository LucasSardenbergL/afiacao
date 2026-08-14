import { describe, it, expect } from 'vitest';
import { eventoDaCarga, type SaidaDaCarga } from './telemetria-fila-plano';

/**
 * Telemetria da fila do Plano Tático — o SENSOR que a errata de #1716 previu.
 *
 * Discriminador destes testes: um teste que só checasse "emitiu algum evento" passaria
 * numa versão que classifica erro como fila vazia — que é exatamente o defeito. Os asserts
 * abaixo travam (a) o motivo DECLARADO de cada saída-vazia, (b) a precedência do erro sobre
 * a lista, e (c) o fato de que o `catch` deixa a lista ANTIGA na tela.
 */

const ctx = { filtro: 'pendentes' as const, total: 169 };

describe('eventoDaCarga — a fila diz POR QUE veio vazia', () => {
  it('lista com planos → fila_carregada com o tamanho e o total sob o mesmo recorte', () => {
    const ev = eventoDaCarga({ tipo: 'lista', nExibidos: 50 }, ctx);
    expect(ev.evento).toBe('plano_tatico.fila_carregada');
    expect(ev.props.n_exibidos).toBe(50);
    expect(ev.props.total).toBe(169);
    expect(ev.props.filtro).toBe('pendentes');
  });

  it('lista vazia → fila_vazia com motivo recorte_vazio (a consulta RESPONDEU zero)', () => {
    const ev = eventoDaCarga({ tipo: 'lista', nExibidos: 0 }, { filtro: 'pendentes', total: 0 });
    expect(ev.evento).toBe('plano_tatico.fila_vazia');
    expect(ev.props.motivo).toBe('recorte_vazio');
  });

  // As três saídas-vazias que hoje produzem o MESMO pixel ("Nenhum plano pendente").
  // Sem motivo declarado, "a consulta morreu" é indistinguível de "não há plano".
  it.each([
    ['sem_escopo', 'a carga nem chegou a consultar (sem id efetivo)'],
    ['sem_resposta', 'sem error E sem data — indecidível, declarado como tal'],
    ['recorte_vazio', 'a consulta respondeu e o recorte não tem plano'],
  ] as const)('motivo %s viaja no evento em vez de virar o mesmo pixel', (motivo) => {
    const ev = eventoDaCarga({ tipo: 'vazia', motivo }, { filtro: 'pendentes', total: null });
    expect(ev.evento).toBe('plano_tatico.fila_vazia');
    expect(ev.props.motivo).toBe(motivo);
  });

  it('contagem não apurada viaja como null, NUNCA como 0 (ausente ≠ zero)', () => {
    const ev = eventoDaCarga({ tipo: 'lista', nExibidos: 12 }, { filtro: 'pendentes', total: null });
    expect(ev.props.total).toBeNull();
    expect(ev.props.total).not.toBe(0);
  });

  it('erro de CONSULTA → fila_erro, e a lista foi limpa', () => {
    const ev = eventoDaCarga(
      { tipo: 'erro', origem: 'consulta', mensagem: 'statement timeout', manteveLista: false },
      ctx,
    );
    expect(ev.evento).toBe('plano_tatico.fila_erro');
    expect(ev.props.origem).toBe('consulta');
    expect(ev.props.mensagem).toBe('statement timeout');
    expect(ev.props.manteve_lista).toBe(false);
  });

  it('EXCEÇÃO → fila_erro sinalizando que a lista ANTIGA continua na tela', () => {
    // O `catch` de loadPlans só faz console.error: `plans` NÃO é atualizado, então a tela
    // segue exibindo o retrato do carregamento anterior. Sem `manteve_lista` ninguém
    // distingue "quebrou e esvaziou" de "quebrou e está mostrando dado velho".
    const ev = eventoDaCarga(
      { tipo: 'erro', origem: 'excecao', mensagem: 'Failed to fetch', manteveLista: true },
      ctx,
    );
    expect(ev.evento).toBe('plano_tatico.fila_erro');
    expect(ev.props.origem).toBe('excecao');
    expect(ev.props.manteve_lista).toBe(true);
  });

  it('erro sem mensagem utilizável não fabrica diagnóstico', () => {
    const ev = eventoDaCarga(
      { tipo: 'erro', origem: 'consulta', mensagem: null, manteveLista: false },
      ctx,
    );
    expect(ev.props.mensagem).toBe('(sem mensagem)');
  });

  it('o erro NUNCA reporta tamanho de lista — é inrepresentável no tipo', () => {
    // Precedência do erro sobre `data`: no caminho de exceção o `plans` do hook é o retrato
    // VELHO. Se a variante de erro carregasse `nExibidos`, uma carga que PASSOU a falhar
    // reportaria sucesso com o número antigo. O tipo não deixa — este teste trava a garantia.
    const erro: SaidaDaCarga = { tipo: 'erro', origem: 'consulta', mensagem: 'x', manteveLista: false };
    expect(Object.keys(erro)).not.toContain('nExibidos');
    expect(eventoDaCarga(erro, ctx).props.n_exibidos).toBeUndefined();
  });

  it('o filtro viaja em todas as saídas — a análise que importa é a aba pendentes', () => {
    const saidas: SaidaDaCarga[] = [
      { tipo: 'lista', nExibidos: 3 },
      { tipo: 'lista', nExibidos: 0 },
      { tipo: 'vazia', motivo: 'sem_escopo' },
      { tipo: 'erro', origem: 'excecao', mensagem: 'x', manteveLista: true },
    ];
    for (const s of saidas) {
      expect(eventoDaCarga(s, { filtro: 'expirados', total: null }).props.filtro).toBe('expirados');
    }
  });
});
