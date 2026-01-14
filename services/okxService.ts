import { OKXConfig, TickerData, Asset, Position, Order } from '../types';

// This service mimics the OKX V5 API structure.
class OKXService {
  private config: OKXConfig | null = null;
  private mockOrders: Order[] = [];

  constructor() {
    // Initialize with some mock history
    this.mockOrders = [
      { ordId: '1001', clOrdId: 'qx-1', instId: 'BTC-USDT-SWAP', side: 'sell', ordType: 'market', sz: '0.5', px: '64200.5', state: 'filled', cTime: Date.now() - 86400000, fillSz: '0.5', fillPx: '64200.5' },
      { ordId: '1002', clOrdId: 'qx-2', instId: 'ETH-USDT-SWAP', side: 'sell', ordType: 'limit', sz: '5.0', px: '3400.0', state: 'filled', cTime: Date.now() - 43200000, fillSz: '5.0', fillPx: '3400.0' },
      { ordId: '1003', clOrdId: 'qx-3', instId: 'SOL-USDT', side: 'buy', ordType: 'market', sz: '20.0', px: '145.2', state: 'filled', cTime: Date.now() - 21000000, fillSz: '20.0', fillPx: '145.2' },
    ];
  }

  setConfig(config: OKXConfig) {
    this.config = config;
  }

  async getLatency(): Promise<number> {
    return Math.floor(Math.random() * 50) + 20; // 20-70ms
  }

  async getFundingRates(): Promise<TickerData[]> {
    await new Promise(resolve => setTimeout(resolve, 300));
    const baseTickers = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT'];
    return baseTickers.map(coin => ({
      instId: `${coin}-USDT-SWAP`,
      last: (Math.random() * 1000 + 10).toFixed(2),
      fundingRate: (Math.random() * 0.0005 * (Math.random() > 0.3 ? 1 : -1)).toFixed(6),
      ts: Date.now().toString()
    }));
  }

  async getAccountAssets(): Promise<Asset[]> {
    await new Promise(resolve => setTimeout(resolve, 300));
    return [
      { currency: 'USDT', balance: 52450.00, available: 42000.00, equityUsd: 52450.00 },
      { currency: 'BTC', balance: 0.15, available: 0.0, equityUsd: 9800.00 }, // Locked in trade
      { currency: 'ETH', balance: 2.5, available: 0.0, equityUsd: 6500.00 } // Locked in trade
    ];
  }

  async getPositions(): Promise<Position[]> {
    await new Promise(resolve => setTimeout(resolve, 300));
    // Simulate an arbitrage portfolio: Long Spot (in Assets) + Short Perpetuals (here)
    return [
      {
        instId: 'BTC-USDT-SWAP',
        pos: '-0.15', // Short
        avgPx: '64100.5',
        upl: '125.40',
        uplRatio: '0.019',
        lever: '1',
        liqPx: '128000.0',
        mgnMode: 'cross',
        cTime: Date.now() - 86400000
      },
      {
        instId: 'ETH-USDT-SWAP',
        pos: '-2.5', // Short
        avgPx: '3450.0',
        upl: '-45.20',
        uplRatio: '-0.005',
        lever: '1',
        liqPx: '6900.0',
        mgnMode: 'cross',
        cTime: Date.now() - 43200000
      }
    ];
  }

  async getOrders(state: 'live' | 'history' = 'live'): Promise<Order[]> {
    await new Promise(resolve => setTimeout(resolve, 200));
    if (state === 'history') {
      return this.mockOrders;
    }
    // Return some mock live orders
    return [
      { ordId: '1004', clOrdId: 'qx-4', instId: 'DOGE-USDT-SWAP', side: 'sell', ordType: 'limit', sz: '10000', px: '0.18', state: 'live', cTime: Date.now() - 300000 }
    ];
  }

  async placeOrder(instId: string, side: 'buy' | 'sell', amount: string) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const newOrder: Order = {
      ordId: Math.random().toString(36).substring(7),
      clOrdId: `quantx-${Date.now()}`,
      instId,
      side,
      ordType: 'market',
      sz: amount,
      px: '0', // Market order
      state: 'filled', // Auto fill for simulation
      cTime: Date.now(),
      fillSz: amount,
      fillPx: 'Market Price'
    };
    this.mockOrders.unshift(newOrder); // Add to history
    
    return {
      ordId: newOrder.ordId,
      clOrdId: newOrder.clOrdId,
      sCode: '0',
      sMsg: 'Order placed successfully'
    };
  }
}

export const okxService = new OKXService();