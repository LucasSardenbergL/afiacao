// src/lib/reposicao/param-auto-helpers.ts
export interface SugestaoParam {
  ponto_pedido: number | null;
  estoque_minimo: number | null;
  estoque_maximo: number | null;
  estoque_seguranca: number | null;
  cobertura_alvo_dias: number | null;
}
export interface LimiaresFusivel { mult: number; coberturaDias: number; }
export type StatusAuto = 'bloqueado_validacao' | 'segurado' | 'pinado' | 'aplicado' | 'sem_mudanca';

const arred = (n: number) => Math.round(n);
const finitoNaoNeg = (n: number | null): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export function passaValidacao(s: SugestaoParam): { ok: boolean; motivo: string | null } {
  const campos = [s.ponto_pedido, s.estoque_minimo, s.estoque_maximo, s.estoque_seguranca, s.cobertura_alvo_dias];
  if (!campos.every(finitoNaoNeg)) return { ok: false, motivo: 'campo nulo/não-finito/negativo' };
  if (s.estoque_maximo! < s.ponto_pedido!) return { ok: false, motivo: 'max < pp' };
  if (s.ponto_pedido! < s.estoque_minimo!) return { ok: false, motivo: 'pp < min' };
  if (s.cobertura_alvo_dias! <= 0) return { ok: false, motivo: 'cobertura <= 0' };
  return { ok: true, motivo: null };
}

export function disparaFusivel(
  maxAntes: number | null, s: SugestaoParam, demandaMediaDiaria: number | null, lim: LimiaresFusivel,
): { segurado: boolean; motivo: string | null } {
  if (typeof s.estoque_maximo !== 'number' || !Number.isFinite(s.estoque_maximo)) return { segurado: false, motivo: null };
  if (typeof maxAntes === 'number' && maxAntes > 0 && s.estoque_maximo > lim.mult * maxAntes) {
    return { segurado: true, motivo: `máximo ${s.estoque_maximo} > ${lim.mult}× anterior ${maxAntes}` };
  }
  if (typeof demandaMediaDiaria === 'number' && demandaMediaDiaria > 0) {
    const coberturaDias = s.estoque_maximo / demandaMediaDiaria;
    if (coberturaDias > lim.coberturaDias) return { segurado: true, motivo: `cobertura ${Math.round(coberturaDias)}d > ${lim.coberturaDias}d` };
  }
  return { segurado: false, motivo: null };
}

export function fingerprintMaterial(pontoPedido: number, estoqueMaximo: number): string {
  return `${arred(pontoPedido)}|${arred(estoqueMaximo)}`;
}

export function pinBloqueia(rejeitadoPp: number, rejeitadoMax: number, s: SugestaoParam): boolean {
  if (typeof s.ponto_pedido !== 'number' || typeof s.estoque_maximo !== 'number') return false;
  return fingerprintMaterial(s.ponto_pedido, s.estoque_maximo) === fingerprintMaterial(rejeitadoPp, rejeitadoMax);
}

export function impactoSimulado(args: {
  ppAntes: number | null; maxAntes: number | null;
  ppDepois: number; maxDepois: number; posicao: number; custo: number | null;
}): { impactoRs: number | null; qtdeAntes: number; qtdeDepois: number } {
  const q = (pp: number | null, max: number | null) =>
    typeof pp === 'number' && typeof max === 'number' && args.posicao <= pp ? Math.max(0, max - args.posicao) : 0;
  const qtdeAntes = q(args.ppAntes, args.maxAntes);
  const qtdeDepois = q(args.ppDepois, args.maxDepois);
  const impactoRs = args.custo == null ? null : (qtdeDepois - qtdeAntes) * args.custo;
  return { impactoRs, qtdeAntes, qtdeDepois };
}

export function decideStatus(args: {
  antes: SugestaoParam; sugestao: SugestaoParam; demandaMediaDiaria: number | null;
  pin: { pp: number; max: number } | null; limiares: LimiaresFusivel;
}): StatusAuto {
  const { antes, sugestao, demandaMediaDiaria, pin, limiares } = args;
  if (!passaValidacao(sugestao).ok) return 'bloqueado_validacao';
  if (disparaFusivel(antes.estoque_maximo, sugestao, demandaMediaDiaria, limiares).segurado) return 'segurado';
  if (pin && pinBloqueia(pin.pp, pin.max, sugestao)) return 'pinado';
  const difere =
    arred(sugestao.ponto_pedido!) !== arred(antes.ponto_pedido ?? Number.NEGATIVE_INFINITY) ||
    arred(sugestao.estoque_maximo!) !== arred(antes.estoque_maximo ?? Number.NEGATIVE_INFINITY);
  return difere ? 'aplicado' : 'sem_mudanca';
}
