/**
 * Meta mensal por potencial da carteira (RPC `meta_potencial_mes`, migration 20261120230000).
 * Meta = (previsão espontânea calibrada + incremento por alavanca) × índice sazonal, por conta × dono da carteira.
 * Ausente ≠ zero: qualquer conta sem meta deixa a meta do recorte INDISPONÍVEL (nunca soma parcial, nunca R$ 0).
 * Spec: docs/superpowers/specs/2026-11-20-meta-potencial-vendedora-design.md
 */
import type { CompanySelection } from '@/contexts/CompanyContext';

export interface LinhaMeta {
  account: string;
  owner_user_id: string | null;
  owner_nome: string | null;
  owner_ativo: boolean;
  base: number;
  esp_c: number | null;
  esp_d: number | null;
  novos: number | null;
  inc_c: number;
  inc_d: number;
  inc_b: number;
  inc_cross: number | null;
  taxa_c: number | null;
  taxa_d: number | null;
  indice_sazonal: number | null;
  meta: number | null;
  n_a: number;
  n_b: number;
  n_c: number;
  n_d: number;
  realizado: number;
}

interface Dias { total: number; restantes: number }

export interface MetaResposta {
  mes: string;
  versao: number;
  status: 'congelada' | 'provisoria';
  linhas: LinhaMeta[];
  diasUteis: Record<string, Dias>;
  diasUteisGrupo: Dias;
}

const ehObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ehDias = (v: unknown): v is Dias => ehObj(v) && typeof v.total === 'number' && typeof v.restantes === 'number';

/** Valida o jsonb da RPC; forma inesperada LANÇA (vira "meta indisponível", não número inventado). */
export function parseMetaResposta(raw: unknown): MetaResposta {
  if (
    !ehObj(raw) || (raw.status !== 'congelada' && raw.status !== 'provisoria') || !Array.isArray(raw.linhas)
    || !ehObj(raw.dias_uteis) || !ehDias(raw.dias_uteis_grupo) || typeof raw.mes !== 'string'
    || !raw.linhas.every((l) => ehObj(l) && typeof l.account === 'string' && typeof l.base === 'number'
      && typeof l.realizado === 'number')
  ) {
    throw new Error('meta_potencial_mes: resposta malformada');
  }
  const diasUteis: Record<string, Dias> = {};
  for (const [k, v] of Object.entries(raw.dias_uteis)) if (ehDias(v)) diasUteis[k] = v;
  return {
    mes: raw.mes,
    versao: Number(raw.versao),
    status: raw.status,
    linhas: raw.linhas as LinhaMeta[],
    diasUteis,
    diasUteisGrupo: raw.dias_uteis_grupo,
  };
}

interface VendedoraMeta { id: string | null; nome: string; ativo: boolean; meta: number | null; realizado: number }

export interface MetaAgregada {
  status: MetaResposta['status'];
  /** null = indisponível (conta sem calibração/sazonalidade ou sem linhas). */
  meta: number | null;
  realizado: number;
  pct: number | null;
  /** R$ por dia útil restante para bater a meta; 0 se batida; null sem meta ou sem dias restantes. */
  ritmo: number | null;
  batida: boolean;
  diasRestantes: number | null;
  diasTotal: number | null;
  previsao: number | null;
  incremento: number | null;
  alavancas: { inc_c: number; inc_d: number; inc_b: number; inc_cross: number | null };
  segmentos: { n_a: number; n_b: number; n_c: number; n_d: number };
  indice: number | null;
  contasSemMeta: string[];
  semLinhas: boolean;
  vendedoras: VendedoraMeta[];
}

const somaOuNull = (xs: (number | null)[]): number | null => (xs.some((x) => x == null) ? null : xs.reduce<number>((a, x) => a + (x as number), 0));

export function agregarMeta(r: MetaResposta, selection: CompanySelection): MetaAgregada {
  const linhas = selection === 'all' ? r.linhas : r.linhas.filter((l) => l.account === selection);
  const semLinhas = linhas.length === 0;
  const contasSemMeta = [...new Set(linhas.filter((l) => l.meta == null).map((l) => l.account))].sort();
  const meta = semLinhas ? null : somaOuNull(linhas.map((l) => l.meta));
  const realizado = linhas.reduce((a, l) => a + l.realizado, 0);
  const dias = selection === 'all' ? r.diasUteisGrupo : r.diasUteis[selection];
  const indice = linhas[0]?.indice_sazonal ?? null;
  const previsao = somaOuNull(linhas.flatMap((l) => [l.base, l.esp_c, l.esp_d, l.novos]));
  const incremento = somaOuNull(linhas.flatMap((l) => [l.inc_c, l.inc_d, l.inc_b, l.inc_cross]));
  const batida = meta != null && realizado >= meta;
  const ritmo = meta == null || !dias ? null : batida ? 0 : dias.restantes > 0 ? (meta - realizado) / dias.restantes : null;

  const porDono = new Map<string, VendedoraMeta>();
  for (const l of linhas) {
    const k = l.owner_user_id ?? '∅';
    const atual = porDono.get(k) ?? {
      id: l.owner_user_id,
      nome: l.owner_user_id == null ? 'Sem dono / clientes novos' : (l.owner_nome ?? 'Sem nome'),
      ativo: l.owner_ativo,
      meta: 0,
      realizado: 0,
    };
    atual.meta = atual.meta == null || l.meta == null ? null : atual.meta + l.meta;
    atual.realizado += l.realizado;
    porDono.set(k, atual);
  }
  const vendedoras = [...porDono.values()].sort((a, b) =>
    (a.id == null ? 1 : 0) - (b.id == null ? 1 : 0) || Number(b.ativo) - Number(a.ativo) || (b.meta ?? -1) - (a.meta ?? -1));

  const soma = (k: 'inc_c' | 'inc_d' | 'inc_b' | 'n_a' | 'n_b' | 'n_c' | 'n_d') => linhas.reduce((a, l) => a + l[k], 0);
  return {
    status: r.status,
    meta,
    realizado,
    pct: meta != null && meta > 0 ? realizado / meta : null,
    ritmo,
    batida,
    diasRestantes: dias?.restantes ?? null,
    diasTotal: dias?.total ?? null,
    previsao: previsao == null || indice == null ? null : previsao * indice,
    incremento: incremento == null || indice == null ? null : incremento * indice,
    alavancas: { inc_c: soma('inc_c'), inc_d: soma('inc_d'), inc_b: soma('inc_b'), inc_cross: somaOuNull(linhas.map((l) => l.inc_cross)) },
    segmentos: { n_a: soma('n_a'), n_b: soma('n_b'), n_c: soma('n_c'), n_d: soma('n_d') },
    indice,
    contasSemMeta,
    semLinhas,
    vendedoras,
  };
}
