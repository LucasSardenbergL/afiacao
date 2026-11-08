import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { AvisoVinculoCredito } from '@/components/credito-vinculo/AvisoVinculoCredito';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useEffect, useRef, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { cadastravelNoOmie } from '@/lib/radar/sugeridos';
import type { AcaoContato } from '@/lib/radar/ui-helpers';
import { MapPin, Mail, MessageSquare, ChevronRight, History, PhoneCall } from 'lucide-react';
import { RadarOutcomeMenu, type RegistroInfo } from './RadarOutcomeMenu';
import { useAuth } from '@/contexts/AuthContext';
import { gravarRascunhoNota, lerRascunhoNota, limparRascunhoNota } from '@/lib/radar/rascunho-nota';
import { RadarAcoesLead } from './RadarAcoesLead';
import { RadarConflitosDoLead } from './RadarConflitosCadastro';
import { RadarAtendimentoLead } from './RadarAtendimentoLead';
import { RadarModoDiscagem } from './RadarModoDiscagem';
import { RadarSucessaoLead } from './RadarSucessaoLead';
import { RadarTelefoneAcao } from './RadarTelefoneAcao';
import { RadarContatoContabil, RadarPrefiraVisita } from './RadarContatoContabil';
import { Selo } from './Selo';
import { avisoTelefoneCompartilhado, gravarModoDiscagem, lerModoDiscagem } from '@/lib/radar/atendimento';
import { useRadarTelefoneCompartilhado } from '@/queries/useRadarTelefoneCompartilhado';
import { useRadarContatoContabil } from '@/queries/useRadarContatoContabil';
import { urlMapsEmpresa, urlMapsEndereco } from '@/lib/radar/mapa-link';
import {
  algumTelefoneContabil, contabilDoCampo, SELO_CONTABIL, type CampoContato, type ContatoContabil,
} from '@/lib/radar/contato-contabil';
import { track } from '@/lib/analytics';
import { registrarNoLedger } from '@/lib/analytics-ledger';
import { isCellphone, whatsappLink } from '@/lib/phone';
import { estadoDeLeitura, naoConsegui, desatualizado } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { useRadarContatos, LIMITE_HISTORICO_RADAR } from '@/queries/useRadarContatos';
import {
  formatarCnpj, formatarCapital, rotuloPorte, idadeEmAnos, rotuloStatus, tomStatus, seloRfb, scoreUI,
  selosFilial, textoFilialFicha, telefonePrincipal, type IrmaosRaiz, type EstadoIrmaos,
} from '@/lib/radar/ui-helpers';
import type { RadarEmpresa } from '@/queries/useRadarLista';
import { ehInedito, saiuDoDump, rotuloSaiuDoDump, type LoteIngest } from '@/lib/radar/lote-vigente';

