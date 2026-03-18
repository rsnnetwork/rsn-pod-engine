import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Send } from 'lucide-react';
import { useSessionStore, ChatMessage } from '@/stores/sessionStore';
import { useAuthStore } from '@/stores/authStore';
import { getSocket } from '@/lib/socket';

interface ChatPanelProps {
  sessionId: string;
  onClose: () => void;
}

export default function ChatPanel({ sessionId, onClose }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatMessages = useSessionStore(s => s.chatMessages);
  const phase = useSessionStore(s => s.phase);
  const { user } = useAuthStore();

  // Determine scope based on current phase
  const scope: 'lobby' | 'room' = phase === 'matched' ? 'room' : 'lobby';

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages.length]);

  // Mark as read when panel opens
  useEffect(() => {
    useSessionStore.getState().resetUnreadChat();
  }, []);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;

    const socket = getSocket();
    if (!socket) return;

    socket.emit('chat:send', { sessionId, message: trimmed, scope });
    setInput('');
    inputRef.current?.focus();
  }, [input, sessionId, scope]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Filter messages by scope: in room phase show room msgs, in lobby show lobby msgs
  // But always show all messages so users don't lose context
  const visibleMessages = chatMessages;

  return (
    <div className="flex flex-col h-full bg-white border-l border-gray-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50/80">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-700">Chat</h3>
          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
            {scope === 'room' ? 'Room' : 'Everyone'}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {visibleMessages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-gray-400">No messages yet. Say hello!</p>
          </div>
        )}
        {visibleMessages.map((msg) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            isOwn={msg.userId === user?.id}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {phase !== 'complete' && (
        <div className="px-4 py-3 border-t border-gray-200 bg-gray-50/50">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={scope === 'room' ? 'Message your room...' : 'Message everyone...'}
              maxLength={500}
              style={{ color: '#000000' }}
              className="flex-1 px-3 py-2 text-sm bg-white border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-rsn-red/30 focus:border-rsn-red/50 placeholder-gray-400"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="p-2 rounded-full bg-rsn-red text-white hover:bg-rsn-red/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg, isOwn }: { msg: ChatMessage; isOwn: boolean }) {
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className={`flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2 ${
          isOwn
            ? 'bg-rsn-red/10 text-gray-800'
            : msg.isHost
            ? 'bg-amber-50 border-l-2 border-amber-400 text-gray-800'
            : 'bg-gray-100 text-gray-800'
        }`}
      >
        {!isOwn && (
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className={`text-xs font-semibold ${msg.isHost ? 'text-amber-600' : 'text-gray-500'}`}>
              {msg.displayName}
              {msg.isHost && <span className="ml-1 text-[10px] font-medium text-amber-500">HOST</span>}
            </span>
          </div>
        )}
        <p className="text-sm leading-relaxed break-words"><Linkify text={msg.message} /></p>
        <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} mt-0.5`}>
          <span className="text-[10px] text-gray-400">
            {msg.scope === 'room' && <span className="mr-1">Room</span>}
            {formatTime(msg.timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
}

const URL_REGEX = /(https?:\/\/[^\s<]+)/g;

function Linkify({ text }: { text: string }) {
  const parts = text.split(URL_REGEX);
  return (
    <>
      {parts.map((part, i) =>
        URL_REGEX.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline hover:text-blue-800 break-all">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
