import m, { Children, Component, Vnode } from "mithril"
import { theme } from "./theme"
import { component_size, px, size } from "./size"
import { Icons } from "./base/icons/Icons"
import { Translation } from "../misc/LanguageViewModel"
import { Icon, IconAttrs, IconSize } from "./base/Icon"
import { IconButton } from "./base/IconButton"
import { ButtonSize } from "./base/ButtonSize"

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
			".flex.col.border-radius.rel.clip",
			{
				style: {
					background: progressState === ProgressState.error ? theme.error_container : theme.surface_container,
					padding: px(size.spacing_12),
				},
			},
			[
				m(".flex.row.items-center.justify-between.items-center", [
					m(".flex.flex-grow.items-center.gap-16.overflow-hidden", [
						this.renderIcon(progressState, iconOverride),
						m(".flex.col.gap-8.flex-shrink.overflow-hidden", [m(".font-weight-500.text-ellipsis", mainText)]),
					]),
					progressState === ProgressState.error
						? m(IconButton, {
								click: () => {},
								icon: Icons.QuestionmarkFilled,
								style: {
									fill: theme.on_surface_variant,
								},
								title: "help_label", //FIXME
								size: ButtonSize.Normal,
							})
						: null,
					this.renderCancelButton(progressState, onCancel),
				]),
				progressState === ProgressState.running
					? m(".abs", { style: { left: "0", bottom: "0", right: `${100 - percentage}%`, height: px(2), background: theme.outline } })
					: null,
			],
		)
	}
	private renderCancelButton(progressState: ProgressState, onCancel: () => unknown) {
		if (progressState !== ProgressState.error) {
			return progressState === ProgressState.running
				? m(IconButton, {
						click: () => onCancel(),
						icon: Icons.X,
						title: "cancel_action",
						size: ButtonSize.Normal,
					})
				: m("", {
						style: {
							width: px(component_size.button_height),
							height: px(component_size.button_height),
						},
					})
		} else return null
	}

	private renderIcon(state: ProgressState, iconOverride: ProgressSnackBarAttrs["iconOverride"]): Children {
		switch (state) {
			case ProgressState.done:
				return m(Icon, { icon: Icons.SuccessFilled, size: IconSize.PX24, style: { fill: theme.success } } satisfies IconAttrs)
			case ProgressState.error:
				return m(Icon, { icon: Icons.ExclamationFilled, size: IconSize.PX24, style: { fill: theme.error } } satisfies IconAttrs)
			case ProgressState.running:
				return iconOverride ? iconOverride() : null
		}
	}
}
