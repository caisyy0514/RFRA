import React, { useRef, useEffect } from 'react';
import { LogEntry } from '../types';
import { Terminal, AlertTriangle, Info, CheckCircle, XCircle } from 'lucide-react';

interface LogsPanelProps {
  logs: LogEntry[];
}

const LogsPanel: React.FC<LogsPanelProps> = ({ logs }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const getIcon = (level: string) => {
    switch(level) {
      case 'error': return <XCircle className="w-4 h-4 text-red-500" />;
      case 'warning': return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
      case 'success': return <CheckCircle className="w-4 h-4 text-emerald-500" />;
      default: return <Info className="w-4 h-4 text-blue-500" />;
    }
  };

  return (
    <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-lg flex flex-col h-[400px]">
      <div className="p-4 border-b border-slate-700 flex items-center gap-2">
        <Terminal className="w-5 h-5 text-slate-400" />
        <h3 className="font-semibold text-white">系统日志</h3>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-xs" ref={scrollRef}>
        {logs.length === 0 && <div className="text-slate-500 italic">暂无日志。</div>}
        {logs.map((log) => (
          <div key={log.id} className="flex gap-3 hover:bg-slate-700/30 p-1 rounded">
            <div className="text-slate-500 shrink-0 w-20">{new Date(log.timestamp).toLocaleTimeString()}</div>
            <div className="shrink-0 pt-0.5">{getIcon(log.level)}</div>
            <div className="font-bold text-slate-400 shrink-0 w-16">[{log.source}]</div>
            <div className={`break-all ${log.level === 'error' ? 'text-red-300' : 'text-slate-300'}`}>
              {log.message}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default LogsPanel;