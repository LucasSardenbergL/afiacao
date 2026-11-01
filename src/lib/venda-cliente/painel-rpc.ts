// Borda do `jsonb` de `venda_painel` e `venda_repasse_candidatos` (money-path: preço de repasse).
// O cast `supabase.rpc as never` afirmava `PainelVenda`/`CandidatoRepasse[]` sem conferir nada.
// Aqui a forma é lida campo a campo contra o corpo das funções em prod (2026-10-21):
//   - toda chave é SEMPRE montada (`jsonb_build_object`) — chave AUSENTE é forma desconhecida e
//     LANÇA (ausente ≠ NULL: achado P1 do Codex no #3228);
//   - NULL explícito só onde a função o produz (nome, receita, taxas, ligada_em, preço sugerido…);
//   - tipo trocado LANÇA. O lançamento cai no `isError` do react-query: a tela mostra a falha,
//     nunca um número fabricado.
import type { Json } from '@/integrations/supabase/types';
import type { CandidatoRepasse, ContagemDesfecho, LinhaPainel, PainelVenda, SituacaoCompraRepasse } from './painel';

type Obj = { [k: string]: Json | undefined };

const ehObj = (v: Json | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function obj(v: Json | undefined, onde: string): Obj {
  if (!ehObj(v)) throw new Error(`${onde}: não é objeto`);
  return v;
}

function campo(o: Obj, k: string, onde: string): Json {
  const v = o[k];
  if (v === undefined) throw new Error(`${onde}: sem "${k}"`);
  return v;
}

function str(o: Obj, k: string, onde: string): string {
  const v = campo(o, k, onde);
  if (typeof v !== 'string') throw new Error(`${onde}: "${k}" não é texto`);
  return v;
}

function strOuNulo(o: Obj, k: string, onde: string): string | null {
  const v = campo(o, k, onde);
  if (v !== null && typeof v !== 'string') throw new Error(`${onde}: "${k}" não é texto`);
  return v;
}

function num(o: Obj, k: string, onde: string): number {
  const v = campo(o, k, onde);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${onde}: "${k}" não é número`);
  return v;
}

function numOuNulo(o: Obj, k: string, onde: string): number | null {
  const v = campo(o, k, onde);
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${onde}: "${k}" não é número`);
  return v;
}

function bool(o: Obj, k: string, onde: string): boolean {
  const v = campo(o, k, onde);
  if (typeof v !== 'boolean') throw new Error(`${onde}: "${k}" não é booleano`);
  return v;
}

function boolOuNulo(o: Obj, k: string, onde: string): boolean | null {
  const v = campo(o, k, onde);
  if (v !== null && typeof v !== 'boolean') throw new Error(`${onde}: "${k}" não é booleano`);
  return v;
}

function lista(o: Obj, k: string, onde: string): Json[] {
  const v = campo(o, k, onde);
  if (!Array.isArray(v)) throw new Error(`${onde}: "${k}" não é lista`);
  return v;
}

function objOuNulo(o: Obj, k: string, onde: string): Obj | null {
  const v = campo(o, k, onde);
  if (v === null) return null;
  return obj(v, `${onde}.${k}`);
}

// ── venda_painel ──────────────────────────────────────────────────────────────────────────────

function contagem(v: Json | undefined, onde: string): ContagemDesfecho {
  const o = obj(v, onde);
  return {
    virou: num(o, 'virou', onde),
    nao_virou: num(o, 'nao_virou', onde),
    nao_medivel: num(o, 'nao_medivel', onde),
    pendentes: num(o, 'pendentes', onde),
  };
}

