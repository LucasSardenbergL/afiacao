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
 */
export function naoConsegui(e: EstadoLeitura): boolean {
  return e === 'erro' || e === 'sem-rede';
}
