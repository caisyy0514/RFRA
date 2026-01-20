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

  /**
   * 轮询订单状态直到成交或超时
   */
  async pollOrder(instId: string, ordId: string, maxRetries = 10): Promise<any> {
    for (let i = 0; i < maxRetries; i++) {
        // 等待 500ms
        await new Promise(r => setTimeout(r, 500));
        
        const orders = await this.request(`/api/v5/trade/order?instId=${instId}&ordId=${ordId}`);
        const order = orders[0];
        
        if (!order) continue;
        
        // 状态: live (等待成交), filled (完全成交), canceled (撤单)
        // 注意: partially_filled 也是 live 状态的一种，但在 OKX API 中通常 state=live, accFillSz > 0
        if (order.state === 'filled') {
            return order;
        }
        
        if (order.state === 'canceled') {
            throw new Error('Order was canceled by system.');
        }
    }
    // 超时处理
    throw new Error('Order polling timed out (not filled in 5s).');
  }

  async executeDualSideEntry(
      instId: string, 
      usdtAmount: number,
      swapInstrument: Instrument
  ): Promise<{ success: boolean; message: string }> {
      const parts = instId.split('-');
      const spotInstId = `${parts[0]}-${parts[1]}`;

      try {
          // 0. 预检查：获取价格，计算最低资金门槛
          const ticker = await this.request(`/api/v5/market/ticker?instId=${instId}`);
          const price = parseFloat(ticker[0]?.last || '0');
          const ctVal = parseFloat(swapInstrument.ctVal);
          
          if (price <= 0) throw new Error("无法获取当前市价");

          // 最小 1 张合约对应的现货价值 + 保证金
          const oneContractValue = ctVal * price;
          const minRequired = oneContractValue * 2 * 1.05; // 5% 缓冲
          
          if (usdtAmount < minRequired) {
              return { 
                  success: false, 
                  message: `资金不足以开设最小头寸。需 >$${minRequired.toFixed(2)} (1张合约 $${oneContractValue.toFixed(2)} x 2 + buffer), 现有 $${usdtAmount.toFixed(2)}` 
              };
          }

          // 1. 强制设置 1x 杠杆 全仓
          await this.setLeverage(instId, '1', 'cross');

          const spotInsts = await this.getInstruments('SPOT');
          const spotInfo = spotInsts.find(i => i.instId === spotInstId);
          if (!spotInfo) throw new Error(`Spot pair ${spotInstId} not found`);

          // 2. 资金分配
          const spotSpendUsdt = usdtAmount * 0.5;
          const cashReserveUsdt = usdtAmount * 0.5;
          const safeSpotAmt = (spotSpendUsdt * 0.99).toFixed(2); 

          // 3. 买入现货
          const spotOrder = await this.request('/api/v5/trade/order', 'POST', {
              instId: spotInstId,
              tdMode: 'cross',
              side: 'buy',
              ordType: 'market',
              tgtCcy: 'quote_ccy', 
              sz: safeSpotAmt
          });
          
          const spotOrderId = spotOrder[0]?.ordId;
          if (!spotOrderId) throw new Error("Failed to place spot order");
          
          // 4. 轮询等待成交 (替代死板的 sleep)
          let filledOrder;
          try {
              filledOrder = await this.pollOrder(spotInstId, spotOrderId);
          } catch (e) {
              // 若超时，尝试撤单并检查是否部分成交
              console.warn("Spot order timed out, attempting cancel...");
              try { await this.request('/api/v5/trade/cancel-order', 'POST', { instId: spotInstId, ordId: spotOrderId }); } catch(err) {}
              // 再次查询最终状态
              const finalCheck = await this.request(`/api/v5/trade/order?instId=${spotInstId}&ordId=${spotOrderId}`);
              filledOrder = finalCheck[0];
          }

          const fillSz = parseFloat(filledOrder?.fillSz || '0');
          if (fillSz <= 0) throw new Error("Spot fill failed: No coins received after polling.");

          // 5. 计算合约张数
          const contracts = Math.floor(fillSz / ctVal);

          // -----------------------------------------------------
          // 关键点：若计算出的张数为 0，说明买入的币不够一张合约
          // 必须回滚（卖出现货），否则会有裸现货敞口
          // -----------------------------------------------------
          if (contracts < 1) {
             const sellSz = spotInfo ? this.formatByStep(fillSz, spotInfo.minSz) : fillSz.toString();
             console.warn(`Insufficient coins (${fillSz}) for 1 contract (ctVal ${ctVal}). Rolling back...`);
             
             await this.request('/api/v5/trade/order', 'POST', { 
                 instId: spotInstId, 
                 tdMode: 'cross', 
                 side: 'sell', 
                 ordType: 'market', 
                 tgtCcy: 'base_ccy', 
                 sz: sellSz
             });
             
             return { success: false, message: `资金购买量 (${fillSz} ${parts[0]}) 不足 1 张合约 (${ctVal} ${parts[0]}). 已执行自动回滚卖出。` };
          }

          // 6. 校验保证金是否足够
          const balData = await this.request('/api/v5/account/balance?ccy=USDT');
          const usdtAvail = parseFloat(balData[0]?.details?.[0]?.availBal || '0');
          const estimatedPositionValue = contracts * ctVal * parseFloat(filledOrder.fillPx || price.toString());
          
          if (usdtAvail < (estimatedPositionValue * 0.98)) { 
             // 同样的，如果保证金不够，也要回滚现货
             const sellSz = spotInfo ? this.formatByStep(fillSz, spotInfo.minSz) : fillSz.toString();
             await this.request('/api/v5/trade/order', 'POST', { 
                 instId: spotInstId, 
                 tdMode: 'cross', 
                 side: 'sell', 
                 ordType: 'market', 
                 tgtCcy: 'base_ccy', 
                 sz: sellSz 
             });
             return { success: false, message: `保证金不足以维持 1x 杠杆 (需 ~$${estimatedPositionValue.toFixed(2)}, 有 $${usdtAvail.toFixed(2)}). 已回滚。` };
          }

          // 7. 开空合约
          await this.request('/api/v5/trade/order', 'POST', {
              instId: instId,
              tdMode: 'cross', 
              side: 'sell', 
              ordType: 'market',
              sz: contracts.toString()
          });

          return { 
              success: true, 
              message: `[1x 完美对冲] 入场成功: 买入 ${fillSz} ${parts[0]} (合约面值 ${ctVal}), 开空 ${contracts} 张。` 
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