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
          lastPrice: t.last,
          isMainstream: t.instId.startsWith('BTC-') || t.instId.startsWith('ETH-')
      }));

  try {
    const prompt = `
      你是一个量化加密货币交易专家。请分析策略 "${strategyName}" 的市场数据。
      策略逻辑: 期现套利 (赚取资金费率)。
      
      风控铁律 (Risk Control Rules):
      1. 资金费率必须为正 (Funding Rate > 0)。
      2. 基础流动性必须满足 (通常 > 5M USDT)。
      3. 动态异常成交额预警:
         - 对于 BTC 和 ETH: 成交额在 10B - 500B USDT 之间属于高度流动性的正常区间。只有当成交额较往日平均水平出现 5 倍以上爆发式增长且伴随剧烈波动时才需标记为 WAIT。
         - 对于其他山寨币 (Altcoins): 若 24h 成交额 > 50B USDT，通常暗示存在极端行情或操纵风险，应返回 WAIT。

      待分析数据:
      ${JSON.stringify(formattedCandidates)}

      请以 JSON 格式返回结果，包含以下字段：
      - recommendedAction: "BUY" (推荐入场), "SELL" (建议离场), "HOLD" (观望), "WAIT" (风险警告)
      - reasoning: 详细的逻辑分析（中文），需解释为何放宽或收紧对主流币/山寨币的成交额限制。
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
            reasoning: `风控拦截：AI 推荐了费率为负或不存在的币种 (${invalidPairs.join(', ')})。`,
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