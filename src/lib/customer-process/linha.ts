// Borda entre a linha de `customer_processes` (types.ts gerado: `etapas` é `Json`, `porte` é
// `string`, `tags`/`ia_gaps` são `string[] | null`) e o `CustomerProcess` que a tela consome.
// Antes era `data as unknown as CustomerProcess` — cast que fingia a forma do jsonb e o vocabulário
// de `porte`. Aqui a forma é LIDA: etapa fora da forma ou porte fora do vocabulário LANÇA (linha
// inválida não entra, nunca vira etapa "outro"/porte "medio" inventados — ausente ≠ zero).
import type { Json, Tables } from '@/integrations/supabase/types';
import {
  PORTES_PROCESSO,
  TIPOS_ETAPA,
  type CustomerProcess,
  type PorteProcesso,
  type ProcessEtapa,
  type TipoEtapa,
} from './types';

const PARAMETROS_NUMERICOS = [
  'tempo_minutos',
  'temperatura_c',
  'umidade_pct',
  'espessura_um',
  'pressao_bar',
  'distancia_cm',
] as const;

type Objeto = { [key: string]: Json | undefined };

function objeto(j: Json | undefined, campo: string): Objeto {
  if (j === null || j === undefined || typeof j !== 'object' || Array.isArray(j)) {
    throw new Error(`customer_processes.etapas: ${campo} não é objeto`);
  }
  return j;
}

function texto(o: Objeto, campo: string, caminho: string): string {
  const v = o[campo];
  if (typeof v !== 'string') throw new Error(`customer_processes.etapas: ${caminho}.${campo} não é texto`);
  return v;
}

function numero(o: Objeto, campo: string, caminho: string): number {
  const v = o[campo];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`customer_processes.etapas: ${caminho}.${campo} não é número`);
  }
  return v;
}

function listaDeTextos(o: Objeto, campo: string, caminho: string): string[] {
  const v = o[campo];
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === 'string')) {
    throw new Error(`customer_processes.etapas: ${caminho}.${campo} não é lista de textos`);
  }
  return v;
}

function ehTipoEtapa(v: unknown): v is TipoEtapa {
  return typeof v === 'string' && (TIPOS_ETAPA as readonly string[]).includes(v);
}

function etapaDeJson(j: Json | undefined, caminho: string): ProcessEtapa {
  const o = objeto(j, caminho);
  const tipo = o.tipo;
  if (!ehTipoEtapa(tipo)) {
    throw new Error(`customer_processes.etapas: ${caminho}.tipo fora do vocabulário (${String(tipo)})`);
  }
  const params = objeto(o.parametros ?? {}, `${caminho}.parametros`);
  const parametros: ProcessEtapa['parametros'] = {};
  for (const k of PARAMETROS_NUMERICOS) {
    const v = params[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`customer_processes.etapas: ${caminho}.parametros.${k} não é número`);
    }
    parametros[k] = v;
  }
  return {
    ordem: numero(o, 'ordem', caminho),
    nome: texto(o, 'nome', caminho),
    tipo,
    produtos: listaDeTextos(o, 'produtos', caminho),
    parametros,
    equipamentos: listaDeTextos(o, 'equipamentos', caminho),
    observacoes: texto(o, 'observacoes', caminho),
  };
}

/** `etapas` (jsonb) → `ProcessEtapa[]`; NULL continua NULL (processo sem estruturação). */
export function etapasDeJson(json: Json | null): ProcessEtapa[] | null {
  if (json === null) return null;
  if (!Array.isArray(json)) throw new Error('customer_processes.etapas: não é lista');
  return json.map((e, i) => etapaDeJson(e, `[${i}]`));
}

export function porteDeTexto(porte: string | null): PorteProcesso | null {
  if (porte === null) return null;
  if ((PORTES_PROCESSO as readonly string[]).includes(porte)) return porte as PorteProcesso;
  throw new Error(`customer_processes.porte fora do vocabulário (${porte})`);
}

/** Linha do banco → `CustomerProcess` (lança se jsonb/vocabulário não casam com o contrato). */
export function customerProcessDaLinha(linha: Tables<'customer_processes'>): CustomerProcess {
  return {
    ...linha,
    etapas: etapasDeJson(linha.etapas),
    porte: porteDeTexto(linha.porte),
    tags: linha.tags ?? [],
    ia_gaps: linha.ia_gaps ?? [],
  };
}
