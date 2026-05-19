import m, { Children, Component, Vnode } from "mithril"
import { theme } from "./theme"
import { px, size } from "./size"
import { Icons } from "./base/icons/Icons"
import { Translation } from "../misc/LanguageViewModel"
import { Icon, IconAttrs, IconSize } from "./base/Icon"

export enum ProgressState {
	done,
	error,
	running,
}

export interface ProgressSnackBarAttrs {
	mainText: string
	infoText?: Translation
	iconOverride?: () => Children
	progressState: ProgressState
	percentage: number
	onCancel: () => unknown
}

export class ProgressSnackBar implements Component<ProgressSnackBarAttrs> {
	view({ attrs: { infoText, mainText, onCancel, progressState, percentage, iconOverride } }: Vnode<ProgressSnackBarAttrs>): Children {
		return m(
			".flex.col.border-radius",
			{
				style: {
					background: theme.surface_container,
					padding: px(size.spacing_12),
				},
			},
			[
				m(".flex.row.items-center.justify-between.items-center", [
					m(".flex.items-center.gap-16.overflow-hidden", [
						this.renderIcon(progressState, iconOverride),
						m(".flex.col.gap-8.flex-shrink.overflow-hidden", [m(".font-weight-500.text-ellipsis", mainText), m(".small", `${percentage}%`)]),
					]),
				]),
			],
		)
	}

	private renderIcon(state: ProgressState, iconOverride: ProgressSnackBarAttrs["iconOverride"]): Children {
		switch (state) {
			case ProgressState.done:
				return m(Icon, { icon: Icons.SuccessFilled, size: IconSize.PX24, style: { fill: theme.success } } satisfies IconAttrs)
			case ProgressState.error:
				return m(Icon, { icon: Icons.FailureFilled, size: IconSize.PX24, style: { fill: theme.error } } satisfies IconAttrs)
			case ProgressState.running:
				return iconOverride ? iconOverride() : null
		}
	}
}
