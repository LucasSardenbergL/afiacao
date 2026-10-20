// Lote VIGENTE do Radar — helpers PUROS (sem I/O; testáveis).
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
}

/** O maior `mes_referencia` com status `complete`. Running/error no meio são ignorados
 *  (um lote em voo ou falhado NÃO é a foto). Sem lote completo → `null` — e null é "não sei",
 *  nunca "zero": o card diz "sem dado" e a fila não filtra por lote. */
export function loteVigente(lotes: readonly LoteIngest[]): LoteIngest | null {
  let vigente: LoteIngest | null = null;
  for (const l of lotes) {
    if (l.status !== 'complete') continue;
    if (!vigente || l.mes_referencia > vigente.mes_referencia) vigente = l;
  }
  return vigente;
}

/** Inédito = entrou no universo NESTE lote: `primeira_vista_em` (só gravado no INSERT) >=
 *  `iniciado_em` do lote vigente E `ultimo_lote` = vigente. É o MESMO predicado do count do
 *  card "Inéditos do lote" (`useRadarIneditos`) — selo e número não podem divergir. */
export function ehInedito(
  e: { primeira_vista_em: string | null; ultimo_lote: string | null },
  lote: LoteIngest | null,
): boolean {
  if (!lote || !e.primeira_vista_em || e.ultimo_lote !== lote.mes_referencia) return false;
  return Date.parse(e.primeira_vista_em) >= Date.parse(lote.iniciado_em);
}

/** Saiu do dump = a última vez que a RFB listou a empresa foi em lote ANTERIOR ao vigente.
 *  Só diz o FATO (não veio no dump); o motivo (baixa, mudança de CNAE) é outra entrega. */
export function saiuDoDump(e: { ultimo_lote: string | null }, lote: LoteIngest | null): boolean {
  if (!lote || !e.ultimo_lote) return false;
  return e.ultimo_lote < lote.mes_referencia;
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

const MESES_PT =['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** `'2026-05'` → `'mai/2026'`; fora do formato devolve cru (não inventa mês). */
function rotuloMesLote(mes: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(mes);
  const nome = m ? MESES_PT[Number(m[2]) - 1] : undefined;
  return m && nome ? `${nome}/${m[1]}` : mes;
}

export function rotuloSaiuDoDump(ultimoLote: string): string {
  return `saiu do dump em ${rotuloMesLote(ultimoLote)}`;
}
