import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Guarda textual da sombra da associação NF↔PO na omie-sync-nfes-recebidas. O comportamento está nos testes Deno
// (associacao_test.ts, sombra_test.ts — inclusive a fase com relógio falso) e na prova PG17
// (db/test-recebimento-associacao-sombra.sh); aqui se vigia só a LIGAÇÃO (Codex 2026-10-17, P1): dentro do laço do
// vínculo a sombra só ENFILEIRA; ela roda numa fase DEPOIS de todas as empresas, e os completeSync de sucesso ficam
// num finally depois dela. Carimbo de leitura ANTES da consulta da NF.
const fonte = removerComentarios(
  readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-sync-nfes-recebidas/index.ts'), 'utf8'),
);

describe('omie-sync-nfes-recebidas — sombra da associação', () => {
  it('no laço do vínculo a sombra só enfileira, depois do vínculo e da órfã', () => {
    const iSync = fonte.indexOf('async function syncEmpresa(');
    const fimSync = fonte.indexOf('\nasync function ', iSync + 10);
    const corpo = fonte.slice(iSync, fimSync);
    expect(iSync).toBeGreaterThan(0);
    expect(corpo).not.toMatch(/executarSombra|executarFaseSombra|criarPortaSombra|lerSkusComEquivalencia/);
    const iOrfa = corpo.indexOf('await insertOrfa(supabase, empresa, nfe, m, nIdReceb);');
    const iFila = corpo.indexOf('filaSombra.push(');
    expect(corpo.indexOf('await updateLinhasDoPedido(')).toBeGreaterThan(0);
    expect(iFila).toBeGreaterThan(iOrfa);
    expect(iOrfa).toBeGreaterThan(0);
  });

  it('carimbo é o da TENTATIVA que trouxe a NF (antes do fetch de cada retry), não o de antes dos retries', () => {
    const iCall = fonte.indexOf('async function callOmie(');
    const iAoTentar = fonte.indexOf('aoTentar?.(new Date().toISOString());', iCall);
    const iFetch = fonte.indexOf('await fetch(OMIE_ENDPOINT', iCall);
    const iLaco = fonte.indexOf('for (let attempt = 0;', iCall);
    expect(iLaco).toBeGreaterThan(iCall);
    expect(iAoTentar).toBeGreaterThan(iLaco);
    expect(iFetch).toBeGreaterThan(iAoTentar);
    expect(fonte).toMatch(/"ConsultarRecebimento", \{ nIdReceb \}, deadline, \(t\) => \{ detalheLidoEm = t; \}\)/);
    expect(fonte).not.toMatch(/const detalheLidoEm = new Date\(\)/);
  });

  it('os POs da fila são capturados ANTES da reconciliação e do backfill (que troca o raw_data do PO)', () => {
    const iSync = fonte.indexOf('s = await syncEmpresa(');
    const iCaptura = fonte.indexOf('await capturarPedidosDaFila(fila,', iSync);
    const iReconc = fonte.indexOf('await reconciliarOrfasEmpresa(', iSync);
    const iBackfill = fonte.indexOf('await backfillRawData(', iSync);
    expect(iCaptura).toBeGreaterThan(iSync);
    expect(iCaptura).toBeLessThan(iReconc);
    expect(iCaptura).toBeLessThan(iBackfill);
  });

  it('a fase roda depois do laço das empresas e antes dos completeSync de sucesso, que ficam no finally', () => {
    const iLaco = fonte.indexOf('for (const empresa of empresas) {');
    const iAdia = fonte.indexOf('aConcluir.push({ empLogId, s, falha: falhaSistemica });');
    const iFase = fonte.indexOf('await executarFaseSombra(');
    const iFinally = fonte.indexOf('} finally {', iFase);
    const iConclui = fonte.indexOf('await completeSync(supabase, c.empLogId', iFinally);
    expect(iLaco).toBeGreaterThan(0);
    expect(iAdia).toBeGreaterThan(iLaco);
    expect(iFase).toBeGreaterThan(iAdia);
    expect(iFinally).toBeGreaterThan(iFase);
    expect(iConclui).toBeGreaterThan(iFinally);
    expect(fonte).not.toMatch(/await completeSync\(supabase, empLogId, s as unknown/);
  });

  it('publica pela RPC com prazo, nunca por escrita direta na tabela', () => {
    expect(fonte).toMatch(/\.rpc\("recebimento_associacao_sombra_publicar", \{ p: linha \}\)\s*\.abortSignal\(/);
    expect(fonte).not.toMatch(/from\("recebimento_associacao_sombra"\)/);
  });
});
