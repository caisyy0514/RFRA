
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

  // --- 第一层防御：数据源头清洗 (Input Filtering) ---
  // 仅保留资金费率 > 0 的数据。
  const positiveRateMarketData = marketData.filter(item => parseFloat(item.fundingRate) > 0);

  // 如果全市场没有正费率，直接熔断
  if (positiveRateMarketData.length === 0) {
      return {
          recommendedAction: "WAIT",
          reasoning: "系统风控拦截：当前市场无正资金费率 (>0) 币种。系统自动暂停开仓。",
          riskScore: 0,
          suggestedPairs: []
      };
  }

  // 排序并取 Top 15
  const topCandidates = positiveRateMarketData
      .sort((a, b) => parseFloat(b.fundingRate) - parseFloat(a.fundingRate))
      .slice(0, 15);

  try {
    const prompt = `
      你是一个量化加密货币交易专家。
      请分析以下名为 "${strategyName}" 的策略的市场数据。

      策略核心逻辑: 期现套利 (Cash and Carry Arbitrage)
      操作动作: 现货做多 (Long Spot) + 永续合约做空 (Short Perp)
      盈利来源: 赚取多头支付给空头的资金费率。

      重要铁律 (CRITICAL RULES):
      1. 必须资金费率 (Funding Rate) > 0 才有套利空间。
      2. 绝对禁止推荐任何费率为负的币种。
      3. 如果候选列表中的币种风险都过高，返回 WAIT。

      当前可用市场数据 (已预筛选为正费率):
      ${JSON.stringify(topCandidates)}

      请严格只返回 JSON 格式，不要包含 Markdown 格式标记。
      JSON 结构如下:
      {
        "recommendedAction": "BUY" | "SELL" | "HOLD" | "WAIT",
        "reasoning": "简短的分析理由 (必须使用中文)",
        "riskScore": 0-100的数字 (100为高风险),
        "suggestedPairs": ["币种1-USDT-SWAP", "币种2-USDT-SWAP"]
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
          { role: "system", content: "You are a helpful assistant that outputs only JSON." },
          { role: "user", content: prompt }
        ],
        temperature: 0.1 
      })
    });

    const data = await response.json();
    
    if (data.error) {
        throw new Error(data.error.message);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek 未返回内容");

    const cleanContent = content.replace(/```json/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleanContent) as AIAnalysisResult;

    // --- 第二层防御：输出结果后置审查 (Output Validation Guardian) ---
    // 即使 AI 过滤了，我们也要检查它推荐的币种现在的真实费率。
    // 如果 AI 推荐了负费率币种，说明出现了严重幻觉，必须强制拦截。
    if (result.recommendedAction === 'BUY' && result.suggestedPairs.length > 0) {
       const invalidPairs = result.suggestedPairs.filter(pair => {
          const ticker = marketData.find(t => t.instId === pair);
          // 如果找不到Ticker，或者费率 <= 0，视为违规
          return !ticker || parseFloat(ticker.fundingRate) <= 0;
       });

       if (invalidPairs.length > 0) {
          console.warn(`[Risk Control] AI Hallucination blocked. Recommended negative rate pairs: ${invalidPairs.join(', ')}`);
          return {
            recommendedAction: "WAIT",
            reasoning: `风控拦截警告：AI 试图推荐负费率币种 (${invalidPairs.join(', ')})，这违反了套利策略核心逻辑。已强制转为观望状态。`,
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
      reasoning: `AI 服务请求失败: ${error instanceof Error ? error.message : '未知错误'}`,
      riskScore: 0,
      suggestedPairs: []
    };
  }
};
