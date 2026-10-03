/**
 * relatorio.ts — junta itens × resultados do Jev e gera as tabelas do backtest (markdown pt-BR).
 *
 * Uso:  bun scripts/jev/relatorio.ts [--dados scripts/jev/.dados]   → grava <dados>/relatorio.md
 *
 * Onde o instrumento pode mentir, e como cada ponto é fechado (testado em relatorio.test.ts):
 *   - item SEM resultado é FALHA contada, nunca acerto nem abstenção (ausente ≠ zero);
 *   - item sem gabarito (resíduo) NUNCA entra no acerto — só na cobertura;
 *   - "média das 2 ordens" exige as DUAS ordens; com uma só, o item é falha (não usa metade);
 *   - o limiar é escolhido na partição `dev` e medido na `teste` (nunca no mesmo conjunto).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NENHUM, NENHUMA, particao, type Dominio, type ItemBacktest, type TipoGabarito } from './dados';
import {
  avaliarLimiar,
  avaliarRegra,
  calcularEce,
  combinarOrdens,
  custoUsd,
  limiarDaCurva,
  percentil,
  sensibilidadeOrdem,
  type ParOrdem,
  type Predicao,
  type ResultadoCobertura,
} from './metricas';
import type { Ordem } from './rodar';

export type ResultadoChamada =
  | {
      id: string; ordem: Ordem; ok: true; escolha: string; prob: number; probabilidades: Record<string, number>;
      confidence: number; tokensEntrada: number; modelo: string; tentativas: number; latenciaMs: number; latenciaTotalMs: number;
    }
  | { id: string; ordem: Ordem; ok: false; erro: string; status: number | null; tentativas: number; latenciaTotalMs: number };

export type IndiceResultados = Map<string, ResultadoChamada>;

const chave = (id: string, ordem: Ordem) => `${id}|${ordem}`;

/** Sucesso nunca é sobrescrito; falha é sobrescrita pela tentativa mais nova (retomada). */
export function indexarResultados(res: readonly ResultadoChamada[]): IndiceResultados {
  const m: IndiceResultados = new Map();
  for (const r of res) {
    const k = chave(r.id, r.ordem);
    const atual = m.get(k);
    if (!atual || !atual.ok) m.set(k, r);
  }
  return m;
}

export type PredicaoItem = Predicao & { id: string; grupo: string };

export function predicoesJev(
  itens: readonly ItemBacktest[],
  idx: IndiceResultados,
  modo: 'direta' | 'media',
  escore: 'prob' | 'confidence',
): PredicaoItem[] {
  if (modo === 'media' && escore === 'confidence') throw new Error('confidence não existe para a média das ordens');
  const out: PredicaoItem[] = [];
  for (const it of itens) {
    if (it.gabarito === null) continue;
    const d = idx.get(chave(it.id, 'direta'));
    let escolha: string | null = null;
    let prob: number | null = null;
    if (modo === 'direta') {
      if (d?.ok) {
        escolha = d.escolha;
        prob = escore === 'prob' ? d.prob : d.confidence;
      }
    } else {
      const v = idx.get(chave(it.id, 'invertida'));
      if (d?.ok && v?.ok) {
        const c = combinarOrdens(d.probabilidades, v.probabilidades);
        escolha = c.escolha;
        prob = c.prob;
      }
    }
    out.push({ id: it.id, grupo: it.grupo, escolha, prob, correta: escolha !== null && it.gabarito.includes(escolha) });
  }
  return out;
}

export function predicoesBaseline(itens: readonly ItemBacktest[]): Array<{ id: string; grupo: string; escolha: string | null; correta: boolean }> {
  return itens
    .filter((it) => it.gabarito !== null)
    .map((it) => ({
      id: it.id,
      grupo: it.grupo,
      escolha: it.baseline,
      correta: it.baseline !== null && (it.gabarito ?? []).includes(it.baseline),
    }));
}

