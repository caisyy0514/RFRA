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

  /**
   * 检查账户配置：必须非简单模式 (acctLv > 1) 才能执行全仓套利
   */
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
   * 核心逻辑升级：50% 现金压舱石入场
   */
  async executeDualSideEntry(
      instId: string, 
      usdtAmount: number,
      swapInstrument: Instrument
  ): Promise<{ success: boolean; message: string }> {
      const parts = instId.split('-');
      const spotInstId = `${parts[0]}-${parts[1]}`;

      try {
          const spotInsts = await this.getInstruments('SPOT');
          const spotInfo = spotInsts.find(i => i.instId === spotInstId);
          if (!spotInfo) throw new Error(`Spot pair ${spotInstId} not found`);

          // 核心逻辑：50/50 分配
          const spotSpendUsdt = usdtAmount * 0.5;
          const cashReserveUsdt = usdtAmount * 0.5;
          
          // 实际买入时再扣除 1% 以抵消潜在手续费和价格波动
          const safeSpotAmt = (spotSpendUsdt * 0.99).toFixed(2);

          // 1. 现货买入 (利用 50% 资金)
          const spotOrder = await this.request('/api/v5/trade/order', 'POST', {
              instId: spotInstId,
              tdMode: 'cross',
              side: 'buy',
              ordType: 'market',
              tgtCcy: 'quote_ccy', 
              sz: safeSpotAmt
          });
          
          const spotOrderId = spotOrder[0]?.ordId;
          
          // 给模拟盘结算引擎 3.5 秒同步时间，确保 USDT 减少而现货增加的状态被同步到保证金池
          await new Promise(r => setTimeout(r, 3500)); 
          
          const orderDetails = await this.request(`/api/v5/trade/order?instId=${spotInstId}&ordId=${spotOrderId}`);
          const fillSz = parseFloat(orderDetails[0]?.fillSz || '0');
          if (fillSz <= 0) throw new Error("Spot fill failed: No coins received.");

          // 2. 根据实际买到的现货数量，计算对应的合约张数
          const ctVal = parseFloat(swapInstrument.ctVal);
          const contracts = Math.floor(fillSz / ctVal);

          if (contracts < 1) {
             // 自动回滚：如果买入的现货不足以支撑 1 张合约，卖出现货避免单向风险
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

          // 3. 执行合约开仓 (使用账户中剩余的 50% 现金作为保证金)
          await this.request('/api/v5/trade/order', 'POST', {
              instId: instId,
              tdMode: 'cross', 
              side: 'sell', 
              ordType: 'market',
              sz: contracts.toString()
          });

          return { 
              success: true, 
              message: `[50% 压舱石模式] 入场成功: 使用 $${safeSpotAmt} 买入 ${fillSz} ${parts[0]}, 留存约 $${cashReserveUsdt.toFixed(2)} 现金作为保证金, 开空 ${contracts} 张合约。` 
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
          // 合约平仓
          const swapPromise = this.request('/api/v5/trade/close-position', 'POST', { instId: instId, mgnMode: 'cross' });
          
          const coinAmountToSell = contracts * parseFloat(swapInstrument.ctVal);
          const spotInsts = await this.getInstruments('SPOT');
          const spotInfo = spotInsts.find(i => i.instId === spotInstId);
          const formattedSz = spotInfo ? this.formatByStep(coinAmountToSell, spotInfo.minSz) : coinAmountToSell.toString();

          // 现货卖出
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
        // 同时返回账户级的可用保证金，用于 App 的分配计算基数
        const assets = details.map((d: any) => ({
            currency: d.ccy,
            balance: parseFloat(d.cashBal),
            available: parseFloat(d.availBal),
            equityUsd: parseFloat(d.eqUsd) 
        })).filter((a: Asset) => a.equityUsd > 1 || a.balance > 0);
        
        // 扩展：在列表最后附加一个特殊的 "AVAIL_EQ" 资产，仅用于 UI/逻辑内部读取
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