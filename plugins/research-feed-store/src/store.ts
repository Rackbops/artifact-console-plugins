import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

/**
 * The local SQLite mirror of the research-triage machine feed (#453 decision 6/9). One table,
 * `gradings`, keyed by the feed's own `id` (upsert -- a correction re-surfaces a grading with a new
 * cursor under the SAME id, so it replaces the row rather than duplicating it); `meta` holds the
 * poll cursor and last-poll state as plain key/value JSON.
 *
 * `applyPage` commits a whole page (every upsert + the advanced cursor) in ONE transaction, so a
 * crash mid-page never advances the cursor past unsaved rows -- the next poll re-reads that page,
 * which is harmless since every upsert is idempotent by id.
 */

export interface Correction {
  correctedVerdict: string | null
  correctedWatchLive: boolean | null
  note: string | null
  transcriptMissedIt: boolean | null
  createdAt: string
}

export interface FeedItem {
  id: string
  cursor: string
  kind: "video" | "article"
  title: string | null
  url: string
  verdict: "keep" | "grey_area" | "drop"
  signalScore: number | null
  summary: string | null
  keyTakeaways: string[]
  watchLive: boolean
  watchLiveReason: string | null
  gradedAt: string
  corrections: Correction[]
}

export interface StoredGrading extends FeedItem {
  mirroredAt: string
}

export interface PollState {
  state: "ok" | "unreachable" | "unconfigured"
  lastAttemptAt: string | undefined
  lastSuccessAt: string | undefined
  error: string | undefined
}

export interface VerdictFilter {
  verdict?: string
  watchLive?: boolean
  limit?: number
}

const SCHEMA_VERSION = 1

interface Row {
  id: string
  cursor: string
  kind: string
  title: string | null
  url: string
  verdict: string
  signal_score: number | null
  summary: string | null
  key_takeaways: string
  watch_live: number
  watch_live_reason: string | null
  graded_at: string
  corrections: string
  mirrored_at: string
}

function rowToGrading(row: Row): StoredGrading {
  return {
    id: row.id,
    cursor: row.cursor,
    kind: row.kind as FeedItem["kind"],
    title: row.title,
    url: row.url,
    verdict: row.verdict as FeedItem["verdict"],
    signalScore: row.signal_score,
    summary: row.summary,
    keyTakeaways: JSON.parse(row.key_takeaways) as string[],
    watchLive: row.watch_live === 1,
    watchLiveReason: row.watch_live_reason,
    gradedAt: row.graded_at,
    corrections: JSON.parse(row.corrections) as Correction[],
    mirroredAt: row.mirrored_at,
  }
}

