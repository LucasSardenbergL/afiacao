// Emite a saída ESPERADA de `venda_cidades_alvo` e de `route_city_norm`/`private.venda_city_uf` para a
// fixture db/fixtures/venda-cidades-alvo.json, calculada pelo código TS da fila de rota
// (resolvePrepForWorkday / normalizeCityKey). Usado por db/test-venda-gerador.sh (paridade SQL × TS).
// Uso: bun scripts/venda-cidades-alvo-esperado.ts <fixture.json> <saida.json>
import { readFileSync, writeFileSync } from 'node:fs';
import {
  resolvePrepForWorkday,
  type RouteOverrideRow,
  type RouteScheduleRow,
} from '../src/lib/whatsapp/route-schedule';
import { normalizeCityKey } from '../src/lib/whatsapp/route-city';

interface Fixture {
  schedule: RouteScheduleRow[];
  overrides: RouteOverrideRow[];
  workdays: string[];
  cidades_cadastro: string[];
}

const [fixturePath, saidaPath] = process.argv.slice(2);
if (!fixturePath || !saidaPath) {
  console.error('uso: bun scripts/venda-cidades-alvo-esperado.ts <fixture.json> <saida.json>');
  process.exit(2);
}
const fx = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

const alvo = fx.workdays.flatMap((workday) =>
  resolvePrepForWorkday(workday, fx.schedule, fx.overrides).cities.map((c) => ({
    workday,
    city: c.city,
    uf: c.uf,
  })),
);
const cadastro = fx.cidades_cadastro.map((raw) => {
  const k = normalizeCityKey(raw);
  return { raw, city: k?.city ?? null, uf: k?.uf ?? null };
});

if (alvo.length === 0) {
  console.error('oráculo sem nenhuma cidade-alvo — fixture quebrada');
  process.exit(1);
}
writeFileSync(saidaPath, JSON.stringify({ alvo, cadastro }));
console.log(`esperado: ${alvo.length} cidades-alvo em ${fx.workdays.length} dias, ${cadastro.length} cadastros`);
