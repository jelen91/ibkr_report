// Výpočty na cestě k finanční nezávislosti (FIRE).
//
// Všechno počítá s nominálními hodnotami a měsíčním připisováním. Nejsou to
// předpovědi — je to jedna konkrétní varianta „co když to takhle půjde dál“.
// Reálný vývoj se od průměrného zhodnocení odchýlí v obou směrech a nejvíc
// bude záležet na tom, jak vyjdou první roky.

export interface FireInputs {
    current: number;        // hodnota portfolia dnes
    monthly: number;        // kolik měsíčně přidáváš
    annualReturn: number;   // očekávané roční zhodnocení, např. 0.10
    target: number;         // cílová hodnota portfolia
    withdrawalRate: number; // míra bezpečného výběru, např. 0.04
    inflation: number;      // pro přepočet na dnešní kupní sílu, např. 0.025
}

export const DEFAULT_FIRE: FireInputs = {
    current: 0,
    monthly: 0,
    annualReturn: 0.10,
    target: 20_000_000,
    withdrawalRate: 0.04,
    inflation: 0.025,
};

/** Měsíční úroková míra odpovídající ročnímu zhodnocení (složené úročení). */
export const monthlyRate = (annual: number) =>
    Number.isFinite(annual) && annual > -1 ? Math.expm1(Math.log1p(annual) / 12) : NaN;

const stableMonths = (months: number) => Math.abs(months - Math.round(months)) < 1e-9
    ? Math.round(months) : months;

/**
 * Za kolik měsíců portfolio doroste na cíl při pravidelných měsíčních vkladech.
 * Vrací null, když se tam s danými parametry nedojde nikdy (nulový výnos
 * i nulový vklad, nebo výnos, který nestačí cíl dohnat).
 */
export function monthsToTarget(inputs: FireInputs): number | null {
    const { current, monthly, target } = inputs;
    if (![current, monthly, target, inputs.annualReturn].every(Number.isFinite) ||
        current < 0 || target < 0 || inputs.annualReturn <= -1) return null;
    if (current >= target) return 0;

    const r = monthlyRate(inputs.annualReturn);

    // Bez úročení stačí prostý podíl.
    if (r === 0) {
        if (monthly <= 0) return null;
        return stableMonths((target - current) / monthly);
    }

    // Budoucí hodnota = current·(1+r)^n + monthly·((1+r)^n − 1)/r
    // Po dosazení cíle a úpravě vyjde n přímo logaritmem.
    const numerator = target * r + monthly;
    const denominator = current * r + monthly;
    // Při záporném výnosu hodnota směřuje k monthly / -r. Cíl na této
    // asymptotě nebo nad ní není dosažitelný v konečném čase.
    if (denominator <= 0 || numerator <= 0) return null;
    // (monthly / -r) * r + monthly se může mezi JS runtimy zaokrouhlit
    // na drobnou kladnou hodnotu. Toleranci škálujeme podle sčítaných členů.
    const equilibriumTolerance = 8 * Number.EPSILON * Math.max(Math.abs(target * r), Math.abs(monthly));
    if (r < 0 && numerator <= equilibriumTolerance) return null;

    const ratio = numerator / denominator;
    const months = Math.log1p((target - current) * r / denominator) / Math.log1p(r);
    return Number.isFinite(months) && months >= 0 && ratio > 0 ? stableMonths(months) : null;
}

/** Hodnota portfolia za `months` měsíců při daných vkladech. */
export function futureValue(inputs: FireInputs, months: number): number {
    const r = monthlyRate(inputs.annualReturn);
    if (!Number.isFinite(r) || !Number.isFinite(months) || months < 0 ||
        !Number.isFinite(inputs.current) || !Number.isFinite(inputs.monthly)) return NaN;
    if (r === 0) return inputs.current + inputs.monthly * months;
    const growthMinusOne = Math.expm1(Math.log1p(r) * months);
    return inputs.current * (growthMinusOne + 1) + inputs.monthly * (growthMinusOne / r);
}

/** Cíl s vklady na konci měsíce nastane nejdřív v následujícím celém měsíci. */
export function targetDateAfterMonths(months: number, now = new Date()): Date | null {
    if (!Number.isFinite(months) || months < 0) return null;
    const date = new Date(now);
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + Math.ceil(stableMonths(months)));
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDay));
    return Number.isFinite(date.getTime()) ? date : null;
}

