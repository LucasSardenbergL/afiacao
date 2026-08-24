/**
 * migration-objects.test.ts — o extrator de objetos do audit de migrations.
 * =========================================================================
 *
 * Motivação (medida em 2026-08-21, `docs/historico/audit-migrations-falso-vermelho.md`):
 * a classe `[^\s"]+` do policyRe parava no PRIMEIRO espaço, então TODA policy de nome
 * citado com espaço — `CREATE POLICY "Staff can read association rules" ON ...` — não
 * casava nada. No corpus custom real: 449 `CREATE POLICY`, 400 casadas, **49 perdidas
 * (11%) em 20 arquivos**. E o buraco não vira vermelho: vira AUSÊNCIA (a migration cai
 * no bucket ⚪ "sem objeto rastreável"), que é o pior modo de falha para um audit.
 *
 * O teste de corpus ao fim é o SENSOR que faltava: varre as migrations custom reais e
 * exige que toda ocorrência de `CREATE POLICY` vire objeto — migration futura com
 * sintaxe exótica falha AQUI, não silenciosamente no inventário.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractObjects, objectKey } from './migration-objects';
import { removerComentariosSql } from './sql-comentarios';

/** só as policies — os demais kinds têm bloco próprio abaixo (migrado da órfã, 2026-08-23) */
const policies = (sql: string) => extractObjects(sql).filter((o) => o.kind === 'rls_policy');

describe('extractObjects — CREATE POLICY', () => {
  it('extrai nome CITADO com espaço (o buraco de 11% do corpus)', () => {
    // real: 20260820225840_farmer_assoc_rules_escritor_unico.sql
    const sql = `CREATE POLICY "Staff can read association rules" ON public.farmer_association_rules FOR SELECT USING (true);`;
    expect(policies(sql)).toEqual([
      {
        kind: 'rls_policy',
        schema: 'public',
        name: 'Staff can read association rules',
        parent: 'farmer_association_rules',
      },
    ]);
  });

  it('extrai nome NÃO-citado (regressão do comportamento que já funcionava)', () => {
    const sql = `CREATE POLICY staff_le_execucoes ON public.acoes_execucoes FOR SELECT USING (true);`;
    expect(policies(sql)).toEqual([
      { kind: 'rls_policy', schema: 'public', name: 'staff_le_execucoes', parent: 'acoes_execucoes' },
    ]);
  });

  it('respeita schema EXPLÍCITO não-public', () => {
    // real: 20260627180200_seg_onda2_revoke_secdef_storage.sql
    const sql = `CREATE POLICY "Public can view avatars" ON storage.objects FOR SELECT TO public USING (bucket_id = 'avatars');`;
    expect(policies(sql)).toEqual([
      { kind: 'rls_policy', schema: 'storage', name: 'Public can view avatars', parent: 'objects' },
    ]);
  });

  it('assume public quando o schema é IMPLÍCITO', () => {
    // real: 20260328200400_fix_cron_sync.sql
    const sql = `CREATE POLICY "fin_sync_log_select" ON fin_sync_log FOR SELECT USING (true);`;
    expect(policies(sql)).toEqual([
      { kind: 'rls_policy', schema: 'public', name: 'fin_sync_log_select', parent: 'fin_sync_log' },
    ]);
  });

  it('atravessa quebra de linha entre o nome e o ON', () => {
    // real: 20260718100000_filas_recalc_rls_master_only.sql
    const sql = `CREATE POLICY "Master can view recalc queue"\n  ON public.score_recalc_queue\n  FOR SELECT\n  USING (true);`;
    expect(policies(sql)).toEqual([
      { kind: 'rls_policy', schema: 'public', name: 'Master can view recalc queue', parent: 'score_recalc_queue' },
    ]);
  });

  it('aceita o IF NOT EXISTS que o corpus tem (mesmo não sendo sintaxe do PG)', () => {
    // real: 20260328200400_fix_cron_sync.sql — o extrator inventaria o que a migration
    // DIZ criar; se não aplicou, o vermelho do audit é o achado LEGÍTIMO.
    const sql = `CREATE POLICY IF NOT EXISTS "fin_sync_log_service" ON fin_sync_log FOR ALL USING (auth.role() = 'service_role');`;
    expect(policies(sql)).toEqual([
      { kind: 'rls_policy', schema: 'public', name: 'fin_sync_log_service', parent: 'fin_sync_log' },
    ]);
  });

  it('casa minúsculas e preserva acento no nome', () => {
    // real: 20260615210000_reposicao_auto_aprovacao_v2.sql + 20260722100000_acoes_execucoes_ultima_execucao.sql
    const sql = `create policy "Staff lê log de auto-aprovação" on public.reposicao_auto_aprovacao_log for select using (true);`;
    expect(policies(sql)).toEqual([
      {
        kind: 'rls_policy',
        schema: 'public',
        name: 'Staff lê log de auto-aprovação',
        parent: 'reposicao_auto_aprovacao_log',
      },
    ]);
  });

  it('extrai TODAS as policies de um arquivo com várias', () => {
    const sql = [
      `CREATE POLICY "call_log own select" ON public.call_log FOR SELECT USING (farmer_id = auth.uid());`,
      `CREATE POLICY "call_log own update" ON public.call_log FOR UPDATE USING (farmer_id = auth.uid());`,
    ].join('\n');
    expect(policies(sql).map((p) => p.name)).toEqual(['call_log own select', 'call_log own update']);
  });

  it('a chave de colisão distingue nomes citados na MESMA tabela', () => {
    const a = policies(`CREATE POLICY "Staff can read association rules" ON public.farmer_association_rules FOR SELECT USING (true);`)[0];
    const b = policies(`CREATE POLICY "Staff can write association rules" ON public.farmer_association_rules FOR ALL USING (true);`)[0];
    expect(objectKey(a)).toBe('rls_policy:public.farmer_association_rules.Staff can read association rules');
    expect(objectKey(a)).not.toBe(objectKey(b));
  });
});

