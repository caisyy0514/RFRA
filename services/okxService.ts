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
      // 忽略部分非关键错误
      if (json.code === '51000') {
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

  /**
   * 向上取整到指定精度 (用于买入，确保数量足够覆盖手续费)
   * e.g. val=1.0000001, step=0.00001 => 1.00001
   */
  private ceilToPrecision(value: number, step: string): string {
    const stepNum = parseFloat(step);
    if (isNaN(stepNum) || stepNum <= 0) return value.toString();
    const precision = step.includes('.') ? step.split('.')[1].length : 0;
    
    // 使用乘法放大再取整可能溢出，改用更安全的计算方式
    // Math.ceil(value / step) * step
    const inverse = 1 / stepNum;
    const rounded = Math.ceil(value * inverse) / inverse;
    return rounded.toFixed(precision);
  }

  /**
   * 向下取整到指定精度 (用于卖出，确保符合交易所规范)
   */
  private floorToPrecision(value: number, step: string): string {
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
        tickSz: i.tickSz,
        lotSz: i.lotSz // 关键字段：数量精度
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

  async setLeverage(instId: string, lever: string, mgnMode: 'cross' | 'isolated'): Promise<void> {
    try {
        await this.request('/api/v5/account/set-leverage', 'POST', {
            instId,
            lever,
            mgnMode
        });
    } catch (e: any) {
        console.log(`Setting leverage info for ${instId}: ${e.message}`);
    }
  }

  async pollOrder(instId: string, ordId: string, maxRetries = 10): Promise<any> {
    for (let i = 0; i < maxRetries; i++) {
        await new Promise(r => setTimeout(r, 500));
        const orders = await this.request(`/api/v5/trade/order?instId=${instId}&ordId=${ordId}`);
        const order = orders[0];
        if (!order) continue;
        if (order.state === 'filled') return order;
        if (order.state === 'canceled') throw new Error('Order was canceled by system.');
    }
    throw new Error('Order polling timed out (not filled in 5s).');
  }

  /**
   * V3.0 Precision-First Zero-Dust Entry Protocol
   * 1. 根据资金计算最大整数合约张数 (Anchor)
   * 2. 逆推所需现货数量 (Reverse Calc)
   * 3. 加上手续费损耗缓冲 (Fee Buffer)
   * 4. 向上取整到 Spot lotSz (Ceil Precision)
   * 5. 执行原子下单
   */
  async executeDualSideEntry(
      instId: string, 
      usdtAmount: number,
      swapInstrument: Instrument
  ): Promise<{ success: boolean; message: string }> {
      const parts = instId.split('-');
      const baseCcy = parts[0];
      const spotInstId = `${parts[0]}-${parts[1]}`;

      try {
          // 1. 获取基础数据
          const [ticker, spotInsts] = await Promise.all([
              this.request(`/api/v5/market/ticker?instId=${instId}`),
              this.getInstruments('SPOT')
          ]);
          
          const price = parseFloat(ticker[0]?.last || '0');
          const spotInfo = spotInsts.find(i => i.instId === spotInstId);

          if (price <= 0) throw new Error("无法获取当前市价");
          if (!spotInfo) throw new Error(`Spot pair ${spotInstId} not found`);

          // 2. 计算最大可开合约张数 (Anchor)
          const ctVal = parseFloat(swapInstrument.ctVal);
          const oneContractValue = ctVal * price;
          
          // 预留 5% 作为波动缓冲
          const availableForOneSide = usdtAmount * 0.48; 
          
          // Max Contracts = Floor(Funds / UnitValue)
          const maxContracts = Math.floor(availableForOneSide / oneContractValue);
          
          if (maxContracts < parseFloat(swapInstrument.minSz)) {
               return { success: false, message: `资金不足最小合约单位。至少需: $${(oneContractValue * parseFloat(swapInstrument.minSz)).toFixed(2)}` };
          }

          // 3. 逆推目标现货量 (Target Spot)
          const targetSpotQty = maxContracts * ctVal;

          // 4. 计算含手续费的买单量 (Fee Adjusted)
          // Taker fee 0.1% => Need to buy Target / (1 - 0.001)
          const estimatedFeeRate = 0.001;
          const rawBuySize = targetSpotQty / (1 - estimatedFeeRate);

          // 5. 现货精度对齐 (Precision Alignment - Ceil)
          // 向上取整，宁可多买一点(Dust)，不能少买(Naked Short)
          const finalSpotSz = this.ceilToPrecision(rawBuySize, spotInfo.lotSz);

          console.log(`[Entry Plan] Contracts: ${maxContracts}, TargetSpot: ${targetSpotQty}, WithFee: ${rawBuySize}, FinalOrder: ${finalSpotSz}`);

          // 6. 执行操作
          await this.setLeverage(instId, '1', 'cross');

          // 6.1 买入现货 (使用 base_ccy 模式买币)
          const spotOrder = await this.request('/api/v5/trade/order', 'POST', {
              instId: spotInstId,
              tdMode: 'cross',
              side: 'buy',
              ordType: 'market',
              tgtCcy: 'base_ccy', // 关键：按币买
              sz: finalSpotSz
          });

          const spotOrderId = spotOrder[0]?.ordId;
          if (!spotOrderId) throw new Error("Failed to place spot order");

          // 等待成交
          let filledSpot;
          try {
              filledSpot = await this.pollOrder(spotInstId, spotOrderId);
          } catch (e) {
              // 超时也不要紧，只要成交了部分或全部，我们后续按实际成交量开合约
              console.warn("Spot order polling timeout/error. Checking status...");
          }
          
          // 重新查询订单确认成交量
          const checkOrder = await this.request(`/api/v5/trade/order?instId=${spotInstId}&ordId=${spotOrderId}`);
          const actualSpotFilled = parseFloat(checkOrder[0]?.accFillSz || '0');

          if (actualSpotFilled <= 0) {
              return { success: false, message: "Spot buy failed (No fill)." };
          }

          // 7. 根据实际现货成交量重新计算合约 (Double Safe)
          // 虽然我们计算得很精准，但防止交易所因为某种原因没完全成交
          // Contracts = Floor(ActualSpot / ctVal)
          const safeContracts = Math.floor(actualSpotFilled / ctVal);

          if (safeContracts < 1) {
              // 极端情况：买入失败回滚
              await this.request('/api/v5/trade/order', 'POST', { 
                 instId: spotInstId, tdMode: 'cross', side: 'sell', ordType: 'market', tgtCcy: 'base_ccy', sz: actualSpotFilled.toString()
              });
              return { success: false, message: `成交现货 ${actualSpotFilled} 不足1张合约，已回滚。` };
          }

          // 8. 开空合约
          await this.request('/api/v5/trade/order', 'POST', {
              instId: instId,
              tdMode: 'cross', 
              side: 'sell', 
              ordType: 'market',
              sz: safeContracts.toString()
          });

          return { 
              success: true, 
              message: `[Precision Entry] Spot: ${actualSpotFilled}, Swap: ${safeContracts} (${safeContracts*ctVal}). Delta ~0.` 
          };

      } catch (e) {
          return { success: false, message: `Entry Failed: ${e instanceof Error ? e.message : 'Unknown'}` };
      }
  }

  /**
   * 自动再平衡 (Auto-Rebalancing)
   * 扫描持仓，计算 Delta，自动买入补齐或卖出多余现货
   */
  async auditAndRebalance(instId: string): Promise<{ success: boolean; message: string }> {
     try {
         const parts = instId.split('-');
         const baseCcy = parts[0];
         const spotInstId = `${parts[0]}-${parts[1]}`;

         const [positions, assets, swapInsts, spotInsts] = await Promise.all([
             this.getPositions(),
             this.getAccountAssets(),
             this.getInstruments('SWAP'),
             this.getInstruments('SPOT')
         ]);

         const pos = positions.find(p => p.instId === instId);
         if (!pos) return { success: false, message: "No position found." };

         const swapInfo = swapInsts.find(i => i.instId === instId);
         const spotInfo = spotInsts.find(i => i.instId === spotInstId);
         if (!swapInfo || !spotInfo) return { success: false, message: "Metadata missing." };

         const spotAsset = assets.find(a => a.currency === baseCcy);
         const balance = spotAsset ? spotAsset.balance : 0;
         const contracts = Math.abs(parseFloat(pos.pos));
         const ctVal = parseFloat(swapInfo.ctVal);

         const targetSpot = contracts * ctVal;
         const diff = balance - targetSpot; // 正数=现货多，负数=现货少
         
         const absDiff = Math.abs(diff);
         // 忽略极小误差 (小于 1/10 的 minSz 或 价值极低)
         const minSpotSz = parseFloat(spotInfo.minSz);
         if (absDiff < minSpotSz * 0.5) {
             return { success: true, message: "Perfectly balanced." };
         }

         // Case 1: 现货多了 (Excess Spot)
         if (diff > 0) {
             // 检查是否多到可以开新的一张合约
             // NewContracts = Floor(Diff / ctVal)
             const newContracts = Math.floor(diff / ctVal);
             
             if (newContracts >= parseFloat(swapInfo.minSz)) {
                 // 够开新合约 -> 开空
                 await this.request('/api/v5/trade/order', 'POST', {
                    instId: instId, tdMode: 'cross', side: 'sell', ordType: 'market', sz: newContracts.toString()
                 });
                 return { success: true, message: `Opened ${newContracts} new contracts to cover excess spot.` };
             } else {
                 // 不够开合约 -> 扫尘 (卖出多余现货)
                 const sellSz = this.floorToPrecision(diff, spotInfo.lotSz);
                 if (parseFloat(sellSz) >= parseFloat(spotInfo.minSz)) {
                     await this.request('/api/v5/trade/order', 'POST', {
                        instId: spotInstId, tdMode: 'cross', side: 'sell', ordType: 'market', tgtCcy: 'base_ccy', sz: sellSz
                     });
                     return { success: true, message: `Sold dust (${sellSz}) to match contracts.` };
                 }
                 return { success: true, message: "Dust too small to sell." };
             }
         } 
         // Case 2: 现货少了 (Deficit Spot - Naked Short Risk)
         else {
            const shortage = absDiff;
            // 补单需考虑手续费
            const estimatedFeeRate = 0.001;
            const rawBuySize = shortage / (1 - estimatedFeeRate);
            const buySz = this.ceilToPrecision(rawBuySize, spotInfo.lotSz);
            
            if (parseFloat(buySz) >= parseFloat(spotInfo.minSz)) {
                await this.request('/api/v5/trade/order', 'POST', {
                    instId: spotInstId, tdMode: 'cross', side: 'buy', ordType: 'market', tgtCcy: 'base_ccy', sz: buySz
                });
                return { success: true, message: `Bought ${buySz} spot to cover naked short.` };
            }
            
            // 如果缺口实在太小买不了，可能需要平掉一张合约来平衡 (暂不实现，优先买入)
            return { success: false, message: "Shortage too small to buy, but exists." };
         }

     } catch (e) {
         return { success: false, message: `Rebalance Error: ${e instanceof Error ? e.message : 'Unknown'}` };
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
          // 1. 平合约
          const swapPromise = this.request('/api/v5/trade/close-position', 'POST', { instId: instId, mgnMode: 'cross' });
          
          // 2. 卖现货 (全卖，不论多少，扫清残余)
          // 获取当前持仓余额
          const spotAsset = (await this.getAccountAssets()).find(a => a.currency === parts[0]);
          const balance = spotAsset ? spotAsset.balance : 0;
          
          const spotInsts = await this.getInstruments('SPOT');
          const spotInfo = spotInsts.find(i => i.instId === spotInstId);
          
          let spotPromise = Promise.resolve();
          if (balance > 0 && spotInfo) {
              const sellSz = this.floorToPrecision(balance, spotInfo.lotSz);
              if (parseFloat(sellSz) >= parseFloat(spotInfo.minSz)) {
                spotPromise = this.request('/api/v5/trade/order', 'POST', {
                    instId: spotInstId,
                    tdMode: 'cross',
                    side: 'sell',
                    ordType: 'market',
                    tgtCcy: 'base_ccy',
                    sz: sellSz
                });
              }
          }

          await Promise.all([swapPromise, spotPromise]);
          return { success: true, message: `Exit Success` };
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
            accFillSz: o.accFillSz, 
            fillPx: o.fillPx
        }));
    } catch (e) { return []; }
  }
}

export const okxService = new OKXService();