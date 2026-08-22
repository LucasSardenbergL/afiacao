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
export function naoConsegui(e: EstadoLeitura): e is EstadoSemLeitura {
  return e === 'erro' || e === 'sem-rede';
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
