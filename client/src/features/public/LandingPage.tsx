import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useScrollReveal } from '@/hooks/useScrollReveal';

const TICKER_ITEMS = [
  'Fast, focused, and human',
  'Raw and Real',
  '8 minutes with people who get it',
  'No small talk',
  'Built for founders',
  'Quality over quantity',
];

const REASONS = [
  { quote: '"I made more real connections in 8 minutes than I have in 8 months of networking events."', author: 'Founder, SaaS startup' },
  { quote: '"It felt like meeting an old friend for the first time."', author: 'Agency owner' },
  { quote: '"Finally — networking that doesn\'t feel like networking."', author: 'Executive coach' },
];

const WHO_ITS_FOR = [
  { title: 'Founders', desc: 'who value honesty over hype' },
  { title: 'Leaders', desc: 'who understand the weight of decisions' },
  { title: 'Company Owners', desc: 'who want real connections, not transactions' },
];

const HOW_STEPS = [
  { num: '01', title: 'You sign up for a session.', desc: '' },
  { num: '02', title: 'You join a live call.', desc: '' },
  { num: '03', title: 'You meet five people in focused 8-minute conversations.', desc: '' },
];

const AVOID = ['Another evening pretending to network', 'Another room full of hidden agendas', 'Another round of follow-ups that lead nowhere'];
const LEAVE_WITH = ['Clarity', 'Energy', 'Real connections'];

