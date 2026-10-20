#!/usr/bin/env bun
/**
 * Carga do Radar de Clientes — dump RFB → radar-ingest.
 * Uso: bun scripts/radar/carga.ts --mes 2026-05 [--base-url <url>] [--dry-run] [--conhecidos <csv>]
 *   --conhecidos: CSV (cabeçalho `cnpj`) com os CNPJs conhecidos para extrair a situação cadastral num
 *   dry-run local; sem a edge a lista não existe e a extração é pulada com aviso.
 * Env: RADAR_INGEST_URL (https://<proj>.supabase.co/functions/v1/radar-ingest)
 *      RADAR_CRON_SECRET (valor do CRON_SECRET do Vault)
 * ⚠️ A RFB mudou layout/URLs em jan/2026 — o caminho VIVO (descoberto na 1ª carga,
 * 2026-06-11) é o share Nextcloud público via WebDAV (token público, linkado da
 * página oficial de dados abertos): public.php/webdav/<YYYY-MM>/<arquivo>.
 * O script tenta os candidatos e ABORTA com instrução clara se nenhum responder.
 */
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import {
  montarCnpj, normalizarData, normalizarTelefone, normalizarCapital,
  splitCnaesSecundarios, normalizarTexto, normalizarChaveMunicipio,
} from "../../src/lib/radar/normalizar";
import type { RadarEmpresaRow, RadarMunicipioRow, RadarSituacaoRow } from "./types";
import { mapaDeMotivos, normalizarSituacao } from "./situacao";
import { RFB_SHARE_TOKEN, basesCandidatas, precisaDeAuth } from "./rfb";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") ? "true" : (process.argv[++i] ?? "true"));
}
const MES = args.get("mes") ?? "";
if (!/^\d{4}-\d{2}$/.test(MES)) { console.error("--mes YYYY-MM obrigatório"); process.exit(1); }
const DRY = args.get("dry-run") === "true";
// Share público oficial da RFB (Nextcloud) — token/bases em rfb.ts (compartilhado com mes-alvo.ts).
const URL_BASES = args.get("base-url") ? [args.get("base-url")!] : basesCandidatas(MES);
// WebDAV de share Nextcloud exige basic auth "<token>:" — as outras bases, não.
const authDe = (base: string) => precisaDeAuth(base) ? `-u "${RFB_SHARE_TOKEN}:"` : "";
const INGEST_URL = process.env.RADAR_INGEST_URL ?? "";
const SECRET = process.env.RADAR_CRON_SECRET ?? "";
if (!DRY && (!INGEST_URL || !SECRET)) { console.error("RADAR_INGEST_URL e RADAR_CRON_SECRET obrigatórios (ou use --dry-run)"); process.exit(1); }

// RADAR_WORK_DIR: no runner do GitHub o `/` tem ~14 GB livres e o dump descompactado passa de 20 GB —
// a Action aponta para /mnt (~60 GB). Default local inalterado.
const WORK = process.env.RADAR_WORK_DIR ? `${process.env.RADAR_WORK_DIR}/radar-${MES}` : `/tmp/radar-${MES}`;
mkdirSync(WORK, { recursive: true });
const sh = (cmd: string) => execSync(cmd, { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1024 * 1024 * 64 }).toString();

