// Importa a CARTEIRA (1.283 CEPs distintos) no cep_geo via API do CEP Aberto e gera
// um INSERT colável no SQL Editor do Lovable (writes não passam por mim). Decisão A
// do gate (eu + Codex): carteira agora é viável/auditável/money-path; prospects ficam
// no orgânico; bulk completo adiado. precision='postcode_centroid' (CEP-level honesto),
// source='cep_aberto', ON CONFLICT anti-downgrade (idempotente; re-rodável).
//   CEP_ABERTO_TOKEN=xxx bun scripts/cep-aberto/importar-carteira.ts /tmp/carteira-ceps.csv /tmp/carteira-import.sql
import { readFileSync, writeFileSync } from 'node:fs';

const TOKEN = process.env.CEP_ABERTO_TOKEN;
if (!TOKEN) {
  console.error('❌ Falta CEP_ABERTO_TOKEN no env.');
  process.exit(1);
}
const CSV = process.argv[2] ?? '/tmp/carteira-ceps.csv';
const OUT = process.argv[3] ?? '/tmp/carteira-import.sql';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ceps = readFileSync(CSV, 'utf8')
  .trim()
  .split('\n')
  .map((l) => l.trim())
  .filter((c) => /^[0-9]{8}$/.test(c));

async function cepAberto(cep: string): Promise<{ lat: number; lng: number; uf: string } | null | 'erro'> {
  for (let tent = 0; tent < 4; tent++) {
    try {
      const r = await fetch(`https://www.cepaberto.com/api/v3/cep?cep=${cep}`, {
        headers: { Authorization: `Token token=${TOKEN}` },
      });
      if (r.ok) {
        const j = (await r.json()) as { latitude?: string; longitude?: string; estado?: { sigla?: string } };
        if (j && j.latitude && j.longitude) {
          return { lat: parseFloat(j.latitude), lng: parseFloat(j.longitude), uf: (j.estado?.sigla ?? '').toUpperCase() };
        }
        return null; // {} = não coberto
      }
      await sleep(2500); // backoff rate-limit
    } catch {
      await sleep(1500);
    }
  }
  return 'erro';
}

(async () => {
  const rows: string[] = [];
  let hit = 0;
  let miss = 0;
  let erro = 0;
  for (let i = 0; i < ceps.length; i++) {
    const cep = ceps[i];
    const ca = await cepAberto(cep);
    await sleep(1600);
    if (ca === 'erro') {
      erro++;
    } else if (ca === null) {
      miss++;
    } else {
      hit++;
      const uf = /^[A-Z]{2}$/.test(ca.uf) ? `'${ca.uf}'` : 'NULL';
      rows.push(`('${cep}',${ca.lat},${ca.lng},'cep_aberto','postcode_centroid',${uf})`);
    }
    if ((i + 1) % 50 === 0) console.error(`... ${i + 1}/${ceps.length} (hit ${hit} miss ${miss} erro ${erro})`);
  }

  const sql = `-- Carteira import (Sub-PR 3, geocoding por CEP). ${hit} CEPs via CEP Aberto.
-- postcode_centroid honesto, source cep_aberto. Idempotente (anti-downgrade). Colar 1x.
INSERT INTO cep_geo (cep, lat, lng, source, precision, uf) VALUES
${rows.join(',\n')}
ON CONFLICT (cep) DO UPDATE SET
  lat = EXCLUDED.lat, lng = EXCLUDED.lng, source = EXCLUDED.source,
  precision = EXCLUDED.precision, uf = EXCLUDED.uf, updated_at = now()
WHERE rank_precisao(EXCLUDED.precision) >= rank_precisao(cep_geo.precision);

SELECT count(*) AS cep_geo_total, count(*) FILTER (WHERE source='cep_aberto') AS via_cep_aberto FROM cep_geo;
`;
  writeFileSync(OUT, sql);
  console.log(`\n=== CARTEIRA IMPORT — pronto ===`);
  console.log(`CEPs: ${ceps.length} · hit ${hit} · miss ${miss} · erro ${erro}`);
  console.log(`SQL colável: ${OUT} (${(sql.length / 1024).toFixed(0)} KB, ${hit} linhas)`);
})();
