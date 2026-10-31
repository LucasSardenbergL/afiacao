// Borda banco → domínio do Raio-X. O gerador do Supabase declara TODA coluna de `Returns` de RPC
// como não-nula e todo texto como `string`; o domínio (`tipos.ts`) é mais honesto (nullables, unions).
// Antes a conversão era `as unknown as Pagina<FatoSku>` — que também aceitaria coluna renomeada ou
// tabela errada. Aqui cada campo que ESTREITA (destino, origem, empresa, categoria, clientes jsonb)
// passa por guarda e lança fora do vocabulário; o resto é atribuição estrutural, checada pelo TS.
import type { Database, Json, Tables } from '@/integrations/supabase/types';
import { DESTINOS } from './classificar';
import { CANAIS } from './execucao';
import type {
  CanalLiquidacao,
  Categoria,
  ClassificacaoManual,
  ClienteComprador,
  CoorteTop,
  DecisaoRow,
  Destino,
  Empresa,
  FatoSku,
  LinhaMedicao,
} from './tipos';

type Fns = Database['public']['Functions'];
export type FatoRpc = Fns['raio_x_estoque_fatos']['Returns'][number];
export type MedicaoRpc = Fns['raio_x_medicao']['Returns'][number];
export type LinhaManual = ClassificacaoManual & { sku_codigo_omie: number };

const CATEGORIAS: readonly Categoria[] = ['nao_mercadoria', 'uso_consumo', 'mercadoria'];
const ORIGENS = ['app', 'artifact_fase_a'] as const;

function ehDestino(s: string): s is Destino {
  return (DESTINOS as readonly string[]).includes(s);
}
function exigirDestino(s: string, sku: number): Destino {
  if (!ehDestino(s)) throw new Error(`raio-x: destino "${s}" desconhecido (SKU ${sku})`);
  return s;
}
function exigirCanal(s: string, sku: number): CanalLiquidacao {
  const c = CANAIS.find((x) => x === s);
  if (!c) throw new Error(`raio-x: canal "${s}" desconhecido (SKU ${sku})`);
  return c;
}
function exigirEmpresa(s: string, sku: number): Empresa {
  if (s !== 'oben' && s !== 'colacor') throw new Error(`raio-x: empresa "${s}" fora de oben/colacor (SKU ${sku})`);
  return s;
}

/** `clientes` é jsonb: lista de {nome, ult, qtd}. Elemento fora da forma lança — não vira cliente fantasma. */
export function clientesDe(j: Json, sku: number): ClienteComprador[] | null {
  if (j === null) return null;
  if (!Array.isArray(j)) throw new Error(`raio-x: clientes do SKU ${sku} não é lista`);
  return j.map((c, i) => {
    if (c === null || typeof c !== 'object' || Array.isArray(c) || typeof c.nome !== 'string' || typeof c.qtd !== 'number') {
      throw new Error(`raio-x: clientes[${i}] do SKU ${sku} sem nome/qtd`);
    }
    return { nome: c.nome, qtd: c.qtd, ult: typeof c.ult === 'string' ? c.ult : null };
  });
}

export function comoFatoSku(r: FatoRpc): FatoSku {
  return { ...r, clientes: clientesDe(r.clientes, r.sku_codigo_omie) };
}

export function comoDecisaoRow(r: Tables<'raio_x_decisao'>): DecisaoRow {
  const origem = ORIGENS.find((o) => o === r.origem);
  if (!origem) throw new Error(`raio-x: origem "${r.origem}" desconhecida (SKU ${r.sku_codigo_omie})`);
  return {
    ...r,
    empresa: exigirEmpresa(r.empresa, r.sku_codigo_omie),
    destino: r.destino === null ? null : exigirDestino(r.destino, r.sku_codigo_omie),
    origem,
    // Colunas do pacote 2: `?? null` porque o bundle pode ir ao ar ANTES da migration (Publish ≠ db:aplicar) —
    // coluna inexistente chega undefined e não pode derrubar a aba nem virar "canal desconhecido".
    preco_piso: r.preco_piso ?? null,
    canal_liquidacao: r.canal_liquidacao == null ? null : exigirCanal(r.canal_liquidacao, r.sku_codigo_omie),
    responsavel: r.responsavel ?? null,
    prazo: r.prazo ?? null,
    concluido_em: r.concluido_em ?? null,
    concluido_por: r.concluido_por ?? null,
  };
}

export function comoLinhaManual(r: Pick<Tables<'raio_x_classificacao_manual'>, 'sku_codigo_omie' | 'categoria' | 'motivo'>): LinhaManual {
  const categoria = CATEGORIAS.find((c) => c === r.categoria);
  if (!categoria) throw new Error(`raio-x: categoria manual "${r.categoria}" desconhecida (SKU ${r.sku_codigo_omie})`);
  return { sku_codigo_omie: r.sku_codigo_omie, categoria, motivo: r.motivo };
}

export function comoLinhaMedicao(r: MedicaoRpc): LinhaMedicao {
  return { ...r, destino: exigirDestino(r.destino, r.sku_codigo_omie) };
}

/** Linhas de `raio_x_coorte_top` de UMA empresa → coorte. Vazio = ainda não congelada (null, nunca coorte vazia). */
export function comoCoorte(
  rows: Pick<Tables<'raio_x_coorte_top'>, 'sku_codigo_omie' | 'posicao' | 'valor' | 'congelada_em'>[],
): CoorteTop | null {
  if (rows.length === 0) return null;
  const congeladaEm = rows[0].congelada_em;
  if (rows.some((r) => r.congelada_em !== congeladaEm)) throw new Error('raio-x: coorte com mais de um congelamento');
  return {
    congelada_em: congeladaEm,
    itens: new Map(rows.map((r) => [r.sku_codigo_omie, { posicao: r.posicao, valor: r.valor }])),
  };
}
