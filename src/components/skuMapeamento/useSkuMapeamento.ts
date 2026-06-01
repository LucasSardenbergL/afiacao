// Hook de dados/estado do Mapeamento SKU.
// Extraído verbatim de src/pages/AdminSkuMapeamento.tsx (god-component split):
// 2 queries (mapeamentos + descrições), memos de filtro, upsert e validação.
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { EMPTY_FORM } from './config';
import { dividirSegurosParaGravar } from './grava-seguros';
import type { Mapeamento, DescricaoLookup, ValidacaoResult } from './types';
import { validarGabarito, sugerirMapeamentos, ehProdutoFracionado, PARSER_VERSION, type SugestaoSegura } from '@/lib/reposicao/sayerlack-sku';

export function useSkuMapeamento() {
  const qc = useQueryClient();
  const [filtroEmpresa, setFiltroEmpresa] = useState<string>('__all__');
  const [filtroFornecedor, setFiltroFornecedor] = useState<string>('__all__');
  const [filtroAtivo, setFiltroAtivo] = useState<string>('__all__');
  const [busca, setBusca] = useState('');
  const [openAdd, setOpenAdd] = useState(false);
  const [openValidar, setOpenValidar] = useState(false);
  const [editing, setEditing] = useState<Mapeamento | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [validacao, setValidacao] = useState<ValidacaoResult | null>(null);
  const [validando, setValidando] = useState(false);

  const { data: mapeamentos, isLoading } = useQuery({
    queryKey: ['sku-mapeamento'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sku_fornecedor_externo')
        .select('*')
        .order('empresa')
        .order('fornecedor_nome')
        .order('sku_omie');
      if (error) throw error;
      return data as Mapeamento[];
    },
  });

  // Lookup de descrições do Omie a partir de pedido_compra_item (último valor visto)
  const skusOmie = useMemo(() => (mapeamentos ?? []).map((m) => m.sku_omie), [mapeamentos]);

  const { data: descricoes } = useQuery({
    queryKey: ['sku-descricoes', skusOmie],
    enabled: skusOmie.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pedido_compra_item')
        .select('sku_codigo_omie, sku_descricao')
        .in('sku_codigo_omie', skusOmie);
      if (error) throw error;
      const map = new Map<string, string>();
      (data as DescricaoLookup[]).forEach((d) => {
        if (!map.has(d.sku_codigo_omie) && d.sku_descricao) {
          map.set(d.sku_codigo_omie, d.sku_descricao);
        }
      });
      return map;
    },
  });

  const empresas = useMemo(
    () => Array.from(new Set((mapeamentos ?? []).map((m) => m.empresa))).sort(),
    [mapeamentos],
  );
  const fornecedores = useMemo(
    () => Array.from(new Set((mapeamentos ?? []).map((m) => m.fornecedor_nome))).sort(),
    [mapeamentos],
  );

  const filtrados = useMemo(() => {
    return (mapeamentos ?? []).filter((m) => {
      if (filtroEmpresa !== '__all__' && m.empresa !== filtroEmpresa) return false;
      if (filtroFornecedor !== '__all__' && m.fornecedor_nome !== filtroFornecedor) return false;
      if (filtroAtivo === 'ativos' && !m.ativo) return false;
      if (filtroAtivo === 'inativos' && m.ativo) return false;
      if (busca.trim()) {
        const t = busca.trim().toLowerCase();
        const desc = descricoes?.get(m.sku_omie) ?? '';
        return (
          m.sku_omie.toLowerCase().includes(t) ||
          (m.sku_portal ?? '').toLowerCase().includes(t) ||
          desc.toLowerCase().includes(t)
        );
      }
      return true;
    });
  }, [mapeamentos, filtroEmpresa, filtroFornecedor, filtroAtivo, busca, descricoes]);

  const upsertMut = useMutation({
    mutationFn: async (payload: typeof EMPTY_FORM & { id?: number }) => {
      const { id, ...rest } = payload;
      if (id) {
        const { error } = await supabase
          .from('sku_fornecedor_externo')
          .update({ ...rest, atualizado_em: new Date().toISOString() })
          .eq('id', id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('sku_fornecedor_externo').insert(rest);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sku-mapeamento'] });
      toast.success(editing ? 'Mapeamento atualizado' : 'Mapeamento criado');
      setOpenAdd(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    },
    onError: (e: Error) => toast.error(e.message ?? 'Erro ao salvar'),
  });

  // Grava em lote os mapeamentos "seguros" (1 código extraído da descrição).
  // fator_conversao=1 (default do EMPTY_FORM = regra do negócio; founder revisa antes);
  // unidade_portal = sufixo do código; observacoes marca como auto pro contador `automaticos`.
  const gravarSegurosMut = useMutation({
    mutationFn: async (seguros: SugestaoSegura[]) => {
      if (seguros.length === 0) return { criados: 0, pulados: [] as string[] };
      // RE-CONSULTA no clique (não confiar no snapshot do react-query da validação): pega
      // QUALQUER linha existente — ativa OU inativa — pros SKUs dos seguros. Só inserimos os
      // genuinamente novos; existentes são PULADOS pra revisão manual. Fecha a janela de corrida
      // em que um mapa ativo correto poderia ser sobrescrito pelo parser (fator 1). Catch do codex.
      const { data: existentesData, error: eCheck } = await supabase
        .from('sku_fornecedor_externo')
        .select('sku_omie')
        .eq('empresa', 'OBEN')
        .ilike('fornecedor_nome', '%SAYERLACK%')
        .in('sku_omie', seguros.map((s) => s.sku_omie));
      if (eCheck) throw eCheck;
      const skusExistentes = new Set((existentesData ?? []).map((r) => (r as { sku_omie: string }).sku_omie));
      const { novos, pulados } = dividirSegurosParaGravar(seguros, skusExistentes);
      if (novos.length > 0) {
        const rows = novos.map((s) => ({
          empresa: 'OBEN',
          fornecedor_nome: 'RENNER SAYERLACK S/A',
          sku_omie: s.sku_omie,
          sku_portal: s.sku_portal,
          unidade_portal: s.sufixo || 'UN',
          fator_conversao: 1,
          ativo: true,
          observacoes: `extraído automaticamente (parser v${PARSER_VERSION})`,
        }));
        // ignoreDuplicates: INSERT ... ON CONFLICT DO NOTHING — rede contra corrida entre a
        // re-consulta e o insert; nunca sobrescreve uma linha existente.
        const { error } = await supabase
          .from('sku_fornecedor_externo')
          .upsert(rows, { onConflict: 'empresa,fornecedor_nome,sku_omie', ignoreDuplicates: true });
        if (error) throw error;
      }
      return { criados: novos.length, pulados };
    },
    onSuccess: ({ criados, pulados }) => {
      qc.invalidateQueries({ queryKey: ['sku-mapeamento'] });
      if (criados > 0) toast.success(`${criados} mapeamento(s) criado(s) automaticamente`);
      if (pulados.length > 0) {
        toast.info(`${pulados.length} SKU(s) já tinham mapeamento — pulados (revise manualmente): ${pulados.slice(0, 5).join(', ')}${pulados.length > 5 ? '…' : ''}`);
      }
      if (criados === 0 && pulados.length === 0) toast.info('Nenhum mapeamento novo a gravar');
      setOpenValidar(false);
    },
    onError: (e: Error) => toast.error(e.message ?? 'Erro ao gravar mapeamentos'),
  });

  const handleEdit = (m: Mapeamento) => {
    setEditing(m);
    setForm({
      empresa: m.empresa,
      fornecedor_nome: m.fornecedor_nome,
      sku_omie: m.sku_omie,
      sku_portal: m.sku_portal ?? '',
      unidade_portal: m.unidade_portal,
      fator_conversao: Number(m.fator_conversao),
      ativo: m.ativo,
      observacoes: m.observacoes ?? '',
    });
    setOpenAdd(true);
  };

  const handleNovo = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setOpenAdd(true);
  };

  const handleValidar = async () => {
    setValidando(true);
    setOpenValidar(true);
    try {
      // (1) UNIVERSO DO MOTOR — o que a engine de reposição PODE sugerir e vai falhar no portal
      // sem de-para. Espelha os predicados ESTRUTURAIS da RPC gerar_pedidos_sugeridos_ciclo que
      // vivem em sku_parametros: reposição automática ligada, tipo 'automatica', ponto de pedido
      // e estoque máximo definidos. NÃO espelha os predicados de join externo (familia_nao_comprada,
      // omie_products.ativo, sku_status_omie) nem o dinâmico estoque<=ponto — eventual inflação é
      // benigna (de-para que o motor não chega a usar) e é filtrada na revisão humana antes de gravar.
      // É a FONTE do risco real (≠ histórico: pega SKU que o motor pede mesmo que nunca tenha sido pedido).
      const { data: motor, error: e0 } = await supabase
        .from('sku_parametros')
        .select('sku_codigo_omie, sku_descricao')
        .eq('empresa', 'OBEN')
        .ilike('fornecedor_nome', '%SAYERLACK%')
        .eq('ativo', true)
        .eq('habilitado_reposicao_automatica', true)
        .or('tipo_reposicao.is.null,tipo_reposicao.eq.automatica')
        .not('ponto_pedido', 'is', null)
        .not('estoque_maximo', 'is', null);
      if (e0) throw e0;

      // (2) HISTÓRICO — SKUs que já apareceram em pedidos Sayerlack OBEN (visão complementar).
      const { data: itens, error: e1 } = await supabase
        .from('pedido_compra_item')
        .select('sku_codigo_omie, sku_descricao, pedido_id, pedido_compra_sugerido!inner(empresa, fornecedor_nome)')
        .ilike('pedido_compra_sugerido.fornecedor_nome', '%SAYERLACK%')
        .eq('pedido_compra_sugerido.empresa', 'OBEN');
      if (e1) throw e1;

      const skusUnicos = new Map<string, string>();
      (itens as Array<{ sku_codigo_omie: string; sku_descricao: string }> | null)?.forEach((i) => {
        if (!skusUnicos.has(i.sku_codigo_omie)) skusUnicos.set(i.sku_codigo_omie, i.sku_descricao);
      });

      const mapAtivos = new Set(
        (mapeamentos ?? [])
          .filter((m) => m.ativo && m.empresa === 'OBEN' && /SAYERLACK/i.test(m.fornecedor_nome))
          .map((m) => m.sku_omie),
      );

      // faltantesMotor: universo do motor − mapeados ativos − fracionados (450/405ml).
      const faltantesMotor: ValidacaoResult['faltantesMotor'] = [];
      const vistosMotor = new Set<string>();
      (motor as Array<{ sku_codigo_omie: string | number; sku_descricao: string }> | null)?.forEach((r) => {
        const sku = String(r.sku_codigo_omie);
        if (vistosMotor.has(sku)) return;
        vistosMotor.add(sku);
        if (mapAtivos.has(sku) || ehProdutoFracionado(r.sku_descricao)) return;
        faltantesMotor.push({ empresa: 'OBEN', fornecedor_nome: 'RENNER SAYERLACK S/A', sku_codigo_omie: sku, sku_descricao: r.sku_descricao });
      });

      // SKUs com reposição automática DESLIGADA: o motor não pede → não são "faltantes" reais.
      // (ex.: produtos não-comprados pelo portal, como os 8:1 e o selante base água)
      const { data: spDesligados } = await supabase
        .from('sku_parametros')
        .select('sku_codigo_omie')
        .eq('empresa', 'OBEN')
        .eq('habilitado_reposicao_automatica', false);
      const skusDesligados = new Set(
        (spDesligados ?? []).map((r) => String((r as { sku_codigo_omie: unknown }).sku_codigo_omie)),
      );

      const faltantes: ValidacaoResult['faltantes'] = [];
      skusUnicos.forEach((desc, sku) => {
        // só conta como faltante o que o motor REALMENTE vai pedir: não-mapeado, não-fracionado
        // (450/405ml), e com reposição ligada. O resto é fantasma histórico (não-comprado).
        if (mapAtivos.has(sku) || ehProdutoFracionado(desc) || skusDesligados.has(String(sku))) return;
        faltantes.push({
          empresa: 'OBEN',
          fornecedor_nome: 'RENNER SAYERLACK S/A',
          sku_codigo_omie: sku,
          sku_descricao: desc,
        });
      });

      const suspeitos = (mapeamentos ?? []).filter(
        (m) =>
          (m.sku_portal ?? '').trim() === '' ||
          (m.sku_portal ?? '').length < 4 ||
          !/[A-Z]/i.test(m.sku_portal ?? ''),
      );

      const automaticos = (mapeamentos ?? []).filter((m) =>
        (m.observacoes ?? '').toLowerCase().includes('extraído automaticamente'),
      ).length;
      const manuais = (mapeamentos ?? []).length - automaticos;

      // GATE: o parser reproduz os mapeamentos manuais (Sayerlack OBEN ativos)?
      const gabaritoRows = (mapeamentos ?? [])
        .filter((m) => m.ativo && m.empresa === 'OBEN' && /SAYERLACK/i.test(m.fornecedor_nome))
        .map((m) => ({ sku_omie: m.sku_omie, sku_portal: m.sku_portal, descricao: descricoes?.get(m.sku_omie) ?? null }));
      const gabarito = validarGabarito(gabaritoRows);

      // SUGESTÕES vêm do MOTOR (risco real), não mais só do histórico — fecha o gap que o
      // motor pode disparar mesmo que o SKU nunca tenha aparecido num pedido anterior.
      const sugestoes = sugerirMapeamentos(
        faltantesMotor.map((f) => ({ sku_codigo_omie: f.sku_codigo_omie, sku_descricao: f.sku_descricao })),
      );

      setValidacao({
        faltantes,
        faltantesMotor,
        suspeitos,
        total: mapeamentos?.length ?? 0,
        automaticos,
        manuais,
        gabarito,
        sugestoes,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Erro ao validar');
    } finally {
      setValidando(false);
    }
  };

  const handleOpenAddChange = (v: boolean) => {
    setOpenAdd(v);
    if (!v) { setEditing(null); setForm(EMPTY_FORM); }
  };

  return {
    // filtros
    filtroEmpresa, setFiltroEmpresa,
    filtroFornecedor, setFiltroFornecedor,
    filtroAtivo, setFiltroAtivo,
    busca, setBusca,
    empresas, fornecedores,
    // dados
    mapeamentos,
    isLoading,
    descricoes,
    filtrados,
    // add/edit
    openAdd,
    handleOpenAddChange,
    closeAdd: () => setOpenAdd(false),
    isEditing: !!editing,
    form, setForm,
    save: () => upsertMut.mutate({ ...form, id: editing?.id }),
    isSaving: upsertMut.isPending,
    handleEdit,
    handleNovo,
    // validar
    openValidar, setOpenValidar,
    validando, validacao,
    handleValidar,
    gravarSeguros: (seguros: SugestaoSegura[]) => gravarSegurosMut.mutate(seguros),
    gravandoSeguros: gravarSegurosMut.isPending,
  };
}
