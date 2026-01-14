import React, { useState, useEffect, useRef } from 'react';
import { LayoutDashboard, Settings, Layers, Zap, PlayCircle, List } from 'lucide-react';
import { okxService } from './services/okxService';
import { analyzeMarketConditions } from './services/deepseekService';
import Dashboard from './components/Dashboard';
import StrategyManager from './components/StrategyManager';
import LogsPanel from './components/LogsPanel';
import OrdersPanel from './components/OrdersPanel';
import { Asset, TickerData, StrategyConfig, LogEntry, OKXConfig, AIAnalysisResult, Position } from './types';
import { DEFAULT_STRATEGIES, MOCK_LOGS_INIT } from './constants';

const App: React.FC = () => {
  // Navigation State
  const [activeTab, setActiveTab] = useState<'dashboard' | 'strategies' | 'orders' | 'settings'>('dashboard');

  // Data State
  const [assets, setAssets] = useState<Asset[]>([]);
  const [marketData, setMarketData] = useState<TickerData[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [totalEquity, setTotalEquity] = useState<number>(0);
  const [strategies, setStrategies] = useState<StrategyConfig[]>(DEFAULT_STRATEGIES);
  const [logs, setLogs] = useState<LogEntry[]>(MOCK_LOGS_INIT);
  const [lastAnalysis, setLastAnalysis] = useState<AIAnalysisResult | null>(null);

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

  // Initialization
  useEffect(() => {
    okxService.setConfig(okxConfig);
    
    // Initial fetch
    fetchData();
    const interval = setInterval(fetchData, 5000); // 5s refresh
    return () => clearInterval(interval);
  }, [okxConfig]);

  const fetchData = async () => {
    try {
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
       // Silent fail for mock
    }
  };

  // Main Strategy Loop with dynamic interval
  const strategiesRef = useRef(strategies);
  const marketDataRef = useRef(marketData);
  const deepseekKeyRef = useRef(deepseekKey);

  // Sync refs for the loop
  useEffect(() => { strategiesRef.current = strategies; }, [strategies]);
  useEffect(() => { marketDataRef.current = marketData; }, [marketData]);
  useEffect(() => { deepseekKeyRef.current = deepseekKey; }, [deepseekKey]);

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const runLoop = async () => {
      // Run frequently to check if any strategy needs execution
      const activeStrats = strategiesRef.current.filter(s => s.isActive);
      
      for (const strategy of activeStrats) {
        const scanInterval = (strategy.parameters.scanIntervalEmpty || 60) * 1000;
        const timeSinceLastRun = Date.now() - (strategy.lastRun || 0);

        if (timeSinceLastRun >= scanInterval) {
           await executeStrategy(strategy);
        }
      }

      timeoutId = setTimeout(runLoop, 1000); // Check every second
    };

    const executeStrategy = async (strategy: StrategyConfig) => {
        addLog('info', 'STRATEGY', `正在评估策略: ${strategy.name}...`);
        
        // 1. AI Analysis Step
        if (strategy.parameters.useAI) {
           addLog('info', 'AI', '正在请求 DeepSeek 进行市场分析...');
           const analysis = await analyzeMarketConditions(marketDataRef.current, strategy.name, deepseekKeyRef.current);
           setLastAnalysis(analysis);
           
           if (analysis.recommendedAction === 'ERROR') {
              addLog('error', 'AI', analysis.reasoning);
           } else {
              addLog('success', 'AI', `分析完成. 建议: ${analysis.recommendedAction}. 理由: ${analysis.reasoning.substring(0, 30)}...`);
           }

           if(analysis.riskScore > 80) {
             addLog('warning', 'STRATEGY', `检测到高风险 (${analysis.riskScore}). 跳过执行.`);
             updateStrategyLastRun(strategy.id);
             return;
           }
        }

        // 2. Execution Logic (Simulation)
        if (Math.random() > 0.8) {
           await okxService.placeOrder('BTC-USDT', 'buy', '0.01');
           addLog('success', 'OKX', '再平衡订单已提交 (模拟).');
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
                <div className="flex items-center gap-4 bg-indigo-900/30 px-4 py-2 rounded-lg border border-indigo-500/30">
                  <span className="text-xs text-indigo-300 uppercase font-bold">最新 AI 观点</span>
                  <span className="text-sm text-white font-medium">{lastAnalysis.recommendedAction}</span>
                </div>
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
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;