// src/lib/reposicao/param-auto-helpers.ts
export interface SugestaoParam {
  ponto_pedido: number | null;
  estoque_minimo: number | null;
  estoque_maximo: number | null;
  estoque_seguranca: number | null;
  cobertura_alvo_dias: number | null;
}
export interface LimiaresFusivel { mult: number; }
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

// Fusível recalibrado (pós-prod: 33/33 falso-segurado). SÓ o multiplicador, material + upward-only:
// segura quando o MÁXIMO sugerido (arredondado) salta > mult× o máximo anterior (arredondado, >0).
// QUEDA do máximo NUNCA é segurada (assimétrico). Cobertura-absoluto removido — penalizava giro lento
// (em demanda baixa o máximo é dominado pelo estoque de segurança → max/demanda é estruturalmente alto,
// não corrupção). Sem base anterior → não há salto a medir (o guard de base NULL no decideStatus bloqueia).
export function disparaFusivel(
  maxAntes: number | null, s: SugestaoParam, lim: LimiaresFusivel,
): { segurado: boolean; motivo: string | null } {
  if (typeof s.estoque_maximo !== 'number' || !Number.isFinite(s.estoque_maximo)) return { segurado: false, motivo: null };
  if (typeof maxAntes === 'number' && maxAntes > 0 && arred(s.estoque_maximo) > lim.mult * arred(maxAntes)) {
    return { segurado: true, motivo: `máximo ${arred(s.estoque_maximo)} > ${lim.mult}× anterior ${arred(maxAntes)}` };
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

// Precedência (7 passos, calibração pós-prod) — a SQL espelha 1:1 (money-path):
//   1. qualquer campo sugerido NULL → sem_mudanca (COALESCE preserva o anterior; status != OK)
//   2. sugestão incoerente (NaN/neg/max<pp/pp<min/cob<=0) → bloqueado_validacao
//   3. SEM base válida (max_antes NULL ou <=0) → bloqueado_validacao (cold-start é manual: não
//      auto-aplica primeiro parâmetro sem baseline pra sanity-check)
//   4. pin bate (pp+máx arredondados == rejeitado) → pinado
//   5. SEM mudança material (pp+máx arredondados == anterior) → sem_mudanca  ← ANTES do fusível
//      (mata o falso 'segurado' em no-op)
//   6. fusível (máx_antes>0 e round(máx_sug) > mult×round(máx_antes)) → segurado
//   7. else → aplicado
export function decideStatus(args: {
  antes: SugestaoParam; sugestao: SugestaoParam;
  pin: { pp: number; max: number } | null; limiares: LimiaresFusivel;
}): StatusAuto {
  const { antes, sugestao, pin, limiares } = args;
  // (1) status != OK (qualquer campo NULL) → COALESCE preserva o anterior = 'sem_mudanca'.
  const semSugestao = [sugestao.ponto_pedido, sugestao.estoque_minimo, sugestao.estoque_maximo, sugestao.estoque_seguranca, sugestao.cobertura_alvo_dias].some((v) => v == null);
  if (semSugestao) return 'sem_mudanca';
  // (2) validação dura (incoerência).
  if (!passaValidacao(sugestao).ok) return 'bloqueado_validacao';
  // (3) sem base válida → não auto-aplica o primeiro parâmetro (sem baseline pra checar).
  if (!(typeof antes.estoque_maximo === 'number' && Number.isFinite(antes.estoque_maximo) && antes.estoque_maximo > 0)) return 'bloqueado_validacao';
  // (4) trava de reversão.
  if (pin && pinBloqueia(pin.pp, pin.max, sugestao)) return 'pinado';
  // (5) sem mudança material (pp+máx arredondados iguais ao anterior) → ANTES do fusível.
  const semMudanca =
    arred(sugestao.ponto_pedido!) === arred(antes.ponto_pedido ?? Number.NEGATIVE_INFINITY) &&
    arred(sugestao.estoque_maximo!) === arred(antes.estoque_maximo!);
  if (semMudanca) return 'sem_mudanca';
  // (6) fusível.
  if (disparaFusivel(antes.estoque_maximo, sugestao, limiares).segurado) return 'segurado';
  // (7) aplica.
  return 'aplicado';
}
