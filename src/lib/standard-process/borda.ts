// Borda de `standard_processes`: `etapas` é `jsonb` (tipado `Json`) e `status` é texto com CHECK.
// O jeito antigo era `data as unknown as StandardProcess`, que afirmava a forma das etapas e o
// vocabulário sem conferir. Aqui cada etapa é lida campo a campo e o status é conferido contra o
// CHECK da prod (psql-ro, 2026-10-21): desvio LANÇA com a chave, nunca vira default.
import type { Json, Tables } from '@/integrations/supabase/types';
import { listaJson, numeroJson, objetoJson, textoJson, type ObjetoJson } from '@/lib/json-forma';
import type { StandardProcess, StandardProcessEtapa, StandardProcessStatus } from './types';

// Derivado do tipo do próprio módulo (importar de customer-process cruzaria a fronteira para admin-crm).
type TipoEtapa = StandardProcessEtapa['tipo'];

const F = 'standard_processes.etapas';
const STATUS = ['draft', 'in_review', 'published', 'archived'] as const satisfies readonly StandardProcessStatus[];
const PARAMETROS = ['tempo_minutos', 'temperatura_c', 'umidade_pct', 'espessura_um', 'pressao_bar', 'distancia_cm'] as const;

// Lista local, pelo mesmo motivo. O tipo abaixo
// garante, em tempo de compilação, que ela cobre TODO o `TipoEtapa`: valor novo lá → erro aqui.
const TIPOS = ['preparacao', 'aplicacao', 'secagem', 'lixamento', 'mistura', 'inspecao', 'embalagem', 'outro'] as const satisfies readonly TipoEtapa[];
type TiposFaltando = Exclude<TipoEtapa, (typeof TIPOS)[number]>;
const tiposCompletos: [TiposFaltando] extends [never] ? true : TiposFaltando = true;
void tiposCompletos;
const ehTipo = (v: Json | undefined): v is TipoEtapa => TIPOS.some((t) => t === v);
const ehStatus = (v: string): v is StandardProcessStatus => STATUS.some((s) => s === v);

function textos(o: ObjetoJson, chave: string, fonte: string): string[] {
  return listaJson(o[chave], `${fonte}.${chave}`).map((x) => {
    if (typeof x !== 'string') throw new Error(`${fonte}: "${chave}" tem item que não é texto`);
    return x;
  });
}

function etapa(v: Json, i: number): StandardProcessEtapa {
  const f = `${F}[${i}]`;
  const o = objetoJson(v, f);
  if (!ehTipo(o.tipo)) throw new Error(`${f}: "tipo" fora do vocabulário (${String(o.tipo)})`);
  const p = o.parametros === undefined || o.parametros === null ? {} : objetoJson(o.parametros, `${f}.parametros`);
  const parametros: StandardProcessEtapa['parametros'] = {};
  for (const k of PARAMETROS) {
    const x = p[k];
    if (x === undefined || x === null) continue;
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`${f}.parametros: "${k}" não é número`);
    parametros[k] = x;
  }
  const rationale = o.rationale;
  if (rationale !== undefined && typeof rationale !== 'string') throw new Error(`${f}: "rationale" não é texto`);
  return {
    ordem: numeroJson(o, 'ordem', f),
    nome: textoJson(o, 'nome', f),
    tipo: o.tipo,
    produtos: textos(o, 'produtos', f),
    parametros,
    equipamentos: textos(o, 'equipamentos', f),
    observacoes: textoJson(o, 'observacoes', f),
    produtos_kb: textos(o, 'produtos_kb', f),
    ...(rationale === undefined ? {} : { rationale }),
  };
}

/** Uma linha de `standard_processes` como `StandardProcess`; lança se etapas/status divergirem. */
export function paraStandardProcess(l: Tables<'standard_processes'>): StandardProcess {
  if (!ehStatus(l.status)) throw new Error(`standard_processes: "status" = "${l.status}" fora do vocabulário`);
  return { ...l, status: l.status, etapas: listaJson(l.etapas, F).map(etapa) };
}