const post = async (body: unknown) => {
  for (let t = 1; t <= 4; t++) {
    // try/catch cobre rejeição do fetch (rede: ECONNRESET/DNS) — review da 1ª carga:
    // só status HTTP no retry deixava ~527 POSTs sequenciais morrerem no 1º transitório.
    try {
      const res = await fetch(INGEST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-secret": SECRET },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      const txt = await res.text();
      if (t === 4) throw new Error(`POST falhou (${res.status}): ${txt}`);
      console.warn(`tentativa ${t} falhou (${res.status}), retry…`);
    } catch (e) {
      if (t === 4) throw e;
      console.warn(`tentativa ${t} falhou (rede: ${e instanceof Error ? e.message : e}), retry…`);
    }
    await new Promise((r) => setTimeout(r, 800 * 2 ** t));
  }
};

// ── 0. CNPJs conhecidos (radar ∪ clientes): a situação cadastral RFB é extraída para TODOS eles, em
//      qualquer situação (02/03/04/08), e aplicada no finalize (radar_aplicar_situacao). A lista vem da
//      edge (ação cnpjs_conhecidos, keyset) ANTES de ler os zips — é a 2ª condição do scan do passo 3.
//      Edge antiga (sem a ação) → o POST falha alto e a carga aborta: deploy da edge antes da carga.
const CONHECIDOS = `${WORK}/conhecidos.csv`;
let temConhecidos = false;
if (args.get("conhecidos") && args.get("conhecidos") !== "true") {
  copyFileSync(args.get("conhecidos")!, CONHECIDOS);
  temConhecidos = true;
} else if (!DRY) {
  const todos: string[] = [];
  let apos = "";
  for (;;) {
    const r = (await post({ action: "cnpjs_conhecidos", apos, limite: 50000 })) as
      { cnpjs?: string[]; proximo?: string | null } | undefined;
    if (!r?.cnpjs) throw new Error("cnpjs_conhecidos: resposta sem `cnpjs` (edge antiga?) — ausente ≠ vazio, abortando");
    todos.push(...r.cnpjs);
    if (!r.proximo) break;
    apos = r.proximo;
  }
  if (todos.length === 0) throw new Error("cnpjs_conhecidos devolveu 0 CNPJs — radar_empresas vazio? abortando");
  writeFileSync(CONHECIDOS, `cnpj\n${todos.join("\n")}\n`);
  temConhecidos = true;
  console.log(`🧾 CNPJs conhecidos (radar ∪ clientes): ${todos.length}`);
} else {
  console.warn("⚠️ dry-run sem --conhecidos: extração da situação cadastral PULADA (só o filtro por CNAE)");
}
const nConhecidos = temConhecidos ? readFileSync(CONHECIDOS, "utf-8").split("\n").filter((l) => l && l !== "cnpj").length : 0;

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
    sh(`curl -fSL --retry 3 -C - ${authDe(BASE)} -o "${dest}.part" "${BASE}/${nome}" && mv "${dest}.part" "${dest}"`); // atômico: zip parcial nunca vira "completo"
  }
  return dest;
};

// ── 2. Curadoria + validação contra o Cnaes.zip (DV errado = abort) ──────────
const cnaes = readFileSync("scripts/radar/cnaes-alvo.txt", "utf-8").split("\n")
  .map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")[0].trim());
if (cnaes.length === 0) { console.error("cnaes-alvo.txt vazio"); process.exit(1); }
baixar("Cnaes.zip");
sh(`cd ${WORK} && rm -rf cnaes/ && unzip -o -q Cnaes.zip -d cnaes/`);
// duckdb via execFileSync (args em array, SEM shell) — o SQL contém aspas duplas
// (quote='"') e single quotes; string-shell quoting quebrava (1ª carga, 2026-06-11).
// temp_directory no WORK: o spill do DuckDB (sort/join grande) vai por padrão para `.tmp` no cwd —
// no runner do GitHub o cwd é o checkout em `/` (~14 GB livres), não o disco de trabalho.
const duck = (q: string) =>
  execFileSync("duckdb", ["-json", "-c", `SET temp_directory='${WORK}/duck_tmp'; ${q}`], { maxBuffer: 1024 * 1024 * 256 }).toString();
// RADAR_APAGAR_ZIPS=1 (Action): zip consumido é apagado — o cache de resume é o parquet, não o zip.
// Local fica como era (zip retido evita re-download numa carga interrompida).
const APAGAR_ZIPS = process.env.RADAR_APAGAR_ZIPS === "1";

