#!/usr/bin/env bun
/**
 * Carga do Radar de Clientes — dump RFB → radar-ingest.
 * Uso: bun scripts/radar/carga.ts --mes 2026-05 [--base-url <url>] [--dry-run] [--so-municipios]
 * Env: RADAR_INGEST_URL (https://<proj>.supabase.co/functions/v1/radar-ingest)
 *      RADAR_CRON_SECRET (valor do CRON_SECRET do Vault)
 * ⚠️ A RFB mudou layout/URLs em jan/2026 — o caminho VIVO (descoberto na 1ª carga,
 * 2026-06-11) é o share Nextcloud público via WebDAV (token público, linkado da
 * página oficial de dados abertos): public.php/webdav/<YYYY-MM>/<arquivo>.
 * O script tenta os candidatos e ABORTA com instrução clara se nenhum responder.
 */
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import {
  montarCnpj, normalizarData, normalizarTelefone, normalizarCapital,
  splitCnaesSecundarios, normalizarTexto, normalizarChaveMunicipio,
} from "../../src/lib/radar/normalizar";
import type { RadarEmpresaRow, RadarMunicipioRow } from "../../src/lib/radar/types";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") ? "true" : (process.argv[++i] ?? "true"));
}
const MES = args.get("mes") ?? "";
if (!/^\d{4}-\d{2}$/.test(MES)) { console.error("--mes YYYY-MM obrigatório"); process.exit(1); }
const DRY = args.get("dry-run") === "true";
// Share público oficial da RFB (Nextcloud). O token identifica o SHARE público,
// não é credencial — é o mesmo link aberto da página de dados abertos do gov.br.
const RFB_SHARE_TOKEN = "YggdBLfdninEJX9";
const URL_BASES = args.get("base-url") ? [args.get("base-url")!] : [
  `https://arquivos.receitafederal.gov.br/public.php/webdav/${MES}`,
  `https://arquivos.receitafederal.gov.br/dados/cnpj/dados_abertos_cnpj/${MES}`,
  `https://dadosabertos.rfb.gov.br/CNPJ/dados_abertos_cnpj/${MES}`,
];
// WebDAV de share Nextcloud exige basic auth "<token>:" — as outras bases, não.
const authDe = (base: string) => base.includes("public.php/webdav") ? `-u "${RFB_SHARE_TOKEN}:"` : "";
const INGEST_URL = process.env.RADAR_INGEST_URL ?? "";
const SECRET = process.env.RADAR_CRON_SECRET ?? "";
if (!DRY && (!INGEST_URL || !SECRET)) { console.error("RADAR_INGEST_URL e RADAR_CRON_SECRET obrigatórios (ou use --dry-run)"); process.exit(1); }

const WORK = `/tmp/radar-${MES}`;
mkdirSync(WORK, { recursive: true });
const sh = (cmd: string) => execSync(cmd, { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1024 * 1024 * 64 }).toString();

// ── 1. Descobrir base URL viva (HEAD no Cnaes.zip, arquivo pequeno) ──────────
let BASE = "";
for (const cand of URL_BASES) {
  try {
    const code = sh(`curl -s -o /dev/null -w '%{http_code}' --max-time 30 -I ${authDe(cand)} "${cand}/Cnaes.zip"`).trim();
    if (code === "200") { BASE = cand; break; }
    console.log(`candidato ${cand} → HTTP ${code}`);
  } catch { /* tenta o próximo */ }
}
if (!BASE) {
  console.error(`\n❌ Nenhuma URL candidata respondeu para ${MES}.\n` +
    `Descubra o caminho atual em https://www.gov.br/receitafederal/pt-br/acesso-a-informacao/dados-abertos\n` +
    `e re-rode com --base-url <url-da-pasta-do-mes>.`);
  process.exit(2);
}
console.log(`✅ base: ${BASE}`);

const baixar = (nome: string) => {
  const dest = `${WORK}/${nome}`;
  if (!existsSync(dest)) {
    console.log(`⬇️  ${nome}`);
    sh(`curl -fSL --retry 3 -C - ${authDe(BASE)} -o "${dest}" "${BASE}/${nome}"`);
  }
  return dest;
};

// ── 2. Curadoria + validação contra o Cnaes.zip (DV errado = abort) ──────────
const cnaes = readFileSync("scripts/radar/cnaes-alvo.txt", "utf-8").split("\n")
  .map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")[0].trim());
if (cnaes.length === 0) { console.error("cnaes-alvo.txt vazio"); process.exit(1); }
baixar("Cnaes.zip");
sh(`cd ${WORK} && unzip -o -q Cnaes.zip -d cnaes/`);
// duckdb via execFileSync (args em array, SEM shell) — o SQL contém aspas duplas
// (quote='"') e single quotes; string-shell quoting quebrava (1ª carga, 2026-06-11).
const duck = (q: string) =>
  execFileSync("duckdb", ["-json", "-c", q], { maxBuffer: 1024 * 1024 * 256 }).toString();
