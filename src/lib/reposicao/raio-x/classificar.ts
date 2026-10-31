// Categoria por tipo Omie + destino sugerido (porte de docs/superpowers/raio-x-estoque-parado/logica.mjs).
// Lógica pura, sem I/O. Ausente ≠ zero: q12/cmc nulos nunca viram 0.
import type {
  Categoria, ClassificacaoManual, CoorteTop, Empresa, FatoSku, ItemRaioX, Sugestao,
} from './tipos';

export const TOP_N = 61;
const DIAS_NOVO = 90;
export const DESTINOS = [
  'trocar', 'venda_dirigida', 'liquidar', 'manter_suspender_recompra', 'estrategico', 'erro_cadastro',
] as const;
export const ROTULOS: Record<string, string> = {
  trocar: 'Trocar', venda_dirigida: 'Venda dirigida', liquidar: 'Liquidar',
  manter_suspender_recompra: 'Manter · suspender recompra', estrategico: 'Estratégico',
  erro_cadastro: 'Erro de cadastro', novo_aguarde: 'Novo · aguarde', revisar: 'Revisar',
  sem_historico: 'Sem histórico de venda',
};

const TIPOS_INDUSTRIAIS = ['01', '03'];

/** Matéria-prima (01) / produto em processo (03): estoque industrial (CPC 16), não distorção do DIO. */
export function ehEstoqueIndustrial(i: Pick<ItemRaioX, 'categoria' | 'tipo_produto'>): boolean {
  return i.categoria === 'uso_consumo' && i.tipo_produto !== null && TIPOS_INDUSTRIAIS.includes(i.tipo_produto);
}

const RE_NAO_MERC = /MAQUINA|ESPECTRO|SOFTWARE|MOSTRUARIO|CARTELA|EXPOSITOR|DISPLAY/i;
const LIMITE_PARADO_DIAS = 180;

function diasEntre(data: string | null, hoje: string): number | null {
  if (!data) return null;
  return Math.floor((Date.parse(hoje) - Date.parse(data)) / 86400000);
}

export function cobertura(f: Pick<FatoSku, 'q12' | 'saldo'>): number | null {
  return f.q12 !== null && f.q12 > 0 ? f.saldo / (f.q12 / 365) : null;
}

export function categorizar(
  f: FatoSku,
  manual?: ClassificacaoManual,
): { categoria: Categoria; motivo: string } {
  if (manual) return { categoria: manual.categoria, motivo: manual.motivo };
  if (f.tipo_produto === null && f.familia === null && f.descricao === null) {
    return { categoria: 'mercadoria', motivo: 'sem cadastro no Omie' };
  }
  const d = f.descricao ?? '';
  // tipo do item no Omie (SPED): 07 uso e consumo, 01 matéria-prima, 03 em processo, 08 imobilizado.
  // 01/03 seguem no bloco uso_consumo (fora da reposição), mas são estoque industrial legítimo (CPC 16):
  // o placar os separa e NÃO os soma como "distorce o DIO" — ver `ehEstoqueIndustrial`.
  if (f.tipo_produto !== null && TIPOS_INDUSTRIAIS.includes(f.tipo_produto)) {
    const oque = f.tipo_produto === '01' ? 'matéria-prima' : 'produto em processo';
    return { categoria: 'uso_consumo', motivo: `tipo do item ${f.tipo_produto} no Omie (${oque} — estoque industrial)` };
  }
  if (f.tipo_produto === '07') {
    return { categoria: 'uso_consumo', motivo: 'tipo do item 07 no Omie (consumido aqui, não vendido)' };
  }
  if (f.tipo_produto === '08') return { categoria: 'nao_mercadoria', motivo: 'tipo do item 08 (imobilizado) no Omie' };
  if (f.familia === 'Imobilizado') return { categoria: 'nao_mercadoria', motivo: 'família Imobilizado' };
  const m = d.match(RE_NAO_MERC);
  if (m && f.q12 === 0) {
    return { categoria: 'nao_mercadoria', motivo: `descrição contém ${m[0].toUpperCase()} e sem venda em 12m` };
  }
  if (f.familia === 'Material de Uso e Consumo') return { categoria: 'uso_consumo', motivo: 'família Material de Uso e Consumo' };
  // Fase A: insumo_maquina e granel agora são uso_consumo (mantêm o motivo).
  if (f.familia === 'Concentrados MixMachine') return { categoria: 'uso_consumo', motivo: 'concentrado da MixMachine' };
  if (f.familia === 'Concentrados LC' && /^AT[LP]/i.test(d)) {
    return { categoria: 'uso_consumo', motivo: 'concentrado ATL/ATP da 2ª máquina' };
  }
  if (/1000 ?KG/i.test(d)) return { categoria: 'uso_consumo', motivo: 'granel 1.000 kg para fracionar' };
  return { categoria: 'mercadoria', motivo: '' };
}

