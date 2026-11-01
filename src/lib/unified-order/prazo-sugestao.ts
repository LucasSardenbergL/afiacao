/**
 * Sugestão de prazo no pedido para cliente com título VENCIDO em aberto
 * (Frente B do plano Oben PME/PMR, spec 2026-10-31-oben-frente-b §2.2).
 *
 * Decisão do founder (2026-10-31): o pedido AVISA e SUGERE condição menor; a
 * vendedora decide; nada trava (o gate `venda_gate_credito` de 60+ dias segue
 * igual). Este módulo é PURO e espelha os degraus da aba Ciclo
 * (`degrauAbaixo`), para a sugestão do pedido e a análise do financeiro
 * falarem a mesma régua.
 *
 * ⚠️ A condição de pagamento do Omie é `codigo_parcela` + DESCRIÇÃO LIVRE
 * ("30/60/90 DDL", "A Vista", "28/56/84 DDL", "30dd", "Boleto"). Não há campo
 * numérico. O parser é FAIL-CLOSED: o que não lê com certeza vira `null`, e
 * `null` nunca vira 0 dias — "Boleto" não é à vista (money-path §1/§2:
 * precisão > recall, ausente ≠ zero). Sem leitura, não há sugestão; o aviso
 * do vencido continua aparecendo.
 */

export type FormaLegivel = { codigo: string; descricao: string };

type MotivoSistema = 'condicao_ilegivel' | 'ja_a_vista' | 'sem_forma_menor' | 'prazo_ja_curto';

export type Sugestao =
  | { tipo: 'nenhuma'; motivoSistema: MotivoSistema | null }
  | {
      tipo: 'degrau';
      sugerida: FormaLegivel;
      prazoAtual: number;
      prazoSugerido: number;
      /** `degrau` = um degrau usual abaixo; `vencido_60d` = à vista direto (o gate já exige exceção). */
      motivo: 'degrau' | 'vencido_60d';
    };

/**
 * Degraus usuais de prazo — ESPELHO de `DEGRAUS_PRAZO` em `src/lib/financeiro/ciclo-cliente-helpers.ts`
 * (vendas não importa de financeiro: fronteira entre módulos). Paridade travada por teste que lê os dois
 * fontes (`prazo-sugestao.test.ts`). Ao mudar lá, mude aqui.
 */
export const DEGRAUS_PRAZO_PEDIDO: readonly number[] = [90, 75, 60, 56, 45, 42, 35, 30, 28, 21, 14, 7];

/** Próximo degrau usual ESTRITAMENTE abaixo do prazo (arredondado). Sem 7→0 (igual ao do Ciclo). */
function degrauAbaixo(prazo: number): number | null {
  const p = Math.round(prazo);
  for (const d of DEGRAUS_PRAZO_PEDIDO) if (d < p) return d;
  return null;
}

/** Acima disso o gate da fronteira exige exceção de gestor — degrau não cabe, só à vista. */
const DIAS_VENCIDO_A_VISTA = 60;
/** Teto de sanidade do calendário (acima disso a descrição não é prazo em dias). */
const PRAZO_MAX_DIAS = 365;

// Só as grafias conhecidas do Omie; QUALIFICADOR só o explicitamente permitido ("(faturamento)").
// "A Vista (30 dias)" contradiz "à vista" e cai em null (achado Codex P1 #7).
const RE_A_VISTA = /^\s*[aà]\s*vista(?:\s*\(\s*faturamento\s*\))?\s*$/i;
// "30 dias" · "30dd" · "30 DDL" · "30/60/90 DDL" · "28/56/84 dias"
const RE_CALENDARIO = /^\s*(\d{1,3}(?:\s*\/\s*\d{1,3})*)\s*(?:dias?|dd|ddl)\s*$/i;

/**
 * Lê a descrição da parcela como calendário de dias (crescente). `[0]` = à vista.
 * `null` = ilegível — NUNCA um default. Lista fora de ordem/repetida ou dia fora
 * de (0, 365] também é ilegível: reordenar em silêncio seria inventar condição.
 */
export function parseCalendarioParcela(descricao: string | null | undefined): number[] | null {
  if (typeof descricao !== 'string') return null;
  const d = descricao.trim();
  if (d === '') return null;
  if (RE_A_VISTA.test(d)) return [0];
  const m = RE_CALENDARIO.exec(d);
  if (!m) return null;
  const dias = m[1].split('/').map((x) => Number(x.trim()));
  if (dias.some((x) => !Number.isInteger(x) || x <= 0 || x > PRAZO_MAX_DIAS)) return null;
  for (let i = 1; i < dias.length; i++) if (dias[i] <= dias[i - 1]) return null;
  return dias;
}

/** A parcela mais LONGA é o que a empresa financia (média de 30/60/90 não é condição — financeiro.md). */
export function prazoDaParcela(calendario: number[]): number {
  return Math.max(...calendario);
}

type Lida = { forma: FormaLegivel; cal: number[]; prazo: number };

function lerFormas(formas: FormaLegivel[]): Lida[] {
  const out: Lida[] = [];
  for (const forma of formas) {
    const cal = parseCalendarioParcela(forma.descricao);
    if (cal) out.push({ forma, cal, prazo: prazoDaParcela(cal) });
  }
  return out;
}

/**
 * S DOMINA C quando, em todo dia t, a fração do valor já recebida sob S é ≥ a sob C
 * (parcelas iguais), com ganho em algum t. Comparar só o `max` erraria: 30/60/90
 * (média 60) → "75 dias" antecipa o último vencimento mas ATRASA a média para 75
 * (achado Codex P1 #6). À vista domina tudo; um calendário nunca domina a si mesmo.
 */
