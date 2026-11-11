// Modo PACOTE do replay (spec docs/superpowers/specs/2026-11-09-f0-suaves-atendimento-a-design.md §4): F0′ nos 12 SUAVES da
// coorte × X ∈ {F1, F2, F3} nos intermitentes, calibrados juntos e avaliados com a régua de capital para mudança que COMPRA
// serviço (D1/D1b: 3′ economia + 3″ teto). `bun scripts/reposicao-replay/pacote.ts [--dados DIR] [--saida ARQ] [--paralelo N]
// [--estabilidade]`.
//
// O MODO OFICIAL (rodar.ts) NÃO muda: este arquivo só reusa as etapas dele. Ordem e fail-closed:
//   1. âncora Omie, classe e gate de paridade do F0 (as MESMAS etapas do rodar.ts);
//   2. o teto do 3″ é LIDO de $REPLAY_DADOS/teto-capital-pacote.json — gravado ANTES da rodada (§7.2), nunca um padrão
//      no código: sem o arquivo a rodada para (ErroDadosReplay);
//   3. calibração de todas as tuplas (P, X) (calibrarPacote), seleção determinística (escolherTupla, três estados);
//   4. a tupla CONGELADA é avaliada como a candidata do oficial (avaliarCandidata com `pacote`), baseline = F0 de hoje;
//   5. diagnósticos (informativos, §4.4 item 7 e D5): A suaves × A intermitentes, fronteira capital × fill A da
//      calibração com o benefício líquido de cada ponto, capital por SKU, sem a 1ª semana, sem o maior SKU, estabilidade.
// Relatório e JSON em $REPLAY_DADOS (com R$): NUNCA no repositório.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  avaliarNaCalibracao,
  baseDaCalibracao,
  calibrar,
  calibrarPacote,
  chavePerfilSuaves,
  escolherTupla,
  estadoDaTupla,
  FORMULAS_PACOTE,
  mapaDosSuaves,
  mapaMisto,
  mapaPacote,
  mediaSomas,
  REPS_CALIBRACAO,
  serializarTupla,
  somarSomas,
  suavesDaCoorte,
  vereditoDaCalibracaoPacote,
  type EscolhaPacote,
  type PerfilSuaves,
  type TuplaPacote,
} from './calibracao';
import { classeEfetiva } from './classe';
import { GRADE_CUSTO, JANELAS } from './config';
import { addDias } from '../../src/lib/reposicao/orcamento-compra/datas';
import { carregarDados } from './dados';
import { hashCodigo, preComputarComOrigem, type Formula, type ParamsDia } from './formulas';
import { custoLiquido } from './metricas';
import { decomporDLU, type DecomposicaoDLU, type DLUIndisponivel } from './pacote-dlu';
import { coorte, coorteTodosAtivos } from './parados';
import { avaliarCandidata, etapasPreCalibracao, type Congelado } from './rodar';
import { simular, type SomasSemanais } from './simulador';
import { ErroDadosReplay, type Classe, type Dados, type Data, type VereditoReplay } from './tipos';

/** O arquivo do teto do 3″ em $REPLAY_DADOS (spec §7.2): `{ "teto": 0.20 }`, gravado antes da rodada. */
export const ARQ_TETO = 'teto-capital-pacote.json';
/** O SKU que concentra as falhas dos suaves de A (spec §2.1, §5): a sensibilidade "sem ele" é só informativa (D5). */
export const SKU_SENSIBILIDADE = '8689717792';
/** Cortes temporais da estabilidade (§4.2): fev–mar e mar–abr. */
export const CORTES_ESTABILIDADE: readonly [Data, Data][] = [
  ['2026-02-01', '2026-03-31'],
  ['2026-03-01', '2026-04-30'],
];

/** Lê o teto (fração; 0,20 = 20%) e o sha256 do arquivo. Ausente ou inválido ⇒ ErroDadosReplay (nunca um padrão do código). */
export function lerTetoPacote(dir: string): { teto: number; sha256: string; arquivo: string } {
  const arquivo = join(dir, ARQ_TETO);
  if (!existsSync(arquivo)) throw new ErroDadosReplay(`TETO_PACOTE_AUSENTE: grave ${arquivo} com {"teto": <fração>} ANTES da rodada (spec §7.2)`);
  const txt = readFileSync(arquivo, 'utf8');
  let j: unknown;
  try {
    j = JSON.parse(txt);
  } catch {
    throw new ErroDadosReplay(`TETO_PACOTE_INVALIDO: ${arquivo} não é JSON`);
  }
  const teto = j !== null && typeof j === 'object' ? (j as { teto?: unknown }).teto : undefined;
  if (typeof teto !== 'number' || !(teto > 0 && teto <= 1)) throw new ErroDadosReplay(`TETO_PACOTE_INVALIDO: "teto" deve ser fração em (0, 1] (veio ${JSON.stringify(teto)})`);
  return { teto, sha256: createHash('sha256').update(txt).digest('hex'), arquivo };
}

