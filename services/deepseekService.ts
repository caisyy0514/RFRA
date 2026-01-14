import { AIAnalysisResult } from '../types';

export const analyzeMarketConditions = async (
  marketData: any[],
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

  try {
    const prompt = `
      你是一个量化加密货币交易专家。
      请分析以下名为 "${strategyName}" 的策略的市场数据。

      市场数据样本 (资金费率 Top 10):
      ${JSON.stringify(marketData.slice(0, 10))}

      目标: 识别最安全的资金费率套利交易对 (现货做多, 合约做空)。
      避免波动极大或有暴涨暴跌迹象的币种。

      请严格只返回 JSON 格式，不要包含 Markdown 格式标记（如 \`\`\`json）。
      JSON 结构如下:
      {
        "recommendedAction": "BUY" | "SELL" | "HOLD" | "WAIT",
        "reasoning": "简短的分析理由",
        "riskScore": 0-100的数字 (100为高风险),
        "suggestedPairs": ["币种1", "币种2"]
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

    // Clean potential markdown code blocks if the model ignores the prompt instruction
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