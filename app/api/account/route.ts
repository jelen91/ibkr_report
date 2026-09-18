import { NextResponse, NextRequest } from 'next/server';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { parseAccountReport } from '../../lib/account';

// Header-only mode: Requires x-flex-token and x-flex-query-id headers
// v3 endpoints per https://www.interactivebrokers.com/campus/ibkr-api-page/flex-web-service/
const BASE_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest";
const PICKUP_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement";

// Transient IBKR error codes — safe to retry after a delay.
// 1001 statement-not-generated, 1004 incomplete, 1005-1008 P/L data not ready,
// 1009 server-heavy-load, 1018 rate-limit, 1019 in-progress, 1021 retrieval-failed.
const RETRYABLE_CODES = new Set([1001, 1004, 1005, 1006, 1007, 1008, 1009, 1018, 1019, 1021]);
const isRetryableCode = (code: unknown) => RETRYABLE_CODES.has(Number(code));

// XML Parser Configuration
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseAttributeValue: false
});

export async function GET(request: NextRequest) {
    // Get credentials exclusively from headers
    const FLEX_TOKEN = request.headers.get('x-flex-token');
    const FLEX_QUERY_ID = request.headers.get('x-flex-query-id');

    if (!FLEX_TOKEN || !FLEX_QUERY_ID) {
        return NextResponse.json({ error: "Missing Flex Token or Query ID. Provide credentials in request headers." }, { status: 400 });
    }


    try {
        // 1. Send Request — retry on transient IBKR errors (see RETRYABLE_CODES)
        const MAX_INITIAL_ATTEMPTS = 3;
        const INITIAL_RETRY_DELAY_MS = 30000;

        let responseRoot: any = null;
        let lastFailErrorCode: string | number | undefined;
        let lastFailErrorMessage: string | undefined;

        for (let attempt = 1; attempt <= MAX_INITIAL_ATTEMPTS; attempt++) {
            const initialResponse = await axios.get(BASE_URL, {
                params: { t: FLEX_TOKEN, q: FLEX_QUERY_ID, v: '3' },
                headers: { 'User-Agent': 'Java/1.8.0_202' },
                timeout: 30000
            });

            const initialData = parser.parse(initialResponse.data);
            responseRoot = initialData.FlexStatementResponse || initialData;

            if (responseRoot.Status !== 'Fail') break;

            lastFailErrorCode = responseRoot.ErrorCode;
            lastFailErrorMessage = responseRoot.ErrorMessage;
            console.error(`IBKR initial request failed (attempt ${attempt}/${MAX_INITIAL_ATTEMPTS}): code=${lastFailErrorCode} message="${lastFailErrorMessage}"`);

            if (!isRetryableCode(lastFailErrorCode) || attempt === MAX_INITIAL_ATTEMPTS) {
                return NextResponse.json({ error: lastFailErrorMessage, code: lastFailErrorCode }, { status: 400 });
            }

            await new Promise(resolve => setTimeout(resolve, INITIAL_RETRY_DELAY_MS));
        }

        const referenceCode = responseRoot.ReferenceCode;
        if (!referenceCode) {
            console.error("IBKR returned no statement reference");
            return NextResponse.json({ error: "No reference code returned. Check inputs." }, { status: 500 });
        }


        // 2. Poll for Report (Max 20 retries, 2s interval = 40s max)
        let reportData = null;
        for (let i = 0; i < 20; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s

            try {
                const pickupResponse = await axios.get(PICKUP_URL, {
                    params: { t: FLEX_TOKEN, q: referenceCode, v: '3' },
                    headers: { 'User-Agent': 'Java/1.8.0_202' },
                    timeout: 30000
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
                    if (isRetryableCode(code)) continue;
                    console.error(`IBKR pickup failed non-retryable: code=${code} message="${pickupRoot.ErrorMessage}"`);
                    return NextResponse.json({ error: pickupRoot.ErrorMessage, code }, { status: 400 });
                }
            } catch (err) {
                console.error("IBKR polling request failed");
            }
        }

        if (!reportData) {
            return NextResponse.json({ error: "Failed to retrieve report after retries. Check server logs." }, { status: 504 });
        }


        try {
            return NextResponse.json(parseAccountReport(reportData), { headers: { 'Cache-Control': 'no-store' } });
        } catch (error) {
            return NextResponse.json({ error: error instanceof Error ? error.message : 'Neplatný Flex report.' }, { status: 422 });
        }


    } catch (error) {
        console.error("IBKR account retrieval failed");
        return NextResponse.json({ error: "Stažení Flex reportu selhalo. Zkuste požadavek později." }, { status: 502 });
    }
}
