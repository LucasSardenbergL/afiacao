// Geração da fila de conciliação bancária (`fin_conciliacao`) a partir de `fin_movimentacoes`.
// Extraída de `pages/FinanceiroConciliacao.tsx` para ter contrato testável — antes, zero teste.
//
// ⚠️ DEFESA, INERTE HOJE (medido na PROD em 2026-09-10): `fin_conciliacao` nunca teve uma linha
// (`n_tup_ins = 0`) e `fin_permissoes` está vazia, sem UI que a grave — a policy
// `fin_conc_write` exige `pode_conciliar`, então a RLS recusa TODA gravação vinda do app. Esta
// correção fecha a ótica e a falha calada; NÃO torna a feature pronta para ligar. Antes de
// conceder `pode_conciliar` a alguém, falta (docs/historico/conciliacao-otica-bancaria-defesa.md):
//   (a) idempotência: `onConflict: 'id'` sem `id` no payload INSERE de novo a cada clique —
//       precisa de UNIQUE(mov_id) + ignorar duplicata (sobrescrever apagaria item já resolvido);
//   (b) `fin_movimentacoes.conciliado` nunca é atualizado pelo resolver, e
//   (c) o sync (`omie-financeiro`) regrava `conciliado:false` a cada carga — o estado da
//       conciliação tem de morar em `fin_conciliacao`, com um escritor só;
//   (d) o `resolver` da página também descarta o `error` do UPDATE (toast de sucesso na recusa);
//   (e) a leitura não pagina: com ~31 mil movimentos bancários, a capa de 1.000 do PostgREST
//       pega um recorte arbitrário; e cada movimento faz até 2 idas ao banco (N+1);
//   (f) a regra de valor compara a BAIXA com o `valor_documento` — baixa parcial, juros e
//       desconto viram "divergência" (8.678 itens na simulação sobre a PROD);
//   (g) a TELA: o `load()` descarta o `error` das três leituras e conta os status sobre uma
//       leitura com capa de 1.000 — acima disso o total e o "% conciliado" mentem.
import { supabase } from '@/integrations/supabase/client';
import type { Company } from '@/contexts/CompanyContext';
import type { FinMovimentacaoRow } from '@/services/financeiroTypes';

type MovimentacaoMatch = Pick<
  FinMovimentacaoRow,
  'id' | 'omie_ncodcc' | 'data_movimento' | 'valor' | 'descricao' | 'tipo' | 'omie_codigo_lancamento' | 'conciliado'
>;

export type ResultadoGeracaoConciliacao = {
  /** Movimentos da ótica bancária elegíveis (com conta corrente) — o denominador. */
  lidos: number;
  criados: number;
  /** Itens NÃO gerados: busca de título que falhou ou gravação recusada (ex.: RLS sem `pode_conciliar`). */
  falhas: number;
  primeiraFalha: string | null;
};

