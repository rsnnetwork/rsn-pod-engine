import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Send, SmilePlus, Smile } from 'lucide-react';
import { useSessionStore, ChatMessage } from '@/stores/sessionStore';
import { useAuthStore } from '@/stores/authStore';
import { getSocket } from '@/lib/socket';

const CHAT_EMOJIS = [
  { type: 'heart', emoji: '❤️' },
  { type: 'clap', emoji: '👏' },
  { type: 'thumbs_up', emoji: '👍' },
] as const;

const EMOJI_PICKER_LIST = ['😀','😂','😍','🥳','🤔','👍','👏','❤️','🔥','🎉','💯','🙌','😮','🤩','😎','👋','✅','💪','🙏','⭐'];

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
  const hostInLobby = useSessionStore(s => s.hostInLobby);
  const hostUserId = useSessionStore(s => s.hostUserId);
  const cohosts = useSessionStore(s => s.cohosts);
  const { user } = useAuthStore();

  // Determine scope based on current phase
  const scope: 'lobby' | 'room' = phase === 'matched' ? 'room' : 'lobby';

  // Chat disabled in lobby when host is not present (host/co-hosts always allowed)
  const isHostOrCohost = user?.id === hostUserId || (!!user?.id && cohosts.has(user.id));
  const chatDisabled = scope === 'lobby' && !hostInLobby && !isHostOrCohost;

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
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-800">Chat</h3>
          <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
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
            sessionId={sessionId}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {phase !== 'complete' && (
        <div className="px-4 py-3 border-t border-gray-200">
          {chatDisabled ? (
            <p className="text-xs text-gray-400 text-center py-1">Chat available when host joins</p>
          ) : (
            <ChatInputWithEmoji
              inputRef={inputRef}
              input={input}
              setInput={setInput}
              handleKeyDown={handleKeyDown}
              handleSend={handleSend}
              scope={scope}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ChatInputWithEmoji({ inputRef, input, setInput, handleKeyDown, handleSend, scope }: {
  inputRef: any;
  input: string;
  setInput: (v: string) => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleSend: () => void;
  scope: string;
}) {
  const [showEmoji, setShowEmoji] = useState(false);
  return (
    <div className="relative">
      {showEmoji && (
        <div className="absolute bottom-full left-0 right-0 mb-1 bg-white border border-gray-200 rounded-xl p-2 grid grid-cols-10 gap-1 shadow-lg">
          {EMOJI_PICKER_LIST.map(e => (
            <button key={e} onClick={() => { setInput(input + e); setShowEmoji(false); inputRef.current?.focus(); }}
              className="text-lg hover:bg-gray-100 rounded p-1 transition-colors">{e}</button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={() => setShowEmoji(!showEmoji)} className="p-2 text-gray-400 hover:text-gray-600 transition-colors">
          <Smile className="h-4 w-4" />
        </button>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={scope === 'room' ? 'Message your room...' : 'Message everyone...'}
          maxLength={500}
          className="flex-1 px-3 py-2 text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500/50 placeholder-gray-400"
        />
        <button onClick={handleSend} disabled={!input.trim()}
          className="p-2 rounded-full bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ msg, isOwn, sessionId }: { msg: ChatMessage; isOwn: boolean; sessionId: string }) {
  const [showPicker, setShowPicker] = useState(false);
  const userId = useAuthStore(s => s.user?.id);

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleReact = (emoji: string) => {
    const socket = getSocket();
    socket?.emit('chat:react', { sessionId, messageId: msg.id, emoji });
    setShowPicker(false);
  };

  const reactions = msg.reactions || {};
  const hasReactions = Object.keys(reactions).length > 0;

  return (
    <div className={`flex flex-col ${isOwn ? 'items-end' : 'items-start'} group/msg`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2 ${
          isOwn
            ? 'bg-blue-50 text-gray-800'
            : msg.isHost
            ? 'bg-amber-50 border-l-2 border-amber-500 text-gray-800'
            : 'bg-gray-100 text-gray-800'
        }`}
      >
        {!isOwn && (
          <div className="flex items-center gap-1.5 mb-0.5">
            <a href={`/profile/${msg.userId}`} className={`text-xs font-semibold hover:underline ${msg.isHost ? 'text-amber-600' : 'text-gray-500'}`}>
              {msg.displayName}
              {msg.isHost && <span className="ml-1 text-[10px] font-medium text-amber-600">HOST</span>}
            </a>
          </div>
        )}
        <p className="text-sm leading-relaxed break-words text-gray-800"><Linkify text={msg.message} /></p>
        <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} mt-0.5`}>
          <span className="text-[10px] text-gray-400">
            {msg.scope === 'room' && <span className="mr-1">Room</span>}
            {formatTime(msg.timestamp)}
          </span>
        </div>
      </div>
      {/* Reaction display */}
      {hasReactions && (
        <div className={`flex gap-1 mt-0.5 ${isOwn ? 'justify-end' : 'justify-start'}`}>
          {CHAT_EMOJIS.filter(e => reactions[e.type]?.length).map(e => (
            <button
              key={e.type}
              onClick={() => handleReact(e.type)}
              className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[11px] transition-colors ${
                reactions[e.type]?.includes(userId || '') ? 'bg-blue-100 border border-blue-300' : 'bg-gray-50 border border-gray-200'
              } hover:bg-gray-100`}
            >
              <span>{e.emoji}</span>
              <span className="text-gray-600">{reactions[e.type].length}</span>
            </button>
          ))}
        </div>
      )}
      {/* Reaction picker toggle */}
      <div className={`relative ${isOwn ? 'self-end' : 'self-start'}`}>
        <button
          onClick={() => setShowPicker(!showPicker)}
          className="opacity-0 group-hover/msg:opacity-100 transition-opacity p-0.5 text-gray-500 hover:text-gray-300"
        >
          <SmilePlus className="h-3.5 w-3.5" />
        </button>
        {showPicker && (
          <div className={`absolute bottom-6 ${isOwn ? 'right-0' : 'left-0'} flex gap-1 bg-white border border-gray-200 rounded-full px-2 py-1 shadow-lg z-10`}>
            {CHAT_EMOJIS.map(e => (
              <button key={e.type} onClick={() => handleReact(e.type)} className="hover:scale-125 transition-transform text-sm">
                {e.emoji}
              </button>
            ))}
          </div>
        )}
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
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline hover:text-blue-700 break-all">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
