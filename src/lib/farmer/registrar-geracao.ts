import { supabase } from '@/integrations/supabase/client';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import type { Completude, InsumosSnapshot } from './completude-snapshot';

/**
 * Move o HEAD de geração do farmer — o caminho que NÃO toca linha.
 *
 * A geração COM linhas move o head dentro da própria RPC de substituição (mesma
 * transação, `20260815181500_farmer_geracao_head_sensor.sql`). Esta função existe para
 * o caminho que a RPC de substituição recusa por desenho: a geração VAZIA, e a
 * DEGRADADA. Sem ela, um recálculo que conclui "não há o que recomendar" não deixa
 * rastro nenhum — que é exatamente por que a frequência desse caso era, até aqui,
 * impossível de medir.
 *
 * ⚠️ **FAIL-OPEN, e é desenho.** Falha aqui NÃO derruba a tela: o cálculo é válido e já
 * foi exibido, e o head é observabilidade. A consequência está declarada no §11 do
 * money-path e vale repetir aqui: sendo fail-open, **o head não pode ser a fonte de
 * completude** — ele mede o que o motor conseguiu declarar, não o que de fato aconteceu.
 * Quem for ligar a expiração por vazio (fase 2) precisa medir contra o ESPERADO.
 */
export async function registrarGeracaoFarmer(params: {
  motor: 'cross_sell' | 'bundle';
  farmerId: string;
  runId: string;
  resultado: 'linhas' | 'vazio';
  linhasGeradas: number;
  completude: Completude;
  motivo: string | null;
  insumos: InsumosSnapshot;
  /** O head que este cálculo VIU antes de rodar — o lado "compare" do compare-and-swap. */
  headVisto: string | null;
}): Promise<void> {
  // O `error` é CAPTURADO: o supabase-js NÃO lança em erro de banco, resolve normal com
  // `error` preenchido — um `await` solto devolveria sucesso sem ter gravado (§11).
  const { error } = await supabase.rpc('farmer_geracao_registrar' as never, {
    p_motor: params.motor,
    p_farmer_id: params.farmerId,
    p_run_id: params.runId,
    p_resultado: params.resultado,
    p_linhas_geradas: params.linhasGeradas,
    p_completude: params.completude,
    p_motivo: params.motivo,
    p_insumos: params.insumos,
    p_head_visto: params.headVisto,
  } as never);

  if (error) {
    // FG106 = outro recálculo moveu o head no meio deste. Não é falha: é a recusa
    // funcionando, e o head no banco é MAIS novo que este. Registrar por cima seria
    // trocar o resultado mais recente pelo mais velho (money-path §10).
    const codigo = (error as { code?: string } | null)?.code;
    const rotulo = codigo === 'FG106' ? 'head já avançou (recusa correta)' : 'falha';
    // Só console: a tela não pode quebrar por causa do sensor.
    console.error(
      `[farmer/head] ${rotulo} ao registrar geração ${params.motor}/${params.resultado}:`,
      mensagemDeErro(error) ?? error,
    );
  }
}

/**
 * Lê o head vigente de um motor para um farmer — o lado "compare" do CAS.
 *
 * FAIL-CLOSED ao contrário do registro: se não deu para ler, devolvemos `undefined`
 * (≠ `null`), porque `null` significa "não há head" e faria o CAS passar como se fosse
 * a primeira execução — sobrescrevendo um head que existe. Ausente ≠ zero, aplicado ao
 * próprio CAS. O caller trata `undefined` pulando o registro.
 */
export async function lerHeadVigente(
  motor: 'cross_sell' | 'bundle',
  farmerId: string,
): Promise<string | null | undefined> {
  const { data, error } = await supabase
    .from('farmer_geracao_vigente' as never)
    .select('run_id')
    .eq('motor', motor)
    .eq('farmer_id', farmerId)
    .maybeSingle();

  if (error) {
    console.error(`[farmer/head] não consegui ler o head vigente de ${motor}:`, mensagemDeErro(error) ?? error);
    return undefined;
  }
  return ((data as { run_id?: string } | null)?.run_id ?? null) as string | null;
}
