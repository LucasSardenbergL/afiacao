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
  calibrarPacote,
  chavePerfilSuaves,
  escolherTupla,
  estadoDaTupla,
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
  type TuplaPacote,
} from './calibracao';
import { classeEfetiva } from './classe';
import { GRADE_CUSTO, JANELAS } from './config';
import { carregarDados } from './dados';
import { hashCodigo, preComputarComOrigem, type ParamsDia } from './formulas';
import { custoLiquido } from './metricas';
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

/** Uma tupla da calibração como ponto da fronteira capital × fill A (calibração, 50 reps, espera). */
export interface PontoFronteira {
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

/** Fill da célula A sem a 1ª semana da janela (D5, informativo). */
export function fillASemPrimeiraSemana(s: SomasSemanais): number | null {
  const d = somaV(s.porCelula.A.demandadas.slice(1));
  return d > 0 ? somaV(s.porCelula.A.integrais.slice(1)) / d : null;
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
  semPrimeiraSemana: { f0: number | null; pacote: number | null };
  /** Fill da célula A sem as linhas do SKU de sensibilidade; null = contagem de linhas A não bate com a célula (nunca fabricado). */
  semSku: { sku: string; f0: number | null; pacote: number | null; linhasA: number } | null;
  capital: ReturnType<typeof decomporCapital>;
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
    return { m, cap, semSku, bate };
  };
  const b0 = braco('F0', mF0);
  const b1 = braco(cg.candidata, mAlt);
  return {
    fillA: { f0: fillASuavesIntermitentes(b0.m), pacote: fillASuavesIntermitentes(b1.m) },
    semPrimeiraSemana: { f0: fillASemPrimeiraSemana(b0.m), pacote: fillASemPrimeiraSemana(b1.m) },
    semSku: b0.bate && b1.bate ? { sku: SKU_SENSIBILIDADE, f0: b0.semSku, pacote: b1.semSku, linhasA: alvo } : null,
    capital: decomporCapital(b0.cap, b1.cap, sv, c.alterados),
  };
}

/** Fronteira (§4.3): cada tupla da calibração com fill, aumento de estoque e o benefício líquido na grade de 25% a.a. */
export function fronteiraDoPacote(dados: Dados, tuplas: readonly TuplaPacote[], cacheDir?: string | null): PontoFronteira[] {
  const base = baseDaCalibracao(dados);
  const c = coorte(dados);
  const sv = suavesDaCoorte(c);
  const o = cacheDir === undefined ? {} : { cacheDir };
  return tuplas.map((t) => {
    const r = t.resultado;
    const fn = preComputarComOrigem(r.formula, dados, r.params, { calibracao: true }, o).mapa;
    const mapa = mapaPacote(base.f0Mapa, mapaDosSuaves(dados, t.perfil, { calibracao: true }, cacheDir), sv, fn, c.populacao, c.alterados);
    const av = avaliarNaCalibracao(dados, r.formula, mapa, REPS_CALIBRACAO);
    const bs: number[] = [];
    let nulo = false;
    for (const emergencialPerc of GRADE_CUSTO.emergencial) {
      for (const atrasoPerc of GRADE_CUSTO.atrasoPorDia) {
        const x = custoLiquido(base.somasF0, av.somas, { taxa: GRADE_CUSTO.taxaBase, emergencialPerc, atrasoPerc }).custo;
        if (x === null) nulo = true;
        else bs.push(x);
      }
    }
    return {
      tupla: serializarTupla(t),
      estado: estadoDaTupla(r),
      fill: av.fill,
      aumento: av.estoque === null || base.estoqueF0 === null || !(base.estoqueF0 > 0) ? null : av.estoque / base.estoqueF0 - 1,
      beneficio: nulo ? { min: null, max: null } : { min: Math.min(...bs), max: Math.max(...bs) },
    };
  });
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
    const e = escolherTupla(calibrarPacote(dados, { semSuave: sku }));
    out.push({ recorte: `sem ${sku}`, escolha: rotulo(e) });
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
    l.push('', '## Fronteira capital × fill A (calibração, diagnóstico)', '', '| tupla | fill A | aumento de estoque | benefício líquido 25% a.a. (pior … melhor célula, R$) |', '|---|---:|---:|---:|');
    for (const p of [...r.fronteira].sort((a, b) => (a.fill.A ?? -1) - (b.fill.A ?? -1))) {
      l.push(`| \`${p.tupla}\` | ${pct(p.fill.A)} | ${pct(p.aumento)} | ${p.beneficio.min === null ? 'n/d' : `${p.beneficio.min.toFixed(0)} … ${p.beneficio.max!.toFixed(0)}`} |`);
    }
  }
  const d = r.diagnostico;
  if (d) {
    l.push('', '## Diagnósticos (informativos; nunca critério)', '');
    l.push(`- Célula A: F0 ${pct(d.fillA.f0.celula)} → pacote ${pct(d.fillA.pacote.celula)}`);
    l.push(`- A suaves (${d.fillA.f0.linhasSuaves} linhas): F0 ${pct(d.fillA.f0.suaves)} → pacote ${pct(d.fillA.pacote.suaves)}`);
    l.push(`- A intermitentes (${d.fillA.f0.linhasIntermitentes} linhas): F0 ${pct(d.fillA.f0.intermitentes)} → pacote ${pct(d.fillA.pacote.intermitentes)}`);
    l.push(`- A sem a 1ª semana (D5): F0 ${pct(d.semPrimeiraSemana.f0)} → pacote ${pct(d.semPrimeiraSemana.pacote)}`);
    l.push(d.semSku ? `- A sem o ${d.semSku.sku} (${d.semSku.linhasA} linhas, D5): F0 ${pct(d.semSku.f0)} → pacote ${pct(d.semSku.pacote)}` : '- A sem o SKU de sensibilidade: não medido (contagem de linhas A divergente)');
    const k = d.capital;
    l.push(`- Aumento de capital (estoque médio, R$): ${k.aumento.toFixed(0)}; suaves ${pct(k.suaves)}, intermitentes ${pct(k.intermitentes)}, outros ${pct(k.outros)}; maior SKU ${k.maior ? `${k.maior.sku} ${pct(k.maior.parte)}` : 'n/d'}`);
    l.push('', '| SKU | Δ estoque médio (R$) |', '|---|---:|');
    for (const x of k.porSku.filter((y) => Math.abs(y.delta) > 0.005)) l.push(`| ${x.sku} | ${x.delta.toFixed(2)} |`);
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
  const fronteira = fronteiraDoPacote(dados, tuplas);
  const comum = {
    geradoEm: new Date().toISOString(),
    chave: { hashDados: dados.hashDados, hashCodigo: hashCodigo(), dataExtracao: dados.dataExtracao, protocolo: 'pacote-2026-11-09-v1', perfis: [...new Set(tuplas.map((t) => chavePerfilSuaves(t.perfil)))] },
    teto: { teto: teto.teto, sha256: teto.sha256 },
    modoAncora,
    tuplas: tuplas.map((t) => ({ tupla: serializarTupla(t), estado: estadoDaTupla(t.resultado), estoqueMedio: t.resultado.estoqueMedio, estoqueF0: t.resultado.estoqueF0, fill: t.resultado.fill })),
    escolha: escolha.tipo === 'TUPLA' ? serializarTupla(escolha.tupla) : escolha.tipo,
    fronteira,
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
