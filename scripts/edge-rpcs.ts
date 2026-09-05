#!/usr/bin/env bun
/**
 * edge-rpcs.ts — PRÉ-FLIGHT de dependências de banco de uma edge, antes do deploy.
 *
 * A receita e a armadilha que a moldaram estão em `docs/agent/deploy.md` §"Deployar uma edge sobe
 * o ARQUIVO INTEIRO da main". Este script é a receita EXECUTÁVEL, e substitui o comando que ela
 * trazia — um `grep -oE "\.rpc\('[a-z_]+'"` sobre o diretório da edge.
 *
 * Aquele comando tinha três cegueiras (medidas no repo em 2026-08-30; o porquê de cada uma está
 * no cabeçalho de `lib/edge-rpcs.ts`): enxergava 16 das 53 RPCs literais do repo, não seguia
 * imports para `_shared/`, e omitia em silêncio toda chamada cujo nome não fosse literal.
 *
 * Uso:
 *   bun run preflight:rpcs <edge> [<edge>...]
 *
 * Exit: 0 = lista COMPLETA · 3 = há indireção, a lista está INCOMPLETA · 1 = erro de execução.
 * O 3 existe para quem automatiza: um 0 sobre uma lista que o extrator SABE estar furada seria o
 * falso verde que este script existe para matar.
 */
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { coletarDaEdge, montarRelatorio } from './lib/edge-rpcs';

export function main(argv: string[]): number {
  if (argv.length === 0) {
    console.error('uso: bun run preflight:rpcs <edge> [<edge>...]');
    return 1;
  }
  let pior = 0;
  for (const edge of argv) {
    try {
      const r = montarRelatorio(edge, coletarDaEdge(edge));
      console.log(r.texto);
      console.log('');
      pior = Math.max(pior, r.codigo);
    } catch (e) {
      // `mensagemDeErro`, não `e instanceof Error ? e.message : String(e)`: para um objeto sem
      // `message` aquele idiom resolve "[object Object]" — um texto que PARECE diagnóstico e não
      // é (classe #1642, gate `erro-object-object`). Aqui o destino é o STDERR de um pré-flight
      // de deploy, então o lixo custa a única pista que o operador teria.
      console.error(`✗ ${edge}: ${mensagemDeErro(e) ?? 'falha sem mensagem utilizável'}`);
      pior = Math.max(pior, 1);
    }
  }
  return pior;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