export function dominaCalendario(s: number[], c: number[]): boolean {
  const frac = (cal: number[], t: number) => cal.filter((d) => d <= t).length / cal.length;
  let estrito = false;
  for (const t of new Set([...s, ...c])) {
    const fs = frac(s, t);
    const fc = frac(c, t);
    if (fs < fc) return false;
    if (fs > fc) estrito = true;
  }
  return estrito;
}

const media = (cal: number[]) => cal.reduce((a, b) => a + b, 0) / cal.length;

/**
 * Entre as legíveis que DOMINAM o calendário atual e cabem no teto (`max ≤ teto`, sem à vista),
 * a MENOS agressiva (maior média; menos parcelas no empate; ordem da lista depois) — é "um degrau".
 */
function melhorAte(lidas: Lida[], atual: number[], teto: number): Lida | null {
  let melhor: Lida | null = null;
  for (const l of lidas) {
    if (l.prazo > teto || l.prazo === 0 || !dominaCalendario(l.cal, atual)) continue;
    if (!melhor || media(l.cal) > media(melhor.cal) || (media(l.cal) === media(melhor.cal) && l.cal.length < melhor.cal.length)) melhor = l;
  }
  return melhor;
}

export function sugerirParcela(input: {
  formas: FormaLegivel[];
  /** Código selecionado no pedido (ou habitual do cliente). */
  parcelaAtual: string;
  /** Descrição a usar quando o código atual não está na lista (ex.: condição histórica). */
  formaAtualDescricao?: string | null;
  /** Saldo vencido em aberto (R$). Ausente/inválido ⇒ sem sugestão. */
  vencido: number | null;
  /** Dias do título vencido mais antigo. > 60 ⇒ à vista direto. */
  diasVencidoMax: number | null;
}): Sugestao {
  const { formas, parcelaAtual, vencido, diasVencidoMax } = input;
  if (vencido === null || !Number.isFinite(vencido) || vencido <= 0) return { tipo: 'nenhuma', motivoSistema: null };

  const lidas = lerFormas(formas);
  const atualDesc = formas.find((f) => f.codigo === parcelaAtual)?.descricao ?? input.formaAtualDescricao ?? null;
  const calAtual = parseCalendarioParcela(atualDesc);
  if (!calAtual) return { tipo: 'nenhuma', motivoSistema: 'condicao_ilegivel' };
  const prazoAtual = prazoDaParcela(calAtual);
  if (prazoAtual === 0) return { tipo: 'nenhuma', motivoSistema: 'ja_a_vista' };

  // Só um código REAL da conta pode ser sugerido — nunca se inventa um "999".
  const aVista = lidas.find((l) => l.prazo === 0) ?? null;

  if (diasVencidoMax !== null && Number.isFinite(diasVencidoMax) && diasVencidoMax > DIAS_VENCIDO_A_VISTA) {
    if (!aVista) return { tipo: 'nenhuma', motivoSistema: 'sem_forma_menor' };
    return { tipo: 'degrau', sugerida: aVista.forma, prazoAtual, prazoSugerido: 0, motivo: 'vencido_60d' };
  }

  // `degrauAbaixo` declara "sem 7→0": prazo já no degrau mínimo não vira à vista por fallback.
  const alvo = degrauAbaixo(prazoAtual);
  if (alvo === null) return { tipo: 'nenhuma', motivoSistema: 'prazo_ja_curto' };
  const escolha = melhorAte(lidas, calAtual, alvo) ?? aVista;
  if (!escolha) return { tipo: 'nenhuma', motivoSistema: 'sem_forma_menor' };
  return { tipo: 'degrau', sugerida: escolha.forma, prazoAtual, prazoSugerido: escolha.prazo, motivo: 'degrau' };
}

export type Decisao = 'aceitou' | 'recusou' | 'recusou_sem_motivo' | 'ignorou' | 'sem_sugestao';

/**
 * O que vai para `venda_prazo_decisao.decisao`. `aceitou` = escolheu a sugerida OU uma condição que a
 * COBRE (antecipa igual ou mais — `escolhidaCobre`, calculado por dominância na tela). `recusou` exige
 * motivo; "Manter" sem motivo é `recusou_sem_motivo` (a ação explícita não vira omissão — achado Codex);
 * sem clicar e sem aceitar = `ignorou`. Nunca se inventa motivo.
 */
export function classificarDecisao(input: {
  sugerida: string | null;
  escolhida: string;
  interagiu: boolean;
  motivo: string | null;
  /** A escolhida (≠ sugerida) domina o calendário da sugerida. */
  escolhidaCobre?: boolean;
}): { decisao: Decisao; motivo: string | null } {
  if (input.sugerida === null) return { decisao: 'sem_sugestao', motivo: null };
  if (input.escolhida === input.sugerida || input.escolhidaCobre === true) return { decisao: 'aceitou', motivo: null };
  const motivo = input.motivo?.trim() || null;
  if (input.interagiu) return motivo ? { decisao: 'recusou', motivo } : { decisao: 'recusou_sem_motivo', motivo: null };
  return { decisao: 'ignorou', motivo: null };
}

/** Faixa do vencido para o ledger — sem R$ nem nome de cliente nas props. */
export function faixaVencido(diasVencidoMax: number | null): '<=15d' | '16-45d' | '46-90d' | '>90d' | null {
  if (diasVencidoMax === null || !Number.isFinite(diasVencidoMax) || diasVencidoMax <= 0) return null;
  if (diasVencidoMax <= 15) return '<=15d';
  if (diasVencidoMax <= 45) return '16-45d';
  if (diasVencidoMax <= 90) return '46-90d';
  return '>90d';
}
