// src/lib/tint/rejeicoes.ts
// Leitura PURA das rejeições que o Guard 4 (`tint_promote_sync_run`) grava em `tint_sync_errors`.
//
// A mensagem (`error_message`) só diz a CLASSE ("corante presente sem dose válida"); o QUE está
// errado na receita vive em `error_details.itens` — cada linha com `ordem`, `id_corante`,
// `qtd_ml` e `viola`. Duas assinaturas reais, ambas diagnosticadas em docs/agent/tintometrico.md
// ("As receitas corrompidas … são DADO DA FONTE"):
//  - slot livre gravado como `{id_corante:'0', qtd_ml:0}` — o formato que o conector ≤0.2.0
//    mandava para cor personalizada; o 0.2.2+ reconhece a sentinela, e o resíduo só sai quando o
//    re-scan completo de domingo relê a cor;
//  - dose legível sem corante (`id_corante` vazio) — ambíguo de verdade: só a fonte diz se falta
//    um corante ou se é lixo do cadastro.
// Qualquer outra forma (ou mistura das duas) NÃO é adivinhada: vira `outro` e a tela mostra a
// mensagem do guard.

export type TipoRejeicao = 'slot_livre' | 'dose_sem_corante' | 'outro';

export interface LinhaVioladora {
  ordem: number | null;
  idCorante: string | null;
  qtdMl: number | null;
}

export interface Classificacao {
  tipo: TipoRejeicao;
  linhas: LinhaVioladora[];
}

