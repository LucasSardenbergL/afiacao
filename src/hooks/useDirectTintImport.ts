import { useState, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import Papa from 'papaparse';

const ACCOUNT = 'oben';
const BATCH_SIZE = 200;
const RPC_BATCH_SIZE = 2000;

const isFormulaImportType = (tipo: string) =>
  tipo === 'formulas_padrao' || tipo === 'formulas_personalizadas';

function parseBrDecimal(value: string | undefined | null): number {
  if (!value || value.trim() === '') return 0;
  return parseFloat(value.trim().replace(',', '.')) || 0;
}

async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface DirectImportProgress {
  phase: string;
  currentBatch: number;
  totalBatches: number;
  recordsProcessed: number;
  totalRecords: number;
  imported: number;
  updated: number;
  errors: number;
}

export interface DirectImportResult {
  status: 'concluido' | 'parcial' | 'erro' | 'duplicado';
  imported: number;
  updated: number;
  errors: number;
  importacaoId: string | null;
}

export function useDirectTintImport() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<DirectImportProgress | null>(null);
  const cancelledRef = useRef(false);

  const produtoCache = useRef(new Map<string, string>());
  const baseCache = useRef(new Map<string, string>());
  const embalagemCache = useRef(new Map<string, string>());
  const coranteCache = useRef(new Map<string, string>());
  const subcolecaoCache = useRef(new Map<string, string>());
  const skuCache = useRef(new Map<string, string>());

  const clearCaches = () => {
    produtoCache.current.clear();
    baseCache.current.clear();
    embalagemCache.current.clear();
    coranteCache.current.clear();
    subcolecaoCache.current.clear();
    skuCache.current.clear();
  };

  const preWarmCaches = async () => {
    const [produtos, bases, embalagens, corantes, subcolecoes, skus] = await Promise.all([
      supabase.from('tint_produtos').select('id, cod_produto').eq('account', ACCOUNT).limit(5000),
      supabase.from('tint_bases').select('id, id_base_sayersystem').eq('account', ACCOUNT).limit(5000),
      supabase.from('tint_embalagens').select('id, id_embalagem_sayersystem').eq('account', ACCOUNT).limit(5000),
      supabase.from('tint_corantes').select('id, id_corante_sayersystem').eq('account', ACCOUNT).limit(5000),
      supabase.from('tint_subcolecoes').select('id, id_subcolecao_sayersystem').eq('account', ACCOUNT).limit(5000),
      supabase.from('tint_skus').select('id, produto_id, base_id, embalagem_id').eq('account', ACCOUNT).limit(10000),
    ]);
    for (const r of produtos.data ?? []) produtoCache.current.set(r.cod_produto, r.id);
    for (const r of bases.data ?? []) baseCache.current.set(r.id_base_sayersystem, r.id);
    for (const r of embalagens.data ?? []) embalagemCache.current.set(r.id_embalagem_sayersystem, r.id);
    for (const r of corantes.data ?? []) coranteCache.current.set(r.id_corante_sayersystem, r.id);
    for (const r of subcolecoes.data ?? []) subcolecaoCache.current.set(r.id_subcolecao_sayersystem, r.id);
    for (const r of skus.data ?? []) skuCache.current.set(`${r.produto_id}:${r.base_id}:${r.embalagem_id}`, r.id);
    console.log(`[direct-import] Caches: ${produtoCache.current.size} produtos, ${baseCache.current.size} bases, ${embalagemCache.current.size} embalagens, ${coranteCache.current.size} corantes, ${skuCache.current.size} skus`);
  };

  // ─── Process dados_corantes ───
  const processDadosCorantes = async (rows: string[][]): Promise<{ imported: number; updated: number; errors: number }> => {
    let imported = 0, updated = 0, errors = 0;
    const totalBatches = Math.ceil(rows.length / BATCH_SIZE);

    for (let b = 0; b < totalBatches; b++) {
      if (cancelledRef.current) break;
      const batch = rows.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
      const upsertRows: Array<{
        account: string; id_corante_sayersystem: string; descricao: string;
        volume_total_ml: number; peso_especifico: number | null; codigo_barras: string | null;
      }> = [];

      for (const row of batch) {
        const [codigo, descricao, volumeMl, pesoEspecifico, codigoBarras] = row;
        if (!codigo || !descricao) { errors++; continue; }
        upsertRows.push({
          account: ACCOUNT, id_corante_sayersystem: codigo, descricao,
          volume_total_ml: parseBrDecimal(volumeMl) || 1000,
          peso_especifico: parseBrDecimal(pesoEspecifico) || null,
          codigo_barras: codigoBarras || null,
        });
      }

      if (upsertRows.length > 0) {
        const { error } = await supabase.from('tint_corantes').upsert(
          upsertRows, { onConflict: 'account,id_corante_sayersystem' }
        );
        if (error) { errors += upsertRows.length; console.error('[direct] corantes batch error:', error); }
        else { imported += upsertRows.length; }
      }

      setProgress(prev => prev ? {
        ...prev, currentBatch: b + 1, totalBatches,
        recordsProcessed: Math.min((b + 1) * BATCH_SIZE, rows.length),
        imported, updated, errors,
      } : prev);
    }
    return { imported, updated, errors };
  };

  // ─── Process dados_produto_base_embalagem ───
  const processDadosPBE = async (rows: string[][]): Promise<{ imported: number; updated: number; errors: number }> => {
    let imported = 0, updated = 0, errors = 0;
    const totalBatches = Math.ceil(rows.length / BATCH_SIZE);

    for (let b = 0; b < totalBatches; b++) {
      if (cancelledRef.current) break;
      const batch = rows.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);

      const uniqueProdutos = new Map<string, string>();
      const uniqueBases = new Map<string, string>();
      const uniqueEmbalagens = new Map<string, { desc: string; vol: number }>();

      for (const row of batch) {
        const [produto, base, embalagem, embalagemConteudoMl] = row;
        if (!produto || !base) continue;
        uniqueProdutos.set(produto, produto);
        const idBaseSayer = base.replace(/\s+/g, '_').substring(0, 100);
        uniqueBases.set(idBaseSayer, base);
        const volumeMl = parseBrDecimal(embalagemConteudoMl) || 0;
        const idEmbSayer = embalagem || `EMB_${volumeMl}`;
        uniqueEmbalagens.set(idEmbSayer, { desc: embalagem, vol: volumeMl });
      }

      // Batch upsert entities
      const newProdutos = Array.from(uniqueProdutos.entries()).filter(([cod]) => !produtoCache.current.has(cod));
      if (newProdutos.length > 0) {
        const { data } = await supabase.from('tint_produtos').upsert(
          newProdutos.map(([cod, desc]) => ({ account: ACCOUNT, cod_produto: cod, descricao: desc })),
          { onConflict: 'account,cod_produto' }
        ).select('id, cod_produto');
        for (const r of data ?? []) produtoCache.current.set(r.cod_produto, r.id);
      }

      const newBases = Array.from(uniqueBases.entries()).filter(([id]) => !baseCache.current.has(id));
      if (newBases.length > 0) {
        const { data } = await supabase.from('tint_bases').upsert(
          newBases.map(([id, desc]) => ({ account: ACCOUNT, id_base_sayersystem: id, descricao: desc })),
          { onConflict: 'account,id_base_sayersystem' }
        ).select('id, id_base_sayersystem');
        for (const r of data ?? []) baseCache.current.set(r.id_base_sayersystem, r.id);
      }

      const newEmb = Array.from(uniqueEmbalagens.entries()).filter(([id]) => !embalagemCache.current.has(id));
      if (newEmb.length > 0) {
        const { data } = await supabase.from('tint_embalagens').upsert(
          newEmb.map(([id, { desc, vol }]) => ({ account: ACCOUNT, id_embalagem_sayersystem: id, volume_ml: vol, descricao: desc || null })),
          { onConflict: 'account,id_embalagem_sayersystem' }
        ).select('id, id_embalagem_sayersystem');
        for (const r of data ?? []) embalagemCache.current.set(r.id_embalagem_sayersystem, r.id);
      }

      // Create SKUs
      const skuRows: Array<{ account: string; produto_id: string; base_id: string; embalagem_id: string }> = [];
      for (const row of batch) {
        const [produto, base, embalagem, embalagemConteudoMl] = row;
        if (!produto || !base) { errors++; continue; }
        const produtoId = produtoCache.current.get(produto);
        const idBaseSayer = base.replace(/\s+/g, '_').substring(0, 100);
        const baseId = baseCache.current.get(idBaseSayer);
        const volumeMl = parseBrDecimal(embalagemConteudoMl) || 0;
        const idEmbSayer = embalagem || `EMB_${volumeMl}`;
        const embalagemId = embalagemCache.current.get(idEmbSayer);
        if (produtoId && baseId && embalagemId) {
          const key = `${produtoId}:${baseId}:${embalagemId}`;
          if (!skuCache.current.has(key)) {
            skuRows.push({ account: ACCOUNT, produto_id: produtoId, base_id: baseId, embalagem_id: embalagemId });
          }
          imported++;
        } else { errors++; }
      }

      if (skuRows.length > 0) {
        const { data } = await supabase.from('tint_skus').upsert(skuRows, { onConflict: 'account,produto_id,base_id,embalagem_id' }).select('id, produto_id, base_id, embalagem_id');
        for (const r of data ?? []) skuCache.current.set(`${r.produto_id}:${r.base_id}:${r.embalagem_id}`, r.id);
      }

      setProgress(prev => prev ? {
        ...prev, currentBatch: b + 1, totalBatches,
        recordsProcessed: Math.min((b + 1) * BATCH_SIZE, rows.length),
        imported, updated, errors,
      } : prev);
    }
    return { imported, updated, errors };
  };

  // ─── Process formulas ───
  const processFormulas = async (rows: string[][], personalizada: boolean, importacaoId: string): Promise<{ imported: number; updated: number; errors: number }> => {
    let imported = 0, updated = 0, errors = 0;
    const totalBatches = Math.ceil(rows.length / BATCH_SIZE);
    const offset = personalizada ? 0 : 2;

    for (let b = 0; b < totalBatches; b++) {
      if (cancelledRef.current) break;
      const batch = rows.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);

      // Phase 1: Collect unique auxiliary entities
      const uniqueProdutos = new Map<string, string>();
      const uniqueBases = new Map<string, string>();
      const uniqueEmbalagens = new Map<string, { desc: string; vol: number }>();
      const uniqueCorantes = new Map<string, string>();
      const uniqueSubcolecoes = new Map<string, string>();

      for (const cols of batch) {
        const codProduto = cols[7]; const produtoDesc = cols[8];
        const idBase = cols[3]; const baseDesc = cols[4];
        const idEmbalagem = cols[5]; const embalagemDesc = cols[6];
        if (codProduto) uniqueProdutos.set(codProduto, produtoDesc || codProduto);
        if (idBase) uniqueBases.set(idBase, baseDesc || idBase);

        const coranteStart = 9 + offset;
        for (let c = 0; c < 6; c++) {
          const corId = cols[coranteStart + c];
          if (corId) uniqueCorantes.set(corId, corId);
        }

        const qtdStart = coranteStart + 6;
        const volumeFinalMl = parseBrDecimal(cols[qtdStart + 6]);
        if (idEmbalagem) uniqueEmbalagens.set(idEmbalagem, { desc: embalagemDesc || '', vol: volumeFinalMl });

        if (!personalizada) {
          const subCode = cols[9] || '';
          const subDesc = cols[10] || '';
          if (subCode && subDesc) uniqueSubcolecoes.set(subCode, subDesc);
        }
      }

      // Phase 2: Batch upsert auxiliary entities (sequential to avoid type issues)
      const newProdutos = Array.from(uniqueProdutos.entries()).filter(([k]) => !produtoCache.current.has(k));
      if (newProdutos.length > 0) {
        const { data } = await supabase.from('tint_produtos').upsert(
          newProdutos.map(([cod, desc]) => ({ account: ACCOUNT, cod_produto: cod, descricao: desc })),
          { onConflict: 'account,cod_produto' }
        ).select('id, cod_produto');
        for (const r of data ?? []) produtoCache.current.set(r.cod_produto, r.id);
      }

      const newBases = Array.from(uniqueBases.entries()).filter(([k]) => !baseCache.current.has(k));
      if (newBases.length > 0) {
        const { data } = await supabase.from('tint_bases').upsert(
          newBases.map(([id, desc]) => ({ account: ACCOUNT, id_base_sayersystem: id, descricao: desc })),
          { onConflict: 'account,id_base_sayersystem' }
        ).select('id, id_base_sayersystem');
        for (const r of data ?? []) baseCache.current.set(r.id_base_sayersystem, r.id);
      }

      const newEmb = Array.from(uniqueEmbalagens.entries()).filter(([k]) => !embalagemCache.current.has(k));
      if (newEmb.length > 0) {
        const { data } = await supabase.from('tint_embalagens').upsert(
          newEmb.map(([id, { desc, vol }]) => ({ account: ACCOUNT, id_embalagem_sayersystem: id, volume_ml: vol, descricao: desc || null })),
          { onConflict: 'account,id_embalagem_sayersystem' }
        ).select('id, id_embalagem_sayersystem');
        for (const r of data ?? []) embalagemCache.current.set(r.id_embalagem_sayersystem, r.id);
      }

      const newCorantes = Array.from(uniqueCorantes.entries()).filter(([k]) => !coranteCache.current.has(k));
      if (newCorantes.length > 0) {
        const { data } = await supabase.from('tint_corantes').upsert(
          newCorantes.map(([id, desc]) => ({ account: ACCOUNT, id_corante_sayersystem: id, descricao: desc, volume_total_ml: 1000 })),
          { onConflict: 'account,id_corante_sayersystem' }
        ).select('id, id_corante_sayersystem');
        for (const r of data ?? []) coranteCache.current.set(r.id_corante_sayersystem, r.id);
      }

      const newSubs = Array.from(uniqueSubcolecoes.entries()).filter(([k]) => !subcolecaoCache.current.has(k));
      if (newSubs.length > 0) {
        const { data } = await supabase.from('tint_subcolecoes').upsert(
          newSubs.map(([id, desc]) => ({ account: ACCOUNT, id_subcolecao_sayersystem: id, descricao: desc })),
          { onConflict: 'account,id_subcolecao_sayersystem' }
        ).select('id, id_subcolecao_sayersystem');
        for (const r of data ?? []) subcolecaoCache.current.set(r.id_subcolecao_sayersystem, r.id);
      }

      // Phase 3: Build SKUs
      const skuSet = new Set<string>();
      const skuRows: Array<{ account: string; produto_id: string; base_id: string; embalagem_id: string }> = [];
      for (const cols of batch) {
        const codProduto = cols[7]; const idBase = cols[3]; const idEmbalagem = cols[5];
        const produtoId = produtoCache.current.get(codProduto);
        const baseId = baseCache.current.get(idBase);
        const embalagemId = embalagemCache.current.get(idEmbalagem);
        if (produtoId && baseId && embalagemId) {
          const key = `${produtoId}:${baseId}:${embalagemId}`;
          if (!skuCache.current.has(key) && !skuSet.has(key)) {
            skuSet.add(key);
            skuRows.push({ account: ACCOUNT, produto_id: produtoId, base_id: baseId, embalagem_id: embalagemId });
          }
        }
      }
      if (skuRows.length > 0) {
        const { data } = await supabase.from('tint_skus').upsert(skuRows, { onConflict: 'account,produto_id,base_id,embalagem_id' }).select('id, produto_id, base_id, embalagem_id');
        for (const r of data ?? []) skuCache.current.set(`${r.produto_id}:${r.base_id}:${r.embalagem_id}`, r.id);
      }

      // Phase 4: Process formulas row by row (no unique constraint on tint_formulas)
      type FormulaItem = { corante_id: string; qtd_ml: number; ordem: number };
      const newFormulas: Array<{
        row: {
          account: string; cor_id: string; nome_cor: string; produto_id: string; base_id: string;
          embalagem_id: string; sku_id: string | null; subcolecao_id: string | null; id_seq: number | null;
          volume_final_ml: number | null; preco_final_sayersystem: number | null; data_geracao: string | null;
          personalizada: boolean; importacao_id: string; updated_at: string;
        };
        items: FormulaItem[];
      }> = [];
      const updFormulas: Array<{ id: string; row: Record<string, unknown>; items: FormulaItem[] }> = [];

      for (const cols of batch) {
        try {
          const idSeq = parseInt(cols[0]) || null;
          const corId = cols[1]; const nomeCor = cols[2];
          const idBase = cols[3]; const idEmbalagem = cols[5];
          const codProduto = cols[7];

          if (!corId || !nomeCor) { errors++; continue; }

          const produtoId = produtoCache.current.get(codProduto);
          const baseId = baseCache.current.get(idBase);
          const embalagemId = embalagemCache.current.get(idEmbalagem);
          if (!produtoId || !baseId || !embalagemId) { errors++; continue; }

          const skuKey = `${produtoId}:${baseId}:${embalagemId}`;
          const skuId = skuCache.current.get(skuKey) || null;

          let subcolecaoId: string | null = null;
          if (!personalizada) {
            const subCode = cols[9] || '';
            if (subCode) subcolecaoId = subcolecaoCache.current.get(subCode) || null;
          }

          const coranteStart = 9 + offset;
          const coranteItems: FormulaItem[] = [];
          for (let c = 0; c < 6; c++) {
            const cId = cols[coranteStart + c];
            const qtdStart = coranteStart + 6;
            const qtd = parseBrDecimal(cols[qtdStart + c]);
            if (cId && qtd > 0) {
              const coranteId = coranteCache.current.get(cId);
              if (coranteId) coranteItems.push({ corante_id: coranteId, qtd_ml: qtd, ordem: c + 1 });
            }
          }

          const qtdStart = coranteStart + 6;
          const volumeFinalMl = parseBrDecimal(cols[qtdStart + 6]);
          const precoFinal = parseBrDecimal(cols[qtdStart + 7]);
          const dataGeracao = cols[qtdStart + 8] || null;

          const formulaRow = {
            account: ACCOUNT, cor_id: corId, nome_cor: nomeCor,
            produto_id: produtoId, base_id: baseId, embalagem_id: embalagemId,
            sku_id: skuId, subcolecao_id: subcolecaoId, id_seq: idSeq,
            volume_final_ml: volumeFinalMl || null,
            preco_final_sayersystem: precoFinal || null,
            data_geracao: dataGeracao, personalizada,
            importacao_id: importacaoId,
            updated_at: new Date().toISOString(),
          };

          // Check existence
          let query = supabase.from('tint_formulas').select('id')
            .eq('account', ACCOUNT).eq('cor_id', corId)
            .eq('produto_id', produtoId).eq('base_id', baseId)
            .eq('embalagem_id', embalagemId);
          if (subcolecaoId) query = query.eq('subcolecao_id', subcolecaoId);
          else query = query.is('subcolecao_id', null);

          const { data: existing } = await query.maybeSingle();

          if (existing) {
            updFormulas.push({ id: existing.id, row: formulaRow, items: coranteItems });
            updated++;
          } else {
            newFormulas.push({ row: formulaRow, items: coranteItems });
            imported++;
          }
        } catch (e: any) {
          errors++;
          console.error(`[direct] formula row error:`, e.message);
        }
      }

      // Execute updates
      for (const upd of updFormulas) {
        await supabase.from('tint_formulas').update(upd.row).eq('id', upd.id);
        await supabase.from('tint_formula_itens').delete().eq('formula_id', upd.id);
        if (upd.items.length > 0) {
          await supabase.from('tint_formula_itens').insert(
            upd.items.map(it => ({ formula_id: upd.id, ...it }))
          );
        }
      }

      // Execute inserts in sub-batches of 50
      for (let si = 0; si < newFormulas.length; si += 50) {
        const subBatch = newFormulas.slice(si, si + 50);
        const { data: inserted, error: insErr } = await supabase.from('tint_formulas')
          .insert(subBatch.map(f => f.row)).select('id');
        if (insErr) {
          console.error('[direct] formula insert error:', insErr);
          errors += subBatch.length;
          imported -= subBatch.length;
          continue;
        }
        // Insert formula items
        const allItems: Array<{ formula_id: string; corante_id: string; qtd_ml: number; ordem: number }> = [];
        for (let j = 0; j < (inserted ?? []).length; j++) {
          const formulaId = inserted![j].id;
          for (const it of subBatch[j].items) {
            allItems.push({ formula_id: formulaId, ...it });
          }
        }
        if (allItems.length > 0) {
          const { error: itemErr } = await supabase.from('tint_formula_itens').insert(allItems);
          if (itemErr) console.error('[direct] formula_itens insert error:', itemErr);
        }
      }

      setProgress(prev => prev ? {
        ...prev, currentBatch: b + 1, totalBatches,
        recordsProcessed: Math.min((b + 1) * BATCH_SIZE, rows.length),
        imported, updated, errors,
      } : prev);
    }

    return { imported, updated, errors };
  };

  // ─── Process formulas via RPC (Postgres-native) ───
  const processFormulasRPC = async (rows: string[][], personalizada: boolean, importacaoId: string): Promise<{ imported: number; updated: number; errors: number }> => {
    let imported = 0, updated = 0, errors = 0;
    const offset = personalizada ? 0 : 2;
    const totalBatches = Math.ceil(rows.length / RPC_BATCH_SIZE);

    for (let b = 0; b < totalBatches; b++) {
      if (cancelledRef.current) break;
      const batch = rows.slice(b * RPC_BATCH_SIZE, (b + 1) * RPC_BATCH_SIZE);

      // Map CSV rows to JSON objects for the RPC
      const jsonRows = batch.map(cols => {
        const obj: Record<string, string> = {
          id_seq: cols[0] || '',
          cor_id: cols[1] || '',
          nome_cor: cols[2] || '',
          id_base: cols[3] || '',
          base: cols[4] || '',
          id_embalagem: cols[5] || '',
          embalagem: cols[6] || '',
          cod_produto: cols[7] || '',
          produto: cols[8] || '',
        };

        if (!personalizada) {
          obj.subcolecao = cols[9] || '';
          obj.sub_colecao = cols[10] || '';
        }

        const coranteStart = 9 + offset;
        for (let c = 1; c <= 6; c++) {
          obj[`corante${c}`] = cols[coranteStart + (c - 1)] || '';
        }
        const qtdStart = coranteStart + 6;
        for (let c = 1; c <= 6; c++) {
          const raw = cols[qtdStart + (c - 1)] || '0';
          obj[`qtd${c}ml`] = raw.replace(',', '.');
        }
        obj.volume_finalml = (cols[qtdStart + 6] || '0').replace(',', '.');
        obj.preco_final = (cols[qtdStart + 7] || '0').replace(',', '.');
        obj.data_geracao = cols[qtdStart + 8] || '';
        // Parse embalagem_ml from the volume_finalml or embalagem field
        obj.embalagem_ml = obj.volume_finalml;

        return obj;
      });

      setProgress(prev => prev ? {
        ...prev, phase: `RPC Postgres — Lote ${b + 1} de ${totalBatches}`,
        currentBatch: b + 1, totalBatches,
        recordsProcessed: Math.min((b + 1) * RPC_BATCH_SIZE, rows.length),
        totalRecords: rows.length,
        imported, updated, errors,
      } : prev);

      const MAX_RETRIES = 3;
      let attempt = 0;
      let batchSuccess = false;

      while (attempt < MAX_RETRIES && !batchSuccess) {
        attempt++;
        if (attempt > 1) {
          const delay = Math.min(2000 * Math.pow(2, attempt - 2), 10000);
          console.warn(`[rpc] batch ${b + 1} retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
          setProgress(prev => prev ? {
            ...prev, phase: `RPC Postgres — Lote ${b + 1} de ${totalBatches} (tentativa ${attempt}/${MAX_RETRIES})`,
          } : prev);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        const { data, error } = await supabase.rpc('import_tint_formulas', {
          p_account: ACCOUNT,
          p_personalizada: personalizada,
          p_rows: jsonRows,
        });

        if (error) {
          console.error(`[rpc] batch ${b + 1} attempt ${attempt} error:`, error);
          if (attempt >= MAX_RETRIES) {
            errors += batch.length;
          }
        } else {
          batchSuccess = true;
          if (data) {
            const res = data as unknown as { imported: number; updated: number; errors: number };
            imported += res.imported ?? 0;
            updated += res.updated ?? 0;
            errors += res.errors ?? 0;
          }
        }
      }

      setProgress(prev => prev ? {
        ...prev, imported, updated, errors,
        recordsProcessed: Math.min((b + 1) * RPC_BATCH_SIZE, rows.length),
      } : prev);

    return { imported, updated, errors };
  };

  const runDirectImport = useCallback(async (
    rawText: string,
    fileName: string,
    tipo: string,
    useRpc: boolean = false,
  ): Promise<DirectImportResult> => {
    cancelledRef.current = false;
    setRunning(true);

    const parseResult = Papa.parse<string[]>(rawText, { delimiter: ';', skipEmptyLines: true });
    const dataRows = parseResult.data.slice(1);
    const totalRows = dataRows.length;
    const totalBatches = Math.ceil(totalRows / BATCH_SIZE);

    setProgress({
      phase: 'Preparando caches...', currentBatch: 0, totalBatches,
      recordsProcessed: 0, totalRecords: totalRows,
      imported: 0, updated: 0, errors: 0,
    });

    // Create or reuse import record
    const hash = await sha256(rawText);
    const isFormulaImport = isFormulaImportType(tipo);
    const { data: existingImport } = await supabase.from('tint_importacoes')
      .select('id, status').eq('account', ACCOUNT).eq('arquivo_hash', hash).maybeSingle();

    let importacaoId: string;

    if (existingImport) {
      if (isFormulaImport) {
        const { error: resetError } = await supabase.from('tint_importacoes').update({
          status: 'processando',
          total_registros: totalRows,
          registros_importados: 0,
          registros_atualizados: 0,
          registros_erro: 0,
          erros_detalhe: null,
        }).eq('id', existingImport.id);

        if (resetError) {
          setRunning(false);
          setProgress(null);
          throw new Error(`Erro ao reprocessar importação: ${resetError.message}`);
        }

        importacaoId = existingImport.id;
      } else {
        if (existingImport.status === 'concluido') {
          setRunning(false);
          setProgress(null);
          return { status: 'duplicado', imported: 0, updated: 0, errors: 0, importacaoId: existingImport.id };
        }

        console.log(`[direct-import] Cleaning up old import ${existingImport.id} (status: ${existingImport.status})`);
        await supabase.from('tint_formula_itens').delete().in(
          'formula_id',
          (await supabase.from('tint_formulas').select('id').eq('importacao_id', existingImport.id)).data?.map(f => f.id) ?? []
        );
        await supabase.from('tint_formulas').delete().eq('importacao_id', existingImport.id);
        await supabase.from('tint_importacoes').delete().eq('id', existingImport.id);

        const { data: importacao, error: impErr } = await supabase.from('tint_importacoes').insert({
          account: ACCOUNT, tipo, arquivo_nome: fileName, arquivo_hash: hash,
          status: 'processando', total_registros: totalRows,
        }).select('id').single();

        if (impErr) {
          setRunning(false);
          setProgress(null);
          throw new Error(`Erro ao criar importação: ${impErr.message}`);
        }

        importacaoId = importacao.id;
      }
    } else {
      const { data: importacao, error: impErr } = await supabase.from('tint_importacoes').insert({
        account: ACCOUNT, tipo, arquivo_nome: fileName, arquivo_hash: hash,
        status: 'processando', total_registros: totalRows,
      }).select('id').single();

      if (impErr) {
        setRunning(false);
        setProgress(null);
        throw new Error(`Erro ao criar importação: ${impErr.message}`);
      }

      importacaoId = importacao.id;
    }

    clearCaches();
    await preWarmCaches();

    setProgress(prev => prev ? { ...prev, phase: 'Importando registros...' } : prev);

    let result: { imported: number; updated: number; errors: number };

    switch (tipo) {
      case 'dados_corantes':
        result = await processDadosCorantes(dataRows);
        break;
      case 'dados_produto_base_embalagem':
        result = await processDadosPBE(dataRows);
        break;
      case 'formulas_padrao':
        result = useRpc
          ? await processFormulasRPC(dataRows, false, importacaoId)
          : await processFormulas(dataRows, false, importacaoId);
        break;
      case 'formulas_personalizadas':
        result = useRpc
          ? await processFormulasRPC(dataRows, true, importacaoId)
          : await processFormulas(dataRows, true, importacaoId);
        break;
      default:
        throw new Error(`Tipo inválido: ${tipo}`);
    }

    const finalStatus = result.errors > 0 && result.imported === 0 && result.updated === 0
      ? 'erro' : result.errors > 0 ? 'parcial' : 'concluido';

    await supabase.from('tint_importacoes').update({
      status: finalStatus,
      registros_importados: result.imported,
      registros_atualizados: result.updated,
      registros_erro: result.errors,
    }).eq('id', importacaoId);

    setRunning(false);
    setProgress(prev => prev ? { ...prev, phase: 'Concluído!' } : prev);

    return {
      status: finalStatus as DirectImportResult['status'],
      imported: result.imported,
      updated: result.updated,
      errors: result.errors,
      importacaoId,
    };
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  return { runDirectImport, running, progress, cancel };
}