/** Kolik si můžeš měsíčně vybírat podle pravidla bezpečného výběru. */
export const monthlyWithdrawal = (portfolio: number, rate: number) => (portfolio * rate) / 12;

/** Jaké portfolio potřebuješ, abys mohl vybírat danou měsíční částku. */
export const portfolioForIncome = (monthlyIncome: number, rate: number) =>
    rate > 0 ? (monthlyIncome * 12) / rate : Infinity;

/** Přepočet budoucí částky na dnešní kupní sílu. */
export const inTodaysMoney = (amount: number, months: number, inflation: number) =>
    Number.isFinite(amount) && Number.isFinite(months) && months >= 0 && Number.isFinite(inflation) && inflation > -1
        ? amount / Math.pow(1 + inflation, months / 12) : NaN;

export interface FireResult {
    /** Kolik portfolio „vydělá“ za rok samo, bez tvého přičinění. */
    passiveAnnual: number;
    passiveMonthly: number;

    /** Kolik si můžeš vybírat dnes a kolik po dosažení cíle. */
    withdrawNow: number;
    withdrawAtTarget: number;

    /** Podíl na cíli, 0–1. */
    progress: number;

    /** Doba do cíle při současném tempu. */
    monthsToGoal: number | null;
    targetDate: Date | null;
    /** Cíl přepočtený na dnešní kupní sílu. */
    targetInTodaysMoney: number | null;

    /** Kdy dojdeš k cíli, kdybys od teď už nepřidal ani korunu. */
    coastMonths: number | null;
    coastDate: Date | null;

    /** O kolik měsíců cíl přiblíží každých 10 000 Kč měsíčně navíc. */
    monthsSavedPer10k: number | null;

    /** Kolik z měsíčního přírůstku dnes dělá výnos a kolik tvoje vklady. */
    growthFromMarket: number;
    growthFromDeposits: number;

    /** Portfolio, při kterém výnos poprvé překoná tvoje měsíční vklady. */
    crossoverPortfolio: number | null;
    crossoverMonths: number | null;
}

export function computeFire(inputs: FireInputs): FireResult {
    const { current, monthly, target, withdrawalRate, inflation } = inputs;
    const r = monthlyRate(inputs.annualReturn);

    const monthsToGoal = monthsToTarget(inputs);
    const coastMonths = monthsToTarget({ ...inputs, monthly: 0 });

    const boosted = monthsToTarget({ ...inputs, monthly: monthly + 10000 });
    const monthsSavedPer10k =
        monthsToGoal !== null && boosted !== null ? monthsToGoal - boosted : null;

    const growthFromMarket = current * r;

    // Bod, kdy portfolio vydělává víc, než kolik do něj sám posíláš.
    const crossoverPortfolio = r > 0 && monthly > 0 ? monthly / r : null;
    const crossoverMonths = crossoverPortfolio !== null && current < crossoverPortfolio
        ? monthsToTarget({ ...inputs, target: crossoverPortfolio })
        : crossoverPortfolio !== null ? 0 : null;

    return {
        passiveAnnual: current * inputs.annualReturn,
        passiveMonthly: growthFromMarket,

        withdrawNow: monthlyWithdrawal(current, withdrawalRate),
        withdrawAtTarget: monthlyWithdrawal(target, withdrawalRate),

        progress: target > 0 ? Math.max(0, Math.min(1, current / target)) : 0,

        monthsToGoal,
        targetDate: monthsToGoal !== null ? targetDateAfterMonths(monthsToGoal) : null,
        targetInTodaysMoney: monthsToGoal !== null
            ? inTodaysMoney(target, monthsToGoal, inflation)
            : null,

        coastMonths,
        coastDate: coastMonths !== null ? targetDateAfterMonths(coastMonths) : null,

        monthsSavedPer10k,

        growthFromMarket,
        growthFromDeposits: monthly,

        crossoverPortfolio,
        crossoverMonths,
    };
}

/** Mezicíle, ať je vidět, že se něco děje i dřív než na konci. */
export function milestones(inputs: FireInputs, levels: number[]) {
    return levels
        .filter(level => level > 0)
        .map(level => {
            const months = monthsToTarget({ ...inputs, target: level });
            const reached = inputs.current >= level;
            let date: Date | null = null;
            if (!reached && months !== null) {
                date = targetDateAfterMonths(months);
            }
            return {
                level,
                reached,
                months: reached ? 0 : months,
                date,
                withdrawal: monthlyWithdrawal(level, inputs.withdrawalRate),
            };
        });
}
