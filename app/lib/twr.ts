// Time-weighted return (TWR) — výnos portfolia očištěný o vklady a výběry.
//
// Proč TWR: samotná NAV se hýbe i tím, že pošleš na účet peníze. Bez očištění
// by vklad 150 000 Kč vypadal jako +5 % denní výnos. TWR řetězí denní výnosy,
// z nichž je vždy odečten cash flow daného dne, takže měří výhradně výkon
// obchodování — a je tím pádem přímo srovnatelný s indexem.

export interface NavPoint {
    date: string;   // YYYYMMDD
    nav: number;    // v bázové měně účtu
}

export interface FlowPoint {
    date: string;   // YYYYMMDD
    amount: number; // + vklad, − výběr, v bázové měně
}

export interface TwrPoint {
    date: string;
    index: number;   // kumulativní index, start = 1
    nav: number;     // NAV daného dne (v požadované měně)
    flow: number;    // cash flow přiřazený tomuto dni (v požadované měně)
    stale: boolean;  // true = den přeskočen (NAV pod prahem), výnos se nezapočítal
}

/**
 * Přiřadí každý vklad/výběr ke dni, kdy se skutečně projevil v NAV.
 *
 * IBKR datuje pohyb ve Statement of Funds podle dne zadání, ale do denního
 * NAV snapshotu se občas dostane až následující obchodní den (typicky u převodů
 * zadaných po uzávěrce nebo přes svátek). Kdyby se to ignorovalo, vznikl by
 * v grafu falešný pár outlierů: jeden den −5 %, druhý +5 %.
 *
 * Detekce je datová, ne heuristika podle času: vklad je řádově větší než běžný
 * denní pohyb NAV (u tohoto účtu medián 1 264 Kč vs. vklady 15 000–1 850 000 Kč),
 * takže se prostě vybere den, jehož skok NAV je daným pohybem vysvětlen lépe.
 * Vklady v sousedních dnech se řeší společně — jinak by se u dvojice 25./26. 5.
 * (svátek Memorial Day) první z nich přiřadil špatně.
 */
export function assignFlowLandingDays(nav: NavPoint[], flows: FlowPoint[]): Record<string, number> {
    const dates = nav.map(n => n.date);
    const idx = new Map(dates.map((d, i) => [d, i]));
    const navBy = new Map(nav.map(n => [n.date, n.nav]));

    // Součet pohybů na den (za jeden den může být víc převodů)
    const byDate = new Map<string, number>();
    for (const f of flows) {
        if (!idx.has(f.date)) continue; // pohyb mimo rozsah NAV řady
        byDate.set(f.date, (byDate.get(f.date) ?? 0) + f.amount);
    }

    const flowDates = [...byDate.keys()].sort();
    if (flowDates.length === 0) return {};

    // Shluky sousedních dnů s pohybem (musí se optimalizovat společně)
    const clusters: string[][] = [];
    let cur = [flowDates[0]];
    for (const d of flowDates.slice(1)) {
        if (idx.get(d)! - idx.get(cur[cur.length - 1])! <= 1) cur.push(d);
        else { clusters.push(cur); cur = [d]; }
    }
    clusters.push(cur);

    const dayChange = (d: string) => {
        const i = idx.get(d)!;
        if (i === 0) return NaN;
        return navBy.get(d)! - navBy.get(dates[i - 1])!;
    };

    const landed: Record<string, number> = {};

    for (const cluster of clusters) {
        // Každý pohyb může přistát v den D nebo D+1 → 2^k kombinací (k ≤ 3 v praxi)
        let best: { cost: number; assign: Map<string, number> } | null = null;
        const combos = 1 << cluster.length;

        for (let mask = 0; mask < combos; mask++) {
            const assign = new Map<string, number>();
            for (let k = 0; k < cluster.length; k++) {
                const shift = (mask >> k) & 1;
                const target = dates[Math.min(idx.get(cluster[k])! + shift, dates.length - 1)];
                assign.set(target, (assign.get(target) ?? 0) + byDate.get(cluster[k])!);
            }

            // Cena = kolik pohybu NAV zůstane nevysvětleno. Menší = lepší.
            const affected = new Set<string>();
            for (const d of cluster) {
                affected.add(d);
                affected.add(dates[Math.min(idx.get(d)! + 1, dates.length - 1)]);
            }
            let cost = 0;
            for (const d of affected) {
                const change = dayChange(d);
                if (!Number.isFinite(change)) continue;
                cost += Math.abs(change - (assign.get(d) ?? 0));
            }

            if (best === null || cost < best.cost) best = { cost, assign };
        }

        for (const [d, v] of best!.assign) landed[d] = (landed[d] ?? 0) + v;
    }

    return landed;
}