// ── diagnósticos (informativos) ────────────────────────────────────────────────────────────────────────────────

/** Níveis de serviço da célula A varridos na fronteira (§4.3: de 95% a 99%). */
export const NIVEIS_FRONTEIRA: readonly number[] = [0.95, 0.96, 0.97, 0.98, 0.99];

/**
 * Um ponto da fronteira capital × fill A: a família (P, X) recalibrada com o alvo de A no `nivel` (B e C no alvo oficial),
 * na calibração (50 reps, espera). Informativo: a seleção oficial já está congelada antes da varredura.
 */
export interface PontoFronteira {
  nivel: number;
  familia: string;
  /** A tupla que a busca devolveu nesse nível (no inviável: a do trio final da busca, só informativa). */
  tupla: string;
  estado: ReturnType<typeof estadoDaTupla>;
  fill: Record<Classe, number | null>;
  /** Ī_tupla / Ī_F0 − 1 na calibração; null = capital não valorado. */
  aumento: number | null;
  /** Benefício líquido (custo líquido, R$; + = pacote vantajoso) na grade de 25% a.a.: o pior e o melhor ponto. */
  beneficio: { min: number | null; max: number | null };
}

const somaV = (v: readonly number[]) => v.reduce((t, x) => t + x, 0);

/** Fill A dos suaves e dos intermitentes ORIGINAIS (A_alt) e da célula A, a partir das somas. */
export function fillASuavesIntermitentes(s: SomasSemanais): { celula: number | null; intermitentes: number | null; suaves: number | null; linhasSuaves: number; linhasIntermitentes: number } {
  const dA = somaV(s.porCelula.A.demandadas);
  const iA = somaV(s.porCelula.A.integrais);
  const dI = somaV(s.porCelula.A_alt.demandadas);
  const iI = somaV(s.porCelula.A_alt.integrais);
  return {
    celula: dA > 0 ? iA / dA : null,
    intermitentes: dI > 0 ? iI / dI : null,
    suaves: dA - dI > 0 ? (iA - iI) / (dA - dI) : null,
    linhasSuaves: Math.round(dA - dI),
    linhasIntermitentes: Math.round(dI),
  };
}

/**
 * Fill da célula A com e sem a 1ª semana das somas (D5, informativo). Nas somas da CALIBRAÇÃO a 1ª semana é 01–07/02, a
 * herdada do aquecimento (spec §5; achado P2 do Codex: não é a 1ª semana da avaliação). A semana vem rotulada pelas datas.
 */
export function fillAComESemPrimeiraSemana(s: SomasSemanais): { semana: [Data, Data]; com: number | null; sem: number | null } {
  if (s.semanas.length === 0) throw new Error('SOMAS_SEM_SEMANAS');
  const dCom = somaV(s.porCelula.A.demandadas);
  const dSem = somaV(s.porCelula.A.demandadas.slice(1));
  return {
    semana: [s.semanas[0], addDias(s.semanas[0], 6)],
    com: dCom > 0 ? somaV(s.porCelula.A.integrais) / dCom : null,
    sem: dSem > 0 ? somaV(s.porCelula.A.integrais.slice(1)) / dSem : null,
  };
}

/** A sensibilidade "sem a 1ª semana" da CALIBRAÇÃO (01–07/02): F0 e, havendo tupla congelada, o pacote. */
export function primeiraSemanaDaCalibracao(
  dados: Dados,
  tupla: TuplaPacote | null,
  cacheDir?: string | null,
  reps = REPS_CALIBRACAO,
): { f0: ReturnType<typeof fillAComESemPrimeiraSemana>; pacote: ReturnType<typeof fillAComESemPrimeiraSemana> | null } {
  const base = baseDaCalibracao(dados, { reps, ...(cacheDir === undefined ? {} : { cacheDir }) });
  if (base.somasF0.semanas[0] !== JANELAS.calibracaoIni) throw new Error(`PRIMEIRA_SEMANA_FORA_DA_CALIBRACAO:${base.somasF0.semanas[0]}`);
  return { f0: fillAComESemPrimeiraSemana(base.somasF0), pacote: tupla === null ? null : fillAComESemPrimeiraSemana(somasDaTupla(dados, tupla.perfil, tupla.resultado.formula, tupla.resultado.params, cacheDir, reps)) };
}

