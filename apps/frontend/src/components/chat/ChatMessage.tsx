import React from "react";
import type { Message } from "../../types/chat";
import { Bot, User, Paperclip, Music, Play, Pause } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Avatar, AvatarFallback } from "../ui/avatar";

interface ChatMessageProps {
  message: Message;
}

const getModelBadgeDetails = (modelKey: string) => {
  const normalized = modelKey.toLowerCase();
  if (normalized.includes("gpt")) {
    return {
      name: "GPT-4o",
      className: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
    };
  }
  if (normalized.includes("claude")) {
    return {
      name: "Claude 3.5 Sonnet",
      className: "bg-orange-500/10 border-orange-500/30 text-orange-400",
    };
  }
  if (normalized.includes("groq") || normalized.includes("llama")) {
    return {
      name: "Llama 3.1 (Groq)",
      className: "bg-purple-500/10 border-purple-500/30 text-purple-400",
    };
  }
  if (normalized.includes("gemini")) {
    return {
      name: "Gemini 1.5 Pro",
      className: "bg-cyan-500/10 border-cyan-500/30 text-cyan-400",
    };
  }
  return {
    name: modelKey,
    className: "bg-blue-500/10 border-blue-500/30 text-blue-400",
  };
};

export const ChatMessage: React.FC<ChatMessageProps> = ({ message }) => {
  const isUser = message.sender === "user";
  const [isPlayingAudio, setIsPlayingAudio] = React.useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  const toggleAudio = () => {
    if (!audioRef.current) return;
    if (isPlayingAudio) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlayingAudio(!isPlayingAudio);
  };

  return (
    <div
      className={`flex w-full gap-3 py-3 px-4 ${
        isUser ? "justify-end" : "justify-start"
      }`}
    >
      {!isUser && (
        <Avatar><AvatarFallback><Bot className="size-4" /></AvatarFallback></Avatar>
      )}

      <div
        className={`flex max-w-[80%] md:max-w-[70%] flex-col gap-2 rounded-2xl px-4 py-3 text-sm shadow-sm transition-all ${
          isUser
            ? "bg-blue-600 text-white rounded-br-none border border-blue-500/40"
            : "bg-slate-900/90 text-slate-100 border border-slate-800/80 rounded-bl-none backdrop-blur-sm"
        }`}
      >
        {/* Model Badge */}
        {!isUser && message.model && (
          <div className="flex items-center self-start">
            <span
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border ${getModelBadgeDetails(message.model).className}`}
            >
              {getModelBadgeDetails(message.model).name}
            </span>
          </div>
        )}
        {/* Attachments Section */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 pb-1">
            {message.attachments.map((file) => (
              <a
                key={file.id}
                href={file.url}
                target="_blank"
                rel="noreferrer"
                aria-disabled={!file.url}
                className={!file.url ? "pointer-events-none" : undefined}
              >
                <Badge
                  variant={isUser ? "secondary" : "default"}
                  className="flex items-center gap-1.5 py-1 px-2.5 bg-slate-800/80 border-slate-700/60 text-xs text-slate-200 hover:border-blue-500/60"
                >
                  <Paperclip className="h-3.5 w-3.5 text-blue-400" />
                  <span className="truncate max-w-[140px] font-medium">
                    {file.name}
                  </span>
                  <span className="opacity-60 text-[10px]">
                    ({(file.size / 1024).toFixed(1)} KB)
                  </span>
                </Badge>
              </a>
            ))}
          </div>
        )}

        {/* Audio Attachment Section */}
        {message.audio && (
          <div className="flex items-center gap-3 p-2 rounded-xl bg-slate-950/40 border border-slate-800/60">
            <Button
              onClick={toggleAudio}
              variant="secondary"
              size="icon"
              className="size-8"
              aria-label={isPlayingAudio ? "Pausar áudio" : "Reproduzir áudio"}
            >
              {isPlayingAudio ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4 ml-0.5" />
              )}
            </Button>
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <Music className="h-3.5 w-3.5 text-blue-400" />
              <span>Áudio de voz ({message.audio.durationSeconds}s)</span>
            </div>
            <audio
              ref={audioRef}
              src={message.audio.url}
              onEnded={() => setIsPlayingAudio(false)}
              className="hidden"
            />
          </div>
        )}

        {/* Text Content */}
        {message.content && (
          <div className="whitespace-pre-wrap leading-relaxed">
            {message.content}
            {message.isStreaming && (
              <span className="inline-block w-2 h-4 ml-1 bg-blue-400 animate-pulse align-middle" />
            )}
          </div>
        )}

        {/* Timestamp */}
        <span
          className={`text-[10px] self-end mt-0.5 opacity-60 ${
            isUser ? "text-blue-100" : "text-slate-400"
          }`}
        >
          {message.timestamp}
        </span>
      </div>

      {isUser && (
        <Avatar><AvatarFallback><User className="size-4" /></AvatarFallback></Avatar>
      )}
    </div>
  );
};
