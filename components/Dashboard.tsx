import React, { useMemo, useState, useEffect } from 'react';
import { Asset, TickerData, StrategyConfig, Position, OKXConfig } from '../types';
import { okxService } from '../services/okxService';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, Cell } from 'recharts';
import { DollarSign, Activity, Zap, TrendingUp, Clock, Server, Wallet, AlertCircle } from 'lucide-react';

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
    // Check latency
    okxService.getLatency().then(setLatency);

    // Calculate next funding time (every 8 hours: 00, 08, 16 UTC)
    const updateTimer = () => {
      const now = new Date();
      const h = now.getUTCHours();
      let targetH = 0;
      if (h < 8) targetH = 8;
      else if (h < 16) targetH = 16;
      else targetH = 24; // Next day 00:00

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

  const activeStrategies = strategies.filter(s => s.isActive).length;

  const topFundingPairs = useMemo(() => {
    return [...marketData]
      .sort((a, b) => parseFloat(b.fundingRate) - parseFloat(a.fundingRate))
      .slice(0, 5);
  }, [marketData]);

  const estimatedDailyYield = useMemo(() => {
    // Crude estimation based on active arbitrage positions
    // Sum (Position Value * Funding Rate * 3 times a day)
    let dailyUsd = 0;
    positions.forEach(pos => {
        // Find matching ticker
        const ticker = marketData.find(m => m.instId === pos.instId);
        if (ticker) {
            const val = Math.abs(parseFloat(pos.pos) * parseFloat(pos.avgPx));
            const rate = parseFloat(ticker.fundingRate);
            // If shorting positive rate or longing negative rate -> Profit
            const isShort = parseFloat(pos.pos) < 0;
            const isRatePositive = rate > 0;
            if ((isShort && isRatePositive) || (!isShort && !isRatePositive)) {
                dailyUsd += val * Math.abs(rate) * 3;
            } else {
                dailyUsd -= val * Math.abs(rate) * 3;
            }
        }
    });
    return dailyUsd;
  }, [positions, marketData]);

  return (
    <div className="space-y-6 animate-fade-in">
      
      {/* Zone A: Account Overview & API Status */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Equity */}
        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:opacity-20 transition-opacity">
            <DollarSign className="w-12 h-12 text-white" />
          </div>
          <div className="flex flex-col h-full justify-between">
            <div className="text-slate-400 text-sm font-medium flex items-center gap-2">
                <Wallet className="w-4 h-4" /> 总权益 (Equity)
            </div>
            <div>
                <div className="text-2xl font-bold text-white mt-2">${totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                <div className="flex items-center mt-1 text-xs">
                    <span className="text-emerald-400 font-medium flex items-center">
                        <TrendingUp className="w-3 h-3 mr-1" /> +$124.50 (Today)
                    </span>
                </div>
            </div>
          </div>
        </div>

        {/* Estimated Yield */}
        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg relative overflow-hidden">
          <div className="flex flex-col h-full justify-between">
            <div className="text-slate-400 text-sm font-medium flex items-center gap-2">
                <Zap className="w-4 h-4 text-yellow-400" /> 预估收益 (Daily)
            </div>
            <div>
                <div className="text-2xl font-bold text-white mt-2 flex items-baseline gap-2">
                    ${estimatedDailyYield.toFixed(2)}
                    <span className="text-sm text-slate-500 font-normal">/ day</span>
                </div>
                <div className="flex items-center mt-1 text-xs text-slate-400">
                    <Clock className="w-3 h-3 mr-1" /> 下次结算: <span className="text-white ml-1">{nextFundingTime}</span>
                </div>
            </div>
          </div>
        </div>

        {/* Strategy Status */}
        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg">
           <div className="flex flex-col h-full justify-between">
            <div className="text-slate-400 text-sm font-medium flex items-center gap-2">
                <Activity className="w-4 h-4 text-blue-400" /> 策略状态
            </div>
            <div>
                <div className="text-2xl font-bold text-white mt-2">
                    {activeStrategies} <span className="text-lg text-slate-500">/ {strategies.length}</span>
                </div>
                <div className="text-xs text-blue-400 mt-1">
                    系统运行正常
                </div>
            </div>
          </div>
        </div>

        {/* API Connection */}
        <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg">
          <div className="flex flex-col h-full justify-between">
            <div className="text-slate-400 text-sm font-medium flex items-center gap-2">
                <Server className="w-4 h-4 text-purple-400" /> API 连接
            </div>
            <div className="mt-2">
                <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-white">{okxConfig.isSimulated ? '模拟盘 (Sim)' : '实盘 (Real)'}</span>
                    <span className={`w-2 h-2 rounded-full ${latency < 100 ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
                </div>
                <div className="w-full bg-slate-700 rounded-full h-1.5 mt-2">
                    <div className="bg-emerald-500 h-1.5 rounded-full" style={{ width: '95%' }}></div>
                </div>
                <div className="text-xs text-slate-500 mt-1 text-right">{latency}ms latency</div>
            </div>
          </div>
        </div>
      </div>

      {/* Zone B: Positions & Holdings */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
         {/* Positions Table */}
         <div className="lg:col-span-2 bg-slate-800 rounded-xl border border-slate-700 shadow-lg overflow-hidden flex flex-col">
            <div className="p-5 border-b border-slate-700 flex justify-between items-center">
                <h3 className="font-semibold text-white">当前持仓 (Positions)</h3>
                <span className="text-xs text-slate-500 bg-slate-900 px-2 py-1 rounded">Delta Neutral</span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-left">
                    <thead className="bg-slate-900/50 text-xs uppercase text-slate-400">
                        <tr>
                            <th className="px-5 py-3">合约</th>
                            <th className="px-5 py-3">数量/杠杆</th>
                            <th className="px-5 py-3">开仓均价</th>
                            <th className="px-5 py-3">未实现盈亏</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700 text-sm">
                        {positions.length === 0 && (
                            <tr><td colSpan={4} className="px-5 py-8 text-center text-slate-500">无持仓</td></tr>
                        )}
                        {positions.map((pos) => (
                            <tr key={pos.instId} className="hover:bg-slate-700/30">
                                <td className="px-5 py-3 font-medium text-white">
                                    {pos.instId}
                                    <div className="text-xs text-slate-500">{pos.mgnMode}</div>
                                </td>
                                <td className="px-5 py-3 text-slate-300">
                                    <span className={parseFloat(pos.pos) > 0 ? 'text-emerald-400' : 'text-red-400'}>
                                        {parseFloat(pos.pos) > 0 ? 'Buy' : 'Sell'} {Math.abs(parseFloat(pos.pos))}
                                    </span>
                                    <span className="ml-2 text-xs bg-slate-700 px-1 rounded text-slate-400">{pos.lever}x</span>
                                </td>
                                <td className="px-5 py-3 text-slate-300 font-mono">${parseFloat(pos.avgPx).toLocaleString()}</td>
                                <td className="px-5 py-3 font-mono">
                                    <div className={parseFloat(pos.upl) >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                                        {parseFloat(pos.upl) >= 0 ? '+' : ''}{parseFloat(pos.upl).toFixed(2)}
                                    </div>
                                    <div className="text-xs text-slate-500">
                                        {(parseFloat(pos.uplRatio) * 100).toFixed(2)}%
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
         </div>

         {/* Funding Opportunities Chart */}
         <div className="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg flex flex-col">
            <h3 className="font-semibold text-white mb-4">资金费率扫描 (Top 5)</h3>
            <div className="flex-1 min-h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topFundingPairs} layout="vertical" margin={{ top: 5, right: 30, left: 40, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                    <XAxis type="number" stroke="#94a3b8" tickFormatter={(val) => `${(val * 100).toFixed(3)}%`} />
                    <YAxis dataKey="instId" type="category" stroke="#94a3b8" width={90} tick={{fontSize: 10}} />
                    <ReTooltip 
                    cursor={{fill: '#334155', opacity: 0.2}}
                    contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#fff' }}
                    />
                    <Bar dataKey="fundingRate" radius={[0, 4, 4, 0]}>
                    {topFundingPairs.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={parseFloat(entry.fundingRate) > 0 ? '#10b981' : '#ef4444'} />
                    ))}
                    </Bar>
                </BarChart>
                </ResponsiveContainer>
            </div>
            <div className="mt-4 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                <div className="text-xs text-slate-400">
                    <span className="text-white font-medium">推荐操作:</span> 若费率为正，则现货做多 + 合约做空。若费率为负，则避免做空或平仓。
                </div>
            </div>
         </div>
      </div>
    </div>
  );
};

export default Dashboard;