function Linha({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/**
 * `outras`: em quantas OUTRAS raízes de CNPJ o número aparece; undefined = não consegui verificar (sem aviso).
 * `contato`: a classificação "é da contabilidade?" deste campo (migration 20261109140000). Da contabilidade no efetivo,
 * ligar e WhatsApp continuam, mas SEM destaque — a ação da ficha passa a ser a visita.
 */
function Telefone({ numero, outras, cnpj, campo, contato }: {
  numero: string; outras?: number; cnpj: string; campo: CampoContato; contato?: ContatoContabil | null;
}) {
  const contabil = contato?.efetivo === true;
  const wa = isCellphone(numero) ? whatsappLink(numero) : null;
  // O aviso genérico de "aparece em N empresas" sai quando o selo já explica (o motivo traz a contagem).
  const aviso = outras != null && !contabil ? avisoTelefoneCompartilhado(outras) : null;
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span className={contabil ? 'font-tabular text-muted-foreground' : 'font-tabular'}>{numero}</span>
      <RadarTelefoneAcao telefone={numero} discreto={contabil} />
      {wa && (
        <a className={contabil ? 'inline-flex items-center gap-1 text-xs text-muted-foreground' : 'inline-flex items-center gap-1 text-xs text-status-success-bold'}
          href={wa} target="_blank" rel="noreferrer">
          <MessageSquare className="w-3 h-3" /> WhatsApp
        </a>
      )}
      {aviso && <span className="basis-full text-xs text-status-warning" data-testid="radar-telefone-compartilhado">{aviso}</span>}
      <RadarContatoContabil cnpj={cnpj} campo={campo} contato={contato} />
    </span>
  );
}

/** Histórico de contatos: distingue erro de vazio (erro colapsado em vazio é a classe que o Radar já pagou). */
function Historico({ cnpj }: { cnpj: string }) {
  const q = useRadarContatos(cnpj);
  const estado = estadoDeLeitura(q);
  const velho = desatualizado(q, Boolean(q.data));
  return (
    <div className="mt-4">
      <div className="flex items-center gap-1 text-sm font-medium mb-1">
        <History className="w-4 h-4" /> Histórico
        <span className="text-xs text-muted-foreground font-normal">(últimos {LIMITE_HISTORICO_RADAR})</span>
      </div>
      {estado === 'carregando' ? (
        <div className="space-y-1">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-6" />)}</div>
      ) : naoConsegui(estado) && !q.data ? (
        <AvisoLeituraFalhou oque="o histórico de contatos" estado={estado} className="mb-0" />
      ) : !q.data || q.data.length === 0 ? (
        <>
          <p className="text-xs text-muted-foreground">Nenhum contato registrado ainda.</p>
          {velho && <AvisoLeituraFalhou oque="a leitura mais recente do histórico" estado={velho} className="mt-1" />}
        </>
      ) : (
        <ul className="divide-y text-sm">
          {q.data.map((c) => (
            <li key={c.id} className="py-1.5 flex items-start gap-2">
              <Selo tom={tomStatus(c.acao)}>{rotuloStatus(c.acao)}</Selo>
              <div className="min-w-0 flex-1">
                {c.nota && <div className="whitespace-pre-wrap break-words" data-testid="radar-historico-nota">{c.nota}</div>}
                <div className="text-xs text-muted-foreground">
                  {new Date(c.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                  {' · '}<span data-testid="radar-historico-autor">{c.autor ?? 'autor não identificado'}</span>
                  {c.status_anterior ? ` · antes: ${rotuloStatus(c.status_anterior)}` : ''}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {velho && q.data && q.data.length > 0 && <AvisoLeituraFalhou oque="a leitura mais recente do histórico" estado={velho} className="mt-1" />}
    </div>
  );
}

export function RadarDetailSheet({
  empresa,
  hojeISO,
  onClose,
  onProximo,
  lote = null,
  irmaos = null,
  irmaosEstado = 'carregando',
}: {
  empresa: RadarEmpresa | null;
  hojeISO: string;
  onClose: () => void;
  /** Avança para o próximo lead da lista (registrar desfecho → próximo, sem fechar a ficha). */
  onProximo?: () => void;
  /** Lote vigente — selos "inédito" / "saiu do dump em <mês>" (só o fato; o motivo é outra entrega). */
  lote?: LoteIngest | null;
  /** Outros estabelecimentos da mesma raiz de CNPJ e o estado da leitura (a ficha diz "não consegui verificar"). */
  irmaos?: IrmaosRaiz | null;
  irmaosEstado?: EstadoIrmaos;
}) {
  const [discagem, setDiscagem] = useState(lerModoDiscagem);
  // Nota do PRÓXIMO registro (B4), por lead. Pacote G4: o texto do vendedor nunca se perde — trocar de ficha GUARDA o
  // rascunho (por usuário + CNPJ) e voltar o restaura; só some quando o servidor confirma que gravou.
  const { user } = useAuth();
  const dono = user?.id ?? 'anon';
  const [nota, setNotaEstado] = useState('');
  const notaRef = useRef('');
  const setNota = (v: string) => {
    notaRef.current = v;
    setNotaEstado(v);
  };
  const [conversaSalva, setConversaSalva] = useState<string | null>(null);
  const compartilhado = useRadarTelefoneCompartilhado(empresa?.cnpj ?? null);
  const contabil = useRadarContatoContabil(empresa?.cnpj ?? null);
  // Sensor da ficha: 1 chamada por CNPJ aberto (não por render/refetch); o dedup por titular, CNPJ e dia é do banco.
  // Sob a lente "Ver como" o registrarNoLedger retorna cedo — inspeção não infla o 'abriu'.
  const cnpjAberto = empresa?.cnpj ?? null;
  useEffect(() => {
    const v = cnpjAberto ? lerRascunhoNota(`${dono}:${cnpjAberto}`) : '';
    notaRef.current = v;
    setNotaEstado(v);
  }, [cnpjAberto, dono]);
  useEffect(() => {
    if (cnpjAberto) void registrarNoLedger('radar.ficha_aberta', cnpjAberto, { cnpj: cnpjAberto });
  }, [cnpjAberto]);
  if (!empresa) return null;
  const alternarDiscagem = () => {
    const v = !discagem;
    setDiscagem(v);
    gravarModoDiscagem(v);
    track('radar.modo_discagem', { ligado: v });
  };
  const outras = (tel: string) => compartilhado.data?.get(tel);
  // Depois do registro: "em conversa" num lead cadastrável FICA na ficha — o cadastro no Omie é a próxima ação
  // dela (B6, sem janela automática); os outros desfechos seguem para o próximo lead.
  const chaveRascunho = `${dono}:${empresa.cnpj}`;
  const aposRegistro = (acao: AcaoContato, { notaGravada, notaEnviada }: RegistroInfo) => {
    // Nota NÃO gravada (dedupe no banco anterior, ou já cliente): fica no campo e a ficha não avança — avançar trocava
    // de CNPJ e apagava o texto (o bug que o pacote G4 fecha). O menu já avisou.
    if (!notaGravada) return;
    // Só apaga o que foi ENVIADO: se o vendedor continuou digitando durante a resposta, o texto novo fica.
    if ((notaRef.current.trim() || undefined) === notaEnviada) {
      setNota('');
      limparRascunhoNota(chaveRascunho);
    }
    if (acao === 'em_conversa' && cadastravelNoOmie(empresa).ok) { setConversaSalva(empresa.cnpj); return; }
    setConversaSalva(null);
    onProximo?.();
  };
  // Desfazer o contato apaga o sinal otimista: o botão de cadastro volta a depender do status relido.
  const aposDesfazer = () => setConversaSalva(null);
  const campoNota = (
    <Textarea
      value={nota}
      onChange={(e) => { setNota(e.target.value); gravarRascunhoNota(chaveRascunho, e.target.value); }}
      placeholder="Nota da conversa (opcional): quem atendeu, o que precisa, próximo passo"
      className="min-h-[60px] text-sm"
      aria-label="Nota da conversa"
      maxLength={1000}
    />
  );
  const telPrincipal = telefonePrincipal(empresa);
  const leituraContabil = contabil.data ?? null;
  const campoPrincipal: CampoContato = empresa.telefone1 ? 'telefone1' : 'telefone2';
  const principalContabil = telPrincipal ? contabilDoCampo(leituraContabil, campoPrincipal) : null;
  const prefiraVisita = !!leituraContabil && (leituraContabil.visitar || algumTelefoneContabil(leituraContabil));
  const endereco = [empresa.logradouro, empresa.numero, empresa.bairro, empresa.municipio_nome, empresa.uf, empresa.cep]
    .filter(Boolean)
    .join(', ');
  // Busca que o Maps resolve como ENDEREÇO ("Rua X 75, Cidade - UF") e, à parte, a busca pela EMPRESA (src/lib/radar/mapa-link.ts).
  const mapsUrl = urlMapsEndereco(empresa);
  const mapsEmpresaUrl = urlMapsEmpresa(empresa);
  const abriuMapa = (link: 'endereco' | 'empresa', origem: 'linha' | 'visita') => track('radar.mapa_ficha', { link, origem });
  const idade = idadeEmAnos(empresa.data_abertura, hojeISO);
  const nome = empresa.razao_social || empresa.cnpj;
  const rfb = seloRfb(empresa);
  const score = scoreUI(empresa.score, empresa.score_motivos);

  return (
    <Sheet open={!!empresa} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 flex-wrap">
            {nome}
            <Selo tom={tomStatus(empresa.prospeccao_status)} className="font-normal">{rotuloStatus(empresa.prospeccao_status)}</Selo>
            {empresa.ja_cliente && <Badge variant="secondary">já é cliente</Badge>}
            {ehInedito(empresa, lote) && <Badge variant="info">inédito</Badge>}
            {saiuDoDump(empresa, lote) && (
              <Badge variant="outline" className="text-muted-foreground font-normal">{rotuloSaiuDoDump(empresa.ultimo_lote)}</Badge>
            )}
            {rfb && (
              <Selo tom={rfb.tom} title={rfb.titulo} className="font-normal" data-testid="selo-rfb">{rfb.texto}</Selo>
            )}
          </SheetTitle>
        </SheetHeader>
        <div className="mt-3 flex items-center justify-between gap-2">
          <RadarAtendimentoLead cnpj={empresa.cnpj} jaCliente={empresa.ja_cliente} />
          <Button variant={discagem ? 'secondary' : 'ghost'} size="sm" onClick={alternarDiscagem} aria-pressed={discagem}
            title="Telefone grande, Ligar, desfechos e Próximo num painel só">
            <PhoneCall className="w-4 h-4 mr-1" /> Modo discagem
          </Button>
        </div>
        {discagem ? (
          <div className="mt-3">
            <RadarModoDiscagem empresa={empresa} compartilhado={compartilhado.data} nota={nota} campoNota={campoNota}
              onRegistrado={aposRegistro} onDesfeito={aposDesfazer}
              ligar={telPrincipal ? <RadarTelefoneAcao telefone={telPrincipal} variant="full" discreto={!!principalContabil} /> : null}
              avisoContabil={principalContabil ? (
                <p className="text-xs text-status-warning" data-testid="radar-discagem-contabil">{SELO_CONTABIL}</p>
              ) : null}
              compartilhadoFalhou={compartilhado.isError} onProximo={onProximo} />
          </div>
        ) : (
          <div className="mt-4 space-y-2">
          {campoNota}
          <div className="flex items-center justify-between gap-2">
            {onProximo ? (
              <Button variant="ghost" size="sm" onClick={onProximo} title="Pular para o próximo lead da lista">
                Próximo <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            ) : <span />}
            <RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} nota={nota} onRegistrado={aposRegistro} onDesfeito={aposDesfazer} />
          </div>
          </div>
        )}
        <div className="mt-3 space-y-2">
          <RadarConflitosDoLead cnpj={empresa.cnpj} />
          {/* Antes do cadastro no Omie: a edge cria no Omie ANTES de registrar, o aviso tem de ser leitura prévia. */}
          <AvisoVinculoCredito documento={empresa.cnpj} superficie="ficha_radar" />
          <RadarAcoesLead empresa={empresa} conversaSalva={conversaSalva === empresa.cnpj} />
          {prefiraVisita && endereco && (
            <RadarPrefiraVisita endereco={endereco} mapsUrl={mapsUrl} mapsEmpresaUrl={mapsEmpresaUrl}
              todos={leituraContabil?.visitar === true} onAbrir={(link) => abriuMapa(link, 'visita')} />
          )}
        </div>
        <div className="mt-4 divide-y">
          <Linha label="Score">
            <Selo tom={score.tom} className="font-tabular" data-testid="radar-score-ficha">
              {score.texto}{empresa.score != null ? ' / 100' : ''}
            </Selo>
            {empresa.score != null && empresa.score_motivos && empresa.score_motivos.length > 0 ? (
              <ul className="mt-1 text-xs text-muted-foreground list-disc pl-4">
                {empresa.score_motivos.map((m) => <li key={m}>{m}</li>)}
              </ul>
            ) : (
              <span className="ml-2 text-xs text-muted-foreground">{score.detalhe}</span>
            )}
          </Linha>
          <Linha label="Mesma empresa">
            {selosFilial(irmaosEstado === 'ok' ? irmaos : null).map((s) => (
              <Selo key={s.chave} tom={s.tom} className="mr-1.5">{s.texto}</Selo>
            ))}
            <span className="text-xs text-muted-foreground" data-testid="radar-filial-ficha">
              {textoFilialFicha(irmaosEstado, irmaos)}
            </span>
          </Linha>
          <Linha label="Já é cliente?">
            <RadarSucessaoLead cnpj={empresa.cnpj} dataAbertura={empresa.data_abertura ?? null} />
          </Linha>
          {empresa.nome_fantasia && <Linha label="Fantasia">{empresa.nome_fantasia}</Linha>}
          <Linha label="CNPJ"><span className="font-tabular">{formatarCnpj(empresa.cnpj)}</span></Linha>
          <Linha label="CNAE">
            {empresa.cnae_principal}
            {empresa.cnae_descricao ? ` — ${empresa.cnae_descricao}` : ''}
          </Linha>
          <Linha label="Abertura">
            {empresa.data_abertura ?? '—'} {idade != null ? `(${idade} anos)` : ''}
          </Linha>
          <Linha label="Porte">{rotuloPorte(empresa.porte)}</Linha>
          <Linha label="Capital">{formatarCapital(empresa.capital_social)}</Linha>
          <Linha label="Telefone">
            {empresa.telefone1 ? (
              <Telefone numero={empresa.telefone1} outras={outras(empresa.telefone1)} cnpj={empresa.cnpj} campo="telefone1"
                contato={leituraContabil?.contatos.get('telefone1')} />
            ) : '—'}
          </Linha>
          {compartilhado.isError && (empresa.telefone1 || empresa.telefone2) && (
            <p className="py-1 text-xs text-muted-foreground" data-testid="radar-telefone-compartilhado-erro">
              Não consegui verificar se o telefone aparece em outras empresas.
            </p>
          )}
          {empresa.telefone2 && (
            <Linha label="Telefone 2">
              <Telefone numero={empresa.telefone2} outras={outras(empresa.telefone2)} cnpj={empresa.cnpj} campo="telefone2"
                contato={leituraContabil?.contatos.get('telefone2')} />
            </Linha>
          )}
          <Linha label="E-mail">
            {empresa.email ? (
              <span className="inline-flex items-center gap-1.5 flex-wrap min-w-0">
                <a className="inline-flex items-center gap-1 underline truncate" href={`mailto:${empresa.email}`}>
                  <Mail className="w-3 h-3" />{empresa.email}
                </a>
                <RadarContatoContabil cnpj={empresa.cnpj} campo="email" contato={leituraContabil?.contatos.get('email')} />
              </span>
            ) : '—'}
          </Linha>
          {contabil.isError && (empresa.telefone1 || empresa.telefone2 || empresa.email) && (
            <p className="py-1 text-xs text-muted-foreground" data-testid="radar-contabil-erro">
              Não consegui verificar se o contato é da contabilidade.
            </p>
          )}
          <Linha label="Endereço">
            {endereco || '—'}
            {mapsUrl && (
              <a className="ml-2 inline-flex items-center gap-1 text-xs underline" href={mapsUrl} target="_blank" rel="noreferrer"
                data-testid="radar-mapa-endereco" onClick={() => abriuMapa('endereco', 'linha')}>
                <MapPin className="w-3 h-3" /> mapa
              </a>
            )}
            {mapsEmpresaUrl && (
              <a className="ml-2 inline-flex items-center gap-1 text-xs underline" href={mapsEmpresaUrl} target="_blank" rel="noreferrer"
                data-testid="radar-mapa-empresa" onClick={() => abriuMapa('empresa', 'linha')}>
                procurar a empresa no Maps
              </a>
            )}
          </Linha>
          {empresa.socios_nomes && <Linha label="Sócios">{empresa.socios_nomes}</Linha>}
          {empresa.omie_codigo_cliente && (
            <Linha label="Omie (Oben)">
              cód. <span className="font-tabular">{empresa.omie_codigo_cliente}</span>
              {empresa.omie_cadastrado_em
                ? ` · ${new Date(empresa.omie_cadastrado_em).toLocaleDateString('pt-BR')}`
                : ''}
            </Linha>
          )}
          {rfb && <Linha label="Situação RFB">{rfb.titulo}</Linha>}
          {empresa.descarte_motivo && <Linha label="Motivo descarte">{empresa.descarte_motivo}</Linha>}
        </div>
        <Historico cnpj={empresa.cnpj} />
      </SheetContent>
    </Sheet>
  );
}
