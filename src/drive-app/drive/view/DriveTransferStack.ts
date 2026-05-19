import m, { Children, Component, Vnode } from "mithril"
import { DriveTransferState, DriveTransferType } from "./DriveTransferController"
import { px, size } from "../../../common/gui/size"
import { TransferId } from "../../../common/api/common/drive/DriveTypes"
import { ProgressSnackBar, ProgressSnackBarAttrs, ProgressState } from "../../../common/gui/ProgressSnackBar"
import { TranslationKeyType } from "../../../common/misc/TranslationKey"
import { fabBottomSpacing } from "../../../common/gui/base/FloatingActionButton"
import { lang, Translation } from "../../../common/misc/LanguageViewModel"
import { theme } from "../../../common/gui/theme"
import { boxShadowHigh } from "../../../common/gui/main-styles"
import { IconButton } from "../../../common/gui/base/IconButton"
import { Icons } from "../../../common/gui/base/icons/Icons"
import { ButtonSize } from "../../../common/gui/base/ButtonSize"
import { Icon, IconSize } from "../../../common/gui/base/Icon"
import { CircleLoadingBar, CircleLoadingBarAttrs } from "../../../common/gui/CircleLoadingBar"

export interface DriveTransferStackAttrs {
	transfers: readonly DriveTransferState[]
	cancelTransfer: (transferId: TransferId) => unknown
}

// register custom CSS property so that we can animate it.
// it is relatively new so check the support before using it
if (typeof CSS.registerProperty === "function") {
	CSS.registerProperty({
		name: "--progress-value",
		syntax: "<integer>",
		initialValue: "0",
		inherits: false,
	})
}

// Interface representing the "total" status of a group of transfers in the stack.
interface TransferStackStatus {
	progressState: ProgressState
	percentage: number
	mainText: string
	infoText?: Translation
}

export class DriveTransferStack implements Component<DriveTransferStackAttrs> {
	private expanded: boolean = false

	getStackStatus(transfers: readonly DriveTransferState[]): TransferStackStatus {
		let progressState: ProgressState
		let mainText: string
		let infoTextText: string

		const progressStatePerTransfer = transfers.map((transfer) => this.getProgressState(transfer.state))
		const totalTransfers = transfers.length
		const doneTransfers = progressStatePerTransfer.filter((state) => state === ProgressState.done).length

		const allTransfersDone = progressStatePerTransfer.every((state) => state === ProgressState.done)
		if (allTransfersDone) {
			progressState = ProgressState.done
			mainText = "Done"
			infoTextText = `${doneTransfers} of ${totalTransfers} completed`
		} else {
			const anyTransferFailed = progressStatePerTransfer.some((state) => state === ProgressState.error)
			if (anyTransferFailed) {
				progressState = ProgressState.error
				mainText = "Error"
				infoTextText = "Something went wrong"
			} else {
				progressState = ProgressState.running
				mainText = "Transferring …"
				infoTextText = `${doneTransfers} of ${totalTransfers} completed`
			}
		}

		const infoText = lang.makeTranslation("test_transferStackInfoText", infoTextText)

		const percentages = transfers.map((transfer) => (transfer.transferredSize / transfer.totalSize) * 100)

		const accPercentages = percentages.reduce((acc, cur, index) => acc + cur, 0)

		const percentage = Math.min(Math.round(accPercentages / transfers.length), 100)

		return { progressState, percentage, mainText, infoText }
	}