export async function gerarFilaConciliacao(company: Company): Promise<ResultadoGeracaoConciliacao> {
  // ALLOWLIST POSITIVA de ótica, NA QUERY. O Omie devolve o MESMO pagamento duas vezes — como
  // lançamento do TÍTULO (`CONTA_A_*`) e como lançamento na CONTA CORRENTE (`CONTA_CORRENTE_*`)
  // — e ainda lista PREVISÕES (`PREVISAO_*`). Conciliação é extrato contra título: a pergunta
  // é "cada movimento do BANCO está explicado?", então só a ótica bancária entra. A linha da
  // ótica do título casa com o próprio título por construção (falso "conciliado") e, com o
  // título aberto, vira "divergência". Simulado na PROD em 2026-09-10: 56.962 itens sem o
  // filtro × 31.160 com ele. Mesma allowlist do caixa realizado (`getFluxoCaixa`).
  // Positiva porque a negação (`NOT LIKE 'CONTA_A_%'`) deixaria PREVISÃO entrar; na query
  // porque o `.select()` não traz `categoria_descricao`, e filtrar em JS por coluna não
  // selecionada ZERA a fila.
  const { data: movs, error: errMovs } = await supabase
    .from('fin_movimentacoes')
    .select('id, omie_ncodcc, data_movimento, valor, descricao, tipo, omie_codigo_lancamento, conciliado')
    .eq('company', company)
    .eq('conciliado', false)
    .in('categoria_descricao', ['CONTA_CORRENTE_REC', 'CONTA_CORRENTE_PAG']);
  // Leitura que falha não é leitura vazia: sem isto, um timeout virava "0 itens gerados".
  if (errMovs) throw errMovs;

  // `omie_ncodcc` é NOT NULL em `fin_conciliacao`; na PROD nenhum movimento vem sem ele.
  const elegiveis = ((movs ?? []) as MovimentacaoMatch[]).filter((m) => m.omie_ncodcc != null);

  let criados = 0;
  let falhas = 0;
  let primeiraFalha: string | null = null;
  for (const mov of elegiveis) {
    // Tentar match automático por omie_codigo_lancamento
    let tituloId: string | null = null;
    let tituloValor: number | null = null;
    let tipoTitulo: 'CR' | 'CP' | null = null;
    let tipoMatch: 'automatico' | null = null;
    let erroBusca: { message?: string } | null = null;

    if (mov.omie_codigo_lancamento) {
      const { data: cr, error: errCr } = await supabase
        .from('fin_contas_receber')
        .select('id, valor_documento')
        .eq('company', company)
        .eq('omie_codigo_lancamento', mov.omie_codigo_lancamento)
        .limit(1);
      if (errCr) {
        erroBusca = errCr;
      } else if (cr && cr.length > 0) {
        tituloId = cr[0].id;
        tituloValor = cr[0].valor_documento;
        tipoTitulo = 'CR';
        tipoMatch = 'automatico';
      } else {
        const { data: cp, error: errCp } = await supabase
          .from('fin_contas_pagar')
          .select('id, valor_documento')
          .eq('company', company)
          .eq('omie_codigo_lancamento', mov.omie_codigo_lancamento)
          .limit(1);
        if (errCp) {
          erroBusca = errCp;
        } else if (cp && cp.length > 0) {
          tituloId = cp[0].id;
          tituloValor = cp[0].valor_documento;
          tipoTitulo = 'CP';
          tipoMatch = 'automatico';
        }
      }
    }

    // Busca que falha não é "sem match" — o item viraria pendente com o título lá. Conta como
    // não gerado e segue: um timeout no meio não pode esconder quantos ficaram de fora.
    if (erroBusca) {
      falhas++;
      primeiraFalha ??= erroBusca.message?.trim() || null;
      continue;
    }

    const status = tipoMatch === 'automatico'
      ? (Math.abs(mov.valor - (tituloValor || 0)) < 0.01 ? 'conciliado' : 'divergencia')
      : 'pendente';

    const { error } = await supabase
      .from('fin_conciliacao')
      .upsert({
        company,
        omie_ncodcc: mov.omie_ncodcc as number,
        mov_id: mov.id,
        mov_data: mov.data_movimento,
        mov_valor: mov.valor,
        mov_descricao: mov.descricao,
        tipo_titulo: tipoTitulo,
        titulo_id: tituloId,
        titulo_valor: tituloValor,
        status,
        tipo_match: tipoMatch,
      }, { onConflict: 'id' });

    // A gravação recusada é CONTADA: antes o `if (!error) criados++` a engolia e a tela
    // anunciava "0 itens gerados" como sucesso, com a RLS recusando tudo.
    if (error) {
      falhas++;
      primeiraFalha ??= error.message?.trim() || null;
    } else {
      criados++;
    }
  }

  return { lidos: elegiveis.length, criados, falhas, primeiraFalha };
}

export type ResumoGeracaoConciliacao = {
  tipo: 'sucesso' | 'erro';
  titulo: string;
  descricao: string | null;
};

/** O que o toast diz: falha parcial ou total é ERRO com a contagem e o motivo, nunca sucesso. */
export function resumirGeracaoConciliacao(r: ResultadoGeracaoConciliacao): ResumoGeracaoConciliacao {
  if (r.falhas === 0) {
    return { tipo: 'sucesso', titulo: `${r.criados} itens gerados na fila de conciliação`, descricao: null };
  }
  return {
    tipo: 'erro',
    titulo: `${r.falhas} de ${r.lidos} itens não gerados na fila de conciliação`,
    descricao: r.primeiraFalha ?? 'O banco recusou a gravação sem mensagem — tente de novo ou avise a equipe.',
  };
}
