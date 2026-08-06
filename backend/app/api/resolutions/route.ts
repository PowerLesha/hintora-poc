import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Permissive CORS: this is a local-only demo backend, never meant to be
// deployed/exposed. In production this would be scoped to the customer's
// own domains, same as any embeddable SDK's API.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new NextResponse(null, { headers: CORS_HEADERS });
}

interface HintRow {
  query: string;
  matchedName: string;
  score: number;
  confirmations: number;
}

export async function GET(request: NextRequest) {
  const hostname = request.nextUrl.searchParams.get("hostname");
  if (!hostname) {
    return NextResponse.json({ error: "hostname is required" }, { status: 400, headers: CORS_HEADERS });
  }

  const db = getDb();
  // One row per distinct (query, matched control) pair that's ever been
  // confirmed for this host, most-repeated first — this is the whole
  // "gets more reliable with usage" mechanism: it's what the extension
  // merges into its scoring on the next similar query.
  const rows = db
    .prepare(
      `SELECT query, matched_name as matchedName, MAX(score) as score, COUNT(*) as confirmations
       FROM resolutions
       WHERE hostname = ? AND confirmed = 1
       GROUP BY query, matched_name
       ORDER BY confirmations DESC
       LIMIT 200`
    )
    .all(hostname) as HintRow[];

  return NextResponse.json({ hints: rows }, { headers: CORS_HEADERS });
}

interface LogBody {
  hostname: string;
  query: string;
  matchedName: string;
  score: number;
  confirmed: boolean;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Partial<LogBody>;
  if (!body.hostname || !body.query || !body.matchedName) {
    return NextResponse.json(
      { error: "hostname, query, matchedName are required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO resolutions (hostname, query, matched_name, score, confirmed) VALUES (?, ?, ?, ?, ?)`
  ).run(body.hostname, body.query, body.matchedName, body.score ?? 0, body.confirmed ? 1 : 0);

  return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
}
