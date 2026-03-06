import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PhotoUpload } from '@/components/PhotoUpload';
import { VoiceServiceInput } from '@/components/VoiceServiceInput';
import {
  Loader2, Plus, Minus, Trash2, Wrench, AlertCircle, MapPin, Clock, Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { DELIVERY_OPTIONS, TIME_SLOTS, DeliveryOption } from '@/types';
import type {
  UserTool, ServiceCartItem, CartItem, AddressData,
} from '@/hooks/useUnifiedOrder';
import { fmt, getToolName, PAYMENT_OPTIONS } from '@/hooks/useUnifiedOrder';
import type { OmieServico } from '@/services/omieService';
import type { IdentifiedItem } from '@/components/VoiceServiceInput';

interface ServiceItemFormProps {
  customerUserId: string | null;
  loadingTools: boolean;
  loadingServicos: boolean;
  creatingLocalProfile: boolean;
  serviceItems: ServiceCartItem[];
  availableTools: UserTool[];
  userTools: UserTool[];
  cart: CartItem[];
  submitting: boolean;
  // Delivery
  deliveryOption: DeliveryOption;
  setDeliveryOption: (v: DeliveryOption) => void;
  addresses: AddressData[];
  selectedAddress: string;
  setSelectedAddress: (v: string) => void;
  selectedTimeSlot: string;
  setSelectedTimeSlot: (v: string) => void;
  showAddressOptions: boolean;
  setShowAddressOptions: (v: boolean) => void;
  afiacaoPaymentMethod: string;
  setAfiacaoPaymentMethod: (v: string) => void;
  // Actions
  onStaffAddTool: () => void;
  onAddService: (tool: UserTool) => void;
  onRemoveFromCart: (idx: number) => void;
  onUpdateQuantity: (idx: number, delta: number) => void;
  onUpdateServiceServico: (toolId: string, codigo: number) => void;
  onUpdateServiceNotes: (toolId: string, notes: string) => void;
  onUpdateServicePhotos: (toolId: string, photos: string[]) => void;
  onVoiceItemsIdentified: (items: IdentifiedItem[]) => void;
  getFilteredServicos: (tool: UserTool) => OmieServico[];
  getServicePrice: (item: ServiceCartItem) => number | null;
  setAddToolDialogOpen: (v: boolean) => void;
}

export function ServiceItemForm({
  customerUserId, loadingTools, loadingServicos, creatingLocalProfile,
  serviceItems, availableTools, userTools, cart, submitting,
  deliveryOption, setDeliveryOption, addresses, selectedAddress, setSelectedAddress,
  selectedTimeSlot, setSelectedTimeSlot, showAddressOptions, setShowAddressOptions,
  afiacaoPaymentMethod, setAfiacaoPaymentMethod,
  onStaffAddTool, onAddService, onRemoveFromCart, onUpdateQuantity,
  onUpdateServiceServico, onUpdateServiceNotes, onUpdateServicePhotos,
  onVoiceItemsIdentified, getFilteredServicos, getServicePrice, setAddToolDialogOpen,
}: ServiceItemFormProps) {
  const { toast } = useToast();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Wrench className="w-4 h-4" /> Afiação — Ferramentas do Cliente
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loadingTools || loadingServicos ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : !customerUserId ? (
          <div className="text-center py-6 space-y-3">
            <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">Cliente sem cadastro no app. Crie o perfil para cadastrar ferramentas.</p>
            <Button onClick={onStaffAddTool} disabled={creatingLocalProfile} size="sm">
              {creatingLocalProfile ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
              Criar perfil e cadastrar ferramenta
            </Button>
          </div>
        ) : userTools.length === 0 ? (
          <div className="text-center py-6 space-y-3">
            <Wrench className="w-8 h-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">Nenhuma ferramenta cadastrada para este cliente.</p>
            <Button onClick={() => setAddToolDialogOpen(true)} size="sm">
              <Plus className="w-4 h-4 mr-2" /> Cadastrar Ferramenta
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <VoiceServiceInput userTools={userTools} onItemsIdentified={onVoiceItemsIdentified} isLoading={submitting} />

            {serviceItems.length > 0 && (
              <div className="space-y-4">
                {serviceItems.map((item) => {
                  const filteredSvcs = getFilteredServicos(item.userTool);
                  const cartIdx = cart.indexOf(item);
                  const price = getServicePrice(item);
                  return (
                    <div key={item.userTool.id} className="border rounded-xl p-4 bg-accent/10 space-y-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <Wrench className="w-4 h-4 text-primary" />
                          <span className="text-sm font-medium">{getToolName(item.userTool)}</span>
                        </div>
                        <button onClick={() => onRemoveFromCart(cartIdx)}>
                          <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                        </button>
                      </div>
                      <div>
                        <label className="text-xs font-medium mb-1 block">Tipo de serviço *</label>
                        {filteredSvcs.length > 0 ? (
                          <select
                            value={item.servico?.omie_codigo_servico || ''}
                            onChange={e => onUpdateServiceServico(item.userTool.id, Number(e.target.value))}
                            className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm"
                          >
                            <option value="">Selecione serviço...</option>
                            {filteredSvcs.map(s => (
                              <option key={s.omie_codigo_servico} value={s.omie_codigo_servico}>{s.descricao}</option>
                            ))}
                          </select>
                        ) : (
                          <p className="text-xs text-muted-foreground"><AlertCircle className="w-3 h-3 inline mr-1" />Nenhum serviço disponível</p>
                        )}
                      </div>
                      <div>
                        <label className="text-xs font-medium mb-1 block">
                          Quantidade <span className="text-muted-foreground ml-1">(máx: {item.userTool.quantity || 1})</span>
                        </label>
                        <div className="flex items-center gap-3">
                          <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={() => onUpdateQuantity(cartIdx, -1)}>
                            <Minus className="w-3 h-3" />
                          </Button>
                          <span className="w-8 text-center font-semibold">{item.quantity}</span>
                          <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={() => {
                            const maxQty = item.userTool.quantity || 1;
                            if (item.quantity >= maxQty) {
                              toast({ title: 'Quantidade máxima atingida', description: `Esta ferramenta possui apenas ${maxQty} unidade(s).` });
                              return;
                            }
                            onUpdateQuantity(cartIdx, 1);
                          }}>
                            <Plus className="w-3 h-3" />
                          </Button>
                          {price !== null && (
                            <span className="text-xs text-primary font-medium ml-auto">{fmt(price * item.quantity)}</span>
                          )}
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-medium mb-1 block">Observações (opcional)</label>
                        <textarea
                          value={item.notes || ''}
                          onChange={e => onUpdateServiceNotes(item.userTool.id, e.target.value)}
                          placeholder="Descreva danos, lascados, ou instruções especiais..."
                          className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm resize-none"
                          rows={2}
                        />
                      </div>
                      {customerUserId && (
                        <div>
                          <label className="text-xs font-medium mb-1 block">Fotos (opcional)</label>
                          <PhotoUpload photos={item.photos || []} onPhotosChange={(photos) => onUpdateServicePhotos(item.userTool.id, photos)} userId={customerUserId} maxPhotos={3} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {availableTools.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  {serviceItems.length > 0 ? 'Adicionar mais ferramentas:' : 'Ferramentas cadastradas:'}
                </p>
                <div className="space-y-1.5">
                  {availableTools.map(tool => (
                    <button
                      key={tool.id}
                      onClick={() => onAddService(tool)}
                      className="w-full p-2.5 rounded-lg border border-dashed border-border flex items-center gap-2 text-left hover:border-primary hover:bg-primary/5 transition-colors"
                    >
                      <Wrench className="w-4 h-4 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{getToolName(tool)}</p>
                        <p className="text-[10px] text-muted-foreground">{tool.tool_categories?.name}</p>
                      </div>
                      <Plus className="w-4 h-4 text-primary" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Button variant="ghost" size="sm" className="w-full" onClick={() => setAddToolDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-2" /> Cadastrar nova ferramenta
            </Button>

            {/* Delivery section */}
            {serviceItems.length > 0 && (
              <div className="border-t pt-4 space-y-4">
                <h3 className="text-sm font-semibold flex items-center gap-2"><MapPin className="w-4 h-4" /> Entrega da Afiação</h3>
                <div className="bg-primary/10 border border-primary/20 rounded-lg p-3">
                  <p className="text-xs text-primary font-medium">✓ Frete grátis em todas as modalidades</p>
                </div>
                <div className="space-y-2">
                  {Object.entries(DELIVERY_OPTIONS).map(([key, { label, description }]) => (
                    <button
                      key={key}
                      onClick={() => setDeliveryOption(key as DeliveryOption)}
                      className={cn(
                        'w-full p-3 rounded-lg border-2 text-left transition-all flex items-start gap-2',
                        deliveryOption === key ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                      )}
                    >
                      <div className={cn('w-4 h-4 rounded-full border-2 flex items-center justify-center mt-0.5 shrink-0', deliveryOption === key ? 'border-primary' : 'border-muted-foreground')}>
                        {deliveryOption === key && <div className="w-2 h-2 rounded-full bg-primary" />}
                      </div>
                      <div className="flex-1">
                        <span className="text-sm font-medium block">{label}</span>
                        <span className="text-xs text-muted-foreground">{description}</span>
                      </div>
                    </button>
                  ))}
                </div>

                {deliveryOption !== 'balcao' && (
                  <>
                    {addresses.length > 0 ? (
                      <div>
                        <label className="text-xs font-medium mb-2 flex items-center gap-1"><MapPin className="w-3 h-3" /> Endereço</label>
                        {(() => {
                          const addr = addresses.find(a => a.id === selectedAddress);
                          if (!addr) return null;
                          return (
                            <div className="bg-card rounded-lg p-3 border-2 border-primary">
                              <div className="flex items-start justify-between">
                                <div>
                                  <span className="text-xs font-semibold">{addr.label}</span>
                                  <p className="text-xs text-muted-foreground">{addr.street}, {addr.number}{addr.complement && ` - ${addr.complement}`}</p>
                                  <p className="text-xs text-muted-foreground">{addr.neighborhood} - {addr.city}/{addr.state}</p>
                                </div>
                                <Check className="w-4 h-4 text-primary" />
                              </div>
                            </div>
                          );
                        })()}
                        {!showAddressOptions && addresses.length > 1 && (
                          <Button variant="outline" size="sm" className="w-full mt-2" onClick={() => setShowAddressOptions(true)}>Alterar endereço</Button>
                        )}
                        {showAddressOptions && addresses.filter(a => a.id !== selectedAddress).map(addr => (
                          <button key={addr.id} onClick={() => { setSelectedAddress(addr.id); setShowAddressOptions(false); }}
                            className="w-full mt-2 p-3 rounded-lg border-2 border-border text-left hover:border-primary/50 transition-all">
                            <span className="text-xs font-semibold">{addr.label}</span>
                            <p className="text-xs text-muted-foreground">{addr.street}, {addr.number} - {addr.city}/{addr.state}</p>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Nenhum endereço cadastrado para este cliente.</p>
                    )}
                    <div>
                      <label className="text-xs font-medium mb-2 flex items-center gap-1"><Clock className="w-3 h-3" /> Horário preferido</label>
                      <div className="grid grid-cols-2 gap-2">
                        {TIME_SLOTS.map(slot => (
                          <button key={slot.id} onClick={() => setSelectedTimeSlot(slot.id)}
                            className={cn('py-2 px-3 rounded-lg border-2 text-xs font-medium transition-all',
                              selectedTimeSlot === slot.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                            )}>
                            {slot.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                <div>
                  <label className="text-xs font-medium mb-2 block">Pagamento Afiação</label>
                  <div className="space-y-1.5">
                    {PAYMENT_OPTIONS.map(option => (
                      <button key={option.id} onClick={() => setAfiacaoPaymentMethod(option.id)}
                        className={cn('w-full p-2.5 rounded-lg border-2 text-left transition-all',
                          afiacaoPaymentMethod === option.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                        )}>
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="text-xs font-medium">{option.label}</span>
                            <p className="text-[10px] text-muted-foreground">{option.description}</p>
                          </div>
                          {afiacaoPaymentMethod === option.id && <Check className="w-3.5 h-3.5 text-primary" />}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
