export interface PositionValue {
    symbol: string;
    underlying?: string;
    expiry?: string | number;
    strike?: number;
    type?: 'CALL' | 'PUT' | 'C' | 'P';
    quantity: number;
    markPrice: number;
    marketValue: number;
    commitedCapital?: number;
    fxRateToBase?: number;
    multiplier?: number;
    assetClass: 'STK' | 'OPT' | 'CRYPTO' | 'FUT' | string;
    costPrice?: number;
    costBasisPrice?: number;
    fifoPnlUnrealized?: number;
    unrealizedPnL?: number;
    costBasisMoney?: number;
}

export interface PositionItem {
    tag: 'Position';
    value: PositionValue;
    currency: string;
}

export interface MetricItem {
    tag: string;
    value: string | number;
    currency?: string;
}

export type AccountData = (PositionItem | MetricItem)[];

export interface Account {
    id: string;
    name: string;
    token: string;
    queryId: string;
}
