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
      const baseCcy = parts[0];
      const spotInstId = `${parts[0]}-${parts[1]}`;

      try {
          // 0. 预检查
          const ticker = await this.request(`/api/v5/market/ticker?instId=${instId}`);
          const price = parseFloat(ticker[0]?.last || '0');
          const ctVal = parseFloat(swapInstrument.ctVal);
          
          if (price <= 0) throw new Error("无法获取当前市价");

          const oneContractValue = ctVal * price;
          const minRequired = oneContractValue * 2 * 1.05; // 5% buffer
          
          if (usdtAmount < minRequired) {
              return { 
                  success: false, 
                  message: `资金不足最小门槛。需 >$${minRequired.toFixed(2)}, 现有 $${usdtAmount.toFixed(2)}` 
              };
          }

          // 1. 强制 1x 杠杆
          await this.setLeverage(instId, '1', 'cross');

          const spotInsts = await this.getInstruments('SPOT');
          const spotInfo = spotInsts.find(i => i.instId === spotInstId);
          if (!spotInfo) throw new Error(`Spot pair ${spotInstId} not found`);

          // 2. 资金分配
          const spotSpendUsdt = usdtAmount * 0.5;
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
          
          // 4. 轮询成交
          let filledOrder;
          try {
              filledOrder = await this.pollOrder(spotInstId, spotOrderId);
          } catch (e) {
              console.warn("Spot order timed out, attempting cancel...");
              try { await this.request('/api/v5/trade/cancel-order', 'POST', { instId: spotInstId, ordId: spotOrderId }); } catch(err) {}
              const finalCheck = await this.request(`/api/v5/trade/order?instId=${spotInstId}&ordId=${spotOrderId}`);
              filledOrder = finalCheck[0];
          }

          // --- CRITICAL FIX: 使用 accFillSz (累计成交) 而非 fillSz ---
          const spotQty = parseFloat(filledOrder?.accFillSz || filledOrder?.fillSz || '0');
          if (spotQty <= 0) throw new Error(`Spot fill failed. accFillSz: ${filledOrder?.accFillSz}`);

          // 5. 计算张数
          const contracts = Math.floor(spotQty / ctVal);
          
          const mathMsg = `[Hedge Calc] Spot(Acc): ${spotQty}, Face: ${ctVal}, Contracts: ${contracts}`;
          console.log(mathMsg);

          // 6. 检查是否过小
          if (contracts < 1) {
             const sellSz = spotInfo ? this.formatByStep(spotQty, spotInfo.minSz) : spotQty.toString();
             console.warn(`Insufficient coins (${spotQty}) for 1 contract. Rolling back...`);
             await this.request('/api/v5/trade/order', 'POST', { 
                 instId: spotInstId, tdMode: 'cross', side: 'sell', ordType: 'market', tgtCcy: 'base_ccy', sz: sellSz
             });
             return { success: false, message: `买入量 ${spotQty} 不足1张合约。已回滚。` };
          }

          // 7. 开空合约
          await this.request('/api/v5/trade/order', 'POST', {
              instId: instId,
              tdMode: 'cross', 
              side: 'sell', 
              ordType: 'market',
              sz: contracts.toString()
          });

          // 8. 🛡️ Post-Trade Circuit Breaker (对冲结果熔断校验)
          // 给予 2秒 使得交易所更新持仓数据
          await new Promise(r => setTimeout(r, 2000));

          const [latestAssets, latestPositions] = await Promise.all([
              this.getAccountAssets(),
              this.getPositions()
          ]);

          // 获取当前真实持仓数据 (Real-time Reality Check)
          const spotAsset = latestAssets.find(a => a.currency === baseCcy);
          const currentSpotBalance = spotAsset ? spotAsset.balance : 0;
          
          const swapPos = latestPositions.find(p => p.instId === instId);
          const currentShortContracts = swapPos ? Math.abs(parseFloat(swapPos.pos)) : 0;
          const currentHedgedAmount = currentShortContracts * ctVal;

          // 计算全局 Delta 偏差
          // 理想情况: SpotBalance ≈ HedgedAmount
          const diff = Math.abs(currentSpotBalance - currentHedgedAmount);
          const deviation = currentSpotBalance > (ctVal * 5) ? (diff / currentSpotBalance) : 0; // 忽略小额噪音

          if (deviation > 0.05) { // 偏差 > 5%
              const errMsg = `[CRITICAL RISK] Hedge Deviation ${(deviation*100).toFixed(2)}% > 5%. Spot: ${currentSpotBalance}, Hedged: ${currentHedgedAmount}. EXECUTING EMERGENCY EXIT.`;
              console.error(errMsg);

              // --- 紧急逃生程序 ---
              // 1. 市价全平合约
              if (currentShortContracts > 0) {
                  await this.request('/api/v5/trade/close-position', 'POST', { instId: instId, mgnMode: 'cross' });
              }
              // 2. 市价全卖现货 (清除该币种所有余额)
              if (currentSpotBalance > 0) {
                  const sellSz = spotInfo ? this.formatByStep(currentSpotBalance, spotInfo.minSz) : currentSpotBalance.toString();
                  await this.request('/api/v5/trade/order', 'POST', {
                      instId: spotInstId,
                      tdMode: 'cross',
                      side: 'sell',
                      ordType: 'market',
                      tgtCcy: 'base_ccy',
                      sz: sellSz
                  });
              }

              return { success: false, message: errMsg };
          }

          return { 
              success: true, 
              message: `[Perfect Hedge] ${mathMsg}. Verified Delta: ${(deviation*100).toFixed(2)}%.` 
          };

      } catch (e) {
          return { success: false, message: `Entry Failed: ${e instanceof Error ? e.message : 'Unknown'}` };
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
            accFillSz: o.accFillSz, // Map accumulated fill size
            fillPx: o.fillPx
        }));
    } catch (e) { return []; }
  }
}

export const okxService = new OKXService();