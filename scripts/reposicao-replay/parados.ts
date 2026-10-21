// Padrão Syntetos-Boylan (série semanal), coorte fixada no corte e SKUs "parados" (spec §5.1.1, §5.3 e §7).
// Tudo que decide a coorte usa só dados < CORTE_COORTE (intenção de tratar: quem muda de regime na avaliação fica na sua coorte).
//
// Semana = bloco de 7 dias ALINHADO EM d (k=1 é o mais recente: [d-7, d), k=2: [d-14, d-7) ...). Só entram blocos inteiros que
// começam em/depois do início do histórico: semana anterior ao início é "não observada", não zero. Com o histórico de 2025-10-21 e
// o corte de 2026-05-01 cabem exatamente 27 blocos (os "27 semanas observadas" da spec).
// SB: ADI = nº de semanas observadas / nº de semanas com venda; CV² = (desvio amostral / média)² das quantidades semanais POSITIVAS.
// ADI > 1,32 e CV² > 0,49 (estritos). `sem_dado` = menos de 2 semanas com venda (CV² não estimável).
import { addDias } from '../../src/lib/reposicao/orcamento-compra/datas';
import { classeEfetiva, type DadosClasse } from './classe';
import { CORTE_COORTE, INICIO_AQUECIMENTO, MAX_SEMANAS_COM_VENDA_PARADO, SEMANAS_PARADO } from './config';
import type { Classe, Data, PadraoSB, Parado } from './tipos';

export const SB_ADI_CORTE = 1.32;
export const SB_CV2_CORTE = 0.49;

const porSku = new WeakMap<object, Map<string, { data: Data; quantidade: number }[]>>();
function vendasDoSku(dados: Pick<DadosClasse, 'vendas'>, sku: string) {
  let idx = porSku.get(dados.vendas);
  if (!idx) {
    idx = new Map();
    for (const v of dados.vendas) {
      let l = idx.get(v.sku);
      if (!l) idx.set(v.sku, (l = []));
      l.push({ data: v.data, quantidade: v.quantidade });
    }
    porSku.set(dados.vendas, idx);
  }
  return idx.get(sku) ?? [];
}

/** Quantidade por bloco semanal observado, do mais recente (k=1) ao mais antigo. Só dados < d. */
export function serieSemanal(dados: Pick<DadosClasse, 'vendas'>, d: Data, sku: string, maxSemanas = Infinity): number[] {
  const n: number[] = [];
  for (let k = 1; k <= maxSemanas && addDias(d, -7 * k) >= INICIO_AQUECIMENTO; k++) n.push(0);
  for (const v of vendasDoSku(dados, sku)) {
    if (v.data >= d) continue;
    const k = Math.floor((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${v.data}T00:00:00Z`) - 1) / (7 * 86_400_000)) + 1; // bloco de v (k>=1)
    if (k >= 1 && k <= n.length) n[k - 1] += v.quantidade;
  }
  return n;
}

export function padraoSB(dados: Pick<DadosClasse, 'vendas'>, d: Data, sku: string): PadraoSB {
  const serie = serieSemanal(dados, d, sku);
  const pos = serie.filter((q) => q > 0);
  if (pos.length < 2) return 'sem_dado';
  const adi = serie.length / pos.length;
  const media = pos.reduce((s, x) => s + x, 0) / pos.length;
  const dp = Math.sqrt(pos.reduce((s, x) => s + (x - media) ** 2, 0) / (pos.length - 1));
  const cv2 = (dp / media) ** 2;
  const intermitente = adi > SB_ADI_CORTE;
  const irregular = cv2 > SB_CV2_CORTE;
  return intermitente ? (irregular ? 'lumpy' : 'intermitente') : irregular ? 'erratico' : 'suave';
}

export interface Coorte {
  populacao: Set<string>;
  alterados: Set<string>;
  parados: Parado[];
}

function montar(dados: DadosClasse, soHabilitados: boolean): Coorte {
  const corte = CORTE_COORTE;
  const efetiva = classeEfetiva(dados, corte);
  const parados: Parado[] = [];
  const populacao = new Set<string>();
  const alterados = new Set<string>();
  const ini90 = addDias(corte, -90);
  for (const s of [...dados.skus.values()].filter((x) => x.ativo).sort((a, b) => (a.sku < b.sku ? -1 : 1))) {
    const serie = serieSemanal(dados, corte, s.sku, SEMANAS_PARADO);
    const semanas = serie.filter((q) => q > 0).length;
    if (semanas <= MAX_SEMANAS_COM_VENDA_PARADO) {
      let ultimaVenda: Data | null = null;
      for (const v of vendasDoSku(dados, s.sku)) if (v.data < corte && v.quantidade > 0 && (ultimaVenda === null || v.data > ultimaVenda)) ultimaVenda = v.data;
      let ultimaCompra: Data | null = null;
      for (const r of dados.recebimentos) if (r.sku === s.sku && r.data < corte && (ultimaCompra === null || r.data > ultimaCompra)) ultimaCompra = r.data;
      parados.push({
        sku: s.sku, semanasComVenda: semanas, ultimaVenda, ultimaCompra,
        estoqueCmc: s.saldoHoje === null || s.cmc === null ? null : s.saldoHoje * s.cmc,
        habilitado: s.habilitado,
        compradoUltimos90d: ultimaCompra !== null && ultimaCompra >= ini90,
        classe: (efetiva.get(s.sku) ?? null) as Classe | null,
      });
      continue;
    }
    if (soHabilitados && !s.habilitado) continue;
    populacao.add(s.sku);
    const sb = padraoSB(dados, corte, s.sku);
    if (sb === 'intermitente' || sb === 'lumpy') alterados.add(s.sku);
  }
  return { populacao, alterados, parados };
}

/** Coorte do replay: ativo + reposição automática habilitada − parados (todos com dados < corte). Contrato de unidade já filtrado em `dados.skus`. */
export function coorte(dados: DadosClasse): Coorte {
  return montar(dados, true);
}

/** Sensibilidade (spec §5.1.1): todos os ativos, sem o filtro de reposição automática. Parados continuam fora (sem evidência para cauda, §7). */
export function coorteTodosAtivos(dados: DadosClasse): Coorte {
  return montar(dados, false);
}
