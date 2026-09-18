import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_FIRE, computeFire, futureValue, monthlyRate, monthsToTarget, targetDateAfterMonths } from '../app/lib/fire';

const close = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('annual return compounds consistently over twelve months', () => {
    close(futureValue({ ...DEFAULT_FIRE, current: 100_000, monthly: 0, annualReturn: .10 }, 12), 110_000);
    close(monthlyRate(.10), 1.1 ** (1 / 12) - 1);
});

test('negative returns reduce capital and contributions compound at end of month', () => {
    const inputs = { ...DEFAULT_FIRE, current: 100_000, monthly: 1_000, annualReturn: -.12 };
    let expected = inputs.current;
    for (let i = 0; i < 24; i++) expected = expected * (1 + monthlyRate(inputs.annualReturn)) + inputs.monthly;
    close(futureValue(inputs, 24), expected);
    close(futureValue({ ...inputs, monthly: 0 }, 12), 88_000);
});

test('negative-return goal can be reachable, asymptotic, or unreachable', () => {
    const inputs = { ...DEFAULT_FIRE, current: 0, monthly: 1_000, annualReturn: .99 ** 12 - 1, target: 50_000 };
    const months = monthsToTarget(inputs);
    assert.notEqual(months, null);
    close(futureValue(inputs, months!), inputs.target);
    assert.equal(monthsToTarget({ ...inputs, target: 110_000 }), null);
    assert.equal(monthsToTarget({ ...inputs, target: inputs.monthly / -monthlyRate(inputs.annualReturn) }), null);
    assert.equal(monthsToTarget({ ...inputs, current: 100_000, target: 150_000, monthly: 0 }), null);
    for (const monthly of [.01, 1_000_000_000]) {
        const equilibrium = monthly / -monthlyRate(inputs.annualReturn);
        assert.equal(monthsToTarget({ ...inputs, monthly, target: equilibrium }), null);
        assert.notEqual(monthsToTarget({ ...inputs, monthly, target: equilibrium * (1 - 1e-8) }), null);
    }
});

test('zero and nearly zero returns retain contribution accuracy', () => {
    const inputs = { ...DEFAULT_FIRE, current: 1_000, monthly: 100, annualReturn: 0, target: 2_000 };
    assert.equal(monthsToTarget(inputs), 10);
    assert.equal(futureValue(inputs, 10), 2_000);
    close(futureValue({ ...inputs, annualReturn: 1e-12 }, 10), 2_000);
    assert.equal(monthsToTarget({ ...inputs, monthly: 0 }), null);
});

test('integer-month targets resist tiny-rate roundoff and do not move to month thirteen', () => {
    const now = new Date(2025, 0, 31, 12);
    for (const annualReturn of [1e-12, .05, .10, -.05]) {
        const inputs = { ...DEFAULT_FIRE, current: 100_000, monthly: 1_000, annualReturn };
        const months = monthsToTarget({ ...inputs, target: futureValue(inputs, 12) });
        assert.equal(months, 12);
        const date = targetDateAfterMonths(months!, now)!;
        assert.equal(date.getFullYear(), 2026);
        assert.equal(date.getMonth(), 0);
        assert.equal(date.getDate(), 31);
    }
});

test('invalid growth inputs produce unavailable goals', () => {
    assert.equal(monthsToTarget({ ...DEFAULT_FIRE, annualReturn: -1 }), null);
    assert.equal(monthsToTarget({ ...DEFAULT_FIRE, annualReturn: NaN }), null);
    assert.equal(monthsToTarget({ ...DEFAULT_FIRE, target: Infinity }), null);
    assert.equal(computeFire({ ...DEFAULT_FIRE, annualReturn: -2 }).targetDate, null);
});

test('goal date uses completed months and clamps month end without skipping February', () => {
    const now = new Date(2025, 0, 31, 12);
    const date = targetDateAfterMonths(.8, now)!;
    assert.equal(date.getFullYear(), 2025);
    assert.equal(date.getMonth(), 1);
    assert.equal(date.getDate(), 28);
    assert.equal(targetDateAfterMonths(Infinity, now), null);
});
