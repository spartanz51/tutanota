import { TimeStamp } from "../utils/AdSyncUtils.js"

export interface TimeStampInterval {
	fromTimeStamp: TimeStamp
	toTimeStamp: TimeStamp
}

export enum OptimizerUpdateAction {
	NO_UPDATE,
	INCREASE,
	DECREASE,
}

export const THROUGHPUT_THRESHOLD: number = 10

export abstract class AdSyncOptimizer {
	protected optimizationDifference: number
	protected optimizationInterval: number
	protected abstract scheduler?: IntervalID
	protected optimizerUpdateTimeStampHistory: TimeStamp[] = []

	protected constructor(optimizationDifference: number, optimizationInterval: number) {
		this.optimizationDifference = optimizationDifference
		this.optimizationInterval = optimizationInterval
	}

	protected abstract optimize(): void

	startAdSyncOptimizer(): void {
		this.optimizerUpdateTimeStampHistory.push(Date.now())
	}

	stopAdSyncOptimizer(): void {
		clearInterval(this.scheduler)
	}

	protected getCurrentTimeStampInterval(): TimeStampInterval {
		const fromTimeStamp = this.optimizerUpdateTimeStampHistory.at(-1) !== undefined ? this.optimizerUpdateTimeStampHistory.at(-1)! : 0
		const toTimeStamp = Date.now()
		return { fromTimeStamp, toTimeStamp }
	}

	protected getLastTimeStampInterval(): TimeStampInterval {
		const fromTimeStamp = this.optimizerUpdateTimeStampHistory.at(-2) !== undefined ? this.optimizerUpdateTimeStampHistory.at(-2)! : 0
		const toTimeStamp = this.optimizerUpdateTimeStampHistory.at(-1) !== undefined ? this.optimizerUpdateTimeStampHistory.at(-1)! : Date.now()
		return { fromTimeStamp, toTimeStamp }
	}
}
