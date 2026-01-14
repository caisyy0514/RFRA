import React, { useState } from 'react';
import { StrategyConfig } from '../types';
import { Play, Square, Settings, Cpu, Save } from 'lucide-react';

interface StrategyManagerProps {
  strategies: StrategyConfig[];
  onToggleStrategy: (id: string) => void;
  onUpdateStrategy: (strategy: StrategyConfig) => void;
}

const StrategyManager: React.FC<StrategyManagerProps> = ({ strategies, onToggleStrategy, onUpdateStrategy }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editParams, setEditParams] = useState<string>('');

  const handleEdit = (strategy: StrategyConfig) => {
    setEditingId(strategy.id);
    setEditParams(JSON.stringify(strategy.parameters, null, 2));
  };

  const handleSave = () => {
    if (!editingId) return;
    try {
      const parsedParams = JSON.parse(editParams);
      const strategy = strategies.find(s => s.id === editingId);
      if (strategy) {
        onUpdateStrategy({ ...strategy, parameters: parsedParams });
      }
      setEditingId(null);
    } catch (e) {
      alert("JSON 格式无效");
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6">
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
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm text-slate-400">策略参数配置 (JSON)</span>
                  </div>
                  <textarea
                    value={editParams}
                    onChange={(e) => setEditParams(e.target.value)}
                    className="w-full h-48 bg-slate-950 text-emerald-400 font-mono text-sm p-3 rounded border border-slate-700 focus:outline-none focus:border-blue-500 resize-none"
                    spellCheck={false}
                  />
                  <div className="flex gap-2 mt-3 justify-end">
                    <button 
                      onClick={() => setEditingId(null)}
                      className="px-3 py-1.5 text-sm text-slate-400 hover:text-white"
                    >
                      取消
                    </button>
                    <button 
                      onClick={handleSave}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm flex items-center gap-2"
                    >
                      <Save className="w-4 h-4" /> 保存配置
                    </button>
                  </div>
               </div>
            ) : (
              <div className="mt-4">
                 <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700/50 font-mono text-sm text-slate-400 overflow-x-auto">
                    <pre>{JSON.stringify(strategy.parameters, null, 2)}</pre>
                 </div>
                 <button 
                  onClick={() => handleEdit(strategy)}
                  className="mt-3 text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1"
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