describe('extractObjects — DDL dinâmica não vira objeto esperado', () => {
  it('DESCARTA policy cujo NOME é um placeholder %I (vermelho eterno)', () => {
    // real: 20260720160000_authz_cap_compras_ler_alertas_auto_aprovacao_fu4h.sql
    const sql = `EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', p_policy, p_tabela);`;
    expect(policies(sql)).toEqual([]);
  });

  it('DESCARTA nome PARCIALMENTE dinâmico (%I_select_master)', () => {
    // real: 20260704160000_fin_dividas.sql
    const sql = `EXECUTE format($p$CREATE POLICY %I_select_master ON public.%I FOR SELECT USING (true)$p$, t, t);`;
    expect(policies(sql)).toEqual([]);
  });

  it('DESCARTA quando só a TABELA é dinâmica (nome fixo, alvo inverificável)', () => {
    const sql = `EXECUTE format('CREATE POLICY leitura_staff ON public.%I FOR SELECT USING (true)', p_tabela);`;
    expect(policies(sql)).toEqual([]);
  });

  it('não descarta policy legítima só porque o CORPO tem % (LIKE)', () => {
    const sql = `CREATE POLICY "Staff filtra prefixo" ON public.t FOR SELECT USING (codigo LIKE 'AF%');`;
    expect(policies(sql).map((p) => p.name)).toEqual(['Staff filtra prefixo']);
  });
});

