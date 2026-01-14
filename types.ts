
export enum ExchangeMode {
  SIMULATION = 'SIMULATION',
  REAL = 'REAL',
}

export enum StrategyType {
  ROTATIONAL_FUNDING = 'ROTATIONAL_FUNDING',
  GRID_TRADING = 'GRID_TRADING',
  AI_SENTIMENT = 'AI_SENTIMENT',
}

export interface OKXConfig {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  isSimulated: boolean;
}

export interface StrategyConfig {
  id: string;
  name: string;
  type: StrategyType;
  isActive: boolean;
  parameters: {
    minFundingRate: number; // e.g. 0.0003
    minVolume24h: number; // e.g. 10,000,000
    rotationThreshold: number; // e.g. 0.0002 (Diff required to rotate)
    exitThreshold: number; // e.g. 0.0001
    allocationPct: number;
    maxPositions: number;
    useAI: boolean;
    scanInterval: number; // seconds
    [key: string]: any;
  };
  lastRun?: number;
}

export interface TickerData {
  instId: string;
  last: string;
  fundingRate: string; // Next funding rate
  volCcy24h: string; // 24h Volume in USD
  ts: string;
}

export interface Instrument {
  instId: string;
  baseCcy: string;
  quoteCcy: string;
  ctVal: string; // Contract value (e.g., "0.01" for BTC)
  minSz: string; // Minimum order size (e.g., "1")
  tickSz: string; // Price tick size
}

export interface LogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warning' | 'error' | 'success';
  source: 'SYSTEM' | 'STRATEGY' | 'AI' | 'OKX';
  message: string;
}

export interface Asset {
  currency: string;
  balance: number;
  available: number;
  equityUsd: number;
}

export interface Position {
  instId: string;
  pos: string; // Position size (positive for long, negative for short)
  avgPx: string;
  upl: string; // Unrealized PnL
  uplRatio: string; // PnL Ratio
  lever: string;
  liqPx: string; // Liquidation Price
  mgnMode: 'cross' | 'isolated';
  cTime: number;
}

export interface Order {
  ordId: string;
  clOrdId: string;
  instId: string;
  side: 'buy' | 'sell';
  ordType: 'limit' | 'market';
  sz: string; // Size
  px: string; // Price
  state: 'live' | 'filled' | 'canceled' | 'partially_filled';
  cTime: number;
  fillSz?: string;
  fillPx?: string;
}

export interface AIAnalysisResult {
  recommendedAction: string;
  reasoning: string;
  riskScore: number;
  suggestedPairs: string[];
}
