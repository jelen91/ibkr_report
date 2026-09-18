import { NextResponse, NextRequest } from 'next/server';
import { getPerformanceSeries } from '@/app/lib/flexPerformance';

// Vrací syrové řady (NAV, cash flows, kurzy). TWR se počítá až na klientu,
// protože při zapnuté záložce "Vše" se musí nejdřív sečíst NAV napříč účty
// a teprve nad součtem řetězit výnosy.
export async function GET(request: NextRequest) {
    const token = request.headers.get('x-flex-token');
    const queryId = request.headers.get('x-flex-query-id');
    const force = request.nextUrl.searchParams.get('force') === '1';

    if (!token || !queryId) {
        return NextResponse.json({ error: 'Chybí Flex Token nebo Query ID.' }, { status: 400 });
    }

    try {
        const series = await getPerformanceSeries(token, queryId, { force });

        if (series.nav.length < 2) {
            return NextResponse.json({
                error: 'Flex query vrátilo jen ' + series.nav.length + ' denní NAV. '
                    + 'Nastav v IBKR u query období na "Last 365 Calendar Days" a zapni sekci '
                    + '"Net Asset Value (NAV) in Base".',
            }, { status: 422 });
        }

        return NextResponse.json(series);
    } catch (error: any) {
        console.error('Performance API error:', error?.name ?? 'Error');
        return NextResponse.json({ error: error?.isAxiosError ? 'IBKR spojení selhalo. Zkus načtení opakovat.' : String(error?.message ?? error) }, { status: 500 });
    }
}