function linhaPainel(v: Json, i: number): LinhaPainel {
  const onde = `venda_painel.linhas[${i}]`;
  const o = obj(v, onde);
  return {
    ...contagem(o, onde),
    farmer_user_id: str(o, 'farmer_user_id', onde),
    farmer_nome: strOuNulo(o, 'farmer_nome', onde),
    semana: str(o, 'semana', onde),
    na_lista: num(o, 'na_lista', onde),
    mostradas: num(o, 'mostradas', onde),
    contatados: num(o, 'contatados', onde),
    compraram: num(o, 'compraram', onde),
    receita_realizada: numOuNulo(o, 'receita_realizada', onde),
    receita_incompleta: bool(o, 'receita_incompleta', onde),
    taxa_ativa: numOuNulo(o, 'taxa_ativa', onde),
    na_lista_sombra: num(o, 'na_lista_sombra', onde),
    base_historico: contagem(campo(o, 'base_historico', onde), `${onde}.base_historico`),
    taxa_base_historico_mesma_semana: numOuNulo(o, 'taxa_base_historico_mesma_semana', onde),
    base_sombra: contagem(campo(o, 'base_sombra', onde), `${onde}.base_sombra`),
    taxa_base_sombra: numOuNulo(o, 'taxa_base_sombra', onde),
    base_confiavel: bool(o, 'base_confiavel', onde),
  };
}

function ondaBase(o: Obj, onde: string) {
  return {
    ligada: bool(o, 'ligada', onde),
    ligada_em: strOuNulo(o, 'ligada_em', onde),
    condicao_ao_ligar: objOuNulo(o, 'condicao_ao_ligar', onde),
  };
}

export function lerPainel(data: Json | null): PainelVenda {
  const onde = 'venda_painel';
  if (data === null) throw new Error(`${onde} devolveu vazio`);
  const o = obj(data, onde);
  const periodo = obj(campo(o, 'periodo', onde), `${onde}.periodo`);
  const ondas = obj(campo(o, 'ondas', onde), `${onde}.ondas`);

  const o1 = obj(campo(ondas, 'onda_recompra', onde), `${onde}.onda_recompra`);
  const p1 = obj(campo(o1, 'prerequisitos', `${onde}.onda_recompra`), `${onde}.onda_recompra.prerequisitos`);
  const o2 = obj(campo(ondas, 'onda_complemento', onde), `${onde}.onda_complemento`);
  const p2 = obj(campo(o2, 'prerequisitos', `${onde}.onda_complemento`), `${onde}.onda_complemento.prerequisitos`);
  const o3 = obj(campo(ondas, 'onda_preco', onde), `${onde}.onda_preco`);
  const p3 = obj(campo(o3, 'prerequisitos', `${onde}.onda_preco`), `${onde}.onda_preco.prerequisitos`);

  return {
    hoje: str(o, 'hoje', onde),
    periodo: { de: str(periodo, 'de', `${onde}.periodo`), ate: str(periodo, 'ate', `${onde}.periodo`) },
    base_confiavel: bool(o, 'base_confiavel', onde),
    repasse_disponivel: bool(o, 'repasse_disponivel', onde),
    linhas: lista(o, 'linhas', onde).map(linhaPainel),
    ondas: {
      onda_recompra: {
        ...ondaBase(o1, `${onde}.onda_recompra`),
        prerequisitos: {
          historico_dias: num(p1, 'historico_dias', `${onde}.onda_recompra`),
          historico_meta: num(p1, 'historico_meta', `${onde}.onda_recompra`),
          sombra_ao_vivo: lista(p1, 'sombra_ao_vivo', `${onde}.onda_recompra`).map((d, i) => {
            const od = obj(d, `${onde}.sombra_ao_vivo[${i}]`);
            return { dia: str(od, 'dia', `${onde}.sombra_ao_vivo[${i}]`), ao_vivo: bool(od, 'ao_vivo', `${onde}.sombra_ao_vivo[${i}]`) };
          }),
          avaliada_hoje: bool(p1, 'avaliada_hoje', `${onde}.onda_recompra`),
        },
      },
      onda_complemento: {
        ...ondaBase(o2, `${onde}.onda_complemento`),
        prerequisitos: {
          onda_recompra_ligada: bool(p2, 'onda_recompra_ligada', `${onde}.onda_complemento`),
          semanas: lista(p2, 'semanas', `${onde}.onda_complemento`).map((s, i) => {
            const w = `${onde}.semanas[${i}]`;
            const os = obj(s, w);
            return {
              semana: str(os, 'semana', w),
              farmers: num(os, 'farmers', w),
              menor_taxa: numOuNulo(os, 'menor_taxa', w),
              ok: bool(os, 'ok', w),
            };
          }),
        },
      },
      onda_preco: {
        ...ondaBase(o3, `${onde}.onda_preco`),
        prerequisitos: {
          onda_complemento_ligada: bool(p3, 'onda_complemento_ligada', `${onde}.onda_preco`),
          // NULL = "não sei" (tabela da Task 6 ausente), nunca false.
          repasse_vigente: boolOuNulo(p3, 'repasse_vigente', `${onde}.onda_preco`),
        },
      },
    },
  };
}