const catalogoCnae: { c: string; d: string }[] = JSON.parse(duck(
  `SELECT column0 AS c, column1 AS d FROM read_csv('${WORK}/cnaes/*', delim=';', header=false, quote='"', encoding='latin-1', all_varchar=true)`));
const mapaCnae = new Map(catalogoCnae.map((r) => [r.c, r.d]));
const invalidos = cnaes.filter((c) => !mapaCnae.has(c));
if (invalidos.length) { console.error(`❌ CNAEs fora do catálogo RFB (DV errado?): ${invalidos.join(", ")}`); process.exit(3); }
console.log(`✅ curadoria: ${cnaes.length} CNAEs válidos`);

// ── 3. Estabelecimentos: 10 zips, um por vez → parquet filtrado ──────────────
const inList = cnaes.map((c) => `'${c}'`).join(",");
const secRegex = cnaes.join("|");
for (let i = 0; i <= 9; i++) {
  const zip = baixar(`Estabelecimentos${i}.zip`);
  sh(`cd ${WORK} && rm -rf est/ && unzip -o -q ${zip} -d est/`);
  duck(`COPY (
      SELECT column0 b, column1 o, column2 dv, column4 fantasia, column10 dt,
             column11 cnae1, column12 cnae2, column13 tlog, column14 log, column15 num,
             column16 comp, column17 bai, column18 cep, column19 uf, column20 mun,
             column21 ddd1, column22 tel1, column23 ddd2, column24 tel2, column27 email
      FROM read_csv('${WORK}/est/*', delim=';', header=false, quote='"',
                    encoding='latin-1', all_varchar=true, strict_mode=false)
      WHERE column5 = '02' AND (column11 IN (${inList}) OR regexp_matches(coalesce(column12,''), '(${secRegex})'))
    ) TO '${WORK}/est_filtrado_${i}.parquet' (FORMAT parquet)`);
  rmSync(`${WORK}/est/`, { recursive: true, force: true });
  console.log(`✅ Estabelecimentos${i} filtrado`);
}

// ── 4. Empresas + Socios: semi-join pelos cnpj_basico filtrados ──────────────
for (let i = 0; i <= 9; i++) baixar(`Empresas${i}.zip`);
for (let i = 0; i <= 9; i++) baixar(`Socios${i}.zip`);
sh(`cd ${WORK} && rm -rf emp/ soc/ && mkdir emp soc && for z in Empresas*.zip; do unzip -o -q $z -d emp/; done && for z in Socios*.zip; do unzip -o -q $z -d soc/; done`);
baixar("Municipios.zip");
sh(`cd ${WORK} && unzip -o -q Municipios.zip -d mun/`);

duck(`
  CREATE TEMP TABLE est AS SELECT * FROM read_parquet('${WORK}/est_filtrado_*.parquet');
  CREATE TEMP TABLE emp AS
    SELECT column0 b, column1 razao, column4 capital, column5 porte
    FROM read_csv('${WORK}/emp/*', delim=';', header=false, quote='"', encoding='latin-1', all_varchar=true, strict_mode=false)
    WHERE column0 IN (SELECT DISTINCT b FROM est);
  CREATE TEMP TABLE soc AS
    SELECT column0 b, string_agg(column2, '; ') socios
    FROM read_csv('${WORK}/soc/*', delim=';', header=false, quote='"', encoding='latin-1', all_varchar=true, strict_mode=false)
    WHERE column0 IN (SELECT DISTINCT b FROM est) GROUP BY column0;
  CREATE TEMP TABLE mun AS
    SELECT column0 cod, column1 nome
    FROM read_csv('${WORK}/mun/*', delim=';', header=false, quote='"', encoding='latin-1', all_varchar=true);
  COPY (SELECT est.*, emp.razao, emp.capital, emp.porte, soc.socios, mun.nome AS mun_nome
        FROM est LEFT JOIN emp ON emp.b = est.b
                 LEFT JOIN soc ON soc.b = est.b
                 LEFT JOIN mun ON mun.cod = est.mun)
  TO '${WORK}/final.jsonl' (FORMAT json)`);

