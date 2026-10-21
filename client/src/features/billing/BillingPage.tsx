import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { CreditCard, Check, Lock, Zap } from 'lucide-react';


const plans = [
  {
    name: 'Starter',
    price: 'Free',
    description: 'Get started with REASON basics',
    features: ['1 Pod membership', 'Join events', 'Basic profile', 'Invite friends'],
    current: true,
  },
  {
    name: 'Pro',
    price: '$19/mo',
    description: 'Unlock the full REASON experience',
    features: ['Unlimited Pods', 'Priority matching', 'Advanced analytics', 'Early event access', 'Custom invite links'],
    current: false,
  },
];

export default function BillingPage() {

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="animate-fade-in">
        <h1 className="text-2xl font-bold text-[#1a1a2e]">Billing</h1>
        <p className="text-gray-500 text-sm mt-1">Manage your subscription and billing</p>
      </div>

      {/* Current plan */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-[#1a1a2e]">Current Plan</h2>
              <Badge variant="brand">Starter</Badge>
            </div>
            <p className="text-sm text-gray-500 mt-1">You're on the free plan</p>
          </div>
          <CreditCard className="h-8 w-8 text-gray-300" />
        </div>
      </Card>

      {/* Plans */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-fade-in-up">
        {plans.map(plan => (
          <Card
            key={plan.name}
            className={`flex flex-col ${plan.current ? 'border-brand-500/30' : 'border-gray-200'}`}
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold text-[#1a1a2e]">{plan.name}</h3>
              {plan.current && <Badge variant="success">Current</Badge>}
            </div>
            <p className="text-2xl font-bold text-[#1a1a2e] mb-1">{plan.price}</p>
            <p className="text-sm text-gray-500 mb-4">{plan.description}</p>
            <ul className="space-y-2 mb-6 flex-1">
              {plan.features.map(f => (
                <li key={f} className="flex items-center gap-2 text-sm text-gray-600">
                  <Check className="h-4 w-4 text-emerald-400 flex-shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
            {plan.current ? (
              <Button variant="secondary" disabled className="w-full">Current Plan</Button>
            ) : (
              <Button className="w-full">
                <Zap className="h-4 w-4 mr-2" /> Upgrade
              </Button>
            )}
          </Card>
        ))}
      </div>

      {/* Billing note */}
      <Card className="animate-fade-in-up">
        <div className="flex items-center gap-3">
          <Lock className="h-5 w-5 text-gray-400 flex-shrink-0" />
          <div>
            <p className="text-sm text-gray-600">Billing is not yet active</p>
            <p className="text-xs text-gray-400">Stripe integration will be available soon. All current features are free during the beta period.</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
