// A fatia que separa "não há" de "não consegui" numa leitura react-query.
//
// POR QUE EXISTE (classe medida em 2026-08-22 — docs/historico/fase-sem-sinal.md):
// um hook que LANÇA quando a RPC falha deixa `data === undefined`, que é a MESMA
// condição de "vazio" e de "nunca carregou". O componente que faz `if (!data) return
// null` sem ler `error` colapsa os três num silêncio só. Quando a tela é um ALERTA ou
// um painel de SAÚDE, essa ausência AFIRMA segurança: "não consegui ler" chega ao
// usuário como "está tudo bem" — a falha mais cara que um alarme pode ter.
//
// O CONTRA-EXEMPLO já existia no repo, 20 linhas ao lado do defeito original:
// `DataHealthBadge` faz `isError ? 'red' : badgeLevel(data ?? [])` — fail-closed.
// `DataHealthBanner`, mesmo hook, fazia `const { data } = useDataHealth()` e sumia.
//
// O QUARTO ESTADO É O OFFLINE, e ele é o que engana quem "já trata erro": com
// `networkMode: 'online'` (o default, sem override no repo), sem rede a query fica
// `status: 'pending'` + `fetchStatus: 'paused'` — `isLoading` é FALSE (v5 define
// `isLoading = isPending && isFetching`), `data` é `undefined` e `error` é `null`.
// Quem testa só `isLoading`/`error` cai no ramo do vazio. Medido em vitest com
// `onlineManager.setOnline(false)` no #1874; num PWA de campo não é o caso raro.
//
// Por isso o mapeamento aqui é EXAUSTIVO sobre (status × fetchStatus): estado que não
// tem nome é estado que vai colapsar no vizinho.

/** Fatia estrutural de `UseQueryResult` — evita acoplar esta camada pura ao react-query. */
export type FatiaDeQuery = {
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
};

export type EstadoLeitura =
  /** buscando pela 1ª vez — ausência transitória e auto-resolvida */
  | 'carregando'
  /** `networkMode:'online'` sem rede: pending + paused. NÃO é vazio, é cegueira. */
  | 'sem-rede'
  /** a query falhou (`queryFn` lançou) */
  | 'erro'
  /** `enabled: false` — a pergunta não foi feita (sem acesso / sem parâmetro) */
  | 'desabilitada'
  /** respondeu; só aqui `data` fala pela realidade */
  | 'pronta';

/** Os estados em que a leitura NÃO aconteceu — o que `<AvisoLeituraFalhou>` sabe mostrar. */
export type EstadoSemLeitura = Extract<EstadoLeitura, 'erro' | 'sem-rede'>;

export function estadoDeLeitura(q: FatiaDeQuery): EstadoLeitura {
  if (q.status === 'error') return 'erro';
  if (q.status === 'success') return 'pronta';
  // status === 'pending': quem decide é o fetchStatus, e é aqui que mora o offline.
  if (q.fetchStatus === 'paused') return 'sem-rede';
  if (q.fetchStatus === 'idle') return 'desabilitada';
  return 'carregando';
}

/**
 * Os estados em que a tela NÃO PODE afirmar "não há" — ela não sabe.
 *
 * `erro` e `sem-rede` são indistinguíveis do ponto de vista do usuário (em ambos a
 * leitura não aconteceu) e é exatamente por isso que ficam juntos: o que muda é a
 * mensagem, nunca a decisão de FALAR. `carregando` e `desabilitada` ficam de fora de
 * propósito — a primeira é transitória e se resolve sozinha; a segunda é a pergunta
 * que não foi feita, e inventar aviso nela seria alarme fabricado (precisão > recall).
 *
 * É um TYPE GUARD de propósito: o consumidor precisa passar `estado` adiante para o
 * <AvisoLeituraFalhou>, que só aceita os dois. Devolver `boolean` obrigaria cada chamador
 * a re-afirmar o tipo na unha — e um `as` reintroduziria, por cast, exatamente a confusão
 * de estados que este módulo existe para impedir.
 */
export function naoConsegui(e: EstadoDeRegistro): e is EstadoSemLeitura {
  return e === 'erro' || e === 'sem-rede';
}

