// Estado do lote de cadastro Omie persistido no localStorage (por usuário): fechar a aba
// no meio do lote perde a EXECUÇÃO, não os efeitos — na volta, a tela oferece retomar o
// que ficou pendente/indeterminado em vez de fingir que nada aconteceu (P1 do consult
// Codex 2026-10-18). Puro: parse/serialize testáveis; quem lê/grava o storage é o hook.

// Vocabulário PRÓPRIO (aguardando/nao_iniciado, não pendente/cancelado): o gate G5 do
// universo de pedidos caça cópias da lista de status de VENDA, e colidir com ela é ruído.
import { CNPJ_RE } from '@/lib/radar/normalizar';

export type EstadoItemLote =
  | { status: 'aguardando' }
  | { status: 'ok'; codigo: string; jaExistia: boolean; recuperado: boolean }
  | { status: 'falha'; etapa: 'omie' | 'radar'; erro: string; codigo: string | null }
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

const STATUS = new Set(['aguardando', 'ok', 'falha', 'nao_iniciado']);

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

/** Itens que uma retomada ainda precisa tratar (não-ok). */
export function itensPendentes(lote: LotePersistido): ItemLote[] {
  return lote.itens.filter((i) => i.estado.status !== 'ok');
}

/** Lote "acabado" = tudo ok → pode ser esquecido. */
export function loteConcluido(lote: LotePersistido): boolean {
  return itensPendentes(lote).length === 0;
}