// ── 5. Normalizar (helpers TDD) + relatório por CNAE ──────────────────────────
const brutas = readFileSync(`${WORK}/final.jsonl`, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const porCnae = new Map<string, number>();
const linhas: RadarEmpresaRow[] = [];
for (const r of brutas) {
  const cnpj = montarCnpj(r.b ?? "", r.o ?? "", r.dv ?? "");
  if (!cnpj || !/^\d{7}$/.test(r.cnae1 ?? "")) continue;
  porCnae.set(r.cnae1, (porCnae.get(r.cnae1) ?? 0) + 1);
  linhas.push({
    cnpj,
    razao_social: normalizarTexto(r.razao), nome_fantasia: normalizarTexto(r.fantasia),
    cnae_principal: r.cnae1, cnae_descricao: mapaCnae.get(r.cnae1) ?? null,
    cnaes_secundarios: splitCnaesSecundarios(r.cnae2 ?? ""),
    data_abertura: normalizarData(r.dt ?? ""), porte: normalizarTexto(r.porte),
    capital_social: normalizarCapital(r.capital ?? ""),
    logradouro: normalizarTexto([r.tlog, r.log].filter(Boolean).join(" ")),
    numero: normalizarTexto(r.num), complemento: normalizarTexto(r.comp),
    bairro: normalizarTexto(r.bai), municipio_codigo: normalizarTexto(r.mun),
    municipio_nome: normalizarTexto(r.mun_nome), uf: normalizarTexto(r.uf),
    cep: normalizarTexto(r.cep),
    telefone1: normalizarTelefone(r.ddd1 ?? "", r.tel1 ?? ""),
    telefone2: normalizarTelefone(r.ddd2 ?? "", r.tel2 ?? ""),
    email: normalizarTexto(r.email)?.toLowerCase() ?? null,
    socios_nomes: normalizarTexto(r.socios),
  });
}
console.log(`\n📊 ${linhas.length} empresas após filtro/normalização`);
for (const [c, n] of [...porCnae.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`   ${c}  ${String(n).padStart(7)}  ${mapaCnae.get(c)?.slice(0, 60) ?? ""}`);
const zerados = cnaes.filter((c) => !porCnae.has(c));
if (zerados.length) console.warn(`⚠️ CNAEs com 0 matches (conferir): ${zerados.join(", ")}`);

// ── 6. Municípios RFB + lat/lng IBGE (casamento por nome normalizado) ─────────
const ibge = readFileSync("scripts/radar/municipios-ibge.csv", "utf-8").split("\n").slice(1).filter(Boolean);
const UF_POR_CODIGO: Record<string, string> = { "11":"RO","12":"AC","13":"AM","14":"RR","15":"PA","16":"AP","17":"TO","21":"MA","22":"PI","23":"CE","24":"RN","25":"PB","26":"PE","27":"AL","28":"SE","29":"BA","31":"MG","32":"ES","33":"RJ","35":"SP","41":"PR","42":"SC","43":"RS","50":"MS","51":"MT","52":"GO","53":"DF" };
const latPorChave = new Map<string, { lat: number; lng: number }>();
for (const l of ibge) {
  const [_, nome, lat, lng, , uf_cod] = l.split(","); // codigo_ibge,nome,latitude,longitude,capital,codigo_uf,siafi_id
  const uf = UF_POR_CODIGO[uf_cod?.trim() ?? ""] ?? "";
  if (nome && uf) latPorChave.set(normalizarChaveMunicipio(nome, uf), { lat: +lat, lng: +lng });
}
const ufPorMunCodigo = new Map<string, string>();
for (const r of linhas) if (r.municipio_codigo && r.uf) ufPorMunCodigo.set(r.municipio_codigo, r.uf);
const municipiosRfb: { cod: string; nome: string }[] = JSON.parse(duck(
  `SELECT column0 cod, column1 nome FROM read_csv('${WORK}/mun/*', delim=';', header=false, quote='"', encoding='latin-1', all_varchar=true)`));
let semLatLng = 0;
const municipios: RadarMunicipioRow[] = municipiosRfb.map((m) => {
  const uf = ufPorMunCodigo.get(m.cod) ?? "";
  const hit = uf ? latPorChave.get(normalizarChaveMunicipio(m.nome, uf)) : undefined;
  if (uf && !hit) semLatLng++;
  return { codigo: m.cod, nome: m.nome, uf, lat: hit?.lat ?? null, lng: hit?.lng ?? null };
}).filter((m) => m.uf); // só municípios que aparecem no nosso universo
console.log(`🗺️  municípios do universo: ${municipios.length} (${semLatLng} sem lat/lng — mapa os ignora)`);

if (DRY) { console.log("🏁 dry-run: nada enviado"); process.exit(0); }

// ── 7. POST em chunks ─────────────────────────────────────────────────────────
const post = async (body: unknown) => {
  for (let t = 1; t <= 4; t++) {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": SECRET },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const txt = await res.text();
    if (t === 4) throw new Error(`POST falhou (${res.status}): ${txt}`);
    console.warn(`tentativa ${t} falhou (${res.status}), retry…`);
    await new Promise((r) => setTimeout(r, 800 * 2 ** t));
  }
};
await post({ action: "begin_lote", mes: MES });
for (let i = 0; i < municipios.length; i += 1000)
  await post({ action: "chunk_municipios", mes: MES, linhas: municipios.slice(i, i + 1000) });
for (let i = 0; i < linhas.length; i += 1000) {
  await post({ action: "chunk", mes: MES, linhas: linhas.slice(i, i + 1000) });
  if ((i / 1000) % 25 === 0) console.log(`… ${i}/${linhas.length}`);
}
const fin = await post({ action: "finalize", mes: MES });
console.log(`\n🏁 finalize:`, JSON.stringify(fin));
