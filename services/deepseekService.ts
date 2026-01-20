import { AIAnalysisResult, TickerData } from '../types';

/**
 * 使用 DeepSeek API 批量分析市场标的。
 * 引入主流币放权逻辑与动态异常侦测。
 */
export const analyzeMarketConditions = async (
  marketData: TickerData[],
  strategyName: string,
  apiKey: string
): Promise<AIAnalysisResult> => {
  if (!apiKey || marketData.length === 0) {
    return {
      recommendedAction: "WAIT",
      reasoning: "缺少分析数据或 API Key",
      riskScore: 0,
      suggestedPairs: []
    };
  }

  // 定义主流币列表 (Mainstream Coins)
  const mainstreamCoins = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'OKB'];

  const formattedCandidates = marketData.map(t => {
      const volumeInMillions = parseFloat(t.volUsdt24h) / 1e6;
      return {
          instId: t.instId,
          fundingRate: `${(parseFloat(t.fundingRate)*100).toFixed(4)}%`,
          // 关键修改：发送纯数字，单位为百万 (Million)，消除 AI 对字符串 "$900M" 的解析歧义
          turnoverMillions: parseFloat(volumeInMillions.toFixed(2)), 
          isMainstream: mainstreamCoins.some(coin => t.instId.startsWith(`${coin}-`))
      };
  });

  try {
    const prompt = `
      你是一个顶级的量化策略研究员。请对以下 10 个潜在套利标的进行综合评估并排序。
      策略类型: 期现套利 (赚取资金费率)。

      核心风控铁律:
      1. 资金费率必须为正。
      2. 基础流动性要求：turnoverMillions (24h成交额/百万U) 必须大于 5。(例如: 974.36 代表 9.74亿，远大于 5，符合条件)。
      3. 动态异常成交额预警:
         - 对于 isMainstream=true 的主流币 (BTC, ETH, SOL, BNB, XRP, OKB): 成交额高是流动性好的表现。只有当成交额较往日平均水平瞬间喷发 10 倍以上且伴随极端波动时才拦截。
         - 对于 isMainstream=false 的山寨币: 若成交额 > 50B USDT (turnoverMillions > 50000)，通常暗示脱钩或操纵，需高度警惕。

      待分析标的列表:
      ${JSON.stringify(formattedCandidates)}

      请在 JSON 结果中：
      1. recommendedAction: 若存在优质标的返回 "BUY"，否则 "WAIT"。
      2. suggestedPairs: 按照安全性与费率性价比，从优到劣排列的前 3-5 个标的 ID。
      3. reasoning: 说明为什么在评估中对主流币/山寨币采取了差异化的风控标准。

      返回 JSON 格式：
      {
        "recommendedAction": "BUY" | "WAIT",
        "reasoning": "中文逻辑分析",
        "riskScore": 0-100,
        "suggestedPairs": ["BTC-USDT-SWAP", ...]
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
          { role: "system", content: "你是一个专业的加密货币量化风险评估专家。请仅返回 JSON。" },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return JSON.parse(data.choices[0].message.content) as AIAnalysisResult;

  } catch (error) {
    return {
      recommendedAction: "ERROR",
      reasoning: `AI 服务连接失败: ${error instanceof Error ? error.message : '未知'}`,
      riskScore: 50,
      suggestedPairs: []
    };
  }
};