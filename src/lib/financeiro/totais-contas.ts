/**
 * Totalizadores das abas "Contas a Receber"/"a Pagar" de `/financeiro`.
 *
 * ⚠️ POR QUE EXISTE: os cards somavam `valor_recebido`/`valor_pago` e `saldo` crus de
 * `fin_contas_{receber,pagar}` — colunas que o LIST do Omie nunca preenche (#396; 0 em
 * 44.524/44.524 CR e 16.125/16.125 CP, medido em prod 2026-09-09). O card "Recebido" afirmava
 * R$ 0,00 sobre R$ 27,8M de títulos com status RECEBIDO, e o card "Saldo" o valor de face
 * inteiro, porque `saldo` é coluna GERADA (`valor_documento - COALESCE(valor_pago, 0)`) e herda
 * o subtraendo zerado. Ver `./procedencia-baixa`.
 *
 * A agregação mora aqui, fora do componente, por uma razão de PROVA: a decisão que interessa —
 * degradar ou não — fica exercitável sem montar a página, e o CONTROLE (fonte confiável + soma 0
 * ⇒ `0`, nunca "—") é um caso de teste em vez de uma inspeção visual.
 */
import { baixaOuIndisponivel, type ProcedenciaBaixa } from './procedencia-baixa';

export interface TotaisContas {
  /** Soma de `valor_documento`: medida, não depende da baixa — fica sempre. */
  valor: number;
  /** Soma de `valor_recebido`/`valor_pago`; `null` quando a fonte não ingere a baixa. */
  baixa: number | null;
  /** Soma do `saldo` GERADO a partir da baixa → degrada junto com ela. */
  saldo: number | null;
  /**
   * A declaração de fonte que produziu (ou não) os `null` acima. Viaja junto de propósito: o
   * CSV e as células POR TÍTULO da mesma tela mostram as MESMAS colunas e têm de degradar pelo
   * mesmo gatilho — duas declarações de procedência na mesma tela poderiam divergir.
   */
  procedencia: ProcedenciaBaixa;
}

/** Forma mínima que a agregação lê — as duas tabelas diferem só no nome da coluna de baixa. */
interface LinhaNormalizada {
  valor_documento: number;
  baixa: number;
  saldo: number;
}

/**
 * Soma em NÚMERO e só degrada na SAÍDA: acumular sobre `null` reintroduziria o
 * `Number(null) === 0` que esta contenção existe para remover.
 *
 * ⚠️ A decisão NÃO olha a soma. `soma === 0` como gatilho transformaria uma carteira
 * legitimamente sem recebimento em "—", mentindo no sentido oposto — `procedencia-baixa.ts`.
 */
function totalizar(
  linhas: readonly LinhaNormalizada[],
  procedencia: ProcedenciaBaixa,
): TotaisContas {
  let valor = 0;
  let baixa = 0;
  let saldo = 0;
  for (const l of linhas) {
    valor += l.valor_documento;
    baixa += l.baixa;
    saldo += l.saldo;
  }
  return {
    valor,
    baixa: baixaOuIndisponivel(baixa, procedencia),
    saldo: baixaOuIndisponivel(saldo, procedencia),
    procedencia,
  };
}

export function totaisReceber(
  contas: readonly { valor_documento: number; valor_recebido: number; saldo: number }[],
  procedencia: ProcedenciaBaixa,
): TotaisContas {
  return totalizar(
    contas.map(c => ({ valor_documento: c.valor_documento, baixa: c.valor_recebido, saldo: c.saldo })),
    procedencia,
  );
}

export function totaisPagar(
  contas: readonly { valor_documento: number; valor_pago: number; saldo: number }[],
  procedencia: ProcedenciaBaixa,
): TotaisContas {
  return totalizar(
    contas.map(c => ({ valor_documento: c.valor_documento, baixa: c.valor_pago, saldo: c.saldo })),
    procedencia,
  );
}