// Saneamento dos CSVs da RFB ANTES do DuckDB (lições da 1ª carga, 2026-06-11):
// 1) encoding real é Windows-1252 COM bytes indefinidos (0x81 etc.) → iconv -c
//    converte pra UTF-8 descartando só os bytes podres (o decoder ICU do DuckDB
//    crasha/decodifica errado; latin-1 estrito rejeita a faixa C1);
// 2) a RFB NÃO escapa aspas internas → linha com nº ÍMPAR de aspas é
//    estruturalmente quebrada (~2 em 7,4M) e faz o parser do DuckDB crashar
//    (assert interno) mesmo com ignore_errors → awk remove e CONTA;
// 3) com o arquivo saneado, o DuckDB roda em modo ESTRITO (sem strict_mode=false/
//    null_padding/ignore_errors — eram essas opções que ativavam o assert).
const sanear = (dir: string) => {
  for (const f of readdirSync(`${WORK}/${dir}`)) {
    const p = `${WORK}/${dir}/${f}`;
    execFileSync("sh", ["-c", `iconv -c -f WINDOWS-1252 -t UTF-8 '${p}' > '${p}.utf8' && mv '${p}.utf8' '${p}'`]);
    execFileSync("touch", [`${p}.ok`]); // awk cria o .ok lazy; entrada vazia não pode estourar o mv
    const impares = execFileSync("awk", [
      `{ n=gsub(/"/,"\\""); if (n%2==0) print > OUT; else c++ } END { print c+0 }`,
      `OUT=${p}.ok`, p,
    ]).toString().trim();
    execFileSync("mv", [`${p}.ok`, p]);
    if (impares !== "0") console.warn(`⚠️ ${dir}/${f}: ${impares} linha(s) com aspas desbalanceadas descartada(s)`);
  }
};

sanear("cnaes");
const catalogoCnae: { c: string; d: string }[] = JSON.parse(duck(
  `SELECT c, d FROM read_csv('${WORK}/cnaes/*', delim=';', header=false, quote='"', all_varchar=true, parallel=false, names=['c','d'])`));
const mapaCnae = new Map(catalogoCnae.map((r) => [r.c, r.d]));
const invalidos = cnaes.filter((c) => !mapaCnae.has(c));
if (invalidos.length) { console.error(`❌ CNAEs fora do catálogo RFB (DV errado?): ${invalidos.join(", ")}`); process.exit(3); }
console.log(`✅ curadoria: ${cnaes.length} CNAEs válidos`);

// ── 3. Estabelecimentos: 10 zips, um por vez → parquet filtrado ──────────────
// Filtro v1 = só CNAE PRINCIPAL (decisão do founder, 2026-06-11): match por
// secundário inflava o universo com atividade acessória (1,17M vs 526k; ex.:
// hospital com serralheria interna). v2 planejada: reintroduzir secundários com
// coluna match_via ('principal'|'secundario') e filtro default na UI.
const inList = cnaes.map((c) => `'${c}'`).join(",");
let usouCache = false;
for (let i = 0; i <= 9; i++) {
  // Parquet existente = cache (resume de carga interrompida). ⚠️ Se a CURADORIA
  // mudou desde a última rodada, apagar ${WORK}/est_filtrado_*.parquet antes —
  // parquet velho não contém CNAE recém-adicionado (o aviso de 0-matches denuncia).
  // Com conhecidos, o cache só vale se os DOIS parquets existem (o da situação nasce no mesmo scan).
  if (existsSync(`${WORK}/est_filtrado_${i}.parquet`) && (!temConhecidos || existsSync(`${WORK}/sit_conhecidos_${i}.parquet`))) {
    console.log(`↩️  Estabelecimentos${i}: parquet em cache, pulando`);
    usouCache = true;
    continue;
  }
  const zip = baixar(`Estabelecimentos${i}.zip`);
  sh(`cd ${WORK} && rm -rf est/ && unzip -o -q ${zip} -d est/`);
  sanear("est");
  // names= explícitos: o auto-naming do DuckDB zero-padda com ≥10 colunas
  // (column00..column29) — columnN cru quebrou na 1ª carga. Layout RFB: 30 colunas.
  // UM scan do CSV (o custo da carga é a leitura), com as duas condições em OR, para uma temp table
  // pequena; dela saem o parquet filtrado (universo prospectável, como antes) e, com conhecidos, o parquet
  // da situação cadastral (cnpj, situacao, dt_sit, motivo) de quem já conhecemos — em QUALQUER situação.
  const filtroUniverso = `situacao = '02' AND cnae1 IN (${inList})`;
  const cnpjExpr = `lpad(b, 8, '0') || lpad(o, 4, '0') || lpad(dv, 2, '0')`;
  const filtroConhecidos = temConhecidos ? `(${cnpjExpr}) IN (SELECT cnpj FROM conhecidos)` : "false";
  duck(`
    ${temConhecidos ? `CREATE TEMP TABLE conhecidos AS SELECT cnpj FROM read_csv('${CONHECIDOS}', delim=',', header=true, all_varchar=true, names=['cnpj']);` : ""}
    CREATE TEMP TABLE scan AS
      SELECT b, o, dv, fantasia, situacao, dt_sit, motivo, dt, cnae1, cnae2, tlog, log, num,
             comp, bai, cep, uf, mun, ddd1, tel1, ddd2, tel2, email
      FROM read_csv('${WORK}/est/*', delim=';', header=false, quote='"',
                    all_varchar=true, parallel=false,
                    names=['b','o','dv','matriz','fantasia','situacao','dt_sit','motivo','cid_ext','pais',
                           'dt','cnae1','cnae2','tlog','log','num','comp','bai','cep','uf',
                           'mun','ddd1','tel1','ddd2','tel2','ddd_fax','fax','email','sit_esp','dt_sit_esp'])
      WHERE (${filtroUniverso}) OR ${filtroConhecidos};
    COPY (
      SELECT b, o, dv, fantasia, dt, cnae1, cnae2, tlog, log, num,
             comp, bai, cep, uf, mun, ddd1, tel1, ddd2, tel2, email
      FROM scan WHERE ${filtroUniverso}
    ) TO '${WORK}/est_filtrado_${i}.parquet' (FORMAT parquet);
    ${temConhecidos ? `COPY (SELECT b, o, dv, situacao, dt_sit, motivo, cnae1 FROM scan WHERE ${filtroConhecidos})
      TO '${WORK}/sit_conhecidos_${i}.parquet' (FORMAT parquet);` : ""}`);
  rmSync(`${WORK}/est/`, { recursive: true, force: true });
  if (APAGAR_ZIPS) rmSync(zip, { force: true });
  console.log(`✅ Estabelecimentos${i} filtrado`);
}