// ── venda_repasse_candidatos ──────────────────────────────────────────────────────────────────

const SITUACOES: readonly SituacaoCompraRepasse[] = ['comprando', 'parado', 'substituido'];

function candidato(v: Json, i: number): CandidatoRepasse {
  const onde = `venda_repasse_candidatos[${i}]`;
  const o = obj(v, onde);
  const empresa = str(o, 'empresa', onde);
  if (empresa !== 'oben') throw new Error(`${onde}: empresa "${empresa}" fora do repasse v1 (só oben)`);
  const ra = objOuNulo(o, 'repasse_atual', onde);
  const ondeRa = `${onde}.repasse_atual`;
  const situacao = strOuNulo(o, 'situacao_compra', onde);
  if (situacao !== null && !SITUACOES.includes(situacao as SituacaoCompraRepasse)) {
    throw new Error(`${onde}: situacao_compra "${situacao}" desconhecida`);
  }
  const sub = objOuNulo(o, 'substituto', onde);
  const ondeSub = `${onde}.substituto`;
  // substituído sem substituto (ou o inverso) é forma que a função não produz
  if ((situacao === 'substituido') !== (sub !== null)) {
    throw new Error(`${onde}: situacao_compra "${situacao}" incoerente com o substituto`);
  }
  return {
    comprador_id: str(o, 'comprador_id', onde),
    empresa,
    omie_codigo_produto: num(o, 'omie_codigo_produto', onde),
    descricao: strOuNulo(o, 'descricao', onde),
    status_defasagem: strOuNulo(o, 'status_defasagem', onde),
    motivo: strOuNulo(o, 'motivo', onde),
    abaixo_piso: boolOuNulo(o, 'abaixo_piso', onde),
    ultimo_preco: numOuNulo(o, 'ultimo_preco', onde),
    data_ultima_compra: strOuNulo(o, 'data_ultima_compra', onde),
    preco_sugerido: numOuNulo(o, 'preco_sugerido', onde),
    alta_custo_perc: numOuNulo(o, 'alta_custo_perc', onde),
    valor_anual_recuperavel: numOuNulo(o, 'valor_anual_recuperavel', onde),
    n_pedidos: numOuNulo(o, 'n_pedidos', onde),
    cadencia_dias: numOuNulo(o, 'cadencia_dias', onde),
    qtd_sugerida: numOuNulo(o, 'qtd_sugerida', onde),
    situacao_compra: situacao as SituacaoCompraRepasse | null,
    dias_sem_comprar: numOuNulo(o, 'dias_sem_comprar', onde),
    substituto: sub && {
      omie_codigo_produto: num(sub, 'omie_codigo_produto', ondeSub),
      codigo: strOuNulo(sub, 'codigo', ondeSub),
      descricao: strOuNulo(sub, 'descricao', ondeSub),
      primeira_compra: str(sub, 'primeira_compra', ondeSub),
      ultima_compra: str(sub, 'ultima_compra', ondeSub),
      dias_com_compra: num(sub, 'dias_com_compra', ondeSub),
    },
    repasse_atual: ra && {
      id: str(ra, 'id', ondeRa),
      preco_alvo: num(ra, 'preco_alvo', ondeRa),
      valido_ate: str(ra, 'valido_ate', ondeRa),
      revogado: bool(ra, 'revogado', ondeRa),
      vigente: bool(ra, 'vigente', ondeRa),
    },
  };
}

export function lerCandidatos(data: Json | null): CandidatoRepasse[] {
  if (!Array.isArray(data)) throw new Error('venda_repasse_candidatos devolveu formato inesperado');
  return data.map(candidato);
}
