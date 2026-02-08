import { NextResponse, NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
    const headerToken = request.headers.get('x-flex-token');
    const headerQueryId = request.headers.get('x-flex-query-id');

    const connected = !!(headerToken && headerQueryId);
    return NextResponse.json({ connected });
}
