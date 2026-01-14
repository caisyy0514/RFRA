import { GoogleGenAI, Type } from "@google/genai";
import { AIAnalysisResult } from '../types';

// Initialize Gemini Client
// Using process.env.API_KEY as per guidelines.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const analyzeMarketConditions = async (
  marketData: any[],
  strategyName: string
): Promise<AIAnalysisResult> => {
  try {
    const model = "gemini-3-flash-preview";
    
    const prompt = `
      You are a quantitative crypto trading expert. 
      Analyze the following market data for a strategy named "${strategyName}".
      
      Market Data Sample (Top Funding Rates):
      ${JSON.stringify(marketData.slice(0, 10))}

      Goal: Identify the safest pairs for funding rate arbitrage (Long Spot, Short Perp).
      Avoid pairs with extreme volatility or potential pump-and-dump signs.
      
      Return a JSON response.
    `;

    const response = await ai.models.generateContent({
      model: model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            recommendedAction: { type: Type.STRING },
            reasoning: { type: Type.STRING },
            riskScore: { type: Type.NUMBER, description: "0-100 score, 100 is high risk" },
            suggestedPairs: { 
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          },
          required: ["recommendedAction", "reasoning", "riskScore", "suggestedPairs"]
        }
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response from AI");
    
    return JSON.parse(text) as AIAnalysisResult;

  } catch (error) {
    console.error("AI Analysis Failed:", error);
    return {
      recommendedAction: "ERROR",
      reasoning: "AI service failed to respond or API Key is invalid.",
      riskScore: 0,
      suggestedPairs: []
    };
  }
};