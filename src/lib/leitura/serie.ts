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
import { desatualizado, type EstadoLeitura, type EstadoSemLeitura, type FatiaDeQuery } from './estado-de-leitura';

// Sem `export`: os dois sensores consomem `motivoNaSerie()`, não a tabela. Exportá-la seria
// deadcode (o `knip` do CI reprova) — e pior, seria um segundo caminho para traduzir o motivo,
// que é exatamente a duplicação que este módulo existe para eliminar.
const MOTIVO_NA_SERIE = {
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

// ─── O SEGUNDO EIXO: o ESTADO da leitura, não o motivo de o número estar velho ───
//
// `motivoNaSerie` acima cobre o eixo "o que está na tela pode estar velho". O outro eixo é o
// DESFECHO da leitura, e ele vazou pelos mesmos 20cm de código: `carteira.saude_vista` (#1886) e
// `carteira.positivacao_vista` (#1896) mandaram o retorno de `estadoDeLeitura` CRU para dentro do
// `track()` — `{ estado }` —, e o helper fala `'sem-rede'` com HÍFEN enquanto a série fala
// `sem_rede`. O #1886 fez isso 27 MINUTOS depois de o `sem_rede` nascer no #1892.
//
// Nada disso fica vermelho sozinho: a tela não muda, e o `tsc` não via porque
// `track(event, properties?: Record<string, unknown>)` não tipava o payload. O que quebra é a
// CONTINUIDADE da série — quem filtra `estado = sem_rede` passa a enxergar um dos eventos, não
// os três. O gate que torna a reintrodução vermelha vive em `@/lib/analytics` (o tipo de `track`
// recusa union de literais hifenizado); esta tabela é a saída certa que ele empurra.
//
// Exaustiva sobre `EstadoLeitura` inteiro, e não só sobre os dois de `EstadoSemLeitura`: estado
// novo no helper não compila até alguém decidir como ele se chama na série.
const ESTADO_NA_SERIE = {
  carregando: 'carregando',
  'sem-rede': 'sem_rede',
  erro: 'erro',
  desabilitada: 'desabilitada',
  pronta: 'pronta',
} as const satisfies Record<EstadoLeitura, string>;

/** Sem `export` na tabela, pelo mesmo motivo do `MOTIVO_NA_SERIE`: um caminho só para traduzir. */
type EstadoNaSerie = (typeof ESTADO_NA_SERIE)[EstadoLeitura];

/** O desfecho da leitura já no alfabeto da série — nenhum membro hifenizado, por construção. */
export function estadoNaSerie(e: EstadoLeitura): EstadoNaSerie {
  return ESTADO_NA_SERIE[e];
}