/**
 * Práh, pod kterým se denní výnos nezapočítává.
 *
 * Když je na účtu pár tisíc korun, každý drobný pohyb je desítky procent a
 * řetězení takových dnů rozbije celou řadu (na reálných datech dělalo prázdné
 * období do ledna 2026 z ročního výnosu −37 %). 2 % historického maxima NAV
 * spolehlivě oddělí "účet reálně obchoduje" od "účet je prázdný".
 */
export const MIN_NAV_FRACTION = 0.02;

export function detectInception(nav: NavPoint[]): { inception: string; minNav: number } {
    const peak = Math.max(...nav.map(n => n.nav), 0);
    const minNav = peak * MIN_NAV_FRACTION;
    const first = nav.find(n => n.nav >= minNav);
    return { inception: first?.date ?? nav[0]?.date ?? '', minNav };
}

/**
 * Spočítá kumulativní TWR index. `fxRate` (měna účtu → USD) se použije jen
 * v USD režimu; NAV i cash flows se převádí kurzem daného dne, takže výsledek
 * je výnos pohledem investora držícího dolary.
 */
export function computeTwr(
    nav: NavPoint[],
    landedFlows: Record<string, number>,
    opts: { minNav: number; fxToUsd?: Record<string, number> } // fxToUsd: kolik CZK za 1 USD
): TwrPoint[] {
    const { minNav, fxToUsd } = opts;
    const convert = (date: string, v: number) => (fxToUsd ? v / (fxToUsd[date] || 1) : v);

    const out: TwrPoint[] = [];
    let acc = 1;

    for (let i = 0; i < nav.length; i++) {
        const { date } = nav[i];
        const flow = landedFlows[date] ?? 0;
        let stale = true;

        if (i > 0) {
            const prev = nav[i - 1];
            const begin = convert(prev.date, prev.nav);
            const end = convert(date, nav[i].nav);
            const f = convert(date, flow);
            if (prev.nav >= minNav && begin > 0) {
                acc *= (end - f) / begin;
                stale = false;
            }
        }

        out.push({
            date,
            index: acc,
            nav: convert(date, nav[i].nav),
            flow: convert(date, flow),
            stale,
        });
    }

    return out;
}

/**
 * Pasivní protipól: kdyby každý vklad ve stejný den koupil benchmark, kolik by
 * dnes měl? Odpovídá na "vyplatil se mi aktivní trading" v penězích, ne v procentech.
 */
export function simulatePassive(
    flows: FlowPoint[],
    benchmark: Record<string, number>,
    dates: string[],
    from: string,
    startValue: number,
): number {
    const priceAt = (date: string) => {
        // nejbližší dostupná cena k datu (dopředu i dozadu)
        if (benchmark[date]) return benchmark[date];
        const i = dates.indexOf(date);
        for (let k = i; k >= 0; k--) if (benchmark[dates[k]]) return benchmark[dates[k]];
        for (let k = i; k < dates.length; k++) if (benchmark[dates[k]]) return benchmark[dates[k]];
        return NaN;
    };

    const last = dates[dates.length - 1];
    const endPrice = priceAt(last);
    if (!Number.isFinite(endPrice)) return NaN;

    let units = startValue / priceAt(from);
    for (const f of flows) {
        // Ostrá nerovnost: pohyb, který dopadl v den startu, je už započítaný
        // v `startValue` (NAV toho dne). Jinak by se vklad počítal dvakrát.
        if (f.date <= from || f.date > last) continue;
        const p = priceAt(f.date);
        if (Number.isFinite(p) && p > 0) units += f.amount / p;
    }
    return units * endPrice;
}