/** As somas da calibração de uma tupla (P, X, params) — o mesmo mapa que a calibração avaliou. */
function somasDaTupla(dados: Dados, perfil: PerfilSuaves, formula: Formula, params: TuplaPacote['resultado']['params'], cacheDir: string | null | undefined, reps: number): SomasSemanais {
  const base = baseDaCalibracao(dados, { reps, ...(cacheDir === undefined ? {} : { cacheDir }) });
  const c = coorte(dados);
  const o = cacheDir === undefined ? {} : { cacheDir };
  const fn = preComputarComOrigem(formula, dados, params, { calibracao: true }, o).mapa;
  const mapa = mapaPacote(base.f0Mapa, mapaDosSuaves(dados, perfil, { calibracao: true }, cacheDir), suavesDaCoorte(c), fn, c.populacao, c.alterados);
  return avaliarNaCalibracao(dados, formula, mapa, reps).somas;
}

/**
 * Capital por SKU (Σ estoque × preço × dias ÷ dias, média das reps) dos dois braços e a decomposição do AUMENTO: suaves,
 * intermitentes, outros e o maior SKU (frações do aumento total). Aumento ≤ 0 ⇒ frações null (não há aumento a repartir).
 */
export function decomporCapital(
  porSkuF0: Record<string, number>,
  porSkuAlt: Record<string, number>,
  suaves: ReadonlySet<string>,
  alterados: ReadonlySet<string>,
): { aumento: number; suaves: number | null; intermitentes: number | null; outros: number | null; maior: { sku: string; parte: number } | null; porSku: { sku: string; delta: number }[] } {
  const skus = [...new Set([...Object.keys(porSkuF0), ...Object.keys(porSkuAlt)])].sort();
  const porSku = skus.map((sku) => ({ sku, delta: (porSkuAlt[sku] ?? 0) - (porSkuF0[sku] ?? 0) })).sort((a, b) => b.delta - a.delta || (a.sku < b.sku ? -1 : 1));
  const aumento = porSku.reduce((t, x) => t + x.delta, 0);
  const parte = (f: (s: string) => boolean) => (aumento > 0 ? porSku.filter((x) => f(x.sku)).reduce((t, x) => t + x.delta, 0) / aumento : null);
  return {
    aumento,
    suaves: parte((s) => suaves.has(s)),
    intermitentes: parte((s) => alterados.has(s)),
    outros: parte((s) => !suaves.has(s) && !alterados.has(s)),
    maior: aumento > 0 && porSku.length > 0 ? { sku: porSku[0].sku, parte: porSku[0].delta / aumento } : null,
    porSku,
  };
}

export interface DiagnosticoPacote {
  /** Avaliação, coorte, reconstruído, LT empírico, espera, REPS_CALIBRACAO reps. */
  fillA: { f0: ReturnType<typeof fillASuavesIntermitentes>; pacote: ReturnType<typeof fillASuavesIntermitentes> };
  /** Fill da célula A sem as linhas do SKU de sensibilidade; null = contagem de linhas A não bate com a célula (nunca fabricado). */
  semSku: { sku: string; f0: number | null; pacote: number | null; linhasA: number } | null;
  /** null = há estoque sem preço em algum braço: o capital por SKU seria o subtotal valorado (ausente ≠ zero, achado 10). */
  capital: ReturnType<typeof decomporCapital> | null;
}

/** Linhas medidas de A (classe efetiva do dia da linha, como o simulador) na janela, por id. */
function linhasDeA(dados: Dados, populacao: ReadonlySet<string>, janela: [Data, Data]): Map<string, string> {
  const memo = new Map<Data, Map<string, Classe>>();
  const out = new Map<string, string>();
  for (const v of dados.vendas) {
    if (!v.noEscopo || !(v.quantidade > 0) || v.data < janela[0] || v.data > janela[1] || !populacao.has(v.sku)) continue;
    let m = memo.get(v.data);
    if (!m) memo.set(v.data, (m = classeEfetiva(dados, v.data)));
    if ((m.get(v.sku) ?? 'C') === 'A') out.set(v.linhaId, v.sku);
  }
  return out;
}

