// Estado do lote de cadastro Omie persistido no localStorage (por usuário): fechar a aba
// no meio do lote perde a EXECUÇÃO, não os efeitos — na volta, a tela oferece retomar o
// que ficou pendente/indeterminado em vez de fingir que nada aconteceu (P1 do consult
// Codex 2026-10-18). Puro: parse/serialize testáveis; quem lê/grava o storage é o hook.

// Vocabulário PRÓPRIO (aguardando/nao_iniciado, não pendente/cancelado): o gate G5 do
// universo de pedidos caça cópias da lista de status de VENDA, e colidir com ela é ruído.
import { CNPJ_RE } from '@/lib/radar/normalizar';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { ehMotivoDivergencia, type MotivoDivergencia } from '@/lib/radar/conflito-cadastro';

export type EstadoItemLote =
  | { status: 'aguardando' }
  | { status: 'ok'; codigo: string; jaExistia: boolean; recuperado: boolean }
  | { status: 'falha'; etapa: 'omie' | 'radar'; erro: string; codigo: string | null; codigoVisto?: string | null }
  // Conflito de identidade Radar×Omie (DivergenciaCadastro): TERMINAL — não é retentado (a retomada
  // releria o vínculo antigo e o devolveria como "recuperado") nem é ok (o lote não se apaga sozinho).
  // `conflitoId` = registro no servidor (migration 20261027160000); null/ausente = NÃO sincronizado (lote antigo
  // ou o registro falhou) — o aviso só existe nesta aba até `divergentesNaoSincronizados` subir.
  | { status: 'divergente'; motivo: string; erro: string; codigo: string | null; conflitoId?: number | null }
  | { status: 'nao_iniciado' };

export interface ItemLote {
  cnpj: string;
  nome: string;
  estado: EstadoItemLote;
}

export interface LotePersistido {
  v: 1;
  iniciadoEm: string; // ISO
  itens: ItemLote[];
}

const VERSAO_LOTE_PERSISTIDO = 1 as const;
export const chaveLotePersistido = (uid: string) => `radar-lote-omie:v${VERSAO_LOTE_PERSISTIDO}:${uid}`;

export function serializarLote(lote: LotePersistido): string {
  return JSON.stringify(lote);
}

const STATUS = new Set(['aguardando', 'ok', 'falha', 'nao_iniciado', 'divergente']);

/** Devolve null em JSON inválido, versão diferente ou shape estranho — nunca lança. */
export function parsearLote(raw: string | null): LotePersistido | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<LotePersistido>;
    if (!o || o.v !== VERSAO_LOTE_PERSISTIDO || typeof o.iniciadoEm !== 'string' || !Array.isArray(o.itens)) return null;
    const itens: ItemLote[] = [];
    for (const it of o.itens as unknown[]) {
      if (!it || typeof it !== 'object') return null;
      const i = it as Partial<ItemLote>;
      if (typeof i.cnpj !== 'string' || !CNPJ_RE.test(i.cnpj)) return null;
      const estado = i.estado as Partial<EstadoItemLote> | undefined;
      if (!estado || typeof estado.status !== 'string' || !STATUS.has(estado.status)) return null;
      itens.push({ cnpj: i.cnpj, nome: typeof i.nome === 'string' ? i.nome : i.cnpj, estado: estado as EstadoItemLote });
    }
    return { v: 1, iniciadoEm: o.iniciadoEm, itens };
  } catch {
    return null;
  }
}

/** Itens que uma retomada ainda pode RETENTAR (nem ok, nem conflito terminal). */
export function itensPendentes(lote: LotePersistido): ItemLote[] {
  return lote.itens.filter((i) => i.estado.status !== 'ok' && i.estado.status !== 'divergente');
}

/** Conflitos de vínculo que pedem um humano no Omie — ficam até o usuário esquecer o lote. */
export function itensDivergentes(lote: LotePersistido): ItemLote[] {
  return lote.itens.filter((i) => i.estado.status === 'divergente');
}

/** Conflitos que só esta aba conhece: "Esquecer lote" tem de enviá-los ao servidor antes de apagar. */
export function divergentesNaoSincronizados(lote: LotePersistido): ItemLote[] {
  return lote.itens.filter((i) => i.estado.status === 'divergente' && (i.estado.conflitoId ?? null) === null);
}

/** Lote "acabado" = TUDO ok → pode ser esquecido sozinho. Um conflito só sai por descarte explícito. */
export function loteConcluido(lote: LotePersistido): boolean {
  return lote.itens.every((i) => i.estado.status === 'ok');
}

/**
 * Envia ao servidor os conflitos que só esta aba conhece (o registro falhou na hora, ou lote anterior à migration
 * 20261027160000). `desmentidos` = o servidor re-conferiu e não há mais divergência (RD003) — pode sair. Qualquer
 * outra falha segura o lote: apagá-lo perderia a única evidência (Codex 2026-10-27, g).
 */
export async function sincronizarDivergentes(
  lote: LotePersistido,
  registrar: (cnpj: string, motivo: MotivoDivergencia, codigoRecebido: string | null, detalhe: string) => Promise<{ id: number }>,
  ehDesmentido: (e: unknown) => boolean,
): Promise<{ lote: LotePersistido; falhas: { cnpj: string; erro: string }[]; desmentidos: string[] }> {
  const falhas: { cnpj: string; erro: string }[] = [];
  const desmentidos: string[] = [];
  const ids = new Map<string, number>();
  for (const item of divergentesNaoSincronizados(lote)) {
    const e = item.estado;
    if (e.status !== 'divergente') continue;
    if (!ehMotivoDivergencia(e.motivo)) { falhas.push({ cnpj: item.cnpj, erro: `motivo desconhecido: ${e.motivo}` }); continue; }
    try {
      ids.set(item.cnpj, (await registrar(item.cnpj, e.motivo, e.codigo, e.erro)).id);
    } catch (err) {
      if (ehDesmentido(err)) desmentidos.push(item.cnpj);
      else falhas.push({ cnpj: item.cnpj, erro: mensagemDeErro(err) ?? 'falha desconhecida' });
    }
  }
  const itens = lote.itens.map((i) =>
    i.estado.status === 'divergente' && ids.has(i.cnpj) ? { ...i, estado: { ...i.estado, conflitoId: ids.get(i.cnpj) ?? null } } : i);
  return { lote: { ...lote, itens }, falhas, desmentidos };
}
