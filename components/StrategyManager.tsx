import React, { useState, useEffect } from 'react';
import { StrategyConfig } from '../types';
import { Play, Square, Settings, Cpu, Save, Code, Sliders } from 'lucide-react';

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
  
  // Form State (Simplified for demo)
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
        // In form mode, we trust the form state but need to ensure types match
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
    // Sync JSON background
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
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                  strategy.isActive 
                    ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20' 
                    : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                }`}
              >
                {strategy.isActive ? (
                  <> <Square className="w-4 h-4 fill-current" /> 停止 </>
                ) : (
                  <> <Play className="w-4 h-4 fill-current" /> 启动 </>
                )}
              </button>
            </div>

            {/* Configuration Area */}
            {editingId === strategy.id ? (
               <div className="mt-4 bg-slate-900 rounded-lg p-4 border border-slate-700">
                  <div className="flex justify-between items-center mb-4 border-b border-slate-800 pb-2">
                    <div className="flex gap-2">
                        <button 
                            onClick={() => setMode('form')}
                            className={`text-xs flex items-center gap-1 px-3 py-1.5 rounded ${mode === 'form' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}
                        >
                            <Sliders className="w-3 h-3" /> 基础配置
                        </button>
                        <button 
                            onClick={() => setMode('json')}
                            className={`text-xs flex items-center gap-1 px-3 py-1.5 rounded ${mode === 'json' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}
                        >
                            <Code className="w-3 h-3" /> 专家模式 (JSON)
                        </button>
                    </div>
                  </div>

                  {mode === 'form' ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {/* Dynamic Form Generation based on common keys */}
                          <div>
                              <label className="block text-xs text-slate-400 mb-1">最低资金费率阈值 (minFundingRate)</label>
                              <div className="flex items-center bg-slate-950 border border-slate-700 rounded px-2">
                                <input 
                                    type="number" step="0.0001"
                                    value={formParams.minFundingRate || 0}
                                    onChange={(e) => updateFormParam('minFundingRate', parseFloat(e.target.value))}
                                    className="w-full bg-transparent text-white p-2 text-sm focus:outline-none"
                                />
                                <span className="text-slate-500 text-xs">%</span>
                              </div>
                          </div>
                          
                          <div>
                              <label className="block text-xs text-slate-400 mb-1">仓位比例 (allocationPct)</label>
                              <div className="flex items-center bg-slate-950 border border-slate-700 rounded px-2">
                                <input 
                                    type="number"
                                    value={formParams.allocationPct || 0}
                                    onChange={(e) => updateFormParam('allocationPct', parseFloat(e.target.value))}
                                    className="w-full bg-transparent text-white p-2 text-sm focus:outline-none"
                                />
                                <span className="text-slate-500 text-xs">%</span>
                              </div>
                          </div>

                           <div>
                              <label className="block text-xs text-slate-400 mb-1">最大杠杆 (maxLeverage)</label>
                              <input 
                                  type="number"
                                  value={formParams.maxLeverage || 1}
                                  onChange={(e) => updateFormParam('maxLeverage', parseFloat(e.target.value))}
                                  className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-sm text-white focus:outline-none focus:border-blue-500"
                              />
                          </div>

                           <div className="flex items-center gap-2 pt-5">
                                <input 
                                    type="checkbox"
                                    checked={formParams.useAI || false}
                                    onChange={(e) => updateFormParam('useAI', e.target.checked)}
                                    className="w-4 h-4 rounded bg-slate-950 border-slate-700"
                                />
                                <label className="text-sm text-slate-300">启用 AI 辅助决策</label>
                           </div>
                      </div>
                  ) : (
                    <textarea
                        value={jsonParams}
                        onChange={(e) => setJsonParams(e.target.value)}
                        className="w-full h-48 bg-slate-950 text-emerald-400 font-mono text-sm p-3 rounded border border-slate-700 focus:outline-none focus:border-blue-500 resize-none"
                        spellCheck={false}
                    />
                  )}

                  <div className="flex gap-2 mt-4 justify-end border-t border-slate-800 pt-3">
                    <button 
                      onClick={() => setEditingId(null)}
                      className="px-3 py-1.5 text-sm text-slate-400 hover:text-white"
                    >
                      取消
                    </button>
                    <button 
                      onClick={handleSave}
                      className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm flex items-center gap-2 font-medium"
                    >
                      <Save className="w-4 h-4" /> 保存配置
                    </button>
                  </div>
               </div>
            ) : (
              <div className="mt-4">
                 <div className="flex flex-wrap gap-2 mb-3">
                    {Object.entries(strategy.parameters).slice(0, 4).map(([k, v]) => (
                        <span key={k} className="px-2 py-1 bg-slate-700/50 rounded border border-slate-700 text-xs text-slate-300">
                            {k}: <span className="text-emerald-400">{String(v)}</span>
                        </span>
                    ))}
                 </div>
                 <button 
                  onClick={() => handleEdit(strategy)}
                  className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1 mt-2"
                 >
                   <Settings className="w-4 h-4" /> 修改参数
                 </button>
              </div>
            )}
          </div>
          
          {/* Status Footer */}
          <div className="bg-slate-900/40 p-3 px-6 border-t border-slate-700 flex justify-between items-center text-xs text-slate-500">
            <span>ID: {strategy.id}</span>
            <span>上次运行: {strategy.lastRun ? new Date(strategy.lastRun).toLocaleTimeString() : '从未'}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

export default StrategyManager;