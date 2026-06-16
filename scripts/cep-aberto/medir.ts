// Runner do gate CEP Aberto (Sub-PR 3, geocoding por CEP). Lê uma amostra (uf,cep)
// e mede COBERTURA (o CEP Aberto tem a coord?) + CONFIABILIDADE (a coord cai na
// cidade certa? — distância ao centróide IBGE do município que a própria API
// reporta, via cidade.ibge → nosso municipio_geo). Nominatim foi descartado como
// referência: não resolve CEP nu brasileiro de forma confiável (devolve lixo).
// Token via env CEP_ABERTO_TOKEN (NÃO commitar). Roda 1× e imprime o relatório.
//   CEP_ABERTO_TOKEN=xxx bun scripts/cep-aberto/medir.ts /tmp/cep-sample.csv /tmp/muni.csv
import { readFileSync, writeFileSync } from 'node:fs';
import { distanciaKm, resumoMedicao, type AmostraMedida } from '../../src/lib/cep/medicao';

const TOKEN = process.env.CEP_ABERTO_TOKEN;
if (!TOKEN) {
  console.error('❌ Falta CEP_ABERTO_TOKEN no env.');
  process.exit(1);
}
const CSV = process.argv[2] ?? '/tmp/cep-sample.csv';
const MUNI = process.argv[3] ?? '/tmp/ibge.csv';
const FORA_KM = 50; // > isso do centróide = provável cidade errada / coord lixo
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Coord = { lat: number; lng: number };

// Centróides IBGE oficiais (codigo_ibge,nome,latitude,longitude,...). Chave = IBGE
// 7 díg, que casa com o cidade.ibge devolvido pela API do CEP Aberto.
const muni = new Map<string, Coord>();
for (const l of readFileSync(MUNI, 'utf8').trim().split('\n').slice(1)) {
  const p = l.split(',');
  if (/^[0-9]{7}$/.test(p[0])) muni.set(p[0], { lat: parseFloat(p[2]), lng: parseFloat(p[3]) });
}

const linhas = readFileSync(CSV, 'utf8')
  .trim()
  .split('\n')
  .map((l) => {
    const [uf, cep] = l.split(',');
    return { uf, cep };
  })
  .filter((l) => /^[0-9]{8}$/.test(l.cep));

async function cepAberto(cep: string): Promise<{ lat: number; lng: number; ibge: string | null } | null | 'erro'> {
  for (let tent = 0; tent < 4; tent++) {
    try {
      const r = await fetch(`https://www.cepaberto.com/api/v3/cep?cep=${cep}`, {
        headers: { Authorization: `Token token=${TOKEN}` },
      });
      if (r.ok) {
        const j = (await r.json()) as { latitude?: string; longitude?: string; cidade?: { ibge?: string } };
        if (j && j.latitude && j.longitude) {
          return { lat: parseFloat(j.latitude), lng: parseFloat(j.longitude), ibge: j.cidade?.ibge ?? null };
        }
        return null; // {} = não coberto
      }
      await sleep(2500); // não-ok (rate limit/transiente) → backoff e re-tenta
    } catch {
      await sleep(1500);
    }
  }
  return 'erro';
}

(async () => {
  const amostras: AmostraMedida[] = [];
  const porUf = new Map<string, { hit: number; miss: number; erro: number }>();
  const raw: string[] = ['uf,cep,status,ibge,dist_centroide_km'];
  let erros = 0;
  let foraCidade = 0;
  let semMuni = 0;
  let i = 0;
  for (const { uf, cep } of linhas) {
    i++;
    const u = porUf.get(uf) ?? { hit: 0, miss: 0, erro: 0 };
    const ca = await cepAberto(cep);
    await sleep(1600); // CEP Aberto rate-limita abaixo de ~1,5s/req
    if (ca === 'erro') {
      u.erro++;
      erros++;
      porUf.set(uf, u);
      raw.push(`${uf},${cep},erro,,`);
      continue;
    }
    if (ca === null) {
      u.miss++;
      porUf.set(uf, u);
      amostras.push({ coberto: false, distanciaKm: null });
      raw.push(`${uf},${cep},miss,,`);
      continue;
    }
    u.hit++;
    porUf.set(uf, u);
    const c = ca.ibge ? muni.get(ca.ibge) : undefined;
    let d: number | null = null;
    if (c) {
      d = distanciaKm(ca.lat, ca.lng, c.lat, c.lng);
      if (d > FORA_KM) foraCidade++;
    } else {
      semMuni++;
    }
    amostras.push({ coberto: true, distanciaKm: d });
    raw.push(`${uf},${cep},hit,${ca.ibge ?? ''},${d != null ? d.toFixed(3) : ''}`);
    if (i % 50 === 0) console.error(`... ${i}/${linhas.length} (hits ${amostras.filter((a) => a.coberto).length})`);
  }

  writeFileSync('/tmp/cep-gate-raw.csv', raw.join('\n'));
  const r = resumoMedicao(amostras);
  const naCidade = r.comReferencia - foraCidade;
  const confPct = r.comReferencia ? Math.round((naCidade / r.comReferencia) * 1000) / 10 : 0;
  console.log('\n=== GATE CEP ABERTO — RESULTADO ===');
  console.log(`Amostra: ${linhas.length} CEPs · ${porUf.size} UFs · erros API: ${erros}`);
  console.log(`COBERTURA: ${r.cobertos}/${r.total} = ${r.coberturaPct}%`);
  console.log(
    `CONFIABILIDADE: ${naCidade}/${r.comReferencia} = ${confPct}% na cidade certa (≤${FORA_KM}km do centróide IBGE) · fora: ${foraCidade} · sem centróide: ${semMuni}`,
  );
  console.log(
    `Distância ao centróide (cobertos c/ ref): mediana ${r.distMedianaKm?.toFixed(2) ?? '—'}km · p90 ${r.distP90Km?.toFixed(2) ?? '—'}km`,
  );
  console.log('\nCobertura por UF (hit/total):');
  [...porUf.entries()].sort().forEach(([uf, c]) => {
    const tot = c.hit + c.miss;
    const pct = tot ? Math.round((c.hit / tot) * 100) : 0;
    console.log(`  ${uf}: ${c.hit}/${tot} = ${pct}%${c.erro ? ` (erro ${c.erro})` : ''}`);
  });
  console.log('\nRaw por CEP em /tmp/cep-gate-raw.csv');
})();