export function diagnosticarPacote(dados: Dados, cg: Congelado, reps = REPS_CALIBRACAO, cacheDir?: string | null): DiagnosticoPacote {
  if (!cg.suaves) throw new Error('DIAGNOSTICO_SEM_PACOTE');
  const c = coorte(dados);
  const sv = suavesDaCoorte(c);
  const o = cacheDir === undefined ? {} : { cacheDir };
  const f0 = preComputarComOrigem('F0', dados, { quantil: { A: 0.95, B: 0.95, C: 0.95 } }, { calibracao: false }, o).mapa;
  const fn = preComputarComOrigem(cg.candidata, dados, cg.params, { calibracao: false }, o).mapa;
  const mF0 = mapaMisto(f0, null, c.populacao, c.alterados);
  const mAlt = mapaPacote(f0, mapaDosSuaves(dados, cg.suaves, { calibracao: false }, cacheDir), sv, fn, c.populacao, c.alterados);
  const janela: [Data, Data] = [JANELAS.avaliacaoIni, JANELAS.avaliacaoFim];
  const linhasA = linhasDeA(dados, c.populacao, janela);
  const alvo = [...linhasA.values()].filter((s) => s === SKU_SENSIBILIDADE).length;
  const braco = (formula: Congelado['candidata'] | 'F0', params: Map<string, ParamsDia>) => {
    let acc: SomasSemanais | null = null;
    const cap: Record<string, number> = {};
    let falhasSku = 0;
    for (let rep = 0; rep < reps; rep++) {
      const s = simular({ formula, params, rep, lt: 'empirico', falta: 'espera', inicial: 'reconstruido', janela, dados, alterados: c.alterados, rastro: true, capitalPorSku: true });
      for (const f of s.desfechos ?? []) if (linhasA.get(f.linhaId) === SKU_SENSIBILIDADE) falhasSku++;
      for (const [k, v] of Object.entries(s.capitalPorSku ?? {})) cap[k] = (cap[k] ?? 0) + v;
      s.pedidos = undefined;
      s.desfechos = undefined;
      s.capitalPorSku = undefined;
      acc = somarSomas(acc, s);
    }
    const m = mediaSomas(acc!, reps);
    const dias = somaV(m.diasCorridos);
    for (const k of Object.keys(cap)) cap[k] /= reps * dias;
    // sem o SKU: só se a contagem de linhas A do diagnóstico bate com a célula (senão a conta não é a do simulador)
    const dA = somaV(m.porCelula.A.demandadas);
    const bate = Math.abs(dA - linhasA.size) < 1e-6;
    const semSku = bate && dA - alvo > 0 ? (somaV(m.porCelula.A.integrais) - (alvo - falhasSku / reps)) / (dA - alvo) : null;
    return { m, cap, semSku, bate, naoValorado: somaV(m.estoqueNaoValoradoDias) > 0 };
  };
  const b0 = braco('F0', mF0);
  const b1 = braco(cg.candidata, mAlt);
  return {
    fillA: { f0: fillASuavesIntermitentes(b0.m), pacote: fillASuavesIntermitentes(b1.m) },
    semSku: b0.bate && b1.bate ? { sku: SKU_SENSIBILIDADE, f0: b0.semSku, pacote: b1.semSku, linhasA: alvo } : null,
    capital: b0.naoValorado || b1.naoValorado ? null : decomporCapital(b0.cap, b1.cap, sv, c.alterados),
  };
}

/** As famílias (P, X) da fronteira: (P0, X) para cada X e, havendo tupla congelada, (P*, X) para cada X (sem repetir). */
export function familiasDaFronteira(escolha: EscolhaPacote): { perfil: PerfilSuaves; formula: Formula }[] {
  const perfis: PerfilSuaves[] = [{ tipo: 'F0', perfil: { nome: 'P0' } }];
  if (escolha.tipo === 'TUPLA' && chavePerfilSuaves(escolha.tupla.perfil) !== 'P0') perfis.push(escolha.tupla.perfil);
  return perfis.flatMap((perfil) => FORMULAS_PACOTE.map((formula) => ({ perfil, formula })));
}

/**
 * Fronteira (§4.3, informativa): cada família (P, X) recalibrada com o alvo de A em cada nível de NIVEIS_FRONTEIRA (B e C no
 * alvo oficial), com fill, aumento de estoque e o benefício líquido na grade de 25% a.a. A seleção oficial NÃO muda.
 */
