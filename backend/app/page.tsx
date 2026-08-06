import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

interface Row {
  id: number;
  hostname: string;
  query: string;
  matched_name: string;
  score: number;
  confirmed: number;
  created_at: string;
}

export default function Page() {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM resolutions ORDER BY id DESC LIMIT 100`).all() as Row[];

  return (
    <main style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1>Hintora — confirmed resolutions</h1>
      <p style={{ opacity: 0.75, lineHeight: 1.5 }}>
        Every row here is a query the extension resolved and the user confirmed (👍) or corrected
        (picked a &quot;did you mean&quot; alternative). <code>GET /api/resolutions?hostname=...</code>{" "}
        turns confirmed rows into score boosts the matcher applies on the next similar query on that
        site — this is the extension&apos;s &quot;gets more reliable with usage&quot; idea, made real
        instead of just described.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16, fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #3a3364" }}>
            <th style={{ padding: 8 }}>Host</th>
            <th style={{ padding: 8 }}>Query</th>
            <th style={{ padding: 8 }}>Matched</th>
            <th style={{ padding: 8 }}>Score</th>
            <th style={{ padding: 8 }}>Confirmed</th>
            <th style={{ padding: 8 }}>When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderBottom: "1px solid #241f42" }}>
              <td style={{ padding: 8 }}>{r.hostname}</td>
              <td style={{ padding: 8 }}>{r.query}</td>
              <td style={{ padding: 8 }}>{r.matched_name}</td>
              <td style={{ padding: 8 }}>{r.score.toFixed(1)}</td>
              <td style={{ padding: 8 }}>{r.confirmed ? "✅" : "—"}</td>
              <td style={{ padding: 8, opacity: 0.6 }}>{r.created_at}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: 16, opacity: 0.6 }}>
                No resolutions logged yet — use the extension on a page, confirm a match (👍), then
                refresh this page.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
