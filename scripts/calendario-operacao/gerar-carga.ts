#!/usr/bin/env bun
/**
 * Gerador da carga inicial 2025–2030 do calendário de operação (Etapa 1, Task 2).
 * Spec: docs/superpowers/specs/2026-11-18-calendario-operacao-design.md §4, §4.1, §4.2.
 *
 * Puro (gerarCarga/pascoa) + CLI (`bun scripts/calendario-operacao/gerar-carga.ts`) que escreve
 * db/carga-calendario-operacao-2025-2030.sql. O SQL é commitado; regerar muda o diff, nunca o banco.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Empresa = 'OBEN' | 'COLACOR';
export type Status = 'aberto' | 'fechado' | 'meia_equipe' | 'pendente_dado';
export type Origem = 'historico' | 'escala' | 'feriado' | 'emenda' | 'manual';

export interface LinhaEmpresa { data: string; empresa: Empresa; status: Status; peso: number; motivo: string; origem: Origem }
export interface LinhaFornecedor { data: string; empresa: Empresa; fornecedor_nome: string; motivo: string; origem: Origem }
export interface LinhaFeriado { data: string; nome: string; tipo: 'nacional'; observacoes: string }

/** Razão social exata de fornecedor_habilitado_reposicao (psql-ro, 2026-11-18; só a OBEN tem habilitados). */
export const SAYERLACK = 'RENNER SAYERLACK S/A';
export const FORNECEDORES_NAO_SAYERLACK = [
  'ACRE CAXIAS IND. E COM. DE ABRASIVOS LTDA',
  'ALLPARTS INDUSTRIA E COMERCIO DE ARTEFATOS LTDA',
  'BAUNGARTEN INDUSTRIA E COMERCIO LTDA',
  'MASTERCOL INDUSTRIA E COMERCIO LTDA',
  'NORQUIMA PRODUTOS QUIMICOS LTDA',
  'SAINT-GOBAIN DO BRASIL PRODUTOS INDUSTRIAIS E PARA CONSTRUCA',
];

const EMPRESAS: Empresa[] = ['OBEN', 'COLACOR'];
const MS_DIA = 86_400_000;
const p2 = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
const dt = (s: string) => new Date(`${s}T12:00:00Z`);
const soma = (s: string, n: number) => iso(new Date(dt(s).getTime() + n * MS_DIA));
const fimDeSemana = (s: string) => [0, 6].includes(dt(s).getUTCDay());
const dmy = (ano: number, d: string) => `${ano}-${d.slice(3, 5)}-${d.slice(0, 2)}`; // 'DD/MM' -> ISO

