import { formatList } from "@crh/api";
import { useLingui } from "@lingui/react/macro";
import { Fragment, type ReactNode } from "react";

/**
 * A user-visible list whose items are React values (links, formatted values), separated the way the
 * active locale writes a list: `en` uses ", ", `zh-CN` uses "、". This is the JSX counterpart of
 * `formatList` for lists that cannot be flattened to strings.
 */
export function LocalizedList<T>({
	items,
	render,
	getKey,
	className,
}: {
	items: readonly T[];
	render: (item: T) => ReactNode;
	getKey: (item: T) => string;
	className?: string;
}) {
	const { i18n } = useLingui();
	if (items.length === 0) return null;
	// `narrow` conjunction style uses one separator for every pair, so formatting two empty items
	// yields exactly the separator the locale's list uses.
	const separator = formatList(i18n.locale, ["", ""]);
	return (
		<span className={className}>
			{items.map((item, index) => (
				<Fragment key={getKey(item)}>
					{index > 0 && <span className="text-muted-foreground">{separator}</span>}
					{render(item)}
				</Fragment>
			))}
		</span>
	);
}
