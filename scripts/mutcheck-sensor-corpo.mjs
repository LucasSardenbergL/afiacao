// mutcheck-sensor-corpo.mjs — executa os scripts do SENSOR extraídos do ci.yml.
//
// Por que extrair em vez de reimplementar: um teste que reescreve a lógica do alerta prova o
// teste, não o alerta. Aqui o corpo medido é o MESMO texto que o GitHub Actions vai rodar — se
// alguém editar o YAML e quebrar o remédio, isto fica vermelho.
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import YAML from 'yaml';

const raiz = process.argv[2];
const require_ = createRequire(import.meta.url);
const CAMINHO = '/tmp/mutcheck-resumo.json';
let fail = 0;
const ok = (m) => console.log(`  ok    | ${m}`);
const bad = (m) => { console.log(`  FAIL  | ${m}`); fail = 1; };

const doc = YAML.parse(readFileSync(`${raiz}/.github/workflows/ci.yml`, 'utf8'));
const steps = doc.jobs['mutation-check'].steps;
const pega = (frag) => {
  const s = steps.find((x) => (x.name || '').includes(frag));
  if (!s?.with?.script) throw new Error(`step "${frag}" sem script — o sensor sumiu do ci.yml`);
  return s.with.script;
};
const scriptAlerta = pega('Alerta de cobertura');
const scriptFecho = pega('voltou ao contrato');

const contexto = {
  repo: { owner: 'o', repo: 'r' }, sha: 'abcdef1234', runId: 42,
  serverUrl: 'https://github.com', actor: 'a', payload: {},
};
function roda(script, issuesAbertas) {
  const chamadas = { criadas: [], comentadas: [], fechadas: [] };
  const github = { rest: { issues: {
    createLabel: async () => {},
    listForRepo: async () => ({ data: issuesAbertas }),
    createComment: async ({ issue_number, body }) => { chamadas.comentadas.push({ issue_number, body }); },
    create: async ({ title, body }) => { chamadas.criadas.push({ title, body }); },
    update: async ({ issue_number, state }) => { chamadas.fechadas.push({ issue_number, state }); },
  } } };
  const fn = new Function('github', 'context', 'core', 'require', `return (async () => { ${script} })()`);
  return fn(github, contexto, {}, require_).then(() => chamadas);
}
const escreve = (obj) => writeFileSync(CAMINHO, JSON.stringify(obj));
const contrato = (o) => ({ mut: 'x.mut', exit: 1, invalidas: 0, divergencias: 0, abortou: false, sumario: 's', ...o });

// preserva um resumo real que porventura exista na máquina
const bkp = `${CAMINHO}.bkp-teste`;
if (existsSync(CAMINHO)) renameSync(CAMINHO, bkp);
try {
  // 1. DIVERGE → remédio "devolver o dente", nunca "afrouxar"
  escreve({ total: 3, com_problema: 1, contratos: [contrato({ divergencias: 2 })] });
  let c = await roda(scriptAlerta, []);
  let b = c.criadas[0]?.body || '';
  if (/PERDEU PODER/.test(b)) ok('DIVERGE → corpo diz "PERDEU PODER"'); else bad(`DIVERGE sem o remédio certo: ${b.slice(0, 120)}`);
  if (/não\*\* afrouxar|não. afrouxar/.test(b)) ok('DIVERGE → corpo proíbe afrouxar o .mut'); else bad('DIVERGE não proíbe afrouxar');
  if (!/envelheceu/.test(b)) ok('DIVERGE → NÃO oferece o remédio da inválida'); else bad('DIVERGE mistura o remédio da inválida');

  // 2. INVÁLIDA → remédio "corrigir o padrão", e é manutenção, não regressão
  escreve({ total: 3, com_problema: 1, contratos: [contrato({ invalidas: 3 })] });
  c = await roda(scriptAlerta, []);
  b = c.criadas[0]?.body || '';
  if (/envelheceu/.test(b)) ok('INVÁLIDA → corpo diz que o .mut envelheceu'); else bad('INVÁLIDA sem o remédio certo');
  if (!/PERDEU PODER/.test(b)) ok('INVÁLIDA → NÃO acusa regressão de cobertura'); else bad('INVÁLIDA acusa regressão que não houve');

  // 3. baseline vermelho → o monitor quebrou, nada se conclui
  escreve({ total: 3, com_problema: 1, contratos: [contrato({ abortou: true })] });
  b = (await roda(scriptAlerta, [])).criadas[0]?.body || '';
  if (/Baseline vermelho|harness quebrado/.test(b)) ok('abortou → corpo separa "monitor quebrou"'); else bad('abortou não é distinguido');

  // 4. resumo AUSENTE ≠ zero problema
  if (existsSync(CAMINHO)) unlinkSync(CAMINHO);
  b = (await roda(scriptAlerta, [])).criadas[0]?.body || '';
  if (/Sem resumo estruturado/.test(b)) ok('resumo ausente → diz ausência, não afirma zero'); else bad('ausência de resumo virou silêncio');

  // 5. Issue já aberta → comenta, não duplica
  escreve({ total: 3, com_problema: 1, contratos: [contrato({ divergencias: 1 })] });
  c = await roda(scriptAlerta, [{ number: 7 }]);
  if (c.comentadas.length === 1 && c.criadas.length === 0) ok('Issue aberta → comenta (não duplica)'); else bad('duplicou a Issue');

  // 6. fecho: idempotente e efetivo
  c = await roda(scriptFecho, [{ number: 7 }]);
  if (c.fechadas.length === 1 && c.fechadas[0].state === 'closed') ok('verde → fecha a Issue'); else bad('não fechou a Issue');
  c = await roda(scriptFecho, []);
  if (c.fechadas.length === 0) ok('verde sem Issue aberta → no-op'); else bad('fecho não é idempotente');
} finally {
  if (existsSync(CAMINHO)) unlinkSync(CAMINHO);
  if (existsSync(bkp)) renameSync(bkp, CAMINHO);
}
process.exit(fail);
