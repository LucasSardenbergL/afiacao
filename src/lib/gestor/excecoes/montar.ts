// src/lib/gestor/excecoes/montar.ts
import type {
  ExcecoesInput, ExcecoesCfg, ConsoleExcecoes, LinhaExcecao, GrupoExcecao,
  DecisaoRiscoInput, SaudeCheckInput, TarefaGapInput, FrescorCarteira,
} from './types';
import { EXCECOES_CFG_DEFAULT } from './types';

const num = (v: number | null | undefined): number | null =>
  v != null && Number.isFinite(v) ? v : null;

/** Horas inteiras entre dois ISO (agora − ref). null/inválido → null. */
export function idadeHoras(refIso: string | null, agoraIso: string): number | null {
  if (!refIso) return null;
  const t = Date.parse(refIso), a = Date.parse(agoraIso);
  if (!Number.isFinite(t) || !Number.isFinite(a)) return null;
  return Math.floor((a - t) / 3_600_000);
}

/** Escada de frescor da carteira (ai_decisions). Sem dado → desatualizada. */
export function frescorCarteira(maxCreatedAtIso: string | null, agoraIso: string, cfg: ExcecoesCfg): FrescorCarteira {
  const h = idadeHoras(maxCreatedAtIso, agoraIso);
  if (h == null) return 'desatualizada';
  if (h < cfg.staleHoras) return 'fresh';
  if (h < cfg.desatualizadaHoras) return 'stale';
  return 'desatualizada';
}

/** "há Xh" até 48h; "há Nd" acima. null → null. */
export function frescorTexto(horas: number | null): string | null {
  if (horas == null) return null;
  if (horas < 48) return `há ${horas}h`;
  return `há ${Math.floor(horas / 24)}d`;
}
