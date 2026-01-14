import { OKXConfig, TickerData, Asset, Position, Order } from '../types';

class OKXService {
  private config: OKXConfig | null = null;

  setConfig(config: OKXConfig) {
    this.config = config;
  }

  // Helper to make proxied requests
  private async request(endpoint: string, method: 'GET' | 'POST' = 'GET', body?: any) {
    if (!this.config || !this.config.apiKey) {
      throw new Error("API credentials not configured");
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'x-secret-key': this.config.secretKey,
      'x-passphrase': this.config.passphrase,
      'x-simulated-trading': this.config.isSimulated ? '1' : '0'
    };

    const res = await fetch(`/api/proxy${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    const json = await res.json();
    
    if (json.code !== '0') {
      throw new Error(`OKX API Error (${json.code}): ${json.msg}`);
    }
    
    return json.data;
  }

  async getLatency(): Promise<number> {
    const start = Date.now();
    try {
      // Use a lightweight public endpoint to test connectivity via proxy
      // Note: This checks your server -> OKX latency primarily
      await this.request('/api/v5/public/time');
      return Date.now() - start;
    } catch (e) {
      return -1;
    }
  }

  async getFundingRates(): Promise<TickerData[]> {
    if (!this.config?.apiKey) return [];
    
    // OKX doesn't have a "get all funding rates" endpoint that is efficient for single call
    // We will fetch funding rates for a specific watchlist
    const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'OP'];
    const promises = coins.map(async (coin) => {
      try {
        const instId = `${coin}-USDT-SWAP`;
        const data = await this.request(`/api/v5/public/funding-rate?instId=${instId}`);
        if (data && data.length > 0) {
            // Also fetch last price for display context
            // Optimization: In a real app, use a bulk ticker endpoint. 
            // Here we just mock the 'last' price or fetch it if needed, but for funding rate strategies, the rate is key.
            // Let's fetch the ticker for "last" price.
            const tickerData = await this.request(`/api/v5/market/ticker?instId=${instId}`);
            
            return {
                instId,
                last: tickerData?.[0]?.last || '0',
                fundingRate: data[0].fundingRate,
                ts: data[0].fundingTime
            };
        }
      } catch (e) {
        console.warn(`Failed to fetch rate for ${coin}`, e);
      }
      return null;
    });

    const results = await Promise.all(promises);
    return results.filter((r): r is TickerData => r !== null);
  }

  async getAccountAssets(): Promise<Asset[]> {
    if (!this.config?.apiKey) return [];
    
    // Get Account Balance
    const data = await this.request('/api/v5/account/balance');
    if (!data || data.length === 0) return [];

    const details = data[0].details;
    // Calculate total equity in USD (simplified, OKX provides totalEq)
    const totalEq = parseFloat(data[0].totalEq);

    return details.map((d: any) => ({
      currency: d.ccy,
      balance: parseFloat(d.cashBal),
      available: parseFloat(d.availBal),
      equityUsd: parseFloat(d.eqUsd) // Equity in USD term
    })).filter((a: Asset) => a.equityUsd > 1 || a.balance > 0); // Filter dust
  }

  async getPositions(): Promise<Position[]> {
    if (!this.config?.apiKey) return [];

    const data = await this.request('/api/v5/account/positions');
    return data.map((p: any) => ({
      instId: p.instId,
      pos: p.pos,
      avgPx: p.avgPx,
      upl: p.upl,
      uplRatio: p.uplRatio,
      lever: p.lever,
      liqPx: p.liqPx || '0',
      mgnMode: p.mgnMode,
      cTime: parseInt(p.cTime)
    }));
  }

  async getOrders(state: 'live' | 'history' = 'live'): Promise<Order[]> {
    if (!this.config?.apiKey) return [];

    const endpoint = state === 'live' 
      ? '/api/v5/trade/orders-pending' 
      : '/api/v5/trade/orders-history?limit=20'; // Last 7 days by default

    const data = await this.request(endpoint);
    return data.map((o: any) => ({
      ordId: o.ordId,
      clOrdId: o.clOrdId,
      instId: o.instId,
      side: o.side,
      ordType: o.ordType,
      sz: o.sz,
      px: o.px,
      state: o.state,
      cTime: parseInt(o.cTime),
      fillSz: o.fillSz,
      fillPx: o.fillPx
    }));
  }

  async placeOrder(instId: string, side: 'buy' | 'sell', amount: string) {
    if (!this.config?.apiKey) throw new Error("Not connected");

    const body = {
      instId,
      tdMode: 'cross', // Default to cross margin
      side,
      ordType: 'market',
      sz: amount
    };

    const data = await this.request('/api/v5/trade/order', 'POST', body);
    return data[0];
  }
}

export const okxService = new OKXService();