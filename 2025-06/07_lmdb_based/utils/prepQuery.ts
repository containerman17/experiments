import Database from 'better-sqlite3';

export class QueryPrepper {
    private db: Database;
    private prepped: Map<string, ReturnType<Database['prepare']>>;

    constructor(db: Database) {
        this.db = db;
        this.prepped = new Map();
    }

    prepare(query: string) {
        if (this.prepped.has(query)) return this.prepped.get(query)!;
        const prepped = this.db.prepare(query);
        this.prepped.set(query, prepped);
        return prepped;
    }
}