	view({ attrs: { transfers, cancelTransfer } }: Vnode<DriveTransferStackAttrs>): Children {
		if (transfers.length === 0) {
			return
		}

		const stackStatus = this.getStackStatus(transfers)

		const onCancel = () => console.log("transfer cancelled")

		return m(
			".flex.col.abs.border-radius",
			{
				"data-testid": "drive:transferstack",
				style: {
					width: `min(calc(100vw - ${size.spacing_12}px * 2), 500px)`,
					bottom: px(size.spacing_12 + fabBottomSpacing()),
					right: px(size.spacing_12),
					background: theme.surface,
					"box-shadow": boxShadowHigh,
					padding: px(size.spacing_8),
				},
			},
			[
				m(".flex.row.items-center.justify-between.items-center.pt-8.plr-4.pb-8", [
					m(".flex.flex-grow.items-center.gap-16.overflow-hidden", [
						this.renderProgress(stackStatus.progressState, stackStatus.percentage),
						m(".flex.col.gap-8.flex-shrink.overflow-hidden", [
							m(".font-weight-500.text-ellipsis", stackStatus.mainText),
							stackStatus.infoText ? m(".small", { "data-testid": stackStatus.infoText.testId }, stackStatus.infoText.text) : null,
						]),
					]),

					m(IconButton, {
						click: () => {
							this.expanded = !this.expanded
						},
						icon: this.expanded ? Icons.ChevronDown : Icons.ChevronUp,
						title: "open_action", // FIXME: Introduce a more precise description.
						size: ButtonSize.Large,
					}),

					m(IconButton, {
						click: () => onCancel(),
						icon: Icons.X,
						title: "cancel_action",
						size: ButtonSize.Large,
					}),
				]),
			],
			this.expanded
				? m(
						".flex.col.gap-4",
						{
							style: {
								overflowY: "scroll",
								maxHeight: "calc(72px * 3)", // show at max three transfers without scrolling
							},
						},
						transfers.map((transferState) => {
							return m(ProgressSnackBar, {
								key: transferState.id,
								mainText: transferState.filename,
								infoText: this.getStatusText(transferState.type, transferState.state),
								iconOverride: () => this.renderStateIcon(transferState.type),
								progressState: this.getProgressState(transferState.state),
								percentage: Math.min(Math.round((transferState.transferredSize / transferState.totalSize) * 100), 100),
								onCancel: () => cancelTransfer(transferState.id),
							} satisfies ProgressSnackBarAttrs & { key: string })
						}),
					)
				: null,
		)
	}

	private renderStateIcon(transferType: DriveTransferType): Children {
		return m(Icon, {
			icon: transferType === "upload" ? Icons.Upload : Icons.DownloadFilled,
			size: IconSize.PX24,
			style: {
				fill: theme.on_surface_variant,
			},
		})
	}

	private renderProgress(state: ProgressState, percentage: number): Children {
		return m(CircleLoadingBar, this.getCircleLoadingBarAttrs(state, percentage))
	}

	private getCircleLoadingBarAttrs(state: ProgressState, percentage: number): CircleLoadingBarAttrs {
		switch (state) {
			case ProgressState.done:
				return {
					backgroundColor: theme.surface,
					color: theme.success,
					icon: Icons.Checkmark,
				}
			case ProgressState.error:
				return {
					backgroundColor: theme.surface,
					color: theme.error,
					icon: Icons.X,
				}
			case ProgressState.running:
				return {
					backgroundColor: theme.surface,
					percentage,
				}
		}
	}

	private getProgressState(state: DriveTransferState["state"]): ProgressState {
		switch (state) {
			case "active":
			case "waiting":
				return ProgressState.running
			case "failed":
				return ProgressState.error
			case "finished":
				return ProgressState.done
		}
	}

	private getStatusText(type: "upload" | "download", state: DriveTransferState["state"]): Translation {
		let translationKey: TranslationKeyType
		if (state === "failed") {
			translationKey = "transferFailed_msg"
		} else if (state === "waiting") {
			translationKey = "transferWaiting_msg"
		} else if (state === "active") {
			translationKey = type === "upload" ? "uploadInProgress_msg" : "downloadInProgress_msg"
		} else {
			translationKey = type === "upload" ? "uploadCompleted_msg" : "downloadCompleted_msg"
		}

		return lang.getTranslation(translationKey)
	}
}
