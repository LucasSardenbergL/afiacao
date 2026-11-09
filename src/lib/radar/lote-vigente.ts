// Lote VIGENTE do Radar — helpers PUROS (sem I/O; testáveis).
import { eqText, orFilter } from '@/lib/postgrest';
//
// A fila do Radar é a FOTO VIGENTE da RFB: a empresa que não veio no dump mais recente
// (fechou, mudou de CNAE, saiu do recorte) fica com `ultimo_lote` antigo e NÃO é lead.
// Medido em prod (psql-ro, 2026-10-19): 52.011 leads ativos com ultimo_lote=2026-05 seguiam
// na fila porque a lista só olhava ja_cliente/status — 1 em cada 10 era foto velha.
//
// O conceito vive AQUI uma vez só (e no hook `useRadarLoteVigente`); lista, KPIs, linha e
// ficha consomem o mesmo valor em vez de cada um recomputar "qual é o lote".

export interface LoteIngest {
  mes_referencia: string;        // 'YYYY-MM'
  status: string;                // running | complete | error
  total_recebido: number;
  novos: number | null;
  iniciado_em: string;           // timestamptz ISO
  /** Lote cuja publicação EM PASSOS está em andamento (migration 20261111120000) — `lotePublicando`.
   *  Enquanto existe, a linha com `ultimo_lote = publicando` pertence à foto do seu `lote_anterior`. */
  publicando?: string | null;
}

/** Linha de `radar_ingest_state` com a fase da carga (o que `lotePublicando` precisa). */
export interface LoteIngestComFase extends LoteIngest {
  carga_fase?: string | null;
  carga_publicacao_iniciada_em?: string | null;
}

/** O maior `mes_referencia` com status `complete`. Running/error no meio são ignorados
 *  (um lote em voo ou falhado NÃO é a foto). Desde a publicação atômica (migration 20261110130000)
 *  `complete` tem UM escritor — o job `radar-publicar-lote`, que troca a foto inteira numa transação —,
 *  e os chunks de um lote `running` vão para o staging: enquanto ele não é publicado, nenhuma empresa
 *  carrega o `ultimo_lote` dele. Sem lote completo → `null` — e null é "não sei",
 *  nunca "zero": o card diz "sem dado" e a fila não filtra por lote. */
export function loteVigente(lotes: readonly LoteIngest[]): LoteIngest | null {
  let vigente: LoteIngest | null = null;
  for (const l of lotes) {
    if (l.status !== 'complete') continue;
    if (!vigente || l.mes_referencia > vigente.mes_referencia) vigente = l;
  }
  return vigente;
}

/** O lote em publicação em passos — o MESMO predicado de `public.radar_lote_publicando()`: validado,
 *  publicação começada e MAIS NOVO que o vigente (re-run do mês vigente nunca troca rótulo → null). */
export function lotePublicando(lotes: readonly LoteIngestComFase[], vigente: LoteIngest | null): string | null {
  let p: string | null = null;
  for (const l of lotes) {
    if (l.carga_fase !== 'validada' || !l.carga_publicacao_iniciada_em) continue;
    if (vigente && l.mes_referencia <= vigente.mes_referencia) continue;
    if (p == null || l.mes_referencia < p) p = l.mes_referencia;
  }
  return p;
}

/** Rótulo EFETIVO da linha: durante a publicação em passos, quem já ganhou o rótulo do lote em
 *  publicação ainda é da foto do `lote_anterior` (null = empresa nova, ainda de foto nenhuma). Fora
 *  da publicação é o `ultimo_lote` físico. Todo predicado de foto do front passa por aqui. */
export function rotuloEfetivo(
  e: { ultimo_lote: string | null; lote_anterior?: string | null },
  lote: { publicando?: string | null } | null,
): string | null {
  if (lote?.publicando && e.ultimo_lote === lote.publicando) return e.lote_anterior ?? null;
  return e.ultimo_lote;
}

/** A foto de `lote` numa query DIRETA do PostgREST (as RPCs expandem no servidor): `ultimo_lote IN
 *  (V, P)` e, havendo P, `ultimo_lote = V OU lote_anterior = V` — o predicado de `radar_lista`. */
export function fotoPostgrest(lote: Pick<LoteIngest, 'mes_referencia' | 'publicando'>): { rotulos: string[]; ou: string | null } {
  const v = lote.mes_referencia;
  if (!lote.publicando) return { rotulos: [v], ou: null };
  return { rotulos: [v, lote.publicando], ou: orFilter(eqText('ultimo_lote', v), eqText('lote_anterior', v)) };
}

/** Inédito = entrou no universo NESTE lote: `primeira_vista_em` (só gravado no INSERT) >=
 *  `iniciado_em` do lote vigente E `ultimo_lote` = vigente. É o MESMO predicado do count do
 *  card "Inéditos do lote" (`useRadarIneditos`) — selo e número não podem divergir. */
export function ehInedito(
  e: { primeira_vista_em: string | null; ultimo_lote: string | null; lote_anterior?: string | null },
  lote: LoteIngest | null,
): boolean {
  if (!lote || !e.primeira_vista_em || rotuloEfetivo(e, lote) !== lote.mes_referencia) return false;
  return Date.parse(e.primeira_vista_em) >= Date.parse(lote.iniciado_em);
}

/** Saiu do dump = a última vez que a RFB listou a empresa foi em lote ANTERIOR ao vigente.
 *  Só diz o FATO (não veio no dump); o motivo (baixa, mudança de CNAE) é outra entrega. */
export function saiuDoDump(e: { ultimo_lote: string | null; lote_anterior?: string | null }, lote: LoteIngest | null): boolean {
  const r = rotuloEfetivo(e, lote);
  if (!lote || !r) return false;
  return r < lote.mes_referencia;
}

/** O recorte de lote que a fila E o ranking/mapa aplicam — um predicado só, para os dois
 *  universos não divergirem. Default: foto vigente (`ultimo_lote = vigente`). "Só inéditos" é o
 *  predicado do card (`ehInedito`) e vence o toggle (inédito é, por definição, do lote vigente).
 *  "Incluir quem saiu do dump" solta o filtro. Sem lote completo (`null`) não há foto para
 *  filtrar: nada é recortado, como a RPC `radar_kpis`. */
export interface RecorteLote {
  ultimoLote: string | null;        // filtra `ultimo_lote = <isto>` quando não nulo
  primeiraVistaMin: string | null;  // filtra `primeira_vista_em >= <isto>` quando não nulo
}

export function recorteDeLote(
  lote: LoteIngest | null,
  f: { incluirSaiuDoDump: boolean; soIneditos: boolean },
): RecorteLote {
  if (!lote) return { ultimoLote: null, primeiraVistaMin: null };
  if (f.soIneditos) return { ultimoLote: lote.mes_referencia, primeiraVistaMin: lote.iniciado_em };
  if (!f.incluirSaiuDoDump) return { ultimoLote: lote.mes_referencia, primeiraVistaMin: null };
  return { ultimoLote: null, primeiraVistaMin: null };
}

const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** `'2026-05'` → `'mai/2026'`; fora do formato devolve cru (não inventa mês). */
function rotuloMesLote(mes: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(mes);
  const nome = m ? MESES_PT[Number(m[2]) - 1] : undefined;
  return m && nome ? `${nome}/${m[1]}` : mes;
}

export function rotuloSaiuDoDump(ultimoLote: string): string {
  return `última presença: ${rotuloMesLote(ultimoLote)} · ausente no lote atual`;
}