// ── 4. Empresas + Socios: semi-join pelos cnpj_basico filtrados ──────────────
for (let i = 0; i <= 9; i++) baixar(`Empresas${i}.zip`);
for (let i = 0; i <= 9; i++) baixar(`Socios${i}.zip`);
sh(`cd ${WORK} && rm -rf emp/ soc/ && mkdir emp soc && for z in Empresas*.zip; do unzip -o -q $z -d emp/; done && for z in Socios*.zip; do unzip -o -q $z -d soc/; done`);
if (APAGAR_ZIPS) sh(`cd ${WORK} && rm -f Empresas*.zip Socios*.zip`);
sanear("emp"); sanear("soc");
baixar("Municipios.zip");
sh(`cd ${WORK} && rm -rf mun/ && unzip -o -q Municipios.zip -d mun/`);
sanear("mun");
// Motivos.zip (63 pares codigo;descricao): a descrição vai junto da situação, para o motivo do descarte e o e-mail.
let mapaMotivos = new Map<string, string>();
if (temConhecidos) {
  baixar("Motivos.zip");
  sh(`cd ${WORK} && rm -rf mot/ && unzip -o -q Motivos.zip -d mot/`);
  sanear("mot");
  mapaMotivos = mapaDeMotivos(JSON.parse(duck(
    `SELECT c, d FROM read_csv('${WORK}/mot/*', delim=';', header=false, quote='"', all_varchar=true, parallel=false, names=['c','d'])`)));
  if (mapaMotivos.size === 0) { console.error("❌ Motivos.zip sem nenhum motivo legível"); process.exit(5); }
}

duck(`
  CREATE TEMP TABLE est AS SELECT * FROM read_parquet('${WORK}/est_filtrado_*.parquet')
    WHERE cnae1 IN (${inList}); -- re-filtra: parquet em cache pode ter sido gerado por filtro mais largo
  CREATE TEMP TABLE emp AS
    SELECT b, razao, capital, porte
    FROM read_csv('${WORK}/emp/*', delim=';', header=false, quote='"', all_varchar=true, parallel=false,
                  names=['b','razao','natureza','qualif','capital','porte','ente'])
    WHERE b IN (SELECT DISTINCT b FROM est);
  CREATE TEMP TABLE soc AS
    SELECT b, string_agg(nome, '; ') socios
    FROM read_csv('${WORK}/soc/*', delim=';', header=false, quote='"', all_varchar=true, parallel=false,
                  names=['b','tipo','nome','doc','qualif','dt_entrada','pais','rep_cpf','rep_nome','rep_qualif','faixa'])
    WHERE b IN (SELECT DISTINCT b FROM est) GROUP BY b;
  CREATE TEMP TABLE mun AS
    SELECT cod, nome
    FROM read_csv('${WORK}/mun/*', delim=';', header=false, quote='"', all_varchar=true, parallel=false,
                  names=['cod','nome']);
  COPY (SELECT est.*, emp.razao, emp.capital, emp.porte, soc.socios, mun.nome AS mun_nome
        FROM est LEFT JOIN emp ON emp.b = est.b
                 LEFT JOIN soc ON soc.b = est.b
                 LEFT JOIN mun ON mun.cod = est.mun)
  TO '${WORK}/final.jsonl' (FORMAT json)`);

