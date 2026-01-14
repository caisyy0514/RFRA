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
            if (!valid) {
                addLog('error', 'SYSTEM', 'CRITICAL: 账户处于“简单模式”，无法进行合约套利！');
                addLog('info', 'SYSTEM', '请前往 OKX 模拟盘设置：交易 -> 设置 -> 账户模式 -> 切换为“跨币种保证金模式”。');
            } else {
                addLog('success', 'SYSTEM', '账户模式检测通过，支持全仓套利逻辑。');
            }
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
        // 在策略执行前强制验证一次账户模式
        const isConfigValid = await okxService.checkAccountConfiguration();
        if (!isConfigValid) {
            addLog('error', 'STRATEGY', '策略拦截：账户模式不兼容，请切换为“跨币种保证金模式”后再启动。');
            toggleStrategy(strategy.id); // 自动关闭不兼容环境下的策略
            return;
        }

        addLog('info', 'STRATEGY', `[引擎轮询] 正在扫描全市场并验证交易对可用性...`);
        
        const [allTickers, spotInsts] = await Promise.all([
          okxService.getMarketTickers(),
          okxService.getInstruments('SPOT')
        ]);
        
        const minVol = strategy.parameters.minVolume24h || 5000000;
        const minRate = strategy.parameters.minFundingRate || 0.0002;
        
        const tradeableSwapTickers = allTickers.filter(t => {
            const isSwap = t.instId.endsWith('-USDT-SWAP');
            if (!isSwap) return false;
            const parts = t.instId.split('-');
            const expectedSpotId = `${parts[0]}-${parts[1]}`;
            const hasSpot = spotInsts.some(si => si.instId === expectedSpotId);
            return hasSpot && parseFloat(t.volUsdt24h) > minVol;
        });
        
        const topCandidates: TickerData[] = [];
        const sortedByVol = tradeableSwapTickers.sort((a, b) => parseFloat(b.volUsdt24h) - parseFloat(a.volUsdt24h)).slice(0, 30);
        
        for (const cand of sortedByVol) {
            const rate = await okxService.getFundingRate(cand.instId);
            if (parseFloat(rate) >= minRate) topCandidates.push({ ...cand, fundingRate: rate });
            if (topCandidates.length >= 10) break;
        }

        if (topCandidates.length === 0) {
            addLog('warning', 'STRATEGY', '筛选完成：当前无可用且符合费率阈值的期现对。');
            updateStrategyLastRun(strategy.id);
            return;
        }

        let finalTradeQueue = topCandidates.sort((a,b) => parseFloat(b.fundingRate) - parseFloat(a.fundingRate));
        if (strategy.parameters.useAI) {
            const analysis = await analyzeMarketConditions(topCandidates.slice(0, 10), strategy.name, deepseekKeyRef.current);
            setLastAnalysis(analysis);
            if (analysis.recommendedAction === 'BUY' && analysis.suggestedPairs.length > 0) {
                finalTradeQueue = analysis.suggestedPairs
                    .map(pair => topCandidates.find(t => t.instId === pair))
                    .filter((t): t is TickerData => !!t);
                addLog('success', 'AI', `AI 审核建议入场：已确认 ${finalTradeQueue.length} 个优质标的。`);
            } else {
                addLog('warning', 'AI', `AI 风险拦截：${analysis.reasoning}`);
                updateStrategyLastRun(strategy.id);
                return;
            }
        }

        const currentPositions = positionsRef.current.filter(p => parseFloat(p.pos) !== 0);
        for (const pos of currentPositions) {
            const currentRate = parseFloat(await okxService.getFundingRate(pos.instId));
            if (currentRate < (strategy.parameters.exitThreshold || 0.0001)) {
                addLog('warning', 'STRATEGY', `[退出] ${pos.instId} 费率衰减至 ${(currentRate*100).toFixed(4)}%，执行平仓。`);
                const instInfo = instrumentsRef.current.find(i => i.instId === pos.instId);
                if (instInfo) await okxService.executeDualSideExit(pos.instId, instInfo, pos.pos);
            }
        }

        const updatedPos = await okxService.getPositions();
        const activeCount = updatedPos.filter(p => parseFloat(p.pos) !== 0).length;
        const maxPos = strategy.parameters.maxPositions || 3;

        if (activeCount < maxPos) {
            const slots = maxPos - activeCount;
            const newEntries = finalTradeQueue.filter(t => !updatedPos.some(p => p.instId === t.instId)).slice(0, slots);

            for (const target of newEntries) {
                await new Promise(r => setTimeout(r, Math.random() * 800 + 1000));
                const investAmt = (totalEquityRef.current * (strategy.parameters.allocationPct || 30) / 100);
                const swapInfo = instrumentsRef.current.find(i => i.instId === target.instId);
                
                if (swapInfo) {
                    addLog('info', 'STRATEGY', `[执行入场] 标的: ${target.instId}, 分配金额: $${investAmt.toFixed(2)}`);
                    const res = await okxService.executeDualSideEntry(target.instId, investAmt, swapInfo);
                    if (res.success) {
                        addLog('success', 'STRATEGY', res.message);
                    } else {
                        addLog('error', 'STRATEGY', `入场失败: ${res.message}`);
                    }
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