export function fronteiraDoPacote(
  dados: Dados,
  familias: readonly { perfil: PerfilSuaves; formula: Formula }[],
  opcoes: { cacheDir?: string | null; reps?: number; niveis?: readonly number[]; log?: (m: string) => void } = {},
): PontoFronteira[] {
  const reps = opcoes.reps ?? REPS_CALIBRACAO;
  const oc = opcoes.cacheDir === undefined ? {} : { cacheDir: opcoes.cacheDir };
  const base = baseDaCalibracao(dados, { reps, ...oc });
  const sv = suavesDaCoorte(coorte(dados));
  const out: PontoFronteira[] = [];
  for (const fam of familias) {
    const mapaSv = mapaDosSuaves(dados, fam.perfil, { calibracao: true }, opcoes.cacheDir);
    for (const nivel of opcoes.niveis ?? NIVEIS_FRONTEIRA) {
      const r = calibrar(dados, fam.formula, { reps, ...oc, alvoA: nivel, suaves: { mapa: mapaSv, skus: sv } });
      const t: TuplaPacote = { perfil: fam.perfil, resultado: r };
      const estado = estadoDaTupla(r);
      const somas = somasDaTupla(dados, fam.perfil, fam.formula, r.params, opcoes.cacheDir, reps);
      const bs: number[] = [];
      let nulo = false;
      for (const emergencialPerc of GRADE_CUSTO.emergencial) {
        for (const atrasoPerc of GRADE_CUSTO.atrasoPorDia) {
          const x = custoLiquido(base.somasF0, somas, { taxa: GRADE_CUSTO.taxaBase, emergencialPerc, atrasoPerc }).custo;
          if (x === null) nulo = true;
          else bs.push(x);
        }
      }
      const p: PontoFronteira = {
        nivel,
        familia: `${chavePerfilSuaves(fam.perfil)}|${fam.formula}`,
        tupla: serializarTupla(t),
        estado,
        fill: r.fill,
        aumento: r.estoqueMedio === null || base.estoqueF0 === null || !(base.estoqueF0 > 0) ? null : r.estoqueMedio / base.estoqueF0 - 1,
        beneficio: nulo || bs.length === 0 ? { min: null, max: null } : { min: Math.min(...bs), max: Math.max(...bs) },
      };
      out.push(p);
      opcoes.log?.(`fronteira ${p.familia} @ A ${nivel}: ${estado} fill A ${r.fill.A} aumento ${p.aumento}`);
    }
  }
  return out;
}

/** Estabilidade (§4.2, informativa): a seleção refeita nos cortes temporais e em leave-one-SKU-out nos suaves. */
export function estabilidadeDoPacote(dados: Dados, log: (m: string) => void): { recorte: string; escolha: string }[] {
  const rotulo = (e: EscolhaPacote) => (e.tipo === 'TUPLA' ? serializarTupla(e.tupla) : e.tipo);
  const out: { recorte: string; escolha: string }[] = [];
  for (const janela of CORTES_ESTABILIDADE) {
    const e = escolherTupla(calibrarPacote(dados, { janela }));
    out.push({ recorte: `corte ${janela.join('..')}`, escolha: rotulo(e) });
    log(`estabilidade corte ${janela.join('..')}: ${rotulo(e)}`);
  }
  for (const sku of [...suavesDaCoorte(coorte(dados))].sort()) {
    const e = escolherTupla(calibrarPacote(dados, { semSku: sku }));
    out.push({ recorte: `sem ${sku} (fora da população medida)`, escolha: rotulo(e) });
    log(`estabilidade sem ${sku}: ${rotulo(e)}`);
  }
  return out;
}

// ── relatório ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface RodadaPacote {
  geradoEm: string;
  chave: { hashDados: string; hashCodigo: string; dataExtracao: Data; protocolo: string; perfis: string[] };
  teto: { teto: number; sha256: string };
  modoAncora: string;
  tuplas: { tupla: string; estado: string; estoqueMedio: number | null; estoqueF0: number | null; fill: Record<Classe, number | null> }[];
  escolha: string;
  veredito: { veredito: VereditoReplay; motivos: string[] };
  congelado: Congelado | null;
  criterios: { criterio: string; estado: string; motivo: string }[];
  reps: number | null;
  diagnostico: DiagnosticoPacote | null;
  fronteira: PontoFronteira[];
  /** D5: fill A da CALIBRAÇÃO com e sem a 1ª semana (01–07/02). */
  primeiraSemana: ReturnType<typeof primeiraSemanaDaCalibracao>;
  /** §2.2 / §4.4(7): decomposição D/L/U da falha dos suaves de A (calibração, diagnóstico). */
  dlu: DecomposicaoDLU | DLUIndisponivel;
  estabilidade: { recorte: string; escolha: string }[] | null;
  segundos: number;
}

