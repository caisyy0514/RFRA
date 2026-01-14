import { GoogleGenAI, Type } from "@google/genai";
import { AIAnalysisResult, TickerData } from '../types';

/**
 * Uses Gemini API to analyze market conditions for arbitrage opportunities.
 * Model 'gemini-3-pro-preview' is used for its advanced reasoning capabilities in financial analysis.
 */
export const analyzeMarketConditions = async (
  marketData: TickerData[],
  strategyName: string
): Promise<AIAnalysisResult> => {
  // Obtain API Key exclusively from environment variable as per security guidelines.
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

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
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: prompt,
      config: {
        systemInstruction: "You are a quantitative trading assistant specialized in crypto arbitrage. Provide a JSON response based on the analysis of provided market data.",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            recommendedAction: {
              type: Type.STRING,
              description: "Final decision: BUY, SELL, HOLD, or WAIT.",
            },
            reasoning: {
              type: Type.STRING,
              description: "Reasoning for the decision in Chinese.",
            },
            riskScore: {
              type: Type.NUMBER,
              description: "Risk evaluation score from 0 (safe) to 100 (high risk).",
            },
            suggestedPairs: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "Array of instrument IDs suggested for entry.",
            }
          },
          required: ["recommendedAction", "reasoning", "riskScore", "suggestedPairs"],
          propertyOrdering: ["recommendedAction", "reasoning", "riskScore", "suggestedPairs"]
        },
      }
    });

    const result = JSON.parse(response.text.trim()) as AIAnalysisResult;

    // Final guard against hallucinations: verify that suggested pairs actually meet basic criteria.
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
    console.error("Gemini Analysis Failed:", error);
    return {
      recommendedAction: "ERROR",
      reasoning: `AI 服务异常: ${error instanceof Error ? error.message : '未知错误'}`,
      riskScore: 0,
      suggestedPairs: []
    };
  }
};