// Último contato na lista de Clientes (onda 3). Funções PURAS — o hook (useUltimoContato) só lê.
//
// Não há fonte única de "contato": a ficha de ligação/Fila do Dia grava em `venda_contato` (1 linha por
// vendedor × cliente × dia, o último toque vence) e a lista de ligação por rota grava em
// `route_contact_log`. `farmer_calls` está VAZIA em prod (2026-11-22) e `v_carteira_sla` deriva dela —
// nenhuma das duas serve. O último contato é o registro mais recente das duas fontes, numa janela fixa.
//
// Ausente ≠ zero: sem registro na janela → "sem contato registrado em 180d"; leitura que falhou →
// "último contato indisponível". Nunca "há 0 dias" por ausência de dado.

/** Janela da leitura (dias). Fora dela a lista diz "sem registro em 180d", não "nunca". */
export const JANELA_ULTIMO_CONTATO_DIAS = 180;

export interface RegistroContato {
  clienteId: string;
  /** ISO timestamp do registro. */
  em: string;
  /** Desfecho no vocabulário da fonte (`venda_contato.resultado` ou `route_contact_log.status`). */
  desfecho: string | null;
}

const ROTULO_DESFECHO: Record<string, string> = {
  // venda_contato.resultado
  vendeu: 'vendeu',
  vai_pedir: 'vai pedir',
  sem_interesse: 'sem interesse',
  nao_atendeu: 'não atendeu',
  // route_contact_log.status
  convertido: 'convertido',
  respondido: 'respondeu',
  sem_resposta: 'sem resposta',
  opt_out: 'pediu para não ligar',
};

/** O registro mais recente de cada cliente (empate: o primeiro visto). Data inválida é descartada. */
export function ultimoPorCliente(registros: RegistroContato[]): Map<string, RegistroContato> {
  const saida = new Map<string, RegistroContato>();
  for (const r of registros) {
    const t = Date.parse(r.em);
    if (!Number.isFinite(t)) continue;
    const atual = saida.get(r.clienteId);
    if (!atual || t > Date.parse(atual.em)) saida.set(r.clienteId, r);
  }
  return saida;
}

/** Dias de calendário (local) entre o registro e hoje; nunca negativo. */
function diasDeCalendario(em: string, hoje: Date): number {
  const d = new Date(em);
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export type EstadoUltimoContato = 'carregando' | 'falha' | 'ok';

/** Contexto da LEITURA inteira (não da linha) que muda o que a ausência significa. */
export interface ContextoUltimoContato {
  /** A leitura respondeu com ZERO registros para todos os clientes do escopo. */
  escopoSemRegistro?: boolean;
  /** A RLS de `venda_contato` só mostra os registros do PRÓPRIO usuário (não-master). */
  soOsProprios?: boolean;
}

/**
 * O que a linha da lista pode afirmar. `carregando` → nada (null) — não pisca "sem contato".
 *
 * Onda B: com o escopo INTEIRO sem registro (as duas fontes estão vazias em prod, 2026-11-24), "sem
 * contato em 180d" em toda linha é ruído, não informação → null. E para quem não é master a RLS de
 * `venda_contato` esconde o contato feito por OUTRA pessoa: a ausência é "não visível para você", não
 * "não houve".
 */
export function rotuloUltimoContato(
  registro: RegistroContato | null | undefined,
  estado: EstadoUltimoContato,
  hoje: Date,
  ctx: ContextoUltimoContato = {},
): string | null {
  if (estado === 'carregando') return null;
  if (estado === 'falha') return 'último contato indisponível';
  if (!registro) {
    if (ctx.escopoSemRegistro) return null;
    return ctx.soOsProprios
      ? `sem contato visível para você em ${JANELA_ULTIMO_CONTATO_DIAS}d`
      : `sem contato registrado em ${JANELA_ULTIMO_CONTATO_DIAS}d`;
  }
  const dias = diasDeCalendario(registro.em, hoje);
  const quando = dias === 0 ? 'contato hoje' : dias === 1 ? 'contato ontem' : `contato há ${dias}d`;
  const desfecho = registro.desfecho ? ROTULO_DESFECHO[registro.desfecho] ?? null : null;
  return desfecho ? `${quando} · ${desfecho}` : quando;
}