const pct = (x: number | null | undefined, casas = 2) => (x === null || x === undefined ? 'n/d' : `${(x * 100).toFixed(casas).replace('.', ',')}%`);

export function montarRelatorioPacote(r: RodadaPacote): string {
  const l: string[] = [];
  l.push(`# Replay — modo PACOTE (F0′ nos suaves × X nos intermitentes)`, '');
  l.push(`> Spec: docs/superpowers/specs/2026-11-09-f0-suaves-atendimento-a-design.md (§4). NÃO é a rodada oficial do TSB.`);
  l.push(`> Protocolo: \`${r.chave.protocolo}\` · hashDados \`${r.chave.hashDados.slice(0, 12)}\` · hashCódigo \`${r.chave.hashCodigo.slice(0, 12)}\` · extração ${r.chave.dataExtracao} · âncora ${r.modoAncora}`);
  l.push(`> Teto do 3″: **${pct(r.teto.teto, 0)}** (sha256 do arquivo \`${r.teto.sha256.slice(0, 12)}\`, gravado antes da rodada)`, '');
  l.push(`## Veredito: **${r.veredito.veredito}**`, '');
  for (const m of r.veredito.motivos.slice(0, 60)) l.push(`- ${m}`);
  l.push('', `Tupla congelada: \`${r.escolha}\`${r.reps === null ? '' : ` · ${r.reps} replicações`}`, '');
  l.push('## Calibração: todas as tuplas (P, X)', '', '| tupla | estado | fill A | fill B | fill C | estoque ÷ F0 − 1 |', '|---|---|---:|---:|---:|---:|');
  for (const t of r.tuplas) {
    const au = t.estoqueMedio === null || t.estoqueF0 === null || !(t.estoqueF0 > 0) ? null : t.estoqueMedio / t.estoqueF0 - 1;
    l.push(`| \`${t.tupla}\` | ${t.estado} | ${pct(t.fill.A)} | ${pct(t.fill.B)} | ${pct(t.fill.C)} | ${pct(au)} |`);
  }
  l.push('', '## Critérios (régua do pacote: 3′ economia + 3″ teto, também no estresse)', '', '| critério | estado | motivo |', '|---|---|---|');
  for (const c of r.criterios) l.push(`| ${c.criterio} | ${c.estado} | ${c.motivo.replace(/\|/g, '/')} |`);
  if (r.fronteira.length > 0) {
    l.push('', '## Fronteira capital × fill A (calibração, informativa; a seleção oficial não muda)', '');
    l.push('Cada família (P, X) recalibrada com o alvo de A no nível (B e C no alvo oficial).', '');
    l.push('| família | alvo A | estado | fill A | aumento de estoque | benefício líquido 25% a.a. (pior … melhor célula, R$) |', '|---|---:|---|---:|---:|---:|');
    for (const p of r.fronteira) {
      l.push(`| \`${p.familia}\` | ${pct(p.nivel, 0)} | ${p.estado} | ${pct(p.fill.A)} | ${pct(p.aumento)} | ${p.beneficio.min === null ? 'n/d' : `${p.beneficio.min.toFixed(0)} … ${p.beneficio.max!.toFixed(0)}`} |`);
    }
  }
  {
    const ps = r.primeiraSemana;
    const sem = `${ps.f0.semana[0]}..${ps.f0.semana[1]}`;
    l.push('', `## Sensibilidade sem a 1ª semana da calibração (${sem}, D5, informativa)`, '');
    l.push(`- F0: A ${pct(ps.f0.com)} com a semana → ${pct(ps.f0.sem)} sem ela`);
    l.push(ps.pacote ? `- Pacote congelado: A ${pct(ps.pacote.com)} com a semana → ${pct(ps.pacote.sem)} sem ela` : '- Pacote: sem tupla congelada');
  }
  if ('indisponivel' in r.dlu) {
    l.push('', '## Decomposição D/L/U da falha dos suaves de A (§2.2)', '', `n/d — ${r.dlu.indisponivel}`);
  } else {
    const k = r.dlu;
    l.push('', `## Decomposição D/L/U da falha dos suaves de A (§2.2, calibração, ${k.reps} reps, ${k.linhasSuavesA} linhas)`, '');
    l.push(`Controle da gravação simplificada: oficial ${pct(k.controle.oficial)} × recálculo D0L0U0 ${pct(k.controle.recalculo)} (|Δ| ${pct(Math.abs(k.controle.oficial - k.controle.recalculo))}).`, '');
    l.push('| D | L | U | fill suaves A | Δ estoque da coorte |', '|:-:|:-:|:-:|---:|---:|');
    for (const x of k.combinacoes) l.push(`| ${x.D} | ${x.L} | ${x.U} | ${pct(x.fillSuavesA)} | ${pct(x.deltaEstoque)} |`);
    l.push('', `Shapley (p.p.): D ${pct(k.shapley.D)} · L ${pct(k.shapley.L)} · U ${pct(k.shapley.U)} · resíduo até 100% ${pct(k.residual)}`);
  }
  const d = r.diagnostico;
  if (d) {
    l.push('', '## Diagnósticos (informativos; nunca critério)', '');
    l.push(`- Célula A: F0 ${pct(d.fillA.f0.celula)} → pacote ${pct(d.fillA.pacote.celula)}`);
    l.push(`- A suaves (${d.fillA.f0.linhasSuaves} linhas): F0 ${pct(d.fillA.f0.suaves)} → pacote ${pct(d.fillA.pacote.suaves)}`);
    l.push(`- A intermitentes (${d.fillA.f0.linhasIntermitentes} linhas): F0 ${pct(d.fillA.f0.intermitentes)} → pacote ${pct(d.fillA.pacote.intermitentes)}`);
    l.push(d.semSku ? `- A sem o ${d.semSku.sku} (${d.semSku.linhasA} linhas, D5): F0 ${pct(d.semSku.f0)} → pacote ${pct(d.semSku.pacote)}` : '- A sem o SKU de sensibilidade: não medido (contagem de linhas A divergente)');
    const k = d.capital;
    if (k === null) l.push('- Capital por SKU: não medido (estoque sem preço em algum braço; o subtotal valorado não é o capital)');
    else {
      l.push(`- Aumento de capital (estoque médio, R$): ${k.aumento.toFixed(0)}; suaves ${pct(k.suaves)}, intermitentes ${pct(k.intermitentes)}, outros ${pct(k.outros)}; maior SKU ${k.maior ? `${k.maior.sku} ${pct(k.maior.parte)}` : 'n/d'}`);
      l.push('', '| SKU | Δ estoque médio (R$) |', '|---|---:|');
      for (const x of k.porSku.filter((y) => Math.abs(y.delta) > 0.005)) l.push(`| ${x.sku} | ${x.delta.toFixed(2)} |`);
    }
  }
  if (r.estabilidade) {
    l.push('', '## Estabilidade da seleção (informativa)', '', '| recorte | tupla escolhida |', '|---|---|');
    for (const e of r.estabilidade) l.push(`| ${e.recorte} | \`${e.escolha}\` |`);
  }
  l.push('', '## Limitações declaradas', '', '- O termo de revisão (H = LT) não entra nos perfis F0′; só a Alt3 (F1, H = LT + 1) o trata.', '- N1/N3/N5 seguem declarados (spec mãe). Demanda censurada: o fill mede linhas observadas.', '- Alt1/Alt2 gravam a demanda por du em `demanda_media_diaria`, que o teto B/C lê (como a produção leria).', '');
  l.push(`Gerado em ${r.geradoEm} · ${r.segundos.toFixed(0)} s`);
  return `${l.join('\n')}\n`;
}

