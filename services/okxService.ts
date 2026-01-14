
import { OKXConfig, TickerData, Asset, Position, Order, Instrument } from '../types';

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
      await this.request('/api/v5/public/time');
      return Date.now() - start;
    } catch (e) {
      return -1;
    }
  }

  // --- 1. Account Configuration Check (Risk Management) ---
  async checkAccountConfiguration(): Promise<boolean> {
    if (!this.config?.apiKey) return false;
    try {
        const data = await this.request('/api/v5/account/config');
        const mode = data[0]?.acctLv;
        // 1: Simple, 2: Single-currency margin, 3: Multi-currency margin, 4: Portfolio margin
        // We require at least level 2 (Single-currency) to use Spot as collateral for Swap Short
        if (mode === '1') {
            console.error("Account mode is Simple. Cannot execute Arbitrage.");
            return false;
        }
        return true;
    } catch (e) {
        console.error("Failed to check account config", e);
        return false;
    }
  }

  // --- 2. Market Data Scanning ---

  async getInstruments(instType: 'SWAP' | 'SPOT' = 'SWAP'): Promise<Instrument[]> {
    if (!this.config?.apiKey) return [];
    try {
      const data = await this.request(`/api/v5/public/instruments?instType=${instType}`);
      return data.map((i: any) => ({
        instId: i.instId,
        baseCcy: i.baseCcy,
        quoteCcy: i.quoteCcy,
        ctVal: i.ctVal,
        minSz: i.minSz,
        tickSz: i.tickSz
      }));
    } catch (e) {
      console.error("Failed to fetch instruments", e);
      return [];
    }
  }

  // Fetch ALL SWAP tickers to scan for volume
  async getMarketTickers(): Promise<TickerData[]> {
      if (!this.config?.apiKey) return [];
      try {
          // 1. Get Tickers (Price & Vol)
          const tickerData = await this.request('/api/v5/market/tickers?instType=SWAP');
          
          // 2. We can't batch fetch funding rates efficiently for ALL coins in one go via public endpoint easily without instId
          // Strategy: Filter locally first by volume, then fetch funding rates for candidates.
          // Note: In a real backend, we'd use WebSocket or loop. Here we return basic data, 
          // and let the strategy fetch specific funding rates for high-vol items.
          
          return tickerData.map((t: any) => ({
              instId: t.instId,
              last: t.last,
              fundingRate: '0', // Placeholder, will be filled by detailed scan
              volCcy24h: t.volCcy24h,
              ts: t.ts
          }));
      } catch (e) {
          console.error(e);
          return [];
      }
  }

  async getFundingRate(instId: string): Promise<string> {
      try {
          const data = await this.request(`/api/v5/public/funding-rate?instId=${instId}`);
          return data[0]?.fundingRate || '0';
      } catch (e) {
          return '0';
      }
  }

  // Compatible for Dashboard
  async getFundingRates(): Promise<TickerData[]> {
    if (!this.config?.apiKey) return [];
    const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'OP'];
    const promises = coins.map(async (coin) => {
      try {
        const instId = `${coin}-USDT-SWAP`;
        const rate = await this.getFundingRate(instId);
        const ticker = await this.request(`/api/v5/market/ticker?instId=${instId}`);
        return {
            instId,
            last: ticker?.[0]?.last || '0',
            fundingRate: rate,
            volCcy24h: ticker?.[0]?.volCcy24h || '0',
            ts: Date.now().toString()
        };
      } catch (e) { return null; }
    });
    const results = await Promise.all(promises);
    return results.filter((r): r is TickerData => r !== null);
  }

  // --- 3. Atomic Execution Logic (Entry) ---

  /**
   * ATOMIC ENTRY: Buy Spot + Short Swap
   * Implements strict revert logic if second leg fails.
   */
  async executeDualSideEntry(
      instId: string, // e.g. DOGE-USDT-SWAP
      usdtAmount: number,
      instrument: Instrument
  ): Promise<{ success: boolean; message: string }> {
      const baseCcy = instrument.baseCcy; // DOGE
      const quoteCcy = instrument.quoteCcy; // USDT
      const spotInstId = `${baseCcy}-${quoteCcy}`; // DOGE-USDT

      console.log(`[EXEC] Starting Atomic Entry for ${baseCcy}. Target: $${usdtAmount}`);

      // Step 1: Market Buy Spot
      // We use 'quote_ccy' as target currency to specify USDT amount directly
      let spotOrderId = '';
      let filledCoinSz = 0;

      try {
          const spotOrder = await this.request('/api/v5/trade/order', 'POST', {
              instId: spotInstId,
              tdMode: 'cash',
              side: 'buy',
              ordType: 'market',
              tgtCcy: 'quote_ccy', // Buy with USDT amount
              sz: usdtAmount.toString()
          });
          
          if (!spotOrder || !spotOrder[0]?.ordId) {
              throw new Error("Spot order placement failed");
          }
          spotOrderId = spotOrder[0].ordId;
          
          // Step 1.5: Verify Spot Fill & Get Exact Size
          // Wait a brief moment for matching
          await new Promise(r => setTimeout(r, 500));
          
          const orderDetails = await this.request(`/api/v5/trade/order?instId=${spotInstId}&ordId=${spotOrderId}`);
          const fillSz = parseFloat(orderDetails[0]?.fillSz || '0');
          
          if (fillSz <= 0) {
              // Extremely rare for market order, but possible
              throw new Error("Spot order executed but returned 0 fill size");
          }
          filledCoinSz = fillSz;
          console.log(`[EXEC] Spot Filled: ${filledCoinSz} ${baseCcy}`);

      } catch (e) {
          return { success: false, message: `Spot Leg Failed: ${e instanceof Error ? e.message : 'Unknown'}` };
      }

      // Step 2: Market Short Swap
      try {
          // Calculate contracts based on spot fill
          // Contracts = CoinAmount / ContractValue
          // e.g. 1000 DOGE / 10 (ctVal) = 100 Contracts
          const ctVal = parseFloat(instrument.ctVal);
          const contracts = Math.floor(filledCoinSz / ctVal);

          if (contracts < 1) {
             throw new Error("Filled spot amount too small for 1 contract");
          }

          console.log(`[EXEC] Shorting Swap: ${contracts} contracts (derived from ${filledCoinSz} spot)`);

          const swapOrder = await this.request('/api/v5/trade/order', 'POST', {
              instId: instId, // DOGE-USDT-SWAP
              tdMode: 'cross', // Cross Margin - Uses Spot as collateral
              side: 'sell', // Short
              ordType: 'market',
              sz: contracts.toString()
          });

          if (swapOrder && swapOrder[0]?.ordId) {
              return { success: true, message: `Entry Successful: Long ${filledCoinSz} ${baseCcy} + Short ${contracts} lots ${instId}` };
          } else {
              throw new Error("Swap order API returned no ID");
          }

      } catch (swapError) {
          console.error(`[EXEC-FATAL] Swap Leg Failed! Initiating REVERT for ${spotInstId}`);
          
          // --- REVERT LOGIC ---
          // Immediate Market Sell of the spot we just bought
          try {
              await this.request('/api/v5/trade/order', 'POST', {
                  instId: spotInstId,
                  tdMode: 'cash',
                  side: 'sell',
                  ordType: 'market',
                  tgtCcy: 'base_ccy', // Sell specific coin amount
                  sz: filledCoinSz.toString() // Sell exactly what we bought
              });
              return { 
                  success: false, 
                  message: `Entry Failed at Swap Leg. REVERT EXECUTED: Sold ${filledCoinSz} ${baseCcy}. Reason: ${swapError instanceof Error ? swapError.message : 'Unknown'}` 
              };
          } catch (revertError) {
              return { 
                  success: false, 
                  message: `CRITICAL: Swap Failed AND Revert Failed! You hold unhedged Spot ${filledCoinSz} ${baseCcy}. Manual Intervention Required!` 
              };
          }
      }
  }

  // --- 4. Atomic Execution Logic (Exit) ---
  
  async executeDualSideExit(
      instId: string, // SWAP ID
      instrument: Instrument,
      posSizeContracts: string // Current Position Size (Contracts)
  ): Promise<{ success: boolean; message: string }> {
      const baseCcy = instrument.baseCcy;
      const spotInstId = `${baseCcy}-${instrument.quoteCcy}`;
      const contracts = Math.abs(parseInt(posSizeContracts));

      console.log(`[EXEC] Exiting ${instId}. Closing ${contracts} contracts + Selling Spot.`);

      // Parallel execution is preferred for exit to minimize leg risk, 
      // but sequential is safer for error handling. Let's do Parallel for speed in exit.
      try {
          const closeSwapPromise = this.request('/api/v5/trade/close-position', 'POST', {
              instId: instId,
              mgnMode: 'cross'
          });

          // For spot, we need to know balance, but assuming 1:1 hedge, we sell all available spot of that coin
          // Alternatively, calculate exact amount: contracts * ctVal
          const coinAmountToSell = contracts * parseFloat(instrument.ctVal);
          
          const closeSpotPromise = this.request('/api/v5/trade/order', 'POST', {
              instId: spotInstId,
              tdMode: 'cash',
              side: 'sell',
              ordType: 'market',
              tgtCcy: 'base_ccy',
              sz: coinAmountToSell.toString()
          });

          await Promise.all([closeSwapPromise, closeSpotPromise]);

          return { success: true, message: `Exit Successful for ${baseCcy}` };
      } catch (e) {
          return { success: false, message: `Exit Partial/Failed: ${e instanceof Error ? e.message : 'Unknown'}` };
      }
  }

  // --- Standard Getters ---
  async getAccountAssets(): Promise<Asset[]> {
    if (!this.config?.apiKey) return [];
    const data = await this.request('/api/v5/account/balance');
    if (!data || data.length === 0) return [];
    const details = data[0].details;
    const totalEq = parseFloat(data[0].totalEq);
    return details.map((d: any) => ({
      currency: d.ccy,
      balance: parseFloat(d.cashBal),
      available: parseFloat(d.availBal),
      equityUsd: parseFloat(d.eqUsd) 
    })).filter((a: Asset) => a.equityUsd > 1 || a.balance > 0);
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
    const endpoint = state === 'live' ? '/api/v5/trade/orders-pending' : '/api/v5/trade/orders-history?limit=20';
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
    const body = { instId, tdMode: 'cross', side, ordType: 'market', sz: amount };
    const data = await this.request('/api/v5/trade/order', 'POST', body);
    return data[0];
  }
}

export const okxService = new OKXService();
