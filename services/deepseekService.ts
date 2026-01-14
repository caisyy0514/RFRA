import { AIAnalysisResult, TickerData } from '../types';

/**
 * 使用 DeepSeek API 分析市场状况以寻找套利机会。
 * 采用 DeepSeek-Chat 模型进行金融逻辑推理。
 */
export const analyzeMarketConditions = async (
  marketData: TickerData[],
  strategyName: string,
  apiKey: string
): Promise<AIAnalysisResult> => {
  if (!apiKey) {
    return {
      recommendedAction: "ERROR",
      reasoning: "未配置 DeepSeek API Key，请前往设置面板配置。",
      riskScore: 0,
      suggestedPairs: []
    };
  }

  // 过滤正费率标的
  const positiveRateMarketData = marketData.filter(item => parseFloat(item.fundingRate) > 0);

  if (positiveRateMarketData.length === 0) {
      return {
          recommendedAction: "WAIT",
          reasoning: "系统风控拦截：当前全市场无正资金费率标的，不具备期现套利基础。",
          riskScore: 0,
          suggestedPairs: []
      };
  }

  const formattedCandidates = positiveRateMarketData
      .sort((a, b) => parseFloat(b.fundingRate) - parseFloat(a.fundingRate))
      .slice(0, 10)
      .map(t => ({
          instId: t.instId,
          fundingRate: `${(parseFloat(t.fundingRate)*100).toFixed(4)}%`,
          turnoverUsdt24h: `$${(parseFloat(t.volUsdt24h) / 1e6).toFixed(2)}M`,
          lastPrice: t.last
      }));

  try {
    const prompt = `
      你是一个量化加密货币交易专家。请分析策略 "${strategyName}" 的市场数据。
      策略逻辑: 期现套利 (赚取资金费率)。
      
      铁律:
      1. 必须资金费率 > 0。
      2. 标的流动性必须充足 (通常 > 5M USDT)。
      3. 若成交额异常巨大 (如 > 50B USDT)，请警惕异常，返回 WAIT。

      待分析数据:
      ${JSON.stringify(formattedCandidates)}

      请以 JSON 格式返回结果，包含以下字段：
      - recommendedAction: "BUY", "SELL", "HOLD", "WAIT"
      - reasoning: 中文逻辑分析
      - riskScore: 0-100 风险分
      - suggestedPairs: 推荐的币种 ID 数组
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
          { role: "system", content: "你是一个专业的加密货币量化研究员，擅长套利风险评估。请仅返回有效的 JSON 数据。" },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const resultString = data.choices[0].message.content;
    const result = JSON.parse(resultString) as AIAnalysisResult;

    // 二次验证，防止 AI 幻觉
    if (result.recommendedAction === 'BUY' && result.suggestedPairs.length > 0) {
       const invalidPairs = result.suggestedPairs.filter(pair => {
          const ticker = marketData.find(t => t.instId === pair);
          return !ticker || parseFloat(ticker.fundingRate) <= 0;
       });

       if (invalidPairs.length > 0) {
          return {
            recommendedAction: "WAIT",
            reasoning: `风控拦截：DeepSeek 推荐了费率为负或不存在的币种 (${invalidPairs.join(', ')})。`,
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
      reasoning: `DeepSeek 服务连接异常: ${error instanceof Error ? error.message : '未知错误'}`,
      riskScore: 0,
      suggestedPairs: []
    };
  }
};