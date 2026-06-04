/**
 * TarefasTemplates — CRUD de templates de tarefas recorrentes + auditoria de provas.
 *
 * Gated: isMaster || isGestorComercial.
 *
 * Estrutura:
 *   - Aba "Templates": lista dos templates com toggle ativo/inativo + botão Editar.
 *     Botão "Novo template" abre o dialog de criação.
 *   - Aba "Provas pendentes": lista do ProvasParaAuditar.
 *
 * Validação client-side de alto_risco:
 *   - alto_risco + requer_comprovacao → tipo_comprovacao DEVE ser 'foto_e_leitura'
 *     (o CHECK do banco `tt_altorisco_foto_chk` rejeita no INSERT/UPDATE;
 *     validamos aqui para exibir uma mensagem clara em vez de "database error").
 */

import { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { PlusCircle, Pencil, ToggleLeft, ToggleRight, ChevronDown, Loader2 } from 'lucide-react';

import { useAuth } from '@/contexts/AuthContext';
import { useTemplates, useTemplateMutations } from '@/hooks/useTarefasFase2';
import { useSalespeople } from '@/hooks/useCoverage';
import { ProvasParaAuditar } from '@/components/tarefas/ProvasParaAuditar';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';

import type { TarefaTemplate, TarefaTemplateCadencia, TarefaTipoComprovacao } from '@/lib/tarefas/templates-types';
import type { TarefaCategoria } from '@/lib/tarefas/types';

// ---------------------------------------------------------------------------
// Tipos locais
// ---------------------------------------------------------------------------

/** Dados do formulário (tudo string pra bind fácil; coergimos na submissão). */
interface FormValues {
  descricao: string;
  categoria: TarefaCategoria;
  area: string;
  empresa: string;
  assigned_to: string;
  cadencia: TarefaTemplateCadencia;
  dias_semana: number[];
  janela_inicio: string;
  janela_fim: string;
  tolerancia_dias: string;
  requer_comprovacao: boolean;
  tipo_comprovacao: TarefaTipoComprovacao;
  leitura_min: string;
  leitura_max: string;
  leitura_unidade: string;
  alto_risco: boolean;
  amostra_auditoria_pct: string;
  reincidente_limite: string;
  supervisor_user_id: string;
  ativo: boolean;
}

const FORM_VAZIO: FormValues = {
  descricao: '',
  categoria: 'outro',
  area: '',
  empresa: 'oben',
  assigned_to: '',
  cadencia: 'diaria',
  dias_semana: [],
  janela_inicio: '',
  janela_fim: '',
  tolerancia_dias: '0',
  requer_comprovacao: false,
  tipo_comprovacao: 'nenhuma',
  leitura_min: '',
  leitura_max: '',
  leitura_unidade: '',
  alto_risco: false,
  amostra_auditoria_pct: '10',
  reincidente_limite: '3',
  supervisor_user_id: '',
  ativo: true,
};

// Dias da semana (0 = dom, 6 = sáb)
const DIAS_SEMANA = [
  { val: 0, label: 'Dom' },
  { val: 1, label: 'Seg' },
  { val: 2, label: 'Ter' },
  { val: 3, label: 'Qua' },
  { val: 4, label: 'Qui' },
  { val: 5, label: 'Sex' },
  { val: 6, label: 'Sáb' },
];

const CATEGORIAS: { val: TarefaCategoria; label: string }[] = [
  { val: 'ligar', label: 'Ligar' },
  { val: 'oferecer', label: 'Oferecer' },
  { val: 'preco', label: 'Preço' },
  { val: 'whatsapp', label: 'WhatsApp' },
  { val: 'outro', label: 'Outro' },
];

const CADENCIAS: { val: TarefaTemplateCadencia; label: string }[] = [
  { val: 'diaria', label: 'Diária (todos os dias)' },
  { val: 'dias_uteis', label: 'Dias úteis (seg–sex)' },
  { val: 'semanal', label: 'Semanal (escolher dia)' },
  { val: 'dias_especificos', label: 'Dias específicos' },
];

const TIPOS_COMPROVACAO: { val: TarefaTipoComprovacao; label: string }[] = [
  { val: 'nenhuma', label: 'Nenhuma' },
  { val: 'foto', label: 'Foto' },
  { val: 'leitura', label: 'Leitura numérica' },
  { val: 'foto_e_leitura', label: 'Foto + leitura' },
];

// ---------------------------------------------------------------------------
// Helpers de conversão
// ---------------------------------------------------------------------------

function templateParaForm(t: TarefaTemplate): FormValues {
  return {
    descricao: t.descricao,
    categoria: t.categoria,
    area: t.area,
    empresa: t.empresa,
    assigned_to: t.assigned_to,
    cadencia: t.cadencia,
    dias_semana: t.dias_semana ?? [],
    janela_inicio: t.janela_inicio?.slice(0, 5) ?? '',
    janela_fim: t.janela_fim?.slice(0, 5) ?? '',
    tolerancia_dias: String(t.tolerancia_dias),
    requer_comprovacao: t.requer_comprovacao,
    tipo_comprovacao: t.tipo_comprovacao,
    leitura_min: t.leitura_min != null ? String(t.leitura_min) : '',
    leitura_max: t.leitura_max != null ? String(t.leitura_max) : '',
    leitura_unidade: t.leitura_unidade ?? '',
    alto_risco: t.alto_risco,
    amostra_auditoria_pct: String(t.amostra_auditoria_pct),
    reincidente_limite: String(t.reincidente_limite),
    supervisor_user_id: t.supervisor_user_id ?? '',
    ativo: t.ativo,
  };
}

function formParaPayload(
  f: FormValues,
  userId: string,
): Omit<TarefaTemplate, 'id' | 'created_at' | 'updated_at'> {
  return {
    descricao: f.descricao.trim(),
    categoria: f.categoria,
    area: f.area.trim(),
    empresa: f.empresa,
    assigned_to: f.assigned_to,
    customer_user_id: null,
    cadencia: f.cadencia,
    dias_semana: ['semanal', 'dias_especificos'].includes(f.cadencia) ? f.dias_semana : null,
    janela_inicio: f.janela_inicio || null,
    janela_fim: f.janela_fim || null,
    tolerancia_dias: Math.max(0, parseInt(f.tolerancia_dias, 10) || 0),
    requer_comprovacao: f.requer_comprovacao,
    tipo_comprovacao: f.requer_comprovacao ? f.tipo_comprovacao : 'nenhuma',
    leitura_min: f.leitura_min.trim() !== '' ? parseFloat(f.leitura_min) : null,
    leitura_max: f.leitura_max.trim() !== '' ? parseFloat(f.leitura_max) : null,
    leitura_unidade: f.leitura_unidade.trim() || null,
    alto_risco: f.alto_risco,
    amostra_auditoria_pct: Math.min(100, Math.max(0, parseInt(f.amostra_auditoria_pct, 10) || 10)),
    reincidente_limite: Math.max(1, parseInt(f.reincidente_limite, 10) || 3),
    supervisor_user_id: f.supervisor_user_id || null,
    ativo: f.ativo,
    created_by: userId,
  };
}

// ---------------------------------------------------------------------------
// Validação client-side
// ---------------------------------------------------------------------------

function validarForm(f: FormValues): string | null {
  if (!f.descricao.trim()) return 'Descrição é obrigatória.';
  if (!f.area.trim()) return 'Área é obrigatória.';
  if (!f.assigned_to) return 'Selecione a vendedora responsável.';

  if (['semanal', 'dias_especificos'].includes(f.cadencia) && f.dias_semana.length === 0) {
    return 'Selecione pelo menos um dia da semana.';
  }

  if (f.janela_inicio && f.janela_fim && f.janela_inicio >= f.janela_fim) {
    return 'Janela de início deve ser antes da janela de fim.';
  }

  if (f.requer_comprovacao && f.tipo_comprovacao === 'nenhuma') {
    return 'Selecione o tipo de comprovação quando "Exigir comprovação" está ativo.';
  }

  // CHECK do banco: alto_risco + requer_comprovacao → tipo_comprovacao = 'foto_e_leitura'
  if (f.alto_risco && f.requer_comprovacao && f.tipo_comprovacao !== 'foto_e_leitura') {
    return 'Tarefa de alto risco com comprovação exige o tipo "Foto + leitura".';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Dialog de criação/edição
// ---------------------------------------------------------------------------

interface TemplateDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  templateEditando: TarefaTemplate | null;
}

function TemplateDialog({ open, onOpenChange, templateEditando }: TemplateDialogProps) {
  const { user } = useAuth();
  const { criarTemplate, editarTemplate } = useTemplateMutations();
  const { data: salespeople = [] } = useSalespeople();

  const [form, setForm] = useState<FormValues>(FORM_VAZIO);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [mostraAvancado, setMostraAvancado] = useState(false);

  // Preenche o form ao editar
  useEffect(() => {
    if (templateEditando) {
      setForm(templateParaForm(templateEditando));
    } else {
      setForm(FORM_VAZIO);
    }
    setErro(null);
    setMostraAvancado(false);
  }, [templateEditando, open]);

  const set = <K extends keyof FormValues>(key: K, val: FormValues[K]) => {
    setForm((prev) => ({ ...prev, [key]: val }));
    setErro(null);
  };

  const toggleDia = (dia: number) => {
    set(
      'dias_semana',
      form.dias_semana.includes(dia)
        ? form.dias_semana.filter((d) => d !== dia)
        : [...form.dias_semana, dia].sort(),
    );
  };

  const handleSalvar = async () => {
    const erroValidacao = validarForm(form);
    if (erroValidacao) { setErro(erroValidacao); return; }
    if (!user) return;

    setSalvando(true);
    try {
      const payload = formParaPayload(form, user.id);
      if (templateEditando) {
        await editarTemplate(templateEditando.id, payload);
      } else {
        await criarTemplate(payload);
      }
      onOpenChange(false);
    } finally {
      setSalvando(false);
    }
  };

  const mostrarDiasSemana = ['semanal', 'dias_especificos'].includes(form.cadencia);
  const mostrarLeitura =
    form.requer_comprovacao &&
    ['leitura', 'foto_e_leitura'].includes(form.tipo_comprovacao);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !salvando) onOpenChange(false); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {templateEditando ? 'Editar template' : 'Novo template de tarefa recorrente'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Descrição */}
          <div className="space-y-1.5">
            <Label htmlFor="tt-descricao">Descrição <span className="text-status-error">*</span></Label>
            <Textarea
              id="tt-descricao"
              placeholder="Ex.: Verificar pH do banho de tinta"
              rows={2}
              value={form.descricao}
              onChange={(e) => set('descricao', e.target.value)}
              disabled={salvando}
            />
          </div>

          {/* Categoria + Área */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Categoria <span className="text-status-error">*</span></Label>
              <Select value={form.categoria} onValueChange={(v) => set('categoria', v as TarefaCategoria)}>
                <SelectTrigger disabled={salvando}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIAS.map((c) => (
                    <SelectItem key={c.val} value={c.val}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tt-area">Área <span className="text-status-error">*</span></Label>
              <Input
                id="tt-area"
                placeholder="Ex.: Tintométrico"
                value={form.area}
                onChange={(e) => set('area', e.target.value)}
                disabled={salvando}
              />
            </div>
          </div>

          {/* Empresa + Vendedora */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Empresa <span className="text-status-error">*</span></Label>
              <Select value={form.empresa} onValueChange={(v) => set('empresa', v)}>
                <SelectTrigger disabled={salvando}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="oben">Oben Comercial</SelectItem>
                  <SelectItem value="colacor">Colacor</SelectItem>
                  <SelectItem value="colacor_sc">Colacor SC</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Responsável <span className="text-status-error">*</span></Label>
              <Select value={form.assigned_to} onValueChange={(v) => set('assigned_to', v)}>
                <SelectTrigger disabled={salvando}>
                  <SelectValue placeholder="Selecione…" />
                </SelectTrigger>
                <SelectContent>
                  {salespeople.map((s) => (
                    <SelectItem key={s.user_id} value={s.user_id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Cadência */}
          <div className="space-y-1.5">
            <Label>Cadência <span className="text-status-error">*</span></Label>
            <Select value={form.cadencia} onValueChange={(v) => set('cadencia', v as TarefaTemplateCadencia)}>
              <SelectTrigger disabled={salvando}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CADENCIAS.map((c) => (
                  <SelectItem key={c.val} value={c.val}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Seletor de dias da semana (semanal / dias_especificos) */}
          {mostrarDiasSemana && (
            <div className="space-y-2">
              <Label>Dias da semana <span className="text-status-error">*</span></Label>
              <div className="flex flex-wrap gap-2">
                {DIAS_SEMANA.map((d) => (
                  <button
                    key={d.val}
                    type="button"
                    disabled={salvando}
                    onClick={() => toggleDia(d.val)}
                    className={[
                      'px-3 py-1.5 rounded-md text-xs font-medium border transition-colors',
                      form.dias_semana.includes(d.val)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border hover:bg-muted',
                    ].join(' ')}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Janela de horário */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tt-janela-ini">Janela início (opcional)</Label>
              <Input
                id="tt-janela-ini"
                type="time"
                value={form.janela_inicio}
                onChange={(e) => set('janela_inicio', e.target.value)}
                disabled={salvando}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tt-janela-fim">Janela fim (opcional)</Label>
              <Input
                id="tt-janela-fim"
                type="time"
                value={form.janela_fim}
                onChange={(e) => set('janela_fim', e.target.value)}
                disabled={salvando}
              />
            </div>
          </div>

          {/* Tolerância */}
          <div className="space-y-1.5">
            <Label htmlFor="tt-tolerancia">Tolerância (dias após vencimento)</Label>
            <Input
              id="tt-tolerancia"
              type="number"
              min={0}
              max={30}
              value={form.tolerancia_dias}
              onChange={(e) => set('tolerancia_dias', e.target.value)}
              disabled={salvando}
              className="w-24"
            />
          </div>

          {/* Comprovação */}
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>Exigir comprovação</Label>
                <p className="text-xs text-muted-foreground">Operador deve annexar prova ao concluir.</p>
              </div>
              <Switch
                checked={form.requer_comprovacao}
                onCheckedChange={(v) => {
                  set('requer_comprovacao', v);
                  if (!v) set('tipo_comprovacao', 'nenhuma');
                }}
                disabled={salvando}
              />
            </div>

            {form.requer_comprovacao && (
              <div className="space-y-3 pt-1">
                <div className="space-y-1.5">
                  <Label>Tipo de comprovação</Label>
                  <Select
                    value={form.tipo_comprovacao}
                    onValueChange={(v) => set('tipo_comprovacao', v as TarefaTipoComprovacao)}
                  >
                    <SelectTrigger disabled={salvando}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIPOS_COMPROVACAO.filter((t) => t.val !== 'nenhuma').map((t) => (
                        <SelectItem key={t.val} value={t.val}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Campos de leitura */}
                {mostrarLeitura && (
                  <div className="space-y-2">
                    <Label className="text-sm">Faixa de leitura (opcional)</Label>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor="tt-lmin" className="text-xs text-muted-foreground">Mínimo</Label>
                        <Input
                          id="tt-lmin"
                          type="number"
                          placeholder="Ex.: 7.0"
                          value={form.leitura_min}
                          onChange={(e) => set('leitura_min', e.target.value)}
                          disabled={salvando}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="tt-lmax" className="text-xs text-muted-foreground">Máximo</Label>
                        <Input
                          id="tt-lmax"
                          type="number"
                          placeholder="Ex.: 7.5"
                          value={form.leitura_max}
                          onChange={(e) => set('leitura_max', e.target.value)}
                          disabled={salvando}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="tt-lunidade" className="text-xs text-muted-foreground">Unidade</Label>
                        <Input
                          id="tt-lunidade"
                          placeholder="Ex.: pH"
                          value={form.leitura_unidade}
                          onChange={(e) => set('leitura_unidade', e.target.value)}
                          disabled={salvando}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Alto risco */}
          <div className="flex items-start gap-3">
            <Checkbox
              id="tt-altorisco"
              checked={form.alto_risco}
              onCheckedChange={(v) => set('alto_risco', !!v)}
              disabled={salvando}
              className="mt-0.5"
            />
            <div>
              <Label htmlFor="tt-altorisco" className="font-medium cursor-pointer">Alto risco</Label>
              <p className="text-xs text-muted-foreground">
                Exige "Foto + leitura" quando comprovação estiver ativa (restrição do banco).
              </p>
            </div>
          </div>

          {/* Configurações avançadas (collapsible) */}
          <button
            type="button"
            onClick={() => setMostraAvancado((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown
              className={[
                'w-3.5 h-3.5 transition-transform',
                mostraAvancado ? 'rotate-180' : '',
              ].join(' ')}
            />
            Configurações avançadas
          </button>

          {mostraAvancado && (
            <div className="space-y-3 pt-1">
              {/* Amostra de auditoria */}
              <div className="space-y-1.5">
                <Label htmlFor="tt-auditoria">% para auditoria aleatória</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="tt-auditoria"
                    type="number"
                    min={0}
                    max={100}
                    value={form.amostra_auditoria_pct}
                    onChange={(e) => set('amostra_auditoria_pct', e.target.value)}
                    disabled={salvando}
                    className="w-24"
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Das provas enviadas, essa % será sorteada para revisão manual.
                </p>
              </div>

              {/* Limite de reincidência */}
              <div className="space-y-1.5">
                <Label htmlFor="tt-reincidente">Limite de reincidência (vezes)</Label>
                <Input
                  id="tt-reincidente"
                  type="number"
                  min={1}
                  max={30}
                  value={form.reincidente_limite}
                  onChange={(e) => set('reincidente_limite', e.target.value)}
                  disabled={salvando}
                  className="w-24"
                />
              </div>

              {/* Supervisor */}
              <div className="space-y-1.5">
                <Label>Supervisor (opcional)</Label>
                <Select
                  value={form.supervisor_user_id}
                  onValueChange={(v) => set('supervisor_user_id', v === '_nenhum' ? '' : v)}
                >
                  <SelectTrigger disabled={salvando}>
                    <SelectValue placeholder="Nenhum" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_nenhum">Nenhum</SelectItem>
                    {salespeople.map((s) => (
                      <SelectItem key={s.user_id} value={s.user_id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Ativo/inativo (só no modo de edição) */}
              {templateEditando && (
                <div className="flex items-center gap-3">
                  <Switch
                    id="tt-ativo"
                    checked={form.ativo}
                    onCheckedChange={(v) => set('ativo', v)}
                    disabled={salvando}
                  />
                  <Label htmlFor="tt-ativo" className="cursor-pointer">
                    {form.ativo ? 'Template ativo' : 'Template inativo'}
                  </Label>
                </div>
              )}
            </div>
          )}

          {/* Erro de validação */}
          {erro && (
            <p className="text-sm text-status-error border border-status-error/30 bg-status-error-bg rounded-md px-3 py-2">
              {erro}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" disabled={salvando} onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={salvando} onClick={handleSalvar}>
            {salvando ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Salvando…
              </>
            ) : templateEditando ? 'Salvar alterações' : 'Criar template'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Card de template na lista
// ---------------------------------------------------------------------------

interface TemplateCardProps {
  template: TarefaTemplate;
  nomeAssignee: string;
  onEditar: () => void;
  onToggleAtivo: () => void;
  toggling: boolean;
}

function TemplateCard({
  template: t,
  nomeAssignee,
  onEditar,
  onToggleAtivo,
  toggling,
}: TemplateCardProps) {
  const cadenciaLabel = CADENCIAS.find((c) => c.val === t.cadencia)?.label ?? t.cadencia;

  return (
    <Card
      className={[
        'p-3 flex items-start justify-between gap-3',
        !t.ativo ? 'opacity-60' : '',
      ].join(' ')}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium">{t.descricao}</p>
          {t.alto_risco && (
            <Badge variant="destructive" className="text-2xs">alto risco</Badge>
          )}
          {!t.ativo && (
            <Badge variant="outline" className="text-2xs">inativo</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t.area} · {nomeAssignee} · {cadenciaLabel}
          {t.requer_comprovacao && ` · ${TIPOS_COMPROVACAO.find((tp) => tp.val === t.tipo_comprovacao)?.label ?? t.tipo_comprovacao}`}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" onClick={onEditar} title="Editar template">
          <Pencil className="w-3.5 h-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onToggleAtivo}
          disabled={toggling}
          title={t.ativo ? 'Desativar template' : 'Ativar template'}
        >
          {toggling ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : t.ativo ? (
            <ToggleRight className="w-4 h-4 text-status-success" />
          ) : (
            <ToggleLeft className="w-4 h-4 text-muted-foreground" />
          )}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Página principal
// ---------------------------------------------------------------------------

export default function TarefasTemplates() {
  const { isMaster, isGestorComercial } = useAuth();
  const podeGerir = isMaster || isGestorComercial;

  const { data: templates = [], isLoading } = useTemplates();
  const { toggleTemplateAtivo } = useTemplateMutations();
  const { data: salespeople = [] } = useSalespeople();

  const [dialogAberto, setDialogAberto] = useState(false);
  const [editando, setEditando] = useState<TarefaTemplate | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  if (!podeGerir) return <Navigate to="/" replace />;

  const resolverNome = (userId: string) =>
    salespeople.find((s) => s.user_id === userId)?.name ?? userId.slice(0, 8);

  const abrirNovo = () => {
    setEditando(null);
    setDialogAberto(true);
  };

  const abrirEditar = (t: TarefaTemplate) => {
    setEditando(t);
    setDialogAberto(true);
  };

  const handleToggle = async (t: TarefaTemplate) => {
    setTogglingId(t.id);
    try {
      await toggleTemplateAtivo(t.id, !t.ativo);
    } finally {
      setTogglingId(null);
    }
  };

  // Contagem de provas para badge da aba (meramente indicativa — o hook está no filho)
  const ativos = templates.filter((t) => t.ativo).length;

  return (
    <div className="container py-6 space-y-4">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl">Tarefas recorrentes</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Templates de atividades + auditoria de comprovações
          </p>
        </div>
        <Button onClick={abrirNovo}>
          <PlusCircle className="w-4 h-4 mr-2" />
          Novo template
        </Button>
      </div>

      <Tabs defaultValue="templates">
        <TabsList>
          <TabsTrigger value="templates">
            Templates
            {templates.length > 0 && (
              <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
                ({ativos}/{templates.length})
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="provas">Provas pendentes</TabsTrigger>
        </TabsList>

        {/* Aba: lista de templates */}
        <TabsContent value="templates" className="mt-4">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              Carregando templates…
            </div>
          ) : templates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <p className="text-sm font-medium">Nenhum template criado</p>
              <p className="text-xs text-muted-foreground mt-1">
                Clique em "Novo template" para definir uma atividade recorrente.
              </p>
              <Button className="mt-4" onClick={abrirNovo}>
                <PlusCircle className="w-4 h-4 mr-2" />
                Novo template
              </Button>
            </div>
          ) : (
            <ul className="space-y-2">
              {templates.map((t) => (
                <li key={t.id}>
                  <TemplateCard
                    template={t}
                    nomeAssignee={resolverNome(t.assigned_to)}
                    onEditar={() => abrirEditar(t)}
                    onToggleAtivo={() => handleToggle(t)}
                    toggling={togglingId === t.id}
                  />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        {/* Aba: provas aguardando auditoria */}
        <TabsContent value="provas" className="mt-4">
          <ProvasParaAuditar />
        </TabsContent>
      </Tabs>

      {/* Dialog de criar/editar */}
      <TemplateDialog
        open={dialogAberto}
        onOpenChange={setDialogAberto}
        templateEditando={editando}
      />
    </div>
  );
}
