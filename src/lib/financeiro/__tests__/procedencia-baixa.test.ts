import { describe, it, expect } from 'vitest';
import {
  BAIXA_OMIE_LIST,
  MOTIVO_BAIXA_NAO_INGERIDA,
  baixaOuIndisponivel,
  type ProcedenciaBaixa,
} from '@/lib/financeiro/procedencia-baixa';

/**
 * O EIXO desta correção é qual pergunta dispara a degradação.
 *
 * "A soma deu 0?" é a pergunta errada e o teste abaixo existe para impedi-la: ela acerta o acervo
 * de hoje por coincidência (100% das baixas são 0 — #396) e passa a MENTIR no sentido oposto no dia
 * em que a ingestão existir, escondendo atrás de "—" o fato de que naquele mês nada foi recebido.
 *
 * "De onde a coluna veio?" é a pergunta certa: é a que continua correta nos dois mundos.
 */

/** Fonte hipotética que INGERE a baixa — o mundo depois do conserto do ingest. */
const COM_BAIXA: ProcedenciaBaixa = {
  fonte: 'teste/fonte-que-ingere-baixa',
  ingereBaixa: true,
  motivo: null,
};

describe('baixaOuIndisponivel — o gatilho é a FONTE, não o valor', () => {
  it('fonte sem baixa → null MESMO com soma > 0 (o valor não é consultado)', () => {
    // Se a implementação testasse `soma === 0`, este caso devolveria 12345 e a coluna crua
    // voltaria à tela sem ninguém notar — a matview pode passar a devolver não-zero (`valor_pag`,
    // que é *a pagar*) sem que a baixa tenha sido ingerida.
    expect(baixaOuIndisponivel(12345, BAIXA_OMIE_LIST)).toBeNull();
  });

  it('fonte sem baixa → null também quando a soma é 0 (é o caso real de hoje)', () => {
    expect(baixaOuIndisponivel(0, BAIXA_OMIE_LIST)).toBeNull();
  });

  it('🔒 O CONTROLE: fonte COM baixa e soma 0 → 0, nunca "—" (zero medido é um FATO)', () => {
    // Este é o caso que a regra `valor === 0` quebraria. Um `expect(...).toBeNull()` aqui seria
    // a degradação mentindo no outro sentido.
    expect(baixaOuIndisponivel(0, COM_BAIXA)).toBe(0);
  });

  it('fonte COM baixa → devolve a soma intacta', () => {
    expect(baixaOuIndisponivel(27_855_279.84, COM_BAIXA)).toBe(27_855_279.84);
  });
});

describe('a procedência do acervo de hoje', () => {
  it('a fonte das matviews dimensionais está declarada como SEM baixa, com motivo exibível', () => {
    // Não é detalhe de implementação: é a afirmação medida em prod (psql-ro, 2026-09-09 —
    // 16.125/16.125 CP e 44.524/44.524 CR com baixa = 0). Trocar para `true` sem consertar o
    // ingest devolve o "R$ 0,00" fabricado à tela, e é isto que deve ficar vermelho.
    expect(BAIXA_OMIE_LIST.ingereBaixa).toBe(false);
    expect(BAIXA_OMIE_LIST.motivo).toBe(MOTIVO_BAIXA_NAO_INGERIDA);
  });

  it('o motivo não tem vírgula nem aspas — ele vai para cabeçalho de CSV sem quoting', () => {
    expect(MOTIVO_BAIXA_NAO_INGERIDA).not.toMatch(/[",\n]/);
  });
});
