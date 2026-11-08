// Lógica pura da decisão do Raio-X (fase B, PR 3). O Sheet e o hook de mutação só orquestram; as regras que
// espelham o SQL de `raio_x_decidir` (alvo do motor, "já no alvo", estado completo) ficam aqui, testadas.
import { DESTINOS } from './classificar';
import type { Categoria, DecisaoRow, Destino, Empresa, FatoSku, ItemRaioX, Sugestao } from './tipos';

/** Seletor de empresa da Reposição → chave do Raio-X. Colacor SC e demais: sem cadastro de produto. */
export function empresaDoRaioX(e: string): Empresa | null {
  if (e === 'OBEN') return 'oben';
  if (e === 'COLACOR') return 'colacor';
  return null;
}

/**
 * Número digitado em pt-BR (porte de `lerNumero`/`parseValorBR` do logica.mjs da fase A).
 * Vazio → `{valor:null, erro:false}` (limpa); inválido → `{valor:null, erro:true}` (não envia).
 * Ponto só como milhar ("1.234,5"); "12.5" é inválido de propósito (ambíguo). Negativo é inválido.
 */
export function lerNumero(texto: string | null | undefined): { valor: number | null; erro: boolean } {
  if (texto === null || texto === undefined || texto.trim() === '') return { valor: null, erro: false };
  const limpo = texto.replace(/R\$|\s/g, '');
  if (!/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/.test(limpo)) return { valor: null, erro: true };
  const v = Number(limpo.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(v) ? { valor: v, erro: false } : { valor: null, erro: true };
}

export const MSG_NUMERO_INVALIDO = 'número inválido — use vírgula para decimais (ex.: 12,5)';

export type AlvoMotor = 'descontinuado' | 'sob_encomenda';

/** Mesmo CASE do SQL: só trocar/liquidar/manter_suspender_recompra tiram do motor. */
export function alvoDoMotor(destino: Destino | null | undefined): AlvoMotor | null {
  if (destino === 'trocar' || destino === 'liquidar') return 'descontinuado';
  if (destino === 'manter_suspender_recompra') return 'sob_encomenda';
  return null;
}

/**
 * O que mostrar sobre o motor para um destino (Ruling S3). `null` = destino sem alvo (nada a mostrar).
 * - colacor: sem motor de reposição;
 * - sem_parametro: Oben sem sku_parametros (o SQL daria RX001);
 * - ja_fora: habilitado=false e tipo já é o alvo (o SQL não escreveria);
 * - pode_tirar: checkbox.
 */
export type EstadoMotor = 'colacor' | 'sem_parametro' | 'ja_fora' | 'pode_tirar';
export function estadoMotor(
  empresa: Empresa,
  item: Pick<FatoSku, 'no_motor' | 'tipo_reposicao' | 'habilitado_reposicao_automatica'>,
  destino: Destino | null | undefined,
): EstadoMotor | null {
  const alvo = alvoDoMotor(destino);
  if (!alvo) return null;
  if (empresa === 'colacor') return 'colacor';
  if (!item.no_motor) return 'sem_parametro';
  if (item.habilitado_reposicao_automatica === false && item.tipo_reposicao === alvo) return 'ja_fora';
  return 'pode_tirar';
}

/** Decisão migrada da fase A (Artifact), com destino que tiraria do motor, mas o motor nunca foi tocado. */
export function seloFaseA(d: DecisaoRow | undefined): boolean {
  return !!d && d.origem === 'artifact_fase_a' && !d.tirou_do_motor && alvoDoMotor(d.destino) !== null;
}

export interface DecidirArgs {
  sku: number;
  destino: Destino | null;
  categoria: Categoria;
  observacao: string | null;
  fornecedor: string | null;
  creditoTroca: number | null;
  tirarDoMotor: boolean;
  restaurarMotor: boolean;
}

/**
 * Args de `raio_x_decidir` reaproveitando o estado GRAVADO (Ruling S2): a RPC apaga campo omitido, então
 * "restaurar" e "tirar do motor agora" reenviam observação, fornecedor e crédito (crédito só com trocar).
 * Categoria = a efetiva do item (a RPC exige categoria quando há destino).
 */
export function argsEstadoSalvo(
  item: ItemRaioX,
  d: DecisaoRow | undefined,
  op: { tirarDoMotor?: boolean; restaurarMotor?: boolean } = {},
): DecidirArgs {
  const destino = d?.destino ?? null;
  return {
    sku: item.sku_codigo_omie,
    destino,
    categoria: item.categoria,
    observacao: d?.observacao ?? null,
    fornecedor: d?.fornecedor_informado ?? null,
    creditoTroca: destino === 'trocar' ? (d?.credito_troca ?? null) : null,
    tirarDoMotor: op.tirarDoMotor ?? false,
    restaurarMotor: op.restaurarMotor ?? false,
  };
}

/**
 * Assinatura do estado do SERVIDOR que o Sheet edita (Ruling S9): a decisão gravada (atualizado_em) e o motor
 * (tipo_reposicao + habilitado). Mudou com o painel aberto → rascunho velho, gravar fica bloqueado.
 */
export function assinaturaServidor(
  item: Pick<FatoSku, 'tipo_reposicao' | 'habilitado_reposicao_automatica'>,
  d: DecisaoRow | undefined,
): string {
  return JSON.stringify([d?.atualizado_em ?? null, item.tipo_reposicao, item.habilitado_reposicao_automatica]);
}

/** Destino mostrado na coluna e usado no filtro (Ruling S4): o decidido vence a sugestão. */
export function destinoEfetivo(i: ItemRaioX, d: DecisaoRow | undefined): Sugestao | null {
  return d?.destino ?? i.destino_sugerido;
}

/** Fornecedor mostrado na coluna e usado no filtro (Ruling S4): o informado vence o do cadastro. */
export function fornecedorEfetivo(i: FatoSku, d: DecisaoRow | undefined): string | null {
  return d?.fornecedor_informado || i.fornecedor || null;
}

const ehDestino = (s: Sugestao | null): s is Destino => s !== null && (DESTINOS as readonly string[]).includes(s);

/** Pré-seleção do Sheet: só mercadoria parada tem sugestão (P10), e só se a sugestão for um destino real. */
export function sugestaoInicial(i: ItemRaioX): Destino | null {
  if (i.categoria !== 'mercadoria' || !i.parado) return null;
  return ehDestino(i.destino_sugerido) ? i.destino_sugerido : null;
}

/**
 * Args do "Confirmar: <sugestão>" (UX 2 — 1 toque no card). O toque explícito no botão É a decisão humana; a regra
 * "pré-seleção sozinha não é decisão" continua valendo para a pré-seleção passiva do painel. `null` = não há o que
 * confirmar: já decidido, linha histórica (fora do estoque) ou sem sugestão que seja destino (revisar/aguarde/sem
 * histórico — inclusive o liquidar que o servidor ainda recusa, já rebaixado a "revisar"). Um item por toque: nada em lote.
 * Observação/fornecedor de uma linha sem destino (ex.: só contagem) são preservados — a RPC apaga campo omitido.
 */
/**
 * Destino que o "Confirmar: <sugestão>" gravaria em 1 toque, ou `null` (já decidido, linha histórica, sem sugestão, ou
 * liquidar sem o veredito inequívoco). Independe da empresa — é a mesma regra do `argsConfirmarSugestao`.
 */
export function sugestaoConfirmavel(item: ItemRaioX, d: DecisaoRow | undefined): Destino | null {
  if (d?.destino || item.fora_do_estoque) return null;
  const s = sugestaoInicial(item);
  if (!s) return null;
  // 2ª camada do bug 5: liquidar só com o veredito "inequívoco" do servidor (o RX004 recusaria) — nunca por omissão
  if (s === 'liquidar' && item.inequivoco !== true) return null;
  return s;
}

export function argsConfirmarSugestao(empresa: Empresa, item: ItemRaioX, d: DecisaoRow | undefined): DecidirArgs | null {
  const s = sugestaoConfirmavel(item, d);
  if (!s) return null;
  return {
    ...argsEstadoSalvo(item, d),
    destino: s,
    creditoTroca: null,
    // mesmo padrão do painel para decisão nova (S8): tira do motor quando há o que tirar — e o botão DIZ isso
    tirarDoMotor: estadoMotor(empresa, item, s) === 'pode_tirar',
    restaurarMotor: false,
  };
}
