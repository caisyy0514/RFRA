import React, { useState, useEffect } from 'react';
import { Order } from '../types';
import { okxService } from '../services/okxService';
import { Clock, CheckCircle, XCircle, RotateCcw, Filter } from 'lucide-react';

const OrdersPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'live' | 'history'>('history');
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchOrders();
  }, [activeTab]);

  const fetchOrders = async () => {
    setLoading(true);
    try {
      const data = await okxService.getOrders(activeTab);
      setOrders(data);
    } catch (error) {
      console.error("Failed to fetch orders", error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (state: string) => {
    switch (state) {
      case 'filled': return 'text-emerald-400';
      case 'live': return 'text-blue-400';
      case 'canceled': return 'text-slate-500';
      default: return 'text-slate-300';
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Controls */}
      <div className="flex flex-col sm:flex-row justify-between items-center gap-4 bg-slate-800 p-4 rounded-xl border border-slate-700">
        <div className="flex bg-slate-900 rounded-lg p-1">
          <button
            onClick={() => setActiveTab('live')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'live' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
          >
            当前委托 (Live)
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'history' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
          >
            历史成交 (History)
          </button>
        </div>
        
        <button onClick={fetchOrders} className="p-2 text-slate-400 hover:text-white transition-colors">
          <RotateCcw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Orders Table */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-900/50 text-xs uppercase text-slate-400 font-semibold">
              <tr>
                <th className="px-6 py-4">时间</th>
                <th className="px-6 py-4">币对 / 类型</th>
                <th className="px-6 py-4">方向</th>
                <th className="px-6 py-4">价格</th>
                <th className="px-6 py-4">数量</th>
                <th className="px-6 py-4">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-500 italic">
                    暂无订单数据
                  </td>
                </tr>
              ) : (
                orders.map((order) => (
                  <tr key={order.ordId} className="hover:bg-slate-700/30 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2 text-slate-300">
                        <Clock className="w-4 h-4 text-slate-500" />
                        <span className="font-mono text-sm">{new Date(order.cTime).toLocaleString()}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="font-bold text-white">{order.instId}</div>
                      <div className="text-xs text-slate-500 uppercase">{order.ordType}</div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-bold ${order.side === 'buy' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                        {order.side === 'buy' ? '买入' : '卖出'}
                      </span>
                    </td>
                    <td className="px-6 py-4 font-mono text-slate-300">
                      {order.fillPx || order.px}
                    </td>
                    <td className="px-6 py-4 font-mono text-slate-300">
                      {order.fillSz || order.sz}
                    </td>
                    <td className="px-6 py-4">
                      <div className={`flex items-center gap-1.5 capitalize text-sm font-medium ${getStatusColor(order.state)}`}>
                        {order.state === 'filled' && <CheckCircle className="w-4 h-4" />}
                        {order.state === 'canceled' && <XCircle className="w-4 h-4" />}
                        {order.state}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default OrdersPanel;