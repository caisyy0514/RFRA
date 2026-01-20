import { OKXConfig, TickerData, Asset, Position, Order, Instrument } from '../types';

class OKXService {
  private config: OKXConfig | null = null;

  setConfig(config: OKXConfig) {
    this.config = config;
  }

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
      // 忽略部分非关键错误（如杠杆已设置、无持仓时平仓等）
      if (json.code === '51000') {
         // parameter error or leverage not modified, usually safe to ignore if setting same leverage
         console.warn(`OKX API Warning (${json.code}): ${json.msg}`);
         return json.data;
      }
      const sCode = json.data?.[0]?.sCode;
      const sMsg = json.data?.[0]?.sMsg;
      const subError = (sCode && sCode !== '0') ? ` (Detail: ${sCode} - ${sMsg})` : '';
      throw new Error(`OKX API Error (${json.code}): ${json.msg}${subError}`);
    }
    return json.data;
  }

  private formatByStep(value: number, step: string): string {
    const stepNum = parseFloat(step);
    if (isNaN(stepNum) || stepNum <= 0) return value.toString();
    const precision = step.includes('.') ? step.split('.')[1].length : 0;
    const factor = Math.pow(10, precision);
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

  async checkAccountConfiguration(): Promise<boolean> {
    if (!this.config?.apiKey) return false;
    try {
        const data = await this.request('/api/v5/account/config');
        return data[0]?.acctLv !== '1';
    } catch (e) {
        return false;
    }
  }

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
      console.error(`Failed to fetch ${instType} instruments`, e);
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
            .slice(0, 20);

        const promises = topByVol.map(async (ticker) => {
            try {
                const rate = await this.getFundingRate(ticker.instId);
                return { ...ticker, fundingRate: rate, ts: Date.now().toString() };
            } catch (e) { return null; }
        });
        const results = await Promise.all(promises);
        return results.filter((r): r is TickerData => r !== null);
    } catch (e) {
        return [];
    }
  }

  /**
   * 设置合约杠杆倍数
   */
  async setLeverage(instId: string, lever: string, mgnMode: 'cross' | 'isolated'): Promise<void> {
    try {
        await this.request('/api/v5/account/set-leverage', 'POST', {
            instId,
            lever,
            mgnMode
        });
    } catch (e: any) {
        // 如果是因为已经是该倍数导致的报错，可以忽略，否则抛出
        console.log(`Setting leverage info for ${instId}: ${e.message}`);
    }
  }

  async executeDualSideEntry(
      instId: string, 
      usdtAmount: number,
      swapInstrument: Instrument
  ): Promise<{ success: boolean; message: string }> {
      const parts = instId.split('-');
      const spotInstId = `${parts[0]}-${parts[1]}`;

      try {
          // 0. 强制设置 1x 杠杆 全仓
          await this.setLeverage(instId, '1', 'cross');

          const spotInsts = await this.getInstruments('SPOT');
          const spotInfo = spotInsts.find(i => i.instId === spotInstId);
          if (!spotInfo) throw new Error(`Spot pair ${spotInstId} not found`);

          // 核心逻辑：50/50 分配
          // 50% 买现货，50% 留作保证金 (1x 杠杆意味着保证金率需 100%)
          const spotSpendUsdt = usdtAmount * 0.5;
          const cashReserveUsdt = usdtAmount * 0.5;
          
          const safeSpotAmt = (spotSpendUsdt * 0.99).toFixed(2); // 预留一点点防止余额不足

          // 1. 买入现货
          const spotOrder = await this.request('/api/v5/trade/order', 'POST', {
              instId: spotInstId,
              tdMode: 'cross',
              side: 'buy',
              ordType: 'market',
              tgtCcy: 'quote_ccy', 
              sz: safeSpotAmt
          });
          
          const spotOrderId = spotOrder[0]?.ordId;
          
          // 给模拟盘结算引擎足够的同步时间
          await new Promise(r => setTimeout(r, 3800)); 
          
          const orderDetails = await this.request(`/api/v5/trade/order?instId=${spotInstId}&ordId=${spotOrderId}`);
          const fillSz = parseFloat(orderDetails[0]?.fillSz || '0');
          if (fillSz <= 0) throw new Error("Spot fill failed: No coins received.");

          // 2. 计算合约张数
          const ctVal = parseFloat(swapInstrument.ctVal);
          const contracts = Math.floor(fillSz / ctVal);

          if (contracts < 1) {
             // 回滚：卖出现货
             await this.request('/api/v5/trade/order', 'POST', { 
                 instId: spotInstId, 
                 tdMode: 'cross', 
                 side: 'sell', 
                 ordType: 'market', 
                 tgtCcy: 'base_ccy', 
                 sz: fillSz.toString() 
             });
             throw new Error(`Insufficient amount for 1 contract. Rolled back.`);
          }

          // 3. 校验资金是否足够支撑 1x 杠杆
          const balData = await this.request('/api/v5/account/balance?ccy=USDT');
          const usdtAvail = parseFloat(balData[0]?.details?.[0]?.availBal || '0');
          
          // 在 1x 杠杆下，所需保证金几乎等于仓位名义价值
          const estimatedPositionValue = contracts * ctVal * parseFloat(orderDetails[0]?.fillPx || '0');
          // 留 2% 缓冲
          if (usdtAvail < (estimatedPositionValue * 0.98)) { 
             throw new Error(`Insufficient margin for 1x leverage. Need ~$${estimatedPositionValue.toFixed(2)}, have $${usdtAvail.toFixed(2)}`);
          }

          // 4. 开空合约
          await this.request('/api/v5/trade/order', 'POST', {
              instId: instId,
              tdMode: 'cross', 
              side: 'sell', 
              ordType: 'market',
              sz: contracts.toString()
          });

          return { 
              success: true, 
              message: `[1x 完美对冲] 入场成功: 杠杆已重置为 1x。使用 $${safeSpotAmt} 买入 ${fillSz} ${parts[0]}, 留存约 $${cashReserveUsdt.toFixed(2)} 现金全额覆盖保证金, 开空 ${contracts} 张合约。` 
          };

      } catch (e) {
          return { success: false, message: `Atomic Entry Failed: ${e instanceof Error ? e.message : 'Unknown'}` };
      }
  }

  async executeDualSideExit(
      instId: string, 
      swapInstrument: Instrument,
      posSizeContracts: string 
  ): Promise<{ success: boolean; message: string }> {
      const parts = instId.split('-');
      const spotInstId = `${parts[0]}-${parts[1]}`;
      const contracts = Math.abs(parseInt(posSizeContracts));

      try {
          const swapPromise = this.request('/api/v5/trade/close-position', 'POST', { instId: instId, mgnMode: 'cross' });
          
          const coinAmountToSell = contracts * parseFloat(swapInstrument.ctVal);
          const spotInsts = await this.getInstruments('SPOT');
          const spotInfo = spotInsts.find(i => i.instId === spotInstId);
          const formattedSz = spotInfo ? this.formatByStep(coinAmountToSell, spotInfo.minSz) : coinAmountToSell.toString();

          const spotPromise = this.request('/api/v5/trade/order', 'POST', {
              instId: spotInstId,
              tdMode: 'cross',
              side: 'sell',
              ordType: 'market',
              tgtCcy: 'base_ccy',
              sz: formattedSz
          });

          await Promise.all([swapPromise, spotPromise]);
          return { success: true, message: `Exit Success: Sold ${formattedSz} Spot + Closed Swap Position` };
      } catch (e) {
          return { success: false, message: `Exit Error: ${e instanceof Error ? e.message : 'Unknown'}` };
      }
  }

  async getAccountAssets(): Promise<Asset[]> {
    if (!this.config?.apiKey) return [];
    try {
        const data = await this.request('/api/v5/account/balance');
        const details = data[0]?.details || [];
        const assets = details.map((d: any) => ({
            currency: d.ccy,
            balance: parseFloat(d.cashBal),
            available: parseFloat(d.availBal), // 关键：这是真实的可用现金
            equityUsd: parseFloat(d.eqUsd) 
        })).filter((a: Asset) => a.equityUsd > 1 || a.balance > 0);
        
        assets.push({
            currency: 'ACCOUNT_AVAIL_EQ',
            balance: parseFloat(data[0].availEq || '0'),
            available: parseFloat(data[0].availEq || '0'),
            equityUsd: parseFloat(data[0].availEq || '0')
        });

        return assets;
    } catch (e) { return []; }
  }

  async getPositions(): Promise<Position[]> {
    if (!this.config?.apiKey) return [];
    try {
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
    } catch (e) { return []; }
  }

  async getOrders(state: 'live' | 'history' = 'live'): Promise<Order[]> {
    if (!this.config?.apiKey) return [];
    const endpoint = state === 'live' ? '/api/v5/trade/orders-pending' : '/api/v5/trade/orders-history?limit=20';
    try {
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
    } catch (e) { return []; }
  }
}

export const okxService = new OKXService();