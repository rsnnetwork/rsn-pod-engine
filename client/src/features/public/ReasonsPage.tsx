import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';

const REASONS = [
  '"I made more real connections in 8 minutes than I have in 8 months of networking events."',
  '"It felt like meeting an old friend for the first time."',
  '"Finally — networking that doesn\'t feel like networking."',
  '"I walked away with three people I genuinely want to talk to again."',
  '"The format strips away everything that makes networking awkward."',
  '"I didn\'t have to perform. I just had to show up."',
  '"This is what LinkedIn wishes it was."',
  '"Eight minutes is the perfect amount of time — enough to know if there\'s a connection, not so long that you\'re stuck."',
  '"I\'ve never left a networking event feeling energised. Until now."',
  '"The matching was surprisingly good. I don\'t know how they do it, but every conversation was relevant."',
  '"No business cards. No pitch decks. Just real talk."',
  '"I thought I\'d hate speed networking. I was wrong."',
  '"RSN respects your time. That alone sets it apart."',
  '"I signed up skeptical and left a believer."',
  '"The people here are serious about building something — not just collecting contacts."',
  '"It\'s the first networking format that actually scales trust."',
  '"I\'ve done conferences, meetups, masterminds. This is the most efficient way to meet quality people."',
  '"The simplicity is the point. No gimmicks, no gamification — just conversations."',
  '"Every round felt like it mattered."',
  '"I appreciate that it\'s not trying to be social media. It\'s trying to be useful."',
  '"I joined one session and immediately knew I\'d be back."',
  '"The quality of people in the room was remarkable."',
  '"Speed networking always felt gimmicky to me. RSN made it feel intentional."',
  '"It\'s raw. It\'s real. It\'s refreshingly human."',
  '"This is how networking should have always worked."',
];

export default function ReasonsPage() {
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
            <button onClick={() => navigate('/how-it-works')} className="hover:text-[#1a1a2e] transition-colors">The Format</button>
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

      {/* Content */}
      <div className="max-w-4xl mx-auto px-6 pt-16 pb-24">
        <button onClick={() => navigate('/welcome')} className="flex items-center gap-2 text-gray-400 hover:text-gray-700 transition-colors text-sm mb-8">
          <ArrowLeft className="h-4 w-4" /> Back to Home
        </button>

        <h1 className="text-4xl md:text-5xl font-extrabold text-[#1a1a2e] tracking-tight mb-4 animate-fade-in-up">Reasons to Join</h1>
        <p className="text-lg text-gray-500 mb-16 animate-fade-in-up" style={{ animationDelay: '0.05s' }}>
          Real words from real members.
        </p>

        <div className="space-y-8">
          {REASONS.map((quote, i) => (
            <div
              key={i}
              className="text-xl md:text-2xl text-gray-700 italic leading-relaxed py-6 border-b border-gray-100 last:border-0 animate-fade-in-up"
              style={{ animationDelay: `${Math.min(i * 0.04, 0.6)}s` }}
            >
              {quote}
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="mt-20 text-center animate-fade-in-up" style={{ animationDelay: '0.6s' }}>
          <p className="text-gray-500 text-lg mb-6">Ready to find your own reason?</p>
          <button onClick={() => navigate('/login')} className="bg-[#1a1a2e] text-white px-10 py-4 rounded-full text-lg font-semibold hover:bg-[#2d2d4e] transition-all hover:scale-[1.02]">
            Join RSN <ArrowRight className="h-5 w-5 inline ml-2" />
          </button>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-100 py-8">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-400">
          <span className="font-extrabold text-[#1a1a2e]">RSN</span>
          <div className="flex gap-6">
            <button onClick={() => navigate('/welcome')} className="hover:text-gray-700 transition-colors">Home</button>
            <button onClick={() => navigate('/how-it-works')} className="hover:text-gray-700 transition-colors">The Format</button>
            <button onClick={() => navigate('/about')} className="hover:text-gray-700 transition-colors">About</button>
            <button onClick={() => navigate('/login')} className="hover:text-gray-700 transition-colors">Sign In</button>
          </div>
        </div>
      </footer>
    </div>
  );
}