// ── 5. Normalizar (helpers TDD) + relatório por CNAE ──────────────────────────
const brutas = readFileSync(`${WORK}/final.jsonl`, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const porCnae = new Map<string, number>();
const linhas: RadarEmpresaRow[] = [];
// Rejeições LOCAIS contadas por motivo (antes era um `continue` mudo): com o CNPJ alfanumérico
// (RFB jul/2026) e o DV validado em montarCnpj, uma linha fora do formato é sinal, não ruído.
const rejeitadasLocal = { cnpj: 0, cnae: 0 };
for (const r of brutas) {
  const cnpj = montarCnpj(r.b ?? "", r.o ?? "", r.dv ?? "");
  if (!cnpj) { rejeitadasLocal.cnpj++; continue; }
  if (!/^\d{7}$/.test(r.cnae1 ?? "")) { rejeitadasLocal.cnae++; continue; }
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
if (zerados.length && usouCache) {
  console.error(`\u274c CNAEs sem nenhum match (${zerados.join(", ")}) COM parquet em cache: se a curadoria foi ampliada, o cache nao contem o CNAE novo. Apague ${WORK}/est_filtrado_*.parquet e re-rode.`);
  process.exit(4);
}
if (zerados.length) console.warn(`\u26a0\ufe0f CNAEs com 0 matches (conferir): ${zerados.join(", ")}`);

// ── 5b. Situação cadastral dos conhecidos (normalizar + relatório por situação) ──────────────────
const situacoes: RadarSituacaoRow[] = [];
const rejeitadasSituacao = { cnpj: 0, situacao: 0 };
if (temConhecidos) {
  const brutasSit = JSON.parse(duck(`SELECT b, o, dv, situacao, dt_sit, motivo FROM read_parquet('${WORK}/sit_conhecidos_*.parquet')`)) as
    { b?: string; o?: string; dv?: string; situacao?: string; dt_sit?: string; motivo?: string }[];
  const porSituacao = new Map<string, number>();
  for (const r of brutasSit) {
    const n = normalizarSituacao(r, mapaMotivos);
    if (!n.ok) { rejeitadasSituacao[n.motivo]++; continue; }
    situacoes.push(n.linha);
    porSituacao.set(n.linha.situacao, (porSituacao.get(n.linha.situacao) ?? 0) + 1);
  }
  const resumo = [...porSituacao.entries()].sort().map(([k, v]) => `${k}: ${v}`).join(" · ");
  // Ausente ≠ baixa: quem não está no dump fica SEM linha de situação (e sem mudança de estado no finalize).
  console.log(`📇 situação cadastral: ${situacoes.length} de ${nConhecidos} CNPJs conhecidos encontrados no dump (${resumo || "nenhum"}) · ausentes do dump: ${nConhecidos - situacoes.length}`
    + (rejeitadasSituacao.cnpj + rejeitadasSituacao.situacao > 0 ? ` · ⚠️ rejeitadas: ${JSON.stringify(rejeitadasSituacao)}` : ""));
}

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
  `SELECT cod, nome FROM read_csv('${WORK}/mun/*', delim=';', header=false, quote='"', all_varchar=true, parallel=false, names=['cod','nome'])`));
let semLatLng = 0;
const municipios: RadarMunicipioRow[] = municipiosRfb.map((m) => {
  const uf = ufPorMunCodigo.get(m.cod) ?? "";
  const hit = uf ? latPorChave.get(normalizarChaveMunicipio(m.nome, uf)) : undefined;
  if (uf && !hit) semLatLng++;
  return { codigo: m.cod, nome: m.nome, uf, lat: hit?.lat ?? null, lng: hit?.lng ?? null };
}).filter((m) => m.uf); // só municípios que aparecem no nosso universo
console.log(`🗺️  municípios do universo: ${municipios.length} (${semLatLng} sem lat/lng — mapa os ignora)`);