const ehNenhum = (s: string) => s === NENHUM || s === NENHUMA;

export function coberturaSemGabarito(
  itens: readonly ItemBacktest[],
  idx: IndiceResultados,
  limiar: number,
): { total: number; falhas: number; respondidas: number; respondeuNenhum: number } {
  let total = 0;
  let falhas = 0;
  let respondidas = 0;
  let respondeuNenhum = 0;
  for (const it of itens) {
    if (it.gabarito !== null) continue;
    total++;
    const d = idx.get(chave(it.id, 'direta'));
    if (!d?.ok) {
      falhas++;
      continue;
    }
    if (d.prob >= limiar) {
      respondidas++;
      if (ehNenhum(d.escolha)) respondeuNenhum++;
    }
  }
  return { total, falhas, respondidas, respondeuNenhum };
}

function pares(itens: readonly ItemBacktest[], idx: IndiceResultados, a: Ordem, b: Ordem): ParOrdem[] {
  return itens.map((it) => {
    const ra = idx.get(chave(it.id, a));
    const rb = idx.get(chave(it.id, b));
    return {
      id: it.id,
      a: ra?.ok ? { escolha: ra.escolha, prob: ra.prob } : { escolha: null, prob: null },
      b: rb?.ok ? { escolha: rb.escolha, prob: rb.prob } : { escolha: null, prob: null },
    };
  });
}

// ─── formatação ─────────────────────────────────────────────────────────────────────────────

const pct = (x: number | null, casas = 1) => (x === null ? '—' : `${(100 * x).toFixed(casas).replace('.', ',')}%`);
const dec = (x: number | null, casas = 3) => (x === null ? '—' : x.toFixed(casas).replace('.', ','));
const LIMIARES = [0.8, 0.9, 0.95] as const;
const GRADE = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.97, 0.99];
const ALVOS = [0.02, 0.05];

const ROTULO: Record<TipoGabarito, string> = {
  prata: 'prata (regra exata)',
  sintetico_negativo: 'negativo sintético (sem a família certa)',
  negativo_cruzado: 'negativo cruzado (famílias de outra ficha)',
  prata_mascarada: 'prata mascarada',
  seed: 'seed (não auditado)',
  sem_gabarito: 'sem gabarito',
};

function linhaCobertura(conjunto: string, sistema: string, portao: string, r: ResultadoCobertura): string {
  return `| ${conjunto} | ${sistema} | ${portao} | ${r.total} | ${pct(r.cobertura)} | ${r.respondidas} | ${pct(r.acerto)} | ${r.erros} | ${pct(r.limiteSuperiorErro)} | ${r.falhas} |`;
}

interface Conjunto {
  rotulo: string;
  itens: ItemBacktest[];
}

function conjuntosComGabarito(itens: readonly ItemBacktest[]): Conjunto[] {
  const tipos: TipoGabarito[] = ['prata', 'sintetico_negativo', 'negativo_cruzado', 'prata_mascarada', 'seed'];
  const cs: Conjunto[] = tipos
    .map((t) => ({ rotulo: ROTULO[t], itens: itens.filter((i) => i.tipoGabarito === t) }))
    .filter((c) => c.itens.length > 0);
  const comGab = itens.filter((i) => i.gabarito !== null);
  if (cs.length > 1) cs.push({ rotulo: '**união**', itens: comGab });
  return cs;
}

export interface MetaExport {
  exportado_em?: string;
  contagens?: Record<string, unknown>;
  recuperacao_boletim?: Record<string, number>;
  dre_seed_confere?: Array<{ id: string; seed_nota: string | null; nome_real: string; confere: boolean }>;
}

