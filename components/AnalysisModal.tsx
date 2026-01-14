import React from 'react';
import { X, ShieldAlert, TrendingUp, TrendingDown, MinusCircle, Lightbulb, Activity } from 'lucide-react';
import { AIAnalysisResult } from '../types';

interface AnalysisModalProps {
  isOpen: boolean;
  onClose: () => void;
  analysis: AIAnalysisResult | null;
}

const AnalysisModal: React.FC<AnalysisModalProps> = ({ isOpen, onClose, analysis }) => {
  if (!isOpen || !analysis) return null;

  const getActionColor = (action: string) => {
    switch (action) {
      case 'BUY': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
      case 'SELL': return 'text-red-400 bg-red-500/10 border-red-500/20';
      case 'HOLD': return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20';
      default: return 'text-slate-400 bg-slate-500/10 border-slate-500/20';
    }
  };

  const getRiskColor = (score: number) => {
    if (score < 40) return 'text-emerald-400';
    if (score < 70) return 'text-yellow-400';
    return 'text-red-400';
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Modal Content */}
      <div className="relative bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-slate-800 bg-slate-900">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-lg">
                <Lightbulb className="w-6 h-6 text-indigo-400" />
            </div>
            <div>
                <h2 className="text-xl font-bold text-white">Gemini 市场深度分析</h2>
                <p className="text-xs text-slate-400">基于实时资金费率与市场波动率模型</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors p-1 hover:bg-slate-800 rounded-lg"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="p-6 overflow-y-auto space-y-6 custom-scrollbar">
          
          {/* Top Status Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
             {/* Decision Card */}
             <div className={`p-4 rounded-xl border flex flex-col items-center justify-center ${getActionColor(analysis.recommendedAction)}`}>
                <span className="text-xs uppercase font-bold tracking-wider opacity-80 mb-1">建议操作</span>
                <span className="text-3xl font-black">{analysis.recommendedAction}</span>
             </div>

             {/* Risk Card */}
             <div className="p-4 rounded-xl border border-slate-700 bg-slate-800 flex flex-col justify-center">
                <div className="flex justify-between items-end mb-2">
                    <span className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center gap-1">
                        <ShieldAlert className="w-3 h-3" /> 风险评分
                    </span>
                    <span className={`text-2xl font-bold ${getRiskColor(analysis.riskScore)}`}>
                        {analysis.riskScore}<span className="text-sm text-slate-500">/100</span>
                    </span>
                </div>
                {/* Progress Bar */}
                <div className="w-full bg-slate-700 h-2 rounded-full overflow-hidden">
                    <div 
                        className={`h-full transition-all duration-500 ${analysis.riskScore > 70 ? 'bg-red-500' : analysis.riskScore > 40 ? 'bg-yellow-500' : 'bg-emerald-500'}`}
                        style={{ width: `${analysis.riskScore}%` }}
                    />
                </div>
                <p className="text-xs text-slate-500 mt-2 text-right">
                    {analysis.riskScore > 80 ? '极高风险，建议观望' : '市场环境处于可接受范围'}
                </p>
             </div>
          </div>

          {/* Targeted Assets */}
          {analysis.suggestedPairs.length > 0 && (
              <div>
                  <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                      <Activity className="w-4 h-4 text-blue-400" /> 目标标的 (Target Assets)
                  </h3>
                  <div className="flex flex-wrap gap-2">
                      {analysis.suggestedPairs.map((pair, idx) => (
                          <span key={idx} className="px-3 py-1.5 bg-slate-800 border border-slate-600 rounded-lg text-sm text-slate-200 font-mono">
                              {pair}
                          </span>
                      ))}
                  </div>
              </div>
          )}

          {/* Full Reasoning */}
          <div className="bg-slate-950/50 rounded-xl border border-slate-800 p-5">
            <h3 className="text-sm font-semibold text-slate-300 mb-3 uppercase tracking-wider">完整逻辑推演 (Reasoning)</h3>
            <div className="prose prose-invert prose-sm max-w-none text-slate-300 leading-relaxed whitespace-pre-wrap">
                {analysis.reasoning}
            </div>
          </div>

        </div>
        
        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-900/50 text-center">
            <span className="text-xs text-slate-500">
                本分析由 Gemini AI 生成，仅供参考。实际交易决策请结合自身风控模型。
            </span>
        </div>
      </div>
    </div>
  );
};

export default AnalysisModal;