import { OKXConfig, TickerData, Asset } from '../types';

// This service mimics the OKX V5 API structure.
// In a production environment, this would sign requests using crypto-js or connect to a backend proxy.
// Due to browser CORS restrictions with direct Exchange API calls, we default to a robust simulation mode here.

class OKXService {
  private config: OKXConfig | null = null;

  setConfig(config: OKXConfig) {
    this.config = config;
  }

  // Simulate fetching tickers with funding rates
  async getFundingRates(): Promise<TickerData[]> {
    // In real implementation: GET /api/v5/public/funding-rate
    
    // Simulating network delay
    await new Promise(resolve => setTimeout(resolve, 500));

    const baseTickers = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT'];
    
    return baseTickers.map(coin => ({
      instId: `${coin}-USDT-SWAP`,
      last: (Math.random() * 1000 + 10).toFixed(2),
      fundingRate: (Math.random() * 0.0005 * (Math.random() > 0.3 ? 1 : -1)).toFixed(6), // Random + or - funding
      ts: Date.now().toString()
    }));
  }

  async getAccountAssets(): Promise<Asset[]> {
    // In real implementation: GET /api/v5/account/balance
    await new Promise(resolve => setTimeout(resolve, 300));
    
    return [
      { currency: 'USDT', balance: 50000.00, available: 45000.00, equityUsd: 50000.00 },
      { currency: 'BTC', balance: 0.15, available: 0.15, equityUsd: 9800.00 },
      { currency: 'ETH', balance: 2.5, available: 2.5, equityUsd: 6500.00 }
    ];
  }

  async placeOrder(instId: string, side: 'buy' | 'sell', amount: string) {
    // POST /api/v5/trade/order
    await new Promise(resolve => setTimeout(resolve, 400));
    return {
      ordId: Math.random().toString(36).substring(7),
      clOrdId: `quantx-${Date.now()}`,
      sCode: '0',
      sMsg: 'Order placed successfully'
    };
  }
}

export const okxService = new OKXService();