import { AsyncLocalStorage } from 'node:async_hooks'

const currentResults = new AsyncLocalStorage<ActivityResults>()

/** One account flow owns its results, including concurrent mobile/desktop work. */
export class ActivityResults {
    private readonly failures = new Set<string>()

    run<T>(operation: () => Promise<T>): Promise<T> {
        return currentResults.run(this, operation)
    }

    record(activity: string, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error)
        this.failures.add(`${activity}: ${message}`)
    }

    summary(): string | undefined {
        return this.failures.size ? [...this.failures].join('; ') : undefined
    }
}

/** Record terminal activity failures explicitly, independently of log level or retry diagnostics. */
export function recordActivityFailure(activity: string, error: unknown): void {
    currentResults.getStore()?.record(activity, error)
}
