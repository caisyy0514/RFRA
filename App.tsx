
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
  
  const [deepseekKey, setDeepseekKey] = useState('');
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
  const deepseekKeyRef = useRef(deepseekKey);
  const totalEquityRef = useRef(totalEquity);

  useEffect(() => { strategiesRef.current = strategies; }, [strategies]);
  useEffect(() => { positionsRef.current = positions; }, [positions]);
  useEffect(() => { instrumentsRef.current = instruments; }, [instruments]);
  useEffect(() => { deepseekKeyRef.current = deepseekKey; }, [deepseekKey]);
  useEffect(() => { totalEquityRef.current = totalEquity; }, [totalEquity]);

  useEffect(() => {
    let timeoutId: any;
    const runLoop = async () => {
      const activeStrats = strategiesRef.current.filter(s => s.isActive);
      for (const strategy of activeStrats) {
        const scanInterval = (strategy.parameters.scanInterval || 60) * 1000;
        const timeSinceLastRun = Date.now() - (strategy.lastRun || 0);
        if (timeSinceLastRun >= scanInterval) {
           await executeOptimizedStrategy(strategy);
        }
      }
      timeoutId = setTimeout(runLoop, 1000); 
    };

    const executeOptimizedStrategy = async (strategy: StrategyConfig) => {
        addLog('info', 'STRATEGY', `[Cycle Start] 执行策略: ${strategy.name}`);
        addLog('info', 'STRATEGY', '正在扫描全市场合约及资金费率...');
        
        const allTickers = await okxService.getMarketTickers();
        const minVol = strategy.parameters.minVolume24h || 10000000;
        // CRITICAL FIX: Use volUsdt24h (calculated USDT turnover) for filtering
        const liquidTickers = allTickers.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && 
            parseFloat(t.volUsdt24h) > minVol
        );

        if (liquidTickers.length === 0) {
            addLog('warning', 'STRATEGY', '市场流动性不足，未找到满足成交额要求的币种。');
            updateStrategyLastRun(strategy.id);
            return;
        }

        const candidatesToCheck = liquidTickers
            .sort((a, b) => parseFloat(b.volUsdt24h) - parseFloat(a.volUsdt24h))
            .slice(0, 30);
        
        const candidatesWithRates: TickerData[] = [];
        for (const cand of candidatesToCheck) {
            const rate = await okxService.getFundingRate(cand.instId);
            candidatesWithRates.push({ ...cand, fundingRate: rate });
        }

        setMarketData(candidatesWithRates);

        const sortedCandidates = candidatesWithRates
            .filter(c => parseFloat(c.fundingRate) > 0)
            .sort((a, b) => parseFloat(b.fundingRate) - parseFloat(a.fundingRate));

        const topCandidate = sortedCandidates[0]; 
        const minRateThreshold = strategy.parameters.minFundingRate || 0.0003;

        if (!topCandidate || parseFloat(topCandidate.fundingRate) < minRateThreshold) {
             addLog('info', 'STRATEGY', `当前市场无高收益机会 (Max: ${topCandidate?.fundingRate || 0})`);
        } else {
             addLog('success', 'STRATEGY', `发现最佳标的: ${topCandidate.instId} (Rate: ${(parseFloat(topCandidate.fundingRate)*100).toFixed(4)}%)`);
        }

        const currentPositions = positionsRef.current;
        const currentHolding = currentPositions.find(p => parseInt(p.pos) !== 0);

        if (currentHolding) {
            const holdingRate = await okxService.getFundingRate(currentHolding.instId);
            const exitThreshold = strategy.parameters.exitThreshold || 0.0001;
            const rotationThreshold = strategy.parameters.rotationThreshold || 0.0002;

            if (parseFloat(holdingRate) < exitThreshold) {
                addLog('warning', 'STRATEGY', `[EXIT] 持仓 ${currentHolding.instId} 费率过低 (${holdingRate})。`);
                const instInfo = instrumentsRef.current.find(i => i.instId === currentHolding.instId);
                if (instInfo) await okxService.executeDualSideExit(currentHolding.instId, instInfo, currentHolding.pos);
                updateStrategyLastRun(strategy.id);
                return;
            }

            if (topCandidate && topCandidate.instId !== currentHolding.instId) {
                const rateDiff = parseFloat(topCandidate.fundingRate) - parseFloat(holdingRate);
                if (rateDiff > rotationThreshold) {
                    addLog('info', 'STRATEGY', `[ROTATION] 切换至 ${topCandidate.instId}。费率差: ${rateDiff.toFixed(5)}。`);
                    const instInfo = instrumentsRef.current.find(i => i.instId === currentHolding.instId);
                    if (instInfo) {
                        const exitRes = await okxService.executeDualSideExit(currentHolding.instId, instInfo, currentHolding.pos);
                        if (exitRes.success) {
                            addLog('success', 'STRATEGY', '旧仓位已平，准备切换。');
                        }
                    }
                    updateStrategyLastRun(strategy.id);
                    return;
                }
            }
        }

        if (!currentHolding && positionsRef.current.length === 0 && topCandidate && parseFloat(topCandidate.fundingRate) >= minRateThreshold) {
            if (strategy.parameters.useAI) {
                // Pass candidates with calculated USDT volume to DeepSeek
                const analysis = await analyzeMarketConditions([topCandidate], strategy.name, deepseekKeyRef.current);
                setLastAnalysis(analysis);
                if (analysis.recommendedAction === 'WAIT' || analysis.recommendedAction === 'SELL') {
                    addLog('warning', 'AI', `AI 建议观望 ${topCandidate.instId}: ${analysis.reasoning}`);
                    updateStrategyLastRun(strategy.id);
                    return;
                }
            }
            const allocationPct = strategy.parameters.allocationPct || 50;
            const investAmount = (totalEquityRef.current * (allocationPct / 100)); 
            const instrumentInfo = instrumentsRef.current.find(i => i.instId === topCandidate.instId);
            if (!instrumentInfo) {
                addLog('error', 'STRATEGY', `元数据缺失: ${topCandidate.instId}`);
                return;
            }
            const res = await okxService.executeDualSideEntry(topCandidate.instId, investAmount, instrumentInfo);
            if (res.success) addLog('success', 'STRATEGY', res.message);
            else addLog('error', 'STRATEGY', res.message);
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
            <LogsPanel logs={logs} />
          </div>
        )}
        {activeTab === 'orders' && <OrdersPanel />}
        {activeTab === 'strategies' && <StrategyManager strategies={strategies} onToggleStrategy={toggleStrategy} onUpdateStrategy={updateStrategy} />}
        {activeTab === 'settings' && (
          <div className="max-w-2xl space-y-6">
            <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-4">DeepSeek AI 模型配置</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-slate-400 mb-1">DeepSeek API Key</label>
                  <input 
                    type="password" 
                    value={deepseekKey}
                    onChange={(e) => setDeepseekKey(e.target.value)}
                    placeholder="输入您的 DeepSeek API Key (sk-...)"
                    className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white focus:border-blue-500 focus:outline-none"
                  />
                  <p className="text-xs text-slate-500 mt-1">用于市场情绪分析与风控。Key 仅保存在本地浏览器中。</p>
                </div>
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