if (DRY) {
  // Relatório LOCAL também no dry-run: a simulação é justamente onde se quer ver o que o dump rejeitaria.
  console.log(`${rejeitadasLocal.cnpj + rejeitadasLocal.cnae > 0 ? "⚠️" : "📋"} rejeições locais: ${JSON.stringify(rejeitadasLocal)}`);
  console.log("🏁 dry-run: nada enviado"); process.exit(0);
}

// ── 7. POST em chunks ─────────────────────────────────────────────────────────
await post({ action: "begin_lote", mes: MES });
for (let i = 0; i < municipios.length; i += 1000)
  await post({ action: "chunk_municipios", mes: MES, linhas: municipios.slice(i, i + 1000) });
// Soma o que a edge descartou (por motivo) e deduplicou — o retorno dos chunks era ignorado.
const descartadasEdge: Record<string, number> = {};
let duplicadasNoChunk = 0;
for (let i = 0; i < linhas.length; i += 1000) {
  const resp = (await post({ action: "chunk", mes: MES, linhas: linhas.slice(i, i + 1000) })) as
    { descartadas?: number; descartadas_por_motivo?: Record<string, number>; duplicadas_no_chunk?: number } | undefined;
  if (resp?.descartadas_por_motivo) {
    for (const [motivo, n] of Object.entries(resp.descartadas_por_motivo)) {
      descartadasEdge[motivo] = (descartadasEdge[motivo] ?? 0) + n;
    }
  } else if (typeof resp?.descartadas === "number" && resp.descartadas > 0) {
    // Edge ANTIGA (< v1.1): só o total. Ausente ≠ zero — entra como não classificado, nunca como 0.
    descartadasEdge.nao_classificado = (descartadasEdge.nao_classificado ?? 0) + resp.descartadas;
  }
  duplicadasNoChunk += resp?.duplicadas_no_chunk ?? 0;
  if ((i / 1000) % 25 === 0) console.log(`… ${i}/${linhas.length}`);
}
const totalRejeitadas = rejeitadasLocal.cnpj + rejeitadasLocal.cnae
  + Object.values(descartadasEdge).reduce((a, b) => a + b, 0);
console.log(`${totalRejeitadas > 0 ? "⚠️" : "📋"} rejeições — local: ${JSON.stringify(rejeitadasLocal)}`
  + ` · edge: ${JSON.stringify(descartadasEdge)} · duplicadas no chunk: ${duplicadasNoChunk}`
  + (totalRejeitadas > 0 ? " — confira antes de confiar no lote (CNPJ fora do formato RFB/DV, CNAE ≠ 7 dígitos)" : ""));
// Situação cadastral dos conhecidos: a edge só grava (radar_situacao_cadastral); quem decide é o finalize.
const descartadasSituacao: Record<string, number> = {};
for (let i = 0; i < situacoes.length; i += 1000) {
  const resp = (await post({ action: "chunk_situacao", mes: MES, linhas: situacoes.slice(i, i + 1000) })) as
    { descartadas_por_motivo?: Record<string, number> } | undefined;
  if (!resp?.descartadas_por_motivo) throw new Error("chunk_situacao: resposta sem `descartadas_por_motivo` (edge antiga?) — abortando");
  for (const [motivo, n] of Object.entries(resp.descartadas_por_motivo)) descartadasSituacao[motivo] = (descartadasSituacao[motivo] ?? 0) + n;
  if ((i / 1000) % 100 === 0) console.log(`… situação ${i}/${situacoes.length}`);
}
if (temConhecidos) {
  const rej = Object.values(descartadasSituacao).reduce((a, b) => a + b, 0);
  console.log(`${rej > 0 ? "⚠️" : "📋"} situação cadastral enviada: ${situacoes.length} linhas · descartadas pela edge: ${JSON.stringify(descartadasSituacao)}`);
}
const fin = (await post({ action: "finalize", mes: MES })) as { situacao?: unknown } | undefined;
console.log(`\n🏁 finalize:`, JSON.stringify(fin));
if (temConhecidos && fin && !("situacao" in fin)) {
  console.warn("⚠️ finalize sem `situacao`: a edge não aplicou radar_aplicar_situacao (edge/migration antigas?) — leads baixados e alerta ao gestor NÃO aconteceram neste lote");
}