describe('extractObjects — comentário é o do POSTGRES, não `--` até o fim da linha', () => {
  it('DDL dentro de bloco /* */ NÃO vira objeto (o inventário diz o que a migration CRIA)', () => {
    const sql = [
      `/* rollback da tentativa anterior — não aplicar:`,
      `CREATE POLICY "desativada" ON public.t FOR SELECT USING (true);`,
      `*/`,
      `CREATE POLICY "ativa" ON public.u FOR SELECT USING (true);`,
    ].join('\n');
    expect(policies(sql).map((p) => p.name)).toEqual(['ativa']);
  });

  it('`--` dentro de LITERAL não trunca a DDL seguinte da mesma linha', () => {
    const sql = `CREATE POLICY "filtra marcador" ON public.t FOR SELECT USING (obs = 'a -- b'); CREATE POLICY "sobrevivente" ON public.u FOR SELECT USING (true);`;
    expect(policies(sql).map((p) => p.name)).toEqual(['filtra marcador', 'sobrevivente']);
  });

  it('`--` dentro do NOME CITADO não engole a própria DDL', () => {
    const sql = `CREATE POLICY "Staff le -- log" ON public.t FOR SELECT USING (true);`;
    expect(policies(sql)).toEqual([
      { kind: 'rls_policy', schema: 'public', name: 'Staff le -- log', parent: 't' },
    ]);
  });

  it('comentário de LINHA de verdade segue fora do inventário (regressão)', () => {
    const sql = [
      `-- CREATE POLICY "comentada" ON public.t FOR SELECT USING (true);`,
      `CREATE POLICY "ativa" ON public.u FOR SELECT USING (true);`,
    ].join('\n');
    expect(policies(sql).map((p) => p.name)).toEqual(['ativa']);
  });
});
/**
 * Os DEMAIS kinds do extrator — migrados de `scripts/test-migration-objects.ts` em 2026-08-23.
 *
 * Aquele arquivo era uma suíte ÓRFÃ: nasceu no #922 como `bun scripts/test-migration-objects.ts`,
 * verde, com as únicas asserções que este repo tinha sobre `view`/`function`/`table`/`index`/
 * `trigger`/`cron_job`/`enum_value` — e NINGUÉM a rodava. Não casava o `scripts/**` + `*.test.ts`
 * do vitest (`vitest.config.ts:11`) nem os laços do `test:hooks`, e nenhum workflow a citava.
 * Mesma classe do #1902 (`docs/historico/vigia-de-cobertura-parcial.md`), outro eixo: lá `.sh`,
 * aqui `.ts`.
 *
 * O detalhe que fecha o círculo: o helper `policies()` acima dizia *"o resto do extrator tem
 * cobertura própria via corpus"*. Tinha cobertura — na órfã. O teste de corpus abaixo só varre
 * `CREATE POLICY`. O comentário AFIRMAVA uma cobertura que existia e não rodava, que é
 * exatamente como a classe se esconde.
 */
describe('extractObjects — CREATE VIEW (o gap que o audit não cobria)', () => {
  it('extrai view com schema EXPLÍCITO (views v_grupo_* ficavam cegas)', () => {
    expect(extractObjects('CREATE OR REPLACE VIEW public.v_grupo_x AS SELECT 1;')).toContainEqual(
      expect.objectContaining({ kind: 'view', schema: 'public', name: 'v_grupo_x' }),
    );
  });

  it('assume public quando o schema é IMPLÍCITO', () => {
    expect(extractObjects('CREATE VIEW v_simple AS SELECT 1;')).toContainEqual(
      expect.objectContaining({ kind: 'view', schema: 'public', name: 'v_simple' }),
    );
  });

  it('a chave IGNORA o schema implícito x explícito — as duas colidem entre si', () => {
    const explicito = extractObjects('CREATE OR REPLACE VIEW public.v_grupo_x AS SELECT 1;')[0];
    const implicito = extractObjects('CREATE OR REPLACE VIEW v_grupo_x AS SELECT 2;')[0];
    expect(objectKey(implicito)).toBe(objectKey(explicito));
  });
});

describe('extractObjects — FUNCTION: identidade do PG é nome + tipos de arg', () => {
  const fInt = extractObjects('CREATE OR REPLACE FUNCTION foo(x integer) RETURNS void AS $$ $$ LANGUAGE sql;');
  const fTxt = extractObjects('CREATE OR REPLACE FUNCTION foo(x text) RETURNS void AS $$ $$ LANGUAGE sql;');
  const fIntOutroCorpo = extractObjects('CREATE OR REPLACE FUNCTION foo(x integer) RETURNS int AS $$ select 1 $$ LANGUAGE sql;');

  it('extrai a function', () => {
    expect(fInt).toContainEqual(expect.objectContaining({ kind: 'function', schema: 'public', name: 'foo' }));
  });

  it('overload NÃO colide: foo(integer) e foo(text) são objetos distintos', () => {
    expect(objectKey(fTxt[0])).not.toBe(objectKey(fInt[0]));
  });

  it('mesma assinatura COLIDE, mesmo com corpo diferente — é o caso que o preflight existe pra pegar', () => {
    expect(objectKey(fIntOutroCorpo[0])).toBe(objectKey(fInt[0]));
  });
});

