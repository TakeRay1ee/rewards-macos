interface IdleQueue {
    onIdle(): Promise<void>
}

export async function flushQueue(queue: IdleQueue, timeoutMs = 5000): Promise<void> {
    let timer: NodeJS.Timeout | undefined

    try {
        await Promise.race([
            queue.onIdle(),
            new Promise<void>(resolve => {
                timer = setTimeout(resolve, timeoutMs)
            })
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}
