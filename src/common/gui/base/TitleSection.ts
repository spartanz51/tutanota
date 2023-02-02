import { AllIcons, Icon, IconSize } from "./Icon"
import m, { Children, Component, Vnode } from "mithril"
import { Card } from "./Card"

export type SettingsTitleSectionAttrsType = {
	icon?: AllIcons
	iconOptions?: { color: string; class?: string }
	title: string
	subTitle: Children
	style?: Record<string, any>
}

export class TitleSection implements Component<SettingsTitleSectionAttrsType> {
	view({ attrs }: Vnode<SettingsTitleSectionAttrsType>): Children {
		return m(
			Card,
			{},
			m(
				"",
				{
					style: {
						paddingTop: "8px",
						paddingBottom: "8px",
						...attrs.style,
					},
				},
				m(
					".center.pb-8.pt-12",
					attrs.icon
						? m(Icon, {
								icon: attrs.icon,
								size: IconSize.PX64,
								class: attrs.iconOptions?.class,
								style: {
									fill: attrs.iconOptions?.color,
								},
							})
						: null,
				),
				m(
					".center.mb-16",
					{
						style: {
							fontSize: "20px",
						},
					},
					attrs.title,
				),
				m(".center.smaller.text-preline", attrs.subTitle),
			),
		)
	}
}