/** Domingo de Páscoa (algoritmo gregoriano anônimo), 'YYYY-MM-DD'. */
export function pascoa(ano: number): string {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${ano}-${p2(mes)}-${p2(dia)}`;
}

function intervalo(ini: string, fim: string): string[] {
  const r: string[] = [];
  for (let d = ini; d <= fim; d = soma(d, 1)) r.push(d);
  return r;
}

interface Nacional { data: string; nome: string }
function nacionais(ano: number): Nacional[] {
  const p = pascoa(ano);
  return [
    { data: `${ano}-01-01`, nome: 'Confraternização Universal' },
    { data: soma(p, -2), nome: 'Sexta-feira Santa' },
    { data: `${ano}-04-21`, nome: 'Tiradentes' },
    { data: `${ano}-05-01`, nome: 'Dia do Trabalho' },
    { data: `${ano}-09-07`, nome: 'Independência do Brasil' },
    { data: `${ano}-10-12`, nome: 'Nossa Senhora Aparecida' },
    { data: `${ano}-11-02`, nome: 'Finados' },
    { data: `${ano}-11-15`, nome: 'Proclamação da República' },
    { data: `${ano}-11-20`, nome: 'Consciência Negra' },
    { data: `${ano}-12-25`, nome: 'Natal' },
  ];
}

// Precedência quando duas regras caem no mesmo (data, empresa): menor número vence.
const PREC: Record<Origem, number> = { historico: 0, manual: 1, escala: 2, emenda: 3, feriado: 4 };

export function gerarCarga(fornecedoresNaoSayerlack: string[]) {
  type Cand = { data: string; status: Status; peso: number; motivo: string; origem: Origem; soOben?: boolean };
  const cands: Cand[] = [];
  const add = (data: string, status: Status, motivo: string, origem: Origem, soOben = false) => {
    if (fimDeSemana(data)) return;
    cands.push({ data, status, peso: status === 'fechado' ? 0 : 1, motivo, origem, soOben });
  };
  const fechar = (datas: string[], motivo: string, origem: Origem) => datas.forEach((d) => add(d, 'fechado', motivo, origem));

  // ── historico (fato observado, §4.1/§4.2) ──
  fechar(intervalo('2025-12-22', '2026-01-02'), 'Recesso de fim de ano 2025', 'historico');
  fechar(intervalo('2026-02-16', '2026-02-18'), 'Carnaval 2026 (a empresa parou)', 'historico');
  const histNac = [...nacionais(2025), ...nacionais(2026)];
  for (const n of histNac) {
    if (n.data < '2025-10-21' || n.data > '2026-11-18') continue;
    if (n.data === '2025-11-20') add(n.data, 'aberto', 'Consciência Negra 2025: loja operou (12 NFs)', 'historico');
    else add(n.data, 'fechado', `Feriado nacional: ${n.nome}`, 'historico');
  }
  add(soma(pascoa(2026), 60), 'fechado', 'Corpus Christi 2026 (municipal, Lei 744/1967)', 'historico');
  add('2025-11-21', 'fechado', 'Ponte do feriado de 20/11/2025', 'historico');
  add('2026-04-20', 'fechado', 'Ponte do feriado de 21/04/2026', 'historico');
  add('2026-06-05', 'fechado', 'Ponte do Corpus Christi 2026', 'historico');
  add('2025-12-08', 'fechado', 'Imaculada Conceição (municipal, Lei 744/1967)', 'historico');
  add('2026-06-01', 'fechado', 'São Firmino (municipal, Lei 744/1967)', 'historico');
  for (const d of ['11', '15', '18', '19', '20', '22', '29'])
    add(`2026-05-${d}`, 'pendente_dado', 'Dia útil sem NF sem explicação: pendente de decisão do founder', 'historico', true);

  // ── manual ──
  add('2026-11-20', 'fechado', 'Consciência Negra 2026 (decisão do founder)', 'manual');
  fechar(intervalo('2026-12-18', '2027-01-03'), 'Recesso de fim de ano 2026', 'manual');

  // ── feriados 2027–2030 (nacionais + Corpus + municipais Divinópolis) e 2026 municipal ──
  add('2026-12-08', 'fechado', 'Imaculada Conceição (municipal, Lei 744/1967)', 'feriado');
  for (let ano = 2027; ano <= 2030; ano++) {
    for (const n of nacionais(ano)) add(n.data, 'fechado', `Feriado nacional: ${n.nome}`, 'feriado');
    add(soma(pascoa(ano), 60), 'fechado', 'Corpus Christi (municipal, Lei 744/1967)', 'feriado');
  }
  for (let ano = 2027; ano <= 2030; ano++) {
    add(`${ano}-06-01`, 'fechado', 'São Firmino (municipal, Lei 744/1967)', 'feriado');
    add(`${ano}-12-08`, 'fechado', 'Imaculada Conceição (municipal, Lei 744/1967)', 'feriado');
  }

  // ── emendas ──
  const emendas: Record<number, string[]> = {
    2026: ['07/12'],
    2027: ['28/05', '31/05', '06/09', '11/10', '01/11'],
    2028: ['16/06', '02/06', '08/09', '13/10', '03/11'],
    2029: ['30/04', '01/06', '16/11', '19/11'],
    2030: ['21/06'],
  };
  for (const [ano, ds] of Object.entries(emendas))
    for (const d of ds) add(dmy(Number(ano), d), 'fechado', 'Emenda (ponte) de feriado', 'emenda');

  // ── escala 2027–2030 (PDF escala-ferias-2027-2030) ──
  const fimDeAno: [string, string][] = [
    ['2027-12-22', '2028-01-04'], ['2028-12-19', '2029-01-01'], ['2029-12-19', '2030-01-01'], ['2030-12-19', '2031-01-01'],
  ];
  for (const [i, f] of fimDeAno) fechar(intervalo(i, f), 'Fim de ano: escala de férias coletivas', 'escala');
  const meia: Record<number, [string, string][]> = {
    2027: [['02-01', '02-11'], ['02-15', '02-25'], ['03-22', '03-26'], ['03-15', '03-19']],
    2028: [['02-21', '03-02'], ['03-06', '03-16'], ['04-10', '04-14'], ['04-03', '04-07']],
    2029: [['02-05', '02-15'], ['02-19', '03-01'], ['03-26', '03-30'], ['03-19', '03-23']],
    2030: [['02-25', '03-07'], ['03-11', '03-21'], ['04-15', '04-19'], ['04-08', '04-12']],
  };
  // Dia que já é feriado/emenda fechado (ex.: Sexta Santa) não vira meia_equipe: a janela só cobre dias de loja aberta.
  const fechadoPorFeriado = new Set(cands.filter((c) => c.origem === 'feriado' || c.origem === 'emenda').map((c) => c.data));
  for (const [ano, js] of Object.entries(meia))
    for (const [i, f] of js)
      for (const d of intervalo(`${ano}-${i}`, `${ano}-${f}`))
        if (!fechadoPorFeriado.has(d)) add(d, 'meia_equipe', 'Escala de meia equipe (Carnaval/Semana Santa)', 'escala');

  // ── consolida por (data, empresa) pela precedência ──
  const mapa = new Map<string, LinhaEmpresa>();
  for (const c of cands) {
    for (const empresa of EMPRESAS) {
      if (c.soOben && empresa !== 'OBEN') continue;
      const k = `${c.data}|${empresa}`;
      const atual = mapa.get(k);
      if (atual && PREC[atual.origem] <= PREC[c.origem]) continue;
      mapa.set(k, { data: c.data, empresa, status: c.status, peso: c.peso, motivo: c.motivo, origem: c.origem });
    }
  }
  const empresa = [...mapa.values()].sort((a, b) => a.data.localeCompare(b.data) || a.empresa.localeCompare(b.empresa));

  // ── fornecedores ──
  const forn = new Map<string, LinhaFornecedor>();
  const addF = (data: string, emp: Empresa, nome: string, motivo: string) => {
    if (fimDeSemana(data)) return;
    forn.set(`${data}|${emp}|${nome}`, { data, empresa: emp, fornecedor_nome: nome, motivo, origem: 'feriado' });
  };
  for (const emp of EMPRESAS) {
    for (let ano = 2026; ano <= 2030; ano++) {
      addF(`${ano}-12-25`, emp, SAYERLACK, 'Sayerlack fecha em 25/12');
      addF(`${ano + 1}-01-01`, emp, SAYERLACK, 'Sayerlack fecha em 01/01');
      for (const nome of fornecedoresNaoSayerlack)
        for (const d of intervalo(`${ano}-12-21`, `${ano + 1}-01-03`)) addF(d, emp, nome, 'Fornecedor fecha de 21/12 a 03/01');
    }
  }
  const fornecedor = [...forn.values()].sort(
    (a, b) => a.data.localeCompare(b.data) || a.empresa.localeCompare(b.empresa) || a.fornecedor_nome.localeCompare(b.fornecedor_nome),
  );

  const feriadosNacionais: LinhaFeriado[] = [];
  for (let ano = 2027; ano <= 2030; ano++)
    for (const n of nacionais(ano)) feriadosNacionais.push({ data: n.data, nome: n.nome, tipo: 'nacional', observacoes: 'Carga calendario-operacao 2027-2030' });
  feriadosNacionais.sort((a, b) => a.data.localeCompare(b.data));

  return { empresa, fornecedor, feriadosNacionais };
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function gerarSql(c: ReturnType<typeof gerarCarga>): string {
  const emp = c.empresa.map((l) => `  (${q(l.data)}, ${q(l.empresa)}, ${q(l.status)}, ${l.peso}, ${q(l.motivo)}, ${q(l.origem)})`).join(',\n');
  const forn = c.fornecedor.map((l) => `  (${q(l.data)}, ${q(l.empresa)}, ${q(l.fornecedor_nome)}, ${q(l.motivo)}, ${q(l.origem)})`).join(',\n');
  const fer = c.feriadosNacionais.map((l) => `  (${q(l.data)}, ${q(l.nome)}, ${q(l.tipo)}, ${q(l.observacoes)})`).join(',\n');
  const porOrigem = new Map<string, number>();
  for (const l of c.empresa) porOrigem.set(`${l.origem}/${l.empresa}`, (porOrigem.get(`${l.origem}/${l.empresa}`) ?? 0) + 1);
  const esperadoOrigem = [...porOrigem.entries()].sort().map(([k, n]) => { const [o, e] = k.split('/'); return `    (${q(o)}, ${q(e)}, ${n})`; }).join(',\n');
  const resumo = [...porOrigem.entries()].sort().map(([k, n]) => `--   ${k}: ${n}`).join('\n');
  return `-- Carga inicial 2025–2030 do calendário de operação (Etapa 1, Task 2). GERADO por
-- scripts/calendario-operacao/gerar-carga.ts — não edite à mão; regere (\`bun scripts/calendario-operacao/gerar-carga.ts\`).
-- Spec: docs/superpowers/specs/2026-11-18-calendario-operacao-design.md §4, §4.1, §4.2.
-- Idempotente: ON CONFLICT DO NOTHING (re-rodar não sobrescreve edição do founder). Transacional, com postcondição.
-- Feriados municipais de Divinópolis (Corpus Christi, São Firmino 01/06, Imaculada Conceição 08/12): Lei municipal
--   744/1967 — ementa confirmada no SAPL: https://sapl.divinopolis.mg.leg.br/norma/5727?display (Corpus Christi, Sexta-feira
--   da Paixão, São Firmino e Imaculada Conceição). As DATAS (01/06 e 08/12) NÃO foram confirmadas no texto integral
--   (só a ementa foi lida) — vêm das listas de feriados locais do TRT-3 e da resposta do founder (§4.2): não confirmado na fonte primária.
-- Linhas da empresa por origem/empresa (${c.empresa.length} no total; ${c.fornecedor.length} de fornecedor; ${c.feriadosNacionais.length} feriados):
${resumo}
-- Aplicação em prod: manual, pelo founder no SQL Editor (custom não auto-aplica). Depende da migration 20261119100000.

BEGIN;

CREATE TEMP TABLE _carga_emp (data date, empresa text, status text, peso numeric, motivo text, origem text) ON COMMIT DROP;
INSERT INTO _carga_emp VALUES
${emp};

CREATE TEMP TABLE _carga_forn (data date, empresa text, fornecedor_nome text, motivo text, origem text) ON COMMIT DROP;
INSERT INTO _carga_forn VALUES
${forn};

CREATE TEMP TABLE _carga_fer (data date, nome text, tipo text, observacoes text) ON COMMIT DROP;
INSERT INTO _carga_fer VALUES
${fer};

INSERT INTO public.calendario_operacao_empresa (data, empresa, status, peso, motivo, origem)
SELECT data, empresa, status, peso, motivo, origem FROM _carga_emp
ON CONFLICT (data, empresa) DO NOTHING;

INSERT INTO public.calendario_operacao_fornecedor (data, empresa, fornecedor_nome, motivo, origem)
SELECT data, empresa, fornecedor_nome, motivo, origem FROM _carga_forn
ON CONFLICT (data, empresa, fornecedor_nome) DO NOTHING;

INSERT INTO public.calendario_feriados (data, nome, tipo, observacoes)
SELECT data, nome, tipo, observacoes FROM _carga_fer
ON CONFLICT (data) DO NOTHING;

-- Postcondição com contagens ESPERADAS embutidas como constante (geradas junto com os VALUES, mas conferidas contra
-- elas): carga incompleta (linha perdida no VALUES) e destino sem as chaves falham. Presença, não inserção: a 2ª
-- execução e a edição do founder (ON CONFLICT DO NOTHING) não reprovam.
DO $$
DECLARE
  esp_emp  CONSTANT int := ${c.empresa.length};
  esp_forn CONSTANT int := ${c.fornecedor.length};
  esp_nac  CONSTANT int := ${c.feriadosNacionais.length};
  n int; r record;
BEGIN
  SELECT count(*) INTO n FROM _carga_emp;
  IF n <> esp_emp THEN RAISE EXCEPTION 'POST carga calendario: carga de empresa tem % linhas (esperado %)', n, esp_emp; END IF;
  FOR r IN SELECT * FROM (VALUES
${esperadoOrigem}
  ) e(origem, empresa, n) LOOP
    SELECT count(*) INTO n FROM _carga_emp WHERE origem = r.origem AND empresa = r.empresa;
    IF n <> r.n THEN RAISE EXCEPTION 'POST carga calendario: % / % tem % linhas na carga (esperado %)', r.origem, r.empresa, n, r.n; END IF;
  END LOOP;
  SELECT count(*) INTO n FROM _carga_forn;
  IF n <> esp_forn THEN RAISE EXCEPTION 'POST carga calendario: carga de fornecedor tem % linhas (esperado %)', n, esp_forn; END IF;
  SELECT count(*) INTO n FROM _carga_fer;
  IF n <> esp_nac THEN RAISE EXCEPTION 'POST carga calendario: carga de feriados tem % linhas (esperado %)', n, esp_nac; END IF;

  SELECT count(*) INTO n FROM _carga_emp c JOIN public.calendario_operacao_empresa t USING (data, empresa);
  IF n <> esp_emp THEN RAISE EXCEPTION 'POST carga calendario: destino tem % das % chaves de empresa', n, esp_emp; END IF;
  SELECT count(*) INTO n FROM _carga_forn c JOIN public.calendario_operacao_fornecedor t USING (data, empresa, fornecedor_nome);
  IF n <> esp_forn THEN RAISE EXCEPTION 'POST carga calendario: destino tem % das % chaves de fornecedor', n, esp_forn; END IF;
  SELECT count(*) INTO n FROM _carga_fer c JOIN public.calendario_feriados t ON t.data = c.data AND t.tipo = 'nacional';
  IF n <> esp_nac THEN RAISE EXCEPTION 'POST carga calendario: destino tem % dos % feriados nacionais', n, esp_nac; END IF;
  FOR r IN SELECT y FROM generate_series(2027, 2030) y LOOP
    SELECT count(*) INTO n FROM _carga_fer WHERE extract(year FROM data) = r.y;
    IF n <> 10 THEN RAISE EXCEPTION 'POST carga calendario: carga com % nacionais em % (esperado 10)', n, r.y; END IF;
    SELECT count(*) INTO n FROM public.calendario_feriados WHERE extract(year FROM data) = r.y AND tipo = 'nacional';
    IF n < 10 THEN RAISE EXCEPTION 'POST carga calendario: destino com % nacionais em % (esperado >= 10)', n, r.y; END IF;
  END LOOP;
  RAISE NOTICE 'POST carga calendario OK';
END $$;

COMMIT;

SELECT origem, empresa, status, count(*) AS linhas
  FROM public.calendario_operacao_empresa GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
SELECT 'fim', 'ok';
`;
}

if (import.meta.main) {
  const saida = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'carga-calendario-operacao-2025-2030.sql');
  writeFileSync(saida, gerarSql(gerarCarga(FORNECEDORES_NAO_SAYERLACK)));
  console.log(`escrito ${saida}`);
}