export function sugerirDestino(f: FatoSku, hoje: string): { destino: Sugestao; motivo: string } {
  const cad = diasEntre(f.cadastro_em, hoje);
  // Só o CADASTRO novo dá "aguarde". Entrada recente em item parado não imuniza (seria proteger justamente a
  // recompra indevida): segue a regra normal e ganha `alerta_recompra` (ver `alertaRecompra`).
  if (cad !== null && cad < DIAS_NOVO) return { destino: 'novo_aguarde', motivo: `cadastrado há ${cad} dias` };
  if ((f.unidades_venda ?? []).some((u) => u !== f.unidade_estoque)) {
    return { destino: 'revisar', motivo: 'unidade da venda ≠ unidade do estoque — cobertura não confiável' };
  }
  // Sem venda por NF (Colacor) não há histórico: nunca inferir "sem comprador" → nunca liquidar.
  if (f.q12 === null) {
    return { destino: 'sem_historico', motivo: 'sem histórico de venda (NF) — decida manualmente' };
  }
  const cob = cobertura(f);
  if (f.q12 === 0 && /sayerlack/i.test(f.fornecedor ?? '')) {
    return { destino: 'trocar', motivo: 'Sayerlack · 0 vendas em 12m → troca por crédito' };
  }
  if (f.q12 > 0 && cob !== null && cob > 365) {
    return { destino: 'venda_dirigida', motivo: `cobertura ${Math.round(cob)} dias · ${f.ncli ?? 0} cliente(s) compraram` };
  }
  if (f.q12 > 0 && cob !== null && cob > LIMITE_PARADO_DIAS) {
    return { destino: 'manter_suspender_recompra', motivo: `cobertura ${Math.round(cob)} dias · vende, mas não recomprar` };
  }
  if (f.q12 === 0) {
    return { destino: 'liquidar', motivo: `0 vendas em 12m · sem comprador · fornecedor ${f.fornecedor ?? '?'} — informe se aceita troca` };
  }
  return { destino: 'revisar', motivo: `fora do motor com cobertura ${cob === null ? '?' : Math.round(cob)} dias` };
}

/** Item parado com entrada nos últimos 90 dias: recompra recente de item parado — alerta, não imunidade. */
export function alertaRecompra(f: FatoSku, hoje: string): string | null {
  const ent = diasEntre(f.ult_entrada, hoje);
  if (ent === null || ent >= DIAS_NOVO) return null;
  return `recompra recente de item parado · entrada há ${ent} dias`;
}

function estaParado(f: FatoSku, cob: number | null, categoria: Categoria, empresa: Empresa): boolean {
  if (categoria !== 'mercadoria') return false;
  if (empresa === 'colacor') return true; // sem venda por NF: toda mercadoria entra
  return !f.no_motor || f.q12 === 0 || (cob !== null && cob > LIMITE_PARADO_DIAS);
}

export function classificar(
  fatos: FatoSku[],
  manuais: Map<number, ClassificacaoManual>,
  empresa: Empresa,
  hoje: string,
): ItemRaioX[] {
  const itens: ItemRaioX[] = fatos.map((f) => {
    const c = categorizar(f, manuais.get(f.sku_codigo_omie));
    const cob = cobertura(f);
    const parado = estaParado(f, cob, c.categoria, empresa);
    const s = parado ? sugerirDestino(f, hoje) : null;
    return {
      ...f,
      valor: f.cmc === null || f.cmc <= 0 ? null : f.saldo * f.cmc,
      cobertura: cob,
      categoria: c.categoria,
      motivo_categoria: c.motivo,
      parado,
      destino_sugerido: s ? s.destino : null,
      motivo_destino: s ? s.motivo : '',
      alerta_recompra: parado ? alertaRecompra(f, hoje) : null,
      top: false,
      top_atual: false,
      entrou_no_top: false,
    };
  });
  itens.sort((a, b) => {
    if (a.valor === null && b.valor === null) return a.sku_codigo_omie - b.sku_codigo_omie;
    if (a.valor === null) return 1;
    if (b.valor === null) return -1;
    return b.valor - a.valor || a.sku_codigo_omie - b.sku_codigo_omie;
  });
  // `top_atual` = o Top 61 de HOJE (recalculado a cada leitura). Sem coorte congelada, `top` o segue;
  // com coorte, `aplicarCoorte` troca `top` pela coorte da meta.
  itens.filter((i) => i.parado && i.valor !== null).slice(0, TOP_N).forEach((i) => { i.top = true; i.top_atual = true; });
  return itens;
}

/**
 * Meta "100% do Top 61": o denominador é a coorte CONGELADA (gravada uma vez por empresa), não o Top de hoje —
 * senão item que vende sai e outro entra, e a meta vira alvo móvel. Quem entraria no Top hoje e não está na
 * coorte ganha `entrou_no_top` (aparece, mas não mexe no denominador). Coorte null = ainda não congelada.
 */
export function aplicarCoorte(itens: ItemRaioX[], coorte: CoorteTop | null): ItemRaioX[] {
  if (!coorte) return itens;
  return itens.map((i) => {
    const naCoorte = coorte.itens.has(i.sku_codigo_omie);
    return { ...i, top: naCoorte, entrou_no_top: i.top_atual && !naCoorte };
  });
}