const RAIZ_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function escreverRelatorioPacote(r: RodadaPacote, arquivo: string): void {
  const rel = relative(RAIZ_REPO, resolve(arquivo));
  if (!rel.startsWith('..') && !rel.startsWith('/')) throw new Error(`RELATORIO_DENTRO_DO_REPO:${arquivo}`);
  mkdirSync(dirname(arquivo), { recursive: true });
  writeFileSync(arquivo, montarRelatorioPacote(r));
  writeFileSync(join(dirname(arquivo), 'rodada-pacote.json'), JSON.stringify(r));
}

// ── principal ────────────────────────────────────────────────────────────────────────────────────────────────

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

function args(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const prox = argv[i + 1];
    if (prox !== undefined && !prox.startsWith('--')) {
      out[a.slice(2)] = prox;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

async function principal(): Promise<number> {
  const a = args(process.argv.slice(2));
  const dir = typeof a.dados === 'string' ? a.dados : (process.env.REPLAY_DADOS ?? join(homedir(), '.cache/afiacao/reposicao-replay'));
  const saida = typeof a.saida === 'string' ? a.saida : join(dir, 'pacote', 'relatorio-pacote.md');
  const paralelo = a.paralelo === undefined ? 4 : Number(a.paralelo);
  if (!(Number.isInteger(paralelo) && paralelo >= 1 && paralelo <= 64)) throw new Error(`--paralelo deve ser inteiro entre 1 e 64 (veio ${String(a.paralelo)})`);
  const t0 = performance.now();
  const teto = lerTetoPacote(dir); // antes de qualquer cálculo: sem teto gravado, nada roda
  log(`teto do 3″: ${teto.teto} (${teto.arquivo}, sha256 ${teto.sha256.slice(0, 12)})`);
  const dados = carregarDados(dir);
  const c = coorte(dados);
  log(`dados: coorte ${c.populacao.size} (alterados ${c.alterados.size}, suaves ${suavesDaCoorte(c).size}), todos os ativos ${coorteTodosAtivos(dados).populacao.size}`);
  const { modoAncora } = etapasPreCalibracao(dados, { informativoSaldoHoje: a['informativo-saldo-hoje'] === true, log });
  const tuplas = calibrarPacote(dados, { log });
  const escolha = escolherTupla(tuplas);
  const vc = vereditoDaCalibracaoPacote(escolha);
  log(`escolha: ${escolha.tipo === 'TUPLA' ? serializarTupla(escolha.tupla) : escolha.tipo}`);
  const fronteira = fronteiraDoPacote(dados, familiasDaFronteira(escolha), { log });
  const primeiraSemana = primeiraSemanaDaCalibracao(dados, escolha.tipo === 'TUPLA' ? escolha.tupla : null);
  log('decomposição D/L/U (9 braços na calibração)');
  const dlu = decomporDLU(dados);
  const comum = {
    geradoEm: new Date().toISOString(),
    chave: { hashDados: dados.hashDados, hashCodigo: hashCodigo(), dataExtracao: dados.dataExtracao, protocolo: 'pacote-2026-11-09-v1', perfis: [...new Set(tuplas.map((t) => chavePerfilSuaves(t.perfil)))] },
    teto: { teto: teto.teto, sha256: teto.sha256 },
    modoAncora,
    tuplas: tuplas.map((t) => ({ tupla: serializarTupla(t), estado: estadoDaTupla(t.resultado), estoqueMedio: t.resultado.estoqueMedio, estoqueF0: t.resultado.estoqueF0, fill: t.resultado.fill })),
    escolha: escolha.tipo === 'TUPLA' ? serializarTupla(escolha.tupla) : escolha.tipo,
    fronteira,
    primeiraSemana,
    dlu,
    estabilidade: a.estabilidade === true ? estabilidadeDoPacote(dados, log) : null,
  };
  if (escolha.tipo !== 'TUPLA' || vc?.veredito === 'NO-GO') {
    const v = vc ?? { veredito: 'NO-GO' as const, motivos: ['INVIAVEL_NA_CALIBRACAO'] };
    escreverRelatorioPacote({ ...comum, veredito: v, congelado: null, criterios: [], reps: null, diagnostico: null, segundos: (performance.now() - t0) / 1000 }, saida);
    log(`VEREDITO PACOTE ${v.veredito} (${v.motivos.join('; ')}) → ${saida}`);
    return 0;
  }
  const t = escolha.tupla;
  const cg: Congelado = Object.freeze({ candidata: t.resultado.formula, params: structuredClone(t.resultado.params), suaves: structuredClone(t.perfil) });
  const av = await avaliarCandidata(dados, dir, cg, vc, { paralelo, pacote: { teto: teto.teto } });
  const diagnostico = diagnosticarPacote(dados, cg);
  escreverRelatorioPacote({ ...comum, veredito: av.veredito, congelado: cg, criterios: av.avaliacao.criterios, reps: av.avaliacao.reps, diagnostico, segundos: (performance.now() - t0) / 1000 }, saida);
  log(`VEREDITO PACOTE ${av.veredito.veredito} (${av.avaliacao.reps} reps) → ${saida}`);
  return 0;
}

if (import.meta.main) {
  principal().then(
    (rc) => process.exit(rc),
    (e: unknown) => {
      console.error(e instanceof ErroDadosReplay ? `ERRO DE DADOS: ${e.message}` : e);
      process.exit(1);
    },
  );
}
