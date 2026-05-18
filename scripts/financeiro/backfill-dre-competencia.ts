// Backfill de snapshot_dre_competencia_id em fechamentos pré-Phase 3.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... bun run scripts/financeiro/backfill-dre-competencia.ts
//
// Pra cada fechamento sem snapshot_dre_competencia_id, dispara calcular_dre
// (que agora calcula ambos regimes) e popula o FK do snapshot de competência.
//
// Pré-requisitos:
// - Migrations 20260518002000 + 20260518002100 já aplicadas (colunas existem)
// - omie-financeiro deployada com Task 3.3 (regime parameter)
// - CR/CP sincronizados pro período (sem isso, snapshot vai vir com zeros)

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

type Fechamento = {
  id: string;
  company: 'oben' | 'colacor' | 'colacor_sc';
  ano: number;
  mes: number;
};

async function main() {
  const { data: fechamentos, error } = await supabase
    .from('fin_fechamentos')
    .select('id, company, ano, mes')
    .is('snapshot_dre_competencia_id', null);
  if (error) {
    console.error('erro ao listar fechamentos:', error.message);
    process.exit(1);
  }

  const list = (fechamentos ?? []) as Fechamento[];
  console.log(`${list.length} fechamentos sem snapshot competência`);

  for (const f of list) {
    console.log(`  → ${f.company} ${f.ano}/${String(f.mes).padStart(2, '0')}`);

    const { error: invErr } = await supabase.functions.invoke('omie-financeiro', {
      body: { action: 'calcular_dre', company: f.company, ano: f.ano, mes: f.mes, regime: 'ambos' },
    });
    if (invErr) {
      console.error(`    falhou calcular_dre: ${invErr.message}`);
      continue;
    }

    const { data: snaps } = await supabase
      .from('fin_dre_snapshots')
      .select('id, regime')
      .eq('company', f.company)
      .eq('ano', f.ano)
      .eq('mes', f.mes);

    const caixa = (snaps ?? []).find((s) => s.regime === 'caixa');
    const comp = (snaps ?? []).find((s) => s.regime === 'competencia');

    const updates: Record<string, string> = {};
    if (caixa?.id) updates.snapshot_dre_caixa_id = caixa.id;
    if (comp?.id) updates.snapshot_dre_competencia_id = comp.id;
    if (Object.keys(updates).length === 0) {
      console.warn('    snapshots não foram criados — pular');
      continue;
    }

    const { error: upErr } = await supabase
      .from('fin_fechamentos')
      .update(updates)
      .eq('id', f.id);
    if (upErr) {
      console.error(`    falhou update fechamento: ${upErr.message}`);
      continue;
    }

    console.log(`    OK: caixa=${caixa?.id ? '✓' : '—'} competencia=${comp?.id ? '✓' : '—'}`);
  }

  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