describe('extractObjects — paridade de kinds com o audit original', () => {
  it('table', () => {
    expect(extractObjects('CREATE TABLE IF NOT EXISTS public.t (id int);')).toContainEqual(
      expect.objectContaining({ kind: 'table', schema: 'public', name: 't' }),
    );
  });

  it('index (com a tabela como parent)', () => {
    expect(extractObjects('CREATE UNIQUE INDEX idx_x ON public.t (id);')).toContainEqual(
      expect.objectContaining({ kind: 'index', name: 'idx_x', parent: 't' }),
    );
  });

  it('trigger (com a tabela como parent)', () => {
    const sql = 'CREATE TRIGGER trg AFTER INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f();';
    expect(extractObjects(sql)).toContainEqual(expect.objectContaining({ kind: 'trigger', name: 'trg', parent: 't' }));
  });

  it('cron_job', () => {
    expect(extractObjects("SELECT cron.schedule('job_x','* * * * *',$$ select 1 $$);")).toContainEqual(
      expect.objectContaining({ kind: 'cron_job', name: 'job_x' }),
    );
  });

  it('enum_value (com o enum como parent)', () => {
    expect(extractObjects("ALTER TYPE public.my_enum ADD VALUE IF NOT EXISTS 'val';")).toContainEqual(
      expect.objectContaining({ kind: 'enum_value', name: 'val', parent: 'my_enum' }),
    );
  });

  it('rls_policy', () => {
    expect(extractObjects('CREATE POLICY "p_sel" ON public.t FOR SELECT USING (true);')).toContainEqual(
      expect.objectContaining({ kind: 'rls_policy', name: 'p_sel', parent: 't' }),
    );
  });
});

describe('corpus real — nenhuma CREATE POLICY custom fica fora do inventário', () => {
  const DIR = join(process.cwd(), 'supabase', 'migrations');
  const UUID = /_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.sql$/;

  it('toda ocorrência de CREATE POLICY é extraída ou é DDL dinâmica declarada', () => {
    const arquivos = readdirSync(DIR).filter((f) => f.endsWith('.sql') && !UUID.test(f));
    expect(arquivos.length).toBeGreaterThan(400); // sanidade: o corpus foi lido de fato

    const buracos: string[] = [];
    let ocorrencias = 0;
    let dinamicas = 0;

    for (const arquivo of arquivos) {
      const sql = removerComentariosSql(readFileSync(join(DIR, arquivo), 'utf8'));
      const idxs = [...sql.matchAll(/CREATE\s+POLICY/gi)].map((m) => m.index!);
      for (let i = 0; i < idxs.length; i++) {
        ocorrencias++;
        const fim = Math.min(idxs[i] + 400, idxs[i + 1] ?? sql.length);
        const trecho = sql.slice(idxs[i], fim);
        const achadas = policies(trecho);
        if (achadas.length > 0) continue;
        // só a CABEÇA (`CREATE POLICY <nome> ON <schema>.<tabela>`) decide se é DDL
        // dinâmica — `%` no CORPO é LIKE, não placeholder.
        if (/%/.test(trecho.slice(0, 120))) {
          dinamicas++;
          continue;
        }
        buracos.push(`${arquivo}: ${trecho.replace(/\s+/g, ' ').slice(0, 100)}`);
      }
    }

    expect(buracos).toEqual([]);
    expect(ocorrencias).toBeGreaterThan(400); // sanidade: as policies foram vistas
    expect(dinamicas).toBe(3); // as 3 EXECUTE format conhecidas — mudou? revise o descarte
  });
});
