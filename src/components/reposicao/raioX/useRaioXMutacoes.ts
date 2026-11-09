// Mutações do Raio-X (fase B, PR 3): decidir (money-path — `raio_x_decidir` pode mexer em sku_parametros,
// o motor de compras), contar, classificar e planejar (pacote 2 — `raio_x_planejar`, só o plano de execução). Cada uma invalida o PREFIXO ['raio-x', empresa] (fatos,
// decisões, manuais e o selo do pedido — Ruling S1) e avisa por toast. A empresa é a do ITEM, passada por
// quem abriu, nunca relida do seletor na hora do clique.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { registrarNoLedger } from '@/lib/analytics-ledger';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { comNulo } from '@/lib/rpc-args';
import type { DecidirArgs } from '@/lib/reposicao/raio-x/decisao';
import type { CanalLiquidacao, Categoria, Empresa, TrocaContrapartida } from '@/lib/reposicao/raio-x/tipos';

export interface PlanejarArgs {
  sku: number;
  precoPiso: number | null;
  canal: CanalLiquidacao | null;
  responsavel: string | null;
  /** 'YYYY-MM-DD' */
  prazo: string | null;
  concluido: boolean;
  /** atualizado_em da decisão que o formulário EDITOU (concorrência otimista — RX003 se mudou). */
  atualizadoEm: string;
  /** R$ total estimado de frete da liquidação (só liquidar). */
  frete: number | null;
  /** só trocar: o que entra no lugar. */
  trocaContrapartida: TrocaContrapartida | null;
}

const MSG_RX001 = 'Este SKU não tem parâmetro de reposição — desmarque "tirar do motor"';
const MSG_RX001_RESTAURAR = 'Este SKU não tem mais parâmetro de reposição — não há motor para restaurar';
const MSG_SEM_PERMISSAO = 'Sem permissão para decidir no Raio-X (exige acesso a custo).';
const MSG_RX002 = 'Esta decisão foi desfeita — grave o destino antes do plano';
const MSG_RX003 = 'Outra pessoa mudou esta decisão — recarregue antes de salvar a execução';
const MSG_RX004 = 'Liquidar só no inequívoco: este SKU ainda aguarda (corante, entrada recente, cold-start, substituição ou cadastro) — escolha outro destino';

/** SQLSTATE conhecida vira texto acionável; o resto usa a mensagem do servidor. */
function textoDoErro(e: unknown, fallback: string, msgRx001 = MSG_RX001): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'RX001') return msgRx001;
  if (code === 'RX002') return MSG_RX002;
  if (code === 'RX003') return MSG_RX003;
  if (code === 'RX004') return MSG_RX004;
  if (code === '42501') return MSG_SEM_PERMISSAO;
  return mensagemDeErro(e) ?? fallback;
}

function avisarErro(e: unknown, fallback: string, msgRx001 = MSG_RX001) {
  toast.error(textoDoErro(e, fallback, msgRx001));
}

const numeroValido = (n: number | null) => n === null || (Number.isFinite(n) && n >= 0);

/** `credito_troca` = 2ª chamada que só acrescenta o crédito depois da contrapartida "encalhe" (ver `salvar`). */
export type AcaoDecisao = 'decidir' | 'restaurar' | 'tirar_agora' | 'credito_troca';
/** De onde veio o toque que decidiu (sensor do ledger): Confirmar sugestão no card, painel direto ou pela fila. */
export type OrigemDecisao = 'card' | 'sheet' | 'fila';
/** Plano que acompanha a decisão no MESMO salvar (UX 5): tudo do PlanejarArgs menos o que vem da decisão gravada. */
export type PlanoJunto = Omit<PlanejarArgs, 'sku' | 'atualizadoEm'>;
/** `ok` = decisão (e plano, se havia) gravados; `parcial` = decisão gravada, plano NÃO; `falhou` = nada gravado. */
export type ResultadoSalvar = 'ok' | 'parcial' | 'falhou';

