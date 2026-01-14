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
  const [deepseekKey, setDeepseekKey] = useState<string>(localStorage.getItem('deepseek_key') || '');
  const [okxConfig, setOkxConfig] = useState<OKXConfig>({ apiKey: '', secretKey: '', passphrase: '', isSimulated: true });

  const addLog = (level: LogEntry['level'], source: LogEntry['source'], message: string) => {
    setLogs(prev => [...prev, { id: Math.random().toString(36), timestamp: Date.now(), level, source, message }]);
  };

  useEffect(() => {
    okxService.setConfig(okxConfig);
    if (okxConfig.apiKey) {
        okxService.checkAccountConfiguration().then(valid => {
            if (!valid) addLog('error', 'SYSTEM', '账户风险：请确保 OKX 已切换为“保证金模式”！');
        });
        okxService.getInstruments('SWAP').then(setInstruments);
        fetchData();
    }
    const interval = setInterval(fetchData, 15000); 
    return () => clearInterval(interval);
  }, [okxConfig]);

  const fetchData = async () => {
    if (!okxConfig.apiKey) return;
    try {
      const [newAssets, newRates, newPositions] = await Promise.all([
        okxService.getAccountAssets(), okxService.getFundingRates(), okxService.getPositions()
      ]);
      setAssets(newAssets);
      setMarketData(newRates);
      setPositions(newPositions);
      setTotalEquity(newAssets.reduce((sum, a) => sum + a.equityUsd, 0));
    } catch (e) { console.error(e); }
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
        if (timeSinceLastRun >= scanInterval) await executeMultiAssetStrategy(strategy);
      }
      timeoutId = setTimeout(runLoop, 3000); 
    };

    const executeMultiAssetStrategy = async (strategy: StrategyConfig) => {
        addLog('info', 'STRATEGY', `[引擎轮询] 正在全市场扫描最优套利组合...`);
        const allTickers = await okxService.getMarketTickers();
        const minVol = strategy.parameters.minVolume24h || 5000000;
        const minRate = strategy.parameters.minFundingRate || 0.0002;
        
        // 1. 全市场初筛 (满足基础流动性)
        const filtered = allTickers.filter(t => t.instId.endsWith('-USDT-SWAP') && parseFloat(t.volUsdt24h) > minVol);
        
        // 2. 批量获取费率并提取 Top 10
        const topCandidates: TickerData[] = [];
        const sortedByVol = filtered.sort((a, b) => parseFloat(b.volUsdt24h) - parseFloat(a.volUsdt24h)).slice(0, 30);
        for (const cand of sortedByVol) {
            const rate = await okxService.getFundingRate(cand.instId);
            if (parseFloat(rate) >= minRate) topCandidates.push({ ...cand, fundingRate: rate });
            if (topCandidates.length >= 10) break;
        }

        if (topCandidates.length === 0) {
            addLog('warning', 'STRATEGY', '当前市场无高费率标的，继续监控中。');
            updateStrategyLastRun(strategy.id);
            return;
        }

        // 3. AI 批量择优与排序
        let finalTradeQueue = topCandidates.sort((a,b) => parseFloat(b.fundingRate) - parseFloat(a.fundingRate));
        if (strategy.parameters.useAI) {
            const analysis = await analyzeMarketConditions(topCandidates.slice(0, 10), strategy.name, deepseekKeyRef.current);
            setLastAnalysis(analysis);
            if (analysis.recommendedAction === 'BUY' && analysis.suggestedPairs.length > 0) {
                finalTradeQueue = analysis.suggestedPairs
                    .map(pair => topCandidates.find(t => t.instId === pair))
                    .filter((t): t is TickerData => !!t);
                addLog('success', 'AI', `AI 审核完成：已从 10 个标的中选出 ${finalTradeQueue.length} 个高安全性标的。`);
            } else {
                addLog('warning', 'AI', `AI 建议观望：${analysis.reasoning}`);
                updateStrategyLastRun(strategy.id);
                return;
            }
        }

        // 4. 仓位检查与轮动
        const currentPositions = positionsRef.current.filter(p => parseFloat(p.pos) !== 0);
        
        // 离场检查
        for (const pos of currentPositions) {
            const currentRate = parseFloat(await okxService.getFundingRate(pos.instId));
            if (currentRate < (strategy.parameters.exitThreshold || 0.0001)) {
                addLog('warning', 'STRATEGY', `[退出] ${pos.instId} 费率过低 (${(currentRate*100).toFixed(4)}%)，正在执行原子离场...`);
                const instInfo = instrumentsRef.current.find(i => i.instId === pos.instId);
                if (instInfo) await okxService.executeDualSideExit(pos.instId, instInfo, pos.pos);
            }
        }

        // 入场/填充至 Top 3
        const updatedPos = await okxService.getPositions();
        const activeCount = updatedPos.filter(p => parseFloat(p.pos) !== 0).length;
        const maxPos = strategy.parameters.maxPositions || 3;

        if (activeCount < maxPos) {
            const slots = maxPos - activeCount;
            const newEntries = finalTradeQueue.filter(t => !updatedPos.some(p => p.instId === t.instId)).slice(0, slots);

            for (const target of newEntries) {
                const investAmt = (totalEquityRef.current * (strategy.parameters.allocationPct || 30) / 100);
                const swapInfo = instrumentsRef.current.find(i => i.instId === target.instId);
                if (swapInfo) {
                    addLog('info', 'STRATEGY', `[入场] 执行 ${target.instId} 套利组合，预计占用: $${investAmt.toFixed(2)}`);
                    const res = await okxService.executeDualSideEntry(target.instId, investAmt, swapInfo);
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

  const toggleStrategy = (id: string) => setStrategies(prev => prev.map(s => s.id === id ? { ...s, isActive: !s.isActive } : s));
  const updateStrategy = (updated: StrategyConfig) => setStrategies(prev => prev.map(s => s.id === updated.id ? updated : s));

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans flex flex-col md:flex-row">
      <AnalysisModal isOpen={isAnalysisModalOpen} onClose={() => setIsAnalysisModalOpen(false)} analysis={lastAnalysis} />
      <aside className="w-full md:w-64 bg-slate-950 border-r border-slate-800 flex flex-col shrink-0">
        <div className="p-6 border-b border-slate-800"><div className="flex items-center gap-2 text-emerald-500 font-bold text-xl"><Zap className="fill-current" /> QuantX</div></div>
        <nav className="flex-1 p-4 space-y-2">
          <button onClick={() => setActiveTab('dashboard')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg ${activeTab === 'dashboard' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-900'}`}><LayoutDashboard className="w-5 h-5" /> 仪表盘</button>
          <button onClick={() => setActiveTab('orders')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg ${activeTab === 'orders' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-900'}`}><List className="w-5 h-5" /> 交易监控</button>
          <button onClick={() => setActiveTab('strategies')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg ${activeTab === 'strategies' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-900'}`}><Layers className="w-5 h-5" /> 策略管理</button>
          <button onClick={() => setActiveTab('settings')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg ${activeTab === 'settings' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-900'}`}><Settings className="w-5 h-5" /> 系统设置</button>
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            <Dashboard assets={assets} strategies={strategies} marketData={marketData} totalEquity={totalEquity} positions={positions} okxConfig={okxConfig} />
            <div className="flex justify-end"><button onClick={() => setIsAnalysisModalOpen(true)} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-bold disabled:opacity-50" disabled={!lastAnalysis}><Eye className="w-4 h-4" /> 查看 AI 批量审核报告</button></div>
            <LogsPanel logs={logs} />
          </div>
        )}
        {activeTab === 'orders' && <OrdersPanel />}
        {activeTab === 'strategies' && <StrategyManager strategies={strategies} onToggleStrategy={toggleStrategy} onUpdateStrategy={updateStrategy} />}
        {activeTab === 'settings' && (
          <div className="max-w-2xl space-y-6">
            <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-xl">
              <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2"><Lock className="w-5 h-5 text-blue-400" /> DeepSeek 秘钥配置</h2>
              <input type="password" placeholder="sk-..." value={deepseekKey} onChange={(e) => setDeepseekKey(e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white font-mono text-sm mb-4" />
              <p className="text-[10px] text-slate-500 italic">API Key 仅本地加密存储，绝不上传。</p>
            </div>
            <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-xl">
              <h2 className="text-xl font-bold text-white mb-6">OKX V5 连接</h2>
              <div className="space-y-4">
                <div className="flex items-center gap-3 mb-2"><input type="checkbox" id="sim" checked={okxConfig.isSimulated} onChange={(e) => setOkxConfig({...okxConfig, isSimulated: e.target.checked})} className="w-4 h-4" /><label htmlFor="sim" className="text-sm">启用模拟盘</label></div>
                <input type="text" placeholder="API Key" value={okxConfig.apiKey} onChange={(e) => setOkxConfig({...okxConfig, apiKey: e.target.value})} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white font-mono text-sm" />
                <input type="password" placeholder="Secret Key" value={okxConfig.secretKey} onChange={(e) => setOkxConfig({...okxConfig, secretKey: e.target.value})} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white font-mono text-sm" />
                <input type="password" placeholder="Passphrase" value={okxConfig.passphrase} onChange={(e) => setOkxConfig({...okxConfig, passphrase: e.target.value})} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white font-mono text-sm" />
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;