export function gerarRelatorioDominio(dominio: Dominio, itens: readonly ItemBacktest[], idx: IndiceResultados, meta: MetaExport | null): string {
  const out: string[] = [];
  const titulo = dominio === 'boletim_sku' ? '(a) Boletim técnico → produto (família de SKUs)' : '(c) Categoria Omie → linha da DRE';
  const porTipo = (t: TipoGabarito) => itens.filter((i) => i.tipoGabarito === t).length;
  out.push(`### ${titulo}`, '');
  out.push(
    `Itens: **${itens.length}** — prata ${porTipo('prata')} · negativo ${porTipo('sintetico_negativo')} · cruzado ${porTipo('negativo_cruzado')} · mascarada ${porTipo('prata_mascarada')} · seed ${porTipo('seed')} · sem gabarito ${porTipo('sem_gabarito')}.`,
    '',
  );
  if (dominio === 'boletim_sku' && meta?.recuperacao_boletim) {
    const r = meta.recuperacao_boletim;
    out.push(
      `Recuperação (réplica de \`buscar_skus_candidatos\`): ${r.specs} fichas aprovadas → ${r.sem_candidato} sem nenhum candidato · ${r.com_familia_exata} com a família exata · ${r.residuo} só com famílias não-exatas · ${r.truncadas_no_limit100} cortadas no LIMIT 100.`,
      '',
    );
  }
  const conjuntos = conjuntosComGabarito(itens);

  // 1+2. acerto e cobertura
  out.push('#### Acerto nas respondidas e cobertura', '');
  out.push('| Conjunto | Sistema | Portão | n | Cobertura | Respondidas | Acerto | Erros | LS 95% do erro | Falhas |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of conjuntos) {
    out.push(linhaCobertura(c.rotulo, 'baseline (regra)', 'decide/abstém', avaliarRegra(predicoesBaseline(c.itens))));
    const dir = predicoesJev(c.itens, idx, 'direta', 'prob');
    const med = predicoesJev(c.itens, idx, 'media', 'prob');
    const conf = predicoesJev(c.itens, idx, 'direta', 'confidence');
    for (const t of LIMIARES) out.push(linhaCobertura(c.rotulo, 'Jev · ordem direta', `p ≥ ${dec(t, 2)}`, avaliarLimiar(dir, t)));
    for (const t of LIMIARES) out.push(linhaCobertura(c.rotulo, 'Jev · média 2 ordens', `p ≥ ${dec(t, 2)}`, avaliarLimiar(med, t)));
    for (const t of LIMIARES) out.push(linhaCobertura(c.rotulo, 'Jev · direta', `confidence ≥ ${dec(t, 2)}`, avaliarLimiar(conf, t)));
  }
  out.push('');

  // 3. calibração
  out.push('#### Calibração — ECE em 10 faixas sobre `probabilities[choice]`', '');
  out.push('| Conjunto | n | ECE (direta) | ECE (média 2 ordens) |', '|---|---|---|---|');
  for (const c of conjuntos) {
    const e1 = calcularEce(predicoesJev(c.itens, idx, 'direta', 'prob'));
    const e2 = calcularEce(predicoesJev(c.itens, idx, 'media', 'prob'));
    out.push(`| ${c.rotulo} | ${e1.n} | ${dec(e1.ece)} | ${dec(e2.ece)} |`);
  }
  out.push('');
  const uniao = conjuntos.find((c) => c.rotulo === '**união**') ?? conjuntos[0];
  if (uniao) {
    const e = calcularEce(predicoesJev(uniao.itens, idx, 'direta', 'prob'));
    out.push(`Tabela de confiabilidade — ${uniao.rotulo.replace(/\*/g, '')}, ordem direta:`, '');
    out.push('| Faixa de p | n | p médio | Acerto | Gap |', '|---|---|---|---|---|');
    for (const f of e.faixas) {
      if (f.n === 0) continue;
      const gap = f.acerto !== null && f.confMedia !== null ? f.acerto - f.confMedia : null;
      out.push(`| ${dec(f.de, 1)}–${dec(f.ate, 1)} | ${f.n} | ${dec(f.confMedia)} | ${pct(f.acerto)} | ${gap === null ? '—' : `${gap >= 0 ? '+' : ''}${dec(gap)}`} |`);
    }
    out.push('');

    // 4. limiar da nossa curva: escolhido no dev, medido no teste
    out.push('#### Limiar da nossa curva — escolhido na partição `dev`, medido na `teste`', '');
    out.push('| Alvo de erro (LS 95%) | n dev | Limiar (dev) | n teste | Cobertura (teste) | Acerto (teste) | Erros (teste) | LS 95% (teste) |');
    out.push('|---|---|---|---|---|---|---|---|');
    const preds = predicoesJev(uniao.itens, idx, 'direta', 'prob');
    const dev = preds.filter((p) => particao(p.grupo) === 'dev');
    const teste = preds.filter((p) => particao(p.grupo) === 'teste');
    for (const alvo of ALVOS) {
      const t = limiarDaCurva(dev, GRADE, alvo);
      if (t === null) {
        out.push(`| ${pct(alvo, 0)} | ${dev.length} | **inconclusivo** (nenhum limiar da grade sustenta o alvo) | ${teste.length} | — | — | — | — |`);
      } else {
        const r = avaliarLimiar(teste, t);
        out.push(`| ${pct(alvo, 0)} | ${dev.length} | ${dec(t, 2)} | ${teste.length} | ${pct(r.cobertura)} | ${pct(r.acerto)} | ${r.erros} | ${pct(r.limiteSuperiorErro)} |`);
      }
    }
    out.push('');
  }

  // 5. ordem e repetição (não precisa de gabarito: inclui o resíduo)
  out.push('#### Sensibilidade à ordem das opções (direta × invertida) e repetição (direta × repetida)', '');
  out.push('| Conjunto | Comparação | Pares válidos | Troca de escolha | Decisão muda @0,80 | @0,90 | @0,95 | Trocas confiantes @0,80 / 0,90 / 0,95 |');
  out.push('|---|---|---|---|---|---|---|---|');
  const conjOrdem: Conjunto[] = [...conjuntos.filter((c) => c.rotulo !== '**união**')];
  const semGab = itens.filter((i) => i.gabarito === null);
  if (semGab.length > 0) conjOrdem.push({ rotulo: ROTULO.sem_gabarito, itens: semGab });
  for (const c of conjOrdem) {
    for (const [nome, a, b] of [['ordem', 'direta', 'invertida'], ['repetição', 'direta', 'repetida']] as const) {
      const s = sensibilidadeOrdem(pares(c.itens, idx, a, b), LIMIARES);
      const pl = (t: number) => s.porLimiar.find((p) => p.limiar === t)!;
      out.push(
        `| ${c.rotulo} | ${nome} | ${s.paresValidos} | ${pct(s.taxaTrocaEscolha)} | ${pct(pl(0.8).taxaDecisaoMuda)} | ${pct(pl(0.9).taxaDecisaoMuda)} | ${pct(pl(0.95).taxaDecisaoMuda)} | ${pl(0.8).trocasConfiantes} / ${pl(0.9).trocasConfiantes} / ${pl(0.95).trocasConfiantes} |`,
      );
    }
  }
  out.push('');

  // resíduo
  if (semGab.length > 0) {
    out.push('#### Sem gabarito — quanto o Jev decidiria (ordem direta)', '');
    out.push('| Limiar | Itens | Respondidas | Cobertura | Das quais "nenhum" | Falhas |', '|---|---|---|---|---|---|');
    for (const t of [0.5, ...LIMIARES]) {
      const r = coberturaSemGabarito(itens, idx, t);
      out.push(`| p ≥ ${dec(t, 2)} | ${r.total} | ${r.respondidas} | ${pct(r.total ? r.respondidas / r.total : null)} | ${r.respondeuNenhum} | ${r.falhas} |`);
    }
    if (dominio === 'categoria_dre') {
      let ambos = 0;
      let iguais = 0;
      for (const it of semGab) {
        const d = idx.get(chave(it.id, 'direta'));
        if (it.baseline !== null && d?.ok && d.prob >= 0.8) {
          ambos++;
          if (d.escolha === it.baseline) iguais++;
        }
      }
      out.push('', `Concordância Jev (p ≥ 0,80) × regex onde AMBOS respondem: ${iguais}/${ambos} (${pct(ambos ? iguais / ambos : null)}).`);
    }
    out.push('');
  }

  // 6. latência e custo
  const chamadas = itens.flatMap((it) => (['direta', 'invertida', 'repetida'] as const).map((o) => idx.get(chave(it.id, o))));
  const oks = chamadas.filter((r): r is Extract<ResultadoChamada, { ok: true }> => r?.ok === true);
  const falhas = chamadas.filter((r) => r !== undefined && !r.ok).length;
  const ausentes = chamadas.filter((r) => r === undefined).length;
  const tokens = oks.reduce((s, r) => s + r.tokensEntrada, 0);
  const modelos = [...new Set(oks.map((r) => r.modelo))].join(', ') || '—';
  const lat = oks.map((r) => r.latenciaMs);
  const latTot = oks.map((r) => r.latenciaTotalMs);
  out.push('#### Latência e custo', '');
  out.push('| Chamadas ok | Falhas | Ausentes | p50 (ms) | p95 (ms) | p50 c/ retries (ms) | p95 c/ retries (ms) | Tokens de entrada | Custo total | Custo por 1.000 chamadas | Modelo(s) |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|');
  const usd = custoUsd(tokens);
  out.push(
    `| ${oks.length} | ${falhas} | ${ausentes} | ${percentil(lat, 50)?.toFixed(0) ?? '—'} | ${percentil(lat, 95)?.toFixed(0) ?? '—'} | ${percentil(latTot, 50)?.toFixed(0) ?? '—'} | ${percentil(latTot, 95)?.toFixed(0) ?? '—'} | ${tokens.toLocaleString('pt-BR')} | US$ ${usd.toFixed(4).replace('.', ',')} | US$ ${oks.length ? ((usd / oks.length) * 1000).toFixed(4).replace('.', ',') : '—'} | ${modelos} |`,
  );
  out.push('');
  return out.join('\n');
}

