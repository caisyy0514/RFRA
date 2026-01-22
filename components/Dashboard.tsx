import React, { useMemo, useState, useEffect } from 'react';
import { Asset, TickerData, StrategyConfig, Position, OKXConfig, Instrument } from '../types';
import { okxService } from '../services/okxService';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, Cell } from 'recharts';
import { DollarSign, Clock, Server, Wallet, PieChart, Briefcase, TrendingUp, Scale, RefreshCw, AlertTriangle, CheckCircle, ArrowRightLeft, Zap, List } from 'lucide-react';

interface DashboardProps {
  assets: Asset[];
  strategies: StrategyConfig[];
  marketData: TickerData[];
  positions: Position[];
  totalEquity: number;
  okxConfig: OKXConfig;
}

const Dashboard: React.FC<DashboardProps> = ({ assets, strategies, marketData, positions, totalEquity, okxConfig }) => {
  const [latency, setLatency] = useState<number>(0);
  const [nextFundingTime, setNextFundingTime] = useState<string>('');
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [fixingId, setFixingId] = useState<string | null>(null);

  useEffect(() => {
    okxService.getLatency().then(setLatency);
    okxService.getInstruments('SWAP').then(setInstruments);

    const updateTimer = () => {
      const now = new Date();
      const h = now.getUTCHours();
      let targetH = h < 8 ? 8 : h < 16 ? 16 : 24;
      const target = new Date(now);
      target.setUTCHours(targetH, 0, 0, 0);
      const diff = target.getTime() - now.getTime();
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      setNextFundingTime(`${hours}h ${minutes}m`);
    };
    updateTimer();
    const interval = setInterval(updateTimer, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleFixHedge = async (instId: string) => {
    if (!confirm(`Are you sure you want to rebalance ${instId}? This will execute market orders.`)) return;
    setFixingId(instId);
    try {
        const res = await okxService.auditAndRebalance(instId);
        alert(res.message);
    } catch (e) {
        alert("Failed to fix hedge");
    } finally {
        setFixingId(null);
    }
  };

  const topFundingPairs = useMemo(() => {
    return [...marketData]
      .sort((a, b) => parseFloat(b.fundingRate) - parseFloat(a.fundingRate))
      .slice(0, 8); 
  }, [marketData]);

  const portfolioItems = useMemo(() => {
      return positions.map(pos => {
          const pair = pos.instId; // e.g., ETH-USDT-SWAP
          const baseCurrency = pair.split('-')[0]; // e.g., ETH
          
          // Find Spot Asset
          const spotAsset = assets.find(a => a.currency === baseCurrency);
          const spotBalance = spotAsset ? spotAsset.balance : 0;
          
          // Find Market Data for price
          const ticker = marketData.find(m => m.instId === pair);
          const currentPrice = ticker ? parseFloat(ticker.last) : 0;
          const fundingRate = ticker ? parseFloat(ticker.fundingRate) : 0;
          
          // Find Instrument for ctVal
          const instInfo = instruments.find(i => i.instId === pair);
          const ctVal = instInfo ? parseFloat(instInfo.ctVal) : 0;
          
          // Swap Calculations
          const swapSize = Math.abs(parseFloat(pos.pos)); // contracts
          const swapUPL = parseFloat(pos.upl);
          const swapEntry = parseFloat(pos.avgPx);
          const swapCoinQty = swapSize * ctVal;
          const swapValue = swapCoinQty * currentPrice;
          
          // Hedge Delta Calculation
          const deltaAmount = spotBalance - swapCoinQty;
          const deltaValue = deltaAmount * currentPrice;
          
          // Spot Calculations
          const spotValue = spotBalance * currentPrice;
          // Approximate Spot PnL: (Current - Entry) * Balance
          // Note: Since we don't track exact Spot Entry in this simple version, we assume Spot Entry ~= Swap Entry for PnL estimation purposes
          // This shows the "Hedged PnL" logic: Spot gains should offset Swap losses.
          const spotPnL = (currentPrice - swapEntry) * spotBalance;
          
          // Yield Calculations
          // Next Yield (Next Payout) = Swap Value * Funding Rate (assuming Short & Positive Rate)
          const nextYield = swapValue * fundingRate;
          const dailyYield = nextYield * 3;
          
          // Price PnL = Spot PnL + Swap UPL
          const pricePnL = spotPnL + swapUPL;

          let status: 'Perfect' | 'Dusty' | 'Risk' = 'Perfect';
          if (Math.abs(deltaValue) > 10) status = 'Risk';
          else if (Math.abs(deltaValue) > 1) status = 'Dusty';

          return {
              pair,
              baseCurrency,
              currentPrice,
              fundingRate,
              ctVal,
              spot: { balance: spotBalance, value: spotValue, pnl: spotPnL },
              swap: { size: swapSize, coinQty: swapCoinQty, value: swapValue, entry: swapEntry, upl: swapUPL, leverage: pos.lever },
              yield: { daily: dailyYield, next: nextYield, pricePnL: pricePnL },
              hedge: { deltaAmount, deltaValue, status }
          };
      });
  }, [positions, assets, marketData, instruments]);

  const globalStats = useMemo(() => {
    let totalHedgePnL = 0;
    let totalNextYield = 0;
    let totalDailyYield = 0;
    let totalValueDeployed = 0;

    portfolioItems.forEach(item => {
        totalHedgePnL += item.yield.pricePnL;
        totalNextYield += item.yield.next;
        totalDailyYield += item.yield.daily;
        totalValueDeployed += item.spot.value;
    });
    
    // Annualized Return based on Total Equity (Capital Efficiency)
    // APY = (Daily Yield * 365) / Total Equity
    const apy = totalEquity > 0 ? (totalDailyYield * 365 / totalEquity) * 100 : 0;
    const utilization = totalEquity > 0 ? (totalValueDeployed / totalEquity) * 100 : 0;

    return { totalHedgePnL, totalNextYield, totalDailyYield, apy, utilization, totalValueDeployed };
  }, [portfolioItems, totalEquity]);

  const formatVolume = (volStr: string) => {
    const vol = parseFloat(volStr);
    if (vol >= 1e9) return `$${(vol / 1e9).toFixed(2)}B`;
    if (vol >= 1e6) return `$${(vol / 1e6).toFixed(2)}M`;
    return `$${vol.toLocaleString()}`;
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Global Yield Header (New Module) */}
      <div className="bg-gradient-to-r from-slate-900 to-slate-800 p-6 rounded-xl border border-slate-700 shadow-2xl relative overflow-hidden">
        {/* Visual decoration */}
        <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
            <TrendingUp className="w-48 h-48 text-emerald-500" />
        </div>
        
        <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-6 flex items-center gap-2">
            <Zap className="w-4 h-4 text-yellow-400" /> 全局收益监控 (Total Yield Overview)
        </h2>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 relative z-10">
            {/* Col 1: Hedge PnL */}
            <div>
                <div className="text-xs text-slate-500 mb-1 font-medium uppercase">盘面总浮盈 (Price PnL)</div>
                <div className={`text-2xl font-mono font-bold ${globalStats.totalHedgePnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {globalStats.totalHedgePnL >= 0 ? '+' : ''}{globalStats.totalHedgePnL.toFixed(2)}
                    <span className="text-xs text-slate-500 font-sans ml-1">USD</span>
                </div>
                <div className="text-[10px] text-slate-600 mt-1">现货盈亏 + 合约未结</div>
            </div>

            {/* Col 2: Next Payout */}
             <div>
                <div className="text-xs text-slate-500 mb-1 font-medium uppercase">预计下次结算 (Next Payout)</div>
                <div className={`text-2xl font-mono font-bold ${globalStats.totalNextYield >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {globalStats.totalNextYield >= 0 ? '+' : ''}{globalStats.totalNextYield.toFixed(2)}
                    <span className="text-xs text-slate-500 font-sans ml-1">USD</span>
                </div>
                <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-1">
                   <Clock className="w-3 h-3" /> {nextFundingTime}
                </div>
            </div>

            {/* Col 3: Est 24h */}
             <div>
                <div className="text-xs text-slate-500 mb-1 font-medium uppercase">日化预估收益 (Est. 24h)</div>
                <div className={`text-2xl font-mono font-bold ${globalStats.totalDailyYield >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {globalStats.totalDailyYield >= 0 ? '+' : ''}{globalStats.totalDailyYield.toFixed(2)}
                    <span className="text-xs text-slate-500 font-sans ml-1">USD</span>
                </div>
                <div className="text-[10px] text-slate-600 mt-1">当前费率 × 3</div>
            </div>

            {/* Col 4: APY */}
             <div>
                <div className="text-xs text-slate-500 mb-1 font-medium uppercase">综合年化 (APY)</div>
                <div className="text-2xl font-mono font-bold text-blue-400 flex items-baseline">
                    {globalStats.apy.toFixed(2)}<span className="text-sm ml-1">%</span>
                </div>
                <div className="text-[10px] text-slate-600 mt-1">基于总权益计算</div>
            </div>
        </div>
      </div>

      {/* Basic Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg relative overflow-hidden">
          <div className="flex flex-col h-full justify-between">
            <div className="text-slate-400 text-sm font-medium flex items-center gap-2"><Wallet className="w-4 h-4" /> 总权益 (Equity)</div>
            <div>
                <div className="text-2xl font-bold text-white mt-2">${totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
            </div>
          </div>
        </div>
        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg relative overflow-hidden">
           <div className="flex flex-col h-full justify-between">
            <div className="text-slate-400 text-sm font-medium flex items-center gap-2"><PieChart className="w-4 h-4 text-blue-400" /> 资金利用率</div>
            <div>
                <div className="text-2xl font-bold text-white mt-2">{globalStats.utilization.toFixed(1)}%</div>
                <div className="w-full bg-slate-700 h-1 rounded-full mt-2 overflow-hidden">
                  <div className="bg-blue-500 h-full transition-all duration-500" style={{ width: `${Math.min(globalStats.utilization, 100)}%` }} />
                </div>
            </div>
          </div>
        </div>
        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg">
          <div className="flex flex-col h-full justify-between">
             <div className="text-slate-400 text-sm font-medium flex items-center gap-2"><Briefcase className="w-4 h-4 text-emerald-400" /> 活跃策略组合</div>
             <div className="text-2xl font-bold text-white mt-2">{portfolioItems.length}</div>
          </div>
        </div>
        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg">
          <div className="flex flex-col h-full justify-between">
            <div className="text-slate-400 text-sm font-medium flex items-center gap-2"><Server className="w-4 h-4 text-purple-400" /> API 连接</div>
            <div className="mt-2">
                <div className="flex items-center justify-between mb-1"><span className="text-sm text-white">{okxConfig.isSimulated ? '模拟盘' : '实盘'}</span><span className={`w-2 h-2 rounded-full ${latency < 150 ? 'bg-emerald-500' : 'bg-red-500'}`}></span></div>
                <div className="text-xs text-slate-500 mt-1 text-right">{latency}ms latency</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
         {/* Portfolio Monitor */}
         <div className="lg:col-span-2 space-y-4">
            <div className="flex justify-between items-center mb-2">
                <h3 className="font-semibold text-white flex items-center gap-2"><List className="w-5 h-5 text-blue-400" /> 组合详情 (Details)</h3>
            </div>
            
            <div className="grid grid-cols-1 gap-4">
                {portfolioItems.length === 0 && (
                    <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-10 text-center text-slate-500 border-dashed">
                        暂无活跃套利组合，请启动策略。
                    </div>
                )}
                {portfolioItems.map((item) => (
                    <div key={item.pair} className="bg-slate-800 rounded-xl border border-slate-700 shadow-lg overflow-hidden group hover:border-blue-500/50 transition-colors">
                        {/* Header */}
                        <div className="bg-slate-900/40 p-3 px-4 flex justify-between items-center border-b border-slate-700/50">
                             <div className="flex items-center gap-3">
                                 <span className="font-bold text-white text-lg">{item.pair}</span>
                                 {item.hedge.status === 'Perfect' && <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded flex items-center gap-1"><CheckCircle className="w-3 h-3"/> Perfect Hedge</span>}
                                 {item.hedge.status === 'Dusty' && <span className="text-[10px] bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded flex items-center gap-1">Dusty</span>}
                                 {item.hedge.status === 'Risk' && <span className="text-[10px] bg-red-500/20 text-red-400 px-2 py-0.5 rounded flex items-center gap-1 animate-pulse"><AlertTriangle className="w-3 h-3"/> Imbalanced</span>}
                             </div>
                             <div className="flex items-center gap-2">
                                 {item.hedge.status !== 'Perfect' && (
                                     <button 
                                        onClick={() => handleFixHedge(item.pair)}
                                        disabled={fixingId === item.pair}
                                        className="text-[10px] bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded flex items-center gap-1 disabled:opacity-50"
                                     >
                                         <RefreshCw className={`w-3 h-3 ${fixingId === item.pair ? 'animate-spin' : ''}`} /> Auto-Fix
                                     </button>
                                 )}
                             </div>
                        </div>

                        {/* Symmetric Asset-Liability View */}
                        <div className="grid grid-cols-3 divide-x divide-slate-700/50 bg-slate-800/50">
                             {/* Left: Spot (Asset/Long) */}
                             <div className="p-4 space-y-3 border-t-2 border-t-emerald-500/30 bg-emerald-900/5">
                                <div className="text-xs text-emerald-400 font-bold uppercase tracking-wider mb-2 flex items-center gap-1">
                                    <Wallet className="w-3 h-3" /> 现货端 (Spot Long)
                                </div>
                                <div className="flex justify-between items-end">
                                    <span className="text-xs text-slate-500">持仓量</span>
                                    <span className="text-sm font-mono text-white">{item.spot.balance.toFixed(4)} <span className="text-[10px] text-slate-600">{item.baseCurrency}</span></span>
                                </div>
                                <div className="flex justify-between items-end">
                                    <span className="text-xs text-slate-500">持仓价值</span>
                                    <span className="text-sm font-mono text-white">${item.spot.value.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                                </div>
                                <div className="flex justify-between items-end">
                                    <span className="text-xs text-slate-500">估算盈亏</span>
                                    <span className={`text-sm font-mono font-bold ${item.spot.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {item.spot.pnl >= 0 ? '+' : ''}{item.spot.pnl.toFixed(2)}
                                    </span>
                                </div>
                             </div>

                             {/* Middle: Swap (Liability/Short) */}
                             <div className="p-4 space-y-3 border-t-2 border-t-purple-500/30 bg-purple-900/5">
                                <div className="text-xs text-purple-400 font-bold uppercase tracking-wider mb-2 flex items-center gap-1">
                                    <Scale className="w-3 h-3" /> 合约端 (Swap Short)
                                </div>
                                <div className="flex justify-between items-end">
                                    <span className="text-xs text-slate-500">合约张数</span>
                                    <div className="text-right">
                                        <div className="text-sm font-mono text-white">-{item.swap.size} <span className="text-[10px] text-slate-600">张</span></div>
                                        <div className="text-[10px] text-slate-500">≈ {item.swap.coinQty.toFixed(4)} {item.baseCurrency}</div>
                                    </div>
                                </div>
                                <div className="flex justify-between items-end">
                                    <span className="text-xs text-slate-500">名义价值</span>
                                    <span className="text-sm font-mono text-white">${item.swap.value.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                                </div>
                                <div className="flex justify-between items-end">
                                    <span className="text-xs text-slate-500">未结盈亏</span>
                                    <span className={`text-sm font-mono font-bold ${item.swap.upl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {item.swap.upl >= 0 ? '+' : ''}{item.swap.upl.toFixed(2)}
                                    </span>
                                </div>
                             </div>

                             {/* Right: Net Summary */}
                             <div className="p-4 space-y-3 border-t-2 border-t-blue-500/30">
                                <div className="text-xs text-blue-400 font-bold uppercase tracking-wider mb-2 flex items-center gap-1">
                                    <ArrowRightLeft className="w-3 h-3" /> 收益详解 (Yield Detail)
                                </div>
                                
                                <div className="flex justify-between items-end">
                                    <span className="text-xs text-slate-500">对冲差额 (Delta)</span>
                                    <span className={`text-sm font-mono ${item.hedge.status === 'Perfect' ? 'text-slate-500' : 'text-yellow-400'}`}>
                                        {item.hedge.deltaValue > 0 ? '+' : ''}{item.hedge.deltaValue.toFixed(2)}
                                    </span>
                                </div>

                                <div className="flex justify-between items-end">
                                    <span className="text-xs text-slate-500">盘面浮盈 (PnL)</span>
                                    <span className={`text-sm font-mono font-bold ${item.yield.pricePnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {item.yield.pricePnL >= 0 ? '+' : ''}{item.yield.pricePnL.toFixed(2)}
                                    </span>
                                </div>

                                <div className="h-px bg-slate-700/50 my-1"></div>

                                <div className="flex justify-between items-end">
                                    <span className="text-xs text-slate-500">资金费率</span>
                                    <span className="text-sm font-mono text-white font-bold">{(item.fundingRate * 100).toFixed(4)}%</span>
                                </div>

                                <div className="flex justify-between items-end bg-emerald-500/10 p-1 -mx-1 rounded">
                                    <span className="text-xs text-emerald-400 font-medium">下次收益 (Next)</span>
                                    <span className="text-sm font-mono text-emerald-400 font-bold">
                                        +{item.yield.next.toFixed(2)}
                                    </span>
                                </div>

                                <div className="flex justify-between items-end">
                                    <span className="text-xs text-slate-500">日化预估 (24h)</span>
                                    <span className="text-sm font-mono text-emerald-500">
                                        +{item.yield.daily.toFixed(2)}
                                    </span>
                                </div>
                             </div>
                        </div>
                    </div>
                ))}
            </div>
         </div>

         {/* Right Radar Chart */}
         <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg flex flex-col h-[480px]">
            <h3 className="font-semibold text-white mb-4">优选费率雷达 (Top 8)</h3>
            <div className="flex-1 min-h-[350px]">
                <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topFundingPairs} layout="vertical" margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                    <XAxis type="number" stroke="#94a3b8" tickFormatter={(val) => `${(val * 100).toFixed(2)}%`} domain={[0, 'auto']} />
                    <YAxis dataKey="instId" type="category" stroke="#94a3b8" width={110} tick={{fontSize: 9}} />
                    <ReTooltip 
                    cursor={{fill: '#334155', opacity: 0.2}}
                    contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                    formatter={(val: any, name: any, props: any) => [
                        `${(val * 100).toFixed(4)}%`, 
                        `成交额: ${formatVolume(props.payload.volUsdt24h)}`
                    ]}
                    />
                    <Bar dataKey="fundingRate" radius={[0, 4, 4, 0]} barSize={20}>
                    {topFundingPairs.map((entry, index) => {
                        const isHeld = positions.some(p => p.instId === entry.instId);
                        const rate = parseFloat(entry.fundingRate);
                        let color = rate > 0 ? '#10b981' : '#ef4444';
                        if (isHeld) color = '#8b5cf6'; 
                        return <Cell key={`cell-${index}`} fill={color} />;
                    })}
                    </Bar>
                </BarChart>
                </ResponsiveContainer>
            </div>
            <div className="mt-4 p-3 bg-slate-900/50 rounded-lg border border-slate-700">
                <div className="flex justify-around text-[10px] text-slate-400">
                   <span className="flex items-center gap-1"><span className="w-2 h-2 bg-emerald-500 rounded-full"></span>高正费率</span>
                   <span className="flex items-center gap-1"><span className="w-2 h-2 bg-red-500 rounded-full"></span>负费率</span>
                   <span className="flex items-center gap-1"><span className="w-2 h-2 bg-purple-500 rounded-full"></span>已持仓</span>
                </div>
            </div>
         </div>
      </div>
    </div>
  );
};

export default Dashboard;