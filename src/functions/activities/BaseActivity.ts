import type { MicrosoftRewardsBot } from '../../index'
import { recordActivityFailure } from '../../util/ActivityResults'

export abstract class BaseActivity {
    protected readonly bot: MicrosoftRewardsBot
    private executed = false

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    protected markExecuted(): void {
        this.executed = true
    }

    protected recordFailure(error: unknown): void {
        recordActivityFailure(this.constructor.name, error)
    }

    public didExecute(): boolean {
        return this.executed
    }
}
