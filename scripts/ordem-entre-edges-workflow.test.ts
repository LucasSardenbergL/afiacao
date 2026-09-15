import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CAMINHO_WORKFLOW, CONTEXTO_OBRIGATORIO } from './lib/ordem-entre-edges-declaracao';

// O check `ordem-entre-edges` só segura merge se for EXIGIDO pela branch protection, e o GitHub trata
// check exigido que não roda de três jeitos diferentes: job pulado por `if` conta como SATISFEITO;
// workflow filtrado por `paths` nunca reporta e trava o PR; e evento fora de `types` deixa valendo o
// veredito do corpo ANTIGO. Cada invariante abaixo fecha um desses — o YAML é parte do gate.

interface Passo {
  run?: string;
  uses?: string;
  env?: Record<string, unknown>;
}
interface Job {
  name?: unknown;
  if?: unknown;
  needs?: unknown;
  'continue-on-error'?: unknown;
  steps?: Passo[];
}
interface Workflow {
  on?: { pull_request?: Record<string, unknown> } & Record<string, unknown>;
  concurrency?: { group?: unknown; 'cancel-in-progress'?: unknown };
  permissions?: Record<string, unknown>;
  jobs?: Record<string, Job>;
}

const wf = (): Workflow => (existsSync(CAMINHO_WORKFLOW) ? (parse(readFileSync(CAMINHO_WORKFLOW, 'utf8')) as Workflow) : {});
const jobs = (w: Workflow): [string, Job][] => Object.entries(w.jobs ?? {});

describe('workflow do gate de declaração de ordem entre edges', () => {
  // `edited` é a razão de o gate morar fora do ci.yml: o corpo muda sem push em 10% dos PRs, e o
  // draft que vira ready mergeia 7-18 s depois sobre o veredito que já existia.
  it('[WF_EVENTOS] roda em opened, synchronize, reopened, edited e ready_for_review', () => {
    const tipos = wf().on?.pull_request?.types;
    expect(Array.isArray(tipos)).toBe(true);
    for (const t of ['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review']) {
      expect(tipos).toContain(t);
    }
  });

  it('[WF_SEM_FILTRO_DE_CAMINHO] não filtra por caminho nem exclui branch', () => {
    const pr = wf().on?.pull_request ?? {};
    expect(pr).not.toHaveProperty('paths');
    expect(pr).not.toHaveProperty('paths-ignore');
    expect(pr).not.toHaveProperty('branches-ignore');
    expect(pr.branches).toEqual(['main']);
  });

  it('[WF_JOB_COM_NOME_DO_CONTEXTO] um job só, e o nome dele é o contexto exigido', () => {
    const js = jobs(wf());
    expect(js.map(([id]) => id)).toEqual([CONTEXTO_OBRIGATORIO]);
    const nome = js[0]?.[1].name;
    expect(nome === undefined || nome === CONTEXTO_OBRIGATORIO).toBe(true);
  });

  it('[WF_JOB_SEM_IF] o job nunca é pulado nem espera outro', () => {
    const job = jobs(wf())[0]?.[1] ?? {};
    expect(job).not.toHaveProperty('if');
    expect(job).not.toHaveProperty('needs');
    expect(job).not.toHaveProperty('continue-on-error');
    for (const p of job.steps ?? []) {
      expect(p).not.toHaveProperty('if');
      expect(p).not.toHaveProperty('continue-on-error');
    }
  });

  it('[WF_RODA_O_CLI_COM_EVENTO] um passo roda o CLI com o evento, e tem token para reler o corpo', () => {
    const passos = jobs(wf())[0]?.[1].steps ?? [];
    const cli = passos.filter((p) => typeof p.run === 'string' && p.run.includes('bun run ordem:declaracao'));
    expect(cli).toHaveLength(1);
    expect(cli[0].run).toContain('--evento "$GITHUB_EVENT_PATH"');
    expect(cli[0].env).toHaveProperty('GH_TOKEN');
  });

  it('[WF_PACKAGE_JSON_TEM_O_SCRIPT] o script do package.json aponta para o CLI', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['ordem:declaracao']).toBe('bun scripts/ordem-entre-edges-declaracao.ts');
  });

  // Dois jobs com o mesmo nome no mesmo SHA disputam o contexto exigido: o verde de um cobriria o
  // vermelho do outro.
  it('[WF_NOME_UNICO_ENTRE_WORKFLOWS] nenhum outro workflow tem job com o nome do contexto', () => {
    const dir = '.github/workflows';
    const outros = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f) && join(dir, f) !== CAMINHO_WORKFLOW)
      .filter((f) => {
        const doc = parse(readFileSync(join(dir, f), 'utf8')) as Workflow;
        return jobs(doc).some(([id, j]) => id === CONTEXTO_OBRIGATORIO || j.name === CONTEXTO_OBRIGATORIO);
      });
    expect(outros).toEqual([]);
  });

  it('[WF_CONCORRENCIA_POR_PR] a concorrência é por PR e cancela o run anterior', () => {
    const c = wf().concurrency ?? {};
    expect(String(c.group)).toContain('github.event.pull_request.number');
    expect(c['cancel-in-progress']).toBe(true);
  });

  it('[WF_PERMISSOES_MINIMAS] só lê: conteúdo e PR', () => {
    expect(wf().permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  });
});
