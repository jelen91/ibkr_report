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
export const monthlyRate = (annual: number) => Math.pow(1 + annual, 1 / 12) - 1;

/**
 * Za kolik měsíců portfolio doroste na cíl při pravidelných měsíčních vkladech.
 * Vrací null, když se tam s danými parametry nedojde nikdy (nulový výnos
 * i nulový vklad, nebo výnos, který nestačí cíl dohnat).
 */
export function monthsToTarget(inputs: FireInputs): number | null {
    const { current, monthly, target } = inputs;
    if (current >= target) return 0;

    const r = monthlyRate(inputs.annualReturn);

    // Bez úročení stačí prostý podíl.
    if (r <= 0) {
        if (monthly <= 0) return null;
        return (target - current) / monthly;
    }

    // Budoucí hodnota = current·(1+r)^n + monthly·((1+r)^n − 1)/r
    // Po dosazení cíle a úpravě vyjde n přímo logaritmem.
    const numerator = target * r + monthly;
    const denominator = current * r + monthly;
    if (denominator <= 0 || numerator <= 0) return null;

    const ratio = numerator / denominator;
    if (ratio <= 1) return null;

    return Math.log(ratio) / Math.log(1 + r);
}

/** Hodnota portfolia za `months` měsíců při daných vkladech. */
export function futureValue(inputs: FireInputs, months: number): number {
    const r = monthlyRate(inputs.annualReturn);
    const growth = Math.pow(1 + r, months);
    if (r <= 0) return inputs.current + inputs.monthly * months;
    return inputs.current * growth + inputs.monthly * ((growth - 1) / r);
}

/** Kolik si můžeš měsíčně vybírat podle pravidla bezpečného výběru. */
export const monthlyWithdrawal = (portfolio: number, rate: number) => (portfolio * rate) / 12;

/** Jaké portfolio potřebuješ, abys mohl vybírat danou měsíční částku. */
export const portfolioForIncome = (monthlyIncome: number, rate: number) =>
    rate > 0 ? (monthlyIncome * 12) / rate : Infinity;

/** Přepočet budoucí částky na dnešní kupní sílu. */
export const inTodaysMoney = (amount: number, months: number, inflation: number) =>
    amount / Math.pow(1 + inflation, months / 12);

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

    const addMonths = (months: number) => {
        const d = new Date();
        d.setMonth(d.getMonth() + Math.round(months));
        return d;
    };

    return {
        passiveAnnual: current * inputs.annualReturn,
        passiveMonthly: growthFromMarket,

        withdrawNow: monthlyWithdrawal(current, withdrawalRate),
        withdrawAtTarget: monthlyWithdrawal(target, withdrawalRate),

        progress: target > 0 ? Math.min(1, current / target) : 0,

        monthsToGoal,
        targetDate: monthsToGoal !== null ? addMonths(monthsToGoal) : null,
        targetInTodaysMoney: monthsToGoal !== null
            ? inTodaysMoney(target, monthsToGoal, inflation)
            : null,

        coastMonths,
        coastDate: coastMonths !== null ? addMonths(coastMonths) : null,

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
                date = new Date();
                date.setMonth(date.getMonth() + Math.round(months));
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
