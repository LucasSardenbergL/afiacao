/**
 * Lado TS do harness diferencial de paridade city-norm (db/test-city-norm-paridade.sh).
 * Lê o corpus (1 caso cru por linha; linhas '#' e vazias são puladas) e imprime
 * UMA linha por caso: a cidade normalizada por normalizeCityKey, ou ∅ pra null.
 * O lado SQL (route_city_norm) imprime no MESMO formato — diff byte a byte.
 *
 * Uso: bun scripts/city-norm-print.ts db/city-norm-corpus.txt
 */
import { readFileSync } from 'node:fs';
import { normalizeCityKey } from '../src/lib/whatsapp/route-city';

const path = process.argv[2];
if (!path) {
  console.error('uso: bun scripts/city-norm-print.ts <corpus.txt>');
  process.exit(1);
}

// split por \n APENAS (não \r\n — o corpus é LF; um \r entraria como input,
// o que é desejável: o lado SQL receberia o mesmo \r).
const lines = readFileSync(path, 'utf8').split('\n');
for (const line of lines) {
  if (line === '' || line.startsWith('#')) continue;
  const k = normalizeCityKey(line);
  console.log(k?.city ?? '∅');
}