// ─── LEITURA DE UM REGISTRO POR ID ──────────────────────────────────────────────────
//
// `estadoDeLeitura` responde "a leitura aconteceu?". Uma tela de DETALHE precisa de uma
// segunda resposta — "esta linha existe?" — e é ela que o front do `return` afirmativo
// erra: `if (!registro) return <p>não encontrado</p>` cobre também "o banco caiu"
// (docs/historico/o-check-verde-que-a-falha-acende.md, achado 3). O usuário sai procurar
// um documento que existe.
//
// O eixo que separa as duas NÃO é o mesmo nos dois terminadores do PostgREST, e é por isso
// que um fix só não serve aos dois:
//
//   `.maybeSingle()` → a distinção EXISTE no dado. Em SUCESSO, `null` é "não existe";
//                      `undefined` só sai de loading ou erro. O componente que escreve
//                      `if (!x)` DESCARTA o que o hook preservou.
//   `.single()`      → a distinção NÃO existe sem ler o erro: 0 linhas LANÇA, e chega
//                      idêntico a uma queda de rede.

/**
 * O código que o PostgREST devolve quando não pôde coagir o resultado a UM objeto.
 *
 * ⚠️ RESTRIÇÃO DE USO: `PGRST116` é "não deu UMA linha" — 0 linhas **ou mais de uma**
 * (o comentário de `useKbProductSpecs.ts` documenta o caso >1 no repo). Tratá-lo como
 * "não existe" só é correto quando o filtro é por CHAVE ÚNICA, onde >1 é impossível;
 * sobre filtro não-único ele também significa "há linhas demais", que é defeito de dado
 * — e aí "não encontrado" volta a mentir, só que na direção oposta.
 */
export const PGRST_NENHUMA_LINHA = 'PGRST116';

/**
 * O erro que chegou é "não achei a linha"? Casa o CAMPO `code`, nunca o texto.
 *
 * Casar a mensagem (`includes('PGRST116')`) casaria também um erro EMBRULHADO por outro,
 * e a mensagem é do servidor: muda sem aviso.
 */
export function ehNaoEncontrado(erro: unknown): boolean {
  return (
    typeof erro === 'object' &&
    erro !== null &&
    (erro as { code?: unknown }).code === PGRST_NENHUMA_LINHA
  );
}

/** `EstadoLeitura` mais o único estado que só uma leitura POR ID tem: a linha não existe. */
export type EstadoDeRegistro = EstadoLeitura | 'inexistente';

/**
 * Os 6 estados de uma leitura de UM registro — com "não existe" separado de "não consegui".
 *
 * `temRegistro` só é consultado quando a query RESPONDEU: nos estados de pendência não há
 * dado para consultar, e é justamente aí que mora o offline (`pending` + `paused`, com
 * `isLoading` FALSE e `data` `undefined`) que faz o `if (!registro)` mentir sem que erro
 * nenhum tenha acontecido.
 *
 * Serve aos dois terminadores porque lê os DOIS eixos: o dado em mãos e o código do erro.
 * Quem passar só o primeiro (`.single()` sem `error`) recebe `'erro'` no não-achado — que
 * é conservador e honesto, nunca "inexistente" fabricado.
 */
export function estadoDeRegistro(
  q: FatiaDeQuery & { error?: unknown },
  temRegistro: boolean,
): EstadoDeRegistro {
  if (q.status === 'error') return ehNaoEncontrado(q.error) ? 'inexistente' : 'erro';
  if (q.status === 'success') return temRegistro ? 'pronta' : 'inexistente';
  return estadoDeLeitura(q);
}

/**
 * A leitura falhou MAS há dado em mãos — mostre os DOIS, não escolha.
 *
 * Escolher entre a lista e o aviso é honesto para o sensor e regressão para o usuário:
 * apagar 14 alertas de fluxo de caixa que estão no cache porque um refetch falhou é
 * trocar um defeito por outro. O desenho que serve aos dois é composto — o conteúdo
 * continua na tela, com o aviso de que está desatualizado
 * (`docs/historico/fase-sem-sinal.md`, achado da revisão retroativa do #1859).
 *
 * ⚠️ A ORDEM importa e é `sem-rede` antes de `erro`, mas só COM dado em mãos: o
 * `fetchState` do query-core zera `error` ao iniciar um fetch APENAS quando
 * `data === undefined`, então sem dado os dois nunca coexistem. Com dado no cache eles se
 * sobrepõem, e aí o motivo acionável é o atual — recarregar não resolve falta de sinal.
 * (Sutileza medida pelo #1892 no MixGapCard.)
 *
 * Devolve `null` quando não há o que avisar: leitura boa, ou nada em mãos — nesse último
 * caso o certo é `naoConsegui` + <AvisoLeituraFalhou> sozinho.
 */
export function desatualizado(q: FatiaDeQuery, temDado: boolean): EstadoSemLeitura | null {
  if (!temDado) return null;
  if (q.fetchStatus === 'paused') return 'sem-rede';
  if (q.status === 'error') return 'erro';
  return null;
}
