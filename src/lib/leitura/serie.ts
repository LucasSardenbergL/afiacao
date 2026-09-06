// A FRONTEIRA entre o vocabulário da leitura e o vocabulário da SÉRIE.
//
// `estado-de-leitura.ts` é camada pura e fala hifenizado (`'sem-rede'`); o PostHog tem
// `sem_rede` gravado desde o #1892. Renomear de um lado partiria o histórico do evento em duas
// séries que ninguém soma depois — então a tradução mora aqui, num módulo próprio, e não dentro
// do helper.
//
// POR QUE UM MÓDULO, e não uma cópia em cada sensor (medido — `docs/historico/fase-sem-sinal.md`):
// os dois sensores da carteira (`carteira.mixgap_visto` e `carteira.positivacao_vista`) alimentam
// a MESMA leitura de adoção. O #1892 escreveu esta tabela à mão dentro do `MixGapCard`; o #1896
// nasceu 1 dia depois sem herdá-la, e a revisão retroativa mediu o resultado: um sensor sabia
// separar "número fresco" de "número velho" e o irmão mandava número velho como fresco. Um literal
// duplicado não diverge no dia em que é copiado — diverge no dia em que só um dos dois é tocado.
//
// O `satisfies` é o que torna a tabela exaustiva: se `EstadoSemLeitura` ganhar um terceiro membro,
// isto PARA DE COMPILAR em vez de mandar `undefined` para o PostHog.
import { desatualizado, type EstadoSemLeitura, type FatiaDeQuery } from './estado-de-leitura';

export const MOTIVO_NA_SERIE = {
  'sem-rede': 'sem_rede',
  erro: 'erro',
} as const satisfies Record<EstadoSemLeitura, string>;

/** Por que o número que está na tela pode estar velho. `null` = acabou de ser lido com sucesso. */
export type MotivoDesatualizado = (typeof MOTIVO_NA_SERIE)[EstadoSemLeitura];

/**
 * `desatualizado()` já no alfabeto da série — o composto que todo sensor da carteira precisa.
 *
 * A precedência (`sem-rede` ganha de `erro`) e a razão de ela só decidir algo COM dado em mãos
 * moram no helper puro, junto do teste que as falsifica; aqui só se traduz.
 */
export function motivoNaSerie(q: FatiaDeQuery, temDado: boolean): MotivoDesatualizado | null {
  const m = desatualizado(q, temDado);
  return m === null ? null : MOTIVO_NA_SERIE[m];
}
