export interface CashBalance {
    currency: string;
    quantity: number;  // v dané měně
    value: number;     // v bázové měně
}

/** Sums per-date values of several accounts on the given dates; unknown when any account lacks one. */
export function sumByDate(lists: (Record<string, number> | undefined)[], dates: string[]): Record<string, number> | undefined {
    if (lists.some(list => !list || dates.some(date => !Number.isFinite(list[date])))) return undefined;
    return Object.fromEntries(dates.map(date => [date, lists.reduce((sum, list) => sum + list![date], 0)]));
}

/** Sums balances of several accounts by currency; unknown when any account lacks them. */
export function mergeCashBalances(lists: (CashBalance[] | undefined)[]): CashBalance[] | undefined {
    if (lists.some(list => !list)) return undefined;
    const byCurrency = new Map<string, CashBalance>();
    for (const row of lists.flat() as CashBalance[]) {
        const prior = byCurrency.get(row.currency) ?? { currency: row.currency, quantity: 0, value: 0 };
        byCurrency.set(row.currency, { ...prior, quantity: prior.quantity + row.quantity, value: prior.value + row.value });
    }
    return [...byCurrency.values()].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}
