import React, { useState, useEffect, useRef } from 'react';
import { LayoutDashboard, Settings, Layers, Zap, PlayCircle, List, Eye, Lock } from 'lucide-react';
import { okxService } from './services/okxService';
import { analyzeMarketConditions } from './services/deepseekService';
import Dashboard from './components/Dashboard';
import StrategyManager from './components/StrategyManager';
import LogsPanel from './components/LogsPanel';
import OrdersPanel from './components/OrdersPanel';
import AnalysisModal from './components/AnalysisModal';
import { Asset, TickerData, StrategyConfig, LogEntry, OKXConfig, AIAnalysisResult, Position, Instrument } from './types';
import { DEFAULT_STRATEGIES, MOCK_LOGS_INIT } from './constants';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'strategies' | 'orders' | 'settings'>('dashboard');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [marketData, setMarketData] = useState<TickerData[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [instruments, setInstruments] = useState<Instrument[]>([]); 
  const [totalEquity, setTotalEquity] = useState<number>(0);
  const [strategies, setStrategies] = useState<StrategyConfig[]>(DEFAULT_STRATEGIES);
  const [logs, setLogs] = useState<LogEntry[]>(MOCK_LOGS_INIT);
  const [lastAnalysis, setLastAnalysis] = useState<AIAnalysisResult | null>(null);
  const [isAnalysisModalOpen, setIsAnalysisModalOpen] = useState(false);
  
  // DeepSeek API Key State
  const [deepseekKey, setDeepseekKey] = useState<string>(localStorage.getItem('deepseek_key') || '');
  
  const [okxConfig, setOkxConfig] = useState<OKXConfig>({
    apiKey: '',
    secretKey: '',
    passphrase: '',
    isSimulated: true
  });

  const addLog = (level: LogEntry['level'], source: LogEntry['source'], message: string) => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36),
      timestamp: Date.now(),
      level,
      source,
      message
    }]);
  };

  useEffect(() => {
    okxService.setConfig(okxConfig);
    const init = async () => {
        if (okxConfig.apiKey) {
            const isConfigValid = await okxService.checkAccountConfiguration();
            if (!isConfigValid) {
                addLog('error', 'SYSTEM', '账户风险警告：请确保 OKX 账户处于“单币种保证金”或“跨币种保证金”模式！');
            } else {
                addLog('info', 'SYSTEM', '账户模式检查通过 (Single/Multi Currency Margin)。');
            }
            okxService.getInstruments('SWAP').then(setInstruments).catch(console.error);
            fetchData();
        }
    };
    init();
    const interval = setInterval(fetchData, 15000); 
    return () => clearInterval(interval);
  }, [okxConfig]);

  const fetchData = async () => {
    try {
      if (!okxConfig.apiKey) return;
      const [newAssets, newRates, newPositions] = await Promise.all([
        okxService.getAccountAssets(),
        okxService.getFundingRates(), 
        okxService.getPositions()
      ]);
      setAssets(newAssets);
      setMarketData(newRates);
      setPositions(newPositions);
      const equity = newAssets.reduce((sum, a) => sum + a.equityUsd, 0);
      setTotalEquity(equity);
    } catch (e) {
       console.error(e);
    }
  };

  const strategiesRef = useRef(strategies);
  const positionsRef = useRef(positions);
  const instrumentsRef = useRef(instruments);
  const totalEquityRef = useRef(totalEquity);
  const deepseekKeyRef = useRef(deepseekKey);

  useEffect(() => { strategiesRef.current = strategies; }, [strategies]);
  useEffect(() => { positionsRef.current = positions; }, [positions]);
  useEffect(() => { instrumentsRef.current = instruments; }, [instruments]);
  useEffect(() => { totalEquityRef.current = totalEquity; }, [totalEquity]);
  useEffect(() => { 
    deepseekKeyRef.current = deepseekKey; 
    localStorage.setItem('deepseek_key', deepseekKey);
  }, [deepseekKey]);

  useEffect(() => {
    let timeoutId: any;
    const runLoop = async () => {
      const activeStrats = strategiesRef.current.filter(s => s.isActive);
      for (const strategy of activeStrats) {
        const scanInterval = (strategy.parameters.scanInterval || 60) * 1000;
        const timeSinceLastRun = Date.now() - (strategy.lastRun || 0);
        if (timeSinceLastRun >= scanInterval) {
           await executeMultiAssetStrategy(strategy);
        }
      }
      timeoutId = setTimeout(runLoop, 2000); 
    };

    const executeMultiAssetStrategy = async (strategy: StrategyConfig) => {
        addLog('info', 'STRATEGY', `[引擎轮询] 开始扫描组合目标...`);
        
        const allTickers = await okxService.getMarketTickers();
        const minVol = strategy.parameters.minVolume24h || 10000000;
        const minRate = strategy.parameters.minFundingRate || 0.0003;
        
        const validTickers = allTickers.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && 
            parseFloat(t.volUsdt24h) > minVol
        );

        if (validTickers.length === 0) {
            addLog('warning', 'STRATEGY', '市场流动性不足，未找到满足成交额要求的币种。');
            updateStrategyLastRun(strategy.id);
            return;
        }

        const candidateBatch = validTickers
            .sort((a, b) => parseFloat(b.volUsdt24h) - parseFloat(a.volUsdt24h))
            .slice(0, 30);
        
        const candidateData: TickerData[] = [];
        for (const cand of candidateBatch) {
            const rate = await okxService.getFundingRate(cand.instId);
            if (parseFloat(rate) >= minRate) {
              candidateData.push({ ...cand, fundingRate: rate });
            }
        }

        const targetSet = candidateData
            .sort((a, b) => parseFloat(b.fundingRate) - parseFloat(a.fundingRate))
            .slice(0, 3);

        setMarketData(candidateData); 

        const currentManagedPositions = positionsRef.current.filter(p => parseFloat(p.pos) !== 0);
        const rotationThreshold = strategy.parameters.rotationThreshold || 0.0002;
        const exitThreshold = strategy.parameters.exitThreshold || 0.0001;

        for (const pos of currentManagedPositions) {
            const currentRateStr = await okxService.getFundingRate(pos.instId);
            const currentRate = parseFloat(currentRateStr);
            const instInfo = instrumentsRef.current.find(i => i.instId === pos.instId);
            
            if (currentRate < exitThreshold) {
                addLog('warning', 'STRATEGY', `[退出信号] ${pos.instId} 费率 (${(currentRate*100).toFixed(4)}%) 低于离场阈值。`);
                if (instInfo) await okxService.executeDualSideExit(pos.instId, instInfo, pos.pos);
                continue;
            }

            const potentialReplacement = targetSet.find(t => 
                !currentManagedPositions.some(p => p.instId === t.instId) && 
                (parseFloat(t.fundingRate) - currentRate > rotationThreshold)
            );

            if (potentialReplacement && currentManagedPositions.length >= 3) {
                const lowestRatePos = currentManagedPositions.reduce((prev, curr) => 
                    parseFloat(curr.uplRatio) < parseFloat(prev.uplRatio) ? curr : prev
                );
                
                if (pos.instId === lowestRatePos.instId) {
                   addLog('info', 'STRATEGY', `[轮动触发] 发现高性价比标的 ${potentialReplacement.instId}。替换当前最低收益位 ${pos.instId}。`);
                   if (instInfo) await okxService.executeDualSideExit(pos.instId, instInfo, pos.pos);
                }
            }
        }

        const updatedPositions = await okxService.getPositions();
        const activeCount = updatedPositions.filter(p => parseFloat(p.pos) !== 0).length;

        if (activeCount < 3) {
            const emptySlots = 3 - activeCount;
            const entryList = targetSet.filter(t => !updatedPositions.some(p => p.instId === t.instId));

            for (let i = 0; i < Math.min(emptySlots, entryList.length); i++) {
                const candidate = entryList[i];
                
                if (strategy.parameters.useAI) {
                    const analysis = await analyzeMarketConditions([candidate], strategy.name, deepseekKeyRef.current);
                    setLastAnalysis(analysis);
                    if (analysis.recommendedAction !== 'BUY') {
                        addLog('warning', 'AI', `AI 拒绝入场 ${candidate.instId}: ${analysis.reasoning}`);
                        continue;
                    }
                }

                const allocationPct = strategy.parameters.allocationPct || 30;
                const investAmount = (totalEquityRef.current * (allocationPct / 100)); 
                
                const instrumentInfo = instrumentsRef.current.find(inst => inst.instId === candidate.instId);
                if (instrumentInfo) {
                    addLog('success', 'STRATEGY', `[入场执行] 目标: ${candidate.instId} | 分配本金: $${investAmount.toFixed(2)} | 当前费率: ${(parseFloat(candidate.fundingRate)*100).toFixed(4)}%`);
                    const res = await okxService.executeDualSideEntry(candidate.instId, investAmount, instrumentInfo);
                    if (!res.success) addLog('error', 'STRATEGY', res.message);
                }
            }
        }

        updateStrategyLastRun(strategy.id);
    };

    const updateStrategyLastRun = (id: string) => {
      setStrategies(prev => prev.map(s => s.id === id ? {...s, lastRun: Date.now()} : s));
    };
    runLoop();
    return () => clearTimeout(timeoutId);
  }, []); 

  const toggleStrategy = (id: string) => {
    setStrategies(prev => prev.map(s => s.id === id ? { ...s, isActive: !s.isActive } : s));
  };

  const updateStrategy = (updated: StrategyConfig) => {
    setStrategies(prev => prev.map(s => s.id === updated.id ? updated : s));
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans flex flex-col md:flex-row">
      <AnalysisModal isOpen={isAnalysisModalOpen} onClose={() => setIsAnalysisModalOpen(false)} analysis={lastAnalysis} />
      <aside className="w-full md:w-64 bg-slate-950 border-r border-slate-800 flex flex-col shrink-0">
        <div className="p-6 border-b border-slate-800">
          <div className="flex items-center gap-2 text-emerald-500 font-bold text-xl"><Zap className="fill-current" /> QuantX</div>
        </div>
        <nav className="flex-1 p-4 space-y-2">
          <button onClick={() => setActiveTab('dashboard')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${activeTab === 'dashboard' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-900'}`}><LayoutDashboard className="w-5 h-5" /> 仪表盘</button>
          <button onClick={() => setActiveTab('orders')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${activeTab === 'orders' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-900'}`}><List className="w-5 h-5" /> 交易监控</button>
          <button onClick={() => setActiveTab('strategies')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${activeTab === 'strategies' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-900'}`}><Layers className="w-5 h-5" /> 策略管理</button>
          <button onClick={() => setActiveTab('settings')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${activeTab === 'settings' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-900'}`}><Settings className="w-5 h-5" /> 系统设置</button>
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            <Dashboard assets={assets} strategies={strategies} marketData={marketData} totalEquity={totalEquity} positions={positions} okxConfig={okxConfig} />
            <div className="flex justify-end">
              <button 
                onClick={() => setIsAnalysisModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-bold shadow-lg transition-all"
                disabled={!lastAnalysis}
              >
                <Eye className="w-4 h-4" /> 查看最新 AI 分析
              </button>
            </div>
            <LogsPanel logs={logs} />
          </div>
        )}
        {activeTab === 'orders' && <OrdersPanel />}
        {activeTab === 'strategies' && <StrategyManager strategies={strategies} onToggleStrategy={toggleStrategy} onUpdateStrategy={updateStrategy} />}
        {activeTab === 'settings' && (
          <div className="max-w-2xl space-y-6">
            <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-xl">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                   DeepSeek AI 模型配置
                </h2>
                <span className="bg-blue-600/20 text-blue-400 text-[10px] px-2 py-0.5 rounded border border-blue-500/30 uppercase font-bold">DeepSeek-V3</span>
              </div>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                    <Lock className="w-3 h-3" /> API 密钥 (API Key)
                  </label>
                  <input 
                    type="password" 
                    placeholder="sk-..." 
                    value={deepseekKey} 
                    onChange={(e) => setDeepseekKey(e.target.value)} 
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white focus:outline-none focus:border-blue-500 transition-colors shadow-inner font-mono text-sm" 
                  />
                  <p className="mt-2 text-[10px] text-slate-500 leading-relaxed italic">
                    注意：API 密钥仅存储在您的浏览器本地存储 (LocalStorage) 中。系统绝不会将该密钥上传至除 DeepSeek 官方 API 接口以外的任何位置。
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-xl">
              <h2 className="text-xl font-bold text-white mb-6">OKX V5 交易所连接</h2>
              <div className="flex items-center gap-3 mb-6 bg-slate-900/50 p-3 rounded-lg border border-slate-700/50">
                <input 
                  type="checkbox" 
                  id="sim-mode"
                  checked={okxConfig.isSimulated} 
                  onChange={(e) => setOkxConfig({...okxConfig, isSimulated: e.target.checked})} 
                  className="w-4 h-4 rounded border-slate-700 bg-slate-950 text-blue-600 focus:ring-blue-600"
                />
                <label htmlFor="sim-mode" className="text-sm text-slate-300 font-medium">启用模拟盘 (Simulation Mode)</label>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">API Key</label>
                  <input type="text" placeholder="Enter OKX API Key" value={okxConfig.apiKey} onChange={(e) => setOkxConfig({...okxConfig, apiKey: e.target.value})} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white focus:outline-none focus:border-blue-500 transition-colors font-mono text-sm" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Secret Key</label>
                  <input type="password" placeholder="Enter OKX Secret Key" value={okxConfig.secretKey} onChange={(e) => setOkxConfig({...okxConfig, secretKey: e.target.value})} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white focus:outline-none focus:border-blue-500 transition-colors font-mono text-sm" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Passphrase</label>
                  <input type="password" placeholder="Enter OKX Passphrase" value={okxConfig.passphrase} onChange={(e) => setOkxConfig({...okxConfig, passphrase: e.target.value})} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white focus:outline-none focus:border-blue-500 transition-colors font-mono text-sm" />
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;