import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Guarda textual da sombra da associação NF↔PO na omie-sync-nfes-recebidas. O comportamento está nos testes Deno
// (associacao_test.ts, sombra_test.ts) e na prova PG17 (db/test-recebimento-associacao-sombra.sh); aqui se vigia só
// a LIGAÇÃO: a sombra roda DEPOIS do vínculo NF↔PO e da órfã (nunca os atrasa nem os impede) e publica pela RPC.
const fonte = removerComentarios(
  readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-sync-nfes-recebidas/index.ts'), 'utf8'),
);

describe('omie-sync-nfes-recebidas — sombra da associação', () => {
  it('roda depois do vínculo e da órfã, com o resumo próprio', () => {
    const iVinculo = fonte.indexOf('await updateLinhasDoPedido(');
    const iOrfa = fonte.indexOf('await insertOrfa(supabase, empresa, nfe, m, nIdReceb);');
    const iProcessada = fonte.indexOf('summary.nfes_processadas++;', iOrfa);
    const iSombra = fonte.indexOf('await executarSombra(', iProcessada);
    expect(iVinculo).toBeGreaterThan(0);
    expect(iOrfa).toBeGreaterThan(iVinculo);
    expect(iProcessada).toBeGreaterThan(iOrfa);
    expect(iSombra).toBeGreaterThan(iProcessada);
    expect(fonte.slice(iSombra, iSombra + 400)).toContain('sombraResumo');
    expect(fonte).toMatch(/summary\.sombra = sombraResumo;/);
  });

  it('publica pela RPC com prazo, nunca por escrita direta na tabela', () => {
    expect(fonte).toMatch(/\.rpc\("recebimento_associacao_sombra_publicar", \{ p: linha \}\)\s*\.abortSignal\(/);
    expect(fonte).not.toMatch(/from\("recebimento_associacao_sombra"\)/);
  });
});
