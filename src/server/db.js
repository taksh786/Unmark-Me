import pg from 'pg';

let pool = null;

export class DatabaseNotConfiguredError extends Error {}

function isLocalDatabase(connectionString) {
    try {
        const { hostname } = new URL(connectionString);
        return ['localhost', '127.0.0.1', '::1', ''].includes(hostname);
    } catch {
        return false;
    }
}

// One pool per process. Serverless instances reuse it across warm invocations.
export function getDb() {
    if (pool) return pool;
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new DatabaseNotConfiguredError('DATABASE_URL is not set');
    }
    pool = new pg.Pool({
        connectionString,
        max: 5,
        ssl: isLocalDatabase(connectionString) ? false : { rejectUnauthorized: true }
    });
    return pool;
}
