import { OKXConfig, TickerData, Asset, Position, Order, Instrument } from '../types';

class OKXService {
  private config: OKXConfig | null = null;
  private instrumentsCache: Instrument[] = [];

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

  /**
   * 格式化数量或价格以符合 OKX 步长要求
   */
  private formatByStep(value: number, step: string): string {
    const stepNum = parseFloat(step);
    if (isNaN(stepNum) || stepNum <= 0) return value.toString();
    
    // 计算小数位数
    const precision = step.includes('.') ? step.split('.')[1].length : 0;
    // 按步长向下取整，防止超出余额
    const factor = 1 / stepNum;
    const rounded = Math.floor(value * factor) / factor;
    return rounded.toFixed(precision);
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
      const insts = data.map((i: any) => ({
        instId: i.instId,
        baseCcy: i.baseCcy,
        quoteCcy: i.quoteCcy,
        ctVal: i.ctVal,
        minSz: i.minSz,
        tickSz: i.tickSz
      }));
      this.instrumentsCache = insts;
      return insts;
    } catch (e) {
      console.error("Failed to fetch instruments", e);
      return [];
    }
  }

  async getMarketTickers(): Promise<TickerData[]> {
      if (!this.config?.apiKey) return [];
      try {
          const tickerData = await this.request('/api/v5/market/tickers?instType=SWAP');
          return tickerData.map((t: any) => {
              const lastPrice = parseFloat(t.last);
              const volCcy = parseFloat(t.volCcy24h);
              // For SWAP, volCcy24h is the volume in COINS. 
              // To get USDT turnover, we multiply by the last price.
              const calculatedVolUsdt = (volCcy * lastPrice).toString();
              
              return {
                  instId: t.instId,
                  last: t.last,
                  fundingRate: '0', 
                  volCcy24h: t.volCcy24h,
                  volUsdt24h: calculatedVolUsdt,
                  ts: t.ts
              };
          });
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

  async getFundingRates(): Promise<TickerData[]> {
    if (!this.config?.apiKey) return [];
    try {
        const allTickers = await this.getMarketTickers();
        const topByVol = allTickers
            .filter(t => t.instId.endsWith('-USDT-SWAP'))
            .sort((a, b) => parseFloat(b.volUsdt24h) - parseFloat(a.volUsdt24h))
            .slice(0, 15);

        const promises = topByVol.map(async (ticker) => {
            try {
                const rate = await this.getFundingRate(ticker.instId);
                return {
                    ...ticker,
                    fundingRate: rate,
                    ts: Date.now().toString()
                };
            } catch (e) { return null; }
        });
        
        const results = await Promise.all(promises);
        return results.filter((r): r is TickerData => r !== null);
    } catch (e) {
        console.error("Failed to fetch dynamic funding rates", e);
        return [];
    }
  }

  // --- 3. Atomic Execution Logic ---

  async executeDualSideEntry(
      instId: string, 
      usdtAmount: number,
      instrument: Instrument
  ): Promise<{ success: boolean; message: string }> {
      const baseCcy = instrument.baseCcy;
      const quoteCcy = instrument.quoteCcy;
      const spotInstId = `${baseCcy}-${quoteCcy}`;

      console.log(`[EXEC] Starting Atomic Entry for ${baseCcy}. Target: $${usdtAmount}`);

      let spotOrderId = '';
      let filledCoinSz = 0;

      try {
          // 1. 获取现货实时价格以计算购买币数，解决 tgtCcy: 'quote_ccy' 在模拟盘的失败问题
          const tickerRes = await this.request(`/api/v5/market/ticker?instId=${spotInstId}`);
          const spotPrice = parseFloat(tickerRes[0]?.last || '0');
          if (spotPrice <= 0) throw new Error("Could not fetch spot market price");

          // 2. 获取现货币种的精度元数据
          const spotInsts = await this.getInstruments('SPOT');
          const spotInfo = spotInsts.find(i => i.instId === spotInstId);
          if (!spotInfo) throw new Error(`Instrument metadata not found for ${spotInstId}`);

          // 3. 计算预估购买数量并进行精度截断
          const estimatedSz = (usdtAmount * 0.99) / spotPrice; // 留 1% 空间防滑点/手续费
          const formattedSz = this.formatByStep(estimatedSz, spotInfo.minSz);

          if (parseFloat(formattedSz) <= 0) {
              throw new Error(`Calculated size ${formattedSz} is too small for minSz ${spotInfo.minSz}`);
          }

          console.log(`[EXEC] Spot Order: Buy ${formattedSz} ${baseCcy} at ~$${spotPrice}`);

          // 4. 执行现货买入 (改为 base_ccy 模式)
          const spotOrder = await this.request('/api/v5/trade/order', 'POST', {
              instId: spotInstId,
              tdMode: 'cash',
              side: 'buy',
              ordType: 'market',
              tgtCcy: 'base_ccy', 
              sz: formattedSz
          });
          
          if (!spotOrder || !spotOrder[0]?.ordId) {
              throw new Error("Spot order placement failed");
          }
          spotOrderId = spotOrder[0].ordId;
          
          // 等待成交
          await new Promise(r => setTimeout(r, 800));
          
          const orderDetails = await this.request(`/api/v5/trade/order?instId=${spotInstId}&ordId=${spotOrderId}`);
          const fillSz = parseFloat(orderDetails[0]?.fillSz || '0');
          
          if (fillSz <= 0) {
              throw new Error("Spot order executed but returned 0 fill size (Check USDT balance)");
          }
          filledCoinSz = fillSz;

      } catch (e) {
          return { success: false, message: `Spot Leg Failed: ${e instanceof Error ? e.message : 'Unknown'}` };
      }

      try {
          // 5. 计算对应的永续合约张数
          const ctVal = parseFloat(instrument.ctVal);
          const rawContracts = filledCoinSz / ctVal;
          // 合约张数必须为整数 (OKX 规定)
          const contracts = Math.floor(rawContracts);

          if (contracts < 1) {
             throw new Error(`Filled spot amount (${filledCoinSz}) too small for 1 contract (ctVal: ${ctVal})`);
          }

          console.log(`[EXEC] Swap Order: Sell ${contracts} lots of ${instId}`);

          const swapOrder = await this.request('/api/v5/trade/order', 'POST', {
              instId: instId,
              tdMode: 'cross', 
              side: 'sell', 
              ordType: 'market',
              sz: contracts.toString()
          });

          if (swapOrder && swapOrder[0]?.ordId) {
              return { success: true, message: `Entry Successful: Long ${filledCoinSz} ${baseCcy} + Short ${contracts} lots ${instId}` };
          } else {
              throw new Error("Swap order API returned no ID");
          }

      } catch (swapError) {
          // 容错：如果合约侧失败，必须卖出现货以对冲风险
          try {
              console.warn(`[REVERT] Swap side failed, selling back spot: ${filledCoinSz} ${baseCcy}`);
              await this.request('/api/v5/trade/order', 'POST', {
                  instId: spotInstId,
                  tdMode: 'cash',
                  side: 'sell',
                  ordType: 'market',
                  tgtCcy: 'base_ccy', 
                  sz: filledCoinSz.toString()
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

  async executeDualSideExit(
      instId: string, 
      instrument: Instrument,
      posSizeContracts: string 
  ): Promise<{ success: boolean; message: string }> {
      const baseCcy = instrument.baseCcy;
      const spotInstId = `${baseCcy}-${instrument.quoteCcy}`;
      const contracts = Math.abs(parseInt(posSizeContracts));

      try {
          // 1. 平掉永续仓位
          const closeSwapPromise = this.request('/api/v5/trade/close-position', 'POST', {
              instId: instId,
              mgnMode: 'cross'
          });

          // 2. 卖出对应现货
          const coinAmountToSell = contracts * parseFloat(instrument.ctVal);
          
          // 获取现货精度
          const spotInsts = await this.getInstruments('SPOT');
          const spotInfo = spotInsts.find(i => i.instId === spotInstId);
          const formattedSz = spotInfo ? this.formatByStep(coinAmountToSell, spotInfo.minSz) : coinAmountToSell.toString();

          const closeSpotPromise = this.request('/api/v5/trade/order', 'POST', {
              instId: spotInstId,
              tdMode: 'cash',
              side: 'sell',
              ordType: 'market',
              tgtCcy: 'base_ccy',
              sz: formattedSz
          });

          await Promise.all([closeSwapPromise, closeSpotPromise]);

          return { success: true, message: `Exit Successful for ${baseCcy}` };
      } catch (e) {
          return { success: false, message: `Exit Partial/Failed: ${e instanceof Error ? e.message : 'Unknown'}` };
      }
  }

  async getAccountAssets(): Promise<Asset[]> {
    if (!this.config?.apiKey) return [];
    const data = await this.request('/api/v5/account/balance');
    if (!data || data.length === 0) return [];
    const details = data[0].details;
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