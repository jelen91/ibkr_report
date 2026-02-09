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


        // 3. Process Data
        const statements = reportData.FlexStatements?.FlexStatement;

        const stmt = Array.isArray(statements) ? statements[0] : statements;

        if (!stmt) {
            console.error("Statement is empty or undefined. ReportData dump:", JSON.stringify(reportData, null, 2));
            return NextResponse.json({ error: "Empty statement in report" }, { status: 500 });
        }

        // Extract Summary
        const summary = [];
        // Correct path based on logs: stmt.EquitySummaryInBase -> EquitySummaryByReportDateInBase
        const equitySummaryRoot = stmt.EquitySummaryInBase;
        const equitySummary = equitySummaryRoot?.EquitySummaryByReportDateInBase;

        if (equitySummary) {
            // Fix: Sort by reportDate descending to get the latest
            const eqArray = Array.isArray(equitySummary) ? equitySummary : [equitySummary];
            eqArray.sort((a: any, b: any) => Number(b.reportDate) - Number(a.reportDate));
            eqArray.sort((a: any, b: any) => Number(b.reportDate) - Number(a.reportDate));
            const eq = eqArray[0];

            // Map fields based on User's XML format (cash, total, stockLong, optionsShort)
            // Fallback to standard names just in case

            // AvailableFunds (Cash)
            const cash = eq.cash ?? eq.cashBalance;
            if (cash !== undefined) summary.push({ tag: 'AvailableFunds', value: Number(cash), currency: stmt.currency });

            // NetLiquidation (Total NAV)
            const netLiq = eq.total ?? eq.totalNav;
            if (netLiq !== undefined) summary.push({ tag: 'NetLiquidation', value: Number(netLiq), currency: stmt.currency });

            // Stock Value (Long)
            const stock = eq.stockLong ?? eq.stock ?? eq.stockMarketValue;
            if (stock !== undefined) summary.push({ tag: 'StockValueLong', value: Number(stock), currency: stmt.currency });

            // Option Value (Short)
            const options = eq.optionsShort ?? eq.options ?? eq.optionMarketValue;
            if (options !== undefined) summary.push({ tag: 'OptionValueShort', value: Number(options), currency: stmt.currency });

            // InitMarginReq (Not present in user XML, keep optional)
            if (eq.initMarginReq !== undefined) summary.push({ tag: 'InitMarginReq', value: Number(eq.initMarginReq), currency: stmt.currency });

            // Report Date
            if (eq.reportDate) {
                summary.push({ tag: 'ReportDate', value: formatDate(String(eq.reportDate)) });
            }

        } else {
            console.log("EquitySummary details missing. Root Keys:", equitySummaryRoot ? Object.keys(equitySummaryRoot) : "Root undefined");
        }

        // Extract Positions
        const positions = [];
        const openPositionsRoot = stmt.OpenPositions;
        // Try common variations
        let openPositions = openPositionsRoot?.OpenPosition;

        const positionsList = Array.isArray(openPositions) ? openPositions : (openPositions ? [openPositions] : []);

        for (const [index, pos] of positionsList.entries()) {
            if (pos.levelOfDetail && pos.levelOfDetail.toUpperCase() !== 'SUMMARY') continue;

            let marketValue = Number(pos.positionValue || 0);
            const quantity = Number(pos.position || 0);

            // Blocked Capital Calculation for Short Puts
            let commitedCapital = 0;
            if (pos.assetCategory === 'OPT' && quantity < 0 && pos.putCall === 'P') {
                commitedCapital = Number(pos.strike) * Number(pos.multiplier) * quantity;
            }

            positions.push({
                tag: 'Position',
                value: {
                    symbol: pos.symbol,
                    underlying: pos.underlyingSymbol,
                    quantity: quantity,
                    markPrice: Number(pos.markPrice || 0),
                    marketValue: marketValue,
                    assetClass: pos.assetCategory,
                    fxRateToBase: Number(pos.fxRateToBase || 1),
                    multiplier: Number(pos.multiplier || 1),
                    expiry: pos.expiry ? formatDate(pos.expiry) : null,
                    strike: Number(pos.strike || 0),
                    type: pos.putCall === 'P' ? 'PUT' : (pos.putCall === 'C' ? 'CALL' : null),
                    commitedCapital: commitedCapital,
                    costPrice: Number(pos.costBasisPrice || pos.costPrice || 0),
                    costBasisPrice: Number(pos.costBasisPrice || 0),
                    fifoPnlUnrealized: Number(pos.fifoPnlUnrealized || 0),
                    unrealizedPnL: Number(pos.unrealizedPnL || 0),
                    costBasisMoney: Number(pos.costBasisMoney || 0),
                    debugKeys: Object.keys(pos) // TEMPORARY DEBUG
                },
                currency: pos.currency
            });
        }

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
