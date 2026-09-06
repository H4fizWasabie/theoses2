import type { ExtensionAPI } from "theoses-coding-agent";

export default function widgetPlacementExtension(theoses: ExtensionAPI) {
	theoses.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
