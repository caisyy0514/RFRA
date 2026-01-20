import React, { useMemo, useState, useEffect } from 'react';
import { Asset, TickerData, StrategyConfig, Position, OKXConfig } from '../types';
import { okxService } from '../services/okxService';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, Cell } from 'recharts';
import { DollarSign, Clock, Server, Wallet, PieChart, Briefcase, TrendingUp, TrendingDown, Scale } from 'lucide-react';

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

  useEffect(() => {
    okxService.getLatency().then(setLatency);
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
          
          // Swap Calculations
          const swapSize = parseFloat(pos.pos); // contracts (usually negative for short)
          const swapUPL = parseFloat(pos.upl);
          const swapEntry = parseFloat(pos.avgPx);
          
          // Spot Calculations (Assumption: Spot Entry ~= Swap Entry)
          const spotValue = spotBalance * currentPrice;
          const spotPnL = (currentPrice - swapEntry) * spotBalance;
          
          // Yield Calculations
          // Daily Yield = Value * Rate * 3 (8h * 3)
          const totalExposure = Math.abs(swapSize * swapEntry * 0.01); // Approx value, accurate calc needs contract value
          // Using simpler heuristic: Swap Value roughly equals Spot Value
          const dailyYield = spotValue * Math.abs(fundingRate) * 3;
          
          const netPnL = spotPnL + swapUPL;

          return {
              pair,
              baseCurrency,
              currentPrice,
              fundingRate,
              spot: { balance: spotBalance, value: spotValue, pnl: spotPnL },
              swap: { size: swapSize, entry: swapEntry, upl: swapUPL, leverage: pos.lever },
              yield: { daily: dailyYield, netPnL }
          };
      });
  }, [positions, assets, marketData]);

  const stats = useMemo(() => {
    let dailyUsd = 0;
    let totalValueDeployed = 0;
    
    portfolioItems.forEach(item => {
        dailyUsd += item.yield.daily;
        totalValueDeployed += item.spot.value;
    });

    const utilization = totalEquity > 0 ? (totalValueDeployed / totalEquity) * 100 : 0;
    return { dailyUsd, utilization, totalValueDeployed };
  }, [portfolioItems, totalEquity]);

  const formatVolume = (volStr: string) => {
    const vol = parseFloat(volStr);
    if (vol >= 1e9) return `$${(vol / 1e9).toFixed(2)}B`;
    if (vol >= 1e6) return `$${(vol / 1e6).toFixed(2)}M`;
    return `$${vol.toLocaleString()}`;
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Top Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:opacity-20 transition-opacity"><DollarSign className="w-12 h-12 text-white" /></div>
          <div className="flex flex-col h-full justify-between">
            <div className="text-slate-400 text-sm font-medium flex items-center gap-2"><Wallet className="w-4 h-4" /> 总权益 (Equity)</div>
            <div>
                <div className="text-2xl font-bold text-white mt-2">${totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
            </div>
          </div>
        </div>
        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg relative overflow-hidden">
          <div className="flex flex-col h-full justify-between">
            <div className="text-slate-400 text-sm font-medium flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-400" /> 预估日收 (Est. Daily)</div>
            <div>
                <div className={`text-2xl font-bold mt-2 flex items-baseline gap-2 text-emerald-400`}>
                  +${stats.dailyUsd.toFixed(2)}
                  <span className="text-sm text-slate-500 font-normal">/ day</span>
                </div>
                <div className="flex items-center mt-1 text-xs text-slate-400"><Clock className="w-3 h-3 mr-1" /> 下次结算: <span className="text-white ml-1">{nextFundingTime}</span></div>
            </div>
          </div>
        </div>
        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg">
           <div className="flex flex-col h-full justify-between">
            <div className="text-slate-400 text-sm font-medium flex items-center gap-2"><PieChart className="w-4 h-4 text-blue-400" /> 资金利用率</div>
            <div>
                <div className="text-2xl font-bold text-white mt-2">{stats.utilization.toFixed(1)}%</div>
                <div className="w-full bg-slate-700 h-1 rounded-full mt-2 overflow-hidden">
                  <div className="bg-blue-500 h-full transition-all duration-500" style={{ width: `${Math.min(stats.utilization, 100)}%` }} />
                </div>
            </div>
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
                <h3 className="font-semibold text-white flex items-center gap-2"><Briefcase className="w-5 h-5 text-blue-400" /> 套利组合监控 (Portfolio)</h3>
                <span className="text-xs text-slate-500">活跃组合: {portfolioItems.length}</span>
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
                                 <span className="text-[10px] bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded uppercase">Cross {item.swap.leverage}x</span>
                             </div>
                             <div className="flex items-center gap-4">
                                 <div className="text-right">
                                     <div className="text-[10px] text-slate-500 uppercase">净值 PnL</div>
                                     <div className={`font-mono font-bold ${item.yield.netPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                         {item.yield.netPnL >= 0 ? '+' : ''}{item.yield.netPnL.toFixed(2)} USD
                                     </div>
                                 </div>
                             </div>
                        </div>

                        {/* Card Body Grid */}
                        <div className="grid grid-cols-3 divide-x divide-slate-700/50">
                             {/* Module 1: Spot */}
                             <div className="p-4 space-y-3">
                                <div className="text-xs text-slate-500 font-bold uppercase tracking-wider mb-1 flex items-center gap-1"><Wallet className="w-3 h-3" /> 现货端 (Spot)</div>
                                <div>
                                    <div className="text-xs text-slate-400">持仓量</div>
                                    <div className="text-sm font-mono text-white">{item.spot.balance.toFixed(4)} {item.baseCurrency}</div>
                                </div>
                                <div>
                                    <div className="text-xs text-slate-400">当前价值</div>
                                    <div className="text-sm font-mono text-white">${item.spot.value.toFixed(2)}</div>
                                </div>
                                <div>
                                    <div className="text-xs text-slate-400">估算盈亏</div>
                                    <div className={`text-sm font-mono font-bold ${item.spot.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {item.spot.pnl >= 0 ? '+' : ''}{item.spot.pnl.toFixed(2)}
                                    </div>
                                </div>
                             </div>

                             {/* Module 2: Swap */}
                             <div className="p-4 space-y-3">
                                <div className="text-xs text-slate-500 font-bold uppercase tracking-wider mb-1 flex items-center gap-1"><Scale className="w-3 h-3" /> 合约端 (Swap)</div>
                                <div>
                                    <div className="text-xs text-slate-400">合约张数</div>
                                    <div className="text-sm font-mono text-white">{item.swap.size} <span className={`text-[10px] ${item.swap.size < 0 ? 'text-red-400' : 'text-emerald-400'}`}>{item.swap.size < 0 ? 'SHORT' : 'LONG'}</span></div>
                                </div>
                                <div>
                                    <div className="text-xs text-slate-400">开仓均价</div>
                                    <div className="text-sm font-mono text-white">${item.swap.entry.toFixed(2)}</div>
                                </div>
                                <div>
                                    <div className="text-xs text-slate-400">未实现盈亏 (UPL)</div>
                                    <div className={`text-sm font-mono font-bold ${item.swap.upl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {item.swap.upl >= 0 ? '+' : ''}{item.swap.upl.toFixed(2)}
                                    </div>
                                </div>
                             </div>

                             {/* Module 3: Yield */}
                             <div className="p-4 space-y-3 bg-slate-800/30">
                                <div className="text-xs text-slate-500 font-bold uppercase tracking-wider mb-1 flex items-center gap-1"><TrendingUp className="w-3 h-3" /> 收益与风险</div>
                                <div>
                                    <div className="text-xs text-slate-400">实时费率</div>
                                    <div className="text-sm font-mono text-emerald-400 font-bold">{(item.fundingRate * 100).toFixed(4)}%</div>
                                </div>
                                <div>
                                    <div className="text-xs text-slate-400">预估日收</div>
                                    <div className="text-sm font-mono text-emerald-400">+${item.yield.daily.toFixed(2)}</div>
                                </div>
                                <div className="pt-1">
                                    <div className="flex items-center gap-1 text-[10px] text-slate-400 border border-slate-600 rounded px-1.5 py-0.5 w-max">
                                        <Clock className="w-3 h-3" /> 8h 倒计时: {nextFundingTime}
                                    </div>
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