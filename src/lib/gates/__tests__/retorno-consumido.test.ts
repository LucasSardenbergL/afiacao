import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chamadasQueConsomemRetorno, usosDoRetorno } from '../retorno-consumido';

const CWD = resolve(__dirname, '../../../..');
const read = (rel: string) => readFileSync(resolve(CWD, rel), 'utf8');

describe('retorno-consumido: as formas que CALCULAM E DESCARTAM têm de reprovar', () => {
  // Estas são as sabotagens que ficaram VERDES no gate money-path em 2026-08-25 — a medição que
  // originou este helper. Cada uma chama o helper (o gate antigo casava `nome(` e aprovava) e
  // joga o produto fora.
  // O nome do alvo vai EXPLÍCITO. Extraí-lo do próprio código por regex já foi tentado aqui e é a
  // mesma classe que este arquivo mata: um nome errado casaria zero chamadas, `consumos` daria 0,
  // e o teste passaria VERDE sem nunca ter exercitado o helper. O `it` de sentinela abaixo prova
  // que cada fixture realmente contém a chamada que diz conter.
  const DESCARTES: [string, string, string][] = [
    ['sentença solta', 'buildOwnerMap', 'buildOwnerMap(assignmentsRaw);\nconst ownerMap = new Map();\nuse(ownerMap);'],
    ['solta dentro de bloco', 'skuItemsElegivel', '.filter((n) => { skuItemsElegivel(c.get(n.id), agora); return true; })'],
    ['solta em comparador', 'skuItemsCompararFila', '.sort((a, b) => {\n  skuItemsCompararFila(a, b);\n  return 0;\n});'],
    ['void', 'classificarLoteProof', 'void classificarLoteProof(candidatos, porCodigo, porUser);'],
    ['atribui e IGNORA a variável', 'agregarItensRecebimento', 'const agregados = agregarItensRecebimento(resolvidos);\nfor (const ag of resolvidos) { upsert(ag); }'],
    ['atribui e ignora (const depois)', 'classificarLoteProof', 'const decisoes = classificarLoteProof(x);\nconst mapRows = candidatos.filter(() => true);'],
    ['acumula e descarta', 'acumularUsoCache', 'const acc = null as never;\nacumularUsoCache(acc0, uso);\nreportar(acc);'],
  ];

  for (const [forma, nome, codigo] of DESCARTES) {
    it(`reprova: ${forma}`, () => {
      // Sentinela: sem isto, um fixture que perdesse a chamada passaria por CEGUEIRA (0 de 0).
      expect(usosDoRetorno(codigo, nome), `fixture "${forma}" não contém chamada a ${nome}`).not.toHaveLength(0);
      expect(chamadasQueConsomemRetorno(codigo, nome), `"${forma}" deveria ser 0 consumos`).toBe(0);
    });
  }

  it('reprova a chamada certa que existe SÓ em comentário (o stripper compartilhado é obrigatório)', () => {
    const soComentario = '// const x = decidirIdentidadeSelfService(args);\ndecidirIdentidadeSelfService(args);';
    expect(chamadasQueConsomemRetorno(soComentario, 'decidirIdentidadeSelfService')).toBe(0);
  });
});

describe('retorno-consumido: as formas LEGÍTIMAS medidas no repo têm de aprovar', () => {
  // Enumerar embrulhos reprova código correto, e o conserto disso é sempre afrouxar o gate
  // (#1985). Estas seis formas são TEXTO REAL das edges — se o helper reprovar qualquer uma,
  // ele está errado, não a edge.
  const LEGITIMAS: [string, string, string][] = [
    ['A: atribui e lê', 'agregarItensRecebimento', 'const agregados = agregarItensRecebimento(resolvidos);\nsummary.fundidos += resolvidos.length - agregados.length;'],
    ['B: predicado de .filter', 'skuItemsElegivel', '.filter((n) => skuItemsElegivel(controleMap.get(n.id), agoraMs))'],
    ['C: comparador de .sort multi-linha', 'skuItemsCompararFila', 'const fila = rows.sort((a, b) =>\n  skuItemsCompararFila(\n    { id: a.id },\n    { id: b.id },\n  )\n);'],
    ['D: valor de propriedade', 'resolveOwner', 'decisions.push({\n  farmer_id: resolveOwner(ownerMap, m.customer_user_id, null),\n});'],
    ['E: await atribuído', 'deriveOmieAccountIdentity', 'const ident = await deriveOmieAccountIdentity(supabaseAdmin, { doc });\nawait criarPedidoVenda(ident.codigo_cliente);'],
    ['F: ramo de ternário', 'decidirIdentidadeSelfService', 'const via = temView\n  ? decidirIdentidadeSelfService({ viewRow })\n  : null;\nreturn via;'],
  ];

  for (const [forma, nome, codigo] of LEGITIMAS) {
    it(`aprova ${forma}`, () => {
      expect(chamadasQueConsomemRetorno(codigo, nome), `forma ${forma} reprovada — o gate ficou APERTADO demais`).toBeGreaterThan(0);
    });
  }

  it('aprova uma forma INVENTADA (o gate é posicional, não uma lista de embrulhos)', () => {
    const nova = 'const r = pipe(dados, (d) => classificarLoteProof(d), coletar);\nuse(r);';
    expect(chamadasQueConsomemRetorno(nova, 'classificarLoteProof')).toBeGreaterThan(0);
  });

  it('não confunde a DEFINIÇÃO do helper com uma chamada', () => {
    const def = 'function docsComCodigoAmbiguoNoOmie(regs: Reg[]) {\n  return new Set();\n}';
    expect(usosDoRetorno(def, 'docsComCodigoAmbiguoNoOmie')).toHaveLength(0);
  });
});

describe('retorno-consumido: as edges REAIS de hoje passam (controle da varredura de 2026-08-25)', () => {
  // Sentinela de leitura + prova de que o helper não reprova a `main` íntegra. Se um destes
  // quebrar sem que ninguém tenha mexido no helper, a edge REGREDIU — é o achado, não o ruído.
  const REAIS: [string, string][] = [
    ['supabase/functions/omie-analytics-sync/index.ts', 'classificarLoteProof'],
    ['supabase/functions/omie-analytics-sync/index.ts', 'docsComCodigoAmbiguoNoOmie'],
    ['supabase/functions/ai-ops-agent/index.ts', 'buildOwnerMap'],
    ['supabase/functions/ai-ops-agent/index.ts', 'resolveOwner'],
    ['supabase/functions/omie-sync/index.ts', 'decidirIdentidadeSelfService'],
    ['supabase/functions/omie-sync-sku-items/index.ts', 'skuItemsElegivel'],
    ['supabase/functions/omie-sync-sku-items/index.ts', 'skuItemsCompararFila'],
    ['supabase/functions/omie-sync-sku-items/index.ts', 'agregarItensRecebimento'],
    ['supabase/functions/analyze-unified-order/index.ts', 'acumularUsoCache'],
    ['supabase/functions/omie-vendas-sync/index.ts', 'deriveOmieAccountIdentity'],
  ];

  for (const [arquivo, nome] of REAIS) {
    it(`${nome} entrega o retorno em ${arquivo.split('/')[2]}`, () => {
      expect(chamadasQueConsomemRetorno(read(arquivo), nome)).toBeGreaterThan(0);
    });
  }
});