export function gerarRelatorio(porDominio: ReadonlyArray<[Dominio, ItemBacktest[]]>, resultados: readonly ResultadoChamada[], meta: MetaExport | null): string {
  const idx = indexarResultados(resultados);
  return porDominio.map(([d, itens]) => gerarRelatorioDominio(d, itens, idx, meta)).join('\n');
}

function main(): void {
  const i = process.argv.indexOf('--dados');
  const dir = i > 0 ? process.argv[i + 1] : join(import.meta.dirname, '.dados');
  const ler = <T>(n: string): T => JSON.parse(readFileSync(join(dir, n), 'utf8')) as T;
  const porDominio: Array<[Dominio, ItemBacktest[]]> = (['boletim_sku', 'categoria_dre'] as const)
    .filter((d) => existsSync(join(dir, `${d}.json`)))
    .map((d) => [d, ler<ItemBacktest[]>(`${d}.json`)]);
  const arq = join(dir, 'resultados.jsonl');
  const resultados = existsSync(arq)
    ? readFileSync(arq, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ResultadoChamada)
    : [];
  const meta = existsSync(join(dir, 'meta.json')) ? ler<MetaExport>('meta.json') : null;
  const md = gerarRelatorio(porDominio, resultados, meta);
  writeFileSync(join(dir, 'relatorio.md'), md);
  console.log(md);
  console.log(`RELATORIO-JEV-OK (${resultados.length} linhas de resultado)`);
}

if (import.meta.main) main();
