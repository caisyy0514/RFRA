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
  // 逻辑：期现套利（做空合约）只有在费率为正时才能获利。
  const positiveRateMarketData = marketData.filter(item => parseFloat(item.fundingRate) > 0);

  // 如果全市场没有正费率，直接熔断，无需请求 AI
  if (positiveRateMarketData.length === 0) {
      return {
          recommendedAction: "WAIT",
          reasoning: "系统风控拦截：当前市场无正资金费率 (>0) 币种。做空合约将支付费率导致亏损，系统自动暂停开仓。",
          riskScore: 0,
          suggestedPairs: []
      };
  }

  // 排序并取 Top 15，避免 token 消耗过大
  const topCandidates = positiveRateMarketData
      .sort((a, b) => parseFloat(b.fundingRate) - parseFloat(a.fundingRate))
      .slice(0, 15);

  try {
    // --- 第二层防御：提示词工程强化 (Prompt Engineering) ---
    // 明确定义正负费率的含义，并要求中文输出
    const prompt = `
      你是一个量化加密货币交易专家。
      请分析以下名为 "${strategyName}" 的策略的市场数据。

      策略核心逻辑: 期现套利 (Cash and Carry Arbitrage)
      操作动作: 现货做多 (Long Spot) + 永续合约做空 (Short Perp)
      盈利来源: 赚取多头支付给空头的资金费率。

      重要铁律 (CRITICAL RULES):
      1. 必须资金费率 (Funding Rate) > 0 才有套利空间。
      2. 费率 > 0 代表多头付钱给空头（我们赚钱）。
      3. 费率 < 0 代表空头付钱给多头（我们亏钱）。
      4. 绝对禁止推荐任何费率为负的币种。
      5. 请从下方提供的列表中（已过滤为正费率），挑选波动率相对稳定、流动性好且费率具有吸引力的标的。

      当前可用市场数据 (已预筛选为正费率):
      ${JSON.stringify(topCandidates)}

      请严格只返回 JSON 格式，不要包含 Markdown 格式标记（如 \`\`\`json）。
      JSON 结构如下:
      {
        "recommendedAction": "BUY" | "SELL" | "HOLD" | "WAIT",
        "reasoning": "简短的分析理由 (必须使用中文，解释为什么选择这些币种，风险点在哪里)",
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
        temperature: 0.1 // 低温度，降低幻觉
      })
    });

    const data = await response.json();
    
    if (data.error) {
        throw new Error(data.error.message);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek 未返回内容");

    // Clean potential markdown code blocks
    const cleanContent = content.replace(/```json/g, '').replace(/```/g, '').trim();

    return JSON.parse(cleanContent) as AIAnalysisResult;

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