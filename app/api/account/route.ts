import { NextResponse, NextRequest } from 'next/server';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import fs from 'fs';
import path from 'path';

// Header-only mode: Requires x-flex-token and x-flex-query-id headers
const BASE_URL = "https://www.interactivebrokers.com/Universal/servlet/FlexStatementService.SendRequest";
const PICKUP_URL = "https://www.interactivebrokers.com/Universal/servlet/FlexStatementService.GetStatement";

// XML Parser Configuration
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseAttributeValue: true
});

export async function GET(request: NextRequest) {
    // Get credentials exclusively from headers
    const FLEX_TOKEN = request.headers.get('x-flex-token');
    const FLEX_QUERY_ID = request.headers.get('x-flex-query-id');

    // // Mock Data Mode
    // try {
    //     console.log("USING MOCK DATA FROM xmlMock.xml");
    //     const mockPath = path.join(process.cwd(), 'xmlMock.xml');
    //     const mockXml = fs.readFileSync(mockPath, 'utf-8');
    //     const parsedMock = parser.parse(mockXml);

    //     // Structure matches FlexQueryResponse
    //     const reportData = parsedMock.FlexQueryResponse;

    //     if (!reportData) {
    //         return NextResponse.json({ error: "Invalid Mock Data: FlexQueryResponse missing" }, { status: 500 });
    //     }

    if (!FLEX_TOKEN || !FLEX_QUERY_ID) {
        return NextResponse.json({ error: "Missing Flex Token or Query ID. Please configure .env or provide credentials in request headers." }, { status: 400 });
    }

    // Log info (mask token)
    console.log(`Using Token: ${FLEX_TOKEN.substring(0, 4)}... and Query ID: ${FLEX_QUERY_ID}`);

    try {
        // 1. Send Request
        const initialResponse = await axios.get(BASE_URL, {
            params: { t: FLEX_TOKEN, q: FLEX_QUERY_ID, v: '3' },
            headers: { 'User-Agent': 'Java/1.8.0_202' } // Mimic Java client just in case
        });

        const initialData = parser.parse(initialResponse.data);

        // fast-xml-parser usually returns the root element as a key
        const responseRoot = initialData.FlexStatementResponse || initialData;

        if (responseRoot.Status === 'Fail') {
            return NextResponse.json({ error: responseRoot.ErrorMessage }, { status: 400 });
        }

        const referenceCode = responseRoot.ReferenceCode;
        if (!referenceCode) {
            console.error("Full Initial Response:", JSON.stringify(initialData, null, 2));
            return NextResponse.json({ error: "No reference code returned. Check inputs." }, { status: 500 });
        }


        // 2. Poll for Report (Max 20 retries, 2s interval = 40s max)
        let reportData = null;
        for (let i = 0; i < 20; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s

            try {
                const pickupResponse = await axios.get(PICKUP_URL, {
                    params: { t: FLEX_TOKEN, q: referenceCode, v: '3' },
                    headers: { 'User-Agent': 'Java/1.8.0_202' }
                });

                const parsedPickup = parser.parse(pickupResponse.data);

                // Identify root for pickup response (FlexStatementResponse or FlexQueryResponse)
                // If success, it might return FlexQueryResponse directly or wrapped
                const pickupRoot = parsedPickup.FlexStatementResponse || parsedPickup.FlexQueryResponse || parsedPickup;

                if (pickupRoot?.Status === 'Success' || parsedPickup.FlexQueryResponse) {
                    if (parsedPickup.FlexQueryResponse) {
                        reportData = parsedPickup.FlexQueryResponse;
                        break;
                    } else if (pickupRoot.FlexStatements) {
                        // Some formats might have FlexStatements directly under root if it's FlexQueryResponse
                        reportData = pickupRoot;
                        break;
                    }
                } else if (pickupRoot?.Status === 'Fail') {
                    const code = pickupRoot.ErrorCode;
                    if (code === '1019' || code === '1021') continue;
                }
            } catch (err) {
                console.error("Polling error:", err);
            }
        }

        if (!reportData) {
            return NextResponse.json({ error: "Failed to retrieve report after retries. Check server logs." }, { status: 504 });
        }


        // 3. Process Data — handle single OR multiple FlexStatements (multi-account)
        const statementsRaw = reportData.FlexStatements?.FlexStatement;
        if (!statementsRaw) {
            console.error("Statement is empty or undefined. ReportData dump:", JSON.stringify(reportData, null, 2));
            return NextResponse.json({ error: "Empty statement in report" }, { status: 500 });
        }
        const stmtList: any[] = Array.isArray(statementsRaw) ? statementsRaw : [statementsRaw];
        console.log(`Processing ${stmtList.length} FlexStatement(s)`);

        // Accumulators for equity metrics (we sum across all accounts)
        let totalCash = 0;
        let totalNetLiq = 0;
        let totalStock = 0;
        let totalOptionsShort = 0;
        let latestReportDate: string | null = null;
        let baseCurrency = stmtList[0]?.currency || 'CZK';
        let eurToCzkRate: number | null = null;

        const positions: any[] = [];

        for (const stmt of stmtList) {
            // --- Equity Summary ---
            const equitySummaryRoot = stmt.EquitySummaryInBase;
            const equitySummary = equitySummaryRoot?.EquitySummaryByReportDateInBase;

            if (equitySummary) {
                const eqArray: any[] = Array.isArray(equitySummary) ? equitySummary : [equitySummary];
                // Take the most recent reportDate for this statement
                eqArray.sort((a: any, b: any) => Number(b.reportDate) - Number(a.reportDate));
                const eq = eqArray[0];

                totalCash += Number(eq.cash ?? eq.cashBalance ?? 0);
                totalNetLiq += Number(eq.total ?? eq.totalNav ?? 0);
                totalStock += Number(eq.stockLong ?? eq.stock ?? eq.stockMarketValue ?? 0);
                totalOptionsShort += Number(eq.optionsShort ?? eq.options ?? eq.optionMarketValue ?? 0);

                if (eq.reportDate) {
                    const formatted = formatDate(String(eq.reportDate));
                    if (!latestReportDate || String(eq.reportDate) > latestReportDate) {
                        latestReportDate = formatted;
                    }
                }
            } else {
                console.log(`EquitySummary missing for account ${stmt.accountId}`);
            }

            // --- Positions ---
            const openPositions = stmt.OpenPositions?.OpenPosition;
            const positionsList: any[] = Array.isArray(openPositions)
                ? openPositions
                : (openPositions ? [openPositions] : []);

            for (const pos of positionsList) {
                if (pos.levelOfDetail && pos.levelOfDetail.toUpperCase() !== 'SUMMARY') continue;

                const quantity = Number(pos.position || 0);
                const marketValue = Number(pos.positionValue || 0);

                let commitedCapital = 0;
                if (pos.assetCategory === 'OPT' && quantity < 0 && pos.putCall === 'P') {
                    commitedCapital = Number(pos.strike) * Number(pos.multiplier) * quantity;
                }

                positions.push({
                    tag: 'Position',
                    value: {
                        symbol: pos.symbol,
                        underlying: pos.underlyingSymbol,
                        quantity,
                        markPrice: Number(pos.markPrice || 0),
                        marketValue,
                        assetClass: pos.assetCategory,
                        fxRateToBase: Number(pos.fxRateToBase || 1),
                        multiplier: Number(pos.multiplier || 1),
                        expiry: pos.expiry ? formatDate(pos.expiry) : null,
                        strike: Number(pos.strike || 0),
                        type: pos.putCall === 'P' ? 'PUT' : (pos.putCall === 'C' ? 'CALL' : null),
                        commitedCapital,
                        costPrice: Number(pos.costBasisPrice || pos.costPrice || 0),
                        costBasisPrice: Number(pos.costBasisPrice || 0),
                        fifoPnlUnrealized: Number(pos.fifoPnlUnrealized || 0),
                        unrealizedPnL: Number(pos.unrealizedPnL || 0),
                        costBasisMoney: Number(pos.costBasisMoney || 0),
                    },
                    currency: pos.currency
                });
            }

            // --- EUR/CZK rate (take from first statement that has it) ---
            if (eurToCzkRate === null) {
                const ratesList = stmt.ConversionRates?.ConversionRate;
                if (ratesList) {
                    const ratesArray: any[] = Array.isArray(ratesList) ? ratesList : [ratesList];
                    const eurRate = ratesArray.find((r: any) => r.fromCurrency === 'EUR' && r.toCurrency === 'CZK');
                    if (eurRate) eurToCzkRate = Number(eurRate.rate);
                }
            }
        }

        // Build summary array from accumulated values
        const summary: any[] = [];
        summary.push({ tag: 'AvailableFunds', value: totalCash, currency: baseCurrency });
        summary.push({ tag: 'NetLiquidation', value: totalNetLiq, currency: baseCurrency });
        summary.push({ tag: 'StockValueLong', value: totalStock, currency: baseCurrency });
        summary.push({ tag: 'OptionValueShort', value: totalOptionsShort, currency: baseCurrency });
        if (latestReportDate) summary.push({ tag: 'ReportDate', value: latestReportDate });
        if (eurToCzkRate !== null) summary.push({ tag: 'EurToCzkRate', value: eurToCzkRate });

        return NextResponse.json([...summary, ...positions]);


    } catch (error) {
        console.error("API Error:", error);
        return NextResponse.json({ error: "Internal Server Error: " + error }, { status: 500 });
    }
}

// Helper to format YYYYMMDD to DD.MM.YYYY
function formatDate(dateStr: string) {
    if (!dateStr || dateStr.length !== 8) return dateStr;
    return `${dateStr.substring(6, 8)}.${dateStr.substring(4, 6)}.${dateStr.substring(0, 4)}`;
}