export class Store {
  #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  /** Upserts every item in `items` by id and advances the cursor to `nextCursor`, all in one
   *  transaction -- both effects land together, or neither does. */
  applyPage(items: FeedItem[], nextCursor: string): void {
    this.#db.exec("BEGIN IMMEDIATE")
    try {
      const stmt = this.#db.prepare(`
        INSERT INTO gradings
          (id, cursor, kind, title, url, verdict, signal_score, summary, key_takeaways,
           watch_live, watch_live_reason, graded_at, corrections, mirrored_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          cursor = excluded.cursor,
          kind = excluded.kind,
          title = excluded.title,
          url = excluded.url,
          verdict = excluded.verdict,
          signal_score = excluded.signal_score,
          summary = excluded.summary,
          key_takeaways = excluded.key_takeaways,
          watch_live = excluded.watch_live,
          watch_live_reason = excluded.watch_live_reason,
          graded_at = excluded.graded_at,
          corrections = excluded.corrections,
          mirrored_at = excluded.mirrored_at
      `)
      const mirroredAt = new Date().toISOString()
      for (const item of items) {
        stmt.run(
          item.id,
          item.cursor,
          item.kind,
          item.title,
          item.url,
          item.verdict,
          item.signalScore,
          item.summary,
          JSON.stringify(item.keyTakeaways),
          item.watchLive ? 1 : 0,
          item.watchLiveReason,
          item.gradedAt,
          JSON.stringify(item.corrections),
          mirroredAt,
        )
      }
      this.#setMeta("cursor", nextCursor)
      this.#db.exec("COMMIT")
    } catch (err) {
      this.#db.exec("ROLLBACK")
      throw err
    }
  }

  cursor(): string {
    return this.#getMeta("cursor") ?? "0"
  }

  /** The latest grading per url (by graded_at, then cursor -- decision 5), optionally filtered. */
  latestPerUrl(filter: VerdictFilter = {}): StoredGrading[] {
    const rows = this.#db
      .prepare(`
        SELECT g.* FROM gradings g
        INNER JOIN (
          SELECT url, MAX(graded_at) AS max_graded_at
          FROM gradings
          GROUP BY url
        ) latest ON g.url = latest.url AND g.graded_at = latest.max_graded_at
        ORDER BY g.graded_at DESC, CAST(g.cursor AS REAL) DESC
      `)
      .all() as unknown as Row[]

    // graded_at ties (two gradings for the same url sharing a timestamp) are broken by the highest
    // cursor, done in JS since SQLite's MAX() over graded_at alone can't express that tiebreak.
    const byUrl = new Map<string, Row>()
    for (const row of rows) {
      const current = byUrl.get(row.url)
      if (!current || Number(row.cursor) > Number(current.cursor)) byUrl.set(row.url, row)
    }

    let gradings = [...byUrl.values()]
      .sort((a, b) => Number(b.cursor) - Number(a.cursor))
      .map(rowToGrading)

    if (filter.verdict !== undefined) {
      gradings = gradings.filter((g) => g.verdict === filter.verdict)
    }
    if (filter.watchLive !== undefined) {
      gradings = gradings.filter((g) => g.watchLive === filter.watchLive)
    }
    if (filter.limit !== undefined) {
      gradings = gradings.slice(0, filter.limit)
    }
    return gradings
  }

  byId(id: string): StoredGrading | undefined {
    const row = this.#db.prepare("SELECT * FROM gradings WHERE id = ?").get(id) as Row | undefined
    return row ? rowToGrading(row) : undefined
  }

  /** Every grading sharing `url`, newest first. */
  historyFor(url: string): StoredGrading[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM gradings WHERE url = ? ORDER BY graded_at DESC, CAST(cursor AS REAL) DESC",
      )
      .all(url) as unknown as Row[]
    return rows.map(rowToGrading)
  }

  /** Every grading, newest first, capped at `limit`. */
  history(limit: number): StoredGrading[] {
    const rows = this.#db
      .prepare("SELECT * FROM gradings ORDER BY graded_at DESC, CAST(cursor AS REAL) DESC LIMIT ?")
      .all(limit) as unknown as Row[]
    return rows.map(rowToGrading)
  }

  count(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM gradings").get() as { n: number }
    return row.n
  }

  setPollState(state: PollState): void {
    this.#setMeta("pollState", JSON.stringify(state))
  }

  pollState(): PollState | undefined {
    const raw = this.#getMeta("pollState")
    return raw ? (JSON.parse(raw) as PollState) : undefined
  }

  close(): void {
    this.#db.close()
  }

  #getMeta(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  #setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value)
  }
}

export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS gradings (
      id TEXT PRIMARY KEY,
      cursor TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      url TEXT NOT NULL,
      verdict TEXT NOT NULL,
      signal_score REAL,
      summary TEXT,
      key_takeaways TEXT NOT NULL,
      watch_live INTEGER NOT NULL,
      watch_live_reason TEXT,
      graded_at TEXT NOT NULL,
      corrections TEXT NOT NULL,
      mirrored_at TEXT NOT NULL
    )
  `)
  db.exec("CREATE INDEX IF NOT EXISTS gradings_url_idx ON gradings(url)")
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
  if (version < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
  return new Store(db)
}
