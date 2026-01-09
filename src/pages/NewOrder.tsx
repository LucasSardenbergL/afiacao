import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Camera, ChevronRight, Check, MapPin, Clock, CreditCard } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/button';
import { 
  TOOL_CATEGORIES, 
  SERVICE_TYPES, 
  WEAR_LEVELS, 
  DELIVERY_OPTIONS,
  TIME_SLOTS,
  ToolCategory, 
  ServiceType, 
  WearLevel,
  DeliveryOption,
  ToolItem 
} from '@/types';
import { mockAddresses, priceTable } from '@/data/mockData';
import { cn } from '@/lib/utils';

type Step = 'items' | 'service' | 'delivery' | 'review';

const NewOrder = () => {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState<Step>('items');
  const [items, setItems] = useState<Partial<ToolItem>[]>([{ id: '1', quantity: 1 }]);
  const [deliveryOption, setDeliveryOption] = useState<DeliveryOption>('coleta_entrega');
  const [selectedAddress, setSelectedAddress] = useState(mockAddresses[0]?.id);
  const [selectedTimeSlot, setSelectedTimeSlot] = useState<string>('');

  const steps: { id: Step; label: string; number: number }[] = [
    { id: 'items', label: 'Itens', number: 1 },
    { id: 'service', label: 'Serviço', number: 2 },
    { id: 'delivery', label: 'Entrega', number: 3 },
    { id: 'review', label: 'Revisão', number: 4 },
  ];

  const currentStepIndex = steps.findIndex(s => s.id === currentStep);

  const addItem = () => {
    setItems([...items, { id: String(items.length + 1), quantity: 1 }]);
  };

  const removeItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  const updateItem = (index: number, field: keyof ToolItem, value: any) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], [field]: value };
    setItems(newItems);
  };

  const calculateSubtotal = () => {
    return items.reduce((acc, item) => {
      if (item.category && item.serviceType) {
        const price = priceTable[item.category]?.[item.serviceType] || 0;
        return acc + price * (item.quantity || 1);
      }
      return acc;
    }, 0);
  };

  const deliveryFee = deliveryOption === 'balcao' ? 0 : 15;
  const subtotal = calculateSubtotal();
  const total = subtotal + deliveryFee;

  const canProceed = () => {
    switch (currentStep) {
      case 'items':
        return items.every(item => item.category && item.quantity);
      case 'service':
        return items.every(item => item.serviceType && item.wearLevel);
      case 'delivery':
        if (deliveryOption === 'balcao') return true;
        return selectedAddress && selectedTimeSlot;
      default:
        return true;
    }
  };

  const nextStep = () => {
    const idx = currentStepIndex;
    if (idx < steps.length - 1) {
      setCurrentStep(steps[idx + 1].id);
    }
  };

  const prevStep = () => {
    const idx = currentStepIndex;
    if (idx > 0) {
      setCurrentStep(steps[idx - 1].id);
    } else {
      navigate(-1);
    }
  };

  const handleSubmit = () => {
    // Here would go the order submission logic
    navigate('/orders');
  };

  return (
    <div className="min-h-screen bg-background pb-32">
      <Header title="Novo Pedido" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Progress steps */}
        <div className="flex items-center justify-between mb-6 py-4">
          {steps.map((step, index) => (
            <div key={step.id} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    'w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-all',
                    index < currentStepIndex && 'bg-primary text-primary-foreground',
                    index === currentStepIndex && 'bg-secondary text-secondary-foreground',
                    index > currentStepIndex && 'bg-muted text-muted-foreground'
                  )}
                >
                  {index < currentStepIndex ? <Check className="w-4 h-4" /> : step.number}
                </div>
                <span className="text-[10px] mt-1 text-muted-foreground">{step.label}</span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={cn(
                    'w-12 h-0.5 mx-1 mt-[-12px]',
                    index < currentStepIndex ? 'bg-primary' : 'bg-border'
                  )}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="animate-fade-in">
          {/* Step 1: Items */}
          {currentStep === 'items' && (
            <div>
              <h2 className="font-display font-bold text-xl mb-1">Adicionar Ferramentas</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Selecione as ferramentas que deseja afiar
              </p>

              <div className="space-y-4">
                {items.map((item, index) => (
                  <div key={index} className="bg-card rounded-xl p-4 shadow-soft border border-border">
                    <div className="flex items-start justify-between mb-3">
                      <span className="text-sm font-medium text-muted-foreground">
                        Item {index + 1}
                      </span>
                      {items.length > 1 && (
                        <button
                          onClick={() => removeItem(index)}
                          className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    {/* Category select */}
                    <div className="mb-3">
                      <label className="text-sm font-medium mb-2 block">Tipo de ferramenta</label>
                      <select
                        value={item.category || ''}
                        onChange={(e) => updateItem(index, 'category', e.target.value as ToolCategory)}
                        className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="">Selecione...</option>
                        {Object.entries(TOOL_CATEGORIES).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                    </div>

                    {/* Brand/Model */}
                    <div className="mb-3">
                      <label className="text-sm font-medium mb-2 block">Marca/Modelo (opcional)</label>
                      <input
                        type="text"
                        value={item.brandModel || ''}
                        onChange={(e) => updateItem(index, 'brandModel', e.target.value)}
                        placeholder="Ex: Tramontina Chef 8 polegadas"
                        className="w-full h-11 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>

                    {/* Quantity */}
                    <div className="mb-3">
                      <label className="text-sm font-medium mb-2 block">Quantidade</label>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => updateItem(index, 'quantity', Math.max(1, (item.quantity || 1) - 1))}
                          className="w-10 h-10 rounded-lg border border-input flex items-center justify-center hover:bg-muted"
                        >
                          -
                        </button>
                        <span className="w-10 text-center font-semibold">{item.quantity || 1}</span>
                        <button
                          onClick={() => updateItem(index, 'quantity', (item.quantity || 1) + 1)}
                          className="w-10 h-10 rounded-lg border border-input flex items-center justify-center hover:bg-muted"
                        >
                          +
                        </button>
                      </div>
                    </div>

                    {/* Photos placeholder */}
                    <button className="w-full h-20 rounded-lg border-2 border-dashed border-border flex items-center justify-center gap-2 text-muted-foreground hover:border-primary hover:text-primary transition-colors">
                      <Camera className="w-5 h-5" />
                      <span className="text-sm">Adicionar fotos</span>
                    </button>
                  </div>
                ))}

                <button
                  onClick={addItem}
                  className="w-full py-3 rounded-xl border-2 border-dashed border-border flex items-center justify-center gap-2 text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                >
                  <Plus className="w-5 h-5" />
                  <span className="font-medium">Adicionar outro item</span>
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Service type */}
          {currentStep === 'service' && (
            <div>
              <h2 className="font-display font-bold text-xl mb-1">Tipo de Serviço</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Escolha o serviço e nível de desgaste para cada item
              </p>

              <div className="space-y-6">
                {items.map((item, index) => (
                  <div key={index} className="bg-card rounded-xl p-4 shadow-soft border border-border">
                    <h3 className="font-semibold mb-4">
                      {item.category ? TOOL_CATEGORIES[item.category as ToolCategory] : `Item ${index + 1}`}
                      {item.brandModel && <span className="text-sm font-normal text-muted-foreground ml-2">{item.brandModel}</span>}
                    </h3>

                    {/* Service type */}
                    <div className="mb-4">
                      <label className="text-sm font-medium mb-2 block">Serviço desejado</label>
                      <div className="grid grid-cols-2 gap-2">
                        {Object.entries(SERVICE_TYPES).map(([key, { label, description }]) => (
                          <button
                            key={key}
                            onClick={() => updateItem(index, 'serviceType', key as ServiceType)}
                            className={cn(
                              'p-3 rounded-lg border-2 text-left transition-all',
                              item.serviceType === key
                                ? 'border-primary bg-primary/5'
                                : 'border-border hover:border-primary/50'
                            )}
                          >
                            <span className="text-sm font-medium block">{label}</span>
                            <span className="text-[10px] text-muted-foreground">{description}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Wear level */}
                    <div className="mb-4">
                      <label className="text-sm font-medium mb-2 block">Nível de desgaste</label>
                      <div className="flex gap-2">
                        {Object.entries(WEAR_LEVELS).map(([key, { label, color }]) => (
                          <button
                            key={key}
                            onClick={() => updateItem(index, 'wearLevel', key as WearLevel)}
                            className={cn(
                              'flex-1 py-2 px-3 rounded-lg border-2 text-sm font-medium transition-all',
                              item.wearLevel === key
                                ? 'border-primary bg-primary/5'
                                : 'border-border hover:border-primary/50'
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Notes */}
                    <div>
                      <label className="text-sm font-medium mb-2 block">Observações (opcional)</label>
                      <textarea
                        value={item.notes || ''}
                        onChange={(e) => updateItem(index, 'notes', e.target.value)}
                        placeholder="Descreva danos, lascados, ou instruções especiais..."
                        className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                        rows={2}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 3: Delivery */}
          {currentStep === 'delivery' && (
            <div>
              <h2 className="font-display font-bold text-xl mb-1">Entrega</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Como deseja receber suas ferramentas?
              </p>

              {/* Delivery options */}
              <div className="space-y-3 mb-6">
                {Object.entries(DELIVERY_OPTIONS).map(([key, { label, description }]) => (
                  <button
                    key={key}
                    onClick={() => setDeliveryOption(key as DeliveryOption)}
                    className={cn(
                      'w-full p-4 rounded-xl border-2 text-left transition-all flex items-start gap-3',
                      deliveryOption === key
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    )}
                  >
                    <div
                      className={cn(
                        'w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5',
                        deliveryOption === key ? 'border-primary' : 'border-muted-foreground'
                      )}
                    >
                      {deliveryOption === key && (
                        <div className="w-2.5 h-2.5 rounded-full bg-primary" />
                      )}
                    </div>
                    <div className="flex-1">
                      <span className="font-medium block">{label}</span>
                      <span className="text-sm text-muted-foreground">{description}</span>
                    </div>
                    {key !== 'balcao' && (
                      <span className="text-sm font-semibold text-primary">R$ 15</span>
                    )}
                  </button>
                ))}
              </div>

              {/* Address selection */}
              {deliveryOption !== 'balcao' && (
                <>
                  <div className="mb-6">
                    <label className="text-sm font-medium mb-3 flex items-center gap-2">
                      <MapPin className="w-4 h-4" />
                      Endereço
                    </label>
                    <div className="space-y-2">
                      {mockAddresses.map((address) => (
                        <button
                          key={address.id}
                          onClick={() => setSelectedAddress(address.id)}
                          className={cn(
                            'w-full p-3 rounded-lg border-2 text-left transition-all',
                            selectedAddress === address.id
                              ? 'border-primary bg-primary/5'
                              : 'border-border hover:border-primary/50'
                          )}
                        >
                          <span className="font-medium">{address.label}</span>
                          <p className="text-sm text-muted-foreground">
                            {address.street}, {address.number} - {address.neighborhood}
                          </p>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Time slot */}
                  <div>
                    <label className="text-sm font-medium mb-3 flex items-center gap-2">
                      <Clock className="w-4 h-4" />
                      Horário preferido
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {TIME_SLOTS.map((slot) => (
                        <button
                          key={slot.id}
                          onClick={() => setSelectedTimeSlot(slot.id)}
                          className={cn(
                            'py-2 px-3 rounded-lg border-2 text-sm font-medium transition-all',
                            selectedTimeSlot === slot.id
                              ? 'border-primary bg-primary/5'
                              : 'border-border hover:border-primary/50'
                          )}
                        >
                          {slot.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 4: Review */}
          {currentStep === 'review' && (
            <div>
              <h2 className="font-display font-bold text-xl mb-1">Revisar Pedido</h2>
              <p className="text-sm text-muted-foreground mb-6">
                Confira os detalhes antes de enviar
              </p>

              {/* Items summary */}
              <div className="bg-card rounded-xl p-4 shadow-soft border border-border mb-4">
                <h3 className="font-semibold mb-3">Itens</h3>
                <div className="space-y-3">
                  {items.map((item, index) => {
                    const price = item.category && item.serviceType
                      ? priceTable[item.category]?.[item.serviceType] || 0
                      : 0;
                    return (
                      <div key={index} className="flex justify-between items-start">
                        <div>
                          <p className="font-medium">
                            {item.quantity}x {item.category ? TOOL_CATEGORIES[item.category as ToolCategory] : 'Item'}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {item.serviceType && SERVICE_TYPES[item.serviceType as ServiceType].label}
                          </p>
                        </div>
                        <span className="font-semibold">
                          R$ {(price * (item.quantity || 1)).toFixed(2).replace('.', ',')}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Delivery summary */}
              <div className="bg-card rounded-xl p-4 shadow-soft border border-border mb-4">
                <h3 className="font-semibold mb-2">Entrega</h3>
                <p className="text-sm">{DELIVERY_OPTIONS[deliveryOption].label}</p>
                {deliveryOption !== 'balcao' && selectedAddress && (
                  <p className="text-sm text-muted-foreground mt-1">
                    {mockAddresses.find(a => a.id === selectedAddress)?.street}
                    {selectedTimeSlot && ` • ${TIME_SLOTS.find(s => s.id === selectedTimeSlot)?.label}`}
                  </p>
                )}
              </div>

              {/* Totals */}
              <div className="bg-card rounded-xl p-4 shadow-soft border border-border mb-6">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>R$ {subtotal.toFixed(2).replace('.', ',')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Taxa de entrega</span>
                    <span>R$ {deliveryFee.toFixed(2).replace('.', ',')}</span>
                  </div>
                  <div className="border-t border-border pt-2 flex justify-between font-bold text-base">
                    <span>Total estimado</span>
                    <span className="text-primary">R$ {total.toFixed(2).replace('.', ',')}</span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  * Valor final após análise das ferramentas
                </p>
              </div>

              {/* Payment method preview */}
              <button className="w-full bg-card rounded-xl p-4 shadow-soft border border-border flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CreditCard className="w-5 h-5 text-muted-foreground" />
                  <div className="text-left">
                    <p className="font-medium">Forma de pagamento</p>
                    <p className="text-sm text-muted-foreground">Pix, Cartão ou na entrega</p>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Fixed bottom buttons */}
      <div className="fixed bottom-0 left-0 right-0 bg-background border-t border-border p-4 safe-bottom">
        <div className="max-w-lg mx-auto flex gap-3">
          <Button variant="outline" onClick={prevStep} className="flex-1">
            Voltar
          </Button>
          {currentStep === 'review' ? (
            <Button onClick={handleSubmit} className="flex-1">
              Enviar Pedido
            </Button>
          ) : (
            <Button onClick={nextStep} disabled={!canProceed()} className="flex-1">
              Continuar
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default NewOrder;
