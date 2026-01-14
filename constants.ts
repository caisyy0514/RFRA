import { StrategyConfig, StrategyType, LogEntry } from './types';

export const DEFAULT_STRATEGIES: StrategyConfig[] = [
  {
    id: 'rotational-arb-001',
    name: '多币种资金费率轮动策略',
    type: StrategyType.ROTATIONAL_FUNDING,
    isActive: false,
    parameters: {
      minFundingRate: 0.0001, // 0.01% per 8h
      rebalanceInterval: 60, // minutes
      maxLeverage: 1, // Delta neutral
      excludedCoins: ['USDC', 'DAI'],
      allocationPct: 50, // % of total portfolio
      useAI: true,
      scanIntervalEmpty: 60, // seconds
      scanIntervalHolding: 20 // seconds
    },
    lastRun: 0
  }
];

export const MOCK_LOGS_INIT: LogEntry[] = [
  { id: '1', timestamp: Date.now() - 100000, level: 'info', source: 'SYSTEM', message: '系统初始化完成。' },
  { id: '2', timestamp: Date.now() - 90000, level: 'info', source: 'OKX', message: '已连接到 OKX V5 (模拟模式)。' },
];