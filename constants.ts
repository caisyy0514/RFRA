
import { StrategyConfig, StrategyType, LogEntry } from './types';

export const DEFAULT_STRATEGIES: StrategyConfig[] = [
  {
    id: 'rotational-arb-001',
    name: '多币种资金费率轮动策略',
    type: StrategyType.ROTATIONAL_FUNDING,
    isActive: false,
    isTrading: false,
    parameters: {
      minFundingRate: 0.0003, // 0.03% (approx 32% APY)
      minVolume24h: 10000000, // 10 Million USDT liquidity required
      rotationThreshold: 0.0002, // New rate must be 0.02% higher than current to switch
      exitThreshold: 0.0001, // Exit if rate drops below 0.01%
      allocationPct: 30, // Each position uses 30% of total equity (Spot buy amount)
      maxPositions: 3, // Support up to 3 positions
      useAI: true,
      scanInterval: 60, // 1 minute
    },
    lastRun: 0
  }
];

export const MOCK_LOGS_INIT: LogEntry[] = [
  { id: '1', timestamp: Date.now() - 100000, level: 'info', source: 'SYSTEM', message: '系统初始化完成。' },
  { id: '2', timestamp: Date.now() - 90000, level: 'info', source: 'OKX', message: '已连接到 OKX V5 (模拟模式)。' },
];