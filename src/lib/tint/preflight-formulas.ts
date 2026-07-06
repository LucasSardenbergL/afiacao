import { parseDecimalBR } from '@/lib/preco/parse-decimal-br';
import { formulaColumnLayout } from './formula-layout';

// PREFLIGHT money-path do import de fórmulas tintométricas (break-glass CSV).
//
// Por quê: o parser antigo (`parseFloat(v.replace(',','.')) || 0`) transformava
// decimal ilegível/ambíguo/ausente em 0 ou num número ~1000× errado (milhar pt-BR
// "1.234,56" → 1.234; "3.600" → 3.6) e gravava SILENCIOSO, sobrescrevendo o catálogo.
// O preflight roda ANTES de qualquer escrita, sobre o CSV INTEIRO, e REPROVA o
// arquivo se qualquer célula decimal money for ilegível/ambígua — melhor não
// importar do que registrar receita/preço errado (precisão > recall).
//
// Tem de ser client-side (fronteira única): o edge processa o CSV em CHUNKS e
// nunca vê o arquivo inteiro, então não pode preflightar server-side [Codex P1#3].
//
// Regra por célula:
//  - corante PRESENTE no slot → a quantidade tem de ser number finito > 0
//    (ausente/ilegível/≤0 = item de receita quebrado → ofensa);
//  - volume_final / preço → se a célula está PREENCHIDA mas ilegível/ambígua → ofensa;
//    VAZIA é legítima (vira null honesto, nunca 0 — ausente ≠ zero).
//  `parseDecimalBR` é fail-closed: null em ilegível OU ambíguo (ex.: "1.234").

export interface PreflightOffense {
  /** Nº da linha de DADOS, 1-based (não conta o cabeçalho). */
  linha: number;
  /** Campo ofensivo: `qtd1ml`..`qtd6ml`, `volume_final`, `preco_final`. */
  campo: string;
  /** Valor cru da célula (para o operador achar e corrigir no CSV). */
  valor: string;
}

export interface PreflightResult {
  ok: boolean;
  total: number;
  offending: PreflightOffense[];
}

export function preflightFormulaRows(rows: string[][], personalizada: boolean): PreflightResult {
  const layout = formulaColumnLayout(personalizada);
  const offending: PreflightOffense[] = [];

  rows.forEach((cols, idx) => {
    const linha = idx + 1;

    const idsVistos = new Set<string>();
    let corantesPresentes = 0;
    for (let i = 0; i < 6; i++) {
      const cId = (cols[layout.corante[i]] ?? '').trim();
      if (!cId) continue; // slot vazio → não é um componente da receita
      corantesPresentes++;
      const qtdRaw = cols[layout.qtd[i]] ?? '';
      const qtd = parseDecimalBR(qtdRaw);
      if (qtd === null || qtd <= 0) {
        offending.push({ linha, campo: `qtd${i + 1}ml`, valor: qtdRaw });
        continue;
      }
      // Corante duplicado na mesma fórmula (Codex R2 [P1]): o writer faz delete+insert e o
      // 2º item viola UNIQUE(formula_id, corante_id) → insert falha DEPOIS do delete → receita
      // apagada com "sucesso". Reprova a linha antes de qualquer escrita.
      if (idsVistos.has(cId)) {
        offending.push({ linha, campo: `corante${i + 1}`, valor: `${cId} (duplicado)` });
        continue;
      }
      idsVistos.add(cId);
    }
    // Fórmula precisa de ≥1 corante (Codex R2 [P1]): sem nenhum corante, o writer atualiza o
    // header e o guard de itens deixa a receita antiga stale (ou o legado apagava tudo). Reprova.
    if (corantesPresentes === 0) {
      offending.push({ linha, campo: 'corantes', valor: '(linha sem corante)' });
    }

    // volume/preço: se PREENCHIDO, tem de parsear para um número ≥ 0. Ilegível/ambíguo (null)
    // OU negativo → ofensa. VAZIO é legítimo (vira null honesto). 0 passa (pode ser legítimo).
    const volRaw = cols[layout.volumeFinal] ?? '';
    if (volRaw.trim() !== '') {
      const v = parseDecimalBR(volRaw);
      if (v === null || v < 0) offending.push({ linha, campo: 'volume_final', valor: volRaw });
    }

    const precoRaw = cols[layout.precoFinal] ?? '';
    if (precoRaw.trim() !== '') {
      const p = parseDecimalBR(precoRaw);
      if (p === null || p < 0) offending.push({ linha, campo: 'preco_final', valor: precoRaw });
    }
  });

  return { ok: offending.length === 0, total: rows.length, offending };
}

/**
 * Resumo humano das ofensas para o toast/relatório (dry-run): cita as primeiras
 * `maxCells` células com linha/campo/valor — o operador acha e corrige, ou percebe
 * que o formato do export não bate com o parser (de-risco do "1.234" sem fixture).
 */
export function summarizePreflight(res: PreflightResult, maxCells = 8): string {
  if (res.ok) return '';
  const shown = res.offending
    .slice(0, maxCells)
    .map((o) => `linha ${o.linha}, ${o.campo}: "${o.valor}"`)
    .join('; ');
  const extra = res.offending.length > maxCells ? ` (+${res.offending.length - maxCells} outras)` : '';
  return `${res.offending.length} célula(s) numérica(s) inválida(s)/ambígua(s) — ${shown}${extra}`;
}
