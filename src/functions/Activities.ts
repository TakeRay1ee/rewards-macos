import type { MicrosoftRewardsBot } from '../index'
import { recordActivityFailure } from '../util/ActivityResults'

import { DailySet } from './activities/rewards/DailySet'
import { MorePromotions } from './activities/rewards/MorePromotions'
import { PunchCards } from './activities/rewards/PunchCards'

import { DailyCheckIn } from './activities/app/DailyCheckIn'
import { ReadToEarn } from './activities/app/ReadToEarn'
import { AppReward } from './activities/app/AppReward'
import { AppPromotions } from './activities/app/AppPromotions'

import { UrlReward } from './activities/api/UrlReward'
import { ClaimBonusPoints } from './activities/api/ClaimBonusPoints'
import { EnsureStreakProtection } from './activities/api/EnsureStreakProtection'
import { ClaimReward } from './activities/api/ClaimReward'
import { ActivateSearchPerk } from './activities/api/ActivateSearchPerk'
import { VisualSearch } from './activities/visualSearch/VisualSearch'

import { Search as BrowserSearch } from './activities/search/BrowserSearch'
import { SearchOnBing as BrowserSearchOnBing } from './activities/search/BrowserSearchOnBing'

import { ApiSearch } from './activities/experimental/ApiSearch'
import { ApiSearchOnBing } from './activities/experimental/ApiSearchOnBing'
import { EdgeBrowsing } from './activities/experimental/EdgeBrowsing'

import type { Page } from 'patchright'
import type { BasePromotion, DashboardData } from '../interface/DashboardData'
import type { AppDashboardData, Promotion } from '../interface/AppDashBoardData'
import type { QuestChild } from '../browser/ReactFunc'

export default class Activities {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    private async execute<T>(activity: string, operation: () => Promise<T>, failedResult: T): Promise<T> {
        try {
            return await operation()
        } catch (error) {
            recordActivityFailure(activity, error)
            this.bot.logger.error(this.bot.isMobile, activity, error instanceof Error ? error : String(error))
            // An independent activity failure must not prevent later enabled activities.
            return failedResult
        }
    }

    doSearch = async (page: Page, isMobile: boolean): Promise<number> => {
        return this.execute(
            'doSearch',
            async () => {
                if (this.bot.config.experimental.apiSearch) {
                    return await new ApiSearch(this.bot).doSearch(isMobile)
                }
                return await new BrowserSearch(this.bot).doSearch(page, isMobile)
            },
            0
        )
    }

    doBonusSearches = async (page: Page): Promise<number> => {
        return this.execute(
            'doBonusSearches',
            async () => {
                if (this.bot.config.experimental.apiSearch) {
                    return await new ApiSearch(this.bot).doBonusSearches()
                }
                return await new BrowserSearch(this.bot).doBonusSearches(page)
            },
            0
        )
    }

    doSearchOnBing = async (promotion: BasePromotion, page: Page): Promise<boolean> => {
        return this.execute(
            'doSearchOnBing',
            async () => {
                if (this.bot.config.experimental.apiSearchOnBing) {
                    const activity = new ApiSearchOnBing(this.bot)
                    await activity.doSearchOnBing(promotion)
                    return activity.didExecute()
                }
                const activity = new BrowserSearchOnBing(this.bot)
                await activity.doSearchOnBing(promotion, page)
                return activity.didExecute()
            },
            true
        )
    }

    doDailySet = async (data: DashboardData): Promise<boolean> => {
        return this.execute(
            'doDailySet',
            async () => {
                const activity = new DailySet(this.bot)
                await activity.run(data)
                return activity.didExecute()
            },
            true
        )
    }

    doMorePromotions = async (data: DashboardData): Promise<boolean> => {
        return this.execute(
            'doMorePromotions',
            async () => {
                const activity = new MorePromotions(this.bot)
                await activity.run(data)
                return activity.didExecute()
            },
            true
        )
    }

    doPunchCardsMobile = async (data: DashboardData): Promise<boolean> => {
        return this.execute(
            'doPunchCardsMobile',
            async () => {
                const activity = new PunchCards(this.bot)
                await activity.runMobile(data)
                return activity.didExecute()
            },
            true
        )
    }

    doPunchCardsDesktop = async (): Promise<void> => {
        return this.execute(
            'doPunchCardsDesktop',
            async () => {
                await new PunchCards(this.bot).runDesktop()
            },
            undefined
        )
    }

    doUrlReward = async (promotion: BasePromotion): Promise<boolean> => {
        return this.execute(
            'doUrlReward',
            async () => {
                const activity = new UrlReward(this.bot)
                await activity.doUrlReward(promotion)
                return activity.didExecute()
            },
            true
        )
    }

    doClaimBonusPoints = async (): Promise<void> => {
        return this.execute(
            'doClaimBonusPoints',
            async () => {
                const claimBonusPoints = new ClaimBonusPoints(this.bot)
                await claimBonusPoints.claimBonusPoints()
            },
            undefined
        )
    }

    doEnsureStreakProtection = async (): Promise<void> => {
        return this.execute(
            'doEnsureStreakProtection',
            async () => {
                const ensureStreakProtection = new EnsureStreakProtection(this.bot)
                await ensureStreakProtection.ensureStreakProtection()
            },
            undefined
        )
    }

    doClaimReward = async (child: QuestChild, parentId: string): Promise<boolean> => {
        return this.execute(
            'doClaimReward',
            async () => {
                const claimReward = new ClaimReward(this.bot)
                await claimReward.claimReward(child, parentId)
                return claimReward.didExecute()
            },
            true
        )
    }

    doActivateSearchPerk = async (data: DashboardData): Promise<boolean> => {
        return this.execute(
            'doActivateSearchPerk',
            async () => {
                const activity = new ActivateSearchPerk(this.bot)
                await activity.activate(data)
                return activity.didExecute()
            },
            true
        )
    }

    doVisualSearch = async (data: DashboardData): Promise<number> => {
        return this.execute(
            'doVisualSearch',
            async () => {
                const visualSearch = new VisualSearch(this.bot)
                return await visualSearch.doVisualSearch(data)
            },
            0
        )
    }

    doAppReward = async (promotion: Promotion): Promise<void> => {
        return this.execute(
            'doAppReward',
            async () => {
                const urlReward = new AppReward(this.bot)
                await urlReward.doAppReward(promotion)
            },
            undefined
        )
    }

    doReadToEarn = async (): Promise<boolean> => {
        return this.execute(
            'doReadToEarn',
            async () => {
                const activity = new ReadToEarn(this.bot)
                await activity.doReadToEarn()
                return activity.didExecute()
            },
            true
        )
    }

    doDailyCheckIn = async (): Promise<boolean> => {
        // Preserve the existing public rejection contract; Main isolates this stage and
        // records its terminal failure before continuing independent account work.
        const activity = new DailyCheckIn(this.bot)
        await activity.doDailyCheckIn()
        return activity.didExecute()
    }

    doAppPromotions = async (data: AppDashboardData): Promise<boolean> => {
        return this.execute(
            'doAppPromotions',
            async () => {
                const activity = new AppPromotions(this.bot)
                await activity.run(data)
                return activity.didExecute()
            },
            true
        )
    }

    doEdgeBrowsing = async (data: DashboardData, signal?: AbortSignal): Promise<void> => {
        return this.execute(
            'doEdgeBrowsing',
            async () => {
                const edgeBrowsing = new EdgeBrowsing(this.bot)
                await edgeBrowsing.run(data, signal)
            },
            undefined
        )
    }
}
