import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';

const steps = [
  {
    num: '01',
    title: 'Sign Up',
    desc: 'Create your account in under a minute. No password, no app — just your email. We send you a magic link to get started.',
  },
  {
    num: '02',
    title: 'Join a Pod',
    desc: 'Pods are curated groups built around a shared interest, industry, or purpose. Browse open pods or create your own. Every session runs inside a pod.',
  },
  {
    num: '03',
    title: 'Enter a Live Session',
    desc: 'When a session starts, you enter the lobby. See who else is here. The host kicks off the rounds and the matching engine does the rest.',
  },
  {
    num: '04',
    title: 'Get Matched 1-on-1',
    desc: 'Each round you\'re paired with one other person via live video. 8 minutes. No scripts, no pitch decks — just real conversation.',
  },
  {
    num: '05',
    title: 'Rate & Connect',
    desc: 'After each round, rate the conversation and say whether you\'d meet again. Mutual matches show up in your Encounters — so you can follow up for real.',
  },
];

export default function HowItWorksPage() {
  const navigate = useNavigate();

  return (
    <div className="light-theme min-h-screen font-display">
      {/* Nav */}
      <header className="sticky top-0 z-50 bg-white/90 backdrop-blur-md border-b border-gray-100">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
          <button onClick={() => navigate('/welcome')} className="text-2xl font-extrabold tracking-tight text-[#1a1a2e]">
            RSN
          </button>
          <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-gray-600">
            <button onClick={() => navigate('/reasons')} className="hover:text-[#1a1a2e] transition-colors">Reasons To Join</button>
            <button onClick={() => navigate('/about')} className="hover:text-[#1a1a2e] transition-colors">About</button>
            <button onClick={() => navigate('/login')} className="bg-[#1a1a2e] text-white px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-[#2d2d4e] transition-colors">
              Get Started
            </button>
          </nav>
          <button onClick={() => navigate('/login')} className="md:hidden bg-[#1a1a2e] text-white px-4 py-2 rounded-full text-sm font-semibold">
            Join
          </button>
        </div>
      </header>

      {/* Header */}
      <div className="max-w-3xl mx-auto px-6 pt-16 pb-8">
        <button onClick={() => navigate('/welcome')} className="flex items-center gap-2 text-gray-400 hover:text-gray-700 transition-colors text-sm mb-8">
          <ArrowLeft className="h-4 w-4" /> Back to Home
        </button>
        <h1 className="text-4xl md:text-5xl font-extrabold text-[#1a1a2e] tracking-tight mb-4">The Format</h1>
        <p className="text-lg text-gray-500">From sign-up to meaningful connections in 5 simple steps.</p>
      </div>

      {/* Steps */}
      <div className="max-w-3xl mx-auto px-6 pb-20">
        <div className="space-y-10">
          {steps.map((step, i) => (
            <div key={i} className="flex items-start gap-6 animate-fade-in-up" style={{ animationDelay: `${i * 0.08}s` }}>
              <span className="text-5xl font-extrabold text-gray-200 leading-none select-none">{step.num}</span>
              <div>
                <h3 className="text-xl font-bold text-[#1a1a2e] mb-2">{step.title}</h3>
                <p className="text-gray-500 leading-relaxed">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="text-center mt-16">
          <button onClick={() => navigate('/login')} className="bg-[#1a1a2e] text-white px-10 py-4 rounded-full text-lg font-semibold hover:bg-[#2d2d4e] transition-all hover:scale-[1.02]">
            Get Started <ArrowRight className="h-5 w-5 inline ml-2" />
          </button>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-100 py-8">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-400">
          <span className="font-extrabold text-[#1a1a2e]">RSN</span>
          <div className="flex gap-6">
            <button onClick={() => navigate('/welcome')} className="hover:text-gray-700 transition-colors">Home</button>
            <button onClick={() => navigate('/reasons')} className="hover:text-gray-700 transition-colors">Reasons</button>
            <button onClick={() => navigate('/about')} className="hover:text-gray-700 transition-colors">About</button>
            <button onClick={() => navigate('/login')} className="hover:text-gray-700 transition-colors">Sign In</button>
          </div>
        </div>
      </footer>
    </div>
  );
}
