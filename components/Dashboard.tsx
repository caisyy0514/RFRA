import React, { useMemo } from 'react';
import { Asset, TickerData, StrategyConfig } from '../types';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as ReTooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { DollarSign, Activity, Zap, TrendingUp } from 'lucide-react';

interface DashboardProps {
  assets: Asset[];
  strategies: StrategyConfig[];
  marketData: TickerData[];
  totalEquity: number;
}

const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444'];

const Dashboard: React.FC<DashboardProps> = ({ assets, strategies, marketData, totalEquity }) => {
  
  const activeStrategies = strategies.filter(s => s.isActive).length;
  
  const topFundingPairs = useMemo(() => {
    return [...marketData]
      .sort((a, b) => parseFloat(b.fundingRate) - parseFloat(a.fundingRate))
      .slice(0, 5);
  }, [marketData]);

  const assetData = assets.map(a => ({ name: a.currency, value: a.equityUsd }));

  return (
    <div className="space-y-6 animate-fade-in">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <div className="flex items-center justify-between pb-2">
            <span className="text-slate-400 text-sm font-medium">总权益 (Total Equity)</span>
            <DollarSign className="w-5 h-5 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-white">${totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div className="text-xs text-emerald-400 mt-1 flex items-center">
            <TrendingUp className="w-3 h-3 mr-1" /> +2.4% (24h)
          </div>
        </div>

        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <div className="flex items-center justify-between pb-2">
            <span className="text-slate-400 text-sm font-medium">运行中策略</span>
            <Activity className="w-5 h-5 text-blue-400" />
          </div>
          <div className="text-2xl font-bold text-white">{activeStrategies} <span className="text-sm font-normal text-slate-500">/ {strategies.length}</span></div>
          <div className="text-xs text-blue-400 mt-1">运行正常</div>
        </div>

         <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <div className="flex items-center justify-between pb-2">
            <span className="text-slate-400 text-sm font-medium">最高资金费率</span>
            <Zap className="w-5 h-5 text-yellow-400" />
          </div>
          <div className="text-2xl font-bold text-white">
            {topFundingPairs[0] ? `${(parseFloat(topFundingPairs[0].fundingRate) * 100).toFixed(4)}%` : '0.00%'}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            {topFundingPairs[0]?.instId || 'N/A'}
          </div>
        </div>
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Asset Allocation */}
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg lg:col-span-1">
          <h3 className="text-lg font-semibold text-white mb-4">资产分布</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={assetData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {assetData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <ReTooltip 
                  contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#fff' }}
                  itemStyle={{ color: '#fff' }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap gap-2 mt-4 justify-center">
            {assets.map((asset, idx) => (
              <div key={asset.currency} className="flex items-center text-xs text-slate-300">
                <span className="w-2 h-2 rounded-full mr-1" style={{ backgroundColor: COLORS[idx % COLORS.length] }}></span>
                {asset.currency}
              </div>
            ))}
          </div>
        </div>

        {/* Funding Rates Chart */}
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg lg:col-span-2">
          <h3 className="text-lg font-semibold text-white mb-4">资金费率套利机会 (Top 5)</h3>
          <div className="h-64">
             <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topFundingPairs} layout="vertical" margin={{ top: 5, right: 30, left: 40, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                <XAxis type="number" stroke="#94a3b8" tickFormatter={(val) => `${(val * 100).toFixed(3)}%`} />
                <YAxis dataKey="instId" type="category" stroke="#94a3b8" width={100} tick={{fontSize: 10}} />
                <ReTooltip 
                  cursor={{fill: '#334155', opacity: 0.2}}
                  contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#fff' }}
                />
                <Bar dataKey="fundingRate" fill="#3b82f6" radius={[0, 4, 4, 0]} name="资金费率">
                   {topFundingPairs.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={parseFloat(entry.fundingRate) > 0 ? '#10b981' : '#ef4444'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;