export function useRaioXMutacoes(empresa: Empresa) {
  const qc = useQueryClient();
  // S10: invalidação e track usam a empresa das VARIÁVEIS da mutação (a mesma que foi como p_empresa), nunca a
  // do closure — se o seletor trocar antes da resposta, o cache invalidado é o da empresa gravada.
  const invalidar = (emp: Empresa) => qc.invalidateQueries({ queryKey: ['raio-x', emp] });

  const mDecidir = useMutation({
    mutationFn: async ({ empresa, args }: {
      empresa: Empresa; args: DecidirArgs; acao: AcaoDecisao; origem?: OrigemDecisao; silencioso?: boolean;
    }) => {
      // O gerador declara todo Arg não-nulo, mas a RPC (migration 20261016120000, sem DEFAULT, não-STRICT —
      // conferido na prod) aceita NULL em destino/observação/fornecedor/crédito: `comNulo` reabre só essas 4
      // chaves e checa o resto contra o types.ts.
      const params = comNulo<'raio_x_decidir', 'p_destino' | 'p_observacao' | 'p_fornecedor' | 'p_credito_troca'>({
        p_empresa: empresa,
        p_sku: args.sku,
        p_destino: args.destino,
        p_categoria: args.categoria,
        p_observacao: args.observacao,
        p_fornecedor: args.fornecedor,
        // Crédito só faz sentido em troca (a RPC grava o que vier; a regra é nossa).
        p_credito_troca: args.destino === 'trocar' ? args.creditoTroca : null,
        p_tirar_do_motor: args.tirarDoMotor,
        p_restaurar_motor: args.restaurarMotor,
      });
      const { data, error } = await supabase.rpc('raio_x_decidir', params);
      if (error) throw error;
      return data;
    },
    onSuccess: (row, { empresa, args, acao, origem, silencioso }) => {
      void invalidar(empresa);
      if (!silencioso) toast.success(acao === 'restaurar' ? 'Motor restaurado' : acao === 'tirar_agora' ? 'Tirado do motor' : 'Decisão salva');
      track('raio_x.decisao', {
        empresa,
        destino: args.destino,
        tirou_do_motor: row?.tirou_do_motor ?? args.tirarDoMotor,
        acao,
        origem: origem ?? null,
      });
      // Sensor (ledger, 1x por SKU × origem × dia): só a decisão de destino, não restaurar/tirar agora.
      if (acao === 'decidir' && origem && args.destino) {
        void registrarNoLedger('reposicao.raio_x_decisao', `${empresa}:${args.sku}:${origem}`, { empresa, origem, destino: args.destino });
      }
    },
    // RX001 no restaurar = o sku_parametros sumiu; "desmarque tirar do motor" não se aplica.
    onError: (e, { acao, silencioso }) => {
      if (!silencioso) avisarErro(e, 'Não foi possível salvar a decisão.', acao === 'restaurar' ? MSG_RX001_RESTAURAR : MSG_RX001);
    },
  });

  const mContar = useMutation({
    mutationFn: async ({ empresa, sku, qtd }: { empresa: Empresa; sku: number; qtd: number | null }) => {
      // `p_qtd` NULL vai como NULL (a RPC, não-STRICT, grava o que vier — comportamento de antes).
      const params = comNulo<'raio_x_contar', 'p_qtd'>({ p_empresa: empresa, p_sku: sku, p_qtd: qtd });
      const { error } = await supabase.rpc('raio_x_contar', params);
      if (error) throw error;
    },
    onSuccess: (_d, { empresa }) => {
      void invalidar(empresa);
      toast.success('Contagem salva');
    },
    onError: (e) => avisarErro(e, 'Não foi possível salvar a contagem.'),
  });

  const mClassificar = useMutation({
    mutationFn: async ({ empresa, sku, categoria, motivo }: { empresa: Empresa; sku: number; categoria: Categoria; motivo: string }) => {
      const { error } = await supabase.rpc('raio_x_classificar', {
        p_empresa: empresa,
        p_sku: sku,
        p_categoria: categoria,
        p_motivo: motivo,
      });
      if (error) throw error;
    },
    onSuccess: (_d, { empresa, categoria }) => {
      void invalidar(empresa);
      toast.success('Categoria marcada');
      track('raio_x.reclassificacao', { empresa, categoria });
    },
    onError: (e) => avisarErro(e, 'Não foi possível reclassificar.'),
  });

  const mPlanejar = useMutation({
    mutationFn: async ({ empresa, args }: { empresa: Empresa; args: PlanejarArgs; silencioso?: boolean }) => {
      // Estado completo (como decidir): campo nulo LIMPA. A RPC (20261031180000, sem DEFAULT, não-STRICT) aceita NULL.
      const params = comNulo<'raio_x_planejar', 'p_preco_piso' | 'p_canal' | 'p_responsavel' | 'p_prazo' | 'p_frete' | 'p_troca_contrapartida'>({
        p_empresa: empresa,
        p_sku: args.sku,
        p_preco_piso: args.precoPiso,
        p_canal: args.canal,
        p_responsavel: args.responsavel,
        p_prazo: args.prazo,
        p_concluido: args.concluido,
        p_frete: args.frete,
        p_troca_contrapartida: args.trocaContrapartida,
        p_atualizado_em: args.atualizadoEm,
      });
      const { error } = await supabase.rpc('raio_x_planejar', params);
      if (error) throw error;
    },
    onSuccess: (_d, { empresa, args, silencioso }) => {
      void invalidar(empresa);
      if (!silencioso) toast.success('Execução salva');
      track('raio_x.plano', {
        empresa,
        tem_piso: args.precoPiso !== null,
        canal: args.canal,
        tem_responsavel: args.responsavel !== null,
        tem_prazo: args.prazo !== null,
        concluido: args.concluido,
      });
    },
    onError: (e, { silencioso }) => {
      if (!silencioso) avisarErro(e, 'Não foi possível salvar a execução.');
    },
  });

  /** Resolve `true` se gravou. Erro já virou toast; nunca rejeita. Número inválido não sai do cliente. */
  const decidir = async (args: DecidirArgs, acao: AcaoDecisao = 'decidir'): Promise<boolean> => {
    if (args.tirarDoMotor && args.restaurarMotor) {
      toast.error('Não é possível tirar e restaurar o motor na mesma gravação.'); // a RPC recusaria (22023)
      return false;
    }
    if (!numeroValido(args.creditoTroca)) {
      toast.error('Crédito de troca inválido.');
      return false;
    }
    try {
      await mDecidir.mutateAsync({ empresa, args, acao });
      return true;
    } catch {
      return false;
    }
  };

  const contar = async (sku: number, qtd: number | null): Promise<boolean> => {
    if (!numeroValido(qtd)) {
      toast.error('Quantidade inválida.');
      return false;
    }
    try {
      await mContar.mutateAsync({ empresa, sku, qtd });
      return true;
    } catch {
      return false;
    }
  };

  const classificar = async (sku: number, categoria: Categoria, motivo: string): Promise<boolean> => {
    const m = motivo.trim();
    if (!m) return false; // CHECK do banco (23514): motivo obrigatório
    try {
      await mClassificar.mutateAsync({ empresa, sku, categoria, motivo: m });
      return true;
    } catch {
      return false;
    }
  };

  /**
   * UM salvar para decisão + plano (UX 5 — liquidar num passo). As duas RPCs seguem separadas e em sequência
   * (`raio_x_decidir` → `raio_x_planejar`, nunca uma gravação dupla escondida): o plano vai com o `atualizado_em` que a
   * decisão ACABOU de gravar. Decisão sem mudança (`args` null) só planeja, com o `atualizadoEm` editado (RX003 se outro
   * operador gravou no meio). Falha no plano depois da decisão gravada = `parcial`, com mensagem que diz isso.
   */
  const salvar = async (
    args: DecidirArgs | null,
    plano: PlanoJunto | null,
    ctx: { sku: number; atualizadoEm: string | null; origem: OrigemDecisao },
  ): Promise<ResultadoSalvar> => {
    if (args && args.tirarDoMotor && args.restaurarMotor) {
      toast.error('Não é possível tirar e restaurar o motor na mesma gravação.');
      return 'falhou';
    }
    if (args && !numeroValido(args.creditoTroca)) {
      toast.error('Crédito de troca inválido.');
      return 'falhou';
    }
    if (plano && !numeroValido(plano.precoPiso)) {
      toast.error('Preço piso inválido.');
      return 'falhou';
    }
    if (plano && !numeroValido(plano.frete)) {
      toast.error('Frete inválido.');
      return 'falhou';
    }
    let atualizadoEm = ctx.atualizadoEm;
    if (args && plano) {
      // `raio_x_decidir` não recebe versão esperada; o plano iria com a versão que ELE devolve e sobrescreveria, sem RX003,
      // um plano gravado por outro operador depois da nossa leitura (Codex P1). Relê a versão antes: mudou → nada é gravado.
      let viva: { atualizado_em: string } | null;
      try {
        const r = await supabase
          .from('raio_x_decisao')
          .select('atualizado_em')
          .eq('empresa', empresa)
          .eq('sku_codigo_omie', ctx.sku)
          .maybeSingle();
        if (r.error) throw r.error;
        viva = r.data;
      } catch (e) {
        avisarErro(e, 'Não foi possível conferir a versão da decisão.');
        return 'falhou';
      }
      if ((viva?.atualizado_em ?? null) !== (ctx.atualizadoEm ?? null)) {
        toast.error(MSG_RX003);
        return 'falhou';
      }
    }
    // Troca com contrapartida "encalhe": o crédito só vai DEPOIS da contrapartida gravada. Plano que falhasse com o crédito
    // já gravado contaria o crédito como liberado (contrapartida nula conta — Codex P1); assim a falha subconta (lado seguro).
    const creditoDepois = !!(args && plano && args.destino === 'trocar' && plano.trocaContrapartida === 'encalhe' && args.creditoTroca !== null);
    if (args) {
      try {
        const row: unknown = await mDecidir.mutateAsync({
          empresa, args: creditoDepois ? { ...args, creditoTroca: null } : args, acao: 'decidir', origem: ctx.origem, silencioso: true,
        });
        // só a versão gravada interessa aqui; lida crua (uma conversão que falhasse marcaria como "falhou" o que gravou)
        const v = (row as { atualizado_em?: unknown } | null)?.atualizado_em;
        atualizadoEm = typeof v === 'string' ? v : null;
      } catch (e) {
        avisarErro(e, 'Não foi possível salvar a decisão.');
        return 'falhou';
      }
    }
    if (!plano) {
      toast.success('Decisão salva');
      return 'ok';
    }
    if (!atualizadoEm) {
      // decisão gravada sem devolver a linha: sem a versão, o plano não vai às cegas
      if (args) toast.warning('Decisão salva, mas a execução não. Confira os campos e salve de novo.');
      else toast.error('Sem a versão da decisão — recarregue antes de salvar a execução.');
      return args ? 'parcial' : 'falhou';
    }
    try {
      await mPlanejar.mutateAsync({ empresa, args: { ...plano, sku: ctx.sku, atualizadoEm }, silencioso: true });
    } catch (e) {
      const motivo = textoDoErro(e, 'erro ao salvar a execução');
      if (args) {
        toast.warning(`Decisão salva, mas a execução NÃO: ${motivo}. Confira os campos e salve de novo.`);
        return 'parcial';
      }
      toast.error(motivo);
      return 'falhou';
    }
    if (creditoDepois && args) {
      try {
        // mesmo destino (decidido_em não muda), motor já resolvido na 1ª chamada: só acrescenta o crédito
        await mDecidir.mutateAsync({ empresa, args: { ...args, tirarDoMotor: false }, acao: 'credito_troca', silencioso: true });
      } catch (e) {
        toast.warning(`Decisão e contrapartida salvas, mas o crédito de troca NÃO: ${textoDoErro(e, 'erro ao salvar o crédito')}. Salve de novo para informar.`);
        return 'parcial';
      }
    }
    toast.success(args ? 'Decisão e execução salvas' : 'Execução salva');
    return 'ok';
  };

  const planejar = async (args: PlanejarArgs): Promise<boolean> => {
    if (!numeroValido(args.precoPiso)) {
      toast.error('Preço piso inválido.');
      return false;
    }
    if (!numeroValido(args.frete)) {
      toast.error('Frete inválido.');
      return false;
    }
    try {
      await mPlanejar.mutateAsync({ empresa, args });
      return true;
    } catch {
      return false;
    }
  };

  return {
    decidir,
    contar,
    classificar,
    planejar,
    salvar,
    pendente: mDecidir.isPending || mContar.isPending || mClassificar.isPending || mPlanejar.isPending,
  };
}