function texto(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function numero(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function ehSlotLivre(l: LinhaVioladora): boolean {
  return l.idCorante === '0' && l.qtdMl === 0;
}

function ehDoseSemCorante(l: LinhaVioladora): boolean {
  return (l.idCorante ?? '').trim() === '' && l.qtdMl !== null && l.qtdMl > 0;
}

/**
 * Classifica UMA rejeição pelo `error_details`. Sem `itens` legíveis ou sem linha marcada
 * `viola` devolve `null` — "não sei dizer", nunca um tipo inventado.
 */
export function classificarRejeicao(detalhes: unknown): Classificacao | null {
  if (detalhes == null || typeof detalhes !== 'object') return null;
  const itens = (detalhes as { itens?: unknown }).itens;
  if (!Array.isArray(itens)) return null;

  const linhas: LinhaVioladora[] = itens
    .filter((i): i is Record<string, unknown> => i != null && typeof i === 'object')
    .filter((i) => i.viola === true)
    .map((i) => ({ ordem: numero(i.ordem), idCorante: texto(i.id_corante), qtdMl: numero(i.qtd_ml) }))
    .sort((a, b) => (a.ordem ?? Infinity) - (b.ordem ?? Infinity));
  if (linhas.length === 0) return null;

  const tipo: TipoRejeicao = linhas.every(ehSlotLivre)
    ? 'slot_livre'
    : linhas.every(ehDoseSemCorante)
      ? 'dose_sem_corante'
      : 'outro';
  return { tipo, linhas };
}

/** "slot 4" · "slots 5 e 6" · "slots 2, 3, 4, 5 e 6" — `null` se nenhuma linha tem ordem. */
export function descreverSlots(linhas: LinhaVioladora[]): string | null {
  const ordens = [...new Set(linhas.map((l) => l.ordem).filter((o): o is number => o !== null))];
  if (ordens.length === 0) return null;
  if (ordens.length === 1) return `slot ${ordens[0]}`;
  return `slots ${ordens.slice(0, -1).join(', ')} e ${ordens[ordens.length - 1]}`;
}

export interface LinhaDeErro {
  sync_run_id: string;
  entity_type: string;
  entity_id: string | null;
  error_message: string | null;
  error_details: unknown;
}

export interface CorRejeitada {
  cor: string;
  /** Fórmulas (produto/base/embalagem) da cor barradas no run mais recente em que ela apareceu. */
  formulas: number;
  tipo: TipoRejeicao;
  /** Linhas violadoras da 1ª fórmula do run — o que a tela descreve. */
  linhas: LinhaVioladora[];
  /** Cabeça da mensagem do guard — o que sobra quando o detalhe não classifica. */
  motivo: string;
}

/**
 * O motivo que `tint_promote_sync_run` grava vem com o sufixo técnico e a fórmula colada:
 * "receita corrompida: corante presente sem dose válida (qtd_ml <= 0/nula/não-finita) + linha
 * inválida sob protocolo declarado (1d-E) — fórmula PRETO/0,9L". O operador precisa só da cabeça.
 */
export function motivoCurto(msg: string): string {
  return msg.split(' — ')[0].split(' + ')[0].replace(/\s*\(.*$/, '').trim();
}

/**
 * Deduplica por cor. `linhas` vem do MAIS NOVO para o mais velho: o conector re-envia a mesma cor
 * a cada ciclo, então a 1ª ocorrência é o run mais recente dela, e só as linhas DESSE run contam
 * fórmulas — somar todos os runs da janela multiplicaria a mesma fórmula pelo nº de ciclos.
 * Fórmulas da mesma cor com tipos diferentes viram `outro` (não escolhe um pelo outro).
 */
export function agruparPorCor(linhas: LinhaDeErro[]): CorRejeitada[] {
  const porCor = new Map<string, CorRejeitada & { run: string }>();
  for (const l of linhas) {
    const chave = `${l.entity_type}:${l.entity_id}`;
    const c = classificarRejeicao(l.error_details);
    const atual = porCor.get(chave);
    if (!atual) {
      porCor.set(chave, {
        run: l.sync_run_id,
        cor: l.entity_id ?? '—',
        formulas: 1,
        tipo: c?.tipo ?? 'outro',
        linhas: c?.linhas ?? [],
        motivo: motivoCurto(l.error_message ?? ''),
      });
      continue;
    }
    if (atual.run !== l.sync_run_id) continue;
    atual.formulas += 1;
    if ((c?.tipo ?? 'outro') !== atual.tipo) atual.tipo = 'outro';
  }
  return [...porCor.values()]
    .map(({ run: _run, ...cor }) => cor)
    .sort((a, b) => b.formulas - a.formulas || a.cor.localeCompare(b.cor));
}

/**
 * De ONDE é a cor: criada no balcão (`personalizada`) ou do catálogo da fábrica. A rejeição só grava
 * o nome da cor (`entity_id`) — a marca vem das linhas da MESMA cor em `tint_formulas`,
 * `tint_receita_versoes` e `tint_staging_formulas` (a rejeitada pode nunca ter sido promovida).
 */
export type OrigemCor = 'personalizada' | 'fabrica';

/**
 * Funde as marcas `personalizada` de todas as linhas lidas por cor. Uma marca só → ela; nenhuma ou
 * as DUAS (o mesmo `cor_id` nos dois mundos — 1 em 9.340 em 2026-10-27) → a cor fica FORA do mapa:
 * "não sei", nunca um lado escolhido por padrão.
 */
export function origemPorCor(linhas: Array<{ cor_id: string | null; personalizada: boolean | null }>): Map<string, OrigemCor> {
  const marcas = new Map<string, Set<boolean>>();
  for (const l of linhas) {
    if (l.cor_id == null || l.personalizada == null) continue;
    const s = marcas.get(l.cor_id) ?? new Set<boolean>();
    s.add(l.personalizada);
    marcas.set(l.cor_id, s);
  }
  const origem = new Map<string, OrigemCor>();
  for (const [cor, s] of marcas) {
    if (s.size === 1) origem.set(cor, s.has(true) ? 'personalizada' : 'fabrica');
  }
  return origem;
}

/**
 * O número do badge da sidebar (`/tintometrico`) — o MESMO que o card "Fórmulas rejeitadas pela
 * fonte" mostra: cores com receita barrada nas 24h até o último run. Antes o badge contava runs de
 * `tint_importacoes` com erro em 60 dias (2.656 em 31/10/2026 com 1 cor barrada de fato).
 *
 * Lista vazia com rejeições na janela = o card mostra "N rejeições sem detalhe" → o badge mostra N.
 * `null` (nunca houve run) não é alerta → 0, e o shell não pinta badge.
 */
export function contagemDoBadge(
  r: { rejeicoesNaJanela: number; cores: readonly unknown[] } | null,
): number {
  if (!r) return 0;
  return r.cores.length > 0 ? r.cores.length : r.rejeicoesNaJanela;
}