export default function LandingPage() {
  const navigate = useNavigate();
  useScrollReveal();
  const tickerText = TICKER_ITEMS.map(t => `${t}  ·  `).join('');

  return (
    <div className="light-theme min-h-screen font-display">
      {/* Ticker bar */}
      <div className="bg-[#1a1a2e] text-white/80 py-2 ticker-wrap">
        <div className="ticker-content text-xs tracking-[0.2em] uppercase font-medium">
          <span>{tickerText}</span>
          <span>{tickerText}</span>
        </div>
      </div>

      {/* Nav */}
      <header className="sticky top-0 z-50 bg-white/90 backdrop-blur-md border-b border-gray-100">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
          <button onClick={() => navigate('/welcome')} className="flex items-center gap-2">
            <img src="/rsn-logo.png" alt="RSN" className="h-8 w-auto" />
            <span className="text-2xl font-extrabold tracking-tight text-[#1a1a2e]">RSN<span className="text-red-600">.</span></span>
          </button>
          <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-gray-600">
            <button onClick={() => navigate('/how-it-works')} className="hover:text-[#1a1a2e] transition-colors">The Format</button>
            <button onClick={() => navigate('/reasons')} className="hover:text-[#1a1a2e] transition-colors">Reasons To Join</button>
            <button onClick={() => navigate('/about')} className="hover:text-[#1a1a2e] transition-colors">About</button>
            <button onClick={() => navigate('/login')} className="hover:text-[#1a1a2e] transition-colors">Join</button>
            <button onClick={() => navigate('/request-to-join')} className="bg-red-600 text-white px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-red-700 transition-all hover:scale-[1.02] shadow-md">
              Request to Join <ArrowRight className="h-4 w-4 inline ml-1" />
            </button>
          </nav>
          <button onClick={() => navigate('/login')} className="md:hidden bg-red-600 text-white px-4 py-2 rounded-full text-sm font-semibold">
            Join
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="relative py-24 md:py-36 text-center px-6 overflow-hidden">
        {/* Decorative L-shaped corner brackets */}
        <div className="absolute top-16 left-8 md:left-24 w-12 h-12 md:w-20 md:h-20 border-l-2 border-t-2 border-gray-200 select-none pointer-events-none" aria-hidden></div>
        <div className="absolute bottom-16 right-8 md:right-24 w-12 h-12 md:w-20 md:h-20 border-r-2 border-b-2 border-gray-200 select-none pointer-events-none" aria-hidden></div>
        {/* Sheep icon in hero */}
        <img src="/rsn-sheep.png" alt="" className="absolute top-8 right-12 md:right-32 h-12 w-12 md:h-16 md:w-16 opacity-20 hover:opacity-80 transition-opacity duration-500 pointer-events-auto cursor-pointer" title="🐑" />

        <div className="max-w-4xl mx-auto relative">
          <h1 className="text-5xl md:text-7xl font-extrabold text-[#1a1a2e] leading-[1.05] tracking-tight animate-fade-in-up">
            FAST, FOCUSED,<br />AND HUMAN
          </h1>
          <p className="mt-8 text-lg md:text-2xl text-[#1a1a2e] font-semibold tracking-wide border-b-2 border-[#1a1a2e] inline-block pb-1 animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
            8 MINUTES WITH PEOPLE WHO GET IT
          </p>
          <div className="mt-10 animate-fade-in-up" style={{ animationDelay: '0.2s' }}>
            <button onClick={() => navigate('/request-to-join')} className="text-[#1a1a2e] text-lg font-semibold hover:text-red-600 transition-colors inline-flex items-center gap-2">
              <ArrowRight className="h-5 w-5" /> REQUEST TO JOIN
            </button>
          </div>
        </div>
      </section>

      {/* Divider line */}
      <div className="max-w-6xl mx-auto px-6"><hr className="border-gray-200" /></div>

      {/* Reasons to Join */}
      <section className="py-20 md:py-28 px-6 scroll-reveal">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-extrabold text-[#1a1a2e] text-center mb-16 tracking-tight">Reasons to Join</h2>
          <div className="grid md:grid-cols-3 gap-8">
            {REASONS.map((r, i) => (
              <div key={i} className="text-center group hover:-translate-y-1 transition-transform duration-300 animate-fade-in-up" style={{ animationDelay: `${i * 0.1}s` }}>
                <div className="bg-gray-50 rounded-2xl p-8 hover:bg-gray-100 transition-colors duration-300">
                  <p className="text-lg md:text-xl text-gray-700 italic leading-relaxed mb-4">{r.quote}</p>
                  <p className="text-sm text-gray-400 font-medium">— {r.author}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="text-center mt-12">
            <button onClick={() => navigate('/reasons')} className="text-sm font-semibold text-[#1a1a2e] border-b-2 border-[#1a1a2e] pb-0.5 hover:opacity-70 transition-opacity">
              See all reasons →
            </button>
          </div>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6"><hr className="border-gray-200" /></div>

      {/* Who It's For */}
      <section className="py-20 md:py-28 px-6 scroll-reveal">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-extrabold text-[#1a1a2e] mb-16 tracking-tight">Who It&apos;s For</h2>
          <div className="grid md:grid-cols-3 gap-10">
            {WHO_ITS_FOR.map((w, i) => (
              <div key={i} className="group hover:-translate-y-1 transition-transform duration-300 animate-fade-in-up" style={{ animationDelay: `${i * 0.1}s` }}>
                <div className="bg-gray-50 rounded-2xl p-8 hover:bg-gray-100 transition-colors duration-300 h-full">
                  <h3 className="text-xl font-bold text-[#1a1a2e] mb-2">{w.title}</h3>
                  <p className="text-gray-500">{w.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6"><hr className="border-gray-200" /></div>

      {/* How It Works */}
      <section className="py-20 md:py-28 px-6 scroll-reveal">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-extrabold text-[#1a1a2e] text-center mb-16 tracking-tight">How It Works</h2>
          <div className="space-y-8">
            {HOW_STEPS.map((s, i) => (
              <div key={i} className="flex items-start gap-6 group hover:bg-gray-50 rounded-2xl p-6 -mx-6 transition-all duration-300 animate-fade-in-up" style={{ animationDelay: `${i * 0.1}s` }}>
                <span className="text-4xl md:text-5xl font-extrabold text-gray-200 leading-none group-hover:text-red-200 transition-colors duration-300">{s.num}</span>
                <div>
                  <h3 className="text-xl font-bold text-[#1a1a2e] mb-1">{s.title}</h3>
                  <p className="text-gray-500">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-12 text-center space-y-2">
            <p className="text-lg text-gray-500 italic">No pitching. No selling. No scripts.</p>
            <p className="text-lg text-gray-500 italic">Just two people. One conversation at a time.</p>
          </div>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6"><hr className="border-gray-200" /></div>

      {/* Why It Matters */}
      <section className="py-20 md:py-28 px-6 text-center scroll-reveal">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-extrabold text-[#1a1a2e] mb-8 tracking-tight">Why It Matters</h2>
          <div className="text-lg md:text-xl text-gray-500 leading-relaxed space-y-6 text-left">
            <p>Leadership can be isolating.</p>
            <p>Not because you want it to be. But because so few people truly understand what you're dealing with.</p>
            <p>RSN creates a space where you don't have to explain yourself.</p>
            <p>Where you can listen, be heard, and think out loud with someone who gets it.</p>
          </div>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6"><hr className="border-gray-200" /></div>

      {/* What You Avoid / What You Leave With */}
      <section className="py-20 md:py-28 px-6 scroll-reveal">
        <div className="max-w-5xl mx-auto grid md:grid-cols-2 gap-16">
          <div className="animate-fade-in-up">
            <h3 className="text-2xl font-extrabold text-[#1a1a2e] mb-6 tracking-tight">What You Avoid</h3>
            <ul className="space-y-4">
              {AVOID.map((item, i) => (
                <li key={i} className="flex items-center gap-3 text-gray-500 group hover:text-gray-700 transition-colors">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-400 flex-shrink-0 group-hover:scale-125 transition-transform" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="animate-fade-in-up" style={{ animationDelay: '0.15s' }}>
            <h3 className="text-2xl font-extrabold text-[#1a1a2e] mb-6 tracking-tight">What You Leave With</h3>
            <ul className="space-y-4">
              {LEAVE_WITH.map((item, i) => (
                <li key={i} className="flex items-center gap-3 text-gray-500 group hover:text-gray-700 transition-colors">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 flex-shrink-0 group-hover:scale-125 transition-transform" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 md:py-32 text-center px-6 bg-[#1a1a2e]">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-extrabold text-white mb-6 tracking-tight">Join Raw Speed Networking</h2>
          <div className="text-gray-400 text-sm mb-10 space-y-1">
            <p>No pitching. No selling. Ever.</p>
            <p>5 conversations. 8 minutes each. Live.</p>
            <p>Founders, leaders, and company owners.</p>
          </div>
          <button onClick={() => navigate('/request-to-join')} className="bg-red-600 text-white px-10 py-4 rounded-full text-lg font-semibold hover:bg-red-700 transition-all hover:scale-[1.02] shadow-lg hover:shadow-red-500/30">
            Request to Join <ArrowRight className="h-5 w-5 inline ml-2" />
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-100 py-10">
        <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <img src="/rsn-logo.png" alt="RSN" className="h-8 w-auto" />
            <span className="text-sm text-gray-400">© {new Date().getFullYear()}</span>
          </div>
          <nav className="flex items-center gap-6 text-sm text-gray-500">
            <button onClick={() => navigate('/how-it-works')} className="hover:text-[#1a1a2e] transition-colors">The Format</button>
            <button onClick={() => navigate('/reasons')} className="hover:text-[#1a1a2e] transition-colors">Reasons</button>
            <button onClick={() => navigate('/about')} className="hover:text-[#1a1a2e] transition-colors">About</button>
            <button onClick={() => navigate('/login')} className="hover:text-[#1a1a2e] transition-colors">Sign In</button>
          </nav>
          {/* Sheep easter egg */}
          <img src="/rsn-sheep.png" alt="" className="h-10 w-10 opacity-30 hover:opacity-100 transition-all duration-500 cursor-pointer hover:scale-110" title="🐑" />
        </div>
      </footer>
    </div>
  );
}
