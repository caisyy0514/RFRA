import React, { useState, useEffect, useRef } from 'react';
import { LayoutDashboard, Settings, Layers, Zap, PlayCircle, List, Eye } from 'lucide-react';
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

  useEffect(() => { strategiesRef.current = strategies; }, [strategies]);
  useEffect(() => { positionsRef.current = positions; }, [positions]);
  useEffect(() => { instrumentsRef.current = instruments; }, [instruments]);
  useEffect(() => { totalEquityRef.current = totalEquity; }, [totalEquity]);

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
                    const analysis = await analyzeMarketConditions([candidate], strategy.name);
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
            <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-4">DeepSeek AI 模型配置</h2>
              <div className="p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-lg">
                <p className="text-sm text-indigo-200">
                  系统当前由 <strong>DeepSeek-V3</strong> 驱动。API 密钥已通过系统环境变量安全配置。
                </p>
              </div>
            </div>
            <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-4">OKX V5 配置</h2>
              <div className="flex items-center gap-2 mb-4"><input type="checkbox" checked={okxConfig.isSimulated} onChange={(e) => setOkxConfig({...okxConfig, isSimulated: e.target.checked})} /><label className="text-sm text-white">启用模拟盘</label></div>
              <div className="space-y-4">
                <input type="text" placeholder="API Key" value={okxConfig.apiKey} onChange={(e) => setOkxConfig({...okxConfig, apiKey: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white" />
                <input type="password" placeholder="Secret Key" value={okxConfig.secretKey} onChange={(e) => setOkxConfig({...okxConfig, secretKey: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white" />
                <input type="password" placeholder="Passphrase" value={okxConfig.passphrase} onChange={(e) => setOkxConfig({...okxConfig, passphrase: e.target.value})} className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white" />
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;