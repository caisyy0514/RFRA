
import { AIAnalysisResult, TickerData } from '../types';

export const analyzeMarketConditions = async (
  marketData: TickerData[],
  strategyName: string,
  apiKey: string
): Promise<AIAnalysisResult> => {
  if (!apiKey) {
     return {
      recommendedAction: "ERROR",
      reasoning: "未配置 DeepSeek API Key，请在设置中添加。",
      riskScore: 0,
      suggestedPairs: []
    };
  }

  // Filter positive rates
  const positiveRateMarketData = marketData.filter(item => parseFloat(item.fundingRate) > 0);

  if (positiveRateMarketData.length === 0) {
      return {
          recommendedAction: "WAIT",
          reasoning: "系统风控拦截：当前市场无正资金费率 (>0) 币种。系统自动暂停开仓。",
          riskScore: 0,
          suggestedPairs: []
      };
  }

  // Format data for AI: Use calculated USDT volume
  const formattedCandidates = positiveRateMarketData
      .sort((a, b) => parseFloat(b.fundingRate) - parseFloat(a.fundingRate))
      .slice(0, 10)
      .map(t => ({
          instId: t.instId,
          fundingRate: `${(parseFloat(t.fundingRate)*100).toFixed(4)}%`,
          turnoverUsdt24h: `$${(parseFloat(t.volUsdt24h) / 1e6).toFixed(2)}M`, // Display in Millions for clarity
          lastPrice: t.last
      }));

  try {
    const prompt = `
      你是一个量化加密货币交易专家。
      请分析以下名为 "${strategyName}" 的策略的市场数据。

      策略逻辑: 期现套利 (Cash and Carry Arbitrage)
      盈利来源: 赚取多头支付给空头的资金费率。

      重要铁律:
      1. 必须资金费率 (Funding Rate) > 0 才有套利空间。
      2. turnoverUsdt24h 是折算后的真实 USDT 24小时成交额。请确保推荐的币种具有足够的流动性 (通常 > 5M USDT)。
      3. 如果成交额异常巨大 (例如单币种 > 50B USDT)，请警惕数据异常或市场操纵风险，此时应返回 WAIT。

      市场数据 (Top Candidates):
      ${JSON.stringify(formattedCandidates)}

      请严格只返回 JSON 格式，JSON 结构如下:
      {
        "recommendedAction": "BUY" | "SELL" | "HOLD" | "WAIT",
        "reasoning": "分析理由 (中文)，请重点评估流动性与费率性价比",
        "riskScore": 0-100,
        "suggestedPairs": ["币种1-USDT-SWAP"]
      }
    `;

    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "You are a quantitative trading assistant. Always output valid JSON." },
          { role: "user", content: prompt }
        ],
        temperature: 0.1 
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek 未返回内容");

    const cleanContent = content.replace(/```json/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleanContent) as AIAnalysisResult;

    // Final guard against hallucinations
    if (result.recommendedAction === 'BUY' && result.suggestedPairs.length > 0) {
       const invalidPairs = result.suggestedPairs.filter(pair => {
          const ticker = marketData.find(t => t.instId === pair);
          return !ticker || parseFloat(ticker.fundingRate) <= 0;
       });

       if (invalidPairs.length > 0) {
          return {
            recommendedAction: "WAIT",
            reasoning: `风控拦截：AI 推荐了不符合套利条件的币种 (${invalidPairs.join(', ')})。`,
            riskScore: 100,
            suggestedPairs: []
          };
       }
    }

    return result;

  } catch (error) {
    console.error("DeepSeek Analysis Failed:", error);
    return {
      recommendedAction: "ERROR",
      reasoning: `AI 服务异常: ${error instanceof Error ? error.message : '未知错误'}`,
      riskScore: 0,
      suggestedPairs: []
    };
  }
};
