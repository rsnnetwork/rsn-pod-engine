import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';

export default function AboutPage() {
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
            <button onClick={() => navigate('/reasons')} className="hover:text-[#1a1a2e] transition-colors">Reasons To Join</button>
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
      <div className="max-w-3xl mx-auto px-6 pt-16 pb-24">
        <button onClick={() => navigate('/welcome')} className="flex items-center gap-2 text-gray-400 hover:text-gray-700 transition-colors text-sm mb-8">
          <ArrowLeft className="h-4 w-4" /> Back to Home
        </button>

        <h1 className="text-4xl md:text-5xl font-extrabold text-[#1a1a2e] tracking-tight mb-8 animate-fade-in-up">About RSN</h1>

        <div className="space-y-6 text-lg text-gray-600 leading-relaxed animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
          <p>
            <strong className="text-[#1a1a2e]">RSN — Raw Speed Networking</strong> is networking stripped back to what actually works.
          </p>
          <p>
            No apps to download. No small talk. No forced connections.
            Just real conversations with real people, in 8-minute rounds, via live video.
          </p>
          <p>
            We built RSN because we were tired of events that felt like performances.
            Conferences where everyone's pitching. Mixers where nobody remembers anyone.
            LinkedIn messages that go nowhere.
          </p>
          <p>
            RSN is the opposite. It's fast, focused, and human.
            You show up, get matched 1-on-1, talk, rate, and move on.
            If it's mutual — you connect for real.
          </p>
          <p>
            It's designed for founders, operators, and leaders who value their time
            and want to build relationships that actually matter.
          </p>
        </div>

        {/* Founders */}
        <div className="mt-16 pt-16 border-t border-gray-200 animate-fade-in-up" style={{ animationDelay: '0.2s' }}>
          <h2 className="text-2xl font-extrabold text-[#1a1a2e] tracking-tight mb-8">Founders</h2>
          <div className="grid md:grid-cols-2 gap-10">
            <div>
              <h3 className="text-xl font-bold text-[#1a1a2e] mb-1">Stefan Avivson</h3>
              <p className="text-gray-500 leading-relaxed">
                Co-founder of RSN. Passionate about building systems that remove friction
                from human connection. Believes the best relationships start with honest
                conversation, not polished pitches.
              </p>
            </div>
            <div>
              <h3 className="text-xl font-bold text-[#1a1a2e] mb-1">Michael Kainatsky</h3>
              <p className="text-gray-500 leading-relaxed">
                Co-founder of RSN. Driven by the idea that networking should feel natural,
                not transactional. Building the infrastructure for founders to meet
                the right people, faster.
              </p>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="mt-16 text-center animate-fade-in-up" style={{ animationDelay: '0.3s' }}>
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
            <button onClick={() => navigate('/reasons')} className="hover:text-gray-700 transition-colors">Reasons</button>
            <button onClick={() => navigate('/login')} className="hover:text-gray-700 transition-colors">Sign In</button>
          </div>
        </div>
      </footer>
    </div>
  );
}
