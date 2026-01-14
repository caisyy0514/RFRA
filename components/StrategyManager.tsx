import React, { useState } from 'react';
import { StrategyConfig } from '../types';
import { Play, Square, Settings, Cpu, Save, Code, Sliders, Info } from 'lucide-react';

interface StrategyManagerProps {
  strategies: StrategyConfig[];
  onToggleStrategy: (id: string) => void;
  onUpdateStrategy: (strategy: StrategyConfig) => void;
}

const StrategyManager: React.FC<StrategyManagerProps> = ({ strategies, onToggleStrategy, onUpdateStrategy }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mode, setMode] = useState<'form' | 'json'>('form');
  
  // JSON State
  const [jsonParams, setJsonParams] = useState<string>('');
  
  // Form State
  const [formParams, setFormParams] = useState<any>({});

  const handleEdit = (strategy: StrategyConfig) => {
    setEditingId(strategy.id);
    setJsonParams(JSON.stringify(strategy.parameters, null, 2));
    setFormParams(strategy.parameters);
    setMode('form');
  };

  const handleSave = () => {
    if (!editingId) return;
    try {
      let finalParams: any = {};
      if (mode === 'json') {
        finalParams = JSON.parse(jsonParams);
      } else {
        finalParams = formParams;
      }

      const strategy = strategies.find(s => s.id === editingId);
      if (strategy) {
        onUpdateStrategy({ ...strategy, parameters: finalParams });
      }
      setEditingId(null);
    } catch (e) {
      alert("配置参数无效，请检查格式");
    }
  };

  const updateFormParam = (key: string, value: any) => {
    const newParams = { ...formParams, [key]: value };
    setFormParams(newParams);
    setJsonParams(JSON.stringify(newParams, null, 2));
  };

  return (
    <div className="grid grid-cols-1 gap-6 animate-fade-in">
      {strategies.map((strategy) => (
        <div key={strategy.id} className={`bg-slate-800 rounded-xl border ${strategy.isActive ? 'border-emerald-500/50' : 'border-slate-700'} shadow-lg overflow-hidden transition-all duration-300`}>
          <div className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div className="flex items-center gap-3">
                 <div className={`p-2 rounded-lg ${strategy.isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-700 text-slate-400'}`}>
                    <Cpu className="w-6 h-6" />
                 </div>
                 <div>
                    <h3 className="text-xl font-bold text-white">{strategy.name}</h3>
                    <div className="text-xs text-slate-400 uppercase tracking-wider mt-1">{strategy.type.replace('_', ' ')}</div>
                 </div>
              </div>
              
              <button
                onClick={() => onToggleStrategy(strategy.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all transform active:scale-95 ${
                  strategy.isActive 
                    ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20' 
                    : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                }`}
              >
                {strategy.isActive ? (
                  <> <Square className="w-4 h-4 fill-current" /> 停止策略 </>
                ) : (
                  <> <Play className="w-4 h-4 fill-current" /> 启动策略 </>
                )}
              </button>
            </div>

            {/* Configuration Area */}
            {editingId === strategy.id ? (
               <div className="mt-4 bg-slate-900 rounded-lg p-5 border border-slate-700">
                  <div className="flex justify-between items-center mb-4 border-b border-slate-800 pb-3">
                    <div className="flex gap-2">
                        <button 
                            onClick={() => setMode('form')}
                            className={`text-xs flex items-center gap-1 px-3 py-1.5 rounded transition-colors ${mode === 'form' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}
                        >
                            <Sliders className="w-3 h-3" /> 基础配置
                        </button>
                        <button 
                            onClick={() => setMode('json')}
                            className={`text-xs flex items-center gap-1 px-3 py-1.5 rounded transition-colors ${mode === 'json' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}
                        >
                            <Code className="w-3 h-3" /> 专家模式 (JSON)
                        </button>
                    </div>
                  </div>

                  {mode === 'form' ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                          <div>
                              <label className="block text-xs text-slate-400 mb-1.5 flex items-center gap-1">
                                最低费率阈值 (minFundingRate)
                                {/* Fix: Wrap Lucide Info in span with title attribute as title is not a direct prop */}
                                <span title="高于此费率才考虑入场">
                                  <Info className="w-3 h-3 text-slate-600" />
                                </span>
                              </label>
                              <div className="flex items-center bg-slate-950 border border-slate-700 rounded-lg px-2">
                                <input 
                                    type="number" step="0.0001"
                                    value={formParams.minFundingRate || 0}
                                    onChange={(e) => updateFormParam('minFundingRate', parseFloat(e.target.value))}
                                    className="w-full bg-transparent text-white p-2.5 text-sm focus:outline-none"
                                />
                                <span className="text-slate-500 text-xs px-2">%</span>
                              </div>
                          </div>
                          
                          <div>
                              <label className="block text-xs text-slate-400 mb-1.5 flex items-center gap-1">
                                单币种分配比例 (allocationPct)
                                {/* Fix: Wrap Lucide Info in span with title attribute as title is not a direct prop */}
                                <span title="单个币种套利占用的本金百分比">
                                  <Info className="w-3 h-3 text-slate-600" />
                                </span>
                              </label>
                              <div className="flex items-center bg-slate-950 border border-slate-700 rounded-lg px-2">
                                <input 
                                    type="number"
                                    value={formParams.allocationPct || 0}
                                    onChange={(e) => updateFormParam('allocationPct', parseFloat(e.target.value))}
                                    className="w-full bg-transparent text-white p-2.5 text-sm focus:outline-none"
                                />
                                <span className="text-slate-500 text-xs px-2">%</span>
                              </div>
                              <p className="text-[10px] text-slate-500 mt-1">注：当前最大持仓数为 3，建议设置低于 33.3%</p>
                          </div>

                           <div>
                              <label className="block text-xs text-slate-400 mb-1.5">成交额门槛 (minVolume24h)</label>
                              <div className="flex items-center bg-slate-950 border border-slate-700 rounded-lg px-2">
                                <input 
                                    type="number"
                                    value={formParams.minVolume24h || 0}
                                    onChange={(e) => updateFormParam('minVolume24h', parseFloat(e.target.value))}
                                    className="w-full bg-transparent text-white p-2.5 text-sm focus:outline-none"
                                />
                                <span className="text-slate-500 text-xs px-2">USDT</span>
                              </div>
                          </div>

                           <div className="space-y-4">
                             <div className="flex items-center gap-2 mt-2">
                                  <input 
                                      type="checkbox"
                                      id="useAI"
                                      checked={formParams.useAI || false}
                                      onChange={(e) => updateFormParam('useAI', e.target.checked)}
                                      className="w-4 h-4 rounded border-slate-700 bg-slate-950 text-blue-600 focus:ring-blue-600"
                                  />
                                  <label htmlFor="useAI" className="text-sm text-slate-300 font-medium">启用 AI 最终核准</label>
                             </div>
                             <div className="text-xs text-slate-500 border-l-2 border-blue-500/30 pl-3">
                               开启后，引擎在执行开仓前会将标的发送给 Gemini 进行流动性与风险评估。
                             </div>
                           </div>
                      </div>
                  ) : (
                    <textarea
                        value={jsonParams}
                        onChange={(e) => setJsonParams(e.target.value)}
                        className="w-full h-56 bg-slate-950 text-emerald-400 font-mono text-sm p-4 rounded-lg border border-slate-700 focus:outline-none focus:border-blue-500 resize-none shadow-inner"
                        spellCheck={false}
                    />
                  )}

                  <div className="flex gap-2 mt-6 justify-end border-t border-slate-800 pt-4">
                    <button 
                      onClick={() => setEditingId(null)}
                      className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
                    >
                      取消
                    </button>
                    <button 
                      onClick={handleSave}
                      className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm flex items-center gap-2 font-bold shadow-lg transition-all"
                    >
                      <Save className="w-4 h-4" /> 保存并应用
                    </button>
                  </div>
               </div>
            ) : (
              <div className="mt-4">
                 <div className="flex flex-wrap gap-3 mb-4">
                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 flex flex-col min-w-[120px]">
                      <span className="text-[10px] text-slate-500 uppercase font-bold">单币分配</span>
                      <span className="text-emerald-400 font-bold text-lg">{strategy.parameters.allocationPct}%</span>
                    </div>
                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 flex flex-col min-w-[120px]">
                      <span className="text-[10px] text-slate-500 uppercase font-bold">费率阈值</span>
                      <span className="text-blue-400 font-bold text-lg">{strategy.parameters.minFundingRate}%</span>
                    </div>
                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 flex flex-col min-w-[120px]">
                      <span className="text-[10px] text-slate-500 uppercase font-bold">最大持仓</span>
                      <span className="text-white font-bold text-lg">{strategy.parameters.maxPositions || 3}</span>
                    </div>
                    <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 flex flex-col min-w-[120px]">
                      <span className="text-[10px] text-slate-500 uppercase font-bold">AI 审核</span>
                      <span className={`font-bold text-lg ${strategy.parameters.useAI ? 'text-emerald-400' : 'text-slate-500'}`}>{strategy.parameters.useAI ? 'ON' : 'OFF'}</span>
                    </div>
                 </div>
                 <button 
                  onClick={() => handleEdit(strategy)}
                  className="text-sm text-slate-400 hover:text-white flex items-center gap-1.5 transition-colors"
                 >
                   <Settings className="w-4 h-4" /> 修改策略运行参数
                 </button>
              </div>
            )}
          </div>
          
          {/* Status Footer */}
          <div className="bg-slate-900/60 p-3 px-6 border-t border-slate-700/50 flex justify-between items-center text-[10px] tracking-wider text-slate-500 uppercase font-medium">
            <span className="flex items-center gap-1.5"><span className={`w-1.5 h-1.5 rounded-full ${strategy.isActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`}></span> ID: {strategy.id}</span>
            <span>LAST RUN: {strategy.lastRun ? new Date(strategy.lastRun).toLocaleTimeString() : 'PENDING'}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

export default StrategyManager;