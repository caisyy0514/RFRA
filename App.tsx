
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
  // Navigation State
  const [activeTab, setActiveTab] = useState<'dashboard' | 'strategies' | 'orders' | 'settings'>('dashboard');

  // Data State
  const [assets, setAssets] = useState<Asset[]>([]);
  const [marketData, setMarketData] = useState<TickerData[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [instruments, setInstruments] = useState<Instrument[]>([]); 
  const [totalEquity, setTotalEquity] = useState<number>(0);
  const [strategies, setStrategies] = useState<StrategyConfig[]>(DEFAULT_STRATEGIES);
  const [logs, setLogs] = useState<LogEntry[]>(MOCK_LOGS_INIT);
  const [lastAnalysis, setLastAnalysis] = useState<AIAnalysisResult | null>(null);
  
  // UI State
  const [isAnalysisModalOpen, setIsAnalysisModalOpen] = useState(false);

  // Configuration State
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

  // Initialization & Risk Checks
  useEffect(() => {
    okxService.setConfig(okxConfig);
    
    const init = async () => {
        if (okxConfig.apiKey) {
            // 1. Account Config Check
            const isConfigValid = await okxService.checkAccountConfiguration();
            if (!isConfigValid) {
                addLog('error', 'SYSTEM', '账户风险警告：请确保 OKX 账户处于“单币种保证金”或“跨币种保证金”模式，否则无法利用现货抵押空单！');
            } else {
                addLog('info', 'SYSTEM', '账户模式检查通过 (Single/Multi Currency Margin)。');
            }

            // 2. Fetch Instruments
            okxService.getInstruments('SWAP').then(setInstruments).catch(console.error);
            
            // 3. Initial Data
            fetchData();
        }
    };
    
    init();
    
    const interval = setInterval(fetchData, 5000); 
    return () => clearInterval(interval);
  }, [okxConfig]);

  const fetchData = async () => {
    try {
      if (!okxConfig.apiKey) return;

      const [newAssets, newRates, newPositions] = await Promise.all([
        okxService.getAccountAssets(),
        okxService.getFundingRates(), // Keep fetching watchlist for dashboard visualization
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

  // Main Strategy Loop references
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
    let timeoutId: NodeJS.Timeout;

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

    /**
     * CORE STRATEGY ENGINE
     * Implements: Scanner -> Monitor -> Rotation -> Execution
     */
    const executeOptimizedStrategy = async (strategy: StrategyConfig) => {
        addLog('info', 'STRATEGY', `[Cycle Start] 执行策略: ${strategy.name}`);
        
        // --- Phase 1: Scanner (全市场扫描) ---
        addLog('info', 'STRATEGY', '正在扫描全市场合约及资金费率...');
        
        // 1. Get All Tickers to filter by Volume
        const allTickers = await okxService.getMarketTickers();
        const minVol = strategy.parameters.minVolume24h || 10000000;
        
        // 2. Filter High Liquidity
        const liquidTickers = allTickers.filter(t => 
            t.instId.endsWith('-USDT-SWAP') && 
            parseFloat(t.volCcy24h) > minVol
        );

        if (liquidTickers.length === 0) {
            addLog('warning', 'STRATEGY', '市场流动性不足，未找到满足成交量要求的币种。');
            updateStrategyLastRun(strategy.id);
            return;
        }

        // 3. Batch Fetch Funding Rates for Top Candidates (Limit to top 30 by Vol to save API)
        // In production, we might use a dedicated monitor service.
        const candidatesToCheck = liquidTickers
            .sort((a, b) => parseFloat(b.volCcy24h) - parseFloat(a.volCcy24h))
            .slice(0, 30);
        
        const candidatesWithRates = [];
        for (const cand of candidatesToCheck) {
            const rate = await okxService.getFundingRate(cand.instId);
            if (parseFloat(rate) > 0) { // Only care about positive rates
                candidatesWithRates.push({ ...cand, fundingRate: rate });
            }
        }

        // 4. Sort by Funding Rate (High to Low)
        const sortedCandidates = candidatesWithRates
            .sort((a, b) => parseFloat(b.fundingRate) - parseFloat(a.fundingRate));

        const topCandidate = sortedCandidates[0]; // The King
        const minRateThreshold = strategy.parameters.minFundingRate || 0.0003;

        if (!topCandidate || parseFloat(topCandidate.fundingRate) < minRateThreshold) {
             addLog('info', 'STRATEGY', `当前市场无高收益机会 (Max: ${topCandidate?.fundingRate || 0} < Threshold: ${minRateThreshold})`);
             // Continue to Monitor phase anyway to check if we need to close existing bad positions
        } else {
             addLog('success', 'STRATEGY', `发现最佳标的: ${topCandidate.instId} (Rate: ${(parseFloat(topCandidate.fundingRate)*100).toFixed(4)}%, Vol: ${(parseFloat(topCandidate.volCcy24h)/1000000).toFixed(1)}M)`);
        }

        // --- Phase 2: Monitor & Rotation (监控与轮动) ---
        const currentPositions = positionsRef.current;
        const currentHolding = currentPositions.find(p => parseInt(p.pos) !== 0); // Assuming 1 active arb pair for simplicity

        // A. Check Exit / Rotation Conditions
        if (currentHolding) {
            const holdingRate = await okxService.getFundingRate(currentHolding.instId);
            const exitThreshold = strategy.parameters.exitThreshold || 0.0001;
            const rotationThreshold = strategy.parameters.rotationThreshold || 0.0002;

            // Condition 1: Rate turned bad (Absolute Exit)
            if (parseFloat(holdingRate) < exitThreshold) {
                addLog('warning', 'STRATEGY', `[EXIT] 持仓 ${currentHolding.instId} 费率恶化 (${holdingRate} < ${exitThreshold})。执行清仓。`);
                const instInfo = instrumentsRef.current.find(i => i.instId === currentHolding.instId);
                if (instInfo) await okxService.executeDualSideExit(currentHolding.instId, instInfo, currentHolding.pos);
                updateStrategyLastRun(strategy.id);
                return; // End cycle, wait for next to enter new
            }

            // Condition 2: Better opportunity found (Rotation)
            if (topCandidate && topCandidate.instId !== currentHolding.instId) {
                const rateDiff = parseFloat(topCandidate.fundingRate) - parseFloat(holdingRate);
                if (rateDiff > rotationThreshold) {
                    addLog('info', 'STRATEGY', `[ROTATION] 发现更优标的。${topCandidate.instId} (${topCandidate.fundingRate}) 比 ${currentHolding.instId} (${holdingRate}) 高出 ${rateDiff.toFixed(5)}。执行轮动。`);
                    const instInfo = instrumentsRef.current.find(i => i.instId === currentHolding.instId);
                    if (instInfo) {
                        const exitRes = await okxService.executeDualSideExit(currentHolding.instId, instInfo, currentHolding.pos);
                        if (exitRes.success) {
                            addLog('success', 'STRATEGY', '旧仓位已平，准备在新一轮循环中建仓新币种。');
                        }
                    }
                    updateStrategyLastRun(strategy.id);
                    return;
                }
            }
            
            addLog('info', 'STRATEGY', `持仓 ${currentHolding.instId} 状态良好 (Rate: ${holdingRate})。继续持有。`);
        }

        // --- Phase 3: Entry (建仓) ---
        // Only enter if we have no positions (or just closed them) and a good candidate exists
        if (!currentHolding && positionsRef.current.length === 0 && topCandidate && parseFloat(topCandidate.fundingRate) >= minRateThreshold) {
            
            // AI Check (Sentiment Filter)
            if (strategy.parameters.useAI) {
                const analysis = await analyzeMarketConditions([topCandidate], strategy.name, deepseekKeyRef.current);
                setLastAnalysis(analysis);
                if (analysis.recommendedAction === 'WAIT' || analysis.recommendedAction === 'SELL') {
                    addLog('warning', 'AI', `AI 建议观望 ${topCandidate.instId} (${analysis.reasoning})。暂停建仓。`);
                    updateStrategyLastRun(strategy.id);
                    return;
                }
            }

            const allocationPct = strategy.parameters.allocationPct || 50;
            const totalEq = totalEquityRef.current;
            const investAmount = (totalEq * (allocationPct / 100)); // Total USD for this pair (Spot + Margin)
            
            // For Cash & Carry: We buy Spot with 50% of allocation, hold Short with collateral
            // Actually, usually we use ~95% of equity to buy Spot, and use that spot as collateral to short 1x.
            // Let's assume we use 'investAmount' to Buy Spot.
            
            const instrumentInfo = instrumentsRef.current.find(i => i.instId === topCandidate.instId);
            if (!instrumentInfo) {
                addLog('error', 'STRATEGY', `无法获取 ${topCandidate.instId} 元数据。`);
                return;
            }

            addLog('info', 'STRATEGY', `[ENTRY] 准备建仓 ${topCandidate.instId}。金额: $${investAmount.toFixed(0)}`);
            const res = await okxService.executeDualSideEntry(topCandidate.instId, investAmount, instrumentInfo);
            
            if (res.success) {
                addLog('success', 'STRATEGY', res.message);
            } else {
                addLog('error', 'STRATEGY', res.message);
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
    setStrategies(prev => prev.map(s => 
      s.id === id ? { ...s, isActive: !s.isActive } : s
    ));
    const s = strategies.find(x => x.id === id);
    addLog('info', 'SYSTEM', `策略 ${s?.name} ${!s?.isActive ? '已启动' : '已停止'}`);
  };

  const updateStrategy = (updated: StrategyConfig) => {
    setStrategies(prev => prev.map(s => s.id === updated.id ? updated : s));
    addLog('info', 'SYSTEM', `策略 ${updated.name} 配置已更新.`);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans flex flex-col md:flex-row">
      <AnalysisModal 
        isOpen={isAnalysisModalOpen} 
        onClose={() => setIsAnalysisModalOpen(false)} 
        analysis={lastAnalysis} 
      />

      {/* Sidebar */}
      <aside className="w-full md:w-64 bg-slate-950 border-r border-slate-800 flex flex-col shrink-0">
        <div className="p-6 border-b border-slate-800">
          <div className="flex items-center gap-2 text-emerald-500 font-bold text-xl">
             <Zap className="fill-current" /> QuantX
          </div>
          <div className="text-xs text-slate-500 mt-1">AI 驱动量化交易</div>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          <button 
            onClick={() => setActiveTab('dashboard')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${activeTab === 'dashboard' ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50' : 'text-slate-400 hover:bg-slate-900'}`}
          >
            <LayoutDashboard className="w-5 h-5" /> 仪表盘
          </button>
          <button 
            onClick={() => setActiveTab('orders')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${activeTab === 'orders' ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50' : 'text-slate-400 hover:bg-slate-900'}`}
          >
            <List className="w-5 h-5" /> 交易监控
          </button>
          <button 
            onClick={() => setActiveTab('strategies')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${activeTab === 'strategies' ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50' : 'text-slate-400 hover:bg-slate-900'}`}
          >
            <Layers className="w-5 h-5" /> 策略管理
          </button>
          <button 
            onClick={() => setActiveTab('settings')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${activeTab === 'settings' ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50' : 'text-slate-400 hover:bg-slate-900'}`}
          >
            <Settings className="w-5 h-5" /> 系统设置
          </button>
        </nav>

        {/* Status Indicator */}
        <div className="p-4 bg-slate-900/50 border-t border-slate-800">
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className={`w-2 h-2 rounded-full ${okxConfig.isSimulated ? 'bg-yellow-500' : 'bg-emerald-500'}`}></span>
            {okxConfig.isSimulated ? '模拟模式 (Simulation)' : '实盘模式 (Live)'}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            <header className="flex justify-between items-center mb-8">
              <h1 className="text-2xl font-bold text-white">市场总览</h1>
              {lastAnalysis && (
                <button 
                  onClick={() => setIsAnalysisModalOpen(true)}
                  className="flex items-center gap-4 bg-indigo-900/30 px-4 py-2 rounded-lg border border-indigo-500/30 hover:bg-indigo-900/50 hover:border-indigo-500/50 transition-all cursor-pointer group"
                >
                  <div className="flex flex-col items-end">
                    <span className="text-xs text-indigo-300 uppercase font-bold flex items-center gap-1">
                      最新 AI 观点 <Eye className="w-3 h-3 group-hover:text-white" />
                    </span>
                    <span className={`text-sm font-bold ${lastAnalysis.recommendedAction === 'BUY' ? 'text-emerald-400' : lastAnalysis.recommendedAction === 'SELL' ? 'text-red-400' : 'text-white'}`}>
                      {lastAnalysis.recommendedAction} (Risk: {lastAnalysis.riskScore})
                    </span>
                  </div>
                </button>
              )}
            </header>
            <Dashboard 
              assets={assets}
              strategies={strategies}
              marketData={marketData}
              totalEquity={totalEquity}
              positions={positions}
              okxConfig={okxConfig}
            />
            <LogsPanel logs={logs} />
          </div>
        )}

        {activeTab === 'orders' && (
          <div className="space-y-6">
            <header className="mb-8">
              <h1 className="text-2xl font-bold text-white">交易执行监控</h1>
              <p className="text-slate-400">查看当前挂单及历史成交记录。</p>
            </header>
            <OrdersPanel />
          </div>
        )}

        {activeTab === 'strategies' && (
          <div className="space-y-6">
            <header className="mb-8">
              <h1 className="text-2xl font-bold text-white">策略配置</h1>
              <p className="text-slate-400">管理交易机器人及运行参数。</p>
            </header>
            <StrategyManager 
              strategies={strategies}
              onToggleStrategy={toggleStrategy}
              onUpdateStrategy={updateStrategy}
            />
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="max-w-2xl space-y-6">
            <header className="mb-8">
              <h1 className="text-2xl font-bold text-white">系统设置</h1>
            </header>
            
            <div className="bg-slate-800 p-6 rounded-xl border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <Zap className="w-5 h-5 text-yellow-400" /> AI 模型配置 (DeepSeek)
              </h2>
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
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <PlayCircle className="w-5 h-5 text-blue-400" /> 交易所配置 (OKX V5)
              </h2>
              <div className="space-y-4">
                 <div className="flex items-center gap-2 mb-4">
                    <input 
                      type="checkbox" 
                      checked={okxConfig.isSimulated}
                      onChange={(e) => setOkxConfig({...okxConfig, isSimulated: e.target.checked})}
                      className="w-4 h-4 rounded bg-slate-900 border-slate-700"
                    />
                    <label className="text-sm text-white">启用模拟盘 / Paper Trading 模式</label>
                 </div>
                 
                 <div className={`${okxConfig.isSimulated ? 'opacity-50 pointer-events-none' : ''} space-y-4 transition-opacity`}>
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">API Key</label>
                      <input 
                        type="text" 
                        value={okxConfig.apiKey}
                        onChange={(e) => setOkxConfig({...okxConfig, apiKey: e.target.value})}
                        className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Secret Key</label>
                      <input 
                        type="password" 
                        value={okxConfig.secretKey}
                        onChange={(e) => setOkxConfig({...okxConfig, secretKey: e.target.value})}
                        className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                     <div>
                      <label className="block text-sm text-slate-400 mb-1">Passphrase</label>
                      <input 
                        type="password" 
                        value={okxConfig.passphrase}
                        onChange={(e) => setOkxConfig({...okxConfig, passphrase: e.target.value})}
                        className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-white focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                 </div>
                 <div className="bg-slate-900/50 p-3 rounded text-xs text-slate-400">
                    注意：若启用模拟盘模式，请确保使用 OKX 模拟盘专用的 API Key，否则可能会出现 "Invalid API Key" 错误。
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
